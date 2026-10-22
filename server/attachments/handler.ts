import {createHash} from 'node:crypto';
import {ecoConnections} from '../../config/ecoConnections.ts';
import {attachmentMaxBytes,attachmentRequestBytes,profileAttachmentPath,type AttachmentAccess} from '../../shared/attachments.ts';
import type {AdministrationGateway} from '../admin/handler.ts';
import type {AuthConfig} from '../auth/config.ts';
import {ApiError} from '../auth/validation.ts';
import {access,mutation,prepare} from './validation.ts';
export interface AttachmentObject {id:string;name:string;bucketId:string;size:number;contentType:string;version:string|null}
export interface AttachmentStorage {
 info(path:string):Promise<AttachmentObject>;
 upload(path:string):Promise<string>;
 sign(path:string,seconds:number,fileName?:string):Promise<string>;
 fetch(url:string,signal:AbortSignal):Promise<Response>;
 complete(input:{actorId:string;sessionId:string;aal:string;uploadId:string;verified:{sha256:string;size:number;objectId:string;version:string|null;mime:string}}):Promise<unknown>;
}
export function checkAttachmentUrl(value:string,config:Pick<AuthConfig,'supabaseUrl'>,path:string,upload=false):URL {
 const url=new URL(value),allowed=upload?['token']:['token','download'];
 if(url.origin!==config.supabaseUrl||url.username||url.password||url.hash||!profileAttachmentPath.test(path)
   ||url.pathname!==`/storage/v1/object/${upload?'upload/sign':'sign'}/${ecoConnections.profileAttachmentsBucket}/${path}`
   ||!url.searchParams.get('token')||url.searchParams.getAll('token').length!==1
   ||[...url.searchParams.keys()].some(k=>!allowed.includes(k))||url.searchParams.getAll('download').length>1)throw new ApiError(503,'Attachment unavailable.');
 return url;
}
/** Stream and hash actual provider bytes; proposed metadata alone never publishes a file. */
export async function verifyAttachmentBytes(storage:AttachmentStorage,config:AuthConfig,value:AttachmentAccess){
 const before=await storage.info(value.objectPath),item=value.item;
 if(before.bucketId!==ecoConnections.profileAttachmentsBucket||before.name!==value.objectPath||before.size!==item.size||before.contentType!==item.mime
   ||!Number.isSafeInteger(before.size)||before.size<0||before.size>attachmentMaxBytes)throw new ApiError(409,'Uploaded file does not match the request.');
 const url=checkAttachmentUrl(await storage.sign(value.objectPath,120),config,value.objectPath);
 const response=await storage.fetch(url.href,AbortSignal.timeout(120000));
 if(response.status!==200||response.redirected||(response.url&&response.url!==url.href)||!response.body
   ||response.headers.get('content-type')?.split(';')[0].trim()!==item.mime)throw new ApiError(503,'File verification unavailable.');
 const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)!==item.size))throw new ApiError(409,'Uploaded file size changed.');
 const reader=response.body.getReader(),hash=createHash('sha256');let size=0;
 try {for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>item.size||size>attachmentMaxBytes)throw new ApiError(409,'Uploaded file size changed.');hash.update(next.value);}}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 const sha256=hash.digest('hex');if(size!==item.size||sha256!==value.expectedSha256)throw new ApiError(409,'Uploaded file checksum does not match.');
 const after=await storage.info(value.objectPath);
 if(['id','name','bucketId','size','contentType','version'].some(k=>before[k as keyof AttachmentObject]!==after[k as keyof AttachmentObject]))throw new ApiError(409,'Uploaded file changed during verification.');
 return {sha256,size,objectId:before.id,version:before.version,mime:before.contentType};
}
export async function handleAttachments(request:Request,config:AuthConfig,gateway:AdministrationGateway,storage:AttachmentStorage):Promise<Response>{
 const respond=(data:unknown,status=200)=>{const headers=new Headers({'Content-Type':'application/json','Cache-Control':'private, no-store, max-age=0',Pragma:'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});for(const cookie of gateway.cookies)headers.append('Set-Cookie',cookie);return new Response(JSON.stringify(data),{status,headers});};
 try{
  const url=new URL(request.url),route=url.pathname.slice('/api/attachments/'.length);
  if(!url.pathname.startsWith('/api/attachments/')||!['list','prepare','complete','download','mutate'].includes(route)||url.search)throw new ApiError(404,'Not found.');
  if(request.method!==(route==='list'?'GET':'POST'))throw new ApiError(405,'Method not allowed.');
  if(request.headers.get('x-eco-data-mode')!=='live')throw new ApiError(403,'Switch to LIVE to use shared attachments.');
  let input:unknown;
  if(request.method==='POST'){
   const origin=request.headers.get('origin');if((origin!==config.origin&&origin!==config.deploymentOrigin)||request.headers.get('x-eco-request')!=='1'||request.headers.get('sec-fetch-site')==='cross-site')throw new ApiError(403,'Access denied.');
   if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')throw new ApiError(415,'JSON required.');
   const raw=await request.text();if(Buffer.byteLength(raw)>attachmentRequestBytes)throw new ApiError(413,'Request too large.');
   try{input=JSON.parse(raw);}catch{throw new ApiError(400,'Invalid attachment request.');}
  }
  const actor=await gateway.currentUser();if(!actor?.isActive||!actor.activated)throw new ApiError(401,'Sign in required.');
  if(['prepare','complete','mutate'].includes(route)&&await gateway.getPreview())throw new ApiError(403,'Preview is read only.');
  if(route==='list')return respond(await gateway.authenticatedRpc('eco_list_profile_attachments'));
  if(route==='mutate')return respond(await gateway.authenticatedRpc('eco_mutate_profile_attachment',{p_input:mutation(input)}));
  if(route==='prepare'){
   const value=prepare(input),reserved=await gateway.authenticatedRpc<{uploadId:string;objectPath:string;id:string}>('eco_prepare_profile_attachment',{p_input:value});
   if(reserved.id!==value.item.id||!profileAttachmentPath.test(reserved.objectPath))throw new ApiError(503,'Attachment unavailable.');
   const signed=checkAttachmentUrl(await storage.upload(reserved.objectPath),config,reserved.objectPath,true);
   return respond({id:reserved.id,uploadId:reserved.uploadId,url:signed.href});
  }
  const value=access(input),entry=await gateway.authenticatedRpc<AttachmentAccess>('eco_access_profile_attachment',{p_id:value.id,p_upload:route==='complete'});
  if(entry.item.id!==value.id||entry.actorId!==actor.id||!profileAttachmentPath.test(entry.objectPath))throw new ApiError(503,'Attachment unavailable.');
  if(route==='download')return respond({url:checkAttachmentUrl(await storage.sign(entry.objectPath,60,entry.item.name),config,entry.objectPath).href,expiresAt:new Date(Date.now()+60000).toISOString(),size:entry.item.size,sha256:entry.expectedSha256,mime:entry.item.mime});
  // Rechecking service publication also checks current role/session after byte verification.
  const verified=entry.state==='active'?{sha256:entry.expectedSha256,size:entry.item.size,objectId:'',version:null,mime:entry.item.mime}:await verifyAttachmentBytes(storage,config,entry);
  return respond(await storage.complete({actorId:entry.actorId,sessionId:entry.sessionId,aal:entry.aal,uploadId:entry.uploadId,verified}));
 }catch(error){return respond({message:error instanceof ApiError?error.message:'Attachment service unavailable.'},error instanceof ApiError?error.status:503);}
}
