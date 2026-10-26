import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { installStagingCookies } from './fixtures/protection-cookies.mjs';
import { installSharedLocations } from './fixtures/shared-locations.mjs';

// Disposable browsers and synthetic authenticated API responses only. All API
// requests are intercepted, including login/logout; no production identity or
// business data is read or changed. Images stay outside the source checkout.
const base = process.env.ECO_FLOWING_UI_ORIGIN || 'http://127.0.0.1:4286';
const out = resolve(process.env.ECO_FLOWING_UI_OUTPUT || `${tmpdir()}/eco-flowing-water-ui`);
const reports = resolve(process.env.ECO_FLOWING_REPORT_OUTPUT || out);
await mkdir(out, { recursive: true });
await mkdir(reports, { recursive: true });
const results = [];
const originalLogoHash = 'e6fe5111eddff7bd167e8c7d734660d126eaeab9fc63496c7b882ab6af05da88';
const member = {
  capabilities: { appearancePreview: false, testWorkspace: false },
  id: '10000000-0000-4000-8000-000000000001', email: 'Trader.Case@example.test',
  displayName: 'SAMPLE TRADER', phone: '+6591815902', officeId: 'HONG KONG',
  officeName: 'HONG KONG', isAdmin: true, isSpcTrader: true, isManager: false,
  isActive: true, activated: true, passwordChangeSuggested: false, revision: 1,
};
const groups = {
  Trading: ['Enquiries', 'Fixtures', 'Lost Records'],
  'Ports & Suppliers': ['Countries & Ports', 'Supplier Profiles'],
  'Buyers and Credit': ['Buyer Profiles', 'Credit Requests'],
};
async function mocks(context) {
  const state = { signedIn: false, rejectLogin: true, user: { ...member }, writes: [], unexpected: [], harbour: [] };
  await context.route('**/marine/**', route => {
    const path = new URL(route.request().url()).pathname;
    // Vite may import source helpers under /src/marine; only retired public
    // artwork is unavailable in this regression case.
    if (!path.startsWith('/marine/')) return route.fallback();
    state.harbour.push(path);
    return route.abort('failed');
  });
  await context.route('**/api/**', route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) state.writes.push(path);
    if (path === '/api/access/session') return route.fulfill(state.signedIn
      ? { json: { user: state.user, preview: null } }
      : { status: 401, json: { message: 'Sign in required.' } });
    if (path === '/api/access/login') {
      assert.deepEqual(request.postDataJSON(), { email: member.email, password: 'Synthetic Password 8' });
      if (state.rejectLogin) { state.rejectLogin = false; return route.fulfill({ status: 401, json: { message: 'Synthetic sign-in rejected.' } }); }
      state.signedIn = true;
      return route.fulfill({ json: { user: state.user, preview: null } });
    }
    if (path === '/api/access/activate') {
      const input = request.postDataJSON();
      assert.ok(['invite', 'recovery'].includes(input.type));
      assert.deepEqual(input, { tokenHash: `synthetic-${input.type}`, type: input.type, password: 'Synthetic Password 8' });
      state.signedIn = true; return route.fulfill({ json: { user: state.user, preview: null } });
    }
    if (path === '/api/access/logout') { state.signedIn = false; return route.fulfill({ json: { user: null } }); }
    if (path === '/api/access/phone-requests') return route.fulfill({ json: { requests: [] } });
    if (path === '/api/access/users') return route.fulfill({ json: { users: [state.user], offices: [{ id: 'HONG KONG', name: 'HONG KONG' }] } });
    if (path === '/api/enquiries/test-policy') return route.fulfill({ json: { enabled: false, generation: '' } });
    if (path === '/api/enquiries/inbox') return route.fulfill({ json: { items: [], nextCursor: null, unreadCount: 0 } });
    if (path === '/api/enquiries/records' && request.method() === 'GET') return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === '/api/attachments/list' && request.method() === 'GET') return route.fulfill({ json: { items: [], folders: [], retainedIds: [], targetKeys: [] } });
    if (path === '/api/intelligence/snapshot') return route.fulfill({ json: { available: false, snapshot: null } });
    if (path.startsWith('/api/admin/')) return route.fulfill({ json: { items: [], count: 0, nextCursor: null, periodStart: '2026-10-20T00:00:00Z', periodEnd: '2026-10-27T00:00:00Z', timeZone: 'Asia/Hong_Kong', source: 'shared-feedback' } });
    if (path.startsWith('/api/suppliers/')) return route.fulfill({ json: { items: [], page: 1, pageSize: 100, total: 0 } });
    if (path === '/api/profile-tabs/list') return route.fulfill({ json: { target: { kind: url.searchParams.get('kind'), id: url.searchParams.get('id') }, shared: { revision: 0, tabs: [] }, private: { revision: 0, tabs: [] } } });
    state.unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 503, json: { message: 'Unmatched synthetic test request.' } });
  });
  const locations = await installSharedLocations(context, { user: () => state.signedIn ? state.user : null });
  return { state, locations };
}
const animationState = background => background.evaluate(node => node.getAnimations({ subtree: true }).map(animation => ({
  name: animation.animationName, state: animation.playState, time: animation.currentTime,
  duration: animation.effect?.getComputedTiming().duration,
})));
async function noOverflow(page, name) {
  const bounds = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
  assert.ok(bounds.document <= bounds.viewport + 1, `${name}: horizontal overflow ${JSON.stringify(bounds)}`);
}
async function homepageGeometry(page, width) {
  const buttons = page.locator('.world-launcher button.launcher-toggle');
  await expect(buttons).toHaveCount(3);
  const geometry = await buttons.evaluateAll(nodes => nodes.map(node => {
    const style = getComputedStyle(node), r = node.getBoundingClientRect();
    return { text: node.textContent.trim(), x: r.x, y: r.y, width: r.width, height: r.height,
      fontSize: parseFloat(style.fontSize), textTransform: style.textTransform,
      radius: parseFloat(style.borderRadius) };
  }));
  for (const button of geometry) {
    assert.ok(button.fontSize >= 16, `${button.text}: homepage entry text must be at least 16px`);
    assert.ok(button.height >= 44 && button.width >= 44, `${button.text}: minimum target size`);
    assert.equal(button.textTransform, 'uppercase');
    assert.ok(button.radius >= button.height / 2, `${button.text}: approved pill action`);
    assert.ok(button.x >= 0 && button.x + button.width <= width + 1, `${button.text}: clipped entry action`);
  }
  if (width >= 760) {
    assert.ok(Math.max(...geometry.map(b => b.y)) - Math.min(...geometry.map(b => b.y)) < 2, 'Desktop launchers form one row');
    assert.ok(geometry.every((b, i) => i === 0 || b.x >= geometry[i - 1].x + geometry[i - 1].width), 'Desktop launchers do not overlap');
  } else {
    assert.ok(geometry.every((b, i) => i === 0 || b.y >= geometry[i - 1].y + geometry[i - 1].height), 'Phone launchers stack without overlap');
  }
  const logo = await page.locator('.world-identity .ecosystem-logo').boundingBox();
  assert.ok(Math.abs(logo.x + logo.width / 2 - width / 2) < 3, 'Homepage logo is centered');
  return geometry;
}

