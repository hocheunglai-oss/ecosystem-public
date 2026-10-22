import { installSharedLocations, sharedLocations } from './fixtures/shared-locations.mjs';
import { installSharedAttachments } from './fixtures/shared-attachments.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve, sep } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { installStagingCookies } from './fixtures/protection-cookies.mjs';
import { installEmptyLiveInbox } from './fixtures/empty-live-inbox.mjs';

// Isolated browser fixtures: no contributions, identities or preview counts are
// written to a hosted service. Real backend permissions are verified separately.
const base = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4266';
const output = process.env.ECO_TEST_OUTPUT ? pathToFileURL(resolve(process.env.ECO_TEST_OUTPUT) + sep) : new URL('../output/contribution-tiers/', import.meta.url);
await mkdir(output, { recursive: true });
const id = '10000000-0000-4000-8000-000000000001';
const key = `ecosystem.live.v1:${id}:state:v2`;
const administrator = { id, email: 'owner@example.test', displayName: 'OWNER FIXTURE', phone: '+6591815902', officeId: 'HONG KONG', officeName: 'HONG KONG', isAdmin: true, isSpcTrader: false, isManager: false, isActive: true, activated: true, passwordChangeSuggested: false, revision: 1, capabilities: { appearancePreview: true, testWorkspace: true } };
const now = new Date('2026-10-14T03:00:00Z');
const reports = [];
const height=Number(process.env.ECO_TEST_HEIGHT || 1000);
async function fixture(page, total) {
  await page.evaluate(({key, id, total}) => {
    const state = JSON.parse(localStorage.getItem(key));
    const item = (index, at) => ({ id: `published-${index}`, createdAt: at, publishedAt: at, title: `FEEDBACK ${index}`, body: `USEFUL FEEDBACK ${index}`, author: id, status: 'approved', publication: 'direct', targetType: 'feedback', targetId: 'ecosystem' });
    state.contributions = [...Array.from({length:total}, (_,i) => item(i,'2026-10-13T01:00:00Z')), item('old','2026-10-01T01:00:00Z')];
    state.drops = [];
    state.hats = [{ id:'hat-1', targetKey:'test-hat', readerId:'otto', recipientId:id, awardedAt:'2026-10-13T01:00:00Z', target:{kind:'key-info',portId:'port-chiba',field:'sampleLocation'}, update:{updatedBy:id,updatedAt:'2026-10-12T01:00:00Z'} }];
    localStorage.setItem(key,JSON.stringify(state));
  }, {key,id,total});
  await page.reload({waitUntil:'networkidle'});
}
for (const engine of ['chromium', 'webkit']) {
  if (process.env.ECO_TEST_ENGINE && engine !== process.env.ECO_TEST_ENGINE) continue;
  const browser = await (engine === 'chromium' ? chromium : webkit).launch({headless:true});
  try {
    for (const width of [1440, 390, 320]) for (const theme of ['light', 'dark']) {
      if (process.env.ECO_TEST_WIDTH && width !== Number(process.env.ECO_TEST_WIDTH)) continue;
      if (process.env.ECO_TEST_THEME && theme !== process.env.ECO_TEST_THEME) continue;
      const context = await browser.newContext({viewport:{width,height},isMobile:width<850,hasTouch:width<850,reducedMotion:'reduce'});
      await installStagingCookies(context, base);
      let user = {...administrator}, preview = null, writes = [];
      await installEmptyLiveInbox(context);
      await installSharedLocations(context,{user:()=>user,preview:()=>preview,now:()=>now.toISOString()});
      await installSharedAttachments(context,{user:()=>user,preview:()=>preview});
      await context.route('**/api/admin/**',route=>{if(route.request().method()!=='GET')writes.push(route.request().url());return route.fulfill({json:{count:0,previousCount:0,items:[],periodStart:'2026-10-07T16:00:00Z',periodEnd:'2026-10-14T16:00:00Z',source:'shared-feedback',timeZone:'Asia/Hong_Kong'}});});
      await context.route('**/api/access/**', route => {
        const path = new URL(route.request().url()).pathname.replace('/api/access/','');
        const reply = (json,status=200) => route.fulfill({json,status});
        if (path === 'session') return reply({user,effectiveUser:user,preview});
        if (path === 'phone-requests' && route.request().method() === 'GET') return reply({requests:[]});
        if (path === 'users' && route.request().method() === 'GET') return reply({users:[user],offices:[{id:'HONG KONG',name:'HONG KONG'},{id:'CREDIT',name:'CREDIT'}]});
        writes.push(path); return reply({message:'Unexpected access request'},403);
      });
      await context.addInitScript(theme => localStorage.setItem('ecosystem.theme.v1',theme),theme);
      const page=await context.newPage(), errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.clock.setFixedTime(now);
      const checkFit = async () => {
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1), `${engine} ${width} ${theme}: page overflow`);
        for (const target of ['[data-trader-hud]','.hud-resource-activity','.hud-resource-activity .contribution-tier','#hud-contribution-activity']) {
          const box=await page.locator(target).boundingBox();
          assert.ok(box && box.x>=0 && box.x+box.width<=width+1,`${engine} ${width}: ${target} fits`);
        }
        if(width>850) {
          const bounds=await page.locator('#hud-contribution-activity').boundingBox(),footer=await page.locator('.home-display-controls').boundingBox();
          assert.ok(bounds.y>=0&&bounds.y+bounds.height<=footer.y-2,`Expanded contribution stays above footer at ${height}px height`);
          const available=await page.locator('#hud-contribution-activity .hud-inline-scroll').evaluate(el=>Number.parseFloat(getComputedStyle(el).maxHeight));
          if(height===1000) assert.ok(available>380,'Tall desktops use more than the former380px body');
        }
        const tier=page.locator('.hud-resource-activity .contribution-tier');
        assert.ok(await tier.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'Tier text fits its box');
        if(width<850) assert.ok((await page.getByRole('button',{name:'Close contribution activity',exact:true}).boundingBox()).height>=44,'Phone close target has a 44px height');
      };
      const shot=async name => {
        if(width>850) await page.locator('.marine-world[data-artwork-ready="true"]').waitFor();
        await page.screenshot({path:new URL(`${engine}-${width}-${theme}-${name}.png`,output).pathname,fullPage:true});
        const panel=page.locator('#hud-contribution-activity');
        if(width>850 && await panel.count()) await panel.screenshot({path:new URL(`${engine}-${width}-${theme}-${name}-panel.png`,output).pathname});
      };
      try {
        await page.goto(base,{waitUntil:'networkidle'});
        await expect(page.locator('[data-trader-hud]')).toBeVisible();
        for(const [total,label] of [[0,'INACTIVE'],[1,'ACTIVE'],[10,'ACTIVE'],[11,'OUTSTANDING']]) {
          await fixture(page,total);
          const trigger=page.locator('.hud-resource-activity');
          await expect(trigger.locator('.contribution-tier')).toHaveText(label);
          await trigger.click();
          const panel=page.locator('#hud-contribution-activity');
          await expect(panel.locator('[data-activity-total]')).toHaveText(String(total));
          await expect(panel.locator('.activity-tier-heading .contribution-tier')).toHaveText(label);
          await expect(panel.locator('.activity-tier-emblem')).toBeVisible();
          const progress=panel.getByRole('progressbar',{name:'Contribution progress',exact:true});
          await expect(progress).toHaveAttribute('aria-valuenow',String(Math.min(total,11)));
          await expect(progress).toHaveAttribute('aria-valuemax','11');
          await expect(progress.locator('span')).toHaveCount(11);
          await expect(progress.locator('span[data-complete="true"]')).toHaveCount(Math.min(total,11));
          await expect(panel.locator('[data-activity-next-tier]')).toContainText(total===0?'1MORE TO ACTIVE':total<11?`${11-total}MORE TO OUTSTANDING`:'OUTSTANDING REACHED');
          if (total===0 || total===1 || total===11) await shot(label.toLowerCase());
          await expect(panel).toContainText('HOW TO CONTRIBUTE');
          await expect(panel).toContainText('UPDATE INFORMATION OR SEND FEEDBACK.');
          await expect(panel.getByRole('button',{name:/^(EDIT|FEEDBACK)$/i})).toHaveCount(0);
          await expect(panel).not.toContainText('HOW IT COUNTS');
          await expect(panel).not.toContainText('HONG KONG TIME');
          await expect(panel).not.toContainText('PREVIOUS SIX DAYS');
          await expect(panel).not.toContainText('EXCEPTIONAL');
          await checkFit();
          if(total===0) await shot('how-to-contribute');
          await page.getByRole('button',{name:'Close contribution activity',exact:true}).click();
        }
        // Every preview updates both appearances but never changes saved activity.
        await fixture(page,0);
        await page.locator('.hud-resource-activity').click();
        const before=await page.evaluate(key=>localStorage.getItem(key),key);
        const previewSelect=page.getByRole('combobox',{name:'Contribution appearance preview'});
        await expect(previewSelect).toBeVisible();
        if(width<850) assert.ok((await previewSelect.boundingBox()).height>=44,'Phone preview selector has a 44px target');
        for(const [status,total] of [['inactive',0],['active',5],['outstanding',11]]) {
          await previewSelect.selectOption(status);
          await expect(page.locator('.hud-resource-activity .contribution-tier')).toHaveText(status.toUpperCase());
          await expect(page.locator('#hud-contribution-activity [data-activity-total]')).toHaveText(String(total));
          await expect(page.locator('.activity-preview-label')).toHaveText('PREVIEW');
          const progress=page.getByRole('progressbar',{name:'Contribution progress',exact:true});
          await expect(progress).toHaveAttribute('aria-valuenow',String(Math.min(total,11)));
          await expect(progress.locator('span[data-complete="true"]')).toHaveCount(Math.min(total,11));
          assert.equal(await page.evaluate(key=>localStorage.getItem(key),key),before,'Preview never changes persisted records');
          await checkFit();
        }
        await shot('appearance-preview');
        await page.getByRole('button',{name:'Close contribution activity',exact:true}).click();
        await expect(page.locator('.hud-resource-activity .contribution-tier')).toHaveText('INACTIVE');
        await page.locator('.hud-resource-activity').click();
        await expect(previewSelect).toHaveValue('actual');
        await previewSelect.selectOption('active');
        await page.locator('.hud-resource-hats').click();
        await page.locator('.hud-resource-activity').click();
        await expect(previewSelect).toHaveValue('actual');
        await page.keyboard.press('Escape');
        await expect(page.locator('#hud-contribution-activity')).toHaveCount(0);
        await expect(page.locator('.hud-resource-activity')).toBeFocused();
        // The brief encouragement stays informational; opening the actual database and feedback flows does not publish.
        await page.locator('.hud-resource-activity').click();
        const actionPanel=page.locator('#hud-contribution-activity');
        await expect(actionPanel.getByRole('button',{name:/^(DATABASE UPDATE|FEEDBACK)$/i})).toHaveCount(0);
        await page.getByRole('button',{name:'Close contribution activity',exact:true}).click();
        const nav=page.getByRole('navigation',{name:'Workspace navigation'});
        await nav.getByRole('button',{name:'Ports & Suppliers',exact:true}).click();
        await nav.getByRole('button',{name:'Countries & Ports',exact:true}).click();
        await expect(page.getByRole('dialog',{name:'Countries & Ports',exact:true})).toBeVisible();
        await expect(page.locator('#hud-contribution-activity')).toHaveCount(0);
        await page.getByRole('button',{name:'Close workspace',exact:true}).click();
        await page.locator('.home-display-controls').getByRole('button',{name:'Feedback for ecosystem',exact:true}).click();
        const feedback=page.getByRole('dialog',{name:'Feedback for ecosystem',exact:true});
        await expect(feedback).toBeVisible();
        await feedback.getByRole('button',{name:'Close dialog',exact:true}).click();
        assert.equal(await page.evaluate(key=>localStorage.getItem(key),key),before,'Opening contribution actions never publishes a record');
        // Appearance checking requires the session capability, not an email or admin role.
        user={...administrator,email:'Other.Admin@example.com',displayName:'OTHER ADMIN',capabilities:{appearancePreview:false,testWorkspace:false}};
        await page.reload({waitUntil:'networkidle'});
        await page.locator('.hud-resource-activity').click();
        await expect(page.getByRole('combobox',{name:'Contribution appearance preview'})).toHaveCount(0);
        await expect(page.getByRole('button',{name:'View as',exact:true})).toBeVisible();
        // A normal user cannot see the appearance controls either.
        user={...administrator,email:'Other.User@example.com',displayName:'OTHER USER',isAdmin:false,capabilities:{appearancePreview:false,testWorkspace:false}};
        await page.reload({waitUntil:'networkidle'});
        await page.locator('.hud-resource-activity').click();
        await expect(page.getByRole('combobox',{name:'Contribution appearance preview'})).toHaveCount(0);
        await checkFit();
        // Both actual CREDIT members and the effective CREDIT role preview omit it.
        user={...user,officeId:'CREDIT',officeName:'CREDIT'};
        await page.reload({waitUntil:'networkidle'});
        await expect(page.locator('[data-trader-hud]')).toBeVisible();
        await expect(page.locator('.hud-resource-activity')).toHaveCount(0);
        await expect(page.locator('#hud-contribution-activity')).toHaveCount(0);
        user={...administrator}; preview={role:'credit',officeId:'CREDIT',officeName:'CREDIT',readOnly:true};
        await page.reload({waitUntil:'networkidle'});
        await expect(page.locator('[data-trader-hud]')).toBeVisible();
        await expect(page.locator('.hud-resource-activity')).toHaveCount(0);
        await shot('credit');
        assert.deepEqual(errors,[]); assert.deepEqual(writes,[]);assert.deepEqual(sharedLocations(page).requests,[],'Tier appearance and navigation never publish shared location records');
        reports.push({engine,width,height,theme,passed:true});
        console.log(`PASS ${engine} ${width} ${theme}: thresholds, seven days, appearance preview, normal user, CREDIT`);
      } catch(error) { await shot('failure').catch(()=>{}); throw error; }
      finally { await context.close(); }
    }
  } finally { await browser.close(); }
}
await writeFile(new URL('results.json',output),JSON.stringify(reports,null,2));
