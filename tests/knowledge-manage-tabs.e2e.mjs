import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
const BASE = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4173';
const OUT = new URL('../artifacts/manage-tabs/', import.meta.url);
const SUPPLIERS = 'SUPPLIERS AND REGIONAL DELIVERY CONTACTS';
const EXTRA = 'ADDITIONAL OPERATIONAL ARRANGEMENTS AND LOCAL REQUIREMENTS';
const readState = page => page.evaluate(() => JSON.parse(localStorage.getItem('ecosystem.demo.v1')));
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
async function enter(page) {
  await page.goto(BASE);
  const login = page.getByLabel('Demo profile', { exact: true });
  if (await login.isVisible()) {
    await login.selectOption('otto');
    await page.getByRole('button', { name: 'ENTER ECOSYSTEM', exact: true }).click();
  }
}
async function openProfile(page, name = 'Hong Kong') {
  const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
  const button = nav.getByRole('button', { name: 'Countries & Ports', exact: true });
  if (!(await button.isVisible())) await nav.getByRole('button', { name: 'Ports & Suppliers', exact: true }).click();
  await button.click();
  const profile = page.getByRole('dialog', { name: 'Countries & Ports', exact: true });
  await profile.getByRole('button', { name: 'Port Index', exact: true }).click();
  await profile.getByLabel('Country or port', { exact: true }).fill(name);
  await profile.locator('.location-table').getByRole('button', { name, exact: true }).click();
  return profile;
}
async function manage(page, profile) {
  await profile.getByRole('button', { name: 'Manage Tabs', exact: true }).click();
  return page.getByRole('dialog', { name: 'Manage Tabs', exact: true });
}
async function namedRow(dialog, name) {
  const rows = dialog.locator('.knowledge-manage-row');
  for (let index = 0; index < await rows.count(); index++) {
    if ((await rows.nth(index).getByRole('textbox').inputValue()).toLowerCase() === name.toLowerCase()) return rows.nth(index);
  }
  throw new Error(`Manage Tabs has no row named ${name}`);
}
async function rename(dialog, from, to) { await (await namedRow(dialog, from)).getByRole('textbox').fill(to); }
async function remove(dialog, name) { await (await namedRow(dialog, name)).getByRole('button', { name: /^Remove tab / }).click(); }
async function save(dialog) { await dialog.getByRole('button', { name: 'Save', exact: true }).click(); await expect(dialog).toHaveCount(0); }
async function assertWrap(profile, viewport) {
  const bar = profile.getByRole('tablist', { name: 'Information sections' });
  const result = await bar.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth, buttons: [...element.querySelectorAll('[role="tab"]')].map(button => { const r = button.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}; }) }));
  assert.ok(result.scroll <= result.width + 1, 'Tab bar never scrolls horizontally');
  assert.ok(result.buttons.every(button => button.left >= -1 && button.right <= viewport.width + 1), 'Long tab names fit viewport');
  assert.ok(new Set(result.buttons.map(button => Math.round(button.top))).size > 1, 'Long tab names wrap to another row');
}
async function fixedScroll(profile) {
  const controls = ['.location-toolbar', '.knowledge-header', '.knowledge-tabs-row'];
  const before = await Promise.all(controls.map(selector => profile.locator(selector).boundingBox()));
  assert.ok(before.every(Boolean));
  const body = profile.locator('.knowledge-content');
  const scroll = await body.evaluate(element => { element.scrollTop = element.scrollHeight; return { top: element.scrollTop, height:element.clientHeight, extent:element.scrollHeight }; });
  assert.ok(scroll.top > 20, `Only information body scrolls (${JSON.stringify(scroll)})`);
  assert.ok(scroll.height > 80, 'Information viewport remains usable at short window heights');
  const after = await Promise.all(controls.map(selector => profile.locator(selector).boundingBox()));
  before.forEach((box,index) => { assert.ok(Math.abs(box.y - after[index].y) < 1, `${controls[index]} stays fixed while content scrolls`); });
}
try {
  const layouts = [{width:1440,height:800},{width:1280,height:720},{width:390,height:844}].filter(viewport => !process.env.ECO_MANAGE_WIDTH || viewport.width === Number(process.env.ECO_MANAGE_WIDTH));
  for (const viewport of layouts) {
    const context = await browser.newContext({ viewport, reducedMotion:'reduce' });
    const page = await context.newPage();
    const errors=[];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    try {
      await enter(page);
      let profile = await openProfile(page);
      await expect(profile.locator('.location-breadcrumb')).toHaveCount(0);
      await expect(profile.locator('.knowledge-section-toolbar')).toHaveCount(0);
      await expect(profile.getByLabel('Search information',{exact:true})).toHaveCount(0);
      for(const name of ['Add Text','Add Table','Add file link']) await expect(profile.getByRole('button',{name,exact:true})).toHaveCount(0);
      await expect(profile.getByRole('button',{name:'Add Tab',exact:true})).toHaveCount(0);
      const feedback=profile.locator('.window-foot-actions').getByRole('button',{name:'Feedback for ecosystem',exact:true});
      await expect(feedback).toContainText('+1');
      const color=await feedback.evaluate(element=>getComputedStyle(element).backgroundColor);
      const channels=color.match(/[\d.]+/g).map(Number);
      assert.ok(channels[1]>channels[0] && channels[1]>channels[2],`Feedback uses green background: ${color}`);
      const keyInfo=profile.locator('.knowledge-facts').getByRole('button',{name:'Update',exact:true});
      await expect(keyInfo).toBeVisible();
      await expect(keyInfo).not.toContainText('+1');
      let dialog=await manage(page,profile);
      assert.equal(await dialog.locator('.knowledge-manage-row').count(),8);
      await rename(dialog,'Port Information','OPERATIONS');
      await rename(dialog,'Uploaded Documents','DOCUMENT LIBRARY');
      await rename(dialog,'Price History','RECORDED PRICES');
      await rename(dialog,'Suppliers',SUPPLIERS);
      await remove(dialog,'Refineries');
      await dialog.getByRole('button',{name:'Add Tab',exact:true}).click();
      await dialog.locator('.knowledge-manage-row').last().getByRole('textbox').fill(EXTRA);
      await save(dialog);
      await assertWrap(profile,viewport);
      for (const name of ['OPERATIONS','DOCUMENT LIBRARY','RECORDED PRICES',SUPPLIERS,EXTRA]) await expect(profile.getByRole('tab',{name,exact:true})).toBeVisible();
      for (const name of ['Port Information','Uploaded Documents','Price History','Refineries']) await expect(profile.getByRole('tab',{name,exact:true})).toHaveCount(0);
      await profile.getByRole('tab',{name:'OPERATIONS',exact:true}).click();
      await expect(profile.locator('.knowledge-facts')).toBeVisible();
      await profile.getByRole('tab',{name:'RECORDED PRICES',exact:true}).click();
      await expect(profile.getByRole('region',{name:'RECORDED PRICES',exact:true})).toBeVisible();
      await profile.getByRole('tab',{name:SUPPLIERS,exact:true}).click();
      await fixedScroll(profile);
      await page.screenshot({path:new URL(`fixed-profile-${viewport.width}x${viewport.height}.png`,OUT).pathname});
      await profile.locator('.knowledge-header').getByRole('button',{name:/^Update(?:\s|$)/}).click();
      let editor=page.getByRole('dialog',{name:'Update information',exact:true});
      await editor.getByRole('button',{name:'Add file link',exact:true}).click();
      await expect(editor.getByRole('button',{name:'Preview changes',exact:true})).toHaveCount(0);
      await expect(editor.getByLabel('Reason',{exact:true})).toHaveCount(0);
      await expect(editor.getByLabel('Source',{exact:true})).toHaveCount(0);
      await expect(editor.getByText('Reason and source',{exact:true})).toHaveCount(0);
      await expect(editor.getByLabel('Edit tab',{exact:true}).locator('option:checked')).toHaveText('DOCUMENT LIBRARY');
      await editor.getByLabel('Block 1 title',{exact:true}).fill('AGENT DOCUMENT');
      await editor.getByLabel('HTTPS file link',{exact:true}).fill('https://example.com/agent-document.pdf');
      await editor.getByRole('button',{name:'Update',exact:true}).click();
      await expect(editor).toHaveCount(0);
      await expect(profile.getByRole('tab',{name:'DOCUMENT LIBRARY',exact:true})).toHaveAttribute('aria-selected','true');
      await expect(profile.getByRole('link',{name:/AGENT DOCUMENT/})).toBeVisible();
      await page.reload(); await enter(page); profile=await openProfile(page);
      for(const name of ['OPERATIONS','DOCUMENT LIBRARY','RECORDED PRICES',SUPPLIERS,EXTRA]) await expect(profile.getByRole('tab',{name,exact:true})).toBeVisible();
      await expect(profile.getByRole('tab',{name:'Refineries',exact:true})).toHaveCount(0);
      await profile.getByRole('tab',{name:'DOCUMENT LIBRARY',exact:true}).click();
      await expect(profile.getByRole('link',{name:/AGENT DOCUMENT/})).toBeVisible();
      const beforeRemove=await readState(page);
      dialog=await manage(page,profile);
      await remove(dialog,'DOCUMENT LIBRARY');
      await dialog.getByLabel('Restore default tab',{exact:true}).selectOption('uploaded-documents');
      await expect((await namedRow(dialog,'DOCUMENT LIBRARY')).getByRole('textbox')).toHaveValue('DOCUMENT LIBRARY');
      await save(dialog);
      await profile.getByRole('tab',{name:'DOCUMENT LIBRARY',exact:true}).click();
      await expect(profile.getByRole('link',{name:/AGENT DOCUMENT/})).toBeVisible();
      const restored=await readState(page);
      const documentFile=state=>state.knowledgeRecords['port:port-hong-kong'].sections.flatMap(section=>section.blocks).find(block=>block.title==='AGENT DOCUMENT');
      assert.deepEqual(documentFile(restored),documentFile(beforeRemove),'Restoring an unsaved removal preserves the original file and audit');
      dialog=await manage(page,profile);
      await remove(dialog,'OPERATIONS'); await remove(dialog,'RECORDED PRICES'); await remove(dialog,'DOCUMENT LIBRARY');
      await save(dialog);
      await page.reload(); await enter(page); profile=await openProfile(page);
      for(const name of ['OPERATIONS','RECORDED PRICES','DOCUMENT LIBRARY','Port Information','Price History','Uploaded Documents']) await expect(profile.getByRole('tab',{name,exact:true})).toHaveCount(0);
      const afterRemove=await readState(page);
      assert.ok(afterRemove.knowledgeHistory.length>beforeRemove.knowledgeHistory.length);
      assert.ok(JSON.stringify(afterRemove.knowledgeHistory).includes('AGENT DOCUMENT'),'Removed information remains in audit snapshots');
      dialog=await manage(page,profile);
      await dialog.getByLabel('Restore default tab',{exact:true}).selectOption('price-history');
      await save(dialog);
      await profile.getByRole('tab',{name:'Price History',exact:true}).click();
      await expect(profile.getByRole('region',{name:'Price History',exact:true})).toBeVisible();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
      assert.deepEqual(errors,[]);
      console.log(`PASS ${viewport.width}x${viewport.height}: editable default/special tabs, persistent removal, wrapped long names, fixed profile controls, file semantic role, removed Reason/Source, reward labels`);
    }catch(error){await page.screenshot({path:new URL(`failure-${viewport.width}.png`,OUT).pathname}).catch(()=>{});throw error;}
    finally{await context.close();}
  }
}finally{await browser.close();}
