import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {chromium,webkit,expect} from '@playwright/test';
import {installSharedAttachments} from './fixtures/shared-attachments.mjs';
import {installSharedLocations} from './fixtures/shared-locations.mjs';
import {installEmptyLiveInbox} from './fixtures/empty-live-inbox.mjs';
import {installStagingCookies} from './fixtures/protection-cookies.mjs';
const base=process.env.ECO_SHARED_ATTACHMENTS_ORIGIN||'http://127.0.0.1:4288',out=resolve(process.env.ECO_SHARED_ATTACHMENTS_OUTPUT||'/private/tmp/eco-shared-attachments');
const user={id:'10000000-0000-4000-8000-000000000001',email:'attachments@example.test',displayName:'ATTACHMENT FIXTURE',phone:'',officeId:'hk',officeName:'Hong Kong',isAdmin:true,isSpcTrader:true,isManager:false,isActive:true,activated:true,passwordChangeSuggested:false,revision:1};
const bytes=Buffer.from('Original intact document'),hash=createHash('sha256').update(bytes).digest('hex'),results=[];await mkdir(out,{recursive:true});
for(const engine of (process.env.ECO_SHARED_ATTACHMENTS_ENGINES||'chromium,webkit').split(',')){
 const browser=await({chromium,webkit})[engine].launch({headless:true});
 try{for(const width of (process.env.ECO_SHARED_ATTACHMENTS_WIDTHS||'1440,320,390').split(',').map(Number))for(const theme of (process.env.ECO_SHARED_ATTACHMENTS_THEMES||'light,dark').split(',')){
  const context=await browser.newContext({viewport:{width,height:1000},hasTouch:width<700,reducedMotion:'reduce'}),page=await context.newPage(),name=`${engine}-${width}-${theme}`;page.setDefaultTimeout(15000);const errors=[];let fixture,sessionUser=user;page.on('pageerror',e=>errors.push(e.message));
  try{
   await installStagingCookies(context,base);
   await context.addInitScript(theme=>localStorage.setItem('ecosystem.theme.v1',theme),theme);
   await context.route('**/api/**',r=>r.fulfill({status:404,json:{message:'Unconfigured fixture.'}}));await installEmptyLiveInbox(context);
   await context.route('**/api/access/**',r=>sessionUser?r.fulfill({json:new URL(r.request().url()).pathname.endsWith('/session')?{user:sessionUser,preview:null}:new URL(r.request().url()).pathname.endsWith('/users')?{users:[sessionUser],offices:[]}:{requests:[]}}):r.fulfill({status:401,json:{message:'Sign in required.'}}));
   await context.route('**/api/profile-tabs/**',r=>r.fulfill({json:{shared:{revision:0,tabs:[]},private:{revision:0,tabs:[]}}}));
   await context.route('**/api/suppliers/**',r=>r.fulfill({json:{items:[],total:0,page:1,pageSize:100}}));
   await context.route('**/api/enquiries/test-policy',r=>r.fulfill({json:{enabled:false}}));
   await context.route('**/api/admin/**',r=>r.fulfill({json:{items:[],count:0}}));
   await installSharedLocations(context,{user:()=>sessionUser});fixture=await installSharedAttachments(context,{user:()=>sessionUser});
   await page.goto(base);await page.getByRole('main',{name:'ECOSYSTEM workspace'}).waitFor();await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
   const nav=page.getByRole('navigation',{name:'Workspace navigation'});await nav.getByRole('button',{name:'Ports & Suppliers',exact:true}).click();await nav.getByRole('button',{name:'Countries & Ports',exact:true}).click();
   const workspace=page.getByRole('dialog',{name:'Countries & Ports',exact:true});await workspace.getByRole('button',{name:'Port Index',exact:true}).click();await workspace.getByLabel('Country or port',{exact:true}).fill('Singapore');await workspace.locator('.location-table').getByRole('button',{name:'Singapore',exact:true}).click();await workspace.locator('.knowledge-header .attachments-trigger').first().click();
   const files=page.getByRole('dialog',{name:'Attachments',exact:true});
   await page.evaluate(async owner=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('ecosystem.attachments.v1',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});const bytes=new Uint8Array(50*1024*1024+1);bytes[0]=17;bytes[bytes.length-1]=29;await new Promise((resolve,reject)=>{const tx=db.transaction(['items','blobs'],'readwrite');tx.objectStore('items').put({id:'oversized-local-original',folderId:'port:port-singapore',scope:{target:{kind:'port',id:'port-singapore'}},name:'Oversized browser original.bin',type:'file',size:bytes.length,mime:'application/octet-stream',createdBy:owner,createdAt:'2026-01-01T00:00:00Z'});tx.objectStore('blobs').put({id:'oversized-local-original',bytes:bytes.buffer,mime:'application/octet-stream'});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();const channel=new BroadcastChannel('ecosystem.attachments.v1');channel.postMessage('refresh');channel.close();},user.id);
   await expect(files.getByText(/1 ABOVE 50 MB/)).toBeVisible();fixture.failPrepareResponseOnce=true;
   await files.getByLabel('Upload attachments',{exact:true}).setInputFiles({name:'Retry original.txt',mimeType:'text/plain',buffer:bytes});
   await expect(files.getByRole('button',{name:'IMPORT MY ATTACHMENTS',exact:true})).toBeEnabled();assert.equal(fixture.uploads.size,1);assert.equal(fixture.putCount,0);
   const first=[...fixture.uploads.values()][0];await files.getByRole('button',{name:'IMPORT MY ATTACHMENTS',exact:true}).click();
   await expect.poll(()=>fixture.items.size).toBe(1);assert.equal(fixture.uploads.size,1);assert.equal(fixture.putCount,1);assert.equal(fixture.sha256(first.item.id),hash);assert.ok(!fixture.uploads.has('oversized-local-original'),'an oversized original does not block a valid import or request a cloud allocation');
   const prepares=fixture.requests.filter(r=>r.route.endsWith('/prepare'));assert.equal(prepares[0].body.requestId,prepares[1].body.requestId,'uncertain response resumes exact durable operation');
   fixture.corruptUploadOnce=true;await files.getByLabel('Upload attachments',{exact:true}).setInputFiles({name:'Checksum original.txt',mimeType:'text/plain',buffer:bytes});
   await expect(files.getByText('Uploaded file checksum does not match.',{exact:true})).toBeVisible();assert.equal(fixture.items.size,1);
   const bad=[...fixture.uploads.values()].find(u=>u.item.name==='Checksum original.txt'),unchanged=Buffer.from(bad.bytes);await files.getByRole('button',{name:'IMPORT MY ATTACHMENTS',exact:true}).click();
   await expect(files.getByText('Uploaded file checksum does not match.',{exact:true})).toBeVisible();assert.deepEqual(bad.bytes,unchanged,'a retry never overwrites a damaged immutable object');assert.equal(fixture.items.size,1);
   const staged=await page.evaluate(async()=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('ecosystem.attachments.shared-stage.v1',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});const rows=await new Promise((resolve,reject)=>{const r=db.transaction('entries').objectStore('entries').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});db.close();return Promise.all(rows.map(async row=>({name:row.item.name,actorId:row.actorId,sha:[...new Uint8Array(await crypto.subtle.digest('SHA-256',row.bytes))].map(b=>b.toString(16).padStart(2,'0')).join('')})));});
   const large=await page.evaluate(async()=>{const db=await new Promise(resolve=>{const r=indexedDB.open('ecosystem.attachments.v1',1);r.onsuccess=()=>resolve(r.result);});const original=await new Promise(resolve=>{const r=db.transaction('blobs').objectStore('blobs').get('oversized-local-original');r.onsuccess=()=>resolve(r.result);});db.close();const b=new Uint8Array(original.bytes);return{size:b.length,first:b[0],last:b[b.length-1]};});assert.deepEqual(large,{size:50*1024*1024+1,first:17,last:29},'oversized original remains untouched in the legacy archive');
   assert.equal(staged.length,2);assert.ok(staged.every(s=>s.actorId===user.id&&s.sha===hash),'both original byte copies survive upload and validation failures');
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no horizontal overflow');await page.screenshot({path:`${out}/${name}.png`});
   const publications=fixture.items.size,requests=fixture.requests.length;sessionUser=null;await page.reload();await expect(page.getByLabel('Password',{exact:true})).toBeVisible();await expect(page.getByRole('main',{name:'ECOSYSTEM workspace'})).toHaveCount(0);await expect(page.getByRole('dialog',{name:'Attachments',exact:true})).toHaveCount(0);await expect(page.locator('html')).toHaveAttribute('data-theme',theme);assert.equal(fixture.items.size,publications);assert.equal(fixture.requests.length,requests,'signed-out view never reads or writes shared attachments');assert.deepEqual(errors,[]);await page.screenshot({path:`${out}/${name}-signed-out.png`});
   results.push({engine,width,theme,passed:true,signedIn:true,signedOut:true});console.log(`PASS ${name}: uncertain retry, immutable mismatch, oversized skip, retained originals and signed-out boundary`);
  }catch(error){console.error(JSON.stringify({engine,width,theme,errors,requests:fixture?.requests.filter(r=>!r.route.endsWith('/list')).map(r=>({route:r.route,id:r.body?.id,requestId:r.body?.requestId})),puts:fixture?.putCount,uploads:[...(fixture?.uploads.values()??[])].map(u=>({name:u.item.name,expectedSize:u.item.size,expectedMime:u.item.mime,size:u.bytes?.length,mime:u.mime}))}));await page.screenshot({path:`${out}/${name}-failure.png`});throw error;}finally{await context.close();await writeFile(`${out}/results.json`,JSON.stringify(results,null,2));}
 }}finally{await browser.close();}
}
