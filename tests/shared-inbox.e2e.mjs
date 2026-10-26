import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
const base = process.env.ECO_TEST_UI_ORIGIN || 'http://127.0.0.1:4395';
const out = resolve(process.env.ECO_TEST_UI_OUTPUT || 'output/shared-inbox-ui');
const sessionLatency = Number(process.env.ECO_TEST_SESSION_LATENCY_MS || 0);
const otto = { capabilities: { appearancePreview: true, testWorkspace: true }, id: '10000000-0000-4000-8000-000000000001', email: 'owner@example.test', displayName: 'SAMPLE TRADER', phone: '+6591815902', officeId: 'HONG KONG', officeName: 'HONG KONG', isAdmin: true, isSpcTrader: true, isManager: false, isActive: true, activated: true, passwordChangeSuggested: false, revision: 1 };
const other = { ...otto, capabilities: undefined, id: '10000000-0000-4000-8000-000000000002', email: 'other@example.test', displayName: 'OTHER TRADER', isAdmin: false, isSpcTrader: false };
const generation = '10000000-0000-4000-8000-000000000010';
const record = (n, owner = otto.id) => ({ id: `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`, providerMessageId: `fixture-${n}`, owner, channel: n % 2 ? 'email' : 'whatsapp', sender: n % 2 ? 'trader@example.test' : '+6591815902', subject: 'Enquiry', rawText: `Vessel: FIXTURE ${n}\nPort: Singapore\nETA: 20 OCT 2026\nVLSFO: 300 MT`, receivedAt: '2026-10-15T08:30:00.000Z', read: false, dismissed: false });
const count = data => data.filter(item => !item.read && !item.dismissed).length;
const focus = page => page.evaluate(() => dispatchEvent(new Event('focus')));
async function invalidateSession(page, userId) {
  // Synthetic account changes must use the same cross-tab signal as login or
  // logout. Focus deliberately deduplicates an older in-flight session check.
  const response = page.waitForResponse(async result => {
    if (new URL(result.url()).pathname !== '/api/access/session') return false;
    if (userId === null) return result.status() === 401;
    if (result.status() !== 200) return false;
    return (await result.json().catch(() => null))?.user?.id === userId;
  });
  await page.evaluate(() => {
    const channel = new BroadcastChannel('eco-access-invalidation');
    channel.postMessage('refresh-needed'); channel.close();
  });
  await response;
}
const control = page => page.locator('.home-display-controls').getByRole('button', { name: 'Test data', exact: true });
const panel = page => page.getByRole('region', { name: 'Notifications', exact: true });
async function openInbox(page) { const toggle = page.getByRole('button', { name: 'Notifications', exact: true }); if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click(); return panel(page); }
async function fixture(context, shared) {
  const session = { user: { ...otto }, preview: null, latency: 0, getError: false, failWrite: false, hold: null, holdWrite: null, calls: [], writes: [] };
  await context.route('**/api/access/**', async route => {
    const path = new URL(route.request().url()).pathname.split('/api/access/')[1];
    if (path === 'preview') { const input = route.request().postDataJSON(); session.preview = { ...input, officeName: input.officeId, readOnly: true }; }
    if (path === 'preview/end') session.preview = null;
    if (['session', 'preview', 'preview/end'].includes(path)) {
      const response = { status: session.user ? 200 : 401, json: session.user ? structuredClone({ user: session.user, preview: session.preview }) : { message: 'Sign in required.' } };
      if (path === 'session' && session.latency > 0) await new Promise(resolve => setTimeout(resolve, session.latency));
      return route.fulfill(response).catch(() => {});
    }
    return route.fulfill({ json: { requests: [], users: [session.user], offices: [{ id: 'HONG KONG', name: 'HONG KONG' }] } });
  });
  await context.route('**/api/enquiries/test-policy', route => route.fulfill({ json: { enabled: true, generation } }));
  await context.route('**/api/enquiries/records*', route => {
    const req = route.request(), url = new URL(req.url());
    assert.equal(req.method(), 'GET'); assert.equal(req.headers()['x-eco-data-mode'], 'live');
    return route.fulfill({ json: url.searchParams.has('inboxId') ? { item: null } : { items: [], nextCursor: null } });
  });
  await context.route('**/api/admin/**', route => route.fulfill({ json: { count: 0, items: [], periodStart: '2026-10-09T00:00:00Z', periodEnd: '2026-10-16T00:00:00Z', timeZone: 'Asia/Hong_Kong', source: 'shared-feedback' } }));
  await context.route('**/api/suppliers/**', route => route.fulfill({ json: { items: [], page: 1, pageSize: 100, total: 0 } }));
  await context.route('**/api/profile-tabs/**', route => { const url = new URL(route.request().url()); return route.fulfill({ json: { target: { kind: url.searchParams.get('kind'), id: url.searchParams.get('id') }, shared: { revision: 0, tabs: [] }, private: { revision: 0, tabs: [] } } }); });
  await context.route('**/api/enquiries/inbox*', async route => {
    const req = route.request(); assert.equal(req.headers()['x-eco-data-mode'], 'live');
    session.calls.push(req.method()); const owner = session.user?.id; const data = shared.items.filter(item => item.owner === owner);
    if (req.method() === 'GET') {
      if (session.getError) return route.fulfill({ status: 503, json: { message: 'Unavailable' } });
      const url = new URL(req.url()), offset = Number(url.searchParams.get('cursor') || 0); assert.equal(url.searchParams.get('limit'), '50');
      const response = { items: structuredClone(data.slice(offset, offset + 50)), nextCursor: data.length > offset + 50 ? String(offset + 50) : null, unreadCount: count(data) };
      if (session.hold) { const held = session.hold; session.hold = null; await held(response); }
      return route.fulfill({ json: response }).catch(() => {});
    }
    const input = req.postDataJSON(); session.writes.push(input); assert.equal(req.headers()['x-eco-request'], '1'); assert.deepEqual(Object.keys(input).sort(), (input.action === 'dismiss-all' ? ['action', 'requestId'] : ['action', 'id', 'requestId']).sort());
    let response = shared.receipts.get(input.requestId);
    if (!response) {
      const item = data.find(item => item.id === input.id); let changedCount = 0;
      if (input.action === 'read') { if (!item.read) changedCount++; item.read = true; }
      else if (input.action === 'dismiss') { if (!item.dismissed) changedCount++; item.dismissed = true; }
      else data.forEach(item => { if (!item.dismissed) changedCount++; item.dismissed = true; });
      response = { requestId: input.requestId, action: input.action, item: input.action === 'dismiss-all' ? null : structuredClone(item), changedCount, unreadCount: count(data) };
      shared.receipts.set(input.requestId, response);
    }
    if (session.failWrite) { session.failWrite = false; return route.abort('failed'); }
    if (session.holdWrite) { const held = session.holdWrite; session.holdWrite = null; await held(); }
    return route.fulfill({ json: response }).catch(() => {});
  });
  return session;
}

