import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { installEmptyLiveInbox } from './fixtures/empty-live-inbox.mjs';
import { createLiveFixtureBuyer } from './fixtures/test-workspace.mjs';
import { installStagingCookies } from './fixtures/protection-cookies.mjs';

const base = process.env.ECO_PROFILE_TABS_ORIGIN || process.env.ECO_PRIVATE_UI_ORIGIN || 'http://127.0.0.1:4320';
const out = resolve(process.env.ECO_PROFILE_TABS_OUTPUT || process.env.ECO_PRIVATE_UI_OUTPUT || '/private/tmp/eco-profile-tabs-unified');
const user = { capabilities: { testWorkspace: true, appearancePreview: true }, id: '10000000-0000-4000-8000-000000000001', email: 'owner@example.test', displayName: 'FIXTURE ADMIN', phone: '', officeId: 'HONG KONG', officeName: 'HONG KONG', isAdmin: true, isSpcTrader: true, isManager: false, isActive: true, activated: true, passwordChangeSuggested: false, revision: 1 };
const supplier = {
  id: '90000000-0000-4000-8000-000000000001', legacyIds: [], sourceKey: 'TAB FIXTURE', legalName: 'TAB FIXTURE MARINE PTE LTD', shortName: 'TAB FIXTURE', aliases: [],
  countryCode: 'SG', countryName: 'Singapore', portName: 'Singapore', nameStatus: 'verified', legalNameSourceId: 'authority',
  info: { paymentTerms: '30', qualityClaimBar: '30', supplierTrader: 'FIXTURE ADMIN', availableGrade: 'HSFO, VLSFO, LSMGO', foBdn: 'FO ORIGINAL', goBdn: 'GO ORIGINAL' },
  contacts: [{ id: 'contact-one', role: 'sales', name: 'UNCHANGED SALES', phone: '+6500000000', email: '', sourceId: 'user' }],
  barges: [{ id: 'barge-one', name: 'UNCHANGED BARGE', imo: '9000001', grade: 'VLSFO', capacity: '3,000 MT', sourceId: 'user' }],
  facts: [], sources: [{ id: 'authority', type: 'mpa', title: 'Synthetic legal-name source', url: 'https://example.test/source', retrievedAt: '2026-10-20T00:00:00Z', documentDate: '' }, { id: 'user', type: 'user', title: 'Fixture operator', url: '', retrievedAt: '2026-10-20T00:00:00Z', documentDate: '' }],
  revision: 1, updatedAt: '2026-10-20T00:00:00Z',
};
const kinds = ['country', 'port', 'supplier', 'buyer'];
const privateTitle = kind => `PRIVATE ${kind.toUpperCase()} NOTE`;
const privateText = kind => `OWNER ONLY ${kind.toUpperCase()} LEGACY TEXT`;
const secondTitle = kind => `PRIVATE ${kind.toUpperCase()} REFERENCE`;
const sharedTitles = ['SHARED OPERATIONS', 'SHARED REFERENCE'];
const liveKey = id => `ecosystem.live.v1:${id}:state`;
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const focus = page => page.evaluate(() => window.dispatchEvent(new Event('focus')));
const results = [];
await mkdir(out, { recursive: true });

function knowledgeDocument(kind) {
  return { version: 4, layoutVersion: 2, sections: sharedTitles.map((title, i) => ({
    id: `${kind}-shared-${i}`, title, blocks: [
      { id: `${kind}-${i}-text`, type: 'text', title: `SHARED ${i + 1} NOTE`, text: `UNCHANGED ${kind.toUpperCase()} ${i + 1}`, update: { updatedBy: user.id, updatedAt: '2026-10-19T00:00:00Z' } },
      { id: `${kind}-${i}-table`, type: 'table', title: `SHARED ${i + 1} TABLE`, columns: [{ id: `${kind}-${i}-column`, name: 'Name' }], rows: [{ id: `${kind}-${i}-row`, cells: ['UNCHANGED SHARED CELL'], update: { updatedBy: user.id, updatedAt: '2026-10-19T00:00:00Z' } }] },
    ],
  })) };
}

