import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const BASE = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4197';
const output = new URL('../artifacts/contribution-harbour/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const results = [];
try {
  for (const [actor, theme, mobile] of [
    ['otto', 'light', false], ['gianmichele', 'dark', false],
    ['marco', 'light', false], ['elena', 'dark', false],
    ['otto', 'light', true], ['silvia', 'dark', true],
  ]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, reducedMotion: 'reduce', isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.addInitScript(({ actor, theme }) => {
      sessionStorage.setItem('ecosystem.session.v1', actor);
      localStorage.setItem('ecosystem.theme.v1', theme);
    }, { actor, theme });
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await expect(page.locator('[data-cosulich-barge]')).toHaveCount(2);
    await expect(page.locator('[data-cosulich-barge="cosulich"]')).toHaveCount(1);
    await expect(page.locator('[data-cosulich-barge="cosulich-lng"]')).toHaveCount(1);
    await expect(page.locator('.fleet-berths, .destination-tanker, .voyage-status, [data-resource="oil"], [data-resource="gold"], .resource-icon-gold, .hud-volume-row, .hud-transport-meter')).toHaveCount(0);
    const bargePositions = () => page.locator('[data-cosulich-barge] image').evaluateAll(images => images.map(image => ({ vessel: image.closest('[data-cosulich-barge]').dataset.cosulichBarge, box: image.getBoundingClientRect().toJSON() })));
    const before = await bargePositions();
    await page.waitForTimeout(300);
    assert.deepEqual(await bargePositions(), before, 'Both barges stay stationary');
    await page.screenshot({ path: new URL(`${actor}-${theme}-${mobile ? 'mobile' : 'desktop'}.png`, output).pathname });
    const trading = ['otto', 'gianmichele', 'silvia'].includes(actor);
    if (mobile) {
      await page.getByRole('button', { name: 'Personal details', exact: true }).click();
      await page.getByRole('button', { name: 'Contribution Activity', exact: true }).click();
    } else await page.locator('[data-resource="activity"]').click();
    await expect(page.locator('#hud-contribution-activity')).toBeVisible();
    await expect(page.locator('#hud-contribution-activity')).not.toContainText(/Gold|Oil|Transport|Reward|Redeem/i);
    await expect(page.locator('#hud-contribution-activity')).toContainText('Contributions');
    await expect(page.locator('#hud-contribution-activity')).toContainText('Hats received');
    await page.getByRole('button', { name: 'Close contribution activity' }).click();
    if (mobile) await expect(page.getByRole('button', { name: 'Personal details', exact: true })).toBeFocused();
    if (trading && !mobile) {
      await page.locator('.hud-achievements-toggle').click();
      await expect(page.locator('#hud-achievements')).toContainText('Contributions');
      await expect(page.locator('#hud-achievements')).toContainText('Hats received');
      await expect(page.locator('#hud-achievements')).not.toContainText(/Gold|Total volume|Transported|Remaining Oil|Aframax|Destination/i);
      await page.getByRole('button', { name: 'Close achievements' }).click();
    }
    if (actor === 'marco') {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await expect(page.locator('.workspace-window')).not.toContainText(/Annual rewards|Transported volume/);
      await expect(page.getByRole('button', { name: 'Rewards', exact: true })).toHaveCount(0);
    }
    if (actor !== 'marco') await expect(page.getByRole('button', { name: 'Reset demo', exact: true })).toHaveCount(0);
    assert.deepEqual(errors, []);
    results.push(`${actor}/${theme}/${mobile ? 'mobile' : 'desktop'} passed`);
    await context.close();
  }
  console.log(results.join('\n'));
} finally { await browser.close(); }
