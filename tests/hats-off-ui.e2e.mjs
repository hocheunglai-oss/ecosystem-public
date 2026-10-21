import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve, sep } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { installStagingCookies } from './fixtures/protection-cookies.mjs';

// Every account API is intercepted. Data lives only in each isolated browser
// context; appearance previews must never change this data or call a write API.
const base = process.env.ECO_DEMO_URL || 'http://127.0.0.1:4270';
const output = process.env.ECO_TEST_OUTPUT ? pathToFileURL(resolve(process.env.ECO_TEST_OUTPUT) + sep) : new URL('../output/hats-off/', import.meta.url);
await mkdir(output, { recursive: true });
const id = '10000000-0000-4000-8000-000000000001';
const key = `ecosystem.prototype.v2:${id}`;
const administrator = { id, email:'owner@example.test', displayName:'OWNER FIXTURE', phone:'+6591815902', officeId:'HONG KONG',officeName:'HONG KONG',isAdmin:true,isSpcTrader:false,isManager:false,isActive:true,activated:true,passwordChangeSuggested:false,revision:1,capabilities:{appearancePreview:true,testWorkspace:true} };
const now = new Date('2026-10-14T03:00:00Z');
const reports = [];
const height=Number(process.env.ECO_TEST_HEIGHT || 1000);
const persisted = page => page.evaluate(key => localStorage.getItem(key),key);
async function fixture(page, ownCount, empty=false) {
  await page.evaluate(({key,id,ownCount,empty}) => {
    const state=JSON.parse(localStorage.getItem(key));
    const award=(suffix,recipientId,readerId,at) => ({id:`hat-${suffix}`,targetKey:`test-${suffix}`,readerId,recipientId,awardedAt:at,target:{kind:'key-info',portId:'port-chiba',field:'sampleLocation'},update:{updatedBy:recipientId,updatedAt:'2026-10-10T01:00:00Z'}});
    state.hats=empty ? [] : [
      ...Array.from({length:5},(_,i)=>award(`leader-${i}`,'elena','luca','2026-10-12T01:00:00Z')),
      ...Array.from({length:2},(_,i)=>award(`other-${i}`,'filippo','marco','2026-10-12T01:00:00Z')),
      ...Array.from({length:ownCount},(_,i)=>award(`own-${i}`,id,['luca','marco','gianmichele'][i%3],`2026-10-${13-i}T01:00:00Z`)),
      {...award('undone',id,'silvia','2026-10-14T01:00:00Z'),undoneAt:'2026-10-14T02:00:00Z'},
      award('self',id,id,'2026-10-14T01:00:00Z'),
    ];
    state.contributions=[];
    state.drops=[];
    localStorage.setItem(key,JSON.stringify(state));
  },{key,id,ownCount,empty});
  await page.reload({waitUntil:'networkidle'});
}
for(const engine of ['chromium','webkit']) {
  if(process.env.ECO_TEST_ENGINE && engine!==process.env.ECO_TEST_ENGINE) continue;
  const browser=await (engine==='chromium'?chromium:webkit).launch({headless:true});
  try {
    for(const width of [1440,390,320]) for(const theme of ['light','dark']) {
      if(process.env.ECO_TEST_WIDTH && width!==Number(process.env.ECO_TEST_WIDTH)) continue;
      if(process.env.ECO_TEST_THEME && theme!==process.env.ECO_TEST_THEME) continue;
      const context=await browser.newContext({viewport:{width,height},isMobile:width<850,hasTouch:width<850,reducedMotion:'reduce'});
      await installStagingCookies(context,base);
      let user={...administrator},preview=null;
      const writes=[],errors=[];
      await context.route('**/api/access/**',route=>{
        const path=new URL(route.request().url()).pathname.replace('/api/access/','');
        const reply=(json,status=200)=>route.fulfill({json,status});
        if(path==='session') return reply({user,effectiveUser:user,preview});
        if(path==='phone-requests'&&route.request().method()==='GET') return reply({requests:[]});
        if(path==='users'&&route.request().method()==='GET') return reply({users:[user],offices:[{id:'HONG KONG',name:'HONG KONG'},{id:'CREDIT',name:'CREDIT'}]});
        writes.push(path);return reply({message:'Unexpected access request'},403);
      });
      await context.addInitScript(theme=>localStorage.setItem('ecosystem.theme.v1',theme),theme);
      const page=await context.newPage();
      page.on('pageerror',error=>errors.push(error.message));
      await page.clock.setFixedTime(now);
      const trigger=page.locator('.hud-resource-hats');
      const panel=page.locator('#hud-hats-off');
      const shots=[];
      const shot=async name=>{
        if(width>850) await page.locator('.marine-world[data-artwork-ready="true"]').waitFor();
        const path=new URL(`${engine}-${width}-${theme}-${name}.png`,output).pathname;
        await page.screenshot({path,fullPage:true});shots.push(path);
        if(width>850 && await panel.count()) await panel.screenshot({path:new URL(`${engine}-${width}-${theme}-${name}-panel.png`,output).pathname});
      };
      const fit=async()=>{
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No horizontal page overflow');
        for(const target of ['[data-trader-hud]','.hud-resource-hats','#hud-hats-off']) {
          const box=await page.locator(target).boundingBox();
          assert.ok(box&&box.x>=-1&&box.x+box.width<=width+1,`${target} fits ${width}px`);
        }
        if(width>850) {
          const bounds=await panel.boundingBox(),footer=await page.locator('.home-display-controls').boundingBox();
          assert.ok(bounds.y>=0&&bounds.y+bounds.height<=footer.y-2,`Expanded Hats panel stays above footer at ${height}px height`);
          const available=await panel.locator('.hud-inline-scroll').evaluate(el=>Number.parseFloat(getComputedStyle(el).maxHeight));
          if(height===1000) assert.ok(available>380,'Tall desktops use more than the former380px body');
        }
        const clipped=await panel.locator('h2,h3,p,.hats-off-name').evaluateAll(elements=>elements.filter(el=>el.scrollWidth>el.clientWidth+1).map(el=>el.textContent));
        assert.deepEqual(clipped,[],'Panel text does not clip');
        if(width<850) {
          assert.ok((await trigger.boundingBox()).height>=44,'Phone Hats Off target >=44px');
          assert.ok((await panel.getByRole('button',{name:/^Close hats off$/i}).boundingBox()).height>=44,'Phone close target >=44px');
        }
      };
      const noPerformance=async()=>{
        await expect(page.locator('.hud-achievements-toggle,.hud-office-performance,#hud-achievements,.office-performance')).toHaveCount(0);
        await expect(page.getByRole('button',{name:/^(Achievements|Office performance)$/i})).toHaveCount(0);
      };
      try {
        await page.goto(base,{waitUntil:'networkidle'});
        await expect(page.locator('[data-trader-hud]')).toBeVisible();
        for(const total of [0,3]) {
          await fixture(page,total);
          await noPerformance();
          const before=await persisted(page);
          await expect(trigger.locator('strong')).toHaveText(String(total));
          await trigger.click();
          await expect(panel).toBeVisible();
          await expect(panel.getByRole('heading',{name:/^Hats off$/i})).toBeVisible();
          await expect(panel.getByRole('heading',{name:/Hats? ranking/i})).toBeVisible();
          await expect(panel.locator('.hats-off-ranking-list li')).toHaveCount(total?3:2);
          await expect(panel.locator('.hats-off-ranking-list .hats-off-name').first()).toHaveText('SAMPLE CREDIT REVIEWER');
          await expect(panel).not.toContainText(/compliments/i);
          await expect(panel.getByRole('region',{name:'Your Hats standing',exact:true})).toBeVisible();
          await expect(panel.locator('.hats-off-total strong')).toHaveText(String(total));
          await expect(panel.locator('.hats-off-your-rank strong')).toHaveText(total?'#2':'—');
          const progress=panel.getByRole('progressbar',{name:'Hats towards your next rank'});
          await expect(progress).toHaveAttribute('aria-valuenow',String(total));
          await expect(progress).toHaveAttribute('aria-valuemax',String(total?6:1));
          await expect(panel.locator('.hats-off-next')).toContainText(total?'3 HATS':'1 HAT');
          await expect(panel.locator('.hats-off-next')).toContainText(total?'TO RANK #1':'TO ENTER THE RANKING');
          if(total===0) {
            await expect(panel).toContainText(/useful contribution/i);
            await expect(panel).toContainText(/no hats/i);
          } else {
            await expect(panel).toContainText('SAMPLE TRADER C');
            await expect(panel).toContainText('SAMPLE ADMINISTRATOR');
            await expect(panel).toContainText('SAMPLE MANAGER A');
            await expect(panel.locator('.hats-off-recent-list .hats-off-name')).toHaveText(['SAMPLE TRADER C','SAMPLE ADMINISTRATOR','SAMPLE MANAGER A']);
            await expect(panel.locator('.hats-off-recent-list time')).toHaveText(['13 Oct 2026','12 Oct 2026','11 Oct 2026']);
            await expect(panel.locator('.hats-off-recent-list')).not.toContainText('SAMPLE MANAGER B');
          }
          await fit(); await shot(total?'received':'no-hats');
          assert.equal(await persisted(page),before,'Opening Hats Off does not change records');
          await panel.getByRole('button',{name:/^Close hats off$/i}).click();
          await expect(panel).toHaveCount(0);
        }
        // The configured owner can preview empty and received states independently of actual totals.
        await fixture(page,0);
        await trigger.click();
        const selector=page.getByRole('combobox',{name:'Hats appearance preview',exact:true});
        await expect(selector).toBeVisible();
        if(width<850) assert.ok((await selector.boundingBox()).height>=44,'Phone preview target >=44px');
        const before=await persisted(page);
        const options=await selector.locator('option').evaluateAll(els=>els.map(el=>el.value).filter(v=>v!=='actual'));
        assert.equal(options.length,2,'Two sample Hats appearances');
        for(const option of options) {
          await selector.selectOption(option);
          await expect(panel).toContainText('PREVIEW');
          await expect(panel.getByRole('heading',{name:/Hats? ranking/i})).toBeVisible();
          assert.equal(await persisted(page),before,'Hats preview never changes records');
          await expect(panel.locator('.hats-off-total strong')).toHaveText(option==='received'?'5':'0');
          await expect(panel.locator('.hats-off-your-rank strong')).toHaveText(option==='received'?'#2':'—');
          const previewProgress=panel.getByRole('progressbar',{name:'Hats towards your next rank'});
          await expect(previewProgress).toHaveAttribute('aria-valuenow',option==='received'?'5':'0');
          await expect(previewProgress).toHaveAttribute('aria-valuemax',option==='received'?'9':'1');
          if(option==='received') await expect(panel.locator('.hats-off-next')).toContainText('4 HATS');
          await panel.locator('.hud-inline-scroll').evaluate(el=>el.scrollTop=0);
          await fit(); await shot(`preview-${option}`);
        }
        await panel.getByRole('button',{name:/^Close hats off$/i}).click();
        await expect(trigger.locator('strong')).toHaveText('0');
        await trigger.click();
        await expect(selector).toHaveValue('actual');
        await selector.selectOption(options[1]);
        await page.locator('.hud-resource-activity').click();
        await trigger.click();
        await expect(selector).toHaveValue('actual');
        await page.keyboard.press('Escape');
        await expect(panel).toHaveCount(0);
        await expect(trigger).toBeFocused();
        // An entirely empty ranking still keeps the ranking region and earn guidance.
        await fixture(page,0,true);await trigger.click();
        await expect(panel.getByRole('heading',{name:/Hats? ranking/i})).toBeVisible();
        await expect(panel.locator('.hats-off-ranking-list li')).toHaveCount(0);
        await expect(panel).toContainText(/useful contribution/i);
        await shot('empty-ranking');
        // Normal trader, manager and unrelated administrator have no appearance controls.
        for(const kind of ['trader','manager','other-admin']) {
          user={...administrator,email:kind==='other-admin'?'admin@example.com':'member@example.com',displayName:kind.toUpperCase(),isAdmin:kind==='other-admin',isManager:kind==='manager',capabilities:{appearancePreview:false,testWorkspace:false}};
          await page.evaluate(({key,id})=>{const state=JSON.parse(localStorage.getItem(key));state.profiles[id].email='owner@example.test';state.profiles[id].capabilities={appearancePreview:true,testWorkspace:true};localStorage.setItem(key,JSON.stringify(state));},{key,id});
          await page.reload({waitUntil:'networkidle'});
          await noPerformance();await trigger.click();
          await expect(page.getByRole('combobox',{name:'Hats appearance preview',exact:true})).toHaveCount(0);
          await page.locator('.hud-resource-activity').click();
          await expect(page.getByRole('combobox',{name:'Contribution appearance preview',exact:true})).toHaveCount(0);
          if(kind==='other-admin') await expect(page.getByRole('button',{name:'View as',exact:true})).toBeVisible();
          await shot(kind);
          await page.locator('.hud-settings').click();
          const settings=page.getByRole('dialog',{name:'Settings',exact:true});
          await expect(settings).toBeVisible();
          await expect(settings.getByRole('button',{name:/^(Achievements|Office performance)$/i})).toHaveCount(0);
          await page.getByRole('button',{name:'Close workspace',exact:true}).click();
        }
        user={...administrator,email:'credit@example.com',displayName:'CREDIT USER',officeId:'CREDIT',officeName:'CREDIT',isAdmin:false};
        await page.reload({waitUntil:'networkidle'});
        await noPerformance();
        await expect(page.locator('.hud-resource-activity')).toHaveCount(0);
        await trigger.click();await fit();await shot('credit');
        assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
        reports.push({engine,width,height,theme,passed:true,shots});
        console.log(`PASS ${engine} ${width} ${theme}: Hats ranking, recent givers, owner previews, readonly/reset, roles, no achievements`);
      } catch(error) {await shot('failure').catch(()=>{});throw error;}
      finally {await context.close();}
    }
  } finally {await browser.close();}
}
await writeFile(new URL(process.env.ECO_TEST_ENGINE ? `${process.env.ECO_TEST_ENGINE}-results.json` : 'results.json',output),JSON.stringify(reports,null,2));
