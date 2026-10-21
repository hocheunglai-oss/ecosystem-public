import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {supplierUpdate,supplierListQuery,supplierDetailId,supplierCreate,supplierArchive} from '../server/suppliers/validation.ts';
import {handleSuppliers} from '../server/suppliers/handler.ts';
import type {AdministrationGateway} from '../server/admin/handler.ts';
import type {AuthConfig} from '../server/auth/config.ts';
const id='11111111-1111-4111-8111-111111111111';
const input=()=>({requestId:id,id,revision:1,info:{paymentTerms:'30 days',qualityClaimBar:'30 days',supplierTrader:'Otto',availableGrade:'VLSFO',foBdn:'',goBdn:''},contacts:[],barges:[]});
const config={origin:'https://eco.fcuno.com',deploymentOrigin:'https://eco-test.vercel.app'} as AuthConfig;
const request=(path:string,value?:unknown,origin=config.origin)=>new Request(config.origin+path,{method:value===undefined?'GET':'POST',headers:{origin,'x-eco-request':'1','content-type':'application/json'},body:value===undefined?undefined:JSON.stringify(value)});
function gateway(options:{signedIn?:boolean;preview?:boolean;authorized?:boolean;spc?:boolean;active?:boolean}={}){const calls:{name:string;args:unknown}[]=[];const g:AdministrationGateway={cookies:['renewed=cookie'],currentUser:async()=>options.signedIn===false?null:{id,isActive:options.active!==false,isAdmin:options.authorized!==false,isSpcTrader:options.spc===true} as never,getPreview:async()=>options.preview?{role:'trader'} as never:null,authenticatedRpc:async<T>(name:string,args?:unknown)=>{calls.push({name,args});return {id} as T;}};return {g,calls};}
test('supplier validation rejects forged identity/provenance, duplicates and pagination bypass',()=>{
 assert.equal(supplierUpdate(input()).info.paymentTerms,'30 days');
 assert.equal(supplierUpdate({...input(),contacts:[{id:'unnamed',role:'general',name:'',phone:'+6590000000',email:'',sourceId:''}]}).contacts[0].name,'');
 for(const v of [{...input(),facts:[]},{...input(),revision:0},{...input(),contacts:[{id:'blank',role:'sales',name:' ',phone:'',email:'',sourceId:''}]},{...input(),info:{...input().info,secret:'x'}},{...input(),contacts:[{id:'a',role:'admin',name:'A',phone:'',email:'',sourceId:''}]},{...input(),barges:[{id:'a',name:'A',imo:'',grade:'',capacity:'',sourceId:''},{id:'a',name:'B',imo:'',grade:'',capacity:'',sourceId:''}]}])assert.throws(()=>supplierUpdate(v));
 for(const q of ['?limit=101','?page=-1','?page=1&page=2','?scope=all'])assert.throws(()=>supplierListQuery(new URL('https://example.test/'+q)));
 assert.deepEqual(supplierListQuery(new URL('https://example.test/?country=SG&search=ABC')),{search:'ABC',country:'SG',grade:'',trader:'',page:1,limit:50});
 assert.equal(supplierDetailId(new URL('https://example.test/?id=spc-legacy')),'spc-legacy');assert.throws(()=>supplierDetailId(new URL('https://example.test/?id=a&id=b')));
});
test('supplier API requires live authentication, same origin and writable real view',async()=>{
 for(const [options,req,status] of [[{signedIn:false},request('/api/suppliers/list'),401],[{active:false},request('/api/suppliers/list'),401],[{authorized:false},request('/api/suppliers/update',input()),403],[{preview:true},request('/api/suppliers/update',input()),403],[{},request('/api/suppliers/update',input(),'https://attacker.test'),403]] as const){const {g,calls}=gateway(options);assert.equal((await handleSuppliers(req,config,g)).status,status);assert.equal(calls.length,'authorized' in options&&options.authorized===false?1:0);}
});
test('supplier routes forward only validated DTOs, preserve no-store/cookies and have literal Vercel files',async()=>{
 for(const [path,method] of [['list','eco_list_suppliers'],['detail?id='+id,'eco_supplier_detail'],['update','eco_update_supplier'],['pic-options','eco_supplier_pic_options']]){
  const {g,calls}=gateway();const response=await handleSuppliers(request('/api/suppliers/'+path,path==='update'?input():undefined),config,g);
  assert.equal(response.status,200);assert.equal(calls[0].name,method);assert.match(response.headers.get('cache-control')!,/no-store/);assert.equal(response.headers.getSetCookie().length,1);
  const route=await readFile(new URL('../api/suppliers/'+path.split('?')[0]+'.ts',import.meta.url),'utf8');assert.match(route,/export default serveSuppliers/);
 }
});
test('PIC options permit authenticated read-only selection without granting user-administration access',async()=>{
 for(const options of [{authorized:false},{authorized:false,spc:true},{preview:true}]){
  const {g,calls}=gateway(options);const r=await handleSuppliers(request('/api/suppliers/pic-options'),config,g);
  assert.equal(r.status,200);assert.deepEqual(calls,[{name:'eco_supplier_pic_options',args:undefined}]);
 }
 for(const [options,path,body,status] of [[{signedIn:false},'/api/suppliers/pic-options',undefined,401],[{active:false},'/api/suppliers/pic-options',undefined,401],[{},'/api/suppliers/pic-options?scope=all',undefined,400],[{},'/api/suppliers/pic-options',{},404]] as const){
  const {g,calls}=gateway(options);assert.equal((await handleSuppliers(request(path,body),config,g)).status,status);assert.equal(calls.length,0);
 }
});
test('no HTTP operator import endpoint; failures never return raw backend errors',async()=>{
 const {g,calls}=gateway();assert.equal((await handleSuppliers(request('/api/suppliers/import',input()),config,g)).status,404);assert.equal(calls.length,0);
 g.authenticatedRpc=async()=>{throw new Error('secret-backend-details');};const r=await handleSuppliers(request('/api/suppliers/list'),config,g);assert.equal(r.status,503);assert.doesNotMatch(await r.text(),/secret/);
});

test('supplier creation and archive accept only explicit bounded fields and real SPC authority',async()=>{
 const create={requestId:id,legalName:'Test Pte Ltd',shortName:'TEST',countryCode:'SG',countryName:'Singapore',portName:'Singapore',background:'Brief background',info:input().info,contacts:[],barges:[]};
 assert.equal(supplierCreate(create).legalName,'Test Pte Ltd');assert.throws(()=>supplierCreate({...create,countryCode:'KR'}));assert.throws(()=>supplierCreate({...create,sources:[]}));
 assert.throws(()=>supplierArchive({requestId:id,id,revision:0}));assert.equal(supplierUpdate({...input(),legalName:'New name',background:'New context'}).legalName,'New name');
 for(const [path,body,rpc] of [['create',create,'eco_create_supplier'],['archive',{requestId:id,id,revision:1},'eco_archive_supplier']] as const){const {g,calls}=gateway({authorized:false,spc:true});assert.equal((await handleSuppliers(request('/api/suppliers/'+path,body),config,g)).status,200);assert.equal(calls[0].name,rpc);}
});
