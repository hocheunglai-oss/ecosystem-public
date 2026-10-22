import { installSharedLocations, sharedLocations } from './fixtures/shared-locations.mjs';
import { installSharedAttachments } from './fixtures/shared-attachments.mjs';
import { invalidateFixtureAuthority } from './fixtures/authority-transition.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
const base = process.env.ECO_TEST_UI_ORIGIN || process.env.ECO_TEST_WORKSPACE_ORIGIN || 'http://127.0.0.1:4348';
const out = resolve(process.env.ECO_TEST_UI_OUTPUT || 'output/test-workspace-ui');
const otto = { id: '10000000-0000-4000-8000-000000000001', email: 'owner@example.test', displayName: 'OWNER FIXTURE', phone: '+6591815902', officeId: 'HONG KONG', officeName: 'HONG KONG', isAdmin: true, isSpcTrader: true, isManager: false, isActive: true, activated: true, passwordChangeSuggested: false, revision: 1, capabilities: { appearancePreview: true, testWorkspace: true } };
const g1 = '10000000-0000-4000-8000-000000000010', g2 = '10000000-0000-4000-8000-000000000011';
const liveKey = `ecosystem.live.v1:${otto.id}:state:v2`, testKey = generation => `ecosystem.test.v1:${otto.id}:${generation}:state`;
const legacyKey = `ecosystem.prototype.v2:${otto.id}`;
const results = [];
await mkdir(out, { recursive: true });
async function fixture(context) {
  const state = { user: { ...otto }, preview: null, policy: { enabled: true, generation: g1 }, policyError: false, writes: [] };
  await context.route('**/api/access/**', route => {
    const req = route.request(), path = new URL(req.url()).pathname.split('/api/access/')[1];
    if (!state.user && path === 'session') return route.fulfill({ status: 401, json: { message: 'Sign in required.' } });
    if (path === 'preview') { const input = req.postDataJSON(); state.preview = { ...input, officeName: input.officeId, readOnly: true }; }
    if (path === 'preview/end') state.preview = null;
    if (['session', 'preview', 'preview/end'].includes(path)) return route.fulfill({ json: { user: state.user, preview: state.preview } });
    return route.fulfill({ json: { requests: [], users: [state.user], offices: [{ id: 'HONG KONG', name: 'HONG KONG' }] } });
  });
  await context.route('**/api/enquiries/inbox*', route => { assert.equal(route.request().headers()['x-eco-data-mode'], 'live'); return route.fulfill({ json: { items: [], nextCursor: null, unreadCount: 0 } }); });
  await context.route('**/api/enquiries/test-policy', route => route.fulfill({ status: state.policyError ? 503 : 200, json: state.policyError ? { message: 'Unavailable' } : state.policy }));
  await context.route('**/api/admin/**', route => { if (route.request().method() !== 'GET') state.writes.push(route.request().url()); return route.fulfill({ json: { count: 0, items: [], periodStart: '2026-10-09T00:00:00Z', periodEnd: '2026-10-16T00:00:00Z', timeZone: 'Asia/Hong_Kong', source: 'shared-feedback' } }); });
  await context.route('**/api/suppliers/**', route => { if (route.request().method() !== 'GET') state.writes.push(route.request().url()); return route.fulfill({ json: { items: [], page: 1, pageSize: 100, total: 0 } }); });
  await context.route('**/api/profile-tabs/**', route => { if (route.request().method() !== 'GET') state.writes.push(route.request().url()); const url = new URL(route.request().url()); return route.fulfill({ json: { target: { kind: url.searchParams.get('kind'), id: url.searchParams.get('id') }, shared: { revision: 0, tabs: [] }, private: { revision: 0, tabs: [] } } }); });
  await installSharedLocations(context,{user:()=>state.user,preview:()=>state.preview});
  state.attachments = await installSharedAttachments(context,{user:()=>state.user,preview:()=>state.preview});
  return state;
}
const readState = (page, key) => page.evaluate(value => JSON.parse(localStorage.getItem(value)), key);
const focus = page => page.evaluate(() => dispatchEvent(new Event('focus')));
const control = page => page.locator('.home-display-controls').getByRole('button', { name: 'Test data', exact: true });
async function open(page, title) {
  const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
  const group = nav.getByRole('button', { name: title === 'Enquiries' ? 'Trading' : 'Buyers and Credit', exact: true });
  if (await group.getAttribute('aria-expanded') !== 'true') await group.click();
  await nav.getByRole('button', { name: title, exact: true }).click();
  return page.getByRole('dialog', { name: title, exact: true });
}
for (const [engine, browserType] of [['chromium', chromium], ['webkit', webkit]]) {
  if (process.env.ECO_TEST_ENGINE && process.env.ECO_TEST_ENGINE !== engine) continue;
  const browser = await browserType.launch({ headless: true });
  try { for (const width of [1440, 320, 390]) for (const theme of ['light', 'dark']) {
    if (process.env.ECO_TEST_WIDTH && +process.env.ECO_TEST_WIDTH !== width || process.env.ECO_TEST_THEME && process.env.ECO_TEST_THEME !== theme) continue;
    const context = await browser.newContext({ viewport: { width, height: 1000 }, isMobile: width < 760, hasTouch: width < 760, reducedMotion: 'reduce' });
    const state = await fixture(context);
    await context.addInitScript(({ theme, legacyKey }) => { localStorage.setItem('ecosystem.theme.v1', theme); localStorage.setItem(legacyKey, '{"preserved":"LEGACY COMMERCIAL EDITS"}'); localStorage.setItem('ecosystem.inbox.v2', '{"preserved":"LEGACY INBOX"}'); }, { theme, legacyKey });
    const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(10000);
    const shot = async name => { await expect(page.locator('[data-artwork-ready="true"]')).toBeVisible(); await page.evaluate(async () => { await Promise.all([...document.images].map(img => img.decode().catch(() => {}))); }); await page.screenshot({ path: `${out}/${engine}-${width}-${theme}-${name}.png`, fullPage: true }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: horizontal overflow`); };
    try {
      await page.goto(base); await expect(control(page)).toBeEnabled(); await expect(control(page)).toHaveAttribute('aria-pressed', 'false');
      await expect.poll(async () => (await readState(page, liveKey))?.companies.length).toBe(0);
      const liveBefore = JSON.stringify(await readState(page, liveKey)); await shot('live');
      await page.getByRole('button', { name: 'Notifications', exact: true }).click(); await expect(page.locator('.inbox-arrivals')).toHaveCount(0); await page.getByRole('button', { name: 'Notifications', exact: true }).click();
      await control(page).click(); await expect(control(page)).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(async () => (await readState(page, testKey(g1)))?.companies.length ?? 0).toBeGreaterThan(0);
      const data = await readState(page, testKey(g1)); assert.ok(data.enquiries.some(item => item.owner === otto.id)); assert.equal(data.enquiries.some(item => item.owner === 'otto'), false);
      await page.getByRole('button', { name: 'Notifications', exact: true }).click(); await page.getByRole('button', { name: 'WhatsApp (demo)', exact: true }).click(); await page.getByRole('button', { name: 'Normal enquiry', exact: true }).click();
      const inboxKey = testKey(g1).replace(/:state$/, ':inbox'); await expect.poll(async () => (await readState(page, inboxKey))?.items.length).toBe(1); assert.equal((await readState(page, inboxKey)).items[0].owner, otto.id);
      const dialog = await open(page, 'Buyer Profiles'); await expect(dialog.getByRole('textbox', { name: 'Search buyer profiles', exact: true })).toBeVisible(); await expect(dialog.locator('tbody tr').first()).toBeVisible(); await expect(dialog.getByRole('cell', { name: otto.id, exact: true })).toHaveCount(0); await shot('test-buyers');
      await page.getByRole('button', { name: 'Close workspace', exact: true }).click();
      await page.locator('.home-display-controls').getByRole('button', { name: 'View as', exact: true }).click();
      await page.locator('.home-display-controls').getByRole('button', { name: 'Normal trader', exact: true }).click();
      await expect(page.getByRole('status', { name: 'Role preview' }).first()).toBeVisible();
      await expect(control(page)).toBeDisabled(); await expect(control(page)).toHaveAttribute('aria-pressed', 'true');
      await page.getByRole('button', { name: 'Notifications', exact: true }).click(); await expect(page.locator('.inbox-arrivals')).toHaveCount(0); await page.getByRole('button', { name: 'Notifications', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: 'Buyer Profiles', exact: true }).count(), 0);
      await shot('test-preview');
      await page.getByRole('button', { name: 'Back to OWNER FIXTURE', exact: true }).first().click();
      await expect(control(page)).toBeEnabled(); await control(page).click(); await expect(control(page)).toHaveAttribute('aria-pressed', 'false');
      assert.equal(JSON.stringify(await readState(page, liveKey)), liveBefore);
      await page.reload(); await expect(control(page)).toBeEnabled(); await expect(control(page)).toHaveAttribute('aria-pressed', 'false');
      await control(page).click(); await expect(control(page)).toHaveAttribute('aria-pressed', 'true');
      state.policyError = true; await focus(page); await expect(control(page)).toBeDisabled(); await expect(control(page)).toHaveAttribute('aria-pressed', 'false');
      assert.ok(await readState(page, testKey(g1)), 'Network error preserves test edits without exposing them');
      state.policyError = false; state.policy = { enabled: true, generation: g2 }; await focus(page); await expect(control(page)).toBeEnabled();
      assert.equal(await readState(page, testKey(g1)), null); assert.equal(await readState(page, inboxKey), null); await expect(control(page)).toHaveAttribute('aria-pressed', 'false');
      await control(page).click(); await expect.poll(async () => (await readState(page, testKey(g2)))?.companies.length ?? 0).toBeGreaterThan(0);
      state.policy = { enabled: false, generation: '' }; await focus(page); await expect(control(page)).toBeDisabled(); await expect(control(page)).toHaveAttribute('aria-pressed', 'false');
      assert.equal(await readState(page, testKey(g2)), null);
      state.policy = { enabled: true, generation: g2 }; await focus(page); await expect(control(page)).toBeEnabled();
      await control(page).click(); await expect(control(page)).toHaveAttribute('aria-pressed', 'true');
      state.user = { ...otto, capabilities: { appearancePreview: true, testWorkspace: false } }; await invalidateFixtureAuthority(page, { user: state.user, preview: state.preview });
      await expect(control(page)).toHaveCount(0);
      assert.equal(JSON.stringify(await readState(page, liveKey)), liveBefore, 'Same-account capability revocation restores LIVE without touching its records');
      state.user = { ...otto, id: '10000000-0000-4000-8000-000000000002', email: 'another@example.test', displayName: 'OTHER ADMIN', capabilities: { appearancePreview: false, testWorkspace: false } }; await invalidateFixtureAuthority(page, { user: state.user, preview: state.preview });
      await expect(page.locator('.hud-identity')).toContainText('OTHER ADMIN'); await expect(control(page)).toHaveCount(0);
      const otherKey = `ecosystem.live.v1:${state.user.id}:state:v2`; await expect.poll(async () => (await readState(page, otherKey))?.companies.length).toBe(0); await shot('other-admin');
      state.user = null; await invalidateFixtureAuthority(page, { user: null, preview: state.preview }); await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible(); await expect(control(page)).toHaveCount(0); await shot('signed-out');
      assert.equal(await page.evaluate(key => localStorage.getItem(key), legacyKey), '{"preserved":"LEGACY COMMERCIAL EDITS"}');
      assert.deepEqual(state.writes, []); assert.deepEqual(sharedLocations(page).requests, [], 'TEST data and previews never write shared LIVE location records');
      assert.deepEqual(state.attachments.requests.filter(request => request.body !== undefined), [], 'TEST data and previews never mutate shared LIVE attachments');
      assert.equal(state.attachments.putCount, 0, 'TEST data and previews never upload shared LIVE attachment bytes'); assert.deepEqual(errors, []);
      results.push({ engine, width, theme, passed: true }); console.log(`PASS ${engine} ${width} ${theme}: live/test isolation, role preview, reload, error, rotation, revocation, other admin, signed out`);
    } catch (error) { await shot('failure'); throw error; } finally { await context.close(); }
  } } finally { await browser.close(); }
}
await writeFile(`${out}/verification.json`, JSON.stringify({ base, results, limits: 'Isolated authenticated browser fixtures; physical devices and native Safari not tested.' }, null, 2));
