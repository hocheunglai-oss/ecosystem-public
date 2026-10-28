import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

// Local demo data in disposable headless contexts; never reuse a personal browser.
const BASE = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4173';
const OUT = new URL('../artifacts/mobile-account/', import.meta.url);
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const results = [];
const profileButton = page => page.getByRole('button', { name: 'Personal details', exact: true });
const inboxButton = page => page.getByRole('button', { name: 'Notifications', exact: true });
const profileRegion = page => page.getByRole('region', { name: 'Personal details', exact: true });
const inboxRegion = page => page.getByRole('region', { name: 'Enquiries', exact: true });
const saved = page => page.evaluate(() => JSON.parse(localStorage.getItem('ecosystem.demo.v1')));

async function setup(viewport, theme = 'light', touch = true) {
  const context = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch });
  await context.addInitScript(mode => localStorage.setItem('ecosystem.theme.v1', mode), theme);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(BASE);
  await page.getByLabel('Demo profile', { exact: true }).selectOption('otto');
  await page.getByRole('button', { name: 'ENTER ECOSYSTEM', exact: true }).click();
  return { context, page, errors };
}

async function inlinePanel(page, name) {
  const region = page.getByRole('region', { name, exact: true });
  await expect(region).toBeVisible();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  const geometry = await region.evaluate(element => {
    const hud = element.closest('.trader-hud');
    const header = hud?.querySelector('.hud-header');
    return { panel: element.getBoundingClientRect().toJSON(), hud: hud?.getBoundingClientRect().toJSON(), header: header?.getBoundingClientRect().toJSON(), position: getComputedStyle(element).position };
  });
  assert.ok(geometry.hud && geometry.header, 'Expanded account content must remain inside its original account box');
  assert.ok(!['absolute', 'fixed'].includes(geometry.position), 'Account details must expand in normal page flow');
  assert.ok(geometry.panel.y >= geometry.header.bottom - 1, 'Expanded content must sit below the account header');
  assert.ok(geometry.panel.width >= geometry.hud.width - 40, 'Expanded account content must span the account box');
  assert.ok(geometry.panel.x >= geometry.hud.x - 1 && geometry.panel.right <= geometry.hud.right + 1 && geometry.panel.bottom <= geometry.hud.bottom + 1, 'The account box must contain its expanded content');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'Inline account must not cause horizontal scrolling');
  return region;
}

async function scenario(name, run) {
  try { await run(); results.push({ name, status: 'passed' }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, status: 'failed', error: error.message }); throw error; }
}

