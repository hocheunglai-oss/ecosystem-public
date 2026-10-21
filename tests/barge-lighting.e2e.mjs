import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit, expect } from '@playwright/test';
import { installStagingCookies } from './fixtures/protection-cookies.mjs';

const BASE = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4198';
const output = new URL('../artifacts/barge-lighting/', import.meta.url);
await mkdir(output, { recursive: true });

// Computed CSS alone missed WebKit's ignored SVG brightness filter. Compare
// rendered hull pixels with the same unfiltered artwork on a constant backdrop.
async function meanLuminance(page, screenshots) {
  return page.evaluate(async images => Promise.all(images.map(async encoded => {
    const image = new Image();
    image.src = `data:image/png;base64,${encoded}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    let total = 0, count = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] === 20 && pixels[i + 1] === 40 && pixels[i + 2] === 60) continue;
      total += .2126 * pixels[i] + .7152 * pixels[i + 1] + .0722 * pixels[i + 2];
      count++;
    }
    if (!count) throw new Error('The vessel did not render');
    return total / count;
  })), screenshots.map(image => image.toString('base64')));
}

for (const [engine, browserType] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await browserType.launch({ headless: true,
    ...(engine === 'chromium' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}),
  });
  try {
    for (const mobile of [false, true]) for (const theme of ['light', 'dark']) {
      const label = `${engine}-${mobile ? 'mobile' : 'desktop'}-${theme}`;
      const context = await browser.newContext({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1671, height: 941 },
        isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1, reducedMotion: 'reduce',
      });
      try {
        await installStagingCookies(context, BASE);
        await context.addInitScript(theme => localStorage.setItem('ecosystem.theme.v1', theme), theme);
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(BASE, { waitUntil: 'domcontentloaded' });
        const root = page.locator(mobile ? '.mobile-harbour-background' : '.marine-world');
        await expect(root).toHaveAttribute('data-artwork-ready', 'true');
        await expect(root.locator('[data-cosulich-barge]')).toHaveCount(2);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await page.screenshot({ path: new URL(`${label}.png`, output).pathname });

        for (const vessel of ['cosulich', 'cosulich-lng']) {
          const hull = root.locator(`[data-cosulich-barge="${vessel}"] > image`);
          const original = await hull.evaluate(image => ({
            x: image.getAttribute('x'), y: image.getAttribute('y'),
            width: image.getAttribute('width'), height: image.getAttribute('height'),
          }));
          assert.deepEqual(original, vessel === 'cosulich-lng'
            ? { x: '570', y: '328', width: '200', height: '100' }
            : { x: '925', y: '407', width: '240', height: '120' }, 'Preserve approved vessel size and berth');
          await hull.evaluate(image => {
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.id = 'barge-lighting-probe';
            svg.setAttribute('viewBox', ['x', 'y', 'width', 'height'].map(name => image.getAttribute(name)).join(' '));
            svg.style.cssText = 'position:fixed;left:0;top:0;width:390px;height:195px;background:rgb(20,40,60);z-index:100000';
            const copy = image.parentElement.cloneNode(true);
            // Keep cloned filter/reflection references independent from the scene.
            const ids = new Map([...copy.querySelectorAll('[id]')].map(node => [node.id, `probe-${node.id}`]));
            for (const node of copy.querySelectorAll('*')) for (const attribute of [...node.attributes]) {
              let value = attribute.value;
              if (attribute.name === 'id') value = ids.get(value) ?? value;
              else for (const [before, after] of ids) {
                value = value.replaceAll(`url(#${before})`, `url(#${after})`);
                if (value === `#${before}`) value = `#${after}`;
              }
              if (value !== attribute.value) node.setAttribute(attribute.name, value);
            }
            svg.append(copy);
            document.body.append(svg);
          });
          const probe = page.locator('#barge-lighting-probe');
          const filtered = await probe.screenshot({ path: new URL(`${label}-${vessel}.png`, output).pathname });
          await probe.locator('image').evaluate(image => {
            image.removeAttribute('filter');
            image.style.filter = 'none';
          });
          const unfiltered = await probe.screenshot();
          const [lit, raw] = await meanLuminance(page, [filtered, unfiltered]);
          const ratio = lit / raw;
          assert.ok(theme === 'dark' ? ratio > .35 && ratio < .72 : ratio > .85 && ratio < 1.1,
            `${label} ${vessel}: lighting must actually render (filtered/raw luminance ${ratio.toFixed(3)})`);
          await probe.evaluate(element => element.remove());
        }
        const nextTheme = theme === 'dark' ? 'light' : 'dark';
        await page.getByRole('button', { name: new RegExp(`^${nextTheme} mode$`, 'i') }).click();
        await expect(page.locator('html')).toHaveAttribute('data-theme', nextTheme);
        await expect(page.locator('.mobile-theme-snapshot')).toHaveCount(0);
        await expect(root.locator('[data-cosulich-barge]')).toHaveCount(2);
        for (const func of await root.locator('[data-cosulich-barge] feFuncR').all()) {
          await expect(func).toHaveAttribute('slope', nextTheme === 'dark' ? '.624' : '.96');
        }
        assert.deepEqual(errors, []);
        console.log(`PASS ${label}: both rendered hull colours, approved geometry and theme switching`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
}
