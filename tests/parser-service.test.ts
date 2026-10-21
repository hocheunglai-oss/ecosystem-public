import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AccessUser, RolePreview } from '../shared/access.ts';
import type { AuthConfig } from '../server/auth/config.ts';
import type { AdministrationGateway } from '../server/admin/handler.ts';
import { ApiError } from '../server/auth/validation.ts';
import { handleParser, type ParserServices, type ParserReceipt } from '../server/parser/handler.ts';
import { createParserProvider, produceSuggestions, validateExtraction } from '../server/parser/provider.ts';
import { fixInput, reportInput, reportQuery } from '../server/parser/validation.ts';
import { applicableSuggestions, emptyParserFields, PARSER_VERSION, type ParserFixInput, type ParserFixResult } from '../shared/parserService.ts';
const config: AuthConfig = { origin: 'https://eco.example.test', supabaseUrl: 'https://example.supabase.co', publishableKey: 'fixture', secretKey: 'fixture', rateLimitSecret: 'fixture-only', secureCookies: true };
const user: AccessUser = { id: '11111111-1111-4111-8111-111111111111', email: 'trader@example.test', displayName: 'Trader', officeId: 'HONG KONG', officeName: 'Hong Kong', isAdmin: false, isManager: false, isSpcTrader: false, isActive: true, activated: true, passwordChangeSuggested: false, revision: 1 };
const input: ParserFixInput = { requestId: '22222222-2222-4222-8222-222222222222', rawText: 'Vessel: ALPHA\nPort: Singapore\nVLSFO 450 MT\nETA: 15 OCT 2026', current: emptyParserFields(), sourceRevision: 'source-v1', parserVersion: PARSER_VERSION, dataMode: 'live' };
const extraction = { fields: { ...emptyParserFields(), vessel: 'ALPHA', portText: 'Singapore', vlsfo: '450' }, evidence: { ...emptyParserFields(), vessel: 'ALPHA', portText: 'Singapore', vlsfo: '450 MT' }, warnings: [] };
function fixture(actor: AccessUser | null = user, preview: RolePreview | null = null) {
  const calls: { name: string; args?: Record<string, unknown> }[] = [], finishes: unknown[] = [];
  let providerCalls = 0;
  let receipt: ParserReceipt = { id: input.requestId, state: 'pending', runProvider: true };
  const gateway: AdministrationGateway = { cookies: [], currentUser: async () => actor, getPreview: async () => preview, authenticatedRpc: async <T>(name: string, args?: Record<string, unknown>) => { calls.push({ name, args }); return (name === 'eco_begin_parser_ai' ? receipt : { items: [], nextCursor: null, id: input.requestId }) as T; } };
  const services: ParserServices = { provider: () => ({ model: 'fixture-model', extract: async () => { providerCalls++; return extraction; } }), finish: async (actorId, requestId, result, errorCode) => { finishes.push({ actorId, requestId, result, errorCode }); return { id: requestId, state: result ? 'complete' : 'failed', ...(result ? { result } : {}) }; } };
  return { gateway, services, calls, finishes, providerCalls: () => providerCalls, receipt: (value: ParserReceipt) => { receipt = value; } };
}
function request(path = 'fix', body: unknown = input, extra: Record<string, string> = {}) { return new Request(`${config.origin}/api/parser/${path}`, { method: 'POST', headers: { origin: config.origin, 'content-type': 'application/json', 'x-eco-request': '1', ...extra }, body: JSON.stringify(body) }); }
test('parser denies anonymous and every preview before provider or SQL; reports list is admin-only', async () => {
  const anon = fixture(null); assert.equal((await handleParser(request(), config, anon.gateway, anon.services)).status, 401); assert.equal(anon.calls.length, 0);
  for (const role of ['admin','trader','spc-trader','manager','credit'] as const) { const f = fixture({ ...user, isAdmin: true }, { role, officeId: 'HONG KONG', officeName: 'Hong Kong', readOnly: true }); for (const req of [request(), new Request(config.origin + '/api/parser/reports?dataMode=live')]) assert.equal((await handleParser(req, config, f.gateway, f.services)).status, 403); assert.equal(f.calls.length, 0); }
  const f = fixture(); assert.equal((await handleParser(new Request(config.origin + '/api/parser/reports?dataMode=live'), config, f.gateway, f.services)).status, 403); assert.equal(f.providerCalls(), 0);
});
test('CSRF, JSON, methods, version, input size and unknown fields fail before receipt/provider', async () => {
  for (const headers of [{origin:'https://evil.test'},{'x-eco-request':'0'},{'sec-fetch-site':'cross-site'},{'content-type':'text/plain'}]) { const f = fixture(); assert.ok([403,415].includes((await handleParser(request('fix', input, headers as Record<string,string>), config, f.gateway, f.services)).status)); assert.equal(f.calls.length, 0); }
  for (const body of [null, [], {...input,actorId:user.id}, {...input,rawText:'界'.repeat(7000)}, {...input,parserVersion:'old'}, {...input,current:{...input.current,price:123}}]) { const f = fixture(); assert.ok([400,409].includes((await handleParser(request('fix', body),config,f.gateway,f.services)).status)); assert.equal(f.providerCalls(),0); }
  const f=fixture(); assert.equal((await handleParser(new Request(config.origin+'/api/parser/fix',{method:'DELETE'}),config,f.gateway,f.services)).status,405);
});
test('missing dedicated key or selected model fails closed without provider request', async () => {
  for (const environment of [{}, {OPENAI_API_KEY:'fixture'}, {OPENAI_PARSER_MODEL:'fixture-model'}]) assert.throws(()=>createParserProvider(environment), /not configured/);
  const f=fixture();f.services.provider=()=>createParserProvider({});assert.equal((await handleParser(request(),config,f.gateway,f.services)).status,503);assert.equal(f.calls.length,1);assert.equal((f.finishes[0] as any).errorCode,'CONFIGURATION_UNAVAILABLE');
});
test('successful extraction uses authenticated actor, server hash and durable completion before response', async () => {
  const f=fixture();f.gateway.cookies.push('eco-auth=fixture; HttpOnly; Secure');const response=await handleParser(request(),config,f.gateway,f.services);assert.equal(response.status,200);const data=await response.json();assert.equal(data.requestId,input.requestId);assert.equal(data.sourceRevision,input.sourceRevision);assert.equal(data.sourceHash,createHash('sha256').update(input.rawText).digest('hex'));assert.equal(f.providerCalls(),1);assert.equal(f.finishes.length,1);assert.equal((f.finishes[0] as any).actorId,user.id);assert.match(response.headers.get('set-cookie')!,/HttpOnly/);assert.match(response.headers.get('cache-control')!,/no-store/);assert.equal((f.calls[0].args?.p_input as any).sourceHash,data.sourceHash);
});
test('pending and terminal receipts never issue a duplicate model call', async () => {
  const result=await produceSuggestions(fixture().services.provider(),fixInput(input));
  for(const receipt of [{id:input.requestId,state:'pending',runProvider:false},{id:input.requestId,state:'failed',runProvider:false},{id:input.requestId,state:'complete',runProvider:false,result}] as ParserReceipt[]){const f=fixture();f.receipt(receipt);f.services.provider=()=>{throw new Error('provider configuration removed');};const response=await handleParser(request(),config,f.gateway,f.services);assert.equal(response.status,receipt.state==='complete'?200:receipt.state==='pending'?409:503);assert.equal(f.providerCalls(),0);assert.equal(f.finishes.length,0);}
});
test('provider errors are bounded and uncertain completion never claims success', async () => {
  const f=fixture();f.services.provider=()=>({model:'fixture',extract:async()=>{throw new Error('secret-sentinel');}});const response=await handleParser(request(),config,f.gateway,f.services);assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/sentinel/);assert.equal((f.finishes[0] as any).errorCode,'PROVIDER_FAILED');
  const uncertain=fixture();uncertain.services.finish=async()=>{throw new Error('private-db-sentinel');};const failed=await handleParser(request(),config,uncertain.gateway,uncertain.services);assert.equal(failed.status,503);assert.equal((await failed.json()).operationState,'pending');
  const quota=fixture();quota.gateway.authenticatedRpc=async()=>{throw new ApiError(429,'Too many requests.');};const limited=await handleParser(request(),config,quota.gateway,quota.services);assert.equal(limited.status,429);assert.equal(limited.headers.get('retry-after'),'60');assert.equal(quota.providerCalls(),0);
});
test('provider request is source-only, strict, bounded, no tools and store false', async () => {
  let outbound: any;
  const provider=createParserProvider({OPENAI_API_KEY:'synthetic-provider-key',OPENAI_PARSER_MODEL:'operator-selected-model'},async(url, options)=>{assert.equal(url,'https://api.openai.com/v1/responses');outbound=JSON.parse(String(options?.body));assert.equal(options?.redirect,'error');assert.ok(options?.signal);return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(extraction)}]}]}));});
  await provider.extract(input.rawText);assert.equal(outbound.store,false);assert.equal(outbound.model,'operator-selected-model');assert.equal(outbound.text.format.strict,true);assert.equal(outbound.max_output_tokens,2200);assert.equal(outbound.tools,undefined);assert.equal(outbound.input[0].content[0].text,input.rawText);assert.equal(outbound.current,undefined);assert.doesNotMatch(JSON.stringify(outbound),/synthetic-provider-key|trader@example/);
});
test('strict output rejects extra fields, fabricated evidence, bad quantities and refusal/incomplete replies', async () => {
  for(const bad of [{...extraction,price:1},{...extraction,fields:{...extraction.fields,vlsfo:'-450'}},{...extraction,evidence:{...extraction.evidence,vessel:'NOT IN SOURCE'}},{...extraction,fields:{...extraction.fields,imo:'123'}}])assert.throws(()=>validateExtraction(bad,input.rawText));
  for(const payload of [{status:'incomplete',output:[]},{status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'secret-sentinel'}]}]},{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'not JSON'}]}]}]){const p=createParserProvider({OPENAI_API_KEY:'fixture',OPENAI_PARSER_MODEL:'fixture'},async()=>new Response(JSON.stringify(payload)));await assert.rejects(p.extract(input.rawText),/unchanged/);}
});
test('manual fields, changed values and changed source revision cannot be applied', async () => {
  const result=await produceSuggestions(fixture().services.provider(),fixInput(input));
  assert.equal(applicableSuggestions(result,'new-revision',input.current,input.current,new Set()).length,0);
  assert.ok(!applicableSuggestions(result,input.sourceRevision,input.current,input.current,new Set(['vessel'])).some(item=>item.field==='vessel'));
  assert.ok(!applicableSuggestions(result,input.sourceRevision,input.current,{...input.current,vessel:'MANUAL'},new Set()).some(item=>item.field==='vessel'));
  assert.ok(applicableSuggestions(result,input.sourceRevision,input.current,input.current,new Set()).some(item=>item.field==='vessel'));
});
test('test generation and report lineage are explicit and keyset cursors reject malformed boundaries',()=>{
  assert.throws(()=>fixInput({...input,dataMode:'test'}));assert.throws(()=>fixInput({...input,generation:user.id}));assert.equal(fixInput({...input,dataMode:'test',generation:user.id}).generation,user.id);
  const {current,...common}=input;const report={...common,parsed:current,corrected:extraction.fields,notes:'Correction'};assert.equal(reportInput(report).rawText,input.rawText);assert.throws(()=>reportInput({...report,createdBy:user.id}));assert.throws(()=>reportInput({...report,notes:'x'.repeat(2001)}));
  assert.equal(reportQuery(new URL(config.origin+'/?dataMode=live&cursor='+encodeURIComponent('2026-10-15T08:30:00.123Z|'+user.id))).cursor,'2026-10-15T08:30:00.123Z|'+user.id);assert.doesNotThrow(()=>reportQuery(new URL(config.origin+'/?dataMode=live&cursor='+encodeURIComponent('2026-10-15 08:30:00.123+00|'+user.id))));for(const query of ['dataMode=test','dataMode=live&limit=51','dataMode=live&cursor=bad','dataMode=live&dataMode=test'])assert.throws(()=>reportQuery(new URL(config.origin+'/?'+query)));
});
test('shared parser discards invalid calendar dates and AI-normalized non-MT quantities', async () => {
  for (const [rawText, field, value, quote] of [['Vessel: ALPHA\nETA: 31 April 2026','eta','31 April 2026','31 April 2026'],['Vessel: ALPHA\nVLSFO 450 KG','vlsfo','450','450 KG']] as const) {
    const provider={model:'fixture',extract:async()=>({fields:{...emptyParserFields(),[field]:value},evidence:{...emptyParserFields(),[field]:quote},warnings:[]})};
    const result=await produceSuggestions(provider,fixInput({...input,rawText}));
    assert.ok(!result.suggestions.some(item=>item.field===field),field);
  }
});


