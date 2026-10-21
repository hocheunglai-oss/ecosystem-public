import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,stat,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {ecoConnections as target} from '../config/ecoConnections.ts';
// @ts-expect-error Operator-only JavaScript has no declaration file.
import {prepareEnrichment,publishEnrichment} from '../scripts/suppliers/publish-enrichment.mjs';

const operatorId='11111111-1111-4111-8111-111111111111',email='operator@example.com';
const timestamp='2026-10-15T00:00:00+00:00';
function manifest():any {
 const oldSource={id:'spc',type:'spc',title:'SPC SOURCE',url:'https://example.com/suppliers',documentDate:'2026-10-14',retrievedAt:timestamp};
 const newSource={id:'owner-20261015',type:'user',title:'OWNER CONFIRMATION',url:'',documentDate:'2026-10-15',retrievedAt:timestamp,reference:'REVIEWED CONFIRMATION'};
 return {schemaVersion:1,current:{id:'22222222-2222-4222-8222-222222222222',legacyIds:['spc-test'],sourceKey:'EXAMPLE',legalName:'EXAMPLE',shortName:'EXAMPLE',aliases:['EXAMPLE SUPPLIER'],countryCode:'SG',countryName:'Singapore',portName:'Singapore',nameStatus:'needs-review',legalNameSourceId:null,
  info:{paymentTerms:'30 DAYS',qualityClaimBar:'30 DAYS',supplierTrader:'OPERATOR',availableGrade:'VLSFO',foBdn:'FO SOURCE',goBdn:'GO SOURCE'},
  contacts:[{id:'contact1',role:'general',name:'',phone:'+6599999999',email:'',sourceId:'spc'}],barges:[{id:'barge1',name:'EXAMPLE BARGE',imo:'1234567',grade:'VLSFO',capacity:'1000',sourceId:'spc'}],
  facts:[{label:'BUSINESS',value:'ORIGINAL VALUE',sourceId:'spc'}],sources:[oldSource],revision:1,updatedAt:timestamp},
  enrichment:{legalName:'Example Supplier Pte. Ltd.',nameStatus:'verified',legalNameSourceId:newSource.id,facts:[{label:'BUSINESS',value:'NEW REVIEWED VALUE',sourceId:newSource.id}],sources:[newSource]}};
}
async function workspace(run:(f:any)=>Promise<void>){
 const directory=await mkdtemp(join(tmpdir(),'eco-enrichment-test-'));
 try{
  const path=join(directory,'manifest.private.json'),request=join(directory,'request.private.json'),receipt=join(directory,'request.receipt.private.json'),value=manifest();
  await writeFile(path,JSON.stringify(value),{mode:0o600});
  await run({directory,path,request,receipt,value,args:['--manifest',path,'--operator-email',email,'--request',request]});
 }finally{await rm(directory,{recursive:true,force:true});}
}
function runtime(f:any):any{
 const plan=prepareEnrichment(f.value),state={supplier:structuredClone(f.value.current),receipt:null as any},calls={inventory:0,operator:0,state:0,enrich:0},flags={loseResponse:false};
 return {stateValue:state,calls,flags,
  inventory:async()=>{calls.inventory++;return {account:{username:'hocheunglai-oss'},projects:[{id:target.supabaseProjectRef,organization_id:target.supabaseOrganizationId,region:target.supabaseRegion,name:'ECO',status:'ACTIVE_HEALTHY'}]};},
  operator:async()=>{calls.operator++;return [{id:operatorId,email}];},
  state:async()=>{calls.state++;return structuredClone(state);},
  enrich:async(request:any)=>{
   calls.enrich++;
   const saved=JSON.parse(await readFile(f.request,'utf8'));assert.deepEqual(saved.request,request);assert.equal((await stat(f.request)).mode&0o777,0o600);
   const result={...structuredClone(plan.proposed),revision:f.value.current.revision+1,updatedAt:'2026-10-15T01:00:00+00:00'};
   state.supplier=structuredClone(result);state.receipt={operation:'supplier-enrich',payloadMatches:true,result:structuredClone(result),snapshotMatches:true};
   if(flags.loseResponse)throw Error('PRIVATE-RPC-DIAGNOSTIC');
   return structuredClone(result);
  }
 };
}
test('evidence additions preserve complete profile and facts, deduplicating only exact repeated facts',()=>{
 const input=manifest(),before=structuredClone(input);input.enrichment.facts.push({...input.current.facts[0]},{...input.enrichment.facts[0]});
 const plan=prepareEnrichment(input);
 assert.deepEqual(input.current,before.current);assert.equal(plan.proposed.facts.length,2);assert.equal(plan.proposed.facts[0].value,'ORIGINAL VALUE');
 for(const key of ['info','contacts','barges','shortName','aliases','legacyIds','sourceKey','countryCode','countryName','portName'])assert.deepEqual(plan.proposed[key],before.current[key]);
 assert.equal(plan.proposed.sources.length,2);assert.equal(plan.proposed.sources[0].id,'spc');assert.match(plan.manifestHash,/^[a-f0-9]{64}$/);
});
test('same source ID uses semantic equality, but changed source content requires a new ID',()=>{
 const input=manifest(),source=input.current.sources[0];input.enrichment.sources.push(Object.fromEntries(Object.entries(source).reverse()));
 assert.equal(prepareEnrichment(input).proposed.sources.length,2);
 input.enrichment.sources[1].title='CHANGED';assert.throws(()=>prepareEnrichment(input),/Source IDs are immutable/);
});
test('unknown fields, unknown sources, operational changes and unsourced verification fail closed',()=>{
 const cases=[(m:any)=>m.enrichment.info=m.current.info,(m:any)=>m.current.unexpected='x',(m:any)=>m.enrichment.legalNameSourceId=null,(m:any)=>m.enrichment.facts[0].sourceId='missing',(m:any)=>m.current.contacts[0].sourceId='',(m:any)=>m.enrichment.sources[0].url='javascript:alert(1)',(m:any)=>m.enrichment.sources.push(m.enrichment.sources[0])];
 for(const change of cases){const input=manifest();change(input);assert.throws(()=>prepareEnrichment(input));}
 const input=manifest();input.enrichment={legalName:input.current.legalName,nameStatus:input.current.nameStatus,legalNameSourceId:input.current.legalNameSourceId,facts:[],sources:[]};assert.throws(()=>prepareEnrichment(input),/no changes/);
});
test('default invocation stays offline and creates neither request nor receipt',async()=>workspace(async f=>{
 const r=runtime(f),result=await publishEnrichment(f.args,r);assert.equal(result.apply,false);assert.equal(result.addedFacts,1);assert.equal(result.addedSources,1);
 assert.deepEqual(r.calls,{inventory:0,operator:0,state:0,enrich:0});await assert.rejects(stat(f.request),{code:'ENOENT'});await assert.rejects(stat(f.receipt),{code:'ENOENT'});
}));
test('apply checks account, region, exact active operator before creating a request',async()=>workspace(async f=>{
 for(const scenario of ['account','region','operator']){
  const r=runtime(f),inventory=await r.inventory();if(scenario==='account')inventory.account.username='different';if(scenario==='region')inventory.projects[0].region='ap-south-1';r.inventory=async()=>inventory;if(scenario==='operator')r.operator=async()=>[{id:operatorId,email:'other@example.com'}];
  await assert.rejects(publishEnrichment([...f.args,'--apply'],r));assert.equal(r.calls.enrich,0);await assert.rejects(stat(f.request),{code:'ENOENT'});
 }
}));
test('successful publication persists mode600 exact request before RPC and verifies ledger and immutable snapshot',async()=>workspace(async f=>{
 const r=runtime(f),result=await publishEnrichment([...f.args,'--apply'],r);assert.equal(result.revision,2);assert.equal(result.recovered,false);assert.equal(r.calls.enrich,1);assert.equal(r.calls.state,2);
 const saved=JSON.parse(await readFile(f.request,'utf8')),receipt=JSON.parse(await readFile(f.receipt,'utf8'));
 assert.deepEqual(saved.before,f.value.current);assert.equal(saved.request.operatorId,operatorId);assert.equal(saved.request.facts.length,2);assert.equal(receipt.complete,true);assert.equal((await stat(f.receipt)).mode&0o777,0o600);
}));
test('lost successful response is recovered from exact server receipt after later user edits without replay',async()=>workspace(async f=>{
 const r=runtime(f);r.flags.loseResponse=true;
 await assert.rejects(publishEnrichment([...f.args,'--apply'],r),error=>{assert.match(String(error),/outcome is unconfirmed/);assert.doesNotMatch(String(error),/PRIVATE-RPC/);return true;});
 const saved=await readFile(f.request,'utf8');assert.equal(JSON.parse(await readFile(f.receipt,'utf8')).complete,false);
 r.stateValue.supplier.revision=3;r.stateValue.supplier.info={...r.stateValue.supplier.info,paymentTerms:'A LATER USER EDIT'};
 const result=await publishEnrichment([...f.args,'--apply'],r);assert.equal(result.recovered,true);assert.equal(result.revision,2);assert.equal(r.calls.enrich,1);assert.equal(await readFile(f.request,'utf8'),saved);
}));
test('uncommitted uncertain outcome retries the same saved UUID and payload',async()=>workspace(async f=>{
 const r=runtime(f),normal=r.enrich;let firstRequest:any;
 r.enrich=async(request:any)=>{firstRequest=structuredClone(request);throw Error('NETWORK FAILURE');};
 await assert.rejects(publishEnrichment([...f.args,'--apply'],r),/unconfirmed/);
 r.enrich=async(request:any)=>{assert.deepEqual(request,firstRequest);return normal(request);};
 assert.equal((await publishEnrichment([...f.args,'--apply'],r)).revision,2);
}));
test('stale revisions and modified snapshots never rebase or reach RPC',async()=>workspace(async f=>{
 const r=runtime(f);r.stateValue.supplier.revision=2;await assert.rejects(publishEnrichment([...f.args,'--apply'],r),/revision changed/);assert.equal(r.calls.enrich,0);
 r.stateValue.supplier.revision=1;r.stateValue.supplier.info.paymentTerms='INTERVENING CHANGE';await assert.rejects(publishEnrichment([...f.args,'--apply'],r),/differs from the reviewed snapshot/);assert.equal(r.calls.enrich,0);
}));
test('changed manifest cannot reuse a saved request even if the previous call was uncertain',async()=>workspace(async f=>{
 const r=runtime(f);r.enrich=async()=>{throw Error('TIMEOUT');};await assert.rejects(publishEnrichment([...f.args,'--apply'],r),/unconfirmed/);
 const saved=await readFile(f.request,'utf8');f.value.enrichment.legalName='DIFFERENT LEGAL NAME';await writeFile(f.path,JSON.stringify(f.value));
 await assert.rejects(publishEnrichment([...f.args,'--apply'],r),/Saved request differs/);assert.equal(await readFile(f.request,'utf8'),saved);
}));
test('receipt conflicts and missing immutable snapshots stop recovery',async()=>workspace(async f=>{
 const r=runtime(f);await publishEnrichment([...f.args,'--apply'],r);
 r.stateValue.receipt.payloadMatches=false;await assert.rejects(publishEnrichment([...f.args,'--apply'],r),/receipt identity, payload or revision snapshot mismatch/);
 r.stateValue.receipt.payloadMatches=true;r.stateValue.receipt.snapshotMatches=false;await assert.rejects(publishEnrichment([...f.args,'--apply'],r),/receipt identity, payload or revision snapshot mismatch/);
 assert.equal(r.calls.enrich,1);
}));
test('local success is not replayed if a database restore removed its server receipt',async()=>workspace(async f=>{
 const r=runtime(f);await publishEnrichment([...f.args,'--apply'],r);r.stateValue.receipt=null;r.stateValue.supplier=f.value.current;
 await assert.rejects(publishEnrichment([...f.args,'--apply'],r),/Local success receipt is missing/);assert.equal(r.calls.enrich,1);
}));
test('unexpected RPC field changes remain unconfirmed and are not reported as successful',async()=>workspace(async f=>{
 const r=runtime(f),normal=r.enrich;r.enrich=async(request:any)=>({...await normal(request),shortName:'UNEXPECTED'});
 await assert.rejects(publishEnrichment([...f.args,'--apply'],r),/unconfirmed/);assert.equal(JSON.parse(await readFile(f.receipt,'utf8')).complete,false);
}));
test('private paths and malformed JSON cannot leak data or write into tracked source',async()=>workspace(async f=>{
 await assert.rejects(publishEnrichment([...f.args.slice(0,4),'--request',f.path]),/paths must differ/);
 await assert.rejects(publishEnrichment([...f.args.slice(0,4),'--request',resolve('src/enrichment.private.json')]),/ignored output/);
 const link=join(f.directory,'linked.private.json');await symlink(f.path,link);await assert.rejects(publishEnrichment(['--manifest',link,...f.args.slice(2)]),/regular file/);
 await writeFile(f.path,'{"secret":"SENSITIVE-REPORT-CONTENT",INVALID');
 await assert.rejects(publishEnrichment(f.args),error=>{assert.match(String(error),/Private JSON is malformed/);assert.doesNotMatch(String(error),/SENSITIVE-REPORT/);return true;});
}));

test('operator evidence updates preserve the optional server-managed background',()=>{const input=manifest();input.current.background='Reviewed brief context';const out=prepareEnrichment(input);assert.equal(out.proposed.background,input.current.background);assert.equal(Object.hasOwn(out.patch,'background'),false);});
