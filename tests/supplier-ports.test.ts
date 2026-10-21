import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { supplierPorts, supplierPortForLocation } from '../shared/supplierPorts.ts';
import { supplierCreate, supplierListQuery } from '../server/suppliers/validation.ts';
import { handleSuppliers } from '../server/suppliers/handler.ts';
import { handleProfileTabs } from '../server/profile-tabs/handler.ts';
import type { AuthConfig } from '../server/auth/config.ts';
import type { AdministrationGateway } from '../server/admin/handler.ts';
const id='11111111-1111-4111-8111-111111111111';
const config={origin:'https://eco.fcuno.com'} as AuthConfig;
const info={paymentTerms:'30',qualityClaimBar:'30',supplierTrader:'',availableGrade:'',foBdn:'',goBdn:''};
const input={requestId:id,legalName:'Tokyo Supplier',shortName:'TOKYO',countryCode:'JP',countryName:'Japan',portName:'Tokyo',portId:'port-tokyo',info,background:'',contacts:[],barges:[]};
const request=(path:string,body:unknown)=>new Request(config.origin+path,{method:'POST',headers:{origin:config.origin,'x-eco-request':'1','content-type':'application/json'},body:JSON.stringify(body)});
function gateway(countryCode:string|null){const calls:string[]=[];const g:AdministrationGateway={cookies:[],currentUser:async()=>({id,isActive:true,isAdmin:false,isSpcTrader:false} as never),getPreview:async()=>null,authenticatedRpc:async<T>(name:string)=>{calls.push(name);return (name==='eco_supplier_detail'?(countryCode?{countryCode}:null):{id}) as T;}};return {g,calls};}
test('port resolution uses exact reference identity and country, never display name',()=>{
 assert.equal(supplierPortForLocation({id:'imported-sg',code:'SG SIN',country:'Singapore'})?.id,'port-singapore');
 assert.equal(supplierPortForLocation({id:'port-chiba',code:'',country:'Japan'})?.id,'port-chiba');
 for(const location of [{id:'port-singapore',code:'HKHKG',country:'Singapore'},{id:'port-singapore',code:'',country:'Japan'},{id:'Singapore',code:'',country:'Singapore'},{id:'custom',code:'',country:'Japan'}])assert.equal(supplierPortForLocation(location),undefined);
});
test('trusted registry and database accepted port locations agree',async()=>{
 const sql=await readFile(new URL('../supabase/baseline/schema.sql',import.meta.url),'utf8');
 for(const port of supplierPorts)assert.ok(sql.includes(`('${port.id}','${port.countryCode}','${port.countryName}','${port.portName}')`));
});
test('list and registration reject unknown or contradictory location claims',()=>{
 assert.equal(supplierListQuery(new URL(config.origin+'/?portId=port-tokyo')).portId,'port-tokyo');
 for(const query of ['?portId=Tokyo','?portId=port-tokyo&portId=port-chiba','?portId='])assert.throws(()=>supplierListQuery(new URL(config.origin+query)));
 assert.equal(supplierCreate(input).portName,'Tokyo');
 for(const change of [{portName:'Singapore'},{countryCode:'SG'},{countryName:'Singapore'},{portId:'port-singapore'},{portId:undefined},{portId:null}])assert.throws(()=>supplierCreate({...input,...change}));
});
test('API uses trusted stored country for non-Singapore contributions and never trusts caller identity',async()=>{
 const update={requestId:id,id,revision:1,info,contacts:[],barges:[]};
 for(const country of ['JP','SG','unknown']){const {g,calls}=gateway(country);const response=await handleSuppliers(request('/api/suppliers/update',update),config,g);assert.equal(response.status,country==='JP'?200:403);assert.deepEqual(calls,country==='JP'?['eco_supplier_detail','eco_update_supplier']:['eco_supplier_detail']);}
 const {g,calls}=gateway('JP');assert.equal((await handleSuppliers(request('/api/suppliers/create',input),config,g)).status,200);assert.deepEqual(calls,['eco_create_supplier']);
 assert.equal((await handleSuppliers(request('/api/suppliers/create',{...input,portId:'port-singapore',countryCode:'SG',countryName:'Singapore',portName:'Singapore'}),config,g)).status,403);
 const retry=gateway(null);assert.equal((await handleSuppliers(request('/api/suppliers/archive',{requestId:id,id,revision:1}),config,retry.g)).status,200);assert.deepEqual(retry.calls,['eco_supplier_detail','eco_archive_supplier']);
});
test('shared tab API permits non-Singapore stored scope without changing private-tab authority',async()=>{
 const body={requestId:id,target:{kind:'supplier',id},visibility:'shared',revision:0,tabs:[{id,visibility:'shared',title:'OPERATIONS',content:'Notes'}]};
 for(const country of ['JP','SG']){const {g,calls}=gateway(country);assert.equal((await handleProfileTabs(request('/api/profile-tabs/save',body),config,g)).status,country==='JP'?200:403);assert.deepEqual(calls,country==='JP'?['eco_supplier_detail','eco_save_profile_tabs']:['eco_supplier_detail']);}
});
