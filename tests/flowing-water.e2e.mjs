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
const waterArtwork = { path: '/flowing-water-day.png', width: 1672, height: 941, hash: 'f0bd089570a0b549b58565afebf43b5674bf7dbef9e14310883eea3705ce074f' };
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
  const state = { signedIn: false, rejectLogin: true, user: { ...member }, writes: [], unexpected: [], harbour: [], water: [] };
  context.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (/^\/flowing-water-.*\.(png|jpeg)$/.test(path)) state.water.push(path);
  });
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
const boxDifference = (first, second) => Math.max(...['x', 'y', 'width', 'height'].map(key => Math.abs(first[key] - second[key])));
const contentPositions = page => page.locator('.world-identity, .main-search, .world-launcher, .home-hud-stack, .flowing-footer').evaluateAll(nodes => nodes.map(node => {
  const box = node.getBoundingClientRect();
  return { name: node.className, x: box.x, y: box.y, width: box.width, height: box.height };
}));
async function verifyArtwork(page, context, theme, verifyBytes = false) {
  const expected = waterArtwork, image = page.locator('.flowing-water-image');
  await expect(image).toHaveCount(1);
  await expect(image).toHaveAttribute('src', expected.path);
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((image, expected) => image.complete && image.naturalWidth === expected.width && image.naturalHeight === expected.height && new URL(image.currentSrc).pathname === expected.path, expected)).toBe(true);
  const filter = await image.evaluate(node => getComputedStyle(node).filter);
  if (theme === 'light') assert.equal(filter, 'none', 'Day mode displays the original approved artwork colours');
  else {
    assert.ok(filter.includes('#eco-watercolour-night'), 'Night applies its colour filter to the same visible image');
    const palette = await page.locator('#eco-watercolour-night').evaluate(node => ({
      primitives: [...node.children].map(child => child.localName),
      channels: ['feFuncR', 'feFuncG', 'feFuncB'].map(name => node.querySelector(name).getAttribute('tableValues').trim().split(/\s+/).map(Number)),
    }));
    assert.deepEqual(palette.primitives, ['feColorMatrix', 'feComponentTransfer'], 'Night changes only colour: no replacement scene, blur or displacement');
    assert.ok(palette.channels.every(channel => channel.length === palette.channels[0].length && channel.every(value => Number.isFinite(value) && value >= 0 && value <= 1)));
    const luminance = channels => channels.map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    for (let index = 1; index < palette.channels[0].length; index++) {
      const input = index / (palette.channels[0].length - 1);
      assert.ok(luminance(palette.channels.map(channel => channel[index])) < luminance([input, input, input]), 'Night colour mapping darkens the midtones and highlights');
    }
  }
  if (verifyBytes) {
    const response = await context.request.get(new URL(expected.path, base).href);
    assert.equal(response.status(), 200);
    assert.ok(response.headers()['content-type']?.includes('image/png'), 'Artwork is served as an image, never the application HTML fallback');
    assert.equal(createHash('sha256').update(await response.body()).digest('hex'), expected.hash, 'The correct approved artwork is served unchanged for this theme');
  }
}
async function originalLogoColours(page) {
  const layers = await page.locator('.ecosystem-logo img').evaluate(node => {
    const layers = [];
    for (let layer = node; layer; layer = layer.parentElement) {
      const style = getComputedStyle(layer);
      layers.push({ tag: layer.tagName, filter: style.filter, opacity: style.opacity, blend: style.mixBlendMode });
    }
    return layers;
  });
  assert.ok(layers.every(layer => layer.filter === 'none' && layer.opacity === '1' && layer.blend === 'normal'), `The original white/green E/F logo is never recoloured with the water: ${JSON.stringify(layers)}`);
}
async function contributionColours(page) {
  const actions = await page.locator('button:visible').evaluateAll(nodes => nodes.map(node => {
    const style = getComputedStyle(node), channels = style.backgroundColor.match(/[\d.]+/g)?.slice(0, 3).map(Number) || [];
    return { text: node.textContent.trim(), credited: node.classList.contains('ui-button--contribution'), channels, ink: style.color };
  }));
  assert.ok(actions.some(action => action.credited), 'Signed-in homepage retains credited Feedback');
  for (const action of actions) {
    const [r, g, b] = action.channels, blue = b > r + 50 && b > g + 45;
    assert.equal(blue, action.credited, `Only contribution actions use blue: ${action.text}`);
    if (action.credited) assert.equal(action.ink, 'rgb(255, 255, 255)', 'Credited homepage label has white text');
  }
}
async function verifyNightContrast(page) {
  // Bound the brightest possible backdrop from the colour-map channel maxima,
  // then conservatively composite a white sheen at its maximum opacity. The
  // darker shade overlay is ignored, so this remains a safe contrast floor.
  const backdrop = await page.locator('#eco-watercolour-night').evaluate(node => {
    const channels = ['feFuncR', 'feFuncG', 'feFuncB'].map(name => Math.max(...node.querySelector(name).getAttribute('tableValues').trim().split(/\s+/).map(Number)));
    const sheen = Number(getComputedStyle(document.querySelector('.flowing-water-sheen')).opacity);
    return channels.map(channel => channel * (1 - sheen) + sheen);
  });
  const luminance = channels => channels.map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  const contrasts = [];
  const textTokens = await page.locator('.immersive-app').evaluate(node => {
    const probe = document.createElement('i'); node.append(probe);
    const values = ['--flow-ink', '--flow-muted', '--flow-footer'].map(token => {
      probe.style.color = `var(${token})`;
      return { token, ink: getComputedStyle(probe).color.match(/[\d.]+/g).slice(0, 3).map(value => Number(value) / 255) };
    });
    probe.remove(); return values;
  });
  for (const { token, ink } of textTokens) {
    const foreground = luminance(ink), background = luminance(backdrop), contrast = (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
    assert.ok(contrast >= 4.5, `${token}: unboxed night text remains at least 4.5:1 across the brightest possible watercolour and sheen (${contrast.toFixed(2)}:1)`);
    contrasts.push(contrast);
  }
  const inspect = async (action, state) => {
    await action.evaluate(node => Promise.all(node.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))));
    const style = await action.evaluate(node => {
      const style = getComputedStyle(node), rgba = color => { const channels = color.match(/[\d.]+/g).map(Number); return { rgb: channels.slice(0, 3).map(channel => channel / 255), alpha: channels[3] ?? 1 }; };
      return { label: node.textContent.trim(), fill: rgba(style.backgroundColor), ink: rgba(style.color), image: style.backgroundImage };
    });
    assert.equal(style.image, 'none', 'Entry contrast uses a measurable shared solid/translucent fill');
    const fill = style.fill.rgb.map((channel, index) => channel * style.fill.alpha + backdrop[index] * (1 - style.fill.alpha));
    const ink = style.ink.rgb.map((channel, index) => channel * style.ink.alpha + fill[index] * (1 - style.ink.alpha));
    const foreground = luminance(ink), background = luminance(fill), contrast = (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
    assert.ok(contrast >= 4.5, `${style.label} ${state}: night text remains at least 4.5:1 over the brightest possible watercolour and sheen (${contrast.toFixed(2)}:1)`);
    contrasts.push(contrast);
  };
  const navigation = await page.locator('.launcher-group:not([data-group="Trading"]) button.launcher-toggle').all();
  const footer = await page.locator('.home-display-controls button:visible:not(.ecosystem-feedback)').all();
  assert.equal(navigation.length, 2, 'Both secondary entry actions are checked');
  assert.ok(footer.length >= 2, 'Ordinary theme and account-view footer controls are checked');
  for (const action of [...navigation, ...footer]) {
    await page.mouse.move(0, 0); await inspect(action, 'normal');
    await action.hover(); await inspect(action, 'hover');
  }
  await page.mouse.move(0, 0);
  assert.equal(contrasts.length, 3 + 2 * (navigation.length + footer.length), 'Unboxed labels and normal/hover entry and footer actions all retain readable contrast');
  return Math.min(...contrasts);
}
async function verifyHiddenPause(page, background, waterImage) {
  // Isolated visibility fixture: exercise the same event used for a background
  // tab without relying on the host window focus or disturbing another browser.
  await page.evaluate(() => {
    for (const key of ['hidden', 'visibilityState']) {
      if (Object.hasOwn(document, key)) throw new Error(`Unexpected own visibility property: ${key}`);
    }
    Object.defineProperties(document, { hidden: { configurable: true, value: true }, visibilityState: { configurable: true, value: 'hidden' } });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  try {
    await expect(background).toHaveAttribute('data-paused', 'true');
    await expect.poll(async () => (await animationState(background)).filter(animation => animation.state === 'running').length).toBe(0);
    await background.evaluate(node => Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.ready)));
    const still = await waterImage.boundingBox(), paused = await animationState(background);
    await page.waitForTimeout(200);
    assert.ok(boxDifference(await waterImage.boundingBox(), still) < 0.1, 'A hidden document freezes the theme artwork');
    assert.deepEqual(await animationState(background), paused, 'A hidden document pauses every decorative animation');
  } finally {
    await page.evaluate(() => {
      delete document.hidden; delete document.visibilityState;
      document.dispatchEvent(new Event('visibilitychange'));
    });
  }
  await expect(background).toHaveAttribute('data-paused', 'false');
  await expect.poll(async () => (await animationState(background)).filter(animation => animation.state === 'running').length).toBeGreaterThan(0);
}
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
  assert.ok(geometry.every((b, i) => i === 0 || b.y >= geometry[i - 1].y + geometry[i - 1].height), 'Launchers stack without overlap at every screen width');
  assert.ok(Math.max(...geometry.map(b => b.x)) - Math.min(...geometry.map(b => b.x)) < 2, 'Stacked launchers share a left edge');
  const logo = await page.locator('.world-identity .ecosystem-logo').boundingBox();
  const search = await page.locator('.main-search').boundingBox();
  assert.ok(Math.abs(logo.x - geometry[0].x) < 3 && Math.abs(search.x - geometry[0].x) < 3, 'Logo, search and navigation retain the original left alignment');
  assert.ok(search.y >= logo.y + logo.height && geometry[0].y >= search.y + search.height, 'Search and stacked navigation follow the logo');
  if (width >= 760) assert.ok(logo.x < width * 0.1 && logo.y < 160, 'Desktop logo remains at the top left, including wide displays');
  const account = await page.locator('.trader-hud[data-trader-hud]').evaluate(node => {
    const style = getComputedStyle(node), box = node.getBoundingClientRect(), canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1; const context = canvas.getContext('2d');
    context.fillStyle = style.backgroundColor; context.fillRect(0, 0, 1, 1);
    return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, radius: parseFloat(style.borderRadius), alpha: context.getImageData(0, 0, 1, 1).data[3] / 255 };
  });
  assert.ok(account.alpha > 0 && account.alpha < 1 && account.radius >= 8, 'Account controls have a bounded translucent panel');
  assert.ok(account.x >= 0 && account.right <= width + 1, 'Account panel fits the viewport');
  if (width >= 760) assert.ok(account.x > width / 2 && account.y < 160 && account.x > logo.x + logo.width, 'Desktop account panel stays at the top right, separate from the left navigation');
  else assert.ok(account.bottom <= logo.y, 'Phone account panel and left-aligned logo do not overlap');
  return geometry;
}

