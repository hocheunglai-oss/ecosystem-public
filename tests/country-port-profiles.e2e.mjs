import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { installEmptyLiveInbox } from './fixtures/empty-live-inbox.mjs';
import { installStagingCookies } from './fixtures/protection-cookies.mjs';

const base = process.env.ECO_COUNTRY_PORT_ORIGIN || 'http://127.0.0.1:4323';
const out = resolve(process.env.ECO_COUNTRY_PORT_OUTPUT || '/private/tmp/eco-country-port-profiles');
const user = { id: '10000000-0000-4000-8000-000000000001', email: 'owner@example.test', displayName: 'LOCATION FIXTURE ADMIN', phone: '', officeId: 'HONG KONG', officeName: 'HONG KONG', isAdmin: true, isSpcTrader: true, isManager: false, isActive: true, activated: true, passwordChangeSuggested: false, revision: 1 };
const key = `ecosystem.live.v1:${user.id}:state`;
const countryKey = 'country:Netherlands', portKey = 'port:port-rotterdam';
const countryTarget = { kind: 'country', id: 'Netherlands' }, portTarget = { kind: 'port', id: 'port-rotterdam' };
const privateTitles = ['COUNTRY OWNER NOTE', 'PORT OWNER NOTE'];
const btn = (scope, name) => scope.getByRole('button', { name, exact: true });
const results = [];
await mkdir(out, { recursive: true });

function document(source) {
  return { version: 7, layoutVersion: 2, sections: [
    { id: `${source}-operations`, title: 'OPERATIONS', blocks: [{ id: `${source}-text`, type: 'text', title: `${source} SOURCE TEXT`, text: `ORIGINAL ${source} SHARED BODY` }] },
    { id: `${source}-only`, title: `${source} ONLY`, blocks: [{ id: `${source}-table`, type: 'table', title: `${source} SOURCE TABLE`, columns: [{ id: `${source}-column`, name: 'Name' }], rows: [{ id: `${source}-row`, cells: [`ORIGINAL ${source} SHARED CELL`] }] }] },
  ] };
}

async function fixture(context) {
  const state = { user: structuredClone(user), preview: null, requests: [], unexpectedWrites: [], collections: new Map() };
  for (const [target, title, id] of [
    [countryTarget, privateTitles[0], 'a0000000-0000-4000-8000-000000000001'],
    [portTarget, privateTitles[1], 'b0000000-0000-4000-8000-000000000002'],
  ]) {
    state.collections.set(`${target.kind}:${target.id}`, { revision: 3, tabs: [
      { id, title, visibility: 'private', content: `PRIVATE ${target.kind.toUpperCase()} BODY` },
      // Separate owner scopes can contain identical titles and tab UUIDs.
      { id: 'c0000000-0000-4000-8000-000000000003', title: 'DUPLICATE OWNER NOTE', visibility: 'private', content: `PRIVATE ${target.kind.toUpperCase()} DUPLICATE BODY` },
    ] });
  }
  await context.route('**/api/**', route => {
    if (!['GET', 'HEAD'].includes(route.request().method())) state.unexpectedWrites.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 404, json: { message: 'Unconfigured isolated fixture endpoint.' } });
  });
  await installEmptyLiveInbox(context);
  await context.route('**/api/enquiries/test-policy', route => route.fulfill({ json: { enabled: true, generation: '10000000-0000-4000-8000-000000000010' } }));
  await context.route('**/api/access/**', route => {
    const path = new URL(route.request().url()).pathname.split('/api/access/')[1];
    if (!state.user) return route.fulfill({ status: 401, json: { message: 'Sign in required.' } });
    return route.fulfill({ status: ['session', 'users', 'phone-requests'].includes(path) ? 200 : 403, json: path === 'session' ? { user: state.user, preview: state.preview } : path === 'users' ? { users: [state.user], offices: [{ id: 'HONG KONG', name: 'HONG KONG' }] } : path === 'phone-requests' ? { requests: [] } : { message: 'Read only.' } });
  });
  await context.route('**/api/admin/**', route => route.fulfill({ json: { count: 0, items: [], periodStart: '2026-10-14T00:00:00Z', periodEnd: '2026-10-20T00:00:00Z', timeZone: 'Asia/Hong_Kong', source: 'shared-feedback' } }));
  await context.route('**/api/suppliers/**', route => route.fulfill({ json: { items: [], page: 1, pageSize: 100, total: 0 } }));
  await context.route('**/api/profile-tabs/**', route => {
    const request = route.request(), url = new URL(request.url()), body = request.method() === 'POST' ? request.postDataJSON() : null;
    const target = body?.target || { kind: url.searchParams.get('kind'), id: url.searchParams.get('id') };
    if (!state.user) return route.fulfill({ status: 401, json: { message: 'Sign in required.' } });
    const recordKey = `${target.kind}:${target.id}`;
    const response = () => ({ target, shared: { revision: 0, tabs: [] }, private: structuredClone(state.preview || state.user.id !== user.id ? { revision: 0, tabs: [] } : state.collections.get(recordKey) || { revision: 0, tabs: [] }) });
    if (!body) return route.fulfill({ json: response() });
    state.requests.push(structuredClone(body));
    if (state.preview || state.user.id !== user.id || body.visibility !== 'private') return route.fulfill({ status: 403, json: { message: 'Read only.' } });
    const current = state.collections.get(recordKey) || { revision: 0, tabs: [] };
    if (current.revision !== body.revision) return route.fulfill({ status: 409, json: { message: 'Tabs changed. Reload latest.' } });
    state.collections.set(recordKey, { revision: current.revision + 1, tabs: structuredClone(body.tabs) });
    return route.fulfill({ json: response() });
  });
  return state;
}

