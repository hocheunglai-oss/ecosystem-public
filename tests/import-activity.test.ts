import test from 'node:test';
import assert from 'node:assert/strict';
import { adminApi } from '../src/lib/adminApi.ts';
import { importAttempt, startImportAttempt, recordImportAttempt } from '../src/lib/importActivity.ts';
import { setPreviewReadOnly } from '../src/lib/previewGuard.ts';
import type { ImportItem, ImportTransition } from '../shared/admin.ts';
const item:ImportItem={id:'11111111-1111-4111-8111-111111111111',kind:'text',sourceName:'Knowledge extraction',sourceType:'parser',status:'processing',provenance:'client-reported',submitterId:'22222222-2222-4222-8222-222222222222',submitterName:'Fixture',createdAt:'2026-10-14T10:00:00Z',updatedAt:'2026-10-14T10:00:00Z',attempt:1,revision:1,warningCount:0,errorCode:null,summary:''};
const ready={...item,status:'awaiting-review' as const,revision:2};
const outcome={status:'awaiting-review' as const,warningCount:0};
const attempt=()=>importAttempt('text','Knowledge extraction','parser');
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason?:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
test('concurrent parser and completion begin calls share one outstanding request',async t=>{
 const pending=deferred<{item:ImportItem}>();let begins=0,transitions=0;
 t.mock.method(adminApi,'beginImport',async()=>{begins++;return pending.promise;});t.mock.method(adminApi,'transitionImport',async()=>{transitions++;return{item:ready};});
 const state=attempt(),a=startImportAttempt(state),b=startImportAttempt(state),c=recordImportAttempt(state,outcome);
 assert.equal(begins,1);assert.equal(transitions,0);pending.resolve({item});assert.equal((await a).id,item.id);await b;await c;assert.equal(begins,1);assert.equal(transitions,1);
});
test('concurrent equal outcomes share one transition, including optional empty fields',async t=>{
 const pending=deferred<{item:ImportItem}>();let calls=0;
 t.mock.method(adminApi,'beginImport',async()=>({item}));t.mock.method(adminApi,'transitionImport',async()=>{calls++;return pending.promise;});
 const state=attempt(),a=recordImportAttempt(state,outcome),b=recordImportAttempt(state,{...outcome,errorCode:'',summary:''});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);pending.resolve({item:ready});assert.deepEqual(await a,await b);
 assert.equal((await recordImportAttempt(state,outcome)).revision,2);assert.equal(calls,1);
});
test('lost begin response retries exact source request and creates only one server job',async t=>{
 const requests:string[]=[],persisted=new Map<string,ImportItem>();let first=true;
 t.mock.method(adminApi,'beginImport',async input=>{requests.push(JSON.stringify(input));persisted.set(input.requestId,item);if(first){first=false;throw new Error('Response lost after commit');}return{item:persisted.get(input.requestId)!};});
 const state=attempt();await assert.rejects(startImportAttempt(state),/Response lost/);assert.equal(state.starting,undefined);await startImportAttempt(state);
 assert.equal(persisted.size,1);assert.equal(requests[0],requests[1]);assert.ok(Object.isFrozen(state.begin));
});
test('lost transition response retries exact first outcome and does not repeat server work',async t=>{
 let first=true;const payloads:ImportTransition[]=[],persisted=new Map<string,ImportItem>();
 t.mock.method(adminApi,'beginImport',async()=>({item}));t.mock.method(adminApi,'transitionImport',async input=>{payloads.push(input);persisted.set(input.requestId,ready);if(first){first=false;throw new Error('Response lost after commit');}return{item:persisted.get(input.requestId)!};});
 const state=attempt();await assert.rejects(recordImportAttempt(state,outcome),/Response lost/);assert.equal(state.complete,undefined);assert.equal(state.recording,undefined);
 assert.equal((await recordImportAttempt(state,outcome)).revision,2);assert.deepEqual(payloads[0],payloads[1]);assert.equal(persisted.size,1);assert.equal(payloads[1].expectedRevision,1);
});
test('conflicting outcome cannot replace an in-flight, unknown or completed first result',async t=>{
 let calls=0;const pending=deferred<{item:ImportItem}>();
 t.mock.method(adminApi,'beginImport',async()=>({item}));t.mock.method(adminApi,'transitionImport',async()=>{calls++;if(calls===1)return pending.promise;return{item:ready};});
 const state=attempt(),first=recordImportAttempt(state,outcome);await new Promise(resolve=>setImmediate(resolve));
 await assert.rejects(recordImportAttempt(state,{status:'failed',warningCount:0}),/DIFFERENT REPORTED OUTCOME/);assert.equal(calls,1);
 pending.reject(new Error('Network lost'));await assert.rejects(first,/Network lost/);
 await assert.rejects(recordImportAttempt(state,{status:'cancelled',warningCount:0}),/DIFFERENT REPORTED OUTCOME/);assert.equal(calls,1);
 await recordImportAttempt(state,outcome);await assert.rejects(recordImportAttempt(state,{...outcome,warningCount:5}),/DIFFERENT REPORTED OUTCOME/);assert.equal(calls,2);
});
test('role preview denies start, recovery and completed-result calls before accessing APIs',async t=>{
 let calls=0;t.mock.method(adminApi,'beginImport',async()=>{calls++;return{item};});t.mock.method(adminApi,'transitionImport',async()=>{calls++;return{item:ready};});
 const state=attempt();setPreviewReadOnly(true);try{await assert.rejects(startImportAttempt(state),/PREVIEW IS READ ONLY/);await assert.rejects(recordImportAttempt(state,outcome),/PREVIEW IS READ ONLY/);state.complete=ready;await assert.rejects(recordImportAttempt(state,outcome),/PREVIEW IS READ ONLY/);assert.equal(calls,0);}finally{setPreviewReadOnly(false);}
});
