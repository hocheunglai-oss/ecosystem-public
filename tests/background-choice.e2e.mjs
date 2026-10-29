import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { chromium, webkit, expect } from '@playwright/test';
import { installSharedLocations } from './fixtures/shared-locations.mjs';
import { installStagingCookies } from './fixtures/protection-cookies.mjs';
const base=process.env.ECO_BACKGROUND_UI_ORIGIN || 'http://127.0.0.1:4286';
const out=resolve(process.env.ECO_BACKGROUND_UI_OUTPUT || tmpdir()+'/eco-background-choice');
const reports=resolve(process.env.ECO_BACKGROUND_REPORT_OUTPUT || out);
await mkdir(out,{recursive:true}); await mkdir(reports,{recursive:true});
const results=[];
const testRequire=createRequire(createRequire(import.meta.url).resolve('@playwright/test'));
const { PNG }=createRequire(testRequire.resolve('playwright'))('playwright-core/lib/utilsBundle');
let pixelCapture;
let phaseDiagnostics=[];
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
  const start=Date.now();pixelCapture={stage:'layout',startedAt:start};
  const view=await page.evaluate(()=>({width:innerWidth,height:innerHeight,
    excluded:[...document.querySelectorAll('.world-identity,.main-search,.world-launcher,.home-hud-stack,.flowing-footer,.entry-brand,.access-login')].map(n=>{
      const b=n.getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom};
    }),
  }));
  pixelCapture={...pixelCapture,stage:'screenshot',layoutMs:Date.now()-start};
  const bytes=await page.screenshot({animations:'allow'});
  pixelCapture={...pixelCapture,stage:'decode',captureMs:Date.now()-start};
  // Decode the actual screenshot in Node using Playwright's pinned PNG utility.
  // Re-decoding it as another page image adds an unrelated browser loading wait.
  const image=PNG.sync.read(bytes),colours=[];
  for(let y=8;y<view.height-8;y+=12)for(let x=8;x<view.width-8;x+=12){
    if(view.excluded.some(b=>x>=b.left-4&&x<=b.right+4&&y>=b.top-4&&y<=b.bottom+4))continue;
    const i=(Math.floor(y*image.height/view.height)*image.width+Math.floor(x*image.width/view.width))*4;
    colours.push([image.data[i],image.data[i+1],image.data[i+2]]);
  }
  const result={count:colours.length, mean:colours.flat().reduce((a,b)=>a+b,0)/(colours.length*3), spread:Math.max(...colours.flat())-Math.min(...colours.flat())};
  pixelCapture={...pixelCapture,stage:'complete',totalMs:Date.now()-start,result};
  return result;
}
async function renderedPixels(page, accepts, message) {
  let current;
  // A loaded image or submitted WebGL draw does not establish painted pixels.
  // Require an actual capture with the expected artwork before comparing modes.
  try {
    await expect.poll(async () => {
      current = await pixels(page);
      return accepts(current);
    }, { timeout: 15000, message }).toBe(true);
  } catch (error) {
    throw new Error(`${error.message}\nLast rendered pixels: ${JSON.stringify(current)}`, { cause: error });
  }
  return current;
}
async function shot(page,name){
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No horizontal overflow');
  await expect(toggle(page)).toHaveAttribute('aria-checked',String(await page.locator('html').getAttribute('data-theme')==='dark'));
  const choice=page.getByLabel('Background',{exact:true});
  await expect(choice).toBeVisible();
  const box=await choice.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=await page.evaluate(()=>innerWidth)+1&&box.height>=44,'Readable selector fits phone');
  const theme=await page.locator('html').getAttribute('data-theme');
  const filters=await page.locator('.flowing-water-background img,.flowing-water-background video,.flowing-water-background canvas').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).filter));
  assert.ok(filters.length>=2&&filters.every(filter=>filter==='none'),'Artwork never depends on unsupported accelerated SVG fragment filters');
  if(theme==='dark'){
    const bg=page.locator('.flowing-water-background');
    if(await bg.getAttribute('data-renderer')==='fallback') await expect(bg.locator('.flowing-water-night-still')).toHaveCSS('opacity','1');
    else if(await bg.getAttribute('data-renderer')==='video'){
      await expect(bg).toHaveAttribute('data-night-ready','true');
      await expect(bg.locator('.flowing-water-video-palette')).toHaveCSS('opacity','1');
    }
  }
  await renderedPixels(page,p=>p.count>100&&p.spread>30&&(theme==='light'?p.mean>80:p.mean<100),'Screenshot artwork reached the compositor');
  await page.screenshot({path:`${out}/${name}.png`,fullPage:true});
}
const graphicsCapabilities=new WeakMap();
async function graphicsAvailable(page){
  if(!graphicsCapabilities.has(page))graphicsCapabilities.set(page,await page.evaluate(()=>{
    const canvas=document.createElement('canvas'),gl=canvas.getContext('webgl',{alpha:false,antialias:false,powerPreference:'low-power'});
    const supported=Boolean(gl&&!gl.isContextLost());gl?.getExtension('WEBGL_lose_context')?.loseContext();return supported;
  }));
  return graphicsCapabilities.get(page);
}
async function ready(page,choice,forceFallback=false){
  const bg=page.locator('.flowing-water-background'); await expect(bg).toHaveAttribute('data-background',choice);
  await bg.locator('img').evaluate(image => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Background image did not decode and paint within 15 seconds')), 15000);
    image.decode().then(() => requestAnimationFrame(() => requestAnimationFrame(() => {
      clearTimeout(timeout); resolve();
    })), error => { clearTimeout(timeout); reject(error); });
  }));
  const reduced=await page.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches);
  const supported=await graphicsAvailable(page),night=await page.locator('html').getAttribute('data-theme')==='dark';
  if(reduced||forceFallback||(!supported&&night)) await expect(bg).toHaveAttribute('data-renderer','fallback',{timeout:15000});
  else await expect(bg).toHaveAttribute('data-renderer','video',{timeout:30000});
  await expect(bg.locator('img')).toHaveAttribute('src',`/flowing-water-${choice}-poster.jpg`);
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
    mediaEvents: window.__mediaPhaseEvents,
    background: { ...document.querySelector('.flowing-water-background')?.dataset },
    videos: [...document.querySelectorAll('.flowing-water-background video')].map(video => ({
      readyState: video.readyState, networkState: video.networkState, paused: video.paused, time: video.currentTime,
    })),
  })).catch(() => null);
}
const mediaPhase = node => node.evaluate(n => ({
  time:n.currentTime,duration:n.duration,at:performance.now(),
  src:n.getAttribute('src'),currentSrc:n.currentSrc,paused:n.paused,seeking:n.seeking,
  readyState:n.readyState,networkState:n.networkState,events:window.__mediaPhaseEvents,
}));
async function verifyPausedThemePhase(page,video,workspace,width){
  // Use the original decoded frame, naturally advanced beyond startup before
  // opening this workspace. Near zero, a restart is otherwise ambiguous.
  const retained=await video.elementHandle(),before=await mediaPhase(video),changes=[];
  assert.ok(before.paused&&!before.seeking&&before.time>1&&before.time<before.duration-1,'Paused theme check starts at a decoded nonzero phase');
  const control=workspace.locator('.window-foot').getByRole('switch',{name:'Dark mode',exact:true});
  try{
    for(const theme of ['dark','light']){
      await tap(page,control,width);await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
      await expect(control).toHaveAttribute('aria-checked',String(theme==='dark'));
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const after=await mediaPhase(video);const evidence={kind:'paused',theme,before,after};phaseDiagnostics.push(evidence);
      assert.ok(await retained.evaluate(n=>n===document.querySelector('video.flowing-water-video')),'Paused theme change retains the exact video node');
      assert.equal(after.src,before.src,'Paused theme change retains source attribute');
      assert.equal(after.currentSrc,before.currentSrc,'Paused theme change retains decoded source');
      assert.equal(after.paused,true,`Theme cannot resume the paused video: ${JSON.stringify(evidence)}`);
      assert.equal(after.seeking,false,`Theme cannot seek the paused video: ${JSON.stringify(evidence)}`);
      assert.equal(after.time,before.time,`Theme must preserve the exact nonzero paused phase: ${JSON.stringify(evidence)}`);
      if(theme==='dark'&&await graphicsAvailable(page)){
        await expect(page.locator('.flowing-water-background')).toHaveAttribute('data-night-ready','true');
        await expect.poll(async()=>Number(await page.locator('.flowing-water-video-palette').getAttribute('data-source-time'))).toBe(before.time);
      }
      changes.push({theme,time:after.time,sourceRetained:true,nodeRetained:true,paused:true});
    }
    return {time:before.time,changes};
  }finally{await retained.dispose();}
}
const toggle=p=>p.locator('.home-display-controls').getByRole('switch',{name:'Dark mode',exact:true,includeHidden:true});
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
    phaseDiagnostics=[];
    await installStagingCookies(context,base); const state=await mocks(context); const page=await context.newPage();const errors=[];
    await page.addInitScript(() => {
      window.__motionEvents = [];
      window.__mediaPhaseEvents=[];
      for(const type of ['loadstart','loadedmetadata','loadeddata','seeking','seeked','playing','pause','emptied','ended'])document.addEventListener(type,event=>{
        const video=event.target;if(!(video instanceof HTMLVideoElement))return;
        window.__mediaPhaseEvents.push({type,at:performance.now(),time:video.currentTime,paused:video.paused,seeking:video.seeking,readyState:video.readyState,src:video.getAttribute('src')});
        if(window.__mediaPhaseEvents.length>80)window.__mediaPhaseEvents.shift();
      },true);
      const motion = matchMedia('(prefers-reduced-motion: reduce)');
      motion.addEventListener('change', event => window.__motionEvents.push({
        matches: event.matches, at: performance.now(), hidden: document.hidden,
      }));
    });
    page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
    const media=[];context.on('request',r=>{if(/flowing-water.*\.(mp4|jpg)/.test(r.url()))media.push(new URL(r.url()).pathname);});
    try{
      await page.goto(base,{waitUntil:'domcontentloaded'});await expect(page.locator('.access-login')).toBeVisible();
      await expect(page.getByLabel('Background',{exact:true})).toHaveValue('diffuse');await ready(page,'diffuse');
      for(const choice of ['diffuse','watercolour']){
        let pausedThemePhase;
        await page.getByLabel('Background',{exact:true}).selectOption(choice);await ready(page,choice);
        await expect(page.locator('html')).toHaveAttribute('data-theme','light');
        await expect(toggle(page)).toHaveAttribute('aria-checked','false');
        const day=await renderedPixels(page,p=>p.count>100&&p.mean>80&&p.spread>30,'Day artwork reached the compositor');await shot(page,`${engine}-${width}-${choice}-signed-out-light`);
        await tap(page,toggle(page),width);await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
        await expect(toggle(page)).toHaveAttribute('aria-checked','true');await ready(page,choice);
        if(await graphicsAvailable(page)){
          const palette=page.locator('.flowing-water-video-palette'),start=Number(await palette.getAttribute('data-source-time'));
          assert.ok(Number.isFinite(start),'Night colour pass has drawn a real source frame');
          const duration=await page.locator('video.flowing-water-video').evaluate(video=>video.duration);
          await expect.poll(async()=>{const next=Number(await palette.getAttribute('data-source-time'));return (next-start+duration)%duration;},{timeout:15000}).toBeGreaterThan(.1);
        }
        const night=await renderedPixels(page,p=>p.count>100&&p.mean<day.mean*.7&&p.spread>30,'Night artwork reached the compositor');
        assert.ok(day.count>100&&night.count>100&&night.mean<day.mean*.7&&night.spread>30,`Actual mobile compositor stays dark and retains detail: ${JSON.stringify({day,night})}`);
        await tap(page,page.getByLabel('Email',{exact:true}),width);await page.waitForTimeout(150);
        await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
        assert.ok((await pixels(page)).mean<day.mean*.7,'Touching another control does not restore light pixels');
        await shot(page,`${engine}-${width}-${choice}-signed-out-dark`);
        await page.getByLabel('Email',{exact:true}).fill(member.email);await page.getByLabel('Password',{exact:true}).fill('Synthetic Password 8');
        await authenticationNavigation(page,'login',()=>tap(page,page.getByRole('button',{name:'Sign in',exact:true}),width));
        await ready(page,choice);await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
        await authenticationNavigation(page,'session',()=>page.reload({waitUntil:'domcontentloaded'}));await ready(page,choice);
        await expect(page.getByLabel('Background',{exact:true})).toHaveValue(choice);await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
        await shot(page,`${engine}-${width}-${choice}-signed-in-dark`);
        const mediaNode=page.locator('.flowing-water-video');
        await expect.poll(()=>mediaNode.evaluate(video=>
          !video.seeking&&video.currentTime>.5&&video.currentTime<video.duration-.5),
        {timeout:15000,message:'Post-reload decoder clock progressed beyond startup before theme comparison'}).toBe(true);
        const retained=await mediaNode.elementHandle();
        const phase=await mediaPhase(mediaNode);
        await tap(page,toggle(page),width);await expect(page.locator('html')).toHaveAttribute('data-theme','light');
        await expect(toggle(page)).toHaveAttribute('aria-checked','false');
        assert.ok(await retained.evaluate(n=>n===document.querySelector('.flowing-water-video')),'Theme preserves the exact media element');
        assert.ok(Number.isFinite(phase.time)&&Number.isFinite(phase.duration)&&phase.duration>0,'Playing video has a known loop duration');
        const next=await mediaPhase(mediaNode);
        const delta=next.time-phase.time,elapsed=(next.at-phase.at)/1000;
        // Both supplied clips are 30fps. One decoder sample may be reported one
        // frame behind; do not modulo that correction into a whole loop.
        const clockCorrection=delta<0&&delta>=-1/30-1e-6;
        const forward=clockCorrection?0:(delta+phase.duration)%phase.duration;
        const evidence={kind:'playing',choice,before:phase,after:next,delta,elapsed,clockCorrection,forward};phaseDiagnostics.push(evidence);
        assert.equal(next.src,phase.src,'Theme retains video source attribute');
        assert.equal(next.currentSrc,phase.currentSrc,'Theme retains decoded video source');
        // Genuine loops retain the wall-time bound; the separate nonzero paused
        // check below rejects actual theme-triggered resets in either direction.
        assert.ok(forward<=elapsed+.25,`Theme preserves forward video phase across a natural loop: ${JSON.stringify(evidence)}`);
        await retained.dispose();
        await shot(page,`${engine}-${width}-${choice}-signed-in-light`);
        {
          const v=page.locator('video.flowing-water-video');const source=await v.getAttribute('src');
          assert.equal(source,`/flowing-water-${choice}${width<760?'-mobile':''}.mp4`);
          assert.equal(await v.getAttribute('data-flow-period-ms'),choice==='diffuse'?'24000':'6000');
          assert.ok(Math.abs(await v.evaluate(n=>n.duration)-(choice==='diffuse'?24:6))<1/30,'The selected supplied clip retains its native duration');
          assert.ok(await v.evaluate(n=>n.muted&&n.loop&&n.playsInline&&!n.controls));
          const t=await v.evaluate(n=>n.currentTime);await expect.poll(()=>v.evaluate((n,t)=>(n.currentTime-t+n.duration)%n.duration,t)).toBeGreaterThan(.1);
          await expect.poll(()=>v.evaluate(n=>!n.seeking&&n.currentTime>1.25&&n.currentTime<Math.min(2.5,n.duration-2)),
            {timeout:15000,message:'A decoded nonzero phase is available for the paused theme check'}).toBe(true);
          await page.getByRole('button',{name:'Trading',exact:true}).click();await page.getByRole('button',{name:'Enquiries',exact:true}).click();
          await expect(page.getByRole('dialog',{name:'Enquiries',exact:true})).toBeVisible();await expect.poll(()=>v.evaluate(n=>n.paused)).toBe(true);
          const paused=await v.evaluate(n=>n.currentTime);await page.waitForTimeout(200);assert.equal(await v.evaluate(n=>n.currentTime),paused);
          pausedThemePhase=await verifyPausedThemePhase(page,v,page.getByRole('dialog',{name:'Enquiries',exact:true}),width);
          await page.getByRole('button',{name:'Close workspace',exact:true}).click();await expect.poll(()=>v.evaluate(n=>n.paused)).toBe(false);
        }
        await authenticationNavigation(page,'logout',()=>tap(page,page.getByRole('button',{name:'Sign out',exact:true}),width),false);
        await authenticationNavigation(page,'session',()=>page.reload({waitUntil:'domcontentloaded'}),false);await expect(page.getByLabel('Background',{exact:true})).toHaveValue(choice);
        results.push({engine,width,choice,passed:true,day,night,persistence:true,...(pausedThemePhase?{pausedThemePhase}:{})});
      }
      for(const choice of ['watercolour','diffuse']){
        await page.getByLabel('Background',{exact:true}).selectOption(choice);await ready(page,choice);
        await motionPreference(page,'reduce');await ready(page,choice);
        await expect(page.locator('video.flowing-water-video')).toHaveCount(0);
        const image=page.locator('.flowing-water-image'),source=await image.getAttribute('src');
        await expect(image).toBeVisible();await expect(image).toHaveCSS('opacity','1');
        const day=await renderedPixels(page,p=>p.count>100&&p.mean>80&&p.spread>30,'Reduced-motion day artwork is painted');
        await shot(page,`${engine}-${width}-${choice}-reduced-motion-light`);
        await tap(page,toggle(page),width);await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
        await expect(page.locator('.flowing-water-night-still')).toHaveAttribute('data-ready','true');
        const night=await renderedPixels(page,p=>p.count>100&&p.mean<day.mean*.7&&p.spread>30,'Reduced-motion night artwork is painted');
        await expect(image).toHaveAttribute('src',source);
        await shot(page,`${engine}-${width}-${choice}-reduced-motion-dark`);
        results.push({engine,width,choice,reducedMotion:true,passed:true,day,night,originalSourceRetained:true});
        await tap(page,toggle(page),width);await expect(page.locator('html')).toHaveAttribute('data-theme','light');
        await motionPreference(page,'no-preference');await ready(page,choice);
      }
      for(const choice of ['watercolour','diffuse']){
        await page.getByLabel('Background',{exact:true}).selectOption(choice);await ready(page,choice);
        await page.locator('video.flowing-water-video').evaluate(v=>v.dispatchEvent(new Event('error')));
        await expect(page.locator('.flowing-water-background')).toHaveAttribute('data-renderer','fallback');
        await expect(page.locator('.flowing-water-image')).toBeVisible();
        await expect(page.locator('.flowing-water-image')).toHaveAttribute('src',`/flowing-water-${choice}-poster.jpg`);
        await tap(page,toggle(page),width);await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
        await shot(page,`${engine}-${width}-${choice}-video-error-dark`);
        await tap(page,toggle(page),width);await expect(page.locator('html')).toHaveAttribute('data-theme','light');
      }
      assert.deepEqual([...new Set(media.filter(p=>p.endsWith('.mp4')))].sort(),
        ['diffuse','watercolour'].map(choice=>`/flowing-water-${choice}${width<760?'-mobile':''}.mp4`).sort(),
        'Only matching renditions of the two selected clips load; no alternate night movie');
      assert.deepEqual(errors,[]);assert.deepEqual(state.unexpected,[]);
      assert.deepEqual(state.writes,['/api/access/login','/api/access/logout','/api/access/login','/api/access/logout']);
      console.log(`PASS ${engine} ${width}: both backgrounds, actual night pixels, touch and saved preferences`);
    }catch(error){results.push({engine,width,passed:false,error:error.message,errors,unexpected:state.unexpected,pixelCapture,phaseDiagnostics,motion:await motionDiagnostics(page)});await page.screenshot({path:`${out}/${engine}-${width}-failure.png`,fullPage:true}).catch(()=>{});throw error;}
    finally{await writeFile(`${reports}/verification.json`,JSON.stringify({base,results,limits:'Synthetic accounts and isolated Chromium/WebKit; physical phones and installed Safari untested.'},null,2));await context.close();}
    if(width<760){
      const unsupported=await browser.newContext({viewport:{width,height:844},hasTouch:true,isMobile:true,colorScheme:'light',reducedMotion:'no-preference'});
      await installStagingCookies(unsupported,base);const fixture=await mocks(unsupported);
      await unsupported.addInitScript(()=>{
        const original=HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext=function(type,...args){
          if(['webgl','webgl2','experimental-webgl'].includes(type))return null;
          return Reflect.apply(original,this,[type,...args]);
        };
      });
      const fallbackPage=await unsupported.newPage();fallbackPage.setDefaultTimeout(15000);const fallbackErrors=[];
      fallbackPage.on('pageerror',error=>fallbackErrors.push(error.message));
      try{
        await fallbackPage.goto(base,{waitUntil:'domcontentloaded'});await expect(fallbackPage.locator('.access-login')).toBeVisible();
        for(const choice of ['diffuse','watercolour']){
          await fallbackPage.getByLabel('Background',{exact:true}).selectOption(choice);await ready(fallbackPage,choice);
          const source=await fallbackPage.locator('.flowing-water-image').getAttribute('src');
          const day=await renderedPixels(fallbackPage,p=>p.count>100&&p.mean>80&&p.spread>30,'Unsupported-WebGL day artwork is painted');
          await shot(fallbackPage,`${engine}-${width}-${choice}-no-webgl-light`);
          await tap(fallbackPage,toggle(fallbackPage),width);await expect(fallbackPage.locator('html')).toHaveAttribute('data-theme','dark');
          await ready(fallbackPage,choice,true);
          await expect(fallbackPage.locator('.flowing-water-night-still')).toHaveAttribute('data-ready','true');
          const night=await renderedPixels(fallbackPage,p=>p.count>100&&p.mean<day.mean*.7&&p.spread>30,'Unsupported-WebGL night artwork is painted');
          await expect(fallbackPage.locator('.flowing-water-image')).toHaveAttribute('src',source);
          await shot(fallbackPage,`${engine}-${width}-${choice}-no-webgl-dark`);
          results.push({engine,width,choice,unsupportedWebGL:true,passed:true,day,night,originalSourceRetained:true});
          await tap(fallbackPage,toggle(fallbackPage),width);await expect(fallbackPage.locator('html')).toHaveAttribute('data-theme','light');
        }
        assert.deepEqual(fixture.writes,[]);assert.deepEqual(fixture.unexpected,[]);assert.deepEqual(fallbackErrors,[]);
      }catch(error){results.push({engine,width,unsupportedWebGL:true,passed:false,error:error.message,errors:fallbackErrors,pixelCapture});await fallbackPage.screenshot({path:`${out}/${engine}-${width}-no-webgl-failure.png`,fullPage:true}).catch(()=>{});throw error;}
      finally{await writeFile(`${reports}/verification.json`,JSON.stringify({base,results,limits:'Synthetic accounts and isolated Chromium/WebKit; physical phones and installed Safari untested.'},null,2));await unsupported.close();}
    }
  }}finally{await browser.close();}
}
