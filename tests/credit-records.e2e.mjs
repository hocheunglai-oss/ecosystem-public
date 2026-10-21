import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
const BASE = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4193';
const OUT = new URL('../artifacts/credit-records/', import.meta.url);
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const results = [];
const stateOf = page => page.evaluate(() => JSON.parse(localStorage.getItem('ecosystem.demo.v1')));
const dollars = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
async function workspace(page, name) {
  const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
  const credit = nav.getByRole('button', { name: 'Buyers and Credit', exact: true });
  if (await credit.getAttribute('aria-expanded') !== 'true') await credit.click();
  await expect(nav.getByRole('button', { name: 'Credit History', exact: true, includeHidden: true })).toHaveCount(0);
  await nav.getByRole('button', { name, exact: true }).click();
  return page.getByRole('dialog', { name, exact: true });
}
async function actor(page, id) { await page.evaluate(id => sessionStorage.setItem('ecosystem.session.v1', id), id); await page.reload(); }
async function close(page) { await page.getByRole('button', { name: 'Close workspace', exact: true }).click(); }
try {
  for (const [width, theme] of [[1440, 'light'], [1280, 'dark'], [390, 'light'], [850, 'dark']].filter(([width]) => !process.env.WIDTH || width === Number(process.env.WIDTH))) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, isMobile: width < 1000, hasTouch: width < 1000, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    const backendWrites = [];
    await context.route('**/*', route => {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) {
        backendWrites.push(`${route.request().method()} ${route.request().url()}`);
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    page.on('pageerror', error => errors.push(error.message));
    try {
      await context.addInitScript(theme => localStorage.setItem('ecosystem.theme.v1', theme), theme);
      await page.goto(BASE);
      await page.getByRole('combobox', { name: 'Demo profile', exact: true }).selectOption('otto');
      await page.getByRole('button', { name: 'ENTER ECOSYSTEM', exact: true }).click();
      const initial = await stateOf(page);
      const buyer = initial.companies.find(item => item.id === 'company-meridian');
      let dialog = await workspace(page, 'Credit Requests');
      await expect(dialog.getByRole('button', { name: 'Decision', exact: true })).toHaveCount(0);
      await dialog.getByRole('combobox', { name: 'Credit request buyer' }).selectOption(buyer.id);
      await dialog.getByRole('button', { name: 'Credit request', exact: true }).click();
      const form = page.getByRole('dialog', { name: 'Credit request', exact: true });
      await expect(form.getByRole('button', { name: 'URGENT Additional overage', exact: true })).toHaveAttribute('aria-pressed', 'true');
      const expiryDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
      await form.getByRole('spinbutton', { name: 'Additional overage requested (USD)', exact: true }).fill('450000');
      await form.getByRole('textbox', { name: 'Expiry date', exact: true }).fill(expiryDate);
      await form.getByRole('textbox', { name: 'Reason', exact: true }).fill('Credit browser verification temporary facility');
      await form.getByRole('textbox', { name: 'Vessel', exact: true }).fill('CREDIT TEST VESSEL');
      await form.getByRole('textbox', { name: 'IMO', exact: true }).fill('9876543');
      await form.getByRole('combobox', { name: 'Port', exact: true }).fill(initial.ports[0].name);
      await form.getByRole('textbox', { name: 'ETA', exact: true }).fill(expiryDate);
      const nonPicConfirmation = form.getByRole('checkbox', { name: 'I am not the person in charge. Proceed with this request.', exact: true });
      if (await nonPicConfirmation.count()) await nonPicConfirmation.check();
      await form.getByRole('button', { name: 'Submit request', exact: true }).click();
      await expect(form).toHaveCount(0);
      const requested = (await stateOf(page)).requests.find(item => item.reason === 'CREDIT BROWSER VERIFICATION TEMPORARY FACILITY');
      assert.ok(requested);
      assert.equal(requested.priority, 'urgent');
      assert.equal(requested.workflow, 'urgent');
      assert.equal(requested.amountBasis, 'additional');
      assert.equal(requested.voyage.vessel, 'CREDIT TEST VESSEL');
      assert.equal(requested.voyage.imo, '9876543');
      assert.ok(requested.recipients.some(recipient => recipient.actorId === 'elena'));
      await dialog.getByRole('textbox', { name: 'Search credit requests' }).fill(requested.id);
      await expect(dialog.locator('tbody tr:visible')).toHaveCount(1);
      await dialog.getByRole('button', { name: /Request .* details/ }).click();
      await expect(dialog.locator('.credit-record-detail:visible')).toContainText('CREDIT BROWSER VERIFICATION TEMPORARY FACILITY');
      await actor(page, 'elena');
      dialog = await workspace(page, 'Credit Requests');
      await dialog.getByRole('textbox', { name: 'Search credit requests' }).fill(requested.id);
      await dialog.getByRole('button', { name: 'Acknowledge', exact: true }).click();
      await expect(dialog.locator('.credit-stage')).toHaveText('Acknowledged');
      const acknowledged = (await stateOf(page)).requests.find(item => item.id === requested.id);
      assert.equal(acknowledged.acknowledgedBy, 'elena');
      await dialog.getByRole('button', { name: 'Decision', exact: true }).click();
      const decision = page.getByRole('dialog', { name: 'Credit decision', exact: true });
      await expect(decision.getByRole('textbox', { name: 'Expiry date', exact: true })).toHaveValue(expiryDate);
      await decision.getByRole('textbox', { name: 'Conditions / Decision remarks', exact: true }).fill('Approved for this demonstration until expiry');
      await decision.getByRole('button', { name: 'Approve credit', exact: true }).click();
      await expect(decision).toHaveCount(0);
      const saved = await stateOf(page);
      const approved = saved.requests.find(item => item.id === requested.id);
      const approvedBuyer = saved.companies.find(item => item.id === buyer.id);
      assert.equal(approved.status, 'approved');
      assert.ok(approved.closedAt && approved.decision.expiresAt);
      assert.equal(approvedBuyer.limit, buyer.limit);
      assert.equal(approvedBuyer.temporaryCredits.at(-1).requestId, requested.id);
      assert.equal(saved.creditHistory.filter(entry => entry.requestId === requested.id).length, 1);
      await dialog.getByRole('button', { name: /Request .* details/ }).click();
      await expect(dialog.locator('.credit-record-detail:visible')).toContainText('APPROVED FOR THIS DEMONSTRATION UNTIL EXPIRY');
      await expect(dialog.getByRole('button', { name: 'Decision', exact: true })).toHaveCount(0);
      await page.screenshot({ path: new URL(`request-${width}-${theme}.png`, OUT).pathname });
      await dialog.locator('tbody:visible .credit-buyer-link').click();
      dialog = page.getByRole('dialog', { name: 'Buyer Profiles', exact: true });
      await expect(dialog.locator('.buyer-profile__title h2')).toHaveText(buyer.name);
      await dialog.getByRole('tab', { name: 'Overview', exact: true }).click();
      await dialog.getByRole('region', { name: 'Credit History', exact: true }).getByRole('button', { name: 'All history', exact: true }).click();
      await dialog.getByRole('textbox', { name: 'Search credit history' }).fill(requested.id);
      await expect(dialog.getByRole('textbox', { name: 'Search credit history' })).toHaveValue(requested.id.toUpperCase());
      await expect(dialog.locator('tbody tr:visible')).toHaveCount(1);
      await expect(dialog.locator('tbody:visible')).toContainText('One-off overage');
      await expect(dialog.locator('tbody:visible')).toContainText('$450,000');
      await expect(dialog.locator('tbody:visible')).toContainText('SAMPLE CREDIT REVIEWER');
      await page.screenshot({ path: new URL(`history-${width}-${theme}.png`, OUT).pathname });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'No page overflow');
      assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, 'Table scroll is contained');
      await actor(page, 'otto');
      dialog = await workspace(page, 'Credit Requests');
      await dialog.getByRole('textbox', { name: 'Search credit requests' }).fill(requested.id);
      await expect(dialog.getByRole('button', { name: 'Decision', exact: true })).toHaveCount(0);
      await dialog.locator('tbody:visible .credit-buyer-link').click();
      const profile = page.getByRole('dialog', { name: 'Buyer Profiles', exact: true });
      await expect(profile.locator('.buyer-profile__available > dd')).toHaveText(dollars(buyer.limit - buyer.exposure + 450000));
      await expect(profile.locator('.buyer-profile__title h2')).toHaveText(buyer.name);
      // Advance only this isolated browser's clock beyond the approved expiry.
      await page.clock.install({ time: new Date(approved.decision.expiresAt).getTime() + 1000 });
      await page.reload();
      dialog = await workspace(page, 'Credit Requests');
      await dialog.getByRole('textbox', { name: 'Search credit requests' }).fill(requested.id);
      await dialog.locator('tbody:visible .credit-buyer-link').click();
      await expect(page.getByRole('dialog', { name: 'Buyer Profiles', exact: true }).locator('.buyer-profile__available > dd')).toHaveText(dollars(buyer.limit - buyer.exposure));
      await close(page);
      // Large demo record set: prove pagination limits DOM rows and search resets page.
      await page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('ecosystem.demo.v1'));
        const sample = state.requests[0];
        for (let index = 0; index < 36; index++) state.requests.push({ ...sample, id: `PAGINATION-${index}`, reason: `PAGING RECORD ${index}` });
        localStorage.setItem('ecosystem.demo.v1', JSON.stringify(state));
      });
      await page.reload();
      dialog = await workspace(page, 'Credit Requests');
      await expect(dialog.locator('tbody tr:visible')).toHaveCount(15);
      await dialog.getByRole('button', { name: 'Next page', exact: true }).click();
      await expect(dialog.locator('tbody tr:visible')).toHaveCount(15);
      await dialog.getByRole('textbox', { name: 'Search credit requests' }).fill('PAGINATION-35');
      await expect(dialog.locator('tbody tr:visible')).toHaveCount(1);
      await expect(dialog.getByRole('button', { name: 'Previous page', exact: true })).toBeDisabled();
      assert.deepEqual(errors, []);
      assert.deepEqual(backendWrites, [], 'Credit demo flows must not write to a backend');
      results.push({ width, theme, passed: true });
      console.log(`PASS ${width}px ${theme}: trader request, credit acknowledgement/decision, history, expiry, contained tables and pagination`);
    } catch (error) { await page.screenshot({ path: new URL(`failure-${width}-${theme}.png`, OUT).pathname }); console.log(await page.locator('.credit-record-panel:visible').innerText().catch(() => '')); throw error; } finally { await context.close(); }
  }
} finally { await browser.close(); await writeFile(new URL('results.json', OUT), JSON.stringify(results, null, 2)); }
