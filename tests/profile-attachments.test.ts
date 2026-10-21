import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {handleAttachments,type AttachmentStorage,verifyAttachmentBytes} from '../server/attachments/handler.ts';
import {mutation,prepare} from '../server/attachments/validation.ts';
import type {AdministrationGateway} from '../server/admin/handler.ts';
import type {AuthConfig} from '../server/auth/config.ts';
import {ecoConnections} from '../config/ecoConnections.ts';
import type {AttachmentAccess} from '../shared/attachments.ts';
const uid='11111111-1111-4111-8111-111111111111',sid='22222222-2222-4222-8222-222222222222';
const bytes=Buffer.from('Original mixed-case document'),hash=createHash('sha256').update(bytes).digest('hex'),path=`${uid}/${sid}.bin`;
const config={origin:'https://eco.example.test',deploymentOrigin:'https://candidate.example.test',supabaseUrl:`https://${ecoConnections.supabaseProjectRef}.supabase.co`} as AuthConfig;
const item={id:'attachment-stable-id',folderId:'port:port-singapore',scope:{target:{kind:'port',id:'port-singapore'}},name:'Original.txt',mime:'text/plain',size:bytes.length,sha256:hash};
const access={actorId:uid,sessionId:sid,aal:'aal1',uploadId:uid,objectPath:path,item,expectedSha256:hash,state:'pending'} as AttachmentAccess;
const req=(route:string,body?:unknown,headers:Record<string,string>={})=>new Request(config.origin+'/api/attachments/'+route,{method:body===undefined?'GET':'POST',headers:{origin:config.origin,'x-eco-request':'1','x-eco-data-mode':'live','content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
function fixture(){
 const calls:string[]=[];const gateway:AdministrationGateway={cookies:[],currentUser:async()=>({id:uid,isActive:true,activated:true}) as never,getPreview:async()=>null,authenticatedRpc:async<T>(name:string)=>{calls.push(name);return(name==='eco_access_profile_attachment'?access:name==='eco_prepare_profile_attachment'?{id:item.id,objectPath:path,uploadId:uid}:{items:[],folders:[]}) as T;}};
 const storage:AttachmentStorage={info:async()=>({id:uid,bucketId:ecoConnections.profileAttachmentsBucket,name:path,size:bytes.length,contentType:'text/plain',version:'v1'}),upload:async()=>{calls.push('signed-upload');return`${config.supabaseUrl}/storage/v1/object/upload/sign/${ecoConnections.profileAttachmentsBucket}/${path}?token=fixture`;},sign:async(p,seconds)=>{calls.push(`signed-download:${seconds}`);return`${config.supabaseUrl}/storage/v1/object/sign/${ecoConnections.profileAttachmentsBucket}/${p}?token=fixture`;},fetch:async()=>new Response(bytes,{headers:{'content-type':'text/plain','content-length':String(bytes.length)}}),complete:async input=>{calls.push('publish');return input.verified;}};
 return{gateway,storage,calls};
}
test('actual bytes are verified before publication and response excludes capability context',async()=>{
 const f=fixture(),response=await handleAttachments(req('complete',{id:item.id}),config,f.gateway,f.storage);assert.equal(response.status,200);assert.equal((await response.json()).sha256,hash);assert.equal(f.calls.at(-1),'publish');
 const download=await handleAttachments(req('download',{id:item.id}),config,f.gateway,f.storage);assert.equal(download.status,200);assert.match(download.headers.get('cache-control')!,/no-store/);assert.doesNotMatch(await download.text(),/sessionId|actorId|aal1/);
});
test('wrong hash, shortened stream, MIME and object version changes never publish',async()=>{
 for(const change of ['hash','size','mime','version']){
  const f=fixture();let infos=0;
  if(change==='hash')f.storage.fetch=async()=>new Response(Buffer.alloc(bytes.length),{headers:{'content-type':'text/plain'}});
  if(change==='size')f.storage.fetch=async()=>new Response(bytes.subarray(1),{headers:{'content-type':'text/plain'}});
  if(change==='mime')f.storage.fetch=async()=>new Response(bytes,{headers:{'content-type':'text/html'}});
  if(change==='version'){const original=f.storage.info;f.storage.info=async p=>({...await original(p),version:++infos===1?'v1':'v2'});}
  const response=await handleAttachments(req('complete',{id:item.id}),config,f.gateway,f.storage);assert.ok(response.status>=400);assert.ok(!f.calls.includes('publish'));
 }
});
test('signed upload and download are exact scoped non-public capabilities; provider URLs cannot redirect',async()=>{
 const f=fixture(),r=await handleAttachments(req('prepare',{requestId:uid,item}),config,f.gateway,f.storage);assert.equal(r.status,200);assert.ok(f.calls.includes('signed-upload'));
 for(const bad of ['https://foreign.invalid/object',`${config.supabaseUrl}/storage/v1/object/upload/sign/other/${path}?token=x`,`${config.supabaseUrl}/storage/v1/object/upload/sign/${ecoConnections.profileAttachmentsBucket}/${path}?token=x&token=y`]){
  const g=fixture();g.storage.upload=async()=>bad;const response=await handleAttachments(req('prepare',{requestId:uid,item}),config,g.gateway,g.storage);assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/token=|foreign/);
 }
 const g=fixture();g.storage.fetch=async()=>new Response(null,{status:302,headers:{location:'https://foreign.invalid'}});await assert.rejects(verifyAttachmentBytes(g.storage,config,access));
});
test('inactive users, VIEW AS, TEST, cross-origin and forged owner fields cannot mutate',async()=>{
 for(const mode of ['inactive','preview','test','origin']){
  const f=fixture();if(mode==='inactive')f.gateway.currentUser=async()=>null;if(mode==='preview')f.gateway.getPreview=async()=>({role:'admin'}) as never;
  const response=await handleAttachments(req('prepare',{requestId:uid,item},mode==='test'?{'x-eco-data-mode':'test'}:mode==='origin'?{origin:'https://foreign.invalid'}:{}),config,f.gateway,f.storage);assert.ok([401,403].includes(response.status));assert.deepEqual(f.calls,[]);
 }
 assert.throws(()=>prepare({requestId:uid,item,actorId:uid}));assert.throws(()=>prepare({requestId:uid,item:{...item,scope:{...item.scope,visibility:'private'}}}));assert.throws(()=>prepare({requestId:uid,item:{...item,scope:{target:{kind:'credit',id:'buyer'}}}}));
 assert.throws(()=>mutation({requestId:uid,action:'update',revision:1,record:{id:item.id,folderId:item.folderId,scope:item.scope,name:item.name,createdBy:uid}}));
});
test('50 MiB boundary, zero-byte documents, Unicode stable IDs and unsafe link/name validation',()=>{
 assert.equal(prepare({requestId:uid,item:{...item,size:50*1024*1024}}).item.size,50*1024*1024);
 assert.equal(prepare({requestId:uid,item:{...item,id:'文件:原始',size:0}}).item.id,'文件:原始');
 assert.throws(()=>prepare({requestId:uid,item:{...item,size:50*1024*1024+1}}));
 for(const url of ['javascript:alert(1)','https://user:password@example.test/file','data:text/html,hi'])assert.throws(()=>mutation({requestId:uid,action:'link',revision:0,record:{id:item.id,folderId:item.folderId,scope:item.scope,name:item.name,url}}));
 assert.throws(()=>prepare({requestId:uid,item:{...item,name:'../secret'}}));
});
