import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const BASE = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4175';
const OUT = new URL('../artifacts/fixture-suppliers/', import.meta.url);
const GRADES = ['HSFO', 'VLSFO', 'LSMGO'];
const SUPPLIERS = {
  meridian: 'MERIDIAN BUNKER SUPPLY · DEMO',
  harbourline: 'HARBOURLINE MARINE FUELS · DEMO',
  pacific: 'PACIFIC CURRENT ENERGY · DEMO',
  tidal: 'TIDAL POINT BUNKERS · DEMO',
};
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const results = [];
const FILTER = process.env.ECO_TEST_FILTER ? new RegExp(process.env.ECO_TEST_FILTER) : null;
const state = page => page.evaluate(() => JSON.parse(localStorage.getItem('ecosystem.demo.v1')));
const dialog = (page, name) => page.getByRole('dialog', { name, exact: true });
const supplierInput = (stem, grade) => stem.getByRole('combobox', { name: `${grade} supplier`, exact: true });
async function open(page, group, name) {
  const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
  const button = nav.getByRole('button', { name: group, exact: true });
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
  await nav.getByRole('button', { name, exact: true }).click();
  await expect(dialog(page, name)).toBeVisible();
  return dialog(page, name);
}
async function close(page) { await page.getByRole('button', { name: 'Close workspace', exact: true }).click(); }
async function confirm(page, vessel) {
  const center = await open(page, 'Trading', 'Enquiries');
  await center.getByRole('button', { name: 'New enquiry', exact: true }).click();
  await center.getByLabel('Raw enquiry', { exact: true }).fill(`Buyer: Meridian Shipping Pte Ltd\nVessel: ${vessel}\nIMO: 9876543\nPort: Singapore\nETA: 2-4 October\nHSFO: 350-400 MT\nVLSFO: 500-600 MT\nLSMGO: 60 MT`);
  await expect(center.getByLabel('Vessel', { exact: true })).toHaveValue(vessel);
  await center.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect.poll(async () => (await state(page)).enquiries.find(e => e.vessel === vessel)?.status).toBe('sent');
  const enquiry = (await state(page)).enquiries.find(e => e.vessel === vessel);
  await center.locator(`[data-enquiry-id="${enquiry.id}"]`).getByRole('button', { name: /^stem$/i }).click();
  const stem = dialog(page, 'STEM');
  await expect(stem).toBeVisible();
  return { center, enquiry, stem };
}
async function choose(stem, grade, key) {
  await supplierInput(stem, grade).click();
  await stem.getByRole('option', { name: SUPPLIERS[key], exact: true }).click();
  await expect(supplierInput(stem, grade)).toHaveValue(SUPPLIERS[key]);
}
async function prices(stem) {
  for (const [grade, price] of [['HSFO', '421'], ['VLSFO', '552'], ['LSMGO', '703']])
    await stem.getByLabel(`${grade} buy price (USD / MT)`, { exact: true }).fill(price);
}
async function checks(stem) {
  await stem.getByRole('checkbox', { name: 'Compliance', exact: true }).check();
  await stem.getByRole('checkbox', { name: 'Credit', exact: true }).check();
}
async function noOverflow(page, container) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal page overflow');
  const box = await container.boundingBox();
  assert.ok(box && box.x >= -1 && box.x + box.width <= page.viewportSize().width + 1, 'Dialog fits viewport');
}
async function scenario(name, run, { width = 1440, height = 1000, theme = 'light' } = {}) {
  if (FILTER && !FILTER.test(name)) return;
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', isMobile: width < 1000, hasTouch: width < 1000 });
  await context.addInitScript(mode => localStorage.setItem('ecosystem.theme.v1', mode), theme);
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) writes.push(request.url()); });
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('button', { name: 'ENTER ECOSYSTEM', exact: true })).toBeVisible();
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    await page.getByLabel('Demo profile', { exact: true }).selectOption('otto');
    await page.getByRole('button', { name: 'ENTER ECOSYSTEM', exact: true }).click();
    await run(page);
    assert.deepEqual(errors, [], 'No uncaught browser errors');
    assert.deepEqual(writes, [], 'Demo test does not write remotely');
    results.push({ name, passed: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, passed: false, error: error.stack });
    console.error(`FAIL ${name}: ${error.message}`);
    await page.screenshot({ path: new URL(`failure-${results.length}.png`, OUT).pathname, fullPage: true }).catch(() => {});
  } finally { await context.close(); }
}

