import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { installSharedLocations } from './fixtures/shared-locations.mjs';
import { installStagingCookies } from './fixtures/protection-cookies.mjs';

// Actual touch/keyboard interactions in disposable browser contexts. Every API
// response is synthetic, including authentication; no business data is changed.
const base = process.env.ECO_THEME_UI_ORIGIN || 'http://127.0.0.1:4286';
const out = resolve(process.env.ECO_THEME_UI_OUTPUT || `${tmpdir()}/eco-theme-touch`);
const reports = resolve(process.env.ECO_THEME_REPORT_OUTPUT || out);
await mkdir(out, { recursive: true });
await mkdir(reports, { recursive: true });
const results = [];
const member = {
  capabilities: { appearancePreview: false, testWorkspace: false },
  id: '10000000-0000-4000-8000-000000000001', email: 'Trader.Case@example.test',
  displayName: 'SAMPLE TRADER', phone: '+6591815902', officeId: 'HONG KONG',
  officeName: 'HONG KONG', isAdmin: true, isSpcTrader: true, isManager: false,
  isActive: true, activated: true, passwordChangeSuggested: false, revision: 1,
};
async function mocks(context) {
  const state = { signedIn: false, unexpected: [], writes: [] };
  await context.route('**/api/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') state.writes.push(path);
    if (path === '/api/access/session') return route.fulfill(state.signedIn ? { json: { user: member, preview: null } } : { status: 401, json: { message: 'Sign in required.' } });
    if (path === '/api/access/login') { state.signedIn = true; return route.fulfill({ json: { user: member, preview: null } }); }
    if (path === '/api/access/logout') { state.signedIn = false; return route.fulfill({ json: { user: null } }); }
    if (path === '/api/access/phone-requests') return route.fulfill({ json: { requests: [] } });
    if (path === '/api/access/users') return route.fulfill({ json: { users: [member], offices: [{ id: 'HONG KONG', name: 'HONG KONG' }] } });
    if (path === '/api/enquiries/test-policy') return route.fulfill({ json: { enabled: false, generation: '' } });
    if (path === '/api/enquiries/inbox') return route.fulfill({ json: { items: [], nextCursor: null, unreadCount: 0 } });
    if (path === '/api/enquiries/records') return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === '/api/intelligence/snapshot') return route.fulfill({ json: { available: false, snapshot: null } });
    if (path.startsWith('/api/admin/')) return route.fulfill({ json: { items: [], count: 0, nextCursor: null, periodStart: '2026-10-20T00:00:00Z', periodEnd: '2026-10-27T00:00:00Z', timeZone: 'Asia/Hong_Kong', source: 'shared-feedback' } });
    state.unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 503, json: { message: 'Unmatched synthetic test request.' } });
  });
  await installSharedLocations(context, { user: () => state.signedIn ? member : null });
  return state;
}
async function mode(page, theme) {
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect(page.locator('html')).toHaveAttribute('data-theme-requested', theme);
  await expect(page.locator('html')).toHaveAttribute('data-theme-pending', 'false');
  assert.equal(await page.evaluate(() => localStorage.getItem('ecosystem.theme.v1')), theme);
  await expect(page.locator('.home-display-controls .theme-toggle:not(.ecosystem-feedback)')).toHaveAttribute('aria-busy', 'false');
}
const homeToggle = page => page.locator('.home-display-controls .theme-toggle:not(.ecosystem-feedback)');
async function activate(locator, mobile) { if (mobile) await locator.tap(); else await locator.click(); }
async function screenshot(page, name) {
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal overflow');
}
async function reducedMotionReload(page, context, name) {
  const background = page.locator('.flowing-water-background');
  await expect(background).toHaveAttribute('data-renderer', 'video');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(background.locator('video')).toHaveCount(0);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let requests = 0;
  const pattern = '**/flowing-water-diffuse-mobile.mp4';
  const hold = async route => {
    requests++;
    await gate;
    await route.continue().catch(error => { if (!page.isClosed()) throw error; });
  };
  await context.route(pattern, hold);
  try {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(background.locator('video')).toHaveCount(1);
    await expect.poll(() => requests).toBeGreaterThan(0);
    assert.equal(await background.locator('video').evaluate(video => video.readyState), 0, 'Replacement media is genuinely undecoded behind the request gate');
    await expect(background).toHaveAttribute('data-renderer', 'fallback');
    await expect(background.locator('img')).toBeVisible();
    assert.equal(await background.locator('video').evaluate(video => getComputedStyle(video).opacity), '0', 'The old element\'s readiness must not reveal an unpainted replacement');
    await mode(page, 'dark');
    await screenshot(page, `${name}-replacement-poster-dark`);
    release();
    await expect(background).toHaveAttribute('data-renderer', 'video', { timeout: 20000 });
    assert.ok(await background.locator('video').evaluate(video => video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA));
    await expect(background.locator('img')).toBeHidden();
    await mode(page, 'dark');
  } finally {
    release();
    await context.unroute(pattern, hold);
  }
}
for (const engine of (process.env.ECO_THEME_BROWSER ? [process.env.ECO_THEME_BROWSER] : ['chromium', 'webkit'])) {
  const browser = await ({ chromium, webkit }[engine]).launch({ headless: true, ...(engine === 'chromium' && process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}) });
  try { for (const width of [1440, 320, 390]) {
    const mobile = width < 760;
    const context = await browser.newContext({ viewport: { width, height: mobile ? 844 : 960 }, hasTouch: mobile, isMobile: mobile, reducedMotion: 'no-preference' });
    await installStagingCookies(context, base);
    const state = await mocks(context), errors = [];
    await context.addInitScript(() => {
      // A delayed or discarded native snapshot must never delay a flowing-mode
      // theme choice. This reproduces the formerly deferred-commit failure path.
      window.__themeTouchProbe = { snapshots: 0, callbacks: [] };
      Object.defineProperty(document, 'startViewTransition', { configurable: true, value(callback) {
        window.__themeTouchProbe.snapshots++;
        window.__themeTouchProbe.callbacks.push(callback);
        const pending = new Promise(() => {});
        return { ready: pending, finished: pending, updateCallbackDone: pending, skipTransition() {} };
      } });
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
      await mode(page, 'light'); await screenshot(page, `${engine}-${width}-signed-out-light`);
      await activate(homeToggle(page), mobile); await mode(page, 'dark');
      await activate(page.getByLabel('Email', { exact: true }), mobile);
      await page.getByLabel('Email', { exact: true }).fill(member.email);
      await page.getByLabel('Password', { exact: true }).fill('Synthetic Password 8');
      await mode(page, 'dark'); await screenshot(page, `${engine}-${width}-signed-out-dark`);
      await activate(page.getByRole('button', { name: 'Sign in', exact: true }), mobile);
      await expect(page.locator('.world-launcher')).toBeVisible(); await mode(page, 'dark');
      await activate(page.getByRole('button', { name: 'Trading', exact: true }), mobile);
      await activate(page.getByRole('button', { name: 'Enquiries', exact: true }), mobile);
      const workspace = page.getByRole('dialog', { name: 'Enquiries', exact: true }); await expect(workspace).toBeVisible();
      await mode(page, 'dark');
      const dialogToggle = workspace.locator('.window-theme-toggle:not(.ecosystem-feedback)');
      await activate(dialogToggle, mobile); await mode(page, 'light');
      await activate(dialogToggle, mobile); await mode(page, 'dark');
      await activate(page.getByRole('button', { name: 'Close workspace', exact: true }), mobile);
      await mode(page, 'dark');
      await page.reload(); await expect(page.locator('.world-launcher')).toBeVisible(); await mode(page, 'dark');
      await activate(page.locator('.world-identity'), mobile); await mode(page, 'dark');
      await screenshot(page, `${engine}-${width}-signed-in-dark`);
      await activate(homeToggle(page), mobile); await mode(page, 'light');
      await screenshot(page, `${engine}-${width}-signed-in-light`);
      // Same-event reversals must be fully committed; a later native callback
      // cannot resurrect an older requested theme after an unrelated touch.
      const immediate = await homeToggle(page).evaluate(button => {
        button.click(); const first = { ...document.documentElement.dataset, stored: localStorage.getItem('ecosystem.theme.v1') };
        button.click(); button.click();
        return { first, last: { ...document.documentElement.dataset, stored: localStorage.getItem('ecosystem.theme.v1') } };
      });
      assert.equal(immediate.first.theme, 'dark'); assert.equal(immediate.first.stored, 'dark');
      assert.equal(immediate.last.theme, 'dark'); assert.equal(immediate.last.themePending, 'false');
      await mode(page, 'dark');
      await activate(page.getByRole('button', { name: 'Sign out', exact: true }), mobile);
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
      await page.reload(); await mode(page, 'dark');
      if (width === 390) await reducedMotionReload(page, context, `${engine}-${width}`);
      assert.equal(await page.evaluate(() => window.__themeTouchProbe.snapshots), 0, 'Flowing mode never captures stale animated media in a page transition');
      assert.deepEqual(state.unexpected, []); assert.deepEqual(errors, []);
      assert.deepEqual(state.writes, ['/api/access/login', '/api/access/logout']);
      results.push({ engine, width, passed: true, signedOut: true, signedIn: true, rapidReversal: true, delayedSnapshot: true, delayedMediaReload: width === 390, storageAcrossReloadAndSignOut: true });
      console.log(`PASS ${engine} ${width}: touch/navigation, immediate theme commit, reload/sign-out persistence`);
    } catch (error) {
      results.push({ engine, width, passed: false, error: error.message, unexpected: state.unexpected, errors });
      await page.screenshot({ path: `${out}/${engine}-${width}-failure.png`, fullPage: true }).catch(() => {});
      throw error;
    } finally {
      await writeFile(`${reports}/verification.json`, JSON.stringify({ base, results, screenshotDirectory: out, limits: 'Synthetic authentication in isolated Chromium/WebKit. This regression holds native snapshots deliberately; natural rendered-video checks are separate. Installed Safari and physical devices are not tested.' }, null, 2));
      await context.close();
    }
  } } finally { await browser.close(); }
}
