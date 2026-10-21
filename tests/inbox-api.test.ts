import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AccessUser, RolePreview } from '../shared/access.ts';
import type { AdministrationGateway } from '../server/admin/handler.ts';
import type { AuthConfig } from '../server/auth/config.ts';
import { handleInbox } from '../server/inbox/handler.ts';
import { ApiError } from '../server/auth/validation.ts';
const origin='https://eco.example.test',url=origin+'/api/enquiries/inbox',config={origin,deploymentOrigin:'https://staged.example.test'} as AuthConfig;
const user:AccessUser={id:randomUUID(),email:'fixture@example.test',displayName:'Synthetic',officeId:'credit',officeName:'Credit',isActive:true,activated:true,isAdmin:false,isSpcTrader:false,isManager:false,passwordChangeSuggested:false,revision:1};
function fixture(actor:AccessUser|null=user,preview:RolePreview|null=null){
 const calls:{name:string;args?:Record<string,unknown>}[]=[];
 const gateway:AdministrationGateway={cookies:[],currentUser:async()=>actor,getPreview:async()=>preview,authenticatedRpc:async<T>(name:string,args?:Record<string,unknown>)=>{calls.push({name,args});return {items:[],nextCursor:null,unreadCount:0} as T;}};
 return {gateway,calls};
}
function get(suffix='',headers:Record<string,string>={}){return new Request(url+suffix,{headers:{'X-Eco-Data-Mode':'live',...headers}});}
function post(body:unknown,headers:Record<string,string>={}){return new Request(url,{method:'POST',headers:{'X-Eco-Data-Mode':'live','X-Eco-Request':'1','Content-Type':'application/json',origin,...headers},body:JSON.stringify(body)});}
function noStore(r:Response){assert.match(r.headers.get('cache-control')??'',/private.*no-store/);assert.equal(r.headers.get('pragma'),'no-cache');assert.equal(r.headers.get('x-content-type-options'),'nosniff');}
test('inbox rejects missing authentication and inactive/unactivated users',async()=>{
 for(const actor of [null,{...user,isActive:false},{...user,activated:false}])for(const r of [get(),post({requestId:randomUUID(),action:'dismiss-all'})]){const f=fixture(actor);const response=await handleInbox(r,config,f.gateway);assert.equal(response.status,401);noStore(response);assert.deepEqual(f.calls,[]);}
});
test('inbox requires explicit LIVE, exact endpoint and bounded unambiguous query',async()=>{
 for(const r of [new Request(url),get('',{'X-Eco-Data-Mode':'test'}),get('?owner='+randomUUID()),get('?limit=51'),get('?limit=01'),get('?limit=1&limit=2'),get('?cursor='),get('?cursor=x&cursor=y'),get('/other'),new Request(url,{method:'DELETE'})]){const f=fixture();const response=await handleInbox(r,config,f.gateway);assert.ok(response.status>=400);noStore(response);assert.deepEqual(f.calls,[]);}
 for(const limit of [1,25,50]){const f=fixture();assert.equal((await handleInbox(get('?limit='+limit),config,f.gateway)).status,200);assert.deepEqual(f.calls,[{name:'eco_list_enquiry_inbox',args:{p_query:{dataMode:'live',limit}}}]);}
});
test('VIEW AS reads empty without inbox SQL and denies writes including administrator preview',async()=>{
 for(const role of ['trader','admin'] as const){const f=fixture({...user,isAdmin:true},{role,officeId:'hk',officeName:'Hong Kong',readOnly:true});const response=await handleInbox(get(),config,f.gateway);assert.deepEqual(await response.json(),{items:[],nextCursor:null,unreadCount:0});assert.equal((await handleInbox(post({requestId:randomUUID(),action:'dismiss-all'}),config,f.gateway)).status,403);assert.deepEqual(f.calls,[]);}
});
test('inbox writes enforce CSRF, strict schema and bounded body before calling SQL',async()=>{
 const base={requestId:randomUUID(),action:'read',id:randomUUID()};
 for(const r of [post(base,{origin:'https://untrusted.test'}),post(base,{'X-Eco-Request':''}),post(base,{'sec-fetch-site':'cross-site'}),post(base,{'content-type':'text/plain'}),post({...base,owner:user.id}),post({...base,dataMode:'test'}),post({...base,enquiryId:randomUUID()}),post({...base,requestId:'bad'}),post({requestId:randomUUID(),action:'dismiss-all',id:base.id}),post({requestId:randomUUID(),action:'dismiss'}),post({oversized:'x'.repeat(4100)}),post([]),post(null)]){const f=fixture();assert.ok((await handleInbox(r,config,f.gateway)).status>=400);assert.deepEqual(f.calls,[]);}
 for(const action of ['read','dismiss','dismiss-all']){const f=fixture(),body={requestId:randomUUID(),action,...(action==='dismiss-all'?{}:{id:randomUUID()})};assert.equal((await handleInbox(post(body,{origin:config.deploymentOrigin!}),config,f.gateway)).status,200);assert.deepEqual(f.calls,[{name:'eco_mutate_enquiry_inbox',args:{p_input:{dataMode:'live',...body}}}]);}
});
test('inbox preserves refreshed cookies and safe errors without leaking provider internals',async()=>{
 for(const error of [new Error('PRIVATE SENTINEL'),new ApiError(409,'Request conflict.')]){const f=fixture();f.gateway.cookies.push('eco=synthetic; Secure; HttpOnly');f.gateway.authenticatedRpc=async()=>{throw error;};const response=await handleInbox(get(),config,f.gateway);assert.equal(response.status,error instanceof ApiError?409:503);noStore(response);assert.match(response.headers.get('set-cookie')??'',/HttpOnly/);assert.doesNotMatch(await response.text(),/PRIVATE SENTINEL/);}
});