try {
  await scenario('First supplier defaults and re-defaults untouched grades; explicit overrides are preserved', async page => {
    const { stem } = await confirm(page, 'SUPPLIER DEFAULTS');
    await expect(stem.getByRole('combobox')).toHaveCount(3);
    await choose(stem, 'HSFO', 'meridian');
    for (const grade of GRADES) await expect(supplierInput(stem, grade)).toHaveValue(SUPPLIERS.meridian);
    await choose(stem, 'HSFO', 'harbourline');
    for (const grade of GRADES) await expect(supplierInput(stem, grade)).toHaveValue(SUPPLIERS.harbourline);
    // Choosing the same currently defaulted supplier is still an explicit decision.
    await choose(stem, 'VLSFO', 'harbourline');
    await choose(stem, 'HSFO', 'pacific');
    await expect(supplierInput(stem, 'HSFO')).toHaveValue(SUPPLIERS.pacific);
    await expect(supplierInput(stem, 'VLSFO')).toHaveValue(SUPPLIERS.harbourline);
    await expect(supplierInput(stem, 'LSMGO')).toHaveValue(SUPPLIERS.pacific);
    await choose(stem, 'LSMGO', 'tidal');
    await choose(stem, 'HSFO', 'meridian');
    await expect(supplierInput(stem, 'VLSFO')).toHaveValue(SUPPLIERS.harbourline);
    await expect(supplierInput(stem, 'LSMGO')).toHaveValue(SUPPLIERS.tidal);
    await prices(stem); await checks(stem);
    await expect(stem.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    await choose(stem, 'VLSFO', 'pacific');
    for (const label of ['Compliance', 'Credit']) await expect(stem.getByRole('checkbox', { name: label, exact: true })).not.toBeChecked();
    await stem.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal((await state(page)).outcomes.some(o => o.vessel === 'SUPPLIER DEFAULTS'), false);
  });

  await scenario('Secondary selection before first is kept; invalid typed supplier blocks save', async page => {
    const { stem } = await confirm(page, 'SUPPLIER VALIDATION');
    await choose(stem, 'LSMGO', 'pacific');
    await choose(stem, 'HSFO', 'meridian');
    await expect(supplierInput(stem, 'VLSFO')).toHaveValue(SUPPLIERS.meridian);
    await expect(supplierInput(stem, 'LSMGO')).toHaveValue(SUPPLIERS.pacific);
    await prices(stem); await checks(stem);
    await supplierInput(stem, 'VLSFO').fill('NOT A REAL SUPPLIER');
    await stem.getByLabel('Private note', { exact: true }).click();
    await checks(stem);
    await expect(stem.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await choose(stem, 'HSFO', 'harbourline');
    await expect(supplierInput(stem, 'VLSFO')).toHaveValue('NOT A REAL SUPPLIER');
    await expect(supplierInput(stem, 'LSMGO')).toHaveValue(SUPPLIERS.pacific);
    await choose(stem, 'VLSFO', 'tidal'); await checks(stem);
    await expect(stem.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  });

  for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [390, 'light'], [850, 'dark']]) {
    await scenario(`Three suppliers persist and display correctly at ${width}px ${theme}`, async page => {
      const vessel = `MIXED SUPPLIERS ${width} ${theme.toUpperCase()}`;
      const before = await state(page);
      const { stem, enquiry } = await confirm(page, vessel);
      await choose(stem, 'HSFO', 'meridian');
      await choose(stem, 'VLSFO', 'harbourline');
      await choose(stem, 'LSMGO', 'pacific');
      await prices(stem);
      await stem.getByLabel('Private note', { exact: true }).fill('OWNER PRIVATE SUPPLIER NOTE');
      await checks(stem);
      await noOverflow(page, stem);
      await page.screenshot({ path: new URL(`stem-${width}-${theme}.png`, OUT).pathname });
      await stem.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(stem).not.toBeVisible();
      const saved = await state(page);
      const outcome = saved.outcomes.find(o => o.enquiryId === enquiry.id);
      assert.equal(saved.outcomes.length, before.outcomes.length + 1, 'Three grades remain one fixture');
      assert.deepEqual(outcome.stemProducts.map(p => [p.grade, p.supplierId, p.buyPrice]), [
        ['HSFO', 'supplier-meridian', 421], ['VLSFO', 'supplier-harbourline', 552], ['LSMGO', 'supplier-pacific', 703],
      ]);
      assert.ok(!outcome.supplierId && !outcome.supplierName, 'Mixed fixture has no misleading shared supplier');
      await close(page); await page.reload({ waitUntil: 'domcontentloaded' });
      const fixtures = await open(page, 'Trading', 'Fixtures');
      const sheet = fixtures.getByRole('region', { name: 'Fixtures', exact: true });
      const search = fixtures.getByRole('textbox', { name: 'Search records', exact: true });
      await search.fill(vessel);
      await expect(sheet.getByRole('status')).toHaveText('1–1 of 1');
      const rows = fixtures.locator(`tbody[data-record-id="${outcome.id}"] tr`);
      await expect(rows).toHaveCount(3);
      for (const [i, grade, supplier, price] of [[0, 'HSFO', 'meridian', '$421'], [1, 'VLSFO', 'harbourline', '$552'], [2, 'LSMGO', 'pacific', '$703']]) {
        await expect(rows.nth(i)).toContainText(grade);
        await expect(rows.nth(i)).toContainText(new RegExp(SUPPLIERS[supplier].replace(' · DEMO', ''), 'i'));
        await expect(rows.nth(i)).toContainText(price);
      }
      await expect(rows.locator('button').filter({ hasText: vessel })).toHaveCount(1);
      await expect(rows.getByRole('button', { name: 'Actual volume', exact: true })).toHaveCount(1);
      await expect(rows.locator('.record-sheet__vessel')).toHaveAttribute('rowspan', '3');
      await noOverflow(page, fixtures);
      await page.screenshot({ path: new URL(`fixtures-${width}-${theme}.png`, OUT).pathname });
      await fixtures.getByRole('region', { name: 'Record table', exact: true }).evaluate(el => { el.scrollLeft = el.scrollWidth; });
      await page.screenshot({ path: new URL(`fixtures-suppliers-${width}-${theme}.png`, OUT).pathname });
      await search.fill(`${vessel} Pacific`);
      await expect(sheet.getByRole('status')).toHaveText('1–1 of 1');
      await expect(rows).toHaveCount(3);
      const downloading = page.waitForEvent('download');
      await fixtures.getByRole('button', { name: 'Export page', exact: true }).click();
      const downloaded = await downloading;
      const csvPath = new URL(`fixtures-${width}-${theme}.csv`, OUT).pathname;
      await downloaded.saveAs(csvPath);
      const csv = await readFile(csvPath, 'utf8');
      const csvRows = csv.trim().split('\r\n');
      assert.equal(csvRows.length, 4, 'One export line per grade');
      for (const [i, grade, supplier, price] of [[1, 'HSFO', 'Meridian Bunker Supply', '421'], [2, 'VLSFO', 'Harbourline Marine Fuels', '552'], [3, 'LSMGO', 'Pacific Current Energy', '703']]) {
        assert.ok(csvRows[i].includes(`"${grade}"`) && csvRows[i].includes(supplier) && csvRows[i].includes(`"${price}"`), 'CSV grade/supplier/buy price pairing');
      }
      assert.ok(!csv.includes('OWNER PRIVATE SUPPLIER NOTE'));
      await fixtures.getByRole('button', { name: vessel, exact: true }).click();
      const detail = dialog(page, vessel);
      const detailRows = detail.locator('.stem-record tbody tr');
      await expect(detailRows).toHaveCount(3);
      await expect(detailRows.nth(1)).toContainText(/HARBOURLINE MARINE FUELS/i);
      await expect(detailRows.nth(1)).toContainText('$552');
      await detail.getByRole('button', { name: 'Close dialog', exact: true }).click();
      await close(page);
      const directory = await open(page, 'Ports & Suppliers', 'Countries & Ports');
      await directory.getByLabel('Country or port', { exact: true }).fill('Singapore');
      await directory.getByRole('button', { name: 'Singapore', exact: true }).click();
      const sectionSelect = directory.getByRole('combobox', { name: 'Information section', exact: true });
      if (await sectionSelect.isVisible()) await sectionSelect.selectOption('$prices');
      else await directory.getByRole('button', { name: 'Buy prices', exact: true }).click();
      const buyPrices = directory.getByRole('region', { name: 'Buy prices', exact: true });
      await buyPrices.getByPlaceholder('Search buy prices', { exact: true }).fill(vessel);
      await expect(buyPrices.locator('tbody tr')).toHaveCount(3);
      await expect(buyPrices.locator('tbody tr').filter({ hasText: 'VLSFO' })).toContainText(SUPPLIERS.harbourline);
      await expect(buyPrices.locator('tbody tr').filter({ hasText: 'VLSFO' })).toContainText('$552');
      // Buy-price search is a single substring search; use supplier alone to verify exact per-grade filtering.
      await buyPrices.getByPlaceholder('Search buy prices', { exact: true }).fill('Pacific Current');
      await expect(buyPrices.locator('tbody tr').filter({ hasText: vessel })).toHaveCount(1);
      await expect(buyPrices.locator('tbody tr').filter({ hasText: vessel })).toContainText('LSMGO');
    }, { width, height: 1000, theme });
  }

  await scenario('Legacy supplier fallback and bounded fixture pagination keep grade groups intact', async page => {
    await page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem('ecosystem.demo.v1'));
      const base = saved.outcomes.find(o => o.kind === 'fixture');
      saved.outcomes = Array.from({ length: 57 }, (_, i) => ({
        ...base, id: `legacy-supplier-${i}`, vessel: `LEGACY SUPPLIER ${String(i).padStart(3, '0')}`,
        owner: 'otto', bookedAt: new Date().toISOString(), supplierId: 'supplier-meridian', supplierName: 'Meridian Bunker Supply · Demo',
        commercialStatus: 'pending', stemProducts: [{ grade: 'HSFO', quantityText: '350–400', buyPrice: 421 }, { grade: 'VLSFO', quantityText: '500', buyPrice: 552 }],
      }));
      localStorage.setItem('ecosystem.demo.v1', JSON.stringify(saved));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    const fixtures = await open(page, 'Trading', 'Fixtures');
    const sheet = fixtures.getByRole('region', { name: 'Fixtures', exact: true });
    await expect(sheet.getByRole('status')).toHaveText('1–50 of 57');
    await expect(sheet.locator('tbody tr')).toHaveCount(100);
    const groupSizes = await sheet.locator('tbody[data-record-id]').evaluateAll(groups => groups.map(group => group.querySelectorAll('tr').length));
    assert.ok(groupSizes.length === 50 && groupSizes.every(size => size === 2));
    await sheet.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(sheet.getByRole('status')).toHaveText('51–57 of 57');
    await expect(sheet.locator('tbody tr')).toHaveCount(14);
    await fixtures.getByRole('textbox', { name: 'Search records', exact: true }).fill('LEGACY SUPPLIER 000');
    await expect(sheet.getByRole('status')).toHaveText('1–1 of 1');
    await expect(sheet.locator('tbody tr')).toHaveCount(2);
    for (const row of await sheet.locator('tbody tr').all()) await expect(row).toContainText(/Meridian Bunker Supply/i);
  });
} finally {
  await browser.close();
  await writeFile(new URL(FILTER ? `results-${process.env.ECO_TEST_FILTER.replace(/[^a-z0-9_-]/gi, '_')}.json` : 'results.json', OUT), JSON.stringify({ results }, null, 2));
}
if (results.some(result => !result.passed)) process.exitCode = 1;
