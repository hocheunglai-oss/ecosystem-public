import type { IncomingMessage,ServerResponse } from 'node:http';
import {authConfig} from '../auth/config.ts';
import {createAuthGateway} from '../auth/gateway.ts';
import {handleEnquiryPolicy} from './handler.ts';
export async function serveEnquiryPolicy(req:IncomingMessage,res:ServerResponse,environment=process.env){
 res.setHeader('Cache-Control','private, no-store');res.setHeader('Content-Type','application/json');res.setHeader('X-Content-Type-Options','nosniff');
 try{const config=authConfig(environment);const headers=new Headers();for(const[k,v]of Object.entries(req.headers))if(v)headers.set(k,Array.isArray(v)?v.join(', '):v);
 const request=new Request(new URL(req.url??'/',config.origin),{method:req.method,headers});
 const response=await handleEnquiryPolicy(request,createAuthGateway(request,config));res.statusCode=response.status;response.headers.forEach((v,k)=>{if(k!=='set-cookie')res.setHeader(k,v);});const cookies=response.headers.getSetCookie();if(cookies.length)res.setHeader('Set-Cookie',cookies);res.end(await response.text());
 }catch{res.statusCode=503;res.end(JSON.stringify({message:'Test workspace unavailable.'}));}
}