async function openWorkspace(page) {
  const existing = page.getByRole('dialog', { name: 'Countries & Ports', exact: true });
  if (await existing.count()) await btn(existing, 'Close workspace').click();
  const nav = page.getByRole('navigation', { name: 'Workspace navigation' }), group = btn(nav, 'Ports & Suppliers');
  if (await group.getAttribute('aria-expanded') !== 'true') await group.click();
  await btn(nav, 'Countries & Ports').click();
  return page.getByRole('dialog', { name: 'Countries & Ports', exact: true });
}
async function openFromIndex(workspace, kind, name) {
  await btn(workspace, kind === 'country' ? 'Country Index' : 'Port Index').click();
  await workspace.getByLabel('Country or port', { exact: true }).fill(name);
  await workspace.locator('.location-table').getByRole('button', { name, exact: true }).click();
  return workspace.locator('.knowledge').first();
}
async function chooseTab(profile, name) {
  await profile.getByRole('tab').filter({ hasText: name }).first().click();
}
async function snapshot(page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
}
async function seed(page) {
  await expect.poll(() => page.evaluate(key => Boolean(localStorage.getItem(key)), key)).toBe(true);
  await page.evaluate(({ key, country, port }) => {
    const value = JSON.parse(localStorage.getItem(key));
    const ids = ['port-singapore', 'port-hong-kong', 'port-gibraltar', 'port-rotterdam', 'port-chiba', 'port-tokyo'];
    value.ports = value.ports.filter(port => ids.includes(port.id));
    value.locationCountries = ['Singapore', 'Hong Kong', 'Gibraltar', 'Netherlands', 'Japan', 'Canada'].map(name => ({ id: name, name }));
    value.knowledgeRecords = {
      ...value.knowledgeRecords, 'country:Netherlands': country, 'port:port-rotterdam': port,
      'country:Japan': { version: 2, layoutVersion: 2, sections: [{ id: 'location-ports', title: 'SAVED PORT NOTES', blocks: [{ id: 'japan-original-note', type: 'text', title: 'SAVED NOTE', text: 'PRESERVE ORIGINAL COUNTRY SECTION' }] }] },
    };
    value.locationHierarchyVersion = 1;
    localStorage.setItem(key, JSON.stringify(value));
  }, { key, country: document('COUNTRY'), port: document('PORT') });
  await page.reload();
  await page.getByRole('main', { name: 'ECOSYSTEM workspace' }).waitFor();
}

async function verifyPortCountries(workspace, shot) {
  for (const [name, country] of [['Singapore', 'Singapore'], ['Hong Kong', 'Hong Kong'], ['Gibraltar', 'Gibraltar'], ['Rotterdam', 'Netherlands']]) {
    await btn(workspace, 'Port Index').click();
    await workspace.getByLabel('Country or port', { exact: true }).fill(name);
    const row = workspace.locator('.location-table tbody tr');
    await expect(row).toHaveCount(1);
    await expect(row.locator('td').nth(2)).toHaveText(country);
    if (name === 'Hong Kong') await shot('port-index-country');
  }
}

