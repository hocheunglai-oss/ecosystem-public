import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect, webkit } from '@playwright/test';
import { installStagingCookies } from './fixtures/protection-cookies.mjs';

const base = process.env.ECO_COMMERCIAL_UI_ORIGIN || 'http://127.0.0.1:4396';
const output = resolve(process.env.ECO_FIXTURE_UI_OUTPUT || 'output/fixture-history-ui');
const member = {
  id: '60000000-0000-4000-8000-000000000001', email: 'fixture-trader@example.test', displayName: 'LONG TEST',
  officeId: 'HONG KONG', officeName: 'Hong Kong', isAdmin: false, isSpcTrader: false, isManager: false,
  isActive: true, activated: true, passwordChangeSuggested: false, revision: 1,
};
const supplierId = '60000000-0000-4000-8000-000000000002';
const secondSupplierId = '60000000-0000-4000-8000-000000000003';
const seller = { ...member, id: '60000000-0000-4000-8000-000000000004', displayName: 'LANA TEST', isSpcTrader: true };
const enquiryId = '60000000-0000-4000-8000-000000000005';
const bookingId = '60000000-0000-4000-8000-000000000006';
const enquiry = {
  id: enquiryId, ownerId: member.id, ownerName: member.displayName, reference: 'ECO-00000001', revision: 1, status: 'confirmed',
  vessel: 'SYNTHETIC SPLIT', imo: '', eta: '12 OCT 2026', products: [{ grade: 'VLSFO', quantityText: '200-300' }],
  port: { id: 'port-singapore', countryCode: 'SG', countryName: 'Singapore', portName: 'Singapore' },
  createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', confirmedAt: '2026-10-10T00:00:00Z', queue: null,
};
const italianTrader = { id: '60000000-0000-4000-8000-000000000007', name: 'SECOND TRADER', code: 'IT', office: 'ITALY' };
const directory = new Map([[member.id, { id: member.id, name: member.displayName, code: 'HK', office: 'HONG KONG' }],
  [seller.id, { id: seller.id, name: seller.displayName, code: 'SG', office: 'SINGAPORE' }], [italianTrader.id, italianTrader]]);
