import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, generateKeyPairSync, verify } from 'node:crypto';
import { ecoConnections } from '../config/ecoConnections.ts';
import { emailConfig, emailReceiverPins, EMAIL_IDENTITY_NAMESPACE, EMAIL_PROVIDER, EmailSyncError, type EmailConfig } from '../server/inbox-email/config.ts';
import { boundedJson, classifyAttachmentMetadata, clientAssertion, deltaUrl, microsoftGraph, retryAfterSeconds, type GraphApi } from '../server/inbox-email/microsoft.ts';
import { cronAuthorized, handleEmailSync, serveEmailSync } from '../server/inbox-email/node.ts';
import { pollEmail, trustedSender, type EmailStore, type SourceLease } from '../server/inbox-email/worker.ts';
const ids={tenantId:'10000000-0000-4000-8000-000000000001',clientId:'20000000-0000-4000-8000-000000000002',mailboxId:'30000000-0000-4000-8000-000000000003',sourceId:'40000000-0000-4000-8000-000000000004'};
const pair=generateKeyPairSync('rsa',{modulusLength:2048});
const config:EmailConfig={...ids,privateKey:pair.privateKey,certificateSha256:'ab'.repeat(32),supabaseUrl:`https://${ecoConnections.supabaseProjectRef}.supabase.co`,supabaseKey:'synthetic-service-key'};
const clock=()=>Date.parse('2026-10-15T12:00:00.000Z');
const folder='INBOX+=fixture';
const cursor=(token='fixture')=>`https://graph.microsoft.com/v1.0/users/${ids.mailboxId}/mailFolders/${encodeURIComponent(folder)}/messages/delta?$deltatoken=${token}`;
const metadata=(id='message-1'):Record<string,unknown>=>({id,receivedDateTime:'2026-10-15T11:30:00Z',hasAttachments:false,sender:{emailAddress:{address:'trader@example.test'}},from:{emailAddress:{address:'trader@example.test'}},internetMessageHeaders:[{name:'X-MS-Exchange-Organization-AuthAs',value:'Internal'},{name:'X-MS-Exchange-CrossTenant-Id',value:ids.tenantId}]});
function fixture(){
 const calls:{name:string;input:Record<string,unknown>}[]=[];const graphCalls:string[]=[];const receipts=new Map<string,{id:string;fingerprint:string}>();let storedCursor:string|null=null;
 const lease:SourceLease={...{sourceId:ids.sourceId},leaseToken:'50000000-0000-4000-8000-000000000005',cursor:null,cutoverAt:'2026-10-15T11:00:00Z',leaseExpiresAt:'2026-10-15T12:02:00Z',provider:EMAIL_PROVIDER,accountId:ids.tenantId,destinationId:ids.mailboxId,identityNamespace:EMAIL_IDENTITY_NAMESPACE};
 const store:EmailStore={async rpc<T>(name,input):Promise<T>{
  calls.push({name,input:structuredClone(input)});
  if(name==='eco_claim_inbox_source')return {...lease,cursor:storedCursor} as T;
  if(name==='eco_resolve_inbox_sender')return {approved:true} as T;
  if(name==='eco_get_inbox_receipt'){const old=receipts.get(String(input.messageId));return (old?{id:old.id,status:'accepted'}:null) as T;}
  if(name==='eco_ingest_enquiry'){
   const key=String(input.messageId);const fingerprint=JSON.stringify({...input,leaseToken:null});const old=receipts.get(key);
   if(old&&old.fingerprint!==fingerprint)throw new Error('payload changed');
   const value=old??{id:`60000000-0000-4000-8000-${String(receipts.size+1).padStart(12,'0')}`,fingerprint};receipts.set(key,value);
   return {id:value.id,status:input.identityVerified===true&&!input.quarantineReason?'accepted':'quarantined',duplicate:Boolean(old)} as T;
  }
  if(name==='eco_checkpoint_inbox_source'){assert.equal(input.expectedCursor,storedCursor);storedCursor=String(input.cursor);return {cursor:storedCursor} as T;}
  return {released:true} as T;
 }};
 const graph:GraphApi={
  async folder(){graphCalls.push('folder');return folder;},
  async delta(){graphCalls.push('delta');return {value:[{id:'message-1',receivedDateTime:'2026-10-15T11:30:00Z'}],'@odata.deltaLink':cursor()};},
  async metadata(id){graphCalls.push('metadata');return metadata(id);},
  async attachments(){graphCalls.push('attachments');return 'none';},
  async body(id){graphCalls.push('body');return {id,subject:'Enquiry',body:{contentType:'text',content:'Vessel ALPHA\nSingapore\nVLSFO 500 MT'}};},
 };
 return {store,graph,calls,graphCalls,lease,receipts,getCursor:()=>storedCursor};
}
function validEnv():NodeJS.ProcessEnv{return {ECO_EMAIL_ENABLED:'true',ECO_EMAIL_HEADER_PROVENANCE_VERIFIED:'true',VERCEL_ENV:'production',ECO_ORIGIN:ecoConnections.productionOrigin,VERCEL_PROJECT_ID:ecoConnections.vercel.projectId,VERCEL_ORG_ID:ecoConnections.vercel.teamId,ECO_SUPABASE_URL:config.supabaseUrl,ECO_SUPABASE_SECRET_KEY:config.supabaseKey,ECO_EMAIL_CERT_SHA256:config.certificateSha256,ECO_EMAIL_PRIVATE_KEY:pair.privateKey.export({type:'pkcs8',format:'pem'}).toString()};}