async function verifyCombinedSources(page, workspace, state, shot) {
  let profile = await openFromIndex(workspace, 'country', 'Netherlands');
  await expect(profile.getByRole('heading', { name: 'Rotterdam', exact: true })).toBeVisible();
  await expect(profile.locator('.knowledge-header')).toContainText('Netherlands');
  await expect(profile.getByRole('tab', { name: /^Ports$/i })).toHaveCount(0);
  for (const title of privateTitles) await expect(profile.getByRole('tab').filter({ hasText: title })).toBeVisible();
  const tabNames = await profile.getByRole('tab').allTextContents();
  assert.ok(tabNames.slice(0, 4).every(text => /COUNTRY OWNER NOTE|PORT OWNER NOTE|DUPLICATE OWNER NOTE/.test(text)), 'Both original private scopes precede shared tabs');
  await chooseTab(profile, 'OPERATIONS');
  await expect(profile).toContainText('ORIGINAL COUNTRY SHARED BODY');
  await expect(profile).toContainText('ORIGINAL PORT SHARED BODY');
  const before = await snapshot(page);
  await shot('singleton-country-entry');
  profile = await openFromIndex(workspace, 'port', 'Rotterdam');
  await expect(profile.getByRole('tab')).toHaveText(tabNames);
  await chooseTab(profile, 'OPERATIONS');
  await expect(profile).toContainText('ORIGINAL COUNTRY SHARED BODY');
  await expect(profile).toContainText('ORIGINAL PORT SHARED BODY');
  for (const source of ['COUNTRY', 'PORT']) {
    const originalKey = source === 'COUNTRY' ? countryKey : portKey;
    const otherKey = source === 'COUNTRY' ? portKey : countryKey;
    const savedBefore = await snapshot(page);
    await btn(profile.locator('.knowledge-content-toolbar'), 'EDIT').click();
    await profile.getByLabel('Information source', { exact: true }).selectOption(`${originalKey}:${source}-operations`);
    const editor = profile.locator('.knowledge-editor');
    await expect(editor.getByLabel('Edit tab', { exact: true })).toHaveCount(0);
    await expect(btn(editor, 'Manage tabs')).toHaveCount(0);
    if (source === 'COUNTRY') {
      const chooser = profile.getByLabel('Information source', { exact: true }), text = editor.getByLabel('Block 1 text', { exact: true });
      await text.fill('UNSAVED COUNTRY SOURCE DRAFT');
      page.once('dialog', dialog => dialog.dismiss());
      await chooser.selectOption(`${portKey}:PORT-operations`);
      await expect(chooser).toHaveValue(`${countryKey}:COUNTRY-operations`);
      await expect(text).toHaveValue('UNSAVED COUNTRY SOURCE DRAFT');
      page.once('dialog', dialog => dialog.accept());
      await chooser.selectOption(`${portKey}:PORT-operations`);
      await expect(text).toHaveValue('ORIGINAL PORT SHARED BODY');
      await chooser.selectOption(`${countryKey}:COUNTRY-operations`);
      await expect(text).toHaveValue('ORIGINAL COUNTRY SHARED BODY');
    }
    await editor.getByLabel('Block 1 text', { exact: true }).fill(`EDITED ${source} SOURCE`);
    await btn(editor, /^SAVE$/i).click();
    await expect(editor).toHaveCount(0);
    const saved = await snapshot(page);
    assert.equal(saved.knowledgeRecords[originalKey].sections.find(section => section.id === `${source}-operations`).blocks[0].text, `EDITED ${source} SOURCE`);
    assert.deepEqual(saved.knowledgeRecords[otherKey], savedBefore.knowledgeRecords[otherKey], 'Editing a shared source never moves or overwrites the other source');
    assert.deepEqual(saved.knowledgeRecords[originalKey].sections.find(section => section.id === `${source}-only`), savedBefore.knowledgeRecords[originalKey].sections.find(section => section.id === `${source}-only`));
  }
  const sharedBeforePrivate = await snapshot(page);
  for (const [source, title, target] of [['COUNTRY', privateTitles[0], countryTarget], ['PORT', privateTitles[1], portTarget]]) {
    await chooseTab(profile, title);
    await expect(profile.locator('.profile-tab-content')).toContainText(`PRIVATE ${source} BODY`);
    await btn(profile.locator('.profile-tab-content'), 'EDIT').click();
    await profile.getByLabel('Block 1 text', { exact: true }).fill(`PRIVATE ${source} EDITED`);
    await btn(profile.locator('.knowledge-editor'), /^SAVE$/i).click();
    await expect(profile.locator('.knowledge-editor')).toHaveCount(0);
    assert.deepEqual(state.requests.at(-1).target, target, 'Inherited and primary private edits retain their original server scope');
    await expect(profile.locator('.profile-tab-content')).toContainText(`PRIVATE ${source} EDITED`);
  }
  const duplicates = profile.getByRole('tab').filter({ hasText: 'DUPLICATE OWNER NOTE' });
  await expect(duplicates).toHaveCount(2);
  for (let index = 0; index < 2; index++) {
    await duplicates.nth(index).click();
    const body = await profile.locator('.profile-tab-content').textContent();
    const source = body.includes('PRIVATE COUNTRY DUPLICATE BODY') ? 'COUNTRY' : 'PORT';
    await expect(profile.locator('.profile-tab-content')).toContainText(`PRIVATE ${source} DUPLICATE BODY`);
    await btn(profile.locator('.profile-tab-content'), 'EDIT').click();
    await profile.getByLabel('Block 1 text', { exact: true }).fill(`PRIVATE ${source} DUPLICATE EDITED`);
    await btn(profile.locator('.knowledge-editor'), /^SAVE$/i).click();
    await expect(profile.locator('.knowledge-editor')).toHaveCount(0);
    assert.deepEqual(state.requests.at(-1).target, source === 'COUNTRY' ? countryTarget : portTarget, 'Same-titled private tabs keep distinct source identity');
  }
  const afterPrivate = await snapshot(page);
  for (const field of ['knowledgeRecords', 'knowledgeHistory', 'contributions', 'hats']) assert.deepEqual(afterPrivate[field], sharedBeforePrivate[field], 'Private edits never enter shared state');
  assert.deepEqual(Object.keys(afterPrivate.knowledgeRecords).sort(), Object.keys(before.knowledgeRecords).sort(), 'Combining profiles creates no replacement storage key');
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  for (const value of [...privateTitles, 'DUPLICATE OWNER NOTE', 'PRIVATE COUNTRY EDITED', 'PRIVATE PORT EDITED']) assert.ok(!storage.includes(value), 'Private titles and content stay out of persisted browser state');
  await shot('singleton-private-source');
}

