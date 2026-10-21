import { installEmptyLiveInbox } from './fixtures/empty-live-inbox.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit, expect } from '@playwright/test';
import { installProfileTabMocks } from './fixtures/profile-tabs.mjs';
import { installStagingCookies } from './fixtures/protection-cookies.mjs';

const base = process.env.ECO_SUPPLIER_UI_ORIGIN || 'http://127.0.0.1:4297';
const output = process.env.ECO_SUPPLIER_SPC_OUTPUT || '/private/tmp/eco-supplier-spc-view-screens';
await mkdir(output, { recursive: true });
const user = { id:'10000000-0000-4000-8000-000000000001',email:'supplier-fixture@example.test',displayName:'FIXTURE ADMIN',phone:'',officeId:'HONG KONG',officeName:'HONG KONG',isAdmin:true,isSpcTrader:true,isManager:false,isActive:true,activated:true,passwordChangeSuggested:false,revision:1 };
const record = { id:'90000000-0000-4000-8000-000000000001',legacyIds:[],sourceKey:'BP MARINE',legalName:'BP SINGAPORE PTE. LIMITED',shortName:'BP MARINE',aliases:[],countryCode:'SG',countryName:'Singapore',portName:'Singapore',nameStatus:'verified',legalNameSourceId:null,info:{paymentTerms:'30',qualityClaimBar:'30',supplierTrader:'FIXTURE ADMIN',availableGrade:'HSFO, VLSFO, LSMGO',foBdn:'ISO 8217:2017',goBdn:'ISO 8217:2010'},contacts:[{id:'contact-one',role:'sales',name:'SALES DESK',phone:'+6500000000',email:'',sourceId:'spc'}],barges:[{id:'barge-one',name:'FIXTURE BARGE',imo:'9000001',grade:'VLSFO',capacity:'3,000 MT',sourceId:'spc'}],facts:[],sources:[{id:'spc',type:'spc',title:'SPC supplier database',url:'https://spc.fcuno.com/suppliers',documentDate:'',retrievedAt:'2026-10-15T00:00:00Z'}],revision:1,updatedAt:'2026-10-15T00:00:00Z' };
const seed = [record,
  {...record,id:'90000000-0000-4000-8000-000000000002',sourceKey:'BUNKERHOUSE',legalName:'BUNKER HOUSE PETROLEUM PTE.LTD.',shortName:'BUNKERHOUSE',info:{...record.info,paymentTerms:'14',qualityClaimBar:'21',supplierTrader:'FIXTURE TRADER',availableGrade:'VLSFO',foBdn:'',goBdn:''},contacts:[],barges:[]},
  {...record,id:'90000000-0000-4000-8000-000000000003',sourceKey:'EMPTY SUPPLIER',legalName:'EMPTY SUPPLIER PTE. LTD.',shortName:'EMPTY SUPPLIER',info:{...record.info,paymentTerms:'',qualityClaimBar:'',supplierTrader:'',availableGrade:'',foBdn:'',goBdn:''},contacts:[],barges:[]},
  {...record,id:'90000000-0000-4000-8000-000000000004',sourceKey:'HONG KONG SUPPLIER',legalName:'HONG KONG SUPPLIER LTD.',shortName:'HONG KONG SUPPLIER',countryCode:'HK',countryName:'Hong Kong',portName:'Hong Kong'},
];

