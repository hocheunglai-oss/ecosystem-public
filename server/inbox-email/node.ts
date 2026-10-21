import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage,ServerResponse } from 'node:http';
import { createClient } from '@supabase/supabase-js';
import { emailConfig, EmailSyncError, type EmailConfig } from './config.ts';
import { microsoftGraph, type GraphApi } from './microsoft.ts';
import { pollEmail, type EmailStore } from './worker.ts';

export function cronAuthorized(header:string|null,secret:string|undefined):boolean {
  if(!secret||secret.length<32||secret.length>512||/[\r\n]/.test(secret))return false;
  const expected=createHash('sha256').update(`Bearer ${secret}`).digest();
  const actual=createHash('sha256').update(header??'').digest();return timingSafeEqual(actual,expected);
}
export function emailStore(config:EmailConfig):EmailStore {
  const client=createClient(config.supabaseUrl,config.supabaseKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:(url,init)=>fetch(url,{...init,redirect:'error',signal:AbortSignal.timeout(8000)})}});
  return {async rpc<T>(name:string,input:Record<string,unknown>):Promise<T>{
    const {data,error}=await client.rpc(name,{p_input:input});
    if(error)throw new EmailSyncError(error.code==='PT429'?'deferred':error.code==='PT409'?'lease_conflict':error.code==='42501'?'configuration_error':'provider_error');return data as T;
  }};
}
interface SyncDependencies {configure:(env:NodeJS.ProcessEnv)=>EmailConfig;store:(config:EmailConfig)=>EmailStore;graph:(config:EmailConfig)=>GraphApi}
const defaults:SyncDependencies={configure:emailConfig,store:emailStore,graph:microsoftGraph};
/** Classifies transport metadata only. The cookie is never authentication or JWT-verified here. */
function cronCookieKind(cookie:string|null):'none'|'platform_jwt'|'rejected' {
  if(cookie===null)return 'none';
  if(cookie.length>4096)return 'rejected';
  const match=/^_vercel_jwt=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(cookie);
  // A base64url segment cannot have a one-character remainder. No claims are decoded or trusted.
  return match&&match.slice(1).every(segment=>segment.length%4!==1)?'platform_jwt':'rejected';
}
export async function handleEmailSync(request:Request,env=process.env,deps:SyncDependencies=defaults):Promise<Response> {
  const headers=new Headers({'Content-Type':'application/json','Cache-Control':'private, no-store, max-age=0','X-Content-Type-Options':'nosniff'});
  const answer=(status:number,value:unknown)=>new Response(JSON.stringify(value),{status,headers});
  if(!cronAuthorized(request.headers.get('authorization'),env.CRON_SECRET))return answer(401,{error:'unauthorized'});
  if(request.method!=='GET')return answer(405,{error:'method_not_allowed'});
  const url=new URL(request.url);
  const cookieKind=cronCookieKind(request.headers.get('cookie'));
  const shape={pathExact:url.pathname==='/api/enquiries/email-sync',queryPresent:Boolean(url.search),
    originPresent:request.headers.has('origin'),originNonempty:Boolean(request.headers.get('origin')),
    cookiePresent:request.headers.has('cookie'),cookieNonempty:Boolean(request.headers.get('cookie')),
    fetchSitePresent:request.headers.has('sec-fetch-site'),fetchSiteNonempty:Boolean(request.headers.get('sec-fetch-site')),cookieKind};
  if(!shape.pathExact||shape.queryPresent||shape.originPresent||cookieKind==='rejected'||shape.fetchSitePresent){
    // Authenticated diagnostics contain fixed booleans/enums only, never request values.
    console.warn(JSON.stringify({event:'eco_email_sync_rejected',...shape}));
    return answer(400,{error:'invalid_request'});
  }
  if(env.ECO_EMAIL_ENABLED!=='true')return answer(200,{status:'disabled'});
  try {const config=deps.configure(env);const result=await pollEmail(config,deps.store(config),deps.graph(config));return answer(200,{status:'complete',...result});}
  catch(error){const safe=error instanceof EmailSyncError?error:new EmailSyncError('provider_error');headers.set('Retry-After',String(safe.retryAfter));return answer(safe.code==='deferred'?429:safe.code==='lease_conflict'?409:503,{error:safe.code==='configuration_error'?'not_configured':'sync_unavailable'});}
}
export async function serveEmailSync(req:IncomingMessage,res:ServerResponse,environment=process.env):Promise<void> {
  try {const headers=new Headers();for(const[k,v]of Object.entries(req.headers))if(v!==undefined)headers.set(k,Array.isArray(v)?v.join(', '):v);
    const request=new Request(new URL(req.url??'/','https://eco.invalid'),{method:req.method,headers});
    const response=await handleEmailSync(request,environment);res.statusCode=response.status;response.headers.forEach((v,k)=>res.setHeader(k,v));res.end(await response.text());
  }catch{res.statusCode=503;res.setHeader('Cache-Control','private, no-store');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:'sync_unavailable'}));}
}
