import { activateDeveloperMode } from './fixtures/test-workspace.mjs';
import { installSharedLocations, sharedLocations } from './fixtures/shared-locations.mjs';
import { installSharedAttachments } from './fixtures/shared-attachments.mjs';
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
const documentName = 'SYNTHETIC SINGAPORE REFINERY GUIDE.PDF';
const monthLabels = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, current: 2675 + i * 250, previous: 1531 + i * 100 }));
const point = [{ label: 'SYNTHETIC SUPPLIER 12', value: 2375 }];
const report = {
  year: 2026, through: '2026-11-25', monthly: monthLabels, estimated: true, cancelled: 2,
  volumeBySupplier: point, fixturesBySupplier: [{ ...point[0], value: 10 }],
  volumeByOffice: [{ label: 'GENOA', value: 2375 }], fixturesByOffice: [{ label: 'GENOA', value: 10 }],
  bySupplierTrader: [{ label: 'SYNTHETIC TRADER', value: 10 }], enquiries: 22,
  byBuyerOffice: [{ label: 'GENOA', enquiries: 4, fixtures: 1 }],
  byBuyerTrader: [{ label: 'SYNTHETIC BUYER', enquiries: 4, fixtures: 1 }],
};
const historicPrice = { id: 'fixture:1', date: '2026-11-25', grade: 'VLSFO', quantity: '100–200',
  vessel: 'SYNTHETIC VESSEL', supplier: 'SYNTHETIC SUPPLIER 12', price: 610.25 };
