import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect, webkit } from '@playwright/test';
import { installStagingCookies } from './fixtures/protection-cookies.mjs';

const base = process.env.ECO_COMMERCIAL_UI_ORIGIN || 'http://127.0.0.1:4396';
const output = resolve(process.env.ECO_FIXTURE_UI_OUTPUT || 'output/fixture-history-ui');
const member = {
  id: '60000000-0000-4000-8000-000000000001', email: 'fixture-trader@example.test', displayName: 'FIXTURE TRADER',
  officeId: 'HONG KONG', officeName: 'Hong Kong', isAdmin: false, isSpcTrader: false, isManager: false,
  isActive: true, activated: true, passwordChangeSuggested: false, revision: 1,
};
const supplierId = '60000000-0000-4000-8000-000000000002';
const records = Array.from({ length: 51 }, (_, index) => ({
  id: `60000001-0000-4000-8000-${String(index).padStart(12, '0')}`, date: index === 50 ? '2025-03-09' : '2026-10-10',
  supplierTrader: 'SYNTHETIC SELLER', supplierOffice: 'SINGAPORE', buyerTrader: 'FIXTURE TRADER', buyerOffice: 'GENOA',
  account: 'SINGAPORE', eta: null, vessel: index === 50 ? 'SYNTHETIC OSPREY' : 'SYNTHETIC TERN', imo: null,
  hsfo: null, vlsfo: '160–220', lsmgo: null, supplierId, supplier: 'SYNTHETIC SUPPLIER', supplierAvailable: true,
  price: 'USD 455/MT', barging: null,
}));

