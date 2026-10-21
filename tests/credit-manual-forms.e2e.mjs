import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const BASE = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4193';
const OUT = new URL('../artifacts/credit-manual-forms/', import.meta.url);
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const results = [];
const stateOf = page => page.evaluate(() => JSON.parse(localStorage.getItem('ecosystem.demo.v1')));
async function workspace(page, name) {
  const opened = page.getByRole('dialog', { name, exact: true });
  if (await opened.isVisible()) return opened;
  const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
  const group = nav.getByRole('button', { name: 'Buyers and Credit', exact: true });
  if (await group.getAttribute('aria-expanded') !== 'true') await group.click();
  await nav.getByRole('button', { name, exact: true }).click();
  return page.getByRole('dialog', { name, exact: true });
}
async function actor(page, id) { await page.evaluate(id => sessionStorage.setItem('ecosystem.session.v1', id), id); await page.reload(); }
async function requestForm(page, buyerId) {
  const view = await workspace(page, 'Credit Requests');
  await view.getByRole('combobox', { name: 'Credit request buyer' }).selectOption(buyerId);
  await view.getByRole('button', { name: 'Credit request', exact: true }).click();
  return page.getByRole('dialog', { name: 'Credit request', exact: true });
}
async function decisionForm(page, request) {
  const view = await workspace(page, 'Credit Requests');
  await view.getByRole('textbox', { name: 'Search credit requests' }).fill(request.id);
  await view.getByRole('button', { name: 'Decision', exact: true }).click();
  return page.getByRole('dialog', { name: 'Credit decision', exact: true });
}
try {
  for (const [width, theme] of [[1440, 'light'], [390, 'dark']]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, isMobile: width < 1000, hasTouch: width < 1000, reducedMotion: 'reduce', acceptDownloads: true });
    const errors = [], writes = [];
    await context.route('**/*', route => {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) { writes.push(route.request().url()); return route.abort('blockedbyclient'); }
      return route.continue();
    });
    await context.addInitScript(value => localStorage.setItem('ecosystem.theme.v1', value), theme);
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(BASE);
      await page.getByRole('combobox', { name: 'Demo profile', exact: true }).selectOption('otto');
      await page.getByRole('button', { name: 'ENTER ECOSYSTEM', exact: true }).click();
      const initial = await stateOf(page);
      const cobalt = initial.companies.find(buyer => buyer.id === 'company-harborlight');
      // P1 from a trader other than the person in charge: total means total, never an increment.
      let form = await requestForm(page, cobalt.id);
      await form.getByRole('textbox', { name: 'Vessel', exact: true }).fill('UNSUBMITTED URGENT DRAFT');
      await form.getByRole('textbox', { name: 'IMO', exact: true }).fill('9319466');
      await form.getByLabel('Expiry date', { exact: true }).fill(new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10));
      await form.getByRole('button', { name: 'P1 Total credit limit', exact: true }).click();
      await expect(form.getByRole('textbox', { name: 'Vessel', exact: true })).toHaveCount(0);
      const expectedLimit = cobalt.limit + 123000;
      await form.getByRole('spinbutton', { name: 'Expected total credit limit (USD)', exact: true }).fill(String(expectedLimit));
      await form.getByRole('textbox', { name: 'Reason', exact: true }).fill('Manual P1 total limit verification');
      await expect(form.getByRole('button', { name: 'Submit request', exact: true })).toBeDisabled();
      await expect(form.locator('.credit-form-recipients')).toContainText('SAMPLE TRADER');
      await expect(form.locator('.credit-form-recipients')).toContainText(initial.companies.find(buyer => buyer.id === cobalt.id).office);
      await form.getByRole('checkbox', { name: 'I am not the person in charge. Proceed with this request.', exact: true }).check();
      await form.getByLabel('Request attachments').setInputFiles({ name: 'rejected.html', mimeType: 'text/html', buffer: Buffer.from('<html>no</html>') });
      await expect(form.getByRole('alert')).toContainText('Use PDF');
      await form.getByLabel('Request attachments').setInputFiles({ name: 'working-note.txt', mimeType: 'text/plain', buffer: Buffer.from('SUPPORTING CREDIT DOCUMENT') });
      await expect(form.locator('.credit-attachment')).toContainText('working-note.txt');
      await form.locator('.credit-attachment__preview summary').click();
      await expect(form.locator('.credit-attachment__preview pre')).toHaveText('SUPPORTING CREDIT DOCUMENT');
      const downloaded = page.waitForEvent('download');
      await form.getByRole('link', { name: 'Download working-note.txt', exact: true }).click();
      assert.equal((await downloaded).suggestedFilename(), 'working-note.txt');
      await form.getByRole('button', { name: 'Remove working-note.txt', exact: true }).click();
      await expect(form.locator('.credit-attachment')).toHaveCount(0);
      await form.getByLabel('Request attachments').setInputFiles({ name: 'credit-evidence.txt', mimeType: 'text/plain', buffer: Buffer.from('CONFIRMED CUSTOMER REQUEST') });
      await expect(form.getByRole('button', { name: 'Submit request', exact: true })).toBeEnabled();
      assert.equal(await form.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, 'P1 form fits');
      await page.screenshot({ path: new URL(`p1-${width}-${theme}.png`, OUT).pathname });
      // A browser storage failure must leave the form and attachments intact without creating a request.
      const requestsBeforeQuota = (await stateOf(page)).requests.length;
      await page.evaluate(() => {
        window.originalCreditStorageSetItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (key === 'ecosystem.demo.v1') throw new DOMException('Test quota exceeded', 'QuotaExceededError');
          return window.originalCreditStorageSetItem.call(this, key, value);
        };
      });
      await form.getByRole('button', { name: 'Submit request', exact: true }).click();
      await expect(form).toBeVisible();
      await expect(form.getByRole('alert')).toBeVisible();
      await expect(form.locator('.credit-attachment')).toContainText('credit-evidence.txt');
      assert.equal((await stateOf(page)).requests.length, requestsBeforeQuota);
      await page.evaluate(() => { Storage.prototype.setItem = window.originalCreditStorageSetItem; delete window.originalCreditStorageSetItem; });
      await form.getByRole('button', { name: 'Submit request', exact: true }).click();
      await expect(form).toHaveCount(0);
      assert.equal((await stateOf(page)).requests.length, requestsBeforeQuota + 1, 'One successful retry, no duplicate request');
      const p1 = (await stateOf(page)).requests.find(request => request.reason === 'MANUAL P1 TOTAL LIMIT VERIFICATION');
      assert.ok(p1); assert.equal(p1.workflow, 'p1'); assert.equal(p1.amountBasis, 'total'); assert.equal(p1.nonPicConfirmed, true); assert.equal(p1.attachments.length, 1);
      assert.equal(p1.voyage, undefined); assert.equal(p1.expiresAt, undefined, 'Switching to P1 discards urgent-only payload');
      assert.ok(p1.recipients.some(recipient => recipient.actorId === cobalt.personInChargeId));
      assert.ok((await stateOf(page)).creditNotifications.some(notification => notification.requestId === p1.id));
      await actor(page, 'elena');
      let decision = await decisionForm(page, p1);
      await expect(decision.getByRole('spinbutton', { name: 'Approved total credit limit (USD)', exact: true })).toHaveValue(String(expectedLimit));
      await expect(decision.locator('.credit-attachment')).toContainText('credit-evidence.txt');
      await decision.getByRole('textbox', { name: 'Conditions / Decision remarks', exact: true }).fill('P1 approved at the total requested limit');
      await decision.getByRole('button', { name: 'Approve credit', exact: true }).click();
      await expect(decision).toHaveCount(0);
      assert.equal((await stateOf(page)).companies.find(buyer => buyer.id === cobalt.id).limit, expectedLimit);
      const legacyIncrease = initial.requests.find(request => !request.workflow && request.status === 'pending' && request.type === 'increase');
      if (legacyIncrease) {
        decision = await decisionForm(page, legacyIncrease);
        await expect(decision.getByRole('spinbutton', { name: 'Approved increase (USD)', exact: true })).toHaveValue(String(legacyIncrease.amount));
        await expect(decision).toContainText('Additional credit');
        await decision.getByRole('button', { name: 'Cancel', exact: true }).click();
      }
      // Urgent form linked to a confirmed incoming enquiry: voyage is prefilled and remains editable.
      await actor(page, 'otto');
      await page.getByRole('button', { name: 'Notifications', exact: true }).click();
      const inbox = page.getByRole('region', { name: 'Enquiries', exact: true });
      await inbox.getByRole('button', { name: 'WhatsApp (demo)', exact: true }).click();
      await inbox.getByRole('region', { name: 'Enquiry scenarios' }).getByRole('button', { name: 'Normal enquiry', exact: true }).click();
      const center = page.getByRole('dialog', { name: 'Enquiries', exact: true });
      await center.getByRole('button', { name: 'Confirm', exact: true }).click();
      await center.getByRole('tab', { name: 'Buyers and Credit', exact: true }).click();
      await center.getByRole('button', { name: 'Credit request', exact: true }).click();
      form = page.getByRole('dialog', { name: 'Credit request', exact: true });
      await expect(form.getByRole('button', { name: 'URGENT Additional overage', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(form.getByRole('textbox', { name: 'Vessel', exact: true })).not.toHaveValue('');
      await expect(form.getByRole('textbox', { name: 'IMO', exact: true })).not.toHaveValue('');
      await expect(form.getByRole('textbox', { name: 'ETA', exact: true })).not.toHaveValue('');
      await form.getByRole('textbox', { name: 'Vessel', exact: true }).fill('ASTER AMENDED VOYAGE');
      await form.getByRole('spinbutton', { name: 'Additional overage requested (USD)', exact: true }).fill('90000');
      const expiry = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
      await form.getByLabel('Expiry date', { exact: true }).fill(expiry);
      await form.getByRole('textbox', { name: 'Reason', exact: true }).fill('Manual urgent voyage verification');
      await page.screenshot({ path: new URL(`urgent-${width}-${theme}.png`, OUT).pathname });
      await form.getByRole('button', { name: 'Submit request', exact: true }).click();
      await expect(form).toHaveCount(0);
      const urgent = (await stateOf(page)).requests.find(request => request.reason === 'MANUAL URGENT VOYAGE VERIFICATION');
      assert.ok(urgent.enquiryId); assert.equal(urgent.voyage.vessel, 'ASTER AMENDED VOYAGE'); assert.equal(urgent.amountBasis, 'additional');
      const originalBuyer = (await stateOf(page)).companies.find(buyer => buyer.id === urgent.companyId);
      await actor(page, 'elena');
      decision = await decisionForm(page, urgent);
      await expect(decision.getByLabel('Expiry date', { exact: true })).toHaveValue(expiry);
      await expect(decision).toContainText('ASTER AMENDED VOYAGE');
      await decision.getByRole('textbox', { name: 'Conditions / Decision remarks', exact: true }).fill('Urgent voyage approved until stated expiry');
      await decision.getByRole('button', { name: 'Approve credit', exact: true }).click();
      await expect(decision).toHaveCount(0);
      const buyerAfter = (await stateOf(page)).companies.find(buyer => buyer.id === urgent.companyId);
      assert.equal(buyerAfter.limit, originalBuyer.limit);
      assert.equal(buyerAfter.temporaryCredits.at(-1).amount, 90000);
      // Onboarding identifies both exact and similar legal names and creates a distinct lead.
      await actor(page, 'otto');
      const profiles = await workspace(page, 'Buyer Profiles');
      await profiles.getByRole('button', { name: 'New lead', exact: true }).click();
      const lead = page.getByRole('dialog', { name: 'New lead', exact: true });
      await lead.getByRole('textbox', { name: 'Legal company name', exact: true }).fill(cobalt.name);
      await expect(lead.getByRole('status')).toContainText('An existing buyer / lead uses this name or alias');
      await expect(lead.getByRole('button', { name: 'Create lead & request credit', exact: true })).toBeDisabled();
      await lead.getByRole('textbox', { name: 'Legal company name', exact: true }).fill('Cobalt Maritime Pacific Ltd');
      await expect(lead.getByRole('status')).toContainText('Possible existing buyers / leads');
      await lead.getByRole('textbox', { name: 'Country', exact: true }).fill('Singapore');
      await lead.getByRole('textbox', { name: 'Contact email', exact: true }).fill('Case.Sensitive@example.com');
      await lead.getByRole('textbox', { name: 'Reason', exact: true }).fill('Different legal entity for Pacific trade');
      await expect(lead.getByRole('button', { name: 'Create lead & request credit', exact: true })).toBeDisabled();
      await lead.getByRole('checkbox', { name: 'This is a separate legal entity.', exact: true }).check();
      await lead.getByLabel('Request attachments').setInputFiles({ name: 'registration.txt', mimeType: 'text/plain', buffer: Buffer.from('COMPANY REGISTRATION') });
      await expect(lead.getByRole('button', { name: 'Create lead & request credit', exact: true })).toBeEnabled();
      await page.screenshot({ path: new URL(`lead-${width}-${theme}.png`, OUT).pathname });
      await lead.getByRole('button', { name: 'Create lead & request credit', exact: true }).click();
      await expect(lead).toHaveCount(0);
      const saved = await stateOf(page);
      const newLead = saved.companies.find(buyer => buyer.name === 'COBALT MARITIME PACIFIC LTD');
      assert.ok(newLead); assert.equal(newLead.lifecycle, 'lead'); assert.equal(newLead.status, 'pending'); assert.equal(newLead.limit, 0); assert.equal(newLead.email, 'Case.Sensitive@example.com');
      assert.equal(saved.companies.length, initial.companies.length + 1);
      assert.equal(saved.requests.find(request => request.companyId === newLead.id).workflow, 'p1');
      assert.equal(saved.requests.find(request => request.companyId === newLead.id).attachments.length, 1);
      assert.equal(saved.companies.find(buyer => buyer.id === cobalt.id).name, cobalt.name);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'No page overflow');
      assert.deepEqual(errors, []); assert.deepEqual(writes, []);
      results.push({ width, theme, passed: true, flows: ['P1 total', 'non-PIC', 'files', 'urgent voyage', 'lead duplicates'] });
      console.log(`PASS ${width}px ${theme}: P1 total, non-PIC, attachments, URGENT voyage and lead duplicates`);
    } catch (error) {
      await page.screenshot({ path: new URL(`failure-${width}-${theme}.png`, OUT).pathname });
      throw error;
    } finally { await context.close(); }
  }
} finally {
  await writeFile(new URL('results.json', OUT), JSON.stringify(results, null, 2));
  await browser.close();
}
