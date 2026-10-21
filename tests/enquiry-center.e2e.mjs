import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

// Isolated headless contexts only: no personal Chrome and no external message transport.
const BASE = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4173';
const FILTER = process.env.ECO_TEST_FILTER;
const OUTPUT = new URL('../artifacts/', import.meta.url);
await mkdir(OUTPUT, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const results = [], browserErrors = [], layoutChecks = [];
const normal = 'Buyer: Harborlight Maritime SA\nVessel: PACIFIC HORIZON\nIMO: 9319466\nPort: Singapore\nETA: 15-17 October\nVLSFO: 450 MT';
const multiple = normal.replace('PACIFIC HORIZON', 'OCEAN RANGES').replace('VLSFO: 450 MT', 'HSFO: 150-200 MT\nVLSFO: 450-500 MT\nLSMGO: 30 MT');
const state = page => page.evaluate(() => JSON.parse(localStorage.getItem('ecosystem.demo.v1')));
const inboxState = page => page.evaluate(() => JSON.parse(localStorage.getItem('ecosystem.inbox.v2')).items);
const center = page => page.getByRole('dialog', { name: 'Enquiries', exact: true });
const navigation = page => page.getByRole('navigation', { name: 'Workspace navigation' });
const confirmButton = dialog => dialog.getByRole('button', { name: 'Confirm', exact: true });
const rowFor = (dialog, id) => dialog.locator(`[data-enquiry-id="${id}"]`);
async function login(page, actor = 'otto') {
  await page.getByLabel('Demo profile', { exact: true }).selectOption(actor);
  await page.getByRole('button', { name: 'ENTER ECOSYSTEM', exact: true }).click();
  await expect(navigation(page)).toBeVisible();
}
async function openCenter(page) {
  const original = page.url();
  const trading = navigation(page).getByRole('button', { name: 'Trading', exact: true });
  if (await trading.getAttribute('aria-expanded') !== 'true') await trading.click();
  await navigation(page).getByRole('button', { name: 'Enquiries', exact: true }).click();
  await expect(center(page)).toBeVisible();
  assert.equal(page.url(), original);
  return center(page);
}
async function paste(dialog, raw = normal, vessel = 'PACIFIC HORIZON') {
  await dialog.getByLabel('Raw enquiry', { exact: true }).fill(raw);
  await expect(dialog.getByLabel('Vessel', { exact: true })).toHaveValue(vessel);
}
async function choose(dialog, name, query, option) {
  await dialog.getByRole('combobox', { name, exact: true }).fill(query);
  await dialog.getByRole('option', { name: option, exact: true }).click();
}
async function confirm(page, dialog, vessel = 'PACIFIC HORIZON') {
  await expect(confirmButton(dialog)).toBeEnabled();
  await confirmButton(dialog).click();
  await expect.poll(async () => (await state(page)).enquiries.find(item => item.vessel === vessel)?.status).toBe('sent');
  return (await state(page)).enquiries.find(item => item.vessel === vessel);
}
async function receive(page, channel = 'WhatsApp') {
  const before = await inboxState(page);
  const bell = page.getByRole('button', { name: 'Notifications', exact: true });
  if (await bell.getAttribute('aria-expanded') !== 'true') await bell.click();
  await page.getByRole('region', { name: 'Enquiries', exact: true }).getByRole('button', { name: `${channel} (demo)`, exact: true }).click();
  await expect.poll(async () => (await inboxState(page)).length).toBe(before.length + 1);
  const item = (await inboxState(page)).find(item => !before.some(previous => previous.id === item.id));
  await bell.click();
  return item;
}
async function reviewStem(modal) {
  await modal.getByRole('checkbox', { name: /^Compliance(?: checked)?$/ }).check();
  await modal.getByRole('checkbox', { name: /^Credit(?: checked)?$/ }).check();
}
async function scenario(name, callback, options = {}) {
  if (FILTER && !name.toLowerCase().includes(FILTER.toLowerCase())) return;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', locale: 'en-GB', ...options });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) writes.push({ method: request.method(), url: request.url() }); });
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('button', { name: 'ENTER ECOSYSTEM', exact: true })).toBeVisible();
    await callback(page, context);
    assert.deepEqual(writes, [], 'The demo must not write to external services');
    results.push({ name, status: 'passed' });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, status: 'failed', error: error.stack });
    console.log(`FAIL ${name}: ${error.message}`);
    await page.screenshot({ path: new URL(`center-failure-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`, OUTPUT).pathname, animations: 'disabled' }).catch(() => {});
  } finally {
    browserErrors.push(...errors.map(error => ({ scenario: name, error })));
    await context.close();
  }
}

