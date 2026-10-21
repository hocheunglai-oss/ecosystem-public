import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

// Disposable headless contexts only: never attach to a personal browser/profile.
const BASE = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4173';
const OUT = new URL('../artifacts/mobile-business/', import.meta.url);
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const results = [];
const groups = { Trading: ['Enquiries', 'Fixtures', 'Lost Records'], 'Ports & Suppliers': ['Countries & Ports', 'Supplier Profiles'], 'Buyers and Credit': ['Buyer Profiles', 'Credit Requests'] };
const links = Object.values(groups).flat();
async function openGroup(page, title) {
  const group = Object.keys(groups).find(name => groups[name].includes(title));
  const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
  const toggle = nav.getByRole('button', { name: group, exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  return nav;
}
const allowedMarineImages = new Set(['destination-oil-terminal-clean-v7.jpg', 'destination-oil-terminal-night-v2.jpg', 'cosulich-hill-sculpture-v1.jpg', 'cosulich-barge-v2.png', 'cosulich-lng-barge-v1.png']);
const model = page => page.evaluate(() => localStorage.getItem('ecosystem.demo.v1'));
const identity = page => page.evaluate(() => sessionStorage.getItem('ecosystem.session.v1'));
const dialog = (page, title) => page.getByRole('dialog', { name: title, exact: true });

async function context(options) {
  const ctx = await browser.newContext(options);
  await ctx.addInitScript(() => {
    window.__mobileViewTransitions = 0;
    const original = document.startViewTransition?.bind(document);
    if (original) document.startViewTransition = (...args) => {
      window.__mobileViewTransitions++;
      return original(...args);
    };
  });
  const page = await ctx.newPage();
  const errors = [];
  const images = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.resourceType() === 'image' && new URL(request.url()).pathname.startsWith('/marine/')) images.push(new URL(request.url()).pathname.split('/').at(-1));
  });
  return { ctx, page, errors, images };
}

async function login(page, actor = 'otto') {
  await page.getByLabel('Demo profile', { exact: true }).selectOption(actor);
  await page.getByRole('button', { name: 'ENTER ECOSYSTEM', exact: true }).click();
}

async function checkMobile(page) {
  await expect(page.locator('html')).toHaveAttribute('data-interface', 'mobile');
  await expect(page.locator('.mobile-harbour-background')).toBeVisible();
  const currentTheme = await page.locator('html').getAttribute('data-theme');
  await expect(page.locator('.mobile-harbour-background > svg [data-mobile-artwork]')).toHaveAttribute('data-mobile-artwork', currentTheme);
  await expect(page.locator('.marine-world, canvas, .fleet-berth, .voyage-status')).toHaveCount(0);
  const barge = page.locator('.mobile-harbour-background > svg [data-cosulich-barge]');
  await expect(barge).toHaveCount(2);
  const placements = () => barge.evaluateAll(nodes => nodes.map(node => ({
    vessel: node.dataset.cosulichBarge, transform: getComputedStyle(node).transform,
    box: node.getBoundingClientRect().toJSON(),
  })));
  const initialPlacements = await placements();
  await page.waitForTimeout(100);
  assert.deepEqual(await placements(), initialPlacements, 'Both mobile barges must remain stationary');
  await expect(page.locator('.hud-resource[data-resource="oil"]:visible, .hud-destination:visible, .desktop-reward-only:visible')).toHaveCount(0);
  const bounds = await page.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth }));
  assert.ok(bounds.page <= bounds.viewport + 1, `Page must not scroll horizontally: ${JSON.stringify(bounds)}`);
  const geometry = await page.locator('[data-mobile-flag-anchor]').evaluate(anchor => {
    const marker = anchor.getBoundingClientRect();
    const header = anchor.closest('.mobile-harbour-background').getBoundingClientRect();
    return { marker: marker.x + marker.width / 2, header: header.x + header.width / 2, headerBox: header.toJSON() };
  });
  assert.ok(Math.abs(geometry.marker - geometry.header) < 1, `Flag centre must match static background centre: ${JSON.stringify(geometry)}`);
  // A user-requested mode change may briefly fade the complete page. The scene
  // itself must remain still once that finite transition has finished.
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running' || animation.effect?.getComputedTiming().duration === 0));
  const animations = await page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running' && animation.effect?.getComputedTiming().duration > 0).map(animation => animation.animationName || animation.constructor.name));
  assert.deepEqual(animations, [], 'Mobile harbour must not run continuous scene animations');
}

