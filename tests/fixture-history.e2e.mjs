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
const secondSupplierId = '60000000-0000-4000-8000-000000000003';
const seller = { ...member, id: '60000000-0000-4000-8000-000000000004', displayName: 'ASSIGNED TRADER', isSpcTrader: true };
const enquiryId = '60000000-0000-4000-8000-000000000005';
const bookingId = '60000000-0000-4000-8000-000000000006';
const enquiry = {
  id: enquiryId, ownerId: member.id, ownerName: member.displayName, reference: 'ECO-00000001', revision: 1, status: 'confirmed',
  vessel: 'SYNTHETIC SPLIT', imo: '', eta: '12 OCT 2026', products: [{ grade: 'VLSFO', quantityText: '200-300' }],
  port: { id: 'port-singapore', countryCode: 'SG', countryName: 'Singapore', portName: 'Singapore' },
  createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', confirmedAt: '2026-10-10T00:00:00Z', queue: null,
};
const records = Array.from({ length: 51 }, (_, index) => ({
  id: `60000001-0000-4000-8000-${String(index).padStart(12, '0')}`, date: index === 50 ? '2025-03-09' : '2026-10-10',
  supplierTrader: index === 50 ? 'SECOND SELLER' : 'LANA TEST', supplierOffice: index === 50 ? 'GENOA' : 'SINGAPORE',
  supplierOfficeCode: index === 50 ? 'IT' : 'SG', supplierTraderId: index === 50 ? member.id : seller.id,
  buyerTrader: 'LONG TEST', buyerOffice: index === 50 ? 'GENOA' : 'HONG KONG',
  buyerOfficeCode: index === 50 ? 'IT' : 'HK', buyerTraderId: member.id,
  account: 'SINGAPORE', eta: null, vessel: index === 50 ? 'SYNTHETIC OSPREY' : 'SYNTHETIC TERN', imo: index === 50 ? '9876543' : null,
  hsfo: null, vlsfo: '160–220', lsmgo: null, supplierId, supplier: 'SYNTHETIC SUPPLIER', supplierAvailable: true,
  price: 'USD 455/MT', barging: null,
  cancelled: index === 50, canEdit: false,
  ...(index === 50 ? { lsmgo: '60–70', supplyRows: [
    { hsfo: null, vlsfo: '160–220', lsmgo: null, supplierId, supplier: 'SYNTHETIC SUPPLIER',
      supplierAvailable: true, account: 'SINGAPORE', price: 'USD 455/MT', barging: null, cancelled: true },
    { hsfo: null, vlsfo: null, lsmgo: '60–70', supplierId: secondSupplierId, supplier: 'SYNTHETIC SUPPLIER TWO',
      supplierAvailable: true, account: 'ITALY', price: 'USD 490/MT', barging: null, cancelled: true },
  ] } : {}),
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
      let actor = member;
      let booking;
      let draft;
      const accounts = [{ id: 'ITALY', name: 'ITALY' }, { id: 'SINGAPORE', name: 'SINGAPORE' }];
      const suppliers = [{ id: supplierId, name: 'SYNTHETIC SUPPLIER' }, { id: secondSupplierId, name: 'SYNTHETIC SUPPLIER TWO' }];
      const quantityReview = { HSFO: { min: 75, max: 6000 }, VLSFO: { min: 70, max: 3500 }, LSMGO: { min: 15, max: 1000 } };
      const bookingVersion = () => String(booking.revision).padStart(32, '0');
      let fail = false;
      const errors = [];
      await context.route('**/api/**', async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname === '/api/access/session') return route.fulfill({ status: signedIn ? 200 : 401, json: { user: signedIn ? actor : null } });
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
          const deleted = url.searchParams.has('deleted');
          const rows = booking ? [{ ...records[0], ...booking, supplierOffice: 'SINGAPORE', supplierOfficeCode: 'SG',
            buyerOffice: 'HONG KONG', buyerOfficeCode: 'HK', canEdit: actor.id === seller.id,
            account: null, supplier: '', supplierId: '', supplierAvailable: false, price: null, vlsfo: booking.status === 'pending'
              ? enquiry.products[0].quantityText : String(booking.lines.reduce((sum, line) => sum + line.quantity, 0)) }, ...records] : records;
          const visible = rows.filter(row => Boolean(row.deleted) === deleted);
          const parties = column => [...new Map(visible.map(row => {
            const id = row[column + 'TraderId'];
            const code = row[column + 'OfficeCode'];
            return [id + code, { id, name: row[column + 'Trader'], code, office: row[column + 'Office'] }];
          })).values()];
          const matches = visible.filter(row => (!year || Number(row.date.slice(0, 4)) === year) &&
            (!month || Number(row.date.slice(5, 7)) === month) && row.vessel.includes(search) &&
            ['supplier', 'buyer'].every(column => {
              const office = url.searchParams.get(column + 'Office');
              const trader = url.searchParams.get(column + 'Trader');
              return (!office || row[column + 'OfficeCode'] === office) && (!trader || row[column + 'TraderId'] === trader);
            }));
          return route.fulfill({ json: { items: matches.slice(page * 50, page * 50 + 50), total: matches.length,
            filters: { supplier: parties('supplier'), buyer: parties('buyer'), canSeeDeleted: Boolean(booking?.deleted) } } });
        }
        if (url.pathname === '/api/enquiries/records') {
          return route.fulfill({ json: { items: actor.id === member.id ? [{ ...enquiry, fixture: booking }] : [], nextCursor: null } });
        }
        if (url.pathname === '/api/enquiries/fixtures') {
          assert.equal(request.headers()['x-eco-data-mode'], 'live');
          if (url.searchParams.has('options')) return route.fulfill({ json: {
            accounts,
            traders: [{ id: seller.id, name: seller.displayName, office: 'SINGAPORE' }],
            quantityReview,
          } });
          if (request.method() === 'GET') {
            if (url.searchParams.has('edit')) {
              assert.equal(actor.id, seller.id);
              assert.equal(url.searchParams.get('edit'), bookingId);
              const fields = draft ?? {
                vessel: booking.vessel, imo: booking.imo, date: booking.date, eta: booking.eta, etaEnd: booking.etaEnd,
                etaKind: booking.etaKind, etaReviewed: false,
                lines: [{ grade: 'VLSFO', quantity: '200-300', supplierId: '', accountId: '', price: '', barging: '', cancelled: false }],
              };
              return route.fulfill({ json: { item: booking, fields, version: bookingVersion(), accounts, suppliers, quantityReview, reference: booking.reference,
                canConfirm: booking.status === 'pending' && !booking.deleted, canCancel: booking.status === 'confirmed' && !booking.cancelled && !booking.deleted } });
            }
            return route.fulfill({ json: { ...booking,
              canConfirm: !booking.cancelled && actor.id === seller.id && booking.status === 'pending',
              canCancel: !booking.cancelled && (booking.status === 'pending' ? actor.id === member.id : actor.id === seller.id),
            } });
          }
          const body = request.postDataJSON();
          if (body.action === 'assign') {
            assert.equal(actor.id, member.id);
            assert.equal(body.enquiryId, enquiryId);
            assert.equal(body.supplierTraderId, seller.id);
            assert.equal(body.eta, '2026-10-12');
            assert.equal(body.etaEnd, '2026-10-14');
            booking = { ...body, id: bookingId, revision: 1, status: 'pending', vessel: enquiry.vessel, imo: '',
              supplierTrader: seller.displayName, supplierOffice: 'SINGAPORE', supplierOfficeCode: 'SG',
              buyerTrader: member.displayName, buyerOffice: 'HONG KONG', buyerOfficeCode: 'HK', reference: enquiry.reference,
              confirmedAt: null, requested: enquiry.products, lines: [], cancellation: null };
          } else {
            assert.equal(actor.id, seller.id);
            assert.equal(body.version, bookingVersion());
            switch (body.action) {
              case 'update':
                draft = body.fields;
                assert.equal(draft.etaEnd, '2026-10-15');
                assert.equal(draft.imo, '9876543');
                booking = { ...booking, imo: draft.imo, etaEnd: draft.etaEnd };
                break;
              case 'complete': {
                const { fields } = body;
                if (!body.quantityReviewed) return route.fulfill({ status: 422, json: { message: 'Review unusually high or low quantities' } });
                assert.deepEqual(fields.lines.map(line => [line.grade, line.quantity, line.supplierId, line.accountId, line.price]),
                  [['VLSFO', '250', supplierId, 'SINGAPORE', '500'], ['VLSFO', '25', secondSupplierId, 'ITALY', '490']]);
                draft = fields;
                booking = { ...booking, status: 'confirmed', confirmedAt: '2026-10-10T04:00:00Z',
                  lines: fields.lines.map(line => ({ ...line, quantity: Number(line.quantity), buyPrice: Number(line.price),
                    account: line.accountId, supplierAvailable: true, supplier: suppliers.find(supplier => supplier.id === line.supplierId).name })) };
                break;
              }
              case 'void':
                assert.equal(body.reason, 'SYNTHETIC WITHDRAWAL');
                booking = { ...booking, cancelled: true,
                  cancellation: { at: '2026-10-10T05:00:00Z', by: seller.displayName, reason: body.reason } };
                break;
              case 'delete':
              case 'restore':
                booking = { ...booking, deleted: body.action === 'delete' };
                break;
              default: assert.fail('Unexpected fixture write');
            }
            booking.revision++;
          }
          return route.fulfill({ json: booking });
        }
        if (url.pathname === '/api/suppliers/list') return route.fulfill({ json: {
          items: [
            { id: supplierId, legalName: 'SYNTHETIC SUPPLIER', shortName: 'SYNTHETIC SUPPLIER', countryCode: 'SG', aliases: [] },
            { id: secondSupplierId, legalName: 'SYNTHETIC SUPPLIER TWO', shortName: 'SYNTHETIC SUPPLIER TWO', countryCode: 'SG', aliases: [] },
          ], total: 2, page: 1, pageSize: 100,
        } });
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
        await expect(grid.getByRole('columnheader')).toHaveText(['DATE', 'SUPPLIER TRADER', 'BUYER TRADER', 'VESSEL', 'ETA', 'HSFO', 'VLSFO', 'LSMGO']);
        await expect(dialog.getByRole('status')).toHaveText('1–50 OF 51');
        await expect(grid.locator('tbody tr')).toHaveCount(50);
        assert.ok(await grid.evaluate(node => node.scrollWidth > node.clientWidth || innerWidth > 760), 'Narrow table scrolls inside its window');
        await expect(grid.getByText('LANA (SG)', { exact: true })).toHaveCount(50);
        await expect(grid.getByText('LONG (HK)', { exact: true })).toHaveCount(50);
        await shot('fixtures');
        for (const [column, id] of [['SUPPLIER TRADER', member.id], ['BUYER TRADER', member.id]]) {
          await grid.getByRole('button', { name: 'FILTER ' + column }).click();
          await dialog.getByLabel(column + ' OFFICE', { exact: true }).selectOption('IT');
          await dialog.getByLabel(column + ' NAME', { exact: true }).selectOption(id);
          await expect(dialog.getByRole('status')).toHaveText('1–1 OF 1');
          await dialog.getByLabel(column + ' OFFICE', { exact: true }).selectOption('');
          await dialog.getByLabel(column + ' NAME', { exact: true }).selectOption('');
          await dialog.getByRole('button', { name: 'DONE', exact: true }).click();
          await expect(dialog.getByRole('status')).toHaveText('1–50 OF 51');
        }
        await dialog.getByRole('button', { name: 'Next fixtures page' }).click();
        await expect(grid.getByText('SYNTHETIC OSPREY (9876543)', { exact: true })).toBeVisible();
        await expect(grid.getByText('CANCELLED', { exact: true })).toBeVisible();
        await expect(grid.locator('s, del')).toHaveCount(0);
        await expect(dialog.getByRole('status')).toHaveText('51–51 OF 51');
        await dialog.getByRole('button', { name: 'Previous fixtures page' }).click();
        await expect(dialog.getByRole('status')).toHaveText('1–50 OF 51');
        await dialog.getByLabel('Fixture year').selectOption('2025');
        await dialog.getByLabel('Fixture month').selectOption('3');
        await dialog.getByRole('searchbox', { name: 'Search fixtures' }).fill('OSPREY');
        await expect(grid.getByText('SYNTHETIC OSPREY (9876543)', { exact: true })).toBeVisible();
        await expect(grid.getByText('LONG (IT)', { exact: true })).toBeVisible();
        fail = true;
        await dialog.getByRole('button', { name: 'REFRESH', exact: true }).click();
        await expect(grid.getByRole('alert')).toContainText('FIXTURES UNAVAILABLE');
        fail = false;
        await dialog.getByRole('button', { name: 'REFRESH', exact: true }).click();
        await grid.getByRole('button', { name: 'SYNTHETIC OSPREY' }).click();
        const archived = page.getByRole('dialog', { name: 'SYNTHETIC OSPREY (9876543)', exact: true });
        await expect(archived.getByRole('button', { name: 'EDIT', exact: true })).toHaveCount(0);
        await expect(archived).toContainText('160–220');
        await expect(archived).toContainText('60–70');
        await expect(archived).toContainText('USD 455/MT');
        await expect(archived.getByText('CANCELLED', { exact: true })).toBeVisible();
        await shot('fixture-history-details');
        const [detail] = await Promise.all([
          page.waitForResponse(response => new URL(response.url()).pathname === '/api/suppliers/detail'),
          archived.getByRole('button', { name: 'SYNTHETIC SUPPLIER', exact: true }).click(),
        ]);
        assert.equal(detail.status(), 200);
        await expect(page.getByRole('dialog', { name: 'Supplier Profiles', exact: true })).toContainText('SYNTHETIC SUPPLIER');
        async function openTrading(name) {
          const group = nav.getByRole('button', { name: 'Trading', exact: true });
          if (await group.getAttribute('aria-expanded') !== 'true') await group.click();
          await nav.getByRole('button', { name, exact: true }).click();
          return page.getByRole('dialog', { name, exact: true });
        }
        await page.reload();
        const enquiries = await openTrading('Enquiries');
        await enquiries.getByRole('button', { name: 'STEM', exact: true }).click();
        const stem = page.getByRole('dialog', { name: 'STEM', exact: true });
        await stem.getByLabel('SUPPLIER TRADER', { exact: true }).selectOption(seller.id);
        await stem.getByLabel('DATE', { exact: true }).fill('2026-10-10');
        await stem.getByLabel('ETA', { exact: true }).selectOption('range');
        await stem.getByLabel(/LATEST ETA/).fill('2026-10-14');
        await shot('fixture-handoff');
        await stem.getByRole('button', { name: 'SAVE', exact: true }).click();
        await expect(enquiries).toContainText(/pending.*assigned trader/i);
        actor = seller;
        await page.reload();
        const ledger = await openTrading('Fixtures');
        const bookingRow = ledger.locator('tr[data-record-id="' + bookingId + '"]');
        async function openEditor() {
          const vessel = bookingRow.getByRole('button', { name: /SYNTHETIC SPLIT/ });
          if (width >= 760) await vessel.dblclick();
          else {
            await vessel.tap();
            await page.getByRole('dialog', { name: /SYNTHETIC SPLIT/ }).getByRole('button', { name: 'EDIT', exact: true }).tap();
          }
          const editor = page.getByRole('dialog', { name: 'EDIT FIXTURE', exact: true });
          await expect(editor.getByLabel('ETA FROM')).toBeVisible();
          return editor;
        }
        let supply = await openEditor();
        await expect(supply.getByLabel('Quantity 1')).toHaveValue('200-300');
        await supply.getByLabel('IMO', { exact: true }).fill('9876543');
        await supply.getByLabel('ETA TO', { exact: true }).fill('2026-10-15');
        await supply.getByLabel('Quantity 1').fill('250');
        await supply.getByLabel('Supplier 1').selectOption(supplierId);
        await supply.getByLabel('Account 1').selectOption('SINGAPORE');
        await supply.getByLabel('Buy price 1').fill('500');
        await supply.getByRole('button', { name: 'ADD LINE' }).click();
        await supply.getByLabel('Quantity 2').fill('25');
        await supply.getByLabel('Supplier 2').selectOption(secondSupplierId);
        await supply.getByLabel('Account 2').selectOption('ITALY');
        await supply.getByLabel('Buy price 2').fill('490');
        await supply.getByLabel('Barging 2').fill('1,500');
        const overflow = await supply.locator('form').evaluate(form => {
          const bounds = form.getBoundingClientRect();
          return [...form.querySelectorAll('input, select')].flatMap(control => {
            const rect = control.getBoundingClientRect();
            if (rect.left >= bounds.left && rect.right <= bounds.right + 1) return [];
            const row = control.closest('tr');
            const table = row?.closest('table');
            return [{ label: control.getAttribute('aria-label'), right: rect.right, formRight: bounds.right,
              layout: [table, table?.parentElement, row, control.closest('td')].filter(Boolean).map(element => {
                const style = getComputedStyle(element);
                return [element.tagName, style.display, style.width, style.minWidth, style.height, style.gridTemplateRows];
              }) }];
          });
        });
        assert.deepEqual(overflow, [], 'Editor fields stay inside the form');
        await shot('fixture-editor');
        await supply.getByRole('button', { name: 'SAVE', exact: true }).click();
        await expect(supply).toBeHidden();
        await expect(bookingRow).toContainText('SYNTHETIC SPLIT (9876543)');
        await expect(bookingRow).toContainText('12 Oct 2026 – 15 Oct 2026');
        await expect(bookingRow).not.toContainText('FROM');

        supply = await openEditor();
        await expect(supply.getByLabel('Barging 2')).toHaveValue('1,500');
        await expect(supply.getByRole('button', { name: 'CONFIRM', exact: true })).toBeDisabled();
        await supply.getByLabel('CONFIRM UNUSUAL QUANTITIES').check();
        await supply.getByRole('button', { name: 'CONFIRM', exact: true }).click();
        await expect(supply).toBeHidden();
        await expect(bookingRow).toContainText('275');

        supply = await openEditor();
        await supply.getByRole('button', { name: 'FIXTURE CANCELLED', exact: true }).click();
        await expect(supply.getByRole('button', { name: 'CONFIRM CANCELLATION' })).toBeDisabled();
        await supply.getByRole('textbox', { name: 'REASON' }).fill('SYNTHETIC WITHDRAWAL');
        await supply.getByRole('button', { name: 'CONFIRM CANCELLATION' }).click();
        await expect(supply).toBeHidden();
        await expect(bookingRow.locator('button .fixture-cancelled')).toHaveText('CANCELLED');
        await expect(bookingRow.locator('button .fixture-cancelled')).toHaveCSS('color', theme === 'dark' ? 'rgb(255, 180, 192)' : 'rgb(164, 47, 59)');
        await shot('cancelled-stem');

        supply = await openEditor();
        await expect(supply).toContainText('SYNTHETIC WITHDRAWAL');
        await expect(supply.getByLabel('Buy price 2')).toHaveValue('490');
        await supply.getByRole('button', { name: 'DELETE', exact: true }).click();
        await supply.getByRole('button', { name: 'CONFIRM DELETE', exact: true }).click();
        await expect(bookingRow).toHaveCount(0);
        await ledger.getByRole('button', { name: 'DELETED', exact: true }).click();
        await bookingRow.getByRole('button', { name: /SYNTHETIC SPLIT/ }).click();
        await supply.getByRole('button', { name: 'RESTORE', exact: true }).click();
        await expect(supply).toBeHidden();
        await ledger.getByRole('button', { name: 'DELETED', exact: true }).click();
        await expect(bookingRow).toContainText('CANCELLED');
        assert.deepEqual(errors, []);
        results.push({ engine, width, theme, ok: true });
        console.log(`PASS ${engine} ${width} ${theme}: sign-in, fixture grid, filters, historical details, buyer handoff, fixture editing, cancellation and restoration`);
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