async function fixture(context) {
  const state = { user: structuredClone(user), preview: null, private: new Map(), shared: new Map(), requests: [], supplierWrites: [], unexpectedWrites: [], receipts: new Map(), conflict: false, dropResponse: false, failSharedOnce: false, record: structuredClone(supplier) };
  // Every API request is intercepted. An omitted fixture cannot reach a live service.
  await context.route('**/api/**', route => {
    if (!['GET', 'HEAD'].includes(route.request().method())) state.unexpectedWrites.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 404, json: { message: 'Unconfigured isolated fixture endpoint.' } });
  });
  await installEmptyLiveInbox(context);
  await context.route('**/api/enquiries/test-policy', route => route.fulfill({ json: { enabled: true, generation: '10000000-0000-4000-8000-000000000010' } }));
  await context.route('**/api/access/**', route => {
    const path = new URL(route.request().url()).pathname.split('/api/access/')[1];
    if (!state.user) return route.fulfill({ status: 401, json: { message: 'Sign in required.' } });
    if (path === 'session') return route.fulfill({ json: { user: state.user, preview: state.preview } });
    if (path === 'users') return route.fulfill({ json: { users: [state.user], offices: [{ id: 'HONG KONG', name: 'HONG KONG' }] } });
    if (path === 'phone-requests') return route.fulfill({ json: { requests: [] } });
    return route.fulfill({ status: 403, json: { message: 'Unexpected access operation.' } });
  });
  await context.route('**/api/admin/**', route => {
    if (route.request().method() !== 'GET') state.unexpectedWrites.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: { count: 0, items: [], periodStart: '2026-10-14T00:00:00Z', periodEnd: '2026-10-20T00:00:00Z', timeZone: 'Asia/Hong_Kong', source: 'shared-feedback' } });
  });
  await context.route('**/api/supplier-reports/**', route => route.fulfill({ json: { items: [] } }));
  await context.route('**/api/suppliers/**', route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.split('/api/suppliers/')[1];
    if (path === 'detail') return route.fulfill({ json: { item: structuredClone(state.record) } });
    if (path === 'pic-options') return route.fulfill({ json: { options: ['FIXTURE ADMIN'] } });
    if (path === 'list') return route.fulfill({ json: { items: [{ ...state.record, contactCount: state.record.contacts.length, bargeCount: state.record.barges.length }], total: 1, page: 1, pageSize: 50 } });
    if (request.method() === 'POST') state.supplierWrites.push(request.postDataJSON());
    if (path === 'update' && !state.preview && (state.user?.isAdmin || state.user?.isSpcTrader)) {
      const body = request.postDataJSON();
      state.record = { ...state.record, ...body, revision: state.record.revision + 1 };
      return route.fulfill({ json: { item: structuredClone(state.record) } });
    }
    return route.fulfill({ status: 403, json: { message: 'Read only.' } });
  });
  state.getTabs = target => {
    const key = `${target.kind}:${target.id}`, owner = `${state.user?.id}:${key}`;
    if (!state.private.has(owner) && state.user?.id === user.id) {
      state.private.set(owner, { revision: 1, tabs: [
        { id: `a0000000-0000-4000-8000-${String(kinds.indexOf(target.kind) + 1).padStart(12, '0')}`, title: privateTitle(target.kind), visibility: 'private', content: privateText(target.kind) },
        { id: `b0000000-0000-4000-8000-${String(kinds.indexOf(target.kind) + 1).padStart(12, '0')}`, title: secondTitle(target.kind), visibility: 'private', content: 'UNCHANGED PRIVATE SIBLING' },
      ] });
    }
    return { target, shared: structuredClone(state.shared.get(key) || { revision: 0, tabs: [] }), private: structuredClone(state.preview ? { revision: 0, tabs: [] } : state.private.get(owner) || { revision: 0, tabs: [] }) };
  };
  await context.route('**/api/profile-tabs/**', route => {
    const request = route.request(), url = new URL(request.url());
    const body = request.method() === 'POST' ? request.postDataJSON() : null;
    const target = body?.target || { kind: url.searchParams.get('kind'), id: url.searchParams.get('id') };
    if (!state.user) return route.fulfill({ status: 401, json: { message: 'Sign in required.' } });
    if (!body) return route.fulfill({ json: state.getTabs(target) });
    state.requests.push(structuredClone(body));
    assert.equal(request.headers()['x-eco-request'], '1');
    if (state.preview) return route.fulfill({ status: 403, json: { message: 'Read only.' } });
    if (state.receipts.has(body.requestId)) return route.fulfill({ json: structuredClone(state.receipts.get(body.requestId)) });
    if (body.visibility === 'shared' && state.failSharedOnce) {
      state.failSharedOnce = false;
      return route.fulfill({ status: 503, json: { message: 'Shared tabs temporarily unavailable.' } });
    }
    const current = state.getTabs(target);
    if (state.conflict || body.revision !== current[body.visibility].revision) return route.fulfill({ status: 409, json: { message: 'Tabs changed. Reload the latest record.' } });
    const key = `${target.kind}:${target.id}`;
    (body.visibility === 'private' ? state.private : state.shared).set(body.visibility === 'private' ? `${state.user.id}:${key}` : key, { revision: body.revision + 1, tabs: structuredClone(body.tabs) });
    const response = state.getTabs(target); state.receipts.set(body.requestId, response);
    if (state.dropResponse) { state.dropResponse = false; return route.abort('failed'); }
    return route.fulfill({ json: response });
  });
  return state;
}