test('email configuration needs all verified pins, provenance, production identity and independent certificate',()=>{
 assert.equal(emailReceiverPins,ecoConnections.emailReceiver);
 assert.ok(Object.isFrozen(emailReceiverPins));
 assert.equal(emailConfig(validEnv(),ids).tenantId,ids.tenantId);
 const pinned=emailConfig(validEnv());
 for(const field of ['tenantId','clientId','mailboxId','sourceId'] as const){
  assert.equal(pinned[field],ecoConnections.emailReceiver[field]);
  assert.throws(()=>emailConfig(validEnv(),{...ids,[field]:null}),/configuration_error/,field);
 }
 for(const field of Object.keys(validEnv())){const env=validEnv();delete env[field];assert.throws(()=>emailConfig(env,ids),/configuration_error/,field);}
 for(const patch of [{VERCEL_ENV:'preview'},{ECO_SUPABASE_URL:'https://wrong.supabase.co'},{ECO_EMAIL_CERT_SHA256:'ab'.repeat(20)},{ECO_EMAIL_PRIVATE_KEY:'private-key-sentinel'}])assert.throws(()=>emailConfig({...validEnv(),...patch},ids),/configuration_error/);
});

test('certificate assertion is tenant-scoped PS256 with SHA256 thumbprint, unique nonce and short expiry',()=>{
 const value=clientAssertion(config,clock(),'unique-fixture-nonce');const[h,p,s]=value.split('.');const header=JSON.parse(Buffer.from(h,'base64url').toString());const claims=JSON.parse(Buffer.from(p,'base64url').toString());
 assert.deepEqual(header,{alg:'PS256',typ:'JWT','x5t#S256':Buffer.from('ab'.repeat(32),'hex').toString('base64url')});
 assert.equal(claims.aud,`https://login.microsoftonline.com/${ids.tenantId}/oauth2/v2.0/token`);assert.equal(claims.iss,ids.clientId);assert.equal(claims.sub,ids.clientId);assert.equal(claims.exp-claims.iat,300);assert.equal(claims.jti,'unique-fixture-nonce');
 assert.ok(verify('sha256',Buffer.from(`${h}.${p}`),{key:pair.publicKey,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32},Buffer.from(s,'base64url')));
 assert.notEqual(clientAssertion(config),clientAssertion(config));
});

test('delta cursors allow only exact HTTPS Graph mailbox/folder/token paths',()=>{
 assert.equal(deltaUrl(config,folder,cursor()),cursor());
 const variants=[cursor().replace('https:','http:'),cursor().replace('graph.microsoft.com','graph.microsoft.com.evil.test'),cursor().replace('graph.microsoft.com','user@graph.microsoft.com'),cursor().replace(ids.mailboxId,ids.clientId),cursor().replace(encodeURIComponent(folder),'another-folder'),cursor()+'&$expand=attachments',cursor()+'#fragment',cursor().replace('v1.0','beta'),cursor()+'&$deltatoken=duplicate',cursor().replace('/messages/delta','/messages'),cursor()+'\n'];
 variants.push(cursor()+'&$select=body',cursor()+'&$top=1000',cursor()+'&$Select=id,receivedDateTime&$select=id,receivedDateTime');
 for(const value of variants)assert.throws(()=>deltaUrl(config,folder,value),/cursor_invalid/);
 assert.match(deltaUrl(config,folder),/\$select=id,receivedDateTime/);
 const odata=`https://graph.microsoft.com/v1.0/users('${ids.mailboxId}')/mailfolders('${encodeURIComponent(folder)}')/messages/delta?$skiptoken=opaque`;
 assert.equal(deltaUrl(config,folder,odata),odata);
 const ordered=cursor().replace('$deltatoken','$deltaToken')+'&$top=10&$select=receivedDateTime,id';assert.equal(deltaUrl(config,folder,ordered),ordered);
});

test('Graph quoted Inbox cursors accept literal base64 padding only for the exact folder',()=>{
 const inbox='AQMk-verified_inbox==';
 const quoted=`https://graph.microsoft.com/v1.0/users/${ids.mailboxId}/mailFolders('${inbox}')/messages/delta?$deltatoken=opaque`;
 assert.equal(deltaUrl(config,inbox,quoted),quoted);
 const encoded=quoted.replace(inbox,encodeURIComponent(inbox));
 assert.equal(deltaUrl(config,inbox,encoded),encoded);
 for(const invalid of [quoted.replace(inbox,'AQMk-other_inbox=='),quoted.replace(inbox,inbox+'%2Fmessages'),quoted.replace(inbox,inbox+"')/other('"),quoted+'&$select=body'])assert.throws(()=>deltaUrl(config,inbox,invalid),/cursor_invalid/);
});

