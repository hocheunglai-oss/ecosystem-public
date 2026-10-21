import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit, expect } from '@playwright/test';
import { installEmptyLiveInbox } from './fixtures/empty-live-inbox.mjs';
import { installProfileTabMocks } from './fixtures/profile-tabs.mjs';
import { invalidateFixtureAuthority } from './fixtures/authority-transition.mjs';
import { installStagingCookies } from './fixtures/protection-cookies.mjs';

const base = process.env.ECO_READABILITY_ORIGIN || 'http://127.0.0.1:4398';
const out = process.env.ECO_READABILITY_OUTPUT || '/private/tmp/eco-knowledge-readability-oct21';
const user = { id:'10000000-0000-4000-8000-000000000001', email:'readability@example.test', displayName:'READABILITY FIXTURE', phone:'', officeId:'HONG KONG', officeName:'HONG KONG', isAdmin:true, isSpcTrader:true, isManager:false, isActive:true, activated:true, passwordChangeSuggested:false, revision:1 };
const paragraph = 'OPERATING INFORMATION SHOULD REMAIN EASY TO READ WHEN AN ENTRY CONTAINS SEVERAL SENTENCES. KEEP THE TEXT AT A COMFORTABLE LINE LENGTH WHILE LETTING COMPARISON TABLES USE THE AVAILABLE SPACE. ';
const text = Array(8).fill(paragraph).join('\n\n');
const btn = (scope, name) => scope.getByRole('button', {name, exact:true});
const results = [];
await mkdir(out, {recursive:true});
async function fixture(context) {
  const state = {user:structuredClone(user), preview:null};
  await context.route('**/api/**', route => route.fulfill({status:404,json:{message:'Synthetic fixture only.'}}));
  await installEmptyLiveInbox(context);
  await installProfileTabMocks(context,{ownerId:()=>state.user?.id,preview:()=>Boolean(state.preview)});
  await context.route('**/api/access/**', route => route.fulfill(state.user ? {json:{user:state.user,preview:state.preview,users:[],offices:[],requests:[]}} : {status:401,json:{message:'Sign in required.'}}));
  await context.route('**/api/admin/**', route => route.fulfill({json:{count:0,items:[],hats:[],timeZone:'Asia/Hong_Kong'}}));
  await context.route('**/api/suppliers/**', route => route.fulfill({json:{items:[],total:0,page:1,pageSize:50}}));
  await context.route('**/api/intelligence/snapshot*', route => route.fulfill({json:{suppliers:[],fixtureCounts:[]}}));
  await context.route('**/api/enquiries/test-policy', route => route.fulfill({json:{enabled:false}}));
  return state;
}
async function selectCountry(workspace, name) {
  await btn(workspace,'Country Index').click();
  await workspace.getByLabel('Country or port',{exact:true}).fill(name);
  await btn(workspace.locator('.location-table'),name).click();
}
async function bordered(locator) {
  const style = await locator.evaluate(node => { const style=getComputedStyle(node); return {width:parseFloat(style.borderTopWidth),kind:style.borderTopStyle,color:style.borderTopColor,background:style.backgroundColor}; });
  assert.ok(style.width>=1 && style.kind==='solid' && style.color!=='rgba(0, 0, 0, 0)','Editable field/outline row has a persistent visible border');
  assert.notEqual(style.background,'rgba(0, 0, 0, 0)','Editable field/outline row has a visible surface');
}
for (const [engine,type] of [['chromium',chromium],['webkit',webkit]]) {
  if(process.env.ECO_TEST_ENGINE&&process.env.ECO_TEST_ENGINE!==engine)continue;
  const browser=await type.launch({headless:true});
  try { for(const width of [1440,320,390]) for(const theme of ['light','dark']) {
    if(process.env.ECO_TEST_WIDTH&&+process.env.ECO_TEST_WIDTH!==width||process.env.ECO_TEST_THEME&&process.env.ECO_TEST_THEME!==theme)continue;
    const context=await browser.newContext({viewport:{width,height:width<760?844:1000},isMobile:width<760,hasTouch:width<760,reducedMotion:'reduce'});
    await installStagingCookies(context,base);
    await context.addInitScript(theme=>localStorage.setItem('ecosystem.theme.v1',theme),theme);
    const authority=await fixture(context),page=await context.newPage(),errors=[];
    page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.stack||error.message));
    const shot=async name=>{await page.screenshot({path:`${out}/${engine}-${width}-${theme}-${name}.png`});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No viewport overflow');};
    try {
      await page.goto(base);await page.getByRole('main',{name:'ECOSYSTEM workspace'}).waitFor();
      const key=`ecosystem.live.v1:${user.id}:state`;
      await expect.poll(()=>page.evaluate(key=>Boolean(localStorage.getItem(key)),key)).toBe(true);
      const portId=await page.evaluate(({key,text})=>{
        const saved=JSON.parse(localStorage.getItem(key));
        saved.knowledgeRecords['country:Japan']={version:7,layoutVersion:2,sections:[{id:'readability',title:'READABILITY FIXTURE',blocks:[
          {id:'paragraph',type:'text',title:'OPERATING BACKGROUND',text},
          {id:'comparison',type:'table',title:'COMPARISON',columns:[{id:'one',name:'PORT',width:240},{id:'two',name:'DETAILS',width:240},{id:'three',name:'REFERENCE',width:240}],rows:[{id:'first',cells:['CHIBA','CONFIRMED','https://Example.test/PortData?Key=AbC']}]}]}]};
        const port=saved.ports.find(port=>port.name.toLowerCase()==='singapore');
        if(!port)throw new Error('Singapore fixture port absent');
        port.intelligenceKeyInfo={qualityClaim:'30 DAYS',isoSpecs:'ISO 8217',sampleLocation:'DELIVERY POINT',debunkering:'CONFIRM WITH AGENT'};
        saved.knowledgeRecords[`port:${port.id}`]={version:7,layoutVersion:2,sections:[{id:'port-info',title:'PORT INFORMATION',role:'port-information',blocks:[{id:'port-note',type:'text',title:'PORT OPERATIONS',text:'ORIGINAL PORT NOTE'}]}]};
        localStorage.setItem(key,JSON.stringify(saved));return port.id;
      },{key,text});
      await page.reload();
      const nav=page.getByRole('navigation',{name:'Workspace navigation'});
      if(await btn(nav,'Ports & Suppliers').getAttribute('aria-expanded')!=='true')await btn(nav,'Ports & Suppliers').click();
      await btn(nav,'Countries & Ports').click();
      const workspace=page.getByRole('dialog',{name:'Countries & Ports',exact:true});
      await selectCountry(workspace,'Japan');await workspace.getByRole('tab',{name:'READABILITY FIXTURE',exact:true}).click();
      await expect(btn(workspace,/^EDIT$/i)).toHaveCount(1);
      const editAction=btn(workspace,/^EDIT$/i),hint=editAction.locator('.contribution-action-hint');
      await expect(editAction).toHaveAttribute('aria-description','CONTRIBUTION +1');
      await page.keyboard.press('Tab');await editAction.focus();await expect(hint).toBeVisible();await shot('edit-contribution-hint');
      const hintClipped = await hint.evaluate(node=>{if(node.matches(':popover-open'))return false;const box=node.getBoundingClientRect();for(let parent=node.parentElement;parent;parent=parent.parentElement){const style=getComputedStyle(parent),bounds=parent.getBoundingClientRect();if(/auto|scroll|hidden|clip/.test(style.overflowY)&&(box.top<bounds.top-1||box.bottom>bounds.bottom+1))return true;if(/auto|scroll|hidden|clip/.test(style.overflowX)&&(box.left<bounds.left-1||box.right>bounds.right+1))return true;}return false;});
      assert.equal(hintClipped,false,'Contribution hint remains within every clipping container');
      await editAction.evaluate(node=>node.blur());await page.mouse.move(0,0);
      if(width===1440){await editAction.hover();await expect(hint).toBeVisible();await page.mouse.move(0,0);}
      await expect(workspace.locator('.knowledge-block-head').getByRole('button',{name:/^EDIT$/i,exact:true})).toHaveCount(0);
      const prose=workspace.locator('.knowledge-prose').filter({hasText:paragraph}).first();
      const measure=await prose.evaluate(node=>{const style=getComputedStyle(node),canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');ctx.font=`${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;return {width:node.getBoundingClientRect().width,ch:ctx.measureText('0').width};});
      if(width===1440)assert.ok(measure.width<=87*measure.ch,'Long prose is bounded to a readable line length');
      await prose.evaluate(node=>node.scrollIntoView({block:'start'}));await shot('read-prose');
      const table=workspace.getByRole('region',{name:'COMPARISON',exact:true});
      if(width===1440)assert.ok((await table.boundingBox()).width>measure.width,'Comparison table can use more width than prose');
      await table.evaluate(node=>node.scrollIntoView({block:'center'}));await shot('read-table');
      await btn(workspace,/^EDIT$/i).click();const editor=workspace.locator('.knowledge-editor');
      if(width<600){await expect(workspace.locator('.location-search')).toBeHidden();await expect(workspace.locator('.knowledge-profile-search')).toBeHidden();await expect(btn(workspace,'Back to Countries & Ports')).toBeVisible();assert.ok((await workspace.locator('.knowledge-content').boundingBox()).height>=500,'Focused phone editor has at least500px content viewport');}
      await expect(workspace.locator('.knowledge-name h2')).toHaveText('Japan');
      if(width<600){await expect(workspace.locator('.window-foot')).toBeHidden();const visibleTextHeight=await editor.locator('.knowledge-text-canvas').evaluate(node=>{let top=node.getBoundingClientRect().top,bottom=node.getBoundingClientRect().bottom;for(let parent=node.parentElement;parent;parent=parent.parentElement){if(/auto|scroll|hidden|clip/.test(getComputedStyle(parent).overflowY)){const box=parent.getBoundingClientRect();top=Math.max(top,box.top);bottom=Math.min(bottom,box.bottom);}}return bottom-top;});assert.ok(visibleTextHeight>=120,`Phone textarea shows at least120px of text, actual ${visibleTextHeight}`);}
      if(width<600){const contentBox=await workspace.locator('.knowledge-content').boundingBox(),actions=await editor.locator('.knowledge-editor-actions').boundingBox();assert.ok(actions.y>=contentBox.y-1&&actions.y+actions.height<=contentBox.y+contentBox.height+1,'Phone SAVE/CANCEL remain in the visible editor');}
      await expect(editor.locator('.knowledge-block-title-field')).toContainText(/^Title/i);
      await expect(editor.locator('.knowledge-text-field')).toContainText(/^Text/i);
      await editor.locator('.knowledge-block-title').evaluate(node=>node.blur());
      await bordered(editor.locator('.knowledge-block-title'));await bordered(editor.locator('.knowledge-text-canvas'));
      for(const row of await editor.locator('.knowledge-outline-item').all())await bordered(row);
      await editor.locator('.knowledge-block-title-field').scrollIntoViewIfNeeded();await shot('edit-text');
      await editor.locator('.knowledge-text-field').evaluate(node=>node.scrollIntoView({block:'start'}));await shot('edit-text-content');
      await editor.locator('.knowledge-outline-list').evaluate(node=>node.scrollIntoView({block:'start'}));await shot('edit-outline');
      await editor.locator('[data-block-id="comparison"] button').click();
      await expect(editor.locator('.knowledge-grid-editor')).toBeVisible();await shot('edit-table');
      await btn(editor,/^Cancel$/i).click();
      await expect(workspace.locator('.location-search')).toBeVisible();await expect(workspace.locator('.knowledge-profile-search')).toBeVisible();await expect(btn(workspace,'Public holidays')).toBeVisible();await expect(workspace.locator('.window-foot')).toBeVisible();
      await selectCountry(workspace,'Singapore');await workspace.getByRole('tab',{name:'PORT INFORMATION',exact:true}).click();
      const infoHeader=workspace.locator('.knowledge-facts > header');
      const alignment=await infoHeader.evaluate(node=>{const heading=node.querySelector('h3').getBoundingClientRect(),action=node.querySelector('.attachments-control').getBoundingClientRect();return {headingRight:heading.right,actionLeft:action.left,actionRight:action.right,right:node.getBoundingClientRect().right};});
      assert.ok(alignment.actionLeft>=alignment.headingRight-1&&alignment.right-alignment.actionRight<=20,'Key Info attachments align at header right');
      await infoHeader.scrollIntoViewIfNeeded();await shot('key-info-read');
      const before=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).contributions.length,key);
      await btn(workspace,/^EDIT$/i).click();
      await expect(editor.locator('.knowledge-key-info-fields')).toBeVisible();
      const claim=editor.getByLabel('30 days quality claim period',{exact:true});
      await claim.fill('45 DAYS');await bordered(claim);await shot('key-info-edit');
      await editor.getByLabel('ISO Specs',{exact:true}).evaluate(node=>node.closest('label').scrollIntoView({block:'start'}));await shot('key-info-fields');
      await editor.locator('[data-block-id="port-note"] button').click();
      await editor.locator('.knowledge-text-canvas').fill('UPDATED PORT NOTE');
      await btn(editor,/^SAVE(?: \+1)?$/i).click();await expect(editor).toHaveCount(0);
      await expect(workspace.locator('.location-search')).toBeVisible();await expect(workspace.locator('.knowledge-profile-search')).toBeVisible();await expect(btn(workspace,'Public holidays')).toBeVisible();await expect(workspace.locator('.window-foot')).toBeVisible();
      const saved=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),key);
      assert.equal(saved.ports.find(port=>port.id===portId).intelligenceKeyInfo.qualityClaim,'45 DAYS');
      assert.equal(saved.knowledgeRecords[`port:${portId}`].sections.find(section=>section.id==='port-info').blocks[0].text,'UPDATED PORT NOTE');
      assert.equal(saved.contributions.length,before+1,'Key Info plus tab text save as one contribution');
      await workspace.getByLabel('Search all tabs',{exact:true}).fill('UPDATED PORT NOTE');
      await expect(workspace.locator('.knowledge-content')).toContainText('UPDATED PORT NOTE');
      authority.preview={role:'trader',officeId:'HONG KONG',officeName:'HONG KONG',readOnly:true};
      await invalidateFixtureAuthority(page,{user:authority.user,preview:authority.preview});await expect(btn(workspace,/^EDIT$/i)).toHaveCount(0);
      authority.user=null;authority.preview=null;await invalidateFixtureAuthority(page,{user:null,preview:null});await expect(page.locator('.access-login')).toBeVisible();
      assert.deepEqual(errors,[]);results.push({engine,width,theme,passed:true});console.log(`PASS readability ${engine} ${width} ${theme}`);
    }catch(error){console.error(JSON.stringify({pageErrors:errors}));await shot('failure').catch(()=>{});throw error;}finally{await context.close();}
  }}finally{await browser.close();await writeFile(`${out}/results.json`,JSON.stringify({base,results},null,2));}
}