async function checkWindow(page, title) {
  const pane = dialog(page, title);
  await expect(pane).toBeVisible();
  await expect(pane.getByRole('button', { name: 'Shrink window', exact: true })).toBeVisible();
  await expect(pane).toHaveAttribute('data-window-size', 'expanded');
  const bounds = await pane.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(Math.abs(bounds.x - 6) < 1 && Math.abs(bounds.y - 6) < 1 && Math.abs(bounds.width - viewport.width + 12) < 1 && Math.abs(bounds.height - viewport.height + 12) < 1, `${title} must use the enlarged mobile window: ${JSON.stringify(bounds)}`);
  const close = await pane.getByRole('button', { name: 'Close workspace', exact: true }).boundingBox();
  assert.ok(close.width >= 44 && close.height >= 44, 'Close target must be at least44px');
  assert.equal(await pane.locator('.window-content').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, `${title} must contain horizontal table scrolling`);
  await expect(pane.locator('.desktop-reward-only:visible, .resource-icon-oil:visible')).toHaveCount(0);
  return pane;
}

async function themeRoundtrip(page) {
  const before = await model(page);
  await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await checkMobile(page);
  await page.getByRole('button', { name: 'Light mode', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await checkMobile(page);
  assert.equal(await page.evaluate(() => window.__mobileViewTransitions), 2, 'Each mobile mode change should fade the complete page once');
  assert.equal(await model(page), before, 'Theme toggles must preserve business records');
}

async function scenario(name, run) {
  try { await run(); results.push({ name, status: 'passed' }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, status: 'failed', error: error.message }); throw error; }
}

try {
  await scenario('390px mobile entry, static harbour, business navigation and forms', async () => {
    const { ctx, page, errors, images } = await context({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      await page.goto(BASE);
      await checkMobile(page);
      await page.screenshot({ path: new URL('entry-light-390.png', OUT).pathname });
      assert.ok(!images.includes('destination-oil-terminal-night-v2.jpg'), 'Light mobile entry must not preload the night harbour');
      await login(page);
      const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
      for (const group of Object.keys(groups)) await expect(nav.getByRole('button', { name: group, exact: true })).toBeVisible();
      await page.screenshot({ path: new URL('home-light-390.png', OUT).pathname });
      for (const title of links) {
        await openGroup(page, title);
        await nav.getByRole('button', { name: title, exact: true }).click();
        const pane = await checkWindow(page, title);
        if (title === 'Enquiries') {
          const raw = pane.getByLabel('Raw enquiry', { exact: true });
          await raw.fill('Vessel: MOBILE VERIFICATION\nPort: Singapore\nHSFO: 300 MT');
          await expect(raw).toHaveValue(/MOBILE VERIFICATION/);
          assert.ok(await raw.evaluate(el => parseFloat(getComputedStyle(el).fontSize)) >= 16, 'Typing must avoid iOS automatic input zoom');
          await pane.getByLabel('Vessel', { exact: true }).fill('MOBILE VERIFICATION');
          await expect(pane.getByLabel('Vessel', { exact: true })).toHaveValue('MOBILE VERIFICATION');
          await page.screenshot({ path: new URL('enquiry-light-390.png', OUT).pathname });
        }
        await pane.getByRole('button', { name: 'Close workspace', exact: true }).click();
      }
      await openGroup(page, 'Enquiries');
      await nav.getByRole('button', { name: 'Enquiries', exact: true }).click();
      await expect(dialog(page, 'Enquiries').getByLabel('Raw enquiry', { exact: true })).toHaveValue(/MOBILE VERIFICATION/);
      await page.getByRole('button', { name: 'Close workspace', exact: true }).click();
      await page.getByRole('button', { name: 'Notifications', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Enquiries', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Notifications', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Settings', exact: true })).toHaveCount(0);
      await themeRoundtrip(page);
      await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
      await checkMobile(page);
      await page.screenshot({ path: new URL('home-dark-390.png', OUT).pathname });
      await openGroup(page, 'Enquiries');
      await nav.getByRole('button', { name: 'Enquiries', exact: true }).click();
      await checkWindow(page, 'Enquiries');
      await page.screenshot({ path: new URL('enquiry-dark-390.png', OUT).pathname });
      await page.getByRole('button', { name: 'Close workspace', exact: true }).click();
      await page.getByRole('button', { name: 'Personal details', exact: true }).click();
      await page.getByRole('region', { name: 'Personal details', exact: true }).getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(page.getByRole('button', { name: 'ENTER ECOSYSTEM', exact: true })).toBeVisible();
      await checkMobile(page);
      assert.ok(images.every(name => allowedMarineImages.has(name)), `Mobile must only download static harbour artwork: ${JSON.stringify(images)}`);
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });

  for (const viewport of [{ width: 320, height: 740 }, { width: 850, height: 900 }, { width: 1200, height: 500 }]) {
    await scenario(`${viewport.width}x${viewport.height} touch mobile layout in both modes`, async () => {
      const { ctx, page, errors, images } = await context({ viewport, hasTouch: true, isMobile: true });
      try {
        await page.goto(BASE);
        await login(page, 'gianmichele');
        await checkMobile(page);
        await themeRoundtrip(page);
        const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
        for (const title of links) {
          await openGroup(page, title);
          await expect(nav.getByRole('button', { name: title, exact: true })).toBeVisible();
        }
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await checkWindow(page, 'Settings');
        await page.getByRole('button', { name: 'Close workspace', exact: true }).click();
        await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
        await page.screenshot({ path: new URL(`home-${viewport.width}x${viewport.height}.png`, OUT).pathname });
        assert.ok(images.every(name => allowedMarineImages.has(name)), 'Only static harbour assets may load');
        assert.deepEqual(errors, []);
      } finally { await ctx.close(); }
    });
  }

  await scenario('Cold mobile mode changes retain the previous complete artwork until decoding finishes', async () => {
    for (const initial of ['light', 'dark']) {
      const { ctx, page, errors } = await context({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      try {
        await page.addInitScript(mode => localStorage.setItem('ecosystem.theme.v1', mode), initial);
        const target = initial === 'light' ? 'dark' : 'light';
        const slowAsset = target === 'dark' ? 'destination-oil-terminal-night-v2.jpg' : 'destination-oil-terminal-clean-v7.jpg';
        await page.route(`**/${slowAsset}`, async route => {
          await new Promise(resolve => setTimeout(resolve, 500));
          await route.continue();
        });
        await page.goto(BASE);
        await checkMobile(page);
        await page.getByRole('button', { name: target === 'dark' ? 'Dark mode' : 'Light mode', exact: true }).click();
        await expect(page.locator('html')).toHaveAttribute('data-theme-requested', target);
        await expect(page.locator('html')).toHaveAttribute('data-theme', initial);
        await expect(page.locator('.mobile-harbour-background > svg [data-mobile-artwork]')).toHaveAttribute('data-mobile-artwork', initial);
        await expect(page.locator('html')).toHaveAttribute('data-theme', target);
        await checkMobile(page);
        assert.equal(await page.evaluate(() => window.__mobileViewTransitions), 1);
        assert.deepEqual(errors, []);
      } finally { await ctx.close(); }
    }
  });

  await scenario('Desktop to mobile to desktop preserves session, profile and enquiry draft', async () => {
    const { ctx, page, errors } = await context({ viewport: { width: 1440, height: 960 } });
    try {
      await page.goto(BASE);
      await login(page);
      await expect(page.locator('.marine-world')).toBeVisible();
      await page.getByRole('button', { name: 'Personal details', exact: true }).click();
      const profile = page.getByRole('region', { name: 'Personal details', exact: true });
      await profile.getByLabel('Email', { exact: true }).fill('mobile-layout-test@example.test');
      await profile.getByRole('button', { name: 'Save', exact: true }).click();
      const stored = await model(page);
      const actor = await identity(page);
      const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
      await nav.getByRole('button', { name: 'Trading', exact: true }).click();
      await openGroup(page, 'Enquiries');
      await nav.getByRole('button', { name: 'Enquiries', exact: true }).click();
      await dialog(page, 'Enquiries').getByLabel('Raw enquiry', { exact: true }).fill('Draft survives resizing');
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator('.marine-world')).toHaveCount(0);
      await checkWindow(page, 'Enquiries');
      await expect(dialog(page, 'Enquiries').getByLabel('Raw enquiry', { exact: true })).toHaveValue('DRAFT SURVIVES RESIZING');
      await page.getByRole('button', { name: 'Close workspace', exact: true }).click();
      await checkMobile(page);
      assert.equal(await model(page), stored);
      assert.equal(await identity(page), actor);
      await page.setViewportSize({ width: 1440, height: 960 });
      await expect(page.locator('html')).toHaveAttribute('data-interface', 'desktop');
      await expect(page.locator('.marine-world')).toBeVisible();
      await expect(page.locator('.mobile-harbour-background')).toHaveCount(0);
      await expect(page.locator('[data-cosulich-barge]')).toHaveCount(2);
      await expect(page.locator('.fleet-berth, .voyage-status')).toHaveCount(0);
      assert.equal(await model(page), stored);
      assert.equal(await identity(page), actor);
      await page.getByRole('button', { name: 'Personal details', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Personal details', exact: true }).getByLabel('Email', { exact: true })).toHaveValue('mobile-layout-test@example.test');
      assert.deepEqual(errors, []);
    } finally { await ctx.close(); }
  });
} finally {
  await writeFile(new URL('results.json', OUT), JSON.stringify(results, null, 2));
  await browser.close();
}