async function closeWorkspace(page) {
  const close = button(page, 'Close workspace');
  if (await close.count()) await close.click();
}
async function openProfile(page, kind) {
  await closeWorkspace(page);
  const name = kind === 'buyer' ? 'Buyer Profiles' : kind === 'supplier' ? 'Supplier Profiles' : 'Countries & Ports';
  const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
  const group = button(nav, kind === 'buyer' ? 'Buyers and Credit' : 'Ports & Suppliers');
  if (await group.getAttribute('aria-expanded') !== 'true') await group.click();
  await button(nav, name).click();
  const workspace = page.getByRole('dialog', { name, exact: true });
  if (kind === 'buyer') {
    await workspace.getByRole('textbox', { name: 'Search buyer profiles', exact: true }).fill('UNIFIED TAB TEST BUYER');
    await button(workspace, 'UNIFIED TAB TEST BUYER').click();
    return workspace.locator('.buyer-profile');
  }
  if (kind === 'supplier') {
    const back = button(workspace, 'Supplier results');
    if (await back.count()) await back.click();
    await workspace.getByLabel('Search suppliers', { exact: true }).fill(supplier.shortName);
    await workspace.getByRole('table', { name: 'Supplier results' }).getByRole('button', { name: /TAB FIXTURE MARINE/ }).click();
    return workspace.locator('.shared-supplier-profile');
  }
  await button(workspace, kind === 'country' ? 'Country Index' : 'Port Index').click();
  const location = kind === 'country' ? 'Japan' : 'Chiba';
  await workspace.getByLabel('Country or port', { exact: true }).fill(location);
  await workspace.locator('.location-table').getByRole('button', { name: location, exact: true }).click();
  return workspace.locator('.knowledge').first();
}
const manager = page => page.getByRole('dialog', { name: /^Manage tabs$/i });
const managerNames = modal => modal.locator('input[aria-label^="Tab "]').evaluateAll(nodes => nodes.map(node => node.value));
async function tab(profile, title) {
  return profile.getByRole('tab').filter({ hasText: title }).first();
}
async function assertPrivateFirst(profile, kind) {
  const list = profile.locator('.profile-tabs-list').first();
  await expect(list.getByRole('tab').nth(0)).toContainText(privateTitle(kind));
  await expect(list.getByRole('tab').nth(1)).toContainText(secondTitle(kind));
  await expect(list.getByRole('tab').nth(0)).toContainText(/PRIVATE/i);
}
async function checkGeometry(page, scope, width) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Page has no horizontal overflow');
  const controls = scope.locator('button.button:visible');
  const styles = await controls.evaluateAll(nodes => nodes.map(node => {
    const style = getComputedStyle(node), box = node.getBoundingClientRect();
    return { name: node.textContent.trim(), radius: style.borderRadius, height: box.height, left: box.left, right: box.right };
  }));
  for (const control of styles) {
    assert.equal(control.radius, '5px', `${control.name}: shared button radius`);
    assert.ok(control.height >= (width <= 600 ? 44 : 30) - 1, `${control.name}: shared control height (${control.height})`);
    assert.ok(control.left >= -1 && control.right <= width + 1, `${control.name}: fits viewport`);
  }
}
async function assertNoPrivateLeak(page, state) {
  const storage = await page.evaluate(() => JSON.stringify({ local: Object.fromEntries(Object.entries(localStorage)), session: Object.fromEntries(Object.entries(sessionStorage)) }));
  for (const kind of kinds) {
    assert.ok(!storage.includes(privateText(kind)), `${kind}: private body absent from browser persistence`);
    assert.ok(!storage.includes(privateTitle(kind)), `${kind}: private title absent from browser persistence`);
  }
  assert.ok(state.requests.filter(request => request.visibility === 'shared').every(request => !JSON.stringify(request).includes('OWNER ONLY')), 'Private content absent from shared writes');
  assert.deepEqual(state.unexpectedWrites, []);
}

