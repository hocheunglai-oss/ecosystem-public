import type {IncomingMessage,ServerResponse} from 'node:http';
import {createClient} from '@supabase/supabase-js';
import {ecoConnections} from '../../config/ecoConnections.ts';
import {attachmentRequestBytes} from '../../shared/attachments.ts';
import {authConfig} from '../auth/config.ts';
import {createAuthGateway} from '../auth/gateway.ts';
import {ApiError} from '../auth/validation.ts';
import {handleAttachments} from './handler.ts';
export async function serveAttachments(req:IncomingMessage&{body?:unknown},res:ServerResponse,environment=process.env){
 res.setHeader('Cache-Control','private, no-store');res.setHeader('Content-Type','application/json');res.setHeader('X-Content-Type-Options','nosniff');
 try{
  const config=authConfig(environment),headers=new Headers();for(const[k,v]of Object.entries(req.headers))if(v)headers.set(k,Array.isArray(v)?v.join(', '):v);
  let body:string|undefined;
  if(!['GET','HEAD'].includes(req.method??'GET')){
   if(req.body!==undefined)body=typeof req.body==='string'?req.body:JSON.stringify(req.body);
   else{const chunks:Buffer[]=[];let size=0;for await(const chunk of req){const b=Buffer.from(chunk);size+=b.length;if(size>attachmentRequestBytes)throw new ApiError(413,'Request too large.');chunks.push(b);}body=Buffer.concat(chunks).toString('utf8');}
   if(Buffer.byteLength(body??'')>attachmentRequestBytes)throw new ApiError(413,'Request too large.');
  }
  const request=new Request(new URL(req.url??'/',config.origin),{method:req.method,headers,body});
  const service=createClient(config.supabaseUrl,config.secretKey,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>fetch(input,{...init,redirect:'error',signal:AbortSignal.timeout(15000)})}}),bucket=service.storage.from(ecoConnections.profileAttachmentsBucket);
  const response=await handleAttachments(request,config,createAuthGateway(request,config),{
   async info(path){const{data,error}=await bucket.info(path);if(error||!data)throw Error('Storage unavailable');return{id:data.id,name:data.name,bucketId:data.bucketId,size:data.size??NaN,contentType:data.contentType??'',version:data.version??null};},
   async upload(path){const{data,error}=await bucket.createSignedUploadUrl(path,{upsert:false});if(error||!data)throw Error('Storage unavailable');return data.signedUrl;},
   async sign(path,seconds,fileName){const{data,error}=await bucket.createSignedUrl(path,seconds,fileName?{download:fileName}:undefined);if(error||!data)throw Error('Storage unavailable');return data.signedUrl;},
   fetch:(url,signal)=>fetch(url,{method:'GET',redirect:'error',signal,headers:{'Accept-Encoding':'identity'}}),
   async complete(input){const{data,error}=await service.rpc('eco_complete_profile_attachment',{p_actor_id:input.actorId,p_session_id:input.sessionId,p_aal:input.aal,p_upload_id:input.uploadId,p_verified:input.verified});if(error){if(['PT409','23505'].includes(error.code))throw new ApiError(409,'Attachment changed. Refresh and try again.');if(['28000','42501'].includes(error.code))throw new ApiError(403,'Access denied.');throw Error('Publication unavailable');}return data;}
  });
  res.statusCode=response.status;response.headers.forEach((v,k)=>{if(k!=='set-cookie')res.setHeader(k,v);});const cookies=response.headers.getSetCookie();if(cookies.length)res.setHeader('Set-Cookie',cookies);res.end(await response.text());
 }catch(error){res.statusCode=error instanceof ApiError?error.status:503;res.end(JSON.stringify({message:error instanceof ApiError?error.message:'Attachment service unavailable.'}));}
}