test('Microsoft transport rejects redirects, bounds responses and surfaces retry delay without retry loops',async()=>{
 const requests:{url:string;init:RequestInit}[]=[];
 const graph=microsoftGraph(config,async(url,init)=>{requests.push({url:String(url),init:init!});return requests.length===1?Response.json({access_token:'synthetic-token',token_type:'Bearer',expires_in:3600}):Response.json({id:folder});},clock,clock()+40000);
 assert.equal(await graph.folder(),folder);assert.equal(await graph.folder(),folder);assert.equal(requests.length,3);
 assert.match(requests[0].url,/^https:\/\/login.microsoftonline.com\//);assert.equal(requests[0].init.redirect,'error');assert.match(String(requests[0].init.body),/client_assertion=/);
 assert.match(requests[1].url,new RegExp(`/users/${ids.mailboxId}/mailFolders/inbox`));assert.equal(requests[1].init.method,'GET');assert.equal(requests[1].init.redirect,'error');assert.match(String((requests[1].init.headers as Record<string,string>).Prefer),/ImmutableId/);
 let calls=0;const limited=microsoftGraph(config,async()=>{calls++;return new Response('do-not-expose',{status:429,headers:{'Retry-After':'3600'}});},clock,clock()+40000);
 await assert.rejects(()=>limited.folder(),(error:unknown)=>error instanceof EmailSyncError&&error.retryAfter===3600);assert.equal(calls,1);
 await assert.rejects(()=>boundedJson(new Response('123456'),5),/response_oversized/);assert.equal(retryAfterSeconds('999999'),86400);assert.equal(retryAfterSeconds('garbage'),60);
});

test('cron endpoint denies browser/session access and remains disabled without touching providers',async()=>{
 const secret='synthetic-cron-secret-with-more-than-32-characters';let calls=0;
 const deps={configure:()=>{calls++;return config;},store:()=>{calls++;return fixture().store;},graph:()=>{calls++;return fixture().graph;}};
 const url='https://eco.example.test/api/enquiries/email-sync';
 for(const header of [undefined,'Bearer wrong',`bearer ${secret}`]){const r=await handleEmailSync(new Request(url,{headers:header?{authorization:header}:{}}),{CRON_SECRET:secret,ECO_EMAIL_ENABLED:'true'},deps);assert.equal(r.status,401);assert.match(r.headers.get('cache-control')!,/no-store/);}
 assert.equal(cronAuthorized(`Bearer ${secret}`,secret),true);
 for(const extra of [{origin:'https://eco.example.test'},{cookie:'session=fixture'},{'sec-fetch-site':'same-origin'}])assert.equal((await handleEmailSync(new Request(url,{headers:{authorization:`Bearer ${secret}`,...extra}}),{CRON_SECRET:secret},deps)).status,400);
 assert.equal((await handleEmailSync(new Request(url,{method:'POST',headers:{authorization:`Bearer ${secret}`}}),{CRON_SECRET:secret},deps)).status,405);
 const disabled=await handleEmailSync(new Request(url,{headers:{authorization:`Bearer ${secret}`}}),{CRON_SECRET:secret},deps);assert.deepEqual(await disabled.json(),{status:'disabled'});assert.equal(calls,0);
 const broken=await handleEmailSync(new Request(url,{headers:{authorization:`Bearer ${secret}`}}),{CRON_SECRET:secret,ECO_EMAIL_ENABLED:'true'},{...deps,configure:()=>{throw new Error('private-sentinel');}});assert.equal(broken.status,503);assert.doesNotMatch(await broken.text(),/private-sentinel/);
});

test('cron rejection diagnostics expose only fixed shape after successful bearer authentication',async(t)=>{
 const secret='synthetic-cron-secret-with-more-than-32-characters';const logs:unknown[][]=[];let calls=0;
 t.mock.method(console,'warn',(...args:unknown[])=>{logs.push(args);});
 const deps={configure:()=>{calls++;return config;},store:()=>{calls++;return fixture().store;},graph:()=>{calls++;return fixture().graph;}};
 const url='https://eco.example.test/api/enquiries/email-sync';const env={CRON_SECRET:secret};
 const unauthorized=await handleEmailSync(new Request(url+'?secret=private-sentinel',{headers:{origin:'https://private-sentinel.example',cookie:'secret=private-sentinel'}}),env,deps);
 assert.equal(unauthorized.status,401);assert.deepEqual(logs,[]);
 const validShape={pathExact:true,queryPresent:false,originPresent:false,originNonempty:false,cookiePresent:false,cookieNonempty:false,fetchSitePresent:false,fetchSiteNonempty:false,cookieKind:'none' as 'none'|'platform_jwt'|'rejected'};
 const cases:[string,Record<string,string>,Partial<typeof validShape>][]=[
  [url+'/private-sentinel',{}, {pathExact:false}],[url+'?secret=private-sentinel',{}, {queryPresent:true}],
  [url,{origin:'https://private-sentinel.example'},{originPresent:true,originNonempty:true}],
  [url,{origin:''},{originPresent:true}],
  [url,{cookie:'session=private-sentinel'},{cookiePresent:true,cookieNonempty:true,cookieKind:'rejected'}],
  [url,{cookie:''},{cookiePresent:true,cookieKind:'rejected'}],
  [url,{'sec-fetch-site':'same-origin'},{fetchSitePresent:true,fetchSiteNonempty:true}],
  [url,{'sec-fetch-site':''},{fetchSitePresent:true}],
 ];
 for(const [target,extra,shape] of cases){
  const response=await handleEmailSync(new Request(target,{headers:{authorization:`Bearer ${secret}`,...extra}}),env,deps);
  assert.equal(response.status,400);assert.deepEqual(await response.json(),{error:'invalid_request'});
  assert.match(response.headers.get('cache-control')!,/no-store/);
  assert.deepEqual(logs.at(-1),[JSON.stringify({event:'eco_email_sync_rejected',...validShape,...shape})]);
 }
 assert.equal(logs.length,cases.length);assert.doesNotMatch(JSON.stringify(logs),/private-sentinel|synthetic-cron-secret|same-origin/);
 const cron=await handleEmailSync(new Request(url,{headers:{authorization:`Bearer ${secret}`,'user-agent':'vercel-cron/1.0','x-vercel-cron-schedule':'* * * * *'}}),env,deps);
 assert.deepEqual(await cron.json(),{status:'disabled'});assert.equal(logs.length,cases.length);assert.equal(calls,0);
});

test('a bounded platform cookie is inert metadata and never substitutes for cron authentication',async(t)=>{
 const secret='synthetic-cron-secret-with-more-than-32-characters';const logs:unknown[][]=[];let calls=0;
 t.mock.method(console,'warn',(...args:unknown[])=>{logs.push(args);});
 const deps={configure:()=>{calls++;return config;},store:()=>{calls++;return fixture().store;},graph:()=>{calls++;return fixture().graph;}};
 const url='https://eco.example.test/api/enquiries/email-sync';const env={CRON_SECRET:secret};
 // Deliberately unsigned fixture: recognizing shape must never imply cryptographic verification.
 const jwt=[Buffer.from('{"alg":"HS256"}').toString('base64url'),Buffer.from('{"sub":"synthetic-platform-only"}').toString('base64url'),'ab'.repeat(21)+'a'].join('.');
 const cookie=`_vercel_jwt=${jwt}`;const metadata={'user-agent':'vercel-cron/1.0','x-vercel-cron-schedule':'* * * * *'};
 for(const authorization of [undefined,'Bearer wrong']){
  const response=await handleEmailSync(new Request(url,{headers:{...metadata,cookie,...authorization?{authorization}:{}}}),env,deps);
  assert.equal(response.status,401);
 }
 assert.deepEqual(logs,[]);
 const accepted=await handleEmailSync(new Request(url,{headers:{...metadata,cookie,authorization:`Bearer ${secret}`}}),env,deps);
 assert.equal(accepted.status,200);assert.deepEqual(await accepted.json(),{status:'disabled'});assert.deepEqual(logs,[]);
 const rejectedCookies=[
  '',`eco_session=fixture; ${cookie}`,`${cookie}; eco_session=fixture`,`${cookie}; unrelated=fixture`,
  `${cookie}; ${cookie}`,`${cookie}, ${cookie}`,`_VERCEL_JWT=${jwt}`,`_vercel_jwt="${jwt}"`,
  '_vercel_jwt=not-a-jwt','_vercel_jwt=aa.bb','_vercel_jwt=aa.bb.', '_vercel_jwt=a.bb.cc',
  '_vercel_jwt=aa.bb.cc.dd','_vercel_jwt=aa=.bb.cc','_vercel_jwt=aa%2Ebb%2Ecc',
  `_vercel_jwt=${'a'.repeat(4096)}.bb.cc`,
 ];
 for(const value of rejectedCookies){
  const response=await handleEmailSync(new Request(url,{headers:{...metadata,cookie:value,authorization:`Bearer ${secret}`}}),env,deps);
  assert.equal(response.status,400);assert.deepEqual(await response.json(),{error:'invalid_request'});
  assert.equal(JSON.parse(String(logs.at(-1)?.[0])).cookieKind,'rejected');
 }
 for(const [target,extra] of [[url+'/other',{}],[url+'?fixture=1',{}],[url,{origin:''}],[url,{origin:'https://eco.example.test'}],[url,{'sec-fetch-site':''}],[url,{'sec-fetch-site':'none'}]] as [string,Record<string,string>][]){
  const response=await handleEmailSync(new Request(target,{headers:{...metadata,cookie,authorization:`Bearer ${secret}`,...extra}}),env,deps);
  assert.equal(response.status,400);
  assert.equal(JSON.parse(String(logs.at(-1)?.[0])).cookieKind,'platform_jwt');
 }
 const post=await handleEmailSync(new Request(url,{method:'POST',headers:{...metadata,cookie,authorization:`Bearer ${secret}`}}),env,deps);assert.equal(post.status,405);
 assert.doesNotMatch(JSON.stringify(logs),/synthetic-platform-only|synthetic-cron-secret|eco_session|unrelated/);
 assert.ok(!JSON.stringify(logs).includes(jwt));assert.equal(calls,0);
});

test('authenticated scheduled request with platform metadata stores one receipt and advances its cursor',async(t)=>{
 t.mock.method(Date,'now',clock);
 const f=fixture();const secret='synthetic-cron-secret-with-more-than-32-characters';
 const deps={configure:()=>config,store:()=>f.store,graph:()=>f.graph};
 const env={CRON_SECRET:secret,ECO_EMAIL_ENABLED:'true'};
 const request=()=>new Request('https://eco.example.test/api/enquiries/email-sync',{headers:{authorization:`Bearer ${secret}`,cookie:'_vercel_jwt=aa.bb.cc','user-agent':'vercel-cron/1.0'}});
 const first=await handleEmailSync(request(),env,deps);
 assert.equal(first.status,200);assert.deepEqual(await first.json(),{status:'complete',pages:1,accepted:1,quarantined:0,duplicates:0,more:false});
 assert.equal(f.receipts.size,1);assert.equal(f.getCursor(),cursor());
 assert.ok(f.calls.findIndex(c=>c.name==='eco_ingest_enquiry')<f.calls.findIndex(c=>c.name==='eco_checkpoint_inbox_source'));
 const replay=await handleEmailSync(request(),env,deps);
 assert.equal(replay.status,200);assert.deepEqual(await replay.json(),{status:'complete',pages:1,accepted:0,quarantined:0,duplicates:1,more:false});
 assert.equal(f.receipts.size,1);assert.equal(f.graphCalls.filter(c=>c==='body').length,1);
});

test('Node cron adapter preserves empty browser headers for rejection',async(t)=>{
 t.mock.method(console,'warn',()=>{});
 const secret='synthetic-cron-secret-with-more-than-32-characters';
 for(const extra of [{origin:''},{'sec-fetch-site':''}]){
  let body='';const headers:Record<string,string>={};
  const request={url:'/api/enquiries/email-sync',method:'GET',headers:{authorization:`Bearer ${secret}`,...extra}} as Parameters<typeof serveEmailSync>[0];
  const response={statusCode:0,setHeader:(name:string,value:string)=>{headers[name]=value;},end:(value:string)=>{body=value;}} as unknown as Parameters<typeof serveEmailSync>[1];
  await serveEmailSync(request,response,{CRON_SECRET:secret});
  assert.equal(response.statusCode,400);assert.deepEqual(JSON.parse(body),{error:'invalid_request'});assert.match(headers['cache-control'],/no-store/);
 }
});

test('trusted sender requires single protected Internal and pinned tenant headers plus matching sender/from',()=>{
 assert.deepEqual(trustedSender(metadata(),ids.tenantId),{identity:'trader@example.test',verified:true});
 for(const change of [
  {internetMessageHeaders:[]},
  {internetMessageHeaders:[...metadata().internetMessageHeaders as unknown[],{name:'x-ms-exchange-organization-authas',value:'Internal'}]},
  {internetMessageHeaders:[{name:'X-MS-Exchange-Organization-AuthAs',value:'Anonymous'},{name:'X-MS-Exchange-CrossTenant-Id',value:ids.tenantId}]},
  {from:{emailAddress:{address:'other@example.test'}}},
 ])assert.equal(trustedSender({...metadata(),...change},ids.tenantId).verified,false);
 assert.equal(trustedSender(metadata(),ids.clientId).verified,false);
});

test('durable receipt precedes cursor and replay after lost checkpoint creates no duplicate enquiry',async()=>{
 const f=fixture();const rpc=f.store.rpc;let fail=true;
 f.store.rpc=async(name,input)=>{if(name==='eco_checkpoint_inbox_source'&&fail){fail=false;throw new Error('unknown-checkpoint-outcome');}return rpc(name,input);};
 await assert.rejects(()=>pollEmail(config,f.store,f.graph,{now:clock}));assert.equal(f.getCursor(),null);assert.equal(f.receipts.size,1);
 const result=await pollEmail(config,f.store,f.graph,{now:clock});assert.equal(result.duplicates,1);assert.equal(result.accepted,0);assert.equal(f.receipts.size,1);assert.equal(f.getCursor(),cursor());
 const ingest=f.calls.findIndex(c=>c.name==='eco_ingest_enquiry');const checkpoint=f.calls.findIndex(c=>c.name==='eco_checkpoint_inbox_source');assert.ok(ingest>=0&&checkpoint>ingest);
 const saved=f.calls.find(c=>c.name==='eco_ingest_enquiry')!.input;assert.equal(saved.identityVerified,true);assert.equal(saved.rawText,'Vessel ALPHA\nSingapore\nVLSFO 500 MT');assert.equal(saved.leaseToken,f.lease.leaseToken);
});

test('untrusted or unmapped staff gets metadata-only quarantine with no body or attachment read',async()=>{
 for(const mapped of [false,true]){
  const f=fixture();if(mapped)f.graph.metadata=async()=>({...metadata(),internetMessageHeaders:[]});else {const rpc=f.store.rpc;f.store.rpc=async(name,input)=>name==='eco_resolve_inbox_sender'?{approved:false} as never:rpc(name,input);}
  const result=await pollEmail(config,f.store,f.graph,{now:clock});assert.equal(result.quarantined,1);assert.ok(!f.graphCalls.includes('body'));assert.ok(!f.graphCalls.includes('attachments'));
  const input=f.calls.find(c=>c.name==='eco_ingest_enquiry')!.input;assert.equal(input.rawText,'');assert.equal(input.subject,undefined);assert.equal(input.identityVerified,false);
 }
});

test('attachments, HTML, blank and oversized UTF8 bodies quarantine without storing content',async()=>{
 for(const [reason,body]of [['unsupported_attachment','secret attachment'],['unsupported_body','<p>private</p>'],['oversized','🙂'.repeat(5001)],['malformed_message','  ']] as const){
  const f=fixture();if(reason==='unsupported_attachment')f.graph.attachments=async()=>'unsupported';
  f.graph.body=async id=>({id,subject:'private-subject',body:{contentType:reason==='unsupported_body'?'html':'text',content:body}});
  const result=await pollEmail(config,f.store,f.graph,{now:clock});assert.equal(result.quarantined,1);
  const input=f.calls.find(c=>c.name==='eco_ingest_enquiry')!.input;assert.equal(input.quarantineReason,reason);assert.equal(input.rawText,'');assert.equal(input.subject,undefined);assert.ok(!JSON.stringify(input).includes('private-subject'));
 }
});

test('malicious next link, invalid saved cursor, changed source and failed receipt never advance a cursor',async()=>{
 for(const kind of ['next','cursor','source','receipt']){
  const f=fixture();if(kind==='next')f.graph.delta=async()=>({value:[],'@odata.deltaLink':'https://evil.test/steal'});
  if(kind==='cursor'){const rpc=f.store.rpc;f.store.rpc=async(name,input)=>name==='eco_claim_inbox_source'?{...f.lease,cursor:'https://evil.test/steal'} as never:rpc(name,input);}
  if(kind==='source')f.lease.accountId=ids.clientId;
  if(kind==='receipt'){const rpc=f.store.rpc;f.store.rpc=async(name,input)=>{if(name==='eco_ingest_enquiry')throw new EmailSyncError('lease_conflict');return rpc(name,input);};}
  await assert.rejects(()=>pollEmail(config,f.store,f.graph,{now:clock}));assert.equal(f.getCursor(),null);assert.ok(!f.calls.some(c=>c.name==='eco_checkpoint_inbox_source'));assert.equal(f.calls.at(-1)?.name,'eco_release_inbox_source');
 }
});

test('deleted and pre-cutover metadata are skipped; page checkpoints and batch count are bounded',async()=>{
 const f=fixture();let pages=0;f.graph.delta=async()=>({value:[{'@removed':{reason:'deleted'},id:'old'}, {id:'old-2',receivedDateTime:'2026-10-14T11:00:00Z'}],'@odata.nextLink':cursor(String(++pages)).replace('$deltatoken','$skiptoken')});
 const result=await pollEmail(config,f.store,f.graph,{now:clock});assert.equal(result.pages,3);assert.equal(result.more,true);assert.equal(pages,3);assert.equal(result.accepted,0);assert.ok(!f.graphCalls.includes('metadata'));assert.equal(f.calls.filter(c=>c.name==='eco_checkpoint_inbox_source').length,3);
});

test('deadline and throttling preserve cursor and release only the current fence',async()=>{
 const f=fixture();await assert.rejects(()=>pollEmail(config,f.store,f.graph,{now:clock,deadline:clock()-1}),/deadline/);assert.equal(f.getCursor(),null);assert.equal(f.calls.at(-1)?.input.leaseToken,f.lease.leaseToken);
 const throttled=fixture();throttled.graph.delta=async()=>{throw new EmailSyncError('provider_error',120);};await assert.rejects(()=>pollEmail(config,throttled.store,throttled.graph,{now:clock}),(e:unknown)=>e instanceof EmailSyncError&&e.retryAfter===120);assert.equal(throttled.getCursor(),null);
});


test('provider retry delay is persisted on release so the next cron cannot ignore Retry-After',async()=>{
 const f=fixture();f.graph.delta=async()=>{throw new EmailSyncError('provider_error',7200);};
 await assert.rejects(()=>pollEmail(config,f.store,f.graph,{now:clock}));
 assert.deepEqual(f.calls.at(-1)?.input,{sourceId:ids.sourceId,leaseToken:f.lease.leaseToken,errorCode:'provider_error',retryAfterSeconds:7200});
});

test('a removed message is quarantined with only stable metadata and does not block the page',async()=>{
 const f=fixture();f.graph.metadata=async()=>{throw new EmailSyncError('message_unavailable');};
 const result=await pollEmail(config,f.store,f.graph,{now:clock});assert.equal(result.quarantined,1);assert.equal(f.getCursor(),cursor());
 const input=f.calls.find(c=>c.name==='eco_ingest_enquiry')!.input;assert.equal(input.quarantineReason,'message_unavailable');assert.equal(input.rawText,'');assert.equal(input.subject,undefined);assert.equal(input.senderIdentity,'');
});

test('only message-specific Graph404 is classified as missing; missing mailbox remains an error',async()=>{
 for(const message of [false,true]){
  let calls=0;const graph=microsoftGraph(config,async()=>++calls===1?Response.json({access_token:'fixture',token_type:'Bearer',expires_in:3600}):new Response('',{status:404}),clock,clock()+40000);
  await assert.rejects(()=>message?graph.metadata('missing'):graph.folder(),(e:unknown)=>e instanceof EmailSyncError&&e.code===(message?'message_unavailable':'provider_error'));
 }
});


test('durable receipt lookup preserves original attribution after binding revocation and skips body reread',async()=>{
 const f=fixture();const rpc=f.store.rpc;let checkpointFails=true;
 f.store.rpc=async(name,input)=>{if(name==='eco_checkpoint_inbox_source'&&checkpointFails){checkpointFails=false;throw new Error('lost-checkpoint');}return rpc(name,input);};
 await assert.rejects(()=>pollEmail(config,f.store,f.graph,{now:clock}));
 f.graphCalls.length=0;f.store.rpc=async(name,input)=>{if(name==='eco_resolve_inbox_sender')throw new Error('revoked-binding-must-not-reinterpret-receipt');return rpc(name,input);};
 const result=await pollEmail(config,f.store,f.graph,{now:clock});assert.equal(result.duplicates,1);assert.ok(!f.graphCalls.includes('metadata'));assert.ok(!f.graphCalls.includes('body'));assert.equal(f.receipts.size,1);assert.equal(f.getCursor(),cursor());
});

test('SQL-incompatible control characters are quarantined and unsafe subject values are omitted',async()=>{
 const malformed=fixture();malformed.graph.body=async id=>({id,subject:'safe',body:{contentType:'text',content:'private\u0001text'}});
 await pollEmail(config,malformed.store,malformed.graph,{now:clock});assert.equal(malformed.calls.find(c=>c.name==='eco_ingest_enquiry')!.input.quarantineReason,'malformed_message');
 const subject=fixture();subject.graph.body=async id=>({id,subject:'unsafe\nsubject',body:{contentType:'text',content:'ordinary enquiry\nSingapore'}});
 const result=await pollEmail(config,subject.store,subject.graph,{now:clock});assert.equal(result.accepted,1);assert.equal(subject.calls.find(c=>c.name==='eco_ingest_enquiry')!.input.subject,undefined);
});


test('non-UTF8 surrogate text is quarantined and oversized UTF8 subjects are not persisted',async()=>{
 const bad=fixture();bad.graph.body=async id=>({id,body:{contentType:'text',content:'broken\ud800'}});await pollEmail(config,bad.store,bad.graph,{now:clock});assert.equal(bad.calls.find(c=>c.name==='eco_ingest_enquiry')!.input.quarantineReason,'malformed_message');
 const long=fixture();long.graph.body=async id=>({id,subject:'漢'.repeat(500),body:{contentType:'text',content:'Vessel ALPHA\nSingapore'}});await pollEmail(config,long.store,long.graph,{now:clock});assert.equal(long.calls.find(c=>c.name==='eco_ingest_enquiry')!.input.subject,undefined);
});


const inlineImage = (id='signature-logo', patch:Record<string,unknown>={}) => ({
 '@odata.type':'#microsoft.graph.fileAttachment',id,isInline:true,contentType:'image/png',size:2048,...patch,
});

test('complete inline image metadata is allowed within individual, aggregate and count limits',()=>{
 assert.equal(classifyAttachmentMetadata({value:[]}), 'none');
 for(const contentType of ['image/png','image/jpeg','image/gif','image/webp','IMAGE/PNG'])
  assert.equal(classifyAttachmentMetadata({value:[inlineImage('logo',{contentType})]}), 'inline-images');
 assert.equal(classifyAttachmentMetadata({value:[inlineImage('logo',{'@odata.type':'microsoft.graph.fileAttachment'})]}),'inline-images');
 assert.equal(classifyAttachmentMetadata({value:Array.from({length:10},(_,i)=>inlineImage(`logo-${i}`))}),'inline-images');
 assert.equal(classifyAttachmentMetadata({value:Array.from({length:4},(_,i)=>inlineImage(`logo-${i}`,{size:512*1024}))}),'inline-images');
 assert.equal(classifyAttachmentMetadata({value:Array.from({length:11},(_,i)=>inlineImage(`logo-${i}`))}),'unsupported');
 assert.equal(classifyAttachmentMetadata({value:Array.from({length:5},(_,i)=>inlineImage(`logo-${i}`,{size:512*1024}))}),'unsupported');
});

test('documents, embedded items, incomplete pages and uncertain attachment metadata remain unsupported',()=>{
 const rejected:Record<string,unknown>[]=[
  {},{value:null},{value:{}},{value:[null]},{value:[[]]},
  {value:[], '@odata.nextLink':'https://graph.microsoft.com/next'},
  {value:[inlineImage()], '@odata.nextLink':'https://untrusted.example/attachment-content'},
  {value:[inlineImage()], '@odata.nextLink':null},
  {value:[inlineImage()], '@odata.deltaLink':'opaque'},
  {value:[inlineImage(),inlineImage()]},
 ];
 for(const patch of [
  {'@odata.type':'#microsoft.graph.itemAttachment'},{'@odata.type':'#microsoft.graph.referenceAttachment'},
  {'@odata.type':'#microsoft.graph.attachment'},{'@odata.type':undefined},{'@odata.type':['#microsoft.graph.fileAttachment']},
  {isInline:false},{isInline:'true'},{isInline:undefined},
  {contentType:'application/pdf'},{contentType:'image/svg+xml'},{contentType:'image/png;name=logo'},
  {contentType:undefined},{id:''},{id:'bad\nidentifier'},{id:'x'.repeat(1025)},
  {size:undefined},{size:'2048'},{size:0},{size:-1},{size:1.5},{size:Infinity},{size:512*1024+1},
  {contentBytes:'unexpected-content-must-not-be-retained'},{item:{body:'unexpected-embedded-message'}},
 ])rejected.push({value:[inlineImage('logo',patch)]});
 for(const value of rejected)assert.equal(classifyAttachmentMetadata(value),'unsupported',JSON.stringify(value));
});

test('Graph signature inspection requests only one bounded metadata page and never follows attachment links',async()=>{
 for(const response of [{value:[inlineImage()]},{value:[inlineImage()], '@odata.nextLink':'https://untrusted.example/never-fetch'}]){
  const calls:{url:URL;init:RequestInit}[]=[];
  const graph=microsoftGraph(config,async(url,init)=>{
   calls.push({url:new URL(String(url)),init:init!});
   return calls.length===1?Response.json({access_token:'fixture',token_type:'Bearer',expires_in:3600}):Response.json(response);
  },clock,clock()+40000);
  assert.equal(await graph.attachments('message-1'), '@odata.nextLink' in response?'unsupported':'inline-images');
  assert.equal(calls.length,2,'Only token and single metadata collection requests are permitted');
  const attachment=calls[1];assert.equal(attachment.init.method,'GET');
  assert.equal(attachment.url.origin,'https://graph.microsoft.com');
  assert.equal(attachment.url.pathname,`/v1.0/users/${ids.mailboxId}/messages/message-1/attachments`);
  assert.equal(attachment.url.searchParams.get('$select'),'id,isInline,contentType,size');
  assert.equal(attachment.url.searchParams.get('$top'),'11');
  assert.deepEqual([...attachment.url.searchParams.keys()].sort(),['$select','$top']);
  assert.doesNotMatch(attachment.url.href,/contentBytes|\$value|\$expand|\/item/);
 }
});

test('approved inline signatures allow only plaintext ingestion after sender preflight',async()=>{
 const f=fixture(),trace:string[]=[];const rpc=f.store.rpc;
 f.store.rpc=async(name,input)=>{trace.push(name);return rpc(name,input);};
 f.graph.metadata=async id=>{trace.push('metadata');return metadata(id);};
 f.graph.attachments=async()=>{trace.push('attachments');return classifyAttachmentMetadata({value:[inlineImage()]});};
 f.graph.body=async id=>{trace.push('body');return {id,body:{contentType:'text',content:'Vessel ALPHA\nSingapore\nVLSFO 500 MT'}};};
 const result=await pollEmail(config,f.store,f.graph,{now:clock});assert.equal(result.accepted,1);assert.equal(result.quarantined,0);
 assert.ok(trace.indexOf('metadata')<trace.indexOf('eco_resolve_inbox_sender'));
 assert.ok(trace.indexOf('eco_resolve_inbox_sender')<trace.indexOf('attachments'));
 assert.ok(trace.indexOf('attachments')<trace.indexOf('body'));
 assert.ok(trace.indexOf('body')<trace.indexOf('eco_ingest_enquiry'));
 const saved=f.calls.find(c=>c.name==='eco_ingest_enquiry')!.input;
 assert.equal(saved.rawText,'Vessel ALPHA\nSingapore\nVLSFO 500 MT');assert.equal(saved.quarantineReason,undefined);
 assert.doesNotMatch(JSON.stringify(saved),/signature-logo|fileAttachment|isInline|image\/png/);
});

test('unsupported or uncertain attachment collections quarantine before body access',async()=>{
 for(const attachmentList of [
  {value:[inlineImage('pdf',{contentType:'application/pdf'})]},
  {value:[inlineImage('ordinary-photo',{isInline:false})]},
  {value:[inlineImage()], '@odata.nextLink':'opaque'},
  {value:Array.from({length:11},(_,i)=>inlineImage(`logo-${i}`))},
 ]){
  const f=fixture();f.graph.attachments=async()=>classifyAttachmentMetadata(attachmentList);
  const result=await pollEmail(config,f.store,f.graph,{now:clock});assert.equal(result.quarantined,1);assert.equal(result.accepted,0);
  assert.ok(!f.graphCalls.includes('body'));
  const saved=f.calls.find(c=>c.name==='eco_ingest_enquiry')!.input;
  assert.equal(saved.quarantineReason,'unsupported_attachment');assert.equal(saved.rawText,'');assert.equal(saved.subject,undefined);
  assert.ok(f.getCursor(),'Durable quarantine still allows the page checkpoint');
 }
});

test('non-inline or missing attachment flags remain closed even if an inline-only list is claimed',async()=>{
 for(const hasAttachments of [true,undefined,'false']){
  const f=fixture();f.graph.metadata=async id=>({...metadata(id),hasAttachments});
  f.graph.attachments=async()=>{throw new Error('Substantive or uncertain flag must not be overridden by another read');};
  const result=await pollEmail(config,f.store,f.graph,{now:clock});assert.equal(result.quarantined,1);assert.ok(!f.graphCalls.includes('body'));
  assert.equal(f.calls.find(c=>c.name==='eco_ingest_enquiry')!.input.quarantineReason,'unsupported_attachment');
 }
});
