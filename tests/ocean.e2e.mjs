import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

// Disposable headless contexts only; no personal browser or external writes.
const BASE = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4173';
const OUT = new URL('../artifacts/ocean/', import.meta.url);
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
async function assertCompanySign(page) {
  const sign = await page.locator('image[data-company-flag="sculpture"]').evaluate(async element => {
    const href = element.getAttribute('href');
    const image = new Image(); image.src = href; await image.decode();
    const response = await fetch(href);
    const matrix = element.getScreenCTM();
    return { href, intrinsic: [image.naturalWidth, image.naturalHeight], x: element.x.baseVal.value, y: element.y.baseVal.value,
      width: element.width.baseVal.value, height: element.height.baseVal.value, mask: element.getAttribute('mask'),
      preserve: element.getAttribute('preserveAspectRatio'), scaleX: Math.hypot(matrix.a, matrix.b), scaleY: Math.hypot(matrix.c, matrix.d),
      orthogonality: matrix.a * matrix.c + matrix.b * matrix.d, decoded: image.naturalWidth > 0, status: response.status };
  });
  assert.equal(sign.href, '/marine/cosulich-hill-sculpture-v1.jpg');
  assert.equal(sign.status, 200); assert.equal(sign.decoded, true);
  assert.deepEqual(sign.intrinsic, [1272, 1236]);
  assert.deepEqual([sign.x, sign.y, sign.width, sign.height], [1060, 148, 178, 173], 'The sculpture must retain its approved framing and placement');
  assert.ok(Math.abs(sign.width / sign.height - sign.intrinsic[0] / sign.intrinsic[1]) < .001, 'The sculpture must retain the reference proportions');
  assert.equal(sign.preserve, 'xMidYMid meet');
  assert.ok(Math.abs(sign.scaleX - sign.scaleY) < .00001 && Math.abs(sign.orthogonality) < .00001, 'The sculpture must scale uniformly without skewing');
  const mounting = await page.locator('[data-hill-sign="cosulich"]').evaluate(element => ({
    blend: getComputedStyle(element).mixBlendMode,
    alphaMask: getComputedStyle(element.querySelector('#hill-sign-patch')).maskType,
    rectangleBacking: [...element.querySelectorAll('rect')].some(rect => !rect.closest('defs') && !rect.hasAttribute('mask')),
    terrainMask: [...element.querySelector('#hill-sign-patch rect').attributes].reduce((attributes, item) => ({ ...attributes, [item.name]: item.value }), {}),
  }));
  assert.equal(mounting.blend, 'normal', 'The approved sculpture colours must not be tinted by the background');
  assert.equal(mounting.alphaMask, 'alpha');
  assert.equal(sign.mask, 'url(#hill-sign-patch)');
  assert.equal(mounting.rectangleBacking, false, 'A flag-shaped sign must not have a rectangular backing');
  assert.deepEqual(['x', 'y', 'width', 'height'].map(key => Number(mounting.terrainMask[key])), [1094, 175, 106, 107], 'The generated edit must stay within the sculpture and its footings');
  assert.ok(mounting.terrainMask.filter, 'The localized sculpture must blend softly into the retained artwork');
  assert.equal(await page.locator('.marine-world__harbour').getAttribute('src'), '/marine/destination-oil-terminal-clean-v7.jpg');
}
async function assertHarbourBrightness(page, view) {
  const screenshot = await page.screenshot({ animations: 'disabled' });
  const readings = await page.evaluate(async encoded => {
    const load = async src => { const image = new Image(); image.src = src; await image.decode(); return image; };
    const rendered = await load(`data:image/png;base64,${encoded}`);
    const plate = document.querySelector('.marine-world__harbour');
    const approved = await load('/marine/destination-oil-terminal-v1.jpg');
    const canvasFor = image => {
      const canvas = document.createElement('canvas'); canvas.width = innerWidth; canvas.height = innerHeight;
      const context = canvas.getContext('2d'), scale = Math.max(innerWidth / image.naturalWidth, innerHeight / image.naturalHeight);
      const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
      context.drawImage(image, (innerWidth - width) / 2, (innerHeight - height) / 2, width, height);
      return context;
    };
    const contexts = [rendered, plate, approved].map(canvasFor);
    // Clear land/sky patches away from UI controls and the overlaid hilltop sign.
    const patches = [{ x: 720, y: 60 }, { x: 1110, y: 310 }, { x: 1450, y: 340 }, { x: 275, y: 640 }];
    const meanLuminance = (context, patch) => {
      const pixels = context.getImageData(patch.x, patch.y, 16, 16).data;
      let total = 0;
      for (let i = 0; i < pixels.length; i += 4) total += .2126 * pixels[i] + .7152 * pixels[i + 1] + .0722 * pixels[i + 2];
      return total / (pixels.length / 4);
    };
    const vignette = document.querySelector('.world-vignette');
    const paint = vignette ? getComputedStyle(vignette) : null;
    return { patches: patches.map(patch => ({ ...patch, values: contexts.map(context => meanLuminance(context, patch)) })),
      vignette: paint && { display: paint.display, opacity: paint.opacity, backgroundImage: paint.backgroundImage, backgroundColor: paint.backgroundColor } };
  }, screenshot.toString('base64'));
  for (const patch of readings.patches) {
    const [rendered, plate, approved] = patch.values;
    assert.ok(Math.abs(rendered - plate) < 3, `${view} must preserve artwork brightness at ${patch.x},${patch.y}: rendered=${rendered.toFixed(2)}, artwork=${plate.toFixed(2)}`);
    assert.ok(Math.abs(plate - approved) < 8, `${view} artwork must retain the approved colour at ${patch.x},${patch.y}: current=${plate.toFixed(2)}, approved=${approved.toFixed(2)}`);
  }
  const vignette = readings.vignette;
  assert.ok(!vignette || vignette.display === 'none' || Number(vignette.opacity) === 0 || (vignette.backgroundImage === 'none' && /(?:rgba\([^)]*,\s*0\)|transparent)/.test(vignette.backgroundColor)), `${view} must not apply a grey or dark vignette`);
}
try {
  const context = await browser.newContext({ viewport: { width: 1671, height: 941 }, reducedMotion: 'no-preference' });
  await context.addInitScript(() => {
    window.__waterDraws = 0;
    const upload = WebGLRenderingContext.prototype.texImage2D;
    WebGLRenderingContext.prototype.texImage2D = function (...args) {
      const source = args[args.length - 1];
      if (source instanceof HTMLImageElement) window.__waterPlate = source.currentSrc;
      return upload.apply(this, args);
    };
    const draw = WebGLRenderingContext.prototype.drawArrays;
    WebGLRenderingContext.prototype.drawArrays = function (...args) {
      draw.apply(this, args);
      window.__waterDraws++;
      if (window.__captureWater) {
        const capture = window.__captureWater;
        window.__captureWater = null;
        capture(this);
      }
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('.marine-world__water')?.dataset.waterState === 'running');
  assert.equal(await page.evaluate(() => window.__waterPlate), await page.locator('.marine-world__harbour').evaluate(image => image.currentSrc), 'Animated water must use the same cleaned artwork as the still harbour');
  await assertCompanySign(page);
  const sample = () => page.evaluate(() => new Promise(resolve => {
    window.__captureWater = gl => {
      const read = (x, y) => {
        const pixels = new Uint8Array(32 * 32 * 4);
        gl.readPixels(Math.round(gl.drawingBufferWidth * x), Math.round(gl.drawingBufferHeight * y), 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return Array.from(pixels);
      };
      const artRect = (x, y, width, height) => {
        const w = Math.ceil(width / 1671 * gl.drawingBufferWidth), h = Math.ceil(height / 941 * gl.drawingBufferHeight);
        const pixels = new Uint8Array(w * h * 4);
        gl.readPixels(Math.floor(x / 1671 * gl.drawingBufferWidth), Math.floor((941 - y - height) / 941 * gl.drawingBufferHeight), w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return Array.from(pixels);
      };
      // Sample the solid face, excluding transparent top corners near the hillside outline.
      resolve({ water: read(.55, .14), land: read(.66, .64), sky: read(.45, .93), sign: artRect(1108, 196, 72, 53), width: gl.drawingBufferWidth, height: gl.drawingBufferHeight });
    };
  }));
  const first = await sample();
  await page.waitForTimeout(800);
  const second = await sample();
  const changes = first.water.reduce((sum, value, index) => sum + Math.abs(value - second.water[index]), 0) / first.water.length;
  assert.ok(changes > .75, `Water must visibly move; mean change was ${changes}`);
  assert.deepEqual(first.land, second.land, 'Buildings must remain still');
  assert.deepEqual(first.sky, second.sky, 'Sky must remain still');
  assert.deepEqual(first.sign, second.sign, 'The hilltop sign must remain still');
  assert.ok(first.sign.every((value, index) => index % 4 !== 3 || value === 0), 'Animated water must remain transparent over the hilltop sign');
  assert.ok(second.width * second.height <= 901000, 'Water buffer must stay bounded');
  await assertHarbourBrightness(page, 'Login');
  await page.getByLabel('Demo profile', { exact: true }).selectOption('otto');
  await page.getByRole('button', { name: 'ENTER ECOSYSTEM', exact: true }).click();
  await assertHarbourBrightness(page, 'Signed-in home');
  await page.screenshot({ animations: 'disabled', path: new URL('home-sculpted-flag.png', OUT).pathname });
  const signBox = await page.locator('image[data-company-flag="sculpture"]').boundingBox();
  await page.screenshot({ animations: 'disabled', clip: { x: signBox.x - 8, y: signBox.y - 8, width: signBox.width + 16, height: signBox.height + 16 }, path: new URL('company-sign-sculpture.png', OUT).pathname });
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() => document.querySelector('.marine-world__water').dataset.waterState === 'paused');
  let stopped = await page.evaluate(() => window.__waterDraws);
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.__waterDraws), stopped, 'Hidden page must stop drawing');
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction(() => document.querySelector('.marine-world__water').dataset.waterState === 'running');
  await page.locator('.marine-world__water').evaluate(canvas => { canvas.style.transform = 'translateY(200vh)'; });
  await page.waitForFunction(() => document.querySelector('.marine-world__water').dataset.waterState === 'paused');
  stopped = await page.evaluate(() => window.__waterDraws);
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.__waterDraws), stopped, 'Off-screen water must stop drawing');
  await page.locator('.marine-world__water').evaluate(canvas => { canvas.style.transform = ''; });
  await page.waitForFunction(() => document.querySelector('.marine-world__water').dataset.waterState === 'running');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.querySelector('.marine-world__water').style.opacity === '0');
  stopped = await page.evaluate(() => window.__waterDraws);
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.__waterDraws), stopped, 'Reduced motion must stop drawing');
  assert.deepEqual(errors, []);
  await context.close();
  console.log('PASS Ocean moves while land stays still; login/home retain approved brightness; hidden/off-screen/reduced-motion rendering pauses');

  const fallbackContext = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'no-preference' });
  await fallbackContext.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) { return type === 'webgl' ? null : getContext.call(this, type, ...args); };
  });
  const fallback = await fallbackContext.newPage();
  await fallback.goto(BASE, { waitUntil: 'domcontentloaded' });
  await fallback.waitForFunction(() => document.querySelector('.marine-world__water')?.dataset.waterState === 'fallback');
  assert.equal(await fallback.locator('.marine-world__harbour').evaluate(img => img.complete && img.naturalWidth > 0), true);
  assert.equal(await fallback.locator('video').count(), 0);
  await fallbackContext.close();
  console.log('PASS WebGL unavailable retains the clean harbor without generic traffic');
} finally {
  await browser.close();
}
