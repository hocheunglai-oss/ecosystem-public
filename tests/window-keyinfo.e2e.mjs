import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const BASE = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4181';
const OUT = new URL('../artifacts/window-keyinfo/', import.meta.url);
const layouts = [{ width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 390, height: 844 }, { width: 320, height: 844 }]
  .filter(layout => !process.env.ECO_WINDOW_WIDTH || layout.width === Number(process.env.ECO_WINDOW_WIDTH));
const workspaces = [['Trading', 'Enquiries'], ['Trading', 'Fixtures'], ['Trading', 'Lost Records'], ['Buyers and Credit', 'Buyer Profiles'], ['Buyers and Credit', 'Credit Requests'], ['Ports & Suppliers', 'Countries & Ports'], ['Ports & Suppliers', 'Supplier Profiles']];
const labels = ['30 days quality claim period', 'ISO Specs', 'Sample Location', 'Debunkering'];
const values = ['45 DAYS AFTER DELIVERY\nSUBJECT TO SUPPLIER AGREEMENT', 'ISO 8217:2024; VLSFO AS AGREED', 'VESSEL MANIFOLD / DRIP SAMPLE', 'BY ARRANGEMENT WITH LOCAL AUTHORITY'];
const fields = ['qualityClaim', 'isoSpecs', 'sampleLocation', 'debunkering'];
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const saved = page => page.evaluate(() => JSON.parse(localStorage.getItem('ecosystem.demo.v1')));
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });

async function openWorkspace(page, group, name) {
  const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
  if (await button(nav, group).getAttribute('aria-expanded') !== 'true') await button(nav, group).click();
  await button(nav, name).click();
  const dialog = page.getByRole('dialog', { name, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function expanded(dialog, viewport) {
  await expect(dialog).toHaveAttribute('data-window-size', 'expanded');
  await expect(button(dialog, 'Shrink window')).toBeVisible();
  const box = await dialog.boundingBox();
  assert.ok(box.width >= viewport.width - 28 && box.height >= viewport.height - 28, `Enlarged dialog fills viewport: ${JSON.stringify(box)}`);
  assert.ok(box.x >= -1 && box.y >= -1 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1);
  return box;
}
async function toggle(dialog, viewport, draft) {
  const full = await expanded(dialog, viewport);
  await button(dialog, 'Shrink window').click();
  await expect(dialog).toHaveAttribute('data-window-size', 'compact');
  await expect(button(dialog, 'Expand window')).toBeVisible();
  const small = await dialog.boundingBox();
  assert.ok(small.width < full.width - 8 || small.height < full.height - 8, 'Shrink changes the actual window geometry');
  assert.ok(small.x >= 0 && small.y >= 0 && small.x + small.width <= viewport.width + 1 && small.y + small.height <= viewport.height + 1);
  if (draft) await draft();
  if (await dialog.locator('.modal-head').count() && await dialog.evaluate(element => element.scrollHeight > element.clientHeight + 1)) await fixedHeader(dialog, '.modal-head');
  await button(dialog, 'Expand window').click();
  const restored = await expanded(dialog, viewport);
  assert.ok(Math.abs(restored.width - full.width) < 2 && Math.abs(restored.height - full.height) < 2);
  if (draft) await draft();
}
async function fixedHeader(dialog, headerSelector, scrollSelector) {
  const header = dialog.locator(headerSelector).first();
  const before = await header.boundingBox();
  const scroll = scrollSelector ? dialog.locator(scrollSelector).first() : dialog;
  const amount = await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; return element.scrollTop; });
  assert.ok(amount > 0, `${scrollSelector} has bounded scrolling`);
  const after = await header.boundingBox();
  assert.ok(Math.abs(after.y - before.y) < 1, 'Window header stays fixed while contents scroll');
  await scroll.evaluate(element => { element.scrollTop = 0; });
}
async function boxed(control, container) {
  await expect(control).toBeVisible();
  const style = await control.evaluate(element => { const s = getComputedStyle(element); return { border: s.borderTopStyle, width: parseFloat(s.borderTopWidth), borderColor: s.borderTopColor, color: s.color, background: s.backgroundColor }; });
  assert.ok(style.border !== 'none' && style.width >= 1 && !/rgba\([^)]*,\s*0\)/.test(style.borderColor), `Update has a visible box: ${JSON.stringify(style)}`);
  const box = await control.boundingBox(), bounds = await container.boundingBox();
  assert.ok(box.width >= 48 && box.height >= 24, 'Update has a usable click target');
  assert.ok(box.x >= bounds.x - 1 && box.x + box.width <= bounds.x + bounds.width + 1, 'Update fits its profile');
  const colors = [style.color, style.background].map(value => value.match(/[\d.]+/g)?.slice(0, 3).map(Number));
  if (colors.every(Boolean) && !/rgba\([^)]*,\s*0\)/.test(style.background)) {
    const luminance = rgb => rgb.map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((total, value, index) => total + value * [.2126, .7152, .0722][index], 0);
    const [first, second] = colors.map(luminance).sort((a, b) => b - a);
    assert.ok((first + .05) / (second + .05) >= 4.5, `Update text contrast ${(first + .05) / (second + .05)}: ${JSON.stringify(style)}`);
  }
}
async function openSingapore(page) {
  const profile = await openWorkspace(page, 'Ports & Suppliers', 'Countries & Ports');
  await button(profile, 'Port Index').click();
  await profile.getByLabel('Country or port', { exact: true }).fill('Singapore');
  await button(profile.locator('.location-table'), 'Singapore').click();
  await expect(profile.getByRole('heading', { name: 'Singapore', exact: true })).toBeVisible();
  return profile;
}

