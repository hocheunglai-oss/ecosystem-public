import { assertKnowledgeAttribution } from './knowledge-attribution-assertions.mjs';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
const BASE=process.env.ECO_DEMO_URL||'http://127.0.0.1:4173';
const OUT=new URL('../artifacts/intelligence-admin/',import.meta.url);
await mkdir(OUT,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const fields=['30 days quality claim period','ISO Specs','Sample Location','Debunkering'];
const edited=['All','All','Barge manifold','Common'].map(value=>value.toUpperCase());
const keys=['qualityClaim','isoSpecs','sampleLocation','debunkering'];
const state=page=>page.evaluate(()=>JSON.parse(localStorage.getItem('ecosystem.demo.v1')));
const portOf=saved=>saved.ports.find(port=>port.id==='port-singapore');
async function login(page,actor){await page.getByLabel('Demo profile',{exact:true}).selectOption(actor);await page.getByRole('button',{name:'ENTER ECOSYSTEM',exact:true}).click();}
async function workspace(page,group,item){const nav=page.getByRole('navigation',{name:'Workspace navigation'});const button=nav.getByRole('button',{name:group,exact:true});if(await button.getAttribute('aria-expanded')!=='true')await button.click();await nav.getByRole('button',{name:item,exact:true}).click();return page.getByRole('dialog',{name:item,exact:true});}
const facts=scope=>scope.locator('.knowledge-facts dd > span:first-child');
try{
 for(const width of [1280,390].filter(width=>!process.env.ECO_ADMIN_WIDTH||width===Number(process.env.ECO_ADMIN_WIDTH))){
  const context=await browser.newContext({viewport:{width,height:844},reducedMotion:'reduce'});const page=await context.newPage();const errors=[],writes=[];
  page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(!['GET','HEAD'].includes(request.method()))writes.push(request.url());});
  try{
   await page.goto(BASE);await login(page,'marco');const original=await state(page);
   let directory=await workspace(page,'Ports & Suppliers','Countries & Ports');await directory.getByRole('button',{name:'Port Index',exact:true}).click();await directory.getByLabel('Country or port',{exact:true}).fill('Singapore');await directory.locator('.location-table').getByRole('button',{name:'Singapore',exact:true}).click();
   const keyInfo=directory.locator('.knowledge-facts');await keyInfo.getByRole('button',{name:'Update',exact:true}).click();let editor=page.getByRole('dialog',{name:'Update Key Info',exact:true});await expect(editor.getByRole('button',{name:'Update',exact:true})).toBeDisabled();
   for(let index=0;index<fields.length;index++)await editor.getByRole('textbox',{name:fields[index],exact:true}).fill(edited[index]);
   await editor.getByLabel('Reason',{exact:true}).fill('Admin verified the port record.');await editor.getByLabel('Source',{exact:true}).fill('https://example.test/reviewed-port');await editor.getByRole('button',{name:'Update',exact:true}).click();await expect(editor).toHaveCount(0);await expect(facts(directory)).toHaveText(edited);
   const adminSaved=await state(page);assert.deepEqual(portOf(adminSaved).intelligenceKeyInfo,Object.fromEntries(keys.map((key,index)=>[key,edited[index]])));assert.equal(adminSaved.contributions[0].author,'marco');assert.equal(adminSaved.contributions[0].status,'approved');assert.equal(adminSaved.contributions[0].publication,'direct');assert.equal(adminSaved.audit[0].actor,'SAMPLE ADMINISTRATOR');
   for(const key of keys){assert.equal(portOf(adminSaved).intelligenceEntryUpdates[key].updatedBy,'marco');assert.ok(Number.isFinite(Date.parse(portOf(adminSaved).intelligenceEntryUpdates[key].updatedAt)));}
   await assertKnowledgeAttribution(page, keyInfo.locator('dl > div').nth(1), 'SAMPLE ADMINISTRATOR');await page.screenshot({path:new URL(`admin-updated-${width}.png`,OUT).pathname});
   await directory.getByRole('button',{name:'Close workspace',exact:true}).click();await page.getByRole('button',{name:'Personal details',exact:true}).click();await page.getByRole(width<1000?'region':'dialog',{name:'Personal details',exact:true}).getByRole('button',{name:'Sign out',exact:true}).click();await login(page,'otto');
   const center=await workspace(page,'Trading','Enquiries');await center.getByLabel('Raw enquiry',{exact:true}).fill('Buyer: Meridian Shipping Pte Ltd\nVessel: AUDIT TEST\nPort: Singapore\nETA: 15 October\nVLSFO: 500 MT');await expect(center.getByRole('combobox',{name:'Port',exact:true})).toHaveValue(/singapore/i);await center.getByRole('tab',{name:'Ports & Suppliers',exact:true}).click();await expect(facts(center)).toHaveText(edited);
   await center.locator('.knowledge-facts').getByRole('button',{name:'Update',exact:true}).click();editor=page.getByRole('dialog',{name:'Update Key Info',exact:true});await editor.getByRole('textbox',{name:'Debunkering',exact:true}).fill('NO');await editor.getByRole('button',{name:'Update',exact:true}).click();await expect(editor).toHaveCount(0);
   const traderSaved=await state(page);assert.equal(portOf(traderSaved).intelligenceEntryUpdates.debunkering.updatedBy,'otto');for(const key of keys.slice(0,3))assert.deepEqual(portOf(traderSaved).intelligenceEntryUpdates[key],portOf(adminSaved).intelligenceEntryUpdates[key],'Unchanged facts keep the original admin attribution');
   await assertKnowledgeAttribution(page, center.locator('.knowledge-facts dl > div').nth(3), 'SAMPLE TRADER');
   await page.reload();await expect(page.getByRole('navigation',{name:'Workspace navigation'})).toBeVisible();directory=await workspace(page,'Ports & Suppliers','Countries & Ports');await directory.getByRole('button',{name:'Port Index',exact:true}).click();await directory.getByLabel('Country or port',{exact:true}).fill('Singapore');await directory.locator('.location-table').getByRole('button',{name:'Singapore',exact:true}).click();await expect(facts(directory)).toHaveText([...edited.slice(0,3),'NO']);
   const reloaded=await state(page);assert.deepEqual(reloaded.outcomes,original.outcomes);assert.deepEqual(reloaded.privateNotes,original.privateNotes);assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);console.log(`PASS ${width}px: admin/trader Key Info updates share both profile views and persist, changed-field attribution is accurate and unchanged audits remain intact`);
  }catch(error){await page.screenshot({path:new URL(`failure-${width}.png`,OUT).pathname}).catch(()=>{});throw error;}finally{await context.close();}
 }
}finally{await browser.close();}
