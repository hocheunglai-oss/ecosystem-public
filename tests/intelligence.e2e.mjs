import { installSharedLocations, sharedLocations } from './fixtures/shared-locations.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { syntheticIntelligence } from './fixtures/intelligence.mjs';
import { installStagingCookies } from './fixtures/protection-cookies.mjs';
import { installEmptyLiveInbox } from './fixtures/empty-live-inbox.mjs';
import { invalidateFixtureAuthority } from './fixtures/authority-transition.mjs';

const base = process.env.ECO_INTELLIGENCE_ORIGIN || 'http://127.0.0.1:4398';
const out = resolve(process.env.ECO_INTELLIGENCE_OUTPUT || 'output/intelligence-ui');
const sessionLatency = Number(process.env.ECO_TEST_SESSION_LATENCY_MS || 0);
const user = { id: '10000000-0000-4000-8000-000000000001', email: 'intelligence-admin@example.test', displayName: 'REFERENCE ADMIN', phone: '', officeId: 'HONG KONG', officeName: 'HONG KONG', isAdmin: true, isSpcTrader: true, isManager: false, isActive: true, activated: true, passwordChangeSuggested: false, revision: 1, capabilities: { appearancePreview: true, testWorkspace: true } };
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const results = [];
await mkdir(out, { recursive: true });
async function fixture(context) {
  const state = { user: structuredClone(user), preview: null, latency: 0, snapshot: syntheticIntelligence(), status: 200, requests: 0, writes: [], hold: false, pending: [] };
  await context.route('**/api/**', route => { if (route.request().method() !== 'GET') state.writes.push(route.request().url()); return route.fulfill({ status: 404, json: { message: 'Isolated fixture only' } }); });
  await installEmptyLiveInbox(context);
  await installSharedLocations(context, { user: () => state.user, preview: () => state.preview });
  await context.route('**/api/access/**', async route => {
    const path = new URL(route.request().url()).pathname.split('/api/access/')[1];
    if (path === 'session') {
      const response = { status: state.user ? 200 : 401, json: state.user ? structuredClone({ user: state.user, preview: state.preview }) : { message: 'Sign in required.' } };
      if (state.latency > 0) await new Promise(resolve => setTimeout(resolve, state.latency));
      return route.fulfill(response).catch(() => {});
    }
    if (!state.user) return route.fulfill({ status: 401, json: { message: 'Sign in required.' } });
    if (path === 'phone-requests') return route.fulfill({ json: { requests: [] } });
    if (path === 'users') return route.fulfill({ json: { users: [state.user], offices: [{ id: 'HONG KONG', name: 'HONG KONG' }] } });
    return route.fulfill({ status: 403, json: { message: 'No fixture mutation allowed' } });
  });
  await context.route('**/api/intelligence/snapshot', async route => {
    state.requests++; assert.equal(route.request().method(), 'GET');
    const json = { available: state.snapshot !== null, snapshot: structuredClone(state.snapshot) }, status = state.status;
    if (state.hold) { state.hold = false; await new Promise(done => state.pending.push(done)); }
    await route.fulfill({ status, json }).catch(() => {});
  });
  await context.route('**/api/enquiries/test-policy', route => route.fulfill({ json: { enabled: true, generation: '10000000-0000-4000-8000-000000000010' } }));
  await context.route('**/api/profile-tabs/list?**', route => { const url = new URL(route.request().url()); return route.fulfill({ json: { target: { kind: url.searchParams.get('kind'), id: url.searchParams.get('id') }, shared: { revision: 0, tabs: [] }, private: { revision: 0, tabs: [] } } }); });
  await context.route('**/api/suppliers/**', route => route.fulfill({ json: { items: [], page: 1, pageSize: 50, total: 0 } }));
  await context.route('**/api/admin/**', route => route.fulfill({ json: { count: 0, items: [], periodStart: '2026-01-08T00:00:00Z', periodEnd: '2026-01-15T00:00:00Z', timeZone: 'Asia/Hong_Kong', source: 'shared-feedback' } }));
  return state;
}
async function openPort(page) {
  const existing = page.getByRole('dialog', { name: 'Countries & Ports', exact: true });
  if (await existing.count()) await button(existing, 'Close workspace').click();
  const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
  if (await button(nav, 'Ports & Suppliers').getAttribute('aria-expanded') !== 'true') await button(nav, 'Ports & Suppliers').click();
  await button(nav, 'Countries & Ports').click();
  const dialog = page.getByRole('dialog', { name: 'Countries & Ports', exact: true });
  const input = dialog.getByLabel('Country or port', { exact: true });
  await expect(input).toBeVisible();
  await button(dialog, 'Port Index').click();
  await input.fill('Singapore');
  await dialog.locator('.location-table').getByRole('button', { name: 'Singapore', exact: true }).click();
  await dialog.getByRole('tab', { name: /Port Information/i }).first().click();
  return dialog;
}
const focus = page => page.evaluate(() => window.dispatchEvent(new Event('focus')));
async function geometry(page, width) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Viewport must not overflow');
  const region = page.locator('.knowledge-top-suppliers');
  const box = await region.boundingBox();
  assert.ok(box && box.x >= -1 && box.x + box.width <= width + 1, 'Ranking fits viewport');
  const overlapping = await region.locator('li').evaluateAll(rows => rows.some(row => {
    const name = row.querySelector('.knowledge-top-supplier-name')?.getBoundingClientRect(), count = row.querySelector('.knowledge-top-supplier-count')?.getBoundingClientRect();
    return name && count && name.right > count.left + 1 && name.bottom > count.top && name.top < count.bottom;
  }));
  assert.equal(overlapping, false, 'Supplier names and fixture counts do not overlap');
}
for (const [engine, type] of [['chromium', chromium], ['webkit', webkit]]) {
  if (process.env.ECO_TEST_ENGINE && process.env.ECO_TEST_ENGINE !== engine) continue;
  const browser = await type.launch({ headless: true });
  try { for (const width of [1440, 320, 390]) for (const theme of ['light', 'dark']) {
    if (process.env.ECO_TEST_WIDTH && Number(process.env.ECO_TEST_WIDTH) !== width || process.env.ECO_TEST_THEME && process.env.ECO_TEST_THEME !== theme) continue;
    const context = await browser.newContext({ viewport: { width, height: 1000 }, isMobile: width < 760, hasTouch: width < 760, reducedMotion: 'reduce', colorScheme: theme });
    await installStagingCookies(context, base); const state = await fixture(context);
    await context.addInitScript(theme => localStorage.setItem('ecosystem.theme.v1', theme), theme);
    const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(15_000);
    const shot = async name => page.screenshot({ path: resolve(out, `${engine}-${width}-${theme}-${name}.png`), fullPage: true });
    try {
      await page.goto(base); let dialog = await openPort(page);
      const ranking = page.locator('.knowledge-top-suppliers');
      await expect(ranking.locator('li')).toHaveCount(10);
      await expect(ranking.locator('li').first()).toContainText('SYNTHETIC SUPPLIER 12');
      await expect(ranking).toContainText('2026-01-14');
      await geometry(page, width); await ranking.evaluate(node => node.scrollIntoView({ block: 'start' })); await shot('ranking');
      if (width < 760) { await ranking.locator('li').last().scrollIntoViewIfNeeded(); await shot('ranking-bottom'); }
      await expect.poll(() => page.evaluate(() => Object.values(localStorage).some(value => value.includes('SYNTHETIC SUPPLIER')))).toBe(false);
      await dialog.getByRole('button', { name: /^Attachments(?: for.*)?$/i }).first().click();
      const attachments = page.getByRole('dialog', { name: 'Attachments', exact: true });
      await attachments.getByRole('navigation', { name: 'Attachment folders' }).getByRole('button', { name: 'Suppliers', exact: true }).click();
      await expect(attachments.locator('.attachment-folder-tile')).toHaveCount(12); await shot('attachment-references');
      state.snapshot = null; await focus(page);
      await expect(attachments).toContainText('Supplier data unavailable'); await expect(attachments.locator('.attachment-folder-tile')).toHaveCount(0);
      await button(attachments, 'Close dialog').click();
      await button(dialog, 'Close workspace').click();
      const control = page.locator('.home-display-controls').getByRole('button', { name: 'Test data', exact: true });
      await expect(control).toBeEnabled(); state.snapshot = syntheticIntelligence();
      const beforeTest = state.requests; await control.click(); await expect(control).toHaveAttribute('aria-pressed', 'true');
      dialog = await openPort(page); await expect(ranking.locator('li')).toHaveCount(10); assert.ok(state.requests > beforeTest, 'TEST namespace fetches its own authorized references');
      await button(dialog, 'Close workspace').click(); await control.click(); await expect(control).toHaveAttribute('aria-pressed', 'false');
      dialog = await openPort(page); await expect(ranking.locator('li')).toHaveCount(10);
      state.snapshot = null; await focus(page); await expect(ranking).toContainText('Fixture data unavailable'); await expect(ranking.locator('li')).toHaveCount(0); await ranking.scrollIntoViewIfNeeded(); await shot('unavailable');
      state.snapshot = syntheticIntelligence(); state.status = 503; await focus(page); await expect(ranking).toContainText('Fixture data unavailable');
      state.status = 200; await focus(page); await expect(ranking.locator('li')).toHaveCount(10);
      await page.evaluate(() => window.dispatchEvent(new Event('offline'))); await expect(ranking).toContainText('Fixture data unavailable');
      await focus(page); await expect(ranking.locator('li')).toHaveCount(10);
      state.snapshot = { ...syntheticIntelligence(), periodStart: '2026-01-01', suppliers: syntheticIntelligence().suppliers.map(item => ({ ...item, fixturePeriod: '2026-01-01 – 2026-01-14' })) };
      await focus(page); await expect(ranking).toContainText('2026-01-01 – 2026-01-14');
      await ranking.evaluate(node => node.scrollIntoView({ block: 'start' })); await geometry(page, width); await shot('dated-period');
      state.snapshot = syntheticIntelligence();
      state.latency = sessionLatency;
      state.hold = true; await focus(page); await expect.poll(() => state.pending.length).toBe(1);
      state.user = { ...user, capabilities: { appearancePreview: false, testWorkspace: false }, id: '20000000-0000-4000-8000-000000000001', email: 'second@example.test', displayName: 'REFERENCE TRADER', isAdmin: false, isSpcTrader: false };
      state.snapshot = { ...syntheticIntelligence(), suppliers: syntheticIntelligence().suppliers.map(item => ({ ...item, name: item.name.replace('SYNTHETIC', 'SECOND') })) };
      await invalidateFixtureAuthority(page, { user: state.user, preview: state.preview }); await expect(page.getByText('REFERENCE TRADER', { exact: true }).first()).toBeVisible();
      state.pending.splice(0).forEach(done => done());
      dialog = await openPort(page); await expect(ranking).toContainText('SECOND SUPPLIER 12'); await expect(ranking).not.toContainText('SYNTHETIC SUPPLIER');
      state.user = { ...user }; state.preview = { role: 'trader', officeId: 'HONG KONG', officeName: 'HONG KONG', readOnly: true };
      await invalidateFixtureAuthority(page, { user: state.user, preview: state.preview }); await expect(page.getByText(/Preview.*Read only/i).first()).toBeVisible();
      await openPort(page); await expect(ranking).toContainText('SECOND SUPPLIER 12');
      state.user = null; state.preview = null; await invalidateFixtureAuthority(page, { user: state.user, preview: state.preview }); await expect(button(page, 'Sign in')).toBeVisible();
      const signedOutRequests = state.requests; await focus(page); await page.waitForTimeout(100); assert.equal(state.requests, signedOutRequests, 'Signed-out does not fetch private references');
      await expect(ranking).toHaveCount(0); await shot('signed-out'); assert.deepEqual(errors, []); assert.deepEqual(state.writes, []);
      results.push({ engine, width, theme, passed: true });
    } catch (error) { await shot('failure').catch(() => {}); results.push({ engine, width, theme, passed: false, error: error.message }); throw error; }
    finally { state.pending.splice(0).forEach(done => done()); await context.close(); await writeFile(resolve(out, 'report.json'), JSON.stringify({ origin: base, results }, null, 2)); }
  } } finally { await browser.close(); }
}
console.log(`Intelligence UI: ${results.length} cases passed`);
