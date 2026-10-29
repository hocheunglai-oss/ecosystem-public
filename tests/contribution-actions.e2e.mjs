import { installSharedLocations, sharedLocations } from './fixtures/shared-locations.mjs';
import { installSharedAttachments } from './fixtures/shared-attachments.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { installIntelligence, syntheticIntelligence } from './fixtures/intelligence.mjs';
import { installEmptyLiveInbox } from './fixtures/empty-live-inbox.mjs';
import { installProfileTabMocks } from './fixtures/profile-tabs.mjs';
import { createLiveFixtureBuyer } from './fixtures/test-workspace.mjs';
import { invalidateFixtureAuthority } from './fixtures/authority-transition.mjs';
import { installStagingCookies } from './fixtures/protection-cookies.mjs';

const base = process.env.ECO_ACTIONS_ORIGIN || 'http://127.0.0.1:4399';
const out = resolve(process.env.ECO_ACTIONS_OUTPUT || '/private/tmp/eco-contribution-actions');
const user = { id:'10000000-0000-4000-8000-000000000001',email:'owner@example.test',displayName:'FIXTURE ADMIN',phone:'',officeId:'HONG KONG',officeName:'HONG KONG',isAdmin:true,isSpcTrader:true,isManager:false,isActive:true,activated:true,passwordChangeSuggested:false,revision:1,capabilities:{testWorkspace:true,appearancePreview:true} };
const key = `ecosystem.live.v1:${user.id}:state:v2`;
const button = (scope,name) => scope.getByRole('button',{name,exact:true});
const saved = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
const results = [];
await mkdir(out,{recursive:true});

