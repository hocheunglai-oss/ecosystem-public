import { installEmptyLiveInbox } from './fixtures/empty-live-inbox.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit, expect } from '@playwright/test';
import { installProfileTabMocks } from './fixtures/profile-tabs.mjs';
import { installTestWorkspacePolicy, activateTestWorkspace } from './fixtures/test-workspace.mjs';
const base = process.env.ECO_SUPPLIER_GUARD_ORIGIN || 'http://127.0.0.1:4394';
const output = process.env.ECO_SUPPLIER_GUARD_OUTPUT || '/private/tmp/eco-supplier-pic-isolation';
await mkdir(output, { recursive: true });
const otto = { capabilities: { testWorkspace: true, appearancePreview: true }, id:'10000000-0000-4000-8000-000000000001',email:'owner@example.test',displayName:'SAMPLE TRADER',phone:'+6500000000',officeId:'HONG KONG',officeName:'HONG KONG',isAdmin:true,isSpcTrader:true,isManager:false,isActive:true,activated:true,passwordChangeSuggested:false,revision:1 };
const other = {...otto,capabilities: { testWorkspace: false, appearancePreview: false },id:'10000000-0000-4000-8000-000000000002',email:'other@example.test',displayName:'OTHER ADMIN'};
const record = { id:'90000000-0000-4000-8000-000000000001',legacyIds:[],sourceKey:'FIXTURE',legalName:'SUPPLIER FIXTURE PTE LTD',shortName:'FIXTURE',aliases:[],countryCode:'SG',countryName:'Singapore',portName:'Singapore',nameStatus:'verified',legalNameSourceId:null,info:{paymentTerms:'30',qualityClaimBar:'30',supplierTrader:'ORIGINAL PIC',availableGrade:'VLSFO',foBdn:'FO',goBdn:'GO'},contacts:[],barges:[],facts:[],sources:[],revision:1,updatedAt:'2026-10-15T00:00:00Z' };
const results=[];
async function install(context) {
  const state={user:{...otto},preview:null,detailReads:0,detailSettled:0,writes:[],holdDetail:false,holdUpdate:false,releaseDetail:null,releaseUpdate:null,updateSettled:0,dropResponse:false,receipts:new Map(),commits:0};
  await installTestWorkspacePolicy(context);
  await installProfileTabMocks(context,{ownerId:()=>state.user.id,preview:()=>Boolean(state.preview),canManageShared:()=>state.user.isAdmin||state.user.isSpcTrader});
  await context.route('**/api/supplier-reports/**',route=>route.fulfill({json:{items:[]}}));
  await installEmptyLiveInbox(context);
  await context.route('**/api/access/**',route=>{
    const path=new URL(route.request().url()).pathname.split('/api/access/')[1];
    if(path==='preview'){const input=route.request().postDataJSON();state.preview={...input,officeName:input.officeId,readOnly:true};}
    if(path==='preview/end')state.preview=null;
    if(['session','preview','preview/end'].includes(path))return route.fulfill({json:{user:state.user,preview:state.preview}});
    return route.fulfill({json:{users:[state.user],offices:[{id:'HONG KONG',name:'HONG KONG'}],requests:[]}});
  });
  await context.route('**/api/admin/**',route=>route.fulfill({json:{count:0,previousCount:0,items:[],periodStart:'2026-10-09T00:00:00Z',periodEnd:'2026-10-16T00:00:00Z',timeZone:'Asia/Hong_Kong',source:'shared-contributions'}}));
  await context.route('**/api/suppliers/**',async route=>{
    const path=new URL(route.request().url()).pathname.split('/api/suppliers/')[1];
    if(path==='pic-options')return route.fulfill({json:{options:['ORIGINAL PIC','PENDING PIC EDIT']}});
    if(path==='list'){const{contacts,barges,facts,sources,...summary}=record;return route.fulfill({json:{items:[{...summary,contactCount:0,bargeCount:0}],page:1,pageSize:50,total:1}});}
    if(path==='detail'){
      state.detailReads++;if(state.holdDetail)await new Promise(resolve=>{state.releaseDetail=resolve;});
      try{return await route.fulfill({json:{item:record}});}catch(error){if(!route.request().failure())throw error;}finally{state.detailSettled++;}
    }
    if(path==='update'){
      const body=route.request().postDataJSON();state.writes.push(body);
      if(!state.receipts.has(body.requestId)){state.commits++;state.receipts.set(body.requestId,{item:{...record,info:body.info,revision:record.revision+1}});}
      if(state.holdUpdate)await new Promise(resolve=>{state.releaseUpdate=resolve;});
      try{if(state.dropResponse){state.dropResponse=false;return await route.abort('failed');}return await route.fulfill({json:state.receipts.get(body.requestId)});}finally{state.updateSettled++;}
    }
    return route.fulfill({status:404,json:{message:'Unexpected fixture request'}});
  });
  return state;
}
async function openPic(page){
  const nav=page.getByRole('navigation',{name:'Workspace navigation'}),group=nav.getByRole('button',{name:'Ports & Suppliers',exact:true});
  if(await group.getAttribute('aria-expanded')!=='true')await group.click();
  await nav.getByRole('button',{name:'Supplier Profiles',exact:true}).click();
  const workspace=page.getByRole('dialog',{name:'Supplier Profiles',exact:true});
  await workspace.getByRole('button',{name:'SPC VIEW',exact:true}).click();
  await workspace.getByRole('button',{name:'CHANGE SUPPLIER PIC FOR FIXTURE',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'SUPPLIER PIC',exact:true});await expect(dialog).toBeVisible();
  return{workspace,dialog};
}
const toggle=page=>page.locator('.home-display-controls').getByRole('button',{name:'Test data',exact:true});
const focus=page=>page.evaluate(()=>dispatchEvent(new Event('focus')));
for(const[engine,browserType]of[['chromium',chromium],['webkit',webkit]]){
  if(process.env.ECO_TEST_ENGINE&&process.env.ECO_TEST_ENGINE!==engine)continue;
  const browser=await browserType.launch({headless:true});
  try{for(const width of[1440,320,390])for(const theme of['light','dark']){
    if(process.env.ECO_TEST_WIDTH&&+process.env.ECO_TEST_WIDTH!==width||process.env.ECO_TEST_THEME&&process.env.ECO_TEST_THEME!==theme)continue;
    const context=await browser.newContext({viewport:{width,height:1000},isMobile:width<760,hasTouch:width<760,reducedMotion:'reduce'});
    await context.addInitScript(value=>{localStorage.setItem('ecosystem.theme.v1',value);window.__supplierEvents=0;addEventListener('eco-suppliers-updated',()=>window.__supplierEvents++);},theme);
    const state=await install(context);let page=await context.newPage();page.setDefaultTimeout(10000);
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    // Each scenario starts a fresh document while retaining this isolated context's storage.
    // Reloading an active workspace can overlap its focus refresh with document replacement;
    // WebKit reports those cancelled same-origin fetches as access-control pageerrors.
    // The held detail/update races within each scenario remain on the same page below.
    async function resetPage(){
      await page.close();page=await context.newPage();page.setDefaultTimeout(10000);
      page.on('pageerror',error=>errors.push(error.message));await page.goto(base);
    }
    try{
      await page.goto(base);await activateTestWorkspace(page);
      let{workspace,dialog}=await openPic(page);
      await expect(dialog.getByRole('alert')).toContainText('Switch to LIVE to update shared records.');
      await expect(dialog.getByRole('button',{name:'CONTRIBUTE +1',exact:true})).toBeDisabled();
      assert.equal(state.detailReads,0,'TEST must reject before detail GET');assert.equal(state.writes.length,0);
      await page.screenshot({path:`${output}/${engine}-${width}-${theme}-test-blocked.png`,fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      for(const transition of['mode','preview','account']){
        state.user={...otto};state.preview=null;state.holdDetail=true;state.releaseDetail=null;
        await resetPage();await expect(toggle(page)).toBeEnabled();await expect(toggle(page)).toHaveAttribute('aria-pressed','false');
        ({workspace,dialog}=await openPic(page));await expect.poll(()=>Boolean(state.releaseDetail)).toBe(true);
        const settled=state.detailSettled;
        if(transition==='account'){state.user={...other};await focus(page);await expect(page.locator('.hud-identity')).toContainText('OTHER ADMIN');}
        else if(transition==='preview'){state.preview={role:'trader',officeId:'HONG KONG',officeName:'HONG KONG',readOnly:true};await focus(page);await expect(page.getByRole('status',{name:'Role preview'}).first()).toBeVisible();}
        else{await dialog.getByRole('button',{name:'CANCEL',exact:true}).click();await workspace.getByRole('button',{name:'Close workspace',exact:true}).click();await toggle(page).click();await expect(toggle(page)).toHaveAttribute('aria-pressed','true');await toggle(page).click();await expect(toggle(page)).toHaveAttribute('aria-pressed','false');}
        await expect(dialog).toHaveCount(0);state.releaseDetail();await expect.poll(()=>state.detailSettled).toBe(settled+1);
        assert.equal(state.writes.length,0,`${transition}: stale detail callback must never POST`);
      }
      state.user={...otto};state.preview=null;state.holdDetail=false;
      await resetPage();await expect(toggle(page)).toBeEnabled();({dialog}=await openPic(page));
      await dialog.getByLabel('SUPPLIER PIC FOR FIXTURE',{exact:true}).selectOption('PENDING PIC EDIT');
      state.dropResponse=true;await dialog.getByRole('button',{name:'CONTRIBUTE +1',exact:true}).click();await expect(dialog.getByRole('alert')).toBeVisible();
      assert.equal(state.writes.length,1);assert.equal(state.commits,1);
      await focus(page);await expect(dialog.getByLabel('SUPPLIER PIC FOR FIXTURE',{exact:true})).toHaveValue('PENDING PIC EDIT');
      await dialog.getByRole('button',{name:'CONTRIBUTE +1',exact:true}).click();await expect(dialog).toHaveCount(0);
      assert.equal(state.writes.length,2);assert.equal(state.commits,1);assert.deepEqual(state.writes[1],state.writes[0],'Retry retains exact payload/request ID');
      assert.equal(state.writes[0].info.supplierTrader,'PENDING PIC EDIT');
      // An already-sent request may finish after account change; its old completion must not update the new view.
      await resetPage();await expect(toggle(page)).toBeEnabled();({dialog}=await openPic(page));
      await dialog.getByLabel('SUPPLIER PIC FOR FIXTURE',{exact:true}).selectOption('PENDING PIC EDIT');
      state.holdUpdate=true;state.releaseUpdate=null;const settled=state.updateSettled;
      await dialog.getByRole('button',{name:'CONTRIBUTE +1',exact:true}).click();await expect.poll(()=>Boolean(state.releaseUpdate)).toBe(true);
      state.user={...other};await focus(page);await expect(page.locator('.hud-identity')).toContainText('OTHER ADMIN');await expect(dialog).toHaveCount(0);
      state.releaseUpdate();await expect.poll(()=>state.updateSettled).toBe(settled+1);await page.waitForTimeout(100);
      assert.equal(await page.evaluate(()=>window.__supplierEvents),0,'Old completion must not publish refresh events after account change');
      // Switching workspace modes drops the open profile and its unsaved draft.
      // Invoke the existing mode control while the window is open to exercise that boundary.
      state.user={...otto};state.preview=null;state.holdUpdate=false;await resetPage();
      await expect(toggle(page)).toBeEnabled();await page.getByRole('combobox',{name:'Search ECO'}).fill('SUPPLIER FIXTURE');
      await page.getByRole('option').filter({hasText:record.legalName}).click();
      workspace=page.getByRole('dialog',{name:'Supplier Profiles',exact:true});
      await workspace.getByRole('button',{name:'CONTRIBUTE +1',exact:true}).click();
      await workspace.getByLabel('Payment terms',{exact:true}).fill('987');
      const writesBeforeMode=state.writes.length;
      await toggle(page).evaluate(button=>button.click());await expect(toggle(page)).toHaveAttribute('aria-pressed','true');
      await expect(workspace).toHaveCount(0);
      await expect(workspace.getByLabel('Payment terms',{exact:true})).toHaveCount(0);
      await expect(workspace.getByRole('button',{name:'CONTRIBUTE +1',exact:true})).toHaveCount(0);
      await expect(workspace.getByRole('button',{name:'Manage tabs',exact:true})).toHaveCount(0);
      await toggle(page).evaluate(button=>button.click());await expect(toggle(page)).toHaveAttribute('aria-pressed','false');
      await page.getByRole('combobox',{name:'Search ECO'}).fill('SUPPLIER FIXTURE');
      await page.getByRole('option').filter({hasText:record.legalName}).click();
      await workspace.getByRole('button',{name:'CONTRIBUTE +1',exact:true}).click();
      await expect(workspace.getByLabel('Payment terms',{exact:true})).toHaveValue('30');
      assert.equal(state.writes.length,writesBeforeMode,'Changing workspace mode clears a profile draft without writing it');
      await page.screenshot({path:`${output}/${engine}-${width}-${theme}-profile-mode-reset.png`,fullPage:true});
      assert.deepEqual(errors,[]);results.push({engine,width,theme,passed:true});console.log(`PASS ${engine} ${width} ${theme}: TEST guard, stale loads/completion, LIVE receipt retry`);
    }finally{state.releaseDetail?.();state.releaseUpdate?.();await context.close();}
  }}finally{await browser.close();}
}
await writeFile(`${output}/verification.json`,JSON.stringify({base,results,limits:'Isolated browser fixtures only. No external requests or physical devices.'},null,2));
