/** Operator-only, disposable ECO identities. No staff mutations, invitations or credentials in reports. */
import {chromium, expect} from '@playwright/test';
import {createClient} from '@supabase/supabase-js';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,chmodSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {ecoConnections as target} from '../config/ecoConnections.ts';
import assert from 'node:assert/strict';
const root=new URL('..',import.meta.url).pathname, runId=randomBytes(8).toString('hex');
const output=root+'output/phone-change/cloud-'+runId;
const quote=v=>"'"+String(v).replaceAll("'","''")+"'";
const run=args=>execFileSync('pnpm',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:90000,maxBuffer:4*1024*1024});
const sb=args=>run(['dlx','--allow-build=supabase','supabase@2.120.0',...args]);
const vc=args=>run(['dlx','vercel@63.1.2',...args]);
const privateWrite=(path,data)=>{writeFileSync(path,data,{mode:0o600});chmodSync(path,0o600);};
let step='preflight', browser,contexts=[],identities=[],requests=[],completed=false,cleaned=false;
let service,base;
const save=()=>privateWrite(output+'/recovery.private.json',JSON.stringify({runId,step,base,identities,requests,completed,cleaned},null,2));
const mark=value=>{step=value;save();console.log(JSON.stringify({step}));};
const rows=sql=>{privateWrite(output+'/query.private.sql',sql);const r=JSON.parse(sb(['db','query','--linked','--project-ref',target.supabaseProjectRef,'--file',output+'/query.private.sql','--output','json']));return Array.isArray(r)?r:r.rows;};
const post=(context,path,data,extra={})=>context.request.post(base+'/api/access/'+path,{headers:{origin:base,'x-eco-request':'1',...extra},data,timeout:45000});
async function verify(){
 assert.ok(process.argv.includes('--allow-cloud-mutations'));
 base=process.env.ECO_VERIFY_ORIGIN;assert.ok(base&&new URL(base).origin===base&&new URL(base).protocol==='https:');
 assert.equal(JSON.parse(sb(['whoami','--output-format','json'])).username,'hocheunglai-oss');
 const project=JSON.parse(sb(['projects','list','--output','json'])).find(p=>p.id===target.supabaseProjectRef);
 assert.equal(project?.organization_id,target.supabaseOrganizationId);assert.equal(project?.region,target.supabaseRegion);assert.equal(project?.name,'ECO');
 const deployment=JSON.parse(vc(['inspect',base,'--json','--scope',target.vercel.teamId]));
 assert.equal(deployment.readyState,'READY');assert.ok(deployment.builds?.some(b=>b.output?.some(o=>o.digest?.startsWith(target.vercel.projectId+'/'))));
 mkdirSync(output,{recursive:true,mode:0o700});save();
 const keys=JSON.parse(readFileSync(root+'output/access/eco-api-keys.private.json','utf8'));
 service=createClient(`https://${target.supabaseProjectRef}.supabase.co`,keys.find(k=>k.type==='secret').api_key,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(20000)})}});
 const cookies=base===target.productionOrigin?[]:readFileSync(process.env.ECO_VERIFY_STAGING_COOKIES,'utf8').split('\n').filter(l=>l.includes('\t')&&(!l.startsWith('#')||l.startsWith('#HttpOnly_'))).map(l=>{const f=l.replace(/^#HttpOnly_/,'').split('\t');assert.equal(f[0].replace(/^\./,''),new URL(base).hostname);return{name:f[5],value:f[6],domain:new URL(base).hostname,path:f[2],secure:f[3]==='TRUE',httpOnly:l.startsWith('#HttpOnly_'),expires:Number(f[4])||-1};});
 try{
  mark('create-disposable-identities');
  const office=rows('select id,name from eco_private.offices where id<>\'CREDIT\' order by name limit 1')[0];
  browser=await chromium.launch({headless:true});
  for(const role of ['admin','trader','other']){
   const id=randomUUID(),email=`eco-phone-check-${runId}-${role}@example.com`,secret='EcoPhone9-'+randomBytes(20).toString('base64url');
   identities.push({id,email});save();
   const result=await service.auth.admin.createUser({id,email,password:secret,email_confirm:true,app_metadata:{eco_verification:runId}});assert.ifError(result.error);assert.equal(result.data.user.id,id);
   const profile={displayName:`ECO PHONE ${role.toUpperCase()}`,officeId:office.id,isAdmin:role==='admin',isActive:true,isManager:false,isSpcTrader:false,sourceSpcId:randomUUID(),phone:'+85255550100'};
   rows(`begin;select eco_private.provision_user(${quote(id)}::uuid,${quote(JSON.stringify(profile))}::jsonb);update eco_private.users set activated_at=now(),password_prompt_dismissed_at=now(),phone='+85255550100' where id=${quote(id)}::uuid;commit;`);
   const ctx=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});await ctx.addCookies(cookies);contexts.push(ctx);
   const login=await post(ctx,'login',{email,password:secret});assert.equal(login.status(),200);assert.equal((await login.json()).user.id,id);
  }
  const [admin,trader,other]=contexts,[adminUser,traderUser]=identities;
  mark('browser-request-and-admin-notification');
  const page=await trader.newPage();const adminPage=await admin.newPage();const errors=[];
  for(const p of [page,adminPage]){p.setDefaultTimeout(30000);p.on('pageerror',()=>errors.push(true));await p.goto(base);await p.getByRole('main',{name:'ECOSYSTEM workspace'}).waitFor();}
  await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Personal details',exact:true}).click();
  await page.getByRole('button',{name:'Request change',exact:true}).click();await page.getByLabel('New WhatsApp phone',{exact:true}).fill('+65 (9181) 5902');
  const responsePromise=page.waitForResponse(r=>r.url()===base+'/api/access/phone-requests'&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Submit request',exact:true}).click();
  const submitted=await responsePromise;assert.equal(submitted.status(),200);const request=(await submitted.json()).request;requests.push(request.id);save();
  assert.equal(request.requestedPhone,'+6591815902');assert.equal(request.status,'pending');
  assert.equal((await (await trader.request.get(base+'/api/access/session')).json()).user.phone,'+85255550100');
  assert.equal((await (await other.request.get(base+'/api/access/phone-requests')).json()).requests.length,0);
  const body=submitted.request().postDataJSON();assert.equal((await post(trader,'phone-requests',body)).status(),200);
  assert.equal((await post(trader,'phone-requests',{requestId:randomUUID(),phone:'+6591815903'})).status(),409);
  assert.equal((await post(trader,'phone-requests/review',{id:request.id,decision:'approve'})).status(),403);
  assert.equal((await post(admin,'phone-requests/review',{id:request.id,decision:'approve'},{origin:'https://untrusted.example'})).status(),403);
  await adminPage.reload();await adminPage.getByRole('button',{name:/Notifications, 1 phone change request/}).click();
  const queue=adminPage.getByRole('region',{name:'Phone change requests',exact:true});await expect(queue).toContainText('ECO PHONE TRADER');await expect(queue).toContainText('+6591815902');
  await adminPage.screenshot({path:output+'/admin-notification.png',fullPage:true});
  const approval=adminPage.waitForResponse(r=>r.url()===base+'/api/access/phone-requests/review'&&r.request().method()==='POST');
  await queue.getByRole('button',{name:'Approve',exact:true}).click();assert.equal((await approval).status(),200);
  assert.equal((await (await trader.request.get(base+'/api/access/session')).json()).user.phone,'+6591815902');
  assert.equal((await post(admin,'phone-requests/review',{id:request.id,decision:'approve'})).status(),200);
  assert.equal((await post(admin,'phone-requests/review',{id:request.id,decision:'decline'})).status(),409);
  await page.reload();await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Personal details',exact:true}).click();await expect(page.locator('.personal-details')).toContainText('+6591815902');
  await page.screenshot({path:output+'/approved-personal-details.png',fullPage:true});
  mark('decline-preview-and-stale-request-protection');
  const pending=(await (await post(trader,'phone-requests',{requestId:randomUUID(),phone:'+6591815903'})).json()).request;requests.push(pending.id);save();
  assert.equal((await post(admin,'preview',{role:'trader',officeId:office.id})).status(),200);
  assert.equal((await post(admin,'phone-requests/review',{id:pending.id,decision:'approve'})).status(),403);
  assert.equal((await post(admin,'phone-requests',{requestId:randomUUID(),phone:'+6591815999'})).status(),403);
  assert.equal((await post(admin,'preview/end',{})).status(),200);
  assert.equal((await post(admin,'phone-requests/review',{id:pending.id,decision:'decline'})).status(),200);
  assert.equal((await (await trader.request.get(base+'/api/access/session')).json()).user.phone,'+6591815902');
  const stale=(await (await post(trader,'phone-requests',{requestId:randomUUID(),phone:'+6591815904'})).json()).request;requests.push(stale.id);save();
  const current=(await (await trader.request.get(base+'/api/access/session')).json()).user;
  const edited=await post(admin,'users',{id:current.id,expectedRevision:current.revision,displayName:current.displayName,phone:'+6591815905',officeId:current.officeId,isAdmin:false,isManager:false,isSpcTrader:false,isActive:true});assert.equal(edited.status(),200);
  const staleReview=await post(admin,'phone-requests/review',{id:stale.id,decision:'approve'});assert.ok([200,409].includes(staleReview.status()));
  const final=rows(`select phone from eco_private.users where id=${quote(traderUser.id)}::uuid`)[0];assert.equal(final.phone,'+6591815905');
  const audit=rows(`select action from eco_private.access_audit where target_id=${quote(traderUser.id)}::uuid`);assert.ok(audit.some(x=>/phone/.test(x.action)));
  const authUser=await service.auth.admin.getUserById(traderUser.id);assert.ok(!authUser.data.user.phone);assert.equal(errors.length,0);
  completed=true;save();console.log(JSON.stringify({realCloud:true,browserRequest:true,browserAdminApproval:true,automaticUpdate:true,decline:true,traderCannotReview:true,crossOriginDenied:true,previewWritesDenied:true,staleRequestSafe:true,idempotent:true,providerPhoneUnchanged:true}));
 }finally{
  for(const c of contexts)await post(c,'logout',{}).catch(()=>{});await browser?.close();mark('cleanup-owned-fixtures');
  const candidates=rows(`select id,email,raw_app_meta_data->>'eco_verification' as marker from auth.users where email in (${identities.map(x=>quote(x.email)).join(',')||'null'})`);assert.ok(candidates.every(x=>x.marker===runId));
  if(candidates.length){const ids=candidates.map(x=>quote(x.id)+'::uuid').join(',');rows(`begin;delete from eco_private.phone_change_requests where user_id in (${ids});delete from eco_private.admin_operations where actor_id in (${ids}) or target_id in (${ids});delete from eco_private.revoked_sessions where user_id in (${ids});delete from eco_private.users where id in (${ids});commit;`);for(const c of candidates){assert.ifError((await service.auth.admin.deleteUser(c.id)).error);}}
  assert.equal(rows(`select id from auth.users where email in (${identities.map(x=>quote(x.email)).join(',')||'null'})`).length,0);cleaned=true;save();privateWrite(output+'/query.private.sql','-- Completed fixture cleanup.');console.log(JSON.stringify({cleaned,completed,report:output+'/recovery.private.json'}));
 }
}
verify().catch(e=>{console.error(JSON.stringify({failed:true,step,name:e.name,actual:typeof e.actual==='number'?e.actual:undefined,expected:typeof e.expected==='number'?e.expected:undefined,location:e.stack?.split('\n').find(l=>l.includes('verify-phone-change-cloud.mjs:'))}));process.exitCode=1;});
