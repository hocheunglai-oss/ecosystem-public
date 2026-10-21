import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const base = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4197';
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
await mkdir('artifacts/hud-expansion', { recursive: true });
try {
  for (const [width, theme] of [[1440, 'light'], [1280, 'dark'], [390, 'light'], [320, 'light']]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: width < 700, reducedMotion: 'reduce' });
    await context.addInitScript(theme => localStorage.setItem('ecosystem.theme.v1', theme), theme);
    await context.route('**/*', route => route.request().method() !== 'GET' || new URL(route.request().url()).pathname.startsWith('/api/') ? route.abort() : route.continue());
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(10000);
    try {
      await page.goto(base);
      await page.getByLabel('Demo profile', { exact: true }).selectOption('otto');
      await button(page, 'ENTER ECOSYSTEM').click();
      const hud = page.getByRole('complementary', { name: 'Your dashboard', exact: true });
      await button(hud, 'Personal details').click();
      await expect(hud.getByRole('region', { name: 'Personal details', exact: true })).toBeVisible();
      await expect(page.getByRole('dialog', { name: 'Personal details', exact: true })).toHaveCount(0);
      await hud.getByLabel('Phone number').fill('+852 1234 5678');
      await page.keyboard.press('Escape');
      await expect(button(hud, 'Personal details')).toBeFocused();
      await expect(hud.locator('.account-inline-slot')).toBeEmpty();
      if (width > 700) {
        const activity = hud.getByRole('button', { name: /contributions in the last 28 days$/ });
        const contributionCount = await activity.textContent();
        await expect(hud.getByRole('button', { name: /Oil earned$/ })).toHaveCount(0);
        await activity.focus();
        await page.keyboard.press('Enter');
        await expect(hud.getByRole('region', { name: 'Contribution activity panel', exact: true })).toBeVisible();
        await expect(hud.getByRole('list', { name: 'Contribution history', exact: true })).toBeVisible();
        await expect(hud.locator('.resource-icon-oil, .resource-tabs')).toHaveCount(0);
        await page.keyboard.press('Escape');
        await expect(activity).toBeFocused();
        await expect(hud.locator('.account-inline-slot')).toBeEmpty();
        await activity.click();
        await expect(hud.getByRole('region', { name: 'Contribution activity panel', exact: true })).toBeVisible();
        await expect(page.getByRole('dialog', { name: 'Contribution Activity', exact: true })).toHaveCount(0);
        await page.screenshot({ path: `artifacts/hud-expansion/resources-${width}.png` });
        await hud.getByRole('button', { name: /Hats\. Hat ranking$/ }).click();
        await expect(hud.getByRole('region', { name: 'Hat ranking', exact: true })).toBeVisible();
        await expect(hud.getByRole('region', { name: 'Contribution activity panel', exact: true })).toHaveCount(0);
        await button(hud, 'Close Hat ranking').click();
        await hud.locator('.hud-achievements-toggle').click();
        await expect(hud.getByRole('region', { name: 'Achievements', exact: true })).toBeVisible();
        await expect(page.getByRole('dialog', { name: 'Achievements', exact: true })).toHaveCount(0);
        await expect(hud.locator('.economy-team-table')).toBeVisible();
        await expect(hud.locator('.economy-team-table thead')).toContainText('Contributions');
        await expect(hud.locator('.economy-team-table thead')).toContainText('Hats received');
        await expect(hud.locator('.tanker-achievements, .team-destination, .office-volume-track')).toHaveCount(0);
        await expect(hud.locator('#hud-achievements')).not.toContainText(/transported|total volume|Oil earned|remaining Oil/i);
        assert.equal(await activity.textContent(), contributionCount, 'Viewing achievements preserves contribution activity');
        await page.screenshot({ path: `artifacts/hud-expansion/achievements-${width}.png` });
        await hud.getByRole('tab', { name: 'Compare offices', exact: true }).click();
        await hud.locator('.office-comparison-list>button').first().click();
        assert.ok(await hud.locator('.hud-inline-scroll').evaluate(node => node.scrollWidth <= node.clientWidth + 1));
        await page.keyboard.press('Escape');
        await expect(hud.locator('.hud-achievements-toggle')).toBeFocused();
      } else {
        await button(hud, 'Personal details').click();
        await button(hud, 'Contribution Activity').click();
        await expect(hud.getByRole('region', { name: 'Contribution activity panel', exact: true })).toBeVisible();
        await expect(hud.getByLabel('Contribution period', { exact: true })).toHaveValue('28d');
        await page.keyboard.press('Escape');
        await expect(button(hud, 'Personal details')).toBeFocused();
        await expect(hud.locator('.account-inline-slot')).toBeEmpty();
      }
      // A scenario delivers a message but does not select it or mark it read.
      await button(hud, 'Notifications').click();
      await button(hud, 'WhatsApp (demo)').click();
      await page.screenshot({ path: `artifacts/hud-expansion/scenarios-${width}.png` });
      await button(hud, 'Normal enquiry').click();
      await expect(page.getByRole('dialog', { name: 'Enquiries', exact: true })).not.toBeVisible();
      await expect(page.getByRole('complementary', { name: 'New enquiry', exact: true })).toBeVisible();
      await expect(button(hud, 'Notifications')).toContainText('1');
      const afterFirst = await page.evaluate(() => JSON.parse(localStorage.getItem('ecosystem.inbox.v2')).items);
      assert.equal(afterFirst.length, 1);
      assert.equal(afterFirst[0].read, false);
      assert.equal(afterFirst[0].channel, 'whatsapp');
      await button(hud, 'Notifications').click();
      await button(hud, 'Email (demo)').click();
      await button(hud, 'Three grades · split suppliers').click();
      await expect(page.getByRole('dialog', { name: 'Enquiries', exact: true })).not.toBeVisible();
      await expect(button(hud, 'Notifications')).toContainText('2');
      const afterSecond = await page.evaluate(() => JSON.parse(localStorage.getItem('ecosystem.inbox.v2')).items);
      assert.equal(afterSecond.filter(item => !item.read).length, 2);
      assert.equal(afterSecond.find(item => item.channel === 'email').read, false);
      await page.screenshot({ path: `artifacts/hud-expansion/notification-${width}.png` });
      await page.getByRole('complementary', { name: 'New enquiry', exact: true }).locator('.inbox-banner-open').click();
      await expect(page.getByRole('dialog', { name: 'Enquiries', exact: true })).toBeVisible();
      const afterOpen = await page.evaluate(() => JSON.parse(localStorage.getItem('ecosystem.inbox.v2')).items);
      assert.equal(afterOpen.filter(item => !item.read).length, 1);
      await button(page.getByRole('dialog', { name: 'Enquiries', exact: true }), 'Close workspace').click();
      if (width > 700) {
        await button(hud, 'Settings').click();
        await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
      }
      assert.deepEqual(errors, []);
      console.log(`PASS ${width} ${theme}: dashboard expansion and notification-first demo enquiries`);
    } finally { await context.close(); }
  }
  for (const actor of ['marco', 'gianmichele']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.route('**/*', route => route.request().method() !== 'GET' || new URL(route.request().url()).pathname.startsWith('/api/') ? route.abort() : route.continue());
    try {
      const page = await context.newPage();
      await page.goto(base);
      await page.getByLabel('Demo profile', { exact: true }).selectOption(actor);
      await button(page, 'ENTER ECOSYSTEM').click();
      const hud = page.getByRole('complementary', { name: 'Your dashboard', exact: true });
      await hud.locator(actor === 'marco' ? '.hud-office-performance' : '.hud-achievements-toggle').click();
      await expect(hud.locator('#hud-achievements')).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await hud.getByRole('tab', { name: 'Compare offices', exact: true }).click();
      await hud.locator('.office-comparison-list>button').first().click();
      await expect(hud.locator('.economy-team-table')).toBeVisible();
      await button(hud, 'Settings').click();
      await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
      await expect(hud.locator('.account-inline-slot')).toBeEmpty();
      console.log(`PASS ${actor}: office performance expands and Settings stays a popup`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
