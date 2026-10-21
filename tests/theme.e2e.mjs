import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

// Disposable headless contexts only; theme choice is independent of demo data.
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const base = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4173';
const key = 'ecosystem.theme.v1';
async function login(page, actor = 'marco') {
  await page.getByLabel('Demo profile', { exact: true }).selectOption(actor);
  await page.getByRole('button', { name: 'ENTER ECOSYSTEM', exact: true }).click();
}
async function editor(page) {
  const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
  const toggle = nav.getByRole('button', { name: 'Trading', exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await nav.getByRole('button', { name: 'Enquiries', exact: true }).click();
  return page.getByRole('dialog', { name: 'Enquiries', exact: true });
}
const colours = element => {
  const style = getComputedStyle(element);
  return { colour: style.color, background: style.backgroundColor, image: style.backgroundImage, border: style.borderColor };
};
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await login(page);
  let window = await editor(page);
  const lightWindow = await window.evaluate(colours);
  const lightField = await window.getByLabel('Raw enquiry', { exact: true }).evaluate(colours);
  await page.getByRole('button', { name: 'Close workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  assert.equal(await page.evaluate(key => localStorage.getItem(key), key), 'dark');
  window = await editor(page);
  assert.notDeepEqual(await window.evaluate(colours), lightWindow);
  assert.notDeepEqual(await window.getByLabel('Raw enquiry', { exact: true }).evaluate(colours), lightField);
  await page.getByRole('button', { name: 'Close workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Reset demo', exact: true }).click();
  const reset = page.getByRole('dialog', { name: 'Reset demo', exact: true });
  await reset.locator('input[name="reset-scope"][value="all"]').check();
  await reset.getByRole('checkbox').check();
  await reset.getByRole('button', { name: 'Reset demo', exact: true }).click();
  await expect(reset).not.toBeVisible();
  assert.equal(await page.evaluate(key => localStorage.getItem(key), key), 'dark');
  await page.getByRole('button', { name: 'Personal details', exact: true }).click();
  await page.getByRole('dialog', { name: 'Personal details', exact: true }).getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Light mode', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Light mode', exact: true }).click();
  await login(page);
  window = await editor(page);
  assert.deepEqual(await window.evaluate(colours), lightWindow, 'Light windows must retain their original colours');
  assert.deepEqual(await window.getByLabel('Raw enquiry', { exact: true }).evaluate(colours), lightField, 'Light fields must retain their original colours');
  assert.deepEqual(errors, []);
  await context.close();
  console.log('PASS default Light, persisted mode, reset/sign-out isolation and exact Light colours after switching back');

  const mobile = await browser.newContext({ viewport: { width: 320, height: 844 }, reducedMotion: 'reduce' });
  const phone = await mobile.newPage();
  await phone.goto(base);
  await login(phone, 'gianmichele');
  const controls = await phone.locator('.home-display-controls').boundingBox();
  assert.ok(controls.x >= 0 && controls.x + controls.width <= 320);
  await phone.getByRole('button', { name: 'Dark mode', exact: true }).press('Enter');
  await expect(phone.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(phone.getByRole('button', { name: 'Light mode', exact: true })).toBeFocused();
  await phone.getByRole('button', { name: 'Light mode', exact: true }).press('Enter');
  await expect(phone.locator('html')).toHaveAttribute('data-theme', 'light');
  await mobile.close();
  console.log('PASS narrow mobile controls and keyboard toggle');
} finally {
  await browser.close();
}
