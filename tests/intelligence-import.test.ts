import test from 'node:test';
import assert from 'node:assert/strict';
// Operator script is deliberately outside every browser/application import graph.
// @ts-expect-error local JavaScript operator module
import { buildPrivateIntelligence, parseImportArgs, importIntelligence } from '../scripts/intelligence/import-snapshot.mjs';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const supplier=()=>({recordedAt:'2025-01-31',portId:'port-example',supplierSourceUrl:'https://example.test/suppliers',suppliers:[{id:'spc-example',name:'Synthetic Supplier',portIds:['port-example'],grades:['VLSFO'],fixtureCount:999,fixtureYear:2025}]});
const counts=()=>({recordedAt:'2025-01-31',periodStart:'2025-01-01',periodEnd:'2025-01-31',sourceUrl:'https://example.test/fixtures',portId:'port-example',counts:[{key:'example',date:'2025-01-03',count:2},{key:'old-alias',date:'2025-01-03',count:3}]});
test('private import requires explicit alias identity, merges legitimate alias days, drops untrusted old totals',()=>{
 assert.throws(()=>buildPrivateIntelligence(supplier(),counts()),/Unmapped/);
 const result=buildPrivateIntelligence(supplier(),counts(),{'old-alias':'spc-example'});assert.deepEqual(result.counts,[{supplierId:'spc-example',date:'2025-01-03',count:5}]);assert.equal(result.suppliers[0].fixtureCount,undefined);assert.equal(result.recordedAt,'2025-01-31T00:00:00.000Z');
 assert.throws(()=>buildPrivateIntelligence(supplier(),{...counts(),counts:[counts().counts[0],counts().counts[0]]}),/Duplicate/);
 assert.throws(()=>buildPrivateIntelligence(supplier(),counts(),{'example':'unknown'}),/Invalid/);
 assert.throws(()=>buildPrivateIntelligence(supplier(),{...counts(),portId:'different'}),/coverage/);
});
test('private import defaults offline and validates apply target/receipt arguments',async()=>{
 assert.equal(parseImportArgs(['--suppliers','/private/a','--counts','/private/b']).apply,false);
 for(const args of [[],['--suppliers','a','--counts','b','--apply'],['--suppliers','a','--counts','b','--apply','--apply'],['--suppliers','a','--suppliers','b','--counts','c'],['--suppliers','a','--counts','b','--unknown','x']])assert.throws(()=>parseImportArgs(args));
 const dir=await realpath(await mkdtemp(join(tmpdir(),'eco-intelligence-test-')));try{
  const a=join(dir,'suppliers.json'),b=join(dir,'counts.json'),c=join(dir,'aliases.json');await writeFile(a,JSON.stringify(supplier()));await writeFile(b,JSON.stringify(counts()));await writeFile(c,JSON.stringify({'old-alias':'spc-example'}));
  const before=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('Offline validation must never use a network');};
  try{const result=await importIntelligence(['--suppliers',a,'--counts',b,'--aliases',c]);assert.equal(result.apply,false);assert.equal(result.suppliers,1);assert.equal(result.counts,1);assert.match(result.sourceHash,/^[a-f0-9]{64}$/);assert.doesNotMatch(JSON.stringify(result),/Synthetic Supplier|Fixture terms/);}finally{globalThis.fetch=before;}
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('private apply verifies target, preserves exact uncertain retry and rejects changed source',async()=>{
 const { ecoConnections: target } = await import('../config/ecoConnections.ts');
 const { chmod, readFile } = await import('node:fs/promises');
 const dir=await realpath(await mkdtemp(join(tmpdir(),'eco-intelligence-apply-')));
 const before=globalThis.fetch;let submissions:Record<string,unknown>[]=[];let fail=true;
 try{
  const a=join(dir,'suppliers.json'),b=join(dir,'counts.json'),c=join(dir,'aliases.json'),credential=join(dir,'credentials.private.json'),request=join(dir,'request.private.json'),cli=join(dir,'fake-supabase');
  await writeFile(a,JSON.stringify(supplier()));await writeFile(b,JSON.stringify(counts()));await writeFile(c,JSON.stringify({'old-alias':'spc-example'}));
  await writeFile(credential,JSON.stringify({projectRef:target.supabaseProjectRef,secretKey:'synthetic-service-key-only-for-unit-tests'}),{mode:0o600});
  const project={id:target.supabaseProjectRef,organization_id:target.supabaseOrganizationId,region:target.supabaseRegion,name:'ECO',status:'ACTIVE_HEALTHY'};
  await writeFile(cli,`#!${process.execPath}\nconsole.log(JSON.stringify(process.argv[2]==='whoami'?${JSON.stringify({username:target.githubRepository.split('/')[0]})}:${JSON.stringify([project])}));\n`,{mode:0o700});await chmod(cli,0o700);
  globalThis.fetch=async(url,init)=>{
   assert.equal(String(url),`https://${target.supabaseProjectRef}.supabase.co/rest/v1/rpc/eco_import_intelligence_snapshot`);
   const input=JSON.parse(String(init?.body)).p_input;submissions.push(input);
   if(fail)throw new Error('Synthetic network interruption');
   return new Response(JSON.stringify({snapshotId:input.requestId,previousSnapshotId:input.expectedActiveId,sourceHash:input.sourceHash,suppliers:input.snapshot.suppliers.length,counts:input.snapshot.counts.length}),{status:200,headers:{'content-type':'application/json'}});
  };
  const args=['--suppliers',a,'--counts',b,'--aliases',c,'--apply','--operator-id','11111111-1111-4111-8111-111111111111','--expected-active-id','none','--request',request,'--credentials',credential,'--supabase-cli',cli];
  await assert.rejects(importIntelligence(args),/unconfirmed/);assert.equal(submissions.length,1);
  const saved=JSON.parse(await readFile(request,'utf8'));assert.equal(saved.input.requestId,submissions[0].requestId);
  fail=false;const result=await importIntelligence(args);assert.equal(result.snapshotId,saved.input.requestId);assert.deepEqual(submissions[1],submissions[0]);
  await writeFile(a,JSON.stringify({...supplier(),suppliers:[{...supplier().suppliers[0],name:'Changed synthetic supplier'}]}));
  await assert.rejects(importIntelligence(args),/Saved request differs/);assert.equal(submissions.length,2);
 }finally{globalThis.fetch=before;await rm(dir,{recursive:true,force:true});}
});
