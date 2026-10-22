import { installSharedLocations, sharedLocations } from './fixtures/shared-locations.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit, expect } from '@playwright/test';
import { installEmptyLiveInbox } from './fixtures/empty-live-inbox.mjs';
import { installProfileTabMocks } from './fixtures/profile-tabs.mjs';
import { installStagingCookies } from './fixtures/protection-cookies.mjs';
import { invalidateFixtureAuthority } from './fixtures/authority-transition.mjs';

const base = process.env.ECO_TABLE_PASTE_ORIGIN || 'http://127.0.0.1:4340';
const out = process.env.ECO_TABLE_PASTE_OUTPUT || '/private/tmp/eco-table-paste';
const user = { id: '10000000-0000-4000-8000-000000000001', email: 'table@example.test', displayName: 'TABLE FIXTURE', phone: '', officeId: 'HONG KONG', officeName: 'HONG KONG', isAdmin: true, isSpcTrader: true, isManager: false, isActive: true, activated: true, passwordChangeSuggested: false, revision: 1 };
const url = 'https://Example.test/Path?Key=AbC';
const btn = (scope, name) => scope.getByRole('button', { name, exact: true });
const results = [];
await mkdir(out, { recursive: true });
async function paste(field, text, html = '') {
  await field.evaluate((node, { text, html }) => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', text); if (html) clipboardData.setData('text/html', html);
    node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  }, { text, html });
}
async function fixture(context) {
  const state = { user: structuredClone(user), preview: null, writes: [], external: [] };
  await context.route('**/api/**', route => { if (route.request().method() !== 'GET') state.writes.push(route.request().url()); return route.fulfill({ status: 404, json: { message: 'Synthetic fixture only.' } }); });
  await context.route('**://paste-untrusted.invalid/**', route => { state.external.push(route.request().url()); return route.abort(); });
  await installEmptyLiveInbox(context);
  await installSharedLocations(context, { user: () => state.user, preview: () => state.preview });
  await installProfileTabMocks(context, { ownerId: () => state.user?.id, preview: () => Boolean(state.preview) });
  await context.route('**/api/access/**', route => route.fulfill(state.user ? { json: new URL(route.request().url()).pathname.endsWith('/session') ? { user: state.user, preview: state.preview } : { users: [state.user], offices: [], requests: [] } } : { status: 401, json: { message: 'Sign in required.' } }));
  await context.route('**/api/admin/**', route => route.fulfill({ json: { count: 0, items: [] } }));
  await context.route('**/api/suppliers/**', route => route.fulfill({ json: { items: [], total: 0, page: 1, pageSize: 50 } }));
  await context.route('**/api/enquiries/test-policy', route => route.fulfill({ json: { enabled: false } }));
  return state;
}
async function openProfile(page) {
  const existing = page.getByRole('dialog', { name: 'Countries & Ports', exact: true });
  if (await existing.count()) await btn(existing, 'Close workspace').click();
  const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
  if (await btn(nav, 'Ports & Suppliers').getAttribute('aria-expanded') !== 'true') await btn(nav, 'Ports & Suppliers').click();
  await btn(nav, 'Countries & Ports').click();
  const workspace = page.getByRole('dialog', { name: 'Countries & Ports', exact: true });
  await btn(workspace, 'Country Index').click(); await workspace.getByLabel('Country or port', { exact: true }).fill('Japan');
  await btn(workspace.locator('.location-table'), 'Japan').click();
  await workspace.getByRole('tab', { name: 'PASTE FIXTURE', exact: true }).click();
  return workspace;
}
async function edit(page, workspace) {
  await btn(workspace.locator('.knowledge-content-toolbar'), 'EDIT').click();
  await workspace.locator('.knowledge-editor [data-block-id="fixture-table"] button').click();
  return workspace.locator('.knowledge-editor');
}
for (const [engine, type] of [['chromium', chromium], ['webkit', webkit]]) {
  if (process.env.ECO_TEST_ENGINE && process.env.ECO_TEST_ENGINE !== engine) continue;
  const browser = await type.launch({ headless: true });
  try { for (const width of [1440, 320, 390]) for (const theme of ['light', 'dark']) {
    if (process.env.ECO_TEST_WIDTH && Number(process.env.ECO_TEST_WIDTH) !== width || process.env.ECO_TEST_THEME && process.env.ECO_TEST_THEME !== theme) continue;
    const context = await browser.newContext({ viewport: { width, height: width < 760 ? 844 : 1000 }, isMobile: width < 760, hasTouch: width < 760, reducedMotion: 'reduce', colorScheme: theme });
    await installStagingCookies(context, base); const state = await fixture(context);
    await context.addInitScript(theme => { localStorage.setItem('ecosystem.theme.v1', theme); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { read: async () => {
      if (window.__deferClipboard) return new Promise(resolve => { window.__resolveClipboard = resolve; });
      throw new DOMException('Denied', 'NotAllowedError');
    } } }); }, theme);
    const page = await context.newPage(), errors = []; page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    const shot = async name => { await page.screenshot({ path: `${out}/${engine}-${width}-${theme}-${name}.png` }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Page must not overflow'); };
    try {
      sharedLocations(context).seed(saved => {
        saved.knowledgeRecords['country:Japan'] = { version: 1, layoutVersion: 2, sections: [{ id: 'paste-fixture', title: 'PASTE FIXTURE', blocks: [
          { id: 'sibling', type: 'text', title: 'UNCHANGED NOTE', text: 'KEEP SIBLING' },
          { id: 'fixture-table', type: 'table', title: 'TABLE FIXTURE', columns: [{ id: 'name', name: 'NAME' }, { id: 'detail', name: 'DETAIL' }], rows: [{ id: 'original', cells: ['ORIGINAL', 'KEEP'] }] },
        ] }] };
      });
      await page.goto(base); await page.getByRole('main', { name: 'ECOSYSTEM workspace' }).waitFor();
      let workspace = await openProfile(page), editor = await edit(page, workspace);
      await btn(editor.locator('.knowledge-sheet-toolbar'), 'PASTE TABLE').click();
      let dialog = page.getByRole('dialog', { name: 'PASTE TABLE', exact: true });
      await btn(dialog, 'PASTE FROM CLIPBOARD').click(); await expect(dialog.getByRole('alert')).toContainText('PASTE INTO THE TABLE DATA FIELD');
      await expect(dialog.getByLabel('Table data')).toBeFocused();
      await page.evaluate(() => { window.__deferClipboard = true; });
      await btn(dialog, 'PASTE FROM CLIPBOARD').click();
      await expect.poll(() => page.evaluate(() => typeof window.__resolveClipboard)).toBe('function');
      await dialog.getByLabel('Table data').fill('MANUAL\tDRAFT\nKEEP\tLATEST');
      await page.evaluate(() => { window.__resolveClipboard([{ types: ['text/plain'], getType: async () => new Blob(['OLD\tCLIPBOARD']) }]); window.__deferClipboard = false; });
      await expect(btn(dialog, 'PASTE FROM CLIPBOARD')).toBeEnabled();
      await expect(dialog.getByLabel('Table data')).toHaveValue('MANUAL\tDRAFT\nKEEP\tLATEST');
      await expect(btn(dialog, 'USE TABLE')).toBeDisabled();
      await btn(dialog, 'PREVIEW TABLE').click();
      await expect(dialog.getByRole('region', { name: 'Table preview' })).toContainText('LATEST');
      await paste(dialog.getByLabel('Table data'), '', '<table><tr><th>NAME</th><th>DETAIL</th></tr><tr><td rowspan="2">MERGED</td><td>A</td></tr><tr><td>B</td></tr></table>');
      assert.deepEqual(await dialog.locator('tbody tr').evaluateAll(rows => rows.map(row => [...row.cells].map(cell => cell.textContent))), [['MERGED', 'A'], ['', 'B']]);
      const html = `<link rel="stylesheet" href="https://paste-untrusted.invalid/x.css"><img src="https://paste-untrusted.invalid/outside.png"><table><tr><th>NAME</th><th>SOURCE</th><th>NOTES</th></tr><tr><td>Acme</td><td><a href="${url}">Main</a></td><td>Line 1<br>Line 2<script>window.__copiedScriptRan=1</script><img src="https://paste-untrusted.invalid/inside.png" onerror="window.__copiedScriptRan=2"></td></tr><tr><td>Other</td><td><a href="javascript:window.__copiedScriptRan=3">Plain label</a></td><td>OK</td></tr></table>`;
      await paste(dialog.getByLabel('Table data'), 'Fallback must not replace HTML structure', html);
      await expect(dialog.getByRole('status')).toHaveText('2 ROWS · 3 COLUMNS · HTML');
      await expect(dialog.getByRole('region', { name: 'Table preview' })).toContainText(url);
      await dialog.getByRole('checkbox', { name: 'FIRST ROW AS HEADERS' }).uncheck(); await expect(dialog.getByRole('status')).toHaveText('3 ROWS · 3 COLUMNS · HTML');
      await dialog.getByRole('checkbox', { name: 'FIRST ROW AS HEADERS' }).check();
      await shot('html-preview');
      page.once('dialog', prompt => prompt.dismiss()); await dialog.getByLabel('Table data').press('Control+Enter'); await expect(dialog).toBeVisible();
      await expect(editor.getByLabel('Row 1, NAME', { exact: true })).toHaveValue('ORIGINAL');
      page.once('dialog', prompt => prompt.accept()); await btn(dialog, 'USE TABLE').click(); await expect(dialog).toHaveCount(0);
      await expect(editor.getByLabel('Row 1, NAME', { exact: true })).toHaveValue('ACME');
      await expect(editor.getByLabel('Row 1, SOURCE', { exact: true })).toHaveValue(`MAIN (${url})`);
      await expect(editor.getByLabel('Row 1, NOTES', { exact: true })).toHaveValue('LINE 1\nLINE 2');
      await shot('imported-grid');
      const plainSource = editor.getByLabel('Row 2, SOURCE', { exact: true });
      await plainSource.focus();
      await expect(plainSource).toHaveValue('PLAIN LABEL');
      await paste(plainSource, `${url}\tPLAIN`);
      await expect(plainSource).toHaveValue(url);
      await expect(plainSource).toHaveCSS('text-transform', 'none');
      await paste(editor.getByLabel('Row 2, SOURCE', { exact: true }), 'A\t"B\nC"\tD\nE\tF\tG');
      await expect(editor.getByLabel('Row 3, SOURCE', { exact: true })).toHaveValue('E');
      await expect(editor.getByLabel('Row 2, NOTES', { exact: true })).toHaveValue('B\nC');
      await expect(editor.getByLabel('Row 3, Column 4', { exact: true })).toHaveValue('G');
      await expect(editor.getByLabel('Row 1, NAME', { exact: true })).toHaveValue('ACME');
      await paste(editor.getByLabel('Row 1, NAME', { exact: true }), Array(31).fill('TOO WIDE').join('\t'));
      await expect(editor.getByRole('alert')).toContainText('30 COLUMNS'); await expect(editor.getByLabel('Row 1, NAME', { exact: true })).toHaveValue('ACME');
      await btn(editor.locator('.knowledge-sheet-toolbar'), 'PASTE TABLE').click(); dialog = page.getByRole('dialog', { name: 'PASTE TABLE', exact: true });
      await dialog.getByLabel('Table data').fill('NAME,DETAIL\n"Alpha","First, line\nSecond ""quoted"" line"');
      await btn(dialog, 'PREVIEW TABLE').click(); await expect(dialog.getByRole('status')).toHaveText('1 ROWS · 2 COLUMNS · CSV');
      await shot('csv-preview');
      await paste(dialog.getByLabel('Table data'), '| NAME | SOURCE |\n| --- | --- |\n| A\\|B | https://Example.test/Path?Key=AbC |');
      await expect(dialog.getByRole('status')).toHaveText('1 ROWS · 2 COLUMNS · MARKDOWN');
      await expect(dialog.getByRole('region', { name: 'Table preview' })).toContainText('A|B');
      await paste(dialog.getByLabel('Table data'), 'NAME,DETAIL\n"UNFINISHED'); await expect(dialog.getByRole('alert')).toContainText('UNCLOSED'); await expect(btn(dialog, 'USE TABLE')).toBeDisabled();
      await btn(dialog, 'CANCEL').click();
      await btn(editor, /^SAVE$/i).click(); await expect(editor).toHaveCount(0);
      await expect(workspace).toContainText('KEEP SIBLING');
      const saved = sharedLocations(page).snapshot().knowledgeRecords['country:Japan'];
      const table = saved.sections.find(section => section.id === 'paste-fixture').blocks.find(block => block.id === 'fixture-table');
      assert.equal(table.rows[0].cells[1], `MAIN (${url})`); assert.equal(table.rows[1].cells[2], 'B\nC'); assert.equal(table.rows[2].cells[3], 'G');
      assert.equal(await page.evaluate(() => window.__copiedScriptRan), undefined); assert.deepEqual(state.external, []);
      await shot('saved-table');
      editor = await edit(page, workspace);
      await editor.locator('.knowledge-editor-additions').getByRole('button', { name: /^Paste Table$/i, exact: true }).click();
      dialog = page.getByRole('dialog', { name: 'PASTE TABLE', exact: true });
      await paste(dialog.getByLabel('Table data'), 'NAME,DETAIL\n"NEW","FIRST, LINE\nSECOND LINE"');
      await btn(dialog, 'USE TABLE').click();
      await editor.getByLabel('Block 3 title', { exact: true }).fill('IMPORTED TABLE');
      await expect(editor.getByLabel('Row 1, DETAIL', { exact: true })).toHaveValue('FIRST, LINE\nSECOND LINE');
      await shot('new-table'); await btn(editor, /^SAVE$/i).click(); await expect(editor).toHaveCount(0);
      const afterAdd = sharedLocations(page).snapshot().knowledgeRecords['country:Japan'];
      const blocks = afterAdd.sections.find(section => section.id === 'paste-fixture').blocks;
      assert.equal(blocks.length, 3); assert.equal(blocks[2].title, 'IMPORTED TABLE'); assert.deepEqual(blocks[1].rows, table.rows); assert.equal(blocks[0].text, 'KEEP SIBLING');
      editor = await edit(page, workspace);
      await expect(btn(editor, /^SAVE$/i)).toBeDisabled();
      await btn(editor.locator('.knowledge-sheet-toolbar'), 'PASTE TABLE').click();
      dialog = page.getByRole('dialog', { name: 'PASTE TABLE', exact: true }); await paste(dialog.getByLabel('Table data'), 'UNSAVED\tDRAFT'); await btn(dialog, 'CANCEL').click();
      await expect(btn(editor, /^SAVE$/i)).toBeDisabled();
      await btn(editor.locator('.knowledge-sheet-toolbar'), 'PASTE TABLE').click();
      state.preview = { role: 'trader', officeId: 'HONG KONG', officeName: 'HONG KONG', readOnly: true };
      await invalidateFixtureAuthority(page, { user: state.user, preview: state.preview });
      await expect(page.getByRole('dialog', { name: 'PASTE TABLE', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'PASTE TABLE', exact: true })).toHaveCount(0);
      state.user = null; state.preview = null; await invalidateFixtureAuthority(page, { user: state.user, preview: state.preview });
      await expect(page.getByRole('main', { name: 'ECOSYSTEM workspace' })).toHaveCount(0);
      assert.deepEqual(state.writes, []); assert.deepEqual(errors, []);
      results.push({ engine, width, theme, passed: true }); console.log(`PASS table paste ${engine} ${width} ${theme}`);
    } catch (error) { await shot('failure').catch(() => {}); throw error; }
    finally { await context.close(); await writeFile(`${out}/results.json`, JSON.stringify({ base, results }, null, 2)); }
  } } finally { await browser.close(); }
}
