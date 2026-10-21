import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

// Each scenario uses its own browser context. Never connect to a personal Chrome profile.
const BASE = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4173';
const FILTER = process.env.ECO_TEST_FILTER;
const OUTPUT = new URL('../artifacts/', import.meta.url);
await mkdir(OUTPUT, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const results = [];
const browserErrors = [];
const layoutChecks = [];
const groups = {
  Trading: ['Enquiries', 'Fixtures', 'Lost Records'],
  Intelligence: ['Port data', 'Country data', 'Supplier Profiles'],
  Credit: ['Credit request', 'Buyer Profile', 'Credit records'],
  Contribute: ['Ports and countries', 'Feedback for ecosystem'],
};
const normalEnquiry = 'Buyer: Meridian Shipping Pte Ltd\nVessel: PACIFIC HORIZON\nIMO: 9319466\nPort: Singapore\nETA: 15-17 October\nVLSFO: 450 MT\nPrice: USD 620\nMargin: USD 12';
async function fillNormalEnquiry(dialog) {
  await dialog.getByLabel('Raw enquiry', { exact: true }).fill(normalEnquiry);
  await expect(dialog.getByLabel('Vessel', { exact: true })).toHaveValue('PACIFIC HORIZON');
}
const snapshot = page => page.evaluate(() => JSON.parse(localStorage.getItem('ecosystem.demo.v1')));
const resetComparable = value => {
  const copy = structuredClone(value);
  // A reset intentionally gives the seeded active colleague enquiry a fresh timestamp.
  const demoPeer = copy.enquiries.find(item => item.id === 'enquiry-demo-luca');
  if (demoPeer) delete demoPeer.createdAt;
  for (const grant of copy.economy?.grants ?? []) delete grant.at;
  return copy;
};
const gold = state => 2 + state.contributions.filter(entry => entry.author === 'otto' && entry.status === 'approved').length + (state.economy?.grants ?? []).filter(entry => entry.owner === 'otto' && entry.resource === 'gold').reduce((sum, entry) => sum + entry.amount, 0);
const monthOf = date => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit' }).format(new Date(date));
const stats = state => {
  const fixtures = state.outcomes.filter(item => item.kind === 'fixture' && item.commercialStatus !== 'pending' && item.owner === 'otto' && monthOf(item.bookedAt) === monthOf(new Date()));
  return { volume: fixtures.reduce((sum, item) => sum + item.quantity, 0), profit: fixtures.reduce((sum, item) => sum + item.quantity * item.margin, 0) };
};
const navigation = page => page.getByRole('navigation', { name: 'Workspace navigation' });
const workspace = (page, name) => page.getByRole('dialog', { name, exact: true });
async function screenshot(page, name) {
  await page.screenshot({ path: new URL(`immersive-${name}.png`, OUTPUT).pathname, animations: 'disabled' });
}
async function login(page, actor = 'otto') {
  await page.getByLabel('Demo profile', { exact: true }).selectOption(actor);
  await page.getByRole('button', { name: 'ENTER ECOSYSTEM', exact: true }).click();
  await expect(navigation(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => scrollY), { message: 'Entering the harbour should reveal its logo and menus from the top' }).toBe(0);
}
async function openWorkspace(page, group, name) {
  const originalUrl = page.url();
  const menu = navigation(page).getByRole('button', { name: group, exact: true });
  if (await menu.getAttribute('aria-expanded') !== 'true') await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await navigation(page).getByRole('button', { name, exact: true }).click();
  const dialog = workspace(page, name);
  await expect(dialog).toBeVisible();
  assert.equal(page.url(), originalUrl, 'Opening a workspace must not navigate away from the harbour');
  return dialog;
}
async function closeWorkspace(page) {
  await page.getByRole('button', { name: 'Close workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close workspace', exact: true })).toHaveCount(0);
}
async function changeRole(page, actor) {
  await page.getByRole('button', { name: 'Personal details', exact: true }).click();
  await workspace(page, 'Personal details').getByRole('button', { name: 'Sign out', exact: true }).click();
  await login(page, actor);
}
async function reviewStem(page) {
  const modal = workspace(page, 'STEM');
  await modal.getByRole('checkbox', { name: 'Compliance', exact: true }).check();
  await modal.getByRole('checkbox', { name: 'Credit', exact: true }).check();
}
async function fillStem(page, price = '620') {
  const modal = workspace(page, 'STEM');
  await modal.getByRole('combobox', { name: 'VLSFO supplier', exact: true }).fill('Meridian');
  await modal.getByRole('option', { name: 'MERIDIAN BUNKER SUPPLY · DEMO', exact: true }).click();
  await modal.getByLabel('VLSFO buy price (USD / MT)', { exact: true }).fill(price);
  return modal;
}

