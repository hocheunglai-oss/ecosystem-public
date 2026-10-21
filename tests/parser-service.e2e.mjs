import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { installStagingCookies } from './fixtures/protection-cookies.mjs';
const base = process.env.ECO_PARSER_UI_ORIGIN || 'http://127.0.0.1:4392';
const out = resolve(process.env.ECO_PARSER_UI_OUTPUT || 'output/parser-service-ui');
await mkdir(out, { recursive: true });
const user = { capabilities: { appearancePreview: true, testWorkspace: true }, id:'10000000-0000-4000-8000-000000000001',email:'owner@example.test',displayName:'SAMPLE TRADER',officeId:'HONG KONG',officeName:'HONG KONG',isAdmin:true,isSpcTrader:true,isManager:false,isActive:true,activated:true,passwordChangeSuggested:false,revision:1 };
const generation = '30000000-0000-4000-8000-000000000001';
const raw = 'VESSEL: ALPHA\nPORT: SINGAPORE\nETA: 15 OCT 2026\nVLSFO: 450 MT\nNEED COQ PLEASE';
const results=[];
async function mocks(context) {
  const state={reports:[],fixes:[],imports:[],pending:null,delay:false,fail:false,signedIn:true};
  await context.route('**/api/**', async route=>{
    const req=route.request(),url=new URL(req.url()),body=req.method()==='POST'?req.postDataJSON():null;
    if(url.pathname==='/api/access/session')return route.fulfill(state.signedIn?{json:{user,preview:null}}:{status:401,json:{message:'Sign in required.'}});
    if(url.pathname==='/api/access/logout'){state.signedIn=false;return route.fulfill({json:{ok:true}});}
    if(url.pathname==='/api/enquiries/inbox'){assert.equal(req.headers()['x-eco-data-mode'],'live');return route.fulfill({json:{items:[],nextCursor:null,unreadCount:0}});}
    if(url.pathname==='/api/enquiries/test-policy')return route.fulfill({json:{enabled:true,generation}});
    if(url.pathname==='/api/parser/fix'){
      state.fixes.push(body);
      if(state.fail)return route.fulfill({status:503,json:{message:'AI suggestions are unavailable. Your enquiry is unchanged.',operationState:'failed'}});
      const result={requestId:body.requestId,sourceRevision:body.sourceRevision,sourceHash:'a'.repeat(64),parserVersion:body.parserVersion,model:'synthetic-ui-model',suggestions:[{field:'vessel',value:'ALPHA CORRECTED',evidence:'ALPHA'},{field:'remarks',value:'COQ REQUIRED',evidence:'NEED COQ PLEASE'},{field:'eta',value:'31 April 2026',evidence:'15 OCT 2026'}],warnings:[]};
      if(state.delay){state.pending=()=>route.fulfill({json:result});return;}
      return route.fulfill({json:result});
    }
    if(url.pathname==='/api/parser/reports'){
      if(body){const item={...body,id:'40000000-0000-4000-8000-'+String(state.reports.length+1).padStart(12,'0'),createdAt:'2026-10-15T10:00:00Z',createdBy:user.id};state.reports.push(item);return route.fulfill({json:{id:item.id,createdAt:item.createdAt}});}
      return route.fulfill({json:{items:state.reports.filter(item=>item.dataMode===url.searchParams.get('dataMode')),nextCursor:null}});
    }
    if(url.pathname.startsWith('/api/admin/imports/')&&body)state.imports.push(body);
    if(url.pathname.startsWith('/api/access/'))return route.fulfill({json:{requests:[],users:[user],offices:[{id:'HONG KONG',name:'HONG KONG'}]}});
    if(url.pathname.startsWith('/api/profile-tabs/'))return route.fulfill({json:{target:{kind:url.searchParams.get('kind'),id:url.searchParams.get('id')},shared:{revision:0,tabs:[]},private:{revision:0,tabs:[]}}});
    return route.fulfill({json:{count:0,items:[],nextCursor:null,page:1,pageSize:100,total:0,periodStart:'2026-10-09T00:00:00Z',periodEnd:'2026-10-16T00:00:00Z',timeZone:'Asia/Hong_Kong',source:'shared-feedback'}});
  });
  return state;
}
async function openEnquiry(page){const nav=page.getByRole('navigation',{name:'Workspace navigation'}),group=nav.getByRole('button',{name:'Trading',exact:true});if(await group.getAttribute('aria-expanded')!=='true')await group.click();await nav.getByRole('button',{name:'Enquiries',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Enquiries',exact:true});await expect(dialog).toBeVisible();return dialog;}
for(const [engine,kind] of [['chromium',chromium],['webkit',webkit]]){
  if(process.env.ECO_TEST_ENGINE&&process.env.ECO_TEST_ENGINE!==engine)continue;
  const browser=await kind.launch({headless:true});
  try{for(const width of [1440,320,390])for(const theme of ['light','dark']){
    if(process.env.ECO_TEST_WIDTH&&Number(process.env.ECO_TEST_WIDTH)!==width||process.env.ECO_TEST_THEME&&process.env.ECO_TEST_THEME!==theme)continue;
    const context=await browser.newContext({viewport:{width,height:width===1440?1000:844},isMobile:width!==1440,hasTouch:width!==1440,reducedMotion:'reduce',colorScheme:theme});
    await installStagingCookies(context,base);
    const state=await mocks(context),page=await context.newPage(),errors=[];
    page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error'&&!/401.*Unauthorized/.test(message.text())&&!(state.fail&&/503.*Service Unavailable/.test(message.text())))errors.push(message.text());});
    await page.addInitScript(theme=>localStorage.setItem('ecosystem.theme.v1',theme),theme);
    const shot=name=>page.screenshot({path:resolve(out,`${engine}-${width}-${theme}-${name}.png`),animations:'disabled',fullPage:true,timeout:30000});
    try{
      await page.goto(base,{waitUntil:'domcontentloaded'});
      const testButton=page.locator('.home-display-controls').getByRole('button',{name:'Test data',exact:true});await expect(testButton).toBeEnabled();await testButton.click();await expect(testButton).toHaveAttribute('aria-pressed','true');
      const dialog=await openEnquiry(page);
      await expect(dialog.getByRole('button',{name:'CHECK IMO',exact:true})).toBeDisabled();
      await dialog.getByLabel('Raw enquiry',{exact:true}).fill('VESSEL: CAUTION TEST\nIMO: 9074729\nPORT: SINGAPORE\nETA: 20 OCT 2026\nRMK: 300 MT\nVLSFO: 500 MT 120 CST MAX / 180 CST MAX\nLSMGO: 40 CBM');
      const caution=dialog.locator('.enquiry-review');await expect(caution).toHaveAttribute('open','');
      for(const term of ['RMK','120','180','CBM'])await expect(caution).toContainText(term);
      const lookup=dialog.getByRole('link',{name:'CHECK IMO',exact:true});
      await expect(lookup).toHaveAttribute('href','https://www.google.com/search?q=CAUTION%20TEST%20IMO%209074729');
      await expect(lookup).toHaveAttribute('target','_blank');await expect(lookup).toHaveAttribute('rel','noopener noreferrer');
      await lookup.scrollIntoViewIfNeeded();await shot('imo-lookup');await caution.scrollIntoViewIfNeeded();await shot('source-cautions');
      await expect(dialog.getByLabel('LSMGO',{exact:true})).toHaveValue('');
      await dialog.getByRole('button',{name:'AI FIX',exact:true}).click();
      const cautionAi=dialog.getByRole('region',{name:'AI suggestions',exact:true});await expect(cautionAi).toBeVisible();
      await cautionAi.getByRole('checkbox').first().uncheck();await cautionAi.getByRole('checkbox').last().uncheck();
      await cautionAi.getByRole('button',{name:'APPLY SELECTED',exact:true}).click();
      for(const term of ['RMK','120','180','CBM'])await expect(caution).toContainText(term);
      await expect(dialog.getByLabel('LSMGO',{exact:true})).toHaveValue('');await expect(dialog.getByRole('textbox',{name:'Remarks',exact:true})).toHaveValue('COQ REQUIRED');
      await dialog.getByLabel('Raw enquiry',{exact:true}).fill(raw);await expect(caution).not.toHaveAttribute('open','');
      await expect(lookup).toHaveAttribute('href','https://www.google.com/search?q=ALPHA%20vessel%20IMO');await expect(dialog.getByLabel('Vessel',{exact:true})).toHaveValue('ALPHA');
      await dialog.getByLabel('Vessel',{exact:true}).fill('MANUAL VESSEL');
      await dialog.getByRole('button',{name:'AI FIX',exact:true}).click();
      const review=dialog.getByRole('region',{name:'AI suggestions',exact:true});await expect(review).toBeVisible();const initialAiRequestId=state.fixes.at(-1).requestId;
      await expect(review.getByText(/ALPHA CORRECTED/)).toHaveCount(0);
      await expect(review.getByText(/COQ REQUIRED/)).toBeVisible();assert.ok(await review.evaluate(el=>el.getBoundingClientRect().width>=el.parentElement.parentElement.getBoundingClientRect().width-2),'AI review spans parser column');await review.getByRole('button',{name:'APPLY SELECTED',exact:true}).scrollIntoViewIfNeeded();await shot('review');
      await review.getByRole('button',{name:'APPLY SELECTED',exact:true}).click();
      await expect(dialog.getByLabel('Vessel',{exact:true})).toHaveValue('MANUAL VESSEL');await expect(dialog.getByRole('textbox',{name:'Remarks',exact:true})).toHaveValue('COQ REQUIRED');await expect(dialog.getByLabel('ETA',{exact:true})).toHaveValue(/15 oct 2026/i);
      await dialog.getByRole('button',{name:'Report',exact:true}).click();
      const reportDialog=page.getByRole('dialog',{name:'PARSER REPORT',exact:true});await expect(reportDialog.getByRole('region',{name:'Reported AI result'})).toContainText('COQ REQUIRED');
      await reportDialog.getByLabel('Report note').fill('SYNTHETIC REPORT NOTE');await reportDialog.getByRole('region',{name:'Reported AI result'}).scrollIntoViewIfNeeded();await shot('report-preview');
      await reportDialog.getByRole('button',{name:'SUBMIT REPORT',exact:true}).click();await expect.poll(()=>state.reports.length).toBe(1);assert.equal(state.reports[0].notes,'SYNTHETIC REPORT NOTE');
      assert.equal(state.reports[0].rawText,raw);assert.equal(state.reports[0].corrected.vessel,'MANUAL VESSEL');assert.equal(state.reports[0].parsed.vessel,'ALPHA');assert.equal(state.reports[0].dataMode,'test');assert.equal(state.reports[0].generation,generation);assert.equal(state.reports[0].aiRequestId,initialAiRequestId);
      assert.equal(state.reports[0].capture.original.fields.vessel,'ALPHA');assert.equal(state.reports[0].capture.submitted.fields.vessel,'MANUAL VESSEL');assert.equal(state.reports[0].capture.original.fields.remarks,'');assert.equal(state.reports[0].capture.submitted.fields.remarks,'COQ REQUIRED');assert.equal(state.reports[0].capture.parseOrigin,'initial');assert.match(state.reports[0].capture.originalRevision,/^[a-f0-9-]{36}$/i);
      state.delay=true;
      await dialog.getByRole('button',{name:'AI FIX',exact:true}).click();await expect.poll(()=>Boolean(state.pending)).toBe(true);
      await expect(dialog.getByRole('button',{name:'Report',exact:true})).toBeDisabled();await expect(reportDialog).toHaveCount(0);
      await dialog.getByRole('textbox',{name:'Remarks',exact:true}).fill('MANUAL DURING REQUEST');await state.pending();state.pending=null;
      await expect(dialog.getByRole('button',{name:'AI FIX',exact:true})).toBeEnabled();await expect(review).toHaveCount(0);await expect(dialog.getByRole('textbox',{name:'Remarks',exact:true})).toHaveValue('MANUAL DURING REQUEST');
      await expect(dialog.getByRole('button',{name:'Report',exact:true})).toBeEnabled();await dialog.getByRole('button',{name:'Report',exact:true}).click();
      await expect(reportDialog.getByRole('region',{name:'Reported AI result'})).toContainText('COQ REQUIRED');
      await reportDialog.getByRole('button',{name:'SUBMIT REPORT',exact:true}).click();await expect.poll(()=>state.reports.length).toBe(2);assert.equal(state.reports[1].aiRequestId,state.fixes.at(-1).requestId,'Settled delayed AI is linked before reporting');
      await dialog.getByRole('button',{name:'AI FIX',exact:true}).click();await expect.poll(()=>Boolean(state.pending)).toBe(true);
      const changed=raw.replace('ALPHA','BETA');await dialog.getByLabel('Raw enquiry',{exact:true}).fill(changed);await state.pending();state.pending=null;
      await expect(dialog.getByLabel('Vessel',{exact:true})).toHaveValue('BETA');await expect(review).toHaveCount(0);
      await dialog.getByRole('button',{name:'Report',exact:true}).click();await page.getByRole('dialog',{name:'PARSER REPORT',exact:true}).getByRole('button',{name:'SUBMIT REPORT',exact:true}).click();await expect.poll(()=>state.reports.length).toBe(3);assert.equal(state.reports[2].aiRequestId,undefined,'Changed source must not link an old AI receipt');
      state.delay=false;
      await dialog.getByRole('button',{name:'AI FIX',exact:true}).click();await expect(review).toBeVisible();await expect(review.getByText('BETA → ALPHA CORRECTED',{exact:true})).toBeVisible();
      await review.getByRole('button',{name:'CLOSE',exact:true}).click();
      await dialog.getByRole('button',{name:'Report',exact:true}).click();await page.getByRole('dialog',{name:'PARSER REPORT',exact:true}).getByRole('button',{name:'SUBMIT REPORT',exact:true}).click();await expect.poll(()=>state.reports.length).toBe(4);
      assert.equal(state.reports[3].aiRequestId,state.fixes.at(-1).requestId,'Unapplied AI remains part of report evidence');
      assert.equal(state.reports[3].capture.original.fields.vessel,'BETA');assert.equal(state.reports[3].corrected.remarks,'');
      state.fail=true;await dialog.getByRole('textbox',{name:'Remarks',exact:true}).fill('REVIEW FAILURE');
      await dialog.getByRole('button',{name:'AI FIX',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('AI suggestions are unavailable');
      await dialog.getByRole('button',{name:'Report',exact:true}).click();await page.getByRole('dialog',{name:'PARSER REPORT',exact:true}).getByRole('button',{name:'SUBMIT REPORT',exact:true}).click();await expect.poll(()=>state.reports.length).toBe(5);
      assert.equal(state.reports[4].aiRequestId,state.fixes.at(-1).requestId,'Failed AI receipt remains inspectable');
      state.fail=false;

      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No page overflow');await shot('enquiry');
      await dialog.getByRole('combobox',{name:'Buyer',exact:true}).fill('ASTER');await dialog.getByRole('option',{name:'ASTER OCEAN NAVIGATION PTE LTD',exact:true}).click();await dialog.getByRole('button',{name:'Confirm',exact:true}).click();await expect(page.getByRole('status')).toHaveText('Enquiry confirmed.');assert.deepEqual(state.imports,[],'Test confirmation must not attempt a shared import write');
      await page.getByRole('button',{name:'Close workspace',exact:true}).click();
      await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Administration',exact:true}).click();
      await page.getByRole('navigation',{name:'Administration',exact:true}).getByRole('button',{name:'Import Activity',exact:true}).click();
      const reports=page.getByRole('region',{name:'Parser reports',exact:true});await expect(reports.getByRole('button',{name:/MANUAL VESSEL/}).first()).toBeVisible();await reports.getByRole('button',{name:/MANUAL VESSEL/}).first().click();
      const detail=page.getByRole('complementary',{name:'Parser report details',exact:true});await expect(detail).toContainText(raw);await detail.locator('.parser-source').first().scrollIntoViewIfNeeded();await shot('reports');await detail.locator('.parser-report-diff section').nth(1).scrollIntoViewIfNeeded();await shot('report-values');
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No report page overflow');
      await page.getByRole('button',{name:'Close workspace',exact:true}).click();await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page.getByRole('button',{name:'Sign in',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'AI FIX',exact:true})).toHaveCount(0);await expect(page.getByRole('region',{name:'Parser reports',exact:true})).toHaveCount(0);await shot('signed-out');assert.deepEqual(errors,[]);
      results.push({engine,width,theme,passed:true,checks:['source cautions retained after AI apply','manual protection reset on new raw','report blocked until AI settled','manual fields','validated apply','explicit apply','stale field result','stale source result','report lineage','admin report review']});console.log(`PASS ${engine} ${width} ${theme}`);
    }catch(error){await shot('failure').catch(()=>{});throw error;}finally{await context.close();}
  }}finally{await browser.close();}
}
await writeFile(resolve(out,'results.json'),JSON.stringify({results},null,2));