await scenario('Clean center starts empty and Confirm stores a reviewed enquiry without editor checkboxes', async page => {
  await login(page);
  const before = await state(page);
  assert.equal(before.enquiries.filter(item => ['draft', 'sent', 'postponed'].includes(item.status)).length, 0);
  assert.equal((await inboxState(page)).length, 0);
  const dialog = await openCenter(page);
  await expect(dialog.locator('.center-incoming-row')).toHaveCount(0);
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await expect(confirmButton(dialog)).toBeDisabled();
  await expect(dialog.getByRole('button', { name: /^(Send|Reset format|Save)$/ })).toHaveCount(0);
  await paste(dialog, `${normal}\nPrice: USD 987.65\nMargin: USD 23.45`);
  await expect(dialog.getByRole('combobox', { name: 'Buyer', exact: true })).toHaveValue('HARBORLIGHT MARITIME SA');
  await expect(dialog.getByRole('combobox', { name: 'Port', exact: true })).toHaveValue('Singapore');
  const output = await dialog.getByLabel('Standard format', { exact: true }).inputValue();
  assert.match(output, /PACIFIC HORIZON/);
  assert.doesNotMatch(output, /Buyer|Harborlight|price|margin|987\.65|23\.45/i);
  const temporary = dialog.locator('[data-draft-id]').filter({ hasText: 'PACIFIC HORIZON' });
  await expect(temporary).toContainText('New enquiry');
  const saved = await confirm(page, dialog);
  assert.equal(saved.price, 0);
  assert.equal(saved.margin, 0);
  await expect(rowFor(dialog, saved.id)).not.toContainText('Confirmed');
  await expect(dialog.getByRole('separator', { name: 'Incoming and confirmed enquiries', exact: true })).toBeVisible();
  await expect(dialog.locator('.center-queue-confirmed').locator(`[data-enquiry-id="${saved.id}"]`)).toBeVisible();
  await expect(rowFor(dialog, saved.id)).not.toContainText('New enquiry');
  assert.deepEqual((await state(page)).outcomes, before.outcomes);
  await page.screenshot({ path: new URL('center-desktop.png', OUTPUT).pathname, animations: 'disabled' });
});

await scenario('Right credit indicator is compact and Clear is inside a taller parser', async page => {
  await login(page);
  const dialog = await openCenter(page);
  await paste(dialog);
  const indicator = dialog.getByRole('region', { name: 'Client credit', exact: true });
  await expect(indicator).toContainText('HARBORLIGHT MARITIME SA');
  await expect(indicator).toContainText('$1,200,000');
  await expect(indicator).toContainText('$885,000');
  await expect(indicator).not.toContainText(/Used|Approved/);
  const parser = await dialog.getByLabel('Raw enquiry', { exact: true }).boundingBox();
  const credit = await indicator.boundingBox();
  const standard = await dialog.getByLabel('Standard format', { exact: true }).boundingBox();
  const clear = await dialog.getByRole('button', { name: 'Clear parser', exact: true }).boundingBox();
  assert.ok(credit.x > parser.x + parser.width, 'Credit and incoming belong to the right sidebar');
  assert.ok(parser.height >= 300, `Parser too short: ${parser.height}`);
  assert.ok(standard.height >= 65 && standard.height <= 105, `Expected three-line standard field, got ${standard.height}`);
  assert.ok(clear.x >= parser.x && clear.x + clear.width <= parser.x + parser.width + 1 && clear.y >= parser.y && clear.y + clear.height <= parser.y + parser.height + 1);
  await dialog.getByRole('button', { name: 'Clear parser', exact: true }).click();
  await expect(dialog.getByLabel('Raw enquiry', { exact: true })).toHaveValue('');
  await expect(dialog.getByLabel('Vessel', { exact: true })).toHaveValue('');
  await expect(dialog.getByLabel('Standard format', { exact: true })).toHaveValue('');
  await expect(confirmButton(dialog)).toBeDisabled();
});

