import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const BASE = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4193';
const OUT = new URL('../artifacts/credit-manual-records/', import.meta.url);
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const stateOf = page => page.evaluate(() => JSON.parse(localStorage.getItem('ecosystem.demo.v1')));
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const results = [];
async function workspace(page, name) {
  const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
  const category = nav.getByRole('button', { name: /^(Buyers and Credit|Credit)$/i });
  if (await category.getAttribute('aria-expanded') !== 'true') await category.click();
  await button(nav, name).click();
  return page.getByRole('dialog', { name, exact: true });
}
async function changeActor(page, id) {
  await page.evaluate(value => sessionStorage.setItem('ecosystem.session.v1', value), id);
  await page.reload();
}
async function profile(page, id) {
  const dialog = await workspace(page, 'Buyer Profiles');
  const state = await stateOf(page);
  const buyer = state.companies.find(item => item.id === id);
  const selector = dialog.getByRole('combobox', { name: 'Buyer', exact: true });
  if (await selector.count()) {
    await selector.fill(buyer.customerId);
    await dialog.getByRole('option').filter({ hasText: buyer.name }).click();
  } else {
    await dialog.getByRole('textbox', { name: 'Search buyer profiles' }).fill(buyer.customerId);
    await button(dialog, buyer.name).click();
  }
  return dialog;
}
try {
  for (const [width, theme] of [[1440, 'light'], [390, 'dark']].filter(([width]) => !process.env.WIDTH || width === Number(process.env.WIDTH))) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: width < 700, reducedMotion: 'reduce' });
    await context.addInitScript(theme => localStorage.setItem('ecosystem.theme.v1', theme), theme);
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    const errors = [], writes = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) { writes.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    try {
      await page.goto(BASE);
      await page.getByRole('combobox', { name: 'Demo profile', exact: true }).selectOption('otto');
      await button(page, 'ENTER ECOSYSTEM').click();
      await page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('ecosystem.demo.v1'));
        const now = new Date().toISOString();
        const document = 'TEST REQUEST SUPPORTING INFORMATION';
        state.requests.push({
          id: 'manual-records-p1', requestNumber: 'CR-DEMO-P1', companyId: 'company-meridian', type: 'increase', workflow: 'p1', amountBasis: 'total',
          amount: 2200000, terms: '30 DAYS', reason: 'P1 TOTAL LIMIT REVIEW', requestedBy: 'otto', requestedOffice: 'HKG', requestedAt: now, status: 'pending',
          voyage: { vessel: 'DEMO VOYAGE', imo: '9876543', portId: 'singapore', portName: 'SINGAPORE', eta: '2026-10-10' },
          attachments: [{ id: 'test-file', name: 'CREDIT-SUPPORT.TXT', mimeType: 'text/plain', size: document.length, dataUrl: 'data:text/plain;base64,' + btoa(document) }],
          recipients: [{ actorId: 'otto', name: 'SAMPLE TRADER', office: 'HKG', reasons: ['requester'] }, { actorId: 'elena', name: 'SAMPLE CREDIT REVIEWER', reasons: ['credit'] }],
        });
        state.creditNotifications = [
          { id: 'manual-otto', requestId: 'manual-records-p1', recipientId: 'otto', kind: 'acknowledged', createdAt: now },
          { id: 'manual-elena', requestId: 'manual-records-p1', recipientId: 'elena', kind: 'requested', createdAt: now },
        ];
        localStorage.setItem('ecosystem.demo.v1', JSON.stringify(state));
      });
      await page.reload();
      let dialog = await workspace(page, 'Credit Requests');
      await button(dialog, /^Needs attention/).click();
      await expect(dialog.locator('.credit-record-table tbody tr')).toHaveCount(1);
      await expect(dialog.locator('.credit-record-table tbody')).toContainText('Expected total limit');
      await expect(dialog.locator('.credit-workflow-label')).toHaveText('p1');
      await button(dialog, 'Request CR-DEMO-P1 details').click();
      const detail = dialog.locator('.credit-record-detail');
      await expect(detail).toContainText('DEMO VOYAGE');
      await expect(detail).toContainText('Notification recipients');
      await expect(detail).toContainText('SAMPLE TRADER');
      await expect(detail).toContainText('Read');
      let state = await stateOf(page);
      assert.ok(state.creditNotifications.find(item => item.id === 'manual-otto').readAt);
      assert.equal(state.creditNotifications.find(item => item.id === 'manual-elena').readAt, undefined);
      const downloadEvent = page.waitForEvent('download');
      await detail.getByRole('link', { name: 'CREDIT-SUPPORT.TXT' }).click();
      const download = await downloadEvent;
      assert.equal(download.suggestedFilename(), 'CREDIT-SUPPORT.TXT');
      assert.equal(await readFile(await download.path(), 'utf8'), 'TEST REQUEST SUPPORTING INFORMATION');
      await page.screenshot({ path: new URL(`request-${width}-${theme}.png`, OUT).pathname });
      await button(dialog, 'Request CR-DEMO-P1 details').click();
      await expect(dialog.locator('.credit-record-empty')).toContainText('No credit requests');
      await changeActor(page, 'elena');
      dialog = await profile(page, 'company-meridian');
      const remarks = dialog.getByRole('region', { name: 'Credit History', exact: true });
      const originalState = await stateOf(page);
      const originalBuyer = originalState.companies.find(item => item.id === 'company-meridian');
      for (const text of ['FIRST HISTORICAL CREDIT REMARK', 'SECOND ACTIVE CREDIT REMARK']) {
        await button(remarks, 'Edit').click();
        await remarks.getByRole('textbox', { name: 'Credit History' }).fill(text);
        await button(remarks, 'Save').click();
        await expect(remarks.locator('.buyer-profile__remark-text')).toHaveText(text);
      }
      await button(remarks, 'All history').click();
      await dialog.getByRole('combobox', { name: 'Credit history type' }).selectOption('remark');
      await expect(dialog.getByRole('combobox', { name: 'Credit history type' })).toHaveValue('remark');
      await expect(dialog.locator('.credit-record-table thead')).not.toContainText('Approved (USD)');
      const beforeRestore = await stateOf(page);
      const first = beforeRestore.creditHistory.find(item => item.summary === 'FIRST HISTORICAL CREDIT REMARK');
      const previousRow = dialog.locator('.credit-record-table tbody tr').filter({ hasText: 'FIRST HISTORICAL CREDIT REMARK' });
      await button(previousRow, 'Set as active remark').click();
      await expect(previousRow.locator('.credit-active-remark')).toHaveText('Active remark');
      state = await stateOf(page);
      assert.deepEqual(state.creditHistory, beforeRestore.creditHistory, 'Restoring an active remark leaves all historical entries unchanged');
      const buyer = state.companies.find(item => item.id === 'company-meridian');
      assert.equal(buyer.activeCreditRemarkId, first.id);
      assert.equal(buyer.creditRemarks, first.summary);
      assert.equal(buyer.limit, originalBuyer.limit);
      assert.equal(buyer.exposure, originalBuyer.exposure);
      await page.screenshot({ path: new URL(`remarks-${width}-${theme}.png`, OUT).pathname });
      await dialog.getByRole('tab', { name: 'Overview', exact: true }).click();
      await expect(dialog.locator('.buyer-profile__remark-text').first()).toHaveText('FIRST HISTORICAL CREDIT REMARK');
      await changeActor(page, 'otto');
      dialog = await profile(page, 'company-meridian');
      await button(dialog.getByRole('region', { name: 'Credit History', exact: true }), 'All history').click();
      await expect(dialog.getByRole('button', { name: 'Set as active remark', exact: true })).toHaveCount(0);
      await button(page, 'Close workspace').click();
      dialog = await profile(page, 'company-novasea');
      await expect(dialog.locator('.buyer-profile__title [data-status="Lead"]')).toHaveText('Lead');
      await expect(dialog.locator('.buyer-profile__title [data-status="Pending approval"]')).toHaveText('Pending approval');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No page overflow');
      assert.ok(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'Tables remain contained');
      assert.deepEqual(errors, []);
      assert.deepEqual(writes, [], 'Demo-only changes make no backend writes');
      results.push({ width, theme, passed: true });
      console.log(`PASS ${width}px ${theme}: request attention/read isolation, actual attachment download, active remark restore, lead lifecycle`);
    } catch (error) {
      await page.screenshot({ path: new URL(`failure-${width}-${theme}.png`, OUT).pathname });
      throw error;
    } finally { await context.close(); }
  }
} finally {
  await browser.close();
  await writeFile(new URL('results.json', OUT), JSON.stringify(results, null, 2));
}