for (const [engine, kind] of [['chromium', chromium], ['webkit', webkit]]) {
  if (process.env.ECO_TEST_ENGINE && process.env.ECO_TEST_ENGINE !== engine) continue;
  const executablePath = process.env[engine === 'chromium' ? 'ECO_CHROMIUM_EXECUTABLE' : 'ECO_WEBKIT_EXECUTABLE'];
  const browser = await kind.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  try { for (const width of [1440, 1024, 320, 390]) for (const theme of ['light', 'dark']) {
    if (process.env.ECO_TEST_WIDTH && +process.env.ECO_TEST_WIDTH !== width || process.env.ECO_TEST_THEME && process.env.ECO_TEST_THEME !== theme) continue;
    const context = await browser.newContext({ viewport: { width, height: width < 760 ? 844 : 900 }, isMobile: width < 760, hasTouch: width < 760, reducedMotion: 'no-preference', colorScheme: theme });
    await installStagingCookies(context, base);
    const { state, locations } = await mocks(context);
    await context.addInitScript(value => {
      if (location.protocol === 'http:' || location.protocol === 'https:') localStorage.setItem('ecosystem.theme.v1', value);
    }, theme);
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
    const shot = async name => { await noOverflow(page, name); await page.screenshot({ path: `${out}/${engine}-${width}-${theme}-${name}.png`, fullPage: true }); };
    const background = page.locator('.flowing-water-background');
    const toggle = () => page.locator('.home-display-controls').getByRole('button', { name: /^(Dark|Light) mode$/ });
    try {
      await page.goto(base);
      await expect(page.locator('.immersive-app')).toHaveAttribute('data-design', 'flowing-water', { timeout: 20000 });
      await expect(page.locator('.access-login')).toBeVisible();
      assert.deepEqual(await page.locator('.access-login label').evaluateAll(nodes => nodes.map(node => node.textContent.trim())), ['Email', 'Password'], 'Sign-in retains only existing form labels');
      await expect(page.locator('.marine-world, .mobile-harbour-background')).toHaveCount(0);
      await expect(background).toBeVisible();
      await expect(page.locator('.world-launcher')).toHaveCount(0);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const logo = page.locator('.ecosystem-logo img');
      await expect(logo).toHaveAttribute('src', '/logo-transparent.png');
      await expect.poll(() => logo.evaluate(image => image.complete && image.naturalWidth === 1712 && image.naturalHeight === 222)).toBe(true);
      const logoResponse = await context.request.get(new URL('/logo-transparent.png', base).href);
      assert.equal(createHash('sha256').update(await logoResponse.body()).digest('hex'), originalLogoHash, 'Original E/F logo pixels retained');
      await page.getByLabel('Email', { exact: true }).fill(member.email);
      await page.getByLabel('Password', { exact: true }).fill('Synthetic Password 8');
      assert.ok((await page.locator('.access-login input').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).textTransform))).every(value => value === 'none'), 'Email and password case must remain exact');
      await shot('signed-out');
      // Broken/absent old harbour artwork must never block theme switching.
      await toggle().click(); await expect(page.locator('html')).toHaveAttribute('data-theme', theme === 'light' ? 'dark' : 'light');
      await expect(toggle()).toHaveAttribute('aria-busy', 'false');
      await toggle().click(); await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByRole('alert')).toHaveText('Synthetic sign-in rejected.');
      await expect(page.getByLabel('Email', { exact: true })).toHaveValue(member.email);
      await expect(page.getByLabel('Password', { exact: true })).toHaveValue('Synthetic Password 8');
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
      await shot('sign-in-error');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByRole('main', { name: 'ECOSYSTEM workspace' })).toBeVisible();
      const geometry = await homepageGeometry(page, width);
      const stationary = await page.locator('.world-left').boundingBox();
      await expect(background).toHaveAttribute('data-paused', 'false');
      await expect.poll(async () => (await animationState(background)).filter(animation => animation.state === 'running').length).toBeGreaterThan(0);
      const before = await animationState(background); await page.waitForTimeout(180);
      const after = await animationState(background);
      assert.notDeepEqual(after.map(a => a.time), before.map(a => a.time), 'Decorative water advances');
      assert.deepEqual(await page.locator('.world-left').boundingBox(), stationary, 'Water never moves the controls');
      await shot('home');
      await page.getByRole('button', { name: 'Notifications', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Notifications', exact: true })).toBeVisible();
      await shot('notifications');
      await page.getByRole('button', { name: 'Close notifications', exact: true }).click();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
      await expect(settings).toBeVisible();
      await expect(background).toHaveAttribute('data-paused', 'true');
      await settings.getByRole('button', { name: 'Close workspace', exact: true }).click();
      const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
      for (const [group, children] of Object.entries(groups)) {
        const button = nav.getByRole('button', { name: group, exact: true });
        if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
        await expect(button).toHaveAttribute('aria-expanded', 'true');
        assert.equal(await nav.locator('.launcher-toggle[aria-expanded="true"]').count(), 1, 'Only one launcher expands');
        for (const label of children) {
          await nav.getByRole('button', { name: label, exact: true }).click();
          const dialog = page.getByRole('dialog', { name: label, exact: true }); await expect(dialog).toBeVisible();
          await expect(background).toHaveAttribute('data-paused', 'true');
          assert.ok((await animationState(background)).every(a => a.state !== 'running'), 'Working windows pause background movement');
          const surface = await dialog.evaluate(node => getComputedStyle(node).backgroundColor);
          assert.ok(/^rgb\(/.test(surface) || /^rgba\([^,]+,[^,]+,[^,]+,\s*1\)/.test(surface), `${label}: working content has an opaque reading surface`);
          if (label === 'Supplier Profiles') await shot('workspace');
          await noOverflow(page, label);
          await dialog.getByRole('button', { name: 'Close workspace', exact: true }).click();
          await expect(background).toHaveAttribute('data-paused', 'false');
        }
      }
      const opened = nav.locator('.launcher-toggle[aria-expanded="true"]'); if (await opened.count()) await opened.click();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await expect(background).toHaveAttribute('data-paused', 'true');
      const reduced = await animationState(background); await page.waitForTimeout(100);
      assert.ok(reduced.every(a => a.state !== 'running'), 'Reduced motion has no running water animation');
      assert.deepEqual(await animationState(background), reduced, 'Reduced motion freezes the water');
      await toggle().focus(); await toggle().press('Enter');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme === 'light' ? 'dark' : 'light');
      await expect(toggle()).toBeFocused(); await toggle().press('Enter');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      assert.equal(await page.evaluate(() => localStorage.getItem('ecosystem.theme.v1')), theme);
      // The new visual layout must retain the real member's non-interactive 2.0 gate.
      state.user = { ...state.user, isAdmin: false, isSpcTrader: false };
      await page.reload(); await expect(page.locator('.hud-identity')).toContainText(member.displayName);
      const deferred = page.locator('.launcher-group--deferred');
      await expect(deferred.getByRole('heading', { name: 'Buyers and Credit', exact: true })).toBeVisible();
      await expect(deferred).toContainText('UNDER CONSTRUCTION: TO BE RELEASED WITH ECO 2.0');
      await expect(deferred.locator('button, [aria-expanded]')).toHaveCount(0);
      await shot('member-gate');
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(page.locator('.access-login')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator('.world-launcher')).toHaveCount(0);
      const expectedWrites = ['/api/access/login', '/api/access/login', '/api/access/logout'];
      if (width === 1440 || width === 320) for (const type of ['invite', 'recovery']) {
        await page.goto('about:blank');
        await page.goto(`${base}/#token_hash=synthetic-${type}&type=${type}`);
        await expect(page.getByLabel('New password', { exact: true })).toBeVisible();
        await expect(page.getByLabel('Email', { exact: true })).toHaveCount(0);
        assert.equal(new URL(page.url()).hash, '', 'Activation token is removed from the address bar');
        await page.getByLabel('New password', { exact: true }).fill('Synthetic Password 8');
        await page.getByLabel('Confirm password', { exact: true }).fill('Different Password 8');
        await page.getByRole('button', { name: 'Set password', exact: true }).click();
        await expect(page.getByRole('alert')).toHaveText('Passwords do not match.');
        assert.deepEqual(state.writes, expectedWrites, 'Mismatched passwords are rejected before a request');
        await page.getByLabel('Confirm password', { exact: true }).fill('Synthetic Password 8');
        await shot(type);
        await page.getByRole('button', { name: 'Set password', exact: true }).click();
        await expect(page.getByRole('main', { name: 'ECOSYSTEM workspace' })).toBeVisible();
        expectedWrites.push('/api/access/activate');
        await page.getByRole('button', { name: 'Sign out', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
        expectedWrites.push('/api/access/logout');
      }
      assert.deepEqual(state.writes, expectedWrites);
      assert.deepEqual(locations.requests, [], 'Navigation and theme changes never save shared location data');
      assert.deepEqual(state.harbour, [], 'Flowing Water does not request retired harbour assets');
      assert.deepEqual(state.unexpected, []); assert.deepEqual(errors, []);
      results.push({ engine, width, theme, passed: true, geometry, signedOut: true, signedIn: true, nonAdminGate: true });
      console.log(`PASS ${engine} ${width} ${theme}: sign-in/out, navigation, theme, motion, role gate`);
    } catch (error) {
      results.push({ engine, width, theme, passed: false, error: error.message, unexpected: state.unexpected, errors });
      await page.screenshot({ path: `${out}/${engine}-${width}-${theme}-failure.png`, fullPage: true }).catch(() => {});
      throw error;
    } finally {
      await writeFile(`${reports}/verification.json`, JSON.stringify({ base, results, screenshotDirectory: out, limits: 'Synthetic authenticated responses in isolated browsers; native Safari and physical phones not tested. No live provider or business-data writes.' }, null, 2));
      await context.close();
    }
  } } finally { await browser.close(); }
}
