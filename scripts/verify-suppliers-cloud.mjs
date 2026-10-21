import { hostedMigrationHistory, assertHostedMigrationHistory } from './hosted-migration-history.mjs';
/** Explicit operator verification: synthetic identities/supplier only, ownership-checked cleanup in finally. */
import {chromium,expect as baseExpect} from '@playwright/test';
// Live provider requests can outlast Playwright's 5-second mock-test default.
const expect=baseExpect.configure({timeout:30000});
import {createClient} from '@supabase/supabase-js';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,chmodSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {ecoConnections as target} from '../config/ecoConnections.ts';
import {installStagingCookies} from '../tests/fixtures/protection-cookies.mjs';
import {storageMissing} from './suppliers/publish-reports.mjs';
import {sourceFingerprint,migrationFingerprint} from './generate-system-information.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const runId=randomBytes(8).toString('hex'),prefix=`ECO SUPPLIER CHECK ${runId.toUpperCase()}`,output=root+'output/suppliers-cloud/'+runId;
const quote=v=>"'"+String(v).replaceAll("'","''")+"'";
const run=args=>execFileSync('pnpm',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:90000,maxBuffer:4*1024*1024});
const sb=args=>run(['dlx','--allow-build=supabase','supabase@2.120.0',...args]);
const vc=args=>run(['dlx','vercel@63.1.2',...args]);
const privateWrite=(path,data)=>{writeFileSync(path,data,{mode:0o600});chmodSync(path,0o600);};
let step='preflight',base,browser,service,identities=[],contexts=[],supplierId=randomUUID(),batchId=randomUUID(),completed=false,cleaned=false,browserPage,failedStep,failureEvidence;
const sourceKey='verification:'+runId,legacyId='verification-legacy:'+runId;
const createRequestId=randomUUID(),reportId=randomUUID(),reportBytes=Buffer.from('%PDF-1.4\n% ECO SYNTHETIC '+runId+'\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'),reportHash=createHash('sha256').update(reportBytes).digest('hex'),reportPath=supplierId+'/'+reportId+'/'+reportHash+'.pdf';
let createdSupplierId=null;
const save=()=>privateWrite(output+'/recovery.private.json',JSON.stringify({runId,step,base,identities,supplierId,batchId,sourceKey,legacyId,completed,cleaned,failedStep,failureEvidence,createRequestId,createdSupplierId,reportId,reportPath,reportHash},null,2));
const mark=value=>{step=value;save();console.log(JSON.stringify({step}));};
// Diagnostic output never includes raw CLI command errors, request headers, credentials or cookies.
function safeDiagnostic(error){
 const message=String(error?.message??'').replace(/\u001b\[[0-9;]*m/g,'');
 const permitted=error?.name==='AssertionError'||message.startsWith('expect(')||error?.name==='TimeoutError';
 const summary=permitted?message.split('Call log:')[0].split('Call log\n')[0]:'Operation failed; inspect the recorded stage and source location.';
 const safe=summary.replace(/\u001b\[[0-9;]*m/g,'').replace(/(?:sb_secret_|sb_publishable_|eyJ|EcoSupplier9-)[A-Za-z0-9._-]+/g,'[REDACTED]')
  .replace(/(?:authorization|cookie|set-cookie|password|access_token|refresh_token)[^\n]*/gi,'[REDACTED]')
  .replace(/https?:\/\/[^\s'"<>]+/g,value=>{try{const url=new URL(value);return url.origin+url.pathname;}catch{return '[URL]';}}).slice(0,500);
 return {name:error?.name,code:error?.code,signal:error?.signal,exitStatus:error?.status,message:safe,apiStatus:error?.apiStatus,apiPath:error?.apiPath,actual:typeof error?.actual==='number'?error.actual:undefined,expected:typeof error?.expected==='number'?error.expected:undefined,location:error?.stack?.split('\n').filter(line=>line.includes('verify-suppliers-cloud.mjs:')).slice(0,3)};
}
const rows=sql=>{privateWrite(output+'/query.private.sql',sql);const r=JSON.parse(sb(['db','query','--linked','--project-ref',target.supabaseProjectRef,'--file',output+'/query.private.sql','--output','json']));return Array.isArray(r)?r:r.rows;};
const post=(ctx,path,data,extra={})=>ctx.request.post(base+path,{headers:{origin:base,'x-eco-request':'1',...extra},data,timeout:45000});
const get=(ctx,path)=>ctx.request.get(base+path,{timeout:45000});
async function okJson(response){
 if(response.status()!==200){const body=await response.json().catch(()=>({}));throw Object.assign(new Error('Supplier API check failed.'),{name:'SupplierApiCheckError',apiStatus:response.status(),apiPath:new URL(response.url()).pathname,apiMessage:typeof body.message==='string'?body.message.slice(0,160):undefined});}
 return response.json();
}
async function verify(){
 assert.ok(process.argv.includes('--allow-cloud-mutations'),'Disposable cloud fixtures require explicit operator flag.');
 base=process.env.ECO_VERIFY_ORIGIN;assert.ok(base&&new URL(base).origin===base&&new URL(base).protocol==='https:');
 assert.ok(base===target.productionOrigin||/^[a-z0-9-]+\.vercel\.app$/.test(new URL(base).hostname));
 assert.equal(JSON.parse(sb(['whoami','--output-format','json'])).username,'hocheunglai-oss');
 const project=JSON.parse(sb(['projects','list','--output','json'])).find(p=>p.id===target.supabaseProjectRef);
 assert.equal(project?.organization_id,target.supabaseOrganizationId);assert.equal(project?.region,target.supabaseRegion);assert.equal(project?.name,'ECO');assert.equal(project?.status,'ACTIVE_HEALTHY');
 const deployment=JSON.parse(vc(['inspect',base,'--json','--scope',target.vercel.teamId]));
 assert.equal(deployment.readyState,'READY');assert.equal(deployment.name,target.vercel.projectName);assert.ok(deployment.builds?.some(b=>b.output?.some(o=>o.digest?.startsWith(target.vercel.projectId+'/'))));
 if(process.env.ECO_VERIFY_DEPLOYMENT_ID)assert.equal(deployment.id,process.env.ECO_VERIFY_DEPLOYMENT_ID);
 mkdirSync(output,{recursive:true,mode:0o700});save();
 const expectedHistory=await hostedMigrationHistory(root);assertHostedMigrationHistory(rows('select version from supabase_migrations.schema_migrations order by version').map(row=>row.version),expectedHistory);
 const privilege=rows("select has_function_privilege('authenticated','public.eco_import_suppliers(jsonb)','EXECUTE') as import_allowed,has_function_privilege('authenticated','public.eco_enrich_supplier(jsonb)','EXECUTE') as enrich_allowed,has_function_privilege('anon','public.eco_list_suppliers(jsonb)','EXECUTE') as anonymous_allowed")[0];assert.equal(privilege.import_allowed,false);assert.equal(privilege.enrich_allowed,false);assert.equal(privilege.anonymous_allowed,false);
 const keys=JSON.parse(readFileSync(root+'output/access/eco-api-keys.private.json','utf8'));
 service=createClient(`https://${target.supabaseProjectRef}.supabase.co`,keys.find(k=>k.type==='secret').api_key,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(20000)})}});
 const bucket=await service.storage.getBucket(target.supplierReportsBucket);assert.ifError(bucket.error);assert.equal(bucket.data.public,false,'Report bucket must already exist and remain private.');
 try{
  mark('create-disposable-identities');const office=rows("select id,name from eco_private.offices where upper(name)<>'CREDIT' order by name limit 1")[0];assert.ok(office);browser=await chromium.launch({headless:true});
  for(const role of ['admin','trader','spc']){
   const id=randomUUID(),email=`eco-supplier-check-${runId}-${role}@example.com`,password='EcoSupplier9-'+randomBytes(20).toString('base64url');identities.push({id,email});save();
   const created=await service.auth.admin.createUser({id,email,password,email_confirm:true,app_metadata:{eco_verification:runId}});assert.ifError(created.error);assert.equal(created.data.user.id,id);
   const profile={displayName:`${prefix} ${role.toUpperCase()}`,officeId:office.id,isAdmin:role==='admin',isActive:true,isManager:false,isSpcTrader:role==='spc',sourceSpcId:randomUUID()};
   rows(`begin;select eco_private.provision_user(${quote(id)}::uuid,${quote(JSON.stringify(profile))}::jsonb);update eco_private.users set activated_at=now(),password_prompt_dismissed_at=now() where id=${quote(id)}::uuid;commit;`);
   const context=await browser.newContext();await installStagingCookies(context,base);contexts.push(context);assert.equal((await okJson(await post(context,'/api/access/login',{email,password}))).user.id,id);
  }
  const [admin,ordinary,trader]=contexts;const anonymous=await browser.newContext();await installStagingCookies(anonymous,base);contexts.push(anonymous);
  mark('verify-deployed-source');
  const system=await okJson(await get(admin,'/api/admin/system-information'));
  const localSource=await sourceFingerprint(root),localMigrations=await migrationFingerprint(root);
  // Save the safe provider/build evidence before assertions so a mismatched deployment remains diagnosable.
  const buildEvidence={releaseId:system.build.releaseId,sourceSha256:system.build.sourceSha256,sourceFileCount:system.build.sourceFileCount,
   lockfileSha256:system.build.lockfileSha256,builtAt:system.build.builtAt,buildNode:system.build.buildNode,requiredNode:system.build.requiredNode,
   gitCommit:system.build.gitCommit,gitWorktree:system.build.gitWorktree,bundledMigrationHead:system.migrations.bundledHead,migrationCount:system.migrations.count,migrationSha256:system.migrations.sha256,
   databaseProjectRef:system.targets.databaseProjectRef,databaseRegion:system.targets.databaseRegion,
   runtime:{node:system.runtime?.node,requiredNode:system.runtime?.requiredNode,environment:system.runtime?.environment,deploymentId:system.runtime?.deploymentId,region:system.runtime?.region},
   local:{sourceSha256:localSource.sha256,sourceFileCount:localSource.count,migrationSha256:localMigrations.sha256,bundledMigrationHead:localMigrations.bundledHead,node:process.version}};
  privateWrite(output+'/build-evidence.json',JSON.stringify(buildEvidence,null,2));
  assert.equal(system.targets.databaseProjectRef,target.supabaseProjectRef);assert.equal(system.targets.databaseRegion,target.supabaseRegion);
  assert.equal(system.migrations.bundledHead,localMigrations.bundledHead);assert.equal(system.migrations.sha256,localMigrations.sha256);
  assert.equal(system.build.sourceSha256,localSource.sha256,'Staged source fingerprint must match the current verified source.');
  if(process.env.ECO_VERIFY_COMMIT){assert.match(process.env.ECO_VERIFY_COMMIT,/^[a-f0-9]{40}$/i);assert.equal(system.build.gitCommit,process.env.ECO_VERIFY_COMMIT.toLowerCase(),'Staged Git commit must match the requested candidate.');}
  mark('import-owned-supplier');
  const fixture={id:supplierId,legacyIds:[legacyId],sourceKey,legalName:prefix+' PTE LTD',shortName:prefix,aliases:[],countryCode:'SG',countryName:'Singapore',portName:'Singapore',nameStatus:'needs-review',legalNameSourceId:null,info:{paymentTerms:'SYNTHETIC TERMS',qualityClaimBar:'SYNTHETIC CLAIM',supplierTrader:'FIXTURE',availableGrade:'VLSFO',foBdn:'',goBdn:''},contacts:[{id:'contact-'+runId,role:'sales',name:'SYNTHETIC PRIVATE CONTACT '+runId,phone:'+6590000000',email:'synthetic@example.com',sourceId:'fixture'}],barges:[],facts:[{label:'Verification',value:'Synthetic fixture only',sourceId:'fixture'}],sources:[{id:'fixture',type:'spc',title:prefix,url:'',documentDate:'',retrievedAt:new Date().toISOString()},{id:'report-'+runId,type:'infospectrum',title:prefix+' REPORT',url:'',documentDate:'2026-10-15',retrievedAt:new Date().toISOString()}]};
  const input={requestId:batchId,operatorId:identities[0].id,sourceHash:createHash('sha256').update(JSON.stringify([fixture])).digest('hex'),records:[fixture]};
  const imported=await service.rpc('eco_import_suppliers',{p_input:input});assert.ifError(imported.error);assert.equal(imported.data.inserted,1);assert.equal(imported.data.items[0].id,supplierId);
  const replay=await service.rpc('eco_import_suppliers',{p_input:input});assert.ifError(replay.error);assert.deepEqual(replay.data,imported.data);
  mark('authenticated-list-detail-and-boundaries');
  for(const path of ['/api/suppliers/list','/api/suppliers/detail?id='+supplierId]){const r=await get(anonymous,path);assert.equal(r.status(),401);assert.match(r.headers()['cache-control'],/no-store/);}
  const query='/api/suppliers/list?country=SG&search='+encodeURIComponent(prefix);const list=await okJson(await get(trader,query));assert.equal(list.total,1);assert.equal(list.items[0].id,supplierId);assert.equal(list.items[0].contacts,undefined);assert.equal(list.items[0].contactCount,1);
  const detail=(await okJson(await get(trader,'/api/suppliers/detail?id='+supplierId))).item;assert.equal(detail.contacts[0].name,fixture.contacts[0].name);assert.equal((await okJson(await get(admin,'/api/suppliers/detail?id='+encodeURIComponent(legacyId)))).item.id,supplierId);
  const update={requestId:randomUUID(),id:supplierId,revision:detail.revision,info:{...detail.info,paymentTerms:'SYNTHETIC UPDATED TERMS'},contacts:detail.contacts,barges:detail.barges};
  assert.equal((await post(anonymous,'/api/suppliers/update',update)).status(),401);assert.equal((await post(trader,'/api/suppliers/update',update,{origin:'https://untrusted.example'})).status(),403);assert.equal((await post(trader,'/api/suppliers/update',{...update,facts:[]})).status(),400);
  assert.equal((await post(ordinary,'/api/suppliers/update',update)).status(),403);assert.equal((await post(ordinary,'/api/suppliers/archive',{requestId:randomUUID(),id:supplierId,revision:1})).status(),403);
  mark('shared-edits-revision-and-idempotency');
  const saved=(await okJson(await post(trader,'/api/suppliers/update',update))).item;assert.equal(saved.revision,2);assert.equal(saved.legalName,fixture.legalName);assert.equal(saved.info.paymentTerms,update.info.paymentTerms);
  assert.deepEqual((await okJson(await post(trader,'/api/suppliers/update',update))).item,saved);assert.equal((await post(trader,'/api/suppliers/update',{...update,info:{...update.info,paymentTerms:'CONFLICT'}})).status(),409);
  assert.equal((await post(admin,'/api/suppliers/update',{...update,requestId:randomUUID()})).status(),409);
  const otherClient=(await okJson(await get(admin,'/api/suppliers/detail?id='+supplierId))).item;assert.equal(otherClient.revision,2);assert.equal(otherClient.info.paymentTerms,update.info.paymentTerms);
  const contactUpdate={...update,requestId:randomUUID(),revision:2,contacts:[{...detail.contacts[0],name:'SYNTHETIC CORRECTED CONTACT '+runId,sourceId:'FORGED'}]};const contactSaved=(await okJson(await post(admin,'/api/suppliers/update',contactUpdate))).item;assert.equal(contactSaved.revision,3);assert.equal(contactSaved.contacts[0].sourceId,'eco-update:'+contactUpdate.requestId);assert.equal(contactSaved.facts[0].sourceId,'fixture');
  mark('server-publication-and-audit-privacy');
  const publicationQuery='/api/admin/imports?status=published&search='+encodeURIComponent(prefix);const publications=await okJson(await get(admin,publicationQuery));assert.equal(publications.items.length,1);assert.equal(publications.items[0].id,batchId);assert.equal(publications.items[0].provenance,'server-published');assert.equal(publications.items[0].warningCount,1);assert.doesNotMatch(JSON.stringify(publications),/synthetic@example|PRIVATE CONTACT|source_records|sourceHash/);
  assert.equal((await okJson(await get(trader,publicationQuery))).items.length,0);
  const audit=await okJson(await get(admin,'/api/admin/audit?search='+supplierId));assert.equal(audit.items.filter(x=>x.action==='supplier-updated').length,2);assert.doesNotMatch(JSON.stringify(audit),/PRIVATE CONTACT|CORRECTED CONTACT|synthetic@example/);
  mark('private-tabs-owner-isolation-and-shared-authority');
  const profileTarget={kind:'supplier',id:supplierId},tabPath='/api/profile-tabs/list?kind=supplier&id='+supplierId;
  assert.equal((await get(anonymous,tabPath)).status(),401);
  const privateInput={requestId:randomUUID(),target:profileTarget,visibility:'private',revision:0,tabs:[{id:randomUUID(),title:'PRIVATE '+runId,visibility:'private',content:'OWNER ONLY '+runId}]};
  const privateSaved=await okJson(await post(ordinary,'/api/profile-tabs/save',privateInput));assert.equal(privateSaved.private.revision,1);assert.deepEqual(await okJson(await post(ordinary,'/api/profile-tabs/save',privateInput)),privateSaved);
  for(const context of [admin,trader]){const other=await okJson(await get(context,tabPath));assert.deepEqual(other.private,{revision:0,tabs:[]});assert.ok(!JSON.stringify(other).includes('OWNER ONLY'));}
  assert.equal((await post(admin,'/api/profile-tabs/save',{...privateInput,requestId:randomUUID(),visibility:'shared',tabs:[{...privateInput.tabs[0],visibility:'shared'}]})).status(),400);
  const sharedInput={requestId:randomUUID(),target:profileTarget,visibility:'shared',revision:0,tabs:[{id:'builtin:information',title:'SUPPLIER INFORMATION',visibility:'shared',builtin:'information'},{id:'builtin:contacts',title:'CONTACTS',visibility:'shared',builtin:'contacts'},{id:'builtin:barges',title:'BARGE FLEET',visibility:'shared',builtin:'barges'},{id:'builtin:sources',title:'SOURCES',visibility:'shared',builtin:'sources'},{id:randomUUID(),title:'SHARED FIXTURE',visibility:'shared',content:'SHARED '+runId}]};
  assert.equal((await post(ordinary,'/api/profile-tabs/save',sharedInput)).status(),403);const sharedSaved=await okJson(await post(trader,'/api/profile-tabs/save',sharedInput));assert.equal(sharedSaved.shared.revision,1);assert.equal((await okJson(await get(admin,tabPath))).shared.tabs.length,5);
  assert.equal((await post(trader,'/api/profile-tabs/save',{...sharedInput,requestId:randomUUID()})).status(),409);
  const reorder={requestId:randomUUID(),target:profileTarget,visibility:'shared',revision:1,ids:sharedInput.tabs.map(t=>t.id).reverse()};assert.deepEqual((await okJson(await post(admin,'/api/profile-tabs/reorder',reorder))).shared.tabs.map(t=>t.id),reorder.ids);
  const deletion={requestId:randomUUID(),target:profileTarget,visibility:'shared',revision:2,id:sharedInput.tabs.at(-1).id};assert.equal((await okJson(await post(admin,'/api/profile-tabs/delete',deletion))).shared.tabs.length,4);
  const ownerAdminInput={...privateInput,requestId:randomUUID(),tabs:[{id:randomUUID(),title:'ADMIN PRIVATE '+runId,visibility:'private',content:'ADMIN OWNER ONLY '+runId}]};await okJson(await post(admin,'/api/profile-tabs/save',ownerAdminInput));
  assert.equal((await post(admin,'/api/access/preview',{role:'admin',officeId:office.id})).status(),200);assert.deepEqual((await okJson(await get(admin,tabPath))).private,{revision:0,tabs:[]});assert.equal((await post(admin,'/api/profile-tabs/save',{...ownerAdminInput,requestId:randomUUID(),revision:1,tabs:[]})).status(),403);await okJson(await post(admin,'/api/access/preview/end',{}));
  const privateAudit=await okJson(await get(admin,'/api/admin/audit?search='+supplierId));assert.ok(!JSON.stringify(privateAudit).includes('OWNER ONLY'));assert.ok(!JSON.stringify(privateAudit).includes('ADMIN PRIVATE'));
  mark('spc-create-and-recoverable-archive');
  const createInput={requestId:createRequestId,legalName:prefix+' ADDITIONAL PTE LTD',shortName:prefix+' ADDITIONAL',countryCode:'SG',countryName:'Singapore',portName:'Singapore',background:'SYNTHETIC BACKGROUND',info:fixture.info,contacts:[],barges:[]};save();
  assert.equal((await post(ordinary,'/api/suppliers/create',createInput)).status(),403);const created=(await okJson(await post(trader,'/api/suppliers/create',createInput))).item;createdSupplierId=created.id;save();assert.equal(created.background,createInput.background);assert.equal(created.nameStatus,'needs-review');assert.deepEqual((await okJson(await post(trader,'/api/suppliers/create',createInput))).item,created);
  const archiveInput={requestId:randomUUID(),id:createdSupplierId,revision:1};const archived=await okJson(await post(trader,'/api/suppliers/archive',archiveInput));assert.equal(archived.revision,2);assert.deepEqual(await okJson(await post(trader,'/api/suppliers/archive',archiveInput)),archived);assert.equal((await get(admin,'/api/suppliers/detail?id='+createdSupplierId)).status(),404);
  assert.equal(rows(`select count(*)::int as count from eco_private.supplier_revisions where supplier_id=${quote(createdSupplierId)}::uuid`)[0].count,2);
  mark('private-report-storage-and-authenticated-download');
  const uploaded=await service.storage.from(target.supplierReportsBucket).upload(reportPath,reportBytes,{contentType:'application/pdf',upsert:false});assert.ifError(uploaded.error);
  const reportInput={id:reportId,operatorId:identities[2].id,supplierId,sourceId:'report-'+runId,fileName:prefix+' REPORT.pdf',objectPath:reportPath,sha256:reportHash,size:reportBytes.length,documentDate:'2026-10-15'};
  assert.ok((await service.rpc('eco_register_supplier_report',{p_input:{...reportInput,operatorId:identities[1].id}})).error,'Ordinary trader cannot publish report metadata');
  const registered=await service.rpc('eco_register_supplier_report',{p_input:reportInput});assert.ifError(registered.error);assert.equal(registered.data.id,reportId);
  const reportListPath='/api/supplier-reports/list?supplierId='+supplierId;assert.equal((await get(anonymous,reportListPath)).status(),401);assert.equal((await post(anonymous,'/api/supplier-reports/download',{id:reportId})).status(),401);
  const reportList=await okJson(await get(ordinary,reportListPath));assert.equal(reportList.items.length,1);assert.equal(reportList.items[0].sha256,reportHash);assert.equal(reportList.items[0].objectPath,undefined);
  const signed=await okJson(await post(ordinary,'/api/supplier-reports/download',{id:reportId}));assert.equal(new URL(signed.url).origin,`https://${target.supabaseProjectRef}.supabase.co`);assert.ok(Date.parse(signed.expiresAt)-Date.now()<=61000);
  const downloaded=await ordinary.request.get(signed.url);assert.equal(downloaded.status(),200);assert.equal(createHash('sha256').update(await downloaded.body()).digest('hex'),reportHash);
  const publicAttempt=await anonymous.request.get(`https://${target.supabaseProjectRef}.supabase.co/storage/v1/object/public/${target.supplierReportsBucket}/${reportPath}`);assert.notEqual(publicAttempt.status(),200);
  await okJson(await post(trader,'/api/profile-tabs/reorder',{requestId:randomUUID(),target:profileTarget,visibility:'shared',revision:3,ids:sharedInput.tabs.slice(0,4).map(t=>t.id)}));
  mark('browser-supplier-edit-and-shared-profile');
  await trader.addInitScript(()=>localStorage.setItem('ecosystem.theme.v1','light'));
  const page=await trader.newPage(),pageErrors=[];browserPage=page;page.setDefaultTimeout(30000);page.on('pageerror',error=>pageErrors.push(error.message));await page.emulateMedia({reducedMotion:'reduce'});await page.setViewportSize({width:1440,height:1000});
  async function openWorkspace(){
   const nav=page.getByRole('navigation',{name:'Workspace navigation'}),group=nav.getByRole('button',{name:'Ports & Suppliers',exact:true});
   if(await group.getAttribute('aria-expanded')!=='true')await group.click();
   await expect(group).toHaveAttribute('aria-expanded','true');
   await nav.getByRole('button',{name:'Supplier Profiles',exact:true}).click();
   const workspace=page.getByRole('dialog',{name:'Supplier Profiles',exact:true});await expect(workspace).toBeVisible();return workspace;
  }
  async function enterSupplier(){await page.goto(base,{waitUntil:'domcontentloaded',timeout:45000});await page.getByRole('main',{name:'ECOSYSTEM workspace'}).waitFor();const workspace=await openWorkspace();await workspace.getByRole('button',{name:'Singapore only',exact:true}).click();await expect(workspace.getByRole('button',{name:'Singapore only',exact:true})).toHaveAttribute('aria-pressed','true');await workspace.getByLabel('Search suppliers',{exact:true}).fill(prefix);await expect(workspace.locator('tbody tr')).toHaveCount(1);await workspace.locator(`button[data-supplier-id="${supplierId}"]`).click();await expect(workspace.getByRole('heading',{name:fixture.legalName,exact:true})).toBeVisible();return workspace;}
  let workspace=await enterSupplier();await workspace.getByRole('button',{name:'Update',exact:true}).click();const browserTerms=('SYNTHETIC BROWSER TERMS '+runId).toUpperCase();await workspace.getByLabel('Payment terms',{exact:true}).fill(browserTerms);
  const uiResponse=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/suppliers/update'&&r.request().method()==='POST');await workspace.getByRole('button',{name:'Save changes',exact:true}).click();const uiSaved=(await okJson(await uiResponse)).item;assert.equal(uiSaved.id,supplierId);assert.equal(uiSaved.revision,4);assert.equal(uiSaved.info.paymentTerms,browserTerms);await expect(workspace.getByText('Supplier updated.',{exact:true})).toBeVisible();
  assert.equal((await okJson(await get(admin,'/api/suppliers/detail?id='+supplierId))).item.info.paymentTerms,browserTerms);
  const stored=rows(`select revision,record#>>'{info,paymentTerms}' as terms from eco_private.suppliers where id=${quote(supplierId)}::uuid and source_key=${quote(sourceKey)}`)[0];assert.equal(stored.revision,4);assert.equal(stored.terms,browserTerms);
  await workspace.getByRole('button',{name:'Supplier results',exact:true}).click();await workspace.getByRole('button',{name:'Close workspace',exact:true}).click();workspace=await openWorkspace();await workspace.getByLabel('Search suppliers',{exact:true}).fill(prefix);await expect(workspace.locator('tbody tr')).toHaveCount(1);await workspace.locator(`button[data-supplier-id="${supplierId}"]`).click();await expect(workspace.getByRole('heading',{name:fixture.legalName,exact:true})).toBeVisible();await expect(workspace.getByRole('tabpanel')).toContainText(browserTerms);await page.screenshot({path:output+'/browser-global-profile-reopened.png',fullPage:true});
  mark('browser-read-only-responsive-evidence');
  const responsive=[];
  // The hosted Chromium/WebKit matrix is a separate release gate. This optional
  // mode focuses the live cloud run on persistence and access, without repeating it.
  const responsiveCoveredBySeparateMatrix=process.argv.includes('--focus-cloud-flow');
  if(!responsiveCoveredBySeparateMatrix){
  await workspace.getByRole('button',{name:'Supplier results',exact:true}).click();
  if(await workspace.getByRole('button',{name:'Singapore only',exact:true}).getAttribute('aria-pressed')!=='true')await workspace.getByRole('button',{name:'Singapore only',exact:true}).click();
  await workspace.getByLabel('Search suppliers',{exact:true}).fill(prefix);
  await expect(workspace.locator('tbody tr')).toHaveCount(1);
  for(const width of [1440,320,390])for(const theme of ['light','dark']){
   await page.setViewportSize({width,height:1000});
   if(await page.locator('html').getAttribute('data-theme')!==theme)await workspace.getByRole('button',{name:theme==='dark'?'Dark mode':'Light mode',exact:true}).click();
   await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
   await workspace.locator(`button[data-supplier-id="${supplierId}"]`).click();
   await expect(workspace.getByRole('heading',{name:fixture.legalName,exact:true})).toBeVisible();
   await expect(workspace.getByRole('tabpanel')).toContainText(browserTerms);await page.screenshot({path:`${output}/browser-chromium-${width}-${theme}-profile.png`,fullPage:true});
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${width} ${theme}: viewport overflow`);
   const geometry=await workspace.locator('.shared-supplier-profile,.shared-supplier-profile-heading,.shared-supplier-section').evaluateAll(nodes=>nodes.filter(node=>node.getBoundingClientRect().height).map(node=>({x:node.getBoundingClientRect().x,right:node.getBoundingClientRect().right})));assert.ok(geometry.every(box=>box.x>=-1&&box.right<=width+1),`${width} ${theme}: clipped profile`);
   await workspace.getByRole('button',{name:'Supplier results',exact:true}).click();await expect(workspace.locator('tbody tr')).toHaveCount(1);await expect(workspace.locator('tbody tr')).toContainText(fixture.legalName);await page.screenshot({path:`${output}/browser-chromium-${width}-${theme}-directory.png`,fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${width} ${theme}: directory overflow`);responsive.push({engine:'chromium',width,theme,passed:true});
  }
  }
  assert.deepEqual(pageErrors,[]);assert.equal((await okJson(await get(admin,'/api/suppliers/detail?id='+supplierId))).item.revision,4,'Responsive checks must remain read only.');
  mark('preview-and-disabled-account-controls');
  assert.equal((await post(admin,'/api/access/preview',{role:'trader',officeId:office.id})).status(),200);assert.equal((await post(admin,'/api/suppliers/update',{...update,requestId:randomUUID(),revision:4})).status(),403);assert.equal((await okJson(await get(admin,publicationQuery))).items.length,0);assert.equal((await okJson(await get(admin,query))).total,1);assert.equal((await post(admin,'/api/access/preview/end',{})).status(),200);
  rows(`update eco_private.users set is_active=false where id=${quote(identities[2].id)}::uuid and email=${quote(identities[2].email)}`);
  assert.ok([401,403].includes((await get(trader,'/api/suppliers/detail?id='+supplierId)).status()));assert.ok([401,403].includes((await post(trader,'/api/suppliers/update',{...update,requestId:randomUUID(),revision:4})).status()));
  const snapshot=rows(`select revision,snapshot->>'shortName' as name from eco_private.supplier_revisions where supplier_id=${quote(supplierId)}::uuid order by revision`);assert.deepEqual(snapshot.map(x=>x.revision),[1,2,3,4]);assert.ok(snapshot.every(x=>x.name===prefix));
  completed=true;save();privateWrite(output+'/verification.json',JSON.stringify({runId,base,deploymentId:deployment.id,completed:true,authenticatedApi:true,crossClient:true,revisionConflict:true,idempotency:true,sourceAttribution:true,anonymousDenied:true,previewReadOnly:true,disabledDenied:true,publicationPrivate:true,audit:true,snapshots:true,browserUiEdit:true,browserGlobalProfile:true,ordinarySupplierWriteDenied:true,spcCreateArchive:true,privateOwnerIsolation:true,privatePreviewHidden:true,sharedTabsRevision:true,privateReportDownload:true,publicStorageDenied:true,responsive,responsiveCoveredBySeparateMatrix,build:buildEvidence},null,2));
 }catch(error){
  failedStep=step;failureEvidence=safeDiagnostic(error);
  if(browserPage&&!browserPage.isClosed()){
   try{await browserPage.screenshot({path:output+'/failure.png',fullPage:true,timeout:15000});failureEvidence.screenshot=output+'/failure.png';}catch{failureEvidence.screenshot='Unavailable';}
  }
  save();privateWrite(output+'/failure.private.json',JSON.stringify({runId,failedStep,...failureEvidence},null,2));throw error;
 }finally{
  for(const c of contexts)await post(c,'/api/access/logout',{}).catch(()=>{});
  // Browser teardown must not prevent cleanup of owned cloud fixtures.
  await browser?.close().catch(()=>{console.warn(JSON.stringify({step:'browser-close',warning:'Browser teardown failed; continuing owned-fixture cleanup.'}));});mark('cleanup-owned-fixtures');
  const candidates=rows(`select id,email,raw_app_meta_data->>'eco_verification' as marker from auth.users where email in (${identities.map(x=>quote(x.email)).join(',')||'null'})`);
  assert.ok(candidates.every(x=>x.marker===runId&&identities.some(i=>i.id===x.id&&i.email===x.email)),'Fixture ownership mismatch: no cleanup performed.');
  const supplier=rows(`select id,source_key,record->>'shortName' as name from eco_private.suppliers where id=${quote(supplierId)}::uuid or source_key=${quote(sourceKey)}`);assert.ok(supplier.every(s=>s.id===supplierId&&s.source_key===sourceKey&&s.name===prefix),'Supplier ownership mismatch: no cleanup performed.');
  const batch=rows(`select id,operator_id,source_records from eco_private.supplier_import_batches where id=${quote(batchId)}::uuid`);assert.ok(batch.every(b=>b.operator_id===identities[0]?.id&&b.source_records.length===1&&b.source_records[0].id===supplierId&&b.source_records[0].sourceKey===sourceKey),'Batch ownership mismatch: no cleanup performed.');
  const createdRows=rows(`select id,source_key,record->>'shortName' as name from eco_private.suppliers where source_key=${quote('eco:'+createRequestId)}`);assert.ok(createdRows.every(s=>s.source_key==='eco:'+createRequestId&&s.name===prefix+' ADDITIONAL'&&(!createdSupplierId||s.id===createdSupplierId)),'Created supplier ownership mismatch: no cleanup performed.');
  const ownedSupplierIds=[supplierId,...createdRows.map(r=>r.id)],supplierIdsSql=ownedSupplierIds.map(id=>quote(id)+'::uuid').join(',');
  const reportRows=rows(`select id,supplier_id,object_path,sha256 from eco_private.supplier_reports where supplier_id in (${supplierIdsSql})`);assert.ok(reportRows.every(r=>r.id===reportId&&r.supplier_id===supplierId&&r.object_path===reportPath&&r.sha256===reportHash),'Report ownership mismatch: no cleanup performed.');
  const object=await service.storage.from(target.supplierReportsBucket).download(reportPath);
  if(!object.error){assert.equal(createHash('sha256').update(Buffer.from(await object.data.arrayBuffer())).digest('hex'),reportHash,'Storage fixture hash mismatch: no cleanup performed.');assert.ifError((await service.storage.from(target.supplierReportsBucket).remove([reportPath])).error);}else if(!storageMissing(object.error))throw Error('Storage cleanup could not be confirmed.');
  const ids=candidates.map(x=>quote(x.id)+'::uuid').join(',')||'null';
  rows(`begin;
   delete from eco_private.supplier_reports where supplier_id in (${supplierIdsSql});
   delete from eco_private.profile_tab_revisions where target_kind='supplier' and target_id in (${ownedSupplierIds.map(quote).join(',')});
   delete from eco_private.profile_tab_identities where target_kind='supplier' and target_id in (${ownedSupplierIds.map(quote).join(',')});
   delete from eco_private.profile_tab_collections where target_kind='supplier' and target_id in (${ownedSupplierIds.map(quote).join(',')});
   delete from eco_private.supplier_revisions where supplier_id in (${supplierIdsSql});
   delete from eco_private.supplier_legacy_ids where supplier_id=${quote(supplierId)}::uuid;
   delete from eco_private.supplier_import_batches where id=${quote(batchId)}::uuid;
   delete from eco_private.suppliers where id in (${supplierIdsSql}) and source_key in (${quote(sourceKey)},${quote('eco:'+createRequestId)});
   delete from eco_private.administration_events where actor_id in (${ids});
   delete from eco_private.administration_requests where actor_id in (${ids});
   delete from eco_private.access_audit where actor_id in (${ids}) or (actor_id is null and action='provision-user' and target_id in (${ids}));
   delete from eco_private.phone_change_requests where user_id in (${ids});
   delete from eco_private.admin_operations where actor_id in (${ids}) or target_id in (${ids});
   delete from eco_private.revoked_sessions where user_id in (${ids});
   delete from eco_private.role_previews where user_id in (${ids});
   delete from eco_private.users where id in (${ids});commit;`);
  for(const c of candidates)assert.ifError((await service.auth.admin.deleteUser(c.id)).error);
  assert.equal(rows(`select id from auth.users where email in (${identities.map(x=>quote(x.email)).join(',')||'null'})`).length,0);assert.equal(rows(`select id from eco_private.suppliers where id in (${supplierIdsSql})`).length,0);assert.equal(rows(`select id from eco_private.supplier_reports where id=${quote(reportId)}::uuid`).length,0);assert.equal(rows(`select target_id from eco_private.profile_tab_collections where target_kind='supplier' and target_id in (${ownedSupplierIds.map(quote).join(',')})`).length,0);assert.equal(rows(`select id from eco_private.supplier_import_batches where id=${quote(batchId)}::uuid`).length,0);
  const removedObject=await service.storage.from(target.supplierReportsBucket).download(reportPath);assert.ok(removedObject.error&&storageMissing(removedObject.error),'Storage cleanup must be confirmed.');
  cleaned=true;save();privateWrite(output+'/query.private.sql','-- Completed fixture cleanup.');console.log(JSON.stringify({completed,cleaned,report:output+'/recovery.private.json'}));
 }
}
verify().catch(error=>{console.error(JSON.stringify({failed:true,step,failedStep:failedStep??step,failure:failureEvidence,...safeDiagnostic(error)}));process.exitCode=1;});
