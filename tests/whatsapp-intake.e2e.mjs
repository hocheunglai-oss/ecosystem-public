import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { installStagingCookies } from './fixtures/protection-cookies.mjs';

// Real hosted assets, synthetic authenticated inbox API. This suite never calls Meta
// or the receiver webhook; the operator verifier establishes durable cloud intake.
const base = process.env.ECO_WHATSAPP_UI_ORIGIN || 'http://127.0.0.1:4395';
const out = resolve(process.env.ECO_WHATSAPP_UI_OUTPUT || 'output/whatsapp-intake-ui');
const owner = { capabilities: { appearancePreview: true, testWorkspace: true }, id: '10000000-0000-4000-8000-000000000001', email: 'owner@example.test', displayName: 'SAMPLE TRADER', phone: '+85251234567', officeId: 'HONG KONG', officeName: 'HONG KONG', isAdmin: true, isSpcTrader: true, isManager: false, isActive: true, activated: true, passwordChangeSuggested: false, revision: 1 };
const other = { ...owner, capabilities: undefined, id: '10000000-0000-4000-8000-000000000002', email: 'other@example.test', displayName: 'OTHER TRADER', isAdmin: false, isSpcTrader: false };
const generation = '10000000-0000-4000-8000-000000000010';
const raw = 'VESSEL: WHATSAPP SYNTHETIC\nIMO: 9074729\nPORT: SINGAPORE\nETA: 25 OCT 2026\nVLSFO: 500 MT\nLSMGO: 40 MT\nREMARKS: COQ REQUIRED';
const makeReceipt = (n = 1, user = owner) => ({ id: `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`, providerMessageId: `wamid.synthetic-${n}`, owner: user.id, channel: 'whatsapp', sender: user.phone, rawText: n === 1 ? raw : raw.replace('WHATSAPP SYNTHETIC', 'OTHER OWNER'), receivedAt: '2026-10-20T08:00:00.000Z', read: false, dismissed: false });
const notifications = page => page.getByRole('region', { name: 'Notifications', exact: true });
const testControl = page => page.locator('.home-display-controls').getByRole('button', { name: 'Test data', exact: true });
const focus = page => page.evaluate(() => dispatchEvent(new Event('focus')));
async function openInbox(page) {
  const button = page.getByRole('button', { name: 'Notifications', exact: true });
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
  return notifications(page);
}
async function installFixture(context) {
  const session = { user: structuredClone(owner), preview: null, items: [], calls: [], mutations: [] };
  await context.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), body = req.method() === 'POST' ? req.postDataJSON() : null;
    if (url.pathname.startsWith('/api/access/')) {
      if (url.pathname === '/api/access/preview') session.preview = { ...body, officeName: body.officeId, readOnly: true };
      if (url.pathname === '/api/access/preview/end') session.preview = null;
      if (url.pathname === '/api/access/logout') session.user = null;
      if (['/api/access/session', '/api/access/preview', '/api/access/preview/end'].includes(url.pathname)) return route.fulfill(session.user ? { json: { user: session.user, preview: session.preview } } : { status: 401, json: { message: 'Sign in required.' } });
      return route.fulfill({ json: { requests: [], users: session.user ? [session.user] : [], offices: [{ id: 'HONG KONG', name: 'HONG KONG' }] } });
    }
    if (url.pathname === '/api/enquiries/test-policy') return route.fulfill({ json: { enabled: true, generation } });
    if (url.pathname === '/api/enquiries/records') {
      assert.equal(req.method(), 'GET'); assert.equal(req.headers()['x-eco-data-mode'], 'live');
      return route.fulfill({ json: url.searchParams.has('inboxId') ? { item: null } : { items: [], nextCursor: null } });
    }
    if (url.pathname === '/api/enquiries/inbox') {
      assert.equal(req.headers()['x-eco-data-mode'], 'live');
      session.calls.push(req.method());
      if (!session.user) return route.fulfill({ status: 401, json: { message: 'Sign in required.' } });
      if (session.preview) return route.fulfill({ status: 403, json: { message: 'Unavailable in VIEW AS.' } });
      const items = session.items.filter(item => item.owner === session.user.id);
      if (req.method() === 'GET') return route.fulfill({ json: { items: structuredClone(items), nextCursor: null, unreadCount: items.filter(item => !item.read && !item.dismissed).length } });
      assert.equal(req.headers()['x-eco-request'], '1');
      session.mutations.push(body);
      const item = items.find(item => item.id === body.id);
      if (!item || body.action !== 'read') return route.fulfill({ status: 403, json: { message: 'Receipt unavailable.' } });
      const changedCount = item.read ? 0 : 1; item.read = true;
      return route.fulfill({ json: { requestId: body.requestId, action: body.action, item: structuredClone(item), changedCount, unreadCount: items.filter(item => !item.read && !item.dismissed).length } });
    }
    if (url.pathname.startsWith('/api/profile-tabs/')) return route.fulfill({ json: { target: { kind: url.searchParams.get('kind'), id: url.searchParams.get('id') }, shared: { revision: 0, tabs: [] }, private: { revision: 0, tabs: [] } } });
    return route.fulfill({ json: { items: [], count: 0, page: 1, pageSize: 100, total: 0, nextCursor: null, periodStart: '2026-10-14T00:00:00Z', periodEnd: '2026-10-21T00:00:00Z', timeZone: 'Asia/Hong_Kong', source: 'shared-feedback' } });
  });
  return session;
}