async function fixture(context) {
  const state={user:structuredClone(user),preview:null,feedback:[],unexpected:[]};
  await context.route('**/api/**',route=>{state.unexpected.push(new URL(route.request().url()).pathname);return route.fulfill({status:404,json:{message:'Unconfigured isolated fixture endpoint.'}});});
  await installEmptyLiveInbox(context);
  await installSharedLocations(context,{user:()=>state.user,preview:()=>state.preview});
  await installSharedAttachments(context,{user:()=>state.user,preview:()=>state.preview});
  await context.route('**/api/enquiries/records*',route=>route.fulfill({json:{items:[],nextCursor:null,unreadCount:0}}));
  await installIntelligence(context, syntheticIntelligence());
  await installProfileTabMocks(context,{ownerId:()=>state.user?.id,preview:()=>Boolean(state.preview)});
  await context.route('**/api/enquiries/test-policy',route=>route.fulfill({json:{enabled:true,generation:'10000000-0000-4000-8000-000000000010'}}));
  await context.route('**/api/access/**',route=>{
    const path=new URL(route.request().url()).pathname.split('/api/access/')[1];
    if(!state.user)return route.fulfill({status:401,json:{message:'Sign in required.'}});
    if(path==='session')return route.fulfill({json:{user:state.user,preview:state.preview}});
    if(path==='users')return route.fulfill({json:{users:[state.user],offices:[{id:'HONG KONG',name:'HONG KONG'}]}});
    if(path==='phone-requests')return route.fulfill({json:{requests:[]}});
    state.unexpected.push(path);return route.fulfill({status:403,json:{message:'Unavailable.'}});
  });
  await context.route('**/api/admin/**',route=>{
    const path=new URL(route.request().url()).pathname.split('/api/admin/')[1], request=route.request();
    if(path==='feedback'&&request.method()==='POST'){
      assert.equal(request.headers()['x-eco-request'],'1');
      if(state.preview)return route.fulfill({status:403,json:{message:'Read only.'}});
      const body=request.postDataJSON(), item={...body,id:crypto.randomUUID(),createdAt:new Date().toISOString(),createdBy:user.id,status:'new'};
      state.feedback.push(item);return route.fulfill({json:{item}});
    }
    if(request.method()!=='GET')state.unexpected.push(path);
    return route.fulfill({json:{items:state.feedback,total:state.feedback.length,count:state.feedback.length,page:1,pageSize:50,periodStart:'2026-10-15T00:00:00Z',periodEnd:'2026-10-21T00:00:00Z',timeZone:'Asia/Hong_Kong',source:'shared-feedback'}});
  });
  await context.route('**/api/suppliers/**',route=>route.fulfill({json:{items:[],total:0,page:1,pageSize:50}}));
  await context.route('**/api/suppliers/pic-options',route=>route.fulfill({json:{options:['FIXTURE ADMIN']}}));
  return state;
}
async function profile(page) {
  const nav=page.getByRole('navigation',{name:'Workspace navigation'}), group=button(nav,'Buyers and Credit');
  if(await group.getAttribute('aria-expanded')!=='true')await group.click();
  await button(nav,'Buyer Profiles').click();
  const workspace=page.getByRole('dialog',{name:'Buyer Profiles',exact:true});
  const search=workspace.getByRole('textbox',{name:'Search buyer profiles',exact:true});
  await expect.poll(async()=>await search.isVisible()||await workspace.locator('.buyer-profile').isVisible()).toBe(true);
  if(await search.isVisible()){await search.fill('ACTION FIXTURE BUYER');await button(workspace,'ACTION FIXTURE BUYER').click();}
  return workspace.locator('.buyer-profile');
}
async function credited(action) {
  await expect(action).toHaveAttribute('aria-description','CONTRIBUTION +1');
  await expect(action).toHaveClass(/knowledge-update-button/);
  await expect(action).toHaveClass(/ui-button--contribution/);
  const style=await action.evaluate(node=>{
    const probe=document.createElement('i');node.append(probe);
    const color=token=>{probe.style.background=`var(${token})`;return getComputedStyle(probe).backgroundColor;};
    const result={actual:getComputedStyle(node).backgroundColor,ink:getComputedStyle(node).color,expected:color('--ui-contribution'),hover:color('--ui-contribution-hover'),expectedInk:color('--ui-contribution-ink')};
    probe.remove();return result;
  });
  assert.ok([style.expected,style.hover].includes(style.actual),`Credited action uses the shared blue fill or its shared hover state: ${JSON.stringify(style)} ${await action.getAttribute('class')}`);
  assert.equal(style.ink,style.expectedInk,'Contribution text uses the shared white ink');
  const rgb=value=>value.match(/[\d.]+/g).slice(0,3).map(Number),fill=rgb(style.actual),ink=rgb(style.ink);
  assert.ok(fill[2]>fill[0]+50&&fill[2]>fill[1]+45,'Contribution actions are visibly blue');
  assert.deepEqual(ink,[255,255,255],'Contribution labels remain white in both themes');
  const luminance=channels=>channels.map(value=>{const n=value/255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;}).reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index],0);
  const foreground=luminance(ink),background=luminance(fill);
  assert.ok((Math.max(foreground,background)+.05)/(Math.min(foreground,background)+.05)>=4.5,'Contribution label contrast is at least 4.5:1');
}
async function neutral(action) {
  assert.equal(await action.getAttribute('aria-description'),null);
  await expect(action).not.toHaveClass(/knowledge-update-button|ui-button--contribution/);
  await expect(action.locator('.contribution-action-hint')).toHaveCount(0);
  const style=await action.evaluate(node=>{
    const scope='#root :is(.workspace-window, .modal, .workspace-module)';
    const primary=node.matches(`${scope} :is(.button.primary, .ui-button--primary, .lime-control):not(.ui-button--contribution):not(.knowledge-update-button)`);
    const selected=node.matches(`${scope} .enquiry-terms > button[aria-pressed="true"]`);
    // Ordinary primary actions and selected enquiry lists have their own neutral
    // tokens; do not broaden every action to accept every neutral surface.
    const tokens=primary?['--ui-primary','--ui-primary-hover']:selected?['--ui-selection']:['--ui-control-surface','--ui-control-hover'];
    const probe=document.createElement('i');node.append(probe);
    const values=tokens.map(token=>{probe.style.background=`var(${token})`;return getComputedStyle(probe).backgroundColor;});
    probe.remove();return {actual:getComputedStyle(node).backgroundColor,tokens,values};
  });
  assert.ok(style.values.includes(style.actual),`Ordinary action uses its shared neutral state: ${await action.textContent()} ${JSON.stringify(style)}`);
  const fill=style.actual.match(/[\d.]+/g).slice(0,3).map(Number);
  assert.ok(!(fill[2]>fill[0]+50&&fill[2]>fill[1]+45),'Ordinary/private actions do not use the reserved contribution blue');
}

