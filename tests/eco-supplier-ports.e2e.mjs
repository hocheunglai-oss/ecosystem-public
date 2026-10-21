import { installEmptyLiveInbox } from './fixtures/empty-live-inbox.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit, expect } from '@playwright/test';
import { installProfileTabMocks } from './fixtures/profile-tabs.mjs';
import { installStagingCookies } from './fixtures/protection-cookies.mjs';

const base = process.env.ECO_SUPPLIER_UI_ORIGIN || 'http://127.0.0.1:4306';
const output = process.env.ECO_SUPPLIER_PORT_OUTPUT || '/private/tmp/eco-supplier-port-screens';
await mkdir(output, { recursive: true });
const user = { id:'10000000-0000-4000-8000-000000000001',email:'supplier-fixture@example.test',displayName:'FIXTURE ADMIN',phone:'',officeId:'HONG KONG',officeName:'HONG KONG',isAdmin:true,isSpcTrader:true,isManager:false,isActive:true,activated:true,passwordChangeSuggested:false,revision:1 };
const record = { id:'90000000-0000-4000-8000-000000000001',legacyIds:[],sourceKey:'BP MARINE',legalName:'BP SINGAPORE PTE. LIMITED',shortName:'BP MARINE',aliases:[],countryCode:'SG',countryName:'Singapore',portName:'Singapore',nameStatus:'verified',legalNameSourceId:null,info:{paymentTerms:'30',qualityClaimBar:'30',supplierTrader:'FIXTURE ADMIN',availableGrade:'HSFO, VLSFO, LSMGO',foBdn:'ISO 8217:2017',goBdn:'ISO 8217:2010'},contacts:[{id:'contact-one',role:'sales',name:'SALES DESK',phone:'+6500000000',email:'',sourceId:'spc'}],barges:[{id:'barge-one',name:'FIXTURE BARGE',imo:'9000001',grade:'VLSFO',capacity:'3,000 MT',sourceId:'spc'}],facts:[],sources:[{id:'spc',type:'spc',title:'SPC supplier database',url:'https://spc.fcuno.com/suppliers',documentDate:'',retrievedAt:'2026-10-15T00:00:00Z'}],revision:1,updatedAt:'2026-10-15T00:00:00Z' };
const seed = [record, {...record,id:'90000000-0000-4000-8000-000000000005',legalName:'TOKYO SUPPLIER LTD',shortName:'TOKYO SUPPLIER',countryCode:'JP',countryName:'Japan',portName:'Tokyo'}, {...record,id:'90000000-0000-4000-8000-000000000006',legalName:'CHIBA SUPPLIER LTD',shortName:'CHIBA SUPPLIER',countryCode:'JP',countryName:'Japan',portName:'Chiba'},
  {...record,id:'90000000-0000-4000-8000-000000000002',sourceKey:'BUNKERHOUSE',legalName:'BUNKER HOUSE PETROLEUM PTE.LTD.',shortName:'BUNKERHOUSE',info:{...record.info,paymentTerms:'14',qualityClaimBar:'21',supplierTrader:'FIXTURE TRADER',availableGrade:'VLSFO',foBdn:'',goBdn:''},contacts:[],barges:[]},
  {...record,id:'90000000-0000-4000-8000-000000000003',sourceKey:'EMPTY SUPPLIER',legalName:'EMPTY SUPPLIER PTE. LTD.',shortName:'EMPTY SUPPLIER',info:{...record.info,paymentTerms:'',qualityClaimBar:'',supplierTrader:'',availableGrade:'',foBdn:'',goBdn:''},contacts:[],barges:[]},
  {...record,id:'90000000-0000-4000-8000-000000000004',sourceKey:'HONG KONG SUPPLIER',legalName:'HONG KONG SUPPLIER LTD.',shortName:'HONG KONG SUPPLIER',countryCode:'HK',countryName:'Hong Kong',portName:'Hong Kong'},
];