try {
  for (const viewport of layouts) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce', hasTouch: viewport.width < 500 });
    await context.addInitScript(theme => localStorage.setItem('ecosystem.theme.v1', theme), viewport.width < 500 ? 'dark' : 'light');
    const blocked = [], errors = [];
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (!['GET', 'HEAD'].includes(request.method()) || /^\/api(?:\/|$)/.test(url.pathname)) { blocked.push({ method: request.method(), path: url.pathname }); return route.abort(); }
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    try {
      await page.goto(BASE);
      await page.getByLabel('Demo profile', { exact: true }).selectOption('otto');
      await button(page, 'ENTER ECOSYSTEM').click();
      await button(page, 'Personal details').click();
      if (viewport.width >= 1000) {
        const details = page.getByRole('dialog', { name: 'Personal details', exact: true });
        await details.getByRole('textbox', { name: 'Phone number', exact: true }).fill('+852 98765432');
        await toggle(details, viewport, () => expect(details.getByRole('textbox', { name: 'Phone number', exact: true })).toHaveValue('+852 98765432'));
        await button(details, 'Shrink window').click();
        await button(details, 'Close personal details').click();
        await button(page, 'Personal details').click();
        await expanded(details, viewport);
        await button(details, 'Close personal details').click();
      } else {
        const details = page.getByRole('region', { name: 'Personal details', exact: true });
        await expect(details).toBeVisible();
        await expect(button(details, 'Shrink window')).toHaveCount(0);
        await button(details, 'Close personal details').click();
      }
      for (const [group, name] of workspaces) {
        const workspace = await openWorkspace(page, group, name);
        let verifyDraft;
        if (name === 'Enquiries') {
          await workspace.getByRole('textbox', { name: 'Remarks', exact: true }).fill('UNSAVED WINDOW DRAFT');
          verifyDraft = () => expect(workspace.getByRole('textbox', { name: 'Remarks', exact: true })).toHaveValue('UNSAVED WINDOW DRAFT');
        }
        await toggle(workspace, viewport, verifyDraft);
        await button(workspace, 'Close workspace').click();
      }
      let profile = await openSingapore(page);
      const ranked = profile.locator('.knowledge-top-suppliers');
      const rows = ranked.locator('ol > li');
      await expect(rows).toHaveCount(10);
      const rankValues = await rows.locator('.knowledge-top-supplier-rank').allTextContents();
      assert.deepEqual(rankValues.map(value => Number(value.trim())), [1, 2, 3, 4, 5, 6, 7, 7, 9, 10]);
      const tiedName = (await rows.nth(7).locator('.knowledge-top-supplier-name strong').innerText()).trim();
      await profile.getByRole('textbox', { name: 'Search all tabs', exact: true }).fill(tiedName);
      await expect(profile.locator('.knowledge-top-suppliers ol > li')).toHaveCount(1);
      await expect(profile.locator('.knowledge-top-supplier-rank')).toHaveText('7');
      await profile.getByRole('textbox', { name: 'Search all tabs', exact: true }).fill('');
      assert.deepEqual((await rows.locator('.knowledge-top-supplier-rank').allTextContents()).map(value => Number(value.trim())), [1, 2, 3, 4, 5, 6, 7, 7, 9, 10]);
      await boxed(profile.locator('.knowledge-facts').getByRole('button', { name: 'Update', exact: true }), profile);
      await page.screenshot({ path: new URL(`profile-${viewport.width}.png`, OUT).pathname });

      await button(profile, 'Feedback for ecosystem').click();
      let modal = page.getByRole('dialog', { name: 'Feedback for ecosystem', exact: true });
      await modal.getByRole('textbox', { name: 'Title', exact: true }).fill('WINDOW TEST DRAFT');
      await modal.getByRole('textbox', { name: 'Details', exact: true }).fill('UNSAVED FEEDBACK MUST SURVIVE BOTH WINDOW SIZES.');
      await toggle(modal, viewport, async () => {
        await expect(modal.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('WINDOW TEST DRAFT');
        await expect(modal.getByRole('textbox', { name: 'Details', exact: true })).toHaveValue('UNSAVED FEEDBACK MUST SURVIVE BOTH WINDOW SIZES.');
      });
      await button(modal, 'Cancel').click();

      await profile.locator('.knowledge-facts').getByRole('button', { name: 'Update', exact: true }).click();
      modal = page.getByRole('dialog', { name: 'Update Key Info', exact: true });
      await expect(button(modal, 'Update')).toBeDisabled();
      for (let index = 0; index < labels.length; index++) {
        const field = modal.getByRole('textbox', { name: labels[index], exact: true });
        await expect(field).toHaveAttribute('maxlength', '1000');
        await field.fill(values[index]);
      }
      await toggle(modal, viewport, async () => { for (let index = 0; index < labels.length; index++) await expect(modal.getByRole('textbox', { name: labels[index], exact: true })).toHaveValue(values[index]); });
      await page.screenshot({ path: new URL(`key-info-${viewport.width}.png`, OUT).pathname });
      await button(modal, 'Update').click();
      await expect(modal).toHaveCount(0);
      let state = await saved(page), port = state.ports.find(port => port.id === 'port-singapore');
      fields.forEach((field, index) => { assert.equal(port.intelligenceKeyInfo[field], values[index]); assert.equal(port.intelligenceEntryUpdates[field].updatedBy, 'otto'); });
      const unchanged = structuredClone(port.intelligenceEntryUpdates);
      await profile.locator('.knowledge-facts').getByRole('button', { name: 'Update', exact: true }).click();
      modal = page.getByRole('dialog', { name: 'Update Key Info', exact: true });
      await expect(button(modal, 'Update')).toBeDisabled();
      await modal.getByRole('textbox', { name: 'Debunkering', exact: true }).fill('LOCAL APPROVAL REQUIRED; CONTACT AGENT');
      await button(modal, 'Update').click();
      state = await saved(page); port = state.ports.find(port => port.id === 'port-singapore');
      for (const field of fields.slice(0, 3)) assert.deepEqual(port.intelligenceEntryUpdates[field], unchanged[field], `${field} retains original attribution`);
      assert.equal(port.intelligenceKeyInfo.debunkering, 'LOCAL APPROVAL REQUIRED; CONTACT AGENT');
      await expect(profile.locator('.knowledge-facts .knowledge-entry-audit')).toHaveCount(4);

      await button(profile, 'Manage Tabs').click();
      modal = page.getByRole('dialog', { name: 'Manage Tabs', exact: true });
      await modal.getByLabel('Tab 1 name', { exact: true }).fill('UNSAVED OPERATIONS');
      for (let index = 0; index < 12; index++) await button(modal, 'Add Tab').click();
      await toggle(modal, viewport, () => expect(modal.getByLabel('Tab 1 name', { exact: true })).toHaveValue('UNSAVED OPERATIONS'));
      await fixedHeader(modal, '.modal-head', '.knowledge-manage-list');
      await button(modal, 'Cancel').click();
      await expect(profile.getByRole('tab', { name: 'Port Information', exact: true })).toBeVisible();

      await profile.getByRole('tab', { name: "Trader's Remarks", exact: true }).click();
      await profile.locator('.knowledge-header').getByRole('button', { name: /^Update(?:\s|$)/ }).click();
      modal = page.getByRole('dialog', { name: 'Update information', exact: true });
      await button(modal, 'Add Text').click();
      await modal.getByLabel(/^Block \d+ title$/).fill('WINDOW NOTE');
      await modal.getByLabel(/^Block \d+ text$/).fill('SHARED EDITOR DRAFT');
      await button(modal, 'Add Table').click();
      await modal.getByLabel(/^Block \d+ title$/).fill('WINDOW TABLE');
      await modal.getByLabel('Row 1, Name', { exact: true }).evaluate(element => {
        const data = new DataTransfer();
        data.setData('text/plain', Array.from({ length: 50 }, (_, index) => `Window ${index + 1}\tDetail ${index + 1}`).join('\n'));
        element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      });
      await toggle(modal, viewport, () => expect(modal.getByLabel('Row 1, Name', { exact: true })).toHaveValue('WINDOW 1'));
      await fixedHeader(modal, '.modal-head', '.knowledge-sheet .knowledge-table-wrap');
      await button(modal, 'Update').click();
      await expect(modal).toHaveCount(0);
      const block = profile.getByRole('article').filter({ has: page.getByRole('heading', { name: 'WINDOW NOTE', exact: true }) });
      await boxed(button(block, 'Update WINDOW NOTE'), profile);
      await expect(block.locator('.knowledge-entry-audit')).toContainText('SAMPLE TRADER');
      await page.reload();
      profile = await openSingapore(page);
      for (const text of [values[0], values[1], values[2], 'LOCAL APPROVAL REQUIRED; CONTACT AGENT']) await expect(profile.locator('.knowledge-facts')).toContainText(text);
      await profile.getByRole('tab', { name: "Trader's Remarks", exact: true }).click();
      await expect(profile.getByText('SHARED EDITOR DRAFT', { exact: true })).toBeVisible();
      await page.screenshot({ path: new URL(`saved-${viewport.width}.png`, OUT).pathname });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
      console.log(`PASS ${viewport.width}×${viewport.height}: seven enlarged workspaces, common-dialog toggles preserve drafts, sticky management header, fixed competition ranks under search, boxed Update buttons, free-text Key Info save/reload and unchanged-field audits`);
    } catch (error) {
      await page.screenshot({ path: new URL(`failure-${viewport.width}.png`, OUT).pathname }).catch(() => {});
      throw error;
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