async function mock(context, mode = 'admin') {
  const activeUser = {...user,isAdmin:mode==='admin'||mode==='preview',isSpcTrader:mode==='admin'||mode==='spc-trader'};
  const preview = mode==='preview'?{role:'trader',officeId:'HONG KONG',officeName:'HONG KONG',readOnly:true}:null;
  const state = {items:structuredClone(seed),updates:0,requests:[],receipts:new Map(),dropResponse:false};
  await installProfileTabMocks(context,{ownerId:()=>user.id,preview:()=>Boolean(preview),canManageShared:()=>activeUser.isAdmin||activeUser.isSpcTrader});
  await installEmptyLiveInbox(context);
  await context.route('**/api/access/**', route => {
    if (mode==='signed-out') return route.fulfill({status:401,json:{message:'Sign in required.'}});
    const path = new URL(route.request().url()).pathname.split('/api/access/')[1];
    if (path==='session') return route.fulfill({json:{user:activeUser,effectiveUser:activeUser,preview}});
    if (path==='users') return route.fulfill({json:{users:[activeUser],offices:[{id:'HONG KONG',name:'HONG KONG'}]}});
    if (path==='phone-requests') return route.fulfill({json:{requests:[]}});
    return route.fulfill({status:403,json:{message:'Unexpected access request'}});
  });
  await context.route('**/api/admin/**', route => route.fulfill({json:{count:state.updates,previousCount:0,items:[],periodStart:'2026-10-09T00:00:00Z',periodEnd:'2026-10-16T00:00:00Z',timeZone:'Asia/Hong_Kong',source:'shared-contributions'}}));
  await context.route('**/api/supplier-reports/**', route => route.fulfill({json:{items:[]}}));
  await context.route('**/api/suppliers/**', route => {
    const request=route.request(),url=new URL(request.url()),path=url.pathname.split('/api/suppliers/')[1];
    state.requests.push({path,method:request.method(),query:url.search});
    if (path==='pic-options') return route.fulfill({json:{options:['FIXTURE TRADER']}});
    if (path==='list') {
      const items=state.items.filter(item => (!url.searchParams.get('country')||url.searchParams.get('country')===item.countryCode)
        && (!url.searchParams.get('trader')||item.info.supplierTrader.toLowerCase().includes(url.searchParams.get('trader').toLowerCase()))
        && (!url.searchParams.get('grade')||item.info.availableGrade.includes(url.searchParams.get('grade')))
        && (!url.searchParams.get('search')||`${item.legalName} ${item.shortName}`.toLowerCase().includes(url.searchParams.get('search').toLowerCase())));
      return route.fulfill({json:{items:items.map(({contacts,barges,facts,sources,...summary})=>({...summary,contactCount:contacts.length,bargeCount:barges.length})),page:1,pageSize:50,total:items.length}});
    }
    if (path==='detail') return route.fulfill({json:{item:state.items.find(item=>item.id===url.searchParams.get('id'))}});
    if (path==='update') {
      assert.equal(request.headers()['x-eco-request'],'1');
      assert.ok(['admin','spc-trader'].includes(mode),'Read-only roles must never request a supplier write');
      const body=request.postDataJSON(); state.requests.at(-1).body=body;
      if(state.receipts.has(body.requestId)) return route.fulfill({json:state.receipts.get(body.requestId)});
      const index=state.items.findIndex(item=>item.id===body.id);
      assert.equal(body.revision,state.items[index].revision);
      state.items[index]={...state.items[index],info:body.info,contacts:body.contacts,barges:body.barges,revision:body.revision+1};
      state.updates++;
      const response={item:state.items[index]};state.receipts.set(body.requestId,response);
      if(state.dropResponse){state.dropResponse=false;return route.abort('failed');}
      return route.fulfill({json:response});
    }
    return route.fulfill({status:404,json:{message:'Unexpected supplier request'}});
  });
  return state;
}

