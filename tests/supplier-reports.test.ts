import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {handleSupplierReports,reportId} from '../server/supplier-reports/handler.ts';
import type {AdministrationGateway} from '../server/admin/handler.ts';
import type {AuthConfig} from '../server/auth/config.ts';
const id='11111111-1111-4111-8111-111111111111',supplierId='22222222-2222-4222-8222-222222222222',sha256='a'.repeat(64);
const config={origin:'https://eco.fcuno.com',deploymentOrigin:'https://eco-staged.vercel.app',supabaseUrl:'https://eco-test.supabase.co'} as AuthConfig;
const req=(path:string,body?:unknown,origin=config.origin)=>new Request(config.origin+'/api/supplier-reports/'+path,{method:body===undefined?'GET':'POST',headers:{origin,'x-eco-request':'1','content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
function fixture(options:{active?:boolean;missing?:boolean;objectPath?:string;signed?:string}={}){
 const calls:string[]=[];const metadata={id,supplierId,sha256,fileName:'Source.pdf',sourceId:'infospectrum',size:100,documentDate:'2026-01-01',uploadedAt:'2026-10-15T00:00:00Z'};
 const g:AdministrationGateway={cookies:['rotated=session; HttpOnly'],currentUser:async()=>({isActive:options.active!==false}) as never,getPreview:async()=>null,authenticatedRpc:async<T>(name:string)=>{calls.push(name);return (name==='eco_list_supplier_reports'?[metadata]:options.missing?null:{...metadata,objectPath:options.objectPath??`${supplierId}/${id}/${sha256}.pdf`}) as T;}};
 const storage={sign:async(path:string,fileName:string)=>{calls.push('sign:'+path+':'+fileName);return options.signed??config.supabaseUrl+`/storage/v1/object/sign/eco-supplier-reports/${supplierId}/${id}/${sha256}.pdf?token=short-lived`;}};
 return {g,storage,calls};
}
test('reports require active membership before listing metadata or creating signed downloads',async()=>{
 for(const [path,body] of [['list?supplierId='+supplierId,undefined],['download',{id}]] as const){const {g,storage,calls}=fixture({active:false});assert.equal((await handleSupplierReports(req(path,body),config,g,storage)).status,401);assert.deepEqual(calls,[]);}
});
test('report listing is bounded and never returns storage paths; all responses are private and no-store',async()=>{
 const {g,storage}=fixture();const r=await handleSupplierReports(req('list?supplierId='+supplierId),config,g,storage);assert.equal(r.status,200);assert.doesNotMatch(await r.text(),/objectPath|token=/);assert.match(r.headers.get('cache-control')!,/private, no-store/);assert.equal(r.headers.getSetCookie().length,1);
 for(const query of ['',`?supplierId=${id}&supplierId=${id}`,`?supplierId=${id}&ownerId=${id}`,'?supplierId=bad'])assert.equal((await handleSupplierReports(req('list'+query),config,g,storage)).status,400);
});
test('signed downloads recheck the database, are short lived, and reject arbitrary paths or hosts',async()=>{
 const {g,storage,calls}=fixture();const r=await handleSupplierReports(req('download',{id}),config,g,storage);assert.equal(r.status,200);const result=await r.json();assert.ok(Date.parse(result.expiresAt)-Date.now()<=60000);assert.equal(calls[0],'eco_supplier_report_access');assert.match(calls[1],new RegExp('^sign:'+supplierId));
 for(const options of [{missing:true},{objectPath:'../other-owner.pdf'},{signed:'https://external.invalid/report.pdf'},{signed:config.supabaseUrl+'/storage/v1/object/sign/another-bucket/report.pdf?token=short-lived'},{signed:config.supabaseUrl+`/storage/v1/object/sign/eco-supplier-reports/${supplierId}/${id}/${sha256}.pdf`}]){const f=fixture(options);const response=await handleSupplierReports(req('download',{id}),config,f.g,f.storage);assert.equal(response.status,options.missing?404:503);}
});
test('download rejects cross-origin, forged fields, unsafe methods and oversized bodies before signing',async()=>{
 for(const [request,status] of [[req('download',{id},'https://attacker.invalid'),403],[req('download',{id,objectPath:'arbitrary'}),400],[req('download',{id:'x'.repeat(1200)}),413],[new Request(config.origin+'/api/supplier-reports/download',{method:'DELETE'}),405]] as const){const f=fixture();assert.equal((await handleSupplierReports(request,config,f.g,f.storage)).status,status);assert.deepEqual(f.calls,[]);}
 assert.throws(()=>reportId('../report'));
});
test('storage and backend errors never expose provider details or secrets',async()=>{
 const f=fixture();f.storage.sign=async()=>{throw Error('service-secret-token');};const r=await handleSupplierReports(req('download',{id}),config,f.g,f.storage);assert.equal(r.status,503);assert.doesNotMatch(await r.text(),/secret-token/);
 for(const route of ['list','download'])assert.match(await readFile(new URL('../api/supplier-reports/'+route+'.ts',import.meta.url),'utf8'),/export default serveSupplierReports/);
});
