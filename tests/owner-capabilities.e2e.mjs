import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { installStagingCookies } from './fixtures/protection-cookies.mjs';
const base = process.env.ECO_OWNER_UI_ORIGIN || 'http://127.0.0.1:4398';
const out = resolve(process.env.ECO_OWNER_UI_OUTPUT || 'output/owner-capabilities');
const owner = { id:'10000000-0000-4000-8000-000000000001',email:'owner@example.test',displayName:'OWNER FIXTURE',officeId:'HONG KONG',officeName:'HONG KONG',isAdmin:true,isSpcTrader:false,isManager:false,isActive:true,activated:true,passwordChangeSuggested:false,revision:1,capabilities:{appearancePreview:true,testWorkspace:true} };
const generation='10000000-0000-4000-8000-000000000010', results=[];
await mkdir(out,{recursive:true});
for(const [engine,type] of [['chromium',chromium],['webkit',webkit]]) {
 if(process.env.ECO_TEST_ENGINE && process.env.ECO_TEST_ENGINE!==engine)continue;
 const browser=await type.launch({headless:true});
 try {for(const width of [1440,320,390])for(const theme of ['light','dark']) {
  if(process.env.ECO_TEST_WIDTH && +process.env.ECO_TEST_WIDTH!==width || process.env.ECO_TEST_THEME && process.env.ECO_TEST_THEME!==theme)continue;
  const context=await browser.newContext({viewport:{width,height:1000},isMobile:width<760,hasTouch:width<760,reducedMotion:'reduce'});
  await installStagingCookies(context,base);
  let user={...owner},preview=null; const writes=[],errors=[];
  await context.route('**/api/**',route=>{
   const req=route.request(),path=new URL(req.url()).pathname;
   if(req.method()!=='GET'){writes.push(path);return route.fulfill({status:403,json:{message:'Unexpected fixture write'}});}
   if(path==='/api/access/session')return route.fulfill({status:user?200:401,json:user?{user,preview}:{message:'Sign in required.'}});
   if(path.startsWith('/api/access/'))return route.fulfill({json:{users:user?[user]:[],offices:[{id:'HONG KONG',name:'HONG KONG'}],requests:[]}});
   if(path==='/api/enquiries/test-policy')return route.fulfill({json:{enabled:user?.capabilities?.testWorkspace===true,generation:user?.capabilities?.testWorkspace?generation:''}});
   if(path==='/api/intelligence/snapshot')return route.fulfill({json:{available:false,snapshot:null}});
   if(path.startsWith('/api/admin/'))return route.fulfill({json:{count:0,previousCount:0,items:[],periodStart:'2026-10-15T16:00:00Z',periodEnd:'2026-10-22T16:00:00Z',timeZone:'Asia/Hong_Kong',source:'shared-feedback'}});
   return route.fulfill({json:{items:[],nextCursor:null,unreadCount:0,total:0,page:1,pageSize:100}});
  });
  await context.addInitScript(theme=>localStorage.setItem('ecosystem.theme.v1',theme),theme);
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  const contribution=page.getByRole('combobox',{name:'Contribution appearance preview',exact:true});
  const hats=page.getByRole('combobox',{name:'Hats appearance preview',exact:true});
  const testControl=page.locator('.home-display-controls').getByRole('button',{name:'Test data',exact:true});
  const focus=()=>page.evaluate(()=>dispatchEvent(new Event('focus')));
  async function shot(name,panel) {
   await expect(page.locator('[data-artwork-ready="true"]')).toBeVisible();
   await page.screenshot({path:`${out}/${engine}-${width}-${theme}-${name}.png`,fullPage:true});
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No horizontal overflow');
   if(panel){const box=await panel.boundingBox();assert.ok(box&&box.x>=-1&&box.x+box.width<=width+1,'Account panel fits viewport');}
  }
  try {
   await page.goto(base);await expect(page.locator('.hud-identity')).toContainText(owner.displayName);await expect(testControl).toBeEnabled();
   const storageKey=`ecosystem.live.v1:${owner.id}:state`;
   const readState=()=>page.evaluate(key=>localStorage.getItem(key),storageKey);
   await expect.poll(readState).not.toBeNull();const before=await readState();
   await page.locator('.hud-resource-activity').click();await expect(contribution).toBeVisible();
   for(const status of ['inactive','active','outstanding']){
    await contribution.selectOption(status);await expect(page.locator('#hud-contribution-activity')).toContainText('PREVIEW ONLY');
    await expect(page.locator('#hud-contribution-activity .activity-tier-heading .contribution-tier')).toHaveText(status.toUpperCase());
   }
   await shot('contribution-owner',page.locator('#hud-contribution-activity'));
   await page.locator('.hud-resource-hats').click();await expect(hats).toBeVisible();
   for(const state of ['none','received']){await hats.selectOption(state);await expect(page.locator('.hats-off-total strong')).toHaveText(state==='received'?'5':'0');}
   await shot('hats-owner',page.locator('#hud-hats-off'));
   assert.equal(await readState(),before,'Appearance previews never change stored records');
   user={...owner,capabilities:{appearancePreview:false,testWorkspace:false}};await focus();
   await expect(hats).toHaveCount(0);await expect(testControl).toHaveCount(0);await expect(page.locator('.hats-off-total strong')).toHaveText('0');
   await page.locator('.hud-resource-activity').click();await expect(contribution).toHaveCount(0);
   await shot('revoked',page.locator('#hud-contribution-activity'));
   user={...owner,id:'10000000-0000-4000-8000-000000000002',displayName:'OTHER ADMIN',capabilities:undefined};
   preview={role:'admin',officeId:'HONG KONG',officeName:'HONG KONG',readOnly:true};
   await page.reload();await expect(page.locator('.hud-identity')).toContainText('OTHER ADMIN');
   await page.locator('.hud-resource-activity').click();await expect(contribution).toHaveCount(0);await expect(testControl).toHaveCount(0);
   await page.locator('.hud-resource-hats').click();await expect(hats).toHaveCount(0);await shot('other-admin',page.locator('#hud-hats-off'));
   user=null;preview=null;await focus();await expect(page.getByRole('button',{name:'Sign in',exact:true})).toBeVisible();
   await expect(testControl).toHaveCount(0);await expect(contribution).toHaveCount(0);await expect(hats).toHaveCount(0);await shot('signed-out');
   assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);results.push({engine,width,theme,passed:true});console.log(`PASS ${engine} ${width} ${theme}: owner capabilities, revocation, other admin, read-only preview and signed out`);
  }catch(error){await page.screenshot({path:`${out}/${engine}-${width}-${theme}-failure.png`,fullPage:true});throw error;}finally{await context.close();}
 }}finally{await browser.close();}
}
await writeFile(`${out}/verification.json`,JSON.stringify({base,results,limits:'Isolated authenticated API fixtures. Backend authority verified separately with PostgreSQL; physical devices/native Safari not tested.'},null,2));