await scenario('Buyer and Port search require selecting a matching entity and support keyboard selection', async page => {
  await login(page);
  const dialog = await openCenter(page);
  await paste(dialog);
  const buyer = dialog.getByRole('combobox', { name: 'Buyer', exact: true });
  await buyer.fill('zz-no-matching-buyer');
  await expect(dialog.getByRole('listbox', { name: 'Buyer options', exact: true })).toContainText('No matches');
  await expect(confirmButton(dialog)).toBeDisabled();
  await buyer.fill('Pacific Orbit');
  await expect(dialog.getByRole('option')).toHaveCount(1);
  await buyer.press('ArrowDown');
  await buyer.press('Enter');
  await expect(buyer).toHaveValue('PACIFIC ORBIT LINES KK');
  await choose(dialog, 'Port', 'NLRTM', 'Rotterdam');
  await expect(dialog.getByRole('combobox', { name: 'Port', exact: true })).toHaveValue('Rotterdam');
  await expect(dialog.getByLabel('Standard format', { exact: true })).toHaveValue(/ROTTERDAM/i);
  const saved = await confirm(page, dialog);
  assert.equal(saved.buyerId, 'company-pacific-orbit');
  assert.equal(saved.portId, 'port-rotterdam');
});

await scenario('Unknown buyer and unsupported units remain blocked until explicitly corrected', async page => {
  await login(page);
  const dialog = await openCenter(page);
  await paste(dialog, normal.replace('Harborlight Maritime SA', 'UNLISTED DEMO BUYER').replace('450 MT', '500 CBM'));
  await expect(dialog.getByLabel(/^VLSFO/)).toHaveValue('');
  await expect(confirmButton(dialog)).toBeDisabled();
  await choose(dialog, 'Buyer', 'Harborlight', 'HARBORLIGHT MARITIME SA');
  await dialog.getByLabel(/^VLSFO/).fill('450');
  await expect(confirmButton(dialog)).toBeEnabled();
});

