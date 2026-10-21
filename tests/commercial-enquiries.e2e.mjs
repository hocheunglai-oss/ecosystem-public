import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { installStagingCookies } from './fixtures/protection-cookies.mjs';
const base = process.env.ECO_COMMERCIAL_UI_ORIGIN || 'http://127.0.0.1:4396';
const out = resolve(process.env.ECO_COMMERCIAL_UI_OUTPUT || 'output/commercial-enquiries-ui');
const owner = { capabilities: { appearancePreview: true, testWorkspace: true }, id:'10000000-0000-4000-8000-000000000001',email:'owner@example.test',displayName:'SAMPLE TRADER',officeId:'HONG KONG',officeName:'HONG KONG',isAdmin:true,isSpcTrader:true,isManager:false,isActive:true,activated:true,passwordChangeSuggested:false,revision:1 };
const other = { ...owner, capabilities: undefined, id:'10000000-0000-4000-8000-000000000002',email:'other@example.test',displayName:'OTHER TRADER',isAdmin:false,isSpcTrader:false };
const longVessel='ECO QUEUE 2284799DBE84D35460316D6A4FF11566592A800EE9B79056112565ADB6E0B8357780 DRAFT';
const reviewedVessel=longVessel.replace('DRAFT','CONFIRMED');
const otherVessel=longVessel.replace('DRAFT','OTHER QUEUED VESSEL');
const raw = `VESSEL: SHARED FIXTURE\nPORT: SINGAPORE\nETA: 25 OCT 2026\nVLSFO: 450 MT\nRMK 180 CST\nLSMGO: 40 CBM`;
const receipt = { id:'20000000-0000-4000-8000-000000000001',providerMessageId:'synthetic-provider-id',channel:'whatsapp',owner:owner.id,sender:'Fixture Sender',rawText:raw,receivedAt:'2026-10-20T04:00:00Z',read:true,dismissed:false };
const generation = '30000000-0000-4000-8000-000000000001';
const sg = { id:'port-singapore',countryCode:'SG',countryName:'Singapore',portName:'Singapore' };
const results=[];
await mkdir(out,{recursive:true});
function summary(item) { const {source,reviewed,...row}=item; return row; }
async function fixture(context, records=new Map(), operations=new Map()) {
  const state={user:owner,preview:null,records,operations,calls:[],writes:[],failNext:false,conflictNext:false,hold:null,holdDetail:null};
  await context.route('**/api/**',async route=>{
    const req=route.request(),url=new URL(req.url()),body=req.method()==='POST'?req.postDataJSON():null;
    if(url.pathname==='/api/access/session')return route.fulfill(state.user?{json:{user:state.user,preview:state.preview}}:{status:401,json:{message:'Sign in required.'}});
    if(url.pathname==='/api/enquiries/test-policy')return route.fulfill({json:{enabled:true,generation}});
    if(url.pathname.startsWith('/api/profile-tabs/'))return route.fulfill({json:{target:{kind:url.searchParams.get('kind'),id:url.searchParams.get('id')},shared:{revision:0,tabs:[]},private:{revision:0,tabs:[]}}});
    if(url.pathname==='/api/enquiries/inbox')return route.fulfill({json:{items:state.user?.id===owner.id&&!state.preview?[receipt]:[],nextCursor:null,unreadCount:0}});
    if(url.pathname==='/api/enquiries/records') {
      assert.equal(req.headers()['x-eco-data-mode'],'live');state.calls.push(url.search);
      if(!state.user||state.preview)return route.fulfill({status:403,json:{message:'Unavailable in preview.'}});
      if(body) {
        state.writes.push(structuredClone(body));assert.equal(req.headers()['x-eco-request'],'1');assert.equal(body.dataMode,'live');
        let response=operations.get(body.requestId);
        if(!response) {
          const prior=records.get(body.id);
          if(state.conflictNext){state.conflictNext=false;prior.revision++;prior.reviewed.formattedText=prior.reviewed.formattedText.replace(prior.vessel,reviewedVessel);prior.reviewed.vessel=reviewedVessel;prior.vessel=reviewedVessel;}
          if((prior?.revision??0)!==body.expectedRevision)return route.fulfill({status:409,json:{message:'Enquiry changed. Load the latest revision.'}});
          const duplicate=[...records.values()].find(item=>body.source.inboxId&&item.source.inboxId===body.source.inboxId&&item.id!==body.id);
          if(duplicate)return route.fulfill({status:409,json:{message:'Receipt already saved.'}});
          if(prior)assert.deepEqual(body.source,prior.source,'Source must remain immutable');
          const stamp='2026-10-20T05:00:00Z';
          const item={id:body.id,reference:prior?.reference??'ECO-0001',ownerId:state.user.id,ownerName:state.user.displayName,
            revision:body.expectedRevision+1,status:body.action==='confirm'?'confirmed':'draft',source:body.source,reviewed:body.reviewed,
            vessel:body.reviewed.vessel,imo:body.reviewed.imo,eta:body.reviewed.eta,products:body.reviewed.products,port:body.reviewed.portId===sg.id?sg:null,
            queue:body.action==='confirm'&&body.reviewed.portId===sg.id?{status:'awaiting_connection',queuedAt:stamp}:null,
            createdAt:prior?.createdAt??stamp,updatedAt:stamp,confirmedAt:body.action==='confirm'?stamp:null};
          records.set(item.id,structuredClone(item));response={requestId:body.requestId,item:structuredClone(item)};operations.set(body.requestId,response);
        }
        if(state.failNext){state.failNext=false;return route.abort('failed');}
        return route.fulfill({json:response});
      }
      let response;
      if(url.searchParams.has('id')) {
        const item=records.get(url.searchParams.get('id'));
        if(item?.ownerId!==state.user.id)return route.fulfill({status:404,json:{message:'Enquiry not found.'}});
        response={item:structuredClone(item)};
        if(state.holdDetail){const hold=state.holdDetail;state.holdDetail=null;await hold();}
      } else if(url.searchParams.has('inboxId')) {
        response={item:structuredClone([...records.values()].find(item=>item.ownerId===state.user.id&&item.source.inboxId===url.searchParams.get('inboxId'))??null)};
      } else {
        const queue=url.searchParams.get('scope')==='singapore';
        if(queue&&!state.user.isAdmin&&!state.user.isSpcTrader)return route.fulfill({status:403,json:{message:'Access denied.'}});
        response={items:[...records.values()].filter(item=>queue?Boolean(item.queue):item.ownerId===state.user.id).map(summary),nextCursor:null};
      }
      if(state.hold){const hold=state.hold;state.hold=null;await hold();}
      return route.fulfill({json:response}).catch(()=>{});
    }
    if(url.pathname.startsWith('/api/access/'))return route.fulfill({json:{requests:[],users:[state.user],offices:[{id:'HONG KONG',name:'HONG KONG'}]}});
    return route.fulfill({json:{count:0,items:[],nextCursor:null,page:1,pageSize:100,total:0,periodStart:'2026-10-14T00:00:00Z',periodEnd:'2026-10-21T00:00:00Z',timeZone:'Asia/Hong_Kong',source:'shared-feedback'}});
  });
  return state;
}
async function openEnquiry(page){
  const nav=page.getByRole('navigation',{name:'Workspace navigation'}),group=nav.getByRole('button',{name:'Trading',exact:true});
  if(await group.getAttribute('aria-expanded')!=='true')await group.click();
  await nav.getByRole('button',{name:'Enquiries',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Enquiries',exact:true});await expect(dialog).toBeVisible();return dialog;
}
async function assertCardText(card, vessel){
  await expect(card.locator('strong')).toHaveText(vessel);
  assert.ok(await card.evaluate(row=>{
    const bounds=row.getBoundingClientRect(),walker=document.createTreeWalker(row,NodeFilter.SHOW_TEXT),boxes=[];
    while(walker.nextNode())if(walker.currentNode.textContent.trim()){
      const range=document.createRange();range.selectNodeContents(walker.currentNode);
      boxes.push(...[...range.getClientRects()].filter(box=>box.width>0&&box.height>0));
    }
    return boxes.every((a,index)=>a.left>=bounds.left-1&&a.right<=bounds.right+1&&a.top>=bounds.top-1&&a.bottom<=bounds.bottom+1&&boxes.slice(index+1).every(b=>Math.min(a.right,b.right)-Math.max(a.left,b.left)<=1||Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)<=1));
  }),'Full vessel, reference and status text must fit inside the card without overlap');
}
for(const [engine,kind] of [['chromium',chromium],['webkit',webkit]]){
  if(process.env.ECO_TEST_ENGINE&&process.env.ECO_TEST_ENGINE!==engine)continue;
  const browser=await kind.launch({headless:true});
  try{for(const width of [1440,320,390])for(const theme of ['light','dark']){
    if(process.env.ECO_TEST_WIDTH&&Number(process.env.ECO_TEST_WIDTH)!==width||process.env.ECO_TEST_THEME&&process.env.ECO_TEST_THEME!==theme)continue;
    const settings={viewport:{width,height:1000},isMobile:width<760,hasTouch:width<760,colorScheme:theme,reducedMotion:'reduce'};
    const context=await browser.newContext(settings);await installStagingCookies(context,base);
    const state=await fixture(context),page=await context.newPage(),errors=[];
    page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(theme=>localStorage.setItem('ecosystem.theme.v1',theme),theme);
    const shot=async name=>{assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No horizontal page overflow');await page.screenshot({path:resolve(out,`${engine}-${width}-${theme}-${name}.png`),fullPage:true,animations:'disabled'});};
    try{
      await page.goto(base,{waitUntil:'domcontentloaded'});let dialog=await openEnquiry(page);
      await dialog.locator(`[data-incoming-id="${receipt.id}"]`).getByRole('button').click();
      const rawInput=dialog.getByLabel('Raw enquiry',{exact:true});
      await expect(rawInput).toHaveValue(raw);await expect(rawInput).toHaveAttribute('readonly','');
      // Unsupported CBM keeps source cautions; the trader supplies reviewed MT.
      await dialog.getByLabel('VLSFO',{exact:true}).fill('450');
      // Keep the raw parse fixture stable; this is the trader-reviewed vessel name.
      await dialog.getByLabel('Vessel',{exact:true}).fill(longVessel);
      await expect(dialog.getByRole('button',{name:'Send to SPC',exact:true})).toBeEnabled();
      await expect(dialog.getByLabel('Buyer',{exact:true})).toHaveValue('');
      await expect(dialog.locator('.enquiry-review')).toContainText('CBM');
      await expect(dialog.locator('.enquiry-review')).not.toContainText('Select an entity');
      await dialog.getByRole('textbox',{name:'Remarks',exact:true}).fill('REVIEWED REMARK');
      state.failNext=true;await dialog.getByRole('button',{name:'Save draft',exact:true}).click();
      await expect(dialog.getByRole('alert')).toContainText(/fetch|load|network|saved/i);
      await dialog.getByRole('button',{name:'Save draft',exact:true}).click();
      await expect.poll(()=>state.writes.length).toBe(2);assert.equal(state.writes[0].requestId,state.writes[1].requestId);
      assert.equal(state.records.size,1);const id=state.writes[0].id;
      await expect(dialog.getByRole('button',{name:'Save draft',exact:true})).toBeEnabled();
      await expect(dialog.getByRole('alert')).toHaveCount(0);
      await assertCardText(dialog.locator(`[data-commercial-id="${id}"]`),longVessel);
      await dialog.locator(`[data-commercial-id="${id}"]`).scrollIntoViewIfNeeded();await shot('saved-draft');
      assert.equal(state.records.get(id).source.rawText,raw);assert.equal(state.records.get(id).reviewed.remarks,'REVIEWED REMARK');
      assert.equal(state.records.get(id).reviewed.buyerId,null);
      assert.ok(state.records.get(id).reviewed.warnings.some(value=>value.includes('CBM')));
      assert.ok(await page.evaluate(id=>!Object.keys(localStorage).some(key=>localStorage.getItem(key)?.includes(id)),id),'No LIVE record persisted locally');

      await page.reload({waitUntil:'domcontentloaded'});dialog=await openEnquiry(page);
      await dialog.locator(`[data-incoming-id="${receipt.id}"]`).getByRole('button').click();
      await expect(dialog.getByRole('textbox',{name:'Remarks',exact:true})).toHaveValue('REVIEWED REMARK');
      await expect(dialog.getByLabel('Raw enquiry',{exact:true})).toHaveValue(raw);
      assert.ok(state.calls.some(query=>query.includes('inboxId=')),'Receipt lookup survives reload independently of paging');
      state.conflictNext=true;await dialog.getByLabel('Vessel',{exact:true}).fill('UNSAVED CHANGE');
      await dialog.getByRole('button',{name:'Save draft',exact:true}).click();
      await expect(dialog.getByRole('alert')).toContainText('Enquiry changed');
      await expect(dialog.getByLabel('Vessel',{exact:true})).toHaveValue('UNSAVED CHANGE');
      await dialog.getByRole('button',{name:'Load latest',exact:true}).click();
      await dialog.getByRole('button',{name:'Keep editing',exact:true}).click();
      await expect(dialog.getByLabel('Vessel',{exact:true})).toHaveValue('UNSAVED CHANGE');
      await dialog.getByRole('button',{name:'Load latest',exact:true}).click();
      await dialog.getByRole('button',{name:'Discard and load latest',exact:true}).click();
      await expect(dialog.getByLabel('Vessel',{exact:true})).toHaveValue(reviewedVessel);
      await dialog.getByRole('button',{name:'Send to SPC',exact:true}).click();
      await expect(dialog.getByRole('button',{name:'Save draft',exact:true})).toBeDisabled();
      await expect(dialog).toContainText('Awaiting connection');
      await expect(dialog.getByLabel('Vessel',{exact:true})).toBeDisabled();
      assert.equal(state.records.get(id).status,'confirmed');assert.equal(state.records.size,1);
      await assertCardText(dialog.locator(`[data-commercial-id="${id}"]`),reviewedVessel);
      await dialog.locator(`[data-commercial-id="${id}"]`).scrollIntoViewIfNeeded();await shot('confirmed');
      const otherId='40000000-0000-4000-8000-000000000002';
      state.records.set(otherId,{...structuredClone(state.records.get(id)),id:otherId,ownerId:other.id,ownerName:other.displayName,vessel:otherVessel,reviewed:{...state.records.get(id).reviewed,buyerText:'PRIVATE BUYER',remarks:'PRIVATE REMARK'},source:{...state.records.get(id).source,rawText:'PRIVATE SOURCE'}});
      await dialog.getByRole('button',{name:'Singapore queue',exact:true}).click();
      await expect(dialog.locator(`[data-commercial-id="${otherId}"]`)).toContainText(otherVessel);
      await expect(dialog.locator(`[data-commercial-id="${otherId}"]`).getByRole('button')).toHaveCount(0);
      await assertCardText(dialog.locator(`[data-commercial-id="${otherId}"]`),otherVessel);
      await expect(dialog).not.toContainText('PRIVATE SOURCE');await expect(dialog).not.toContainText('PRIVATE BUYER');await expect(dialog).not.toContainText('PRIVATE REMARK');
      await dialog.locator(`[data-commercial-id="${otherId}"]`).scrollIntoViewIfNeeded();await shot('singapore-queue');

      // Revoking queue access on the same account also clears its previously loaded rows.
      state.user={...owner,isAdmin:false,isSpcTrader:false};
      await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
      await expect(page.getByRole('complementary',{name:'Your dashboard'})).not.toContainText('Admin');
      if(!await dialog.isVisible())dialog=await openEnquiry(page);
      await expect(dialog.getByRole('button',{name:'Singapore queue',exact:true})).toHaveCount(0);
      await expect(dialog.locator(`[data-commercial-id="${otherId}"]`)).toHaveCount(0);
      await expect(dialog.locator(`[data-commercial-id="${id}"]`)).toBeVisible();
      state.user=owner;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
      await expect(page.getByRole('complementary',{name:'Your dashboard'})).toContainText('Admin');
      if(!await dialog.isVisible())dialog=await openEnquiry(page);

      // New isolated context shares only the server fixture, never browser storage.
      const device=await browser.newContext(settings);await installStagingCookies(device,base);
      await fixture(device,state.records,state.operations);const second=await device.newPage();
      await second.goto(base,{waitUntil:'domcontentloaded'});const secondDialog=await openEnquiry(second);
      await secondDialog.locator(`[data-commercial-id="${id}"]`).getByRole('button').click();
      await expect(secondDialog.getByLabel('Vessel',{exact:true})).toHaveValue(reviewedVessel);
      await expect(secondDialog).toContainText('Awaiting connection');await device.close();

      // A manual first save may commit before the response is lost. Selecting another
      // enquiry and returning must preserve both the record and operation identities.
      await dialog.getByRole('button',{name:'My enquiries',exact:true}).click();
      await dialog.locator(`[data-commercial-id="${id}"]`).getByRole('button').click();
      await expect(dialog.getByLabel('Vessel',{exact:true})).toHaveValue(reviewedVessel);
      await dialog.getByRole('button',{name:'Clear parser',exact:true}).click();
      const manualRaw='VESSEL: MANUAL RETRY\nPORT: SINGAPORE\nETA: 25 OCT 2026\nVLSFO: 600 MT';
      await dialog.getByLabel('Raw enquiry',{exact:true}).fill(manualRaw);
      await expect(dialog.getByLabel('Vessel',{exact:true})).toHaveValue('MANUAL RETRY');
      state.failNext=true;await dialog.getByRole('button',{name:'Save draft',exact:true}).click();
      await expect(dialog.getByRole('alert')).toContainText(/fetch|load|network|saved/i);
      const uncertain=structuredClone(state.writes.at(-1)),recordCount=state.records.size;
      assert.equal(uncertain.source.inboxId,null);
      await dialog.locator(`[data-commercial-id="${id}"]`).getByRole('button').click();
      await expect(dialog.getByLabel('Vessel',{exact:true})).toHaveValue(reviewedVessel);
      await dialog.locator('[data-draft-id]').getByRole('button',{name:'Open MANUAL RETRY',exact:true}).click();
      await expect(dialog.getByLabel('Raw enquiry',{exact:true})).toHaveValue(manualRaw);
      await dialog.getByRole('button',{name:'Save draft',exact:true}).click();
      await expect(dialog.locator(`[data-commercial-id="${uncertain.id}"]`)).toBeVisible();
      assert.deepEqual(state.writes.at(-1),uncertain,'Retry after remount preserves the exact request body and identities');
      assert.equal(state.records.size,recordCount,'An uncertain manual save cannot create a duplicate');

      // A late old-owner detail response must not repopulate the next account's UI.
      let releaseDetail,detailStarted=false;
      state.holdDetail=()=>{detailStarted=true;return new Promise(resolve=>{releaseDetail=resolve;});};
      await dialog.locator(`[data-commercial-id="${id}"]`).getByRole('button').click();
      await expect.poll(()=>detailStarted).toBe(true);
      state.user=other;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
      await expect(page.getByRole('complementary',{name:'Your dashboard'})).toContainText('OTHER TRADER');
      dialog=await openEnquiry(page);
      await expect(dialog.locator(`[data-commercial-id="${otherId}"]`)).toBeVisible();
      await expect(dialog.locator(`[data-commercial-id="${id}"]`)).toHaveCount(0);
      releaseDetail();
      await expect(dialog.getByLabel('Raw enquiry',{exact:true})).toHaveValue('');
      await expect(dialog.getByLabel('Vessel',{exact:true})).toHaveValue('');

      state.user=other;await page.reload({waitUntil:'domcontentloaded'});dialog=await openEnquiry(page);
      await expect(dialog.getByRole('button',{name:'Singapore queue',exact:true})).toHaveCount(0);
      await expect(dialog.locator(`[data-commercial-id="${id}"]`)).toHaveCount(0);
      await expect(dialog.locator(`[data-commercial-id="${otherId}"]`)).toBeVisible();
      state.user=owner;state.preview={role:'trader',officeId:'HONG KONG',officeName:'HONG KONG',readOnly:true};
      await page.reload({waitUntil:'domcontentloaded'});const beforePreview=state.calls.length;dialog=await openEnquiry(page);
      await expect(dialog.getByLabel('Raw enquiry',{exact:true})).toBeDisabled();await expect(dialog.locator('[data-commercial-id]')).toHaveCount(0);
      assert.equal(state.calls.length,beforePreview);
      state.preview=null;await page.reload({waitUntil:'domcontentloaded'});
      const test=page.locator('.home-display-controls').getByRole('button',{name:'Test data',exact:true});await expect(test).toBeEnabled();await test.click();
      const beforeTest=state.calls.length;dialog=await openEnquiry(page);await expect(dialog.getByRole('button',{name:'Save draft',exact:true})).toHaveCount(0);
      await expect(dialog.locator('[data-commercial-id]')).toHaveCount(0);assert.equal(state.calls.length,beforeTest);
      state.user=null;await page.reload({waitUntil:'domcontentloaded'});await expect(page.getByRole('button',{name:'Sign in',exact:true})).toBeVisible();
      assert.deepEqual(errors,[]);results.push({engine,width,theme,ok:true});console.log(`PASS ${engine} ${width} ${theme}`);
    }catch(error){await shot('failure').catch(()=>{});throw error;}finally{await context.close();}
  }}finally{await browser.close();}
}
await writeFile(resolve(out,'results.json'),JSON.stringify({base,results,scope:'Hosted/local UI with synthetic API fixture. Draft/exact manual retry after remount/conflict/reload/device/late account response/same-account permission revocation, long-name text bounds/non-overlap, Singapore queue projection and owner/TEST/VIEW AS boundaries. Actual API/database verification is separate.'},null,2));
