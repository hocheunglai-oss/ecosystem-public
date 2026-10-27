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
const waterArtwork = { path: '/flowing-water-day.png', width: 1672, height: 941, hash: '365ee9400a431fdd03079e40bb86bec7f78e5f6fbe0555aaaa596145bcaaf59c' };
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
async function waterPixelPlan(page) {
  return page.evaluate(() => {
    const excluded = [...document.querySelectorAll('.world-identity,.main-search,.world-launcher,.home-hud-stack,.flowing-footer,.entry-brand,.access-login,[role="dialog"],[role="region"][aria-label="Notifications"]')].map(node => node.getBoundingClientRect());
    const points = [];
    for (let y = 8; y < innerHeight - 8; y += 8) for (let x = 8; x < innerWidth - 8; x += 8) {
      if (!excluded.some(box => box.width && box.height && x >= box.left - 4 && x <= box.right + 4 && y >= box.top - 4 && y <= box.bottom + 4)) points.push([x, y]);
    }
    return { width: innerWidth, height: innerHeight, points };
  });
}
async function waterPixels(page, plan) {
  // Read real compositor output, including the displayed night filter. The
  // detached decoder changes no page pixels, canvas state or animation clock.
  const bytes = await page.screenshot({ animations: 'allow' });
  return page.evaluate(async ({ data, plan }) => {
    const image = new Image(); image.src = data; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    return plan.points.flatMap(([x, y]) => {
      const offset = (Math.floor(y * canvas.height / plan.height) * canvas.width + Math.floor(x * canvas.width / plan.width)) * 4;
      return [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
    });
  }, { data: `data:image/png;base64,${bytes.toString('base64')}`, plan });
}
function pixelDifference(first, second) {
  assert.equal(first.length, second.length, 'The same unoccluded artwork pixels are compared');
  assert.ok(first.length >= 300, 'Motion is measured across at least 100 visible background points');
  let total = 0, changed = 0, maximum = 0;
  for (let index = 0; index < first.length; index += 3) {
    const channels = [0, 1, 2].map(channel => Math.abs(first[index + channel] - second[index + channel]));
    total += channels.reduce((sum, value) => sum + value, 0);
    maximum = Math.max(maximum, ...channels);
    if (Math.max(...channels) >= 2) changed++;
  }
  return { mean: total / first.length, changedFraction: changed / (first.length / 3), maximum, points: first.length / 3 };
}
function verifyVisibleWaterPixels(pixels, label) {
  const channels = [0, 1, 2].map(channel => pixels.filter((_value, index) => index % 3 === channel));
  const spread = channels.map(values => {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return { range: Math.max(...values) - Math.min(...values), deviation: Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length) };
  });
  assert.ok(spread.filter(channel => channel.range > 20).length >= 2 && Math.max(...spread.map(channel => channel.deviation)) > 6, `${label}: visible water retains multiple colour regions instead of a blank cleared canvas (${JSON.stringify(spread)})`);
}
const rendererCapabilities = new WeakMap();
async function readyRenderer(page) {
  const background = page.locator('.flowing-water-background');
  await expect.poll(() => background.locator('img').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  if (!rendererCapabilities.has(page)) {
    const supported = await page.evaluate(() => {
      const probe = document.createElement('canvas');
      const gl = probe.getContext('webgl', { alpha: false, antialias: false, powerPreference: 'low-power' });
      const available = Boolean(gl && !gl.isContextLost());
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
      return available;
    });
    rendererCapabilities.set(page, supported);
    if (process.platform === 'darwin' || process.env.ECO_REQUIRE_WEBGL === '1') assert.ok(supported, 'This verification host must provide WebGL1 to prove actual internal movement');
  }
  const supported = rendererCapabilities.get(page), reduced = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  await expect(background).toHaveAttribute('data-renderer', supported && !reduced ? 'webgl' : 'fallback');
  const image = background.locator('img'), canvas = background.locator('canvas');
  await expect(canvas).toHaveCount(1);
  if (supported && !reduced) {
    await expect(image).toBeHidden(); await expect(canvas).toBeVisible();
    assert.equal(await canvas.evaluate(node => getComputedStyle(node).opacity), '1');
  } else {
    await expect(image).toBeVisible();
    assert.equal(await canvas.evaluate(node => getComputedStyle(node).opacity), '0');
  }
  return { supported, reduced, mode: supported && !reduced ? 'webgl' : 'fallback' };
}
const flowState = background => background.evaluate(node => {
  const canvas = node.querySelector('canvas');
  return { renderer: node.dataset.renderer, state: node.dataset.flowState, frame: Number(canvas.dataset.flowFrame || 0), time: Number(canvas.dataset.flowTimeMs || 0), period: Number(canvas.dataset.flowPeriodMs) };
});
async function verifyStillWater(page, background, label, inspectPixels = true) {
  await expect.poll(async () => (await flowState(background)).state !== 'running').toBe(true);
  assert.ok((await animationState(background)).every(animation => animation.state !== 'running'), `${label}: no CSS water motion continues`);
  const before = await flowState(background), bounds = await background.locator('canvas').boundingBox();
  const plan = inspectPixels ? await waterPixelPlan(page) : null;
  const pixels = plan ? await waterPixels(page, plan) : null;
  await page.waitForTimeout(250);
  assert.deepEqual(await flowState(background), before, `${label}: the actual render frame and active time stay frozen`);
  assert.ok(boxDifference(await background.locator('canvas').boundingBox(), bounds) < .1, `${label}: framing stays fixed`);
  if (plan) {
    verifyVisibleWaterPixels(pixels, label);
    const difference = pixelDifference(pixels, await waterPixels(page, plan));
    assert.ok(difference.mean <= .05 && difference.maximum <= 1, `${label}: the displayed background pixels stay still (${JSON.stringify(difference)})`);
  }
}
async function verifyInternalMotion(page, background) {
  const capability = await readyRenderer(page), canvas = background.locator('canvas');
  const imageBox = () => background.locator('img').evaluate(node => { const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height }; });
  const stationary = await contentPositions(page), bounds = await canvas.boundingBox(), imageBounds = await imageBox();
  assert.equal((await animationState(background)).length, 0, 'No panning image, moving sheen or other CSS motion can masquerade as internal flow');
  assert.equal(await canvas.evaluate(node => getComputedStyle(node).transform), 'none', 'The canvas is never translated or zoomed');
  const plan = await waterPixelPlan(page), first = await waterPixels(page, plan), before = await flowState(background), changes = [];
  if (capability.mode === 'webgl') await expect(background).toHaveAttribute('data-flow-state', 'running');
  // Real wall-clock movement proof. No mocked clock, seeking, playback-rate
  // changes, hidden elements or altered pixels participate in these samples.
  for (let sample = 0; sample < 8; sample++) {
    await page.waitForTimeout(500);
    changes.push(pixelDifference(first, await waterPixels(page, plan)));
    assert.ok(boxDifference(await canvas.boundingBox(), bounds) < .1, 'Internal flow never pans or zooms its canvas');
    assert.ok(boxDifference(await imageBox(), imageBounds) < .1, 'The original fallback image keeps fixed framing');
    const contentAfter = await contentPositions(page);
    assert.equal(contentAfter.length, stationary.length);
    for (let index = 0; index < stationary.length; index++) assert.ok(boxDifference(contentAfter[index], stationary[index]) < .1, `Water never moves ${stationary[index].name}`);
  }
  const after = await flowState(background), strongest = changes.reduce((best, item) => item.mean > best.mean ? item : best);
  if (capability.mode === 'webgl') {
    assert.ok(after.frame > before.frame && after.time > before.time + 3500, 'Real internal animation frames and active time advance');
    assert.ok(strongest.mean > .15 && strongest.changedFraction > .01, `Visible water pixels change inside the stationary frame (${JSON.stringify(strongest)})`);
  } else {
    assert.deepEqual(after, before, 'A genuinely unsupported WebGL host keeps the still fallback');
    assert.ok(strongest.mean <= .05 && strongest.maximum <= 1, 'Unsupported graphics still renders a stable usable image');
  }
  return { capability, difference: strongest, elapsed: after.time - before.time, frames: after.frame - before.frame, fixedBounds: true, actualMovementVerified: capability.mode === 'webgl' };
}
async function settledPhasePixels(page, background, plan) {
  const state = await flowState(background), settling = [];
  let pixels = await waterPixels(page, plan);
  assert.deepEqual(await flowState(background), state, 'The controlled phase stays fixed throughout compositor capture');
  for (let sample = 1; sample < 4; sample++) {
    const next = await waterPixels(page, plan), difference = pixelDifference(pixels, next);
    assert.deepEqual(await flowState(background), state, 'Compositor settlement cannot advance the controlled renderer');
    settling.push(difference);
    if (difference.mean <= .05 && difference.maximum <= 1) {
      verifyVisibleWaterPixels(next, 'Settled loop phase');
      return { state, pixels: next, settling };
    }
    pixels = next;
  }
  assert.fail(`The fixed-phase compositor did not settle within four captures (${JSON.stringify({ state, settling })})`);
}
async function verifyPeriodicFrames(page, background) {
  // This separate check seeks only to compare exact loop phases. The movement
  // and pause proof above used the untouched real clock throughout.
  await page.goto('about:blank');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.clock.install();
  await page.goto(base);
  await expect(page.locator('.access-login')).toBeVisible();
  await readyRenderer(page);
  if (!rendererCapabilities.get(page)) return { verified: false, reason: 'WebGL1 unavailable; stable fallback verified separately' };
  await expect.poll(async () => (await flowState(background)).frame).toBeGreaterThan(2);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
  // pauseAt may end between the renderer's 30fps draws. Prime an actual draw
  // before choosing the baseline, rather than accepting a different phase.
  const beforePrime = await flowState(background);
  await page.clock.fastForward(48);
  const primed = await flowState(background);
  assert.ok(primed.frame > beforePrime.frame && primed.time > beforePrime.time, 'The baseline starts at an actual newly drawn phase');
  const period = (await flowState(background)).period;
  assert.equal(period, 48000, 'The full internal loop retains its declared 48-second period');
  const plan = await waterPixelPlan(page), first = await settledPhasePixels(page, background, plan);
  await page.clock.fastForward(period);
  const repeated = await settledPhasePixels(page, background, plan), repeat = pixelDifference(first.pixels, repeated.pixels);
  assert.ok(Math.abs(repeated.state.time - first.state.time - period) <= .001, `The comparison advances exactly one renderer period (${JSON.stringify({ first: first.state, repeated: repeated.state })})`);
  assert.ok(repeat.mean <= .12 && repeat.changedFraction <= .005, `The actual rendered artwork returns to the same phase after one loop (${JSON.stringify({ repeat, first: first.state, repeated: repeated.state })})`);
  await page.clock.fastForward(period / 4);
  const quarterFrame = await settledPhasePixels(page, background, plan), quarter = pixelDifference(first.pixels, quarterFrame.pixels);
  assert.ok(quarter.mean > .15 && quarter.changedFraction > .01, 'A quarter-loop differs visibly; periodic equality is not a frozen renderer');
  const phase = (await flowState(background)).time % period;
  await page.clock.fastForward((period - 96 - phase + period) % period);
  const nearSeam = [await settledPhasePixels(page, background, plan)], phases = [nearSeam[0].state.time % period];
  for (let sample = 0; sample < 4; sample++) {
    await page.clock.fastForward(48);
    nearSeam.push(await settledPhasePixels(page, background, plan));
    phases.push(nearSeam.at(-1).state.time % period);
  }
  const wrap = phases.findIndex((value, index) => index > 0 && value < phases[index - 1]);
  assert.ok(wrap > 0 && wrap < phases.length - 1, `Samples cross the real period boundary (${phases.join(', ')})`);
  const steps = nearSeam.slice(1).map((frame, index) => pixelDifference(nearSeam[index].pixels, frame.pixels));
  const neighbours = steps.filter((_step, index) => index !== wrap - 1);
  const seam = steps[wrap - 1];
  assert.ok(seam.mean <= Math.max(...neighbours.map(step => step.mean)) * 3 + .12, `The loop boundary has no pixel jump beyond adjacent equal-time steps (${JSON.stringify(steps)})`);
  await page.clock.resume();
  const captures = [first, repeated, quarterFrame, ...nearSeam].map(({ state, settling }) => ({ state, settling }));
  return { verified: true, period, repeat, quarter, phases, seam, adjacent: neighbours, captures };
}
async function verifyContextLossFallback(page, background) {
  if (!rendererCapabilities.get(page)) return { verified: false, reason: 'WebGL1 unavailable; initial fallback verified' };
  const available = await background.locator('canvas').evaluate(node => {
    const gl = node.getContext('webgl'), extension = gl?.getExtension('WEBGL_lose_context');
    if (!extension) return false;
    extension.loseContext(); return true;
  });
  assert.ok(available, 'The supported test renderer exposes deterministic context loss');
  await expect(background).toHaveAttribute('data-renderer', 'fallback');
  await expect(background).toHaveAttribute('data-flow-state', 'fallback');
  await expect(background.locator('img')).toBeVisible();
  assert.equal(await background.locator('canvas').evaluate(node => getComputedStyle(node).opacity), '0');
  await verifyStillWater(page, background, 'Lost graphics context');
  return { verified: true, originalStillImageVisible: true };
}
async function verifyArtwork(page, context, theme, verifyBytes = false) {
  const expected = waterArtwork, image = page.locator('.flowing-water-image');
  await expect(image).toHaveCount(1);
  await expect(image).toHaveAttribute('src', expected.path);
  await readyRenderer(page);
  await expect.poll(() => image.evaluate((image, expected) => image.complete && image.naturalWidth === expected.width && image.naturalHeight === expected.height && new URL(image.currentSrc).pathname === expected.path, expected)).toBe(true);
  const framing = await page.locator('.flowing-water-image,.flowing-water-canvas').evaluateAll(nodes => nodes.map(node => {
    const box = node.getBoundingClientRect(), style = getComputedStyle(node);
    return { x: box.x, y: box.y, width: box.width, height: box.height, viewportWidth: innerWidth, viewportHeight: innerHeight, fit: style.objectFit, tag: node.tagName };
  }));
  for (const frame of framing) {
    assert.ok(Math.abs(frame.x) < .1 && Math.abs(frame.y) < .1 && Math.abs(frame.width - frame.viewportWidth) < .1 && Math.abs(frame.height - frame.viewportHeight) < .1, 'The full-bleed PNG and animated canvas share fixed viewport bounds without a screenshot-border inset');
    if (frame.tag === 'IMG') assert.equal(frame.fit, 'cover');
  }
  const filter = await image.evaluate(node => getComputedStyle(node).filter);
  assert.equal(await page.locator('.flowing-water-canvas').evaluate(node => getComputedStyle(node).filter), filter, 'The canvas and still reference share exactly the same colour-only theme treatment');
  if (theme === 'light') assert.equal(filter, 'none', 'Day mode displays the original approved artwork colours');
  else {
    assert.ok(filter.includes('#eco-watercolour-night'), 'Night applies its colour filter to the same visible image');
    const palette = await page.locator('#eco-watercolour-night').evaluate(node => ({
      primitives: [...node.children].map(child => child.localName),
      matrix: node.querySelector('feColorMatrix').getAttribute('values').trim().split(/\s+/).map(Number),
      channels: ['feFuncR', 'feFuncG', 'feFuncB'].map(name => node.querySelector(name).getAttribute('tableValues').trim().split(/\s+/).map(Number)),
      alpha: node.querySelector('feFuncA')?.getAttribute('type'),
    }));
    assert.deepEqual(palette.primitives, ['feColorMatrix', 'feComponentTransfer'], 'Night changes only colour: no replacement scene, blur or displacement');
    assert.equal(palette.matrix.length, 20);
    assert.ok(palette.matrix.every(Number.isFinite));
    assert.deepEqual(palette.matrix.slice(15), [0, 0, 0, 1, 0], 'The night matrix preserves the source alpha');
    assert.deepEqual([palette.matrix[3], palette.matrix[8], palette.matrix[13]], [0, 0, 0], 'Source opacity does not change the night colours');
    assert.equal(palette.alpha, 'identity', 'The final transfer also preserves source alpha');
    assert.ok(palette.channels.every(channel => channel.length === palette.channels[0].length && channel.every(value => Number.isFinite(value) && value >= 0 && value <= 1)));
    const regions = await image.evaluate((image, palette) => {
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const clamp = value => Math.max(0, Math.min(1, value));
      return [[.08, .30], [.39, .63], [.73, .95]].map(([top, bottom]) => {
        const source = [0, 0, 0], sourceSquares = [0, 0, 0], night = [0, 0, 0], squares = [0, 0, 0]; let count = 0;
        for (let y = Math.floor(canvas.height * top); y < canvas.height * bottom; y += 8) {
          for (let x = Math.floor(canvas.width * .1); x < canvas.width * .9; x += 8) {
            const offset = (y * canvas.width + x) * 4, rgb = [0, 1, 2].map(channel => pixels[offset + channel] / 255);
            for (let channel = 0; channel < 3; channel++) {
              const row = palette.matrix.slice(channel * 5, channel * 5 + 5), input = clamp(rgb.reduce((sum, value, index) => sum + value * row[index], row[4]));
              const table = palette.channels[channel], position = input * (table.length - 1), index = Math.min(Math.floor(position), table.length - 2);
              const value = table[index] + (table[index + 1] - table[index]) * (position - index);
              source[channel] += rgb[channel]; sourceSquares[channel] += rgb[channel] ** 2; night[channel] += value; squares[channel] += value * value;
            }
            count++;
          }
        }
        const rgb = night.map(value => value / count);
        const sourceMean = source.map(value => value / count);
        return { source: sourceMean, sourceVariation: sourceSquares.map((value, channel) => Math.sqrt(Math.max(0, value / count - sourceMean[channel] ** 2))), rgb, variation: squares.map((value, channel) => Math.sqrt(Math.max(0, value / count - rgb[channel] ** 2))) };
      });
    }, palette);
    const luminance = channels => channels.map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    for (const region of regions) {
      assert.ok(luminance(region.rgb) < luminance(region.source), 'Each night region is darker than its corresponding day region');
      assert.ok(Math.max(...region.sourceVariation) > .01, 'Each original reference region has measurable source texture');
      assert.ok(Math.max(...region.variation) > Math.max(...region.sourceVariation) * .2, 'Night retains local variation relative to the original subtle source, rather than clipping a region into a flat fill');
    }
    const [plum, copper, blue] = regions.map(region => region.rgb);
    assert.ok(plum[2] > plum[0] * 1.2 && plum[0] > plum[1] * 1.2, 'The upper teal region becomes distinctly plum');
    assert.ok(copper[0] > copper[1] * 1.5 && copper[0] > copper[2] * 1.6, 'The mint middle becomes distinctly copper');
    assert.ok(blue[2] > blue[0] * 1.5 && blue[2] > blue[1] * 1.3, 'The blue lower region remains distinctly dusky blue');
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
  const tagline = await page.locator('.brand-tagline text').evaluate(node => {
    const style = getComputedStyle(node), box = node.getBoundingClientRect(), frame = node.ownerSVGElement.getBoundingClientRect();
    return { text: node.textContent.trim(), stroke: style.stroke, shadow: style.textShadow, size: parseFloat(style.fontSize), weight: Number(style.fontWeight), left: box.left, right: box.right, top: box.top, bottom: box.bottom, frame: { left: frame.left, right: frame.right, top: frame.top, bottom: frame.bottom } };
  });
  assert.equal(tagline.text, 'FRATELLI COSULICH MARINE ENERGY');
  assert.equal(tagline.stroke, 'none', 'The existing tagline has solid letters without an outline in either theme');
  assert.equal(tagline.shadow, 'none');
  assert.equal(tagline.size, 22);
  assert.equal(tagline.weight, 600);
  assert.ok(tagline.left >= tagline.frame.left - 1 && tagline.right <= tagline.frame.right + 1 && tagline.top >= tagline.frame.top - 1 && tagline.bottom <= tagline.frame.bottom + 1, 'The stronger solid tagline fits its existing SVG lockup without clipping');
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
  const canvas = await background.locator('canvas').elementHandle();
  assert.ok(canvas, 'The current decorative canvas exists before pausing');
  const supported = rendererCapabilities.get(page);
  await expect(background).toHaveAttribute('data-flow-state', supported ? 'running' : 'fallback');
  const beforePause = await background.evaluate(node => {
    const canvas = node.querySelector('canvas');
    const state = { renderer: node.dataset.renderer, frame: Number(canvas.dataset.flowFrame || 0), time: Number(canvas.dataset.flowTimeMs || 0) };
    for (const key of ['hidden', 'visibilityState']) {
      if (Object.hasOwn(document, key)) throw new Error(`Unexpected own visibility property: ${key}`);
    }
    Object.defineProperties(document, { hidden: { configurable: true, value: true }, visibilityState: { configurable: true, value: 'hidden' } });
    document.dispatchEvent(new Event('visibilitychange'));
    return state;
  });
  try {
    await expect(background).toHaveAttribute('data-paused', 'true');
    await expect(background).toHaveAttribute('data-flow-state', supported ? 'paused' : 'fallback');
    const paused = await flowState(background);
    assert.equal(paused.renderer, beforePause.renderer, 'Visibility pauses the existing renderer without replacing it with another picture');
    assert.ok(await canvas.evaluate(node => node === document.querySelector('.flowing-water-canvas')), 'Pausing preserves the existing canvas');
    assert.ok(paused.frame >= beforePause.frame && paused.time >= beforePause.time, 'Pausing retains the current phase without restarting the renderer');
    // Start pixel retention evidence at the first confirmed paused frame. A
    // running screenshot can advance during encoding, decoding and transport.
    // The unchanged strict pixel/clock and nonblank checks prove this real
    // running-to-paused transition retains its rendered picture.
    await verifyStillWater(page, background, 'Hidden document');
  } finally {
    await page.evaluate(() => {
      delete document.hidden; delete document.visibilityState;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await canvas.dispose();
  }
  await expect(background).toHaveAttribute('data-paused', 'false');
  if (rendererCapabilities.get(page)) await expect(background).toHaveAttribute('data-flow-state', 'running');
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
      const retainedCanvas = await background.locator('canvas').elementHandle();
      const themeFlow = await flowState(background), themeBounds = await background.locator('canvas').boundingBox();
      const verifyThemeContinuity = async () => {
        assert.ok(await retainedCanvas.evaluate(node => node === document.querySelector('.flowing-water-canvas')), 'Theme changes retain the same animation canvas');
        assert.ok(boxDifference(await background.locator('canvas').boundingBox(), themeBounds) < .1, 'Theme changes preserve the exact animated frame bounds');
        assert.ok((await flowState(background)).time >= themeFlow.time, 'Theme changes never reset the shared animation phase');
      };
      await toggle().click(); await expect(page.locator('html')).toHaveAttribute('data-theme', theme === 'light' ? 'dark' : 'light');
      await expect(toggle()).toHaveAttribute('aria-busy', 'false');
      await verifyArtwork(page, context, theme === 'light' ? 'dark' : 'light', true);
      await verifyThemeContinuity();
      await toggle().click(); await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await verifyArtwork(page, context, theme);
      await verifyThemeContinuity();
      await retainedCanvas.dispose();
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
      await expect(background).toHaveAttribute('data-paused', 'false');
      const internalMotion = await verifyInternalMotion(page, background);
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
          await verifyStillWater(page, background, `${label} workspace`, false);
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
      await readyRenderer(page);
      await expect(background).toHaveAttribute('data-flow-state', 'fallback');
      await verifyStillWater(page, background, 'Reduced motion');
      const reducedImage = await waterImage.boundingBox();
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
      const periodicity = width === 1440 || width === 320 ? await verifyPeriodicFrames(page, background) : { verified: false, reason: 'Same renderer period is exercised at desktop and narrow-phone widths' };
      const contextLoss = width === 1440 || width === 320 ? await verifyContextLossFallback(page, background) : { verified: false, reason: 'Context loss is exercised at desktop and narrow-phone widths' };
      assert.deepEqual(state.writes, expectedWrites);
      assert.deepEqual(locations.requests, [], 'Navigation and theme changes never save shared location data');
      assert.deepEqual(state.harbour, [], 'Flowing Water does not request retired harbour assets');
      assert.ok(state.water.length > 0 && state.water.every(path => path === waterArtwork.path), 'Day and night use exactly the same artwork with no alternate scene requested');
      assert.deepEqual(state.unexpected, []); assert.deepEqual(errors, []);
      results.push({ engine, width, theme, passed: true, geometry, internalMotion, periodicity, contextLoss, nightContrastMinimum, artwork: waterArtwork, hiddenPause: true, signedOut: true, signedIn: true, nonAdminGate: true });
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
