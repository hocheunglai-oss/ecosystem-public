import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

// Deliberately isolated: no CDP attach, personal profile, visible window or external message transport.
const BASE = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4173';
const FILTER = process.env.ECO_TEST_FILTER;
const OUTPUT = new URL('../artifacts/', import.meta.url);
await mkdir(OUTPUT, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const results = [];
const browserErrors = [];
const normal = 'Buyer: Meridian Shipping Pte Ltd\nVessel: PACIFIC HORIZON\nIMO: 9319466\nPort: Singapore\nETA: 15-17 October\nVLSFO: 450 MT';
const multiple = 'Buyer: Meridian Shipping Pte Ltd\nVessel: OCEAN RANGES\nIMO: 9319466\nPort: Singapore\nETA: 15-17 October\nHSFO: 150-200 MT\nVLSFO: 450-500 MT\nLSMGO: 30 MT';
const windowFor = page => page.getByRole('dialog', { name: 'Send enquiry', exact: true });
const state = page => page.evaluate(() => JSON.parse(localStorage.getItem('ecosystem.demo.v1')));
async function login(page, persona = 'otto') {
  await page.getByLabel('Demo profile', { exact: true }).selectOption(persona);
  await page.getByRole('button', { name: 'Enter ecosystem', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace navigation' })).toBeVisible();
}
async function openComposer(page) {
  const navigation = page.getByRole('navigation', { name: 'Workspace navigation' });
  const trading = navigation.getByRole('button', { name: 'Trading', exact: true });
  if (await trading.getAttribute('aria-expanded') !== 'true') await trading.click();
  await navigation.getByRole('button', { name: 'Send enquiry', exact: true }).click();
  const dialog = windowFor(page);
  await expect(dialog).toBeVisible();
  return dialog;
}
async function paste(dialog, text, vessel) {
  await dialog.getByLabel('Raw enquiry', { exact: true }).fill(text);
  await expect(dialog.getByLabel('Vessel', { exact: true })).toHaveValue(vessel);
}
async function scenario(name, callback, options = {}) {
  if (FILTER && !name.toLowerCase().includes(FILTER.toLowerCase())) return;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', locale: 'en-GB', ...options });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  const outbound = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) outbound.push({ method: request.method(), url: request.url() }); });
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('button', { name: 'Enter ecosystem', exact: true })).toBeVisible();
    await callback(page, context);
    assert.deepEqual(outbound, [], 'Demo intake must not send messages or write to any external service');
    results.push({ name, status: 'passed' });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, status: 'failed', error: error.stack });
    console.log(`FAIL ${name}: ${error.message}`);
    await page.screenshot({ path: new URL(`intake-failure-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`, OUTPUT).pathname, animations: 'disabled' }).catch(() => {});
  } finally {
    browserErrors.push(...errors.map(error => ({ scenario: name, error })));
    await context.close();
  }
}

