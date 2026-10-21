import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';

const BASE = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4197';
const vessels = ['/marine/cosulich-barge-v2.png', '/marine/cosulich-lng-barge-v1.png'];
const flag = '/marine/cosulich-hill-sculpture-v1.jpg';
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });

async function gateAsset(context, asset) {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  let requests = 0;
  await context.route(`**${asset}`, async route => {
    requests++;
    await wait;
    try { await route.continue(); } catch { /* Context may close after a failed assertion. */ }
  });
  return { release, requests: () => requests };
}

async function scenario(theme, mobile) {
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1671, height: 941 },
    reducedMotion: 'reduce',
  });
  const gates = await Promise.all([flag, ...vessels].map(asset => gateAsset(context, asset)));
  try {
    // The retired demo session is not authentication. This isolated rendering
    // fixture supplies the same session response shape as the access service.
    await context.route('**/api/access/session', route => route.fulfill({ json: { user: {
      id: '10000000-0000-4000-8000-000000000001', email: 'harbour@example.com', displayName: 'HARBOUR TEST',
      officeId: 'HKG', officeName: 'HONG KONG', isAdmin: false, isSpcTrader: true, isManager: false,
      isActive: true, activated: true, passwordChangeSuggested: false, revision: 1,
    } } }));
    await context.addInitScript(({ theme, vessels }) => {
      localStorage.setItem('ecosystem.theme.v1', theme);
      const probe = window.__harbourLoading = {
        decoded: [], waiting: [], releases: {}, frames: [],
        release(path) { this.releases[path]?.(); },
      };
      const decode = HTMLImageElement.prototype.decode;
      HTMLImageElement.prototype.decode = async function () {
        await decode.call(this);
        const path = new URL(this.currentSrc || this.src, location.href).pathname;
        if (vessels.includes(path)) {
          probe.waiting.push(path);
          await new Promise(resolve => { probe.releases[path] = resolve; });
        }
        probe.decoded.push(path);
      };
      function sample() {
        const root = document.querySelector('.marine-world, .mobile-harbour-background');
        if (root) {
          const plate = root.querySelector('.marine-world__harbour, [data-mobile-artwork] > image');
          const hulls = [...root.querySelectorAll('[data-cosulich-barge] > image')];
          const source = image => new URL(image.getAttribute('src') || image.getAttribute('href'), location.href).pathname;
          probe.frames.push({
            ready: root.dataset.artworkReady,
            plate: Boolean(plate),
            hulls: hulls.length,
            decoded: Boolean(plate) && [plate, ...hulls].every(image => probe.decoded.includes(source(image))),
          });
        }
        requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    }, { theme, vessels });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('main', { name: 'ECOSYSTEM workspace' })).toBeVisible();
    const root = page.locator(mobile ? '.mobile-harbour-background' : '.marine-world');
    await expect(root).toHaveAttribute('data-artwork-ready', 'false');
    await expect.poll(() => gates.every(gate => gate.requests() > 0)).toBe(true);
    await page.waitForFunction(() => window.__harbourLoading.decoded.some(path => path.includes('destination-oil-terminal-')));
    const expectUnrevealed = async () => {
      await expect(root).toHaveAttribute('data-artwork-ready', 'false');
      await expect(root.locator('.marine-world__harbour, [data-mobile-artwork], [data-cosulich-barge]')).toHaveCount(0);
      await page.waitForTimeout(120);
      const partial = await page.evaluate(() => window.__harbourLoading.frames.filter(frame => frame.plate || frame.hulls));
      assert.deepEqual(partial, [], 'No harbour or vessel may appear while a required asset is unavailable');
    };
    await expectUnrevealed();
    gates[0].release();
    await page.waitForFunction(flag => window.__harbourLoading.decoded.includes(flag), flag);
    await expectUnrevealed();
    gates[1].release();
    await page.waitForFunction(asset => window.__harbourLoading.waiting.includes(asset), vessels[0]);
    await expectUnrevealed();
    await page.evaluate(asset => window.__harbourLoading.release(asset), vessels[0]);
    await page.waitForFunction(asset => window.__harbourLoading.decoded.includes(asset), vessels[0]);
    await expectUnrevealed();
    gates[2].release();
    await page.waitForFunction(asset => window.__harbourLoading.waiting.includes(asset), vessels[1]);
    await expectUnrevealed();
    await page.evaluate(asset => window.__harbourLoading.release(asset), vessels[1]);
    await expect(root).toHaveAttribute('data-artwork-ready', 'true');
    await expect(root.locator('[data-cosulich-barge] > image')).toHaveCount(2);
    await page.waitForTimeout(200);
    const visible = await page.evaluate(() => window.__harbourLoading.frames.filter(frame => frame.plate || frame.hulls));
    assert.ok(visible.length >= 3, 'Sample several painted frames after the reveal');
    assert.deepEqual(visible.filter(frame => frame.ready !== 'true' || !frame.plate || frame.hulls !== 2 || !frame.decoded), [],
      'The first and subsequent visible frames must contain the decoded harbour and both vessels together');
    assert.deepEqual(errors, []);
    console.log(`PASS ${theme} ${mobile ? 'mobile' : 'desktop'}: staggered network/decode, complete first reveal, usable interface`);
  } finally {
    gates.forEach(gate => gate.release());
    await context.close();
  }
}

try {
  for (const mobile of [false, true]) {
    for (const theme of ['light', 'dark']) await scenario(theme, mobile);
  }
} finally { await browser.close(); }
