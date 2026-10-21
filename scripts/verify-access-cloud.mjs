/** Explicit operator-only live test. No emails; own temporary identities are removed in finally. */
import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';
import { readFileSync,writeFileSync,chmodSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { ecoConnections } from '../config/ecoConnections.ts';
async function verify() {
if (!process.argv.includes('--allow-cloud-mutations')) throw new Error('Explicit --allow-cloud-mutations is required: this test creates and removes its own disposable ECO accounts.');
const ref=ecoConnections.supabaseProjectRef,base=process.env.ECO_VERIFY_ORIGIN??'http://127.0.0.1:4173';
const origin=new URL(base);
if (origin.origin!==base || !([ecoConnections.productionOrigin,'http://127.0.0.1:4173','http://127.0.0.1:4183'].includes(base) || (origin.protocol==='https:' && /^[a-z0-9-]+\.vercel\.app$/.test(origin.hostname)))) throw new Error('Unapproved verification origin.');
const keys=JSON.parse(readFileSync('output/access/eco-api-keys.private.json','utf8'));
const admin=createClient(`https://${ref}.supabase.co`,keys.find(k=>k.type==='secret').api_key,{auth:{persistSession:false,autoRefreshToken:false}});
const cli=args=>execFileSync('pnpm',['dlx','--allow-build=supabase','supabase@2.120.0',...args],{encoding:'utf8',timeout:60000,stdio:['ignore','pipe','pipe']});
const operator=JSON.parse(cli(['whoami','--output-format','json']));assert.equal(operator.username,'hocheunglai-oss');
const project=JSON.parse(cli(['projects','list','--output','json'])).find(p=>p.id===ref);
assert.equal(project.organization_id,ecoConnections.supabaseOrganizationId);assert.equal(project.region,ecoConnections.supabaseRegion);assert.equal(project.name,'ECO');
const sql=text=>{const file='output/access/verification.private.sql';writeFileSync(file,text,{mode:0o600});chmodSync(file,0o600);return cli(['db','query','--linked','--project-ref',ref,'--file',file,'--output','json']);};
const quote=s=>"'"+s.replaceAll("'","''")+"'";
if (base.includes('.vercel.app')) {const deployment=JSON.parse(execFileSync('pnpm',['dlx','vercel@63.1.2','inspect',base,'--json','--scope',ecoConnections.vercel.teamId],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));assert.equal(deployment.name,ecoConnections.vercel.projectName);assert.ok(deployment.builds.some(b=>b.output.some(o=>o.digest?.startsWith(ecoConnections.vercel.projectId+'/'))));}
const runId=randomBytes(6).toString('hex'),ids=[];
const password='ECO verification 9 '+randomBytes(20).toString('base64url');
const credentials=[];
let browser;
const protectionCookies=base.includes('.vercel.app')?readFileSync('output/access/staging-cookies.private.txt','utf8').split('\n').filter(l=>l.includes('\t')).map(l=>{const fields=l.replace(/^#HttpOnly_/, '').split('\t');return {name:fields[5],value:fields[6],domain:new URL(base).hostname,path:fields[2],secure:fields[3]==='TRUE',httpOnly:l.startsWith('#HttpOnly_'),expires:Number(fields[4])};}):[];
try {
 for(const role of ['admin','trader']) {
  const email=`eco-verification-${runId}-${role}@example.com`;
  const made=await admin.auth.admin.createUser({email,email_confirm:false,app_metadata:{eco_verification:runId}});
  assert.equal(made.error,null);const id=made.data.user.id;ids.push(id);
  writeFileSync('output/access/verification-identities.private.json',JSON.stringify({runId,ids}),{mode:0o600});
  const profile={displayName:`ECO VERIFY ${role.toUpperCase()}`,officeId:'HONG KONG',isAdmin:role==='admin',isSpcTrader:false,isActive:true,sourceSpcId:crypto.randomUUID()};
  sql(`select eco_private.provision_user(${quote(id)}::uuid,${quote(JSON.stringify(profile))}::jsonb);`);
  const link=await admin.auth.admin.generateLink({type:'invite',email});assert.equal(link.error,null);
  credentials.push({id,email,hash:link.data.properties.hashed_token});
 }
 browser=await chromium.launch({headless:true});
 const ctx=await browser.newContext({viewport:{width:1440,height:1000}});await ctx.addCookies(protectionCookies);const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 async function post(context,path,body){return context.request.post(base+'/api/access/'+path,{headers:{origin:base,'x-eco-request':'1'},data:body});}
 await page.goto(base);await page.getByLabel('Password',{exact:true}).waitFor();
 assert.equal((await ctx.request.get(base+'/api/access/session')).status(),401);
 await page.goto(base+'/#token_hash='+credentials[0].hash+'&type=invite');await page.reload();
 await page.getByLabel('New password',{exact:true}).fill(password);await page.getByLabel('Confirm password',{exact:true}).fill(password);
 await page.getByRole('button',{name:'Set password',exact:true}).click();
 await page.getByRole('main',{name:'ECOSYSTEM workspace'}).waitFor({timeout:30000});console.log('Cloud activation and browser entry passed.');
 const cookies=await ctx.cookies();assert.ok(cookies.some(c=>c.name.startsWith('eco-auth')&&c.httpOnly&&c.sameSite==='Strict'));
 const probe=createClient(`https://${ref}.supabase.co`,keys.find(k=>k.type==='publishable').api_key,{auth:{persistSession:false,autoRefreshToken:false}});const probeResult=await probe.auth.signInWithPassword({email:credentials[0].email,password});assert.equal(probeResult.error,null);await probe.auth.signOut({scope:'local'});
 let response=await ctx.request.get(base+'/api/access/users');assert.equal(response.status(),200);
 const directory=await response.json();assert.ok(credentials.every(account=>directory.users.some(user=>user.id===account.id)));assert.ok(directory.offices.length>0);const trader=directory.users.find(u=>u.id===credentials[1].id);
 await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Users & Access',exact:true}).waitFor();
 await page.screenshot({path:'output/access/cloud-users-access.png'});
 const other=await browser.newContext();await other.addCookies(protectionCookies);
 response=await post(other,'activate',{tokenHash:credentials[1].hash,type:'invite',password});assert.equal(response.status(),200);
 response=await other.request.get(base+'/api/access/users');assert.equal(response.status(),403);
 const patch={...trader,expectedRevision:trader.revision+1,isManager:true}; // activation increments the revision
 response=await post(ctx,'users',patch);assert.equal(response.status(),200);
 response=await other.request.get(base+'/api/access/session');assert.equal(response.status(),401);
 const conflictStarted=Date.now();response=await post(ctx,'users',patch);assert.equal(response.status(),409);assert.ok(Date.now()-conflictStarted<10000);console.log('Cloud access revocation and prompt conflict response passed.');
 response=await post(other,'login',{email:credentials[1].email,password});assert.equal(response.status(),200);assert.equal((await response.json()).user.isManager,true);
 // An existing login cannot be replaced by an activation response. Once signed
 // out, the consumed token must independently remain unusable.
 response=await post(other,'activate',{tokenHash:credentials[1].hash,type:'invite',password});assert.equal(response.status(),409);
 response=await post(other,'logout',{});assert.equal(response.status(),200);
 response=await other.request.get(base+'/api/access/session');assert.equal(response.status(),401);
 response=await post(other,'activate',{tokenHash:credentials[1].hash,type:'invite',password});assert.equal(response.status(),401);
 const recovery=await admin.auth.admin.generateLink({type:'recovery',email:credentials[1].email});assert.equal(recovery.error,null);
 const newPassword=password+' reset';
 response=await post(other,'activate',{tokenHash:recovery.data.properties.hashed_token,type:'recovery',password:newPassword});assert.equal(response.status(),200);
 await post(other,'logout',{});
 response=await post(other,'login',{email:credentials[1].email,password});assert.equal(response.status(),401);
 response=await post(other,'login',{email:credentials[1].email,password:newPassword});assert.equal(response.status(),200);
 // Simulate initial operator credentials on our disposable member, never on a real user's record.
 sql(`update eco_private.users set password_prompt_dismissed_at=null where id=${quote(credentials[1].id)}::uuid;`);
 response=await other.request.get(base+'/api/access/session');assert.equal((await response.json()).user.passwordChangeSuggested,true);
 const traderPage=await other.newPage();await traderPage.goto(base);
 const skippedResponse=traderPage.waitForResponse(r=>r.url()===base+'/api/access/password-prompt'&&r.request().method()==='POST');
 await traderPage.getByRole('button',{name:'Skip',exact:true}).click();
 assert.equal((await skippedResponse).status(),200);
 await traderPage.getByRole('complementary',{name:'Change password invitation'}).waitFor({state:'hidden'});
 response=await other.request.get(base+'/api/access/session');let member=(await response.json()).user;
 assert.equal(member.passwordChangeSuggested,false);assert.equal(member.isAdmin,false);assert.equal(member.isManager,true);
 console.log('Optional password prompt can be skipped without changing access.');
 await traderPage.getByRole('button',{name:'Settings',exact:true}).click();
 assert.equal(await traderPage.getByRole('button',{name:'Users & Access',exact:true}).count(),0);
 await traderPage.getByRole('button',{name:'Change password',exact:true}).first().click();
 await traderPage.getByLabel('Current password',{exact:true}).waitFor();
 const peer=await browser.newContext();await peer.addCookies(protectionCookies);
 response=await post(peer,'login',{email:credentials[1].email,password:newPassword});assert.equal(response.status(),200);
 response=await post(other,'password',{currentPassword:'WrongCurrent9',newPassword:'NewValidPass9'});assert.equal(response.status(),400);
 for(const invalid of ['short9A','alllowercase9','ALLUPPERCASE9','NoNumberHere']) {
  response=await post(other,'password',{currentPassword:newPassword,newPassword:invalid});assert.equal(response.status(),400);
 }
 const chosenPassword='Chosen9x'+randomBytes(14).toString('hex');
 await traderPage.getByLabel('Current password',{exact:true}).fill(newPassword);
 await traderPage.getByLabel('New password',{exact:true}).fill(chosenPassword);
 await traderPage.getByLabel('Confirm password',{exact:true}).fill(chosenPassword);
 await traderPage.getByRole('button',{name:'Change password',exact:true}).last().click();
 await traderPage.getByText('Password changed.',{exact:true}).waitFor({timeout:30000});
 response=await peer.request.get(base+'/api/access/session');assert.equal(response.status(),401);
 response=await other.request.get(base+'/api/access/session');assert.equal(response.status(),200);
 console.log('Password change accepted and other sessions rejected.');
 await post(other,'logout',{});
 response=await post(other,'login',{email:credentials[1].email,password:newPassword});assert.equal(response.status(),401);
 response=await post(other,'login',{email:credentials[1].email,password:chosenPassword});assert.equal(response.status(),200);
 // A real persistent browser profile must retain login after its browser process closes.
 const profileDirectory=mkdtempSync(join(tmpdir(),'eco-login-persistence-'));
 let persistent;
 try {
  persistent=await chromium.launchPersistentContext(profileDirectory,{headless:true});await persistent.addCookies(protectionCookies);
  response=await post(persistent,'login',{email:credentials[1].email,password:chosenPassword});assert.equal(response.status(),200);
  const saved=(await persistent.cookies()).filter(c=>c.name.startsWith('eco-auth'));
  assert.ok(saved.length>0&&saved.every(c=>c.httpOnly&&c.expires>Date.now()/1000+365*86400));
  await persistent.close();persistent=await chromium.launchPersistentContext(profileDirectory,{headless:true});
  response=await persistent.request.get(base+'/api/access/session');assert.equal(response.status(),200);
  response=await post(persistent,'logout',{});assert.equal(response.status(),200);
  response=await persistent.request.get(base+'/api/access/session');assert.equal(response.status(),401);
  console.log('Browser restart retains login; manual logout removes access.');
 } finally {if(persistent)await persistent.close();rmSync(profileDirectory,{recursive:true,force:true});}
 await peer.close();
 await post(other,'logout',{});await post(ctx,'logout',{});await other.close();await ctx.close();
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({realCloud:true,activation:true,passwordSignIn:true,adminDirectory:true,traderDenied:true,permissionRevocation:true,revisionConflict:true,linkReplayDenied:true,logout:true,recovery:true,optionalPrompt:true,passwordChange:true,otherSessionsRevoked:true,oldPasswordDenied:true,browserRestartPersistence:true,browserErrors:0,emailsSent:0}));
} finally {
 if(browser)await browser.close();
 if(ids.length){sql(`begin;delete from eco_private.admin_operations where actor_id in (${ids.map(quote).join(',')}) or target_id in (${ids.map(quote).join(',')});delete from eco_private.revoked_sessions where user_id in (${ids.map(quote).join(',')});delete from eco_private.users where id in (${ids.map(quote).join(',')});commit;`);for(const id of ids){const result=await admin.auth.admin.deleteUser(id);assert.equal(result.error,null);}console.log(JSON.stringify({verificationIdentitiesRemoved:ids.length}));}
}

}
verify().catch(error=>{ console.error(JSON.stringify({verificationFailed:true,errorType:error?.name??'Error',
  actual:typeof error?.actual==='number'||typeof error?.actual==='boolean'?error.actual:undefined,
  expected:typeof error?.expected==='number'||typeof error?.expected==='boolean'?error.expected:undefined,
  location:error?.stack?.split('\n').find(line=>line.includes('verify-access-cloud.mjs:'))?.trim()}));process.exitCode=1; });
