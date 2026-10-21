import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';

const base = process.env.ECO_BACKUP_PRIVACY_UI_ORIGIN || 'http://127.0.0.1:4397';
const out = resolve(process.env.ECO_BACKUP_PRIVACY_UI_OUTPUT || 'output/backup-privacy-ui');
const results = [];
await mkdir(out, { recursive: true });
function luminance(rgb) {
  return rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => value / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}
for (const [engine, kind] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await kind.launch({ headless: true });
  try { for (const width of [1440, 320, 390]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, isMobile: width < 760,
      hasTouch: width < 760, reducedMotion: 'reduce', colorScheme: theme });
    const calls = [], errors = [];
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      calls.push(url);
      if (url.origin !== new URL(base).origin || url.pathname.startsWith('/api/')) return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const shot = async name => {
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: horizontal overflow`);
      await page.screenshot({ path: resolve(out, `${engine}-${width}-${theme}-${name}.png`), fullPage: true, animations: 'disabled' });
    };
    try {
      const response = await page.goto(`${base}/backup-privacy.html`, { waitUntil: 'networkidle' });
      assert.equal(response.status(), 200);
      assert.match(response.headers()['content-type'], /text\/html/);
      await page.evaluate(() => document.fonts.ready);
      await expect(page.getByRole('heading', { name: 'ECO Nightly Backups', exact: true })).toBeVisible();
      await expect(page.locator('script,form,iframe')).toHaveCount(0);
      assert.ok(await page.evaluate(() => document.fonts.check('13px "DM Sans"') && document.fonts.check('20px Manrope')));
      const baselineHtml = await page.locator('main').innerHTML();
      const mail = page.getByRole('link', { name: 'otto@cosulich.com.hk', exact: true });
      await expect(mail).toHaveAttribute('href', 'mailto:otto@cosulich.com.hk');
      assert.equal(await mail.evaluate(element => getComputedStyle(element).textTransform), 'none');
      if (width < 760) assert.ok((await mail.boundingBox()).height >= 44);
      await page.keyboard.press(engine === 'webkit' ? 'Alt+Tab' : 'Tab');
      await expect(mail).toBeFocused();
      assert.equal(await mail.evaluate(element => getComputedStyle(element).outlineWidth), '2px');
      const colors = await page.locator('main').evaluate(element => ({ background: getComputedStyle(element).backgroundColor,
        ink: getComputedStyle(element).color, metadata: getComputedStyle(document.querySelector('.updated')).color }));
      assert.equal(colors.background, theme === 'dark' ? 'rgb(25, 43, 60)' : 'rgb(245, 249, 252)');
      for (const foreground of [colors.ink, colors.metadata]) {
        const values = [luminance(foreground), luminance(colors.background)].sort((a, b) => a - b);
        assert.ok((values[1] + 0.05) / (values[0] + 0.05) >= 4.5, 'body and metadata contrast');
      }
      await page.evaluate(() => scrollTo(0, 0));
      await shot('notice');
      await page.evaluate(() => document.documentElement.style.fontSize = '26px');
      assert.equal(await page.locator('section p').first().evaluate(element => getComputedStyle(element).fontSize), '26px');
      await shot('notice-200-percent-text');
      // Synthetic session markers prove the static page does not mutate cookies or storage.
      await context.addCookies([{ name: 'eco-backup-privacy-session', value: 'synthetic-only', url: base, httpOnly: true }]);
      await page.evaluate(() => localStorage.setItem('eco-backup-privacy-fixture', 'unchanged'));
      const beforeCookies = await context.cookies();
      const beforeStorage = await page.evaluate(() => ({ ...localStorage }));
      const authenticatedResponse = await page.reload({ waitUntil: 'networkidle' });
      assert.equal(authenticatedResponse.status(), 200);
      assert.equal(await page.locator('main').innerHTML(), baselineHtml);
      assert.deepEqual(await context.cookies(), beforeCookies);
      assert.deepEqual(await page.evaluate(() => ({ ...localStorage })), beforeStorage);
      assert.ok(calls.every(url => url.origin === new URL(base).origin && !url.pathname.startsWith('/api/')));
      assert.deepEqual(errors, []);
      results.push({ engine, width, theme, ok: true });
      console.log(`PASS ${engine} ${width} ${theme}`);
    } catch (error) {
      await shot('failure').catch(() => {});
      throw error;
    } finally { await context.close(); }
  } } finally { await browser.close(); }
}
await writeFile(resolve(out, 'results.json'), JSON.stringify({ results,
  checked: 'Public static page, no scripts/API/external requests, light/dark contrast, 200% text, keyboard focus, mobile touch target, synthetic cookie/storage invariance',
  limits: 'Isolated Chromium and WebKit against a local server. No real devices or live Vercel deployment were used.' }, null, 2));
