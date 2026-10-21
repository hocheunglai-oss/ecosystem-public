import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit, expect } from '@playwright/test';

// Uncached stills and explicit decode barriers expose mixed artwork/UI frames.
// Every scenario uses a disposable headless context, never a personal browser.
const BASE = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4173';
const OUT = new URL('../artifacts/mobile-transition/', import.meta.url);
const assets = { light: '/marine/destination-oil-terminal-clean-v7.jpg', dark: '/marine/destination-oil-terminal-night-v2.jpg', flag: '/marine/cosulich-hill-sculpture-v1.jpg' };
await mkdir(OUT, { recursive: true });
const browser = process.env.ECO_BROWSER === 'webkit'
  ? await webkit.launch({ headless: true })
  : await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const results = [];

async function installProbe(context, { initialTheme, decodePaths, native, holdFallback }) {
  await context.addInitScript(({ assets, initialTheme, decodePaths, native, holdFallback }) => {
    localStorage.setItem('ecosystem.theme.v1', initialTheme);
    const probe = window.__mobileTransitionProbe = {
      sample: false, frames: [], violations: [], decoded: [], decodeWaiting: {},
      held: new Set(decodePaths), releases: {}, transitions: [],
      initialBargePlacements: null,
      measureBarges() {
        const artwork = document.querySelector('.mobile-harbour-background > svg [data-mobile-artwork]');
        return [...(artwork?.querySelectorAll('[data-cosulich-barge] > image') ?? [])].map(ship => {
          const group = ship.closest('[data-cosulich-barge]');
          // Scene coordinates remain fixed when the responsive viewBox recrops
          // the harbour; permanent placement transforms are allowed too.
          const { x, y, width, height } = ship.getBBox();
          return { vessel: group.dataset.cosulichBarge, transform: getComputedStyle(group).transform, x, y, width, height };
        }).sort((a, b) => a.vessel.localeCompare(b.vessel));
      },
      release(path) {
        this.held.delete(path);
        for (const resolve of this.releases[path] ?? []) resolve();
        delete this.releases[path];
      },
    };
    const pathname = source => new URL(source || location.href, location.href).pathname;
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = async function () {
      const path = pathname(this.currentSrc || this.src);
      await decode.call(this);
      if (probe.held.has(path)) {
        probe.decodeWaiting[path] = (probe.decodeWaiting[path] ?? 0) + 1;
        await new Promise(resolve => (probe.releases[path] ??= []).push(resolve));
      }
      if (!probe.decoded.includes(path)) probe.decoded.push(path);
    };
    if (holdFallback) {
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (...args) {
        const animation = animate.apply(this, args);
        if (this.classList.contains('mobile-theme-snapshot')) {
          // Inspect cancellation without racing the real420ms fade on a cold CDN.
          // Ordinary timing scenarios keep the browser's clock entirely untouched.
          animation.pause();
          animation.currentTime = 0;
        }
        return animation;
      };
    }
    const start = document.startViewTransition?.bind(document);
    if (!native) Object.defineProperty(document, 'startViewTransition', { configurable: true, value: undefined });
    else if (start) document.startViewTransition = (...args) => {
      const record = { called: performance.now(), ready: null, finished: null, error: null, oldDuration: null, newDuration: null };
      probe.transitions.push(record);
      const transition = start(...args);
      transition.ready.then(() => {
        record.ready = performance.now();
        record.oldDuration = getComputedStyle(document.documentElement, '::view-transition-old(root)').animationDuration;
        record.newDuration = getComputedStyle(document.documentElement, '::view-transition-new(root)').animationDuration;
      }, error => { record.error = String(error); });
      transition.finished.then(() => { record.finished = performance.now(); }, error => { record.error = String(error); });
      return transition;
    };
    const sample = () => {
      if (probe.sample) {
        const background = document.querySelector('.mobile-harbour-background');
        const artwork = background?.querySelector(':scope > svg [data-mobile-artwork]');
        const marker = background?.querySelector('[data-mobile-flag-anchor]');
        const theme = document.documentElement.dataset.theme;
        const state = {
          at: performance.now(), theme, requested: document.documentElement.dataset.themeRequested,
          artwork: artwork?.getAttribute('data-mobile-artwork') ?? null,
          stored: localStorage.getItem('ecosystem.theme.v1'),
          base: artwork?.querySelector(':scope > image')?.getAttribute('href') ?? null,
          baseDecoded: probe.decoded.includes(assets[theme]), flagDecoded: probe.decoded.includes(assets.flag),
          flag: Boolean(artwork?.querySelector('[data-company-flag="sculpture"]')),
          nightLighting: Boolean(artwork?.querySelector('.marine-night-flag-lighting')),
          bargeCount: artwork?.querySelectorAll('[data-cosulich-barge]').length ?? 0,
          bargePlacements: probe.measureBarges(),
          sceneCount: document.querySelectorAll('.marine-world, canvas, .fleet-berth, .voyage-status').length,
          flagX: marker ? marker.getBoundingClientRect().x + marker.getBoundingClientRect().width / 2 : null,
          viewport: innerWidth,
        };
        const problems = [];
        if (state.theme !== state.artwork) problems.push('UI and background show different modes');
        if (state.theme !== state.stored) problems.push('Committed mode and persisted mode differ');
        if (state.base !== assets[theme] || !state.baseDecoded || !state.flagDecoded) problems.push('Committed scene contains old or unready artwork');
        if (state.flag !== (theme === 'light') || state.nightLighting !== (theme === 'dark')) problems.push('Flag treatment differs from the committed mode');
        if (state.sceneCount) problems.push('Desktop marine renderer or retired fleet controls were mounted on mobile');
        if (state.bargeCount !== 2 || JSON.stringify(state.bargePlacements) !== JSON.stringify(probe.initialBargePlacements)) problems.push('A stationary mobile barge is missing or moved');
        if (Math.abs(state.flagX - state.viewport / 2) > 1) problems.push('Flag moved away from the horizontal centre');
        if (problems.length) probe.violations.push({ ...state, problems });
        probe.frames.push(state);
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, { assets, initialTheme, decodePaths, native, holdFallback });
}

async function networkGate(context, path) {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let count = 0;
  await context.route(`**${path}`, async route => {
    count++;
    await held;
    try { await route.continue(); } catch (error) { if (!context.pages().every(page => page.isClosed())) throw error; }
  });
  return { release, count: () => count };
}
async function ready(page, mode) {
  await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
  await expect(page.locator('.mobile-harbour-background > svg [data-mobile-artwork]')).toHaveAttribute('data-mobile-artwork', mode);
  await page.waitForFunction(({ base, flag }) => window.__mobileTransitionProbe.decoded.includes(base) && window.__mobileTransitionProbe.decoded.includes(flag), { base: assets[mode], flag: assets.flag });
}
async function frames(page, count = 8) {
  const current = await page.evaluate(() => window.__mobileTransitionProbe.frames.length);
  await page.waitForFunction(min => window.__mobileTransitionProbe.frames.length >= min, current + count);
}
async function mode(page, committed, requested = committed) {
  await expect(page.locator('html')).toHaveAttribute('data-theme', committed);
  await expect(page.locator('.mobile-harbour-background > svg [data-mobile-artwork]')).toHaveAttribute('data-mobile-artwork', committed);
  await expect(page.locator('html')).toHaveAttribute('data-theme-requested', requested);
  await expect(page.locator('html')).toHaveAttribute('data-theme-pending', String(committed !== requested));
  await expect(page.locator('.theme-toggle:not(.ecosystem-feedback)')).toHaveAttribute('aria-busy', String(committed !== requested));
}
async function releaseDecode(page, path) { await page.evaluate(path => window.__mobileTransitionProbe.release(path), path); }
async function toggle(page, target) { await page.getByRole('button', { name: target === 'dark' ? 'Dark mode' : 'Light mode', exact: true }).click(); }
async function nativeFinished(page) {
  await page.waitForFunction(() => window.__mobileTransitionProbe.transitions.length > 0 && window.__mobileTransitionProbe.transitions.every(item => item.finished !== null));
}
async function assertNativeFade(page) {
  await nativeFinished(page);
  const transitions = await page.evaluate(() => window.__mobileTransitionProbe.transitions);
  assert.equal(transitions.length, 1);
  const transition = transitions[0];
  assert.equal(transition.error, null);
  assert.equal(transition.oldDuration, '0.42s');
  assert.equal(transition.newDuration, '0.42s');
  assert.ok(transition.finished - transition.ready >= 350, `Whole-page fade completed too quickly: ${JSON.stringify(transition)}`);
}

async function scenario(name, run, options = {}) {
  if (process.env.ECO_TEST_FILTER && !name.includes(process.env.ECO_TEST_FILTER)) return;
  const settings = { initialTheme: 'light', decodePaths: [], native: true, reduced: false, holdFallback: false, ...options };
  const context = await browser.newContext({ viewport: { width: settings.width ?? 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: settings.reduced ? 'reduce' : 'no-preference' });
  const page = await context.newPage();
  const errors = [];
  const failedRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('requestfailed', request => failedRequests.push(new URL(request.url()).pathname));
  page.setDefaultTimeout(12000);
  let gate;
  try {
    await installProbe(context, settings);
    if (settings.gatePath) gate = await networkGate(context, settings.gatePath);
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Demo profile', { exact: true }).selectOption('otto');
    await page.getByRole('button', { name: 'ENTER ECOSYSTEM', exact: true }).click();
    await ready(page, settings.initialTheme);
    const data = await page.evaluate(() => localStorage.getItem('ecosystem.demo.v1'));
    await page.evaluate(() => {
      const probe = window.__mobileTransitionProbe;
      probe.initialBargePlacements = probe.measureBarges();
      probe.sample = true;
    });
    await run(page, gate, context);
    await frames(page);
    const probe = await page.evaluate(() => ({ frames: window.__mobileTransitionProbe.frames, violations: window.__mobileTransitionProbe.violations, transitions: window.__mobileTransitionProbe.transitions }));
    assert.deepEqual(probe.violations.slice(0, 5), [], 'Every painted frame must use one complete committed mode');
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => localStorage.getItem('ecosystem.demo.v1')), data, 'Theme changes must preserve business records');
    await writeFile(new URL(`${name}-frames.json`, OUT), JSON.stringify(probe, null, 2));
    results.push({ name, passed: true, frames: probe.frames.length, transitions: probe.transitions, failedRequests });
    console.log(`PASS ${name} (${probe.frames.length} sampled frames)`);
  } catch (error) {
    results.push({ name, passed: false, error: error.stack });
    console.error(`FAIL ${name}: ${error.message}`);
    await page.screenshot({ path: new URL(`${name}-failure.png`, OUT).pathname }).catch(() => {});
    await writeFile(new URL(`${name}-failure.json`, OUT), JSON.stringify(await page.evaluate(() => ({ frames: window.__mobileTransitionProbe?.frames, violations: window.__mobileTransitionProbe?.violations, transitions: window.__mobileTransitionProbe?.transitions })).catch(() => null), null, 2));
  } finally {
    gate?.release();
    await context.close();
  }
}

try {
  for (const initialTheme of ['light', 'dark']) {
    const target = initialTheme === 'light' ? 'dark' : 'light';
    await scenario(`cold-${initialTheme}-to-${target}`, async (page, gate) => {
      await toggle(page, target);
      await expect.poll(gate.count).toBeGreaterThan(0);
      await frames(page);
      await mode(page, initialTheme, target);
      assert.equal(await page.evaluate(() => window.__mobileTransitionProbe.transitions.length), 0);
      gate.release();
      await page.waitForFunction(path => window.__mobileTransitionProbe.decodeWaiting[path] > 0, assets[target]);
      await frames(page);
      await mode(page, initialTheme, target);
      await releaseDecode(page, assets[target]);
      await ready(page, target);
      await page.waitForFunction(() => typeof window.__mobileTransitionProbe.transitions[0]?.ready === 'number');
      await page.waitForTimeout(150);
      await page.screenshot({ path: new URL(`${initialTheme}-to-${target}-fade.png`, OUT).pathname });
      await assertNativeFade(page);
      await mode(page, target);
      await page.screenshot({ path: new URL(`${target}-complete.png`, OUT).pathname });
    }, { initialTheme, gatePath: assets[target], decodePaths: [assets[target]] });
  }

  await scenario('rapid-reversal-cancels-pending-and-active-transition', async (page, gate) => {
    await toggle(page, 'dark');
    await expect.poll(gate.count).toBeGreaterThan(0);
    await toggle(page, 'light');
    await mode(page, 'light');
    gate.release();
    await releaseDecode(page, assets.dark);
    await page.waitForFunction(path => window.__mobileTransitionProbe.decoded.includes(path), assets.dark);
    await frames(page);
    await mode(page, 'light');
    assert.equal(await page.evaluate(() => window.__mobileTransitionProbe.transitions.length), 0, 'Cancelled image loads must not start a stale fade');
    await toggle(page, 'dark');
    await ready(page, 'dark');
    await page.waitForFunction(() => typeof window.__mobileTransitionProbe.transitions[0]?.ready === 'number');
    await page.evaluate(() => { document.querySelector('.theme-toggle:not(.ecosystem-feedback)').click(); document.querySelector('.theme-toggle:not(.ecosystem-feedback)').click(); });
    await ready(page, 'dark');
    await nativeFinished(page);
    await mode(page, 'dark');
  }, { gatePath: assets.dark, decodePaths: [assets.dark] });

  await scenario('failed-night-retains-light-and-retries', async (page, _gate, context) => {
    const path = `**${assets.dark}`;
    await context.route(path, route => route.abort('failed'));
    await toggle(page, 'dark');
    await expect(page.locator('.theme-toggle:not(.ecosystem-feedback)')).toHaveAttribute('title', 'UNABLE TO LOAD THIS MODE. TRY AGAIN.');
    await mode(page, 'light');
    await frames(page);
    assert.equal(await page.evaluate(() => window.__mobileTransitionProbe.transitions.length), 0);
    await context.unroute(path);
    await toggle(page, 'dark');
    await ready(page, 'dark');
    await assertNativeFade(page);
    await mode(page, 'dark');
  });

  for (const fallback of ['reduced-motion', 'unsupported-api', 'unsupported-api-day']) {
    const initialTheme = fallback === 'unsupported-api-day' ? 'dark' : 'light';
    const target = initialTheme === 'light' ? 'dark' : 'light';
    await scenario(fallback, async (page, gate) => {
      await toggle(page, target);
      await expect.poll(gate.count).toBeGreaterThan(0);
      await frames(page);
      await mode(page, initialTheme, target);
      gate.release();
      await page.waitForFunction(path => window.__mobileTransitionProbe.decodeWaiting[path] > 0, assets[target]);
      await mode(page, initialTheme, target);
      await releaseDecode(page, assets[target]);
      await ready(page, target);
      await mode(page, target);
      if (fallback.startsWith('unsupported-api')) {
        const snapshot = page.locator('.mobile-theme-snapshot');
        await expect(snapshot).toBeVisible();
        await expect(snapshot.locator('[data-mobile-artwork]')).toHaveAttribute('data-mobile-artwork', initialTheme);
        const animations = await snapshot.evaluate(element => element.getAnimations().map(animation => ({ duration: animation.effect.getTiming().duration, frames: animation.effect.getKeyframes() })));
        assert.ok(animations.some(animation => animation.duration === 420 && animation.frames.at(0).opacity === '1' && animation.frames.at(-1).opacity === '0'), `Fallback must fade the complete previous image for420ms: ${JSON.stringify(animations)}`);
        await page.waitForTimeout(150);
        await page.screenshot({ path: new URL(`${fallback}-fade.png`, OUT).pathname });
      } else await expect(page.locator('.mobile-theme-snapshot')).toHaveCount(0);
      await frames(page, 30);
      await expect(page.locator('.mobile-theme-snapshot')).toHaveCount(0);
      assert.equal(await page.evaluate(() => window.__mobileTransitionProbe.transitions.length), 0);
      const animations = await page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running').length);
      assert.equal(animations, 0, 'No continuous scene animations may remain after switching');
    }, { initialTheme, native: !fallback.startsWith('unsupported-api'), reduced: fallback === 'reduced-motion', gatePath: assets[target], decodePaths: [assets[target]], width: 320 });
  }

  await scenario('fallback-reversal-and-resize-clean-up-snapshot', async page => {
    await toggle(page, 'dark');
    await ready(page, 'dark');
    await expect(page.locator('.mobile-theme-snapshot')).toHaveCount(1);
    await toggle(page, 'light');
    await ready(page, 'light');
    await expect(page.locator('.mobile-theme-snapshot')).toHaveCount(1);
    await expect(page.locator('.mobile-theme-snapshot [data-mobile-artwork]')).toHaveAttribute('data-mobile-artwork', 'dark');
    await page.locator('.mobile-theme-snapshot').evaluate(snapshot => {
      const animations = snapshot.getAnimations();
      if (!animations.length || animations.some(animation => animation.playState !== 'paused')) throw new Error('Cleanup scenario must control a paused fallback fade');
      animations.forEach(animation => animation.play());
    });
    await frames(page, 30);
    await expect(page.locator('.mobile-theme-snapshot')).toHaveCount(0);
    await toggle(page, 'dark');
    await ready(page, 'dark');
    await expect(page.locator('.mobile-theme-snapshot')).toHaveCount(1);
    await page.setViewportSize({ width: 850, height: 900 });
    await expect(page.locator('html')).toHaveAttribute('data-interface', 'mobile');
    await expect(page.locator('.mobile-theme-snapshot')).toHaveCount(0);
    await ready(page, 'dark');
    await frames(page);
    await toggle(page, 'light');
    await ready(page, 'light');
    await expect(page.locator('.mobile-theme-snapshot')).toHaveCount(1);
    // The desktop scene has separate regression coverage; only verify cleanup at
    // this boundary and stop the mobile-only frame sampler before resizing.
    await page.evaluate(() => { window.__mobileTransitionProbe.sample = false; });
    await page.setViewportSize({ width: 1440, height: 960 });
    await expect(page.locator('html')).toHaveAttribute('data-interface', 'desktop');
    await expect(page.locator('.mobile-theme-snapshot, .mobile-harbour-background')).toHaveCount(0);
    await expect(page.locator('[data-cosulich-barge]')).toHaveCount(2);
    await expect(page.locator('.fleet-berth, .voyage-status')).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('html')).toHaveAttribute('data-interface', 'mobile');
    await ready(page, 'light');
    await page.evaluate(() => { window.__mobileTransitionProbe.sample = true; });
    await expect(page.locator('.mobile-theme-snapshot')).toHaveCount(0);
  }, { native: false, holdFallback: true });
} finally {
  await browser.close();
  await writeFile(new URL('results.json', OUT), JSON.stringify(results, null, 2));
}
if (results.some(result => !result.passed)) process.exitCode = 1;