await mkdir(out, { recursive: true });
const results = [];
for (const [engine, kind] of [['chromium', chromium], ['webkit', webkit]]) {
  if (process.env.ECO_TEST_ENGINE && process.env.ECO_TEST_ENGINE !== engine) continue;
  const browser = await kind.launch({ headless: true });
  try { for (const width of [1440, 320, 390]) for (const theme of ['light', 'dark']) {
    if (process.env.ECO_TEST_WIDTH && Number(process.env.ECO_TEST_WIDTH) !== width || process.env.ECO_TEST_THEME && process.env.ECO_TEST_THEME !== theme) continue;
    const context = await browser.newContext({ viewport: { width, height: 1000 }, isMobile: width < 760, hasTouch: width < 760, reducedMotion: 'reduce', colorScheme: theme });
    await installStagingCookies(context, base);
    const session = await installFixture(context), page = await context.newPage(), errors = [];
    page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(value => localStorage.setItem('ecosystem.theme.v1', value), theme);
    const shot = async name => {
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: horizontal overflow`);
      await page.screenshot({ path: resolve(out, `${engine}-${width}-${theme}-${name}.png`), fullPage: true, animations: 'disabled' });
    };
    try {
      await page.clock.install({ time: new Date('2026-10-20T09:00:00Z') });
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await expect(testControl(page)).toBeEnabled();
      const inbox = await openInbox(page);
      await expect(inbox.locator('.inbox-list')).toHaveAttribute('aria-busy', 'false');
      await expect(inbox.locator('.inbox-notification-row')).toHaveCount(0);
      // Advancing to the fixed pause fires the pending poll. Its empty response
      // must finish before measuring the next completion-based five-second poll.
      const pausedRead = page.waitForResponse(response => new URL(response.url()).pathname === '/api/enquiries/inbox' && response.request().method() === 'GET');
      await page.clock.pauseAt(new Date('2026-10-20T10:00:00Z'));
      await (await pausedRead).finished();
      await expect(inbox.locator('.inbox-list')).toHaveAttribute('aria-busy', 'false');
      const readsBeforeArrival = session.calls.filter(method => method === 'GET').length;
      session.items.push(makeReceipt());
      await page.clock.runFor(5000);
      await expect.poll(() => session.calls.filter(method => method === 'GET').length).toBe(readsBeforeArrival + 1);
      await expect(page.locator('.inbox-count')).toHaveText('1');
      await expect(inbox.locator('.inbox-notification-row')).toHaveCount(1);
      await expect(inbox).toContainText('WHATSAPP');
      await expect(inbox).toContainText(owner.phone);
      await shot('notification');
      await inbox.locator('.inbox-item').filter({ hasText: 'WHATSAPP SYNTHETIC' }).click();
      const enquiry = page.getByRole('dialog', { name: 'Enquiries', exact: true });
      await expect(enquiry.getByRole('textbox', { name: 'Raw enquiry', exact: true })).toHaveValue(raw);
      await page.clock.runFor(300);
      await expect(enquiry.getByRole('textbox', { name: 'Vessel', exact: true })).toHaveValue('WHATSAPP SYNTHETIC');
      await expect(enquiry.getByRole('textbox', { name: 'IMO', exact: true })).toHaveValue('9074729');
      await expect(enquiry.getByRole('textbox', { name: 'VLSFO', exact: true })).toHaveValue('500');
      await expect(enquiry.getByRole('textbox', { name: 'LSMGO', exact: true })).toHaveValue('40');
      await expect(enquiry.getByRole('textbox', { name: 'Remarks', exact: true })).toHaveValue('COQ REQUIRED');
      assert.equal(session.items[0].read, true); assert.equal(session.mutations.filter(item => item.action === 'read').length, 1);
      await enquiry.getByRole('textbox', { name: 'Vessel', exact: true }).scrollIntoViewIfNeeded(); await shot('parser');
      await page.clock.resume(); await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(testControl(page)).toBeEnabled(); await openInbox(page);
      await expect(inbox.locator('.inbox-notification-row')).toHaveCount(1);
      await expect(inbox.locator('.inbox-item')).not.toHaveClass(/is-unread/);
      await expect(page.locator('.inbox-count')).toHaveCount(0);
      await focus(page); await expect(inbox.locator('.inbox-notification-row')).toHaveCount(1);
      assert.equal(session.items.length, 1, 'Repeated reads do not duplicate the WhatsApp notification');
      await page.getByRole('button', { name: 'Notifications', exact: true }).click();
      await testControl(page).click(); await expect(testControl(page)).toHaveAttribute('aria-pressed', 'true');
      const callsInTest = session.calls.length; await openInbox(page); await focus(page);
      await expect(inbox.locator('.inbox-notification-row')).toHaveCount(0); assert.equal(session.calls.length, callsInTest);
      await shot('test-isolation');
      await page.getByRole('button', { name: 'Notifications', exact: true }).click(); await testControl(page).click();
      await expect(testControl(page)).toHaveAttribute('aria-pressed', 'false'); await openInbox(page);
      await expect(inbox.locator('.inbox-notification-row')).toHaveCount(1);
      await page.getByRole('button', { name: 'Notifications', exact: true }).click();
      await page.locator('.home-display-controls').getByRole('button', { name: 'View as', exact: true }).click();
      await page.locator('.home-display-controls').getByRole('button', { name: 'Normal trader', exact: true }).click();
      await expect(page.getByRole('status', { name: 'Role preview' }).first()).toBeVisible();
      const callsInPreview = session.calls.length; await openInbox(page); await focus(page);
      await expect(inbox.locator('.inbox-notification-row')).toHaveCount(0); assert.equal(session.calls.length, callsInPreview);
      await shot('preview-isolation');
      await page.getByRole('button', { name: 'Back to SAMPLE TRADER', exact: true }).first().click();
      await expect(page.getByRole('status', { name: 'Role preview' })).toHaveCount(0);
      session.items.push(makeReceipt(2, other)); session.user = structuredClone(other); await focus(page);
      await expect(page.locator('.hud-identity')).toContainText('OTHER TRADER'); await openInbox(page);
      await expect(inbox).toContainText('OTHER OWNER'); await expect(inbox).not.toContainText('WHATSAPP SYNTHETIC');
      await shot('other-owner');
      session.user = null; await focus(page); await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
      const callsSignedOut = session.calls.length; await focus(page);
      await expect(page.locator('.inbox-count')).toHaveCount(0); assert.equal(session.calls.length, callsSignedOut);
      await shot('signed-out'); assert.deepEqual(errors, []);
      results.push({ engine, width, theme, passed: true }); console.log(`PASS ${engine} ${width} ${theme}: WhatsApp notification, parser, durable read/reload, owner/TEST/VIEW AS/sign-out isolation`);
    } catch (error) { await shot('failure').catch(() => {}); throw error; } finally { await context.close(); }
  } } finally { await browser.close(); }
}
await writeFile(resolve(out, 'results.json'), JSON.stringify({ base, results, limits: 'Hosted UI with synthetic owner-scoped inbox API fixtures. This is not proof of Meta delivery, webhook authentication or database durability. Native Safari and physical devices untested.' }, null, 2));
