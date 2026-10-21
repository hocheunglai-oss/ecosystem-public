import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {ecoConnections} from '../config/ecoConnections.ts';
import {whatsappConfig, WhatsAppError, type WhatsAppPins} from '../server/inbox-whatsapp/config.ts';
import {handleWhatsAppWebhook, whatsappInputs, validWhatsAppSignature, isWhatsAppControl, MAX_WEBHOOK_BYTES, MAX_CHALLENGE_BYTES, MAX_VERIFICATION_QUERY_BYTES, MAX_VERIFICATION_QUERY_ENTRIES, type WhatsAppGetDiagnostic, type WhatsAppInput, type WhatsAppDependencies, type WhatsAppRequest} from '../server/inbox-whatsapp/handler.ts';

const pins: WhatsAppPins = {businessPortfolioId:'900000000000001',appId:'900000000000002',accountId:'900000000000003',phoneNumberId:'900000000000004',displayPhoneNumber:'+85290000001',sourceId:'11111111-1111-4111-8111-111111111111',graphApiVersion:'v23.0',identityNamespace:'meta-whatsapp-signed-v1'};
const env = {VERCEL_ENV:'production',ECO_ORIGIN:ecoConnections.productionOrigin,VERCEL_PROJECT_ID:ecoConnections.vercel.projectId,VERCEL_ORG_ID:ecoConnections.vercel.teamId,ECO_SUPABASE_URL:`https://${ecoConnections.supabaseProjectRef}.supabase.co`,ECO_SUPABASE_SECRET_KEY:'synthetic-database-key',ECO_WHATSAPP_VERIFY_TOKEN:'synthetic_verification_token_1234567890',ECO_WHATSAPP_APP_SECRET:'a'.repeat(32),ECO_WHATSAPP_ENABLED:'true',ECO_WHATSAPP_SUBSCRIPTION_VERIFIED:'true'};
const config=whatsappConfig(env,'delivery',pins);
const now=Date.UTC(2026,9,20,8);
const message=(id='one',extra:Record<string,unknown>={})=>({id:`wamid.${id}`,from:'85290000002',timestamp:String(now/1000),type:'text',text:{body:'MV SYNTHETIC HORIZON / SINGAPORE / 500 MT VLSFO'},...extra});
const change=(messages:unknown[],extra:Record<string,unknown>={})=>({field:'messages',value:{messaging_product:'whatsapp',metadata:{phone_number_id:pins.phoneNumberId,display_phone_number:'+852 9000 0001'},contacts:[{wa_id:'85290000002'}],messages,...extra}});
const envelope=(messages:unknown[])=>({object:'whatsapp_business_account',entry:[{id:pins.accountId,changes:[change(messages)]}]});
function request(payload:unknown):WhatsAppRequest {
 const body=Buffer.from(typeof payload==='string'?payload:JSON.stringify(payload));
 return {method:'POST',url:'/api/enquiries/whatsapp',body,headers:new Headers({'content-type':'application/json','x-hub-signature-256':`sha256=${createHmac('sha256',env.ECO_WHATSAPP_APP_SECRET).update(body).digest('hex')}`})};
}
function fixture(ingest?:(input:WhatsAppInput,signal:AbortSignal)=>Promise<unknown>){
 const calls:WhatsAppInput[]=[],diagnostics:WhatsAppGetDiagnostic[]=[];let stores=0;
 const deps:WhatsAppDependencies={diagnoseGetRejection:value=>diagnostics.push(value),configure:(environment,phase)=>whatsappConfig(environment,phase,pins),store:()=>{stores++;return {ingest:async(input,signal)=>{calls.push(input);return (ingest?await ingest(input,signal):{id:'22222222-2222-4222-8222-222222222222',status:'accepted',duplicate:false}) as never;}};}};
 return {calls,deps,diagnostics,stores:()=>stores,run:(req:WhatsAppRequest,environment=env,options:Parameters<typeof handleWhatsAppWebhook>[3]={})=>handleWhatsAppWebhook(req,environment,deps,{now:()=>now,...options})};
}

