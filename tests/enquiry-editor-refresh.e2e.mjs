import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
const BASE=process.env.ECO_DEMO_URL || 'http://127.0.0.1:4173';
const OUT=new URL('../artifacts/enquiry-editor-refresh/',import.meta.url);
const button=(scope,name)=>scope.getByRole('button',{name,exact:true});
const stateOf=page=>page.evaluate(()=>JSON.parse(localStorage.getItem('ecosystem.demo.v1')));
const layouts=[[1440,900,'light'],[1280,720,'dark'],[390,844,'light'],[320,844,'dark']].filter(([width])=>!process.env.WIDTH||width===Number(process.env.WIDTH));
async function workspace(page,group,name){
  const nav=page.getByRole('navigation',{name:'Workspace navigation'});
  if(await button(nav,group).getAttribute('aria-expanded')!=='true')await button(nav,group).click();
  await button(nav,name).click();return page.getByRole('dialog',{name,exact:true});
}
async function close(page){await button(page,'Close workspace').click();}
async function port(page,name='Singapore'){
 const dialog=await workspace(page,'Ports & Suppliers','Countries & Ports');
 await button(dialog,'Port Index').click();await dialog.getByLabel('Country or port',{exact:true}).fill(name);
 await button(dialog.locator('.location-table'),name).click();return dialog;
}
async function editor(page,profile){await profile.locator('.knowledge-header:visible').getByRole('button',{name:/^Update(?:\s|$)/}).click();return page.getByRole('dialog',{name:'Update information',exact:true});}
const order=editor=>editor.locator('.knowledge-outline-item').evaluateAll(nodes=>nodes.map(node=>node.dataset.blockId));
async function drag(page,source,target,edge,kind='block'){
 const transfer=await page.evaluateHandle(()=>new DataTransfer());
 await source.dispatchEvent('dragstart',{dataTransfer:transfer});
 const bounds=await target.boundingBox();
 const point={clientX:bounds.x+bounds.width*(kind==='column'?(edge==='before'?.2:.8):.5),clientY:bounds.y+bounds.height*(kind==='column'?.5:(edge==='before'?.2:.8))};
 await target.dispatchEvent('dragover',{dataTransfer:transfer,...point});
 const cls=kind==='block'||kind==='tab'?`is-drop-${edge}`:`sheet-drop-${kind}-${edge}`;
 await expect(target).toHaveClass(new RegExp(cls));
 if(kind==='block'||kind==='tab'){
   const style=await target.evaluate((node,edge)=>{const s=getComputedStyle(node,'::after');return {height:parseFloat(s.height),where:parseFloat(edge==='before'?s.top:s.bottom),color:s.backgroundColor}},edge);
   assert.ok(style.height>=3&&style.where<0&&style.color!=='rgba(0, 0, 0, 0)','Insertion line is visible at exact boundary');
 }
 await target.dispatchEvent('drop',{dataTransfer:transfer,...point});await source.dispatchEvent('dragend',{dataTransfer:transfer});
 await transfer.dispose();
}
await mkdir(OUT,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{for(const [width,height,theme] of layouts){
 const context=await browser.newContext({viewport:{width,height},reducedMotion:'reduce',hasTouch:width<500});
 await context.addInitScript(theme=>localStorage.setItem('ecosystem.theme.v1',theme),theme);
 const page=await context.newPage();page.setDefaultTimeout(10000);page.on('dialog',dialog=>dialog.accept());
 const errors=[],writes=[];page.on('pageerror',error=>errors.push(error.message));
 await context.route('**/*',route=>{const r=route.request();if(!['GET','HEAD','OPTIONS'].includes(r.method())||new URL(r.url()).pathname.startsWith('/api/')){writes.push(r.url());return route.abort();}return route.continue();});
 try{
  await page.goto(BASE);await page.getByLabel('Demo profile',{exact:true}).selectOption('otto');await button(page,'ENTER ECOSYSTEM').click();
  let center=await workspace(page,'Trading','Enquiries');
  await expect(button(center,'New lead')).toHaveCount(0);await expect(button(center,'Add lead')).toHaveCount(0);
  await expect(button(center,'New enquiry')).toHaveCount(0);await expect(center.locator('.center-incoming > header button')).toHaveCount(0);
  await expect(center.locator('.center-credit-legend')).not.toContainText('%');
  const buyer=(await stateOf(page)).companies.find(item=>item.id==='company-meridian');
  await center.getByLabel('Raw enquiry',{exact:true}).fill(`Buyer: ${buyer.name}\nVessel: LAYOUT TEST\nIMO: 9876543\nPort: Singapore\nETA: 15 October\nVLSFO: 500 MT`);
  await expect(center.getByLabel('Vessel',{exact:true})).toHaveValue('LAYOUT TEST');await expect(center.getByRole('combobox',{name:'Buyer',exact:true})).toHaveValue(buyer.name.toUpperCase());
  const vessel=await center.getByLabel('Vessel',{exact:true}).boundingBox(),imo=await center.getByLabel('IMO',{exact:true}).boundingBox(),eta=await center.getByLabel('ETA',{exact:true}).boundingBox(),portBox=await center.getByRole('combobox',{name:'Port',exact:true}).boundingBox();
  assert.ok(imo.y>vessel.y+vessel.height && portBox.y>imo.y+imo.height && eta.y>portBox.y+portBox.height,'Vessel, IMO, Port, ETA each have their own row');
  for(const field of [imo,portBox,eta])assert.ok(Math.abs(field.x-vessel.x)<2 && Math.abs(field.width-vessel.width)<2);
  const meter=center.getByRole('meter',{name:'Credit used',exact:true});await expect(meter).toHaveAttribute('aria-valuetext',/used; .* available of /);
  await expect(center.locator('.center-credit-limit')).toContainText('Credit limit');await expect(center.locator('.center-credit-numbers')).toContainText('Used');
  const used=await meter.getAttribute('aria-valuenow');assert.ok(Math.abs(Number(used)-buyer.exposure/buyer.limit*100)<.01);
  assert.ok((await meter.boundingBox()).height>=10,'Credit bar is clearly visible');
  const barColors=await center.locator('.center-credit-indicator').evaluate(node=>({used:getComputedStyle(node.querySelector('.center-credit-track > span')).backgroundColor,available:getComputedStyle(node.querySelector('.center-credit-track')).backgroundColor,usedKey:getComputedStyle(node.querySelector('.center-credit-legend > span:first-child i')).backgroundColor,availableKey:getComputedStyle(node.querySelector('.center-credit-legend > span:last-child i')).backgroundColor,image:getComputedStyle(node.querySelector('.center-credit-track > span')).backgroundImage}));
  assert.equal(barColors.used,barColors.usedKey);assert.equal(barColors.available,barColors.availableKey);assert.notEqual(barColors.used,barColors.available);assert.equal(barColors.image,'none','Solid segments match their legends');
  if(width>=1120){const side=await center.locator('.center-sidebar').boundingBox();assert.ok(side.width>=280);}
  await expect(button(center,'Confirm')).toBeEnabled();await button(center,'Confirm').click();
  await expect.poll(async()=>(await stateOf(page)).enquiries.find(item=>item.vessel==='LAYOUT TEST')?.status).toBe('sent');
  await expect(center.locator('.center-incoming-row').filter({hasText:'LAYOUT TEST'})).toContainText('Amend');
  await button(center,'Clear parser').click();await expect(center.getByLabel('Raw enquiry',{exact:true})).toHaveValue('');
  await center.locator('.center-incoming-row').filter({hasText:'LAYOUT TEST'}).getByRole('button',{name:'Amend',exact:true}).click();
  await expect(center.getByLabel('Vessel',{exact:true})).toHaveValue('LAYOUT TEST');
  const row=center.locator('.center-incoming-row').first();if(await row.count()){const box=await row.boundingBox();assert.ok(box.height<110,'Compact incoming card');}
  await page.screenshot({path:new URL(`enquiry-${width}-${theme}.png`,OUT).pathname});await close(page);
  let profile=await port(page);
  const summary=profile.locator('.knowledge-port-summary:visible'),facts=summary.locator('.knowledge-facts'),ranking=summary.locator('.knowledge-top-suppliers');
  const factBox=await facts.boundingBox(),rankBox=await ranking.boundingBox();
  if(width>=1000)assert.ok(Math.abs(factBox.y-rankBox.y)<2 && rankBox.x>=factBox.x+factBox.width,'Key Info and suppliers are side by side');
  else assert.ok(rankBox.y>=factBox.y+factBox.height,'Summary stacks at phone widths');
  const factRows=await facts.locator('dl > div').evaluateAll(nodes=>nodes.map(node=>{const b=node.getBoundingClientRect();return {x:b.x,y:b.y}}));
  assert.ok(factRows.every((row,index)=>index===0||row.y>factRows[index-1].y&&Math.abs(row.x-factRows[0].x)<1));
  const leaderboard=profile.locator('.knowledge-top-suppliers:visible');await expect(leaderboard.locator('li')).toHaveCount(10);
  assert.deepEqual(await leaderboard.locator('li').evaluateAll(nodes=>nodes.map(node=>Number(node.dataset.rank))),[1,2,3,4,5,6,7,7,9,10]);
  assert.equal(await leaderboard.locator('ol').evaluate(node=>getComputedStyle(node).display),'block');
  const names=await leaderboard.locator('li button').evaluateAll(nodes=>nodes.map(node=>node.textContent));
  assert.ok(names.every(text=>!text.includes('fixtures')),'No repeated fixture labels in rows');
  const bars=await leaderboard.locator('.knowledge-supplier-bar i').evaluateAll(nodes=>nodes.map(node=>parseFloat(node.style.width)));
  assert.equal(bars[0],100);assert.ok(bars.every((value,index)=>index===0||value<=bars[index-1]));
  await profile.locator('.knowledge-facts:visible').getByRole('button',{name:'Update',exact:true}).click();
  let modal=page.getByRole('dialog',{name:'Update Key Info',exact:true});
  await expect(modal.getByRole('textbox',{name:'Reason',exact:true})).toHaveCount(0);await expect(modal.getByRole('textbox',{name:'Source',exact:true})).toHaveCount(0);
  await modal.getByRole('textbox',{name:'ISO Specs',exact:true}).fill('CUSTOM ISO CHECK');await button(modal,'Update').click();await expect(modal).toHaveCount(0);
  await expect(profile.locator('.knowledge-facts:visible .knowledge-fact-title .knowledge-entry-audit')).toHaveCount(1);
  await expect(profile.locator('.knowledge-facts:visible .knowledge-fact-value .knowledge-entry-audit')).toHaveCount(0);
  await page.screenshot({path:new URL(`port-${width}-${theme}.png`,OUT).pathname});
  await close(page);
  // Exact seeded records let the saved result prove ordering and content preservation.
  await page.evaluate(()=>{
   const state=JSON.parse(localStorage.getItem('ecosystem.demo.v1'));
   state.knowledgeRecords={...state.knowledgeRecords,'port:port-chiba':{version:1,layoutVersion:2,sections:[{id:'tab-info',title:'Port Information',role:'port-information',blocks:[{id:'a',type:'text',title:'FIRST NOTE',text:'FIRST CONTENT'}]},{id:'tab-other',title:'Operations',blocks:[]},{id:'tab-last',title:'Last tab',blocks:[]}]}};
   localStorage.setItem('ecosystem.demo.v1',JSON.stringify(state));
  });await page.reload();profile=await port(page,'Chiba');
  let edit=await editor(page,profile);
  const outline=edit.getByRole('navigation',{name:'Information sections',exact:true});await expect(outline).toBeVisible();await expect(outline.locator('.knowledge-outline-item')).toHaveCount(1);
  for(const name of ['Add Text','Add Table'])await expect(button(outline,name)).toBeVisible();
  await edit.getByLabel('Edit tab',{exact:true}).selectOption('tab-other');await expect(outline).toBeVisible();await expect(outline.locator('.knowledge-outline-item')).toHaveCount(0);await edit.getByLabel('Edit tab',{exact:true}).selectOption('tab-info');
  await expect(button(edit,'Add file link')).toHaveCount(0);await expect(edit.getByRole('button',{name:/Move block .* (up|down)/})).toHaveCount(0);
  await expect(edit.locator('.knowledge-editor-topbar').getByRole('button',{name:/Add (Text|Table)/})).toHaveCount(0);
  await button(outline,'Add Text').click();await edit.getByLabel('Block 2 title',{exact:true}).fill('SECOND NOTE');await edit.getByLabel('Block 2 text',{exact:true}).fill('SECOND CONTENT');
  await button(outline,'Add Table').click();await edit.getByLabel('Block 3 title',{exact:true}).fill('TABLE');
  await edit.getByLabel('Row 1, Name',{exact:true}).fill('ZULU');await button(edit,'Add Row').click();await edit.getByLabel('Row 2, Name',{exact:true}).fill('ALPHA');
  await expect(button(edit,'Sort Z–A')).toHaveCount(0);const controls=edit.getByRole('group',{name:'Table controls'});
  assert.deepEqual(await controls.getByRole('button').allTextContents(),[' Sort A–Z',' Add Row',' Add Column','Copy']);
  await edit.getByLabel('Selected cell',{exact:true}).fill('A1');await edit.getByLabel('Selected cell',{exact:true}).press('Enter');
  await button(edit,'Sort A–Z').click();await expect(edit.getByLabel('Row 1, Name',{exact:true})).toHaveValue('ALPHA');
  if(width>=1000){
   await drag(page,button(edit,'Row 1 actions'),edit.locator('tbody tr').nth(1),'after','row');await expect(edit.getByLabel('Row 2, Name',{exact:true})).toHaveValue('ALPHA');
   await drag(page,button(edit,'Row 2 actions'),edit.locator('tbody tr').nth(0),'before','row');await expect(edit.getByLabel('Row 1, Name',{exact:true})).toHaveValue('ALPHA');
   await drag(page,button(edit,'Column 1 actions'),edit.locator('thead th').nth(2),'after','column');await expect(edit.getByLabel('Column 2 name',{exact:true})).toHaveValue('Name');
   await drag(page,button(edit,'Column 2 actions'),edit.locator('thead th').nth(1),'before','column');await expect(edit.getByLabel('Column 1 name',{exact:true})).toHaveValue('Name');
  }
  const initialOrder=await order(edit),[a,b,c]=initialOrder;
  const item=id=>edit.locator(`.knowledge-outline-item[data-block-id="${id}"]`);
  await drag(page,item(a).locator('.knowledge-outline-grip'),item(c),'before');assert.deepEqual(await order(edit),[b,a,c]);
  await drag(page,item(a).locator('.knowledge-outline-grip'),item(c),'after');assert.deepEqual(await order(edit),[b,c,a]);
  await drag(page,item(a).locator('.knowledge-outline-grip'),item(b),'before');assert.deepEqual(await order(edit),[a,b,c]);
  // Touch-specific pointer handling uses the same exact before/after destination.
  if(width<500){
   const from=await item(a).locator('.knowledge-outline-grip').boundingBox(),to=await item(c).boundingBox();
   const touch=await context.newCDPSession(page);
   await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:from.x+3,y:from.y+3}]});
   await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:to.x+20,y:to.y+to.height-3}]});
   await expect(item(c)).toHaveClass(/is-drop-after/);
   await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await touch.detach();
   assert.deepEqual(await order(edit),[b,c,a]);await item(a).locator('.knowledge-outline-select').press('Alt+ArrowUp');await item(a).locator('.knowledge-outline-select').press('Alt+ArrowUp');
  }
  await expect(edit.getByLabel('Block 1 text',{exact:true})).toHaveValue('FIRST CONTENT');
  await button(edit,'Shrink window').click();await expect(outline).toBeVisible();await expect(edit.getByLabel('Block 1 text',{exact:true})).toHaveValue('FIRST CONTENT');await button(edit,'Expand window').click();
  await page.screenshot({path:new URL(`editor-${width}-${theme}.png`,OUT).pathname});
  await button(edit,'Update').click();await expect(edit).toHaveCount(0);
  let state=await stateOf(page);assert.deepEqual(state.knowledgeRecords['port:port-chiba'].sections[0].blocks.map(block=>block.id),[a,b,c]);
  assert.equal(state.knowledgeRecords['port:port-chiba'].sections[0].blocks[0].text,'FIRST CONTENT');
  assert.deepEqual(state.knowledgeRecords['port:port-chiba'].sections[0].blocks[2].rows.map(row=>row.cells[0]),['ALPHA','ZULU']);
  await button(profile,'Manage Tabs').click();modal=page.getByRole('dialog',{name:'Manage Tabs',exact:true});
  const tab=id=>modal.locator(`.knowledge-manage-row[data-tab-id="${id}"]`);
  await drag(page,tab('tab-info').locator('.knowledge-manage-grip'),tab('tab-last'),'after','tab');
  assert.deepEqual(await modal.locator('.knowledge-manage-row').evaluateAll(nodes=>nodes.map(node=>node.dataset.tabId)),['tab-other','tab-last','tab-info']);
  await button(modal,'Save').click();await expect(modal).toHaveCount(0);await page.reload();profile=await port(page,'Chiba');
  state=await stateOf(page);assert.deepEqual(state.knowledgeRecords['port:port-chiba'].sections.map(tab=>tab.id),['tab-other','tab-last','tab-info']);
  assert.deepEqual(state.knowledgeRecords['port:port-chiba'].sections[2].blocks.map(block=>block.id),[a,b,c]);
  await close(page);const buyers=await workspace(page,'Buyers and Credit','Buyer Profiles');
  await buyers.getByRole('textbox',{name:'Search buyer profiles',exact:true}).fill(buyer.name);await button(buyers,buyer.name).click();
  const buyerProfile=buyers.locator('.buyer-profile:visible'),overview=buyerProfile.getByRole('tabpanel',{name:'Overview',exact:true});
  await expect(buyerProfile.getByRole('tab')).toHaveText(['Overview','Stem Records','Credit Requests','Company Information']);
  for(const name of ['Credit Information','Performance','Credit History','Remarks','Competition'])await expect(overview.getByRole('region',{name,exact:true})).toBeVisible();
  const columns=await overview.locator(':scope > .buyer-overview-column').evaluateAll(nodes=>nodes.map(node=>{const b=node.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width}}));
  if(width>=1280)assert.ok(columns[0].x<columns[1].x&&columns[1].x<columns[2].x&&columns.every(c=>c.width<width*.4),'Three narrow overview columns');
  for(const selector of ['.buyer-credit-summary > dl','.buyer-profile__metrics > div']){
   const rows=await overview.locator(selector).evaluateAll(nodes=>nodes.map(node=>{const b=node.getBoundingClientRect();return {x:b.x,y:b.y}}));
   assert.ok(rows.every((row,index)=>index===0||row.y>rows[index-1].y&&Math.abs(row.x-rows[0].x)<1),'One fact per row');
  }
  const competition=overview.getByRole('region',{name:'Competition',exact:true});await button(competition,'Update Competition').click();
  await competition.getByRole('textbox',{name:'Competition 1',exact:true}).fill('OVERVIEW COMPETITOR CHECK');await button(competition,'Update').click();
  await expect(competition).toContainText('OVERVIEW COMPETITOR CHECK');await page.reload();
  await workspace(page,'Buyers and Credit','Buyer Profiles');await buyers.getByRole('textbox',{name:'Search buyer profiles',exact:true}).fill(buyer.name);await button(buyers,buyer.name).click();
  await expect(buyers.locator('.buyer-profile:visible').getByRole('region',{name:'Competition',exact:true})).toContainText('OVERVIEW COMPETITOR CHECK');
  await page.screenshot({path:new URL(`buyer-${width}-${theme}.png`,OUT).pathname});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No page overflow');assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
  console.log(`PASS ${width} ${theme}: compact enquiry, supplier leaderboard, key-info fields/audits, permanent section outline, save/reload, drop indicators and exact destinations`);
 }catch(error){await page.screenshot({path:new URL(`failure-${width}.png`,OUT).pathname});throw error;}finally{await context.close();}
}}finally{await browser.close();}
