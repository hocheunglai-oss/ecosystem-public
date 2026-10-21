import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const BASE = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4173';
const OUTPUT = new URL('../artifacts/', import.meta.url);
await mkdir(OUTPUT, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const results = [];
const browserErrors = [];
const layoutChecks = [];
const navItems = ['Overview', 'Send Enquiry', 'Company Database', 'Port Info', 'Credit Center', 'Fixture & Lost Record', 'Audit', 'Management'];
const snapshot = page => page.evaluate(() => JSON.parse(localStorage.getItem('ecosystem.demo.v1')));
const stats = state => {
  const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const fixtures = state.outcomes.filter(item => item.kind === 'fixture' && item.owner === 'otto' && item.bookedAt.startsWith(month));
  return { volume: fixtures.reduce((sum, item) => sum + item.quantity, 0), profit: fixtures.reduce((sum, item) => sum + item.quantity * item.margin, 0) };
};
async function nav(page, name) {
  const link = page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name, exact: true });
  await link.click();
  await expect(link).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('main h1')).toBeVisible();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function role(page, id) { await page.getByLabel('Demo role', { exact: true }).selectOption(id); }
async function close(page) { await page.getByRole('button', { name: 'Close dialog', exact: true }).click(); }
async function shot(page, name) { await page.screenshot({ path: new URL(`qa-${name}.png`, OUTPUT).pathname, fullPage: true, animations: 'disabled' }); }
async function scenario(name, callback, viewport = { width: 1440, height: 1000 }) {
  const context = await browser.newContext({ viewport, locale: 'en-GB' });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on('pageerror', error => errors.push(`Page: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') errors.push(`Console: ${message.text()}`); });
  try {
    // Streaming background video is independent of app readiness; networkidle may never arrive.
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1')).toBeVisible();
    await callback(page);
    results.push({ name, status: 'passed' });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, status: 'failed', error: error.message });
    console.log(`FAIL ${name}: ${error.message}`);
    await shot(page, `failure-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`).catch(() => {});
  } finally {
    browserErrors.push(...errors.map(error => ({ scenario: name, error })));
    await context.close();
  }
}

await scenario('Normal enquiry to booked fixture', async page => {
  const before = await snapshot(page);
  await shot(page, 'desktop-overview');
  await nav(page, 'Send Enquiry');
  await page.getByLabel('Load demo scenario').selectOption('normal');
  await expect(page.getByLabel('Vessel name', { exact: true })).toHaveValue('PACIFIC HORIZON');
  await expect(page.getByLabel('Buyer legal entity', { exact: false })).toHaveValue('company-meridian');
  await page.getByRole('checkbox', { name: 'Add BIMCO TERMS' }).check();
  await expect(page.locator('.enquiry-preview')).toContainText('BIMCO TERMS');
  await page.getByRole('checkbox', { name: 'I have checked the buyer, port, quantity and original enquiry.' }).check();
  await shot(page, 'desktop-enquiry');
  await page.getByRole('button', { name: 'Send demo enquiry', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Record fixture', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Record fixture', exact: true }).click();
  await page.getByLabel('Fixture notes (optional)').fill('Supplier confirmed. Demonstration booking.');
  await page.getByRole('button', { name: 'Book fixture', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const after = await snapshot(page);
  assert.equal(stats(after).volume, stats(before).volume + 450);
  assert.equal(stats(after).profit, stats(before).profit + 450 * 12);
  assert.equal(after.companies.find(item => item.id === 'company-meridian').exposure, before.companies.find(item => item.id === 'company-meridian').exposure + 450 * 620);
  const enquiry = after.enquiries.find(item => item.vessel === 'PACIFIC HORIZON');
  assert.equal(enquiry.status, 'fixture');
  assert.match(enquiry.formattedText, /BIMCO TERMS/);
  await nav(page, 'Overview');
  await expect(page.locator('.journey-numbers')).toContainText('5,650');
  await expect(page.locator('.journey-numbers')).toContainText('$94,600');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('main h1')).toBeVisible();
  assert.deepEqual(stats(await snapshot(page)), stats(after));
});

await scenario('Credit approval unlocks fixture and persists decision', async page => {
  await nav(page, 'Fixture & Lost Record');
  const row = page.getByRole('row').filter({ hasText: 'BLUEWATER SKY' });
  await row.getByRole('button', { name: 'Book fixture', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Book fixture', exact: true })).toBeDisabled();
  await expect(page.getByRole('dialog')).toContainText('$185,000 additional credit required');
  await close(page);
  await role(page, 'elena');
  await nav(page, 'Credit Center');
  await page.getByRole('button', { name: 'Review request', exact: true }).click();
  await page.getByLabel('Approved increase (USD)').fill('350000');
  await page.getByLabel('Decision rationale and conditions').fill('Approved for demonstrated vessel commitment. Maintain 30-day terms and monitor overdue balance.');
  await page.getByRole('button', { name: 'Approve credit', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Decision history', exact: true }).click();
  await expect(page.locator('.decision-record')).toContainText('Elena Rossi');
  await expect(page.locator('.decision-record')).toContainText('Maintain 30-day terms');
  await shot(page, 'desktop-credit-decision');
  await role(page, 'otto');
  await nav(page, 'Fixture & Lost Record');
  await page.getByRole('row').filter({ hasText: 'BLUEWATER SKY' }).getByRole('button', { name: 'Book fixture', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Book fixture', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await nav(page, 'Audit');
  await expect(page.locator('table')).toContainText('Credit approved');
  await expect(page.locator('table')).toContainText('Maintain 30-day terms');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('main h1')).toBeVisible();
  await expect(page.locator('table')).toContainText('Credit approved');
  const saved = await snapshot(page);
  assert.equal(saved.requests.find(item => item.id === 'credit-001').decision.by, 'elena');
  assert.equal(saved.companies.find(item => item.id === 'company-bluewater').limit, 1250000);
  assert.equal(saved.companies.find(item => item.id === 'company-bluewater').exposure, 1085000);
  assert.equal(saved.enquiries.find(item => item.id === 'enquiry-002').status, 'fixture');
});

await scenario('Reviewed port contribution awards black Drops', async page => {
  const before = await snapshot(page);
  const total = state => state.drops.filter(item => item.owner === 'otto').reduce((sum, item) => sum + item.amount, 0);
  const title = 'Demo handover checklist for Singapore';
  const body = 'Attach the latest buyer-confirmed delivery window and the named contact to the desk handover.';
  await nav(page, 'Port Info');
  await page.getByRole('button', { name: 'Suggest an update', exact: true }).click();
  await page.getByLabel('What changed or what did you learn?').fill(title);
  await page.getByLabel('Details', { exact: true }).fill(body);
  await page.getByLabel('Source or reference (optional)').fill('Fictional desk handover review');
  await page.getByRole('button', { name: 'Submit for review', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  assert.equal(total(await snapshot(page)), total(before));
  await role(page, 'marco');
  await nav(page, 'Management');
  await page.getByRole('article').filter({ hasText: title }).getByRole('button', { name: 'Review contribution' }).click();
  await page.getByLabel('Review note').fill('Useful shared process. Accepted for publication in the demo knowledge record.');
  await page.getByRole('button', { name: 'Publish & award Drops', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await nav(page, 'Port Info');
  await expect(page.locator('#port-detail')).toContainText(body);
  await expect(page.locator('#port-detail')).toContainText(title);
  const after = await snapshot(page);
  assert.equal(total(after), total(before) + 20);
  assert.equal(after.contributions.find(item => item.title === title).status, 'approved');
  await role(page, 'otto');
  await nav(page, 'Overview');
  await expect(page.locator('[data-drops-counter]')).toContainText('90');
  const dropColour = await page.locator('[data-drops-counter] .oil-drop').evaluate(element => getComputedStyle(element).color);
  assert.match(dropColour, /^rgb\(/);
  const rgb = dropColour.match(/\d+/g).map(Number);
  assert.ok(rgb.every(channel => channel < 70), `Expected black oil drop, got ${dropColour}`);
});

await scenario('New customer approval appears in company directory', async page => {
  await nav(page, 'Company Database');
  await page.getByRole('button', { name: 'New customer', exact: true }).click();
  await page.getByLabel('Legal company name', { exact: true }).fill('Aurora Maritime Holdings');
  await page.getByLabel('Country', { exact: true }).fill('Singapore');
  await page.getByLabel('City', { exact: true }).fill('Singapore');
  await page.getByLabel('Contact name', { exact: true }).fill('Demo Purchasing Team');
  await page.getByLabel('Contact email', { exact: true }).fill('purchasing@aurora.example');
  await page.getByLabel('Initial credit limit requested (USD)').fill('500000');
  await page.getByLabel('Business case and supporting context').fill('Fictional new customer with anticipated regional liftings. Request initial approval.');
  await page.getByRole('button', { name: 'Create & request credit', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByLabel('Search companies, aliases or countries').fill('Aurora');
  await expect(page.locator('#company-detail')).toContainText('Pending');
  await role(page, 'elena');
  await nav(page, 'Credit Center');
  await page.getByRole('article').filter({ hasText: 'Aurora Maritime Holdings' }).getByRole('button', { name: 'Review request', exact: true }).click();
  await page.getByLabel('Decision rationale and conditions').fill('Fictional onboarding checked and approved with an initial USD 500,000 limit.');
  await page.getByRole('button', { name: 'Approve credit', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await nav(page, 'Company Database');
  await page.getByLabel('Search companies, aliases or countries').fill('Aurora');
  await expect(page.locator('#company-detail')).toContainText('Approved');
  await expect(page.locator('#company-detail')).toContainText('$500,000');
  await expect(page.locator('#company-detail')).toContainText('30 days');
  const saved = await snapshot(page);
  assert.equal(saved.companies.find(item => item.name === 'Aurora Maritime Holdings').status, 'approved');
});

await scenario('Lost enquiry retains reason without increasing commercial totals', async page => {
  const before = await snapshot(page);
  await nav(page, 'Fixture & Lost Record');
  await page.getByRole('row').filter({ hasText: 'DELTA EXPLORER' }).getByRole('button', { name: 'Record lost', exact: true }).click();
  await page.getByLabel('Primary lost reason').selectOption('Schedule');
  await page.getByLabel('What can we learn?').fill('Vessel changed its delivery window; preserve the timing context for the next enquiry.');
  await page.getByRole('button', { name: 'Save lost record', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const after = await snapshot(page);
  assert.deepEqual(stats(after), stats(before));
  assert.equal(after.companies.find(item => item.id === 'company-delta-horizon').exposure, before.companies.find(item => item.id === 'company-delta-horizon').exposure);
  assert.match(after.outcomes.find(item => item.enquiryId === 'enquiry-006').reason, /^Schedule — Vessel changed/);
  await expect(page.getByRole('row').filter({ hasText: 'DELTA EXPLORER' })).toContainText('Vessel changed its delivery window');
});

async function checkLayout(page, size, fontScale = 1) {
  await role(page, 'otto');
  if (fontScale !== 1) await page.evaluate(scale => { document.documentElement.style.fontSize = `${15 * scale}px`; }, fontScale);
  for (const name of navItems) {
    if (name === 'Management') await role(page, 'marco');
    await nav(page, name);
    if (name === 'Send Enquiry') await page.getByLabel('Load demo scenario').selectOption('normal');
    await page.evaluate(() => document.fonts.ready);
    const dimensions = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
      offenders: [...document.querySelectorAll('main *')].filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.right > document.documentElement.clientWidth + 1 && rect.width > 0 && !element.closest('.table-wrap');
      }).slice(0, 8).map(element => ({ tag: element.tagName, class: element.className, right: Math.round(element.getBoundingClientRect().right), text: element.textContent?.slice(0, 70) })),
    }));
    const okay = dimensions.scroll <= dimensions.client + 1;
    layoutChecks.push({ viewport: size, fontScale, page: name, status: okay ? 'passed' : 'failed', ...dimensions });
    if (!okay) {
      console.log(`LAYOUT FAIL ${size} ${fontScale}x ${name}: ${dimensions.scroll}/${dimensions.client}`);
      await shot(page, `overflow-${size}-${fontScale}x-${name.replaceAll(' ', '-').replaceAll('&', 'and').toLowerCase()}`);
    }
    if (size === 'mobile' && name === 'Overview' && fontScale === 1) await shot(page, 'mobile-overview');
  }
}
await scenario('Desktop navigation and 200 percent text size', async page => {
  await checkLayout(page, 'desktop');
  await checkLayout(page, 'desktop', 2);
});
await scenario('Mobile navigation and 200 percent text size', async page => {
  await checkLayout(page, 'mobile');
  await checkLayout(page, 'mobile', 2);
}, { width: 390, height: 844 });

await browser.close();
const report = { base: BASE, at: new Date().toISOString(), results, layoutChecks, browserErrors };
await writeFile(new URL('qa-report.json', OUTPUT), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ scenarios: results, layoutPassed: layoutChecks.filter(item => item.status === 'passed').length, layoutFailed: layoutChecks.filter(item => item.status === 'failed').length, browserErrors }, null, 2));
process.exitCode = results.some(item => item.status === 'failed') || layoutChecks.some(item => item.status === 'failed') || browserErrors.length ? 1 : 0;
