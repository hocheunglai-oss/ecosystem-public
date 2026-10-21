import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit, expect } from '@playwright/test';
import { installEmptyLiveInbox } from './fixtures/empty-live-inbox.mjs';
import { installProfileTabMocks } from './fixtures/profile-tabs.mjs';
import { installStagingCookies } from './fixtures/protection-cookies.mjs';
import { invalidateFixtureAuthority } from './fixtures/authority-transition.mjs';
const base = process.env.ECO_OFFICIAL_TABLE_ORIGIN || 'http://127.0.0.1:4398';
const out = process.env.ECO_OFFICIAL_TABLE_OUTPUT || '/private/tmp/eco-official-table-ui';
const btn = (scope, name) => scope.getByRole('button', { name, exact: true });
const user = { id:'10000000-0000-4000-8000-000000000001',email:'official@example.test',displayName:'OFFICIAL FIXTURE',phone:'',officeId:'HONG KONG',officeName:'HONG KONG',isAdmin:false,isSpcTrader:false,isManager:false,isActive:true,activated:true,passwordChangeSuggested:false,revision:1 };
const rows = ['LNG','Methanol','Ammonia','Ethanol'].map(fuel => ({ id:fuel.toLowerCase(),fuel,position:`SYNTHETIC VERIFIED ${fuel} FACT`,sourceUrl:`https://www.mpa.gov.sg/media-centre/details/Fixture-${fuel}?Key=AbC`,sourceTitle:'OFFICIAL SOURCE FIXTURE',publishedAt:'2026-10-01',checkedAt:new Date().toISOString(),evidenceHash:'a'.repeat(64) }));
const reports=[]; await mkdir(out,{recursive:true});
async function openTable(page) {
 const nav=page.getByRole('navigation',{name:'Workspace navigation'});await btn(nav,'Ports & Suppliers').click();await btn(nav,'Countries & Ports').click();
 const workspace=page.getByRole('dialog',{name:'Countries & Ports',exact:true});await btn(workspace,'Port Index').click();await workspace.getByLabel('Country or port',{exact:true}).fill('Singapore');await btn(workspace.locator('.location-table'),'Singapore').click();
 await workspace.getByRole('tab',{name:'Grades and delivery modes',exact:true}).click();return workspace;
}
for(const [engine,type] of [['chromium',chromium],['webkit',webkit]]) {
 if(process.env.ECO_TEST_ENGINE && process.env.ECO_TEST_ENGINE!==engine) continue;
 const browser=await type.launch({headless:true});
 try {for(const width of [1440,320,390]) for(const theme of ['light','dark']) {
  if(process.env.ECO_TEST_WIDTH && Number(process.env.ECO_TEST_WIDTH)!==width || process.env.ECO_TEST_THEME && process.env.ECO_TEST_THEME!==theme) continue;
  const context=await browser.newContext({viewport:{width,height:width<760?844:1000},isMobile:width<760,hasTouch:width<760,colorScheme:theme,reducedMotion:'reduce'});
  await installStagingCookies(context,base);
  const state={user:structuredClone(user),snapshot:{feedId:'mpa-singapore-alternative-fuels',status:'current',checkedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),rows:structuredClone(rows)},fail:false,writes:[],reads:0};
  await context.route('**/api/**',route=>{if(route.request().method()!=='GET')state.writes.push(route.request().url());return route.fulfill({status:404,json:{message:'Synthetic fixture only.'}});});
  await installEmptyLiveInbox(context); await installProfileTabMocks(context,{ownerId:()=>state.user?.id});
  await context.route('**/api/access/**',route=>route.fulfill(state.user?{json:{user:state.user,preview:null,users:[],requests:[],offices:[]}}:{status:401,json:{message:'Sign in required.'}}));
  await context.route('**/api/admin/**',route=>route.fulfill({json:{count:0,items:[]}}));
  await context.route('**/api/enquiries/test-policy',route=>route.fulfill({json:{enabled:false}}));
  await context.route('**/api/suppliers/**',route=>route.fulfill({json:{items:[],total:0,page:1,pageSize:50}}));
  await context.route('**/api/official-tables/snapshot',route=>{state.reads++;return route.fulfill(state.fail?{status:503,json:{message:'Unavailable'}}:{json:{snapshot:state.snapshot}});});
  await context.addInitScript(theme=>localStorage.setItem('ecosystem.theme.v1',theme),theme);
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  try {
   await page.goto(base);await page.getByRole('main',{name:'ECOSYSTEM workspace'}).waitFor();
   let workspace=await openTable(page);
   let table=workspace.locator('.official-fuel-table');await expect(table.locator('tbody tr')).toHaveCount(4);await expect(table).toContainText('SYNTHETIC VERIFIED LNG FACT');
   const link=table.getByRole('link').first();await expect(link).toHaveAttribute('href',rows[0].sourceUrl);assert.equal(await link.evaluate(el=>getComputedStyle(el).textTransform),'none');
   const key=`ecosystem.live.v1:${user.id}:state`,count=()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)).contributions.length,key);const before=await count();
   await expect(btn(workspace.locator('.knowledge-content-toolbar'),'EDIT')).toHaveCount(1);
   await page.screenshot({path:`${out}/${engine}-${width}-${theme}-read.png`});
   await btn(workspace.locator('.knowledge-content-toolbar'),'EDIT').click();const editor=workspace.locator('.knowledge-editor');await expect(editor.locator('.official-fuel-table')).toBeVisible();
   await editor.getByLabel('LNG commercial implication',{exact:true}).fill('MANUAL NOTE https://example.test/Case?Key=AbC');
   await expect(editor.getByRole('textbox')).toHaveCount(4);await btn(editor,'Save').click();await expect(editor).toHaveCount(0);assert.equal(await count(),before+1);
   table=workspace.locator('.official-fuel-table');await expect(table).toContainText('MANUAL NOTE');
   state.snapshot.rows[0].position='SYNTHETIC VERIFIED UPDATED LNG FACT';await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
   await expect(table).toContainText('SYNTHETIC VERIFIED UPDATED LNG FACT');await expect(table).toContainText('MANUAL NOTE');assert.equal(await count(),before+1);
   state.fail=true;const reads=state.reads;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect.poll(()=>state.reads).toBeGreaterThan(reads);await expect(table).toContainText('Update unavailable');await expect(table).toContainText('SYNTHETIC VERIFIED UPDATED LNG FACT');
   await page.screenshot({path:`${out}/${engine}-${width}-${theme}-stale.png`});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   await page.evaluate(key=>{const saved=JSON.parse(localStorage.getItem(key)),section=saved.knowledgeRecords['port:port-singapore'].sections.find(section=>section.blocks.some(block=>block.id.startsWith('mpa-alternative-fuels-notes'))),copy=structuredClone(section.blocks.find(block=>block.id.startsWith('mpa-alternative-fuels-notes')));copy.id+='-manual-copy';for(const item of [...copy.columns,...copy.rows])item.id+='-manual-copy';copy.rows[0].cells[1]='SECOND TABLE REMAINS MANUAL';section.blocks.push(copy);localStorage.setItem(key,JSON.stringify(saved));},key);
   state.fail=false;await page.reload();workspace=await openTable(page);await expect(workspace).toContainText('SECOND TABLE REMAINS MANUAL');
   await expect(workspace.locator('.official-fuel-table')).toHaveCount(1);await btn(workspace.locator('.knowledge-content-toolbar'),'EDIT').click();
   const titles=workspace.locator('.knowledge-outline-select').filter({hasText:'Current alternative-fuel supply position'});await expect(titles).toHaveCount(2);await titles.last().click();await expect(workspace.getByRole('group',{name:'Table controls'})).toBeVisible();await expect(workspace.getByLabel('Row 1, Commercial implication',{exact:true})).toHaveValue('SECOND TABLE REMAINS MANUAL');await btn(workspace.locator('.knowledge-editor'),'Cancel').click();
   assert.equal(await count(),before+1);
   assert.equal(state.writes.length,0);assert.deepEqual(errors,[]);
   state.user=null;await invalidateFixtureAuthority(page,{user:null,preview:null});await expect(page.getByRole('main',{name:'ECOSYSTEM workspace'})).toHaveCount(0);await expect(page.locator('.official-fuel-table')).toHaveCount(0);
   reports.push({engine,width,theme,status:'passed'});console.log(`PASS official table ${engine} ${width} ${theme}`);
  }finally{await context.close();}
 }}finally{await browser.close();}
}
await writeFile(`${out}/results.json`,JSON.stringify(reports,null,2));