async function verifyPolling(page, session, inbox) {
  // Initial lazy artwork loads with the clock running; pause at a fixed future instant, never a moving Date.now().
  await page.clock.pauseAt(new Date('2026-10-16T09:00:00Z'));
  await expect(inbox.locator('.inbox-list')).toHaveAttribute('aria-busy', 'false');
  const gets = () => session.calls.filter(method => method === 'GET').length;
  let release, started;
  const pending = new Promise(resolve => { started = resolve; });
  session.hold = () => { started(); return new Promise(resolve => { release = resolve; }); };
  const failures = [];
  const failed = request => { if (request.method() === 'GET' && request.url().includes('/api/enquiries/inbox')) failures.push(request.failure()?.errorText); };
  page.on('requestfailed', failed);
  try {
    const before = gets(); await focus(page); await pending;
    for (let n = 0; n < 3; n++) await page.evaluate(() => {
      dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); dispatchEvent(new Event('online'));
    });
    await page.clock.runFor(15_000);
    assert.equal(gets(), before + 1, 'A slow read must not be restarted or overlapped by five-second polls or focus events');
    assert.deepEqual(failures, [], 'Active read was not aborted by polling');
    release(); await expect(inbox.locator('.inbox-list')).toHaveAttribute('aria-busy', 'false');
    await page.clock.runFor(4_999); assert.equal(gets(), before + 1, 'Deadline starts after completion');
    await page.clock.runFor(1); await expect.poll(gets).toBe(before + 2);
    await expect(inbox.locator('.inbox-list')).toHaveAttribute('aria-busy', 'false');

    session.getError = true;
    await page.clock.runFor(5_000); await expect(inbox.getByRole('alert')).toContainText('Inbox unavailable');
    const failedCount = gets(); await page.clock.runFor(9_999); assert.equal(gets(), failedCount, 'First failure backs off ten seconds');
    await page.clock.runFor(1); await expect.poll(gets).toBe(failedCount + 1);
    await expect(inbox.locator('.inbox-list')).toHaveAttribute('aria-busy', 'false');
    await page.clock.runFor(19_999); assert.equal(gets(), failedCount + 1, 'Repeated failure backs off twenty seconds');
    session.getError = false; await inbox.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(inbox.getByRole('alert')).toHaveCount(0);
    const recovered = gets(); await page.clock.runFor(4_999); assert.equal(gets(), recovered);
    await page.clock.runFor(1); await expect.poll(gets).toBe(recovered + 1);
    await expect(inbox.locator('.inbox-list')).toHaveAttribute('aria-busy', 'false');

    const availability = (hidden, online, event) => page.evaluate(({ hidden, online, event }) => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: online });
      if (event === 'visibilitychange') document.dispatchEvent(new Event(event)); else dispatchEvent(new Event(event));
    }, { hidden, online, event });
    await availability(true, true, 'visibilitychange'); const hiddenCount = gets();
    await page.clock.fastForward(60_000); await focus(page); assert.equal(gets(), hiddenCount, 'Hidden tab does not poll');
    await availability(false, false, 'visibilitychange'); await page.clock.fastForward(60_000);
    assert.equal(gets(), hiddenCount, 'Visible offline tab does not poll');
    await availability(false, true, 'online'); await expect.poll(gets).toBe(hiddenCount + 1);
    await expect(inbox.locator('.inbox-list')).toHaveAttribute('aria-busy', 'false');
    await availability(true, true, 'visibilitychange');
    await availability(false, true, 'visibilitychange'); await expect.poll(gets).toBe(hiddenCount + 2);
    await expect(inbox.locator('.inbox-list')).toHaveAttribute('aria-busy', 'false');
  } finally {
    release?.(); page.off('requestfailed', failed); session.getError = false;
    await page.evaluate(() => { delete document.hidden; delete navigator.onLine; });
    await page.clock.resume();
  }
}

