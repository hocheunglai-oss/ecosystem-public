import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handleIntelligence } from '../server/intelligence/handler.ts';
import { validateIntelligenceSnapshot } from '../server/intelligence/validation.ts';
import type { AdministrationGateway } from '../server/admin/handler.ts';
import type { AuthConfig } from '../server/auth/config.ts';

const config = { origin:'https://example.test',deploymentOrigin:'https://stage.example.test' } as AuthConfig;
const fixture = () => ({schemaVersion:1,portId:'port-example',recordedAt:'2025-01-31T23:59:59.000Z',supplierRecordedAt:'2025-01-31T00:00:00.000Z',periodStart:'2025-01-01',periodEnd:'2025-01-31',sourceUrl:'https://example.test/fixtures',supplierSourceUrl:'https://example.test/suppliers',suppliers:[{id:'spc-example',name:'Synthetic Supplier',portIds:['port-example'],grades:['VLSFO'],paymentTerms:'Fixture terms'}],counts:[{supplierId:'spc-example',date:'2025-01-05',count:3}]});
function gateway(state:{active?:boolean;activated?:boolean;signedIn?:boolean;preview?:boolean;result?:unknown;failure?:boolean}={}) {
 const calls:string[]=[];
 const g:AdministrationGateway={cookies:['renewed=test; HttpOnly'],currentUser:async()=>state.signedIn===false?null:{id:'11111111-1111-4111-8111-111111111111',isActive:state.active!==false,activated:state.activated!==false} as never,getPreview:async()=>state.preview?{role:'trader'} as never:null,authenticatedRpc:async<T>(name:string)=>{calls.push(name);if(state.failure)throw new Error('private source details');return (state.result??{available:false,snapshot:null}) as T;}};
 return {g,calls};
}
test('intelligence read requires activated real identity; preview retains shared reference read',async()=>{
 for(const options of [{signedIn:false},{active:false},{activated:false}]){const {g,calls}=gateway(options);const r=await handleIntelligence(new Request(config.origin+'/api/intelligence/snapshot'),config,g);assert.equal(r.status,401);assert.equal(calls.length,0);assert.match(r.headers.get('cache-control')!,/no-store/);}
 for(const options of [{},{preview:true}]){const {g,calls}=gateway(options);const r=await handleIntelligence(new Request(config.origin+'/api/intelligence/snapshot'),config,g);assert.equal(r.status,200);assert.deepEqual(await r.json(),{available:false,snapshot:null});assert.deepEqual(calls,['eco_intelligence_snapshot']);assert.equal(r.headers.getSetCookie().length,1);assert.match(r.headers.get('cache-control')!,/private, no-store/);}
});
test('intelligence endpoint rejects writes/query bypass/cross-site and never exposes private backend errors',async()=>{
 for(const [path,init,status] of [['/api/intelligence/snapshot',{method:'POST',body:'{}'},405],['/api/intelligence/import',{},404],['/api/intelligence/snapshot?actor=other',{},400],['/api/intelligence/snapshot',{headers:{origin:'https://other.test'}},403],['/api/intelligence/snapshot',{headers:{'sec-fetch-site':'cross-site'}},403]] as const){const {g,calls}=gateway();assert.equal((await handleIntelligence(new Request(config.origin+path,init),config,g)).status,status);assert.equal(calls.length,0);}
 for(const options of [{failure:true},{result:{available:false,snapshot:fixture()}},{result:{available:true,snapshot:null}}]){const {g}=gateway(options);const r=await handleIntelligence(new Request(config.origin+'/api/intelligence/snapshot'),config,g);assert.equal(r.status,503);assert.doesNotMatch(await r.text(),/private source/);}
 const route=await readFile(new URL('../api/intelligence/snapshot.ts',import.meta.url),'utf8');assert.match(route,/export default serveIntelligence/);
});
test('private snapshot rejects orphan counts, duplicate identities, forged totals and impossible/future dates',()=>{
 const good=fixture();assert.deepEqual(validateIntelligenceSnapshot(good),good);
 const cases=[{...good,secret:'x'},{...good,suppliers:[{...good.suppliers[0],fixtureCount:999}]},{...good,suppliers:[...good.suppliers,...good.suppliers]},{...good,counts:[...good.counts,...good.counts]},{...good,counts:[{...good.counts[0],supplierId:'unknown'}]},{...good,counts:[{...good.counts[0],count:0.5}]},{...good,counts:[{...good.counts[0],date:'2025-02-30'}]},{...good,periodEnd:'2099-01-01'},{...good,recordedAt:'2099-01-01T00:00:00Z'},{...good,sourceUrl:'https://user:password@example.test/source'},{...good,suppliers:[{...good.suppliers[0],portIds:['different-port']}]},{...good,suppliers:[{...good.suppliers[0],name:'x\nprivate'}]}];
 for(const value of cases)assert.throws(()=>validateIntelligenceSnapshot(value));
});
