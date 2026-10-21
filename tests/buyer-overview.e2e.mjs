import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const BASE = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4173';
const OUT = new URL('../artifacts/buyer-overview/', import.meta.url);
const layouts = [[1440,900,'light'],[1280,720,'dark'],[390,844,'light'],[320,740,'dark']].filter(([width]) => !process.env.WIDTH || width === Number(process.env.WIDTH));
const tabs = ['Overview','Stem Records','Credit Requests','Company Information'];
const buyerId = 'company-meridian';
const otherId = 'company-pacific-orbit';
const privateText = 'PRIVATE BUYER FOLLOW-UP ONLY FOR OTTO.';
const groupText = 'SHARED GROUP DELIVERY UPDATE BEFORE EACH CONFIRMED LIFTING.';
const competitionText = 'COMPETITOR A SUPPLIED THIS BUYER AT SINGAPORE.';
const stateOf = page => page.evaluate(() => JSON.parse(localStorage.getItem('ecosystem.demo.v1')));
const goldOf = (page,id) => page.evaluate(async id => {
  const { personalResources } = await import('/src/lib/model.ts');
  return personalResources(JSON.parse(localStorage.getItem('ecosystem.demo.v1')),id).gold;
},id);
const financialSnapshot = state => ({
  companies: state.companies.map(({creditRemarks,activeCreditRemarkId,...company}) => company),
  requests: state.requests, outcomes: state.outcomes, enquiries: state.enquiries,
});
const button = (scope,name) => scope.getByRole('button',{name,exact:typeof name === 'string'});
async function workspace(page,group,name) {
  const nav = page.getByRole('navigation',{name:'Workspace navigation'});
  const category = button(nav,group);
  if(await category.getAttribute('aria-expanded') !== 'true') await category.click();
  await button(nav,name).click();
  return page.getByRole('dialog',{name,exact:true});
}
async function close(page) { await button(page,'Close workspace').click(); }
async function actor(page,id) {
  await page.evaluate(id => sessionStorage.setItem('ecosystem.session.v1',id),id);
  await page.reload();
}
async function directory(page,id=buyerId) {
  const window = await workspace(page,'Buyers and Credit','Buyer Profiles');
  const company = (await stateOf(page)).companies.find(company => company.id === id);
  const search = window.getByRole('textbox',{name:'Search buyer profiles'});
  if(await search.count()) {
    await search.fill(company.name);
    await button(window,company.name).click();
  } else {
    await window.getByRole('combobox',{name:'Buyer',exact:true}).fill(company.name);
    await page.getByRole('option').filter({hasText:company.name}).click();
  }
  return window.locator('.buyer-profile:visible');
}
async function selectBuyer(page,profile,id) {
  const company = (await stateOf(page)).companies.find(company => company.id === id);
  const window = page.getByRole('dialog',{name:'Buyer Profiles',exact:true});
  await window.getByRole('combobox',{name:'Buyer',exact:true}).fill(company.name);
  await page.getByRole('option').filter({hasText:company.name}).click();
  await expect(profile.locator('.buyer-profile__title h2')).toHaveText(company.name);
  return window.locator('.buyer-profile:visible');
}
async function enquiry(page) {
  const company = (await stateOf(page)).companies.find(company => company.id === buyerId);
  const window = await workspace(page,'Trading','Enquiries');
  await window.getByRole('tab',{name:'Enquiries',exact:true}).click();
  await window.getByRole('textbox',{name:'Raw enquiry',exact:true}).fill(`Buyer: ${company.name}\nVessel: BUYER OVERVIEW CHECK\nPort: Singapore\nETA: 15 October\nVLSFO: 500 MT`);
  await expect(window.getByRole('combobox',{name:'Buyer',exact:true})).toHaveValue(company.name.toUpperCase());
  await window.getByRole('tab',{name:'Buyers and Credit',exact:true}).click();
  return window.locator('.buyer-profile:visible');
}
async function tab(profile,name) { await profile.getByRole('tab',{name,exact:true}).click(); }
const region = (profile,name) => profile.getByRole('region',{name,exact:true});
async function assertLayout(page,profile,width) {
  await tab(profile,'Overview');
  await expect(profile.getByRole('tab')).toHaveText(tabs);
  await expect(profile.getByRole('tab',{name:'Credit History',exact:true})).toHaveCount(0);
  const header = profile.locator(':scope > .buyer-profile__header');
  await expect(header.locator('dt')).toHaveText(['Customer ID','Group']);
  for(const forbidden of ['Person in charge','Office','Country']) await expect(header.getByText(forbidden,{exact:true})).toHaveCount(0);
  for(const name of ['Credit Information','Performance','Recent margin and volume trends','Credit History']) await expect(region(profile,name)).toBeVisible();
  await expect(profile.getByRole('heading',{name:'Stem Records',exact:true})).toHaveCount(0);
  await expect(profile.getByRole('heading',{name:'Remarks',exact:true})).toBeVisible();await expect(region(profile,'Competition')).toBeVisible();
  await expect(profile.locator('.buyer-credit-metric')).toHaveCount(4);
  const geometry = await profile.evaluate(node => {
    const header=node.querySelector(':scope > header').getBoundingClientRect();
    const nav=node.querySelector('.buyer-profile__tabs');
    const navRect=nav.getBoundingClientRect();
    return { gap:navRect.top-header.bottom, fits:node.scrollWidth<=node.clientWidth+1, tabsFit:nav.scrollWidth<=nav.clientWidth+1,
      rows:new Set([...nav.children].map(child=>Math.round(child.getBoundingClientRect().top))).size,
      buttonsFit:[...nav.children].every(child=>child.scrollWidth<=child.clientWidth+1 && child.getBoundingClientRect().right<=navRect.right+1)};
  });
  assert.ok(geometry.fits && geometry.tabsFit && geometry.buttonsFit,JSON.stringify(geometry));
  const valuesFit = await profile.locator('.buyer-credit-metric > dd, .buyer-profile__identity > div:first-child > dd').evaluateAll(values => values.every(value => {
    const range = document.createRange(); range.selectNodeContents(value);
    return range.getClientRects().length <= 1 && value.scrollWidth <= value.clientWidth + 1;
  }));
  assert.ok(valuesFit,'Financial amounts and customer IDs stay on one line');
  assert.ok(geometry.gap>=-1 && geometry.gap<=25,`Tabs directly follow header: ${geometry.gap}`);
  if(width<500) assert.ok(geometry.rows>1,'Mobile tabs wrap');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No page horizontal overflow');
  // The same tab pattern offers standard keyboard selection.
  await profile.getByRole('tab',{name:'Overview',exact:true}).focus();
  await page.keyboard.press('End');
  await expect(profile.getByRole('tab',{name:'Company Information',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(region(profile,'Credit Information')).toHaveCount(0);
  await page.keyboard.press('Home');
  await expect(profile.getByRole('tab',{name:'Overview',exact:true})).toHaveAttribute('aria-selected','true');
}
async function signature(profile) {
  return profile.evaluate(node => ({
    title:node.querySelector('.buyer-profile__title').textContent,
    identity:node.querySelector('.buyer-profile__identity').textContent,
    tabs:[...node.querySelectorAll('.buyer-profile__tabs button')].map(button=>button.textContent),
    credit:node.querySelector('.buyer-profile__credit').textContent,
    metrics:node.querySelector('.buyer-profile__metrics').textContent,
    className:node.className,
  }));
}
await mkdir(OUT,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const results=[];
try {
  for(const [width,height,theme] of layouts) {
    const context=await browser.newContext({viewport:{width,height},isMobile:width<1000,hasTouch:width<1000,reducedMotion:'reduce'});
    await context.addInitScript(theme=>localStorage.setItem('ecosystem.theme.v1',theme),theme);
    const page=await context.newPage();page.setDefaultTimeout(10000);
    const errors=[],writes=[];
    page.on('pageerror',error=>errors.push(error.message));
    await context.route('**/*',route=>{
      if(!['GET','HEAD','OPTIONS'].includes(route.request().method())){writes.push(route.request().url());return route.abort('blockedbyclient');}
      return route.continue();
    });
    try {
      await page.goto(BASE);
      await page.getByRole('combobox',{name:'Demo profile',exact:true}).selectOption('otto');
      await button(page,'ENTER ECOSYSTEM').click();
      const initial=await stateOf(page),finances=financialSnapshot(initial);
      let profile=await directory(page);
      await assertLayout(page,profile,width);
      const directorySignature=await signature(profile);
      await page.screenshot({path:new URL(`overview-${width}-${theme}.png`,OUT).pathname});
      const history=region(profile,'Credit History');
      await expect(button(history,'Edit')).toHaveCount(0);
      await button(history,'All history').click();
      await history.getByRole('combobox',{name:'Credit history type'}).selectOption('limit');
      await tab(profile,'Overview');
      await expect(region(profile,'Credit Information')).toBeVisible();
      await button(profile,'Add Private Remark').click();
      await profile.getByRole('textbox',{name:'Private Remarks',exact:true}).fill(privateText);
      await button(profile,/Update Group Remarks/).click();
      await profile.getByRole('textbox',{name:'Group Remarks',exact:true}).fill(groupText);
      await tab(profile,'Overview');
      await button(profile,'Add Competition').click();
      const competition=region(profile,'Competition');
      await expect(button(competition,'Save')).toBeDisabled();
      await competition.getByRole('textbox',{name:'Competition',exact:true}).fill(competitionText);
      await tab(profile,'Stem Records');await tab(profile,'Overview');
      await expect(history.getByRole('combobox',{name:'Credit history type'})).toHaveValue('limit');
      await button(history,'All history').click();
      await button(history,'All history').click();
      await expect(history.getByRole('combobox',{name:'Credit history type'})).toHaveValue('limit');
      await button(history,'All history').click();
      await tab(profile,'Overview');
      await expect(profile.getByRole('textbox',{name:'Private Remarks',exact:true})).toHaveValue(privateText);
      await expect(profile.getByRole('textbox',{name:'Group Remarks',exact:true})).toHaveValue(groupText);
      await button(region(profile,'Private Remarks'),'Save').click();
      await button(region(profile,'Group Remarks'),'Update').click();
      await expect(region(profile,'Private Remarks')).toContainText(privateText);
      await page.screenshot({path:new URL(`remarks-${width}-${theme}.png`,OUT).pathname});
      await tab(profile,'Overview');
      await expect(competition.getByRole('textbox',{name:'Competition',exact:true})).toHaveValue(competitionText);
      const gold=await goldOf(page,'otto');
      await button(competition,'Save').click();
      await expect(competition.locator('.buyer-competition-entry')).toHaveCount(1);
      await expect(competition.locator('.buyer-competition-entry')).toContainText(competitionText);
      assert.equal(await goldOf(page,'otto'),gold+1);
      let state=await stateOf(page);
      const entry=state.contributions.find(entry=>entry.targetType==='buyer-competition');
      assert.equal(entry.targetId,buyerId);assert.equal(entry.author,'otto');assert.equal(entry.status,'approved');assert.equal(entry.publication,'direct');
      assert.ok(entry.createdAt && entry.publishedAt);
      await button(competition,'Add Competition').click();
      await competition.getByRole('textbox',{name:'Competition',exact:true}).fill('  COMPETITOR A\nSUPPLIED THIS BUYER AT SINGAPORE.  ');
      await button(competition,'Save').click();
      await expect(competition.getByRole('textbox',{name:'Competition',exact:true})).toBeVisible();
      assert.equal((await stateOf(page)).contributions.filter(entry=>entry.targetType==='buyer-competition').length,1);
      assert.equal(await goldOf(page,'otto'),gold+1,'Duplicate never pays another Gold');
      await button(competition,'Cancel').click();
      await page.screenshot({path:new URL(`competition-${width}-${theme}.png`,OUT).pathname});
      profile=await selectBuyer(page,profile,otherId);
      await tab(profile,'Overview');
      await expect(region(profile,'Competition').locator('.buyer-competition-entry')).toHaveCount(0);
      await tab(profile,'Overview');
      await button(profile,'Add Private Remark').click();
      await expect(profile.getByRole('textbox',{name:'Private Remarks',exact:true})).toHaveValue('');
      await page.reload();
      profile=await directory(page);
      await tab(profile,'Overview');
      await expect(region(profile,'Competition')).toContainText(competitionText);
      assert.equal(await goldOf(page,'otto'),gold+1,'Reload does not reward twice');
      await close(page);
      profile=await enquiry(page);
      await assertLayout(page,profile,width);
      assert.deepEqual(await signature(profile),directorySignature,'Both entry points use the identical buyer profile');
      await page.screenshot({path:new URL(`enquiry-${width}-${theme}.png`,OUT).pathname});
      await tab(profile,'Overview');
      await expect(region(profile,'Private Remarks')).toContainText(privateText);
      await expect(region(profile,'Group Remarks')).toContainText(groupText);
      await tab(profile,'Overview');
      await expect(region(profile,'Competition')).toContainText(competitionText);
      await expect(region(profile,'Competition')).not.toContainText(privateText);
      // Manager may publish; credit/admin can read shared Competition but cannot add.
      await actor(page,'gianmichele');profile=await directory(page);
      await tab(profile,'Overview');
      await expect(profile).not.toContainText(privateText);
      await expect(region(profile,'Group Remarks')).toContainText(groupText);
      await tab(profile,'Overview');
      await button(profile,'Add Competition').click();
      const managerGold=await goldOf(page,'gianmichele');
      await region(profile,'Competition').getByRole('textbox',{name:'Competition',exact:true}).fill('COMPETITOR B');
      await button(region(profile,'Competition'),'Save').click();
      assert.equal(await goldOf(page,'gianmichele'),managerGold+1);
      for(const id of ['elena','marco']) {
        await actor(page,id);profile=await directory(page);
        await expect(profile).not.toContainText(privateText);
        const creditHistory=region(profile,'Credit History');
        await button(creditHistory,'Edit').click();
        const text=`CREDIT HISTORY SAVED BY ${id.toUpperCase()}.`;
        await creditHistory.getByRole('textbox',{name:'Credit History',exact:true}).fill(text);
        await tab(profile,'Overview');
        await expect(button(profile,'Add Competition')).toHaveCount(0);
        await expect(region(profile,'Competition').locator('.buyer-competition-entry')).toHaveCount(2);
        await expect(region(profile,'Competition')).not.toContainText(privateText);
        await tab(profile,'Overview');
        await expect(region(profile,'Private Remarks')).not.toContainText(privateText);
        await tab(profile,'Overview');
        await expect(creditHistory.getByRole('textbox',{name:'Credit History',exact:true})).toHaveValue(text);
        await button(creditHistory,'Save').click();
        await expect(creditHistory.locator('.buyer-credit-history__current')).toContainText(text);
      }
      const beforeRestore=await stateOf(page);
      const first=beforeRestore.creditHistory.find(entry=>entry.summary==='CREDIT HISTORY SAVED BY ELENA.');
      const creditHistory=region(profile,'Credit History');
      await button(creditHistory,'All history').click();
      await creditHistory.getByRole('combobox',{name:'Credit history type'}).selectOption('remark');
      const firstRow=creditHistory.locator('.credit-record-table tbody tr').filter({hasText:first.summary});
      await button(firstRow,'Set as active remark').click();
      await expect(creditHistory.locator('.buyer-credit-history__current')).toContainText(first.summary);
      state=await stateOf(page);
      assert.deepEqual(state.creditHistory,beforeRestore.creditHistory,'Selecting an old active remark preserves every history entry');
      assert.equal(state.companies.find(company=>company.id===buyerId).activeCreditRemarkId,first.id);
      await actor(page,'otto');profile=await directory(page);
      await expect(region(profile,'Credit History').locator('.buyer-credit-history__current')).toContainText(first.summary);
      await button(region(profile,'Credit History'),'All history').click();
      await expect(button(profile,'Set as active remark')).toHaveCount(0);
      await expect(button(region(profile,'Credit History'),'Edit')).toHaveCount(0);
      // Existing decision history and financial entities survive all changes untouched.
      state=await stateOf(page);
      for(const entry of initial.creditHistory) assert.deepEqual(state.creditHistory.find(saved=>saved.id===entry.id),entry);
      assert.deepEqual(financialSnapshot(state),finances,'Profile navigation and remarks must not alter financial data');
      assert.ok(!JSON.stringify(state.audit).includes(privateText),'Audit never records private note text');
      assert.ok(!JSON.stringify(state.contributions).includes(privateText),'Shared records never include private note text');
      assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
      results.push({width,height,theme,passed:true});
      console.log(`PASS ${width} ${theme}: shared overview, wrapped tabs, drafts, credit history restore, private/group permissions, Competition roles/persistence/Gold/isolation`);
    } catch(error) {
      await page.screenshot({path:new URL(`failure-${width}-${theme}.png`,OUT).pathname});
      throw error;
    } finally { await context.close(); }
  }
} finally { await browser.close();await writeFile(new URL('results.json',OUT),JSON.stringify(results,null,2)); }
