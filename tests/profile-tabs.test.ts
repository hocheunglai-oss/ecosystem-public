import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {profileTarget,profileTabsQuery,profileTabsSave,profileTabDelete,profileTabsReorder} from '../server/profile-tabs/validation.ts';
import {handleProfileTabs} from '../server/profile-tabs/handler.ts';
import type {AdministrationGateway} from '../server/admin/handler.ts';
import type {AuthConfig} from '../server/auth/config.ts';
const id='11111111-1111-4111-8111-111111111111';
const config={origin:'https://eco.fcuno.com',deploymentOrigin:'https://eco-fixture.vercel.app'} as AuthConfig;
const body=()=>({requestId:id,target:{kind:'supplier',id},visibility:'private',revision:0,tabs:[{id,title:'MY NOTES',visibility:'private',content:'Private text'}]});
const request=(path:string,input?:unknown,origin=config.origin)=>new Request(config.origin+'/api/profile-tabs/'+path,{method:input===undefined?'GET':'POST',headers:{origin,'x-eco-request':'1','content-type':'application/json'},body:input===undefined?undefined:JSON.stringify(input)});
function gateway(options:{signedIn?:boolean;active?:boolean;admin?:boolean;spc?:boolean;preview?:boolean;previewRole?:string;activated?:boolean}={}){const calls:{name:string;args:unknown}[]=[];const g:AdministrationGateway={cookies:['refreshed=1'],currentUser:async()=>options.signedIn===false?null:{id,activated:options.activated!==false,isActive:options.active!==false,isAdmin:options.admin===true,isSpcTrader:options.spc===true} as never,getPreview:async()=>options.preview?{role:options.previewRole??'admin'} as never:null,authenticatedRpc:async<T>(name:string,args?:unknown)=>{calls.push({name,args});return {target:{kind:'supplier',id},shared:{revision:0,tabs:[]},private:{revision:1,tabs:body().tabs}} as T;}};return {g,calls};}
test('tabs validate bounded stable targets, immutable scope and allow only plain custom content',()=>{
 assert.equal(profileTabsSave(body()).tabs[0].content,'Private text');assert.equal(profileTarget({kind:'country',id:"Côte d'Ivoire"}).id,"Côte d'Ivoire");assert.equal(profileTarget({kind:'country',id:'Hong Kong'}).id,'Hong Kong');
 for(const value of [{...body(),ownerId:id},{...body(),revision:-1},{...body(),tabs:[{...body().tabs[0],visibility:'shared'}]},{...body(),tabs:[{...body().tabs[0],content:'x'.repeat(20001)}]},{...body(),tabs:[body().tabs[0],body().tabs[0]]},{...body(),tabs:[{id:'builtin:information',title:'HIDDEN',visibility:'private',builtin:'information'}]}])assert.throws(()=>profileTabsSave(value));
 const shared={...body(),visibility:'shared',tabs:[{id:'builtin:information',title:'SUPPLIER DATA',visibility:'shared',builtin:'information'}]};assert.equal(profileTabsSave(shared).tabs[0].builtin,'information');assert.throws(()=>profileTabsSave({...shared,target:{kind:'country',id:'SG'}}));
 for(const target of [{kind:'area',id:'asia'},{kind:'port',id:'../escape'},{kind:'supplier',id:'legacy-spc'},{kind:'buyer',id:'valid',ownerId:id}])assert.throws(()=>profileTarget(target));
 assert.throws(()=>profileTabsQuery(new URL('https://eco.test/?kind=port&kind=buyer&id=abc')));assert.throws(()=>profileTabsReorder({...body(),tabs:undefined,ids:[id,id]}));
 assert.equal(profileTabDelete({requestId:id,target:{kind:'port',id:'sg'},visibility:'private',revision:1,id}).id,id);
});
test('private writes allow ordinary active owner; supplier shared writes require actual admin/SPC and deny preview',async()=>{
 for(const [options,input,status] of [[{},body(),200],[{admin:true},body(),200],[{spc:true},{...body(),visibility:'shared',tabs:[{...body().tabs[0],visibility:'shared'}]},200],[{},{...body(),visibility:'shared',tabs:[{...body().tabs[0],visibility:'shared'}]},403],[{preview:true,admin:true},body(),403],[{active:false},body(),401],[{signedIn:false},body(),401]] as const){const {g,calls}=gateway(options);assert.equal((await handleProfileTabs(request('save',input),config,g)).status,status);assert.equal(calls.length,status===200||status===403&&input.visibility==='shared'&&!('preview' in options)?1:0);}
 const {g}=gateway();assert.equal((await handleProfileTabs(request('save',body(),'https://attacker.test'),config,g)).status,403);
});
test('explicit profile tab routes use validated contracts, refresh cookies and no-store responses',async()=>{
 const common={requestId:id,target:{kind:'port',id:'SG'},visibility:'private',revision:1};
 for(const [path,input,rpc] of [['list?kind=port&id=SG',undefined,'eco_list_profile_tabs'],['save',body(),'eco_save_profile_tabs'],['delete',{...common,id},'eco_delete_profile_tab'],['reorder',{...common,ids:[id]},'eco_reorder_profile_tabs']] as const){const {g,calls}=gateway();const response=await handleProfileTabs(request(path,input),config,g);assert.equal(response.status,200);assert.equal(calls[0].name,rpc);assert.match(response.headers.get('cache-control')!,/no-store/);assert.equal(response.headers.getSetCookie().length,1);assert.match(await readFile(new URL('../api/profile-tabs/'+path.split('?')[0]+'.ts',import.meta.url),'utf8'),/export default serveProfileTabs/);}
});
test('tab errors do not expose private payloads or backend exception details',async()=>{const {g}=gateway();g.authenticatedRpc=async()=>{throw Error('PRIVATE SECRET CONTENT');};const response=await handleProfileTabs(request('save',body()),config,g);assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/PRIVATE SECRET/);});

test('ECO 1.0 buyer tab APIs deny non-admin roles and previews before any RPC',async()=>{
 const buyer={kind:'buyer',id:'buyer-fixture'};
 const save={...body(),target:buyer};
 const mutations=[['save',save],['delete',{requestId:id,target:buyer,visibility:'private',revision:1,id}],['reorder',{requestId:id,target:buyer,visibility:'private',revision:1,ids:[id]}]] as const;
 for(const options of [{},{spc:true},{admin:true,activated:false},...['trader','spc-trader','manager','credit'].map(previewRole=>({admin:true,preview:true,previewRole}))]){
  const {g,calls}=gateway(options);const response=await handleProfileTabs(request('list?kind=buyer&id=buyer-fixture'),config,g);
  assert.equal(response.status,403);assert.match(await response.text(),/UNDER CONSTRUCTION: TO BE RELEASED WITH ECO 2.0/);assert.match(response.headers.get('cache-control')!,/no-store/);
  for(const [path,input] of mutations)assert.equal((await handleProfileTabs(request(path,input),config,g)).status,403);
  assert.equal(calls.length,0);
 }
 for(const preview of [false,true]){const {g,calls}=gateway({admin:true,preview,previewRole:'admin'});assert.equal((await handleProfileTabs(request('list?kind=buyer&id=buyer-fixture'),config,g)).status,200);assert.equal(calls.length,1);assert.equal((await handleProfileTabs(request('save',save),config,g)).status,preview?403:200);}
});