const results = [];
await mkdir(output, { recursive: true });
for (const [engine, driver] of [['chromium', chromium], ['webkit', webkit]]) {
  if (process.env.ECO_TEST_ENGINE && process.env.ECO_TEST_ENGINE !== engine) continue;
  const browser = await driver.launch({ headless: true });
  try {
    for (const width of [1440, 320, 390]) for (const theme of ['light', 'dark']) {
      if ((process.env.ECO_TEST_WIDTH && Number(process.env.ECO_TEST_WIDTH) !== width) ||
          (process.env.ECO_TEST_THEME && process.env.ECO_TEST_THEME !== theme)) continue;
      const context = await browser.newContext({ viewport: { width, height: 920 }, isMobile: width < 760,
        hasTouch: width < 760, reducedMotion: 'reduce', colorScheme: theme });
      await context.addInitScript(value => localStorage.setItem('ecosystem.theme.v1', value), theme);
      await installStagingCookies(context, base);
      let signedIn = false;
      let fail = false;
      const errors = [];
      await context.route('**/api/**', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname === '/api/access/session') return route.fulfill({ status: signedIn ? 200 : 401, json: { user: signedIn ? member : null } });
        if (url.pathname === '/api/access/login') {
          signedIn = true;
          return route.fulfill({ json: { user: member } });
        }
        if (url.pathname === '/api/access/fixture-history') {
          assert.equal(signedIn, true);
          assert.equal(request.method(), 'GET');
          assert.equal(request.headers()['x-eco-data-mode'], 'live');
          if (fail) return route.fulfill({ status: 503, json: { message: 'Fixtures unavailable' } });
          const [year, month, page] = ['year', 'month', 'page'].map(key => Number(url.searchParams.get(key)));
          const search = url.searchParams.get('search').toUpperCase();
          const matches = records.filter(row => (!year || Number(row.date.slice(0, 4)) === year) &&
            (!month || Number(row.date.slice(5, 7)) === month) && row.vessel.includes(search));
          return route.fulfill({ json: { items: matches.slice(page * 50, page * 50 + 50), total: matches.length } });
        }
        if (url.pathname === '/api/suppliers/detail') {
          assert.equal(url.searchParams.get('id'), supplierId);
          return route.fulfill({ json: { item: {
            id: supplierId, sourceKey: 'test-supplier', legacyIds: [], aliases: [], legalName: 'SYNTHETIC SUPPLIER LTD', shortName: 'SYNTHETIC SUPPLIER',
            countryCode: 'SG', portName: 'Singapore', countryName: 'Singapore', revision: 1, updatedAt: '2026-10-10T00:00:00Z',
            nameStatus: 'verified', info: { paymentTerms: '', qualityClaimBar: '', supplierTrader: '', availableGrade: 'VLSFO', foBdn: '', goBdn: '' },
            contacts: [], barges: [], sources: [], facts: [], legalNameSourceId: null, background: '',
          } } });
        }
        if (url.pathname === '/api/enquiries/test-policy') return route.fulfill({ json: { enabled: false, generation: '' } });
        if (url.pathname === '/api/profile-tabs/list') return route.fulfill({ json: {
          target: { kind: url.searchParams.get('kind'), id: url.searchParams.get('id') }, shared: { revision: 0, tabs: [] }, private: { revision: 0, tabs: [] },
        } });
        return route.fulfill({ json: { items: [], count: 0, total: 0, unreadCount: 0, nextCursor: null } });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      page.on('pageerror', error => errors.push(error.message));
      const shot = async name => {
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No page overflow');
        await page.screenshot({ path: resolve(output, `${engine}-${width}-${theme}-${name}.png`), fullPage: true, animations: 'disabled' });
      };
      try {
        await page.goto(base);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await page.getByLabel('Email', { exact: true }).fill(member.email);
        await page.getByLabel('Password', { exact: true }).fill('Synthetic Password 8');
        await shot('sign-in');
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
        const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
        const trading = nav.getByRole('button', { name: 'Trading', exact: true });
        if (await trading.getAttribute('aria-expanded') !== 'true') await trading.click();
        await nav.getByRole('button', { name: 'Fixtures', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Fixtures', exact: true });
        const grid = dialog.getByRole('region', { name: 'Fixture table', exact: true });
        await expect(grid.getByRole('columnheader')).toHaveText(['DATE', 'SUPPLIER TRADER', 'BUYER TRADER', 'ACCT', 'ETA', 'VESSEL',
          'IMO', 'HSFO', 'VLSFO', 'LSMGO', 'SUPPLIER', 'PRICE', 'BARGING']);
        await expect(dialog.getByRole('status')).toHaveText('1–50 OF 51');
        await expect(grid.locator('tbody tr')).toHaveCount(50);
        assert.ok(await grid.evaluate(node => node.scrollWidth > node.clientWidth || innerWidth > 760), 'Narrow table scrolls inside its window');
        await shot('fixtures');
        await dialog.getByRole('button', { name: 'Next fixtures page' }).click();
        await expect(grid.getByText('SYNTHETIC OSPREY', { exact: true })).toBeVisible();
        await expect(dialog.getByRole('status')).toHaveText('51–51 OF 51');
        await dialog.getByRole('button', { name: 'Previous fixtures page' }).click();
        await expect(dialog.getByRole('status')).toHaveText('1–50 OF 51');
        await dialog.getByLabel('Fixture year').selectOption('2025');
        await dialog.getByLabel('Fixture month').selectOption('3');
        await dialog.getByRole('searchbox', { name: 'Search fixtures' }).fill('OSPREY');
        await expect(grid.getByText('SYNTHETIC OSPREY', { exact: true })).toBeVisible();
        await expect(grid.getByText('GENOA', { exact: true })).toBeVisible();
        fail = true;
        await dialog.getByRole('button', { name: 'REFRESH', exact: true }).click();
        await expect(grid.getByRole('alert')).toContainText('FIXTURES UNAVAILABLE');
        fail = false;
        await dialog.getByRole('button', { name: 'REFRESH', exact: true }).click();
        const detail = page.waitForResponse(response => new URL(response.url()).pathname === '/api/suppliers/detail');
        await grid.getByRole('button', { name: 'SYNTHETIC SUPPLIER' }).click();
        assert.equal((await detail).status(), 200);
        await expect(page.getByRole('dialog', { name: 'Supplier Profiles', exact: true })).toContainText('SYNTHETIC SUPPLIER');
        assert.deepEqual(errors, []);
        results.push({ engine, width, theme, ok: true });
        console.log(`PASS ${engine} ${width} ${theme}: sign-in, SPC columns, filters, pages, retry, supplier link`);
      } catch (error) {
        await shot('failure').catch(() => {});
        throw error;
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
}
await writeFile(resolve(output, 'results.json'), JSON.stringify({
  results, scope: 'Isolated browsers with synthetic sign-in, fixture and supplier API responses.',
}, null, 2));