await scenario('Pasted enquiry auto-parses and excludes private commercial figures from output', async page => {
  await login(page);
  const dialog = await openComposer(page);
  await expect(dialog.getByRole('button', { name: /parse/i })).toHaveCount(0);
  await expect(dialog.getByLabel('Load demo scenario')).toHaveCount(0);
  await expect(dialog.locator('.page-heading')).toHaveCount(0);
  await paste(dialog, `${normal}\nPrice: USD 987.65\nMargin: USD 23.45`, 'PACIFIC HORIZON');
  await expect(dialog.getByLabel('IMO', { exact: true })).toHaveValue('9319466');
  await expect(dialog.getByLabel(/^Buyer/)).toHaveValue('company-meridian');
  await expect(dialog.getByRole('combobox', { name: /^Port/ })).toHaveValue('port-singapore');
  await expect(dialog.getByLabel(/^VLSFO/)).toHaveValue('450');
  await expect(dialog.getByLabel(/^HSFO/)).toHaveValue('');
  await expect(dialog.getByLabel(/^LSMGO/)).toHaveValue('');
  const outgoing = dialog.getByLabel('Standard format', { exact: true });
  await expect(outgoing).toHaveValue(/PACIFIC HORIZON/);
  await expect(outgoing).toHaveValue(/450/);
  assert.doesNotMatch(await outgoing.inputValue(), /(?:price|margin|987\.65|23\.45)/i);
  await expect(dialog.getByLabel(/Sale price|Margin \(|Estimated price/)).toHaveCount(0);
  await expect(dialog.getByRole('checkbox', { name: 'Verified', exact: true })).not.toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await page.screenshot({ path: new URL('intake-desktop.png', OUTPUT).pathname, animations: 'disabled' });
  await dialog.getByRole('checkbox', { name: 'Verified', exact: true }).check();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = (await state(page)).enquiries.find(item => item.vessel === 'PACIFIC HORIZON' && item.rawText.includes('987.65'));
  assert.ok(saved);
  assert.equal(saved.status, 'draft');
  assert.doesNotMatch(saved.formattedText, /(?:price|margin|987\.65|23\.45)/i);
  assert.equal(saved.price, 0, 'Pasted prices must not become a booking assumption');
  assert.equal(saved.margin, 0, 'Pasted margins must not become a booking assumption');
});

await scenario('Manual corrections persist while a new raw enquiry clears verification', async page => {
  await login(page);
  const dialog = await openComposer(page);
  await paste(dialog, normal, 'PACIFIC HORIZON');
  await dialog.getByLabel('Vessel', { exact: true }).fill('PACIFIC HORIZON CORRECTED');
  await dialog.getByLabel(/^VLSFO/).fill('475');
  await dialog.getByRole('textbox', { name: /^Remarks/ }).fill('Please reconfirm the supplier delivery window.');
  await dialog.getByRole('checkbox', { name: 'Verified', exact: true }).check();
  // Let pending parse timers and unrelated renders settle; user corrections must survive them.
  await page.waitForTimeout(700);
  await expect(dialog.getByLabel('Vessel', { exact: true })).toHaveValue('PACIFIC HORIZON CORRECTED');
  await expect(dialog.getByLabel(/^VLSFO/)).toHaveValue('475');
  await expect(dialog.getByRole('checkbox', { name: 'Verified', exact: true })).toBeChecked();
  await dialog.getByRole('button', { name: 'Close workspace', exact: true }).click();
  await openComposer(page);
  await expect(dialog.getByLabel('Vessel', { exact: true })).toHaveValue('PACIFIC HORIZON CORRECTED');
  await paste(dialog, normal.replace('PACIFIC HORIZON', 'SECOND ENQUIRY').replace('450 MT', '620 MT'), 'SECOND ENQUIRY');
  await expect(dialog.getByLabel(/^VLSFO/)).toHaveValue('620');
  await expect(dialog.getByRole('checkbox', { name: 'Verified', exact: true })).not.toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
});

await scenario('Three grade quantities and ranges survive parsing and optional terms stay explicit', async page => {
  await login(page);
  const dialog = await openComposer(page);
  await paste(dialog, multiple, 'OCEAN RANGES');
  await expect(dialog.getByLabel(/^HSFO/)).toHaveValue(/150\s*[-–]\s*200/);
  await expect(dialog.getByLabel(/^VLSFO/)).toHaveValue(/450\s*[-–]\s*500/);
  await expect(dialog.getByLabel(/^LSMGO/)).toHaveValue('30');
  for (const term of ['COQ REQUIRED', '30D QUALITY TIME BAR', 'BIMCO']) {
    const button = dialog.getByRole('button', { name: term, exact: true });
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
  }
  await dialog.getByRole('button', { name: '80cst min', exact: true }).click();
  await dialog.getByRole('button', { name: '120cst max', exact: true }).click();
  const outgoing = await dialog.getByLabel('Standard format', { exact: true }).inputValue();
  for (const value of ['HSFO', 'VLSFO', 'LSMGO', 'COQ REQUIRED', '30D QUALITY TIME BAR', 'BIMCO TERMS']) assert.ok(outgoing.includes(value), `Missing ${value} from output`);
  assert.match(outgoing, /150\s*[-–]\s*200/);
  assert.match(outgoing, /450\s*[-–]\s*500/);
  assert.match(outgoing, /80\s*cst/i);
  assert.match(outgoing, /120\s*cst/i);
  await dialog.getByRole('button', { name: 'BIMCO', exact: true }).click();
  assert.doesNotMatch(await dialog.getByLabel('Standard format', { exact: true }).inputValue(), /BIMCO TERMS/);
});

await scenario('Unknown buyers remain unconfirmed until the trader chooses the legal entity', async page => {
  await login(page);
  const dialog = await openComposer(page);
  await paste(dialog, normal.replace('Meridian Shipping Pte Ltd', 'UNLISTED DEMO BUYER'), 'PACIFIC HORIZON');
  await expect(dialog.getByLabel(/^Buyer/)).toHaveValue('');
  await dialog.getByRole('checkbox', { name: 'Verified', exact: true }).check();
  await expect(dialog.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await dialog.getByLabel(/^Buyer/).selectOption('company-meridian');
  await expect(dialog.getByRole('checkbox', { name: 'Verified', exact: true })).not.toBeChecked();
  await dialog.getByRole('checkbox', { name: 'Verified', exact: true }).check();
  await expect(dialog.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  await expect(dialog.getByLabel('Standard format', { exact: true })).toHaveValue(/Meridian Shipping Pte Ltd/);
});

await scenario('Unsupported volume units require manual MT confirmation instead of an invented conversion', async page => {
  await login(page);
  const dialog = await openComposer(page);
  await paste(dialog, normal.replace('450 MT', '500 CBM'), 'PACIFIC HORIZON');
  await expect(dialog.getByLabel(/^VLSFO/)).toHaveValue('');
  await expect(dialog).toContainText(/(?:non-MT|convert|conversion|CBM)/i);
  await dialog.getByRole('checkbox', { name: 'Verified', exact: true }).check();
  await expect(dialog.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await dialog.getByLabel(/^VLSFO/).fill('450');
  await dialog.getByRole('checkbox', { name: 'Verified', exact: true }).check();
  await expect(dialog.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
});

await scenario('Multi-grade fixtures require actual terms and sum itemized volume profit and credit', async page => {
  await login(page);
  const before = await state(page);
  const dialog = await openComposer(page);
  await paste(dialog, multiple, 'OCEAN RANGES');
  await dialog.getByRole('checkbox', { name: 'Verified', exact: true }).check();
  await dialog.getByRole('button', { name: 'Send', exact: true }).click();
  await dialog.getByRole('button', { name: 'Record fixture', exact: true }).click();
  const fixture = page.getByRole('dialog', { name: 'Record a fixture', exact: true });
  await expect(fixture.getByRole('button', { name: 'Book fixture', exact: true })).toBeDisabled();
  await expect(fixture.getByLabel('HSFO booked quantity (MT)', { exact: true })).toHaveValue('');
  await expect(fixture.getByLabel('VLSFO booked quantity (MT)', { exact: true })).toHaveValue('');
  await expect(fixture.getByLabel('LSMGO booked quantity (MT)', { exact: true })).toHaveValue('30');
  const products = [
    { grade: 'HSFO', quantity: 175, price: 500, margin: 8 },
    { grade: 'VLSFO', quantity: 475, price: 620, margin: 12 },
    { grade: 'LSMGO', quantity: 30, price: 800, margin: 20 },
  ];
  for (const item of products) {
    await expect(fixture.getByLabel(`${item.grade} sale price (USD / MT)`, { exact: true })).toHaveValue('');
    await expect(fixture.getByLabel(`${item.grade} margin (USD / MT)`, { exact: true })).toHaveValue('');
    await fixture.getByLabel(`${item.grade} booked quantity (MT)`, { exact: true }).fill(String(item.quantity));
    await fixture.getByLabel(`${item.grade} sale price (USD / MT)`, { exact: true }).fill(String(item.price));
    await fixture.getByLabel(`${item.grade} margin (USD / MT)`, { exact: true }).fill(String(item.margin));
  }
  await expect(fixture).toContainText('$7,700');
  await expect(fixture).toContainText('$406,000');
  await fixture.getByRole('button', { name: 'Book fixture', exact: true }).click();
  await expect(fixture).not.toBeVisible();
  const after = await state(page);
  const outcome = after.outcomes.find(item => item.vessel === 'OCEAN RANGES');
  assert.ok(outcome);
  assert.equal(outcome.kind, 'fixture');
  assert.equal(outcome.quantity, 680);
  assert.deepEqual(outcome.products, products);
  assert.equal(outcome.products.reduce((sum, item) => sum + item.quantity * item.margin, 0), 7700);
  assert.equal(after.companies.find(item => item.id === 'company-meridian').exposure, before.companies.find(item => item.id === 'company-meridian').exposure + 406000);
  assert.equal(after.enquiries.find(item => item.id === outcome.enquiryId).status, 'fixture');
  await dialog.getByRole('button', { name: 'Close workspace', exact: true }).click();
  await expect(page.locator('[data-trader-hud]')).toContainText('5,880');
  await expect(page.locator('[data-trader-hud]')).toContainText('96,900');
  await page.reload({ waitUntil: 'domcontentloaded' });
  assert.deepEqual((await state(page)).outcomes.find(item => item.id === outcome.id).products, products);
});

await scenario('WhatsApp notification opens a matched draft and reopening it does not duplicate the enquiry', async page => {
  await login(page);
  const before = await state(page);
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  const inbox = page.getByRole('region', { name: 'Enquiries', exact: true });
  await inbox.locator('.inbox-item').filter({ hasText: 'MERIDIAN DAWN' }).click();
  const dialog = windowFor(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Vessel', { exact: true })).toHaveValue('MERIDIAN DAWN');
  await expect(dialog.getByLabel(/^Buyer/)).toHaveValue('company-meridian');
  await expect(dialog.getByRole('combobox', { name: /^Port/ })).toHaveValue('port-singapore');
  await expect(dialog.getByLabel(/^HSFO/)).toHaveValue(/350\s*[-–]\s*400/);
  await expect(dialog.getByLabel(/^VLSFO/)).toHaveValue(/500\s*[-–]\s*600/);
  await expect(dialog.getByLabel(/^LSMGO/)).toHaveValue('60');
  await dialog.getByRole('checkbox', { name: 'Verified', exact: true }).check();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  const after = await state(page);
  assert.equal(after.enquiries.length, before.enquiries.length + 1);
  const saved = after.enquiries.find(item => item.vessel === 'MERIDIAN DAWN');
  assert.ok(saved);
  let items = await page.evaluate(() => JSON.parse(localStorage.getItem('ecosystem.inbox.v1')).items);
  const message = items.find(item => item.channel === 'whatsapp' && item.rawText.includes('MERIDIAN DAWN'));
  assert.equal(message.read, true);
  assert.equal(message.enquiryId, saved.id);
  assert.equal(message.owner, 'otto');
  await dialog.getByRole('button', { name: 'Close workspace', exact: true }).click();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  await page.getByRole('region', { name: 'Enquiries', exact: true }).locator('.inbox-item').filter({ hasText: 'MERIDIAN DAWN' }).click();
  const reopened = windowFor(page);
  await expect(reopened.getByLabel('Vessel', { exact: true })).toHaveValue('MERIDIAN DAWN');
  await reopened.getByRole('checkbox', { name: 'Verified', exact: true }).check();
  await reopened.getByRole('button', { name: 'Save', exact: true }).click();
  assert.equal((await state(page)).enquiries.length, after.enquiries.length);
  items = await page.evaluate(() => JSON.parse(localStorage.getItem('ecosystem.inbox.v1')).items);
  assert.equal(items.find(item => item.id === message.id).enquiryId, saved.id);
});

await scenario('Email homepage banner opens the intended buyer and port without sending an email', async page => {
  await login(page);
  const banner = page.getByRole('complementary', { name: 'New enquiry', exact: true });
  await expect(banner).toContainText('Email (demo)');
  await expect(banner).toContainText('PACIFIC LANTERN');
  await banner.locator('.inbox-banner-open').click();
  const dialog = windowFor(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Vessel', { exact: true })).toHaveValue('PACIFIC LANTERN');
  await expect(dialog.getByLabel(/^Buyer/)).toHaveValue('company-pacific-orbit');
  await expect(dialog.getByRole('combobox', { name: /^Port/ })).toHaveValue('port-tokyo');
  await expect(dialog.getByLabel(/^VLSFO/)).toHaveValue('400');
  await expect(dialog.getByLabel(/^LSMGO/)).toHaveValue(/80\s*[-–]\s*100/);
  await expect(dialog.getByRole('checkbox', { name: 'Verified', exact: true })).not.toBeChecked();
  const items = await page.evaluate(() => JSON.parse(localStorage.getItem('ecosystem.inbox.v1')).items);
  assert.equal(items.find(item => item.channel === 'email').read, true);
  assert.equal(items.find(item => item.channel === 'whatsapp').read, false);
});

await scenario('A demo channel arrival creates an unread message that opens from the homepage', async page => {
  await login(page);
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('ecosystem.inbox.v1')).items);
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  const inbox = page.getByRole('region', { name: 'Enquiries', exact: true });
  await inbox.getByRole('button', { name: 'WhatsApp (demo)', exact: true }).click();
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('ecosystem.inbox.v1')).items);
  assert.equal(after.length, before.length + 1);
  const received = after.find(item => !before.some(previous => previous.id === item.id));
  assert.equal(received.owner, 'otto');
  assert.equal(received.channel, 'whatsapp');
  assert.equal(received.read, false);
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  const banner = page.getByRole('complementary', { name: 'New enquiry', exact: true });
  await expect(banner).toContainText('WhatsApp (demo)');
  await banner.locator('.inbox-banner-open').click();
  await expect(windowFor(page).getByLabel('Vessel', { exact: true })).toHaveValue('MERIDIAN DAWN');
});

await scenario('Mobile notifications and the compact enquiry stay inside the viewport', async page => {
  await login(page);
  await page.getByRole('button', { name: 'Notifications', exact: true }).click();
  const inbox = page.getByRole('region', { name: 'Enquiries', exact: true });
  const inboxBounds = await inbox.boundingBox();
  assert.ok(inboxBounds.x >= -1 && inboxBounds.x + inboxBounds.width <= 391, `Mobile inbox exceeds viewport: ${JSON.stringify(inboxBounds)}`);
  await page.screenshot({ path: new URL('intake-notification-mobile.png', OUTPUT).pathname, animations: 'disabled' });
  await inbox.locator('.inbox-item').filter({ hasText: 'PACIFIC LANTERN' }).click();
  const dialog = windowFor(page);
  await expect(dialog.getByLabel('Vessel', { exact: true })).toHaveValue('PACIFIC LANTERN');
  await expect(dialog.getByLabel(/^VLSFO/)).toHaveValue('400');
  const overflow = await dialog.evaluate(element => {
    const content = element.querySelector('.window-content');
    const root = document.documentElement;
    return { pageWidth: root.clientWidth, pageScroll: root.scrollWidth, contentWidth: content.clientWidth, contentScroll: content.scrollWidth };
  });
  assert.ok(overflow.pageScroll <= overflow.pageWidth + 1 && overflow.contentScroll <= overflow.contentWidth + 1, `Mobile overflow: ${JSON.stringify(overflow)}`);
  await dialog.locator('.window-content').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: new URL('intake-mobile.png', OUTPUT).pathname, animations: 'disabled' });
  await dialog.getByRole('checkbox', { name: 'Verified', exact: true }).check();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = (await state(page)).enquiries.find(item => item.vessel === 'PACIFIC LANTERN');
  assert.ok(saved && saved.status === 'draft');
}, { viewport: { width: 390, height: 844 } });

await scenario('Draft lifecycle: editing a saved pasted draft updates the existing enquiry', async page => {
  await login(page);
  const before = await state(page);
  const dialog = await openComposer(page);
  await paste(dialog, normal, 'PACIFIC HORIZON');
  await dialog.getByRole('checkbox', { name: 'Verified', exact: true }).check();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  const firstSave = await state(page);
  const saved = firstSave.enquiries.find(item => !before.enquiries.some(previous => previous.id === item.id));
  assert.ok(saved);
  assert.equal(firstSave.enquiries.length, before.enquiries.length + 1);
  await paste(dialog, normal.replace('PACIFIC HORIZON', 'PACIFIC DRAFT UPDATED').replace('450 MT', '525 MT'), 'PACIFIC DRAFT UPDATED');
  await expect(dialog.getByRole('checkbox', { name: 'Verified', exact: true })).not.toBeChecked();
  await dialog.getByRole('checkbox', { name: 'Verified', exact: true }).check();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  const secondSave = await state(page);
  assert.equal(secondSave.enquiries.length, firstSave.enquiries.length, 'Editing a draft must not create another enquiry');
  const updated = secondSave.enquiries.find(item => item.id === saved.id);
  assert.equal(updated.vessel, 'PACIFIC DRAFT UPDATED');
  assert.equal(updated.status, 'draft');
  assert.match(updated.formattedText, /525/);
  assert.equal(updated.createdAt, saved.createdAt);
});

await scenario('Draft lifecycle: a new paste after sending creates a distinct enquiry', async page => {
  await login(page);
  const before = await state(page);
  const dialog = await openComposer(page);
  await paste(dialog, normal.replace('PACIFIC HORIZON', 'FIRST DEMO SEND'), 'FIRST DEMO SEND');
  await dialog.getByRole('checkbox', { name: 'Verified', exact: true }).check();
  await dialog.getByRole('button', { name: 'Send', exact: true }).click();
  const first = (await state(page)).enquiries.find(item => item.vessel === 'FIRST DEMO SEND');
  assert.equal(first.status, 'sent');
  await expect(dialog.getByLabel('Raw enquiry', { exact: true })).toBeEnabled();
  await paste(dialog, normal.replace('PACIFIC HORIZON', 'SECOND DEMO SEND').replace('450 MT', '300 MT'), 'SECOND DEMO SEND');
  await expect(dialog.getByRole('checkbox', { name: 'Verified', exact: true })).not.toBeChecked();
  await dialog.getByRole('checkbox', { name: 'Verified', exact: true }).check();
  await dialog.getByRole('button', { name: 'Send', exact: true }).click();
  const after = await state(page);
  const second = after.enquiries.find(item => item.vessel === 'SECOND DEMO SEND');
  assert.equal(after.enquiries.length, before.enquiries.length + 2);
  assert.notEqual(first.id, second.id);
  assert.equal(second.status, 'sent');
  assert.equal(after.enquiries.find(item => item.id === first.id).rawText, first.rawText, 'The first sent enquiry must remain unchanged');
  assert.match(second.formattedText, /300/);
});

await scenario('Draft lifecycle: switching through WhatsApp preserves manual edits in the pasted draft', async page => {
  await login(page);
  const dialog = await openComposer(page);
  await paste(dialog, normal, 'PACIFIC HORIZON');
  await dialog.getByLabel('Vessel', { exact: true }).fill('LOCAL CORRECTION');
  await dialog.getByLabel(/^VLSFO/).fill('475');
  await dialog.getByRole('textbox', { name: /^Remarks/ }).fill('Hold for the supplier delivery confirmation.');
  await dialog.getByRole('button', { name: 'BIMCO', exact: true }).click();
  await dialog.getByRole('checkbox', { name: 'Verified', exact: true }).check();
  const formatBefore = await dialog.getByLabel('Standard format', { exact: true }).inputValue();
  await dialog.getByRole('button', { name: 'WhatsApp', exact: true }).click();
  await expect(dialog.getByLabel('Vessel', { exact: true })).toHaveValue('MERIDIAN DAWN');
  await dialog.getByRole('button', { name: 'Paste', exact: true }).click();
  await expect(dialog.getByLabel('Raw enquiry', { exact: true })).toHaveValue(normal);
  await expect(dialog.getByLabel('Vessel', { exact: true })).toHaveValue('LOCAL CORRECTION');
  await expect(dialog.getByLabel(/^VLSFO/)).toHaveValue('475');
  await expect(dialog.getByRole('textbox', { name: /^Remarks/ })).toHaveValue(/Hold for the supplier delivery confirmation/);
  await expect(dialog.getByRole('button', { name: 'BIMCO', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByRole('checkbox', { name: 'Verified', exact: true })).toBeChecked();
  await expect(dialog.getByLabel('Standard format', { exact: true })).toHaveValue(formatBefore);
});

await scenario('Custom format quantity mismatches block saving until the standard format is reset', async page => {
  await login(page);
  const dialog = await openComposer(page);
  await paste(dialog, normal, 'PACIFIC HORIZON');
  const output = dialog.getByLabel('Standard format', { exact: true });
  const original = await output.inputValue();
  assert.match(original, /\b450\b/);
  await dialog.getByRole('checkbox', { name: 'Verified', exact: true }).check();
  await output.fill(original.replace(/\b450\b/, '1000'));
  await expect(dialog.getByRole('checkbox', { name: 'Verified', exact: true })).not.toBeChecked();
  await expect(dialog).toContainText('Standard format differs from the details. Reset format or correct it.');
  await dialog.getByRole('checkbox', { name: 'Verified', exact: true }).check();
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await expect(dialog.getByLabel(/^VLSFO/)).toHaveValue('450');
  await dialog.getByRole('button', { name: 'Reset format', exact: true }).click();
  await expect(output).toHaveValue(original);
  await expect(dialog).not.toContainText('Standard format differs from the details. Reset format or correct it.');
  await expect(dialog.getByRole('checkbox', { name: 'Verified', exact: true })).not.toBeChecked();
  await dialog.getByRole('checkbox', { name: 'Verified', exact: true }).check();
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
});

await browser.close();
const report = { base: BASE, at: new Date().toISOString(), results, browserErrors };
const suffix = FILTER ? `-${FILTER.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : '';
await writeFile(new URL(`enquiry-intake${suffix}-report.json`, OUTPUT), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = results.some(item => item.status === 'failed') || browserErrors.length ? 1 : 0;