async function swappedInside(action,page) {
  // Compare label states using the same loaded font, including a cold hosted visit.
  const ready = await action.evaluate(async node => {
    const style=getComputedStyle(node);
    const font=`${style.fontWeight} ${style.fontSize} ${style.fontFamily}`, text=node.textContent || '';
    await document.fonts.load(font,text);
    await document.fonts.ready;
    return {loaded:document.fonts.check(font,text),status:document.fonts.status};
  });
  assert.ok(ready.loaded && ready.status === 'loaded', 'Button font is loaded before geometry samples');
  await action.evaluate(node=>node.blur());await page.mouse.move(0,0);
  const hint=action.locator('.contribution-action-hint'),label=action.locator('.contribution-action-label');
  await expect(hint).toBeHidden();const before=await action.boundingBox();
  await page.keyboard.press('Tab');await action.focus();await expect(action).toBeFocused();await expect(hint).toBeVisible();await credited(action);
  assert.equal(await label.evaluate(node=>getComputedStyle(node).opacity),'0');
  const after=await action.boundingBox(),content=await hint.boundingBox();
  assert.ok(Math.abs(before.width-after.width)<.5 && Math.abs(before.height-after.height)<.5,'Contribution replacement keeps button dimensions stable');
  assert.ok(content.x>=after.x && content.y>=after.y && content.x+content.width<=after.x+after.width && content.y+content.height<=after.y+after.height,'Contribution label is inside the button');
  assert.equal(await hint.evaluate(node=>getComputedStyle(node).position),'static','No external tooltip bubble');
  if((page.viewportSize()?.width??0)>=760){await action.evaluate(node=>node.blur());await action.hover();await expect(hint).toBeVisible();await credited(action);assert.equal(await label.evaluate(node=>getComputedStyle(node).opacity),'0');}
}
async function openWorkspace(page,group,name) {
  const nav=page.getByRole('navigation',{name:'Workspace navigation'});
  if(group&&await button(nav,group).getAttribute('aria-expanded')!=='true')await button(nav,group).click();
  await button(group?nav:page,name).click();return page.getByRole('dialog',{name,exact:true});
}
async function ordinaryScreens(page,shot) {
  let workspace=await openWorkspace(page,'Ports & Suppliers','Supplier Profiles');
  await neutral(button(workspace,'SPC VIEW'));await neutral(button(workspace,'Add supplier'));
  await button(workspace,'SPC VIEW').click();await neutral(button(workspace,'SPC VIEW'));await shot('ordinary-suppliers');
  await button(workspace,'Add supplier').click();const add=page.getByRole('dialog',{name:'Add supplier',exact:true});await neutral(button(add,'Add supplier'));await button(add,'Cancel').click();await button(workspace,'Close workspace').click();
  workspace=await openWorkspace(page,'Trading','Enquiries');
  await neutral(button(workspace,'My enquiries'));await neutral(button(workspace,'Confirm'));await shot('ordinary-parser');
  await button(workspace,'Singapore queue').click();await neutral(button(workspace,'Singapore queue'));await neutral(button(workspace,'My enquiries'));await button(workspace,'My enquiries').scrollIntoViewIfNeeded();await shot('ordinary-enquiry-lists');await button(workspace,'Close workspace').click();
  workspace=await openWorkspace(page,null,'Settings');
  await neutral(button(workspace,'Add user'));await workspace.locator('.users-access-list button').filter({hasText:'FIXTURE ADMIN'}).click();await neutral(button(workspace,'Save changes'));const permission=workspace.getByRole('checkbox',{name:'SPC Trader',exact:true});assert.ok(await permission.evaluate(node=>{const probe=document.createElement('i');probe.style.color='var(--ui-focus)';node.parentElement.append(probe);const matches=getComputedStyle(node).accentColor===getComputedStyle(probe).color;probe.remove();return matches;}),'Permission checkbox uses the neutral selection accent');await button(workspace,'Save changes').scrollIntoViewIfNeeded();await shot('ordinary-admin');
  await button(workspace.locator('.users-access-editor'),'Close').click();await button(workspace,'Personal details').click();await neutral(button(workspace,'Change password'));await button(workspace,'Change password').scrollIntoViewIfNeeded();await shot('ordinary-password');await button(workspace,'Close workspace').click();
}