async function openWorkspace(page) {
  await page.goto(base);
  const nav=page.getByRole('navigation',{name:'Workspace navigation'});
  await nav.getByRole('button',{name:'Ports & Suppliers',exact:true}).click();
  await nav.getByRole('button',{name:'Supplier Profiles',exact:true}).click();
  return page.getByRole('dialog',{name:'Supplier Profiles',exact:true});
}
async function screenshot(page,name,width) {
  await page.screenshot({path:`${output}/${name}.png`,fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,`${name}: page overflow`);
  const boxes=await page.locator('.shared-suppliers,.supplier-quick-view').evaluateAll(nodes=>nodes.filter(node=>node.getBoundingClientRect().height).map(node=>({x:node.getBoundingClientRect().x,right:node.getBoundingClientRect().right})));
  assert.ok(boxes.every(box=>box.x>=-1&&box.right<=width+1),`${name}: panel clipping`);
}
async function picEditor(page,row) {
  await row.getByRole('button',{name:'CHANGE SUPPLIER PIC FOR BP MARINE',exact:true}).click();
  const editor=page.getByRole('dialog',{name:'SUPPLIER PIC',exact:true});
  await expect(editor.getByLabel('SUPPLIER PIC FOR BP MARINE',{exact:true})).toBeVisible();
  return editor;
}
async function refocusSupplierList(page,workspace,state) {
  const query=state.requests.filter(request=>request.path==='list'&&new URLSearchParams(request.query).get('country')==='SG').at(-1).query;
  const completed=page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname==='/api/suppliers/list'&&url.search===query;});
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await completed;
  await expect(workspace.locator('.shared-supplier-table-scroll')).toHaveAttribute('aria-busy','false');
}
const results=[];
for (const [engine,browserType] of [['chromium',chromium],['webkit',webkit]]) {
  if(process.env.ECO_TEST_ENGINE&&process.env.ECO_TEST_ENGINE!==engine) continue;
  const browser=await browserType.launch({headless:true});
  try {
    for (const width of [1440,320,390]) for (const theme of ['light','dark']) {
      if(process.env.ECO_TEST_WIDTH&&+process.env.ECO_TEST_WIDTH!==width) continue;
      if(process.env.ECO_TEST_THEME&&process.env.ECO_TEST_THEME!==theme) continue;
      const context=await browser.newContext({viewport:{width,height:900},isMobile:width<760,hasTouch:width<760,reducedMotion:'reduce'});
      await installStagingCookies(context,base);
      await context.addInitScript(value=>localStorage.setItem('ecosystem.theme.v1',value),theme);
      const state=await mock(context),page=await context.newPage(),errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      const prefix=`${engine}-${width}-${theme}`;
      try {
        const workspace=await openWorkspace(page),table=workspace.getByRole('table',{name:'Supplier results',exact:true});
        await expect(table.locator('thead th')).toHaveCount(1);
        await expect(table.locator('tbody tr')).toHaveCount(4);
        await expect(table.locator('tbody th').first()).toContainText('BP SINGAPORE PTE LIMITED');
        await expect(table.locator('tbody th').nth(1)).toContainText('BUNKER HOUSE PETROLEUM PTE LTD');
        await expect(table.locator('tbody th').first()).toContainText('SPC: BP MARINE');
        await expect(table.locator('tbody th')).not.toContainText(['PTE.','PTE.','PTE.','LTD.']);
        if(width>=760){
          const boxes=await workspace.locator('.shared-supplier-toolbar,.shared-supplier-table-scroll,.shared-supplier-pagination').evaluateAll(nodes=>nodes.map(node=>({left:node.getBoundingClientRect().left,right:node.getBoundingClientRect().right})));
          assert.ok(boxes.every(box=>Math.abs(box.left-boxes[0].left)<=2&&Math.abs(box.right-boxes[0].right)<=2),'Name view toolbar, list and pagination share a reading width');
          assert.ok(boxes[0].right-boxes[0].left<1100,'Name view keeps a centered reading width');
        }
        await screenshot(page,`${prefix}-names`,width);
        await workspace.getByRole('button',{name:'SPC VIEW',exact:true}).click();
        await expect(table.locator('thead th')).toHaveCount(6);
        await expect(table.locator('tbody tr')).toHaveCount(3);
        const first=table.locator('tbody tr').first(),second=table.locator('tbody tr').nth(1),empty=table.locator('tbody tr').nth(2);
        await expect(first.locator('th')).toHaveText('BP MARINE');
        await expect(table).not.toContainText('BP SINGAPORE');
        await expect(table).not.toContainText('SPC:');
        await expect(second.locator('td[data-label="PAYMENT TERMS"] .is-nonstandard')).toHaveText('14');
        await expect(second.locator('td[data-label="QUALITY CLAIM BAR"] .is-nonstandard')).toHaveText('21');
        await expect(first.locator('td[data-label="PAYMENT TERMS"] .is-nonstandard')).toHaveCount(0);
        await expect(empty.locator('td[data-label="PAYMENT TERMS"] .is-nonstandard')).toHaveCount(0);
        await expect(first.locator('.shared-supplier-grades [data-grade]')).toHaveCount(3);
        await expect(second.locator('.shared-supplier-grades [data-grade]')).toHaveCount(3);
        const gradeColours=await first.locator('.shared-supplier-grades [data-grade]').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).backgroundColor));
        assert.equal(new Set(gradeColours).size,3,'HSFO, VLSFO and LSMGO have distinct colour fills');
        await expect(first.getByRole('button',{name:'CONTACT (1)',exact:true})).not.toHaveClass(/is-empty/);
        for(const name of ['BDN','CONTACT (0)','BARGE FLEET (0)','FIXTURES']) await expect(empty.getByRole('button',{name,exact:true})).toHaveClass(/is-empty/);
        if(width>=760)assert.ok((await first.boundingBox()).height<=46,'SPC desktop row remains compact');
        await expect(workspace.getByLabel('Supplier PIC filter',{exact:true})).toBeVisible();
        await expect(workspace.getByLabel('Grade filter',{exact:true})).toBeVisible();
        await screenshot(page,`${prefix}-spc`,width);
        await workspace.getByLabel('Grade filter',{exact:true}).selectOption('HSFO');
        await expect(table.locator('tbody tr')).toHaveCount(1);
        await workspace.getByLabel('Supplier PIC filter',{exact:true}).selectOption('FIXTURE TRADER');
        await expect(table.locator('tbody tr')).toHaveCount(0);
        await expect(workspace.getByText('No suppliers found.',{exact:true})).toBeVisible();
        await workspace.getByLabel('Grade filter',{exact:true}).selectOption('');
        await expect(table.locator('tbody tr')).toHaveCount(1);
        await expect(table).toContainText('BUNKERHOUSE');
        await workspace.getByLabel('Supplier PIC filter',{exact:true}).selectOption('');
        await expect(table.locator('tbody tr')).toHaveCount(3);
        for(const [button,title,text] of [['BDN','BDN','ISO 8217:2017'],['CONTACT (1)','CONTACT','SALES DESK'],['BARGE FLEET (1)','BARGE FLEET','FIXTURE BARGE'],['FIXTURES','FIXTURES','No records match these filters.']]){
          await first.getByRole('button',{name:button,exact:true}).click();
          const quick=page.getByRole('dialog',{name:`BP MARINE · ${title}`,exact:true});
          await expect(quick).toContainText(text);
          await screenshot(page,`${prefix}-quick-${title.toLowerCase().replaceAll(' ','-')}`,width);
          await quick.getByRole('button',{name:'Close dialog',exact:true}).click();
          await expect(table).toBeVisible();
          await expect(workspace.getByRole('button',{name:'SPC VIEW',exact:true})).toHaveAttribute('aria-pressed','true');
        }
        await empty.getByRole('button',{name:'CONTACT (0)',exact:true}).click();
        const emptyQuick=page.getByRole('dialog',{name:'EMPTY SUPPLIER · CONTACT',exact:true});
        await expect(emptyQuick).toBeVisible();
        await emptyQuick.getByRole('button',{name:'Close dialog',exact:true}).click();
        let editor=await picEditor(page,first);
        await expect(editor.getByRole('button',{name:'CONTRIBUTE +1',exact:true})).toBeDisabled();
        await expect(editor.getByLabel('SUPPLIER PIC FOR BP MARINE',{exact:true})).toBeEnabled();
        await expect(editor.getByLabel('SUPPLIER PIC FOR BP MARINE',{exact:true}).locator('option[value="FIXTURE ADMIN"]')).toHaveAttribute('disabled','');
        assert.deepEqual(await editor.getByLabel('SUPPLIER PIC FOR BP MARINE',{exact:true}).locator('option:not(:disabled)').evaluateAll(options=>options.map(option=>option.value)),['','FIXTURE TRADER']);
        await editor.getByLabel('SUPPLIER PIC FOR BP MARINE',{exact:true}).selectOption('FIXTURE TRADER');
        await refocusSupplierList(page,workspace,state);
        await expect(editor).toBeVisible();
        await expect(editor.getByLabel('SUPPLIER PIC FOR BP MARINE',{exact:true})).toHaveValue('FIXTURE TRADER');
        assert.equal(state.updates,0,'Refocus preserves the unsaved selection without writing');
        await screenshot(page,`${prefix}-pic-editor`,width);
        await editor.getByRole('button',{name:'CANCEL',exact:true}).click();
        assert.equal(state.updates,0,'Cancel must not add a contribution');
        await workspace.getByLabel('Supplier PIC filter',{exact:true}).selectOption('FIXTURE ADMIN');
        await expect(table.locator('tbody tr')).toHaveCount(1);
        editor=await picEditor(page,first);
        await expect(editor.getByLabel('SUPPLIER PIC FOR BP MARINE',{exact:true})).toHaveValue('FIXTURE ADMIN');
        await editor.getByLabel('SUPPLIER PIC FOR BP MARINE',{exact:true}).selectOption('FIXTURE TRADER');
        state.dropResponse=true;
        await editor.getByRole('button',{name:'CONTRIBUTE +1',exact:true}).click();
        await expect(editor.getByRole('alert')).toBeVisible();
        assert.equal(state.updates,1,'A lost response may already have committed');
        await refocusSupplierList(page,workspace,state);
        await expect(editor).toBeVisible();
        await expect(editor.getByLabel('SUPPLIER PIC FOR BP MARINE',{exact:true})).toHaveValue('FIXTURE TRADER');
        await expect(editor.getByRole('alert')).toBeVisible();
        await expect(table.locator('tbody tr')).toHaveCount(0);
        await editor.getByRole('button',{name:'CONTRIBUTE +1',exact:true}).click();
        await expect(editor).toHaveCount(0);
        const attempts=state.requests.filter(request=>request.path==='update');
        assert.equal(attempts.length,2);
        assert.equal(new Set(attempts.map(request=>request.body.requestId)).size,1,'Retry reuses the same contribution request');
        await workspace.getByLabel('Supplier PIC filter',{exact:true}).selectOption('');
        await expect(table.locator('tbody tr')).toHaveCount(3);
        await expect(first.locator('td[data-label="SUPPLIER PIC"]')).toContainText('FIXTURE TRADER');
        assert.equal(state.updates,1,'One successful PIC change adds one contribution');
        assert.equal(state.items[0].contacts.length,1,'PIC updates preserve contacts');
        assert.equal(state.items[0].barges.length,1,'PIC updates preserve barges');
        assert.deepEqual(errors,[]);
        results.push({engine,width,theme,mode:'admin',status:'passed'});
        console.log(`PASS ${prefix} admin`);
      }catch(error){await screenshot(page,`${prefix}-FAILURE`,width).catch(()=>{});throw error;}
      finally{await context.close();}
    }
    for (const mode of ['signed-out','trader','preview','spc-trader']) for (const width of mode==='signed-out'?[1440,320,390]:[390]) for (const theme of ['light','dark']) {
      if(process.env.ECO_TEST_THEME&&process.env.ECO_TEST_THEME!==theme) continue;
      const context=await browser.newContext({viewport:{width,height:844},isMobile:width<760,hasTouch:width<760,reducedMotion:'reduce'});
      await installStagingCookies(context,base);
      await context.addInitScript(value=>localStorage.setItem('ecosystem.theme.v1',value),theme);
      const state=await mock(context,mode),page=await context.newPage();
      try{
        if(mode==='signed-out'){
          await page.goto(base);
          await expect(page.getByRole('navigation',{name:'Workspace navigation'})).toHaveCount(0);
          await expect(page.getByLabel('Password',{exact:true})).toBeVisible();
          assert.equal(state.requests.length,0);
        }else{
          const workspace=await openWorkspace(page);
          await workspace.getByRole('button',{name:'SPC VIEW',exact:true}).click();
          const table=workspace.getByRole('table',{name:'Supplier results',exact:true});
          await expect(table.locator('tbody tr')).toHaveCount(3);
          if(mode==='spc-trader'){
            const editor=await picEditor(page,table.locator('tbody tr').first());
            await editor.getByLabel('SUPPLIER PIC FOR BP MARINE',{exact:true}).selectOption('FIXTURE TRADER');
            await editor.getByRole('button',{name:'CONTRIBUTE +1',exact:true}).click();
            await expect(editor).toHaveCount(0);
            assert.equal(state.updates,1);
          }else{
            await expect(table.getByRole('button',{name:/CHANGE SUPPLIER PIC/})).toHaveCount(0);
            await expect(workspace.getByRole('button',{name:'Add supplier',exact:true})).toHaveCount(0);
            await table.locator('tbody tr').first().getByRole('button',{name:'CONTACT (1)',exact:true}).click();
            const quick=page.getByRole('dialog',{name:'BP MARINE · CONTACT',exact:true});
            await expect(quick).toContainText('SALES DESK');
            await expect(quick.getByRole('button',{name:'CONTRIBUTE +1',exact:true})).toHaveCount(0);
            await quick.getByRole('button',{name:'Close dialog',exact:true}).click();
            assert.equal(state.requests.filter(request=>request.method==='POST').length,0);
          }
        }
        await screenshot(page,`${engine}-${width}-${theme}-${mode}`,width);
        results.push({engine,width,theme,mode,status:'passed'});
        console.log(`PASS ${engine} ${theme} ${mode}`);
      }finally{await context.close();}
    }
  }finally{await browser.close();}
}
await writeFile(`${output}/results.json`,JSON.stringify(results,null,2));
console.log(JSON.stringify({passed:results.length,output}));
