import { installSharedLocations, sharedLocations } from './fixtures/shared-locations.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit, expect } from '@playwright/test';
import { installEmptyLiveInbox } from './fixtures/empty-live-inbox.mjs';
import { installProfileTabMocks } from './fixtures/profile-tabs.mjs';
import { installStagingCookies } from './fixtures/protection-cookies.mjs';
import { invalidateFixtureAuthority } from './fixtures/authority-transition.mjs';

const base = process.env.ECO_KNOWLEDGE_SEARCH_ORIGIN || 'http://127.0.0.1:4397';
const out = process.env.ECO_KNOWLEDGE_SEARCH_OUTPUT || '/private/tmp/eco-knowledge-supplier-search';
const user = { id: '10000000-0000-4000-8000-000000000001', email: 'search@example.test', displayName: 'SEARCH FIXTURE', phone: '', officeId: 'HONG KONG', officeName: 'HONG KONG', isAdmin: false, isSpcTrader: false, isManager: false, isActive: true, activated: true, passwordChangeSuggested: false, revision: 1 };
const item = { id: '90000000-0000-4000-8000-000000000001', legacyIds: [], sourceKey: 'SYNTHETIC ALPHA', legalName: 'ALPHA MARINE LTD', shortName: 'ALPHA', aliases: [], countryCode: 'SG', countryName: 'Singapore', portName: 'Singapore', nameStatus: 'verified', legalNameSourceId: null, revision: 1, updatedAt: '2026-10-21T00:00:00Z', info: { paymentTerms: '30', qualityClaimBar: '30', supplierTrader: '', availableGrade: 'VLSFO', foBdn: '', goBdn: '' }, contactCount: 0, bargeCount: 0 };
const btn = (scope, name) => scope.getByRole('button', { name, exact: true });
const results = [];
await mkdir(out, { recursive: true });

async function fixture(context) {
  const state = { user: structuredClone(user), requests: [], writes: [], fail: false, gates: new Map() };
  await context.route('**/api/**', route => {
    if (route.request().method() !== 'GET') state.writes.push(route.request().url());
    return route.fulfill({ status: 404, json: { message: 'Synthetic fixture only.' } });
  });
  await installEmptyLiveInbox(context);
  await installSharedLocations(context, { user: () => state.user, preview: () => state.preview });
  await installProfileTabMocks(context, { ownerId: () => state.user?.id });
  await context.route('**/api/access/**', route => route.fulfill(state.user ? { json: { user: state.user, preview: null } } : { status: 401, json: { message: 'Sign in required.' } }));
  await context.route('**/api/admin/**', route => route.fulfill({ json: { count: 0, items: [] } }));
  await context.route('**/api/enquiries/test-policy', route => route.fulfill({ json: { enabled: false } }));
  await context.route('**/api/suppliers/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() !== 'GET') { state.writes.push(request.url()); return route.fulfill({ status: 403, json: { message: 'Read only fixture.' } }); }
    if (url.pathname.endsWith('/pic-options')) return route.fulfill({ json: { options: [] } });
    if (!url.pathname.endsWith('/list')) return route.fulfill({ status: 404, json: { message: 'Unexpected supplier request.' } });
    const search = url.searchParams.get('search') || '', limit = Number(url.searchParams.get('limit') || 50), portId = url.searchParams.get('portId');
    state.requests.push({ search, limit, portId });
    const gate = limit === 1 ? state.gates.get(search) : undefined;
    if (gate) { gate.started = true; await gate.promise; }
    if (state.fail && search === 'UNAVAILABLE') return route.fulfill({ status: 503, json: { message: 'Fixture supplier service unavailable.' } });
    const items = portId === 'port-singapore' && `${item.legalName} ${item.shortName}`.toLowerCase().includes(search.toLowerCase()) ? [item] : [];
    await route.fulfill({ json: { items: items.slice(0, limit), total: items.length, page: 1, pageSize: limit } }).catch(() => {});
    if (gate) gate.finished = true;
  });
  return state;
}
function hold(state, query) {
  const gate = { started: false };
  gate.promise = new Promise(resolve => { gate.release = resolve; }); state.gates.set(query, gate); return gate;
}

