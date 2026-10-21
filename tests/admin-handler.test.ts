import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAdministration, type AdministrationGateway } from '../server/admin/handler.ts';
import { feedbackCreate, importBegin, importTransition, listQuery } from '../server/admin/validation.ts';
import { ApiError } from '../server/auth/validation.ts';
import type { AccessUser, RolePreview } from '../shared/access.ts';
import type { AuthConfig } from '../server/auth/config.ts';
const config:AuthConfig={origin:'https://eco.example.test',supabaseUrl:'https://example.supabase.co',publishableKey:'fixture',secretKey:'fixture',rateLimitSecret:'fixture-only-secret',secureCookies:true};
const member:AccessUser={id:'11111111-1111-4111-8111-111111111111',email:'trader@example.test',displayName:'Trader',officeId:'hk',officeName:'Hong Kong',isAdmin:false,isManager:false,isSpcTrader:false,isActive:true,activated:true,passwordChangeSuggested:false,revision:1};
const reqid='22222222-2222-4222-8222-222222222222';
const feedback={requestId:reqid,title:'Fixture feedback',description:'Synthetic details',category:'issue',pagePath:'/settings'};
function fixture(user:AccessUser|null=member,preview:RolePreview|null=null){const calls:{name:string,args?:Record<string,unknown>}[]=[];const gateway:AdministrationGateway={cookies:[],currentUser:async()=>user,getPreview:async()=>preview,authenticatedRpc:async<T>(name:string,args?:Record<string,unknown>)=>{calls.push({name,args});return {items:[],nextCursor:null} as T;}};return{gateway,calls};}
function request(path:string,body?:unknown,headers:Record<string,string>={}){return new Request(config.origin+'/api/admin/'+path,body===undefined?{}:{method:'POST',headers:{origin:config.origin,'content-type':'application/json','x-eco-request':'1',...headers},body:JSON.stringify(body)});}
const services={health:async()=>({status:'healthy'}),system:async()=>({build:'fixture'})};
test('anonymous sessions cannot access any administration read or write path',async()=>{
 for(const [path,body] of [['feedback',undefined],['imports',undefined],['audit',undefined],['system-health',undefined],['system-information',undefined],['feedback',feedback]] as const){const f=fixture(null);const response=await handleAdministration(request(path,body),config,f.gateway,services);assert.equal(response.status,401,path);assert.equal(f.calls.length,0);}
});
test('members may submit/read own feedback and import ledger but cannot read audit health system or triage',async()=>{
 for(const path of ['feedback','imports','feedback/contributions']){const f=fixture();assert.equal((await handleAdministration(request(path),config,f.gateway)).status,200);assert.equal(f.calls.length,1);}
 for(const path of ['audit','health','system','system-health','system-information']){const f=fixture();assert.equal((await handleAdministration(request(path),config,f.gateway,services)).status,403);assert.equal(f.calls.length,0);}
 const f=fixture();assert.equal((await handleAdministration(request('feedback/triage',{}),config,f.gateway)).status,403);assert.equal(f.calls.length,0);
});
test('effective role permissions precede cached operational services; every preview denies writes',async()=>{
 for(const role of ['admin','trader','spc-trader','manager','credit'] as const){const f=fixture({...member,isAdmin:true},{role,officeId:role==='credit'?'CREDIT':'hk',officeName:role==='credit'?'CREDIT':'Hong Kong',readOnly:true});
 assert.equal((await handleAdministration(request('feedback',feedback),config,f.gateway)).status,403);
 let called=false;const response=await handleAdministration(request('system-health'),config,f.gateway,{health:async()=>{called=true;return{};},system:async()=>({})});assert.equal(response.status,role==='admin'?200:403);assert.equal(called,role==='admin');}
});
test('writes require same-origin JSON and CSRF intent before reaching SQL',async()=>{
 for(const headers of [{origin:'https://evil.example'}, {'x-eco-request':'0'}, {'sec-fetch-site':'cross-site'}, {'content-type':'text/plain'}]){const f=fixture();const response=await handleAdministration(request('feedback',feedback,headers as Record<string,string>),config,f.gateway);assert.ok([403,415].includes(response.status));assert.equal(f.calls.length,0);}
 const f=fixture();const staged={...config,deploymentOrigin:'https://eco-fixture.vercel.app'};assert.equal((await handleAdministration(request('feedback',feedback,{origin:staged.deploymentOrigin}),staged,f.gateway)).status,200);
});
test('submission accepts no actor, timestamp, status or arbitrary authority fields',async()=>{
 for(const extra of [{submitterId:member.id},{createdAt:new Date().toISOString()},{status:'resolved'},{isAdmin:true}]){const f=fixture();assert.equal((await handleAdministration(request('feedback',{...feedback,...extra}),config,f.gateway)).status,400);assert.equal(f.calls.length,0);}
 const f=fixture();await handleAdministration(request('feedback',feedback),config,f.gateway);assert.deepEqual(f.calls,[{name:'eco_create_feedback',args:{p_input:feedback}}]);
});
test('no import source contents, signed URLs or published claims enter the ledger',()=>{
 const input={requestId:reqid,kind:'document',sourceName:'report.pdf',sourceType:'application/pdf'};
 assert.equal(importBegin(input).sourceName,'report.pdf');
 for(const v of [{...input,body:'private source'}, {...input,sourceName:'https://example.test/signed'}, {...input,sourceName:'folder/report.pdf'}, {...input,sourceType:'invalid type'}, {...input,expectedRevision:1}])assert.throws(()=>importBegin(v));
 for(const status of ['published','complete','server-confirmed'])assert.throws(()=>importTransition({requestId:reqid,id:member.id,expectedRevision:1,status,warningCount:0}));
});
test('list validation bounds resource use and preserves server scoped cursor, scope and filters',()=>{
 const url=new URL(config.origin+'/api/admin/feedback?limit=25&scope=mine&search=fixture');assert.deepEqual(listQuery(url),{limit:25,scope:'mine',search:'fixture',status:'',cursor:''});
 for(const query of ['limit=500','limit=-1','scope=other','actorId=someone','cursor=bad','search='+('a'.repeat(121))])assert.throws(()=>listQuery(new URL(config.origin+'/?'+query)));
 assert.doesNotThrow(()=>listQuery(new URL(config.origin+'/?cursor='+encodeURIComponent('2026-10-14 08:00:00.123+00|'+member.id))));
});
test('feedback receipt periods have an explicit allowlist and never accept another user identity',async()=>{
 for(const period of ['7d','28d','month','all']){const f=fixture();assert.equal((await handleAdministration(request('feedback/contributions?period='+period),config,f.gateway)).status,200);assert.equal(f.calls[0].args?.p_period,period);}
 for(const query of ['period=100y','userId='+member.id])assert.equal((await handleAdministration(request('feedback/contributions?'+query),config,fixture().gateway)).status,400);
});
test('errors preserve refresh cookies and no-store without leaking internal exceptions',async()=>{
 const f=fixture();f.gateway.cookies.push('eco-auth=fixture; HttpOnly; Secure');f.gateway.authenticatedRpc=async()=>{throw new Error('private-secret-sentinel');};
 const response=await handleAdministration(request('feedback'),config,f.gateway);assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/sentinel/);assert.match(response.headers.get('cache-control')!,/no-store/);assert.match(response.headers.get('set-cookie')!,/HttpOnly/);
 f.gateway.authenticatedRpc=async()=>{throw new ApiError(409,'Refresh this record.');};assert.equal((await handleAdministration(request('feedback'),config,f.gateway)).status,409);
});
test('invalid, oversized and unsupported requests never invoke SQL',async()=>{
 for(const body of [[],null,'wrong',{...feedback,description:'x'.repeat(33000)}]){const f=fixture();assert.ok([400,413].includes((await handleAdministration(request('feedback',body),config,f.gateway)).status));assert.equal(f.calls.length,0);}
 assert.equal((await handleAdministration(new Request(config.origin+'/api/admin/feedback',{method:'DELETE'}),config,fixture().gateway)).status,405);
 assert.throws(()=>feedbackCreate({...feedback,pagePath:'/settings?token=secret'}));
});