const results = []; await mkdir(out, { recursive: true });
for (const [engine, browserType] of [['chromium', chromium], ['webkit', webkit]]) {
  if (process.env.ECO_TEST_ENGINE && process.env.ECO_TEST_ENGINE !== engine) continue;
  const browser = await browserType.launch({ headless: true });
  try { for (const width of [1440, 320, 390]) for (const theme of ['light', 'dark']) {
    if (process.env.ECO_TEST_WIDTH && +process.env.ECO_TEST_WIDTH !== width || process.env.ECO_TEST_THEME && process.env.ECO_TEST_THEME !== theme) continue;
    const options = { viewport: { width, height: 1000 }, isMobile: width < 760, hasTouch: width < 760, reducedMotion: 'reduce' };
    const context = await browser.newContext(options), device2 = await browser.newContext(options);
    const shared = { items: Array.from({ length: 53 }, (_, n) => record(53-n)), receipts: new Map() };
    const session = await fixture(context, shared), second = await fixture(device2, shared); session.getError = true;
    await context.addInitScript(({ theme, owner }) => { localStorage.setItem('ecosystem.theme.v1', theme); localStorage.setItem(`ecosystem.live.v1:${owner}:inbox`, JSON.stringify({ version: 2, items: [{ rawText: 'LEGACY PRIVATE MESSAGE' }] })); }, { theme, owner: otto.id });
    await device2.addInitScript(theme => localStorage.setItem('ecosystem.theme.v1', theme), theme);
    const page = await context.newPage(), page2 = await device2.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message)); page2.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(10000); page2.setDefaultTimeout(10000);
    const settled = async target => { await expect(target.locator('.immersive-app')).toHaveAttribute('data-design', 'flowing-water'); await expect(target.locator('.flowing-water-background')).toBeVisible(); };
    const shot = async name => { await settled(page); await page.evaluate(() => { scrollTo(0, 0); document.querySelectorAll('.account-inline-panel,.inbox-list').forEach(element => { element.scrollTop = 0; }); }); await page.evaluate(async () => { await Promise.all([...document.images].map(image => image.decode().catch(() => {}))); }); await page.screenshot({ path: `${out}/${engine}-${width}-${theme}-${name}.png`, fullPage: name !== 'notifications' }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name} overflow`); };
    try {
      // Keep initial lazy rendering live; verifyPolling freezes this fixed clock well ahead of setup time.
      await page.clock.install({ time: new Date('2026-10-16T08:00:00Z') });
      await page.goto(base); await settled(page); await expect(control(page)).toBeEnabled(); const inbox = await openInbox(page);
      await expect(inbox.getByRole('alert')).toContainText('Inbox unavailable'); await shot('offline');
      session.getError = false; await inbox.getByRole('button', { name: 'Retry', exact: true }).click(); await expect(inbox.locator('.inbox-notification-row')).toHaveCount(50);
      await expect(page.locator('.inbox-count')).toHaveText('53'); await expect(inbox).not.toContainText('(demo)'); await expect(inbox).not.toContainText('LEGACY PRIVATE MESSAGE');
      await verifyPolling(page, session, inbox);
      await inbox.getByRole('button', { name: 'Load more', exact: true }).click(); await expect(inbox.locator('.inbox-notification-row')).toHaveCount(53); await shot('notifications');
      await inbox.locator('.inbox-item').filter({ hasText: 'FIXTURE 53' }).click(); const enquiry = page.getByRole('dialog', { name: 'Enquiries', exact: true }); await expect(enquiry.getByRole('textbox', { name: 'Raw enquiry', exact: true })).toHaveValue(shared.items[0].rawText);
      await expect.poll(() => shared.items[0].read).toBe(true); await shot('parser');
      await page2.goto(base); await settled(page2); await expect(page2.locator('.inbox-count')).toHaveText('52'); await openInbox(page2); await expect(panel(page2).locator('.inbox-item').filter({ hasText: 'FIXTURE 53' })).not.toHaveClass(/is-unread/);
      await page2.reload(); await settled(page2); await expect(page2.locator('.inbox-count')).toHaveText('52');
      await page.getByRole('button', { name: 'Close workspace', exact: true }).click(); await openInbox(page);
      session.failWrite = true; await inbox.getByRole('button', { name: 'Clear all', exact: true }).click(); await expect(inbox.getByRole('alert')).toContainText('Inbox update failed');
      shared.items.unshift(record(54)); await inbox.getByRole('button', { name: 'Retry', exact: true }).click(); await expect(inbox.locator('.inbox-notification-row')).toHaveCount(1); await expect(inbox).toContainText('FIXTURE 54'); await expect(page.locator('.inbox-count')).toHaveText('1');
      const clearWrites = session.writes.filter(item => item.action === 'dismiss-all'); assert.equal(clearWrites.length, 2); assert.equal(clearWrites[0].requestId, clearWrites[1].requestId); assert.equal(shared.items.find(item => item.id === record(1).id).dismissed, true);
      await focus(page2); await expect(page2.locator('.inbox-count')).toHaveText('1');
      await page.reload(); await settled(page); await expect(page.locator('.inbox-count')).toHaveText('1'); await expect(control(page)).toBeEnabled();
      let releaseWrite; let writeStarted; const pendingWrite = new Promise(resolve => { writeStarted = resolve; }); session.holdWrite = () => { writeStarted(); return new Promise(resolve => { releaseWrite = resolve; }); };
      await openInbox(page); await panel(page).getByRole('button', { name: 'Clear notification for FIXTURE 54', exact: true }).click(); await pendingWrite;
      await page.getByRole('button', { name: 'Notifications', exact: true }).click();
      await control(page).click(); await expect(control(page)).toHaveAttribute('aria-pressed', 'true'); releaseWrite(); const callsInTest = session.calls.length;
      await openInbox(page); await expect(panel(page).locator('.inbox-notification-row')).toHaveCount(0); await page.getByRole('button', { name: 'WhatsApp (demo)', exact: true }).click(); await page.getByRole('button', { name: 'Normal enquiry', exact: true }).click(); await openInbox(page); await expect(panel(page).locator('.inbox-notification-row')).toHaveCount(1); await focus(page); assert.equal(session.calls.length, callsInTest); await shot('test');
      await page.getByRole('button', { name: 'Notifications', exact: true }).click(); await control(page).click(); await expect(page.locator('.inbox-count')).toHaveCount(0);
      // Completion-based polling starts after the initial LIVE read, not the mode toggle.
      await openInbox(page); await expect(panel(page).locator('.inbox-list')).toHaveAttribute('aria-busy', 'false');
      await page.getByRole('button', { name: 'Notifications', exact: true }).click();
      shared.items.unshift(record(55)); await page.clock.fastForward(5000); await expect(page.locator('.inbox-count')).toHaveText('1'); await page.clock.resume();
      await page.locator('.home-display-controls').getByRole('button', { name: 'View as', exact: true }).click(); await page.locator('.home-display-controls').getByRole('button', { name: 'Normal trader', exact: true }).click(); await expect(page.getByRole('status', { name: 'Role preview' }).first()).toBeVisible(); const previewCalls = session.calls.length;
      await openInbox(page); await expect(panel(page).locator('.inbox-notification-row')).toHaveCount(0); await expect(page.locator('.inbox-count')).toHaveCount(0); await focus(page); assert.equal(session.calls.length, previewCalls); await shot('preview');
      await page.getByRole('button', { name: 'Back to SAMPLE TRADER', exact: true }).first().click(); await expect(page.locator('.inbox-count')).toHaveText('1');
      session.latency = sessionLatency;
      let release; let started; const pending = new Promise(resolve => { started = resolve; }); session.hold = () => { started(); return new Promise(resolve => { release = resolve; }); }; await focus(page); await pending;
      shared.items.push(record(99, other.id)); session.user = { ...other }; await invalidateSession(page, other.id); await expect(page.locator('.hud-identity')).toContainText('OTHER TRADER'); release(); await openInbox(page); await expect(panel(page)).toContainText('FIXTURE 99'); await expect(panel(page)).not.toContainText('FIXTURE 54'); await expect(panel(page)).not.toContainText('FIXTURE 55'); await shot('other-user');
      session.user = null; await invalidateSession(page, null); await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible(); await expect(page.locator('.inbox-count')).toHaveCount(0); await shot('signed-out');
      const local = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.includes(':inbox'))); assert.ok(local.every(([key, value]) => key.includes('ecosystem.test.') || value.includes('LEGACY PRIVATE MESSAGE'))); assert.deepEqual(errors, []);
      results.push({ engine, width, theme, passed: true }); console.log(`PASS ${engine} ${width} ${theme}: server pagination, parser selection, cross-device read, reload, retry receipt, TEST, preview, late read/write, 5s single-flight polling/backoff/visibility/online, signed out`);
    } catch (failure) { await shot('failure'); throw failure; } finally { await context.close(); await device2.close(); }
  } } finally { await browser.close(); }
}
await writeFile(`${out}/verification.json`, JSON.stringify({ base, results, limits: 'Mocked authenticated durable API; headless Chromium/WebKit, not physical devices or native Safari.' }, null, 2));
