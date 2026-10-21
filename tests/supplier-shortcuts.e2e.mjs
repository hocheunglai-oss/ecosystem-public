import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const BASE = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4173';
const OUT = new URL('../artifacts/supplier-directory/', import.meta.url);
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const recents = page => page.evaluate(() => Object.fromEntries(['otto', 'elena'].map(actor => [actor, JSON.parse(localStorage.getItem(`ecosystem.suppliers.recent.${actor}`) || '[]')])));
async function enter(page, actor) {
  await page.goto(BASE);
  await page.getByLabel('Demo profile', { exact: true }).selectOption(actor);
  await button(page, 'ENTER ECOSYSTEM').click();
}
async function workspace(page, name) {
  const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
  const group = button(nav, 'Intelligence');
  if (await group.getAttribute('aria-expanded') !== 'true') await group.click();
  await button(nav, name).click();
  return page.getByRole('dialog', { name, exact: true });
}
async function directSupplier(page) {
  const ports = await workspace(page, 'Countries & Ports');
  await button(ports, 'Port Index').click();
  await ports.getByLabel('Country or port', { exact: true }).fill('Singapore');
  await button(ports.locator('.location-table'), 'Singapore').click();
  await ports.locator('.knowledge-top-suppliers ol > li').first().getByRole('button').click();
  const supplier = page.getByRole('dialog', { name: 'Supplier Profiles', exact: true });
  await expect(supplier.getByRole('heading', { name: 'NUNCHI', exact: true })).toBeVisible();
  return supplier;
}
try {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }].filter(v => !process.env.ECO_SUPPLIER_WIDTH || v.width === Number(process.env.ECO_SUPPLIER_WIDTH))) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    await context.addInitScript(mode => localStorage.setItem('ecosystem.theme.v1', mode), viewport.width === 390 ? 'dark' : 'light');
    const page = await context.newPage();
    const errors = [], writes = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.url()); });
    try {
      await enter(page, 'otto');
      let supplier = await directSupplier(page);
      await expect.poll(async () => (await recents(page)).otto).toEqual(['spc-nunchi']);
      assert.deepEqual((await recents(page)).elena, []);
      await page.screenshot({ path: new URL(`information-${viewport.width}.png`, OUT).pathname });
      const savedBefore = await page.evaluate(() => localStorage.getItem('ecosystem.demo.v1'));
      await button(supplier, 'Share a supplier case study').click();
      const form = page.getByRole('dialog', { name: 'Share a case study', exact: true });
      await expect(form).toBeVisible();
      await form.getByLabel('Title', { exact: true }).fill('UNSAVED SUPPLIER CASE');
      await form.getByLabel('Details', { exact: true }).fill('THIS UNSAVED CASE SHOULD NOT CHANGE THE SUPPLIER RECORD.');
      await button(form, 'Cancel').click();
      await expect(form).toHaveCount(0);
      await expect(supplier.getByRole('heading', { name: 'NUNCHI', exact: true })).toBeVisible();
      await expect(supplier.getByRole('tab', { name: 'Supplier Information', exact: true })).toHaveAttribute('aria-selected', 'true');
      assert.equal(await page.evaluate(() => localStorage.getItem('ecosystem.demo.v1')), savedBefore, 'Cancel leaves the persisted app state untouched');
      await button(supplier, 'Back to supplier results').click();
      await expect(button(supplier.getByRole('region', { name: 'Recently viewed', exact: true }), 'NUNCHI')).toBeVisible();
      await button(supplier, 'Close workspace').click();
      await button(page, 'Personal details').click();
      await button(page, 'Sign out').click();
      await enter(page, 'elena');
      supplier = await workspace(page, 'Supplier Profiles');
      await expect(supplier.getByRole('region', { name: 'Recently viewed', exact: true })).toHaveCount(0);
      await supplier.getByLabel('Search suppliers', { exact: true }).fill('Pacific');
      await supplier.getByRole('table', { name: 'Supplier results', exact: true }).getByRole('button').click();
      await expect.poll(async () => (await recents(page)).elena.length).toBe(1);
      const otherId = (await recents(page)).elena[0];
      assert.notEqual(otherId, 'spc-nunchi');
      await button(supplier, 'Close workspace').click();
      supplier = await directSupplier(page);
      await expect.poll(async () => (await recents(page)).elena).toEqual(['spc-nunchi', otherId]);
      assert.deepEqual((await recents(page)).otto, ['spc-nunchi'], 'Direct visits update only the signed-in actor’s recent suppliers');
      await button(supplier, 'Back to supplier results').click();
      await expect(supplier.getByRole('region', { name: 'Recently viewed', exact: true }).getByRole('button')).toHaveCount(2);
      await supplier.getByLabel('Supplier port', { exact: true }).selectOption('');
      await page.screenshot({ path: new URL(`directory-${viewport.width}.png`, OUT).pathname });
      assert.deepEqual(errors, []);
      assert.deepEqual(writes, []);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      console.log(`PASS ${viewport.width}px: supplier case study opens and cancels without changes, direct visits populate actor-scoped recents, account switching keeps histories separate`);
    } catch (error) {
      await page.screenshot({ path: new URL(`shortcuts-failure-${viewport.width}.png`, OUT).pathname }).catch(() => {});
      throw error;
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
