import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
const base=process.env.ECO_DEMO_URL||'http://127.0.0.1:4181';
const button=(scope,name)=>scope.getByRole('button',{name,exact:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
await mkdir('artifacts/readability',{recursive:true});
try{for(const [width,theme] of [[1440,'light'],[1280,'dark'],[390,'light']]){
 const context=await browser.newContext({viewport:{width,height:1000},hasTouch:width<700,reducedMotion:'reduce'});
 await context.addInitScript(theme=>localStorage.setItem('ecosystem.theme.v1',theme),theme);
 await context.route('**/*',route=>route.request().method()!=='GET'||new URL(route.request().url()).pathname.startsWith('/api/')?route.abort():route.continue());
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(10000);
 try{
  await page.goto(base);await page.getByLabel('Demo profile',{exact:true}).selectOption('otto');await button(page,'ENTER ECOSYSTEM').click();
  const nav=page.getByRole('navigation',{name:'Workspace navigation'});await button(nav,'Ports & Suppliers').click();await button(nav,'Countries & Ports').click();
  const ports=page.getByRole('dialog',{name:'Countries & Ports',exact:true});await button(ports,'Port Index').click();await ports.getByLabel('Country or port',{exact:true}).fill('Singapore');await button(ports.locator('.location-table'),'Singapore').click();
  await expect(ports.getByRole('heading',{name:'Key Info',exact:true})).toBeVisible();await expect(ports.getByRole('heading',{name:/^Top 10 suppliers$/i})).toBeVisible();
  const styles=await ports.locator('.knowledge-facts').evaluate(node=>{const style=getComputedStyle(node);return {border:style.borderTopColor,background:style.backgroundColor,shadow:style.boxShadow}});
  assert.match(styles.border,/rgb\(/);assert.notEqual(styles.background,'rgba(0, 0, 0, 0)');assert.notEqual(styles.shadow,'none');
  assert.ok(await ports.locator('.knowledge').evaluate(node=>node.scrollWidth<=node.clientWidth+1));
  await page.screenshot({path:`artifacts/readability/ports-${width}.png`});await button(ports,'Close workspace').click();
  await button(nav,'Trading').click();await button(nav,'Enquiries').click();
  const enquiries=page.getByRole('dialog',{name:'Enquiries',exact:true});await expect(enquiries).toBeVisible();
  assert.ok(await enquiries.evaluate(node=>node.scrollWidth<=node.clientWidth+1));await page.screenshot({path:`artifacts/readability/enquiries-${width}.png`});
  assert.deepEqual(errors,[]);console.log(`PASS ${width} ${theme}: Ports & Suppliers and Enquiries surfaces`);
 }finally{await context.close();}
}}finally{await browser.close();}