test('AI normalization retains RMK and viscosity source cautions even when it omits those remarks', async () => {
  const rawText = input.rawText + '\nRemarks: No RMK required; check 120 CST / 180 CST';
  const provider = { model: 'fixture', extract: async () => extraction };
  const result = await produceSuggestions(provider, fixInput({ ...input, rawText }));
  assert.ok(result.suggestions.some(item => item.field === 'vlsfo' && item.value === '450'));
  assert.ok(result.warnings.some(warning => /^WARNING: 120 \/ 180 \/ RMK spotted/.test(warning)));
});

test('AI cannot remove CBM warnings or reintroduce compact or split-line non-MT quantities', async () => {
  for (const product of ['VLSFO 450CBM', 'VLSFO 450\nCBM', 'VLSFO 450\nUnit: CBM']) {
    const rawText = input.rawText.replace('VLSFO 450 MT', product);
    const provider = { model: 'fixture', extract: async () => ({ ...extraction, evidence: { ...extraction.evidence, vlsfo: '450' } }) };
    const result = await produceSuggestions(provider, fixInput({ ...input, rawText }));
    assert.ok(!result.suggestions.some(item => item.field === 'vlsfo'), product);
    const warnings = result.warnings.filter(warning => /CBM|non-MT quantity unit/.test(warning));
    assert.equal(warnings.length, 1, product);
    assert.match(warnings[0], /^WARNING: CBM spotted\..*non-MT quantity unit/, product);
  }
});
