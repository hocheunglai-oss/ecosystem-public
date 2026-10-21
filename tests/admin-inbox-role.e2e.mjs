import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
const BASE=process.env.ECO_DEMO_URL||'http://127.0.0.1:4173';
const OUT=new URL('../artifacts/admin-inbox-role/',import.meta.url);
await mkdir(OUT,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const items=[{id:'legacy-guido-msg',providerMessageId:'demo-whatsapp-legacy-guido',channel:'whatsapp',sender:'+390000000003',owner:'marco',rawText:'Forwarded message\nBuyer: Meridian Shipping Pte Ltd\nVessel: MERIDIAN DAWN\nIMO: 9876543\nPort: Singapore\nETA: 10-12 OCT\nVLSFO: 500 MT',receivedAt:'2026-10-06T08:00:00.000Z',read:false},{id:'legacy-otto-msg',providerMessageId:'demo-whatsapp-legacy-otto',channel:'whatsapp',sender:'+85200000001',owner:'otto',rawText:'Forwarded message\nBuyer: Meridian Shipping Pte Ltd\nVessel: TRADER INCOMING\nIMO: 9876543\nPort: Singapore\nETA: 10-12 OCT\nVLSFO: 500 MT',receivedAt:'2026-10-06T08:01:00.000Z',read:false}];
const inbox=page=>page.evaluate(()=>JSON.parse(localStorage.getItem('ecosystem.inbox.v2')).items);
const state=page=>page.evaluate(()=>JSON.parse(localStorage.getItem('ecosystem.demo.v1')));
async function login(page,actor){await page.getByLabel('Demo profile',{exact:true}).selectOption(actor);await page.getByRole('button',{name:'ENTER ECOSYSTEM',exact:true}).click();}
async function openCenter(page){const nav=page.getByRole('navigation',{name:'Workspace navigation'});const group=nav.getByRole('button',{name:'Trading',exact:true});if(await group.getAttribute('aria-expanded')!=='true')await group.click();await nav.getByRole('button',{name:'Enquiries',exact:true}).click();return page.getByRole('dialog',{name:'Enquiries',exact:true});}
try{
 for(const width of [1280,390].filter(width=>!process.env.ECO_INBOX_WIDTH||width===Number(process.env.ECO_INBOX_WIDTH))){
  const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'});const page=await context.newPage();const errors=[],writes=[];
  page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(!['GET','HEAD'].includes(request.method()))writes.push(request.url());});
  try{
   await page.goto(BASE);await page.evaluate(items=>localStorage.setItem('ecosystem.inbox.v2',JSON.stringify({version:2,items})),items);await page.reload();await login(page,'marco');
   const before=await state(page);const bell=page.getByRole('button',{name:'Notifications',exact:true});await bell.click();
   const notifications=page.getByRole('region',{name:'Enquiries',exact:true});await expect(notifications).toBeVisible();
   await expect(notifications.getByRole('button',{name:/^(WhatsApp|Email) \(demo\)$/})).toHaveCount(0);await expect(notifications.locator('.inbox-item')).toHaveCount(0);await bell.click();
   let center=await openCenter(page);await expect(center.getByRole('button',{name:'New enquiry',exact:true})).toBeDisabled();await expect(center.getByRole('button',{name:'Confirm',exact:true})).toBeDisabled();await expect(center.getByLabel('Raw enquiry',{exact:true})).toHaveValue('');
   await expect(center.locator('.center-incoming-row')).toHaveCount(0);assert.deepEqual(await inbox(page),items,'Admin-owned legacy messages are retained without rewriting ownership, content or read state');assert.deepEqual((await state(page)).enquiries,before.enquiries);
   await page.screenshot({path:new URL(`guido-${width}.png`,OUT).pathname});await center.getByRole('button',{name:'Close workspace',exact:true}).click();
   await page.getByRole('button',{name:'Personal details',exact:true}).click();const personal=page.getByRole(width<1000?'region':'dialog',{name:'Personal details',exact:true});await personal.getByRole('button',{name:'Sign out',exact:true}).click();await login(page,'otto');
   await bell.click();await expect(notifications.locator('.inbox-item')).toHaveCount(1);await expect(notifications).toContainText('TRADER INCOMING');await expect(notifications).not.toContainText('MERIDIAN DAWN');await expect(notifications.getByRole('button',{name:'WhatsApp (demo)',exact:true})).toBeVisible();
   await notifications.locator('.inbox-item').click();center=page.getByRole('dialog',{name:'Enquiries',exact:true});await expect(center.getByLabel('Vessel',{exact:true})).toHaveValue('TRADER INCOMING');await expect(center.getByRole('button',{name:'Confirm',exact:true})).toBeEnabled();await center.getByRole('button',{name:'Confirm',exact:true}).click();
   await expect.poll(async()=>(await state(page)).enquiries.find(item=>item.vessel==='TRADER INCOMING')?.status).toBe('sent');const saved=(await state(page)).enquiries.find(item=>item.vessel==='TRADER INCOMING');assert.equal(saved.owner,'otto');assert.deepEqual((await inbox(page)).find(item=>item.id==='legacy-guido-msg'),items[0]);
   await page.screenshot({path:new URL(`trader-${width}.png`,OUT).pathname});await center.getByRole('button',{name:'Close workspace',exact:true}).click();await bell.click();await notifications.getByRole('button',{name:'WhatsApp (demo)',exact:true}).click();await expect.poll(async()=>(await inbox(page)).length).toBe(3);assert.equal((await inbox(page))[0].owner,'otto');
   assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);console.log(`PASS ${width}px: Guido legacy messages preserved but excluded from action UI, trader-owned incoming remains visible and confirmable, new arrivals stay trader-owned`);
  }catch(error){await page.screenshot({path:new URL(`failure-${width}.png`,OUT).pathname}).catch(()=>{});throw error;}finally{await context.close();}
 }
}finally{await browser.close();}