async function verifyMultiPort(workspace, shot) {
  let profile = await openFromIndex(workspace, 'country', 'Japan');
  await chooseTab(profile, 'SAVED PORT NOTES');
  await expect(profile).toContainText('PRESERVE ORIGINAL COUNTRY SECTION');
  await expect(profile.getByRole('region', { name: 'Ports in this country' })).toHaveCount(0);
  await expect(profile.locator('.knowledge-country-ports, .location-children')).toHaveCount(0);
  await profile.getByRole('tab', { name: /^Ports$/i }).click();
  const ports = profile.getByRole('region', { name: 'Ports in this country', exact: true });
  await expect(ports).toBeVisible();
  await expect(ports.getByRole('table')).toBeVisible();
  await expect(btn(ports, 'Chiba')).toBeVisible();
  await expect(btn(ports, 'Tokyo')).toBeVisible();
  await expect(profile.locator('.knowledge-content-toolbar, .knowledge-block, .knowledge-country-ports, .location-children')).toHaveCount(0);
  await shot('country-ports-tab');
  await chooseTab(profile, 'SAVED PORT NOTES');
  await expect(profile).toContainText('PRESERVE ORIGINAL COUNTRY SECTION');
  await profile.getByRole('tab', { name: /^Ports$/i }).click();
  await btn(ports, 'Chiba').click();
  profile = workspace.locator('.knowledge').first();
  await expect(profile.getByRole('heading', { name: 'Chiba', exact: true })).toBeVisible();
  await expect(profile.getByRole('tab', { name: /^Ports$/i })).toHaveCount(0);
  await expect(profile.getByRole('region', { name: 'Ports in this country' })).toHaveCount(0);
  await expect(profile.locator('.knowledge-country-ports, .location-children')).toHaveCount(0);
  await shot('multi-country-port-profile');
}

