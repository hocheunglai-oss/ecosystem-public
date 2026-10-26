import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { tsImport } from 'tsx/esm/api';
import { installStagingCookies } from './fixtures/protection-cookies.mjs';
import { locationHistoryPage } from './fixtures/shared-locations.mjs';
import { installEmptyLiveInbox } from './fixtures/empty-live-inbox.mjs';
import { invalidateFixtureAuthority } from './fixtures/authority-transition.mjs';
const domain = await tsImport('./fixtures/shared-location-domain.ts', import.meta.url);
const { handleLocationKnowledge, createLiveState } = domain;
const base = process.env.ECO_SHARED_LOCATION_ORIGIN || 'http://127.0.0.1:4288';
const out = resolve(process.env.ECO_SHARED_LOCATION_OUTPUT || '/private/tmp/eco-shared-location-ui');
const admin = { id:'10000000-0000-4000-8000-000000000001',email:'owner@example.test',displayName:'STORAGE FIXTURE OWNER',phone:'',officeId:'HK',officeName:'HONG KONG',isAdmin:true,isSpcTrader:true,isManager:false,isActive:true,activated:true,passwordChangeSuggested:false,revision:1 };
const colleague = { ...admin,id:'10000000-0000-4000-8000-000000000002',email:'colleague@example.test',displayName:'STORAGE FIXTURE COLLEAGUE',isAdmin:false,isSpcTrader:false };
const sessionId = '10000000-0000-4000-8000-000000000003';
const portKey = 'port:port-singapore';
const button = (scope,name) => scope.getByRole('button',{name,exact:true});
await mkdir(out,{recursive:true});
const results=[];
function database() {
  const snapshot=domain.initialLocationSnapshot();
  snapshot.knowledgeRecords[portKey]={version:26,layoutVersion:2,sections:[{id:'operations',title:'OPERATIONS',blocks:[{id:'operation-note',type:'text',title:'DELIVERY NOTE',text:'ORIGINAL SHARED NOTE'}]}]};
  const document = version => ({version,layoutVersion:2,sections:[{id:'operations',title:'OPERATIONS',blocks:[{id:'operation-note',type:'text',title:'DELIVERY NOTE',text:`ARCHIVED NOTE ${String(version).padStart(4,'0')}`}]}]});
  const history=Array.from({length:25},(_,index)=>({target:{kind:'port',id:'port-singapore'},version:index+1,at:new Date(Date.UTC(2025,0,1,index)).toISOString(),by:admin.id,reason:`SYNTHETIC REVISION ${String(index+1).padStart(4,'0')}`,before:document(index),after:document(index+1)}));
  return {history,contributions:[],publications:[],historyRequests:[],detailReads:[],envelope:{revision:1,snapshot,importedSources:[]},receipts:new Map(),requests:[],dropNextReply:false,rejectWriteStatus:null,unavailable:false,commits:0};
}
async function fixture(context,db,theme,initialUser=admin,legacy) {
  const state={user:initialUser,preview:null};
  await context.addInitScript(({theme,legacy,id})=>{
    localStorage.setItem('ecosystem.theme.v1',theme);
    if(legacy&&!localStorage.getItem(`ecosystem.live.v1:${id}:state`))localStorage.setItem(`ecosystem.live.v1:${id}:state`,JSON.stringify(legacy));
  },{theme,legacy,id:initialUser.id});
  await context.route('**/api/**',route=>route.fulfill({status:404,json:{message:'Unconfigured isolated endpoint.'}}));
  await installEmptyLiveInbox(context);
  await context.route('**/api/access/**',route=>{
    if(!state.user)return route.fulfill({status:401,json:{message:'Sign in required.'}});
    const path=new URL(route.request().url()).pathname.split('/').at(-1);
    return route.fulfill({json:path==='session'?{user:state.user,preview:state.preview}:path==='users'?{users:[admin,colleague],offices:[{id:'HK',name:'HONG KONG'}]}:{requests:[]}});
  });
  await context.route('**/api/enquiries/test-policy',route=>route.fulfill({json:{enabled:false}}));
  await context.route('**/api/admin/**',route=>route.fulfill({json:{items:[],count:0,source:'shared-feedback'}}));
  await context.route('**/api/suppliers/**',route=>route.fulfill({json:{items:[],total:0,page:1,pageSize:100}}));
  await context.route('**/api/official-tables/**',route=>route.fulfill({status:503,json:{message:'No synthetic source configured.'}}));
  await context.route('**/api/profile-tabs/**',route=>{
    const url=new URL(route.request().url());
    return route.fulfill({json:{target:{kind:url.searchParams.get('kind'),id:url.searchParams.get('id')},shared:{revision:0,tabs:[]},private:{revision:0,tabs:[]}}});
  });
  await context.route('**/api/location-knowledge/**',async route=>{
    if(db.unavailable)return route.fulfill({status:503,json:{message:'Shared location information is unavailable.'}});
    const req=route.request(),input=req.method()==='POST'?req.postDataJSON():null;
    if(input)db.requests.push(structuredClone(input));
    if(input&&db.rejectWriteStatus){const status=db.rejectWriteStatus;db.rejectWriteStatus=null;return route.fulfill({status,json:{message:status===401?'Sign in again.':'Access denied.'}});}
    const gateway={cookies:[],currentUser:async()=>state.user,getPreview:async()=>state.preview,
      authenticatedRpc:async(name,args)=>{
        if(name==='eco_location_knowledge_contribution'){db.detailReads.push(args.p_id);const item=db.contributions.find(row=>row.id===args.p_id);if(!item)throw new domain.ApiError(404,'Contribution not found.');return {item:structuredClone(item)};}
        if(name==='eco_location_knowledge_pending'){const all=db.contributions.filter(row=>row.status==='pending').sort((a,b)=>a.id.localeCompare(b.id)),rows=all.filter(row=>!args.p_cursor||row.id>args.p_cursor),items=rows.slice(0,20);return {items,nextCursor:rows.length>items.length?items.at(-1).id:null,total:all.length};}
        if(name==='eco_location_knowledge_publications'){
          if(args.p_revision!==null&&args.p_revision!==db.envelope.revision)throw new domain.ApiError(409,'Activity changed. Reload and try again.');
          const offset=Number(args.p_after??0),items=db.publications.slice(offset,offset+500);
          return {revision:db.envelope.revision,items,nextCursor:offset+items.length<db.publications.length?String(offset+items.length):null,directoryIds:offset===0?[admin.id,colleague.id]:[]};
        }
        if(name==='eco_location_knowledge_history'){db.historyRequests.push(structuredClone(args));return locationHistoryPage(db.history,{targets:args.p_targets,cursor:args.p_cursor===null?null:String(args.p_cursor)});}
        return {envelope:db.envelope,actorId:state.user?.id,sessionId,aal:'aal1'};
      }};
    const key=()=>`${state.user.id}:${input?.requestId}`;
    const store={
      prepare:async()=>{
        const previous=db.receipts.get(key());
        if(previous){assert.deepEqual(previous.input,input,'An ambiguous retry must preserve the entire request');return {result:{...structuredClone(db.envelope),ack:{requestId:input.requestId,committedRevision:previous.committedRevision}}};}
        return {envelope:structuredClone(db.envelope),actor:state.user,contributions:input?.action?.type==='review-contribution'?db.contributions.filter(row=>row.id===input.action.id):[]};
      },
      commit:async(_identity,_revision,operation,body,snapshot,digest,archives)=>{
        assert.equal(body.revision,db.envelope.revision);
        assert.deepEqual(snapshot.knowledgeHistory,[]);assert.deepEqual(snapshot.contributions,[]);
        for(const record of archives.history){const old=db.history.find(row=>row.target.kind===record.target.kind&&row.target.id===record.target.id&&row.version===record.version);if(old)assert.deepEqual(old,record);else db.history.push(structuredClone(record));}
        for(const field of ['contributions','publications'])for(const record of archives[field]){const index=db[field].findIndex(row=>row.id===record.id);if(index<0)db[field].push(structuredClone(record));else db[field][index]=structuredClone(record);}
        db.commits++;
        db.envelope={revision:db.envelope.revision+1,snapshot,importedSources:[...db.envelope.importedSources,...(operation==='migrate'?[{digest,requestId:body.requestId,importedBy:state.user.id,importedAt:new Date().toISOString()}]:[])]};
        db.receipts.set(key(),{input:structuredClone(body),committedRevision:db.envelope.revision});
        return {...db.envelope,ack:{requestId:body.requestId,committedRevision:db.envelope.revision}};
      },
    };
    const headers=new Headers(req.headers()); if(input)headers.set('origin',new URL(base).origin);
    const response=await handleLocationKnowledge(new Request(req.url(),{method:req.method(),headers,...(input?{body:JSON.stringify(input)}:{})}),{origin:new URL(base).origin},gateway,store);
    if(input&&response.ok&&db.dropNextReply){db.dropNextReply=false;return route.abort('failed');}
    return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});
  });
  return state;
}
async function openProfile(page) {
  await page.getByRole('main',{name:'ECOSYSTEM workspace'}).waitFor();
  const nav=page.getByRole('navigation',{name:'Workspace navigation'});
  if(!await button(nav,'Countries & Ports').isVisible())await button(nav,'Ports & Suppliers').click();await button(nav,'Countries & Ports').click();
  const workspace=page.getByRole('dialog',{name:'Countries & Ports',exact:true});
  await expect(workspace.getByText('LOADING SHARED DATA…',{exact:true})).toHaveCount(0);
  await button(workspace,'Port Index').click();await workspace.getByLabel('Country or port',{exact:true}).fill('Singapore');
  await workspace.locator('.location-table').getByRole('button',{name:'Singapore',exact:true}).click();
  const profile=workspace.locator('.knowledge').first();await profile.getByRole('tab',{name:'OPERATIONS',exact:true}).click();
  return {workspace,profile};
}
async function edit(profile,text) {
  await button(profile.locator('.knowledge-content-toolbar'),'EDIT').click();
  const editor=profile.locator('.knowledge-editor');await editor.getByLabel('Block 1 text',{exact:true}).fill(text);return editor;
}
for(const engine of (process.env.ECO_SHARED_LOCATION_ENGINES||'chromium,webkit').split(',')) {
  const browser=await ({chromium,webkit})[engine].launch({headless:true});
  try {for(const width of (process.env.ECO_SHARED_LOCATION_WIDTHS||'1440,320,390').split(',').map(Number))for(const theme of (process.env.ECO_SHARED_LOCATION_THEMES||'light,dark').split(',')) {
    const context=await browser.newContext({viewport:{width,height:1000},isMobile:width<700,hasTouch:width<700,reducedMotion:'reduce'});
    await installStagingCookies(context,base);
    const db=database(),legacy=createLiveState();legacy.locationCountries.push({id:'Canada',name:'Canada'});
    legacy.knowledgeRecords['country:Canada']={version:2,layoutVersion:2,sections:[{id:'legacy-note',title:'LOCAL OPERATIONS',blocks:[{id:'legacy-text',type:'text',title:'LOCAL NOTE',text:'PRESERVE THIS SYNTHETIC BROWSER NOTE'}]}]};
    const session=await fixture(context,db,theme,admin,legacy),page=await context.newPage(),errors=[];
    page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
    const name=`${engine}-${width}-${theme}`,shot=async label=>{
      await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
      return page.screenshot({path:`${out}/${name}-${label}.png`});
    };
    try {
      await page.goto(base);let {workspace,profile}=await openProfile(page);
      const before=await page.evaluate(id=>localStorage.getItem(`ecosystem.live.v1:${id}:state`),admin.id);
      await expect(profile).toContainText('ORIGINAL SHARED NOTE');
      await button(workspace,'REVIEW IMPORT').click();const review=page.getByRole('dialog',{name:'Import browser data',exact:true});
      await review.getByText('Canada · 1 TABS',{exact:true}).click();await expect(review).toContainText('PRESERVE THIS SYNTHETIC BROWSER NOTE');
      if(width<700){
        const comparison=review.getByRole('region',{name:'Change comparison',exact:true});
        await comparison.focus();await expect(comparison).toBeFocused();
        for(let step=0;step<15;step++)await comparison.press('ArrowRight');
        await expect.poll(()=>comparison.evaluate(node=>node.scrollLeft)).toBeGreaterThan(0);
        await expect.poll(()=>comparison.evaluate(node=>{
          const last=node.querySelector('tbody tr:last-child td:last-child')?.getBoundingClientRect();
          return Boolean(last&&last.right<=node.getBoundingClientRect().right+1);
        })).toBe(true);
      }
      await shot('import-review');await button(review,'IMPORT').click();await expect(review).toHaveCount(0);
      assert.equal(db.envelope.snapshot.knowledgeRecords['country:Canada'].version,2);
      assert.equal(await page.evaluate(id=>localStorage.getItem(`ecosystem.live.v1:${id}:state`),admin.id),before,'Original browser archive is byte-for-byte retained');
      assert.equal(db.contributions.length,0,'Import awards no contribution');
      // Server provenance suppresses a completed import even if this browser's
      // optional local completion marker is lost or cleared.
      await page.evaluate(id=>localStorage.removeItem(`ecosystem.live.v1:${id}:location-imported:v1`),admin.id);
      await page.reload();({workspace,profile}=await openProfile(page));
      await expect(button(workspace,'REVIEW IMPORT')).toHaveCount(0);
      let editor=await edit(profile,'SHARED EDIT FROM FIRST ACCOUNT');await button(editor,/^SAVE$/i).click();await expect(editor).toHaveCount(0);
      assert.equal(db.envelope.snapshot.knowledgeRecords[portKey].sections[0].blocks[0].text,'SHARED EDIT FROM FIRST ACCOUNT');
      assert.equal(db.contributions.length,1);
      await shot('saved');
      assert.deepEqual(db.envelope.snapshot.knowledgeHistory,[],'Current reads do not carry before/after archives');
      assert.deepEqual(db.envelope.snapshot.contributions,[],'Current reads do not carry full proposal bodies');
      assert.equal(db.history.length,26,'Older history survives a fresh edit');
      await button(profile,/^History(?: \d+)?$/i).click();
      await expect(profile.locator('.knowledge-history-row')).toHaveCount(20);
      await button(profile,'Load more').click();await expect(profile.locator('.knowledge-history-row')).toHaveCount(26);
      await expect(button(profile,'Load more')).toHaveCount(0);
      await profile.locator('.knowledge-history-row').filter({hasText:'SYNTHETIC REVISION 0001'}).click();
      const historical=page.getByRole('dialog',{name:'History',exact:true});
      await expect(historical).toContainText('ARCHIVED NOTE 0000');await expect(historical).toContainText('ARCHIVED NOTE 0001');await shot('older-history');
      await historical.getByRole('button',{name:'Close dialog',exact:true}).click();await profile.getByRole('button',{name:'Close information panel',exact:true}).click();
      assert.equal(db.historyRequests.length,2);assert.equal(db.historyRequests[0].p_cursor,null);assert.ok(db.historyRequests[1].p_cursor!==null);
      await workspace.getByRole('button',{name:'Close workspace',exact:true}).click();
      await page.getByRole('button',{name:'Settings',exact:true}).click();const settings=page.getByRole('dialog',{name:'Settings',exact:true});
      await button(settings,'Management').click();const performance=settings.getByRole('region',{name:'User contribution performance',exact:true}),ownRow=performance.locator(`[data-performance-user="${admin.id}"]`);
      await expect(ownRow.locator('[data-label="CONTRIBUTIONS"]')).toHaveText('1');
      await ownRow.getByRole('button',{name:`View contribution records for ${admin.displayName}`,exact:true}).click();
      const ownRecords=performance.getByRole('region',{name:`Contribution records for ${admin.displayName}`,exact:true});
      await ownRecords.locator('summary').filter({hasText:/^View update$/i}).click();
      await expect(ownRecords.locator('.activity-publication')).toContainText('SHARED EDIT FROM FIRST ACCOUNT');
      assert.deepEqual(db.detailReads,[db.contributions[0].id],'Activity details fetch the original proposal only when expanded');await shot('contribution-original-detail');
      await settings.getByRole('button',{name:'Close workspace',exact:true}).click();({workspace,profile}=await openProfile(page));


      // A commit can succeed even when its HTTP response is lost. The explicit
      // retry must return that result without another revision or award.
      editor=await edit(profile,'ACKNOWLEDGED AFTER RETRY');db.dropNextReply=true;
      await button(editor,/^SAVE$/i).click();await expect(editor.getByLabel('Block 1 text',{exact:true})).toHaveValue('ACKNOWLEDGED AFTER RETRY');
      await expect(button(workspace,'RETRY SAVE')).toBeEnabled();const committed=db.commits;
      const unresolved=await page.evaluate(id=>localStorage.getItem(`ecosystem.live.v1:${id}:location-pending:v1`),admin.id);
      for(const status of [401,403]){
        db.rejectWriteStatus=status;await button(editor,/^SAVE$/i).click();
        await expect(button(workspace,'RETRY SAVE')).toBeEnabled();
        assert.equal(await page.evaluate(id=>localStorage.getItem(`ecosystem.live.v1:${id}:location-pending:v1`),admin.id),unresolved,'Auth failures cannot discard an unresolved committed request');
      }
      await button(editor,/^SAVE$/i).click();await expect(editor).toHaveCount(0);assert.equal(db.commits,committed);
      for(const retry of db.requests.slice(-4))assert.deepEqual(retry,JSON.parse(unresolved));
      // Another account uses a fresh context, with no source browser data.
      const other=await browser.newContext({viewport:{width,height:1000},isMobile:width<700,hasTouch:width<700,reducedMotion:'reduce'});
      await installStagingCookies(other,base);await fixture(other,db,theme,colleague);const otherPage=await other.newPage();
      await otherPage.goto(base);const otherView=await openProfile(otherPage);await expect(otherView.profile).toContainText('ACKNOWLEDGED AFTER RETRY');
      await other.close();
      editor=await edit(profile,'UNSAVED CONFLICT DRAFT');db.envelope.revision++;
      db.envelope.snapshot.knowledgeRecords[portKey].version++;
      db.envelope.snapshot.knowledgeRecords[portKey].sections[0].blocks[0].text='CONCURRENT SHARED VALUE';
      await button(editor,/^SAVE$/i).click();await expect(editor.getByLabel('Block 1 text',{exact:true})).toHaveValue('UNSAVED CONFLICT DRAFT');
      await expect(editor.getByRole('alert')).toContainText(/changed|review/i);await shot('conflict-preserves-draft');
      assert.equal(db.envelope.snapshot.knowledgeRecords[portKey].sections[0].blocks[0].text,'CONCURRENT SHARED VALUE');
      assert.equal(await page.evaluate(id=>localStorage.getItem(`ecosystem.live.v1:${id}:state`),admin.id),before);
      assert.ok(await workspace.evaluate(node=>node.scrollWidth<=node.clientWidth+1),'No horizontal workspace overflow');
      page.once('dialog',dialog=>dialog.accept());await page.reload();({workspace,profile}=await openProfile(page));
      // Deliver authority changes through the application's cross-tab session
      // refresh, allowing its effects to abort old activity reads before the
      // account view unmounts. Reloads above still verify persisted data; tearing
      // down the document here would bypass the cleanup this assertion covers.
      session.preview={role:'trader',officeId:'HK',officeName:'HONG KONG',readOnly:true};await invalidateFixtureAuthority(page,session);({workspace,profile}=await openProfile(page));
      await expect(button(profile.locator('.knowledge-content-toolbar'),'EDIT')).toHaveCount(0);await shot('preview-read-only');
      session.user=null;await invalidateFixtureAuthority(page,session);await expect(page.getByRole('main',{name:'ECOSYSTEM workspace'})).toHaveCount(0);await expect(page.locator('.access-login')).toBeVisible();await shot('signed-out');
      assert.deepEqual(errors,[]);
      // Each archive fits independently, while their safe combined import does
      // not. Rendering that review must stay usable and retain the raw archive.
      const capacityContext=await browser.newContext({viewport:{width,height:1000},isMobile:width<700,hasTouch:width<700,reducedMotion:'reduce'});
      try {
        await installStagingCookies(capacityContext,base);
        const capacityDb=database(),capacityLegacy=createLiveState();
        capacityDb.envelope.snapshot.ports.push({...capacityDb.envelope.snapshot.ports[0],id:'port-shared-capacity',name:'SHARED CAPACITY FIXTURE',notes:Array.from({length:100},()=> 's'.repeat(20_000))});
        capacityLegacy.ports.push({...capacityLegacy.ports[0],id:'port-local-capacity',name:'LOCAL CAPACITY FIXTURE',notes:Array.from({length:100},()=> 'l'.repeat(20_000))});
        await fixture(capacityContext,capacityDb,theme,admin,capacityLegacy);const capacityPage=await capacityContext.newPage(),capacityErrors=[];
        capacityPage.on('pageerror',error=>capacityErrors.push(error.message));await capacityPage.goto(base);
        const capacityView=await openProfile(capacityPage),capacityBefore=await capacityPage.evaluate(id=>localStorage.getItem(`ecosystem.live.v1:${id}:state`),admin.id);
        await expect(capacityView.workspace.getByRole('alert')).toContainText(/too large/);
        await button(capacityView.workspace,'REVIEW IMPORT').click();const capacityReview=capacityPage.getByRole('dialog',{name:'Import browser data',exact:true});
        await expect(button(capacityReview,'IMPORT')).toBeDisabled();await expect(button(capacityReview,'CLOSE')).toBeEnabled();
        assert.ok(await capacityReview.evaluate(node=>node.scrollWidth<=node.clientWidth+1),'Capacity review wraps on narrow screens');
        await expect(capacityPage.locator('html')).toHaveAttribute('data-theme',theme);
        await capacityPage.screenshot({path:`${out}/${name}-capacity-error.png`});
        assert.equal(await capacityPage.evaluate(id=>localStorage.getItem(`ecosystem.live.v1:${id}:state`),admin.id),capacityBefore);
        assert.equal(capacityDb.commits,0);assert.deepEqual(capacityErrors,[]);
      }finally{await capacityContext.close();}
      results.push({name,passed:true,commits:db.commits});
    } catch(error){await shot('failure').catch(()=>{});throw error;}finally{await context.close();}
  }}finally{await browser.close();}
}
await writeFile(`${out}/results.json`,JSON.stringify(results,null,2));console.log(JSON.stringify(results));
