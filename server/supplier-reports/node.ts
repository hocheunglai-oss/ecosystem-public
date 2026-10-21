import type { IncomingMessage,ServerResponse } from 'node:http';
import { createClient } from '@supabase/supabase-js';
import { ecoConnections } from '../../config/ecoConnections.ts';
import { authConfig } from '../auth/config.ts';
import { createAuthGateway } from '../auth/gateway.ts';
import { handleSupplierReports } from './handler.ts';
export async function serveSupplierReports(req:IncomingMessage&{body?:unknown},res:ServerResponse,environment=process.env){
 res.setHeader('Cache-Control','private, no-store');res.setHeader('Content-Type','application/json');res.setHeader('X-Content-Type-Options','nosniff');
 try {
  const config=authConfig(environment),headers=new Headers();for(const [key,value]of Object.entries(req.headers))if(value)headers.set(key,Array.isArray(value)?value.join(', '):value);
  let body:string|undefined;
  if(req.method!=='GET'&&req.method!=='HEAD') {
   if(req.body!==undefined)body=typeof req.body==='string'?req.body:JSON.stringify(req.body);
   else {const chunks:Buffer[]=[];let size=0;for await(const chunk of req){const b=Buffer.from(chunk);size+=b.length;if(size>1024){res.statusCode=413;res.end(JSON.stringify({message:'Request too large.'}));return;}chunks.push(b);}body=Buffer.concat(chunks).toString('utf8');}
   if(Buffer.byteLength(body??'')>1024){res.statusCode=413;res.end(JSON.stringify({message:'Request too large.'}));return;}
  }
  const request=new Request(new URL(req.url??'/',config.origin),{method:req.method,headers,body});
  const service=createClient(config.supabaseUrl,config.secretKey,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(15000)})}});
  const response=await handleSupplierReports(request,config,createAuthGateway(request,config),{async sign(path,fileName){const {data,error}=await service.storage.from(ecoConnections.supplierReportsBucket).createSignedUrl(path,60,{download:fileName});if(error||!data?.signedUrl)throw new Error('Storage unavailable');return data.signedUrl;}});
  res.statusCode=response.status;response.headers.forEach((v,k)=>{if(k!=='set-cookie')res.setHeader(k,v);});const cookies=response.headers.getSetCookie();if(cookies.length)res.setHeader('Set-Cookie',cookies);res.end(await response.text());
 }catch{res.statusCode=503;res.end(JSON.stringify({message:'Report service unavailable.'}));}
}
