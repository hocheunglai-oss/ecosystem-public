import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { installStagingCookies } from './fixtures/protection-cookies.mjs';
import { accountPrivacyNotice } from '../server/auth/privacy.ts';
const base = process.env.ECO_PRIVACY_UI_ORIGIN || 'http://127.0.0.1:4396';
const out = resolve(process.env.ECO_PRIVACY_UI_OUTPUT || 'output/privacy-ui');
const member = { id: '10000000-0000-4000-8000-000000000001', email: 'trader@example.test', displayName: 'SAMPLE TRADER', phone: '+85251234567', officeId: 'HONG KONG', officeName: 'HONG KONG', isAdmin: false, isSpcTrader: false, isManager: false, isActive: true, activated: true, passwordChangeSuggested: false, revision: 1 };
const results = [];
await mkdir(out, { recursive: true });
for (const [engine, kind] of [['chromium', chromium], ['webkit', webkit]]) {
  if (process.env.ECO_TEST_ENGINE && process.env.ECO_TEST_ENGINE !== engine) continue;
  const browser = await kind.launch({ headless: true });
  try { for (const width of [1440, 320, 390]) for (const theme of ['light', 'dark']) {
    if (process.env.ECO_TEST_WIDTH && Number(process.env.ECO_TEST_WIDTH) !== width || process.env.ECO_TEST_THEME && process.env.ECO_TEST_THEME !== theme) continue;
    const context = await browser.newContext({ viewport: { width, height: 1000 }, isMobile: width < 760, hasTouch: width < 760, reducedMotion: 'reduce', colorScheme: theme });
    await installStagingCookies(context, base);
    let signedIn = false, privacyFailed = false, privacyReads = 0;
    const unexpected = [], writes = [], errors = [];
    await context.route('**/api/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (request.method() !== 'GET') writes.push(path);
      if (path === '/api/access/session') return route.fulfill(signedIn ? { json: { user: member, preview: null } } : { status: 401, json: { message: 'Sign in required.' } });
      if (path === '/api/access/privacy') { privacyReads++; return route.fulfill(privacyFailed ? { status: 503, json: { message: 'Unavailable.' } } : { json: accountPrivacyNotice }); }
      if (path === '/api/intelligence/snapshot') return route.fulfill({ json: { available: false, snapshot: null } });
      if (path === '/api/enquiries/test-policy') return route.fulfill({ json: { enabled: false, generation: '' } });
      if (path === '/api/enquiries/inbox') return route.fulfill({ json: { items: [], unreadCount: 0, nextCursor: null } });
      if (path === '/api/access/phone-requests') return route.fulfill({ json: { requests: [] } });
      if (path.startsWith('/api/admin/')) return route.fulfill({ json: { items: [], count: 0, nextCursor: null, periodStart: '2026-10-15T00:00:00Z', periodEnd: '2026-10-22T00:00:00Z', timeZone: 'Asia/Hong_Kong', source: 'shared-feedback' } });
      unexpected.push(path); return route.fulfill({ status: 503, json: { message: 'Unmatched fixture request.' } });
    });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(value => localStorage.setItem('ecosystem.theme.v1', value), theme);
    const shot = async (target, name) => {
      assert.ok(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: horizontal overflow`);
      await target.screenshot({ path: resolve(out, `${engine}-${width}-${theme}-${name}.png`), fullPage: true, animations: 'disabled' });
    };
    try {
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
      await expect(page.getByRole('link', { name: 'Privacy', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Privacy', exact: true })).toHaveCount(0);
      assert.equal(privacyReads, 0);
      await expect(page.locator('[data-artwork-ready]').first()).toHaveAttribute('data-artwork-ready', 'true');
      await page.evaluate(() => document.fonts.ready); await shot(page, 'sign-in');
      const publicPage = await context.newPage(), requests = [];
      publicPage.on('request', request => requests.push(request.url()));
      const response = await publicPage.goto(`${base}/privacy.html`, { waitUntil: 'domcontentloaded' });
      assert.equal(response.status(), 200); assert.equal((await response.body()).includes(Buffer.from('<script')), false);
      await expect(publicPage.getByRole('heading', { name: 'ECO Privacy Notice', exact: true })).toBeVisible();
      await expect(publicPage.locator('script,form,iframe')).toHaveCount(0);
      assert.doesNotMatch(await publicPage.locator('main').innerText(), /Vercel|Supabase|Singapore|fingerprint|routing|85298472818/i);
      const mail = publicPage.getByRole('link', { name: 'otto@cosulich.com.hk', exact: true });
      assert.equal(await mail.evaluate(element => getComputedStyle(element).textTransform), 'none');
      await publicPage.keyboard.press(engine === 'webkit' ? 'Alt+Tab' : 'Tab'); await expect(mail).toBeFocused();
      assert.equal(await mail.evaluate(element => getComputedStyle(element).outlineWidth), '2px');
      await publicPage.evaluate(() => document.fonts.ready); await shot(publicPage, 'public-notice');
      await publicPage.evaluate(() => document.documentElement.style.fontSize = '26px'); await shot(publicPage, 'public-notice-200-percent');
      assert.ok(requests.every(url => new URL(url).origin === new URL(base).origin && !new URL(url).pathname.startsWith('/api/')));
      await publicPage.close();
      signedIn = true; await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('main', { name: 'ECOSYSTEM workspace' })).toBeVisible();
      assert.equal(privacyReads, 0, 'account guidance loads only when requested');
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
      privacyFailed = true; await dialog.getByRole('button', { name: 'Privacy', exact: true }).click();
      await expect(dialog.getByRole('alert')).toContainText('Privacy information unavailable.');
      privacyFailed = false; await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
      const article = dialog.getByRole('article', { name: 'Privacy', exact: true });
      await expect(article.getByRole('heading', { name: 'Sign-in and browser storage', exact: true })).toBeVisible();
      await expect(article).toContainText('Private profile tabs belong to their owner.');
      await shot(page, 'settings-privacy');
      const ending = article.locator('p').last();
      await ending.scrollIntoViewIfNeeded(); await expect(ending).toBeInViewport();
      await shot(page, 'settings-privacy-end');
      signedIn = false; await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
      await expect(page.getByRole('article', { name: 'Privacy', exact: true })).toHaveCount(0);
      assert.deepEqual(writes, []); assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
      results.push({ engine, width, theme, ok: true }); console.log(`PASS ${engine} ${width} ${theme}`);
    } catch (error) { await shot(page, 'failure').catch(() => {}); throw error; }
    finally { await context.close(); }
  } } finally { await browser.close(); }
}
await writeFile(resolve(out, 'results.json'), JSON.stringify({ base, results, checked: 'No public Privacy action/account fetch; minimal static notice, keyboard/email/200% text; trader Settings privacy, retry, revocation cleanup.', limits: 'Isolated Chromium/WebKit with synthetic API. No real application credentials or business writes.' }, null, 2));
