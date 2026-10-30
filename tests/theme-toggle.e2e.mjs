import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { installSharedLocations } from './fixtures/shared-locations.mjs';
import { installStagingCookies } from './fixtures/protection-cookies.mjs';

// Exercise the native switch without a production identity or business writes.
// Moving artwork and actual night pixels remain covered by background-choice.
const base = process.env.ECO_TOGGLE_UI_ORIGIN || 'http://127.0.0.1:4286';
const out = resolve(process.env.ECO_TOGGLE_UI_OUTPUT || `${tmpdir()}/eco-theme-toggle`);
const reports = resolve(process.env.ECO_TOGGLE_REPORT_OUTPUT || out);
await mkdir(out, { recursive: true }); await mkdir(reports, { recursive: true });
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
    if (path.startsWith('/api/suppliers/')) return route.fulfill({ json: { items: [], page: 1, pageSize: 100, total: 0 } });
    if (path.startsWith('/api/admin/')) return route.fulfill({ json: { items: [], count: 0, nextCursor: null, periodStart: '2026-10-20T00:00:00Z', periodEnd: '2026-10-27T00:00:00Z', timeZone: 'Asia/Hong_Kong', source: 'shared-feedback' } });
    state.unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 503, json: { message: 'Unmatched synthetic test request.' } });
  });
  await installSharedLocations(context, { user: () => state.signedIn ? member : null });
  return state;
}
const controlIn = scope => scope.getByRole('switch', { name: 'Dark mode', exact: true, includeHidden: true });
const homeControl = page => controlIn(page.locator('.home-display-controls'));
const opposite = theme => theme === 'dark' ? 'light' : 'dark';
async function mode(page, theme) {
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect(page.locator('html')).toHaveAttribute('data-theme-requested', theme);
  await expect(page.locator('html')).toHaveAttribute('data-theme-pending', 'false');
  assert.equal(await page.evaluate(() => localStorage.getItem('ecosystem.theme.v1')), theme);
  for (const control of await controlIn(page).all()) {
    await expect(control).toHaveAttribute('aria-checked', String(theme === 'dark'));
    await expect(control).toHaveAttribute('aria-busy', 'false');
    await expect(control).toHaveAttribute('aria-label', 'Dark mode');
    assert.equal(await control.evaluate(node => node.tagName), 'BUTTON', 'Switch retains native keyboard activation');
    await expect(control).toHaveAttribute('type', 'button');
  }
  // Closed workspaces deliberately have no accessibility-tree name. Verify the
  // exposed switch separately while retaining state assertions for every copy.
  const exposed = page.getByRole('switch', { name: 'Dark mode', exact: true });
  assert.ok(await exposed.count() > 0, 'At least one theme switch is exposed');
  for (const control of await exposed.all()) await expect(control).toHaveAccessibleName('Dark mode');
}
async function geometry(page) {
  await page.evaluate(() => document.fonts.ready);
  return page.locator('.entry-brand,.access-login,.world-identity,.main-search,.world-launcher,.home-hud-stack,.flowing-footer,.theme-mode-toggle,.window-foot').evaluateAll(nodes => nodes.filter(node => node.getBoundingClientRect().width && node.getBoundingClientRect().height).map(node => {
    const { x, y, width, height } = node.getBoundingClientRect();
    return { name: node.className, x, y, width, height };
  }));
}
function unchangedGeometry(before, after, label) {
  assert.equal(after.length, before.length, `${label}: same layout elements`);
  before.forEach((box, index) => {
    assert.equal(after[index].name, box.name);
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(box[key] - after[index][key]) <= .75,
      `${label}: ${box.name} ${key} remains stable (${box[key]} to ${after[index][key]})`);
  });
}
async function usable(page, control) {
  await expect(control).toBeVisible(); await expect(control).toBeEnabled();
  await control.scrollIntoViewIfNeeded();
  const box = await control.boundingBox();
  const viewport = page.viewportSize();
  const desktopFooter = viewport.width >= 760 && await control.evaluate(node => Boolean(node.closest('.window-foot')));
  assert.ok(box && box.width >= 44 && box.height >= (desktopFooter ? 36 : 44), 'Phone/home switches retain 44px touch targets; desktop workspaces preserve their 36px footer height');
  assert.ok(box.x >= -1 && box.x + box.width <= viewport.width + 1 && box.y >= -1 && box.y + box.height <= viewport.height + 1, 'Switch fits the viewport');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal overflow');
  const paint = await control.evaluate(node => {
    const style = getComputedStyle(node), thumb = getComputedStyle(node.querySelector('.theme-mode-toggle__thumb'));
    return {
      mode: node.dataset.mode, track: style.backgroundColor, image: style.backgroundImage,
      thumb: thumb.backgroundColor.match(/[\d.]+/g).map(Number),
      icons: [...node.querySelectorAll('svg')].map(icon => ({ colour: getComputedStyle(icon).color, stroke: getComputedStyle(icon).stroke })),
    };
  });
  assert.equal(paint.track, 'rgba(0, 0, 0, 0)', 'Shared switch track stays transparent, including after hover/touch');
  assert.equal(paint.image, 'none', 'No background image covers the transparent switch');
  const dark = paint.mode === 'dark', ink = dark ? 'rgb(255, 255, 255)' : 'rgb(17, 17, 17)';
  assert.equal(paint.icons.length, 2, 'The sun and moon remain visible line icons');
  for (const icon of paint.icons) {
    assert.equal(icon.colour, ink, 'Both icons use dark lines by day and white lines at night');
    assert.equal(icon.stroke, ink, 'The rendered SVG strokes use the intended theme ink');
  }
  assert.deepEqual(paint.thumb.slice(0, 3), dark ? [255, 255, 255] : [17, 17, 17]);
  assert.ok(Math.abs((paint.thumb[3] ?? 1) - (dark ? .12 : .06)) < .005, 'The selected half uses only the subtle translucent highlight');

  const peers = await control.locator('..').locator(':scope > button, :scope > label').evaluateAll(nodes => nodes.filter(node => node.getBoundingClientRect().width && node.getBoundingClientRect().height).map(node => {
    const { left, right, top, bottom } = node.getBoundingClientRect(); return { left, right, top, bottom };
  }));
  for (let i = 0; i < peers.length; i++) for (let j = i + 1; j < peers.length; j++) {
    const horizontal = Math.min(peers[i].right, peers[j].right) - Math.max(peers[i].left, peers[j].left);
    const vertical = Math.min(peers[i].bottom, peers[j].bottom) - Math.max(peers[i].top, peers[j].top);
    assert.ok(horizontal <= 1 || vertical <= 1, 'Display controls do not overlap');
  }
  return box;
}
async function activateHalf(page, control, side, mobile) {
  const box = await usable(page, control), position = { x: box.width * (side === 'left' ? .2 : .8), y: box.height / 2 };
  if (mobile) await control.tap({ position }); else await control.click({ position });
}
async function authentication(page, path, action, signedIn = true) {
  const [response] = await Promise.all([
    page.waitForResponse(response => response.url() === `${base}/api/access/${path}` && response.request().method() === (path === 'session' ? 'GET' : 'POST'), { timeout: 15000 }),
    action(),
  ]);
  assert.equal(response.status(), path === 'session' && !signedIn ? 401 : 200);
  await expect(page.locator(signedIn ? '.world-launcher' : '.access-login')).toBeVisible({ timeout: 15000 });
}
async function shot(page, name) {
  await usable(page, homeControl(page));
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
}
async function openWorkspace(page, name) {
  if (name === 'Settings') await page.getByRole('button', { name, exact: true }).click();
  else {
    const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
    const group = nav.getByRole('button', { name: name === 'Enquiries' ? 'Trading' : 'Ports & Suppliers', exact: true });
    if (await group.getAttribute('aria-expanded') !== 'true') await group.click();
    await nav.getByRole('button', { name, exact: true }).click();
  }
  const workspace = page.getByRole('dialog', { name, exact: true }); await expect(workspace).toBeVisible(); return workspace;
}
for (const [engine, kind] of [['chromium', chromium], ['webkit', webkit]]) {
  if (process.env.ECO_TEST_ENGINE && process.env.ECO_TEST_ENGINE !== engine) continue;
  const executablePath = process.env[engine === 'chromium' ? 'ECO_CHROMIUM_EXECUTABLE' : 'ECO_WEBKIT_EXECUTABLE']
    || (engine === 'chromium' && process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
  const browser = await kind.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  try { for (const width of [1440, 320, 390]) for (const initialTheme of ['light', 'dark']) {
    if (process.env.ECO_TEST_WIDTH && Number(process.env.ECO_TEST_WIDTH) !== width || process.env.ECO_TEST_THEME && process.env.ECO_TEST_THEME !== initialTheme) continue;
    const mobile = width < 760;
    const context = await browser.newContext({ viewport: { width, height: mobile ? 844 : 960 }, hasTouch: mobile, isMobile: mobile, colorScheme: initialTheme, reducedMotion: 'reduce' });
    await installStagingCookies(context, base);
    await context.addInitScript(theme => { if (!localStorage.getItem('ecosystem.theme.v1')) localStorage.setItem('ecosystem.theme.v1', theme); }, initialTheme);
    const state = await mocks(context), page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(15000);
    let theme = initialTheme;
    try {
      await authentication(page, 'session', () => page.goto(base, { waitUntil: 'domcontentloaded' }), false);
      await mode(page, theme); const home = homeControl(page); await usable(page, home);
      const entryGeometry = await geometry(page);
      await home.focus(); await home.press('Enter'); theme = opposite(theme); await mode(page, theme); await expect(home).toBeFocused();
      const outline = await home.evaluate(node => ({ width: parseFloat(getComputedStyle(node).outlineWidth), style: getComputedStyle(node).outlineStyle }));
      assert.ok(outline.width > 0 && outline.style !== 'none', 'Keyboard focus remains visibly outlined');
      await home.press('Space'); theme = opposite(theme); await mode(page, theme); await expect(home).toBeFocused();
      unchangedGeometry(entryGeometry, await geometry(page), 'Keyboard activation');
      await activateHalf(page, home, 'left', mobile); theme = opposite(theme); await mode(page, theme);
      await shot(page, `${engine}-${width}-${initialTheme}-signed-out-${theme}`);
      await activateHalf(page, home, 'right', mobile); theme = opposite(theme); await mode(page, theme);
      unchangedGeometry(entryGeometry, await geometry(page), 'Both switch halves');
      await shot(page, `${engine}-${width}-${initialTheme}-signed-out-${theme}`);
      assert.deepEqual(state.writes, [], 'Switch activation never submits the sign-in form');
      await page.getByLabel('Email', { exact: true }).fill(member.email); await page.getByLabel('Password', { exact: true }).fill('Synthetic Password 8');
      await authentication(page, 'login', () => page.getByRole('button', { name: 'Sign in', exact: true }).click());
      await mode(page, theme);
      await authentication(page, 'session', () => page.reload({ waitUntil: 'domcontentloaded' })); await mode(page, theme);
      for (const name of ['Enquiries', 'Countries & Ports', 'Supplier Profiles', 'Settings']) {
        const workspace = await openWorkspace(page, name), control = controlIn(workspace.locator('.window-foot'));
        await mode(page, theme); await usable(page, control);
        const before = await geometry(page);
        await activateHalf(page, control, 'left', mobile); theme = opposite(theme); await mode(page, theme);
        await activateHalf(page, control, 'right', mobile); theme = opposite(theme); await mode(page, theme);
        unchangedGeometry(before, await geometry(page), `${name} footer`);
        await control.focus(); await control.press('Space'); theme = opposite(theme); await mode(page, theme); await expect(control).toBeFocused();
        await page.screenshot({ path: `${out}/${engine}-${width}-${initialTheme}-${name.replaceAll(' ', '-')}-${theme}.png`, fullPage: true });
        await workspace.getByRole('button', { name: 'Close workspace', exact: true }).click(); await mode(page, theme);
      }
      await shot(page, `${engine}-${width}-${initialTheme}-signed-in-${theme}`);
      await authentication(page, 'logout', () => page.getByRole('button', { name: 'Sign out', exact: true }).click(), false); await mode(page, theme);
      await authentication(page, 'session', () => page.reload({ waitUntil: 'domcontentloaded' }), false); await mode(page, theme);
      assert.deepEqual(state.writes, ['/api/access/login', '/api/access/logout']); assert.deepEqual(state.unexpected, []); assert.deepEqual(errors, []);
      results.push({ engine, width, initialTheme, passed: true, keyboard: ['Enter', 'Space'], bothHalves: true, geometryStable: true, workspaceFooters: ['Enquiries', 'Countries & Ports', 'Supplier Profiles', 'Settings'], persistence: true });
      console.log(`PASS ${engine} ${width} ${initialTheme}: switch semantics, keyboard/touch, stable geometry and session persistence`);
    } catch (error) {
      results.push({ engine, width, initialTheme, passed: false, error: error.message, errors, unexpected: state.unexpected });
      await page.screenshot({ path: `${out}/${engine}-${width}-${initialTheme}-failure.png`, fullPage: true }).catch(() => {}); throw error;
    } finally {
      await writeFile(`${reports}/verification.json`, JSON.stringify({ base, results, screenshotDirectory: out, limits: 'Isolated Chromium/WebKit and synthetic authentication. Reduced motion isolates switch/layout checks; moving night artwork is verified separately. Physical phones and installed Safari are untested.' }, null, 2));
      await context.close();
    }
  } } finally { await browser.close(); }
}
