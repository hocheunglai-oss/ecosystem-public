import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { chromium, webkit, expect } from '@playwright/test';
import { installStagingCookies } from './fixtures/protection-cookies.mjs';
import { installSharedLocations } from './fixtures/shared-locations.mjs';
import { WATER_NIGHT_MATRIX, WATER_NIGHT_CHANNELS } from '../src/waterNightPalette.ts';

// Disposable browsers and synthetic authenticated API responses only. All API
// requests are intercepted, including login/logout; no production identity or
// business data is read or changed. Images stay outside the source checkout.
const base = process.env.ECO_FLOWING_UI_ORIGIN || 'http://127.0.0.1:4286';
const out = resolve(process.env.ECO_FLOWING_UI_OUTPUT || `${tmpdir()}/eco-flowing-water-ui`);
const reports = resolve(process.env.ECO_FLOWING_REPORT_OUTPUT || out);
await mkdir(out, { recursive: true });
await mkdir(reports, { recursive: true });
const results = [];
const pauseEvidence = new WeakMap();
const testRequire = createRequire(createRequire(import.meta.url).resolve('@playwright/test'));
const { PNG } = createRequire(testRequire.resolve('playwright'))('playwright-core/lib/utilsBundle');
const originalLogoHash = 'e6fe5111eddff7bd167e8c7d734660d126eaeab9fc63496c7b882ab6af05da88';
const waterArtwork = { path: '/flowing-water-watercolour-poster.jpg', width: 1440, height: 810, hash: 'b66d9f876c074587b33afce458fbb265832967942692a0f093144d104e1494ee' };
const waterVideos = {
  desktop: { path: '/flowing-water-watercolour.mp4', width: 1440, height: 810, hash: '4f3f318280ad48e6bab0bdb9f84c09346a80c413fa1424fcbbaa9e14155143ef' },
  mobile: { path: '/flowing-water-watercolour-mobile.mp4', width: 960, height: 540, hash: '428fd8fd05c42ac5d331e215dc2d2a056ff4b8b964a697d9d8256fb082e3e079' },
};
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
    if (/^\/flowing-water-.*\.(png|jpe?g|mp4|webm)$/.test(path)) state.water.push(path);
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
  // Sample the real compositor screenshot without a second browser image load.
  // This includes the visible night palette and changes no animation clock.
  const image = PNG.sync.read(await page.screenshot({ animations: 'allow' }));
  return plan.points.flatMap(([x, y]) => {
    const offset = (Math.floor(y * image.height / plan.height) * image.width + Math.floor(x * image.width / plan.width)) * 4;
    return [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
  });
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
  await background.locator('img').evaluate(image => image.decode());
  if (!rendererCapabilities.has(page)) {
    const supported = await page.evaluate(() => {
      const probe = document.createElement('canvas');
      const gl = probe.getContext('webgl', { alpha: false, antialias: false, powerPreference: 'low-power' });
      const available = Boolean(gl && !gl.isContextLost());
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
      return available;
    });
    rendererCapabilities.set(page, supported);
    if (process.platform === 'darwin' || process.env.ECO_REQUIRE_WEBGL === '1') assert.ok(supported, 'This verification host must provide WebGL1 to prove the actual night colour pass');
  }
  const supported = rendererCapabilities.get(page), reduced = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const night = await page.locator('html').getAttribute('data-theme') === 'dark';
  const mode = !reduced && (!night || supported) ? 'video' : 'fallback';
  await expect(background).toHaveAttribute('data-renderer', mode, { timeout: 30000 });
  const image = background.locator('img');
  await expect(background.locator('.flowing-water-canvas')).toHaveCount(0);
  if (mode === 'video') {
    const video = background.locator('video.flowing-water-video');
    await expect(image).toBeHidden(); await expect(video).toHaveCount(1);
    assert.ok(await video.evaluate(node => node.readyState >= 2 && node.muted && node.loop && node.playsInline && !node.controls));
    assert.equal(await video.getAttribute('data-flow-period-ms'), '6000');
    if (night) {
      await expect(background).toHaveAttribute('data-night-ready', 'true');
      await expect(background.locator('.flowing-water-video-palette')).toHaveCSS('opacity', '1');
    } else await expect(video).toHaveCSS('opacity', '1');
  } else {
    await expect(image).toBeVisible();
    if (night) {
      const still = background.locator('.flowing-water-night-still');
      await expect(still).toHaveAttribute('data-ready', 'true', { timeout: 15000 });
      await expect(still).toHaveCSS('opacity', '1');
    } else await expect(image).toHaveCSS('opacity', '1');
    if (reduced) await expect(background.locator('video')).toHaveCount(0);
  }
  return { supported, reduced, mode };
}
const flowState = background => background.evaluate(node => {
  const video = node.querySelector('video.flowing-water-video');
  return { renderer: node.dataset.renderer, state: node.dataset.flowState,
    time: node.dataset.renderer === 'video' ? video.currentTime * 1000 : 0,
    period: video ? Number(video.dataset.flowPeriodMs) : 6000 };
});
async function verifyStillWater(page, background, label, inspectPixels = true) {
  await expect.poll(async () => (await flowState(background)).state !== 'running').toBe(true);
  assert.ok((await animationState(background)).every(animation => animation.state !== 'running'), `${label}: no CSS water motion continues`);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  if (await background.getAttribute('data-renderer') === 'video') {
    // A pause can coincide with the native loop seek. Finish only that bounded
    // readiness transition before taking the immutable paused-time baseline.
    await expect.poll(() => background.locator('video.flowing-water-video').evaluate(node => ({ paused: node.paused, seeking: node.seeking })),
      { timeout: 1000, message: `${label}: native paused frame is no longer seeking` }).toEqual({ paused: true, seeking: false });
  }
  const before = await flowState(background), bounds = await background.boundingBox();
  const video = before.renderer === 'video' ? await background.locator('video.flowing-water-video').elementHandle() : null;
  const nativeState = async () => video ? video.evaluate(node => {
    const quality = node.getVideoPlaybackQuality?.();
    return { time: node.currentTime, paused: node.paused, seeking: node.seeking, source: node.getAttribute('src'), currentSrc: node.currentSrc,
      readyState: node.readyState, decoded: node.webkitDecodedFrameCount,
      totalFrames: quality?.totalVideoFrames, droppedFrames: quality?.droppedVideoFrames,
      frames: node.__ecoPauseTrace?.frames ?? [], events: node.__ecoPauseTrace?.events ?? [] };
  }) : null;
  const initial = await nativeState(), samples = [];
  const { engine, width, theme, checks } = pauseEvidence.get(page);
  const captureReadinessBudgetMs = 5000;
  const diagnostics = { engine, width, theme, label, before, initial, samples, captureReadinessBudgetMs, holdSamples: 3, holdIntervalMs: 250 };
  const invariant = async () => {
    assert.deepEqual(await flowState(background), before, `${label}: the displayed video time stays frozen`);
    assert.ok(boxDifference(await background.boundingBox(), bounds) < .1, `${label}: framing stays fixed`);
    if (video) {
      assert.ok(await video.evaluate(node => node === document.querySelector('video.flowing-water-video')), `${label}: the same media node is retained`);
      const actual = await nativeState();
      assert.equal(actual.paused, true, `${label}: native playback remains paused`);
      assert.equal(actual.seeking, false, `${label}: native playback cannot seek`);
      for (const key of ['time', 'source', 'currentSrc']) assert.equal(actual[key], initial[key], `${label}: exact native ${key} stays frozen`);
      return actual;
    }
    return null;
  };
  try {
    await invariant();
    if (!inspectPixels) { await page.waitForTimeout(250); await invariant(); diagnostics.passed = true; return; }
    const plan = await waterPixelPlan(page);
    const capture = async (kind, reference) => {
      const sample = { kind, startedAtMs: performance.now(), before: await nativeState() }; samples.push(sample);
      await invariant();
      sample.captureStartedAtMs = performance.now();
      const pixels = await waterPixels(page, plan);
      sample.finishedAtMs = performance.now(); sample.screenshotCallMs = sample.finishedAtMs - sample.captureStartedAtMs;
      sample.after = await nativeState();
      if (reference) sample.difference = pixelDifference(reference, pixels);
      await invariant(); verifyVisibleWaterPixels(pixels, label);
      return pixels;
    };
    const stable = difference => difference.mean <= .05 && difference.maximum <= 1;
    // pause() freezes the native clock before its final queued frame necessarily
    // reaches the compositor. This fixed capture/readiness budget includes at
    // least three screenshots, PNG sampling and browser round trips on CI; it
    // never permits the original clock/node/source/paused state to change.
    const started = performance.now(), deadline = started + captureReadinessBudgetMs;
    let baseline = await capture('initial');
    if (video) {
      let consecutive = 0;
      while (consecutive < 2) {
        assert.ok(performance.now() < deadline, `${label}: stable presentation captures must complete within ${captureReadinessBudgetMs}ms`);
        const next = await capture('settling', baseline), difference = samples.at(-1).difference;
        assert.ok(performance.now() <= deadline, `${label}: stable presentation captures must complete within ${captureReadinessBudgetMs}ms`);
        consecutive = stable(difference) ? consecutive + 1 : 0;
        baseline = next;
      }
    }
    diagnostics.baselineAcceptedMs = performance.now() - started;
    // Each independent hold compares to the one accepted baseline, so small
    // cumulative changes or a decoder that resumes cannot disappear in retries.
    for (let index = 0; index < 3; index++) {
      await page.waitForTimeout(250);
      await capture('hold', baseline);
      const difference = samples.at(-1).difference;
      assert.ok(stable(difference), `${label}: the displayed background pixels stay still (${JSON.stringify(difference)})`);
    }
    diagnostics.passed = true;
  } catch (error) {
    diagnostics.passed = false; diagnostics.error = error.message;
    throw error;
  } finally {
    const filename = `pause-${engine}-${width}-${theme}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`;
    const summary = { engine, width, theme, label, passed: diagnostics.passed, report: filename,
      captureReadinessBudgetMs, baselineAcceptedMs: diagnostics.baselineAcceptedMs,
      initialNativeTime: initial?.time, holdSamples: diagnostics.holdSamples, holdIntervalMs: diagnostics.holdIntervalMs,
      samples: samples.map(({ kind, screenshotCallMs, difference }) => ({ kind, screenshotCallMs, difference })),
      ...(diagnostics.error ? { error: diagnostics.error } : {}) };
    checks.push(summary);
    try {
      // Report output is collected by CI even when screenshots use runner.temp.
      // Keep successful timings compact; retain full native/event traces on failure.
      await writeFile(`${reports}/${filename}`, JSON.stringify(diagnostics.passed ? summary : diagnostics, null, 2));
    } finally { await video?.dispose(); }
  }
}
async function verifyInternalMotion(page, background) {
  const capability = await readyRenderer(page), video = background.locator('video.flowing-water-video');
  const imageBox = () => background.locator('img').evaluate(node => { const box = node.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height }; });
  const stationary = await contentPositions(page), bounds = await background.boundingBox(), imageBounds = await imageBox();
  assert.equal((await animationState(background)).length, 0, 'No panning image, moving sheen or other CSS motion can masquerade as internal flow');
  assert.equal(await video.evaluate(node => getComputedStyle(node).transform), 'none', 'The supplied video is never translated or zoomed');
  const plan = await waterPixelPlan(page), first = await waterPixels(page, plan), changes = [];
  let previous = await flowState(background), elapsed = 0, wraps = 0;
  if (capability.mode === 'video') await expect(background).toHaveAttribute('data-flow-state', 'running');
  // Real wall-clock compositor proof: no mocked clock, seeking, playback-rate
  // changes, hidden elements or altered pixels participate in these samples.
  for (let sample = 0; sample < 8; sample++) {
    await page.waitForTimeout(500);
    changes.push(pixelDifference(first, await waterPixels(page, plan)));
    const next = await flowState(background);
    if (next.time < previous.time - 1000 / 30) wraps++;
    const delta = next.time - previous.time;
    elapsed += delta < 0 && delta >= -1000 / 30 - .001 ? 0 : (delta + next.period) % next.period;
    previous = next;
    assert.ok(boxDifference(await background.boundingBox(), bounds) < .1, 'Internal flow never pans or zooms its frame');
    assert.ok(boxDifference(await imageBox(), imageBounds) < .1, 'The matching fallback image keeps fixed framing');
    const contentAfter = await contentPositions(page);
    assert.equal(contentAfter.length, stationary.length);
    for (let index = 0; index < stationary.length; index++) assert.ok(boxDifference(contentAfter[index], stationary[index]) < .1, `Water never moves ${stationary[index].name}`);
  }
  const strongest = changes.reduce((best, item) => item.mean > best.mean ? item : best);
  if (capability.mode === 'video') {
    assert.ok(elapsed > 3500, 'The real decoded video clock advances across native loop wraps');
    assert.ok(strongest.mean > .15 && strongest.changedFraction > .01, `Visible water pixels change inside the stationary frame (${JSON.stringify(strongest)})`);
  } else {
    assert.equal(elapsed, 0, 'Unsupported night graphics keeps the matching still fallback');
    assert.ok(strongest.mean <= .05 && strongest.maximum <= 1, 'Unsupported graphics still renders a stable usable image');
  }
  return { capability, difference: strongest, elapsed, wraps, fixedBounds: true, actualMovementVerified: capability.mode === 'video' };
}
async function verifyPeriodicFrames(page, background) {
  await page.goto('about:blank');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.access-login')).toBeVisible();
  await readyRenderer(page);
  // Observe native playback without seeking or changing its source/rate. Read
  // pixels only near the boundary; retain callback timing across the full loop.
  const video = background.locator('video.flowing-water-video');
  const evidence = await video.evaluate(video => new Promise(resolve => {
    const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 54;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const source = video.currentSrc, period = video.duration, steps = [], wraps = [], gaps = [];
    const started = performance.now(), frameSeconds = 1 / 30, observationBudgetMs = 24500;
    let previous, request = 0, samples = 0, done = false;
    const native = typeof video.requestVideoFrameCallback === 'function';
    const classifyStep = step => {
      const closelySampled = step.delta > frameSeconds / 2 && step.delta <= frameSeconds * 3 + 1e-6
        && step.wallSeconds > 0 && step.wallSeconds <= .15
        && (!native || Number.isInteger(step.presentedFramesDelta) && step.presentedFramesDelta >= 1 && step.presentedFramesDelta <= 3
          && Math.abs(step.delta - step.presentedFramesDelta * frameSeconds) <= 1e-6
          && step.displaySeconds > 0 && step.displaySeconds <= .1 + 1e-6);
      if (closelySampled) return 'closely-sampled';
      // A missed callback is proven only when compositor frame counts explain
      // the media advance and both display and wall clocks agree. A media jump
      // with only one presented frame, or an unexplained stall, cannot pass.
      const missed = native && step.presentedFramesDelta > 1
        && Math.abs(step.delta - step.presentedFramesDelta * frameSeconds) <= frameSeconds + 1e-6
        && step.displaySeconds > 0 && step.wallSeconds > 0
        && Math.abs(step.displaySeconds - step.delta) <= .1
        && Math.abs(step.wallSeconds - step.displaySeconds) <= .2;
      return missed ? 'missed-callbacks' : 'unexplained-gap';
    };
    const seams = () => wraps.filter(wrap => wrap.stepIndex !== null).map(wrap => ({
      seam: steps[wrap.stepIndex],
      adjacent: steps.slice(Math.max(0, wrap.stepIndex - 3), wrap.stepIndex + 4)
        .filter((step, offset) => Math.max(0, wrap.stepIndex - 3) + offset !== wrap.stepIndex && step.cycle === wrap.cycle),
    })).filter(({ seam, adjacent }) => adjacent.length >= 3 && adjacent.filter(step => step.from < .3 && step.to < .3 && step !== seam).length >= 3);
    const finish = error => {
      if (done) return; done = true; clearTimeout(timer);
      if (native) video.cancelVideoFrameCallback(request); else cancelAnimationFrame(request);
      resolve({ period, source, samples, callback: native ? 'requestVideoFrameCallback' : 'requestAnimationFrame',
        observationMs: performance.now() - started, observationBudgetMs, maximumWraps: 4,
        wraps, gaps, seams: seams(), ...(error ? { error } : {}),
        final: { currentTime: video.currentTime, paused: video.paused, readyState: video.readyState, currentSrc: video.currentSrc },
        maximumStep: steps.length ? Math.max(...steps.map(step => step.mean)) : 0,
        meanStep: steps.length ? steps.reduce((sum, step) => sum + step.mean, 0) / steps.length : 0 });
    };
    // Four six-second cycles plus a bounded tail for the final neighbours.
    const timer = setTimeout(() => finish('Two qualified natural boundaries were not observed within 24.5 seconds'), observationBudgetMs);
    const sample = (now, metadata) => {
      if (done) return;
      try {
        if (video !== document.querySelector('video.flowing-water-video') || video.currentSrc !== source || video.paused || video.playbackRate !== 1) {
          finish('Native loop changed media node/source, paused or changed speed'); return;
        }
        const current = { time: metadata?.mediaTime ?? video.currentTime, now,
          presentedFrames: metadata?.presentedFrames, expectedDisplayTime: metadata?.expectedDisplayTime,
          presentationTime: metadata?.presentationTime, nativeTime: video.currentTime };
        if (!previous || Math.abs(current.time - previous.time) > 1e-6) {
          const crossing = previous && current.time < previous.time - period / 2;
          let timing, status;
          if (previous) {
            timing = { from: previous.time, to: current.time, delta: (current.time - previous.time + period) % period,
              wallSeconds: (now - previous.now) / 1000,
              displaySeconds: native ? (current.expectedDisplayTime - previous.expectedDisplayTime) / 1000 : null,
              presentedFramesDelta: native ? current.presentedFrames - previous.presentedFrames : null };
            status = classifyStep(timing);
            if (status !== 'closely-sampled') gaps.push({ ...timing, status,
              before: { ...previous, pixels: undefined }, after: { ...current }, crossing: Boolean(crossing) });
          }
          // Never compare a newly sampled boundary frame with stale pixels from
          // another part of the loop. Missing observations remain unavailable.
          const inWindow = current.time > period - .3 || current.time < .3;
          if (inWindow) {
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            current.pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          }
          let stepIndex = null;
          if (previous?.pixels && current.pixels && status === 'closely-sampled') {
            let total = 0;
            for (let i = 0; i < current.pixels.length; i += 4) total += Math.abs(current.pixels[i] - previous.pixels[i]) + Math.abs(current.pixels[i + 1] - previous.pixels[i + 1]) + Math.abs(current.pixels[i + 2] - previous.pixels[i + 2]);
            const mean = total / (canvas.width * canvas.height * 3);
            stepIndex = steps.length;
            steps.push({ ...timing, mean, rate: mean / Math.max(timing.delta, frameSeconds), cycle: crossing ? wraps.length : Math.max(0, wraps.length - (current.time < .3 ? 1 : 0)) });
          }
          if (crossing) wraps.push({ cycle: wraps.length, ...timing, stepIndex,
            status: stepIndex === null ? status === 'missed-callbacks' ? status : 'boundary-pixels-unavailable' : 'sampled' });
          previous = current; samples++;
          // Off-boundary timing gaps are recorded, not a new global cadence SLA.
          // An unobserved boundary itself cannot be excused without proof.
          if (crossing && status === 'unexplained-gap') { finish('Boundary gap lacks consistent compositor frame and clock evidence'); return; }
        }
        if (seams().length >= 2) { finish(); return; }
        if (wraps.length >= 4 && current.time >= .3) { finish('Four natural wraps did not provide two qualified boundary observations'); return; }
        request = native ? video.requestVideoFrameCallback(sample) : requestAnimationFrame(sample);
      } catch (error) { finish(error.message); }
    };
    request = native ? video.requestVideoFrameCallback(sample) : requestAnimationFrame(sample);
  }));
  const { engine, width, theme } = pauseEvidence.get(page);
  const report = `loop-${engine}-${width}-${theme}.json`;
  pauseEvidence.get(page).loopDiagnostics = { report, ...evidence };
  // Persist native timing and all observed/missed wraps before any assertion.
  await writeFile(`${reports}/${report}`, JSON.stringify({ engine, width, theme, ...evidence }, null, 2));
  assert.equal(evidence.error, undefined, `Native loop observation failed: ${evidence.error}; see ${report}`);
  assert.ok(Math.abs(evidence.period - 6) < 1 / 30, 'The exact supplied video retains its six-second loop');
  assert.ok(evidence.samples > 100 && evidence.wraps.length >= 2 && evidence.seams.length >= 2, 'Native decoding presented moving frames through two qualified real wraps');
  assert.ok(evidence.maximumStep > .15 && evidence.meanStep > .01, 'Loop evidence cannot pass on a frozen or blank video');
  for (const { seam, adjacent } of evidence.seams) {
    assert.ok(seam.from > evidence.period - .3 && seam.to < .3, `The player crosses the actual encoded boundary: ${JSON.stringify(seam)}`);
    assert.ok(adjacent.length >= 3, 'Loop comparison includes independently decoded neighbouring frames');
    assert.ok(seam.rate <= Math.max(...adjacent.map(step => step.rate)) * 3 + 4, `The decoded boundary has no anomalous jump relative to neighbouring motion: ${JSON.stringify({ seam, adjacent })}`);
  }
  return { verified: true, report, ...evidence, provenance: 'Unmodified native playback, decoded source pixels at two natural wraps sampled at most three frames (100ms) apart; positively identified missed callbacks are recorded, never treated as measured seams. Separate real-compositor motion and pause checks remain in this suite.' };
}
async function verifyContextLossFallback(page, background) {
  if (!rendererCapabilities.get(page)) return { verified: false, reason: 'WebGL1 unavailable; initial night fallback verified' };
  const initialTheme = await page.locator('html').getAttribute('data-theme');
  const control = page.locator('.home-display-controls').getByRole('switch', { name: 'Dark mode', exact: true });
  if (initialTheme !== 'dark') await control.click();
  await readyRenderer(page);
  const available = await background.locator('.flowing-water-video-palette').evaluate(node => {
    const gl = node.getContext('webgl'), extension = gl?.getExtension('WEBGL_lose_context');
    if (!extension) return false;
    extension.loseContext(); return true;
  });
  assert.ok(available, 'The supported palette renderer exposes deterministic context loss');
  await expect(background).toHaveAttribute('data-renderer', 'fallback');
  await expect(background).toHaveAttribute('data-flow-state', 'fallback');
  await expect(background.locator('img')).toBeVisible();
  await expect(background.locator('.flowing-water-night-still')).toHaveAttribute('data-ready', 'true');
  await expect(background.locator('.flowing-water-night-still')).toHaveCSS('opacity', '1');
  assert.equal(await background.locator('.flowing-water-video-palette').evaluate(node => getComputedStyle(node).opacity), '0');
  await verifyStillWater(page, background, 'Lost night graphics context');
  if (initialTheme !== 'dark') await control.click();
  return { verified: true, originalStillImageVisible: true, exactNightStillVisible: true };
}
async function verifyArtwork(page, context, theme, verifyBytes = false) {
  const expected = waterArtwork, image = page.locator('.flowing-water-image');
  await expect(image).toHaveCount(1);
  await expect(image).toHaveAttribute('src', expected.path);
  await readyRenderer(page);
  await expect.poll(() => image.evaluate((image, expected) => image.complete && image.naturalWidth === expected.width && image.naturalHeight === expected.height && new URL(image.currentSrc).pathname === expected.path, expected)).toBe(true);
  const framing = await page.locator('.flowing-water-image,.flowing-water-video,.flowing-water-video-palette').evaluateAll(nodes => nodes.map(node => {
    const box = node.getBoundingClientRect(), style = getComputedStyle(node);
    return { x: box.x, y: box.y, width: box.width, height: box.height, viewportWidth: innerWidth, viewportHeight: innerHeight, fit: style.objectFit, tag: node.tagName };
  }));
  for (const frame of framing) {
    assert.ok(Math.abs(frame.x) < .1 && Math.abs(frame.y) < .1 && Math.abs(frame.width - frame.viewportWidth) < .1 && Math.abs(frame.height - frame.viewportHeight) < .1, 'The supplied poster, video and night pass share fixed viewport bounds without a screenshot-border inset');
    if (frame.tag === 'IMG') assert.equal(frame.fit, 'cover');
  }
  const filters = await page.locator('.flowing-water-image,.flowing-water-video,.flowing-water-video-palette,.flowing-water-night-still').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).filter));
  assert.ok(filters.length >= 3 && filters.every(filter => filter === 'none'), 'No media layer relies on SVG fragment filters that mobile WebKit drops');
  if (theme === 'dark') {
    const palette = { matrix: [...WATER_NIGHT_MATRIX], channels: WATER_NIGHT_CHANNELS.map(channel => [...channel]) };
    assert.deepEqual(palette.matrix, [-0.315127,4.299968,-1.352730,0,-1.626157,0.626944,1.519584,0.002427,0,-0.794092,0.386135,-3.250374,1.438371,0,1.762207,0,0,0,1,0], 'The approved night colour mapping is retained exactly');
    assert.deepEqual(palette.channels, [[.035,.540],[.025,.300],[.065,.440]], 'The approved three-tone channel ranges are retained exactly');
    assert.equal(palette.matrix.length, 20);
    assert.ok(palette.matrix.every(Number.isFinite));
    assert.deepEqual(palette.matrix.slice(15), [0, 0, 0, 1, 0], 'The night matrix preserves the source alpha');
    assert.deepEqual([palette.matrix[3], palette.matrix[8], palette.matrix[13]], [0, 0, 0], 'Source opacity does not change the night colours');
    assert.ok(palette.channels.every(channel => channel.length === palette.channels[0].length && channel.every(value => Number.isFinite(value) && value >= 0 && value <= 1)));
    const still = page.locator('.flowing-water-night-still');
    await expect(still).toHaveAttribute('data-ready', 'true', { timeout: 15000 });
    const exactStill = await image.evaluate((image, palette) => {
      const source = document.createElement('canvas'); source.width = image.naturalWidth; source.height = image.naturalHeight;
      // Use the same CPU JPEG decode surface; GPU YUV conversion can round
      // source channels differently before the independent palette calculation.
      const context = source.getContext('2d', { willReadFrequently: true }); context.drawImage(image, 0, 0);
      const before = context.getImageData(0, 0, source.width, source.height).data;
      const still = document.querySelector('.flowing-water-night-still');
      const after = still.getContext('2d').getImageData(0, 0, still.width, still.height).data;
      let maximum = 0, alphaMismatch = 0, samples = 0;
      for (let y = 0; y < source.height; y += 13) for (let x = 0; x < source.width; x += 13) {
        const offset = (y * source.width + x) * 4, rgb = [0, 1, 2].map(channel => before[offset + channel] / 255);
        for (let channel = 0; channel < 3; channel++) {
          const row = palette.matrix.slice(channel * 5, channel * 5 + 5), [low, high] = palette.channels[channel];
          const mapped = Math.max(0, Math.min(1, row[4] + rgb.reduce((sum, value, index) => sum + value * row[index], 0)));
          maximum = Math.max(maximum, Math.abs(after[offset + channel] - Math.round((low + (high - low) * mapped) * 255)));
        }
        if (after[offset + 3] !== before[offset + 3]) alphaMismatch++;
        samples++;
      }
      return { width: still.width, height: still.height, maximum, alphaMismatch, samples };
    }, palette);
    assert.equal(exactStill.width, expected.width); assert.equal(exactStill.height, expected.height);
    assert.ok(exactStill.samples > 1000 && exactStill.maximum <= 1, `The actual fallback canvas applies only the exact approved palette (${JSON.stringify(exactStill)})`);
    assert.equal(exactStill.alphaMismatch, 0, 'The actual still transfer preserves source alpha');
    const plan = await waterPixelPlan(page);
    let actual;
    await expect.poll(async () => {
      actual = await waterPixels(page, plan);
      return actual.reduce((sum, value) => sum + value, 0) / actual.length;
    }, { timeout: 15000, message: 'Actual night artwork reached the compositor' }).toBeLessThan(100);
    verifyVisibleWaterPixels(actual, 'Actual night artwork');
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
    assert.ok(response.headers()['content-type']?.includes('image/jpeg'), 'Artwork is served as an image, never the application HTML fallback');
    assert.equal(createHash('sha256').update(await response.body()).digest('hex'), expected.hash, 'The supplied matching poster is served unchanged for this theme');
    const video = waterVideos[await page.evaluate(() => innerWidth < 760) ? 'mobile' : 'desktop'];
    const videoResponse = await context.request.get(new URL(video.path, base).href);
    assert.equal(videoResponse.status(), 200);
    assert.ok(videoResponse.headers()['content-type']?.includes('video/mp4'), 'The supplied movie is served as MP4, never application HTML');
    assert.equal(createHash('sha256').update(await videoResponse.body()).digest('hex'), video.hash, 'The selected supplied video bytes are unchanged');
    if (await page.locator('video.flowing-water-video').count()) {
      const actual = await page.locator('video.flowing-water-video').evaluate(node => ({ width: node.videoWidth, height: node.videoHeight, source: new URL(node.currentSrc).pathname }));
      assert.deepEqual(actual, { width: video.width, height: video.height, source: video.path });
    }
  }
}
async function originalLogoColours(page) {
  const logo = page.locator('.ecosystem-logo > svg');
  await expect(logo).toHaveAttribute('role', 'img');
  await expect(logo).toHaveAttribute('aria-label', 'ECOSYSTEM');
  await expect(logo).toHaveAttribute('viewBox', '0 0 1712 222');
  const layers = await logo.locator('image').evaluate(node => {
    const layers = [];
    for (let layer = node; layer; layer = layer.parentElement) {
      const style = getComputedStyle(layer);
      layers.push({ tag: layer.tagName, filter: style.filter, opacity: style.opacity, blend: style.mixBlendMode });
    }
    return layers;
  });
  assert.ok(layers.every(layer => layer.filter === 'none' && layer.opacity === '1' && layer.blend === 'normal'), `The original white/green E/F logo is never recoloured with the water: ${JSON.stringify(layers)}`);
  assert.equal(await logo.locator('mask, clipPath, [data-logo-energy-gap]').count(), 0, 'The recognizable original E/F mark has no stripe cutouts');
  assert.equal(await logo.locator('image').getAttribute('mask'), null, 'The original solid green lower bar stays unmasked');
  assert.equal(await logo.locator('image').evaluate(node => getComputedStyle(node).clipPath), 'none', 'The original white lettering and green bar are not clipped');
  const tagline = await page.locator('.brand-tagline text').evaluate(node => {
    const style = getComputedStyle(node), box = node.getBoundingClientRect(), frame = node.ownerSVGElement.getBoundingClientRect();
    return { text: node.textContent.trim(), fill: style.fill, stroke: style.stroke, shadow: style.textShadow, size: parseFloat(style.fontSize), weight: Number(style.fontWeight), left: box.left, right: box.right, top: box.top, bottom: box.bottom, frame: { left: frame.left, right: frame.right, top: frame.top, bottom: frame.bottom } };
  });
  assert.equal(tagline.text, 'FRATELLI COSULICH MARINE ENERGY');
  assert.equal(tagline.fill, 'rgb(255, 255, 255)', 'The existing tagline stays white in both themes');
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
  // The native video and matching poster use the same canonical colour map,
  // already checked against actual pixels above. Its channel maxima bound every
  // frame conservatively, even when the brightest channels do not coincide.
  // No removed overlay may silently change that contrast bound.
  await expect(page.locator('.flowing-water-sheen,.flowing-water-shade')).toHaveCount(0);
  const backdrop = WATER_NIGHT_CHANNELS.map(channel => Math.max(...channel));
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
    assert.ok(contrast >= 4.5, `${token}: unboxed night text remains at least 4.5:1 across the brightest possible mapped video or poster (${contrast.toFixed(2)}:1)`);
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
    assert.ok(contrast >= 4.5, `${style.label} ${state}: night text remains at least 4.5:1 over the brightest possible mapped video or poster (${contrast.toFixed(2)}:1)`);
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
  // Exercise the browser visibility signal without changing host-window focus.
  const video = await background.locator('video.flowing-water-video').elementHandle();
  assert.ok(video, 'The current supplied video exists before pausing');
  const beforePause = await flowState(background);
  await video.evaluate(node => {
    const trace = { frames: [], events: [] }; node.__ecoPauseTrace = trace;
    const record = event => { trace.events.push({ type: event.type, at: performance.now(), time: node.currentTime, paused: node.paused }); if (trace.events.length > 24) trace.events.shift(); };
    const types = ['pause', 'playing', 'seeking', 'seeked', 'ended', 'timeupdate'];
    for (const type of types) node.addEventListener(type, record);
    let request = 0;
    const frame = (now, metadata) => {
      trace.frames.push({ at: now, mediaTime: metadata.mediaTime, presentedFrames: metadata.presentedFrames, expectedDisplayTime: metadata.expectedDisplayTime });
      if (trace.frames.length > 24) trace.frames.shift();
      request = node.requestVideoFrameCallback(frame);
    };
    if (node.requestVideoFrameCallback) request = node.requestVideoFrameCallback(frame);
    node.__ecoStopPauseTrace = () => { if (request) node.cancelVideoFrameCallback(request); for (const type of types) node.removeEventListener(type, record); delete node.__ecoStopPauseTrace; };
  });
  await page.evaluate(() => {
    for (const key of ['hidden', 'visibilityState']) if (Object.hasOwn(document, key)) throw new Error(`Unexpected own visibility property: ${key}`);
    Object.defineProperties(document, { hidden: { configurable: true, value: true }, visibilityState: { configurable: true, value: 'hidden' } });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  try {
    await expect(background).toHaveAttribute('data-paused', 'true');
    await expect.poll(() => video.evaluate(node => node.paused)).toBe(true);
    const paused = await flowState(background);
    assert.equal(paused.renderer, beforePause.renderer, 'Visibility pauses the existing media without replacing its picture');
    assert.ok(await video.evaluate(node => node === document.querySelector('video.flowing-water-video')), 'Pausing preserves the existing media node');
    const delta = paused.time - beforePause.time;
    // A native 30fps decoder may report one frame just behind its last sample.
    // Preserve the strict phase bound without treating that correction as a loop.
    const forward = delta < 0 && delta >= -1000 / 30 - .001 ? 0 : (delta + paused.period) % paused.period;
    assert.ok(forward < 1000, 'Pausing retains the current phase, including a natural boundary wrap');
    await verifyStillWater(page, background, 'Hidden document');
  } finally {
    await video.evaluate(node => node.__ecoStopPauseTrace?.());
    await page.evaluate(() => { delete document.hidden; delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')); });
    await video.dispose();
  }
  await expect(background).toHaveAttribute('data-paused', 'false');
  if (beforePause.renderer === 'video') await expect(background).toHaveAttribute('data-flow-state', 'running');
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
      if (location.protocol === 'http:' || location.protocol === 'https:') {
        localStorage.setItem('ecosystem.theme.v1', value);
        localStorage.setItem('ecosystem.background.v1', 'watercolour');
      }
    }, theme);
    const page = await context.newPage(), errors = [], pauseChecks = [];
    pauseEvidence.set(page, { engine, width, theme, checks: pauseChecks });
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
    const toggle = () => page.locator('.home-display-controls').getByRole('switch', { name: 'Dark mode', exact: true, includeHidden: true });
    try {
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('.immersive-app')).toHaveAttribute('data-design', 'flowing-water', { timeout: 20000 });
      await expect(page.locator('.access-login')).toBeVisible();
      assert.deepEqual(await page.locator('.access-login label').evaluateAll(nodes => nodes.map(node => node.textContent.trim())), ['Email', 'Password'], 'Sign-in retains only existing form labels');
      await expect(page.locator('.marine-world, .mobile-harbour-background')).toHaveCount(0);
      await expect(background).toBeVisible();
      const waterImage = background.locator('img');
      await verifyArtwork(page, context, theme, true);
      await expect(page.locator('.world-launcher')).toHaveCount(0);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(toggle()).toHaveAttribute('aria-checked', String(theme === 'dark'));
      const logo = page.locator('.ecosystem-logo svg image');
      await expect(logo).toHaveAttribute('href', '/logo-transparent.png');
      const logoSize = await logo.evaluate(async node => {
        const image = new Image(); image.src = node.href.baseVal; await image.decode();
        return { width: image.naturalWidth, height: image.naturalHeight, renderedWidth: node.width.baseVal.value, renderedHeight: node.height.baseVal.value };
      });
      assert.deepEqual(logoSize, { width: 1712, height: 222, renderedWidth: 1712, renderedHeight: 222 });
      const logoResponse = await context.request.get(new URL('/logo-transparent.png', base).href);
      assert.equal(createHash('sha256').update(await logoResponse.body()).digest('hex'), originalLogoHash, 'Original E/F logo pixels retained');
      await originalLogoColours(page);
      await page.getByLabel('Email', { exact: true }).fill(member.email);
      await page.getByLabel('Password', { exact: true }).fill('Synthetic Password 8');
      assert.ok((await page.locator('.access-login input').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).textTransform))).every(value => value === 'none'), 'Email and password case must remain exact');
      await shot('signed-out');
      // Broken/absent old harbour artwork must never block theme switching.
      const retainedVideo = await background.locator('video.flowing-water-video').elementHandle();
      const themeBounds = await background.locator('video.flowing-water-video').boundingBox();
      let themeFlow = await retainedVideo.evaluate(node => ({ time: node.currentTime, duration: node.duration, source: node.currentSrc, at: performance.now() }));
      const verifyThemeContinuity = async () => {
        assert.ok(await retainedVideo.evaluate(node => node === document.querySelector('video.flowing-water-video')), 'Theme changes retain the same supplied media element');
        assert.ok(boxDifference(await background.locator('video.flowing-water-video').boundingBox(), themeBounds) < .1, 'Theme changes preserve the exact animated frame bounds');
        const next = await retainedVideo.evaluate(node => ({ time: node.currentTime, duration: node.duration, source: node.currentSrc, at: performance.now() }));
        assert.equal(next.source, themeFlow.source, 'Theme changes retain the exact supplied video source');
        const delta = next.time - themeFlow.time;
        const forward = delta < 0 && delta >= -1 / 30 - 1e-6 ? 0 : (delta + next.duration) % next.duration;
        assert.ok(forward <= (next.at - themeFlow.at) / 1000 + .25, 'Theme changes preserve native playback phase across natural loops');
        themeFlow = next;
      };
      await toggle().click(); await expect(page.locator('html')).toHaveAttribute('data-theme', theme === 'light' ? 'dark' : 'light');
      await expect(toggle()).toHaveAttribute('aria-checked', String(theme === 'light'));
      await expect(toggle()).toHaveAttribute('aria-busy', 'false');
      await verifyArtwork(page, context, theme === 'light' ? 'dark' : 'light', true);
      await verifyThemeContinuity();
      await toggle().click(); await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(toggle()).toHaveAttribute('aria-checked', String(theme === 'dark'));
      await verifyArtwork(page, context, theme);
      await verifyThemeContinuity();
      await retainedVideo.dispose();
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
      const reducedPlan = await waterPixelPlan(page), reducedPixels = await waterPixels(page, reducedPlan);
      const reducedArtworkStyle = await waterImage.evaluate(node => { const style = getComputedStyle(node); return { fit: style.objectFit, position: style.objectPosition, filter: style.filter }; });
      await toggle().focus(); await toggle().press('Enter');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme === 'light' ? 'dark' : 'light');
      await verifyArtwork(page, context, theme === 'light' ? 'dark' : 'light');
      const oppositeArtworkStyle = await waterImage.evaluate(node => { const style = getComputedStyle(node); return { fit: style.objectFit, position: style.objectPosition, filter: style.filter }; });
      assert.ok(boxDifference(await waterImage.boundingBox(), reducedImage) < 0.1, 'Theme changes preserve the exact still-image position and size');
      assert.equal(oppositeArtworkStyle.fit, reducedArtworkStyle.fit);
      assert.equal(oppositeArtworkStyle.position, reducedArtworkStyle.position);
      assert.equal(oppositeArtworkStyle.filter, 'none'); assert.equal(reducedArtworkStyle.filter, 'none');
      await expect.poll(async () => pixelDifference(reducedPixels, await waterPixels(page, reducedPlan)).mean, { timeout: 15000 }).toBeGreaterThan(20); // Real colour change, same original source and frame.
      await expect(toggle()).toBeFocused(); await toggle().press('Enter');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await verifyArtwork(page, context, theme);
      assert.ok(boxDifference(await waterImage.boundingBox(), reducedImage) < 0.1, 'Returning to the initial theme preserves artwork geometry');
      assert.equal(await page.evaluate(() => localStorage.getItem('ecosystem.theme.v1')), theme);
      // The new visual layout must retain the real member's non-interactive 2.0 gate.
      state.user = { ...state.user, isAdmin: false, isSpcTrader: false };
      await page.reload({ waitUntil: 'domcontentloaded' }); await expect(page.locator('.hud-identity')).toContainText(member.displayName);
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
        await page.goto(`${base}/#token_hash=synthetic-${type}&type=${type}`, { waitUntil: 'domcontentloaded' });
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
      const periodicity = width === 1440 || width === 320 ? await verifyPeriodicFrames(page, background) : { verified: false, reason: 'Native video loops are exercised at desktop and narrow-phone widths' };
      const contextLoss = width === 1440 || width === 320 ? await verifyContextLossFallback(page, background) : { verified: false, reason: 'Context loss is exercised at desktop and narrow-phone widths' };
      assert.deepEqual(state.writes, expectedWrites);
      assert.deepEqual(locations.requests, [], 'Navigation and theme changes never save shared location data');
      assert.deepEqual(state.harbour, [], 'Flowing Water does not request retired harbour assets');
      assert.ok(state.water.length > 0 && state.water.every(path => [waterArtwork.path, waterVideos[width < 760 ? 'mobile' : 'desktop'].path].includes(path)), 'Day and night use exactly the same artwork with no alternate scene requested');
      assert.deepEqual(state.unexpected, []); assert.deepEqual(errors, []);
      results.push({ engine, width, theme, passed: true, geometry, internalMotion, periodicity, contextLoss, nightContrastMinimum, pauseChecks, artwork: waterArtwork, hiddenPause: true, signedOut: true, signedIn: true, nonAdminGate: true });
      console.log(`PASS ${engine} ${width} ${theme}: sign-in/out, navigation, theme, motion, role gate`);
    } catch (error) {
      results.push({ engine, width, theme, passed: false, error: error.message, pauseChecks, loopDiagnostics: pauseEvidence.get(page).loopDiagnostics, unexpected: state.unexpected, errors });
      await page.screenshot({ path: `${out}/${engine}-${width}-${theme}-failure.png`, fullPage: true }).catch(() => {});
      throw error;
    } finally {
      await writeFile(`${reports}/verification.json`, JSON.stringify({ base, results, screenshotDirectory: out, limits: 'Synthetic authenticated responses in isolated browsers; native Safari and physical phones not tested. No live provider or business-data writes.' }, null, 2));
      await context.close();
    }
  } } finally { await browser.close(); }
}