async function verifyPortCountTransition(page, workspace, shot) {
  let profile = await openFromIndex(workspace, 'country', 'Canada');
  await expect(profile.getByRole('heading', { name: 'Canada', exact: true })).toBeVisible();
  await expect(profile.getByRole('tab', { name: /^Ports$/i })).toHaveCount(0);
  for (const name of ['HALIFAX UI FIXTURE', 'VANCOUVER UI FIXTURE']) {
    await btn(workspace, 'Add location').click();
    const modal = page.getByRole('dialog', { name: 'Add location', exact: true });
    await modal.getByLabel('Type', { exact: true }).selectOption('port');
    await modal.getByLabel('Name', { exact: true }).fill(name);
    await modal.getByLabel('Country', { exact: true }).selectOption('Canada');
    await btn(modal, 'Add location').click();
    await expect(modal).toHaveCount(0);
    profile = await openFromIndex(workspace, 'country', 'Canada');
    if (name.startsWith('HALIFAX')) {
      await expect(profile.getByRole('heading', { name, exact: true })).toBeVisible();
      await expect(profile.getByRole('tab', { name: /^Ports$/i })).toHaveCount(0);
      await shot('new-single-port-country');
    }
  }
  await expect(profile.getByRole('heading', { name: 'Canada', exact: true })).toBeVisible();
  await profile.getByRole('tab', { name: /^Ports$/i }).click();
  const ports = profile.getByRole('region', { name: 'Ports in this country' });
  await expect(btn(ports, 'HALIFAX UI FIXTURE')).toBeVisible();
  await expect(btn(ports, 'VANCOUVER UI FIXTURE')).toBeVisible();
  await shot('new-second-port-country');
}

async function verifyHolidays(page, workspace, width, shot) {
  const profile = await openFromIndex(workspace, 'country', 'Netherlands');
  const trigger = btn(profile.locator('.knowledge-header'), 'Public holidays');
  await expect(profile.locator('.knowledge-local-time')).toContainText('Time now');
  await expect(trigger).toContainText('TODAY IS NOT A PUBLIC HOLIDAY');
  await trigger.focus();
  const hint = profile.getByRole('tooltip');
  await expect(hint).toBeVisible();
  await expect(hint).toContainText('25 DEC 2026');
  await expect(hint).toContainText('CHRISTMAS');
  await shot('holiday-beside-clock');
  await trigger.click();
  let modal = page.getByRole('dialog', { name: 'PUBLIC HOLIDAYS', exact: true });
  await expect(modal.getByLabel('Holiday year')).toHaveValue('2026');
  const yearBox = await modal.getByLabel('Holiday year').boundingBox();
  assert.ok(yearBox && yearBox.height >= (width < 760 ? 44 : 30), 'Holiday year uses the shared control height, including native WebKit selects');
  let table = modal.getByRole('table', { name: 'Netherlands public holidays 2026', exact: true });
  await expect(table.locator('time[datetime="2026-12-25"]')).toBeVisible();
  assert.ok(await modal.getByRole('link').count() > 0, 'Calendar exposes its official sources');
  for (const href of await modal.getByRole('link').evaluateAll(nodes => nodes.map(node => node.href))) assert.equal(new URL(href).hostname, 'www.government.nl');
  await modal.getByLabel('Holiday year').selectOption('2027');
  table = modal.getByRole('table', { name: 'Netherlands public holidays 2027', exact: true });
  await expect(table.locator('time[datetime="2027-12-25"]')).toBeVisible();
  await shot('holiday-calendar');
  await btn(modal, 'Close dialog').click();
  const unavailable = await openFromIndex(workspace, 'country', 'Canada');
  await btn(unavailable.locator('.knowledge-header'), 'Public holidays').click();
  modal = page.getByRole('dialog', { name: 'PUBLIC HOLIDAYS', exact: true });
  await expect(modal.getByRole('status')).toHaveText('OFFICIAL HOLIDAY DATES NOT YET AVAILABLE.');
  await expect(modal.getByRole('table')).toHaveCount(0);
  await shot('holiday-unavailable');
  await btn(modal, 'Close dialog').click();
}

