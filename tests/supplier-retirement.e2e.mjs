import { installIntelligence, syntheticIntelligence } from './fixtures/intelligence.mjs';
import { installEmptyLiveInbox } from './fixtures/empty-live-inbox.mjs';
import { activateTestWorkspace, createLiveFixtureBuyer, installTestWorkspacePolicy, testGeneration } from './fixtures/test-workspace.mjs';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium,webkit,expect} from '@playwright/test';
import {installProfileTabMocks} from './fixtures/profile-tabs.mjs';
import {installStagingCookies} from './fixtures/protection-cookies.mjs';

const base=process.env.ECO_SUPPLIER_UI_ORIGIN||'http://127.0.0.1:4297';
const out=resolve(process.env.ECO_SUPPLIER_RETIREMENT_OUTPUT||'output/supplier-retirement-ui');
await mkdir(out,{recursive:true});
const user={ capabilities: { appearancePreview: true, testWorkspace: true },id:'10000000-0000-4000-8000-000000000001',email:'owner@example.test',displayName:'SAMPLE TRADER',phone:'+6591815902',officeId:'HONG KONG',officeName:'HONG KONG',isAdmin:true,isSpcTrader:true,isManager:false,isActive:true,activated:true,passwordChangeSuggested:false,revision:1};
const storageKey=`ecosystem.live.v1:${user.id}:state`;
const testStorageKey=`ecosystem.test.v1:${user.id}:${testGeneration}:state`;
const retired=[['supplier-meridian','Aster Marine Supply'],['supplier-harbourline','North Quay Marine Fuels'],['supplier-pacific','Koyo Strait Energy'],['supplier-tidal','Crescent Coast Bunkers'],['supplier-elm-harbour','Elm Harbour Fuels'],['supplier-fairway','Fairway Distillates'],['supplier-canal','Canal Reach Energy']];
const records=Array.from({length:103},(_,i)=>({id:`90000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,legacyIds:i===0?['synthetic-supplier']:[],sourceKey:`CATALOG${i+1}`,legalName:i===0?'SYNTHETIC MARINE PTE. LTD.':`CATALOG ${i+1} PTE. LTD.`,shortName:i===0?'SYNTHETIC':`CATALOG ${i+1}`,aliases:[],countryCode:'SG',countryName:'Singapore',portName:'Singapore',nameStatus:'verified',legalNameSourceId:'spc',info:{paymentTerms:'30',qualityClaimBar:'30',supplierTrader:'SAMPLE TRADER',availableGrade:'VLSFO',foBdn:'',goBdn:''},contactCount:0,bargeCount:0,revision:1,updatedAt:'2026-10-15T00:00:00Z'}));
const enrichedRecord=process.env.ECO_SUPPLIER_ENRICHED_FIXTURE?JSON.parse(await readFile(process.env.ECO_SUPPLIER_ENRICHED_FIXTURE,'utf8')).result:null;
if(enrichedRecord){assert.ok(enrichedRecord.id&&enrichedRecord.legalName&&enrichedRecord.facts?.length&&enrichedRecord.sources?.length,'Enrichment fixture must be a confirmed private publication receipt');records.push(enrichedRecord);}
async function mock(context){
 const state={fail:false,lists:[],mutations:[]};
 await installProfileTabMocks(context);
 await installEmptyLiveInbox(context);
 const intelligence = syntheticIntelligence();
 intelligence.suppliers = [{ ...intelligence.suppliers[0], id: 'synthetic-supplier', name: 'SYNTHETIC MARINE PTE LTD', fixtureCount: 3 }];
 intelligence.counts = [{ supplierId: 'synthetic-supplier', date: intelligence.periodEnd, count: 3 }];
 await installIntelligence(context, intelligence);
 await installTestWorkspacePolicy(context);
 await context.route('**/api/enquiries/records*',route=>{assert.equal(route.request().method(),'GET');assert.equal(route.request().headers()['x-eco-data-mode'],'live');return route.fulfill({json:{items:[],nextCursor:null}});});
 await context.route('**/api/access/**',route=>{const path=new URL(route.request().url()).pathname.split('/api/access/')[1];if(path==='session')return route.fulfill({json:{user,effectiveUser:user,preview:null}});if(path==='phone-requests')return route.fulfill({json:{requests:[]}});if(path==='users')return route.fulfill({json:{users:[user],offices:[{id:'HONG KONG',name:'HONG KONG'}]}});return route.fulfill({status:403,json:{message:'Unexpected access request'}});});
 await context.route('**/api/admin/**',route=>route.fulfill({json:{count:0,items:[],periodStart:'2026-10-09T00:00:00Z',periodEnd:'2026-10-15T00:00:00Z',timeZone:'Asia/Hong_Kong',source:'shared-feedback'}}));
 await context.route('**/api/suppliers/**',route=>{
  const request=route.request(),url=new URL(request.url());
  if(request.method()!=='GET'){state.mutations.push(url.pathname);return route.fulfill({status:403,json:{message:'Browser retirement test cannot write remotely.'}});}
  if(state.fail)return route.fulfill({status:503,json:{message:'Supplier service unavailable.'}});
  if(url.pathname.endsWith('/pic-options'))return route.fulfill({json:{options:['SAMPLE TRADER']}});
  if(url.pathname.endsWith('/list')){
   const page=+(url.searchParams.get('page')||1),limit=+(url.searchParams.get('limit')||50),query=(url.searchParams.get('search')||'').toLowerCase();state.lists.push({page,limit});
   const filtered=records.filter(item=>`${item.legalName} ${item.shortName}`.toLowerCase().includes(query));return route.fulfill({json:{items:filtered.slice((page-1)*limit,page*limit),page,pageSize:limit,total:filtered.length}});
  }
  const item=records.find(r=>r.id===url.searchParams.get('id')||r.legacyIds.includes(url.searchParams.get('id')));
  return route.fulfill({status:item?200:404,json:item?{item:item.id===enrichedRecord?.id?item:{...item,contacts:[],barges:[],facts:[],sources:[{id:'spc',type:'spc',title:'SPC source',url:'https://example.test/source',documentDate:'',retrievedAt:'2026-10-15T00:00:00Z'}]}}:{message:'Supplier not found.'}});
 });
 return state;
}
async function open(page,group,name){const nav=page.getByRole('navigation',{name:'Workspace navigation'}),button=nav.getByRole('button',{name:group,exact:true});if(await button.getAttribute('aria-expanded')!=='true')await button.click();await nav.getByRole('button',{name,exact:true}).click();return page.getByRole('dialog',{name,exact:true});}
const readState=(page,key=storageKey)=>page.evaluate(value=>JSON.parse(localStorage.getItem(value)),key);
async function loadLegacyState(page){
 return page.evaluate(async({storageKey,retired,user})=>{
  const state=JSON.parse(localStorage.getItem(storageKey));delete state.supplierRetirementVersion;delete state.retiredSupplierKnowledge;
  const source={version:7,layoutVersion:2,supplierFixturesVersion:1,sections:[{id:'information',title:'Supplier Information',role:'supplier-information',blocks:[{id:'edited-note',type:'text',title:'USER SUPPLIER NOTE',text:'KEEP THE ORIGINAL EDITED PROFILE FOR RECOVERY.'}]}]};
  const realRow={id:'user-real-row',cells:['REAL SUPPLIER USER ROW','KEEP USER DELIVERY DETAILS']};
  const portDocument={version:5,layoutVersion:2,sections:[{id:'supplier-portfolio',title:'Suppliers',role:'suppliers',blocks:[{id:'supplier-comparison',type:'table',title:'SUPPLIER COMPARISON',columns:[{id:'supplier',name:'Supplier'},{id:'remarks',name:'Remarks'}],rows:[...retired.map(([id,name])=>({id,cells:[name,'RETIRED EXAMPLE']})),realRow]},{id:'user-port-note',type:'text',title:'USER PORT NOTE',text:'KEEP THIS INDEPENDENT OPERATIONAL NOTE.'}]}]};
  state.knowledgeRecords??={};state.knowledgeRecords['supplier:supplier-meridian']=source;state.knowledgeRecords['port:port-singapore']=portDocument;
  const company=state.companies.find(c=>c.lifecycle!=='lead')||state.companies[0];company.status='approved';company.creditStatus='Active';company.limit=10000000;company.exposure=0;
  const now=new Date().toISOString();
  for(const suffix of ['success','failure'])state.enquiries.unshift({id:`retirement-enquiry-${suffix}`,buyerId:company.id,portId:'port-singapore',vessel:`RETIREMENT ${suffix.toUpperCase()}`,imo:'',eta:now.slice(0,10),grade:'VLSFO',quantity:10,price:0,margin:0,rawText:'RETIREMENT BROWSER FIXTURE',formattedText:'RETIREMENT BROWSER FIXTURE',status:'sent',createdAt:now,owner:user.id,products:[{grade:'VLSFO',quantityText:'10'}]});
  state.outcomes.unshift({id:'retirement-historical-outcome',enquiryId:'retirement-old-enquiry',kind:'fixture',buyerId:company.id,portId:'port-singapore',vessel:'HISTORICAL SUPPLIER RECORD',grade:'VLSFO',quantity:10,price:500,margin:10,bookedAt:now,owner:user.id,reason:'HISTORY MUST REMAIN',supplierId:'supplier-meridian',supplierName:'ORIGINAL HISTORICAL NAME',stemProducts:[{grade:'VLSFO',quantityText:'10',buyPrice:400,supplierId:'supplier-meridian',supplierName:'ORIGINAL HISTORICAL NAME'}]});
  const preserved={outcomes:structuredClone(state.outcomes),history:structuredClone(state.knowledgeHistory||[]),source,portDocument,realRow};localStorage.setItem(storageKey,JSON.stringify(state));
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('ecosystem.attachments.v1',1);r.onupgradeneeded=()=>{for(const name of ['items','folders','blobs'])if(!r.result.objectStoreNames.contains(name))r.result.createObjectStore(name,{keyPath:'id'});};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  const portScope={target:{kind:'port',id:'port-singapore'}},retiredScope={target:{kind:'supplier',id:'supplier-meridian'}};
  const folders=[{id:'supplier:supplier-meridian',parentId:'suppliers',name:'Aster Marine Supply',scope:retiredScope},{id:'retirement-child',parentId:'supplier:supplier-meridian',name:'RETIRED CHILD',scope:retiredScope,custom:true},{id:'retirement-grandchild',parentId:'retirement-child',name:'RETIRED GRANDCHILD',scope:portScope,custom:true},{id:'retirement-preserved-folder',parentId:'port:port-singapore',name:'PRESERVED PORT FOLDER',scope:portScope,custom:true}];
  const item=(id,folderId,scope,name)=>({id,folderId,scope,name,type:'link',mime:'',size:0,createdAt:now,createdBy:user.id,url:'https://example.test/document'});
  const items=[item('retirement-retired','supplier:supplier-meridian',retiredScope,'RETIREMENT HIDDEN DIRECT'),item('retirement-descendant','retirement-grandchild',portScope,'RETIREMENT HIDDEN DESCENDANT'),item('retirement-orphan','missing-retired-folder',retiredScope,'RETIREMENT HIDDEN ORPHAN'),item('retirement-preserved','retirement-preserved-folder',portScope,'RETIREMENT PRESERVED DOCUMENT')];
  await new Promise((resolve,reject)=>{const t=db.transaction(['items','folders'],'readwrite');for(const row of folders)t.objectStore('folders').put(row);for(const row of items)t.objectStore('items').put(row);t.oncomplete=resolve;t.onerror=()=>reject(t.error);});db.close();
  return preserved;
 },{storageKey,retired,user});
}
// The shared LIVE workflow deliberately never exposes legacy local enquiries.
// Fictional lifecycle operations are exercised only in Otto's explicit TEST scope.
async function loadTestLifecycle(page){
 return page.evaluate(({testStorageKey,user})=>{
  const state=JSON.parse(localStorage.getItem(testStorageKey));
  const company=state.companies.find(c=>c.lifecycle!=='lead')||state.companies[0];
  company.status='approved';company.creditStatus='Active';company.limit=10000000;company.exposure=0;
  const now=new Date().toISOString();
  for(const suffix of ['success','failure'])state.enquiries.unshift({id:`retirement-enquiry-${suffix}`,buyerId:company.id,portId:'port-singapore',vessel:`RETIREMENT ${suffix.toUpperCase()}`,imo:'',eta:now.slice(0,10),grade:'VLSFO',quantity:10,price:0,margin:0,rawText:'RETIREMENT BROWSER FIXTURE',formattedText:'RETIREMENT BROWSER FIXTURE',status:'sent',createdAt:now,owner:user.id,products:[{grade:'VLSFO',quantityText:'10'}]});
  const historical={id:'retirement-test-historical-outcome',enquiryId:'retirement-test-old-enquiry',kind:'fixture',buyerId:company.id,portId:'port-singapore',vessel:'HISTORICAL SUPPLIER RECORD',grade:'VLSFO',quantity:10,price:500,margin:10,bookedAt:now,owner:user.id,reason:'HISTORY MUST REMAIN',supplierId:'supplier-meridian',supplierName:'ORIGINAL HISTORICAL NAME',stemProducts:[{grade:'VLSFO',quantityText:'10',buyPrice:400,supplierId:'supplier-meridian',supplierName:'ORIGINAL HISTORICAL NAME'}]};
  state.outcomes.unshift(historical);localStorage.setItem(testStorageKey,JSON.stringify(state));return historical;
 },{testStorageKey,user});
}
const reports=[];
for(const [engine,type] of [['chromium',chromium],['webkit',webkit]]){
 if(process.env.ECO_TEST_ENGINE&&process.env.ECO_TEST_ENGINE!==engine)continue;
 const browser=await type.launch({headless:true});
 try{for(const width of [1440,320,390])for(const theme of ['light','dark']){
  if(process.env.ECO_TEST_WIDTH&&+process.env.ECO_TEST_WIDTH!==width)continue;if(process.env.ECO_TEST_THEME&&process.env.ECO_TEST_THEME!==theme)continue;
  const context=await browser.newContext({viewport:{width,height:1000},isMobile:width<760,hasTouch:width<760,reducedMotion:'reduce'});await installStagingCookies(context,base);const remote=await mock(context);await context.addInitScript(theme=>localStorage.setItem('ecosystem.theme.v1',theme),theme);
  const page=await context.newPage(),errors=[];page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
  const shot=async name=>{await page.screenshot({path:`${out}/${engine}-${width}-${theme}-${name}.png`,fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${name}: page overflow`);const active=page.getByRole('dialog').last();const box=await active.boundingBox();assert.ok(box&&box.x>=-1&&box.x+box.width<=width+1,`${name}: dialog clipping`);};
  try{
   await page.goto(base);await page.getByRole('main',{name:'ECOSYSTEM workspace'}).waitFor();await expect.poll(async()=>Boolean(await readState(page))).toBe(true);await createLiveFixtureBuyer(page,'SUPPLIER RETIREMENT TEST BUYER');const before=await loadLegacyState(page);await page.reload();await page.getByRole('main',{name:'ECOSYSTEM workspace'}).waitFor();
   await expect.poll(async()=>(await readState(page)).supplierRetirementVersion).toBe(1);const upgraded=await readState(page);
   assert.deepEqual(upgraded.outcomes,before.outcomes);assert.deepEqual(upgraded.knowledgeHistory||[],before.history);assert.equal(upgraded.knowledgeRecords['supplier:supplier-meridian'],undefined);assert.deepEqual(upgraded.retiredSupplierKnowledge['supplier:supplier-meridian'],before.source);
   const blocks=upgraded.knowledgeRecords['port:port-singapore'].sections.flatMap(section=>section.blocks);assert.deepEqual(blocks.find(block=>block.id==='supplier-comparison').rows,[before.realRow]);assert.equal(blocks.find(block=>block.id==='user-port-note').text,'KEEP THIS INDEPENDENT OPERATIONAL NOTE.');
   const ports=await open(page,'Ports & Suppliers','Countries & Ports');await ports.getByRole('button',{name:'Port Index',exact:true}).click();await ports.getByLabel('Country or port',{exact:true}).fill('Singapore');await ports.locator('.location-table').getByRole('button',{name:'Singapore',exact:true}).click();await ports.getByRole('tab',{name:'Suppliers',exact:true}).click();await expect(ports.getByText('REAL SUPPLIER USER ROW',{exact:true})).toBeVisible();for(const [,name] of retired)await expect(ports.getByText(name,{exact:true})).toHaveCount(0);await expect(ports.getByRole('button',{name:'Attachments (1) for Singapore',exact:true})).toBeVisible();await shot('port-preservation');
   await ports.locator('.knowledge-header .attachments-trigger').click();const attachments=page.getByRole('dialog',{name:'Attachments',exact:true});await attachments.getByLabel('Search attachments',{exact:true}).fill('RETIREMENT');await expect(attachments.locator('.attachment-file-tile')).toHaveCount(1);await expect(attachments.locator('.attachment-file-tile')).toContainText('RETIREMENT PRESERVED DOCUMENT');await shot('attachments-preservation');
   await attachments.getByLabel('Search attachments',{exact:true}).fill('');await attachments.locator('.attachment-tree-folder').filter({hasText:/^Suppliers$/i}).click();for(const [,name] of retired)await expect(attachments.getByText(name,{exact:true})).toHaveCount(0);await expect(attachments.locator('.attachment-folder-tile').filter({hasText:/SYNTHETIC/i})).toHaveCount(1);await shot('attachment-suppliers');
   const stored=await page.evaluate(async()=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('ecosystem.attachments.v1',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});const rows=await new Promise((resolve,reject)=>{const r=db.transaction('items').objectStore('items').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});db.close();return rows.filter(row=>row.id.startsWith('retirement-')).length;});assert.equal(stored,4,'Retirement hides old attachments without deleting original data');
   await attachments.getByRole('button',{name:'Close dialog',exact:true}).click();await ports.getByRole('button',{name:'Close workspace',exact:true}).click();
   if(enrichedRecord){
    const directory=await open(page,'Ports & Suppliers','Supplier Profiles');await directory.getByLabel('Search suppliers',{exact:true}).fill(enrichedRecord.shortName);await directory.locator(`[data-supplier-id="${enrichedRecord.id}"]`).click();await expect(directory.getByRole('heading',{name:enrichedRecord.legalName,exact:true})).toBeVisible();
    const background=directory.locator('.shared-supplier-background');await expect(background).toBeVisible();await expect(background).not.toContainText('Registered address');await shot('enriched-profile-top');await background.scrollIntoViewIfNeeded();await shot('enriched-profile-background');await directory.getByRole('tab',{name:'Sources',exact:true}).click();for(const source of enrichedRecord.sources.filter(source=>source.type!=='spc'))await expect(directory.getByText(source.title,{exact:true})).toHaveCount(1);await shot('enriched-profile-sources');await directory.getByRole('button',{name:'Close workspace',exact:true}).click();
   }
   const liveCenter=await open(page,'Trading','Enquiries');
   await expect(liveCenter.locator('[data-enquiry-id="retirement-enquiry-success"]')).toHaveCount(0);
   await expect(liveCenter.locator('[data-enquiry-id="retirement-enquiry-failure"]')).toHaveCount(0);
   await liveCenter.getByRole('button',{name:'Close workspace',exact:true}).click();
   const liveBeforeLifecycle=await readState(page);
   await activateTestWorkspace(page);await expect.poll(async()=>(await readState(page,testStorageKey))?.companies.length??0).toBeGreaterThan(0);
   const testHistory=await loadTestLifecycle(page);
   await page.reload();await page.getByRole('main',{name:'ECOSYSTEM workspace'}).waitFor();await activateTestWorkspace(page);
   const center=await open(page,'Trading','Enquiries');const row=center.locator('[data-enquiry-id="retirement-enquiry-success"]');await row.getByRole('button',{name:/^stem$/i}).click();let stem=page.getByRole('dialog',{name:'STEM',exact:true});const picker=stem.getByRole('combobox',{name:'VLSFO supplier',exact:true});await picker.fill('CATALOG 103');await stem.getByRole('option',{name:/CATALOG 103/}).click();assert.ok(remote.lists.some(item=>item.page>1),'STEM loads beyond the first supplier page');for(const [,name] of retired)await expect(stem.getByText(name,{exact:true})).toHaveCount(0);
   await stem.getByLabel('VLSFO buy price (USD / MT)',{exact:true}).fill('400');await stem.getByRole('checkbox',{name:'Compliance',exact:true}).check();await stem.getByRole('checkbox',{name:'Credit',exact:true}).check();await shot('stem-real-catalog');await stem.getByRole('button',{name:'Save',exact:true}).click();await expect(stem).toHaveCount(0);
   const saved=await readState(page,testStorageKey),outcome=saved.outcomes.find(item=>item.enquiryId==='retirement-enquiry-success');assert.equal(outcome.supplierId,records[102].id);assert.equal(outcome.supplierName,records[102].legalName);assert.equal(outcome.stemProducts[0].supplierId,records[102].id);assert.deepEqual(saved.outcomes.find(item=>item.id==='retirement-test-historical-outcome'),testHistory);
   remote.fail=true;await center.locator('[data-enquiry-id="retirement-enquiry-failure"]').getByRole('button',{name:/^stem$/i}).click();stem=page.getByRole('dialog',{name:'STEM',exact:true});await expect(stem.getByRole('alert')).toContainText('Supplier service unavailable');await expect(stem.getByRole('button',{name:'Save',exact:true})).toBeDisabled();await shot('stem-unavailable');assert.equal((await readState(page,testStorageKey)).outcomes.filter(item=>item.enquiryId==='retirement-enquiry-failure').length,0);
   assert.deepEqual(await readState(page),liveBeforeLifecycle,'TEST lifecycle must not change LIVE retirement/history data');
   assert.deepEqual(remote.mutations,[]);assert.deepEqual(errors,[]);reports.push({engine,width,theme,status:'passed'});
  }catch(error){await page.screenshot({path:`${out}/${engine}-${width}-${theme}-FAILURE.png`,fullPage:true}).catch(()=>{});throw error;}finally{await context.close();}
 }}finally{await browser.close();}
}
await writeFile(`${out}/results.json`,JSON.stringify(reports,null,2));console.log(JSON.stringify({passed:reports.length,output:out}));