async function mock(context, mode = 'admin') {
  const activeUser = {...user,isAdmin:mode==='admin'||mode==='preview',isSpcTrader:mode==='admin'||mode==='spc-trader'};
  const preview = mode==='preview'?{role:'trader',officeId:'HONG KONG',officeName:'HONG KONG',readOnly:true}:null;
  const state = {items:structuredClone(seed),updates:0,requests:[],receipts:new Map(),dropResponse:false,actor:activeUser,createGate:null};
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
  await context.route('**/api/suppliers/**', async route => {
    const request=route.request(),url=new URL(request.url()),path=url.pathname.split('/api/suppliers/')[1];
    state.requests.push({path,method:request.method(),query:url.search});
    if (path==='pic-options') return route.fulfill({json:{options:['FIXTURE TRADER']}});
    if (path==='create') { const body=request.postDataJSON(); const item={...record,...body,id:crypto.randomUUID(),revision:1,updatedAt:new Date().toISOString(),nameStatus:'needs-review'}; state.items.push(item); state.created=body; if(state.createGate)await state.createGate; return route.fulfill({json:{item}}); }
    if (path==='list') {
      const portMap={'port-singapore':['SG','Singapore'],'port-hong-kong':['HK','Hong Kong'],'port-tokyo':['JP','Tokyo'],'port-chiba':['JP','Chiba']};
      const port=portMap[url.searchParams.get('portId')];
      const items=state.items.filter(item => (!url.searchParams.has('portId')||(port&&item.countryCode===port[0]&&item.portName===port[1])) && (!url.searchParams.get('country')||url.searchParams.get('country')===item.countryCode)
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


async function openPort(page,name){
 const workspace=page.getByRole('dialog',{name:'Countries & Ports',exact:true});
 await workspace.getByRole('button',{name:'Port Index',exact:true}).click();
 await workspace.getByLabel('Country or port',{exact:true}).fill(name);
 await workspace.locator('.location-table').getByRole('button',{name,exact:true}).click();
 await workspace.getByRole('tab',{name:'Suppliers',exact:true}).click();
 return workspace;
}
const results=[];
for(const [engine,type] of [['chromium',chromium],['webkit',webkit]]){
 if(process.env.ECO_TEST_ENGINE&&process.env.ECO_TEST_ENGINE!==engine)continue;
 const browser=await type.launch({headless:true});
 try{for(const width of [1440,320,390])for(const theme of ['light','dark']){
 if(process.env.ECO_TEST_WIDTH&&+process.env.ECO_TEST_WIDTH!==width)continue;
 if(process.env.ECO_TEST_THEME&&process.env.ECO_TEST_THEME!==theme)continue;
 const context=await browser.newContext({viewport:{width,height:900},isMobile:width<760,hasTouch:width<760,reducedMotion:'reduce'});
 await context.addInitScript(theme=>localStorage.setItem('ecosystem.theme.v1',theme),theme);
 await installStagingCookies(context,base);
 const state=await mock(context,'trader'),page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 try{
 await page.goto(base);const nav=page.getByRole('navigation',{name:'Workspace navigation'});await nav.getByRole('button',{name:'Ports & Suppliers',exact:true}).click();await nav.getByRole('button',{name:'Countries & Ports',exact:true}).click();
 const workspace=await openPort(page,'Singapore');let table=workspace.getByRole('table',{name:'Supplier results',exact:true});
 await expect(table.locator('tbody tr')).toHaveCount(3);await expect(workspace.getByRole('button',{name:'SPC VIEW',exact:true})).toHaveAttribute('aria-pressed','true');await expect(workspace.getByRole('button',{name:'Add supplier',exact:true})).toHaveCount(0);
 await expect(table).not.toContainText('HONG KONG');await expect(table).not.toContainText('TOKYO');
 assert.ok(state.requests.some(r=>r.path==='list'&&new URLSearchParams(r.query).get('portId')==='port-singapore'));
 await page.screenshot({path:`${output}/${engine}-${width}-${theme}-singapore-initial.png`,fullPage:true});
 if(width<800)assert.equal(await table.locator('thead').evaluate(n=>getComputedStyle(n).position),'static');
 await table.locator('tbody tr').first().getByRole('button',{name:'BDN',exact:true}).click();await expect(page.getByRole('dialog',{name:'BP MARINE · BDN',exact:true})).toContainText('ISO 8217:2017');await page.getByRole('dialog',{name:'BP MARINE · BDN',exact:true}).getByRole('button',{name:'Close dialog',exact:true}).click();
 await page.screenshot({path:`${output}/${engine}-${width}-${theme}-singapore.png`,fullPage:true});
 await openPort(page,'Tokyo');table=workspace.getByRole('table',{name:'Supplier results',exact:true});await expect(table.locator('tbody tr')).toHaveCount(1);await expect(table).toContainText('TOKYO SUPPLIER LTD');await expect(table).not.toContainText('CHIBA');await expect(table.locator('thead th')).toHaveCount(1);await expect(workspace.getByRole('button',{name:'SPC VIEW',exact:true})).toHaveCount(0);
 await workspace.getByRole('button',{name:'Add supplier',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Add supplier',exact:true});await expect(dialog.getByLabel('Supplier port',{exact:true})).toHaveValue('port-tokyo');await expect(dialog.getByLabel('Supplier port',{exact:true})).toBeDisabled();await dialog.getByLabel('Official name',{exact:true}).fill('NEW TOKYO SUPPLIER LTD');await dialog.getByLabel('Short name',{exact:true}).fill('NEW TOKYO');
 await page.screenshot({path:`${output}/${engine}-${width}-${theme}-register.png`,fullPage:true});
 await dialog.getByRole('button',{name:'Add supplier',exact:true}).click();await expect(workspace.getByRole('heading',{name:'NEW TOKYO SUPPLIER LTD',exact:true})).toBeVisible();assert.equal(state.created.portId,'port-tokyo');assert.equal(state.created.countryCode,'JP');assert.equal(state.created.portName,'Tokyo');
 await workspace.getByRole('button',{name:'Supplier results',exact:true}).click();await expect(table.locator('tbody tr')).toHaveCount(2);await expect(table).toContainText('NEW TOKYO SUPPLIER LTD');
 await page.screenshot({path:`${output}/${engine}-${width}-${theme}-tokyo.png`,fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);const boxes=await workspace.locator('.shared-suppliers').evaluateAll(nodes=>nodes.map(n=>({x:n.getBoundingClientRect().x,right:n.getBoundingClientRect().right})));assert.ok(boxes.every(b=>b.x>=0&&b.right<=width+1));
 await openPort(page,'Chiba');await expect(workspace.getByRole('table',{name:'Supplier results',exact:true}).locator('tbody tr')).toHaveCount(1);await expect(workspace.getByRole('table',{name:'Supplier results',exact:true})).toContainText('CHIBA SUPPLIER LTD');await expect(workspace.getByRole('table',{name:'Supplier results',exact:true})).not.toContainText('TOKYO');
 assert.deepEqual(errors,[]);results.push({engine,width,theme,status:'passed'});console.log(`PASS port ${engine} ${width} ${theme}`);
 }finally{await context.close();}
 }}finally{await browser.close();}
}

// A response committed for the previous account must not reopen a profile after refresh.
if(!process.env.ECO_TEST_ENGINE||process.env.ECO_TEST_ENGINE==='chromium'){
 const browser=await chromium.launch({headless:true}),context=await browser.newContext({viewport:{width:1440,height:900}});
 try{
  await installStagingCookies(context,base);
  const state=await mock(context,'trader'),page=await context.newPage();await page.goto(base);
  const nav=page.getByRole('navigation',{name:'Workspace navigation'});await nav.getByRole('button',{name:'Ports & Suppliers',exact:true}).click();await nav.getByRole('button',{name:'Countries & Ports',exact:true}).click();
  const workspace=await openPort(page,'Tokyo');await workspace.getByRole('button',{name:'Add supplier',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Add supplier',exact:true});
  await dialog.getByLabel('Official name',{exact:true}).fill('PENDING TOKYO SUPPLIER');await dialog.getByLabel('Short name',{exact:true}).fill('PENDING TOKYO');
  let release;state.createGate=new Promise(resolve=>{release=resolve;});await dialog.getByRole('button',{name:'Add supplier',exact:true}).click();await expect.poll(()=>Boolean(state.created)).toBe(true);
  state.actor.id='10000000-0000-4000-8000-000000000099';state.actor.email='second-supplier-fixture@example.test';state.actor.displayName='SECOND FIXTURE TRADER';
  const refreshed=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/access/session');await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await refreshed;await expect(dialog).toHaveCount(0);
  const completed=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/suppliers/create');release();await completed;
  await expect(page.locator('.shared-supplier-profile')).toHaveCount(0);await expect(page.getByRole('main',{name:'ECOSYSTEM workspace',exact:true})).toBeVisible();await expect(page.getByText('SECOND FIXTURE TRADER',{exact:true})).toBeVisible();
  results.push({engine:'chromium',scenario:'pending-create-account-switch',status:'passed'});console.log('PASS pending create account switch');
 }finally{await context.close();await browser.close();}
}
await writeFile(`${output}/results.json`,JSON.stringify(results,null,2));