// Flow assertions are deliberately shared across the four profile adapters.
// This catches presentation parity without bypassing their independent stores.
async function verifyProfile(page, state, kind, width, shot) {
  let profile = await openProfile(page, kind);
  const sharedBefore = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), liveKey(user.id));
  await assertPrivateFirst(profile, kind);
  await (await tab(profile, privateTitle(kind))).click();
  await expect(profile.locator('.profile-tab-content')).toContainText(privateText(kind));
  const sibling = structuredClone([...state.private.values()].find(scope => scope.tabs.some(entry => entry.title === privateTitle(kind))).tabs[1]);
  await button(profile, 'Manage tabs').click();
  let modal = manager(page);
  await expect(modal).toHaveCount(1);
  assert.deepEqual((await managerNames(modal)).slice(0, 2), [privateTitle(kind), secondTitle(kind)]);
  assert.ok((await managerNames(modal)).length > 2, `${kind}: one manager also shows shared tabs`);
  await expect(button(modal, 'Private tabs')).toHaveCount(0);
  await checkGeometry(page, modal, width);
  await shot(`${kind}-manager`);
  await modal.getByRole('button', { name: /^(?:\+\s*)?PRIVATE TAB$/i }).click();
  await expect(modal).toHaveCount(1);
  const newName = `PRIVATE ${kind.toUpperCase()} NEW`;
  const inputs = modal.locator('input[aria-label^="Tab "]');
  const blank = inputs.filter({ visible: true });
  let newInput;
  for (let i = 0; i < await blank.count(); i++) if (!(await blank.nth(i).inputValue()).trim()) { newInput = blank.nth(i); break; }
  assert.ok(newInput, '+ PRIVATE TAB adds its row inside the same manager');
  await newInput.fill(newName);
  await button(modal, /^SAVE$/i).click();
  await expect(modal).toHaveCount(0);
  await expect(await tab(profile, newName)).toBeVisible();
  await (await tab(profile, privateTitle(kind))).click();
  const content = profile.locator('.profile-tab-content');
  await expect(button(content, 'EDIT')).not.toHaveAttribute('aria-description', 'CONTRIBUTION +1');
  await button(content, 'EDIT').click();
  const editor = profile.locator('.knowledge-editor').first();
  await expect(button(editor, /^SAVE$/i)).not.toHaveAttribute('aria-description', 'CONTRIBUTION +1');
  await expect(editor).toBeVisible();
  await expect(page.getByRole('dialog', { name: /^Update information$/i })).toHaveCount(0);
  await expect(editor.getByLabel('Edit tab', { exact: true })).toHaveCount(0);
  await expect(button(editor, 'Manage tabs')).toHaveCount(0);
  await expect(profile.locator('.profile-tabs-list')).toBeVisible();
  await editor.getByLabel('Block 1 text', { exact: true }).fill(`${privateText(kind)} EDITED`);
  await button(editor, 'Add Table').click();
  await editor.getByLabel('Block 2 title', { exact: true }).fill('PRIVATE TABLE');
  await editor.getByLabel('Row 1, Name', { exact: true }).fill('OWNER ONLY CELL');
  await checkGeometry(page, editor, width);
  await shot(`${kind}-text-table-editor`);
  await button(editor, /^SAVE$/i).click();
  await expect(editor).toHaveCount(0);
  await expect(content).toContainText(`${privateText(kind)} EDITED`);
  await expect(content).toContainText('OWNER ONLY CELL');
  const scope = [...state.private.values()].find(value => value.tabs.some(entry => entry.title === privateTitle(kind)));
  assert.deepEqual(scope.tabs.find(entry => entry.id === sibling.id), sibling, `${kind}: editing one private tab preserves its sibling`);
  await assertNoPrivateLeak(page, state);
  await shot(`${kind}-content`);
  await verifyRetryAndCancel(page, state, profile, kind);
  await verifyEditorTabSwitch(page, profile, kind);
  await verifyManageOrder(page, profile, kind, newName, width, shot);
  const sharedAfter = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), liveKey(user.id));
  for (const key of ['knowledgeRecords', 'knowledgeHistory', 'contributions', 'hats', 'outcomes']) {
    assert.deepEqual(sharedAfter[key], sharedBefore[key], `${kind}: private edits do not change shared ${key}`);
  }
  return profile;
}