for (const [engine, type] of [['chromium', chromium], ['webkit', webkit]]) {
  if (process.env.ECO_TEST_ENGINE && process.env.ECO_TEST_ENGINE !== engine) continue;
  const browser = await type.launch({ headless: true });
  try { for (const width of [1440, 320, 390]) for (const theme of ['light', 'dark']) {
    if (process.env.ECO_TEST_WIDTH && Number(process.env.ECO_TEST_WIDTH) !== width || process.env.ECO_TEST_THEME && process.env.ECO_TEST_THEME !== theme) continue;
    const context = await browser.newContext({ viewport: { width, height: width < 760 ? 844 : 1000 }, isMobile: width < 760, hasTouch: width < 760, reducedMotion: 'reduce', colorScheme: theme });
    await installStagingCookies(context, base); const state = await fixture(context);
    await context.addInitScript(theme => localStorage.setItem('ecosystem.theme.v1', theme), theme);
    const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
    const shot = async name => { await page.screenshot({ path: `${out}/${engine}-${width}-${theme}-${name}.png` }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); };
    try {
      await page.goto(base); await page.getByRole('main', { name: 'ECOSYSTEM workspace' }).waitFor();
      sharedLocations(page).seed(saved => {
        saved.knowledgeRecords['port:port-singapore'] = { version: 1, layoutVersion: 2, sections: [
          { id: 'operations', title: 'OPERATIONS', blocks: [{ id: 'standards', type: 'text', title: 'BUNKERING STANDARD', text: 'SS 600 PROCEDURES REMAIN AVAILABLE IN SEARCH.' }] },
          { id: 'suppliers', role: 'suppliers', title: 'SUPPLIERS', blocks: [] },
        ] };
      });
      await page.reload(); const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
      await btn(nav, 'Ports & Suppliers').click(); await btn(nav, 'Countries & Ports').click();
      const workspace = page.getByRole('dialog', { name: 'Countries & Ports', exact: true });
      await btn(workspace, 'Port Index').click(); await workspace.getByLabel('Country or port', { exact: true }).fill('Singapore');
      await btn(workspace.locator('.location-table'), 'Singapore').click();
      const search = workspace.getByRole('textbox', { name: 'Search all tabs', exact: true });
      const supplierSection = workspace.locator('.knowledge-search-section').filter({ has: page.locator('.knowledge-search-section-head').getByRole('button', { name: 'SUPPLIERS', exact: true }) });
      await search.fill(' SS:600 ');
      await expect(workspace.getByRole('heading', { name: 'BUNKERING STANDARD', exact: true })).toBeVisible();
      await expect.poll(() => state.requests.some(request => request.search === 'SS:600' && request.limit === 1 && request.portId === 'port-singapore')).toBe(true);
      await expect(workspace.getByText('Searching suppliers…', { exact: true })).toHaveCount(0);
      await expect(supplierSection).toHaveCount(0); await shot('matching-notes-no-empty-suppliers');

      await search.fill('ALPHA');
      await expect(supplierSection.getByRole('table', { name: 'Supplier results', exact: true })).toContainText('ALPHA');
      await expect(supplierSection.locator('tbody tr')).toHaveCount(1); await shot('matching-supplier');
      await search.fill('SUPPLIERS');
      await expect(supplierSection.locator('tbody tr')).toHaveCount(1);
      await expect(supplierSection.getByLabel('Search suppliers', { exact: true })).toHaveValue('');

      const old = hold(state, 'ALPHA'), current = hold(state, 'NO CURRENT MATCH');
      await search.fill('ALPHA'); await expect.poll(() => old.started).toBe(true);
      await search.fill('NO CURRENT MATCH'); await expect.poll(() => current.started).toBe(true);
      old.release(); await expect.poll(() => old.finished).toBe(true);
      await expect(workspace.getByText('Searching suppliers…', { exact: true })).toBeVisible();
      await expect(supplierSection).toHaveCount(0); await expect(workspace.getByText('No results', { exact: true })).toHaveCount(0);
      current.release(); await expect(workspace.getByText('No results', { exact: true })).toBeVisible(); await expect(supplierSection).toHaveCount(0);

      state.fail = true; await search.fill('UNAVAILABLE');
      await expect(workspace.getByRole('alert')).toContainText('Supplier search unavailable.');
      await expect(workspace.getByText('No results', { exact: true })).toHaveCount(0); await expect(supplierSection).toHaveCount(0); await shot('retryable-search-error');
      state.fail = false; await btn(workspace, 'Retry supplier search').click();
      await expect(workspace.getByText('No results', { exact: true })).toBeVisible(); await expect(workspace.getByRole('alert')).toHaveCount(0);
      await btn(workspace, 'Clear information search').click(); await workspace.getByRole('tab', { name: 'SUPPLIERS', exact: true }).click();
      await expect(workspace.getByRole('table', { name: 'Supplier results', exact: true })).toContainText('ALPHA');
      state.user = null; await invalidateFixtureAuthority(page, { user: null, preview: null });
      await expect(page.getByRole('main', { name: 'ECOSYSTEM workspace' })).toHaveCount(0);
      assert.deepEqual(errors, []); assert.deepEqual(state.writes, []);
      results.push({ engine, width, theme, passed: true }); console.log(`PASS knowledge supplier search ${engine} ${width} ${theme}`);
    } catch (error) { await shot('failure').catch(() => {}); throw error; }
    finally { for (const gate of state.gates.values()) gate.release(); await context.close(); await writeFile(`${out}/results.json`, JSON.stringify({ base, results }, null, 2)); }
  } } finally { await browser.close(); }
}
