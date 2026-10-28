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
async function renderedPixels(page, accepts, message) {
  let current, previous;
  // A loaded image or submitted WebGL draw does not establish painted pixels.
  // Require two actual captures with the expected artwork before comparing modes.
  try {
    await expect.poll(async () => {
      current = await pixels(page);
      const ready = accepts(current) && previous !== undefined && accepts(previous);
      previous = current;
      return ready;
    }, { timeout: 15000, message }).toBe(true);
  } catch (error) {
    throw new Error(`${error.message}\nLast rendered pixels: ${JSON.stringify(current)}`, { cause: error });
  }
  return current;
}
async function shot(page,name){
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No horizontal overflow');
  const choice=page.getByLabel('Background',{exact:true});
  await expect(choice).toBeVisible();
  const box=await choice.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=await page.evaluate(()=>innerWidth)+1&&box.height>=44,'Readable selector fits phone');
  const theme=await page.locator('html').getAttribute('data-theme');
  await renderedPixels(page,p=>p.count>100&&p.spread>30&&(theme==='light'?p.mean>80:p.mean<100),'Screenshot artwork reached the compositor');
  await page.screenshot({path:`${out}/${name}.png`,fullPage:true});
}
async function ready(page,choice){
  const bg=page.locator('.flowing-water-background'); await expect(bg).toHaveAttribute('data-background',choice);
  await bg.locator('img').evaluate(image => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Background image did not decode and paint within 15 seconds')), 15000);
    image.decode().then(() => requestAnimationFrame(() => requestAnimationFrame(() => {
      clearTimeout(timeout); resolve();
    })), error => { clearTimeout(timeout); reject(error); });
  }));
  if(choice==='diffuse') await expect(bg).toHaveAttribute('data-renderer','video',{timeout:30000});
  else await expect.poll(()=>bg.getAttribute('data-renderer')).toMatch(/webgl|fallback/);
  return bg;
}
async function motionPreference(page, reducedMotion) {
  await page.emulateMedia({ reducedMotion });
  await expect.poll(() => page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
    { timeout: 15000, message: 'Browser applied the requested motion preference' }).toBe(reducedMotion === 'reduce');
  if (reducedMotion === 'reduce') {
    // CI recorded the correct fallback just after the default assertion deadline.
    // Bound this asynchronous transition separately, then keep the strict checks.
    await expect.poll(() => page.locator('.flowing-water-background').evaluate(background => ({
      paused: background.dataset.paused, renderer: background.dataset.renderer,
      videos: background.querySelectorAll('video').length,
    })), { timeout: 15000, message: 'Background completed the reduced-motion transition' })
      .toEqual({ paused: 'true', renderer: 'fallback', videos: 0 });
  }
}
async function motionDiagnostics(page) {
  return page.evaluate(() => ({
    reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
    hidden: document.hidden, visibility: document.visibilityState,
    events: window.__motionEvents,
    background: { ...document.querySelector('.flowing-water-background')?.dataset },
    videos: [...document.querySelectorAll('.flowing-water-background video')].map(video => ({
      readyState: video.readyState, networkState: video.networkState, paused: video.paused, time: video.currentTime,
    })),
  })).catch(() => null);
}
const toggle=p=>p.locator('.home-display-controls').getByRole('button',{name:/^(Dark|Light) mode$/});
async function tap(p,locator,width){if(width<760)await locator.tap();else await locator.click();}
async function authenticationNavigation(page, path, action, signedIn = true) {
  // Authentication is asynchronous. Wait for its actual response before checking
  // the resulting workspace, including on slower mobile WebKit CI workers.
  const [response] = await Promise.all([
    page.waitForResponse(response => response.url() === `${base}/api/access/${path}`
      && response.request().method() === (path === 'session' ? 'GET' : 'POST'), { timeout: 15000 }),
    action(),
  ]);
  assert.equal(response.status(), path === 'session' && !signedIn ? 401 : 200, 'Synthetic authentication response matches the expected session');
  await expect(page.locator(signedIn ? '.world-launcher' : '.access-login')).toBeVisible({ timeout: 15000 });
}
for(const [engine,kind] of [['chromium',chromium],['webkit',webkit]]){
  if(process.env.ECO_TEST_ENGINE&&process.env.ECO_TEST_ENGINE!==engine)continue;
  const executablePath=process.env[engine==='chromium'?'ECO_CHROMIUM_EXECUTABLE':'ECO_WEBKIT_EXECUTABLE'];
  const browser=await kind.launch({headless:true,...(executablePath?{executablePath}:{})});
  try{for(const width of [1440,320,390]){
    if(process.env.ECO_TEST_WIDTH&&+process.env.ECO_TEST_WIDTH!==width)continue;
    const context=await browser.newContext({viewport:{width,height:width<760?844:960},hasTouch:width<760,isMobile:width<760,colorScheme:'light',reducedMotion:'no-preference'});
    await installStagingCookies(context,base); const state=await mocks(context); const page=await context.newPage();const errors=[];
    await page.addInitScript(() => {
      window.__motionEvents = [];
      const motion = matchMedia('(prefers-reduced-motion: reduce)');
      motion.addEventListener('change', event => window.__motionEvents.push({
        matches: event.matches, at: performance.now(), hidden: document.hidden,
      }));
    });
    page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
    const media=[];context.on('request',r=>{if(/flowing-water.*\.(mp4|jpg)/.test(r.url()))media.push(new URL(r.url()).pathname);});
    try{
      await page.goto(base);await expect(page.locator('.access-login')).toBeVisible();
      await expect(page.getByLabel('Background',{exact:true})).toHaveValue('diffuse');await ready(page,'diffuse');
      for(const choice of ['diffuse','watercolour']){
        await page.getByLabel('Background',{exact:true}).selectOption(choice);await ready(page,choice);
        await expect(page.locator('html')).toHaveAttribute('data-theme','light');
        const day=await renderedPixels(page,p=>p.count>100&&p.mean>80&&p.spread>30,'Day artwork reached the compositor');await shot(page,`${engine}-${width}-${choice}-signed-out-light`);
        await tap(page,toggle(page),width);await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
        const night=await renderedPixels(page,p=>p.count>100&&p.mean<day.mean*.7&&p.spread>30,'Night artwork reached the compositor');
        assert.ok(day.count>100&&night.count>100&&night.mean<day.mean*.7&&night.spread>30,`Actual mobile compositor stays dark and retains detail: ${JSON.stringify({day,night})}`);
        await tap(page,page.getByLabel('Email',{exact:true}),width);await page.waitForTimeout(150);
        await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
        assert.ok((await pixels(page)).mean<day.mean*.7,'Touching another control does not restore light pixels');
        await shot(page,`${engine}-${width}-${choice}-signed-out-dark`);
        await page.getByLabel('Email',{exact:true}).fill(member.email);await page.getByLabel('Password',{exact:true}).fill('Synthetic Password 8');
        await authenticationNavigation(page,'login',()=>tap(page,page.getByRole('button',{name:'Sign in',exact:true}),width));
        await ready(page,choice);await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
        await authenticationNavigation(page,'session',()=>page.reload());await ready(page,choice);
        await expect(page.getByLabel('Background',{exact:true})).toHaveValue(choice);await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
        await shot(page,`${engine}-${width}-${choice}-signed-in-dark`);
        const mediaNode=page.locator(choice==='diffuse'?'.flowing-water-video':'.flowing-water-canvas');
        const retained=await mediaNode.elementHandle();
        const phase=await mediaNode.evaluate(n=>({time:n.currentTime??Number(n.dataset.flowTimeMs),duration:n.duration,at:performance.now()}));
        await tap(page,toggle(page),width);await expect(page.locator('html')).toHaveAttribute('data-theme','light');
        assert.ok(await retained.evaluate(n=>n.isConnected),'Theme preserves media element');
        if(Number.isFinite(phase.time)) {
          const next=await mediaNode.evaluate(n=>({time:n.currentTime??Number(n.dataset.flowTimeMs),at:performance.now()}));
          if(choice==='diffuse') {
            assert.ok(Number.isFinite(phase.duration)&&phase.duration>0,'Playing video has a known loop duration');
            const forward=(next.time-phase.time+phase.duration)%phase.duration;
            // A real loop can wrap to zero; allow 250ms for media-clock sampling.
            assert.ok(forward<=(next.at-phase.at)/1000+.25,'Theme preserves forward video phase across a natural loop');
          } else assert.ok(next.time>=phase.time,'Theme does not reset cumulative canvas phase');
        }
        else {
          await expect(page.locator('.flowing-water-background')).toHaveAttribute('data-renderer','fallback');
          await expect(page.locator('.flowing-water-image')).toBeVisible();
        }
        await retained.dispose();
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
        await authenticationNavigation(page,'logout',()=>tap(page,page.getByRole('button',{name:'Sign out',exact:true}),width),false);
        await authenticationNavigation(page,'session',()=>page.reload(),false);await expect(page.getByLabel('Background',{exact:true})).toHaveValue(choice);
        results.push({engine,width,choice,passed:true,day,night,persistence:true});
      }
      await page.getByLabel('Background',{exact:true}).selectOption('diffuse');await ready(page,'diffuse');
      await motionPreference(page,'reduce');await expect(page.locator('.flowing-water-background')).toHaveAttribute('data-renderer','fallback');await expect(page.locator('video.flowing-water-video')).toHaveCount(0);
      await expect(page.locator('.flowing-water-image')).toBeVisible();await shot(page,`${engine}-${width}-reduced-motion`);
      await motionPreference(page,'no-preference');await ready(page,'diffuse');
      await page.locator('video.flowing-water-video').evaluate(v=>v.dispatchEvent(new Event('error')));
      await expect(page.locator('.flowing-water-background')).toHaveAttribute('data-renderer','fallback');await expect(page.locator('.flowing-water-image')).toBeVisible();
      assert.deepEqual([...new Set(media.filter(p=>p.endsWith('.mp4')))], [width<760?'/flowing-water-diffuse-mobile.mp4':'/flowing-water-diffuse.mp4'],'Only matching rendition; no night video');
      assert.deepEqual(errors,[]);assert.deepEqual(state.unexpected,[]);
      assert.deepEqual(state.writes,['/api/access/login','/api/access/logout','/api/access/login','/api/access/logout']);
      console.log(`PASS ${engine} ${width}: both backgrounds, actual night pixels, touch and saved preferences`);
    }catch(error){results.push({engine,width,passed:false,error:error.message,errors,unexpected:state.unexpected,motion:await motionDiagnostics(page)});await page.screenshot({path:`${out}/${engine}-${width}-failure.png`,fullPage:true}).catch(()=>{});throw error;}
    finally{await writeFile(`${reports}/verification.json`,JSON.stringify({base,results,limits:'Synthetic accounts and isolated Chromium/WebKit; physical phones and installed Safari untested.'},null,2));await context.close();}
  }}finally{await browser.close();}
}