async function verifyEditorTabSwitch(page, profile, kind) {
  const content = profile.locator('.profile-tab-content');
  await button(content, 'EDIT').click();
  const editor = profile.locator('.knowledge-editor');
  await expect(editor.getByLabel('Edit tab', { exact: true })).toHaveCount(0);
  await expect(button(editor, 'Manage tabs')).toHaveCount(0);
  // The persistent main strip is the single place for changing tabs.
  await (await tab(profile, secondTitle(kind))).click();
  await expect(editor).toHaveCount(0);
  await expect(content).toContainText('UNCHANGED PRIVATE SIBLING');
  await button(content, 'EDIT').click();
  await editor.getByLabel('Block 1 text', { exact: true }).fill('UNSAVED SWITCH DRAFT');
  page.once('dialog', dialog => dialog.dismiss());
  await (await tab(profile, privateTitle(kind))).click();
  await expect(editor.getByLabel('Block 1 text', { exact: true })).toHaveValue('UNSAVED SWITCH DRAFT');
  page.once('dialog', dialog => dialog.accept());
  await (await tab(profile, privateTitle(kind))).click();
  await expect(editor).toHaveCount(0);
  await expect(content).toContainText(`${privateText(kind)} RETRIED`);
  await (await tab(profile, secondTitle(kind))).click();
  await expect(content).toContainText('UNCHANGED PRIVATE SIBLING');
  await (await tab(profile, privateTitle(kind))).click();
}

async function verifyRetryAndCancel(page, state, profile, kind) {
  const content = profile.locator('.profile-tab-content'), editor = profile.locator('.knowledge-editor').first();
  await button(content, 'EDIT').click();
  await editor.getByRole('button', { name: 'Edit Text 1', exact: true }).click();
  const text = editor.getByLabel('Block 1 text', { exact: true });
  await text.fill(`${privateText(kind)} CONFLICT DRAFT`);
  state.conflict = true;
  await button(editor, /^SAVE$/i).click();
  await expect(content.getByRole('alert')).toContainText('Tabs changed');
  await expect(text).toHaveValue(`${privateText(kind)} CONFLICT DRAFT`);
  state.conflict = false;
  page.once('dialog', dialog => dialog.accept());
  await profile.getByRole('button', { name: 'Reload latest', exact: true }).first().click();
  await (await tab(profile, privateTitle(kind))).click();
  await expect(content).toContainText(`${privateText(kind)} EDITED`);
  await expect(content).not.toContainText('CONFLICT DRAFT');
  await button(content, 'EDIT').click();
  await editor.getByRole('button', { name: 'Edit Text 1', exact: true }).click();
  await text.fill('THIS CANCELLED TEXT MUST NOT BE SAVED');
  const prior = JSON.stringify([...state.private.entries()]);
  page.once('dialog', dialog => dialog.accept());
  await button(editor, 'Cancel').click();
  await expect(editor).toHaveCount(0);
  assert.equal(JSON.stringify([...state.private.entries()]), prior, 'Cancel preserves the saved collection');
  await button(content, 'EDIT').click();
  await editor.getByRole('button', { name: 'Edit Text 1', exact: true }).click();
  await text.fill(`${privateText(kind)} RETRIED`);
  state.dropResponse = true;
  await button(editor, /^SAVE$/i).click();
  await expect(content.getByRole('alert')).toBeVisible();
  const attempt = structuredClone(state.requests.at(-1));
  await focus(page);
  await expect(text).toHaveValue(`${privateText(kind)} RETRIED`);
  await button(editor, /^SAVE$/i).click();
  await expect(editor).toHaveCount(0);
  assert.deepEqual(state.requests.at(-1), attempt, `${kind}: uncertain response retry preserves request ID, revision and payload`);
  await expect(content).toContainText(`${privateText(kind)} RETRIED`);
}

async function verifyManageOrder(page, profile, kind, newName, width, shot) {
  await button(profile, 'Manage tabs').click();
  const modal = manager(page), first = modal.getByLabel('Tab 1 name', { exact: true });
  await first.fill(`${privateTitle(kind)} RENAMED`);
  await modal.getByLabel('Tab 3 name', { exact: true }).press('Alt+ArrowUp');
  assert.equal((await managerNames(modal))[1], newName);
  if (width >= 1000) {
    const source = modal.locator('.profile-tabs-manager-row').nth(1).locator('.profile-tabs-grip');
    const target = modal.locator('.profile-tabs-manager-row').first(), transfer = await page.evaluateHandle(() => new DataTransfer());
    await source.dispatchEvent('dragstart', { dataTransfer: transfer });
    const bounds = await target.boundingBox(), point = { clientX: bounds.x + 20, clientY: bounds.y + 2 };
    await target.dispatchEvent('dragover', { dataTransfer: transfer, ...point });
    await expect(target).toHaveClass(/is-drop-before/);
    await shot(`${kind}-insertion`);
    await target.dispatchEvent('drop', { dataTransfer: transfer, ...point });
    await source.dispatchEvent('dragend', { dataTransfer: transfer });
    await transfer.dispose();
    assert.equal((await managerNames(modal))[0], newName);
  }
  await button(modal, /^SAVE$/i).click();
  await expect(modal).toHaveCount(0);
  await button(profile, 'Manage tabs').click();
  await button(modal, `Remove tab ${newName}`).click();
  await button(modal, /^SAVE$/i).click();
  await expect(await tab(profile, newName)).toHaveCount(0);
  await button(profile, 'Manage tabs').click();
  await modal.getByLabel('Tab 1 name', { exact: true }).fill(privateTitle(kind));
  await button(modal, /^SAVE$/i).click();
  await expect(modal).toHaveCount(0);
}