const finance = state => ({companies:state.companies,requests:state.requests,enquiries:state.enquiries,outcomes:state.outcomes});
for(const [engine,type] of [['chromium',chromium],['webkit',webkit]]) {
  if(process.env.ECO_TEST_ENGINE&&process.env.ECO_TEST_ENGINE!==engine)continue;
  const browser=await type.launch({headless:true});
  try{for(const width of [1440,320,390])for(const theme of ['light','dark']) {
    if(process.env.ECO_TEST_WIDTH&&Number(process.env.ECO_TEST_WIDTH)!==width)continue;
    if(process.env.ECO_TEST_THEME&&process.env.ECO_TEST_THEME!==theme)continue;
    const context=await browser.newContext({viewport:{width,height:width<760?844:1000},isMobile:width<760,hasTouch:width<760,reducedMotion:'reduce'});
    await installStagingCookies(context,base);
    const state=await fixture(context), errors=[];
    await context.addInitScript(theme=>localStorage.setItem('ecosystem.theme.v1',theme),theme);
    const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
    const shot=async name=>{await page.screenshot({path:resolve(out,`${engine}-${width}-${theme}-${name}.png`)});};
    try {
      await page.goto(base);await expect(page.getByRole('navigation',{name:'Workspace navigation'})).toBeVisible();
      const feedback=page.locator('.home-display-controls').getByRole('button',{name:'Feedback for ecosystem',exact:true});
      await credited(feedback);await swappedInside(feedback,page);
      await expect(feedback.locator('.contribution-action-hint')).toBeVisible();await shot('feedback-hint');
      await feedback.click();const modal=page.getByRole('dialog',{name:'Feedback for ecosystem',exact:true});
      const submit=button(modal.getByRole('form',{name:'Submit feedback',exact:true}),'Submit feedback');await credited(submit);
      await modal.getByLabel('Title',{exact:true}).fill('ACTION FEEDBACK FIXTURE');
      await modal.getByLabel('Details',{exact:true}).fill('SYNTHETIC FEEDBACK VERIFICATION WITH NO BUSINESS DATA OR EXTERNAL WRITES.');
      await submit.click();await expect(modal).toContainText('Feedback submitted.');assert.equal(state.feedback.length,1);
      await button(modal,'Close dialog').click();
      await ordinaryScreens(page,shot);
      await createLiveFixtureBuyer(page,'ACTION FIXTURE BUYER');
      let view=await profile(page), overview=view.locator('.buyer-overview-grid');
      const initial=await saved(page), initialFinance=finance(initial);
      const edit=button(overview,'EDIT');await expect(edit).toHaveCount(1);await credited(edit);await swappedInside(edit,page);await shot('overview');
      await edit.click();await expect(button(overview,'EDIT')).toHaveCount(0);
      const competition=overview.getByRole('region',{name:'Competition',exact:true}), team=overview.getByRole('region',{name:'Team Remarks',exact:true}), own=overview.getByRole('region',{name:'Private Remarks',exact:true});
      await competition.getByLabel('Competition 1',{exact:true}).fill('COMPETITOR FIXTURE SHARED NOTE');
      await team.getByLabel('Team Remarks 1',{exact:true}).fill('TEAM FIXTURE PENDING DRAFT');
      await own.getByLabel('Private Remarks 1',{exact:true}).fill('PRIVATE FIXTURE OWNER NOTE');
      await credited(button(competition,'SAVE'));await credited(button(team,'SAVE'));await neutral(button(own,'SAVE'));
      await view.getByRole('tab',{name:'Stem Records',exact:true}).click();await view.getByRole('tab',{name:'Overview',exact:true}).click();
      await expect(team.getByLabel('Team Remarks 1',{exact:true})).toHaveValue('TEAM FIXTURE PENDING DRAFT');
      await expect(own.getByLabel('Private Remarks 1',{exact:true})).toHaveValue('PRIVATE FIXTURE OWNER NOTE');
      await own.getByLabel('Private Remarks 1',{exact:true}).scrollIntoViewIfNeeded();await shot('private-editor');
      await button(competition,'Cancel').click();await expect(team.getByLabel('Team Remarks 1',{exact:true})).toHaveValue('TEAM FIXTURE PENDING DRAFT');
      const beforePrivate=await saved(page);await button(own,'SAVE').click();
      await expect(own).toContainText('PRIVATE FIXTURE OWNER NOTE');let after=await saved(page);
      assert.deepEqual(after.contributions,beforePrivate.contributions);assert.deepEqual(after.audit,beforePrivate.audit);
      await button(team,'SAVE').click();await expect(button(overview,'EDIT')).toBeVisible();after=await saved(page);
      assert.equal(after.contributions.length,initial.contributions.length+1);
      assert.ok(!JSON.stringify(after.contributions).includes('PRIVATE FIXTURE OWNER NOTE'));assert.ok(!JSON.stringify(after.audit).includes('PRIVATE FIXTURE OWNER NOTE'));
      await button(overview,'EDIT').click();await expect(team.getByLabel('Team Remarks 1',{exact:true})).toHaveValue('TEAM FIXTURE PENDING DRAFT');await expect(button(team,'SAVE')).toBeDisabled();await expect(own.getByLabel('Private Remarks 1',{exact:true})).toHaveValue('PRIVATE FIXTURE OWNER NOTE');await expect(button(own,'SAVE')).toBeDisabled();
      await competition.getByLabel('Competition 1',{exact:true}).fill('COMPETITOR FIXTURE SHARED NOTE');await button(competition,'SAVE').click();await button(team,'Cancel').click();await button(own,'Cancel').click();
      await expect(button(overview,'EDIT')).toHaveCount(1);after=await saved(page);assert.equal(after.contributions.length,initial.contributions.length+2);assert.deepEqual(finance(after),initialFinance);
      await button(page,'Close workspace').click();view=await profile(page);overview=view.locator('.buyer-overview-grid');await expect(overview).toContainText('PRIVATE FIXTURE OWNER NOTE');await expect(overview).toContainText('COMPETITOR FIXTURE SHARED NOTE');
      const workspaceFeedback=page.locator('.window-foot').getByRole('button',{name:'Feedback for ecosystem',exact:true});await credited(workspaceFeedback);
      await button(view,'Manage tabs').click();let manager=page.getByRole('dialog',{name:'Manage tabs',exact:true});await button(manager,'PRIVATE TAB').click();await manager.getByLabel('Tab 1 name',{exact:true}).fill('PRIVATE ACTION NOTE');await neutral(button(manager,'SAVE'));await button(manager,'SAVE').click();
      await view.getByRole('tab',{name:/PRIVATE ACTION NOTE/}).click();const content=view.locator('.profile-tab-content');await neutral(button(content,'EDIT'));await button(content,'EDIT').click();await neutral(button(content,'SAVE'));await button(content,'Cancel').click();
      await view.getByRole('tab',{name:'Overview',exact:true}).click();await button(overview,'EDIT').click();await team.getByLabel('Team Remarks 1',{exact:true}).fill('UNSAVED PREVIEW DRAFT');const beforePreview=await saved(page);
      state.preview={role:'trader',officeId:'HONG KONG',officeName:'HONG KONG',readOnly:true};await invalidateFixtureAuthority(page,{user:state.user,preview:state.preview});await expect(page.getByRole('status',{name:'Role preview'})).toBeVisible();await expect(page.getByText('UNSAVED PREVIEW DRAFT',{exact:true})).toHaveCount(0);assert.deepEqual((await saved(page)).contributions,beforePreview.contributions);
      state.preview=null;await invalidateFixtureAuthority(page,{user:state.user,preview:null});await expect(page.getByRole('status',{name:'Role preview'})).toHaveCount(0);view=await profile(page);await expect(view.locator('.buyer-overview-grid').getByRole('button',{name:'EDIT',exact:true})).toHaveCount(1);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No page horizontal overflow');
      state.user=null;await invalidateFixtureAuthority(page,{user:null,preview:null});await expect(page.getByRole('button',{name:'Feedback for ecosystem',exact:true})).toHaveCount(0);
      assert.deepEqual(state.unexpected,[]);assert.deepEqual(sharedLocations(page).requests,[],'Buyer/private actions leave shared location records unchanged');assert.deepEqual(errors,[]);
      results.push({engine,width,theme,passed:true});console.log(`PASS ${engine} ${width} ${theme}: neutral supplier/parser/admin/password actions, stable in-button contribution text, one Overview EDIT, independent drafts/saves, private tabs, VIEW AS/signout`);
    } catch(error) {await shot('failure');throw error;} finally {await context.close();}
  }}finally{await browser.close();await writeFile(resolve(out,'results.json'),JSON.stringify({base,results},null,2));}
}
