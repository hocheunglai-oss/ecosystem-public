#!/usr/bin/env node
/** Explicit operator action only; never imported by application/API code. Default is offline validation. */
import {createHash,randomUUID} from 'node:crypto';
import {readFile,mkdir,open,rename,unlink,lstat} from 'node:fs/promises';
import {dirname,resolve,relative,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createClient} from '@supabase/supabase-js';
import {ecoConnections as target} from '../../config/ecoConnections.ts';

const root=fileURLToPath(new URL('../..',import.meta.url));
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sha=value=>createHash('sha256').update(value).digest('hex');
function check(condition,message){if(!condition)throw Error(message);}
export function validateManifest(manifest){
 check(manifest?.schemaVersion===1&&Array.isArray(manifest.records)&&manifest.records.length>=1&&manifest.records.length<=200,'Invalid supplier manifest.');
 check(/^[a-f0-9]{64}$/.test(manifest.sourceHash)&&sha(JSON.stringify(manifest.records))===manifest.sourceHash,'Manifest source hash does not match records.');
 check(new Set(manifest.records.map(r=>r.id)).size===manifest.records.length&&new Set(manifest.records.map(r=>r.sourceKey)).size===manifest.records.length,'Duplicate supplier identity.');
 check(manifest.records.every(r=>UUID.test(r.id)&&typeof r.sourceKey==='string'&&r.sourceKey.length>0),'Invalid supplier identity.');
 check(manifest.records.every(r=>Array.isArray(r.contacts)&&r.contacts.every(c=>[c.name,c.phone,c.email].some(v=>typeof v==='string'&&v.trim()))),'Empty contact cannot be published.');
 check(Buffer.byteLength(JSON.stringify(manifest.records))<=20*1024*1024,'Manifest exceeds import limit.');
 return manifest;
}
async function privatePath(value){
 const path=resolve(value),local=relative(root,path);
 check(path.endsWith('.private.json'),'Private files must end in .private.json.');
 check(local.startsWith(`..${sep}`)||local.startsWith(`output${sep}`),'Repository private files must be under ignored output/.');
 try{const stat=await lstat(path);check(stat.isFile()&&!stat.isSymbolicLink(),'Private path must be a regular file.');}catch(error){if(error.code!=='ENOENT')throw error;}
 return path;
}
async function readJson(path){return JSON.parse(await readFile(path,'utf8'));}
async function privateWrite(path,value,exclusive=false){
 await mkdir(dirname(path),{recursive:true,mode:0o700});
 const temp=exclusive?path:`${path}.${randomUUID()}.tmp`;
 const handle=await open(temp,'wx',0o600);
 try{await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();}finally{await handle.close();}
 if(!exclusive)try{await rename(temp,path);}finally{await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
function cli(args){
 try{return JSON.parse(execFileSync('pnpm',['dlx','--allow-build=supabase','supabase@2.120.0',...args],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:90000,maxBuffer:8*1024*1024}));}
 catch{throw Error('Target verification CLI failed; no captured CLI output is printed.');}
}
const quote=value=>`'${String(value).replaceAll("'","''")}'`;
function summary(request,receipt){return {batchId:request.requestId,sourceHash:request.sourceHash,inserted:receipt.inserted,preserved:receipt.preserved};}
export async function publishImport(args){
 const options={};let apply=false;
 for(let i=0;i<args.length;i++){
  if(args[i]==='--apply'){check(!apply,'Duplicate --apply.');apply=true;continue;}
  const key=args[i]?.replace(/^--/,'');check(['manifest','operator-email','request'].includes(key)&&!options[key]&&args[i+1],'Use --manifest --operator-email --request [--apply].');options[key]=args[++i];
 }
 check(options.manifest&&options['operator-email']&&options.request,'Use --manifest --operator-email --request [--apply].');
 const email=options['operator-email'];check(email.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),'Supply the exact administrator email.');
 const manifestPath=await privatePath(options.manifest),requestPath=await privatePath(options.request);
 check(manifestPath!==requestPath,'Request cannot replace manifest.');
 const manifest=validateManifest(await readJson(manifestPath));
 if(!apply)return {apply:false,suppliers:manifest.records.length,sourceHash:manifest.sourceHash};
 check(target.supabaseProjectRef&&target.supabaseOrganizationId&&target.supabaseRegion,'Canonical ECO targets are missing.');
 const owner=target.githubRepository.split('/')[0];check(owner==='hocheunglai-oss','Unexpected ECO owner.');
 check(cli(['whoami','--output-format','json']).username===owner,'Authenticated Supabase account mismatch.');
 const projects=cli(['projects','list','--output','json']);check(Array.isArray(projects),'Invalid project inventory.');
 const matches=projects.filter(p=>p.id===target.supabaseProjectRef),project=matches[0];
 check(matches.length===1&&project.organization_id===target.supabaseOrganizationId&&project.region===target.supabaseRegion&&project.name==='ECO'&&project.status==='ACTIVE_HEALTHY','ECO project identity, region or health mismatch.');
 const sqlPath=requestPath.replace(/\.private\.json$/,`.${randomUUID()}.operator.private.sql`);
 await mkdir(dirname(sqlPath),{recursive:true,mode:0o700});
 const sql=`select u.id,u.email from eco_private.users u where u.email=${quote(email)} and u.is_admin and u.is_active and u.activated_at is not null and u.deleted_at is null and u.access_hold_request is null and exists(select 1 from auth.users a where a.id=u.id and a.email_confirmed_at is not null) and to_regprocedure('public.eco_import_suppliers(jsonb)') is not null;`;
 const sqlHandle=await open(sqlPath,'wx',0o600);try{await sqlHandle.writeFile(sql);await sqlHandle.sync();}finally{await sqlHandle.close();}
 let rows;
 try{const response=cli(['db','query','--linked','--project-ref',target.supabaseProjectRef,'--file',sqlPath,'--output','json']);rows=Array.isArray(response)?response:response.rows;}finally{await unlink(sqlPath).catch(e=>{if(e.code!=='ENOENT')throw e;});}
 check(Array.isArray(rows)&&rows.length===1&&rows[0].email===email&&UUID.test(rows[0].id),'Exact active administrator or supplier migration not found.');
 const envelope={schemaVersion:1,projectRef:target.supabaseProjectRef,operatorEmail:email,request:{requestId:randomUUID(),operatorId:rows[0].id,sourceHash:manifest.sourceHash,records:manifest.records}};
 let saved;
 try{saved=await readJson(requestPath);}catch(error){if(error.code!=='ENOENT')throw Error('Existing request cannot be read; preserve it and investigate.');
  try{await privateWrite(requestPath,envelope,true);saved=envelope;}catch(writeError){if(writeError.code!=='EEXIST')throw writeError;saved=await readJson(requestPath);}}
 check(saved.schemaVersion===1&&saved.projectRef===target.supabaseProjectRef&&saved.operatorEmail===email&&UUID.test(saved.request?.requestId)&&saved.request.operatorId===rows[0].id&&saved.request.sourceHash===manifest.sourceHash&&JSON.stringify(saved.request.records)===JSON.stringify(manifest.records),'Saved request differs from manifest/operator/target. Do not overwrite it or create a retry with changed contents.');
 const request=saved.request,receiptPath=await privatePath(requestPath.replace(/\.private\.json$/,'.receipt.private.json'));
 let existingReceipt;try{existingReceipt=await readJson(receiptPath);}catch(error){if(error.code!=='ENOENT')throw Error('Existing receipt cannot be read; preserve it and investigate.');}
 if(existingReceipt?.complete){check(existingReceipt.projectRef===target.supabaseProjectRef&&existingReceipt.sourceHash===request.sourceHash&&existingReceipt.batchId===request.requestId,'Receipt identity mismatch.');return summary(request,existingReceipt);}
 const keys=await readJson(resolve(root,'output/access/eco-api-keys.private.json'));
 const secrets=Array.isArray(keys)?keys.filter(k=>k.type==='secret'&&typeof k.api_key==='string'&&k.api_key.length>20):[];
 check(secrets.length===1,'Expected exactly one configured ECO service secret.');
 const client=createClient(`https://${target.supabaseProjectRef}.supabase.co`,secrets[0].api_key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(45000)})}});
 let result;
 try{
  const response=await client.rpc('eco_import_suppliers',{p_input:request});
  if(response.error)throw Error('RPC failed');result=response.data;
  check(result?.batchId===request.requestId&&Number.isInteger(result.inserted)&&Number.isInteger(result.preserved)&&result.inserted>=0&&result.preserved>=0&&result.inserted+result.preserved===request.records.length,'Unexpected receipt.');
 }catch{
  await privateWrite(receiptPath,{complete:false,projectRef:target.supabaseProjectRef,batchId:request.requestId,sourceHash:request.sourceHash,observedAt:new Date().toISOString(),outcome:'unconfirmed'});
  throw Error('Import outcome is unconfirmed. Preserve manifest/request and rerun the identical command; do not create a new request.');
 }
 const receipt={complete:true,projectRef:target.supabaseProjectRef,batchId:result.batchId,sourceHash:request.sourceHash,inserted:result.inserted,preserved:result.preserved,observedAt:new Date().toISOString(),items:result.items};
 await privateWrite(receiptPath,receipt);return summary(request,receipt);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){publishImport(process.argv.slice(2)).then(value=>console.log(JSON.stringify(value,null,2))).catch(error=>{console.error(error instanceof Error?error.message:'Supplier publication failed.');process.exitCode=1;});}