async function verifySharedEditing(page, state, width, shot) {
  for (const kind of ['country', 'port']) {
    const profile = await openProfile(page, kind);
    await (await tab(profile, sharedTitles[0])).click();
    await expect(profile.locator('.knowledge-header').getByRole('button', { name: 'EDIT', exact: true })).toHaveCount(0);
    const before = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), liveKey(user.id));
    await button(profile.locator('.knowledge-content-toolbar'), 'EDIT').click();
    const editor = profile.locator('.knowledge-editor');
    await expect(editor).toBeVisible();
    await expect(page.getByRole('dialog', { name: /^Update information$/i })).toHaveCount(0);
    await expect(editor.getByLabel('Edit tab', { exact: true })).toHaveCount(0);
    await expect(button(editor, 'Manage tabs')).toHaveCount(0);
    await expect(editor.getByLabel('Block 1 text')).toHaveValue(`UNCHANGED ${kind.toUpperCase()} 1`);
    await editor.getByLabel('Block 1 text').fill(`EDITED ${kind.toUpperCase()} ONLY`);
    await shot(`${kind}-shared-inline`);
    await button(editor, /^SAVE$/i).click();
    await expect(editor).toHaveCount(0);
    const after = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), liveKey(user.id));
    const key = kind === 'country' ? 'country:Japan' : 'port:port-chiba';
    assert.equal(after.knowledgeRecords[key].sections[0].blocks[0].text, `EDITED ${kind.toUpperCase()} ONLY`);
    assert.deepEqual(after.knowledgeRecords[key].sections[0].blocks[1], before.knowledgeRecords[key].sections[0].blocks[1], 'Unedited table and row identities are unchanged');
    assert.deepEqual(after.knowledgeRecords[key].sections[1], before.knowledgeRecords[key].sections[1], 'A different shared tab is unchanged');
  }
  const profile = await openProfile(page, 'supplier');
  await profile.getByRole('tab', { name: 'Supplier information', exact: true }).click();
  await expect(profile.locator('.shared-supplier-profile-heading').getByRole('button', { name: 'EDIT', exact: true })).toHaveCount(0);
  const before = structuredClone(state.record);
  await button(profile.locator('.shared-supplier-content-toolbar'), 'EDIT').click();
  await profile.getByLabel('Payment terms', { exact: true }).fill('21');
  await shot('supplier-shared-inline');
  await button(profile.locator('.shared-supplier-save'), /^SAVE$/i).click();
  await expect(profile.getByLabel('Payment terms', { exact: true })).toHaveCount(0);
  assert.equal(state.record.info.paymentTerms, '21');
  assert.deepEqual(state.record.contacts, before.contacts);
  assert.deepEqual(state.record.barges, before.barges);
  assert.equal(state.record.info.foBdn, before.info.foBdn);
  await checkGeometry(page, profile, width);
}

async function verifyPartialManagerRetry(page, state) {
  const profile = await openProfile(page, 'supplier');
  await button(profile, 'Manage tabs').click();
  const modal = manager(page);
  await modal.getByLabel('Tab 1 name', { exact: true }).fill('PRIVATE SUPPLIER RENAMED');
  const names = await managerNames(modal), at = names.indexOf('Supplier information');
  assert.ok(at >= 2, 'Supplier shared row follows private rows');
  await modal.getByLabel(`Tab ${at + 1} name`, { exact: true }).fill('SUPPLIER OPERATIONS');
  const before = state.requests.length;
  state.failSharedOnce = true;
  await button(modal, /^SAVE$/i).click();
  await expect(modal.getByRole('alert')).toContainText('temporarily unavailable');
  await expect(modal.getByLabel('Tab 1 name', { exact: true })).toHaveValue('PRIVATE SUPPLIER RENAMED');
  assert.equal(state.requests.slice(before).filter(request => request.visibility === 'private').length, 1);
  await button(modal, /^SAVE$/i).click();
  await expect(modal).toHaveCount(0);
  const attempts = state.requests.slice(before);
  assert.equal(attempts.filter(request => request.visibility === 'private').length, 1, 'Successful private save is not resubmitted when shared save retries');
  const shared = attempts.filter(request => request.visibility === 'shared');
  assert.equal(shared.length, 2);
  assert.deepEqual(shared[0], shared[1], 'Shared retry preserves the request identity and revision');
}

