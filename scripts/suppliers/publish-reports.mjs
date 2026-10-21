#!/usr/bin/env node
/** Operator-only PDF publication. Offline by default; reviewed UUID requests and receipts are durable. */
import {readFile,mkdir,open,rename,unlink,lstat,realpath} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {resolve,dirname,basename,relative,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createClient} from '@supabase/supabase-js';
import {ecoConnections as target} from '../../config/ecoConnections.ts';
const root=fileURLToPath(new URL('../..',import.meta.url)),maxBytes=20971520;
const check=(value,message)=>{if(!value)throw Error(message);};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const canonical=value=>JSON.stringify(sort(value));
function sort(value){return Array.isArray(value)?value.map(sort):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,sort(value[k])])):value;}
const equal=(a,b)=>canonical(a)===canonical(b);
function object(value,keys){check(value&&typeof value==='object'&&!Array.isArray(value)&&keys.every(k=>Object.hasOwn(value,k))&&Object.keys(value).every(k=>keys.includes(k)),'Unexpected or missing report fields.');}
function validDate(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;}
export function validateReportManifest(m){
 object(m,['schemaVersion','projectRef','operatorEmail','reports']);
 check(m.schemaVersion===1&&m.projectRef===target.supabaseProjectRef&&typeof m.operatorEmail==='string'&&m.operatorEmail.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m.operatorEmail)&&Array.isArray(m.reports)&&m.reports.length>0&&m.reports.length<=100,'Invalid report manifest.');
 check(new Set(m.reports.map(r=>r?.id)).size===m.reports.length,'Duplicate report id.');
 for(const r of m.reports){
  object(r,['id','supplierId','sourceId','fileName','file','sha256','size','documentDate']);
  check(typeof r.id==='string'&&uuid.test(r.id)&&typeof r.supplierId==='string'&&uuid.test(r.supplierId)&&typeof r.sourceId==='string'&&r.sourceId.startsWith('infospectrum-')&&r.sourceId.length<=160&&!/[\x00-\x1f\x7f]/.test(r.sourceId),'Invalid report identity.');
  check(typeof r.fileName==='string'&&r.fileName===basename(r.fileName)&&r.fileName.length>=5&&r.fileName.length<=200&&/\.pdf$/i.test(r.fileName)&&!/[\\\x00-\x1f\x7f]/.test(r.fileName),'Invalid PDF file name.');
  check(typeof r.file==='string'&&/\.pdf$/i.test(r.file)&&typeof r.sha256==='string'&&/^[a-f0-9]{64}$/.test(r.sha256)&&Number.isSafeInteger(r.size)&&r.size>=5&&r.size<=maxBytes&&validDate(r.documentDate),'Invalid report file/date.');
 }
 return m;
}
/** SDK releases expose either statusCode or status. A generic 400 is not evidence of absence. */
export function storageErrorStatus(error){return Number(error?.statusCode??error?.status);}
export function storageMissing(error){const status=storageErrorStatus(error);return status===404||(status===400&&(/^(NoSuchKey|NoSuchBucket|not_found|object_not_found)$/i.test(error?.code??'')||/^(Object|Bucket) (not found|does not exist)\.?$/i.test(error?.message??'')));}
async function privatePath(value,extension){
 const path=resolve(value);check(path.toLowerCase().endsWith(extension),'Invalid private file extension.');
 let parent=dirname(path),suffix=[];
 for(;;){try{parent=await realpath(parent);break;}catch(error){if(error.code!=='ENOENT')throw error;const next=dirname(parent);check(next!==parent,'Invalid private path.');suffix.unshift(basename(parent));parent=next;}}
 const actual=resolve(parent,...suffix,basename(path)),local=relative(root,actual);
 check(local.startsWith('..'+sep)||local.startsWith('output'+sep),'Private report files must be outside tracked source.');
 try{const info=await lstat(actual);check(info.isFile()&&!info.isSymbolicLink()&&!(info.mode&0o077),'Private report files must be regular owner-only files.');}catch(error){if(error.code!=='ENOENT')throw error;}
 return actual;
}
async function json(path){try{return JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code)throw error;throw Error('Private JSON is malformed; contents are not printed.');}}
async function durableWrite(path,value,exclusive=false){
 await mkdir(dirname(path),{recursive:true,mode:0o700});const temp=exclusive?path:`${path}.${randomUUID()}.tmp`;
 const file=await open(temp,'wx',0o600);try{await file.writeFile(JSON.stringify(value,null,2)+'\n');await file.sync();}finally{await file.close();}
 if(!exclusive)try{await rename(temp,path);}finally{await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
 const dir=await open(dirname(path),'r');try{await dir.sync();}finally{await dir.close();}
}
async function reviewedBytes(report,file){const info=await lstat(file);check(info.isFile()&&!info.isSymbolicLink()&&!(info.mode&0o077)&&info.size===report.size,'PDF file differs from reviewed manifest.');const bytes=await readFile(file);check(bytes.length===report.size&&digest(bytes)===report.sha256&&bytes.subarray(0,5).toString()==='%PDF-','PDF bytes differ from reviewed manifest.');return bytes;}
const quote=v=>"'"+String(v).replaceAll("'","''")+"'";
function cli(args){try{return JSON.parse(execFileSync('pnpm',['dlx','--allow-build=supabase','supabase@2.120.0',...args],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:90000,maxBuffer:8*1024*1024}));}catch{throw Error('Target verification failed; no private CLI output is printed.');}}
function liveRuntime(directory){
 let client;
 async function storage(){if(!client){const keys=await json(await privatePath(resolve(root,'output/access/eco-api-keys.private.json'),'.private.json')),secret=Array.isArray(keys)?keys.filter(k=>k.type==='secret'&&typeof k.api_key==='string'&&k.api_key.length>20):[];check(secret.length===1,'One ECO service key required.');client=createClient(`https://${target.supabaseProjectRef}.supabase.co`,secret[0].api_key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(45000)})}});}return client;}
 async function query(sql){const path=resolve(directory,randomUUID()+'.query.private.sql'),file=await open(path,'wx',0o600);try{await file.writeFile(sql);await file.sync();}finally{await file.close();}try{const data=cli(['db','query','--linked','--project-ref',target.supabaseProjectRef,'--file',path,'--output','json']),rows=Array.isArray(data)?data:data.rows;check(Array.isArray(rows),'Unexpected database result.');return rows;}finally{await unlink(path);}}
 return {
  inventory:async()=>({account:cli(['whoami','--output-format','json']),projects:cli(['projects','list','--output','json'])}),
  operator:email=>query(`select id,email from eco_private.users where email=${quote(email)} and (is_admin or is_spc_trader) and is_active and activated_at is not null and deleted_at is null and access_hold_request is null and exists(select 1 from auth.users where auth.users.id=eco_private.users.id and email_confirmed_at is not null) and to_regprocedure('public.eco_register_supplier_report(jsonb)') is not null;`),
  source:async report=>{const rows=await query(`select id from eco_private.suppliers where id=${quote(report.supplierId)}::uuid and archived_at is null and exists(select 1 from jsonb_array_elements(record->'sources') x where x->>'id'=${quote(report.sourceId)} and x->>'type'='infospectrum' and x->>'documentDate'=${quote(report.documentDate)});`);return rows.length===1;},
  metadata:async report=>{const rows=await query(`select eco_private.present_supplier_report(r)||jsonb_build_object('objectPath',r.object_path,'uploadedBy',r.uploaded_by) as item from eco_private.supplier_reports r where id=${quote(report.id)}::uuid;`);check(rows.length<=1,'Invalid report metadata state.');return rows[0]?.item??null;},
  bucket:async()=> (await storage()).storage.getBucket(target.supplierReportsBucket),
  createBucket:async()=> (await storage()).storage.createBucket(target.supplierReportsBucket,{public:false,fileSizeLimit:maxBytes,allowedMimeTypes:['application/pdf']}),
  download:async path=>(await storage()).storage.from(target.supplierReportsBucket).download(path),
  upload:async(path,bytes)=>(await storage()).storage.from(target.supplierReportsBucket).upload(path,bytes,{contentType:'application/pdf',cacheControl:'0',upsert:false}),
  register:async input=>(await storage()).rpc('eco_register_supplier_report',{p_input:input}),
 };
}
function verifyInventory(value){const owner=target.githubRepository.split('/')[0];check(owner==='hocheunglai-oss'&&value.account?.username===owner&&Array.isArray(value.projects),'ECO account verification failed.');const projects=value.projects.filter(p=>p.id===target.supabaseProjectRef),project=projects[0];check(projects.length===1&&project?.name==='ECO'&&project.organization_id===target.supabaseOrganizationId&&project.region===target.supabaseRegion&&project.status==='ACTIVE_HEALTHY','ECO project verification failed.');}
function verifyMetadata(report,metadata,operatorId){check(metadata&&metadata.id===report.id&&metadata.supplierId===report.supplierId&&metadata.sourceId===report.sourceId&&metadata.fileName===report.fileName&&metadata.objectPath===report.objectPath&&metadata.sha256===report.sha256&&metadata.size===report.size&&metadata.documentDate===report.documentDate&&metadata.uploadedBy===operatorId&&typeof metadata.uploadedAt==='string'&&Number.isFinite(Date.parse(metadata.uploadedAt)),'Committed report metadata does not match the reviewed request.');}
/** Runtime injection is only for deterministic offline operator tests; no application imports this module. */
export async function publishReports(args,injectedRuntime){
 check(args.length===2||args.length===3,'Use --manifest path.private.json [--apply].');check(args[0]==='--manifest'&&(!args[2]||args[2]==='--apply'),'Invalid arguments.');
 const manifestPath=await privatePath(args[1],'.private.json'),apply=args[2]==='--apply';check((await lstat(manifestPath)).size<=1048576,'Report manifest too large.');
 const raw=await readFile(manifestPath),manifest=validateReportManifest(JSON.parse(raw)),manifestHash=digest(raw),files=new Map();
 for(const report of manifest.reports){const file=await privatePath(resolve(dirname(manifestPath),report.file),'.pdf');await reviewedBytes(report,file);files.set(report.id,file);}
 if(!apply)return {apply:false,reports:manifest.reports.length,manifestHash};
 const requestPath=await privatePath(manifestPath.replace(/\.private\.json$/,'.request.private.json'),'.private.json'),receiptPath=await privatePath(manifestPath.replace(/\.private\.json$/,'.receipt.private.json'),'.private.json'),lockPath=requestPath+'.lock';
 // Never race another writer or silently take over an interrupted publication. The
 // private lock is removed only by its owning process; crashes require operator review.
 let lock;try{lock=await open(lockPath,'wx',0o600);}catch{throw Error('Report publication is locked; inspect the previous process and private journal before retrying.');}
 try{
  await lock.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()})+'\n');await lock.sync();
  const runtime=injectedRuntime??liveRuntime(dirname(manifestPath));verifyInventory(await runtime.inventory());
  const operators=await runtime.operator(manifest.operatorEmail);check(Array.isArray(operators)&&operators.length===1&&operators[0].email===manifest.operatorEmail&&uuid.test(operators[0].id),'Exact active ECO supplier editor or report migration missing.');const operatorId=operators[0].id;
  const requests=manifest.reports.map(({file,...report})=>({...report,objectPath:`${report.supplierId}/${report.id}/${report.sha256}.pdf`,operatorId}));
  const envelope={schemaVersion:1,projectRef:target.supabaseProjectRef,manifestHash,operatorEmail:manifest.operatorEmail,operatorId,requests};
  let saved;try{saved=await json(requestPath);}catch(error){if(error.code!=='ENOENT')throw error;await durableWrite(requestPath,envelope,true);saved=envelope;}
  check(equal(saved,envelope),'Saved report request differs from manifest, target or operator. Preserve it and investigate.');
  let receipt;try{receipt=await json(receiptPath);}catch(error){if(error.code!=='ENOENT')throw error;receipt={schemaVersion:1,projectRef:target.supabaseProjectRef,manifestHash,operatorId,completed:[]};}
  check(receipt.schemaVersion===1&&receipt.projectRef===target.supabaseProjectRef&&receipt.manifestHash===manifestHash&&receipt.operatorId===operatorId&&Array.isArray(receipt.completed)&&new Set(receipt.completed.map(r=>r.id)).size===receipt.completed.length,'Receipt belongs to another publication.');
  for(const completed of receipt.completed){const report=requests.find(r=>r.id===completed.id);check(report,'Unknown successful report in receipt.');verifyMetadata(report,completed,operatorId);}
  // Verify every prior success before any mutation. A restore or missing object is
  // never interpreted as permission to recreate a previously committed publication.
  const server=new Map();
  for(const report of requests){check(await runtime.source(report),'Reviewed report source does not match the active supplier.');const metadata=await runtime.metadata(report);server.set(report.id,metadata);if(metadata)verifyMetadata(report,metadata,operatorId);check(metadata||!receipt.completed.some(r=>r.id===report.id),'Local success is missing from the server. Stop and investigate recovery.');if(metadata){const result=await runtime.download(report.objectPath);check(!result.error&&result.data&&digest(Buffer.from(await result.data.arrayBuffer()))===report.sha256,'Published report object is missing or differs. Stop and investigate recovery.');}}
  let {data:bucket,error:bucketError}=await runtime.bucket();if(bucketError&&storageMissing(bucketError)){const result=await runtime.createBucket();check(!result.error,'Private report bucket creation did not confirm success. Retry only the saved request.');({data:bucket,error:bucketError}=await runtime.bucket());}
  check(!bucketError&&bucket?.id===target.supplierReportsBucket&&bucket.public===false&&Number(bucket.file_size_limit)===maxBytes&&bucket.allowed_mime_types?.length===1&&bucket.allowed_mime_types[0]==='application/pdf','Report bucket must be private and PDF-only with a 20 MB limit.');
  for(const report of requests){
   let metadata=server.get(report.id);
   if(!metadata){
    const existing=await runtime.download(report.objectPath);let stored=existing.data;
    if(existing.error){check(storageMissing(existing.error),'Stored object is unavailable; do not upload until its state is known.');const uploaded=await runtime.upload(report.objectPath,await reviewedBytes(report,files.get(report.id)));check(!uploaded.error,'PDF upload did not confirm success. Preserve the request and retry it.');const downloaded=await runtime.download(report.objectPath);check(!downloaded.error,'Uploaded PDF could not be verified.');stored=downloaded.data;}
    check(stored&&digest(Buffer.from(await stored.arrayBuffer()))===report.sha256,'Stored PDF checksum mismatch.');
    const registration=await runtime.register(report);check(!registration.error,'PDF registration did not confirm success. Preserve the request and object for recovery.');
    metadata=await runtime.metadata(report);verifyMetadata(report,metadata,operatorId);
    const {objectPath,uploadedBy,...publicMetadata}=metadata;check(equal(registration.data,publicMetadata),'RPC result differs from committed report metadata.');
   }
   const prior=receipt.completed.find(r=>r.id===report.id);check(!prior||equal(prior,metadata),'Successful report metadata changed. Stop and investigate.');
   if(!prior)receipt.completed.push(metadata);
   receipt.verifiedAt=new Date().toISOString();await durableWrite(receiptPath,receipt);
  }
  return {apply:true,reports:receipt.completed.length,manifestHash};
 }finally{await lock.close();await unlink(lockPath);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)publishReports(process.argv.slice(2)).then(x=>console.log(JSON.stringify(x))).catch(()=>{console.error('Report publication stopped. Review the private manifest/request/receipt and provider state before retrying; no credentials or report contents are printed.');process.exitCode=1;});
