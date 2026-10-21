import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

// Dedicated headless contexts: never attach to a personal browser or write to business services.
const BASE = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4189';
const OUT = new URL('../artifacts/buyer-credit-redesign/', import.meta.url);
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const stateOf = page => page.evaluate(() => JSON.parse(localStorage.getItem('ecosystem.demo.v1')));
const results = [];
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exact = value => new RegExp(`^${escape(value)}$`, 'i');
const fact = (scope, label) => scope.locator('dt').filter({ hasText: exact(label) }).locator('..').locator(':scope > dd');
async function workspace(page, category, name) {
  const navigation = page.getByRole('navigation', { name: 'Workspace navigation' });
  const section = button(navigation, category);
  if (await section.getAttribute('aria-expanded') !== 'true') await section.click();
  await button(navigation, name).click();
  const dialog = page.getByRole('dialog', { name, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function close(page) { await button(page, 'Close workspace').click(); }
async function selectBuyer(dialog, buyer) {
  const selector = dialog.getByRole('combobox', { name: 'Buyer', exact: true });
  if (await selector.count()) {
    await selector.fill(buyer.customerId || buyer.name);
    await dialog.getByRole('option', { name: new RegExp(escape(buyer.name), 'i') }).click();
  } else {
    await dialog.getByRole('textbox', { name: 'Search buyer profiles' }).fill(buyer.customerId || buyer.name);
    await button(dialog, exact(buyer.name)).click();
  }
  return dialog.locator('.buyer-profile:visible');
}
async function switchActor(page, actor) {
  await page.evaluate(id => sessionStorage.setItem('ecosystem.session.v1', id), actor);
  await page.reload();
  return workspace(page, 'Buyers and Credit', 'Buyer Profiles');
}
async function capture(page, name) {
  await page.screenshot({ path: new URL(`${name}.png`, OUT).pathname, animations: 'disabled' });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'The page fits the viewport');
}

try {
  for (const [width, height, theme] of [[1440, 1000, 'light'], [1280, 900, 'dark'], [390, 844, 'light'], [850, 1000, 'dark']].filter(([width]) => !process.env.WIDTH || width === Number(process.env.WIDTH))) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 900, reducedMotion: 'reduce' });
    await context.addInitScript(mode => localStorage.setItem('ecosystem.theme.v1', mode), theme);
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    const errors = [], writes = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) writes.push(request.url()); });
    try {
      await page.goto(BASE);
      await page.getByLabel('Demo profile', { exact: true }).selectOption('otto');
      await button(page, 'ENTER ECOSYSTEM').click();
      let state = await stateOf(page);
      const aster = state.companies.find(buyer => buyer.id === 'company-meridian');
      const beacon = state.companies.find(buyer => buyer.id === 'company-bluewater');
      assert.match(aster.name, /ASTER OCEAN/i);
      assert.ok(aster.customerId && aster.personInChargeId && aster.office);
      let dialog = await workspace(page, 'Buyers and Credit', 'Buyer Profiles');
      let search = dialog.getByRole('textbox', { name: 'Search buyer profiles' });
      const rows = dialog.locator('.buyer-directory-table tbody tr');
      await search.fill(aster.customerId);
      await expect(rows).toHaveCount(1);
      await expect(rows).toContainText(aster.name);
      await search.fill('SAMPLE TRADER');
      const owned = state.companies.filter(buyer => buyer.personInChargeId === 'otto');
      await expect(rows).toHaveCount(owned.length);
      await search.fill(aster.office);
      await expect(rows).toHaveCount(state.companies.filter(buyer => buyer.office === aster.office).length);
      await search.fill('');
      await button(dialog, 'My portfolio').click();
      await expect(rows).toHaveCount(owned.length);
      await button(dialog, 'My portfolio').click();
      await dialog.getByRole('combobox', { name: 'Buyer office' }).selectOption(aster.office);
      await expect(rows).toHaveCount(state.companies.filter(buyer => buyer.office === aster.office).length);
      await dialog.getByRole('combobox', { name: 'Buyer office' }).selectOption('');
      await capture(page, `directory-${width}-${theme}`);

      let profile = await selectBuyer(dialog, aster);
      await expect(profile.getByRole('heading', { name: exact(aster.name) })).toBeVisible();
      const identity = profile.locator('.buyer-profile__identity');
      await expect(fact(identity, 'Customer ID')).toHaveText(aster.customerId);
      await expect(fact(identity, 'Person in charge')).toHaveCount(0);
      await expect(fact(identity, 'Office')).toHaveCount(0);
      for (const title of ['Credit Information', 'Performance', 'Recent margin and volume trends', 'Credit History']) await expect(profile.getByRole('heading', { name: title, exact: true })).toBeVisible();
      await expect(profile.getByRole('combobox', { name: 'Performance period' })).toHaveValue('12m');
      await expect(profile.locator('.buyer-profile__tabs [role=tab]')).toHaveCount(6);
      await expect(profile.locator('textarea')).toHaveCount(0);
      const headerStyles = await profile.locator('.buyer-profile__section-header:visible').evaluateAll(elements => elements.map(element => ({ height: element.getBoundingClientRect().height, background: getComputedStyle(element).backgroundColor })));
      assert.ok(headerStyles.every(item => item.background !== 'rgba(0, 0, 0, 0)'), 'Section headings have a coloured strip');
      if (width >= 900) assert.ok(headerStyles.every(item => item.height <= 36), `Desktop headings are compact: ${JSON.stringify(headerStyles)}`);
      assert.equal(await profile.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, 'Profile has no accidental horizontal overflow');
      await capture(page, `overview-${width}-${theme}`);
      await button(profile, exact(aster.accountGroupName)).click();
      await expect(profile.getByRole('heading', { name: exact(aster.accountGroupName) })).toBeVisible();
      await button(profile, exact(aster.accountGroupName)).click();

      await profile.getByRole('tab', { name: 'Stem Records', exact: true }).click();
      await expect(profile.getByRole('textbox', { name: 'Search stem records' })).toBeVisible();
      const stemRows = profile.locator('tbody tr');
      assert.ok(await stemRows.count() >= 10);
      const firstStem = await stemRows.first().locator('td').first().locator('strong').innerText();
      await profile.getByRole('textbox', { name: 'Search stem records' }).fill(firstStem);
      await expect(stemRows).toHaveCount(1);
      await stemRows.first().getByRole('button').click();
      await expect(profile.locator('.buyer-expanded-row')).toBeVisible();
      await expect(profile.locator('.buyer-expanded-row')).toContainText('Trader');
      await capture(page, `stems-${width}-${theme}`);

      await profile.getByRole('tab', { name: 'Credit Requests', exact: true }).click();
      await expect(profile.getByRole('textbox', { name: 'Search credit requests' })).toBeVisible();
      await expect(profile.locator('.credit-record-table tbody tr')).not.toHaveCount(0);
      await profile.getByRole('button', { name: /Request .* details/ }).first().click();
      await expect(profile.locator('.credit-record-detail')).toContainText('Request reason');
      await expect(profile.locator('.credit-record-detail')).toContainText('Decision');
      await capture(page, `requests-${width}-${theme}`);
      await profile.getByRole('tab', { name: 'Overview', exact: true }).click();
      await button(profile.getByRole('region', { name: 'Credit History', exact: true }), 'All history').click();
      await profile.getByRole('combobox', { name: 'Credit history type' }).selectOption('limit');
      await expect(profile.getByRole('columnheader', { name: 'Effective date', exact: true })).toBeVisible();
      await expect(profile.getByRole('columnheader', { name: 'Recorded by / date', exact: true })).toBeVisible();
      await expect(profile.locator('.credit-record-table tbody')).toContainText(/CREDIT LIMIT/i);
      await capture(page, `history-${width}-${theme}`);
      await profile.getByRole('tab', { name: 'Company Information', exact: true }).click();
      await expect(profile.getByRole('heading', { name: 'In Charge History', exact: true })).toBeVisible();
      await expect(fact(profile, 'Standard name')).toHaveText(aster.name);
      const file = profile.locator('.buyer-file-list a').first();
      await expect(file).toBeVisible();
      const popup = await Promise.all([context.waitForEvent('page'), file.click()]).then(([tab]) => tab);
      await popup.waitForLoadState('domcontentloaded');
      await expect(popup.locator('body')).toContainText(/ASTER/i);
      await popup.close();
      await capture(page, `company-${width}-${theme}`);

      await profile.getByRole('tab', { name: 'Remarks', exact: true }).click();
      await button(profile, 'Add Private Remark').click();
      await profile.getByRole('textbox', { name: 'Private Remarks', exact: true }).fill('PRIVATE FOLLOW-UP FOR ASTER ONLY.');
      await button(profile.getByRole('region', { name: 'Private Remarks', exact: true }), 'Save').click();
      await expect(profile.getByRole('region', { name: 'Private Remarks', exact: true })).toContainText('PRIVATE FOLLOW-UP FOR ASTER ONLY.');
      const before = await stateOf(page);
      await profile.getByRole('button', { name: /Update Group Remarks/ }).click();
      await profile.getByRole('textbox', { name: 'Group Remarks', exact: true }).fill('ASTER GROUP PREFERS ONE CONSOLIDATED DELIVERY UPDATE BEFORE EACH LIFTING.');
      await button(profile.getByRole('region', { name: 'Group Remarks', exact: true }), 'Update').click();
      state = await stateOf(page);
      const contribution = state.contributions.find(item => !before.contributions.some(existing => existing.id === item.id));
      assert.ok(contribution);
      assert.equal(contribution.author, 'otto');
      assert.equal(contribution.status, 'approved');
      assert.equal(contribution.targetType, 'buyer-group');
      assert.equal(state.contributions.filter(item => item.status === 'approved' && item.author === 'otto').length, before.contributions.filter(item => item.status === 'approved' && item.author === 'otto').length + 1, 'One new contribution earns one Gold');
      await expect(profile.locator('textarea')).toHaveCount(0);
      await capture(page, `remarks-${width}-${theme}`);
      profile = await selectBuyer(dialog, beacon);
      await profile.getByRole('tab', { name: 'Remarks', exact: true }).click();
      await expect(profile.getByRole('region', { name: 'Private Remarks', exact: true })).not.toContainText('PRIVATE FOLLOW-UP FOR ASTER ONLY.');
      await profile.getByRole('tab', { name: 'Overview', exact: true }).click();
      await expect(fact(profile.locator('.buyer-credit-facts'), 'PCG')).toHaveText(/No/i);
      await expect(profile.locator('.buyer-profile__available')).toHaveAttribute('data-negative', 'true');
      await expect(profile.locator('.buyer-credit-alert')).toContainText(/OVERDUE/i);

      dialog = await switchActor(page, 'filippo');
      profile = await selectBuyer(dialog, aster);
      await profile.getByRole('tab', { name: 'Remarks', exact: true }).click();
      await expect(profile.getByRole('region', { name: 'Private Remarks', exact: true })).not.toContainText('PRIVATE FOLLOW-UP FOR ASTER ONLY.');
      await expect(profile.getByRole('region', { name: 'Group Remarks', exact: true })).toContainText(contribution.body);
      dialog = await switchActor(page, 'otto');
      profile = await selectBuyer(dialog, aster);
      await profile.getByRole('tab', { name: 'Remarks', exact: true }).click();
      await expect(profile.getByRole('region', { name: 'Private Remarks', exact: true })).toContainText('PRIVATE FOLLOW-UP FOR ASTER ONLY.');
      assert.equal((await stateOf(page)).contributions.filter(item => item.id === contribution.id).length, 1, 'Reload and profile switches cannot duplicate the reward');
      await close(page);
      dialog = await workspace(page, 'Trading', 'Enquiries');
      await dialog.getByRole('tab', { name: 'Enquiries', exact: true }).click();
      await dialog.getByLabel('Raw enquiry', { exact: true }).fill(`Buyer: ${aster.name}\nVessel: ASTER CREDIT CHECK\nPort: Singapore\nETA: 10-12 OCTOBER 2026\nVLSFO: 500 MT`);
      await expect(dialog.getByRole('combobox', { name: 'Buyer', exact: true })).toHaveValue(exact(aster.name));
      await dialog.getByRole('tab', { name: 'Buyers and Credit', exact: true }).click();
      profile = dialog.locator('.buyer-profile:visible');
      await expect(fact(profile.locator('.buyer-profile__identity'), 'Customer ID')).toHaveText(aster.customerId);
      await profile.getByRole('tab', { name: 'Remarks', exact: true }).click();
      await expect(profile.getByRole('region', { name: 'Private Remarks', exact: true })).toContainText('PRIVATE FOLLOW-UP FOR ASTER ONLY.');
      await capture(page, `enquiry-profile-${width}-${theme}`);

      // A sparse buyer is useful for checking omission semantics independently of rich demo seeds.
      await page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('ecosystem.demo.v1'));
        state.companies.push({ ...state.companies.find(item => item.id === 'company-bluewater'), id: 'company-sparse-browser-check', name: 'SPARSE BROWSER BUYER', customerId: 'CHECK000', aliases: [], contact: '', email: '', city: '', registrationAddress: '', tradingAddress: '', nextContact: '', accountGroupId: undefined, accountGroupName: undefined, insuredCredit: 0, parentCompanyGuarantee: false, files: [], inChargeHistory: [] });
        localStorage.setItem('ecosystem.demo.v1', JSON.stringify(state));
      });
      await page.reload();
      dialog = await workspace(page, 'Buyers and Credit', 'Buyer Profiles');
      profile = await selectBuyer(dialog, { customerId: 'CHECK000', name: 'SPARSE BROWSER BUYER' });
      await expect(fact(profile.locator('.buyer-credit-facts'), 'Insured Credit')).toHaveText('$0');
      await expect(fact(profile.locator('.buyer-credit-facts'), 'PCG')).toHaveText(/No/i);
      await profile.getByRole('tab', { name: 'Company Information', exact: true }).click();
      for (const field of ['City', 'Registration address', 'Trading address', 'Contact', 'Email', 'Next contact']) await expect(fact(profile, field)).toHaveCount(0);
      assert.deepEqual(errors, [], 'No browser runtime errors');
      assert.deepEqual(writes, [], 'Demo actions stay in this isolated browser');
      results.push({ width, theme, status: 'passed' });
      console.log(`PASS ${width} ${theme}: directory, six buyer tabs, records/files, remarks privacy and reward, enquiry reuse, sparse optional fields`);
    } catch (error) {
      results.push({ width, theme, status: 'failed', error: error.stack });
      await capture(page, `failure-${width}-${theme}`).catch(() => {});
      throw error;
    } finally { await context.close(); }
  }
} finally {
  await writeFile(new URL('results.json', OUT), JSON.stringify(results, null, 2));
  await browser.close();
}
