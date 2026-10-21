import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
// Historical demo-storage scenario. Authenticated feedback now uses the shared
// API; migrate those fixtures before running this complete legacy flow.
const base = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4173';
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
await mkdir('artifacts/feedback-pages', { recursive: true });
const saved = page => page.evaluate(() => JSON.parse(localStorage.getItem('ecosystem.demo.v1')));
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 1000, hasTouch: width < 1000 });
    try {
      // Verification writes only to this disposable context's local demo storage.
      await context.route('**/*', route => route.request().method() !== 'GET' || new URL(route.request().url()).pathname.startsWith('/api/') ? route.abort() : route.continue());
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base);
      await page.getByLabel('Demo profile', { exact: true }).selectOption('otto');
      await page.getByRole('button', { name: 'ENTER ECOSYSTEM', exact: true }).click();
      const before = await saved(page);
      const homeFeedback = page.locator('.home-display-controls').getByRole('button', { name: 'Feedback for ecosystem', exact: true });
      await homeFeedback.click();
      const modal = page.getByRole('dialog', { name: 'Feedback for ecosystem', exact: true });
      const selector = modal.getByRole('combobox', { name: 'Page (optional)', exact: true });
      await expect(modal.getByRole('textbox', { name: 'Source', exact: true })).toHaveCount(0);
      await expect(selector).toHaveValue('');
      assert.equal(await selector.getAttribute('required'), null);
      const options = await selector.locator('option').evaluateAll(nodes => nodes.map(node => ({ id: node.value, label: node.textContent })));
      assert.equal(options.filter(option => option.label.toUpperCase() === 'COUNTRIES & PORTS').length, 1);
      for (const id of ['home', 'enquiry', 'fixtures', 'lost', 'ports', 'suppliers', 'counterparties', 'credit-request', 'settings']) assert.ok(options.some(option => option.id === id));
      await selector.selectOption('suppliers');
      await modal.getByRole('textbox', { name: 'Title', exact: true }).fill('SUPPLIER FEEDBACK CHECK');
      await modal.getByRole('textbox', { name: 'Details', exact: true }).fill('KEEP THIS FEEDBACK WITH ITS SELECTED SUPPLIER PAGE AFTER RELOADING.');
      await expect(modal).toHaveAttribute('data-window-size', 'compact');
      await modal.getByRole('button', { name: 'Expand window', exact: true }).click();
      await expect(modal).toHaveAttribute('data-window-size', 'expanded');
      await expect(selector).toHaveValue('suppliers');
      await modal.getByRole('button', { name: 'Shrink window', exact: true }).click();
      await expect(modal).toHaveAttribute('data-window-size', 'compact');
      await expect(modal.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('SUPPLIER FEEDBACK CHECK');
      await page.screenshot({ path: `artifacts/feedback-pages/form-${width}.png` });
      await modal.getByRole('button', { name: 'Update', exact: true }).click();
      await expect(modal).toHaveCount(0);
      let state = await saved(page), record = state.contributions[0];
      assert.deepEqual(record.feedbackPage, { id: 'suppliers', label: 'Supplier Profiles' });
      assert.equal(record.source, undefined);
      assert.ok(!record.body.includes('SOURCE:'));
      assert.equal(state.contributions.length, before.contributions.length + 1);
      await page.reload();
      state = await saved(page);
      assert.equal(state.contributions[0].feedbackPage.id, 'suppliers');
      const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
      await nav.getByRole('button', { name: 'Trading', exact: true }).click();
      await nav.getByRole('button', { name: 'Enquiries', exact: true }).click();
      const workspace = page.getByRole('dialog', { name: 'Enquiries', exact: true });
      await workspace.locator('.window-foot').getByRole('button', { name: 'Feedback for ecosystem', exact: true }).click();
      await expect(selector).toHaveValue('');
      await selector.selectOption('enquiry');
      await selector.selectOption('');
      await modal.getByRole('textbox', { name: 'Title', exact: true }).fill('GENERAL FEEDBACK CHECK');
      await modal.getByRole('textbox', { name: 'Details', exact: true }).fill('THIS GENERAL FEEDBACK CAN BE SENT WITHOUT SELECTING A SPECIFIC PAGE.');
      await modal.getByRole('button', { name: 'Update', exact: true }).click();
      await expect(modal).toHaveCount(0);
      state = await saved(page);
      assert.equal(state.contributions[0].feedbackPage, undefined);
      assert.equal(state.contributions[1].feedbackPage.id, 'suppliers');
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}: optional page, no Source, clear selection, resize, submit and reload from home and workspace`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
