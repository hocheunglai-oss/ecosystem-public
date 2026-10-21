import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
const BASE=process.env.ECO_DEMO_URL || 'http://127.0.0.1:4173';
const OUT=new URL('../artifacts/outcome-workflow/',import.meta.url);await mkdir(OUT,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const results=[];
const state=page=>page.evaluate(()=>JSON.parse(localStorage.getItem('ecosystem.demo.v1')));
const dialog=(page,name)=>page.getByRole('dialog',{name,exact:true});
async function login(page,id='otto'){await page.getByLabel('Demo profile',{exact:true}).selectOption(id);await page.getByRole('button',{name:'ENTER ECOSYSTEM',exact:true}).click();}
async function open(page,group,name){const nav=page.getByRole('navigation',{name:'Workspace navigation'});const button=nav.getByRole('button',{name:group,exact:true});if(await button.getAttribute('aria-expanded')!=='true')await button.click();await nav.getByRole('button',{name,exact:true}).click();await expect(dialog(page,name)).toBeVisible();return dialog(page,name);}
async function close(page){await page.getByRole('button',{name:'Close workspace',exact:true}).click();}
async function role(page,id){await page.getByRole('button',{name:'Personal details',exact:true}).click();await dialog(page,'Personal details').getByRole('button',{name:'Sign out',exact:true}).click();await login(page,id);}
async function confirm(page,name='RANGE STAR',products='HSFO: 350-400 MT\nVLSFO: 500-600 MT\nLSMGO: 60 MT'){
 const center=await open(page,'Trading','Enquiries');
 await center.getByRole('button',{name:'New enquiry',exact:true}).click();
 await center.getByLabel('Raw enquiry',{exact:true}).fill(`Buyer: Meridian Shipping Pte Ltd\nVessel: ${name}\nIMO: 9876543\nPort: Singapore\nETA: 2-4 October\n${products}`);
 await expect(center.getByLabel('Vessel',{exact:true})).toHaveValue(name);
 await center.getByRole('button',{name:'Confirm',exact:true}).click();
 await expect.poll(async()=> (await state(page)).enquiries.find(e=>e.vessel===name)?.status).toBe('sent');
 return {center,enquiry:(await state(page)).enquiries.find(e=>e.vessel===name)};
}
async function recordStem(page,name='RANGE STAR'){
 const {center,enquiry}=await confirm(page,name);
 await center.locator(`[data-enquiry-id="${enquiry.id}"]`).getByRole('button',{name:/^stem$/i}).click();
 const stem=dialog(page,'STEM');await expect(stem.locator('.modal-intro')).toHaveCount(0);
 await expect(stem.getByLabel(/sale price|margin/i)).toHaveCount(0);
 await expect(stem.getByLabel('HSFO quantity (MT)',{exact:true})).toHaveValue(/350[–-]400/);
 await stem.getByRole('combobox',{name:'HSFO supplier',exact:true}).fill('Meridian');
 await stem.getByRole('option',{name:/MERIDIAN BUNKER SUPPLY/}).click();
 for(const [grade,price] of [['HSFO','420.5'],['VLSFO','525.25'],['LSMGO','710']])await stem.getByLabel(`${grade} buy price (USD / MT)`,{exact:true}).fill(price);
 await stem.getByLabel('Private note',{exact:true}).fill('OWNER ONLY STEM NOTE');
 const save=stem.getByRole('button',{name:'Save',exact:true});await expect(save).toBeDisabled();
 await stem.getByRole('checkbox',{name:'Compliance',exact:true}).check();await expect(save).toBeDisabled();
 await stem.getByRole('checkbox',{name:'Credit',exact:true}).check();await expect(save).toBeEnabled();
 await stem.getByLabel('HSFO buy price (USD / MT)',{exact:true}).fill('421');await expect(stem.getByRole('checkbox',{name:'Compliance',exact:true})).not.toBeChecked();
 await stem.getByRole('checkbox',{name:'Compliance',exact:true}).check();await stem.getByRole('checkbox',{name:'Credit',exact:true}).check();
 await page.screenshot({path:new URL('stem.png',OUT).pathname});await save.click();await expect(stem).not.toBeVisible();
 return {center,enquiry,outcome:(await state(page)).outcomes.find(o=>o.enquiryId===enquiry.id)};
}
async function scenario(name,fn,viewport={width:1440,height:1000}){
 const context=await browser.newContext({viewport,reducedMotion:'reduce'});const page=await context.newPage();page.setDefaultTimeout(8000);const errors=[],writes=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(['POST','PUT','PATCH','DELETE'].includes(r.method()))writes.push(r.url());});
 try{await page.goto(BASE,{waitUntil:'domcontentloaded'});await login(page);await fn(page);assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);results.push({name,passed:true});console.log('PASS '+name);}
 catch(e){results.push({name,passed:false,error:e.stack});console.log('FAIL '+name+': '+e.message);await page.screenshot({path:new URL(`failure-${results.length}.png`,OUT).pathname}).catch(()=>{});}
 finally{await context.close();}
}
await scenario('Notification wording and separated bordered enquiry queues',async page=>{
 await page.getByRole('button',{name:'Notifications',exact:true}).click();
 await page.getByRole('region',{name:'Enquiries',exact:true}).getByRole('button',{name:'WhatsApp (demo)',exact:true}).click();
 await page.getByRole('button',{name:'Notifications',exact:true}).click();
 await expect(page.getByRole('complementary',{name:'New enquiry',exact:true})).toContainText('Whatsapp Incoming Enquiry (demo)');
 const {center,enquiry}=await confirm(page);
 await expect(center.locator('.center-queue-new .center-incoming-row')).toHaveCount(1);
 await expect(center.locator('.center-queue-confirmed .center-incoming-row')).toHaveCount(1);
 await expect(center.locator(`[data-enquiry-id="${enquiry.id}"]`)).not.toContainText('Confirmed');
 await expect(center.getByRole('button',{name:'Postpone',exact:true})).toHaveCount(0);
 const divider=center.locator('.center-queue-divider');await expect(divider).toBeVisible();assert.ok((await divider.boundingBox()).height>=1);const borderedRow=center.locator('.center-queue-confirmed .center-incoming-row');assert.notEqual(await borderedRow.evaluate(el=>getComputedStyle(el).borderTopWidth),'0px');
 await page.screenshot({path:new URL('enquiry-center.png',OUT).pathname});
});
await scenario('Ranged STEM stores supplier buy prices and private note without invented totals',async page=>{
 const before=await state(page);const {center,outcome}=await recordStem(page);
 assert.equal(outcome.commercialStatus,'pending');assert.deepEqual(outcome.stemProducts.map(p=>p.quantityText),['350–400','500–600','60']);assert.equal(outcome.supplierId,'supplier-meridian');
 const after=await state(page);assert.deepEqual(after.companies,before.companies);assert.deepEqual(after.drops,before.drops);assert.equal(outcome.quantity,0);assert.equal(outcome.price,0);assert.equal(outcome.margin,0);
 assert.equal(after.privateNotes[outcome.id].text,'OWNER ONLY STEM NOTE');assert.ok(!JSON.stringify(after.audit).includes('OWNER ONLY STEM NOTE'));assert.ok(!JSON.stringify(after.outcomes).includes('OWNER ONLY STEM NOTE'));
 await center.getByRole('tab',{name:'Ports & Suppliers',exact:true}).click();const prices=center.getByRole('region',{name:'Buy prices',exact:true});await expect(prices).toContainText('$525.25');await prices.getByPlaceholder('Search buy prices',{exact:true}).fill('VLSFO');await expect(prices.locator('tbody tr')).toHaveCount(1);await expect(prices).not.toContainText('OWNER ONLY STEM NOTE');
 await close(page);const ports=await open(page,'Intelligence','Port data');const portPrices=ports.getByRole('region',{name:'Buy prices',exact:true});await expect(portPrices).toContainText('$421');await portPrices.getByPlaceholder('Search buy prices',{exact:true}).fill('Meridian');await expect(portPrices.locator('tbody tr')).toHaveCount(3);
 await close(page);await page.reload({waitUntil:'domcontentloaded'});const records=await open(page,'Trading','Fixtures');const row=records.getByRole('row').filter({hasText:'RANGE STAR'});await expect(row).toContainText('350–400');await row.getByText('Private note',{exact:true}).click();await expect(row).toContainText('OWNER ONLY STEM NOTE');
 const downloading=page.waitForEvent('download');await records.getByRole('button',{name:'Export page',exact:true}).click();const downloaded=await downloading;const path=new URL('shared-fixtures.csv',OUT).pathname;await downloaded.saveAs(path);assert.ok(!(await readFile(path,'utf8')).includes('OWNER ONLY STEM NOTE'));
 await close(page);await role(page,'elena');const creditView=await open(page,'Trading','Fixtures');await expect(creditView).not.toContainText('OWNER ONLY STEM NOTE');await creditView.getByRole('button',{name:'RANGE STAR',exact:true}).click();await expect(page.getByRole('dialog').last()).not.toContainText('OWNER ONLY STEM NOTE');
});
await scenario('SPC LOST reasons with group note and owner-only private note',async page=>{
 const {center,enquiry}=await confirm(page,'LOST STAR');await center.locator(`[data-enquiry-id="${enquiry.id}"]`).getByRole('button',{name:'Lost',exact:true}).click();const lost=dialog(page,'LOST');await expect(lost.locator('.modal-intro')).toHaveCount(0);await expect(lost.getByRole('checkbox')).toHaveCount(0);
 const reasons=lost.getByRole('combobox',{name:'Reason',exact:true});await expect(reasons.locator('option')).toHaveCount(9);await reasons.selectOption({label:'SUPPLIER LATE RESPONSE'});await lost.getByLabel('Group note',{exact:true}).fill('GROUP CAN SEE: ask suppliers earlier');await lost.getByLabel('Private note',{exact:true}).fill('OWNER ONLY LOST NOTE');await page.screenshot({path:new URL('lost.png',OUT).pathname});await lost.getByRole('button',{name:'Save',exact:true}).click();
 const outcome=(await state(page)).outcomes.find(o=>o.enquiryId===enquiry.id);assert.equal(outcome.reason,'SUPPLIER LATE RESPONSE');assert.equal(outcome.groupNote,'GROUP CAN SEE: ask suppliers earlier');assert.ok(!JSON.stringify((await state(page)).audit).includes('OWNER ONLY LOST NOTE'));
 await close(page);const records=await open(page,'Trading','Lost Records');await expect(records).toContainText('OWNER ONLY LOST NOTE');await close(page);await role(page,'marco');const shared=await open(page,'Trading','Lost Records');await expect(shared).toContainText('GROUP CAN SEE: ask suppliers earlier');await expect(shared).not.toContainText('OWNER ONLY LOST NOTE');
 await shared.getByRole('button',{name:'LOST STAR',exact:true}).click();await expect(page.getByRole('dialog').last()).toContainText('GROUP CAN SEE: ask suppliers earlier');await expect(page.getByRole('dialog').last()).not.toContainText('OWNER ONLY LOST NOTE');
});
await scenario('Admin can edit add disable remove and reorder reasons without changing saved history',async page=>{
 const {center,enquiry}=await confirm(page,'REASON HISTORY');await center.locator(`[data-enquiry-id="${enquiry.id}"]`).getByRole('button',{name:'Lost',exact:true}).click();await dialog(page,'LOST').getByRole('button',{name:'Save',exact:true}).click();await close(page);await role(page,'marco');await page.getByRole('button',{name:'Settings',exact:true}).click();const settings=dialog(page,'Settings');await settings.getByRole('button',{name:'Lost reasons',exact:true}).click();
 const editor=settings.getByRole('region',{name:'Lost reasons',exact:true});await editor.getByRole('textbox',{name:'Reason 1',exact:true}).fill('SUPPLIER STOCK UNAVAILABLE');await editor.getByRole('checkbox',{name:'Active: SUPPLIER LATE RESPONSE',exact:true}).uncheck();await editor.getByRole('button',{name:'Add reason',exact:true}).click();await editor.getByRole('textbox',{name:'Reason 10',exact:true}).fill('PORT RESTRICTION');await editor.getByRole('button',{name:'Move up: PORT RESTRICTION',exact:true}).click();await editor.getByRole('button',{name:'Add reason',exact:true}).click();await editor.getByRole('button',{name:'Remove reason: Reason 11',exact:true}).click();await editor.getByRole('button',{name:'Save',exact:true}).click();
 const saved=await state(page);assert.equal(saved.lostReasons[0].label,'SUPPLIER STOCK UNAVAILABLE');assert.equal(saved.lostReasons[1].active,false);assert.equal(saved.lostReasons[8].label,'PORT RESTRICTION');assert.equal(saved.outcomes.find(o=>o.enquiryId===enquiry.id).reason,'SUPPLIER NO AVAILS');await page.screenshot({path:new URL('admin-reasons.png',OUT).pathname});
 await close(page);await role(page,'otto');const next=await confirm(page,'NEW REASONS');await next.center.locator(`[data-enquiry-id="${next.enquiry.id}"]`).getByRole('button',{name:'Lost',exact:true}).click();const select=dialog(page,'LOST').getByRole('combobox',{name:'Reason',exact:true});await expect(select.locator('option')).toHaveCount(9);await expect(select).not.toContainText('SUPPLIER LATE RESPONSE');await expect(select).toContainText('PORT RESTRICTION');
});
for(const width of [390,1280])await scenario(`Workspace and STEM fit at ${width}px`,async page=>{const {center}=await recordStem(page,'LAYOUT STAR');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));const b=await center.boundingBox();assert.ok(b.x>=0&&b.x+b.width<=width+1);await page.screenshot({path:new URL(`layout-${width}.png`,OUT).pathname});},{width,height:900});
await browser.close();await writeFile(new URL('results.json',OUT),JSON.stringify({results},null,2));if(results.some(r=>!r.passed))process.exitCode=1;