await scenario('Manual draft corrections persist across incoming selection and new blank drafts', async page => {
  await login(page);
  const incoming = await receive(page, 'Email');
  const dialog = await openCenter(page);
  await paste(dialog);
  await dialog.getByLabel('Vessel', { exact: true }).fill('MANUALLY CONFIRMED DRAFT');
  await dialog.getByLabel(/^VLSFO/).fill('475');
  await dialog.getByRole('button', { name: 'BIMCO', exact: true }).click();
  const local = dialog.locator('[data-draft-id]').filter({ hasText: 'MANUALLY CONFIRMED DRAFT' });
  await expect(local).toContainText('New enquiry');
  await dialog.locator(`[data-incoming-id="${incoming.id}"]`).getByRole('button').click();
  await expect(dialog.getByLabel('Vessel', { exact: true })).toHaveValue('PACIFIC LANTERN');
  await local.getByRole('button').click();
  await expect(dialog.getByLabel('Vessel', { exact: true })).toHaveValue('MANUALLY CONFIRMED DRAFT');
  await expect(dialog.getByLabel(/^VLSFO/)).toHaveValue('475');
  await expect(dialog.getByRole('button', { name: 'BIMCO', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('button', { name: 'New enquiry', exact: true }).click();
  await expect(dialog.getByLabel('Raw enquiry', { exact: true })).toHaveValue('');
  await local.getByRole('button').click();
  await expect(dialog.getByLabel('Vessel', { exact: true })).toHaveValue('MANUALLY CONFIRMED DRAFT');
});

await scenario('Standard-format mismatch blocks Confirm and AI FIX restores a truthful local preview', async page => {
  await login(page);
  const dialog = await openCenter(page);
  await paste(dialog);
  const output = dialog.getByLabel('Standard format', { exact: true });
  const original = await output.inputValue();
  await output.fill(original.replace('450', '1000'));
  await expect(confirmButton(dialog)).toBeDisabled();
  await expect(dialog).toContainText('Standard format differs from the details.');
  await expect(dialog.getByRole('button', { name: 'Reset format', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'AI FIX', exact: true }).click();
  await expect(output).toHaveValue(original);
  await expect(confirmButton(dialog)).toBeEnabled();
  await expect(page.locator('.toast[role="status"]')).toContainText('AI is not connected');
});

await scenario('STEM preserves ranges and requires supplier buy prices and both checks without invented totals', async page => {
  await login(page);
  const before = await state(page);
  const dialog = await openCenter(page);
  await paste(dialog, multiple, 'OCEAN RANGES');
  for (const term of ['COQ REQUIRED', '30D QUALITY TIME BAR', 'BIMCO']) await dialog.getByRole('button', { name: term, exact: true }).click();
  const saved = await confirm(page, dialog, 'OCEAN RANGES');
  await rowFor(dialog, saved.id).getByRole('button', { name: /^stem$/i }).click();
  const fixture = page.getByRole('dialog', { name: 'STEM', exact: true });
  const book = fixture.getByRole('button', { name: 'Save', exact: true });
  await expect(fixture.getByLabel('HSFO quantity (MT)', { exact: true })).toHaveValue(/150[–-]200/);
  await expect(fixture.getByLabel('VLSFO quantity (MT)', { exact: true })).toHaveValue(/450[–-]500/);
  await expect(book).toBeDisabled();
  await choose(fixture, 'HSFO supplier', 'Meridian', 'MERIDIAN BUNKER SUPPLY · DEMO');
  const products = [{ grade: 'HSFO', quantityText: '150–200', buyPrice: 500 }, { grade: 'VLSFO', quantityText: '450–500', buyPrice: 620 }, { grade: 'LSMGO', quantityText: '30', buyPrice: 800 }];
  for (const product of products) {
    await expect(fixture.getByLabel(`${product.grade} buy price (USD / MT)`, { exact: true })).toHaveValue('');
    await fixture.getByLabel(`${product.grade} buy price (USD / MT)`, { exact: true }).fill(String(product.buyPrice));
  }
  await expect(fixture.getByLabel(/sale price|margin/i)).toHaveCount(0);
  await expect(book).toBeDisabled();
  await fixture.getByRole('checkbox', { name: /^Compliance(?: checked)?$/ }).check();
  await expect(book).toBeDisabled();
  await fixture.getByRole('checkbox', { name: /^Credit(?: checked)?$/ }).check();
  await expect(book).toBeEnabled();
  await fixture.getByLabel('HSFO quantity (MT)', { exact: true }).fill('150-210');
  await expect(fixture.getByRole('checkbox', { name: 'Compliance', exact: true })).not.toBeChecked();
  await expect(fixture.getByRole('checkbox', { name: 'Credit', exact: true })).not.toBeChecked();
  products[0].quantityText = '150–210';
  await reviewStem(fixture);
  await book.click();
  await expect(fixture).not.toBeVisible();
  const after = await state(page);
  const outcome = after.outcomes.find(item => item.enquiryId === saved.id);
  assert.deepEqual(outcome.stemProducts, products.map(product => ({ ...product, supplierId: 'supplier-meridian', supplierName: 'Meridian Bunker Supply · Demo' })));
  assert.equal(outcome.commercialStatus, 'pending');
  assert.equal(outcome.supplierId, 'supplier-meridian');
  assert.equal(outcome.quantity, 0);
  assert.equal(outcome.margin, 0);
  assert.deepEqual(after.companies, before.companies);
  assert.deepEqual(after.drops, before.drops);
  assert.equal(outcome.complianceChecked, true);
  assert.equal(outcome.creditChecked, true);
  assert.equal(outcome.checkedBy, 'otto');
  assert.ok(Number.isFinite(Date.parse(outcome.checkedAt)));
});

await scenario('Lost requires a reason but no STEM checks and changes no financial exposure', async page => {
  await login(page);
  const before = await state(page);
  const dialog = await openCenter(page);
  await paste(dialog);
  const saved = await confirm(page, dialog);
  await rowFor(dialog, saved.id).getByRole('button', { name: /^lost$/i }).click();
  const loss = page.getByRole('dialog', { name: 'LOST', exact: true });
  await expect(loss.getByRole('checkbox')).toHaveCount(0);
  await loss.getByRole('combobox', { name: 'Reason', exact: true }).selectOption({ label: 'SUPPLIER LATE RESPONSE' });
  await loss.getByLabel('Group note', { exact: true }).fill('The vessel changed its port call; confirm the revised window earlier next time.');
  await loss.getByRole('button', { name: 'Save', exact: true }).click();
  const after = await state(page);
  assert.equal(after.outcomes.find(item => item.enquiryId === saved.id).kind, 'lost');
  assert.deepEqual(after.companies, before.companies);
  assert.deepEqual(after.drops, before.drops);
  assert.deepEqual(after.outcomes.filter(item => item.kind === 'fixture'), before.outcomes.filter(item => item.kind === 'fixture'));
});

await scenario('Confirm Amend and Cancel retain identity and do not invent outcomes', async page => {
  await login(page);
  const before = await state(page);
  const dialog = await openCenter(page);
  await paste(dialog);
  const saved = await confirm(page, dialog);
  await rowFor(dialog, saved.id).getByRole('button', { name: /^amend$/i }).click();
  await expect(rowFor(dialog, saved.id)).not.toContainText('New enquiry');
  await expect(dialog.locator('.center-queue-new').locator(`[data-enquiry-id="${saved.id}"]`)).toBeVisible();
  await dialog.getByLabel(/^VLSFO/).fill('475');
  await confirm(page, dialog);
  let current = (await state(page)).enquiries.find(item => item.id === saved.id);
  assert.equal(current.amendments.length, 1);
  assert.equal(current.amendments[0].before.products[0].quantityText, '450');
  assert.equal(current.products[0].quantityText, '475');
  await expect(rowFor(dialog, saved.id).getByRole('button', { name: /^postpone$/i })).toHaveCount(0);
  await rowFor(dialog, saved.id).getByRole('button', { name: /^cancel$/i }).click();
  current = (await state(page)).enquiries.find(item => item.id === saved.id);
  assert.equal(current.status, 'cancelled');
  assert.deepEqual((await state(page)).outcomes, before.outcomes);
  await expect(rowFor(dialog, saved.id)).toHaveCount(0);
});

await scenario('Fresh arrivals persist after cleanup and notification dismissal preserves the incoming record', async page => {
  await login(page);
  const whatsapp = await receive(page, 'WhatsApp');
  const email = await receive(page, 'Email');
  await page.reload({ waitUntil: 'domcontentloaded' });
  assert.equal((await inboxState(page)).length, 2);
  assert.ok((await inboxState(page)).some(item => item.id === whatsapp.id));
  const bell = page.getByRole('button', { name: 'Notifications', exact: true });
  await bell.click();
  const menu = page.getByRole('region', { name: 'Enquiries', exact: true });
  await menu.getByRole('button', { name: 'Clear notification for MERIDIAN DAWN', exact: true }).click();
  await expect(menu.locator('.inbox-item')).toHaveCount(1);
  await menu.getByRole('button', { name: 'Clear all', exact: true }).click();
  await bell.click();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('complementary', { name: 'New enquiry', exact: true })).toHaveCount(0);
  const dialog = await openCenter(page);
  await expect(dialog.locator(`[data-incoming-id="${whatsapp.id}"]`)).toContainText('New enquiry');
  await expect(dialog.locator(`[data-incoming-id="${email.id}"]`)).toContainText('New enquiry');
  await dialog.locator(`[data-incoming-id="${email.id}"]`).getByRole('button').click();
  await expect(dialog.getByLabel('Vessel', { exact: true })).toHaveValue('PACIFIC LANTERN');
  const saved = await confirm(page, dialog, 'PACIFIC LANTERN');
  await expect(rowFor(dialog, saved.id)).not.toContainText('New enquiry');
  await expect(dialog.locator(`[data-incoming-id="${email.id}"]`)).toHaveCount(0);
  assert.equal((await inboxState(page)).find(item => item.id === email.id).enquiryId, saved.id);
  await page.reload({ waitUntil: 'domcontentloaded' });
  assert.equal((await inboxState(page)).length, 2);
  assert.equal((await state(page)).enquiries.find(item => item.id === saved.id).status, 'sent');
});

await scenario('Compact win and loss history remains below standard format after cleanup', async page => {
  await login(page);
  const dialog = await openCenter(page);
  await paste(dialog, normal.replace('9319466', '9876543'));
  const history = dialog.getByRole('region', { name: 'Win and loss record', exact: true });
  await expect(history).toContainText('1 Win');
  await expect(history).toContainText('1 Lost');
  await expect(history).not.toContainText(/IMO|9876543/);
  const format = await dialog.getByLabel('Standard format', { exact: true }).boundingBox();
  const bounds = await history.boundingBox();
  assert.ok(bounds.y >= format.y + format.height);
  assert.ok(Math.abs(bounds.x - format.x) < 3);
  await history.locator('summary').first().click();
  await expect(history).toContainText(/competing quote|Price/);
});

await scenario('Parser Report persists its original input and corrected output for management review', async page => {
  await login(page);
  const dialog = await openCenter(page);
  await paste(dialog);
  const before = await state(page);
  await dialog.getByRole('button', { name: 'Report', exact: true }).click();
  await expect(page.locator('.toast[role="status"]')).toContainText('Report saved locally for management review.');
  const after = await state(page);
  const report = after.contributions.find(item => !before.contributions.some(previous => previous.id === item.id));
  assert.equal(report.targetType, 'feedback');
  assert.equal(report.targetId, 'ecosystem');
  assert.equal(report.title, 'Parser report: PACIFIC HORIZON');
  assert.equal(report.status, 'pending');
  assert.match(report.body, /Raw enquiry:/);
  assert.match(report.body, /Standard format:/);
  assert.deepEqual(after.drops, before.drops);
});

await scenario('Raw RMK and viscosity survive parse Confirm and reload', async page => {
  await login(page);
  const dialog = await openCenter(page);
  const raw = normal.replace('PACIFIC HORIZON', 'QUALIFIER VOYAGER').replace('VLSFO: 450 MT', 'RMK380: 1000 MT\nVLSFO: 450 MT 80 cSt MIN');
  await paste(dialog, raw, 'QUALIFIER VOYAGER');
  await expect(dialog.getByRole('button', { name: 'RMK', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByRole('button', { name: '80cst min', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const saved = await confirm(page, dialog, 'QUALIFIER VOYAGER');
  assert.equal(saved.rmk, true);
  assert.deepEqual(saved.vlsfoMaxRemarks, ['80cst min']);
  assert.match(saved.formattedText, /1,?000 MT RMK/);
  assert.match(saved.formattedText, /80CST MIN/);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openCenter(page);
  await rowFor(center(page), saved.id).getByRole('button', { name: 'Open QUALIFIER VOYAGER', exact: true }).click();
  await expect(center(page).getByRole('button', { name: 'RMK', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

await scenario('Mobile center keeps search parser and actions within the viewport', async page => {
  await login(page);
  const dialog = await openCenter(page);
  await paste(dialog);
  for (const label of ['Raw enquiry', 'Standard format', 'Buyer', 'Port', 'Vessel']) {
    const control = dialog.getByLabel(label, { exact: true });
    await control.scrollIntoViewIfNeeded();
    const box = await control.boundingBox();
    layoutChecks.push({ viewport: 390, label, box });
    assert.ok(box.x >= -1 && box.x + box.width <= 391, `${label} extends beyond viewport`);
  }
  await dialog.getByRole('combobox', { name: 'Buyer', exact: true }).fill('Harbor');
  const list = dialog.getByRole('listbox', { name: 'Buyer options', exact: true });
  const bounds = await list.boundingBox();
  assert.ok(bounds.x >= -1 && bounds.x + bounds.width <= 391);
  await dialog.getByRole('option', { name: 'HARBORLIGHT MARITIME SA', exact: true }).click();
  for (const action of ['AI FIX', 'Report', 'Confirm']) {
    await dialog.getByRole('button', { name: action, exact: true }).scrollIntoViewIfNeeded();
    await expect(dialog.getByRole('button', { name: action, exact: true })).toBeInViewport();
  }
  await dialog.getByLabel('Raw enquiry', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: new URL('center-mobile.png', OUTPUT).pathname, animations: 'disabled' });
}, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

await scenario('Legacy cleanup runs once while preserving history and later confirmed work', async page => {
  await login(page);
  const original = await state(page);
  assert.equal(original.enquiryCleanupVersion, 2);
  const legacy = structuredClone(original);
  delete legacy.enquiryCleanupVersion;
  for (const [index, status] of ['draft', 'sent', 'postponed'].entries()) legacy.enquiries.push({ ...original.enquiries[0], id: `legacy-active-${index}`, vessel: `LEGACY ACTIVE ${index}`, status });
  legacy.requests[0].enquiryId = 'legacy-active-1';
  await page.evaluate(value => {
    localStorage.setItem('ecosystem.demo.v1', JSON.stringify(value));
    localStorage.removeItem('ecosystem.inbox.v2');
    localStorage.setItem('ecosystem.inbox.v1', JSON.stringify({ version: 1, items: [{ id: 'legacy-arrival', providerMessageId: 'legacy-wa', channel: 'whatsapp', sender: '+85200000001', owner: 'otto', rawText: 'Vessel: LEGACY INCOMING', receivedAt: new Date().toISOString(), read: false }] }));
  }, legacy);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(navigation(page)).toBeVisible();
  const cleaned = await state(page);
  assert.equal(cleaned.enquiryCleanupVersion, 2);
  assert.deepEqual(cleaned.enquiries, original.enquiries);
  for (const key of ['outcomes', 'companies', 'contributions', 'drops', 'goals', 'audit']) assert.deepEqual(cleaned[key], original[key], `${key} must survive cleanup`);
  assert.equal(cleaned.requests[0].enquiryId, undefined);
  assert.equal((await inboxState(page)).length, 0);
  const incoming = await receive(page, 'Email');
  const dialog = await openCenter(page);
  await paste(dialog);
  const saved = await confirm(page, dialog);
  await page.reload({ waitUntil: 'domcontentloaded' });
  assert.ok((await inboxState(page)).some(item => item.id === incoming.id));
  assert.equal((await state(page)).enquiries.find(item => item.id === saved.id).status, 'sent');
  assert.deepEqual((await state(page)).outcomes, original.outcomes);
});

await scenario('Colleague notice distinguishes vessel identity without requiring an acknowledgment', async page => {
  await login(page);
  const baseline = await state(page);
  // Deliberate test fixture: Luca remains an internal peer, not a public login persona.
  const peer = { ...baseline.enquiries[0], id: 'qa-luca-active', owner: 'luca', buyerId: 'company-meridian', vessel: 'PEER VESSEL', imo: '9319466', status: 'sent', createdAt: new Date().toISOString() };
  await page.evaluate(peer => {
    const value = JSON.parse(localStorage.getItem('ecosystem.demo.v1'));
    value.enquiries.push(peer);
    localStorage.setItem('ecosystem.demo.v1', JSON.stringify(value));
  }, peer);
  await page.reload({ waitUntil: 'domcontentloaded' });
  const dialog = await openCenter(page);
  await paste(dialog, normal.replace('Harborlight Maritime SA', 'Meridian Shipping Pte Ltd'));
  const notice = dialog.getByRole('region', { name: 'Account activity', exact: true });
  await expect(notice).toContainText('SAMPLE TRADER C ALSO HAS AN ENQUIRY FOR THIS ACCOUNT. PLEASE DOUBLE CHECK.');
  await expect(notice).toContainText('SAME VESSEL');
  await expect(notice).not.toContainText(/MERIDIAN SHIPPING|PEER VESSEL/);
  await expect(notice.getByRole('checkbox')).toHaveCount(0);
  const format = await dialog.getByLabel('Standard format', { exact: true }).boundingBox();
  const bounds = await notice.boundingBox();
  assert.ok(bounds.y >= format.y + format.height && Math.abs(bounds.x - format.x) < 3);
  await expect(confirmButton(dialog)).toBeEnabled();
  await dialog.getByLabel('IMO', { exact: true }).fill('9876543');
  await expect(notice).toContainText('DIFFERENT VESSEL');
  await expect(notice).not.toContainText('SAME VESSEL');
  await choose(dialog, 'Buyer', 'Cape Union', 'CAPE UNION NAVIGATION SA');
  await expect(notice).toContainText('THIS ACCOUNT GROUP');
  await expect(notice).not.toContainText(/CAPE UNION|MERIDIAN GROUP/);
  const saved = await confirm(page, dialog);
  assert.deepEqual(saved.creditConfirmations, []);
});

await scenario('Intelligence and Credit tabs retain manually corrected enquiry context', async page => {
  await login(page);
  const dialog = await openCenter(page);
  await paste(dialog);
  await dialog.getByLabel(/^VLSFO/).fill('475');
  await dialog.getByRole('tab', { name: 'Ports & Suppliers', exact: true }).click();
  await expect(dialog.getByRole('tabpanel', { name: 'Ports & Suppliers', exact: true })).toContainText('Singapore');
  await dialog.getByRole('tab', { name: 'Buyers and Credit', exact: true }).click();
  const credit = dialog.getByRole('tabpanel', { name: 'Buyers and Credit', exact: true });
  await expect(credit).toContainText('$885,000');
  await expect(credit.getByRole('button', { name: 'Credit request', exact: true })).toBeEnabled();
  await dialog.getByRole('tab', { name: 'Enquiries', exact: true }).click();
  await expect(dialog.getByLabel(/^VLSFO/)).toHaveValue('475');
  await expect(confirmButton(dialog)).toBeEnabled();
});
await browser.close();
const report = { base: BASE, at: new Date().toISOString(), results, browserErrors, layoutChecks };
const suffix = FILTER ? `-${FILTER.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : '';
await writeFile(new URL(`enquiry-center${suffix}-report.json`, OUTPUT), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = results.some(item => item.status === 'failed') || browserErrors.length ? 1 : 0;
