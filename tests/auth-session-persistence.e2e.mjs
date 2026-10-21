import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { installStagingCookies } from './fixtures/protection-cookies.mjs';
const base = process.env.ECO_AUTH_UI_ORIGIN || 'http://127.0.0.1:4396';
const out = resolve(process.env.ECO_AUTH_UI_OUTPUT || 'output/auth-session-ui');
const member = { id: '10000000-0000-4000-8000-000000000001', email: 'trader@example.test', displayName: 'SAMPLE TRADER', officeId: 'HONG KONG', officeName: 'HONG KONG', isAdmin: false, isSpcTrader: false, isManager: false, isActive: true, activated: true, passwordChangeSuggested: false, revision: 1 };
await mkdir(out, { recursive: true }); const results = [];
for (const [engine, kind] of [['chromium', chromium], ['webkit', webkit]]) {
  if (process.env.ECO_TEST_ENGINE && process.env.ECO_TEST_ENGINE !== engine) continue;
  const browser = await kind.launch({ headless: true });
  try { for (const width of [1440, 320, 390]) for (const theme of ['light', 'dark']) {
    if (process.env.ECO_TEST_WIDTH && +process.env.ECO_TEST_WIDTH !== width || process.env.ECO_TEST_THEME && process.env.ECO_TEST_THEME !== theme) continue;
    const context = await browser.newContext({ viewport: { width, height: 1000 }, isMobile: width < 760, hasTouch: width < 760, reducedMotion: 'reduce', colorScheme: theme });
    await installStagingCookies(context, base);
    await context.addInitScript(value => localStorage.setItem('ecosystem.theme.v1', value), theme);
    const errors = [], unexpected = [], mutations = [];
    let mode = 'unavailable', requests = 0, held = null, sessionRevision = 0;
    const session = () => ({ user: { ...member, revision: ++sessionRevision, displayName: `${member.displayName} SESSION ${sessionRevision}` }, preview: null });
    await context.route('**/api/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path === '/api/access/session') {
        requests++;
        if (mode === 'hold') { held = route; return; }
        if (mode === 'network') return route.abort('failed');
        const valid = mode === 'valid';
        const reply = mode === 'revoked' ? { status: 401, json: { user: null } } : mode === 'unavailable' ? { status: 503, json: { message: 'Session check unavailable.' } } : { json: session() };
        // Model real network latency so the test cannot mistake a requested
        // recovery for an accepted session and race the next failure scenario.
        if (valid) await new Promise(resolve => setTimeout(resolve, 300));
        return route.fulfill(reply);
      }
      if (path === '/api/access/password') { mutations.push(path); return route.fulfill({ json: session() }); }
      if (path === '/api/access/logout') { mutations.push(path); mode = 'revoked'; return route.fulfill({ json: { user: null } }); }
      if (path === '/api/access/login') { mutations.push(path); mode = 'valid'; return route.fulfill({ json: session() }); }
      if (path === '/api/profile-tabs/list') { const query = new URL(request.url()).searchParams; return route.fulfill({ json: { target: { kind: query.get('kind'), id: query.get('id') }, shared: { revision: 0, tabs: [] }, private: { revision: 0, tabs: [] } } }); }
      if (path === '/api/intelligence/snapshot') return route.fulfill({ json: { available: false, snapshot: null } });
      if (path === '/api/enquiries/test-policy') return route.fulfill({ json: { enabled: false, generation: '' } });
      if (path === '/api/enquiries/inbox') return route.fulfill({ json: { items: [], unreadCount: 0, nextCursor: null } });
      if (path === '/api/access/phone-requests') return route.fulfill({ json: { requests: [] } });
      if (path.startsWith('/api/admin/')) return route.fulfill({ json: { items: [], count: 0, nextCursor: null, periodStart: '2026-10-15T00:00:00Z', periodEnd: '2026-10-22T00:00:00Z', timeZone: 'Asia/Hong_Kong', source: 'shared-feedback' } });
      unexpected.push(path); return route.fulfill({ status: 503, json: { message: 'Unmatched fixture request.' } });
    });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    const focus = () => page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const isSession = request => new URL(request.url()).pathname === '/api/access/session';
    async function committedSession(action) {
      const pending = page.waitForResponse(response => isSession(response.request()) && response.status() === 200);
      await action();
      const response = await pending;
      assert.equal(await response.finished(), null, 'recovery response finished successfully');
      const accepted = await response.json();
      // This value changes only in a fresh authenticated response. Seeing it in
      // the account header proves React consumed that exact response; an unchanged
      // form value or request count cannot establish completed recovery.
      await expect(page.locator('.hud-identity strong')).toHaveText(accepted.user.displayName);
    }
    async function failedSession(failureMode) {
      const completed = failureMode === 'network'
        ? page.waitForEvent('requestfailed', { predicate: isSession })
        : page.waitForResponse(response => isSession(response.request()) && response.status() === 503);
      mode = failureMode; await focus();
      const result = await completed;
      if (failureMode !== 'network') assert.equal(await result.finished(), null);
    }
    const shot = async name => {
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), name + ': overflow');
      await page.screenshot({ path: resolve(out, `${engine}-${width}-${theme}-${name}.png`), animations: 'disabled', fullPage: true });
    };
    const signIn = async () => {
      await page.getByLabel('Email', { exact: true }).fill(member.email);
      await page.getByLabel('Password', { exact: true }).fill('Synthetic Password 8');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByRole('main', { name: 'ECOSYSTEM workspace' })).toBeVisible();
    };
    try {
      // No browser-stored identity can authenticate while the service is offline.
      await page.goto(base); await expect(page.getByRole('alert')).toContainText('Reconnecting');
      await expect(page.getByRole('main', { name: 'ECOSYSTEM workspace' })).toHaveCount(0);
      // Bounded automatic retry succeeds without entering a password.
      await committedSession(() => { mode = 'valid'; });
      await expect(page.getByRole('main', { name: 'ECOSYSTEM workspace' })).toBeVisible();
      assert.equal(mutations.length, 0);
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const draft = page.getByLabel('New password', { exact: true });
      await draft.fill('Unsaved Fixture 8');
      for (const temporary of ['unavailable', 'network']) {
        await failedSession(temporary);
        await page.getByLabel('Current password', { exact: true }).fill('Synthetic Current 8');
        await page.getByLabel('Confirm password', { exact: true }).fill('Unsaved Fixture 8');
        await page.getByRole('button', { name: 'Change password', exact: true }).click();
        await expect(page.getByRole('alert')).toContainText('SESSION TO RECONNECT');
        assert.equal(mutations.length, 0, 'unverified local writes never reach API');
        await expect(draft).toHaveValue('Unsaved Fixture 8');
        await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);
        await committedSession(async () => { mode = 'valid'; await page.evaluate(() => window.dispatchEvent(new Event('online'))); });
        await expect(draft).toHaveValue('Unsaved Fixture 8');
      }
      await shot('recovered-draft');
      await page.getByRole('button', { name: 'Change password', exact: true }).click();
      await expect(page.locator('.password-settings [role="status"]')).toHaveText('Password changed.');
      await draft.fill('Unsaved Fixture 8');
      mode = 'hold'; held = null; const before = requests;
      await page.evaluate(() => { for (let i = 0; i < 8; i++) { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); } });
      await expect.poll(() => Boolean(held)).toBe(true);
      assert.equal(requests, before + 1, 'overlapping refresh triggers share one server check');
      await committedSession(async () => { mode = 'valid'; await held.fulfill({ json: session() }); }); held = null;
      await expect(draft).toHaveValue('Unsaved Fixture 8');
      // The browser-local knowledge store also rejects changes during a session outage.
      await page.getByRole('button', { name: 'Close workspace', exact: true }).click();
      const navigation = page.getByRole('navigation', { name: 'Workspace navigation' });
      const group = navigation.getByRole('button', { name: 'Ports & Suppliers', exact: true });
      if (await group.getAttribute('aria-expanded') !== 'true') await group.click();
      await navigation.getByRole('button', { name: 'Countries & Ports', exact: true }).click();
      const locations = page.getByRole('dialog', { name: 'Countries & Ports', exact: true });
      await locations.getByRole('button', { name: 'Add location', exact: true }).click();
      const form = page.getByRole('dialog', { name: 'Add location', exact: true });
      await form.getByLabel('Name', { exact: true }).fill('SESSION FIXTURE PORT');
      await form.getByLabel('Country', { exact: true }).selectOption({ label: 'Japan' });
      const key = `ecosystem.live.v1:${member.id}:state`;
      const portsBefore = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).ports.length, key);
      await failedSession('unavailable');
      await form.getByRole('button', { name: 'Add location', exact: true }).click();
      await expect(form.getByRole('alert')).toContainText('SESSION TO RECONNECT');
      assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).ports.length, key), portsBefore);
      await expect(form.getByLabel('Name', { exact: true })).toHaveValue('SESSION FIXTURE PORT');
      await committedSession(async () => { mode = 'valid'; await focus(); });
      await form.getByRole('button', { name: 'Add location', exact: true }).click();
      await expect(form).toHaveCount(0);
      assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).ports.length, key), portsBefore + 1);
      await locations.getByRole('button', { name: 'Close workspace', exact: true }).click();
      // A definitive revocation still clears the UI and its unsaved account form.
      mode = 'revoked'; await focus();
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
      await expect(draft).toHaveCount(0);
      await signIn();
      // A response started before logout cannot restore a signed-out account.
      mode = 'hold'; held = null; await focus(); await expect.poll(() => Boolean(held)).toBe(true);
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
      await held.fulfill({ json: session() }).catch(() => {}); held = null;
      await expect(page.getByRole('main', { name: 'ECOSYSTEM workspace' })).toHaveCount(0);
      await signIn();
      // Cross-tab invalidation interrupts an old check and obtains fresh authority.
      mode = 'hold'; held = null; await focus(); await expect.poll(() => Boolean(held)).toBe(true);
      const stale = held; mode = 'revoked';
      await page.evaluate(() => { const channel = new BroadcastChannel('eco-access-invalidation'); channel.postMessage('refresh-needed'); channel.close(); });
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
      await stale.fulfill({ json: session() }).catch(() => {});
      await expect(page.getByRole('main', { name: 'ECOSYSTEM workspace' })).toHaveCount(0);
      assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
      assert.deepEqual(mutations, ['/api/access/password', '/api/access/login', '/api/access/logout', '/api/access/login']);
      results.push({ engine, width, theme, ok: true }); console.log(`PASS ${engine} ${width} ${theme}`);
    } catch (error) { await shot('failure').catch(() => {}); throw error; }
    finally { await context.close(); }
  } } finally { await browser.close(); }
}
await writeFile(resolve(out, 'results.json'), JSON.stringify({ base, results, checked: 'Initial 503 automatic recovery, background 503/network preserves unsaved form and blocks writes until verified recovery, online recovery, single-flight refresh, definitive 401, logout race, cross-tab invalidation.', limits: 'Isolated browsers and synthetic API responses; cookie expiry/rotation/revocation also covered by real Supabase SDK adapter unit tests.' }, null, 2));
