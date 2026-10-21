import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

// Dedicated headless contexts: intentionally uncached image requests and decode
// barriers expose mixed-theme frames that a final-state screenshot would miss.
const BASE = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4173';
const OUT = new URL('../artifacts/theme-transition/', import.meta.url);
const assets = {
  light: '/marine/destination-oil-terminal-clean-v7.jpg',
  dark: '/marine/destination-oil-terminal-night-v2.jpg',
  flag: '/marine/cosulich-hill-sculpture-v1.jpg',
};
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const results = [];

async function installProbe(context, decodePaths = []) {
  await context.addInitScript(({ assets, decodePaths }) => {
    const probe = window.__themeTransitionProbe = {
      sample: false, frames: [], violations: [], decoded: [], decodeWaiting: {},
      held: new Set(decodePaths), releases: {}, canvasPlates: new WeakMap(),
      initialBargePlacements: null,
      measureBarges() {
        return [...document.querySelectorAll('[data-cosulich-barge] image')].map(ship => {
          const group = ship.closest('[data-cosulich-barge]');
          const { x, y, width, height } = ship.getBoundingClientRect();
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
    const upload = WebGLRenderingContext.prototype.texImage2D;
    WebGLRenderingContext.prototype.texImage2D = function (...args) {
      const source = args.at(-1);
      if (source instanceof HTMLImageElement) probe.canvasPlates.set(this.canvas, pathname(source.currentSrc || source.src));
      return upload.apply(this, args);
    };
    const sample = () => {
      if (probe.sample) {
        const scene = document.querySelector('.marine-world');
        const plate = document.querySelector('.marine-world__harbour');
        const water = document.querySelector('.marine-world__water');
        const ships = [...document.querySelectorAll('[data-cosulich-barge] image')];
        if (scene && plate && ships.length) {
          const theme = document.documentElement.dataset.theme;
          const expected = assets[theme];
          const state = {
            at: performance.now(), theme, sceneTheme: scene.dataset.theme,
            storedTheme: localStorage.getItem('ecosystem.theme.v1'),
            plate: pathname(plate.currentSrc || plate.src),
            plateReady: plate.complete && plate.naturalWidth > 0,
            shipLighting: ships.map(ship => {
              const id = ship.getAttribute('filter')?.match(/^url\(#(.+)\)$/)?.[1];
              return id ? document.getElementById(id)?.querySelector('feFuncR')?.getAttribute('slope') : null;
            }),
            flag: Boolean(scene.querySelector('[data-company-flag="sculpture"]')),
            flagDecoded: probe.decoded.includes(assets.flag),
            bargeCount: scene.querySelectorAll('[data-cosulich-barge]').length,
            bargePlacements: probe.measureBarges(),
            waterVisible: Boolean(water && getComputedStyle(water).visibility !== 'hidden' && Number(getComputedStyle(water).opacity) > 0.01),
            waterPlate: water ? probe.canvasPlates.get(water) ?? null : null,
          };
          const problems = [];
          if (state.theme !== state.sceneTheme) problems.push('document and scene themes differ');
          if (state.theme !== state.storedTheme) problems.push('persisted mode differs from committed mode');
          if (state.plate !== expected || !state.plateReady) problems.push('committed mode has an old or unready sky plate');
          if (theme === 'light' && (!state.flag || !state.flagDecoded)) problems.push('Light mode committed without decoded flag artwork');
          if (state.bargeCount !== 2 || JSON.stringify(state.bargePlacements) !== JSON.stringify(probe.initialBargePlacements)) problems.push('Stationary barges changed position or count');
          if (theme === 'light' && state.shipLighting.some(slope => slope !== '.96')) problems.push('night barge dimming visible over Light mode');
          if (theme === 'dark' && state.shipLighting.some(slope => slope !== '.624')) problems.push('Dark mode lacks a barge treatment');
          if (state.waterVisible && state.waterPlate !== expected) problems.push('visible ocean texture belongs to another mode');
          if (problems.length) probe.violations.push({ ...state, problems });
          probe.frames.push(state);
          if (probe.frames.length > 3000) probe.frames.shift();
        }
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, { assets, decodePaths });
}

async function networkGate(context, path) {
  let release;
  const open = new Promise(resolve => { release = resolve; });
  let count = 0;
  await context.route(`**${path}`, async route => {
    count++;
    await open;
    try { await route.fulfill({ response: await route.fetch() }); }
    catch (error) { if (!context.pages().every(page => page.isClosed())) throw error; }
  });
  return { release, count: () => count };
}
async function login(page) {
  await page.getByLabel('Demo profile', { exact: true }).selectOption('gianmichele');
  await page.getByRole('button', { name: 'ENTER ECOSYSTEM', exact: true }).click();
  await expect(page.locator('[data-cosulich-barge] image')).toHaveCount(2);
  await expect(page.locator('.fleet-berth, .destination-tanker, .voyage-status')).toHaveCount(0);
}
async function ready(page, theme) {
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await page.waitForFunction(({ expected, theme, flag }) => {
    const plate = document.querySelector('.marine-world__harbour');
    return plate?.complete && plate.naturalWidth > 0 && new URL(plate.currentSrc || plate.src).pathname === expected &&
      (theme === 'dark' || window.__themeTransitionProbe.decoded.includes(flag));
  }, { expected: assets[theme], theme, flag: assets.flag });
}
async function frames(page, count = 10) {
  const before = await page.evaluate(() => window.__themeTransitionProbe.frames.length);
  await page.waitForFunction(target => window.__themeTransitionProbe.frames.length >= target, before + count);
}
async function assertMode(page, mode) {
  await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
  assert.equal(await page.evaluate(() => localStorage.getItem('ecosystem.theme.v1')), mode);
}
async function assertIntent(page, mode, pending) {
  await expect(page.locator('html')).toHaveAttribute('data-theme-requested', mode);
  await expect(page.locator('html')).toHaveAttribute('data-theme-pending', String(pending));
  await expect(page.locator('.theme-toggle:not(.ecosystem-feedback)')).toHaveAttribute('aria-busy', String(pending));
}
async function releaseDecode(page, path) {
  await page.evaluate(path => window.__themeTransitionProbe.release(path), path);
}
async function assertFrames(page) {
  const violations = await page.evaluate(() => window.__themeTransitionProbe.violations);
  assert.deepEqual(violations.slice(0, 5), [], 'Every painted frame must contain one complete committed theme');
}
async function scenario(name, run, { initialTheme = 'light', decodePaths = [], gatePath, transition = 'native', failedPath } = {}) {
  const context = await browser.newContext({ viewport: { width: 1671, height: 941 }, reducedMotion: 'no-preference' });
  const gates = [];
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(10000);
  try {
    await installProbe(context, decodePaths);
    await context.addInitScript(({ initialTheme, transition }) => {
      if (initialTheme === 'dark' && !localStorage.getItem('ecosystem.theme.v1')) localStorage.setItem('ecosystem.theme.v1', 'dark');
      if (transition === 'atomic') Object.defineProperty(document, 'startViewTransition', { configurable: true, value: undefined });
    }, { initialTheme, transition });
    const gate = gatePath ? await networkGate(context, gatePath) : null;
    if (gate) gates.push(gate);
    if (failedPath) await context.route(`**${failedPath}`, route => route.abort('failed'));
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await login(page);
    await ready(page, initialTheme);
    await page.evaluate(() => {
      const probe = window.__themeTransitionProbe;
      // A permanent placement transform is allowed; every frame must preserve it
      // and the actual rendered hull bounds captured before the theme changes.
      probe.initialBargePlacements = probe.measureBarges();
      probe.sample = true;
    });
    await run(page, gate);
    await assertFrames(page);
    assert.deepEqual(errors, []);
    const frames = await page.evaluate(() => window.__themeTransitionProbe.frames);
    await writeFile(new URL(`${name}-frames.json`, OUT), JSON.stringify(frames, null, 2));
    results.push({ name, passed: true, sampledFrames: frames.length });
    console.log(`PASS ${name} (${frames.length} sampled frames)`);
  } catch (error) {
    results.push({ name, passed: false, error: error.stack });
    console.error(`FAIL ${name}: ${error.message}`);
    await page.screenshot({ path: new URL(`${name}-failure.png`, OUT).pathname }).catch(() => {});
    const probe = await page.evaluate(() => ({ frames: window.__themeTransitionProbe?.frames, violations: window.__themeTransitionProbe?.violations })).catch(() => null);
    await writeFile(new URL(`${name}-failure.json`, OUT), JSON.stringify(probe, null, 2));
  } finally {
    for (const gate of gates) gate.release();
    await context.close();
  }
}

try {
  for (const transition of ['native', 'atomic']) {
    await scenario(`uncached-night-${transition}`, async (page, gate) => {
      await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
      await expect.poll(gate.count).toBeGreaterThan(0);
      await frames(page);
      await assertMode(page, 'light');
      await assertIntent(page, 'dark', true);
      await page.screenshot({ path: new URL(`uncached-night-${transition}-pending.png`, OUT).pathname });
      gate.release();
      await page.waitForFunction(path => window.__themeTransitionProbe.decodeWaiting[path] > 0, assets.dark);
      await frames(page);
      await assertMode(page, 'light');
      await assertIntent(page, 'dark', true);
      await releaseDecode(page, assets.dark);
      await ready(page, 'dark');
      await assertIntent(page, 'dark', false);
      await frames(page, 30);
      await page.screenshot({ path: new URL(`uncached-night-${transition}-ready.png`, OUT).pathname });
    }, { gatePath: assets.dark, decodePaths: [assets.dark], transition });
  }

  // The shared flag now belongs to the initial complete night scene too, so
  // delay the uncached daylight plate while verifying the decoded flag stays ready.
  await scenario('uncached-daylight', async (page, gate) => {
    await page.getByRole('button', { name: 'Light mode', exact: true }).click();
    await expect.poll(gate.count).toBeGreaterThan(0);
    await frames(page);
    await assertMode(page, 'dark');
    await assertIntent(page, 'light', true);
    gate.release();
    await page.waitForFunction(path => window.__themeTransitionProbe.decodeWaiting[path] > 0, assets.light);
    await frames(page);
    await assertMode(page, 'dark');
    await assertIntent(page, 'light', true);
    await releaseDecode(page, assets.light);
    await ready(page, 'light');
    await assertIntent(page, 'light', false);
    await frames(page, 30);
  }, { initialTheme: 'dark', gatePath: assets.light, decodePaths: [assets.light] });

  await scenario('latest-intent-cancels-delayed-night', async (page, gate) => {
    await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
    await expect.poll(gate.count).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Light mode', exact: true }).click();
    await frames(page);
    await assertMode(page, 'light');
    await assertIntent(page, 'light', false);
    gate.release();
    await releaseDecode(page, assets.dark);
    await page.waitForFunction(path => window.__themeTransitionProbe.decoded.includes(path), assets.dark);
    await frames(page, 30);
    await assertMode(page, 'light');
    await assertIntent(page, 'light', false);
    // Exercise another complete reversal after the image cache has warmed.
    await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
    await page.getByRole('button', { name: 'Light mode', exact: true }).click();
    await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
    await ready(page, 'dark');
    await frames(page, 30);
    await assertMode(page, 'dark');
    await assertIntent(page, 'dark', false);
  }, { gatePath: assets.dark, decodePaths: [assets.dark] });

  await scenario('failed-night-keeps-committed-mode', async page => {
    await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
    await expect(page.locator('.theme-toggle:not(.ecosystem-feedback)')).toHaveAttribute('title', 'UNABLE TO LOAD THIS MODE. TRY AGAIN.');
    await assertMode(page, 'light');
    await assertIntent(page, 'light', false);
    await frames(page, 30);
    await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
    await expect(page.locator('.theme-toggle:not(.ecosystem-feedback)')).toHaveAttribute('title', 'UNABLE TO LOAD THIS MODE. TRY AGAIN.');
    await assertMode(page, 'light');
    await assertIntent(page, 'light', false);
  }, { failedPath: assets.dark });
} finally {
  await browser.close();
  await writeFile(new URL('results.json', OUT), JSON.stringify(results, null, 2));
}
if (results.some(result => !result.passed)) process.exitCode = 1;
