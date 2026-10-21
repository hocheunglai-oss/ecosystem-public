import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const BASE = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4181';
const OUT = new URL('../artifacts/knowledge-editor-layout/', import.meta.url);
const STAMP = { updatedBy: 'elena', updatedAt: '2026-10-01T08:00:00.000Z' };
const supplierName = 'Meridian Bunker Supply · Demo';
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const readState = page => page.evaluate(() => JSON.parse(localStorage.getItem('ecosystem.demo.v1')));
const commonTabs = [
  ['suppliers', 'Suppliers', 'suppliers'], ['refineries', 'Refineries', 'refineries'],
  ['grades-delivery', 'Grades and delivery modes', 'grades-delivery'], ['tax-regulations', 'Tax and regulations', 'tax-regulations'],
  ['trader-remarks', "Trader's Remarks", 'trader-remarks'], ['uploaded-documents', 'Uploaded Documents', 'uploaded-documents'],
];
function document(kind, prefix) {
  const tabs = kind === 'supplier'
    ? [['general', 'Supplier Information', 'supplier-information'], ...commonTabs.slice(-2), ['supplier-fixtures', 'Fixtures', 'supplier-fixtures']]
    : [...(kind === 'port' ? [['general', 'Port Information', 'port-information']] : []), ...commonTabs];
  const sections = tabs.map(([id, title, role]) => ({ id, title, role, blocks: [] }));
  sections[0].blocks = [
    { id: `${prefix}-a`, type: 'text', title: 'FIRST NOTE', text: 'FIRST SAVED CONTENT', update: STAMP },
    { id: `${prefix}-b`, type: 'text', title: 'SECOND NOTE', text: 'SECOND SAVED CONTENT', update: STAMP },
    { id: `${prefix}-c`, type: 'table', title: 'SAVED TABLE', columns: [{ id: `${prefix}-column`, name: 'Name' }], rows: [{ id: `${prefix}-row`, cells: ['UNCHANGED CELL'], update: STAMP }], update: STAMP },
  ];
  return { version: 4, layoutVersion: 2, ...(kind === 'supplier' ? { supplierFixturesVersion: 1 } : {}), sections };
}
const targets = [
  { kind: 'country', name: 'Japan', key: 'country:Japan', prefix: 'country', tab: 'Suppliers' },
  { kind: 'port', name: 'Chiba', key: 'port:port-chiba', prefix: 'port', tab: 'Port Information' },
  { kind: 'supplier', name: supplierName, key: 'supplier:supplier-meridian', prefix: 'supplier', tab: 'Supplier Information' },
];
async function enter(page) {
  await page.goto(BASE);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  const login = page.getByLabel('Demo profile', { exact: true });
  if (await login.isVisible()) { await login.selectOption('otto'); await button(page, 'ENTER ECOSYSTEM').click(); }
}
async function closeWorkspace(page) {
  const close = button(page, 'Close workspace'); if (await close.count()) await close.click();
}
async function workspace(page, name) {
  await closeWorkspace(page);
  const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
  const group = button(nav, 'Intelligence'); if (await group.getAttribute('aria-expanded') !== 'true') await group.click();
  await button(nav, name).click();
  return page.getByRole('dialog', { name, exact: true });
}
async function openProfile(page, target) {
  if (target.kind === 'supplier') {
    const profile = await workspace(page, 'Supplier Profiles');
    const back = button(profile, 'Back to supplier results'); if (await back.count()) await back.click();
    await profile.getByLabel('Search suppliers', { exact: true }).fill(target.name);
    await profile.getByRole('table', { name: 'Supplier results', exact: true }).getByRole('button', { name: new RegExp(target.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }).click();
    return profile;
  }
  const profile = await workspace(page, 'Countries & Ports');
  await button(profile, target.kind === 'country' ? 'Country Index' : 'Port Index').click();
  await profile.getByLabel('Country or port', { exact: true }).fill(target.name);
  await profile.locator('.location-table').getByRole('button', { name: target.name, exact: true }).click();
  return profile;
}
async function editorFor(page, profile, tab) {
  await profile.getByRole('tab', { name: tab, exact: true }).click();
  await profile.locator('.knowledge-header:visible').getByRole('button', { name: /^Update(?:\s|$)/ }).click();
  return page.getByRole('dialog', { name: 'Update information', exact: true });
}
const blockOrder = editor => editor.locator('.knowledge-outline-item').evaluateAll(items => items.map(item => item.dataset.blockId));
const tabOrder = manager => manager.locator('.knowledge-manage-row').evaluateAll(items => items.map(item => item.dataset.tabId));
async function assertShell(page, editor, width) {
  await expect(editor.getByRole('button', { name: /^(Blocks|Show information blocks|Hide information blocks)$/ })).toHaveCount(0);
  const bar = editor.locator('.knowledge-editor-topbar');
  for (const label of ['Manage Tabs', 'Add Text', 'Add Table', 'Add file link']) await expect(button(bar, label)).toBeVisible();
  const [manage, divider, add, cancel, update, footer] = await Promise.all([
    button(bar, 'Manage Tabs').boundingBox(), bar.locator('.knowledge-editor-divider').boundingBox(), button(bar, 'Add Text').boundingBox(),
    button(editor, 'Cancel').boundingBox(), button(editor, 'Update').boundingBox(), editor.locator('footer.knowledge-editor-actions').boundingBox(),
  ]);
  assert.ok(divider.width >= 1 && divider.width <= 3 && divider.height >= 20, 'Visible vertical divider');
  assert.notEqual(await bar.locator('.knowledge-editor-divider').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
  if (width >= 1000) {
    assert.ok(manage.x + manage.width < divider.x && divider.x + divider.width < add.x, 'Add actions follow Manage Tabs and its divider');
    assert.ok(Math.abs(manage.y - add.y) <= 1, 'Top actions share one row');
  }
  assert.ok(Math.abs(cancel.y - update.y) <= 1 && Math.abs(cancel.height - update.height) <= 1, 'Cancel and Update align');
  assert.ok(update.x - cancel.x - cancel.width >= 0 && update.x - cancel.x - cancel.width <= 10, 'Cancel stays adjacent to Update');
  assert.ok(Math.abs(update.x + update.width - footer.x - footer.width) <= 2, 'Footer actions align right');
  for (const box of [cancel, update]) assert.ok(box.x >= 0 && box.x + box.width <= width + 1 && box.y >= 0 && box.y + box.height <= 901);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Page fits viewport');
}
async function seed(page) {
  const docs = Object.fromEntries(targets.map(target => [target.key, document(target.kind, target.prefix)]));
  docs['port:port-hong-kong'] = { version: 4, layoutVersion: 2, sections: [{ id: 'port-a', title: 'PORT A', blocks: [] }, { id: 'port-b', title: 'PORT B', blocks: [] }] };
  docs['country:Hong Kong'] = { version: 4, layoutVersion: 2, sections: [{ id: 'country-a', title: 'COUNTRY A', blocks: [] }, { id: 'country-b', title: 'COUNTRY B', blocks: [] }] };
  await page.evaluate(docs => {
    const state = JSON.parse(localStorage.getItem('ecosystem.demo.v1'));
    state.knowledgeRecords = { ...state.knowledgeRecords, ...docs };
    const source = state.outcomes.find(item => item.kind === 'fixture' && item.owner === 'otto' && item.supplierId === 'supplier-meridian');
    if (!source) throw new Error('Expected existing demo supplier fixtures');
    state.outcomes.push({ ...source, id: 'layout-mixed-fixture', vessel: 'LAYOUT MULTI SUPPLIER', bookedAt: '2026-10-06T10:00:00.000Z', stemProducts: [
      { grade: 'VLSFO', quantityText: '500–600', buyPrice: 550.12, supplierId: 'supplier-meridian', supplierName: 'Meridian Bunker Supply · Demo' },
      { grade: 'LSMGO', quantityText: '70', buyPrice: 919.91, supplierId: 'supplier-harbourline', supplierName: 'Harbourline Marine Fuels · Demo' },
    ] });
    localStorage.setItem('ecosystem.demo.v1', JSON.stringify(state));
  }, docs);
  await page.reload();
}
async function testBlocks(page, target, width) {
  let profile = await openProfile(page, target), editor = await editorFor(page, profile, target.tab);
  await assertShell(page, editor, width);
  await page.screenshot({ path: new URL(`${target.kind}-editor-${width}.png`, OUT).pathname });
  const [a, b, c] = ['a', 'b', 'c'].map(letter => `${target.prefix}-${letter}`);
  const before = (await readState(page)).knowledgeRecords[target.key];
  const item = id => editor.locator(`.knowledge-outline-item[data-block-id="${id}"]`);
  assert.deepEqual(await blockOrder(editor), [a, b, c]);
  if (width >= 1000) {
    await item(a).locator('.knowledge-outline-grip').dragTo(item(c));
    assert.deepEqual(await blockOrder(editor), [b, c, a]);
    await expect(item(a).locator('.knowledge-outline-select')).toHaveAttribute('aria-pressed', 'true');
    await button(item(a), 'Move block 3 up').click();
    assert.deepEqual(await blockOrder(editor), [b, a, c]);
    await item(a).locator('.knowledge-outline-select').press('Alt+ArrowUp');
    assert.deepEqual(await blockOrder(editor), [a, b, c]);
    await button(item(a), 'Move block 1 down').click();
  } else {
    await button(item(a), 'Move block 1 down').click();
    await item(a).locator('.knowledge-outline-select').press('Alt+ArrowDown');
    assert.deepEqual(await blockOrder(editor), [b, c, a]);
    await button(item(a), 'Move block 3 up').click();
  }
  assert.deepEqual(await blockOrder(editor), [b, a, c]);
  await expect(item(a).locator('.knowledge-outline-select')).toHaveAttribute('aria-pressed', 'true');
  await expect(editor.getByLabel('Block 2 text', { exact: true })).toHaveValue('FIRST SAVED CONTENT');
  await button(editor, 'Update').click(); await expect(editor).toHaveCount(0);
  const saved = (await readState(page)).knowledgeRecords[target.key];
  assert.deepEqual(saved.sections[0].blocks.map(block => block.id), [b, a, c]);
  for (const block of saved.sections[0].blocks) assert.deepEqual(block, before.sections[0].blocks.find(old => old.id === block.id), 'Reordering preserves complete content, IDs, provenance and authorship');
  await page.reload(); profile = await openProfile(page, target); editor = await editorFor(page, profile, target.tab);
  assert.deepEqual(await blockOrder(editor), [b, a, c]);
  const beforeCancel = await readState(page);
  await editor.getByLabel('Block 1 text', { exact: true }).fill('THIS MUST NOT BE SAVED');
  await button(editor, 'Move block 1 down').click();
  await button(editor, 'Cancel').click(); await expect(editor).toHaveCount(0);
  assert.deepEqual(await readState(page), beforeCancel, 'Cancel preserves all stored records and history');
  return profile;
}
async function testManage(page, width) {
  const target = targets[1], profile = await openProfile(page, target);
  await button(profile, 'Manage Tabs').click();
  let manager = page.getByRole('dialog', { name: 'Manage Tabs', exact: true });
  const initial = await tabOrder(manager), [a, b, c] = initial;
  const row = id => manager.locator(`.knowledge-manage-row[data-tab-id="${id}"]`);
  if (width >= 1000) await row(a).locator('.knowledge-manage-grip').dragTo(row(c));
  else { await button(row(a), 'Move tab 1 down').click(); await row(a).getByRole('textbox').press('Alt+ArrowDown'); }
  assert.deepEqual((await tabOrder(manager)).slice(0, 3), [b, c, a]);
  await button(row(a), 'Move tab 3 up').click();
  const expected = [b, a, c, ...initial.slice(3)]; assert.deepEqual(await tabOrder(manager), expected);
  const prior = (await readState(page)).knowledgeRecords[target.key];
  await button(manager, 'Save').click(); await expect(manager).toHaveCount(0);
  const saved = (await readState(page)).knowledgeRecords[target.key];
  assert.deepEqual(saved.sections.map(section => section.id), expected);
  for (const section of saved.sections) assert.deepEqual(section, prior.sections.find(old => old.id === section.id));
  await page.reload(); const reloaded = await openProfile(page, target); await button(reloaded, 'Manage Tabs').click();
  manager = page.getByRole('dialog', { name: 'Manage Tabs', exact: true }); assert.deepEqual(await tabOrder(manager), expected); await button(manager, 'Cancel').click();

  const combined = await openProfile(page, { kind: 'port', name: 'Hong Kong' }); await button(combined, 'Manage Tabs').click();
  manager = page.getByRole('dialog', { name: 'Manage Tabs', exact: true });
  const combinedBefore = await tabOrder(manager), storageBefore = await readState(page);
  assert.deepEqual(combinedBefore, ['port-a', 'port-b', 'country:country-a', 'country:country-b']);
  await expect(button(manager, 'Move tab 2 down')).toBeDisabled(); await expect(button(manager, 'Move tab 3 up')).toBeDisabled();
  if (width >= 1000) await row('port-b').locator('.knowledge-manage-grip').dragTo(row('country:country-a'));
  else await row('port-b').getByRole('textbox').press('Alt+ArrowDown');
  assert.deepEqual(await tabOrder(manager), combinedBefore, 'Reordering cannot cross the country/port record boundary');
  await expect(button(manager, 'Save')).toBeDisabled(); await button(manager, 'Cancel').click();
  assert.deepEqual(await readState(page), storageBefore);
}
async function testFixtures(page) {
  let profile = await openProfile(page, targets[2]); await profile.getByRole('tab', { name: 'Fixtures', exact: true }).click();
  const fixtures = profile.getByRole('region', { name: 'Supplier fixtures', exact: true });
  await expect(fixtures).toBeVisible(); await expect(profile.locator('.knowledge-header').getByRole('button', { name: /^Update(?:\s|$)/ })).toHaveCount(0);
  const state = await readState(page), expectedCount = state.outcomes.filter(item => item.kind === 'fixture' && item.owner === 'otto' && item.supplierId === 'supplier-meridian').length;
  await expect(fixtures.locator('tbody')).toHaveCount(Math.min(50, expectedCount));
  const mixed = fixtures.locator('[data-record-id="layout-mixed-fixture"]'); await expect(mixed).toContainText('550.12'); await expect(mixed).toContainText('500–600');
  await expect(mixed.locator('tr')).toHaveCount(1); await expect(mixed).not.toContainText('LSMGO'); await expect(fixtures).not.toContainText('919.91');
  await fixtures.getByLabel('Search fixtures', { exact: true }).fill('LAYOUT MULTI'); await expect(fixtures.locator('tbody')).toHaveCount(1);
  await fixtures.getByLabel('Search fixtures', { exact: true }).fill('LSMGO'); await expect(fixtures.locator('tbody')).toHaveCount(0);
  await fixtures.getByLabel('Search fixtures', { exact: true }).fill(''); await fixtures.getByLabel('Fixtures per page', { exact: true }).selectOption('25');
  await expect(fixtures.locator('tbody')).toHaveCount(Math.min(25, expectedCount));
  await button(fixtures, 'Vessel').click(); await expect(fixtures.getByRole('columnheader', { name: 'Vessel', exact: true })).toHaveAttribute('aria-sort', 'ascending');
  profile = await openProfile(page, { kind: 'supplier', name: 'NUNCHI' }); await profile.getByRole('tab', { name: 'Fixtures', exact: true }).click();
  const noFixtures = profile.getByRole('region', { name: 'Supplier fixtures', exact: true });
  await expect(noFixtures.locator('tbody')).toHaveCount(0); await expect(noFixtures.getByRole('status')).toHaveText('0 records');
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
try {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }].filter(view => !process.env.ECO_EDITOR_LAYOUT_WIDTH || view.width === Number(process.env.ECO_EDITOR_LAYOUT_WIDTH))) {
    const context = await browser.newContext({ viewport, isMobile: viewport.width < 1000, hasTouch: viewport.width < 1000, reducedMotion: 'reduce' });
    await context.addInitScript(theme => localStorage.setItem('ecosystem.theme.v1', theme), viewport.width < 1000 ? 'dark' : 'light');
    const page = await context.newPage(), errors = [], writes = [];
    page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.url()); }); page.on('dialog', dialog => dialog.accept());
    try {
      await enter(page); await seed(page);
      for (const target of targets) await testBlocks(page, target, viewport.width);
      await testManage(page, viewport.width); await testFixtures(page);
      await page.screenshot({ path: new URL(`fixtures-empty-${viewport.width}.png`, OUT).pathname });
      assert.deepEqual(errors, []); assert.deepEqual(writes, []);
      console.log(`PASS ${viewport.width}px: country/port/supplier editor layout, block drag/arrows/keyboard with IDs and audits, save/reload/cancel, tab reorder and source boundary, supplier fixture grade-price isolation and no invented rows`);
    } catch (error) { await page.screenshot({ path: new URL(`failure-${viewport.width}.png`, OUT).pathname }).catch(() => {}); throw error; }
    finally { await context.close(); }
  }
} finally { await browser.close(); }