for (const [engine, kind] of [['chromium', chromium], ['webkit', webkit]]) {
  if (process.env.ECO_TEST_ENGINE && process.env.ECO_TEST_ENGINE !== engine) continue;
  const executablePath = process.env[engine === 'chromium' ? 'ECO_CHROMIUM_EXECUTABLE' : 'ECO_WEBKIT_EXECUTABLE'];
  const browser = await kind.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  try { for (const width of [1440, 1920, 1024, 320, 390]) for (const theme of ['light', 'dark']) {
    if (process.env.ECO_TEST_WIDTH && +process.env.ECO_TEST_WIDTH !== width || process.env.ECO_TEST_THEME && process.env.ECO_TEST_THEME !== theme) continue;
    const context = await browser.newContext({ viewport: { width, height: width < 760 ? 844 : 900 }, isMobile: width < 760, hasTouch: width < 760, reducedMotion: 'no-preference', colorScheme: theme });
    await installStagingCookies(context, base);
    const { state, locations } = await mocks(context);
    await context.addInitScript(value => {
      if (location.protocol === 'http:' || location.protocol === 'https:') localStorage.setItem('ecosystem.theme.v1', value);
    }, theme);
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
    const shot = async name => { await noOverflow(page, name);
      const footer = await page.locator('.home-display-controls button:visible').evaluateAll(nodes => nodes.map(node => ({ label:node.textContent.trim(), size:parseFloat(getComputedStyle(node).fontSize), height:node.getBoundingClientRect().height })));
      assert.ok(footer.every(control => control.size >= 14 && control.height >= 44), `Readable footer actions: ${JSON.stringify(footer)}`);
      const textInk = await page.locator('.access-login label:visible, .access-login p:not([role="alert"]):visible, .launcher-release-remark:visible').evaluateAll(nodes => nodes.map(node => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d'); context.fillStyle = getComputedStyle(node).color; context.fillRect(0, 0, 1, 1);
        const [red, green, blue] = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => { const s = value / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
        return { text: node.textContent.trim(), luminance: .2126 * red + .7152 * green + .0722 * blue };
      }));
      assert.ok(textInk.every(label => theme === 'light' ? label.luminance < .04 : label.luminance > .5), `Sign-in labels and release remarks use dark ink on the bright day image and light ink at night: ${JSON.stringify(textInk)}`);
      await page.screenshot({ path: `${out}/${engine}-${width}-${theme}-${name}.png`, fullPage: true }); };
    const background = page.locator('.flowing-water-background');
    const toggle = () => page.locator('.home-display-controls').getByRole('button', { name: /^(Dark|Light) mode$/ });
    try {
      await page.goto(base);
      await expect(page.locator('.immersive-app')).toHaveAttribute('data-design', 'flowing-water', { timeout: 20000 });
      await expect(page.locator('.access-login')).toBeVisible();
      assert.deepEqual(await page.locator('.access-login label').evaluateAll(nodes => nodes.map(node => node.textContent.trim())), ['Email', 'Password'], 'Sign-in retains only existing form labels');
      await expect(page.locator('.marine-world, .mobile-harbour-background')).toHaveCount(0);
      await expect(background).toBeVisible();
      const waterImage = background.locator('img');
      await verifyArtwork(page, context, theme, true);
      await expect(page.locator('.world-launcher')).toHaveCount(0);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const logo = page.locator('.ecosystem-logo img');
      await expect(logo).toHaveAttribute('src', '/logo-transparent.png');
      await expect.poll(() => logo.evaluate(image => image.complete && image.naturalWidth === 1712 && image.naturalHeight === 222)).toBe(true);
      const logoResponse = await context.request.get(new URL('/logo-transparent.png', base).href);
      assert.equal(createHash('sha256').update(await logoResponse.body()).digest('hex'), originalLogoHash, 'Original E/F logo pixels retained');
      await originalLogoColours(page);
      await page.getByLabel('Email', { exact: true }).fill(member.email);
      await page.getByLabel('Password', { exact: true }).fill('Synthetic Password 8');
      assert.ok((await page.locator('.access-login input').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).textTransform))).every(value => value === 'none'), 'Email and password case must remain exact');
      await shot('signed-out');
      // Broken/absent old harbour artwork must never block theme switching.
      await toggle().click(); await expect(page.locator('html')).toHaveAttribute('data-theme', theme === 'light' ? 'dark' : 'light');
      await expect(toggle()).toHaveAttribute('aria-busy', 'false');
      await verifyArtwork(page, context, theme === 'light' ? 'dark' : 'light', true);
      await toggle().click(); await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await verifyArtwork(page, context, theme);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByRole('alert')).toHaveText('Synthetic sign-in rejected.');
      await expect(page.getByLabel('Email', { exact: true })).toHaveValue(member.email);
      await expect(page.getByLabel('Password', { exact: true })).toHaveValue('Synthetic Password 8');
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
      await shot('sign-in-error');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByRole('main', { name: 'ECOSYSTEM workspace' })).toBeVisible();
      await expect.poll(() => page.locator('.world-interface').evaluate(node => node.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running' && animation.effect?.getComputedTiming().iterations !== Infinity).length)).toBe(0);
      const geometry = await homepageGeometry(page, width);
      await originalLogoColours(page);
      await contributionColours(page);
      const nightContrastMinimum = theme === 'dark' ? await verifyNightContrast(page) : null;
      const stationary = await contentPositions(page);
      await expect(background).toHaveAttribute('data-paused', 'false');
      await expect.poll(async () => (await animationState(background)).filter(animation => animation.state === 'running').length).toBeGreaterThan(0);
      const before = await animationState(background), imageSamples = [await waterImage.boundingBox()];
      // Measure the visible range, not only net start/end displacement: a slow
      // alternate animation can cross its turning point during this interval.
      // Sample the live animation without changing its clock or playback rate.
      for (let sample = 0; sample < 8; sample++) {
        await page.waitForTimeout(500);
        imageSamples.push(await waterImage.boundingBox());
        const contentAfter = await contentPositions(page);
        assert.equal(contentAfter.length, stationary.length);
        for (let index = 0; index < stationary.length; index++) assert.ok(boxDifference(contentAfter[index], stationary[index]) < 0.1, `Water never moves ${stationary[index].name}`);
      }
      const after = await animationState(background);
      assert.notDeepEqual(after.map(a => a.time), before.map(a => a.time), 'Decorative water advances');
      const waterMotionPixels = Math.max(...['x', 'y', 'width', 'height'].map(key => Math.max(...imageSamples.map(box => box[key])) - Math.min(...imageSamples.map(box => box[key]))));
      assert.ok(waterMotionPixels >= 0.3, `The theme artwork visibly moves across four seconds (${waterMotionPixels.toFixed(2)}px)`);
      await verifyHiddenPause(page, background, waterImage);
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
        await expect.poll(() => nav.evaluate(node => node.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running' && animation.effect?.getComputedTiming().iterations !== Infinity).length)).toBe(0);
        const menuLayout = await nav.locator('.launcher-group').evaluateAll(nodes => nodes.map(node => {
          const menu = node.querySelector('.launcher-menu')?.getBoundingClientRect();
          return { top: node.getBoundingClientRect().top, open: node.querySelector('.launcher-toggle')?.getAttribute('aria-expanded') === 'true', menuBottom: menu?.bottom };
        }));
        const expandedIndex = menuLayout.findIndex(item => item.open);
        if (expandedIndex + 1 < menuLayout.length) assert.ok(menuLayout[expandedIndex].menuBottom <= menuLayout[expandedIndex + 1].top + 1, `${group}: expanded choices never cover the next navigation group`);
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
      await expect.poll(async () => (await animationState(background)).filter(animation => animation.state === 'running').length).toBe(0);
      await background.evaluate(node => Promise.all(node.getAnimations({ subtree: true }).map(animation => animation.ready)));
      const reduced = await animationState(background), reducedImage = await waterImage.boundingBox(); await page.waitForTimeout(200);
      assert.ok(reduced.every(a => a.state !== 'running'), 'Reduced motion has no running water animation');
      assert.deepEqual(await animationState(background), reduced, 'Reduced motion freezes the water');
      assert.ok(boxDifference(await waterImage.boundingBox(), reducedImage) < 0.1, 'Reduced motion leaves the theme artwork still');
      const reducedArtworkStyle = await waterImage.evaluate(node => { const style = getComputedStyle(node); return { fit: style.objectFit, position: style.objectPosition, filter: style.filter }; });
      await toggle().focus(); await toggle().press('Enter');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme === 'light' ? 'dark' : 'light');
      await verifyArtwork(page, context, theme === 'light' ? 'dark' : 'light');
      const oppositeArtworkStyle = await waterImage.evaluate(node => { const style = getComputedStyle(node); return { fit: style.objectFit, position: style.objectPosition, filter: style.filter }; });
      assert.ok(boxDifference(await waterImage.boundingBox(), reducedImage) < 0.1, 'Theme changes preserve the exact still-image position and size');
      assert.equal(oppositeArtworkStyle.fit, reducedArtworkStyle.fit);
      assert.equal(oppositeArtworkStyle.position, reducedArtworkStyle.position);
      assert.notEqual(oppositeArtworkStyle.filter, reducedArtworkStyle.filter, 'Night changes the colouring of the same image');
      await expect(toggle()).toBeFocused(); await toggle().press('Enter');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await verifyArtwork(page, context, theme);
      assert.ok(boxDifference(await waterImage.boundingBox(), reducedImage) < 0.1, 'Returning to the initial theme preserves artwork geometry');
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
        await expect.poll(() => new URL(page.url()).hash, {
          message: 'Activation token is removed from the address bar'
        }).toBe('');
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
      assert.ok(state.water.length > 0 && state.water.every(path => path === waterArtwork.path), 'Day and night use exactly the same artwork with no alternate scene requested');
      assert.deepEqual(state.unexpected, []); assert.deepEqual(errors, []);
      results.push({ engine, width, theme, passed: true, geometry, waterMotionPixels, nightContrastMinimum, artwork: waterArtwork, hiddenPause: true, signedOut: true, signedIn: true, nonAdminGate: true });
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
