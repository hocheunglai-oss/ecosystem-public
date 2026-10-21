import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';

// Run against the isolated Vite server; importing its guard checks the same live
// module used by demo mutations, rather than inferring writability from CSS.
const base = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4261';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const realUser = { id:'11111111-1111-4111-8111-111111111111', email:'admin@example.test', displayName:'PREVIEW ADMIN',
  phone:'', officeId:'HONG KONG', officeName:'HONG KONG', isAdmin:true, isManager:false, isSpcTrader:false,
  isActive:true, activated:true, passwordChangeSuggested:true, revision:5 };
for (const [engine, browserType] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await browserType.launch({headless:true});
  try {
    for (const theme of ['light','dark']) {
      const context = await browser.newContext({viewport:{width:320,height:900},reducedMotion:'reduce'});
      try {
        let preview = null, waitForRefresh = false;
        const mutationStarted = deferred(), releaseMutation = deferred(), refreshStarted = deferred(), releaseRefresh = deferred();
        await context.addInitScript(value => localStorage.setItem('ecosystem.theme.v1',value),theme);
        await context.route('**/api/access/**',async route => {
          const path = new URL(route.request().url()).pathname;
          if(path.endsWith('/password-prompt')) {
            mutationStarted.resolve(); await releaseMutation.promise;
            return route.fulfill({json:{user:{...realUser,passwordChangeSuggested:false}}});
          }
          if(path.endsWith('/session')) {
            if(waitForRefresh) { refreshStarted.resolve(); await releaseRefresh.promise; }
            return route.fulfill({json:{user:realUser,preview}});
          }
          return route.fulfill({status:404,json:{message:'Unexpected request'}});
        });
        const page = await context.newPage();
        await page.goto(base);
        await page.getByRole('button',{name:'Skip',exact:true}).click();
        await mutationStarted.promise;
        preview = {role:'trader',officeId:'SINGAPORE',officeName:'SINGAPORE',readOnly:true};
        waitForRefresh = true;
        const sender = await context.newPage();
        const senderUrl = new URL('/preview-invalidation-test',base).href;
        await sender.route(senderUrl,route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Isolated invalidation sender</title>'}));
        await sender.goto(senderUrl);
        await sender.evaluate(() => {
          const channel = new BroadcastChannel('eco-access-invalidation');
          channel.postMessage({untrusted:'refresh only',isAdmin:true});
          channel.close();
        });
        const guarded = () => page.evaluate(async () => (await import('/src/lib/previewGuard.ts')).isPreviewReadOnly());
        await expect.poll(guarded).toBe(true);
        releaseMutation.resolve();
        await Promise.race([refreshStarted.promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Queued refresh did not run after account response')),3000))]);
        assert.equal(await guarded(),true,'Delayed account response must not release the read-only guard');
        releaseRefresh.resolve();
        await expect(page.getByRole('status',{name:'Role preview'})).toContainText('Read only');
        assert.equal(await guarded(),true,'Authoritative preview remains read only');
        await expect(page.locator('.hud-identity')).toContainText('Trader');
        await expect(page.locator('.hud-identity')).toContainText(realUser.displayName);
        console.log(`PASS ${engine} ${theme}: in-flight account response cannot override cross-tab preview`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
}