try {
  for (const width of [320, 390, 850]) for (const theme of ['light', 'dark']) {
    await scenario(`${width}px ${theme} mobile profile and notifications expand inside the same account box`, async () => {
      const { context, page, errors } = await setup({ width, height: 900 }, theme);
      try {
        await expect(page.locator('html')).toHaveAttribute('data-interface', 'mobile');
        await expect(page.locator('[data-mobile-artwork]')).toHaveAttribute('data-mobile-artwork', theme);
        const gap = await page.evaluate(() => {
          const lighthouse = document.querySelector('[data-mobile-lighthouse-anchor]').getBoundingClientRect();
          const lettering = document.querySelector('.brand-tagline').getBoundingClientRect();
          const oldLighthouseTop = 134 * innerHeight / 941;
          return { actual: lighthouse.top - lettering.bottom, expected: (oldLighthouseTop - lettering.bottom) / 2 };
        });
        assert.ok(Math.abs(gap.actual - gap.expected) < 2, `Lighthouse/lettering gap should be halved: ${JSON.stringify(gap)}`);
        const before = await saved(page);
        await profileButton(page).press('Enter');
        let profile = await inlinePanel(page, 'Personal details');
        await expect(profileButton(page)).toHaveAttribute('aria-expanded', 'true');
        await expect(profile).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(profileRegion(page)).toHaveCount(0);
        await expect(profileButton(page)).toBeFocused();
        await profileButton(page).press('Enter');
        await inlinePanel(page, 'Personal details');
        await inboxButton(page).click();
        const inbox = await inlinePanel(page, 'Enquiries');
        await expect(profileRegion(page)).toHaveCount(0);
        await expect(profileButton(page)).toHaveAttribute('aria-expanded', 'false');
        await expect(inboxButton(page)).toHaveAttribute('aria-expanded', 'true');
        await inboxButton(page).click();
        await expect(inboxRegion(page)).toHaveCount(0);
        await expect(inboxButton(page)).toHaveAttribute('aria-expanded', 'false');
        await profileButton(page).click();
        profile = await inlinePanel(page, 'Personal details');
        await profileButton(page).click();
        await expect(profileRegion(page)).toHaveCount(0);
        assert.deepEqual(await saved(page), before, 'Opening or switching account panels must not alter business records');
        await profileButton(page).click();
        profile = await inlinePanel(page, 'Personal details');
        await profile.scrollIntoViewIfNeeded();
        await page.screenshot({ path: new URL(`profile-${width}-${theme}.png`, OUT).pathname });
        await inboxButton(page).click();
        await inlinePanel(page, 'Enquiries');
        await inbox.getByRole('button', { name: 'WhatsApp (demo)', exact: true }).click();
        await expect(inbox.locator('.inbox-item')).toHaveCount(1);
        await inbox.scrollIntoViewIfNeeded();
        await page.screenshot({ path: new URL(`notifications-${width}-${theme}.png`, OUT).pathname });
        await inbox.getByRole('button', { name: 'Clear all', exact: true }).click();
        await expect(inbox.locator('.inbox-item')).toHaveCount(0);
        await expect(inbox.getByRole('button', { name: 'Clear all', exact: true })).toBeDisabled();
        await page.keyboard.press('Escape');
        await expect(inboxRegion(page)).toHaveCount(0);
        await expect(inboxButton(page)).toBeFocused();
        assert.deepEqual(await saved(page), before, 'Notification UI actions must not alter enquiries, contributions or transport accounting');
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
  }

  await scenario('Mobile profile validation, saving, enquiry selection and sign-out still work', async () => {
    const { context, page, errors } = await setup({ width: 390, height: 844 });
    try {
      const before = await saved(page);
      await profileButton(page).click();
      let profile = await inlinePanel(page, 'Personal details');
      await profile.getByLabel('Email', { exact: true }).fill('not-an-email');
      await profile.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(profile).toBeVisible();
      assert.equal(await profile.getByLabel('Email', { exact: true }).evaluate(input => input.validity.valid), false);
      assert.deepEqual(await saved(page), before, 'An invalid profile must not be saved');
      await profile.getByLabel('Email', { exact: true }).fill('inline-mobile-test@example.test');
      await profile.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(profileRegion(page)).toHaveCount(0);
      await profileButton(page).click();
      profile = await inlinePanel(page, 'Personal details');
      await expect(profile.getByLabel('Email', { exact: true })).toHaveValue('inline-mobile-test@example.test');
      await profile.getByRole('button', { name: 'Close personal details', exact: true }).click();
      await expect(profileButton(page)).toBeFocused();
      await inboxButton(page).press('Enter');
      const inbox = await inlinePanel(page, 'Enquiries');
      await inbox.getByRole('button', { name: 'WhatsApp (demo)', exact: true }).click();
      await inbox.locator('.inbox-item').click();
      await expect(inboxRegion(page)).toHaveCount(0);
      const enquiry = page.getByRole('dialog', { name: 'Enquiries', exact: true });
      await expect(enquiry).toBeVisible();
      await expect(enquiry.getByLabel('Raw enquiry', { exact: true })).toHaveValue(/MERIDIAN DAWN/);
      await enquiry.getByRole('button', { name: 'Close workspace', exact: true }).click();
      await profileButton(page).click();
      await profileRegion(page).getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(page.getByRole('button', { name: 'ENTER ECOSYSTEM', exact: true })).toBeVisible();
      assert.equal(await page.evaluate(() => sessionStorage.getItem('ecosystem.session.v1')), null);
      assert.deepEqual((await saved(page)).economy, before.economy, 'Profile and notification changes must preserve resource accounting');
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  await scenario('Desktop panels stay unchanged and open profile drafts survive breakpoint changes', async () => {
    const { context, page, errors } = await setup({ width: 1440, height: 960 }, 'light', false);
    try {
      const before = await saved(page);
      await profileButton(page).click();
      let profile = page.getByRole('dialog', { name: 'Personal details', exact: true });
      await expect(profile).toBeVisible();
      await expect(page.locator('dialog[open]')).toHaveCount(1);
      await profile.getByLabel('Email', { exact: true }).fill('unsaved-inline-draft@example.test');
      await page.setViewportSize({ width: 390, height: 844 });
      profile = await inlinePanel(page, 'Personal details');
      await expect(profile.getByLabel('Email', { exact: true })).toHaveValue('unsaved-inline-draft@example.test');
      await profile.getByLabel('Email', { exact: true }).fill('unsaved-desktop-draft@example.test');
      await page.setViewportSize({ width: 1440, height: 960 });
      profile = page.getByRole('dialog', { name: 'Personal details', exact: true });
      await expect(profile).toBeVisible();
      await expect(profile.getByLabel('Email', { exact: true })).toHaveValue('unsaved-desktop-draft@example.test');
      await profile.getByRole('button', { name: 'Close personal details', exact: true }).click();
      await inboxButton(page).click();
      const inbox = inboxRegion(page);
      await expect(inbox).toBeVisible();
      assert.equal(await inbox.evaluate(element => getComputedStyle(element).position), 'absolute', 'Desktop inbox stays a dropdown');
      await page.keyboard.press('Escape');
      await expect(inbox).toHaveCount(0);
      assert.deepEqual(await saved(page), before, 'Unsaved profile drafts must not modify persisted records');
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
  await scenario('Delayed logo load recomputes the mobile lighthouse gap', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 900 }, hasTouch: true, isMobile: true });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await context.route('**/logo-transparent.png', async route => {
      await gate;
      await route.continue();
    });
    const page = await context.newPage();
    try {
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('[data-mobile-artwork]')).toHaveAttribute('data-mobile-artwork', 'light');
      const logo = page.locator('.ecosystem-logo svg image');
      await logo.evaluate(node => {
        node.dataset.testLoad = 'pending';
        node.addEventListener('load', () => { node.dataset.testLoad = 'loaded'; }, { once: true });
        node.addEventListener('error', () => { node.dataset.testLoad = 'error'; }, { once: true });
      });
      release();
      await expect(logo).toHaveAttribute('data-test-load', 'loaded');
      const gapError = () => page.evaluate(() => {
        const lettering = document.querySelector('.brand-tagline').getBoundingClientRect().bottom;
        const lighthouse = document.querySelector('[data-mobile-lighthouse-anchor]').getBoundingClientRect().top;
        return Math.abs((lighthouse - lettering) - (134 * innerHeight / 941 - lettering) / 2);
      });
      await expect.poll(gapError).toBeLessThan(2);
      await page.getByRole('button', { name: 'ENTER ECOSYSTEM', exact: true }).click();
      await expect.poll(gapError).toBeLessThan(2);
    } finally { release(); await context.close(); }
  });
} finally {
  await writeFile(new URL('results.json', OUT), JSON.stringify(results, null, 2));
  await browser.close();
}
