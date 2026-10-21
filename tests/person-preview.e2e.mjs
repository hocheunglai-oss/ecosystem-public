import { installSharedLocations, sharedLocations } from './fixtures/shared-locations.mjs';
import { installSharedAttachments } from './fixtures/shared-attachments.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { installEmptyLiveInbox } from './fixtures/empty-live-inbox.mjs';
import { installIntelligence, syntheticIntelligence } from './fixtures/intelligence.mjs';
import { installStagingCookies } from './fixtures/protection-cookies.mjs';
import { invalidateFixtureAuthority } from './fixtures/authority-transition.mjs';

const base=process.env.ECO_PERSON_PREVIEW_ORIGIN||'http://127.0.0.1:4398';
const out=resolve(process.env.ECO_PERSON_PREVIEW_OUTPUT||'/private/tmp/eco-person-preview');
const owner={id:'10000000-0000-4000-8000-000000000001',email:'Admin@example.test',displayName:'REAL ADMIN',phone:'+85200000001',officeId:'HK',officeName:'HONG KONG',isAdmin:true,isManager:false,isSpcTrader:false,isActive:true,activated:true,passwordChangeSuggested:false,revision:1};
const person={...owner,id:'10000000-0000-4000-8000-000000000002',email:'Vincent@example.test',displayName:'VINCENT REAL',isAdmin:false,officeId:'SG',officeName:'SINGAPORE'};
const key=`ecosystem.live.v1:${owner.id}:state:v2`,foreignKey=`ecosystem.live.v1:${person.id}:state`;
const btn=(scope,name)=>scope.getByRole('button',{name,exact:true});
const results=[];
await mkdir(out,{recursive:true});
async function fixture(context){
 const session={user:structuredClone(owner),preview:null},writes=[],reads=[];
 await context.route('**/api/**',route=>{if(route.request().method()!=='GET')writes.push(route.request().url());return route.fulfill({status:404,json:{message:'Isolated fixture only.'}});});
 await installEmptyLiveInbox(context);
 await installSharedLocations(context,{user:()=>session.user,preview:()=>session.preview});
 await installSharedAttachments(context,{user:()=>session.user,preview:()=>session.preview});
 await installIntelligence(context,syntheticIntelligence());
 await context.route('**/api/access/**',route=>{
  const request=route.request(),path=new URL(request.url()).pathname.split('/api/access/')[1];
  reads.push({path,method:request.method(),body:request.postData()});
  const reply=(json,status=200)=>route.fulfill({json,status});
  if(!session.user)return reply({user:null},401);
  if(path==='session')return reply(session);
  if(path==='users')return reply({users:[session.user,person,{...person,id:'inactive',isActive:false}],offices:[{id:'HK',name:'HONG KONG'},{id:'SG',name:'SINGAPORE'}]});
  if(path==='phone-requests')return reply({requests:[]});
  if(path==='preview'){const body=request.postDataJSON();assert.deepEqual(Object.keys(body).sort(),['officeId','role']);session.preview={...body,officeName:body.officeId==='SG'?'SINGAPORE':'HONG KONG',readOnly:true};return reply(session);}
  if(path==='preview/end'){session.preview=null;return reply(session);}
  if(path==='logout'){session.user=null;session.preview=null;return reply({user:null});}
  writes.push(path);return reply({message:'No business writes permitted.'},403);
 });
 await context.route('**/api/admin/**',route=>route.fulfill({json:{items:[],total:0,count:0,periodStart:'2026-10-15T00:00:00Z',periodEnd:'2026-10-22T00:00:00Z',timeZone:'Asia/Hong_Kong',source:'shared-feedback'}}));
 await context.route('**/api/profile-tabs/**',route=>{reads.push({path:new URL(route.request().url()).pathname,method:route.request().method(),body:route.request().postData()});assert.equal(route.request().method(),'GET');return route.fulfill({json:{shared:{revision:0,tabs:[]},private:{revision:0,tabs:[]}}});});
 await context.route('**/api/suppliers/**',route=>route.fulfill({json:{items:[],total:0,page:1,pageSize:50}}));
 return {session,writes,reads};
}
async function seed(page){
 await expect.poll(()=>page.evaluate(key=>Boolean(localStorage.getItem(key)),key)).toBe(true);
 const seeded=await page.evaluate(({key,foreignKey,owner,person})=>{
  const state=JSON.parse(localStorage.getItem(key));
  state.profiles[person.id]={email:person.email,phone:''};
  const award=(id,recipientId)=>({id,targetKey:id,readerId:'luca',recipientId,awardedAt:'2026-10-20T01:00:00Z',target:{kind:'key-info',portId:'port-chiba',field:'sampleLocation'},update:{updatedBy:recipientId,updatedAt:'2026-10-19T01:00:00Z'}});
  state.hats=[award('owner',owner.id),...[0,1,2].map(i=>award(`real-${i}`,person.id)),...[0,1].map(i=>award(`fiction-${i}`,'gianmichele'))];
  state.knowledgeRecords['port:port-chiba']={version:1,layoutVersion:2,sections:[{id:'preview-notes',title:'PREVIEW NOTES',blocks:[
   {id:'selected-note',type:'text',title:'SELECTED PERSON NOTE',text:'THIS IS A SHARED NOTE.',update:{updatedBy:person.id,updatedAt:'2026-10-20T01:00:00Z'}},
   {id:'owner-note',type:'text',title:'ADMIN NOTE',text:'ANOTHER SHARED NOTE.',update:{updatedBy:owner.id,updatedAt:'2026-10-20T01:00:00Z'}}]}]};
  localStorage.setItem(key,JSON.stringify(state));localStorage.setItem(foreignKey,'PRIVATE FOREIGN WORKSPACE MUST NOT BE READ');return state;
 },{key,foreignKey,owner,person});
 sharedLocations(page).seedState(seeded);
 await page.reload({waitUntil:'networkidle'});
}
async function selectPerson(page,id,shot){
 await btn(page,'View as').click();await btn(page,'USER').click();
 const chooser=page.getByRole('combobox',{name:'Preview user',exact:true});await expect(chooser).toBeVisible();
 await chooser.selectOption(id);if(page.viewportSize().width<760)assert.ok((await chooser.boundingBox()).height>=44,'Phone user selector has a 44px target');if(shot)await shot('user-picker');await btn(page,'VIEW AS USER').click();
 await expect(page.getByRole('status',{name:'Role preview'})).toContainText(id===person.id?'VINCENT REAL':id==='gianmichele'?'VINCENT (FICTIONAL)':'USER (FICTIONAL)');
}
for(const [engine,type] of [['chromium',chromium],['webkit',webkit]]){
 if(process.env.ECO_TEST_ENGINE&&process.env.ECO_TEST_ENGINE!==engine)continue;
 const browser=await type.launch({headless:true});
 try{for(const width of [1440,320,390])for(const theme of ['light','dark']){
  if(process.env.ECO_TEST_WIDTH&&+process.env.ECO_TEST_WIDTH!==width||process.env.ECO_TEST_THEME&&process.env.ECO_TEST_THEME!==theme)continue;
  const context=await browser.newContext({viewport:{width,height:width<760?844:1000},isMobile:width<760,hasTouch:width<760,reducedMotion:'reduce'});
  await installStagingCookies(context,base);const f=await fixture(context),page=await context.newPage(),errors=[],shots=[];
  page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(10000);
  await context.addInitScript(theme=>localStorage.setItem('ecosystem.theme.v1',theme),theme);
  const shot=async name=>{const path=resolve(out,`${engine}-${width}-${theme}-${name}.png`);await page.screenshot({path,fullPage:true});shots.push(path);};
  const read=()=>page.evaluate(key=>localStorage.getItem(key),key);
  try{
   await page.goto(base,{waitUntil:'networkidle'});await seed(page);const before=await read();
   await page.locator('[data-resource="activity"]').click();const activity=page.locator('#hud-contribution-activity');
   await expect(activity).toContainText('UPDATE INFORMATION OR SEND FEEDBACK.');await expect(activity.locator('[data-activity-status]')).toHaveAttribute('data-activity-status','inactive');await expect(activity.getByRole('button',{name:/^(EDIT|FEEDBACK)$/i})).toHaveCount(0);await expect(activity).not.toContainText('HONG KONG TIME');await expect(activity).not.toContainText('HOW IT COUNTS');await shot('contribution');await btn(activity,'Close contribution activity').click();
   await selectPerson(page,person.id,shot);assert.equal(f.session.user.id,owner.id);await expect(page.locator('.hud-identity')).toContainText('REAL ADMIN');await expect(page.locator('.hud-resource-hats strong')).toHaveText('3');
   await page.locator('.hud-resource-hats').click();const panel=page.locator('#hud-hats-off');await expect(panel).toContainText('VINCENT REAL');await expect(panel.locator('[data-current-user="true"] .hats-off-name')).toHaveText('VINCENT REAL');await expect(panel.locator('.hats-off-recent-list li')).toHaveCount(3);await shot('real-user');await btn(panel,'Close hats off').click();
   const nav=page.getByRole('navigation',{name:'Workspace navigation'});await btn(nav,'Ports & Suppliers').click();await btn(nav,'Countries & Ports').click();const workspace=page.getByRole('dialog',{name:'Countries & Ports',exact:true});await btn(workspace,'Port Index').click();await workspace.getByLabel('Country or port',{exact:true}).fill('Chiba');await btn(workspace.locator('.location-table'),'Chiba').click();await workspace.getByRole('tab',{name:'PREVIEW NOTES',exact:true}).click();
   const ownNote=workspace.getByRole('article').filter({has:page.getByRole('heading',{name:'SELECTED PERSON NOTE',exact:true})});await expect(ownNote.locator('.knowledge-attribution-name')).toHaveText('VINCENT REAL');await expect(ownNote.getByRole('button',{name:/Hats Off/})).toHaveCount(0);
   const otherNote=workspace.getByRole('article').filter({has:page.getByRole('heading',{name:'ADMIN NOTE',exact:true})});const hat=otherNote.getByRole('button',{name:'Hats Off to REAL ADMIN for ADMIN NOTE',exact:true});await expect(hat).toHaveAttribute('aria-disabled','true');await hat.evaluate(node=>node.click());await expect(workspace.getByRole('button',{name:'EDIT',exact:true})).toHaveCount(0);await shot('read-only-attribution');await btn(workspace,'Close workspace').click();assert.equal(await read(),before);
   await btn(page,'Back to REAL ADMIN').click();await expect(page.locator('.hud-resource-hats strong')).toHaveText('1');
   await selectPerson(page,'gianmichele');await expect(page.locator('.hud-resource-hats strong')).toHaveText('2');await page.locator('.hud-resource-hats').click();await expect(panel).toContainText('VINCENT (FICTIONAL)');await shot('fictional-user');await btn(panel,'Close hats off').click();
   await page.reload({waitUntil:'networkidle'});await expect(page.getByRole('status',{name:'Role preview'})).not.toContainText('VINCENT');await expect(page.locator('.hud-resource-hats strong')).toHaveText('1');await btn(page,'Back to REAL ADMIN').click();
   await selectPerson(page,'preview-user');await expect(page.locator('.hud-resource-hats strong')).toHaveText('0');await btn(page,'Back to REAL ADMIN').click();
   assert.equal(await page.evaluate(key=>localStorage.getItem(key),foreignKey),'PRIVATE FOREIGN WORKSPACE MUST NOT BE READ');assert.equal(await read(),before);assert.deepEqual(f.writes,[]);assert.deepEqual(sharedLocations(page).requests,[],'Display-only preview never writes shared location records');assert.ok(f.reads.every(request=>!request.body?.includes(person.id)),'Target identity is never sent as owner/authentication');
   await selectPerson(page,person.id);f.session.user={...owner,isAdmin:false};f.session.preview=null;await invalidateFixtureAuthority(page,f.session);await expect(btn(page,'View as')).toHaveCount(0);await expect(page.getByRole('status',{name:'Role preview'})).toHaveCount(0);
   await btn(page,'Sign out').click();await expect(btn(page,'Sign in')).toBeVisible();await expect(page.locator('#hud-hats-off')).toHaveCount(0);await expect(btn(page,'View as')).toHaveCount(0);
   assert.deepEqual(errors,[]);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));results.push({engine,width,theme,passed:true,screenshots:shots});console.log(`PASS ${engine} ${width} ${theme}`);
  }catch(error){await shot('failure');throw error;}finally{await context.close();}
 }}finally{await browser.close();}
}
await writeFile(resolve(out,'results.json'),JSON.stringify({base,results,scope:'Synthetic APIs only; real admin identity and private namespace retained; ephemeral person projection affects Hats display/self exclusion only. Native Safari and physical devices untested.'},null,2));
