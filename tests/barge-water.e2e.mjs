import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const BASE = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4197';
const output = new URL('../artifacts/barge-water/', import.meta.url);
await mkdir(output, { recursive: true });

// Compare decoded colours, not PNG compression bytes. GPU compositing can round
// a static filtered edge by one channel value without any visible movement.
async function pixelDifferences(page, before, after) {
  return page.evaluate(async pairs => {
    const decode = async encoded => {
      const image = new Image();
      image.src = `data:image/png;base64,${encoded}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, image.width, image.height);
    };
    return Promise.all(pairs.map(async ([before, after]) => {
      const [a, b] = await Promise.all([decode(before), decode(after)]);
      if (a.width !== b.width || a.height !== b.height) throw new Error('Water crop dimensions changed');
      let changedPixels = 0, maxDelta = 0;
      for (let pixel = 0; pixel < a.data.length; pixel += 4) {
        let pixelDelta = 0;
        for (let channel = 0; channel < 4; channel++) {
          pixelDelta = Math.max(pixelDelta, Math.abs(a.data[pixel + channel] - b.data[pixel + channel]));
        }
        maxDelta = Math.max(maxDelta, pixelDelta);
        if (pixelDelta > 1) changedPixels++;
      }
      return { changedPixels, maxDelta };
    }));
  }, before.map((frame, index) => [frame.toString('base64'), after[index].toString('base64')]));
}

async function assertStillWater(page, before, after, message) {
  const differences = await pixelDifferences(page, before, after);
  differences.forEach((difference, index) => {
    assert.ok(difference.maxDelta <= 1, `${message}; hull ${index + 1}: ${JSON.stringify(difference)}`);
  });
}

const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
try {
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1671, height: 941 }, reducedMotion: 'no-preference' });
    await context.addInitScript(theme => {
      sessionStorage.setItem('ecosystem.session.v1', 'otto');
      localStorage.setItem('ecosystem.theme.v1', theme);
    }, theme);
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(BASE, { waitUntil: 'networkidle' });
    const hull = page.locator('[data-cosulich-barge] image');
    await expect(hull).toHaveCount(2);
    const lngSize = await page.locator('[data-cosulich-barge="cosulich-lng"] > image').boundingBox();
    assert.equal(lngSize?.width, 200, 'Keep the approved original LNG vessel width');
    assert.equal(lngSize?.height, 100, 'Keep the approved original LNG vessel height');
    await expect(page.locator('.cosulich-barge__ripple')).toHaveCount(0);
    await expect(page.locator('.marine-world')).toHaveAttribute('data-ambient-motion', 'running');
    await expect(page.locator('.marine-world__water')).toHaveAttribute('data-water-state', 'running');
    const hullPositions = () => hull.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()));
    const water = async () => Promise.all([
      page.screenshot({ clip: { x: 1000, y: 508, width: 80, height: 26 } }),
      page.screenshot({ clip: { x: 636, y: 420, width: 90, height: 24 } }),
    ]);
    const initialHull = await hullPositions(), initialWater = await water();
    await page.waitForTimeout(700);
    (await pixelDifferences(page, initialWater, await water())).forEach((difference, index) => {
      assert.ok(difference.changedPixels >= 8,
        `Water texture must visibly move around hull ${index + 1}: ${JSON.stringify(difference)}`);
    });
    assert.deepEqual(await hullPositions(), initialHull, 'Water motion must never move either barge');
    await page.screenshot({ path: new URL(`${theme}-desktop.png`, output).pathname });
    await page.screenshot({ path: new URL(`${theme}-detail.png`, output).pathname, clip: { x: 910, y: 390, width: 280, height: 170 } });
    await page.screenshot({ path: new URL(`${theme}-lng.png`, output).pathname, clip: { x: 545, y: 285, width: 265, height: 165 } });

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.locator('.marine-world')).toHaveAttribute('data-ambient-motion', 'paused');
    await expect(page.locator('.marine-world__water')).toHaveCSS('opacity', '0');
    const reduced = await water();
    await page.waitForTimeout(400);
    await assertStillWater(page, reduced, await water(), 'Reduced-motion preference must stop water animation');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(page.locator('.marine-world')).toHaveAttribute('data-ambient-motion', 'running');
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
    await expect(page.locator('.marine-world')).toHaveAttribute('data-ambient-motion', 'paused');
    await page.waitForTimeout(100);
    const hidden = await water();
    await page.waitForTimeout(400);
    await assertStillWater(page, hidden, await water(), 'Background tabs must pause the ripples');
    await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.marine-world')).toHaveCount(0);
    await expect(page.locator('.marine-world__water')).toHaveCount(0);
    await expect(hull).toHaveCount(2);
    const mobile = await hullPositions();
    await page.waitForTimeout(400);
    assert.deepEqual(await hullPositions(), mobile, 'Mobile keeps its static business backdrop');
    await page.screenshot({ path: new URL(`${theme}-mobile.png`, output).pathname });
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS ${theme}: moving water, stationary hull, reduced motion, hidden page, static mobile`);
  }
} finally { await browser.close(); }
