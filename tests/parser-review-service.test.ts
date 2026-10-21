import test from 'node:test';
import assert from 'node:assert/strict';
import type { AdministrationGateway } from '../server/admin/handler.ts';
import type { AuthConfig } from '../server/auth/config.ts';
import type { AccessUser, RolePreview } from '../shared/access.ts';
import { emptyParserFields, PARSER_VERSION, type ParserReportDetail, type ParserReviewAnalysis } from '../shared/parserService.ts';
import { handleParser, type ParserServices, type ParserReviewReceipt } from '../server/parser/handler.ts';
import { createParserReviewProvider, validateReviewAnalysis } from '../server/parser/review-provider.ts';
import { reportInput, reportQuery, reviewInput, reviewIdentity } from '../server/parser/validation.ts';
const config: AuthConfig = {origin:'https://eco.example.test',supabaseUrl:'https://fixture.supabase.co',publishableKey:'fixture',secretKey:'fixture',rateLimitSecret:'fixture',secureCookies:true};
const admin: AccessUser = {id:'11111111-1111-4111-8111-111111111111',email:'fixture@example.test',displayName:'Fixture',officeId:'hk',officeName:'Hong Kong',isAdmin:true,isActive:true,isManager:false,isSpcTrader:false,activated:true,passwordChangeSuggested:false,revision:1};
const identity={requestId:'22222222-2222-4222-8222-222222222222',reportId:'33333333-3333-4333-8333-333333333333',expectedRevision:1,dataMode:'live' as const};
const snapshot={fields:{...emptyParserFields(),vessel:'FIXTURE'},standardText:'FIXTURE',warnings:[],rmk:false,viscosity:[]};
const evidence:ParserReportDetail={...identity,id:identity.reportId,createdAt:'2026-10-16T00:00:00Z',createdBy:'Fixture',rawText:'Vessel: FIXTURE',sourceRevision:'source-one',parserVersion:PARSER_VERSION,parsed:snapshot.fields,corrected:snapshot.fields,notes:'Reported note',sourceHash:'a'.repeat(64),buildFingerprint:'b'.repeat(64),capture:{original:snapshot,submitted:snapshot,originalRevision:'initial-one',parseOrigin:'initial'},workflow:{revision:1,stage:'pending_ai',expected:snapshot,notes:'Approved note',aiReview:null,replay:null},originalAi:null,history:[]};
const analysis={diagnosis:'The source label needs explicit handling.',proposedFix:'Match the explicit source label before free text.',regressionExamples:[{rawText:'Vessel: EXAMPLE',reason:'Explicit label'}],warnings:[]};
const req=(path='review-ai',body:unknown=identity,headers:Record<string,string>={})=>new Request(config.origin+'/api/parser/'+path,{method:'POST',headers:{origin:config.origin,'content-type':'application/json','x-eco-request':'1',...headers},body:JSON.stringify(body)});
function fixture(actor:AccessUser|null=admin,preview:RolePreview|null=null) {
 const calls:{name:string;args:unknown}[]=[],finishes:unknown[]=[];let providers=0;let receipt:ParserReviewReceipt={id:identity.requestId,state:'pending',runProvider:true,evidence};
 const gateway:AdministrationGateway={cookies:[],currentUser:async()=>actor,getPreview:async()=>preview,authenticatedRpc:async<T>(name:string,args?:Record<string,unknown>)=>{calls.push({name,args});return (name==='eco_begin_parser_review'?receipt:evidence) as T;}};
 const services:ParserServices={provider:()=>{throw new Error('AI FIX not called');},finish:async()=>{throw new Error('AI FIX not finished');},reviewProvider:()=>({model:'gpt-6-luna',analyze:async loaded=>{providers++;assert.deepEqual(loaded,evidence);return analysis;}}),finishReview:async(actorId,id,result,errorCode)=>{finishes.push({actorId,id,result,errorCode});return {id,state:errorCode?'failed':'complete',...(result?{result:result as ParserReviewAnalysis}:{})};}};
 return{gateway,services,calls,finishes,providers:()=>providers,receipt:(v:ParserReviewReceipt)=>{receipt=v;}};
}
test('review admin identity, preview and CSRF gates run before SQL or provider',async()=>{
 for(const actor of [null,{...admin,isAdmin:false}]){const f=fixture(actor);assert.equal((await handleParser(req(),config,f.gateway,f.services)).status,actor?403:401);assert.equal(f.calls.length,0);}
 for(const role of ['admin','trader','spc-trader','manager','credit'] as const){const f=fixture(admin,{role,officeId:'hk',officeName:'Hong Kong',readOnly:true});assert.equal((await handleParser(req(),config,f.gateway,f.services)).status,403);assert.equal(f.calls.length,0);}
 const f=fixture();assert.equal((await handleParser(req('review-ai',identity,{origin:'https://other.test'}),config,f.gateway,f.services)).status,403);assert.equal(f.calls.length,0);
});
test('review strict bounded inputs accept snapshots and reject invented provider/replay proof',()=>{
 assert.deepEqual(reviewIdentity(identity),identity);for(const value of [{...identity,expectedRevision:-1},{...identity,expectedRevision:'1'},{...identity,rawText:'override'},{...identity,dataMode:'test'},{...identity,generation:admin.id}])assert.throws(()=>reviewIdentity(value));
 for(const action of ['approve','complete','replay','reopen']){const body={...identity,action,...(action==='approve'?{expected:snapshot,notes:''}:action==='complete'?{aiRequestId:admin.id}:{})};assert.equal(reviewInput(body).action,action);assert.throws(()=>reviewInput({...body,result:{status:'matched'}}));}
 assert.throws(()=>reviewInput({...identity,action:'approve',expected:{...snapshot,viscosity:['120']},notes:''}));assert.throws(()=>reviewInput({...identity,action:'approve',expected:{...snapshot,rmk:'true'},notes:''}));
 const report={requestId:identity.requestId,rawText:evidence.rawText,sourceRevision:'one',parserVersion:PARSER_VERSION,dataMode:'live',parsed:snapshot.fields,corrected:snapshot.fields,notes:'',capture:evidence.capture};assert.deepEqual(reportInput(report).capture,evidence.capture);assert.throws(()=>reportInput({...report,capture:{...evidence.capture,serverFingerprint:'invented'}}));
 assert.equal(reportQuery(new URL(config.origin+'/?dataMode=live&stage=pending_ai')).stage,'pending_ai');assert.equal(reportQuery(new URL(config.origin+'/?dataMode=live&id='+identity.reportId)).id,identity.reportId);for(const query of ['dataMode=live&stage=resolved','dataMode=live&id='+identity.reportId+'&stage=reviewed'])assert.throws(()=>reportQuery(new URL(config.origin+'/?'+query)));
});
test('review uses only stored approved evidence and durably finishes before returning successful analysis',async()=>{
 const f=fixture();const response=await handleParser(req(),config,f.gateway,f.services);assert.equal(response.status,200);const result=await response.json();assert.equal(result.reportId,identity.reportId);assert.equal(result.revision,1);assert.equal(result.model,'gpt-6-luna');assert.equal(f.providers(),1);assert.equal(f.finishes.length,1);assert.deepEqual(f.calls[0],{name:'eco_begin_parser_review',args:{p_input:{...identity,kind:'ai'}}});
});
test('completed/pending/failed durable receipts never repeat the provider and uncertain finalization stays pending',async()=>{
 const result={...analysis,...identity,revision:1,model:'fixture'};
 for(const state of ['pending','complete','failed'] as const){const f=fixture();f.receipt({id:identity.requestId,state,runProvider:false,...(state==='complete'?{result}:{})});const response=await handleParser(req(),config,f.gateway,f.services);assert.equal(response.status,state==='complete'?200:state==='pending'?409:503);assert.equal(f.providers(),0);assert.equal(f.finishes.length,0);}
 const f=fixture();f.services.finishReview=async()=>{throw new Error('secret sentinel');};const response=await handleParser(req(),config,f.gateway,f.services);assert.equal(response.status,503);assert.equal((await response.json()).operationState,'pending');assert.equal(f.providers(),1);
});
test('definitive provider rejection stores failure and does not authorize completion',async()=>{
 const f=fixture();f.services.reviewProvider=()=>({model:'fixture',analyze:async()=>{throw new Error('secret sentinel');}});const response=await handleParser(req(),config,f.gateway,f.services);assert.equal(response.status,503);const body=await response.json();assert.equal(body.operationState,'failed');assert.doesNotMatch(JSON.stringify(body),/sentinel/);assert.deepEqual(f.finishes,[{actorId:admin.id,id:identity.requestId,result:null,errorCode:'REVIEW_FAILED'}]);
});
test('replay executes raw-only trusted helper and sends result only through service completion',async()=>{
 const f=fixture();f.receipt({id:identity.requestId,state:'pending',runProvider:true,evidence:{...evidence,workflow:{...evidence.workflow,stage:'reviewed'}}});const response=await handleParser(req('review',{...identity,action:'replay'}),config,f.gateway,f.services);assert.equal(response.status,200);assert.equal(f.providers(),0);const stored=(f.finishes[0] as {result:{actual:typeof snapshot;executedWith:{buildFingerprint:string};provenance:{reportId:string}}}).result;assert.equal(stored.actual.fields.vessel,'FIXTURE');assert.match(stored.executedWith.buildFingerprint,/^[0-9a-f]{64}$/);assert.equal(stored.provenance.reportId,identity.reportId);
});
test('review provider uses bounded structured output with no tools/storage and excludes unrelated report/history/actor fields',async()=>{
 let outbound:any;const provider=createParserReviewProvider({OPENAI_API_KEY:'fixture-secret',OPENAI_PARSER_MODEL:'gpt-6-luna'},async(url,options)=>{assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(options?.redirect,'error');assert.ok(options?.signal);outbound=JSON.parse(String(options?.body));return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(analysis)}]}]}));});
 assert.deepEqual(await provider.analyze(evidence),analysis);assert.equal(outbound.store,false);assert.equal(outbound.tools,undefined);assert.equal(outbound.max_output_tokens,3500);assert.equal(outbound.text.format.strict,true);const data=JSON.parse(outbound.input[0].content[0].text);assert.deepEqual(data.approved,snapshot);assert.equal(data.notes,'Approved note');assert.equal(data.history,undefined);assert.equal(data.createdBy,undefined);assert.doesNotMatch(JSON.stringify(outbound),/fixture-secret/);
});
test('review provider rejects unknown/oversized/malformed output and refusals instead of accepting completion',async()=>{
 for(const bad of [{...analysis,code:'execute'},{...analysis,diagnosis:''},{...analysis,regressionExamples:Array(6).fill(analysis.regressionExamples[0])},{...analysis,warnings:['x'.repeat(1001)]}])assert.throws(()=>validateReviewAnalysis(bad));
 for(const payload of [{status:'incomplete',output:[]},{status:'completed',output:[{type:'message',content:[{type:'refusal'}]}]},{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'bad json'}]}]}]){const provider=createParserReviewProvider({OPENAI_API_KEY:'fixture',OPENAI_PARSER_MODEL:'gpt-6-luna'},async()=>new Response(JSON.stringify(payload)));await assert.rejects(provider.analyze(evidence));}
});

test('full bounded capture accepts repeated source snapshots above the old 64KiB envelope without relaxing AI FIX limits',async()=>{
 const long={...snapshot,standardText:'x'.repeat(19000)};const body={requestId:identity.requestId,rawText:'x'.repeat(19000),sourceRevision:'one',parserVersion:PARSER_VERSION,dataMode:'live',parsed:snapshot.fields,corrected:snapshot.fields,notes:'',capture:{original:{...long,warnings:['x'.repeat(1900),'x'.repeat(1900),'x'.repeat(1900)]},submitted:{...long,warnings:['x'.repeat(1900),'x'.repeat(1900),'x'.repeat(1900)]},originalRevision:'original',parseOrigin:'initial'}};
 assert.ok(Buffer.byteLength(JSON.stringify(body))>65536);const f=fixture();assert.equal((await handleParser(req('reports',body),config,f.gateway,f.services)).status,200);assert.equal((await handleParser(req('fix',body),config,f.gateway,f.services)).status,413);
});
