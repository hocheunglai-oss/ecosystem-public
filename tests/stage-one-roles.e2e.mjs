import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { invalidateFixtureAuthority } from './fixtures/authority-transition.mjs';
import { installStagingCookies } from './fixtures/protection-cookies.mjs';

const base = process.env.ECO_STAGE_ONE_UI_ORIGIN || 'http://127.0.0.1:4286';
const out = resolve(process.env.ECO_STAGE_ONE_UI_OUTPUT || 'output/stage-one-roles');
const owner = {
  id: '10000000-0000-4000-8000-000000000001', displayName: 'SYNTHETIC OWNER', email: 'owner@example.test',
  officeId: 'hk', officeName: 'HONG KONG', isAdmin: true, isActive: true, activated: true,
  isSpcTrader: false, isManager: false, passwordChangeSuggested: false, revision: 1,
};
const offices = [{id:'hk',name:'HONG KONG'}, {id:'sg',name:'SINGAPORE'}, {id:'CREDIT',name:'CREDIT'}];
const roles = [['trader','Normal trader'],['spc-trader','SPC Trader'],['manager','Manager'],['credit','Credit']];
const group = 'Synthetic Route – Mixed Case And A Long Group Name For Mobile';
const cases = [];
const queueRow = { id:'10000000-0000-4000-8000-000000000099', ownerId:owner.id, ownerName:owner.displayName,
  reference:'ECO-00001234', revision:1, status:'confirmed', vessel:'SHARED SYNTHETIC QUEUE', imo:'', eta:'3 DEC',
  createdAt:'2026-11-26T00:00:00Z', updatedAt:'2026-11-26T00:00:00Z', confirmedAt:'2026-11-26T00:00:00Z',
  products:[{grade:'VLSFO',quantityText:'300'}], port:null, queue:{status:'awaiting_connection',queuedAt:'2026-11-26T00:00:00Z'} };
await mkdir(out,{recursive:true});

