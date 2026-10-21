import { installSharedLocations, sharedLocations } from './fixtures/shared-locations.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit, expect } from '@playwright/test';
import { installEmptyLiveInbox } from './fixtures/empty-live-inbox.mjs';
import { installProfileTabMocks } from './fixtures/profile-tabs.mjs';
import { installStagingCookies } from './fixtures/protection-cookies.mjs';

const base = process.env.ECO_EDITING_ORIGIN || 'http://127.0.0.1:4328';
const output = process.env.ECO_EDITING_OUTPUT || '/private/tmp/eco-editing-usability';
const user = { id: '10000000-0000-4000-8000-000000000001', email: 'editing@example.test', displayName: 'EDITING FIXTURE', phone: '', officeId: 'HONG KONG', officeName: 'HONG KONG', isAdmin: true, isSpcTrader: true, isManager: false, isActive: true, activated: true, passwordChangeSuggested: false, revision: 1 };
const record = { id: '90000000-0000-4000-8000-000000000001', legalName: 'EXAMPLE INTERNATIONAL MARINE ENERGY AND PETROLEUM MANAGEMENT SERVICES PTE. LTD.', shortName: 'EXAMPLE INTERNATIONAL MARINE ENERGY', countryCode: 'SG', countryName: 'Singapore', portName: 'Singapore', nameStatus: 'verified', info: { paymentTerms: '30', qualityClaimBar: '30', supplierTrader: '', availableGrade: 'VLSFO', foBdn: '', goBdn: '' }, contactCount: 0, bargeCount: 0 };
const link = 'https://Example.test/PortData?Key=AbC';
const btn = (scope, name) => scope.getByRole('button', { name, exact: true });
const results = [];
await mkdir(output, { recursive: true });
async function mock(context) {
  await context.route('**/api/**', route => route.fulfill({ status: 404, json: { message: 'Unconfigured test endpoint.' } }));
  await installEmptyLiveInbox(context);
  await installSharedLocations(context, { user: () => user });
  await installProfileTabMocks(context, { ownerId: () => user.id, preview: () => false });
  await context.route('**/api/access/session', route => route.fulfill({ json: { user, preview: null } }));
  await context.route('**/api/admin/**', route => route.fulfill({ json: { count: 0, items: [], hats: [], timeZone: 'Asia/Hong_Kong' } }));
  await context.route('**/api/suppliers/list*', route => route.fulfill({ json: { items: [record], total: 1, page: 1, pageSize: 50 } }));
  await context.route('**/api/intelligence/snapshot*', route => route.fulfill({ json: { suppliers: [], fixtureCounts: [] } }));
  await context.route('**/api/enquiries/test-policy', route => route.fulfill({ json: { enabled: false } }));
}
async function open(page, name) {
  const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
  const group = btn(nav, 'Ports & Suppliers');
  if (await group.getAttribute('aria-expanded') !== 'true') await group.click();
  await btn(nav, name).click();
  return page.getByRole('dialog', { name, exact: true });
}
for (const [engine, type] of [['chromium', chromium], ['webkit', webkit]]) {
  if (process.env.ECO_TEST_ENGINE && process.env.ECO_TEST_ENGINE !== engine) continue;
  const browser = await type.launch({ headless: true });
  try {
    for (const width of [1440, 320, 390]) for (const theme of ['light', 'dark']) {
      if (process.env.ECO_TEST_WIDTH && +process.env.ECO_TEST_WIDTH !== width || process.env.ECO_TEST_THEME && process.env.ECO_TEST_THEME !== theme) continue;
      const context = await browser.newContext({ viewport: { width, height: width < 760 ? 844 : 1000 }, isMobile: width < 760, hasTouch: width < 760, reducedMotion: 'reduce' });
      await installStagingCookies(context, base);
      await mock(context);
      await context.addInitScript(theme => localStorage.setItem('ecosystem.theme.v1', theme), theme);
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.setDefaultTimeout(15000);
      const shot = async name => {
        await page.screenshot({ path: `${output}/${engine}-${width}-${theme}-${name}.png`, fullPage: true });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: viewport overflow`);
      };
      try {
        await page.goto(base);
        await page.getByRole('main', { name: 'ECOSYSTEM workspace' }).waitFor();
        sharedLocations(page).seed((state, { link }) => {
          state.knowledgeRecords['country:Japan'] = { version: 7, layoutVersion: 2, sections: [{ id: 'links', title: 'LINK FIXTURE', blocks: [
            { id: 'prose', type: 'text', title: 'WEB REFERENCE', text: `READ (${link}).` },
            { id: 'table', type: 'table', title: 'WEB TABLE', columns: [{ id: 'url', name: 'SOURCE', width: 200 }], rows: [{ id: 'row', cells: [link] }] },
          ] }] };
        }, { link });
        await page.reload();
        const workspace = await open(page, 'Countries & Ports');
        await expect(workspace.locator('.knowledge-extractor')).toHaveCount(0);
        const controls = await workspace.locator('.location-toolbar-actions button').evaluateAll(buttons => buttons.map(button => {
          const bounds = button.getBoundingClientRect(), range = document.createRange();
          range.selectNodeContents(button);
          return { left: bounds.left, right: bounds.right, height: bounds.height, content: [...range.getClientRects()].map(rect => ({ left: rect.left, right: rect.right })) };
        }));
        assert.ok(controls.every(control => control.content.every(rect => rect.left >= control.left && rect.right <= control.right)), 'Toolbar labels and icons fit inside their controls');
        if (width < 760) assert.ok(controls.every(control => control.height >= 44), 'Phone toolbar controls remain touch-sized');
        await shot('locations');
        await btn(workspace, 'Add location').click();
        const form = page.getByRole('dialog', { name: 'Add location', exact: true });
        await form.getByLabel('Name', { exact: true }).fill('example new port');
        await expect(form.getByLabel('Name', { exact: true })).toHaveValue('EXAMPLE NEW PORT');
        await form.getByLabel('Country', { exact: true }).selectOption({ label: 'Japan' });
        const geometry = await form.locator('form').evaluate(el => ({ width: el.getBoundingClientRect().width, client: el.clientWidth, scroll: el.scrollWidth }));
        assert.ok(geometry.width <= 721 && geometry.scroll <= geometry.client + 1, 'Simple form has bounded width and no inner overflow');
        if (width < 760) {
          for (const field of await form.locator('input, select').all()) assert.ok((await field.boundingBox()).height >= 44, 'Phone inputs and native selects remain touch-sized');
        }
        await shot('add-location');
        await expect(form).toHaveAttribute('data-window-size', 'compact');
        await btn(form, 'Expand window').click();
        await expect(form.getByLabel('Name', { exact: true })).toHaveValue('EXAMPLE NEW PORT');
        await btn(form, 'Shrink window').click();
        await btn(form, 'Cancel').click();
        await btn(workspace, 'Information extractor').click();
        let extractor = page.getByRole('dialog', { name: 'Information extractor', exact: true });
        await expect(extractor).toBeVisible();
        await extractor.locator('textarea').first().fill(`check ${link}`);
        await expect(extractor.locator('textarea').first()).toHaveValue(`CHECK ${link}`);
        assert.equal(await extractor.locator('textarea').first().evaluate(el => getComputedStyle(el).textTransform), 'none');
        await shot('extractor');
        page.once('dialog', dialog => dialog.dismiss());
        await btn(extractor, 'Close dialog').click();
        await expect(extractor).toBeVisible();
        page.once('dialog', dialog => dialog.accept());
        await btn(extractor, 'Close dialog').click();
        await expect(extractor).toHaveCount(0);
        await btn(workspace, 'Country Index').click();
        await workspace.getByLabel('Country or port', { exact: true }).fill('Japan');
        await btn(workspace.locator('.location-table'), 'Japan').click();
        await workspace.getByRole('tab').filter({ hasText: 'LINK FIXTURE' }).click();
        const links = workspace.locator('.knowledge-content a[href="' + link + '"]');
        await expect(links).toHaveCount(2);
        for (const anchor of await links.all()) {
          await expect(anchor).toHaveText(link);
          assert.equal(await anchor.evaluate(el => getComputedStyle(el).textTransform), 'none');
          await expect(anchor).toHaveAttribute('rel', 'noopener noreferrer');
        }
        const prose = workspace.locator('.knowledge-block').filter({ has: page.getByRole('heading', { name: 'WEB REFERENCE', exact: true }) });
        await btn(workspace.locator('.knowledge-content-toolbar'), 'EDIT').click();
        const text = workspace.getByLabel('Block 1 text', { exact: true });
        await expect(text).toHaveValue(`READ (${link}).`);
        assert.equal(await text.evaluate(el => getComputedStyle(el).textTransform), 'none');
        await text.fill(`updated ${link}`);
        await expect(text).toHaveValue(`UPDATED ${link}`);
        await btn(workspace.locator('.knowledge-editor'), /^SAVE$/i).click();
        await expect(prose.locator('a')).toHaveAttribute('href', link);
        await shot('links');
        await btn(workspace, 'Close workspace').click();
        const suppliers = await open(page, 'Supplier Profiles');
        await expect(suppliers.locator('.shared-supplier-name')).toHaveCount(1);
        const bounds = await suppliers.locator('.shared-supplier-name').evaluate(button => {
          const label = button.querySelector('span'), arrow = button.querySelector('svg').getBoundingClientRect(), range = document.createRange();
          range.selectNodeContents(label);
          return { text: [...range.getClientRects()].map(rect => ({ left: rect.left, right: rect.right })), left: button.getBoundingClientRect().left, arrow: arrow.left, scroll: label.scrollWidth, client: label.clientWidth };
        });
        assert.ok(bounds.text.every(rect => rect.left >= bounds.left - 1 && rect.right <= bounds.arrow - 3), 'Every supplier text line fits before the arrow');
        assert.ok(bounds.scroll <= bounds.client + 1, 'Long legal name has no hidden inner overflow');
        await shot('supplier-names');
        await btn(suppliers, 'Add supplier').click();
        const supplierForm = page.getByRole('dialog', { name: 'Add supplier', exact: true });
        assert.ok(await supplierForm.locator('form').evaluate(el => el.getBoundingClientRect().width <= 721));
        await shot('add-supplier');
        assert.deepEqual(errors, []);
        results.push({ engine, width, theme, status: 'passed' });
        console.log(`PASS ${engine} ${width} ${theme}: editing, extraction, links and supplier names`);
      } catch (error) {
        await page.screenshot({ path: `${output}/${engine}-${width}-${theme}-FAILURE.png`, fullPage: true }).catch(() => {});
        throw error;
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
}
await writeFile(`${output}/results.json`, JSON.stringify({ base, results, limitation: 'Isolated synthetic API fixtures; native Safari and physical devices not tested.' }, null, 2));
