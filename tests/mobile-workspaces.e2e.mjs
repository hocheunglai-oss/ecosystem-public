import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

// Isolated headless browser only. Layout switches preserve business records and attribution.
const base = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4173';
const out = new URL('../artifacts/mobile-workspaces/', import.meta.url);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const snapshot = page => page.evaluate(() => JSON.parse(localStorage.getItem('ecosystem.demo.v1')));
const activity = (page, actorIds) => page.evaluate(async ids => {
  const { contributionActivity } = await import('/src/lib/contributionActivity.ts');
  return contributionActivity(JSON.parse(localStorage.getItem('ecosystem.demo.v1')), ids);
}, actorIds);
async function login(page, profile) {
  await page.goto(base);
  await page.getByLabel('Demo profile', { exact: true }).selectOption(profile);
  await page.getByRole('button', { name: 'ENTER ECOSYSTEM', exact: true }).click();
}
async function settings(page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  return page.getByRole('dialog', { name: 'Settings', exact: true });
}
async function retiredControlsAbsent(scope) {
  await expect(scope.getByRole('button', { name: 'Rewards', exact: true })).toHaveCount(0);
  await expect(scope.getByRole('region', { name: 'Annual rewards', exact: true })).toHaveCount(0);
  await expect(scope.getByRole('button', { name: /Gold earned$/ })).toHaveCount(0);
  await expect(scope.getByRole('button', { name: /Suggest an update|Submit for review/ })).toHaveCount(0);
}
async function updatePort(page, text) {
  const navigation = page.getByRole('navigation', { name: 'Workspace navigation' });
  const portLink = navigation.getByRole('button', { name: 'Countries & Ports', exact: true });
  if (!(await portLink.isVisible())) await navigation.getByRole('button', { name: 'Ports & Suppliers', exact: true }).click();
  await portLink.click();
  const ports = page.getByRole('dialog', { name: 'Countries & Ports', exact: true });
  await retiredControlsAbsent(ports);
  await ports.getByRole('button', { name: 'Port Index', exact: true }).click();
  await ports.getByLabel('Country or port', { exact: true }).fill('Hong Kong');
  await ports.getByRole('button', { name: 'Hong Kong', exact: true }).click();
  await ports.getByRole('tab', { name: 'Suppliers', exact: true }).click();
  await ports.locator('.knowledge-header').getByRole('button', { name: /^Update(?:\s|$)/ }).click();
  const editor = page.getByRole('dialog', { name: 'Update information', exact: true });
  await retiredControlsAbsent(editor);
  await editor.getByRole('button', { name: 'Add Text', exact: true }).click();
  await editor.locator('.knowledge-block-title').fill('MOBILE DELIVERY UPDATE');
  await editor.locator('.knowledge-text-canvas').fill(text);
  await expect(editor.getByRole('button', { name: 'Update', exact: true })).toBeEnabled();
  assert.equal(await editor.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, 'Mobile editor fits its workspace');
  await page.screenshot({ path: new URL('mobile-contribution.png', out).pathname });
  await editor.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(ports.getByText(text, { exact: true })).toBeVisible();
  await ports.getByRole('button', { name: 'Close workspace', exact: true }).click();
}

try {
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
  try {
    const page = await desktop.newPage();
    await login(page, 'marco');
    let panel = await settings(page);
    await retiredControlsAbsent(panel);
    const original = await snapshot(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('html')).toHaveAttribute('data-interface', 'mobile');
    await expect(panel.getByRole('button', { name: 'Management', exact: true })).toHaveClass('active');
    await retiredControlsAbsent(panel);
    assert.deepEqual(await snapshot(page), original, 'Changing interface must preserve every stored record');
    await expect(panel.getByRole('button', { name: 'Reset demo', exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'Close workspace', exact: true }).click();

    const before = await activity(page, 'marco');
    await updatePort(page, 'MOBILE ADMIN UPDATE: AGENT CONFIRMED THE RECEIVING WINDOW.');
    const saved = await snapshot(page), after = await activity(page, 'marco');
    assert.equal(saved.contributions[0].status, 'approved');
    assert.equal(saved.contributions[0].publication, 'direct');
    assert.equal(saved.contributions[0].author, 'marco');
    assert.equal(after.total, before.total + 1, 'Publishing business information adds one contribution immediately');
    assert.deepEqual(saved.economy, original.economy, 'Publication does not grant rewards');
    assert.deepEqual(saved.hats, original.hats, 'Publishing does not award Hats');
    panel = await settings(page);
    await panel.getByRole('button', { name: 'Audit trail', exact: true }).click();
    await expect(panel.getByRole('table')).toContainText('contribution recorded');
    assert.doesNotMatch(saved.audit[0].detail, /Gold|reward|awarded/i);
    await page.screenshot({ path: new URL('mobile-audit-preserved.png', out).pathname });
    await page.setViewportSize({ width: 1440, height: 960 });
    await expect(panel.getByRole('button', { name: 'Audit trail', exact: true })).toHaveClass('active');
    await retiredControlsAbsent(panel);
    assert.deepEqual(await snapshot(page), saved, 'Returning to desktop preserves the published update and audit');
    console.log('PASS desktop/mobile Settings, immediate business publication, contribution activity and intact audit');
  } finally { await desktop.close(); }

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  try {
    const manager = await mobile.newPage();
    await login(manager, 'gianmichele');
    let performance = await settings(manager);
    await expect(performance.getByRole('region', { name: 'Team performance', exact: true })).toBeVisible();
    await expect(performance.getByRole('columnheader', { name: 'Contributions', exact: true })).toBeVisible();
    await expect(performance.getByRole('columnheader', { name: 'Hats received', exact: true })).toBeVisible();
    await expect(performance.getByRole('columnheader', { name: 'Total volume (MT)', exact: true })).toHaveCount(0);
    await expect(performance.locator('[data-team-member]')).toHaveCount(2);
    await retiredControlsAbsent(performance);
    const before = await activity(manager, ['gianmichele', 'otto']);
    await expect(performance.locator('[data-office-summary] [data-activity-total]')).toHaveText(String(before.total));
    await expect(performance.getByLabel('Contribution period', { exact: true })).toHaveValue('28d');
    await performance.getByLabel('Contribution period', { exact: true }).selectOption('7d');
    await expect(performance.getByRole('heading', { name: 'Daily activity', exact: true })).toBeVisible();
    await performance.getByRole('button', { name: 'Close workspace', exact: true }).click();
    await updatePort(manager, 'MOBILE MANAGER UPDATE: CONFIRM THE AGENT BEFORE NOMINATION.');
    const saved = await snapshot(manager);
    assert.equal(saved.contributions[0].author, 'gianmichele');
    assert.equal(saved.contributions[0].publication, 'direct');
    assert.equal((await activity(manager, ['gianmichele', 'otto'])).total, before.total + 1);
    performance = await settings(manager);
    await expect(performance.locator('[data-office-summary] [data-activity-total]')).toHaveText(String(before.total + 1));
    const ownRow = performance.locator('[data-team-member="gianmichele"]');
    await expect(ownRow.getByRole('cell').first()).toHaveText('1');
    assert.equal(await manager.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'Mobile workspace fits the viewport');
    await manager.screenshot({ path: new URL('mobile-team-activity.png', out).pathname });
    console.log('PASS manager office/member activity, period selection, Hats and direct port update controls');
  } finally { await mobile.close(); }
} finally { await browser.close(); }
