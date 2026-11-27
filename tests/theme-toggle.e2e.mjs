import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { installSharedAttachments } from './fixtures/shared-attachments.mjs';
import { installProfileTabMocks } from './fixtures/profile-tabs.mjs';
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
    if (path === '/api/enquiries/dispatcher') return route.fulfill({ json: { routes: [] } });
    if (path === '/api/enquiries/inbox') return route.fulfill({ json: { items: [], nextCursor: null, unreadCount: 0 } });
    if (path === '/api/enquiries/records') return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === '/api/access/port-fixtures') return route.fulfill({ json: { items: [], supplierCount: 0 } });
    if (path === '/api/intelligence/snapshot') return route.fulfill({ json: { available: false, snapshot: null } });
    if (path.startsWith('/api/suppliers/')) return route.fulfill({ json: { items: [], page: 1, pageSize: 100, total: 0 } });
    if (path.startsWith('/api/admin/')) return route.fulfill({ json: { items: [], count: 0, nextCursor: null, periodStart: '2026-10-20T00:00:00Z', periodEnd: '2026-10-27T00:00:00Z', timeZone: 'Asia/Hong_Kong', source: 'shared-feedback' } });
    state.unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 503, json: { message: 'Unmatched synthetic test request.' } });
  });
  const user = () => state.signedIn ? member : null;
  await installSharedLocations(context, { user });
  await installSharedAttachments(context, { user });
  await installProfileTabMocks(context, { ownerId: () => user()?.id });
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
function contrast(first, second) {
  const luminance = rgb => rgb.slice(0, 3)
    .map(value => value / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
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
    const style = getComputedStyle(node), canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d');
    const rgba = colour => {
      context.clearRect(0, 0, 1, 1); context.fillStyle = colour; context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    return {
      onArtwork: Boolean(node.closest('.home-display-controls')),
      actual: rgba(style.backgroundColor), expected: rgba(style.getPropertyValue('--mode-track').trim()),
      thumb: rgba(getComputedStyle(node.querySelector('.theme-mode-toggle__thumb')).backgroundColor),
      activeInk: rgba(style.getPropertyValue('--mode-active').trim()),
      inactiveInk: rgba(style.getPropertyValue('--mode-inactive').trim()),
      activeIndex: node.dataset.mode === 'dark' ? 1 : 0,
      icons: [...node.querySelectorAll('svg')].map(icon => rgba(getComputedStyle(icon).color)),
    };
  });
  assert.deepEqual(paint.actual, paint.expected, 'The switch uses its shared track paint after hover and touch');
  if (paint.onArtwork) {
    assert.ok([paint.actual, paint.thumb].every(fill => fill[3] > 0 && fill[3] < 64), 'Artwork remains visible through the track and selected thumb');
  } else {
    assert.equal(paint.actual[3], 255, 'The workspace track is opaque');
    assert.equal(paint.thumb[3], 255, 'The workspace thumb is opaque');
    assert.ok(contrast(paint.activeInk, paint.thumb) >= 4.5, 'Selected icon is readable on the thumb');
    assert.ok(contrast(paint.inactiveInk, paint.actual) >= 4.5, 'Other icon is readable on the track');
  }
  assert.notDeepEqual(paint.actual, paint.thumb, 'The thumb is visibly distinct from the track');
  assert.equal(paint.icons.length, 2, 'Both theme icons remain present');
  assert.deepEqual(paint.icons[paint.activeIndex], paint.activeInk);
  assert.deepEqual(paint.icons[1 - paint.activeIndex], paint.inactiveInk);

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
async function translucent(controls) {
  await expect(controls.first()).toBeVisible();
  const fills = await controls.evaluateAll(nodes => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d');
    return nodes.map(node => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = getComputedStyle(node).backgroundColor;
      ctx.fillRect(0, 0, 1, 1);
      return { name: node.className, alpha: ctx.getImageData(0, 0, 1, 1).data[3] / 255 };
    });
  });
  for (const { name, alpha } of fills) assert.ok(alpha > 0 && alpha < .9, `${name} has a visible translucent fill`);
}
async function workspacePaint(workspace, name, theme) {
  const dark = theme === 'dark';
  await expect(workspace).toHaveCSS('background-color', dark ? 'rgb(0, 0, 0)' : 'rgb(245, 245, 245)');
  const selectors = name === 'Enquiries' ? ['.center-tabs > button', '[aria-selected="true"]']
    : name === 'Settings' ? ['.settings-nav-group > button', '.active'] : null;
  if (!selectors) return;
  const [tab, active] = selectors;
  const selected = workspace.locator(tab + active);
  const idle = workspace.locator(`${tab}:not(${active})`).first();
  await expect(selected).toHaveCSS('background-color', dark ? 'rgb(58, 58, 60)' : 'rgb(253, 253, 253)');
  await expect(idle).toHaveCSS('background-color', dark ? 'rgb(44, 44, 46)' : 'rgb(237, 237, 237)');
  await expect(selected).toHaveCSS('border-radius', '8px');
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
    await translucent(nav.locator('.is-open .launcher-menu'));
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
      await translucent(page.getByRole('button', { name: 'Sign in', exact: true }));
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
      await translucent(page.locator('.trader-hud[data-trader-hud], .world-launcher button.launcher-toggle'));
      const contributionTier = page.locator('.hud-resource-activity > .contribution-tier');
      await expect(contributionTier).toHaveCount(0);
      for (const name of ['Enquiries', 'Countries & Ports', 'Supplier Profiles', 'Settings']) {
        const workspace = await openWorkspace(page, name), control = controlIn(workspace.locator('.window-foot'));
        await mode(page, theme); await usable(page, control);
        const before = await geometry(page);
        await activateHalf(page, control, 'left', mobile); theme = opposite(theme); await mode(page, theme);
        await activateHalf(page, control, 'right', mobile); theme = opposite(theme); await mode(page, theme);
        unchangedGeometry(before, await geometry(page), `${name} footer`);
        await control.focus(); await control.press('Space'); theme = opposite(theme); await mode(page, theme); await expect(control).toBeFocused();
        await workspacePaint(workspace, name, theme);
        await page.screenshot({ path: `${out}/${engine}-${width}-${initialTheme}-${name.replaceAll(' ', '-')}-${theme}.png`, fullPage: true });
        await workspace.getByRole('button', { name: 'Close workspace', exact: true }).click(); await mode(page, theme);
      }
      await shot(page, `${engine}-${width}-${initialTheme}-signed-in-${theme}`);
      await authentication(page, 'logout', () => page.getByRole('button', { name: 'Sign out', exact: true }).click(), false); await mode(page, theme);
      await authentication(page, 'session', () => page.reload({ waitUntil: 'domcontentloaded' }), false); await mode(page, theme);
      assert.deepEqual(state.writes, ['/api/access/login', '/api/access/logout']); assert.deepEqual(state.unexpected, []); assert.deepEqual(errors, []);
      results.push({ engine, width, initialTheme, passed: true, keyboard: ['Enter', 'Space'], bothHalves: true, geometryStable: true, workspaceFooters: ['Enquiries', 'Countries & Ports', 'Supplier Profiles', 'Settings'], persistence: true, workspacePaint: true });
      console.log(`PASS ${engine} ${width} ${initialTheme}: switch, palette, stable geometry and session persistence`);
    } catch (error) {
      results.push({ engine, width, initialTheme, passed: false, error: error.message, errors, unexpected: state.unexpected });
      await page.screenshot({ path: `${out}/${engine}-${width}-${initialTheme}-failure.png`, fullPage: true }).catch(() => {}); throw error;
    } finally {
      await writeFile(`${reports}/verification.json`, JSON.stringify({ base, results, screenshotDirectory: out, limits: 'Isolated Chromium/WebKit and synthetic authentication. Reduced motion isolates switch/layout checks; moving night artwork is verified separately. Physical phones and installed Safari are untested.' }, null, 2));
      await context.close();
    }
  } } finally { await browser.close(); }
}
