#!/usr/bin/env node
/** Private operator utility. The default path is fully offline and makes no writes. */
import {createHash,randomUUID} from 'node:crypto';
import {readFile,mkdir,open,rename,unlink,lstat,realpath} from 'node:fs/promises';
import {dirname,resolve,relative,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createClient} from '@supabase/supabase-js';
import {ecoConnections as target} from '../../config/ecoConnections.ts';
import {supplierInfoKeys} from '../../shared/suppliers.ts';

const root=fileURLToPath(new URL('../..',import.meta.url));
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const recordKeys=['id','legacyIds','sourceKey','legalName','shortName','aliases','countryCode','countryName','portName','nameStatus','legalNameSourceId','info','contacts','barges','facts','sources','revision','updatedAt'];
const evidenceKeys=['legalName','nameStatus','legalNameSourceId','facts','sources'];
const check=(condition,message)=>{if(!condition)throw Error(message);};
const canonical=value=>JSON.stringify(sortKeys(value));
function sortKeys(value){return Array.isArray(value)?value.map(sortKeys):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sortKeys(value[key])])):value;}
const equal=(a,b)=>canonical(a)===canonical(b);
const sha=value=>createHash('sha256').update(canonical(value)).digest('hex');
function object(value,required,optional=[]){check(value&&typeof value==='object'&&!Array.isArray(value)&&required.every(k=>Object.hasOwn(value,k))&&Object.keys(value).every(k=>required.includes(k)||optional.includes(k)),'Unexpected or missing manifest fields.');}
function text(value,min,max){check(typeof value==='string'&&value.trim().length>=min&&value.trim().length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value),'Invalid text in enrichment manifest.');}
function list(value,max){check(Array.isArray(value)&&value.length<=max,'Invalid or oversized enrichment array.');}
function unique(values){check(new Set(values).size===values.length,'Duplicate evidence or record identifier.');}
function sources(value){
 list(value,1000);unique(value.map(s=>s?.id));
 for(const s of value){
  object(s,['id','type','title','url','documentDate','retrievedAt'],['page','reference']);
  text(s.id,1,160);text(s.title,1,300);text(s.url,0,2000);text(s.documentDate,0,40);text(s.retrievedAt,1,40);
  check(['mpa','spc','infospectrum','website','user'].includes(s.type),'Invalid source type.');
  check(!s.url||/^https?:\/\//.test(s.url),'Evidence URL must use HTTP or HTTPS.');
  if(s.page!==undefined)text(s.page,0,80);if(s.reference!==undefined)text(s.reference,0,300);
 }
}
function facts(value,sourceIds){
 list(value,200);
 for(const f of value){object(f,['label','value','sourceId']);text(f.label,1,160);text(f.value,1,4000);text(f.sourceId,1,160);check(sourceIds.has(f.sourceId),'Unknown fact source.');}
}
function identity(value,sourceIds){
 text(value.legalName,1,300);check(['verified','needs-review'].includes(value.nameStatus),'Invalid name status.');
 check(value.legalNameSourceId===null||typeof value.legalNameSourceId==='string'&&sourceIds.has(value.legalNameSourceId),'Unknown legal name source.');
 check(value.nameStatus!=='verified'||value.legalNameSourceId!==null,'Verified name requires evidence.');
}
function validateCurrent(value){
 object(value,recordKeys,['background']);if(value.background!==undefined)text(value.background,0,8000);check(UUID.test(value.id),'Invalid supplier UUID.');
 check(Number.isSafeInteger(value.revision)&&value.revision>0&&value.revision<2147483647,'Invalid current revision.');
 check(typeof value.updatedAt==='string'&&Number.isFinite(Date.parse(value.updatedAt)),'Invalid snapshot time.');
 for(const key of ['sourceKey','shortName','countryName','portName'])text(value[key],1,key==='sourceKey'?160:300);
 check(typeof value.countryCode==='string'&&/^[A-Z]{2}$/.test(value.countryCode),'Invalid country code.');
 for(const key of ['legacyIds','aliases']){list(value[key],200);unique(value[key]);for(const v of value[key])text(v,1,160);}
 sources(value.sources);const ids=new Set(value.sources.map(s=>s.id));identity(value,ids);facts(value.facts,ids);
 object(value.info,supplierInfoKeys);for(const key of supplierInfoKeys)text(value.info[key],0,2000);
 for(const kind of ['contacts','barges']){
  const contacts=kind==='contacts',keys=contacts?['id','role','name','phone','email','sourceId']:['id','name','imo','grade','capacity','sourceId'];
  list(value[kind],contacts?100:200);unique(value[kind].map(row=>row?.id));
  for(const row of value[kind]){
   object(row,keys);text(row.id,1,100);text(row.name,contacts?0:1,300);text(row.sourceId,0,160);
   check(ids.has(row.sourceId),'Unknown operational source.');
   if(contacts){check(['sales','ops','general'].includes(row.role),'Invalid contact role.');text(row.phone,0,500);text(row.email,0,500);check([row.name,row.phone,row.email].some(v=>v.trim()),'Empty contact.');}
   else{text(row.imo,0,100);text(row.grade,0,300);text(row.capacity,0,300);}
  }
 }
 check(Buffer.byteLength(canonical(value))<=524288,'Supplier snapshot is too large.');
}
/** facts and sources are ADDITIONS. Existing arrays and every operational field are retained. */
export function prepareEnrichment(manifest){
 object(manifest,['schemaVersion','current','enrichment']);check(manifest.schemaVersion===1,'Unsupported enrichment manifest.');
 const current=structuredClone(manifest.current),add=structuredClone(manifest.enrichment);validateCurrent(current);object(add,evidenceKeys);sources(add.sources);
 const mergedSources=[...current.sources],byId=new Map(current.sources.map(s=>[s.id,s]));
 for(const source of add.sources){const previous=byId.get(source.id);if(previous)check(equal(previous,source),'Source IDs are immutable; use a new ID for new evidence.');else{mergedSources.push(source);byId.set(source.id,source);}}
 identity(add,new Set(byId.keys()));facts(add.facts,new Set(byId.keys()));
 const mergedFacts=[...current.facts],known=new Set(current.facts.map(canonical));
 for(const fact of add.facts){const key=canonical(fact);if(!known.has(key)){mergedFacts.push(fact);known.add(key);}}
 const proposed={...current,legalName:add.legalName,nameStatus:add.nameStatus,legalNameSourceId:add.legalNameSourceId,facts:mergedFacts,sources:mergedSources};
 validateCurrent(proposed);check(!equal(current,proposed),'Enrichment has no changes.');
 const patch={id:current.id,revision:current.revision,legalName:add.legalName,nameStatus:add.nameStatus,legalNameSourceId:add.legalNameSourceId,facts:mergedFacts,sources:mergedSources};
 return {current,proposed,patch,manifestHash:sha(manifest)};
}
async function privatePath(value){
 const path=resolve(value);check(path.endsWith('.private.json'),'Private files must end in .private.json.');
 // Resolve existing ancestors, so a symlink cannot redirect output into tracked source.
 let ancestor=dirname(path),suffix=[];
 for(;;){try{ancestor=await realpath(ancestor);break;}catch(error){if(error.code!=='ENOENT')throw error;suffix.unshift(ancestor.split(sep).at(-1));const next=dirname(ancestor);check(next!==ancestor,'Cannot resolve private directory.');ancestor=next;}}
 const actual=resolve(ancestor,...suffix,path.split(sep).at(-1)),local=relative(root,actual);
 check(local.startsWith(`..${sep}`)||local.startsWith(`output${sep}`),'Repository private files must be under ignored output/.');
 try{const stat=await lstat(actual);check(stat.isFile()&&!stat.isSymbolicLink(),'Private path must be a regular file.');check((stat.mode&0o077)===0,'Private file must have owner-only permissions (chmod 600).');}catch(error){if(error.code!=='ENOENT')throw error;}
 return actual;
}
async function readJson(path){const contents=await readFile(path,'utf8');try{return JSON.parse(contents);}catch{throw Error('Private JSON is malformed; its contents are not printed.');}}
async function privateWrite(path,value,exclusive=false){
 await mkdir(dirname(path),{recursive:true,mode:0o700});const temp=exclusive?path:`${path}.${randomUUID()}.tmp`;
 const handle=await open(temp,'wx',0o600);
 try{await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();}finally{await handle.close();}
 if(!exclusive)try{await rename(temp,path);}finally{await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
 const directory=await open(dirname(path),'r');try{await directory.sync();}finally{await directory.close();}
}
const quote=value=>`'${String(value).replaceAll("'","''")}'`;
function cli(args){
 try{return JSON.parse(execFileSync('pnpm',['dlx','--allow-build=supabase','supabase@2.120.0',...args],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:90000,maxBuffer:8*1024*1024}));}
 catch{throw Error('Target verification CLI failed; private CLI output is not printed. Preserve any saved request.');}
}
function liveRuntime(requestPath){
 async function query(sql){
  const path=requestPath.replace(/\.private\.json$/,`.${randomUUID()}.query.private.sql`);await mkdir(dirname(path),{recursive:true,mode:0o700});
  const file=await open(path,'wx',0o600);try{await file.writeFile(sql);await file.sync();}finally{await file.close();}
  try{const response=cli(['db','query','--linked','--project-ref',target.supabaseProjectRef,'--file',path,'--output','json']);const rows=Array.isArray(response)?response:response.rows;check(Array.isArray(rows),'Invalid verification query result.');return rows;}
  finally{await unlink(path).catch(error=>{if(error.code!=='ENOENT')throw error;});}
 }
 return {
  inventory:async()=>({account:cli(['whoami','--output-format','json']),projects:cli(['projects','list','--output','json'])}),
  operator:email=>query(`select u.id,u.email from eco_private.users u where u.email=${quote(email)} and u.is_admin and u.is_active and u.activated_at is not null and u.deleted_at is null and u.access_hold_request is null and exists(select 1 from auth.users a where a.id=u.id and a.email_confirmed_at is not null) and to_regprocedure('public.eco_enrich_supplier(jsonb)') is not null;`),
  state:async request=>{
   const rows=await query(`select (select eco_private.present_supplier(s) from eco_private.suppliers s where s.id=${quote(request.id)}::uuid) as supplier,
    (select jsonb_build_object('operation',r.operation,'payloadMatches',r.fingerprint=encode(sha256(convert_to(${quote(JSON.stringify(request))}::jsonb::text,'UTF8')),'hex'),'result',r.result,
      'snapshotMatches',exists(select 1 from eco_private.supplier_revisions v where v.supplier_id=${quote(request.id)}::uuid and v.revision=(r.result->>'revision')::integer and v.actor_id=r.actor_id and v.reason='enrichment' and v.snapshot=r.result))
     from eco_private.administration_requests r where r.actor_id=${quote(request.operatorId)}::uuid and r.request_id=${quote(request.requestId)}::uuid) as receipt;`);
   check(rows.length===1,'Unexpected publication verification result.');return rows[0];
  },
  enrich:async request=>{
   const keys=await readJson(await privatePath(resolve(root,'output/access/eco-api-keys.private.json')));
   const secrets=Array.isArray(keys)?keys.filter(k=>k.type==='secret'&&typeof k.api_key==='string'&&k.api_key.length>20):[];
   check(secrets.length===1,'Expected one configured ECO service secret.');
   const client=createClient(`https://${target.supabaseProjectRef}.supabase.co`,secrets[0].api_key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(45000)})}});
   const response=await client.rpc('eco_enrich_supplier',{p_input:request});check(!response.error,'Enrichment RPC did not confirm success.');return response.data;
  }
 };
}
function verifyInventory(inventory){
 check(target.supabaseProjectRef&&target.supabaseOrganizationId&&target.supabaseRegion,'Canonical ECO targets are missing.');
 const owner=target.githubRepository.split('/')[0];check(owner==='hocheunglai-oss'&&inventory.account?.username===owner,'Authenticated Supabase account mismatch.');
 check(Array.isArray(inventory.projects),'Invalid project inventory.');const matches=inventory.projects.filter(p=>p.id===target.supabaseProjectRef),project=matches[0];
 check(matches.length===1&&project.organization_id===target.supabaseOrganizationId&&project.region===target.supabaseRegion&&project.name==='ECO'&&project.status==='ACTIVE_HEALTHY','ECO project identity, region or health mismatch.');
}
function verifyResult(plan,result){
 check(result&&typeof result==='object'&&result.revision===plan.current.revision+1&&typeof result.updatedAt==='string'&&Number.isFinite(Date.parse(result.updatedAt)),'Unexpected enrichment result revision.');
 check(equal({...result,revision:plan.current.revision,updatedAt:plan.current.updatedAt},plan.proposed),'Enrichment result changed unexpected fields or evidence.');
}
function verifyCommitted(plan,state){
 check(state.receipt?.operation==='supplier-enrich'&&state.receipt.payloadMatches===true&&state.receipt.snapshotMatches===true,'Server receipt identity, payload or revision snapshot mismatch.');
 verifyResult(plan,state.receipt.result);
 check(state.supplier?.id===plan.current.id&&state.supplier.sourceKey===plan.current.sourceKey&&state.supplier.revision>=state.receipt.result.revision,'Published supplier identity mismatch.');
 return state.receipt.result;
}
const resultSummary=(request,result,recovered)=>({apply:true,requestId:request.requestId,supplierId:request.id,revision:result.revision,recovered});
/** Runtime injection is for local operator tests only; application/API code never imports this utility. */
export async function publishEnrichment(args,injectedRuntime){
 const options={};let apply=false;
 for(let i=0;i<args.length;i++){
  if(args[i]==='--apply'){check(!apply,'Duplicate --apply.');apply=true;continue;}
  const key=args[i]?.replace(/^--/,'');check(args[i]?.startsWith('--')&&['manifest','operator-email','request'].includes(key)&&!options[key]&&args[i+1]&&!args[i+1].startsWith('--'),'Use --manifest --operator-email --request [--apply].');options[key]=args[++i];
 }
 check(options.manifest&&options['operator-email']&&options.request,'Use --manifest --operator-email --request [--apply].');
 const email=options['operator-email'];check(email.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),'Supply the exact active administrator email.');
 const manifestPath=await privatePath(options.manifest),requestPath=await privatePath(options.request),receiptPath=await privatePath(requestPath.replace(/\.private\.json$/,'.receipt.private.json'));
 check(new Set([manifestPath,requestPath,receiptPath]).size===3,'Manifest, request and receipt paths must differ.');
 const plan=prepareEnrichment(await readJson(manifestPath));
 if(!apply)return {apply:false,supplierId:plan.current.id,revision:plan.current.revision,manifestHash:plan.manifestHash,addedFacts:plan.proposed.facts.length-plan.current.facts.length,addedSources:plan.proposed.sources.length-plan.current.sources.length};
 const runtime=injectedRuntime??liveRuntime(requestPath);verifyInventory(await runtime.inventory());
 const operators=await runtime.operator(email);check(Array.isArray(operators)&&operators.length===1&&operators[0].email===email&&UUID.test(operators[0].id),'Exact active administrator or supplier migration not found.');
 const operatorId=operators[0].id;
 let saved;
 try{saved=await readJson(requestPath);}catch(error){
  if(error.code!=='ENOENT')throw Error('Existing request cannot be read; preserve it and investigate.');
  const envelope={schemaVersion:1,projectRef:target.supabaseProjectRef,operatorEmail:email,manifestHash:plan.manifestHash,before:plan.current,request:{requestId:randomUUID(),operatorId,...plan.patch}};
  try{await privateWrite(requestPath,envelope,true);saved=envelope;}catch(writeError){if(writeError.code!=='EEXIST')throw writeError;saved=await readJson(requestPath);}
 }
 check(saved.schemaVersion===1&&saved.projectRef===target.supabaseProjectRef&&saved.operatorEmail===email&&saved.manifestHash===plan.manifestHash&&equal(saved.before,plan.current)&&UUID.test(saved.request?.requestId)&&saved.request.operatorId===operatorId&&equal(saved.request,{requestId:saved.request.requestId,operatorId,...plan.patch}),'Saved request differs from manifest/operator/target. Preserve it; never change a retry payload.');
 const request=saved.request;
 let localReceipt;try{localReceipt=await readJson(receiptPath);}catch(error){if(error.code!=='ENOENT')throw Error('Existing receipt cannot be read; preserve it and investigate.');}
 if(localReceipt)check(typeof localReceipt.complete==='boolean'&&localReceipt.projectRef===target.supabaseProjectRef&&localReceipt.manifestHash===plan.manifestHash&&localReceipt.requestId===request.requestId&&localReceipt.operatorId===operatorId,'Local receipt identity mismatch. Preserve it and investigate.');
 const state=await runtime.state(request);
 if(state.receipt){
  const result=verifyCommitted(plan,state);
  await privateWrite(receiptPath,{complete:true,projectRef:target.supabaseProjectRef,manifestHash:plan.manifestHash,requestId:request.requestId,operatorId,result,observedAt:new Date().toISOString(),recovered:true});
  return resultSummary(request,result,true);
 }
 // A local success receipt without its server record is not permission to replay after a restore.
 check(!localReceipt?.complete,'Local success receipt is missing from the server. Stop and investigate recovery before publishing.');
 check(state.supplier?.revision===plan.current.revision,'Supplier revision changed. Review a fresh snapshot and prepare a separate request; do not rebase automatically.');
 check(equal(state.supplier,plan.current),'Current supplier differs from the reviewed snapshot. Stop and review the evidence.');
 let result;
 try{
  const response=await runtime.enrich(request);verifyResult(plan,response);
  result=verifyCommitted(plan,await runtime.state(request));check(equal(response,result),'RPC and committed receipt differ.');
 }catch{
  await privateWrite(receiptPath,{complete:false,projectRef:target.supabaseProjectRef,manifestHash:plan.manifestHash,requestId:request.requestId,operatorId,observedAt:new Date().toISOString(),outcome:'unconfirmed'});
  throw Error('Enrichment outcome is unconfirmed. Preserve manifest/request and rerun the identical command; never create a new request to recover a lost response.');
 }
 await privateWrite(receiptPath,{complete:true,projectRef:target.supabaseProjectRef,manifestHash:plan.manifestHash,requestId:request.requestId,operatorId,result,observedAt:new Date().toISOString(),recovered:false});
 return resultSummary(request,result,false);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){publishEnrichment(process.argv.slice(2)).then(value=>console.log(JSON.stringify(value,null,2))).catch(error=>{console.error(error instanceof Error?error.message:'Supplier enrichment failed.');process.exitCode=1;});}
