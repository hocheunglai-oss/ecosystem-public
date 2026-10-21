import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { installStagingCookies } from './fixtures/protection-cookies.mjs';

const base = process.env.ECO_PRIVACY_UI_ORIGIN || 'http://127.0.0.1:4396';
const out = resolve(process.env.ECO_PRIVACY_UI_OUTPUT || 'output/privacy-ui');
const owner = { id: '10000000-0000-4000-8000-000000000001', email: 'otto@cosulich.com.hk', displayName: 'SAMPLE TRADER',
  phone: '+85251234567', officeId: 'HONG KONG', officeName: 'HONG KONG', isAdmin: true, isSpcTrader: true,
  isManager: false, isActive: true, activated: true, passwordChangeSuggested: false, revision: 1 };
const results = [];
await mkdir(out, { recursive: true });
for (const [engine, kind] of [['chromium', chromium], ['webkit', webkit]]) {
  if (process.env.ECO_TEST_ENGINE && process.env.ECO_TEST_ENGINE !== engine) continue;
  const browser = await kind.launch({ headless: true });
  try { for (const width of [1440, 320, 390]) for (const theme of ['light', 'dark']) {
    if (process.env.ECO_TEST_WIDTH && Number(process.env.ECO_TEST_WIDTH) !== width
      || process.env.ECO_TEST_THEME && process.env.ECO_TEST_THEME !== theme) continue;
    const context = await browser.newContext({ viewport: { width, height: 1000 }, isMobile: width < 760,
      hasTouch: width < 760, reducedMotion: 'reduce', colorScheme: theme });
    await installStagingCookies(context, base);
    let signedIn = false;
    const apiCalls = [], errors = [];
    await context.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url());
      apiCalls.push({ path: url.pathname, method: request.method() });
      if (url.pathname === '/api/access/session') {
        return route.fulfill(signedIn ? { json: { user: owner, preview: null } }
          : { status: 401, json: { message: 'Sign in required.' } });
      }
      if (url.pathname === '/api/enquiries/test-policy') return route.fulfill({ json: { enabled: false, generation: '' } });
      if (url.pathname === '/api/enquiries/inbox') return route.fulfill({ json: { items: [], unreadCount: 0, nextCursor: null } });
      return route.fulfill({ json: { items: [], requests: [], count: 0, page: 1, pageSize: 100, total: 0,
        nextCursor: null, periodStart: '2026-10-14T00:00:00Z', periodEnd: '2026-10-21T00:00:00Z',
        timeZone: 'Asia/Hong_Kong', source: 'shared-feedback' } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(value => localStorage.setItem('ecosystem.theme.v1', value), theme);
    const shot = async (target, name) => {
      assert.ok(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: horizontal overflow`);
      await target.screenshot({ path: resolve(out, `${engine}-${width}-${theme}-${name}.png`), fullPage: true, animations: 'disabled' });
    };
    try {
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
      await page.getByLabel('Email', { exact: true }).fill('synthetic@example.test');
      const link = page.getByRole('link', { name: 'Privacy', exact: true });
      await expect(link).toHaveAttribute('href', '/privacy.html');
      if (width < 760) assert.ok((await link.boundingBox()).height >= 44);
      await expect(page.locator('[data-artwork-ready]').first()).toHaveAttribute('data-artwork-ready', 'true');
      await page.evaluate(() => document.fonts.ready);
      await shot(page, 'sign-in');
      const popup = await Promise.all([page.waitForEvent('popup'), link.click()]).then(([value]) => value);
      const requests = [];
      popup.on('request', request => requests.push(request.url()));
      popup.on('pageerror', error => errors.push(error.message));
      await popup.waitForLoadState('domcontentloaded');
      await expect(popup.getByRole('heading', { name: 'ECO WhatsApp Privacy Notice', exact: true })).toBeVisible();
      await popup.evaluate(() => document.fonts.ready);
      const firstHtml = await popup.locator('main').innerHTML();
      const response = await popup.reload({ waitUntil: 'domcontentloaded' });
      assert.equal(response.status(), 200);
      assert.match(response.headers()['content-type'], /text\/html/);
      assert.equal((await response.body()).includes(Buffer.from('<script')), false, 'public page must not load application scripts');
      await popup.evaluate(() => document.fonts.ready);
      assert.equal(await popup.locator('main').innerHTML(), firstHtml);
      await expect(popup.locator('script,form,iframe')).toHaveCount(0);
      const mail = popup.getByRole('link', { name: 'otto@cosulich.com.hk', exact: true });
      await expect(mail).toHaveAttribute('href', 'mailto:otto@cosulich.com.hk');
      assert.equal(await mail.evaluate(element => getComputedStyle(element).textTransform), 'none');
      // WebKit's default keyboard-navigation preference uses Option+Tab for links.
      await popup.keyboard.press(engine === 'webkit' ? 'Alt+Tab' : 'Tab');
      await expect(mail).toBeFocused();
      assert.equal(await mail.evaluate(element => getComputedStyle(element).outlineWidth), '2px');
      const colors = await popup.locator('main').evaluate(element => ({ background: getComputedStyle(element).backgroundColor,
        ink: getComputedStyle(element).color }));
      assert.equal(colors.background, theme === 'dark' ? 'rgb(25, 43, 60)' : 'rgb(245, 249, 252)');
      await shot(popup, 'notice');
      // Text-only 200% enlargement: the root and rem-based headings scale together.
      await popup.evaluate(() => document.documentElement.style.fontSize = '26px');
      assert.equal(await popup.locator('p').first().evaluate(element => getComputedStyle(element).fontSize), '22px');
      await shot(popup, 'notice-200-percent-text');
      assert.ok(requests.every(url => new URL(url).origin === new URL(base).origin && !new URL(url).pathname.startsWith('/api/')));
      await popup.close();
      await expect(page.getByLabel('Email', { exact: true })).toHaveValue('synthetic@example.test');

      // A synthetic authenticated account exercises navigation/session invariance;
      // no personal browser or production application credentials are used.
      signedIn = true;
      await context.addCookies([{ name: 'eco-privacy-session-fixture', value: 'synthetic-only', url: base, httpOnly: true }]);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
      const beforeStorage = await page.evaluate(() => ({ ...localStorage }));
      const beforeCookies = (await context.cookies()).filter(cookie => cookie.name.startsWith('eco-'));
      const publicRequests = [];
      const listener = request => publicRequests.push(request.url());
      page.on('request', listener);
      const authenticatedResponse = await page.goto(`${base}/privacy.html`, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => document.fonts.ready);
      assert.equal(authenticatedResponse.status(), 200);
      assert.equal(await page.locator('main').innerHTML(), firstHtml);
      assert.deepEqual(await page.evaluate(() => ({ ...localStorage })), beforeStorage);
      assert.deepEqual((await context.cookies()).filter(cookie => cookie.name.startsWith('eco-')), beforeCookies);
      assert.ok(publicRequests.every(url => new URL(url).origin === new URL(base).origin && !new URL(url).pathname.startsWith('/api/')));
      page.off('request', listener);
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
      assert.ok(!apiCalls.some(call => call.method !== 'GET'));
      assert.deepEqual(errors, []);
      results.push({ engine, width, theme, ok: true, checked: 'public route, sign-in link, no scripts/API, focus, email case, 200% text, authenticated navigation invariance' });
      console.log(`PASS ${engine} ${width} ${theme}`);
    } catch (error) {
      await shot(page, 'failure').catch(() => {});
      throw error;
    } finally { await context.close(); }
  } } finally { await browser.close(); }
}
await writeFile(resolve(out, 'results.json'), JSON.stringify({ base, results,
  limits: 'Isolated Chromium and WebKit. Authenticated app state is synthetic. 200% enlargement uses root text size. Live Vercel route/security headers and real Meta delivery require separate staged verification.' }, null, 2));