for (const [engine, browserType] of [['chromium',chromium],['webkit',webkit]]) {
  if (process.env.ECO_TEST_ENGINE && process.env.ECO_TEST_ENGINE !== engine) continue;
  const browser = await browserType.launch({ headless: true });
  try {
    for (const width of [1440,320,390]) for (const theme of ['light','dark']) {
      if (process.env.ECO_TEST_WIDTH && Number(process.env.ECO_TEST_WIDTH) !== width || process.env.ECO_TEST_THEME && process.env.ECO_TEST_THEME !== theme) continue;
      const context = await browser.newContext({ viewport:{ width,height:920 }, isMobile:width<760, hasTouch:width<760, reducedMotion:'reduce' });
      const page = await context.newPage();
      const problems = [];
      page.on('pageerror', error => problems.push(error.message));
      let actor = null, preview = null, privateReads = 0, queueReads = 0;
      await installStagingCookies(context,base);
      await context.addInitScript(value=>localStorage.setItem('ecosystem.theme.v1',value),theme);
      await context.route('**/api/**', route => {
        const req = route.request(), url = new URL(req.url()), path = url.pathname;
        const respond = json => route.fulfill({json});
        if (path === '/api/access/session') return actor ? respond({user:actor,preview}) : route.fulfill({status:401,json:{message:'Sign in required.'}});
        if (path === '/api/access/preview/options') return respond({offices});
        if (path === '/api/access/preview') {
          const input=req.postDataJSON();
          preview={...input,officeName:offices.find(office=>office.id===input.officeId)?.name,readOnly:true};
          return respond({user:actor,preview});
        }
        if (path === '/api/access/preview/end') { preview=null; return respond({user:actor,preview}); }
        if (path === '/api/access/users') return respond({users:[actor],offices});
        if (path === '/api/access/phone-requests') return respond({requests:[]});
        if (path === '/api/enquiries/dispatcher') {
          assert.equal(req.method(),'GET'); assert.equal(preview,null);
          privateReads++;
          return respond({routes:[{centre:'singapore',groupName:actor.isAdmin?group:'Synthetic Member Group',canConnect:actor.isAdmin,connected:false}]});
        }
        if (path === '/api/enquiries/test-policy') return respond({enabled:false,generation:''});
        if (path === '/api/enquiries/records') {
          assert.equal(preview,null);
          assert.equal(url.searchParams.get('scope'),'workbench');
          const eligible = actor.isAdmin || actor.isSpcTrader;
          if (eligible) queueReads++;
          return respond({items:eligible?[queueRow]:[],nextCursor:null});
        }
        if (path === '/api/enquiries/inbox') return respond({items:[],nextCursor:null,unreadCount:0});
        if (path.startsWith('/api/admin/')) return respond({items:[],count:0,nextCursor:null});
        return route.fulfill({status:404,json:{message:'No synthetic data.'}});
      });
      const shot = async name => {
        await page.screenshot({path:`${out}/${engine}-${width}-${theme}-${name}.png`,fullPage:true});
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' overflows');
      };
      const close = () => page.getByRole('button',{name:'Close workspace',exact:true}).click();
      const details = async () => {
        await page.getByRole('button',{name:'Settings',exact:true}).click();
        const dialog=page.getByRole('dialog',{name:'Settings',exact:true});
        await dialog.getByRole('button',{name:'Personal details',exact:true}).click();
        return dialog;
      };
      const enquiries = async () => {
        const nav=page.getByRole('navigation',{name:'Workspace navigation'});
        const trading=nav.getByRole('button',{name:'Trading',exact:true});
        if (await trading.getAttribute('aria-expanded')!=='true') await trading.click();
        await nav.getByRole('button',{name:'Enquiries',exact:true}).click();
        return page.getByRole('dialog',{name:'Enquiries',exact:true});
      };
      try {
        await page.goto(base);
        await expect(page.getByRole('button',{name:'Sign in',exact:true})).toBeVisible();
        assert.equal(privateReads,0);
        actor={...owner};
        await invalidateFixtureAuthority(page,{user:actor,preview});
        await expect(page.locator('.hud-identity')).toContainText(owner.displayName);
        const account = await details();
        await expect(account.getByText(group,{exact:true})).toBeVisible();
        await expect(account.getByRole('button',{name:'Connect dispatcher',exact:true})).toBeVisible();
        await shot('assigned-group'); await close();
        for (const [role,label] of roles) {
          const footer=page.locator('.home-display-controls');
          await footer.getByRole('button',{name:'View as',exact:true}).click();
          await footer.getByRole('combobox',{name:'Preview office',exact:true}).selectOption('sg');
          await footer.getByRole('button',{name:label,exact:true}).click();
          await expect(page.getByRole('status',{name:'Role preview'}).first()).toContainText(role==='credit'?'CREDIT':'SINGAPORE');
          const dialog=await enquiries();
          await expect(dialog.getByRole('button',{name:'NEW ENQUIRY',exact:true})).toBeDisabled();
          await expect(dialog.locator('[data-commercial-id]')).toHaveCount(0);
          if (role==='spc-trader') await shot('spc-preview');
          await close();
          const before=privateReads;
          const privateDetails=await details(); await expect(privateDetails.getByText(group,{exact:true})).toHaveCount(0);
          assert.equal(privateReads,before);
          await close();
          await page.getByRole('button',{name:'Back to '+owner.displayName,exact:true}).first().click();
        }
        for (const [role] of roles) {
          actor={...owner,id:'10000000-0000-4000-8000-00000000000'+(roles.findIndex(([r])=>r===role)+2),
            displayName:'SYNTHETIC '+role.toUpperCase(),isAdmin:false,isSpcTrader:role==='spc-trader',isManager:role==='manager',
            officeId:role==='credit'?'CREDIT':'sg',officeName:role==='credit'?'CREDIT':'SINGAPORE'};
          await invalidateFixtureAuthority(page,{user:actor,preview});
          await expect(page.locator('.hud-identity')).toContainText(actor.displayName);
          await expect(page.getByRole('button',{name:'View as',exact:true})).toHaveCount(0);
          const read=page.waitForResponse(response=>new URL(response.url()).searchParams.get('scope')==='workbench');
          const dialog=await enquiries(); await read;
          await expect(dialog.getByText('SHARED SYNTHETIC QUEUE',{exact:true})).toHaveCount(role==='spc-trader'?1:0);
          await expect(dialog.getByRole('button',{name:'Singapore queue',exact:true})).toHaveCount(0);
          await close();
          const privateDetails=await details(); await expect(privateDetails.getByText('Synthetic Member Group',{exact:true})).toBeVisible();
          await expect(privateDetails.getByRole('button',{name:'Connect dispatcher',exact:true})).toHaveCount(0); await close();
        }
        assert.ok(queueReads>=1); assert.deepEqual(problems,[]);
        cases.push({engine,width,theme,passed:true}); console.log(`PASS ${engine} ${width} ${theme} · four roles and private groups`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
}
await writeFile(`${out}/report.json`,JSON.stringify(cases));