async function verifyNavigationDiscard(page, state, shot) {
  for (const visibility of ['shared', 'private']) {
    const profile = await openProfile(page, 'country');
    await (await tab(profile, visibility === 'private' ? privateTitle('country') : sharedTitles[0])).click();
    const before = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).knowledgeRecords, liveKey(user.id));
    const requests = state.requests.length;
    if (visibility === 'private') await button(profile.locator('.profile-tab-content'), 'EDIT').click();
    else await button(profile.locator('.knowledge-content-toolbar'), 'EDIT').click();
    const editor = profile.locator('.knowledge-editor'), text = editor.getByLabel('Block 1 text', { exact: true });
    await text.fill(`UNSAVED ${visibility.toUpperCase()} NAVIGATION DRAFT`);
    const narrow = page.viewportSize().width <= 600;
    const index = page.getByRole('dialog', { name: 'Countries & Ports', exact: true }).getByRole('button', { name: narrow ? 'Back to Countries & Ports' : 'Port Index', exact: true });
    page.once('dialog', dialog => dialog.dismiss());
    await index.click();
    await expect(text).toHaveValue(`UNSAVED ${visibility.toUpperCase()} NAVIGATION DRAFT`);
    await shot(`${visibility}-discard-dismissed`);
    page.once('dialog', dialog => dialog.accept());
    await index.click();
    await expect(editor).toHaveCount(0);
    await expect(page.locator(narrow ? '.location-recents' : '.location-table')).toBeVisible();
    assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).knowledgeRecords, liveKey(user.id)), before);
    assert.equal(state.requests.length, requests, 'Discarding navigation draft sends no private save');
  }
}

