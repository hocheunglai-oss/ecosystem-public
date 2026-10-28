import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const BASE = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4194';
const OUT = new URL('../artifacts/main-menu/', import.meta.url);
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const stateOf = page => page.evaluate(() => JSON.parse(localStorage.getItem('ecosystem.demo.v1')));
const results = [];
async function expand(page, name) {
  const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
  const section = button(nav, name);
  if (await section.getAttribute('aria-expanded') !== 'true') await section.click();
  return nav;
}
async function search(page, text, category) {
  const input = page.getByRole('combobox', { name: 'Search ECO', exact: true });
  await input.fill(text);
  const results = page.getByRole('listbox', { name: 'Search results' });
  await expect(results).toBeVisible();
  await expect(results).toHaveAttribute('aria-busy', 'false');
  const options = results.getByRole('option');
  return category ? options.filter({ has: page.locator('.main-search-type').filter({ hasText: new RegExp(`^${category}$`, 'i') }) }) : options;
}
async function closeWorkspace(page) { await button(page, 'Close workspace').click(); }
async function actor(page, id) { await page.evaluate(id => sessionStorage.setItem('ecosystem.session.v1', id), id); await page.reload(); }
try {
  for (const [width, theme] of [[1440, 'light'], [390, 'dark']]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: width < 700, reducedMotion: 'reduce' });
    await context.addInitScript(theme => localStorage.setItem('ecosystem.theme.v1', theme), theme);
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    const errors = [], writes = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => { if (!['GET','HEAD','OPTIONS'].includes(route.request().method())) { writes.push(route.request().url()); return route.abort(); } return route.continue(); });
    try {
      await page.goto(BASE);
      await page.getByRole('combobox', { name: 'Demo profile', exact: true }).selectOption('otto');
      await button(page, 'ENTER ECOSYSTEM').click();
      let nav = page.getByRole('navigation', { name: 'Workspace navigation' });
      await expect(nav.locator('.launcher-toggle')).toHaveCount(3);
      for (const name of ['Trading','Buyers and Credit','Ports & Suppliers']) await expect(button(nav, name)).toBeVisible();
      await expect(nav.getByRole('button', { name: 'Contribute', exact: true, includeHidden: true })).toHaveCount(0);
      for (const [group, names] of [['Trading',['Enquiries','Fixtures','Lost Records']],['Buyers and Credit',['Buyer Profiles','Credit Requests']],['Ports & Suppliers',['Countries & Ports','Supplier Profiles']]]) {
        await expand(page, group);
        for (const name of names) await expect(button(nav, name)).toBeVisible();
        await expect(nav.locator('.launcher-toggle[aria-expanded="true"]')).toHaveCount(1);
      }
      await expect(nav.locator('.launcher-count')).toHaveCount(0);
      const globalInput = page.getByRole('combobox', { name: 'Search ECO', exact: true });
      await expect(globalInput).toHaveAttribute('type', 'search');
      await expect(globalInput).toHaveAttribute('autocomplete', 'off');
      const fieldStyle = () => globalInput.evaluate(input => {
        const style = getComputedStyle(input.closest('.main-search-field'));
        return { outline: style.outline, border: style.borderColor, shadow: style.boxShadow };
      });
      await button(nav, 'Trading').focus();
      const unfocusedField = await fieldStyle();
      await page.keyboard.press('Shift+Tab');
      await expect(globalInput).toBeFocused();
      const inputStyle = await globalInput.evaluate(input => {
        const style = getComputedStyle(input);
        const fieldBounds = input.closest('.main-search-field').getBoundingClientRect();
        const inputBounds = input.getBoundingClientRect();
        return { outline: style.outlineStyle, outlineWidth: style.outlineWidth, shadow: style.boxShadow,
          fits: inputBounds.left >= fieldBounds.left && inputBounds.right <= fieldBounds.right && inputBounds.top >= fieldBounds.top && inputBounds.bottom <= fieldBounds.bottom };
      });
      assert.ok(inputStyle.outline === 'none' || inputStyle.outlineWidth === '0px', 'Input has no separate oversized focus outline');
      assert.equal(inputStyle.shadow, 'none', 'Input has no independent focus box shadow');
      assert.equal(inputStyle.fits, true, 'Input fits inside the complete search field');
      assert.notDeepEqual(await fieldStyle(), unfocusedField, 'The whole search field shows keyboard focus');
      await page.screenshot({ path: new URL(`focus-${width}-${theme}.png`, OUT).pathname });
      await expand(page, 'Trading');
      await nav.scrollIntoViewIfNeeded();
      await page.screenshot({ path: new URL(`menu-${width}-${theme}.png`, OUT).pathname });
      let state = await stateOf(page);
      const buyer = state.companies.find(item => item.id === 'company-meridian');
      await search(page, buyer.customerId, 'Buyer');
      await page.getByRole('combobox', { name: 'Search ECO' }).press('Escape');
      await expect(page.getByRole('listbox', { name: 'Search results' })).toHaveCount(0);
      await search(page, 'ASTER', 'Buyer');
      await expect(page.locator('.main-search-results strong').filter({hasText:buyer.name})).toHaveCount(1);
      await expect(page.locator('.main-search-results strong').filter({hasText:/Aster Marine Supply/i})).toHaveCount(1);
      const searchInput = page.getByRole('combobox', { name: 'Search ECO' });
      // Keep the pointer stationary over the results while the keyboard scrolls
      // and wraps. Scrolling rows under that pointer must not change selection.
      const options = page.getByRole('listbox', { name: 'Search results' }).getByRole('option');
      const firstBounds = await options.first().boundingBox();
      await page.mouse.move(firstBounds.x + firstBounds.width / 2, firstBounds.y + firstBounds.height / 2);
      const optionIds = await options.evaluateAll(nodes => nodes.map(node => node.id));
      assert.ok(optionIds.length > 8, 'Enough results to exercise automatic scrolling');
      await expect(searchInput).toHaveAttribute('aria-activedescendant', optionIds[0]);
      await searchInput.press('ArrowUp');
      await expect(searchInput).toHaveAttribute('aria-activedescendant', optionIds.at(-1));
      await searchInput.press('ArrowDown');
      await expect(searchInput).toHaveAttribute('aria-activedescendant', optionIds[0]);
      for (let index = 1; index <= optionIds.length; index++) {
        await searchInput.press('ArrowDown');
        await expect(searchInput).toHaveAttribute('aria-activedescendant', optionIds[index % optionIds.length]);
      }
      for (let index = optionIds.length - 1; index >= 0; index--) {
        await searchInput.press('ArrowUp');
        await expect(searchInput).toHaveAttribute('aria-activedescendant', optionIds[index]);
      }
      await page.screenshot({ path: new URL(`search-${width}-${theme}.png`, OUT).pathname });
      await page.mouse.click(5, 5);
      await expect(page.getByRole('listbox', { name: 'Search results' })).toHaveCount(0);
      const buyerResults = await search(page, buyer.customerId, 'Buyer');
      await expect(buyerResults).toHaveCount(1);
      await page.getByRole('combobox', { name: 'Search ECO' }).press('Enter');
      let dialog = page.getByRole('dialog', { name: 'Buyer Profiles', exact: true });
      await expect(dialog.locator('.buyer-profile__title h2')).toHaveText(buyer.name);
      await closeWorkspace(page);
      await (await search(page, 'ASTER MARINE SUPPLY', 'Supplier')).click();
      dialog = page.getByRole('dialog', { name: 'Supplier Profiles', exact: true });
      await expect(dialog.getByRole('heading', { name: /Aster Marine Supply/i })).toBeVisible();
      await closeWorkspace(page);
      for (const [query, category, title] of [['OSAKA','Port','OSAKA'],['JAPAN','Country','JAPAN'],['CHIBA','Port','CHIBA'],[state.ports.find(item => item.code).code,'Port',state.ports.find(item => item.code).name.toUpperCase()]]) {
        await (await search(page, query, category)).click();
        dialog = page.getByRole('dialog', { name: 'Countries & Ports', exact: true });
        await expect(dialog.getByRole('heading', { name: new RegExp(`^${title}$`, 'i') })).toBeVisible();
        await expect(button(dialog, 'Enquiries')).toHaveCount(0);
        if(category === 'Port' && title === 'OSAKA') await page.screenshot({ path: new URL(`osaka-${width}-${theme}.png`, OUT).pathname });
        await closeWorkspace(page);
      }
      await page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('ecosystem.demo.v1'));
        const sample = state.enquiries.find(item => item.owner === 'otto' && !state.outcomes.some(outcome => outcome.enquiryId === item.id));
        state.enquiries.push({ ...sample, id:'menu-own-active',owner:'otto',buyerId:'company-meridian',portId:state.ports.find(port => port.name.toUpperCase() === 'OSAKA').id,vessel:'MENU OWN ACTIVE',imo:'9712345',status:'draft' });
        state.enquiries.push({ ...sample, id:'menu-other-private',owner:'luca',vessel:'MENU PRIVATE OTHER',imo:'9612346',status:'draft' });
        const outcome = state.outcomes.find(item => item.kind === 'fixture');
        state.enquiries.push({ ...sample, id:'menu-shared-enquiry',owner:'luca',vessel:'MENU SHARED FIXTURE',imo:'9512347',status:'fixture' });
        state.outcomes.push({ ...outcome, id:'menu-shared-fixture',enquiryId:'menu-shared-enquiry',owner:'luca',vessel:'MENU SHARED FIXTURE',imo:'9512347' });
        localStorage.setItem('ecosystem.demo.v1', JSON.stringify(state));
        const now = new Date().toISOString();
        const incoming = (id, vessel, read, dismissed=false) => ({ id,providerMessageId:id,channel:'email',sender:'owner@example.test',owner:'otto',rawText:`Vessel: ${vessel}\nBuyer: ASTER OCEAN NAVIGATION PTE LTD\nPort: Singapore\nETA: 15 OCT 2026\nGrade: VLSFO\nQuantity: 500 MT`,receivedAt:now,read,dismissed });
        localStorage.setItem('ecosystem.inbox.v2',JSON.stringify({version:2,items:[incoming('menu-inbox-unread','MENU INBOX UNREAD',false),incoming('menu-inbox-read','MENU INBOX READ',true),incoming('menu-inbox-dismissed','MENU INBOX DISMISSED',false,true)]}));
      });
      await page.reload();
      await search(page, 'MENU PRIVATE OTHER');
      await expect(page.getByRole('listbox', { name: 'Search results' }).getByRole('option')).toHaveCount(0);
      await expect(page.getByRole('listbox')).toContainText('No results');
      await (await search(page, '9712345', 'Enquiry')).click();
      dialog = page.getByRole('dialog', { name: 'Enquiries', exact: true });
      await expect(dialog.getByRole('textbox', { name: 'Vessel', exact: true })).toHaveValue('MENU OWN ACTIVE');
      const tabs = dialog.getByRole('tablist', { name: 'Enquiries', exact: true });
      await expect(tabs.getByRole('tab')).toHaveCount(3);
      for (const tab of ['Enquiries','Ports & Suppliers','Buyers and Credit']) await expect(tabs.getByRole('tab', { name: tab, exact: true })).toBeVisible();
      await tabs.getByRole('tab', { name: 'Ports & Suppliers', exact: true }).click();
      await expect(dialog.getByRole('tabpanel', { name: 'Ports & Suppliers', exact: true })).toContainText('OSAKA');
      await tabs.getByRole('tab', { name: 'Buyers and Credit', exact: true }).click();
      await expect(dialog.getByRole('tabpanel', { name: 'Buyers and Credit', exact: true }).locator('.buyer-profile__title h2')).toHaveText(buyer.name);
      await tabs.getByRole('tab', { name: 'Enquiries', exact: true }).click();
      const draftRaw = `Vessel: MENU UNSAVED DRAFT\nBuyer: ${buyer.name}\nPort: PUERTO BRISA\nETA: 15 OCT 2026\nGrade: VLSFO\nQuantity: 500 MT`;
      await dialog.getByRole('textbox', { name: 'Raw enquiry', exact: true }).fill(draftRaw);
      await expect(dialog.getByRole('combobox', { name: 'Port', exact: true })).toHaveValue(/PUERTO BRISA/i);
      await dialog.getByRole('textbox', { name: 'Remarks', exact: true }).fill('KEEP THIS UNSAVED REMARK');
      const storedBeforeNavigation = await stateOf(page);
      await button(dialog, 'Countries & Ports').click();
      const portWorkspace = page.getByRole('dialog', { name: 'Countries & Ports', exact: true });
      await expect(button(portWorkspace, 'Enquiries')).toBeVisible();
      await button(portWorkspace, 'Enquiries').click();
      await expect(dialog.getByRole('textbox', { name: 'Raw enquiry', exact: true })).toHaveValue(draftRaw.toUpperCase());
      await expect(dialog.getByRole('textbox', { name: 'Vessel', exact: true })).toHaveValue('MENU UNSAVED DRAFT');
      await expect(dialog.getByRole('textbox', { name: 'Remarks', exact: true })).toHaveValue('KEEP THIS UNSAVED REMARK');
      assert.deepEqual((await stateOf(page)).enquiries, storedBeforeNavigation.enquiries, 'Returning from ports keeps the unsaved draft without committing it');
      await page.screenshot({ path: new URL(`enquiry-tabs-${width}-${theme}.png`, OUT).pathname });
      await closeWorkspace(page);
      await (await search(page, '9512347', 'Fixture')).click();
      const record = page.getByRole('dialog', { name: 'MENU SHARED FIXTURE', exact: true });
      await expect(record).toBeVisible();
      await expect(record).toContainText('Fixture');
      await record.getByRole('button', { name: 'Close dialog', exact: true }).click();
      nav = await expand(page, 'Trading');
      await button(nav, '1 unread enquiries').click();
      dialog = page.getByRole('dialog', { name: 'Enquiries', exact: true });
      await expect(dialog.locator('.enquiry-unread-filter')).toContainText('Unread');
      await expect(dialog.locator('[data-incoming-id]')).toHaveCount(1);
      await expect(dialog.locator('[data-incoming-id="menu-inbox-unread"]')).toBeVisible();
      await button(dialog, 'Show all').click();
      await expect(dialog.locator('[data-incoming-id="menu-inbox-read"]')).toBeVisible();
      await expect(dialog.locator('[data-enquiry-id="menu-own-active"]')).toHaveCount(1);
      await closeWorkspace(page);
      await button(nav, '1 unread enquiries').click();
      await expect(page.getByRole('dialog', { name: 'Enquiries', exact: true }).locator('.enquiry-unread-filter')).toBeVisible();
      await closeWorkspace(page);
      await actor(page, 'elena');
      nav = await expand(page, 'Buyers and Credit');
      state = await stateOf(page);
      const pending = state.requests.filter(request=>request.status==='pending').length;
      await button(nav, `${pending} credit requests needing attention`).click();
      dialog = page.getByRole('dialog', { name: 'Credit Requests', exact: true });
      await expect(button(dialog, /^Needs attention/)).toHaveAttribute('aria-pressed','true');
      await expect(dialog.locator('.credit-record-table tbody tr')).toHaveCount(pending);
      await button(dialog, /^Needs attention/).click();
      await closeWorkspace(page);
      await button(nav, `${pending} credit requests needing attention`).click();
      await expect(button(page.getByRole('dialog', { name: 'Credit Requests', exact: true }), /^Needs attention/)).toHaveAttribute('aria-pressed','true');
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No viewport overflow');
      assert.deepEqual(errors,[]);
      assert.deepEqual(writes,[],'No backend writes');
      results.push({width,theme,passed:true});
      console.log(`PASS ${width}px ${theme}: menu names/accordion, contained focus and autofill hints, direct Osaka navigation, renamed tabs and draft round trip, private search, attention/unread badges`);
    } catch(error) {
      await page.screenshot({ path:new URL(`failure-${width}-${theme}.png`,OUT).pathname });
      throw error;
    } finally { await context.close(); }
  }
} finally { await browser.close(); await writeFile(new URL('results.json',OUT),JSON.stringify(results,null,2)); }
