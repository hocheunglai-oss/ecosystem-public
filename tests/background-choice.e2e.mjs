import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { installSharedLocations } from './fixtures/shared-locations.mjs';
import { installStagingCookies } from './fixtures/protection-cookies.mjs';
const base=process.env.ECO_BACKGROUND_UI_ORIGIN || 'http://127.0.0.1:4286';
const out=resolve(process.env.ECO_BACKGROUND_UI_OUTPUT || tmpdir()+'/eco-background-choice');
const reports=resolve(process.env.ECO_BACKGROUND_REPORT_OUTPUT || out);
await mkdir(out,{recursive:true}); await mkdir(reports,{recursive:true});
const results=[];
const member = {
  capabilities: { appearancePreview: false, testWorkspace: false },
  id: '10000000-0000-4000-8000-000000000001', email: 'Trader.Case@example.test',
  displayName: 'SAMPLE TRADER', phone: '+6591815902', officeId: 'HONG KONG',
  officeName: 'HONG KONG', isAdmin: true, isSpcTrader: true, isManager: false,
  isActive: true, activated: true, passwordChangeSuggested: false, revision: 1,
};
async function mocks(context) {
  const state = { signedIn: false, unexpected: [], writes: [] };
  await context.route('**/api/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') state.writes.push(path);
    if (path === '/api/access/session') return route.fulfill(state.signedIn ? { json: { user: member, preview: null } } : { status: 401, json: { message: 'Sign in required.' } });
    if (path === '/api/access/login') { state.signedIn = true; return route.fulfill({ json: { user: member, preview: null } }); }
    if (path === '/api/access/logout') { state.signedIn = false; return route.fulfill({ json: { user: null } }); }
    if (path === '/api/access/phone-requests') return route.fulfill({ json: { requests: [] } });
    if (path === '/api/access/users') return route.fulfill({ json: { users: [member], offices: [{ id: 'HONG KONG', name: 'HONG KONG' }] } });
    if (path === '/api/enquiries/test-policy') return route.fulfill({ json: { enabled: false, generation: '' } });
    if (path === '/api/enquiries/inbox') return route.fulfill({ json: { items: [], nextCursor: null, unreadCount: 0 } });
    if (path === '/api/enquiries/records') return route.fulfill({ json: { items: [], nextCursor: null } });
    if (path === '/api/intelligence/snapshot') return route.fulfill({ json: { available: false, snapshot: null } });
    if (path.startsWith('/api/admin/')) return route.fulfill({ json: { items: [], count: 0, nextCursor: null, periodStart: '2026-10-20T00:00:00Z', periodEnd: '2026-10-27T00:00:00Z', timeZone: 'Asia/Hong_Kong', source: 'shared-feedback' } });
    state.unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 503, json: { message: 'Unmatched synthetic test request.' } });
  });
  await installSharedLocations(context, { user: () => state.signedIn ? member : null });
  return state;
}
async function pixels(page) {
  const bytes=await page.screenshot({animations:'allow'});
  return page.evaluate(async data=>{
    const image=new Image(); image.src=data; await image.decode();
    const canvas=document.createElement('canvas'); canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
    const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
    const excluded=[...document.querySelectorAll('.world-identity,.main-search,.world-launcher,.home-hud-stack,.flowing-footer,.entry-brand,.access-login')].map(n=>n.getBoundingClientRect());
    const colours=[];
    for(let y=8;y<innerHeight-8;y+=12)for(let x=8;x<innerWidth-8;x+=12){
      if(excluded.some(b=>x>=b.left-4&&x<=b.right+4&&y>=b.top-4&&y<=b.bottom+4))continue;
      const i=(Math.floor(y*canvas.height/innerHeight)*canvas.width+Math.floor(x*canvas.width/innerWidth))*4;
      colours.push([pixels[i],pixels[i+1],pixels[i+2]]);
    }
    return {count:colours.length, mean:colours.flat().reduce((a,b)=>a+b,0)/(colours.length*3), spread:Math.max(...colours.flat())-Math.min(...colours.flat())};
  },'data:image/png;base64,'+bytes.toString('base64'));
}
async function shot(page,name){
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No horizontal overflow');
  const choice=page.getByLabel('Background',{exact:true});
  await expect(choice).toBeVisible();
  const box=await choice.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=await page.evaluate(()=>innerWidth)+1&&box.height>=44,'Readable selector fits phone');
  await page.screenshot({path:`${out}/${name}.png`,fullPage:true});
}
async function ready(page,choice){
  const bg=page.locator('.flowing-water-background'); await expect(bg).toHaveAttribute('data-background',choice);
  await expect.poll(()=>bg.locator('img').evaluate(i=>i.complete&&i.naturalWidth>0)).toBe(true);
  if(choice==='diffuse') await expect(bg).toHaveAttribute('data-renderer','video',{timeout:30000});
  else await expect.poll(()=>bg.getAttribute('data-renderer')).toMatch(/webgl|fallback/);
  return bg;
}
const toggle=p=>p.locator('.home-display-controls').getByRole('button',{name:/^(Dark|Light) mode$/});
async function tap(p,locator,width){if(width<760)await locator.tap();else await locator.click();}
for(const [engine,kind] of [['chromium',chromium],['webkit',webkit]]){
  if(process.env.ECO_TEST_ENGINE&&process.env.ECO_TEST_ENGINE!==engine)continue;
  const executablePath=process.env[engine==='chromium'?'ECO_CHROMIUM_EXECUTABLE':'ECO_WEBKIT_EXECUTABLE'];
  const browser=await kind.launch({headless:true,...(executablePath?{executablePath}:{})});
  try{for(const width of [1440,320,390]){
    if(process.env.ECO_TEST_WIDTH&&+process.env.ECO_TEST_WIDTH!==width)continue;
    const context=await browser.newContext({viewport:{width,height:width<760?844:960},hasTouch:width<760,isMobile:width<760,colorScheme:'light',reducedMotion:'no-preference'});
    await installStagingCookies(context,base); const state=await mocks(context); const page=await context.newPage();const errors=[];
    page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
    const media=[];context.on('request',r=>{if(/flowing-water.*\.(mp4|jpg)/.test(r.url()))media.push(new URL(r.url()).pathname);});
    try{
      await page.goto(base);await expect(page.locator('.access-login')).toBeVisible();
      await expect(page.getByLabel('Background',{exact:true})).toHaveValue('diffuse');await ready(page,'diffuse');
      for(const choice of ['diffuse','watercolour']){
        await page.getByLabel('Background',{exact:true}).selectOption(choice);await ready(page,choice);
        await expect(page.locator('html')).toHaveAttribute('data-theme','light');
        const day=await pixels(page);await shot(page,`${engine}-${width}-${choice}-signed-out-light`);
        await tap(page,toggle(page),width);await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
        await page.waitForTimeout(350);const night=await pixels(page);
        assert.ok(day.count>100&&night.count>100&&night.mean<day.mean*.7&&night.spread>30,`Actual mobile compositor stays dark and retains detail: ${JSON.stringify({day,night})}`);
        await tap(page,page.getByLabel('Email',{exact:true}),width);await page.waitForTimeout(150);
        await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
        assert.ok((await pixels(page)).mean<day.mean*.7,'Touching another control does not restore light pixels');
        await shot(page,`${engine}-${width}-${choice}-signed-out-dark`);
        await page.getByLabel('Email',{exact:true}).fill(member.email);await page.getByLabel('Password',{exact:true}).fill('Synthetic Password 8');
        await tap(page,page.getByRole('button',{name:'Sign in',exact:true}),width);await expect(page.locator('.world-launcher')).toBeVisible();
        await ready(page,choice);await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
        await page.reload();await expect(page.locator('.world-launcher')).toBeVisible();await ready(page,choice);
        await expect(page.getByLabel('Background',{exact:true})).toHaveValue(choice);await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
        await shot(page,`${engine}-${width}-${choice}-signed-in-dark`);
        const mediaNode=page.locator(choice==='diffuse'?'.flowing-water-video':'.flowing-water-canvas');
        const retained=await mediaNode.elementHandle();const phase=await mediaNode.evaluate(n=>n.currentTime??Number(n.dataset.flowTimeMs));
        await tap(page,toggle(page),width);await expect(page.locator('html')).toHaveAttribute('data-theme','light');
        assert.ok(await retained.evaluate(n=>n.isConnected),'Theme preserves media element');
        assert.ok(await mediaNode.evaluate(n=>n.currentTime??Number(n.dataset.flowTimeMs))>=phase,'Theme does not reset phase');await retained.dispose();
        await shot(page,`${engine}-${width}-${choice}-signed-in-light`);
        if(choice==='diffuse'){
          const v=page.locator('video.flowing-water-video');const source=await v.getAttribute('src');
          assert.equal(source,width<760?'/flowing-water-diffuse-mobile.mp4':'/flowing-water-diffuse.mp4');
          assert.ok(await v.evaluate(n=>n.muted&&n.loop&&n.playsInline&&!n.controls));
          const t=await v.evaluate(n=>n.currentTime);await expect.poll(()=>v.evaluate(n=>n.currentTime)).toBeGreaterThan(t+.1);
          await page.getByRole('button',{name:'Trading',exact:true}).click();await page.getByRole('button',{name:'Enquiries',exact:true}).click();
          await expect(page.getByRole('dialog',{name:'Enquiries',exact:true})).toBeVisible();await expect.poll(()=>v.evaluate(n=>n.paused)).toBe(true);
          const paused=await v.evaluate(n=>n.currentTime);await page.waitForTimeout(200);assert.equal(await v.evaluate(n=>n.currentTime),paused);
          await page.getByRole('button',{name:'Close workspace',exact:true}).click();await expect.poll(()=>v.evaluate(n=>n.paused)).toBe(false);
        }
        await tap(page,page.getByRole('button',{name:'Sign out',exact:true}),width);await expect(page.locator('.access-login')).toBeVisible();
        await page.reload();await expect(page.locator('.access-login')).toBeVisible();await expect(page.getByLabel('Background',{exact:true})).toHaveValue(choice);
        results.push({engine,width,choice,passed:true,day,night,persistence:true});
      }
      await page.getByLabel('Background',{exact:true}).selectOption('diffuse');await ready(page,'diffuse');
      await page.emulateMedia({reducedMotion:'reduce'});await expect(page.locator('.flowing-water-background')).toHaveAttribute('data-renderer','fallback');await expect(page.locator('video.flowing-water-video')).toHaveCount(0);
      await expect(page.locator('.flowing-water-image')).toBeVisible();await shot(page,`${engine}-${width}-reduced-motion`);
      await page.emulateMedia({reducedMotion:'no-preference'});await ready(page,'diffuse');
      await page.locator('video.flowing-water-video').evaluate(v=>v.dispatchEvent(new Event('error')));
      await expect(page.locator('.flowing-water-background')).toHaveAttribute('data-renderer','fallback');await expect(page.locator('.flowing-water-image')).toBeVisible();
      assert.deepEqual([...new Set(media.filter(p=>p.endsWith('.mp4')))], [width<760?'/flowing-water-diffuse-mobile.mp4':'/flowing-water-diffuse.mp4'],'Only matching rendition; no night video');
      assert.deepEqual(errors,[]);assert.deepEqual(state.unexpected,[]);
      assert.deepEqual(state.writes,['/api/access/login','/api/access/logout','/api/access/login','/api/access/logout']);
      console.log(`PASS ${engine} ${width}: both backgrounds, actual night pixels, touch and saved preferences`);
    }catch(error){results.push({engine,width,passed:false,error:error.message,errors,unexpected:state.unexpected});await page.screenshot({path:`${out}/${engine}-${width}-failure.png`,fullPage:true}).catch(()=>{});throw error;}
    finally{await writeFile(`${reports}/verification.json`,JSON.stringify({base,results,limits:'Synthetic accounts and isolated Chromium/WebKit; physical phones and installed Safari untested.'},null,2));await context.close();}
  }}finally{await browser.close();}
}