async function closeAction(page) {
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close dialog', exact: true })).toHaveCount(0);
}
async function assertFocusCycle(page, dialog) {
  for (const [edge, key] of [['last', 'Tab'], ['first', 'Shift+Tab']]) {
    await dialog.evaluate((root, edge) => {
      const focusables = [...root.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter(element => element.getClientRects().length && !element.closest('[inert], [hidden]'));
      (edge === 'last' ? focusables.at(-1) : focusables[0]).focus();
    }, edge);
    await page.keyboard.press(key);
    assert.ok(await dialog.evaluate(root => root.contains(document.activeElement)), `Focus escaped dialog at ${edge} boundary`);
  }
}
async function scenario(name, callback, options = {}) {
  if (FILTER && !name.toLowerCase().includes(FILTER.toLowerCase())) return;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-GB', ...options });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  const mediaRequests = [];
  page.on('pageerror', error => errors.push(`Page: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') errors.push(`Console: ${message.text()}`); });
  page.on('request', request => { if (/\.mp4(?:$|\?)/.test(request.url())) mediaRequests.push(request.url()); });
  try {
    // A streaming film can prevent networkidle; the actual login control is the readiness signal.
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('button', { name: 'ENTER ECOSYSTEM', exact: true })).toBeVisible();
    await callback(page, context, mediaRequests);
    results.push({ name, status: 'passed' });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, status: 'failed', error: error.stack });
    console.log(`FAIL ${name}: ${error.message}`);
    await screenshot(page, `failure-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`).catch(() => {});
  } finally {
    browserErrors.push(...errors.map(error => ({ scenario: name, error })));
    await context.close();
  }
}

await scenario('Minimal login, compact Gold and Hats HUD, session reload and explicit sign out', async (page, context) => {
  await expect(navigation(page)).toHaveCount(0);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.locator('.entry-story, .entry-horizon, .entry-intro, .pass-topline, .pass-emblem, .pass-baseline')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Pause animation|Play animation|Set monthly targets/ })).toHaveCount(0);
  await expect(page.getByText('FRATELLI COSULICH MARINE ENERGY', { exact: true })).toBeVisible();
  await expect(page.getByText('ECOSYSTEM | FRATELLI COSULICH', { exact: true })).toBeVisible();
  const loginBounds = await page.locator('.entry-pass').boundingBox();
  assert.ok(Math.abs(loginBounds.x + loginBounds.width / 2 - 720) < 3, 'Login should be horizontally centered');
  assert.ok(Math.abs(loginBounds.y + loginBounds.height / 2 - 500) < 80, 'Login should sit in the middle of the harbour');
  const logoBounds = await page.locator('.ecosystem-logo').boundingBox();
  const taglineBounds = await page.getByText('FRATELLI COSULICH MARINE ENERGY', { exact: true }).boundingBox();
  assert.ok(Math.abs(logoBounds.width - taglineBounds.width) < 3, 'Brand tagline should span the logo width');
  await screenshot(page, 'login-desktop');
  await login(page);
  const hud = page.locator('[data-trader-hud]');
  await expect(hud).toContainText('SAMPLE TRADER');
  await expect(hud.locator('[data-resource="gold"]')).toContainText(String(gold(await snapshot(page))));
  await expect(hud).not.toContainText(/contribution/i);
  await expect(hud.locator('.hud-identity')).toContainText('Trader');
  await expect(page.getByRole('button', { name: 'Personal details', exact: true })).toBeVisible();
  await expect(hud).not.toContainText(/Total volume|Transported volume|Oil/);
  await expect(page.locator('[data-cosulich-barge]')).toHaveCount(2);
  await expect(hud).not.toContainText(/Target|Profit/);
  await expect(hud).not.toContainText(/GOLD DROPS|YOUR PROGRESS|USD|ECOSYSTEM/);
  await expect(hud.locator('.profile-avatar, .hud-month')).toHaveCount(0);
  await expect(hud.getByRole('button', { name: 'Set monthly targets', exact: true })).toHaveCount(0);
  for (const name of Object.keys(groups)) {
    const toggle = navigation(page).getByRole('button', { name, exact: true });
    await expect(toggle).toHaveText(name);
  }
  const goldPaint = await page.locator('[data-resource="gold"] .resource-icon').evaluate(element => ({
    stops: [...element.querySelectorAll('stop')].map(stop => getComputedStyle(stop).stopColor),
  }));
  assert.ok(goldPaint.stops.some(colour => { const rgb = colour.match(/[\d.]+/g)?.map(Number) || []; return rgb[0] > 150 && rgb[1] > 100 && rgb[0] > rgb[2] + 40; }));
  await expect(hud.locator('[data-resource="oil"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
  await screenshot(page, 'home-desktop');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(navigation(page)).toBeVisible();
  // A newly opened tab must require its own demo session; no account authentication is implied.
  const second = await context.newPage();
  await second.goto(BASE, { waitUntil: 'domcontentloaded' });
  await expect(second.getByRole('button', { name: 'ENTER ECOSYSTEM', exact: true })).toBeVisible();
  await second.close();
  await page.getByRole('button', { name: 'Personal details', exact: true }).click();
  await workspace(page, 'Personal details').getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'ENTER ECOSYSTEM', exact: true })).toBeVisible();
  await expect(navigation(page)).toHaveCount(0);
});

await scenario('All eleven menu actions open local windows over the same harbour', async page => {
  await login(page);
  for (const [group, children] of Object.entries(groups)) {
    const button = navigation(page).getByRole('button', { name: group, exact: true });
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await button.click();
    for (const name of children) await expect(navigation(page).getByRole('button', { name, exact: true })).toBeVisible();
    for (const name of children) {
      const window = await openWorkspace(page, group, name);
      await expect(window).toContainText(name);
      await expect(page.locator('.marine-world')).toHaveCount(1);
      await closeWorkspace(page);
    }
    if (await button.getAttribute('aria-expanded') === 'true') await button.click();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
  }
});

await scenario('All public roles have Settings and Sign out with a readable compact HUD', async page => {
  for (const [id, name, role] of [['otto', 'SAMPLE TRADER', 'Trader'], ['gianmichele', 'SAMPLE MANAGER A', 'Manager'], ['silvia', 'SAMPLE MANAGER B', 'Manager'], ['filippo', 'SAMPLE TRADER B', 'Trader'], ['elena', 'SAMPLE CREDIT REVIEWER', 'Credit'], ['marco', 'SAMPLE ADMINISTRATOR', 'Admin']]) {
    await login(page, id);
    const hud = page.locator('[data-trader-hud]');
    const identity = hud.locator('.hud-identity');
    await expect(identity).toContainText(name);
    await expect(identity).toContainText(role);
    const nameBox = await identity.locator('strong').boundingBox();
    const roleBox = await identity.locator('span').boundingBox();
    assert.ok(roleBox.y >= nameBox.y + nameBox.height - 1);
    const clipped = await identity.locator('strong').evaluate(element => element.scrollWidth > element.clientWidth + 1);
    assert.equal(clipped, false, `Long name clipped for ${name}`);
    await expect(hud.getByRole('button', { name: 'Personal details', exact: true })).toBeVisible();
    await expect(hud).not.toContainText(/contribution/i);
    const bell = await hud.getByRole('button', { name: 'Notifications', exact: true }).boundingBox();
    const settings = await hud.getByRole('button', { name: 'Settings', exact: true }).boundingBox();
    assert.ok(Math.abs(settings.y + settings.height / 2 - bell.y - bell.height / 2) < 3);
    if (role === 'Trader' || role === 'Manager') {
      const points = await hud.locator('[data-resource="gold"]').boundingBox();
      assert.ok(Math.abs(points.y + points.height / 2 - bell.y - bell.height / 2) < 3);
      await expect(hud.locator('.hud-volume-row, [data-resource="oil"]')).toHaveCount(0);
      await expect(hud.locator('.hud-achievements-toggle')).toContainText('Achievements');
    } else {
      await expect(hud.locator('[data-resource="gold"], [data-resource="oil"], .hud-achievements-toggle, .hud-volume-row')).toHaveCount(0);
      if (role === 'Admin') await expect(hud.getByRole('button', { name: 'Office Performance', exact: true })).toBeVisible();
      else await expect(hud.locator('.hud-office-performance')).toHaveCount(0);
    }
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-trader-hud]')).toContainText(name);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = workspace(page, 'Settings');
    if (id === 'marco') await expect(dialog.getByRole('button', { name: 'Audit trail', exact: true })).toBeVisible();
    else await expect(dialog.getByRole('button', { name: 'Audit trail', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
    await closeWorkspace(page);
    await hud.getByRole('button', { name: 'Personal details', exact: true }).click();
    await workspace(page, 'Personal details').getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('button', { name: 'ENTER ECOSYSTEM', exact: true })).toBeVisible();
  }
  await expect(page.getByLabel('Demo profile', { exact: true }).locator('option')).toHaveCount(6);
});

await scenario('The Destination harbour fills the viewport and remains behind a window', async page => {
  await login(page);
  await expect(page.locator('.marine-world')).toHaveAttribute('data-playback', 'destination');
  await expect(page.locator('.marine-world video')).toHaveCount(0);
  await expect(page.locator('.marine-world')).toHaveAttribute('data-arrival-count', '0');
  const bounds = await page.locator('.marine-world').boundingBox();
  assert.ok(bounds.x <= 1 && bounds.y <= 1 && bounds.width >= 1439 && bounds.height >= 999);
  await openWorkspace(page, 'Trading', 'Enquiries');
  await expect(page.locator('.marine-world')).toHaveCount(1);
  await closeWorkspace(page);
});

await scenario('Enquiry draft survives window changes; keyboard focus stays inside and returns', async page => {
  await login(page);
  const dialog = await openWorkspace(page, 'Trading', 'Enquiries');
  await fillNormalEnquiry(dialog);
  await dialog.getByLabel('Vessel', { exact: true }).fill('DEMO DRAFT RETAINED');
  await dialog.getByRole('button', { name: 'BIMCO', exact: true }).click();
  // Exercise both focus boundaries rather than merely inspecting ARIA attributes.
  await assertFocusCycle(page, dialog);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(navigation(page).getByRole('button', { name: 'Enquiries', exact: true })).toBeFocused();
  await openWorkspace(page, 'Intelligence', 'Port data');
  await closeWorkspace(page);
  const reopened = await openWorkspace(page, 'Trading', 'Enquiries');
  await expect(reopened.getByLabel('Vessel', { exact: true })).toHaveValue('DEMO DRAFT RETAINED');
  await expect(reopened.getByRole('button', { name: 'BIMCO', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

await scenario('Pending STEM saves supply terms while keeping monthly HUD and credit unchanged', async page => {
  await login(page);
  const before = await snapshot(page);
  const dialog = await openWorkspace(page, 'Trading', 'Enquiries');
  await fillNormalEnquiry(dialog);
  await dialog.getByRole('button', { name: 'BIMCO', exact: true }).click();
  await expect(dialog.getByLabel('Standard format', { exact: true })).toHaveValue(/BIMCO TERMS/);
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  const enquiryId = (await snapshot(page)).enquiries.find(item => item.vessel === 'PACIFIC HORIZON').id;
  const stemButton = dialog.locator(`[data-enquiry-id="${enquiryId}"]`).getByRole('button', { name: 'Stem', exact: true });
  await stemButton.click();
  await assertFocusCycle(page, workspace(page, 'STEM'));
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Close dialog', exact: true })).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(stemButton).toBeFocused();
  await stemButton.click();
  await fillStem(page);
  await page.getByLabel('Private note', { exact: true }).fill('Supplier confirmed for this demo booking.');
  await reviewStem(page);
  await workspace(page, 'STEM').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close dialog', exact: true })).toHaveCount(0);
  await expect(dialog).toBeVisible();
  const after = await snapshot(page);
  assert.deepEqual(stats(after), stats(before));
  assert.equal(after.companies.find(item => item.id === 'company-meridian').exposure, before.companies.find(item => item.id === 'company-meridian').exposure);
  const outcome = after.outcomes.find(item => item.enquiryId === enquiryId);
  assert.equal(outcome.commercialStatus, 'pending');
  assert.deepEqual(outcome.stemProducts, [{ grade: 'VLSFO', quantityText: '450', buyPrice: 620, supplierId: 'supplier-meridian', supplierName: 'Meridian Bunker Supply · Demo' }]);
  assert.deepEqual(after.drops, before.drops);
  await closeWorkspace(page);
  await expect(page.locator('[data-trader-hud]')).toContainText('3,000,000');
  await expect(page.locator('[data-trader-hud]')).not.toContainText(/Target|Profit/);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(navigation(page)).toBeVisible();
  assert.deepEqual(stats(await snapshot(page)), stats(after));
});

await scenario('Credit approval retains its decision and increases the limit while STEM stays pending', async page => {
  await login(page);
  let dialog = await openWorkspace(page, 'Trading', 'Enquiries');
  const raw = normalEnquiry.replace('Meridian Shipping Pte Ltd', 'Bluewater Navigation Ltd').replace('PACIFIC HORIZON', 'BLUEWATER SKY').replace('450 MT', '500 MT');
  await dialog.getByLabel('Raw enquiry', { exact: true }).fill(raw);
  await expect(dialog.getByLabel('Vessel', { exact: true })).toHaveValue('BLUEWATER SKY');
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  const enquiryId = (await snapshot(page)).enquiries.find(item => item.vessel === 'BLUEWATER SKY').id;
  await dialog.locator(`[data-enquiry-id="${enquiryId}"]`).getByRole('button', { name: 'Stem', exact: true }).click();
  await fillStem(page, '610');
  await expect(workspace(page, 'STEM').getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await reviewStem(page);
  await expect(workspace(page, 'STEM').getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  assert.equal((await snapshot(page)).companies.find(item => item.id === 'company-bluewater').exposure, 780000);
  await closeAction(page);
  await closeWorkspace(page);
  await changeRole(page, 'elena');
  dialog = await openWorkspace(page, 'Credit', 'Credit request');
  await dialog.getByRole('button', { name: 'Review request', exact: true }).click();
  await page.getByLabel('Approved increase (USD)').fill('350000');
  await page.getByLabel('Decision rationale and conditions').fill('Approved for the linked vessel commitment. Maintain 30-day terms and review overdue balances.');
  await page.getByRole('button', { name: 'Approve credit', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close dialog', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Decision history', exact: true }).click();
  dialog = workspace(page, 'Credit records');
  await expect(dialog.locator('.decision-record')).toContainText('SAMPLE CREDIT REVIEWER');
  await expect(dialog.locator('.decision-record')).toContainText('Maintain 30-day terms');
  await closeWorkspace(page);
  await changeRole(page, 'otto');
  dialog = await openWorkspace(page, 'Trading', 'Enquiries');
  await dialog.locator(`[data-enquiry-id="${enquiryId}"]`).getByRole('button', { name: 'Stem', exact: true }).click();
  await fillStem(page, '610');
  await reviewStem(page);
  await workspace(page, 'STEM').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close dialog', exact: true })).toHaveCount(0);
  const saved = await snapshot(page);
  assert.equal(saved.requests.find(item => item.id === 'credit-001').decision.by, 'elena');
  assert.equal(saved.companies.find(item => item.id === 'company-bluewater').limit, 1250000);
  assert.equal(saved.companies.find(item => item.id === 'company-bluewater').exposure, 780000);
  assert.equal(saved.enquiries.find(item => item.id === enquiryId).status, 'fixture');
  assert.equal(gold(saved), 6000);
});

await scenario('Management accepts useful knowledge and awards the contributor Gold', async page => {
  await login(page);
  const before = await snapshot(page);
  const title = 'Demo Singapore handover: confirm the latest delivery window';
  const contribute = await openWorkspace(page, 'Contribute', 'Ports and countries');
  await contribute.getByLabel(/^Type/).selectOption('port');
  await contribute.getByLabel(/^Port/).selectOption('port-singapore');
  await contribute.getByRole('button', { name: 'Contribute', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByLabel('Details', { exact: true }).fill('Keep the latest buyer-confirmed delivery window and named contact in the shared desk handover.');
  await page.getByLabel('Source', { exact: true }).fill('Fictional desk process review');
  await page.getByRole('button', { name: 'Submit for review', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close dialog', exact: true })).toHaveCount(0);
  assert.equal(gold(await snapshot(page)), gold(before), 'Submission must wait for independent review before earning Gold');
  await closeWorkspace(page);
  await changeRole(page, 'marco');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('article').filter({ hasText: title }).getByRole('button', { name: 'Review contribution', exact: true }).click();
  await page.getByLabel('Review note').fill('Accepted after checking the source and usefulness for the group.');
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close dialog', exact: true })).toHaveCount(0);
  const after = await snapshot(page);
  assert.equal(gold(after), gold(before) + 1);
  assert.equal(after.contributions.find(item => item.title === title).status, 'approved');
  await closeWorkspace(page);
  await changeRole(page, 'otto');
  await expect(page.locator('[data-resource="gold"]')).toContainText('6,001');
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
});

await scenario('Country contributions publish to the country record after independent review', async page => {
  await login(page);
  const before = await snapshot(page);
  const title = 'Singapore country knowledge: align the desk handover';
  const body = 'Keep the latest sourced country context and its review date with the shared handover before confirming operational details.';
  const dialog = await openWorkspace(page, 'Contribute', 'Ports and countries');
  await dialog.getByLabel(/^Type/).selectOption('country');
  await dialog.getByLabel(/^Country/).selectOption('Singapore');
  await dialog.getByRole('button', { name: 'Contribute', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByLabel('Details', { exact: true }).fill(body);
  await page.getByLabel('Source', { exact: true }).fill('Fictional demo country review');
  await page.getByRole('button', { name: 'Submit for review', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close dialog', exact: true })).toHaveCount(0);
  let record = (await snapshot(page)).contributions.find(item => item.title === title);
  assert.equal(record.targetType, 'country');
  assert.equal(record.targetId, 'Singapore');
  assert.equal(record.status, 'pending');
  assert.equal(gold(await snapshot(page)), gold(before));
  await closeWorkspace(page);
  await changeRole(page, 'marco');
  const review = await openWorkspace(page, 'Contribute', 'Ports and countries');
  await review.getByRole('article').filter({ hasText: title }).getByRole('button', { name: 'Review', exact: true }).click();
  await page.getByLabel('Review note').fill('Accepted as a sourced country handover improvement for the demo.');
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close dialog', exact: true })).toHaveCount(0);
  const after = await snapshot(page);
  record = after.contributions.find(item => item.title === title);
  assert.equal(record.status, 'approved');
  assert.equal(record.reviewer, 'marco');
  assert.equal(gold(after), gold(before) + 1);
  assert.deepEqual(after.ports, before.ports, 'Country knowledge must not rewrite a port record');
  await closeWorkspace(page);
  const country = await openWorkspace(page, 'Intelligence', 'Country data');
  await country.getByLabel('Search countries', { exact: true }).fill('Singapore');
  await expect(country).toContainText(title);
  await expect(country).toContainText(body);
});

await scenario('Ecosystem feedback stays separate from knowledge and does not award Gold before approval', async page => {
  await login(page);
  const before = await snapshot(page);
  const title = 'Keep the current filter when reopening supplier data';
  const body = 'Retaining the last supplier grade and search would help me resume an interrupted enquiry without repeating the same steps.';
  const feedback = await openWorkspace(page, 'Contribute', 'Feedback for ecosystem');
  await feedback.getByLabel('Title', { exact: true }).fill(title);
  await feedback.getByLabel('Details', { exact: true }).fill(body);
  await feedback.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(feedback.getByLabel('Title', { exact: true })).toHaveValue('');
  await expect(feedback.getByRole('article').filter({ hasText: title })).toContainText('Pending');
  let record = (await snapshot(page)).contributions.find(item => item.title === title);
  assert.equal(record.targetType, 'feedback');
  assert.equal(record.targetId, 'ecosystem');
  assert.equal(gold(await snapshot(page)), gold(before));
  await closeWorkspace(page);
  const knowledge = await openWorkspace(page, 'Contribute', 'Ports and countries');
  await expect(knowledge.getByRole('article').filter({ hasText: title })).toHaveCount(0);
  await closeWorkspace(page);
  await changeRole(page, 'marco');
  const managerFeedback = await openWorkspace(page, 'Contribute', 'Feedback for ecosystem');
  await managerFeedback.getByRole('article').filter({ hasText: title }).getByRole('button', { name: 'Review', exact: true }).click();
  await page.getByLabel('Review note').fill('Accepted for the product improvement backlog; keep the window state across visits.');
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close dialog', exact: true })).toHaveCount(0);
  const after = await snapshot(page);
  record = after.contributions.find(item => item.title === title);
  assert.equal(record.status, 'approved');
  assert.equal(record.reviewer, 'marco');
  assert.equal(gold(after), gold(before) + 1, 'Approved feedback earns one Gold');
  assert.ok(after.audit.some(entry => entry.entity === title && entry.actor === 'SAMPLE ADMINISTRATOR'));
  await closeWorkspace(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  assert.equal((await snapshot(page)).contributions.find(item => item.title === title).status, 'approved');
});

await scenario('Management has no retired transport reward settings', async page => {
  await login(page, 'marco');
  const before = await snapshot(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = workspace(page, 'Settings');
  await expect(settings.getByRole('button', { name: 'Rewards', exact: true })).toHaveCount(0);
  await expect(settings.getByRole('region', { name: 'Annual rewards' })).toHaveCount(0);
  await closeWorkspace(page);
  const after = await snapshot(page);
  assert.deepEqual(after.economy, before.economy);
  assert.deepEqual(after.goals, before.goals);
  assert.deepEqual(after.outcomes, before.outcomes);
});

await scenario('Lost Record preserve the reason without increasing monthly performance or exposure', async page => {
  await login(page);
  const before = await snapshot(page);
  let dialog = await openWorkspace(page, 'Trading', 'Enquiries');
  await dialog.getByLabel('Raw enquiry', { exact: true }).fill(normalEnquiry.replace('Meridian Shipping Pte Ltd', 'Delta Horizon Shipping BV').replace('PACIFIC HORIZON', 'DELTA EXPLORER').replace('Singapore', 'Rotterdam'));
  await expect(dialog.getByLabel('Vessel', { exact: true })).toHaveValue('DELTA EXPLORER');
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  const enquiryId = (await snapshot(page)).enquiries.find(item => item.vessel === 'DELTA EXPLORER').id;
  await closeWorkspace(page);
  dialog = await openWorkspace(page, 'Trading', 'Lost Records');
  await dialog.getByRole('row').filter({ hasText: 'DELTA EXPLORER' }).getByRole('button', { name: 'LOST', exact: true }).click();
  await workspace(page, 'LOST').getByRole('combobox', { name: 'Reason', exact: true }).selectOption({ label: 'SUPPLIER LATE RESPONSE' });
  await workspace(page, 'LOST').getByLabel('Group note', { exact: true }).fill('Vessel changed delivery timing; keep the window in the shared handover.');
  await workspace(page, 'LOST').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close dialog', exact: true })).toHaveCount(0);
  const after = await snapshot(page);
  assert.deepEqual(stats(after), stats(before));
  assert.equal(after.companies.find(item => item.id === 'company-delta-horizon').exposure, before.companies.find(item => item.id === 'company-delta-horizon').exposure);
  assert.equal(after.outcomes.find(item => item.enquiryId === enquiryId).reason, 'SUPPLIER LATE RESPONSE');
  assert.match(after.outcomes.find(item => item.enquiryId === enquiryId).groupNote, /^Vessel changed/);
  await expect(dialog.getByRole('row').filter({ hasText: 'DELTA EXPLORER' })).toContainText('Vessel changed delivery timing');
});

await scenario('Admin reset clears demo edits, preserves the admin session and never navigates', async page => {
  await login(page, 'marco');
  const before = await snapshot(page);
  const originalUrl = page.url();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = workspace(page, 'Settings');
  await settings.getByRole('article').filter({ hasText: 'Singapore: clearer desk handovers' }).getByRole('button', { name: 'Review contribution', exact: true }).click();
  await page.getByLabel('Review note').fill('Accepted for this reset verification, after reviewing the shared handover process.');
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close dialog', exact: true })).toHaveCount(0);
  assert.equal(gold(await snapshot(page)), gold(before) + 1);
  await settings.getByRole('button', { name: 'Reset demo', exact: true }).click();
  const reset = workspace(page, 'Reset demo');
  await reset.locator('input[name="reset-scope"][value="all"]').check();
  await reset.getByRole('checkbox').check();
  await reset.getByRole('button', { name: 'Reset demo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close dialog', exact: true })).toHaveCount(0);
  await expect(settings).not.toBeVisible();
  assert.equal(page.url(), originalUrl);
  assert.deepEqual(resetComparable(await snapshot(page)), resetComparable(before));
  assert.equal(await page.evaluate(() => sessionStorage.getItem('ecosystem.session.v1')), 'marco');
  await expect(page.locator('[data-trader-hud]')).toContainText('SAMPLE ADMINISTRATOR');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.locator('[data-trader-hud]')).toContainText('SAMPLE ADMINISTRATOR');
  assert.equal(page.url(), originalUrl);
  assert.deepEqual(resetComparable(await snapshot(page)), resetComparable(before));
});

await scenario('Reduced motion keeps Destination still and avoids downloading a film', async (page, _context, mediaRequests) => {
  await login(page);
  await expect(page.locator('.marine-world')).toHaveAttribute('data-playback', 'destination');
  await expect(page.locator('.marine-world video')).toHaveCount(0);
  assert.equal(mediaRequests.length, 0);
  await openWorkspace(page, 'Trading', 'Enquiries');
  await closeWorkspace(page);
  assert.equal(mediaRequests.length, 0);
}, { reducedMotion: 'reduce' });

async function checkLayout(page, viewport, fontScale, surface) {
  await page.evaluate(() => document.fonts.ready);
  const metrics = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
    contained: [...document.querySelectorAll('.entry-pass, .launcher-toggle, .trader-hud, .window-content')]
      .filter(element => element.getClientRects().length && !element.closest('[hidden]'))
      .map(element => ({ class: String(element.className), scroll: element.scrollWidth, client: element.clientWidth })),
    offenders: [...document.querySelectorAll('body *')].filter(element => {
      const rect = element.getBoundingClientRect();
      return rect.width && rect.height && rect.right > innerWidth + 1 && !element.closest('.table-wrap, [hidden], [inert]');
    }).slice(0, 6).map(element => ({ tag: element.tagName, class: String(element.className), right: Math.round(element.getBoundingClientRect().right) })),
  }));
  const okay = metrics.scroll <= metrics.client + 1 && metrics.contained.every(element => element.scroll <= element.client + 2);
  layoutChecks.push({ viewport, fontScale, surface, status: okay ? 'passed' : 'failed', ...metrics });
  if (!okay) await screenshot(page, `overflow-${viewport}-${fontScale}-${surface.replaceAll(' ', '-')}`);
}
for (const viewport of [{ width: 1440, height: 1000 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
  await scenario(`${viewport.width}px layout at normal and 200 percent text`, async page => {
    const baseFontSize = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    for (const fontScale of [1, 2]) {
      await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, baseFontSize * fontScale);
      if (fontScale === 2) {
        await page.getByRole('button', { name: 'Personal details', exact: true }).click();
        await workspace(page, 'Personal details').getByRole('button', { name: 'Sign out', exact: true }).click();
      }
      await checkLayout(page, viewport.width, fontScale, 'login');
      await login(page);
      await checkLayout(page, viewport.width, fontScale, 'harbour');
      await screenshot(page, `home-${viewport.width}${fontScale === 2 ? '-200' : ''}`);
      for (const [group, children] of Object.entries(groups)) {
        for (const name of children) {
          const dialog = await openWorkspace(page, group, name);
          if (name === 'Enquiries') await fillNormalEnquiry(dialog);
          await checkLayout(page, viewport.width, fontScale, name);
          if (name === 'Enquiries') await screenshot(page, `enquiry-${viewport.width}${fontScale === 2 ? '-200' : ''}`);
          await closeWorkspace(page);
        }
      }
    }
  }, { viewport, reducedMotion: 'reduce' });
}

await browser.close();
const report = { base: BASE, at: new Date().toISOString(), results, layoutChecks, browserErrors };
const reportName = FILTER ? `immersive-${FILTER.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-report.json` : 'immersive-report.json';
await writeFile(new URL(reportName, OUTPUT), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ scenarios: results, layoutPassed: layoutChecks.filter(item => item.status === 'passed').length, layoutFailed: layoutChecks.filter(item => item.status === 'failed').length, browserErrors }, null, 2));
process.exitCode = results.some(item => item.status === 'failed') || layoutChecks.some(item => item.status === 'failed') || browserErrors.length ? 1 : 0;
