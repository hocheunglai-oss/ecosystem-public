import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import type {IncomingMessage} from 'node:http';
import type {AccessUser,RolePreview} from '../shared/access.ts';
import type {AdministrationGateway} from '../server/admin/handler.ts';
import type {AuthConfig} from '../server/auth/config.ts';
import {handleCommercialEnquiries} from '../server/commercial-enquiries/handler.ts';
import {commercialMutation,commercialQuery} from '../server/commercial-enquiries/validation.ts';
import {commercialNodeRequest} from '../server/commercial-enquiries/node.ts';
import {ApiError} from '../server/auth/validation.ts';
const origin='https://eco.example.test',url=origin+'/api/enquiries/records',config={origin,deploymentOrigin:'https://staged.example.test'} as AuthConfig;
const user:AccessUser={id:randomUUID(),email:'synthetic@example.test',displayName:'Synthetic',officeId:'CREDIT',officeName:'Credit',isActive:true,activated:true,isAdmin:false,isSpcTrader:false,isManager:false,passwordChangeSuggested:false,revision:1};
const payload=()=>({dataMode:'live',requestId:randomUUID(),id:randomUUID(),expectedRevision:0,action:'confirm',source:{rawText:'SYNTHETIC PORT SINGAPORE',parsed:null,parserVersion:null,inboxId:null},reviewed:{vessel:'SYNTHETIC',imo:'9876543',eta:'20 OCT',portId:'port-singapore',buyerText:null,buyerId:null,products:[{grade:'VLSFO',quantityText:'100-200'}],remarks:'',rmk:false,viscosity:[],formattedText:'SYNTHETIC',warnings:[]}});
function fixture(actor:AccessUser|null=user,preview:RolePreview|null=null){const calls:unknown[]=[];const gateway:AdministrationGateway={cookies:[],currentUser:async()=>actor,getPreview:async()=>preview,authenticatedRpc:async<T>(name:string,args?:Record<string,unknown>)=>{calls.push({name,args});return {items:[],nextCursor:null} as T;}};return {calls,gateway};}
const get=(suffix='',headers:Record<string,string>={})=>new Request(url+suffix,{headers:{'X-Eco-Data-Mode':'live',...headers}});
const post=(body:unknown,headers:Record<string,string>={})=>new Request(url,{method:'POST',headers:{origin,'Content-Type':'application/json','X-Eco-Request':'1','X-Eco-Data-Mode':'live',...headers},body:JSON.stringify(body)});
test('commercial reads and writes require active authentication, LIVE and no VIEW AS',async()=>{
 for(const actor of [null,{...user,isActive:false},{...user,activated:false}]){const f=fixture(actor);for(const r of [get(),post(payload())])assert.equal((await handleCommercialEnquiries(r,config,f.gateway)).status,401);assert.deepEqual(f.calls,[]);}
 for(const r of [get('',{'X-Eco-Data-Mode':'test'}),new Request(url),post({...payload(),dataMode:'test'})]){const f=fixture();assert.equal((await handleCommercialEnquiries(r,config,f.gateway)).status,403);assert.deepEqual(f.calls,[]);}
 for(const role of ['admin','trader'] as const){const f=fixture({...user,isAdmin:true},{role,officeId:'hk',officeName:'Hong Kong',readOnly:true});for(const r of [get(),post(payload())])assert.equal((await handleCommercialEnquiries(r,config,f.gateway)).status,403);assert.deepEqual(f.calls,[]);}
});
test('Singapore queue requires admin or SPC, never manager/CREDIT membership; own creation needs neither',async()=>{
 for(const actor of [user,{...user,isManager:true}]){const f=fixture(actor);assert.equal((await handleCommercialEnquiries(get('?scope=singapore'),config,f.gateway)).status,403);assert.deepEqual(f.calls,[]);assert.equal((await handleCommercialEnquiries(post(payload()),config,f.gateway)).status,200);}
 for(const actor of [{...user,isAdmin:true},{...user,isSpcTrader:true}]){const f=fixture(actor);assert.equal((await handleCommercialEnquiries(get('?scope=singapore'),config,f.gateway)).status,200);}
});
test('unambiguous query forwards owned detail and receipt lookup without caller ownership',()=>{
 const id=randomUUID();assert.deepEqual(commercialQuery(new URL(url+'?inboxId='+id)),{dataMode:'live',inboxId:id});assert.deepEqual(commercialQuery(new URL(url+'?id='+id)),{dataMode:'live',id});
 for(const q of ['?owner='+id,'?id='+id+'&scope=mine','?inboxId='+id+'&id='+id,'?limit=0','?limit=51','?limit=01','?scope=all','?limit=1&limit=2','?cursor='])assert.throws(()=>commercialQuery(new URL(url+q)));
});
test('strict reviewed/source schemas permit unresolved buyer but reject fabricated authority and invalid confirmed quantities',()=>{
 assert.equal(commercialMutation(payload()).reviewed.buyerId,null);
 for(const mutate of [(p:any)=>p.ownerId=user.id,(p:any)=>p.reviewed.countryCode='SG',(p:any)=>p.reviewed.buyerId='prototype',(p:any)=>p.reviewed.portId='Singapore',(p:any)=>p.source.receivedAt='2099-01-01',(p:any)=>p.reviewed.portId=null,(p:any)=>p.action=null,(p:any)=>p.reviewed.products.push(p.reviewed.products[0]),(p:any)=>p.reviewed.vessel='港'.repeat(167),(p:any)=>p.source.rawText='x'.repeat(20001),(p:any)=>p.reviewed.warnings=['\u0001']]){const p=payload();mutate(p);assert.throws(()=>commercialMutation(p));}
 for(const quantityText of ['0','200-100','1000001','1,00 MT','NaN','1e3','-1','1/-2']){const p=payload();p.reviewed.products[0].quantityText=quantityText;assert.throws(()=>commercialMutation(p));}
 for(const quantityText of ['1,000 MT','500/700','500–700','500—700','500 to 700 MTS','500 ~ 700 metric tonnes','100.12345',' 100 MT ','100\tMT','\t100 MT','\n100 MT\n','\u00a0100\u00a0MT\u00a0','\ufeff500\u2009to\u2009700\u3000MT']){const p=payload();p.reviewed.products[0].quantityText=quantityText;assert.equal(commercialMutation(p).reviewed.products[0].quantityText,quantityText);}
 const draft=payload();draft.action='save';draft.reviewed.portId=null as any;draft.reviewed.vessel='';draft.reviewed.products=[];assert.equal(commercialMutation(draft).action,'save');
});
test('CSRF, body, route and content checks precede database operations',async()=>{
 for(const r of [post(payload(),{origin:'https://other.test'}),post(payload(),{'X-Eco-Request':''}),post(payload(),{'sec-fetch-site':'cross-site'}),post(payload(),{'content-type':'text/plain'}),post({huge:'x'.repeat(131073)}),get('/other'),new Request(url,{method:'DELETE'})]){const f=fixture();assert.ok((await handleCommercialEnquiries(r,config,f.gateway)).status>=400);assert.deepEqual(f.calls,[]);}
 const f=fixture();assert.equal((await handleCommercialEnquiries(post(payload(),{origin:config.deploymentOrigin!}),config,f.gateway)).status,200);
});
test('conflicts preserve409, outages fail503 without fallback; refreshed cookies remain private',async()=>{
 for(const error of [new ApiError(409,'This record changed.'),new Error('PRIVATE-SENTINEL')]){const f=fixture();f.gateway.cookies.push('eco=fixture; HttpOnly');f.gateway.authenticatedRpc=async()=>{throw error;};const r=await handleCommercialEnquiries(post(payload()),config,f.gateway);assert.equal(r.status,error instanceof ApiError?409:503);assert.match(r.headers.get('cache-control')??'',/private.*no-store/);assert.match(r.headers.get('set-cookie')??'',/HttpOnly/);assert.doesNotMatch(await r.text(),/PRIVATE-SENTINEL/);}
});
test('Node adapter bounds both parsed and streamed bodies',async()=>{
 function req(body?:unknown,chunks:Buffer[]=[]){return Object.assign(Readable.from(chunks),{method:'POST',url:'/api/enquiries/records',headers:{'content-type':'application/json'},...(body===undefined?{}:{body})}) as IncomingMessage & {body?:unknown};}
 const p=payload();assert.deepEqual(await (await commercialNodeRequest(req(p),origin)).json(),p);assert.deepEqual(await (await commercialNodeRequest(req(undefined,[Buffer.from(JSON.stringify(p))]),origin)).json(),p);
 for(const r of [req('x'.repeat(131073)),req(undefined,[Buffer.alloc(131073)])])await assert.rejects(commercialNodeRequest(r,origin),/too large/);
});
