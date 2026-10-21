import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
const BASE = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4173';
const browser = await chromium.launch({ headless:true, executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
await mkdir('artifacts/credit-visual',{recursive:true});
const saved = page => page.evaluate(() => JSON.parse(localStorage.getItem('ecosystem.demo.v1')));
const button = (scope,name) => scope.getByRole('button',{name,exact:true});
try { for(const [width,theme] of [[1440,'light'],[1280,'dark'],[390,'light'],[320,'dark']]) {
 const context = await browser.newContext({viewport:{width,height:1000},hasTouch:width<700,reducedMotion:'reduce'});
 await context.addInitScript(theme=>localStorage.setItem('ecosystem.theme.v1',theme),theme);
 await context.route('**/*',route=>route.request().method()!=='GET'||new URL(route.request().url()).pathname.startsWith('/api/')?route.abort():route.continue());
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(10000);
 try {
  await page.goto(BASE);await page.getByLabel('Demo profile',{exact:true}).selectOption('otto');await button(page,'ENTER ECOSYSTEM').click();
  const nav=page.getByRole('navigation',{name:'Workspace navigation'});await button(nav,'Buyers and Credit').click();await button(nav,'Buyer Profiles').click();
  const workspace=page.getByRole('dialog',{name:'Buyer Profiles',exact:true});
  const buyer=(await saved(page)).companies.find(item=>item.id==='company-meridian');
  await button(workspace,buyer.name).click();const profile=workspace.locator('.buyer-profile:visible');
  const credit=profile.getByRole('region',{name:'Credit Information',exact:true});
  await expect(profile.locator('.buyer-profile__header').getByText('Credit manager',{exact:true})).toBeVisible();
  await expect(credit.getByText('Credit Status',{exact:true})).toHaveCount(0);await expect(credit.getByText('Risk Category',{exact:true})).toHaveCount(0);
  await expect(credit.getByRole('meter',{name:'Risk rating',exact:true})).toHaveAttribute('aria-valuetext',`${buyer.riskRating} of 5; 1 is lower risk, 5 is higher risk`);
  const meter=credit.getByRole('meter',{name:'Credit limit used',exact:true});
  await expect(meter).toHaveAttribute('aria-valuetext',/used; .* available of /);assert.ok((await meter.boundingBox()).height>=12);
  const colors=await meter.evaluate(node=>({used:getComputedStyle(node.firstElementChild).backgroundColor,available:getComputedStyle(node).backgroundColor,image:getComputedStyle(node.firstElementChild).backgroundImage,usedKey:getComputedStyle(node.nextElementSibling.querySelector('i')).backgroundColor,availableKey:getComputedStyle(node.nextElementSibling.querySelector('span:last-child i')).backgroundColor}));assert.notEqual(colors.used,colors.available);assert.equal(colors.image,'none');assert.equal(colors.used,colors.usedKey);assert.equal(colors.available,colors.availableKey);
  for(const value of await profile.locator('.buyer-profile__trend-month>strong').allTextContents())assert.match(value,/MT$/);
  const competition=profile.getByRole('region',{name:'Competition',exact:true}), performance=profile.getByRole('region',{name:'Performance',exact:true});
  assert.ok((await competition.boundingBox()).y<(await performance.boundingBox()).y);
  await button(competition,'Update Competition').click();await competition.getByRole('textbox',{name:'Competition 1',exact:true}).fill('COMPETITOR ALPHA');
  await button(competition,'Add').click();await competition.getByRole('textbox',{name:'Competition 2',exact:true}).fill('COMPETITOR BETA');
  await button(competition,'Update').click();await expect(competition.locator('article')).toHaveCount(2);
  await button(competition,'Update Competition').click();await expect(competition.getByRole('textbox',{name:'Competition 1',exact:true})).toHaveValue('COMPETITOR ALPHA');
  await expect(button(competition,'Update')).toBeDisabled();await competition.getByRole('textbox',{name:'Competition 1',exact:true}).fill('COMPETITOR GAMMA');
  await button(competition,'Remove Competition 2').click();
  await profile.getByRole('tab',{name:'Stem Records',exact:true}).click();await profile.getByRole('tab',{name:'Overview',exact:true}).click();
  await expect(competition.getByRole('textbox',{name:'Competition 1',exact:true})).toHaveValue('COMPETITOR GAMMA');await button(competition,'Update').click();
  await expect(competition.locator('article')).toHaveCount(1);await expect(competition.locator('article')).toContainText('COMPETITOR GAMMA');
  const remarks=profile.getByRole('region',{name:'Team Remarks',exact:true});
  await button(remarks,'Update Team Remarks').click();await remarks.getByRole('textbox',{name:'Team Remarks 1',exact:true}).fill('GROUP REMARK BEFORE EDITING FOR THIS DEMO CHECK.');await button(remarks,'Update').click();
  await button(remarks,'Update Team Remarks').click();await expect(remarks.getByRole('textbox',{name:'Team Remarks 1',exact:true})).toHaveValue('GROUP REMARK BEFORE EDITING FOR THIS DEMO CHECK.');
  await remarks.getByRole('textbox',{name:'Team Remarks 1',exact:true}).fill('GROUP REMARK AFTER EDITING FOR THIS DEMO CHECK.');await button(remarks,'Update').click();
  await expect(remarks.locator('article')).toHaveCount(1);await expect(remarks.locator('article')).toContainText('AFTER EDITING');
  const privateNotes=profile.getByRole('region',{name:'Private Remarks',exact:true});
  await button(privateNotes,'Update Private Remarks').click();await privateNotes.getByRole('textbox',{name:'Private Remarks 1',exact:true}).fill('PRIVATE NOTE ONE');
  await button(privateNotes,'Add').click();await privateNotes.getByRole('textbox',{name:'Private Remarks 2',exact:true}).fill('PRIVATE NOTE TWO');await button(privateNotes,'Update').click();
  await expect(privateNotes.locator('article')).toHaveCount(2);await expect(privateNotes.locator('article').first().locator('time')).toBeVisible();
  await button(privateNotes,'Update Private Remarks').click();await privateNotes.getByRole('textbox',{name:'Private Remarks 1',exact:true}).fill('PRIVATE NOTE UPDATED');await button(privateNotes,'Remove Private Remarks 2').click();await button(privateNotes,'Update').click();
  await expect(privateNotes.locator('article')).toHaveCount(1);await expect(privateNotes.locator('article')).toContainText('PRIVATE NOTE UPDATED');
  const history=profile.getByRole('region',{name:'Credit History',exact:true});
  await expect(history.locator('.buyer-credit-history__recent>article')).toHaveCount(3);
  await button(history,'All history').click();await expect(profile.getByRole('tab',{name:'Credit History',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(profile.getByRole('textbox',{name:'Search credit history',exact:true})).toBeVisible();
  await profile.getByRole('tab',{name:'Overview',exact:true}).click();
  await expect(remarks.getByText(buyer.accountGroupName,{exact:true})).toHaveCount(0);
  const textStyles=await profile.evaluate(node=>({label:parseFloat(getComputedStyle(node.querySelector('.buyer-credit-approval dt')).fontSize),body:parseFloat(getComputedStyle(node.querySelector('.buyer-profile__remark-text')).fontSize),line:getComputedStyle(node).getPropertyValue('--line')}));
  assert.ok(textStyles.label>=11&&textStyles.body>=13);assert.ok(!textStyles.line.trim().endsWith('66'));
  assert.ok((await competition.boundingBox()).height<130,'Competition remains compact');
  const [groupStyle,competitionStyle]=await Promise.all([button(remarks,'Update Team Remarks'),button(competition,'Update Competition')].map(node=>node.evaluate(button=>({background:getComputedStyle(button).backgroundImage,color:getComputedStyle(button).color,border:getComputedStyle(button).borderColor}))));assert.deepEqual(groupStyle,competitionStyle);assert.match(groupStyle.background,/linear-gradient/);
  await workspace.locator('.window-content').evaluate(node=>node.scrollTop=0);await page.screenshot({path:`artifacts/credit-visual/profile-${width}.png`});
  const state=await saved(page);assert.equal(state.contributions.filter(entry=>entry.targetType==='buyer-competition'&&entry.targetId===buyer.id).length,2);
  assert.equal(state.buyerSharedLists[JSON.stringify(['competition',buyer.id])].entries[0].text,'COMPETITOR GAMMA');
  await page.reload();await button(page.getByRole('navigation',{name:'Workspace navigation'}),'Buyers and Credit').click();await button(page.getByRole('navigation',{name:'Workspace navigation'}),'Buyer Profiles').click();await button(workspace,buyer.name).click();
  await expect(competition.locator('article')).toHaveCount(1);await expect(remarks.locator('article')).toContainText('AFTER EDITING');await expect(privateNotes.locator('article')).toContainText('PRIVATE NOTE UPDATED');
  if(width===1440){
    await page.evaluate(()=>sessionStorage.setItem('ecosystem.session.v1','filippo'));await page.reload();
    const nav=page.getByRole('navigation',{name:'Workspace navigation'});await button(nav,'Buyers and Credit').click();await button(nav,'Buyer Profiles').click();await button(workspace,buyer.name).click();
    await expect(privateNotes.locator('article')).toHaveCount(0);await expect(remarks.locator('article')).toContainText('AFTER EDITING');
    await page.evaluate(()=>sessionStorage.setItem('ecosystem.session.v1','otto'));await page.reload();await button(page.getByRole('navigation',{name:'Workspace navigation'}),'Buyers and Credit').click();await button(page.getByRole('navigation',{name:'Workspace navigation'}),'Buyer Profiles').click();await button(workspace,buyer.name).click();
    await expect(privateNotes.locator('article')).toContainText('PRIVATE NOTE UPDATED');
  }
  assert.ok(await profile.evaluate(node=>node.scrollWidth<=node.clientWidth+1),'Profile fits the viewport');
  // Zero credit and over-limit accounts must not produce NaN or hide their real balance.
  for (const [limit,exposure,riskRating] of [[0,0,undefined],[100,200,5]]) {
    await page.evaluate(({limit,exposure,riskRating})=>{const state=JSON.parse(localStorage.getItem('ecosystem.demo.v1'));const buyer=state.companies.find(item=>item.id==='company-meridian');Object.assign(buyer,{limit,exposure,riskRating,temporaryCredits:[]});localStorage.setItem('ecosystem.demo.v1',JSON.stringify(state));},{limit,exposure,riskRating});
    await page.reload();const nav=page.getByRole('navigation',{name:'Workspace navigation'});await button(nav,'Buyers and Credit').click();await button(nav,'Buyer Profiles').click();await button(workspace,buyer.name).click();
    await expect(meter).toHaveAttribute('aria-valuenow',limit===0?'0':'100');
    await expect(credit).not.toContainText('NaN');
    if(limit===0)await expect(credit.getByRole('meter',{name:'Risk rating',exact:true})).toHaveCount(0);
    else {await expect(credit.getByRole('meter',{name:'Risk rating',exact:true})).toHaveAttribute('aria-valuenow','5');await expect(credit.locator('.credit-usage__numbers .is-negative')).toContainText('-$100');}
  }
  assert.deepEqual(errors,[]);console.log(`PASS ${width} ${theme}: credit/risk illustration, header manager, MT units, competition order, edit/remove, group edits and reload`);
 }finally{await context.close();}
}}finally{await browser.close();}