async function verifyGates(page, state, shot) {
  const refreshAuthority = async () => {
    const expected = structuredClone({ user: state.user, preview: state.preview });
    const response = page.waitForResponse(async response => {
      if (new URL(response.url()).pathname !== '/api/access/session') return false;
      if (!expected.user) return response.status() === 401;
      if (response.status() !== 200) return false;
      const session = await response.json().catch(() => null);
      return session?.user?.id === expected.user.id && JSON.stringify(session.preview) === JSON.stringify(expected.preview);
    });
    // Authority changes invalidate pending refreshes; focus remains appropriate
    // for the data-only refresh cases elsewhere in this suite.
    await page.evaluate(() => {
      const channel = new BroadcastChannel('eco-access-invalidation');
      channel.postMessage('refresh-needed');
      channel.close();
    });
    assert.equal(await (await response).finished(), null);
  };
  let profile = await openProfile(page, 'country');
  await (await tab(profile, privateTitle('country'))).click();
  await button(profile.locator('.profile-tab-content'), 'EDIT').click();
  await profile.getByLabel('Block 1 text').fill('UNSAVED OWNER SECRET');
  const beforeWrites = state.requests.length + state.supplierWrites.length;
  state.preview = { role: 'trader', officeId: 'HONG KONG', officeName: 'HONG KONG', readOnly: true };
  await refreshAuthority();
  await expect(page.getByRole('status', { name: 'Role preview' }).first()).toBeVisible();
  profile = await openProfile(page, 'country');
  await expect(await tab(profile, privateTitle('country'))).toHaveCount(0);
  await expect(profile.locator('.knowledge-editor')).toHaveCount(0);
  await expect(profile.getByText('UNSAVED OWNER SECRET', { exact: true })).toHaveCount(0);
  await expect(profile.getByRole('button', { name: 'EDIT', exact: true })).toHaveCount(0);
  await shot('preview-country');
  state.preview = null; await refreshAuthority();
  await expect(page.getByRole('status', { name: 'Role preview' })).toHaveCount(0);
  profile = await openProfile(page, 'country');
  await button(profile, 'Manage tabs').click();
  state.user = { ...user, capabilities: { testWorkspace: false, appearancePreview: false }, id: '10000000-0000-4000-8000-000000000002', email: 'another@example.test', displayName: 'OTHER ADMIN' };
  await refreshAuthority();
  await expect(page.locator('.hud-identity')).toContainText('OTHER ADMIN');
  await expect(manager(page)).toHaveCount(0);
  profile = await openProfile(page, 'country');
  await expect(await tab(profile, privateTitle('country'))).toHaveCount(0);
  await shot('other-admin');
  state.user = structuredClone(user); await refreshAuthority();
  await expect(page.locator('.hud-identity')).toContainText('FIXTURE ADMIN');
  await closeWorkspace(page);
  const testToggle = page.locator('.home-display-controls').getByRole('button', { name: 'Test data', exact: true });
  await expect(testToggle).toBeEnabled(); await testToggle.click();
  await expect(testToggle).toHaveAttribute('aria-pressed', 'true');
  profile = await openProfile(page, 'supplier');
  await expect(profile.getByRole('tab', { name: /PRIVATE SUPPLIER/ })).toHaveCount(0);
  await expect(button(profile, 'Manage tabs')).toHaveCount(0);
  await expect(profile.getByRole('button', { name: 'EDIT', exact: true })).toHaveCount(0);
  await shot('test-supplier');
  await closeWorkspace(page); await testToggle.click();
  await expect(testToggle).toHaveAttribute('aria-pressed', 'false');
  state.user = { ...user, capabilities: { testWorkspace: false, appearancePreview: false }, id: '10000000-0000-4000-8000-000000000003', email: 'trader@example.test', displayName: 'NORMAL TRADER', isAdmin: false, isSpcTrader: false };
  await refreshAuthority();
  await expect(page.locator('.hud-identity')).toContainText('NORMAL TRADER');
  profile = await openProfile(page, 'supplier');
  await expect(profile.getByRole('button', { name: 'EDIT', exact: true })).toHaveCount(0);
  await button(profile, 'Manage tabs').click();
  await expect(manager(page).getByRole('button', { name: /^(?:\+\s*)?PRIVATE TAB$/i })).toBeVisible();
  await expect(manager(page).getByRole('button', { name: 'Add tab', exact: true })).toHaveCount(0);
  await button(manager(page), 'Cancel').click();
  await shot('trader-supplier');
  state.user = null; await refreshAuthority();
  await expect(button(page, 'Sign in')).toBeVisible();
  await expect(page.locator('.profile-tab-content')).toHaveCount(0);
  await expect(manager(page)).toHaveCount(0);
  await shot('signed-out');
  assert.equal(state.requests.length + state.supplierWrites.length, beforeWrites, 'Owner/preview/TEST/signed-out transitions send no writes');
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
      await context.addInitScript(value => localStorage.setItem('ecosystem.theme.v1', value), theme);
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.setDefaultTimeout(15000);
      const shot = async name => {
        await page.screenshot({ path: `${out}/${engine}-${width}-${theme}-${name}.png`, fullPage: true });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: page overflow`);
      };
      try {
        await page.goto(base);
        await page.getByRole('main', { name: 'ECOSYSTEM workspace' }).waitFor();
        await createLiveFixtureBuyer(page, 'UNIFIED TAB TEST BUYER');
        await page.evaluate(({ key, country, port }) => {
          const state = JSON.parse(localStorage.getItem(key));
          state.knowledgeRecords = { ...state.knowledgeRecords, 'country:Japan': country, 'port:port-chiba': port };
          localStorage.setItem(key, JSON.stringify(state));
        }, { key: liveKey(user.id), country: knowledgeDocument('country'), port: knowledgeDocument('port') });
        await page.reload();
        for (const kind of kinds) await verifyProfile(page, state, kind, width, shot);
        await verifySharedEditing(page, state, width, shot);
        await verifyPartialManagerRetry(page, state);
        await verifyNavigationDiscard(page, state, shot);
        await verifyGates(page, state, shot);
        await assertNoPrivateLeak(page, state);
        assert.deepEqual(errors, []);
        results.push({ engine, width, theme, kinds, status: 'passed' });
        console.log(`PASS ${engine} ${width} ${theme}: unified country/port/supplier/buyer tabs`);
      } catch (error) {
        await page.screenshot({ path: `${out}/${engine}-${width}-${theme}-FAILURE.png`, fullPage: true }).catch(() => {});
        throw error;
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
}
await writeFile(`${out}/results.json`, JSON.stringify({ base, results, limits: 'Isolated API fixtures; physical devices and native Safari are not covered.' }, null, 2));
console.log(JSON.stringify({ passed: results.length, output: out }));