const records = Array.from({ length: 101 }, (_, index) => ({
  id: `60000001-0000-4000-8000-${String(index).padStart(12, '0')}`, date: index === 100 ? '2025-03-09' : '2026-10-10',
  supplierTraderId: index === 100 ? italianTrader.id : seller.id,
  buyerTraderId: index === 100 ? italianTrader.id : member.id,
  vessel: index === 100 ? 'SYNTHETIC OSPREY' : 'SYNTHETIC TERN', imo: index === 100 ? '9876543' : null,
  vlsfo: '160–220', cancelled: index === 100,
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
      let removedPreviewRequests = 0;
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
          assert.equal(url.searchParams.get('view'), 'register');
          const rows = booking && (!booking.deleted || actor.id === seller.id) ? [{
            id: booking.id, vessel: booking.vessel, imo: booking.imo, date: booking.date, eta: booking.eta, etaEnd: booking.etaEnd,
            buyerTraderId: member.id, supplierTraderId: seller.id, status: booking.status, deleted: booking.deleted,
            cancelled: booking.cancelled, canEdit: actor.id === seller.id, vlsfo: booking.status === 'pending'
              ? enquiry.products[0].quantityText : String(booking.lines.reduce((sum, line) => sum + line.quantity, 0)),
          }, ...records] : records;
          const visible = rows.filter(row => Boolean(row.deleted) === deleted);
          const parties = column => [...new Set(visible.map(row => row[column + 'TraderId']))].map(id => directory.get(id));
          const matches = visible.filter(row => (!year || Number(row.date.slice(0, 4)) === year) &&
            (!month || Number(row.date.slice(5, 7)) === month) && row.vessel.includes(search) &&
            ['supplier', 'buyer'].every(column => {
              const office = url.searchParams.get(column + 'Office');
              const trader = url.searchParams.get(column + 'Trader');
              const party = directory.get(row[column + 'TraderId']);
              return (!office || party.code === office) && (!trader || party.id === trader);
            }));
          return route.fulfill({ json: { items: matches.slice(page * 100, page * 100 + 100), total: matches.length,
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
                canConfirm: booking.status === 'pending' && !booking.deleted && !booking.cancelled,
                canCancel: booking.status === 'confirmed' && !booking.cancelled && !booking.deleted, canReinstate: booking.cancelled && !booking.deleted } });
            }
            removedPreviewRequests++;
            return route.fulfill({ status: 404, json: { message: 'Fixture preview is unavailable' } });
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
          } else if ('expectedRevision' in body) {
            assert.equal(actor.id, member.id);
            assert.equal(body.expectedRevision, booking.revision);
            assert.equal(booking.status, 'pending');
            assert.ok(['cancel', 'reinstate'].includes(body.action));
            assert.ok(!('reason' in body));
            booking = { ...booking, revision: booking.revision + 1, cancelled: body.action === 'cancel' };
            return route.fulfill({ json: { id: booking.id, assignment: booking } });
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
              case 'cancel':
                assert.ok(!('reason' in body));
                booking = { ...booking, cancelled: true,
                  cancellation: { at: '2026-10-10T05:00:00Z', by: seller.displayName, reason: null } };
                break;
              case 'reinstate':
                assert.ok(!('reason' in body));
                booking = { ...booking, cancelled: false, cancellation: null };
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
        if (url.pathname === '/api/enquiries/test-policy') return route.fulfill({ json: { enabled: false, generation: '' } });
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
        await expect(dialog.getByRole('status')).toHaveText('1–100 OF 101');
        await expect(grid.locator('tbody tr')).toHaveCount(100);
        assert.ok(await grid.evaluate(node => node.scrollWidth > node.clientWidth || innerWidth > 760), 'Narrow table scrolls inside its window');
        await expect(grid.getByText('LANA (SG)', { exact: true })).toHaveCount(100);
        await expect(grid.getByText('LONG (HK)', { exact: true })).toHaveCount(100);
        await expect(dialog.getByText('YEAR', { exact: true })).toHaveCount(0);
        await expect(dialog.getByText('MONTH', { exact: true })).toHaveCount(0);
        await shot('fixtures');
        for (const [column, id] of [['SUPPLIER TRADER', italianTrader.id], ['BUYER TRADER', italianTrader.id]]) {
          await grid.getByRole('button', { name: 'FILTER ' + column }).click();
          await expect(dialog.getByLabel(column + ' NAME', { exact: true }).locator('option')).toHaveCount(3);
          await expect(dialog.getByLabel(column + ' NAME', { exact: true })).not.toContainText(' / ');
          await dialog.getByLabel(column + ' OFFICE', { exact: true }).selectOption('IT');
          await dialog.getByLabel(column + ' NAME', { exact: true }).selectOption(id);
          await expect(dialog.getByRole('status')).toHaveText('1–1 OF 1');
          await dialog.getByLabel(column + ' OFFICE', { exact: true }).selectOption('');
          await dialog.getByLabel(column + ' NAME', { exact: true }).selectOption('');
          await dialog.getByRole('button', { name: 'DONE', exact: true }).click();
          await expect(dialog.getByRole('status')).toHaveText('1–100 OF 101');
        }
        await dialog.getByRole('button', { name: 'Next fixtures page' }).click();
        await expect(grid.getByText('SYNTHETIC OSPREY', { exact: true })).toBeVisible();
        await expect(grid.getByText('CANCELLED', { exact: true })).toBeVisible();
        await expect(grid.locator('s, del')).toHaveCount(0);
        await expect(dialog.getByRole('status')).toHaveText('101–101 OF 101');
        await dialog.getByRole('button', { name: 'Previous fixtures page' }).click();
        await expect(dialog.getByRole('status')).toHaveText('1–100 OF 101');
        await dialog.getByLabel('Fixture year').selectOption('2025');
        await dialog.getByLabel('Fixture month').selectOption('3');
        await dialog.getByRole('searchbox', { name: 'Search fixtures' }).fill('OSPREY');
        await expect(grid.getByText('SYNTHETIC OSPREY', { exact: true })).toBeVisible();
        await expect(grid.locator('.fixture-imo')).toHaveText('9876543');
        fail = true;
        await dialog.getByRole('button', { name: 'REFRESH', exact: true }).click();
        await expect(grid.getByRole('alert')).toContainText('FIXTURES UNAVAILABLE');
        fail = false;
        await dialog.getByRole('button', { name: 'REFRESH', exact: true }).click();
        const archived = grid.getByText('SYNTHETIC OSPREY', { exact: true });
        await archived.click();
        await expect(page.getByRole('dialog', { name: /SYNTHETIC OSPREY/ })).toHaveCount(0);
        await expect(grid.getByRole('button', { name: /SYNTHETIC OSPREY/ })).toHaveCount(0);
        await shot('fixture-history');
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
        await expect(stem.getByLabel('ETA FROM', { exact: true })).toHaveValue('2026-10-12');
        await expect(stem.getByLabel('ETA', { exact: true })).toHaveCount(0);
        await stem.getByLabel('ETA TO', { exact: true }).fill('2026-10-14');
        await shot('fixture-handoff');
        await stem.getByRole('button', { name: 'SAVE', exact: true }).click();
        await expect(enquiries).toContainText(/pending.*lana test/i);
        await enquiries.getByRole('button', { name: 'CANCEL STEM', exact: true }).click();
        const pendingCancel = page.getByRole('dialog', { name: 'CANCEL STEM', exact: true });
        await expect(pendingCancel.getByLabel('REASON')).toHaveCount(0);
        await pendingCancel.getByRole('button', { name: 'CONFIRM CANCELLATION' }).click();
        await expect(enquiries).toContainText(/cancelled.*lana test/i);
        await enquiries.getByRole('button', { name: 'REINSTATE', exact: true }).click();
        await page.getByRole('dialog', { name: 'REINSTATE', exact: true }).getByRole('button', { name: 'REINSTATE', exact: true }).click();
        await expect(enquiries).toContainText(/pending.*lana test/i);
        actor = seller;
        await page.reload();
        const ledger = await openTrading('Fixtures');
        const bookingRow = ledger.locator('tr[data-record-id="' + bookingId + '"]');
        async function openEditor() {
          const vessel = bookingRow.getByRole('button', { name: 'EDIT SYNTHETIC SPLIT', exact: true });
          if (width >= 760) await bookingRow.locator('td').first().dblclick();
          else await vessel.tap();
          const editor = page.getByRole('dialog', { name: 'EDIT FIXTURE', exact: true });
          await expect(editor.getByLabel('ETA FROM')).toBeVisible();
          return editor;
        }
        let supply = await openEditor();
        await expect(supply.getByLabel('Quantity 1')).toHaveValue('200-300');
        await expect(supply.getByLabel('ETA', { exact: true })).toHaveCount(0);
        await expect(supply.getByLabel('ETA FROM', { exact: true })).toHaveValue('2026-10-12');
        if (width >= 760) await expect(supply.getByRole('table', { name: 'SUPPLY LINES' })).toHaveCSS('border-bottom-width', '1px');
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
        await expect(bookingRow.locator('.fixture-imo')).toHaveText('9876543');
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
        await expect(supply.getByRole('button', { name: 'CONFIRM CANCELLATION' })).toBeEnabled();
        await expect(supply.getByLabel('REASON')).toHaveCount(0);
        await supply.getByRole('button', { name: 'CONFIRM CANCELLATION' }).click();
        await expect(supply).toBeHidden();
        await expect(bookingRow.locator('button .fixture-cancelled')).toHaveText('CANCELLED');
        await expect(bookingRow.locator('button .fixture-cancelled')).toHaveCSS('color', theme === 'dark' ? 'rgb(255, 180, 192)' : 'rgb(164, 47, 59)');
        await shot('cancelled-stem');

        supply = await openEditor();
        await expect(supply.getByRole('button', { name: 'REINSTATE', exact: true })).toBeVisible();
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
        supply = await openEditor();
        await supply.getByRole('button', { name: 'REINSTATE', exact: true }).click();
        await expect(supply).toBeHidden();
        await expect(bookingRow).not.toContainText('CANCELLED');
        await expect(bookingRow).toContainText('275');
        assert.equal(removedPreviewRequests, 0);
        assert.deepEqual(errors, []);
        results.push({ engine, width, theme, ok: true });
        console.log(`PASS ${engine} ${width} ${theme}: sign-in, fixture grid, filters, direct editing, buyer handoff, cancellation, reinstatement and restoration`);
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
