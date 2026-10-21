import assert from 'node:assert/strict';
import {mkdir,readFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
const BASE=process.env.ECO_DEMO_URL||'http://127.0.0.1:4173';
const OUT=new URL('../artifacts/records/',import.meta.url);await mkdir(OUT,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
async function open(page,name){const nav=page.getByRole('navigation',{name:'Workspace navigation'});const group=nav.getByRole('button',{name:'Trading',exact:true});if(await group.getAttribute('aria-expanded')!=='true')await group.click();await nav.getByRole('button',{name,exact:true}).click();return page.getByRole('dialog',{name,exact:true});}
try{
 for(const [width,theme] of [[1440,'light'],[1440,'dark'],[390,'light'],[320,'dark'],[850,'light']]){
 const context=await browser.newContext({viewport:{width,height:960},isMobile:width<1000,hasTouch:width<1000,reducedMotion:'reduce'});
 await context.addInitScript(theme=>localStorage.setItem('ecosystem.theme.v1',theme),theme);
 const page=await context.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto(BASE);await page.getByLabel('Demo profile',{exact:true}).selectOption('otto');await page.getByRole('button',{name:'ENTER ECOSYSTEM',exact:true}).click();
  await page.evaluate(()=>{
   const state=JSON.parse(localStorage.getItem('ecosystem.demo.v1'));
   const base=state.outcomes.find(o=>o.kind==='fixture');
   const now=new Date().toISOString();
   state.outcomes=Array.from({length:1207},(_,i)=>({...base,id:`fixture-${i}`,enquiryId:base.enquiryId,owner:'otto',vessel:`VESSEL ${String(i).padStart(4,'0')}`,bookedAt:now,supplierName:i%2?'NUNCHI':'SOVARNO',commercialStatus:'pending',stemProducts:[{grade:'HSFO',quantityText:'350–400',buyPrice:421},{grade:'VLSFO',quantityText:'500',buyPrice:550,supplierName:'TFG MARINE'},{grade:'LSMGO',quantityText:'60',buyPrice:720,supplierName:'SIRIUS'}]}));
   state.outcomes.push({...base,id:'lost-one',kind:'lost',vessel:'LOST VESSEL',owner:'otto',bookedAt:now,reason:'SUPPLIER NO AVAILS',groupNote:'Arrange supplier response earlier next time.'});
   state.privateNotes={'fixture-1206':{owner:'otto',text:'PRIVATE NOT FOR EXPORT',updatedAt:now},'lost-one':{owner:'otto',text:'PRIVATE LOST NOTE',updatedAt:now}};
   localStorage.setItem('ecosystem.demo.v1',JSON.stringify(state));
  });
  await page.reload();let workspace=await open(page,'Fixtures');let sheet=workspace.locator('.record-sheet:visible');
  await expect(sheet.locator('tbody[data-record-id]')).toHaveCount(50);await expect(sheet.locator('tbody tr')).toHaveCount(150);await expect(sheet.getByRole('status')).toHaveText('1–50 of 1,207');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'Page overflow');
  assert.equal(await sheet.evaluate(el=>el.scrollWidth<=el.clientWidth+1),true,'Sheet overflow');
  const footer=await sheet.locator('footer').boundingBox();const frame=await workspace.boundingBox();assert.ok(footer.y+footer.height<=frame.y+frame.height-20,'Paging stays visible');
  const firstFixture=sheet.locator('tbody[data-record-id]').first();
  await expect(firstFixture.locator('[data-grade="HSFO"]')).toContainText('350–400');await expect(firstFixture.locator('[data-grade="HSFO"]')).toContainText('SOVARNO');
  await expect(firstFixture.locator('[data-grade="VLSFO"]')).toContainText('TFG MARINE');await expect(firstFixture.locator('[data-grade="LSMGO"]')).toContainText('SIRIUS');
  await expect(firstFixture.locator('.record-sheet__vessel')).toHaveAttribute('rowspan','3');await expect(firstFixture.getByRole('button',{name:'Actual volume',exact:true})).toHaveCount(1);
  const grid=sheet.locator('.record-sheet__grid');await grid.evaluate((el,offset)=>el.scrollLeft=offset,width<700?850:500);
  await page.screenshot({path:new URL(`fixtures-${width}-${theme}.png`,OUT).pathname});await grid.evaluate(el=>el.scrollLeft=0);
  await sheet.getByRole('button',{name:'Next page',exact:true}).click();await expect(sheet.getByRole('status')).toHaveText('51–100 of 1,207');
  await sheet.getByRole('textbox',{name:'Search records',exact:true}).fill('VESSEL 000');await expect(sheet.locator('tbody[data-record-id]')).toHaveCount(11);await expect(sheet.getByRole('status')).toHaveText('1–11 of 11');
  await sheet.getByRole('button',{name:'Vessel',exact:true}).click();await expect(sheet.locator('tbody[data-record-id]').first()).toContainText('VESSEL 0000');
  await sheet.getByRole('textbox',{name:'Search records',exact:true}).fill('');await sheet.getByRole('combobox',{name:'Fixtures per page',exact:true}).selectOption('100');await expect(sheet.locator('tbody[data-record-id]')).toHaveCount(100);
  await sheet.getByRole('combobox',{name:'Record status',exact:true}).selectOption('delivered');await expect(sheet.getByText('No records match these filters.',{exact:true})).toBeVisible();
  await sheet.getByRole('combobox',{name:'Record status',exact:true}).selectOption('all');
  await sheet.getByRole('textbox',{name:'Search records',exact:true}).fill('VESSEL 1206');await expect(sheet.locator('tbody[data-record-id]')).toHaveCount(1);
  await sheet.locator('summary').filter({hasText:'Private note'}).click();await expect(sheet.locator('tbody[data-record-id]')).toContainText('PRIVATE NOT FOR EXPORT');
  const waitDownload=page.waitForEvent('download');await sheet.getByRole('button',{name:'Export page',exact:true}).click();const download=await waitDownload;const path=new URL(`export-${width}-${theme}.csv`,OUT).pathname;await download.saveAs(path);const csv=await readFile(path,'utf8');assert.ok(csv.includes('350–400'));assert.ok(!csv.includes('PRIVATE NOT FOR EXPORT'));assert.equal(csv.split('\r\n').length,4);assert.ok(csv.includes('"VLSFO","500","TFG MARINE","550"'));assert.ok(csv.includes('"LSMGO","60","SIRIUS","720"'));
  await sheet.getByRole('combobox',{name:'Record period',exact:true}).selectOption('custom');await sheet.getByLabel('From date',{exact:true}).fill('2026-10-04');await sheet.getByLabel('To date',{exact:true}).fill('2026-10-01');await expect(sheet.getByRole('alert')).toBeVisible();
  await page.getByRole('button',{name:'Close workspace',exact:true}).click();workspace=await open(page,'Lost Records');sheet=workspace.locator('.record-sheet:visible');
  await expect(sheet.locator('tbody tr')).toHaveCount(1);await expect(sheet).toContainText('SUPPLIER NO AVAILS');await sheet.locator('summary').filter({hasText:'Group note'}).click();await expect(sheet).toContainText('Arrange supplier response earlier next time.');
  await page.screenshot({path:new URL(`lost-${width}-${theme}.png`,OUT).pathname});
  assert.deepEqual(errors,[]);console.log(`PASS ${width}px ${theme}: bounded paging, search, sort, CSV, date validation, private notes, lost records`);
 }finally{await context.close();}
 }
}finally{await browser.close();}