test('configuration requires every verified provider pin, exact ECO deployment and independent credentials',()=>{
 for(const field of ['businessPortfolioId','appId','accountId','phoneNumberId','sourceId','graphApiVersion'] as const)assert.throws(()=>whatsappConfig(env,'delivery',{...pins,[field]:null}),/not_configured/);
 for(const field of ['VERCEL_ENV','ECO_ORIGIN','VERCEL_PROJECT_ID','VERCEL_ORG_ID','ECO_SUPABASE_URL','ECO_SUPABASE_SECRET_KEY','ECO_WHATSAPP_VERIFY_TOKEN','ECO_WHATSAPP_APP_SECRET','ECO_WHATSAPP_ENABLED','ECO_WHATSAPP_SUBSCRIPTION_VERIFIED'])assert.throws(()=>whatsappConfig({...env,[field]:''},'delivery',pins),/not_configured/);
 assert.throws(()=>whatsappConfig(env,'delivery',{...pins,identityNamespace:'email'}),/not_configured/);
 assert.throws(()=>whatsappConfig(env,'delivery',{...pins,displayPhoneNumber:'85290000001'}),/not_configured/);
});
test('challenge setup works before activation without DB or app secret; token/query values stay strict',async()=>{
 const f=fixture();const query=`?hub.mode=subscribe&hub.verify_token=${env.ECO_WHATSAPP_VERIFY_TOKEN}&hub.challenge=123456789`;
 const base={method:'GET',url:`/api/enquiries/whatsapp${query}`,headers:new Headers(),body:Buffer.alloc(0)};
 const disabled={...env,ECO_WHATSAPP_ENABLED:'false',ECO_WHATSAPP_SUBSCRIPTION_VERIFIED:'false',ECO_WHATSAPP_APP_SECRET:'',ECO_SUPABASE_URL:'',ECO_SUPABASE_SECRET_KEY:''};
 const ok=await f.run(base,disabled);assert.equal(ok.status,200);assert.equal(await ok.text(),'123456789');assert.match(ok.headers.get('content-type')!,/^text\/plain/);assert.equal(f.stores(),0);
 for(const url of [base.url+'&hub.mode=subscribe',base.url.replace('hub.challenge=123456789','hub.challenge=%00'),base.url.replace('hub.mode=subscribe','hub.mode=unsubscribe')])assert.equal((await f.run({...base,url},disabled)).status,400);
 assert.equal((await f.run({...base,url:base.url.replace(env.ECO_WHATSAPP_VERIFY_TOKEN,'wrong')},disabled)).status,403);
 assert.equal((await f.run({...base,body:Buffer.from('body')},disabled)).status,400);
});
test('Meta provider query fields are ignored within limits while required decoded values stay unique',async()=>{
 const f=fixture();const challenge='123456789',secretMarker='SYNTHETIC_IGNORED_PRIVATE';
 const required={'hub.mode':'subscribe','hub.verify_token':env.ECO_WHATSAPP_VERIFY_TOKEN,'hub.challenge':challenge};
 const base={method:'GET',url:'/api/enquiries/whatsapp?'+new URLSearchParams(required),headers:new Headers(),body:Buffer.alloc(0)};
 const extra=`&provider_one=${secretMarker}&provider_two=2&provider_three=3`;
 for(const suffix of [extra,'&provider_one='+secretMarker+'&provider_one=another']){
  const response=await f.run({...base,url:base.url+suffix});assert.equal(response.status,200);assert.equal(await response.text(),challenge);
 }
 assert.deepEqual(f.diagnostics,[],'Ignored provider values are not logged on success');
 for(const key of Object.keys(required)){
  const missing=new URLSearchParams(required);missing.delete(key);
  assert.equal((await f.run({...base,url:'/api/enquiries/whatsapp?'+missing+extra})).status,400);
  for(const duplicate of [key,key.replace('.', '%2E')])assert.equal((await f.run({...base,url:base.url+extra+'&'+duplicate+'='+secretMarker})).status,400);
 }
 const wrong=await f.run({...base,url:(base.url+extra).replace(env.ECO_WHATSAPP_VERIFY_TOKEN,'wrong')});assert.equal(wrong.status,403);assert.equal(await wrong.text(),'{"error":"forbidden"}');
 const atEntries=base.url+Array.from({length:MAX_VERIFICATION_QUERY_ENTRIES-3},(_,i)=>`&provider_${i}=x`).join('');
 assert.equal((await f.run({...base,url:atEntries})).status,200);
 assert.equal((await f.run({...base,url:atEntries+'&one_more=x'})).status,400);assert.equal(f.diagnostics.at(-1)?.reason,'query_bounds');
 const padded=base.url+'&provider_padding=';
 const padding=MAX_VERIFICATION_QUERY_BYTES-Buffer.byteLength(new URL(padded,'https://eco.invalid').search,'utf8');
 const atBytes=padded+'x'.repeat(padding);assert.equal(Buffer.byteLength(new URL(atBytes,'https://eco.invalid').search,'utf8'),MAX_VERIFICATION_QUERY_BYTES);
 assert.equal((await f.run({...base,url:atBytes})).status,200);
 assert.equal((await f.run({...base,url:atBytes+'x'})).status,400);assert.equal(f.diagnostics.at(-1)?.reason,'query_bounds');
 const encoded=base.url+'&provider_padding='+encodeURIComponent('港'.repeat(1000));assert.equal((await f.run({...base,url:encoded})).status,400,'Encoded query bytes are bounded before reading optional values');
 assert.doesNotMatch(JSON.stringify(f.diagnostics),new RegExp(`${secretMarker}|${env.ECO_WHATSAPP_VERIFY_TOKEN}|provider_one|provider_padding`));
 assert.equal(f.stores(),0);assert.equal(f.calls.length,0);
 const post=request(envelope([]));assert.equal((await f.run({...post,url:post.url+'?provider_one=x'})).status,400,'POST still rejects every query string');
});
test('Meta challenges remain opaque exact plain text, with UTF8 bounds and no control characters',async()=>{
 const f=fixture();const disabled={...env,ECO_WHATSAPP_ENABLED:'false',ECO_WHATSAPP_SUBSCRIPTION_VERIFIED:'false'};
 const base={method:'GET',headers:new Headers(),body:Buffer.alloc(0)};
 const url=(challenge:string)=>'/api/enquiries/whatsapp?'+new URLSearchParams({'hub.mode':'subscribe','hub.verify_token':env.ECO_WHATSAPP_VERIFY_TOKEN,'hub.challenge':challenge});
 for(const challenge of ['-123456','random-opaque_challenge=+/','<script>synthetic</script>','港 🚢','a'.repeat(MAX_CHALLENGE_BYTES),'🚢'.repeat(MAX_CHALLENGE_BYTES/4)]){
  const response=await f.run({...base,url:url(challenge)},disabled);assert.equal(response.status,200);assert.equal(await response.text(),challenge);
  assert.equal(response.headers.get('content-type'),'text/plain; charset=utf-8');assert.equal(response.headers.get('x-content-type-options'),'nosniff');
 }
 assert.equal(f.diagnostics.length,0);
 for(const challenge of ['', '\0', '\r\n', '\u007f', '\u0085', 'a'.repeat(MAX_CHALLENGE_BYTES+1),'🚢'.repeat(MAX_CHALLENGE_BYTES/4+1)])assert.equal((await f.run({...base,url:url(challenge)},disabled)).status,400);
 assert.equal(f.stores(),0);assert.ok(f.diagnostics.every(row=>row.reason==='challenge'));
});
test('GET rejection diagnostics are bounded shape only and never alter auth or POST behavior',async()=>{
 const f=fixture(), marker='SYNTHETIC_PRIVATE_VALUE';
 const query=new URLSearchParams({'hub.mode':'subscribe','hub.verify_token':env.ECO_WHATSAPP_VERIFY_TOKEN,'hub.challenge':marker});
 const base={method:'GET',url:'/api/enquiries/whatsapp?'+query,headers:new Headers(),body:Buffer.alloc(0)};
 assert.equal((await f.run({...base,url:base.url.replace('hub.mode','ignored')+'&'+marker+'='+marker})).status,400);
 assert.deepEqual(f.diagnostics.at(-1),{event:'eco_whatsapp_get_rejected',reason:'query_shape',status:400,hasOrigin:false,hasSecFetchSite:false,hasDataMode:false,queryEntryCount:4,queryKeyCount:4,unexpectedQuery:true,repeatedRequiredQuery:false,challengeLength:marker.length,challengeFormat:'opaque',bodyBytes:0});
 assert.equal((await f.run({...base,url:base.url+'&hub.challenge='+marker})).status,400);assert.equal(f.diagnostics.at(-1)?.repeatedRequiredQuery,true);
 assert.equal((await f.run({...base,url:base.url.replace(env.ECO_WHATSAPP_VERIFY_TOKEN,marker)})).status,403);assert.equal(f.diagnostics.at(-1)?.reason,'token_mismatch');
 for(const [header,flag] of [['origin','hasOrigin'],['sec-fetch-site','hasSecFetchSite'],['x-eco-data-mode','hasDataMode']] as const){assert.equal((await f.run({...base,headers:new Headers({[header]:marker})})).status,400);assert.equal(f.diagnostics.at(-1)?.reason,'browser_context');assert.equal(f.diagnostics.at(-1)?.[flag],true);assert.equal(['hasOrigin','hasSecFetchSite','hasDataMode'].filter(key=>f.diagnostics.at(-1)?.[key as keyof WhatsAppGetDiagnostic]===true).length,1);}
 assert.equal((await f.run({...base,url:base.url.replace('hub.mode=subscribe','hub.mode=unsubscribed')})).status,400);assert.equal(f.diagnostics.at(-1)?.reason,'mode');
 assert.equal((await f.run({...base,url:base.url+'&'+Array.from({length:50},(_,i)=>`${marker}${i}=${marker}`).join('&')})).status,400);assert.equal(f.diagnostics.at(-1)?.queryEntryCount,16);assert.equal(f.diagnostics.at(-1)?.queryKeyCount,16);
 assert.equal((await f.run({...base,body:Buffer.alloc(MAX_WEBHOOK_BYTES+500,120)})).status,400);assert.equal(f.diagnostics.at(-1)?.bodyBytes,MAX_WEBHOOK_BYTES+1);
 assert.equal((await f.run(base,{...env,ECO_WHATSAPP_VERIFY_TOKEN:''})).status,503);assert.equal(f.diagnostics.at(-1)?.reason,'configuration');
 assert.doesNotMatch(JSON.stringify(f.diagnostics),new RegExp(`${marker}|${env.ECO_WHATSAPP_VERIFY_TOKEN}|hub\\.|/api/|origin|sec-fetch|data-mode`));
 const count=f.diagnostics.length;assert.equal((await f.run(request(envelope([])))).status,200);assert.equal((await f.run({...request(envelope([])),url:'/wrong'})).status,400);assert.equal(f.diagnostics.length,count,'POST never emits GET diagnostics');
 f.deps.diagnoseGetRejection=()=>{throw new Error(marker);};assert.equal((await f.run({...base,url:base.url+'&hub.mode=subscribe'})).status,400);
 assert.equal((await f.run({...base,url:'http://['})).status,503,'Malformed diagnostic URLs cannot throw or replace the normal error response.');
});
test('disabled/unverified delivery rejects before constructing store',async()=>{
 const f=fixture();for(const key of ['ECO_WHATSAPP_ENABLED','ECO_WHATSAPP_SUBSCRIPTION_VERIFIED'])assert.equal((await f.run(request(envelope([message()])),{...env,[key]:'false'})).status,503);
 assert.equal(f.stores(),0);
});
test('signature covers exact bytes and never accepts altered content, malformed signatures or old-app credentials',async()=>{
 const f=fixture();const r=request(envelope([message()]));assert.equal(validWhatsAppSignature(r.body,r.headers.get('x-hub-signature-256'),env.ECO_WHATSAPP_APP_SECRET),true);
 for(const signature of [null,'sha256=bad',r.headers.get('x-hub-signature-256')+', sha256='+'a'.repeat(64),'sha1='+'a'.repeat(40)]){const headers=new Headers(r.headers);if(signature===null)headers.delete('x-hub-signature-256');else headers.set('x-hub-signature-256',signature);assert.equal((await f.run({...r,headers})).status,401);}
 assert.equal((await f.run({...r,body:Buffer.concat([r.body,Buffer.from(' ')])})).status,401);
 assert.equal(validWhatsAppSignature(r.body,r.headers.get('x-hub-signature-256'),'b'.repeat(32)),false);
 assert.equal(f.calls.length,0);
});
test('all matching entries and changes are ingested with trusted configuration fields only',async()=>{
 const f=fixture();const value=envelope([message('one',{ownerId:'attacker',dataMode:'test',generation:'fake'})]);
 value.entry.push({id:pins.accountId,changes:[change([message('two')]),change([message('three')])]});
 const result=await f.run(request(value));assert.equal(result.status,200);assert.deepEqual(await result.json(),{received:true});
 assert.deepEqual(f.calls.map(x=>x.messageId),['wamid.one','wamid.two','wamid.three']);
 assert.deepEqual(Object.keys(f.calls[0]).sort(),['sourceId','provider','accountId','destinationId','messageId','senderIdentity','identityNamespace','rawText','receivedAt'].sort());
 assert.equal(f.calls[0].provider,'meta-whatsapp-cloud');assert.equal(f.calls[0].receivedAt,'2026-10-20T08:00:00.000Z');
});
test('wrong accounts/phones never ingest, and known metadata mismatch rejects whole batch',async()=>{
 const f=fixture();const other=envelope([message()]);other.entry[0].id='900000000009999';assert.equal((await f.run(request(other))).status,200);
 const phone=envelope([message()]);phone.entry[0].changes[0].value.metadata={phone_number_id:'900000000009999',display_phone_number:'unrelated'};assert.equal((await f.run(request(phone))).status,200);
 const bad=envelope([message('before')]);bad.entry[0].changes.push(change([message('after')],{metadata:{phone_number_id:pins.phoneNumberId,display_phone_number:'+85290000999'}}));assert.equal((await f.run(request(bad))).status,400);assert.equal(f.calls.length,0);
});
test('statuses, interactive replies, SPC acknowledgement tokens and isolated OTPs are not enquiries',async()=>{
 const controls=['OK',' ok ','MOBILE_RECEIVE_private-token','RECEIVE_private-token','123456','OTP: 123456','Verification code 123456','LOGIN 123456'];
 const f=fixture();const value=envelope([...controls.map((body,i)=>message(String(i),{text:{body}})),message('button',{type:'button',button:{payload:'RECEIVE_private-token'}}),message('interactive',{type:'interactive'}),message('reaction',{type:'reaction'}),message('system',{type:'system'})]);
 Object.assign(value.entry[0].changes[0].value,{statuses:[{id:'wamid.outbound',status:'delivered'}]});
 assert.equal((await f.run(request(value))).status,200);assert.equal(f.calls.length,0);assert.equal(f.stores(),0);
 assert.equal(isWhatsAppControl('MV TEST / 123456 MT / SINGAPORE'),false);
});
test('media captions and download references remain contentless; no outbound or provider request is available',async()=>{
 const f=fixture();const rows=['audio','document','image','video','sticker','location','contacts','unknown'].map(type=>message(type,{type,image:{id:'private-media-id',caption:'PRIVATE CAPTION',url:'https://not-fetched.example'}}));
 assert.equal((await f.run(request(envelope(rows)))).status,200);assert.equal(f.calls.length,8);
 assert.ok(f.calls.every(x=>x.rawText===''&&x.quarantineReason));assert.doesNotMatch(JSON.stringify(f.calls),/PRIVATE CAPTION|private-media-id|not-fetched/);
});
test('BSUIDs, malformed phones, mismatched contacts and invalid text produce contentless quarantine',async()=>{
 const f=fixture();const rows=[message('bsuid',{from:'US.1234567890'}),message('long-id',{from:'12345678901234567890'}),message('plus',{from:'+85290000002'}),message('mismatch',{from:'85290000003'}),message('empty',{text:{body:'  '}}),message('nul',{text:{body:'secret\0text'}}),message('surrogate',{text:{body:'secret\ud800'}}),message('oversized',{text:{body:'港'.repeat(7000)}})];
 assert.equal((await f.run(request(envelope(rows)))).status,200);assert.ok(f.calls.every(x=>x.rawText===''));assert.equal(f.calls[0].senderIdentity,'');assert.equal(f.calls.at(-1)?.quarantineReason,'oversized');
});
test('signed text supports unicode and forwards without trusting quoted identities',async()=>{
 const f=fixture();const raw='From: someone@example.test\nMV 船 🚢 / SINGAPORE / 500 MT VLSFO';
 assert.equal((await f.run(request(envelope([message('forward',{text:{body:raw},context:{forwarded:true}})])))).status,200);
 assert.equal(f.calls[0].senderIdentity,'85290000002');assert.equal(f.calls[0].rawText,raw);
});
test('malformed ids, times, collections, oversized batches and UTF8 are rejected before partial writes',async()=>{
 const f=fixture();for(const bad of [message('bad',{id:'not-a-wamid'}),message('bad',{timestamp:'yesterday'}),message('bad',{timestamp:String(now/1000+301)}),message('bad',{timestamp:now/1000}),null])assert.equal((await f.run(request(envelope([message('first'),bad])))).status,400);
 assert.equal((await f.run(request(envelope(Array.from({length:101},(_,i)=>message(String(i))))))).status,400);
 assert.equal((await f.run(request({object:'whatsapp_business_account',entry:{}}))).status,400);
 assert.equal((await f.run(request('{'))).status,400);
 const utf8=request(envelope([]));utf8.body=Buffer.from([0xff]);utf8.headers.set('x-hub-signature-256',`sha256=${createHmac('sha256',env.ECO_WHATSAPP_APP_SECRET).update(utf8.body).digest('hex')}`);assert.equal((await f.run(utf8)).status,400);
 assert.equal(f.calls.length,0);
});
test('request bounds and browser/TEST entry restrictions are enforced',async()=>{
 const f=fixture();const base=request(envelope([]));
 assert.equal((await f.run({...base,body:Buffer.alloc(MAX_WEBHOOK_BYTES+1)})).status,413);
 for(const [key,value] of [['origin','https://eco.example.test'],['sec-fetch-site','same-origin'],['x-eco-data-mode','test'],['content-encoding','gzip'],['content-type','text/plain']]){const headers=new Headers(base.headers);headers.set(key,value);assert.equal((await f.run({...base,headers})).status,400);}
 assert.equal((await f.run({...base,url:'/api/enquiries/whatsapp?extra=1'})).status,400);
 assert.equal((await f.run({...base,method:'PUT'})).status,405);assert.equal(f.calls.length,0);
});
test('partial storage failures return retryable status, replay stable IDs and never acknowledge unfinished work',async()=>{
 const saved=new Set<string>();let fail=true;let duplicates=0;
 const f=fixture(async(input)=>{if(input.messageId==='wamid.two'&&fail){fail=false;throw new Error('SQL diagnostic PRIVATE');}const duplicate=saved.has(input.messageId);if(duplicate)duplicates++;saved.add(input.messageId);return {id:'22222222-2222-4222-8222-222222222222',status:'accepted',duplicate};});
 const r=request(envelope([message('one'),message('two'),message('three')]));const failed=await f.run(r);assert.equal(failed.status,503);assert.equal(failed.headers.get('retry-after'),'30');assert.doesNotMatch(await failed.text(),/SQL|PRIVATE/);assert.deepEqual([...saved],['wamid.one']);
 assert.equal((await f.run(r)).status,200);assert.equal(saved.size,3);assert.equal(duplicates,1);assert.equal(f.calls[0].receivedAt,f.calls[2].receivedAt);
});
test('deadlines cancel pending work and do not start later messages',async()=>{
 let signal:AbortSignal|undefined;const f=fixture(async(_input,s)=>{signal=s;return new Promise(()=>{});});
 const response=await f.run(request(envelope([message('one'),message('two')])),env,{deadlineMs:15});assert.equal(response.status,503);assert.equal(signal?.aborted,true);assert.equal(f.calls.length,1);
 const aborted=new AbortController();aborted.abort();assert.equal((await f.run(request(envelope([message()])),env,{signal:aborted.signal})).status,503);assert.equal(f.calls.length,1);
});
test('unexpected RPC response never becomes provider acknowledgement or response data',async()=>{
 for(const receipt of [null,{id:'invalid',status:'accepted',duplicate:false},{id:'22222222-2222-4222-8222-222222222222',status:'accepted',duplicate:'yes'}]){const f=fixture(async()=>receipt);assert.equal((await f.run(request(envelope([message()])))).status,503);}
});