async function verifyPrivacy(page, workspace, state, shot) {
  const refreshAuthority = async () => {
    const expected = structuredClone({ user: state.user, preview: state.preview });
    const response = page.waitForResponse(async response => {
      if (new URL(response.url()).pathname !== '/api/access/session') return false;
      if (!expected.user) return response.status() === 401;
      if (response.status() !== 200) return false;
      const session = await response.json().catch(() => null);
      return session?.user?.id === expected.user.id && JSON.stringify(session.preview) === JSON.stringify(expected.preview);
    });
    // A changed server authority invalidates pending refreshes; ordinary focus
    // intentionally reuses them and is not a synthetic account-change signal.
    await page.evaluate(() => {
      const channel = new BroadcastChannel('eco-access-invalidation');
      channel.postMessage('refresh-needed');
      channel.close();
    });
    assert.equal(await (await response).finished(), null);
  };
  let profile = await openFromIndex(workspace, 'country', 'Netherlands');
  await chooseTab(profile, privateTitles[0]);
  await btn(profile.locator('.profile-tab-content'), 'EDIT').click();
  await profile.getByLabel('Block 1 text').fill('UNSAVED INHERITED SECRET');
  const before = state.requests.length;
  state.preview = { role: 'trader', officeId: 'HONG KONG', officeName: 'HONG KONG', readOnly: true };
  await refreshAuthority();
  await expect(page.getByRole('status', { name: 'Role preview' }).first()).toBeVisible();
  workspace = await openWorkspace(page);
  profile = await openFromIndex(workspace, 'country', 'Netherlands');
  for (const title of [...privateTitles, 'DUPLICATE OWNER NOTE']) await expect(profile.getByRole('tab').filter({ hasText: title })).toHaveCount(0);
  await expect(profile).not.toContainText('UNSAVED INHERITED SECRET');
  await expect(btn(profile, 'Manage tabs')).toHaveCount(0);
  await expect(profile.getByRole('button', { name: 'EDIT', exact: true })).toHaveCount(0);
  await shot('preview-combined-profile');
  state.preview = null;
  state.user = { ...user, id: '10000000-0000-4000-8000-000000000002', displayName: 'OTHER LOCATION ADMIN' };
  await refreshAuthority();
  await expect(page.locator('.hud-identity')).toContainText('OTHER LOCATION ADMIN');
  workspace = await openWorkspace(page);
  profile = await openFromIndex(workspace, 'country', 'Netherlands');
  for (const title of [...privateTitles, 'DUPLICATE OWNER NOTE']) await expect(profile.getByRole('tab').filter({ hasText: title })).toHaveCount(0);
  state.user = null;
  await refreshAuthority();
  await expect(page.getByRole('button', { name: /Sign in/i })).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(0);
  await shot('signed-out');
  assert.equal(state.requests.length, before, 'Changing preview, owner or sign-in state sends no private save');
}

for (const [engine, browserType] of [['chromium', chromium], ['webkit', webkit]]) {
  if (process.env.ECO_TEST_ENGINE && process.env.ECO_TEST_ENGINE !== engine) continue;
  const browser = await browserType.launch({ headless: true });
  try {
    for (const width of [1440, 320, 390]) for (const theme of ['light', 'dark']) {
      if (process.env.ECO_TEST_WIDTH && +process.env.ECO_TEST_WIDTH !== width || process.env.ECO_TEST_THEME && process.env.ECO_TEST_THEME !== theme) continue;
      const context = await browser.newContext({ viewport: { width, height: width < 760 ? 844 : 1000 }, isMobile: width < 760, hasTouch: width < 760, reducedMotion: 'reduce' });
      await installStagingCookies(context, base);
      const state = await fixture(context);
      await context.addInitScript(theme => localStorage.setItem('ecosystem.theme.v1', theme), theme);
      const page = await context.newPage(), errors = [];
      await page.clock.setFixedTime(new Date('2026-10-20T04:00:00Z'));
      page.on('pageerror', error => errors.push(error.message));
      page.setDefaultTimeout(15000);
      const shot = async name => {
        await page.screenshot({ path: `${out}/${engine}-${width}-${theme}-${name}.png`, fullPage: true });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: no document overflow`);
      };
      try {
        await page.goto(base);
        await page.getByRole('main', { name: 'ECOSYSTEM workspace' }).waitFor();
        await seed(page);
        const workspace = await openWorkspace(page);
        await verifyPortCountries(workspace, shot);
        await verifyCombinedSources(page, workspace, state, shot);
        await verifyMultiPort(workspace, shot);
        await verifyPortCountTransition(page, workspace, shot);
        await verifyHolidays(page, workspace, width, shot);
        await verifyPrivacy(page, workspace, state, shot);
        assert.deepEqual(state.unexpectedWrites, []);
        assert.deepEqual(errors, []);
        results.push({ engine, width, theme, status: 'passed' });
        console.log(`PASS ${engine} ${width} ${theme}: country and port profiles`);
      } catch (error) {
        await page.screenshot({ path: `${out}/${engine}-${width}-${theme}-FAILURE.png`, fullPage: true }).catch(() => {});
        throw error;
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
}
await writeFile(`${out}/results.json`, JSON.stringify({ base, results, limits: 'Isolated API fixtures; physical devices and native Safari are not covered.' }, null, 2));
console.log(JSON.stringify({ passed: results.length, output: out }));