await mkdir(out, { recursive: true });
async function fixture(context) {
  const suppliers = syntheticIntelligence().suppliers.map((item, index) => ({
    id: `90000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, legacyIds: [item.id], sourceKey: `CANONICAL ${index + 1}`,
    legalName: `CANONICAL SUPPLIER ${String(index + 1).padStart(2, '0')} PTE. LTD.`, shortName: `CANONICAL ${index + 1}`, aliases: [item.name],
    countryCode: 'SG', countryName: 'Singapore', portName: 'Singapore', nameStatus: 'verified', legalNameSourceId: null,
    info: { paymentTerms: '', qualityClaimBar: '', supplierTrader: '', availableGrade: item.grades.join(', '), foBdn: '', goBdn: '' },
    contactCount: 0, bargeCount: 0, revision: 1, updatedAt: '2026-01-15T00:00:00Z',
  }));
  const state = { user: structuredClone(user), preview: null, latency: 0, snapshot: syntheticIntelligence(), status: 200, requests: 0, supplierStatus: 200, supplierRequests: 0, reportRequests: [], reportStatus: 200, suppliers, writes: [], hold: false, pending: [] };
  await context.route('**/api/**', route => { if (route.request().method() !== 'GET') state.writes.push(route.request().url()); return route.fulfill({ status: 404, json: { message: 'Isolated fixture only' } }); });
  await installEmptyLiveInbox(context);
  const locations = await installSharedLocations(context, { user: () => state.user, preview: () => state.preview });
  locations.seed(model => {
    const key = 'port:port-singapore';
    const original = model.knowledgeRecords[key];
    const table = { id: 'synthetic-refinery-table', title: 'Refineries', type: 'table',
      columns: [{ id: 'name', name: 'Name' }, { id: 'location', name: 'Location' }, { id: 'capacity', name: 'Capacity' }],
      rows: [{ id: 'synthetic-refinery-row', cells: ['SYNTHETIC REFINERY', 'SINGAPORE', '250,000 BPD'] }],
    };
    const standard = [['general', 'Port Information', 'port-information'], ['suppliers', 'Suppliers', 'suppliers'],
      ['uploaded-documents', 'Uploaded Documents', 'uploaded-documents'], ['price-history', 'Price History', 'price-history']];
    const sections = (original?.sections || standard.map(([id, title, role]) => ({ id, title, role, blocks: [] })))
      .filter(section => section.role !== 'refineries' && section.id !== 'refineries');
    model.knowledgeRecords[key] = { version: 1, layoutVersion: 2, sections: [
      ...sections, { id: 'refineries', title: 'Refineries', role: 'refineries', blocks: [table] },
    ] };
  });
  state.attachments = await installSharedAttachments(context, { user: () => state.user, preview: () => state.preview });
  state.attachments.items.set('synthetic-refinery-guide', {
    id: 'synthetic-refinery-guide', folderId: 'port:port-singapore:section:synthetic-refinery-table',
    scope: { target: { kind: 'port', id: 'port-singapore' }, section: { id: 'synthetic-refinery-table', name: 'Refineries' } },
    name: documentName, type: 'link', url: 'https://example.test/Synthetic-Refinery-Guide.pdf',
    mime: 'text/uri-list', size: 0, revision: 1, createdAt: '2026-11-24T00:00:00Z', createdBy: state.user.id,
  });
  await context.route('**/api/access/**', async route => {
    const path = new URL(route.request().url()).pathname.split('/api/access/')[1];
    if (path === 'session') {
      const response = { status: state.user ? 200 : 401, json: state.user ? structuredClone({ user: state.user, preview: state.preview }) : { message: 'Sign in required.' } };
      if (state.latency > 0) await new Promise(resolve => setTimeout(resolve, state.latency));
      return route.fulfill(response).catch(() => {});
    }
    if (!state.user) return route.fulfill({ status: 401, json: { message: 'Sign in required.' } });
    if (path === 'port-fixtures') {
      const query = new URL(route.request().url()).searchParams, view = query.get('view');
      state.reportRequests.push(view);
      assert.equal(route.request().headers()['x-eco-data-mode'], 'live');
      assert.equal(query.get('portId'), 'port-singapore');
      if (state.reportStatus !== 200) return route.fulfill({ status: state.reportStatus, json: { message: 'Unavailable' } });
      if (view === 'statistics') return route.fulfill({ json: report });
      if (view === 'prices') {
        const matches = !query.get('search') || /vessel/i.test(query.get('search'));
        return route.fulfill({ json: { items: matches ? [historicPrice] : [], total: Number(matches), pageSize: 50 } });
      }
      const personal = !state.user.isAdmin && !state.user.isSpcTrader;
      return route.fulfill({ json: { through: '2026-11-25', supplierCount: 10, personal,
        items: state.suppliers.slice(2).reverse().map((supplier, index) => ({ id: supplier.id,
          name: (personal ? 'SECOND' : 'SYNTHETIC') + ' SUPPLIER ' + (12 - index), grades: ['VLSFO'], fixtures: 40 - index })),
      } });
    }
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
  await context.route('**/api/suppliers/list?**', route => {
    state.supplierRequests++; assert.equal(route.request().method(), 'GET');
    if (!state.user) return route.fulfill({ status: 401, json: { message: 'Sign in required.' } });
    if (state.supplierStatus !== 200) return route.fulfill({ status: state.supplierStatus, json: { message: 'Supplier data unavailable' } });
    const query = new URL(route.request().url()).searchParams, page = Number(query.get('page') || 1), pageSize = Number(query.get('limit') || 50);
    return route.fulfill({ json: { items: state.suppliers.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: state.suppliers.length } });
  });
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
      await expect(ranking).toContainText('2026-11-25');
      await expect(ranking.getByRole('heading', { name: 'Top 10 Suppliers' })).toBeVisible();
      await expect(dialog.getByRole('tab', { name: 'Refineries', exact: true })).toHaveCount(0);
      const refinery = dialog.getByRole('region', { name: 'Refineries', exact: true });
      await expect(refinery).toContainText('SYNTHETIC REFINERY');
      await expect(button(refinery, documentName)).toBeVisible();
      if (width === 1440) {
        const heights = await dialog.locator('.knowledge-port-summary > *').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
        assert.equal(heights.length, 3);
        assert.ok(Math.max(...heights) - Math.min(...heights) < 1, 'Overview panels have equal heights');
      }
      await geometry(page, width); await ranking.evaluate(node => node.scrollIntoView({ block: 'start' })); await shot('ranking');
      if (width < 760) { await ranking.locator('li').last().scrollIntoViewIfNeeded(); await shot('ranking-bottom'); }
      await expect.poll(() => page.evaluate(() => Object.values(localStorage).some(value => value.includes('SYNTHETIC SUPPLIER')))).toBe(false);
      await dialog.getByRole('button', { name: /^Attachments(?: for.*)?$/i }).first().click();
      const attachments = page.getByRole('dialog', { name: 'Attachments', exact: true });
      await attachments.getByRole('navigation', { name: 'Attachment folders' }).getByRole('button', { name: 'Suppliers', exact: true }).click();
      await expect(attachments.locator('.attachment-folder-tile')).toHaveCount(12); await shot('attachment-references');
      await expect(attachments.locator('.attachment-folder-tile').first()).toContainText('CANONICAL SUPPLIER 01 PTE LTD');
      await expect(attachments.locator('.attachment-files')).not.toContainText('SYNTHETIC SUPPLIER');
      state.snapshot = null; await focus(page);
      await expect(ranking.locator('li')).toHaveCount(10);
      await expect(attachments.locator('.attachment-folder-tile')).toHaveCount(12);
      await expect(attachments).not.toContainText('Supplier data unavailable');
      state.supplierStatus = 503; await focus(page);
      await expect(attachments).toContainText('Supplier data unavailable'); await expect(attachments.locator('.attachment-folder-tile')).toHaveCount(0);
      state.supplierStatus = 200; await focus(page); await expect(attachments.locator('.attachment-folder-tile')).toHaveCount(12);
      await expect.poll(() => page.evaluate(() => Object.values(localStorage).some(value => value.includes('SYNTHETIC SUPPLIER') || value.includes('CANONICAL SUPPLIER')))).toBe(false);
      await button(attachments, 'Close dialog').click();
      await dialog.getByRole('tab', { name: 'Uploaded Documents', exact: true }).click();
      await button(dialog, documentName).click();
      const preview = page.getByRole('dialog', { name: documentName, exact: true });
      await expect(preview.getByRole('link', { name: 'Open link' })).toHaveAttribute('href', 'https://example.test/Synthetic-Refinery-Guide.pdf');
      await button(preview, 'Close dialog').click();
      await shot('documents');

      assert.equal(state.reportRequests.includes('statistics'), false, 'Statistics fetch only after opening the tab');
      await dialog.getByRole('tab', { name: 'SPC Statistics', exact: true }).click();
      const statistics = dialog.getByRole('region', { name: 'SPC Statistics', exact: true });
      await expect(statistics.getByRole('heading', { name: 'MONTHLY VOLUME', exact: true })).toBeVisible();
      await expect(statistics.getByRole('heading')).toHaveCount(9);
      await expect(statistics).toContainText('25%');
      await expect(statistics).toContainText('INCLUDES ESTIMATES');
      await expect(statistics).toContainText('CANCELLED FIXTURES · 2');
      await shot('statistics');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      state.reportStatus = 503;
      await button(statistics, 'REFRESH').click();
      await expect(statistics.getByRole('alert')).toHaveText('STATISTICS UNAVAILABLE.');
      state.reportStatus = 200;
      await button(statistics, 'REFRESH').click();
      await expect(statistics.getByRole('heading', { name: 'MONTHLY VOLUME', exact: true })).toBeVisible();

      await dialog.getByRole('tab', { name: 'Price History', exact: true }).click();
      const prices = dialog.getByRole('region', { name: 'Price History', exact: true });
      await expect(prices.getByText('SYNTHETIC VESSEL', { exact: true })).toBeVisible();
      await expect(prices.getByText('$610.25 / MT', { exact: true })).toBeVisible();
      await prices.getByPlaceholder('Search price history').fill('unavailable');
      await expect(prices).toContainText('NO PRICES FOUND.');
      await prices.getByPlaceholder('Search price history').fill('vessel');
      await expect(prices.getByText('SYNTHETIC VESSEL', { exact: true })).toBeVisible();
      await shot('prices');

      await button(dialog, 'Close workspace').click();
      await activateDeveloperMode(page);
      const control = page.locator('.home-display-controls').getByRole('button', { name: 'Test data', exact: true });
      await expect(control).toBeEnabled();
      const beforeTest = state.reportRequests.length;
      await control.click();
      await expect(control).toHaveAttribute('aria-pressed', 'true');
      dialog = await openPort(page);
      await expect(ranking.locator('li')).toHaveCount(0);
      assert.equal(state.reportRequests.length, beforeTest, 'TEST must not fetch live fixture reports');
      await button(dialog, 'Close workspace').click();
      await control.click();
      await expect(control).toHaveAttribute('aria-pressed', 'false');

      state.reportStatus = 503;
      dialog = await openPort(page);
      await expect(ranking).toContainText('Fixture data unavailable');
      await shot('unavailable');
      state.reportStatus = 200;
      dialog = await openPort(page);
      await expect(ranking.locator('li')).toHaveCount(10);
      state.latency = sessionLatency;
      state.user = { ...user, capabilities: { appearancePreview: false, testWorkspace: false }, id: '20000000-0000-4000-8000-000000000001', email: 'second@example.test', displayName: 'REFERENCE TRADER', isAdmin: false, isSpcTrader: false };
      await invalidateFixtureAuthority(page, { user: state.user, preview: state.preview });
      await expect(page.getByText('REFERENCE TRADER', { exact: true }).first()).toBeVisible();
      dialog = await openPort(page);
      await expect(ranking).toContainText('SECOND SUPPLIER 12');
      await expect(ranking).not.toContainText('SYNTHETIC SUPPLIER');
      await expect(dialog.getByRole('tab', { name: 'SPC Statistics', exact: true })).toHaveCount(0);

      state.user = { ...user };
      state.preview = { role: 'trader', officeId: 'HONG KONG', officeName: 'HONG KONG', readOnly: true };
      await invalidateFixtureAuthority(page, { user: state.user, preview: state.preview });
      await expect(page.getByText(/Preview.*Read only/i).first()).toBeVisible();
      dialog = await openPort(page);
      await expect(ranking.locator('li')).toHaveCount(0);
      await expect(dialog.getByRole('tab', { name: 'SPC Statistics', exact: true })).toHaveCount(0);
      state.user = null; state.preview = null; await invalidateFixtureAuthority(page, { user: state.user, preview: state.preview }); await expect(button(page, 'Sign in')).toBeVisible();
      const signedOutRequests = state.requests, signedOutSupplierRequests = state.supplierRequests; await focus(page); await page.waitForTimeout(100); assert.equal(state.requests, signedOutRequests, 'Signed-out does not fetch private references');
      assert.equal(state.supplierRequests, signedOutSupplierRequests, 'Signed-out does not fetch the private supplier catalog');
      await expect(ranking).toHaveCount(0); await shot('signed-out'); assert.deepEqual(errors, []); assert.deepEqual(state.writes, []);
      assert.deepEqual(sharedLocations(page).requests, [], 'Intelligence browsing never publishes shared location records');
      assert.deepEqual(state.attachments.requests.filter(request => request.body), [], 'Intelligence browsing never modifies shared attachments');
      results.push({ engine, width, theme, passed: true });
    } catch (error) { await shot('failure').catch(() => {}); results.push({ engine, width, theme, passed: false, error: error.message }); throw error; }
    finally { state.pending.splice(0).forEach(done => done()); await context.close(); await writeFile(resolve(out, 'report.json'), JSON.stringify({ origin: base, results }, null, 2)); }
  } } finally { await browser.close(); }
}
console.log(`Intelligence UI: ${results.length} cases passed`);
