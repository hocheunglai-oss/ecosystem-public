import { applySchemaMigrations } from './fixtures/migrations.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,readdir,rm} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
const exec=promisify(execFile),lit=v=>`'${String(v).replaceAll("'","''")}'`,json=v=>`${lit(JSON.stringify(v))}::jsonb`;
const owners=[randomUUID(),randomUUID(),randomUUID()],sessions=owners.map(()=>randomUUID()),sourceId=randomUUID(),emailSource=randomUUID();
const payload=extra=>({sourceId,provider:'fixture-whatsapp',accountId:'fixture-account',destinationId:'fixture-destination',messageId:randomUUID(),senderIdentity:'verified-1',identityNamespace:'fixture-provider-v1',identityVerified:true,rawText:'  SYNTHETIC ENQUIRY\nPORT: SINGAPORE\nVLSFO 100MT\n',receivedAt:'2026-10-15T10:00:00.000Z',...extra});
test('shared LIVE inbox SQL on isolated native PostgreSQL17',async t=>{
 const bin=process.env.ECO_NATIVE_PG_BIN;assert.ok(bin&&isAbsolute(bin),'Set trusted native PG17 bin; no remote fallback.');assert.match((await exec(join(bin,'postgres'),['--version'])).stdout,/PostgreSQL\) 17\./);
 const root=await mkdtemp(join(tmpdir(),'eco-inbox-pg-')),socket=join(root,'socket'),data=join(root,'data');await mkdir(socket,{mode:0o700});
 const env={PATH:process.env.PATH,LANG:'C',LC_ALL:'C',PGPASSFILE:join(root,'none')};let started=false;
 const query=async sql=>(await exec(join(bin,'psql'),['-X','-q','-A','-t','--no-password','-h',socket,'-p','55495','-U','eco_fixture','-d','postgres','-v','ON_ERROR_STOP=1','-c',sql],{env})).stdout.trim();
 const as=(i,sql,extra={})=>query(`begin;set local role authenticated;do $$begin perform set_config('request.jwt.claims',${lit(JSON.stringify({sub:owners[i],session_id:sessions[i],aal:'aal1',...extra}))},true);end$$;${sql};commit;`);
 const call=async(i,name,input)=>JSON.parse(await as(i,`select public.${name}(${json(input)})`));
 const svc=async(name,input)=>JSON.parse(await query(`begin;set local role service_role;select coalesce(public.${name}(${json(input)}),'null'::jsonb);commit;`));
 const ingest=input=>svc('eco_ingest_enquiry',input),list=(i,extra={})=>call(i,'eco_list_enquiry_inbox',{dataMode:'live',...extra}),mutate=(i,extra)=>call(i,'eco_mutate_enquiry_inbox',{dataMode:'live',requestId:randomUUID(),...extra});
 const seed=async()=>{
  await query(`truncate eco_private.inbox_mutations,eco_private.inbox_messages,eco_private.inbox_sender_bindings,eco_private.inbox_sources;truncate auth.users cascade;
   insert into auth.users(id,email,email_confirmed_at,encrypted_password) values ${owners.map((id,i)=>`(${lit(id)},${lit(`fixture-${i}@example.test`)},now(),'synthetic')`).join(',')};
   update eco_private.users set office_id='hk',display_name='Fixture Owner',is_active=true,activated_at=now(),is_admin=id=${lit(owners[0])};
   insert into auth.sessions(id,user_id) values ${owners.map((id,i)=>`(${lit(sessions[i])},${lit(id)})`).join(',')};
   insert into eco_private.inbox_sources(id,provider,account_id,destination_id,channel,identity_namespace,enabled,provisioned_at,scopes_verified_at,cutover_at,sender_authority) values
    (${lit(sourceId)},'fixture-whatsapp','fixture-account','fixture-destination','whatsapp','fixture-provider-v1',true,now(),now(),'2026-10-01','manual'),
    (${lit(emailSource)},'microsoft-graph','fixture-tenant','fixture-mailbox','email','exchange-authenticated-internal-v1',true,now(),now(),'2026-10-01','manual');
   insert into eco_private.inbox_sender_bindings(source_id,sender_identity,sender_display,owner_id,enabled,verified_at) values
    (${lit(sourceId)},'verified-1','Fixture Sender One',${lit(owners[1])},true,now()),(${lit(sourceId)},'verified-2','Fixture Sender Two',${lit(owners[2])},true,now()),
    (${lit(emailSource)},'fixture1@example.test','Fixture Sender One',${lit(owners[1])},true,now());`);
 };
 try{
  await exec(join(bin,'initdb'),['-D',data,'-U','eco_fixture','-A','trust','--no-locale','--encoding=UTF8'],{env});
  await exec(join(bin,'pg_ctl'),['-D',data,'-l',join(root,'server.log'),'-o',`-k ${socket} -p 55495 -c listen_addresses=''`,'-w','start'],{env});started=true;
  assert.equal(await query("select current_setting('listen_addresses')"),'');assert.equal(await query('select inet_server_addr() is null'),'t');
  await query(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
   create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,encrypted_password text,raw_app_meta_data jsonb not null default '{}');
   create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),not_after timestamptz);
   create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
   create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
   grant usage on schema auth to authenticated,service_role;grant execute on function auth.uid(),auth.jwt() to authenticated,service_role;`);
    await applySchemaMigrations(query);
  await query("insert into eco_private.offices values('hk','Hong Kong'),('sg','Singapore') on conflict do nothing");
  await t.test('deployment provisions no source; private tables and service RPCs deny browser roles',async()=>{
   assert.equal(await query('select count(*) from eco_private.inbox_sources'),'0');
   for(const table of ['inbox_sources','inbox_sender_bindings','inbox_messages','inbox_mutations']){
    assert.equal(await query(`select relrowsecurity from pg_class where oid='eco_private.${table}'::regclass`),'t');
    for(const role of ['anon','authenticated','service_role'])await assert.rejects(query(`set role ${role};select * from eco_private.${table}`),/permission denied/);
   }
   for(const role of ['anon','authenticated'])for(const name of ['eco_ingest_enquiry','eco_ingest_whatsapp_enquiry','eco_claim_inbox_source','eco_checkpoint_inbox_source','eco_release_inbox_source','eco_resolve_inbox_sender','eco_get_inbox_receipt'])await assert.rejects(query(`set role ${role};select public.${name}('{}')`),/permission denied/);
   for(const name of ['eco_list_enquiry_inbox','eco_mutate_enquiry_inbox'])await assert.rejects(query(`set role anon;select public.${name}('{}')`),/permission denied/);
   await assert.rejects(query("set role service_role;select eco_private.inbox_unread(null)"),/permission denied/);
  });
  await t.test('exact source configuration and explicit live scope fail closed',async()=>{
   await seed();const input=payload();
   for(const changes of [{sourceId:randomUUID()},{provider:'other'},{accountId:'other'},{destinationId:'other'},{identityNamespace:'untrusted'}])await assert.rejects(ingest({...input,...changes}),/unavailable|mismatch/);
   await query(`update eco_private.inbox_sources set enabled=false where id=${lit(sourceId)}`);await assert.rejects(ingest(input),/unavailable/);
   for(const dataMode of [undefined,null,'test','LIVE',{}])for(const name of ['eco_list_enquiry_inbox','eco_mutate_enquiry_inbox'])await assert.rejects(call(1,name,{...(dataMode===undefined?{}:{dataMode}),...(name.includes('mutate')?{requestId:randomUUID(),action:'dismiss-all'}:{})}),/Switch to LIVE/);
   assert.equal(await query('select count(*) from eco_private.inbox_messages'),'0');
  });
  await t.test('owner-only items and unread totals, including administrators and CREDIT office',async()=>{
   await seed();const original=payload(),first=await ingest(original);await ingest(payload({senderIdentity:'verified-2'}));
   const page=await list(1);assert.equal(page.unreadCount,1);assert.equal(page.items.length,1);assert.equal(page.items[0].id,first.id);assert.equal(page.items[0].owner,owners[1]);assert.equal(page.items[0].rawText,original.rawText);assert.equal(page.items[0].sender,'Fixture Sender One');assert.equal(page.items[0].read,false);assert.equal(page.items[0].dismissed,false);
   assert.deepEqual(await list(0),{items:[],nextCursor:null,unreadCount:0});assert.equal((await list(2)).items.length,1);
   for(const i of [0,2])await assert.rejects(mutate(i,{action:'read',id:first.id}),/not found/);
   await query(`update eco_private.users set office_id='CREDIT' where id=${lit(owners[1])}`);assert.equal((await list(1)).items.length,1);
  });
  await t.test('VIEW AS, revoked, inactive, expired and MFA sessions cannot expose or mutate live items',async()=>{
   await seed();await ingest(payload({senderIdentity:'verified-2'}));await as(0,"select public.eco_set_preview('trader','hk')");
   assert.deepEqual(await list(0),{items:[],nextCursor:null,unreadCount:0});await assert.rejects(mutate(0,{action:'dismiss-all'}),/read.only/);
   for(const sql of [`update eco_private.users set is_active=false where id=${lit(owners[2])}`,`update auth.sessions set not_after=now()-interval '1 second' where id=${lit(sessions[2])}`,`insert into eco_private.revoked_sessions(session_id,user_id) values(${lit(sessions[2])},${lit(owners[2])})`,`update eco_private.users set mfa_required=true where id=${lit(owners[2])}`,`update auth.users set email_confirmed_at=null where id=${lit(owners[2])}`]){
    await seed();await query(sql);await assert.rejects(list(2),/Unauthorized/);await assert.rejects(mutate(2,{action:'dismiss-all'}),/Unauthorized/);
   }
  });
  await t.test('concurrent delivery retry has one durable record; altered replays conflict and bindings never reroute it',async()=>{
   await seed();const input=payload();const replies=await Promise.all(Array.from({length:8},()=>ingest(input)));assert.equal(replies.filter(r=>!r.duplicate).length,1);assert.equal(new Set(replies.map(r=>r.id)).size,1);
   const timeZoneReplay=JSON.parse(await query(`begin;set local role service_role;set local timezone='Asia/Hong_Kong';select public.eco_ingest_enquiry(${json(input)});commit;`));assert.equal(timeZoneReplay.duplicate,true,'Canonical content fingerprint must not depend on database session timezone.');
   for(const changes of [{rawText:'altered'},{receivedAt:'2026-10-15T10:00:01.000Z'},{senderIdentity:'verified-2'},{subject:'changed'},{identityVerified:false}])await assert.rejects(ingest({...input,...changes}),/delivery conflict/);
   await query(`update eco_private.inbox_sender_bindings set owner_id=${lit(owners[2])} where source_id=${lit(sourceId)} and sender_identity='verified-1'`);assert.equal((await ingest(input)).duplicate,true);assert.equal((await list(1)).items.length,1);assert.equal((await list(2)).items.length,0);
   assert.equal(await query('select count(*) from eco_private.inbox_messages'),'1');
  });
  await t.test('unknown, ambiguous, unverified and inactive senders quarantine privately without body or subject',async()=>{
   await seed();const unknown=await ingest(payload({senderIdentity:'unknown',subject:'Private subject'}));assert.equal(unknown.reason,'unknown_sender');
   const unverified=await ingest(payload({senderIdentity:'',identityVerified:false,rawText:''}));assert.equal(unverified.reason,'unverified_identity');
   await query(`insert into eco_private.inbox_sender_bindings(source_id,sender_identity,sender_display,owner_id,enabled,verified_at) values(${lit(sourceId)},'verified-1','Ambiguous',${lit(owners[2])},true,now())`);assert.equal((await ingest(payload())).reason,'ambiguous_sender');
   await query(`update eco_private.users set is_active=false where id=${lit(owners[2])}`);assert.equal((await ingest(payload({senderIdentity:'verified-2'}))).reason,'inactive_owner');
   const forced=await ingest(payload({rawText:'',quarantineReason:'oversized',contentHash:'f'.repeat(64)}));assert.equal(forced.reason,'oversized');
   assert.equal(await query("select count(*) from eco_private.inbox_messages where status='quarantined' and raw_text is null and subject is null and owner_id is null"),'5');assert.equal((await list(0)).items.length,0);assert.equal((await list(1)).items.length,0);
   assert.equal(await query("select count(*) from eco_private.administration_events where details::text like '%SYNTHETIC ENQUIRY%'"),'0');
  });
  await t.test('read/dismiss are monotonic, exact mutation retries are stable, dismiss-all never catches later arrivals',async()=>{
   await seed();const first=await ingest(payload()),second=await ingest(payload());const read={requestId:randomUUID(),action:'read',id:first.id};const result=await mutate(1,read);assert.equal(result.changedCount,1);assert.equal(result.item.read,true);assert.equal(result.unreadCount,1);assert.deepEqual(await mutate(1,read),result);await assert.rejects(mutate(1,{...read,action:'dismiss'}),/Request conflict/);
   const all={requestId:randomUUID(),action:'dismiss-all'};const dismissed=await mutate(1,all);assert.equal(dismissed.changedCount,2);assert.equal(dismissed.item,null);assert.equal(dismissed.unreadCount,0);
   const third=await ingest(payload());assert.deepEqual(await mutate(1,all),dismissed);const page=await list(1);assert.equal(page.unreadCount,1);assert.equal(page.items.find(i=>i.id===third.id).dismissed,false);assert.equal(page.items.find(i=>i.id===second.id).dismissed,true);
   const race={requestId:randomUUID(),action:'dismiss',id:third.id};const responses=await Promise.all(Array.from({length:6},()=>mutate(1,race)));assert.ok(responses.every(r=>r.changedCount===1));assert.equal(await query(`select count(*) from eco_private.inbox_mutations where request_id=${lit(race.requestId)}`),'1');
  });
  await t.test('bounded keyset pages preserve order and completeness with total unread count',async()=>{
   await seed();const accepted=[];for(let i=0;i<7;i++)accepted.push(await ingest(payload({messageId:'page-'+i})));let cursor;const found=[];
   do{const page=await list(1,{limit:2,...(cursor?{cursor}:{})});assert.equal(page.unreadCount,7);assert.ok(page.items.length<=2);found.push(...page.items.map(i=>i.id));cursor=page.nextCursor;}while(cursor);
   assert.equal(new Set(found).size,7);assert.deepEqual(found,accepted.map(i=>i.id).reverse());
   for(const extra of [{limit:0},{limit:51},{limit:'2'},{cursor:'infinity|'+randomUUID()},{cursor:'bad'},{owner:owners[2]}])await assert.rejects(list(1,extra),/Invalid/);
  });
  await t.test('provider input validation preserves exact bytes and rejects forged ownership or malformed content',async()=>{
   await seed();for(const change of [{owner:owners[0]},{enquiryId:randomUUID()},{identityVerified:'true'},{rawText:'x'.repeat(20001)},{rawText:'港'.repeat(6667)},{rawText:'bad\u0001'},{receivedAt:'tomorrow'},{receivedAt:'2026-99-15T10:00:00Z'},{messageId:''},{messageId:'x'.repeat(1025)},{subject:'x'.repeat(1001)},{quarantineReason:'oversized'},{contentHash:'0'.repeat(64)}])await assert.rejects(ingest(payload(change)),/Invalid|mismatch/);
   const max=payload({messageId:'x'.repeat(1024),rawText:'x'.repeat(20000)});max.contentHash=createHash('sha256').update(max.rawText).digest('hex');assert.equal((await ingest(max)).status,'accepted');
   assert.equal((await ingest(payload({receivedAt:'2026-09-30T00:00:00Z'}))).reason,'before_cutover');
  });
  await t.test('health is aggregate admin/service evidence and never treats missing sources as configured',async()=>{
   await seed();
   const health=JSON.parse(await as(0,'select public.eco_inbox_health()'));assert.equal(health.configuredSources,2);assert.equal(health.enabledSources,2);assert.equal(health.enabledEmailSources,1);assert.equal(health.uncheckpointedEmailSources,1);assert.equal(health.lastSuccessfulCheckpoint,null);
   assert.ok(Object.values(health).every(v=>v===null||typeof v==='number'||(typeof v==='string'&&Number.isFinite(Date.parse(v)))));
   await assert.rejects(as(1,'select public.eco_inbox_health()'),/Forbidden/);await as(0,"select public.eco_set_preview('admin','hk')");await assert.rejects(as(0,'select public.eco_inbox_health()'),/Forbidden/);
   const serviceHealth=JSON.parse(await query('begin;set local role service_role;select public.eco_inbox_health();commit;'));assert.equal(serviceHealth.configuredSources,2);
   await query('update eco_private.inbox_sources set enabled=false');assert.equal(JSON.parse(await query('begin;set local role service_role;select public.eco_inbox_health();commit;')).enabledSources,0);
  });
  const waPayload = extra => ({sourceId,provider:'meta-whatsapp-cloud',accountId:'123456789012345',destinationId:'987654321098765',
   messageId:'wamid.'+randomUUID(),senderIdentity:'85298472818',identityNamespace:'meta-whatsapp-signed-v1',
   rawText:'SYNTHETIC WHATSAPP ENQUIRY\nPORT: SINGAPORE\nVLSFO 100 MT',receivedAt:'2026-10-20T02:00:00.000Z',...extra});
  const waIngest = input => svc('eco_ingest_whatsapp_enquiry',input);
  const waSeed = async () => {
   await seed();
   await query(`update eco_private.inbox_sources set provider='meta-whatsapp-cloud',account_id='123456789012345',destination_id='987654321098765',identity_namespace='meta-whatsapp-signed-v1' where id=${lit(sourceId)};
    update eco_private.inbox_sender_bindings set sender_identity=case when owner_id=${lit(owners[1])} then '85298472818' else '85290000002' end where source_id=${lit(sourceId)};`);
  };
  await t.test('Meta adapter RPC checks exact source, protocol and allowed input without browser authority',async()=>{
   await waSeed();const input=waPayload();
   for(const change of [{sourceId:emailSource},{provider:'meta-other'},{accountId:'other'},{destinationId:'other'},{identityNamespace:'other'}])await assert.rejects(waIngest({...input,...change}),/mismatch/);
   for(const change of [{ownerId:owners[0]},{identityVerified:true},{contentHash:'a'.repeat(64)},{subject:'private'},{leaseToken:randomUUID()},{dataMode:'test'},{generation:randomUUID()}])await assert.rejects(waIngest({...input,...change}),/Unknown|Invalid|Unexpected/);
   for(const senderIdentity of ['+85298472818','0085298472818','BSUID.SYNTHETIC','852 98472818',''])await assert.rejects(waIngest({...input,senderIdentity}),/Invalid WhatsApp sender/);
   for(const rawText of [null,{}])await assert.rejects(waIngest({...input,rawText}),/Invalid WhatsApp text/);
   for(const receivedAt of ['not-a-date','infinity','2026-99-20T02:00:00Z'])await assert.rejects(waIngest({...input,receivedAt}),/Invalid.*(?:timestamp|input)/);
   await assert.rejects(waIngest({...input,quarantineReason:'invented'}),/Invalid WhatsApp quarantine/);
   await assert.rejects(waIngest({...input,quarantineReason:'oversized'}),/Invalid WhatsApp quarantine/);
   await query(`update eco_private.inbox_sources set enabled=false where id=${lit(sourceId)}`);await assert.rejects(waIngest(input),/unavailable/);
   assert.equal(await query('select count(*) from eco_private.inbox_messages'),'0');
  });
  await t.test('Meta concurrent receipts are durable owner-only records; accepted retries cannot change content or routing',async()=>{
   await waSeed();const input=waPayload(),replies=await Promise.all(Array.from({length:8},()=>waIngest(input)));
   assert.equal(replies.filter(value=>!value.duplicate).length,1);assert.equal(new Set(replies.map(value=>value.id)).size,1);
   const first=replies[0];assert.equal(first.status,'accepted');assert.equal((await list(1)).items[0].rawText,input.rawText);
   assert.deepEqual(await list(0),{items:[],nextCursor:null,unreadCount:0});assert.equal((await list(2)).items.length,0);
   const inOtherZone=JSON.parse(await query(`begin;set local role service_role;set local timezone='Asia/Hong_Kong';select public.eco_ingest_whatsapp_enquiry(${json({...input,receivedAt:'2026-10-20T10:00:00+08:00'})});commit;`));assert.equal(inOtherZone.duplicate,true);
   for(const change of [{rawText:input.rawText+' CHANGED'},{senderIdentity:'85290000002'},{receivedAt:'2026-10-20T02:00:01Z'},{rawText:'',quarantineReason:'unsupported_attachment'}])await assert.rejects(waIngest({...input,...change}),/delivery conflict/);
   await query(`update eco_private.inbox_sender_bindings set enabled=false,owner_id=${lit(owners[0])} where source_id=${lit(sourceId)} and sender_identity='85298472818'`);
   assert.equal((await waIngest(input)).id,first.id);assert.equal((await list(1)).items.length,1);assert.equal((await list(0)).items.length,0);
   assert.equal(await query(`select content_hash=${lit(createHash('sha256').update(input.rawText).digest('hex'))} from eco_private.inbox_messages where id=${lit(first.id)}`),'t');
  });
  await t.test('Meta unknown, ambiguous, disabled and inactive routing leaves no content or content digest',async()=>{
   await waSeed();const cases=[];
   cases.push(await waIngest(waPayload({senderIdentity:'85299999999'})));assert.equal(cases.at(-1).reason,'unknown_sender');
   await query(`insert into eco_private.inbox_sender_bindings(source_id,sender_identity,sender_display,owner_id,enabled,verified_at) values(${lit(sourceId)},'85298472818','Ambiguous',${lit(owners[2])},true,now())`);
   cases.push(await waIngest(waPayload()));assert.equal(cases.at(-1).reason,'ambiguous_sender');
   await query(`delete from eco_private.inbox_sender_bindings where source_id=${lit(sourceId)} and sender_identity='85298472818' and owner_id=${lit(owners[2])};update eco_private.inbox_sender_bindings set enabled=false where source_id=${lit(sourceId)} and sender_identity='85298472818'`);
   cases.push(await waIngest(waPayload()));assert.equal(cases.at(-1).reason,'unknown_sender');
   await query(`update eco_private.users set is_active=false where id=${lit(owners[2])}`);
   cases.push(await waIngest(waPayload({senderIdentity:'85290000002'})));assert.equal(cases.at(-1).reason,'inactive_owner');
   assert.equal(await query("select count(*) from eco_private.inbox_messages where status='quarantined' and raw_text is null and subject is null and owner_id is null and content_hash is null"),String(cases.length));
   assert.equal((await list(0)).items.length,0);assert.equal((await list(1)).items.length,0);
   assert.equal(await query("select count(*) from eco_private.administration_events where details::text like '%SYNTHETIC WHATSAPP ENQUIRY%'"),'0');
  });
  await t.test('Meta unsupported bodies, non-phone identity, controls, empty text and pre-cutover delivery quarantine without a body hash',async()=>{
   await waSeed();const cases=[];
   for(const quarantineReason of ['unsupported_attachment','unsupported_body','oversized','malformed_message']){
    const result=await waIngest(waPayload({rawText:'',quarantineReason}));assert.equal(result.reason,quarantineReason);cases.push(result);
   }
   cases.push(await waIngest(waPayload({rawText:'',senderIdentity:'',quarantineReason:'malformed_message'})));
   for(const [extra,reason] of [[{rawText:'漢'.repeat(7000)},'oversized'],[{rawText:'SYNTHETIC'+String.fromCharCode(1)+'CONTROL'},'malformed_message'],[{rawText:'  \n\t'},'empty_message'],[{receivedAt:'2026-09-01T00:00:00Z'},'before_cutover']]){
    const result=await waIngest(waPayload(extra));assert.equal(result.reason,reason);cases.push(result);
   }
   assert.equal(await query("select count(*) from eco_private.inbox_messages where status='quarantined' and raw_text is null and subject is null and content_hash is null and owner_id is null"),String(cases.length));
   assert.equal(await query("select count(*) from eco_private.inbox_messages where fingerprint !~ '^[0-9a-f]{64}$'"),'0');
  });
  await t.test('Meta quarantined retry is stable after binding approval and fingerprints no body-derived data',async()=>{
   await waSeed();const input=waPayload({senderIdentity:'85299999999'}),first=await waIngest(input);
   assert.equal(first.reason,'unknown_sender');
   const fingerprint=await query(`select fingerprint from eco_private.inbox_messages where id=${lit(first.id)}`);
   const retry=await waIngest({...input,rawText:'DIFFERENT PRIVATE BODY NOT RETAINED'});assert.equal(retry.id,first.id);assert.equal(retry.duplicate,true);
   await query(`insert into eco_private.inbox_sender_bindings(source_id,sender_identity,sender_display,owner_id,enabled,verified_at) values(${lit(sourceId)},'85299999999','Later binding',${lit(owners[1])},true,now())`);
   assert.equal((await waIngest(input)).status,'quarantined');assert.equal((await list(1)).items.length,0);
   assert.equal(await query(`select fingerprint from eco_private.inbox_messages where id=${lit(first.id)}`),fingerprint);
   assert.equal(await query(`select content_hash is null and raw_text is null from eco_private.inbox_messages where id=${lit(first.id)}`),'t');
   for(const change of [{senderIdentity:'85298472818'},{receivedAt:'2026-10-20T02:00:01Z'}])await assert.rejects(waIngest({...input,...change}),/delivery conflict/);
  });
  await t.test('Meta routing waits for an in-flight binding revocation before deciding ownership',async()=>{
   await waSeed();const tag='eco_wa_binding_race_'+randomUUID().replaceAll('-','');
   const pending=query(`set application_name=${lit(tag)};begin;update eco_private.inbox_sender_bindings set enabled=false where source_id=${lit(sourceId)} and sender_identity='85298472818';select pg_sleep(0.5);commit;`);
   let locked=false;
   for(let i=0;i<30&&!locked;i++)locked=await query(`select exists(select 1 from pg_locks l join pg_stat_activity a on a.pid=l.pid where a.application_name=${lit(tag)} and l.relation='eco_private.inbox_sender_bindings'::regclass and l.mode='RowExclusiveLock' and l.granted)`) === 't';
   assert.equal(locked,true,'Observe the binding write lock before racing intake.');
   const received=waIngest(waPayload());await pending;const result=await received;
   assert.equal(result.status,'quarantined');assert.equal(result.reason,'unknown_sender');
   assert.equal(await query(`select owner_id is null and raw_text is null and content_hash is null from eco_private.inbox_messages where id=${lit(result.id)}`),'t');
  });
  await t.test('source leases serialize claims and persist provider retry backoff across worker calls',async()=>{
   await seed();const attempts=await Promise.allSettled(Array.from({length:6},()=>svc('eco_claim_inbox_source',{sourceId:emailSource,requestId:randomUUID()})));assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);
   const lease=attempts.find(r=>r.status==='fulfilled').value,fence={sourceId:emailSource,leaseToken:lease.leaseToken};
   for(const bad of [{retryAfterSeconds:60},{errorCode:'provider_error',retryAfterSeconds:0},{errorCode:'provider_error',retryAfterSeconds:86401},{errorCode:'provider_error',retryAfterSeconds:'60'}])await assert.rejects(svc('eco_release_inbox_source',{...fence,...bad}),/Invalid/);
   await svc('eco_release_inbox_source',{...fence,errorCode:'provider_error',retryAfterSeconds:300});await assert.rejects(svc('eco_claim_inbox_source',{sourceId:emailSource,requestId:randomUUID()}),/deferred/);
   assert.equal(await query(`select retry_after>now()+interval '290 seconds' from eco_private.inbox_sources where id=${lit(emailSource)}`),'t');
   await query(`update eco_private.inbox_sources set retry_after=now()-interval '1 second' where id=${lit(emailSource)}`);
   const next=await svc('eco_claim_inbox_source',{sourceId:emailSource,requestId:randomUUID()});await svc('eco_checkpoint_inbox_source',{sourceId:emailSource,leaseToken:next.leaseToken,expectedCursor:null,cursor:'https://graph.microsoft.com/v1.0/empty',receiptIds:[]});
   await svc('eco_release_inbox_source',{sourceId:emailSource,leaseToken:next.leaseToken});assert.equal(await query(`select retry_after is null and last_error_code is null and last_checkpoint_at is not null from eco_private.inbox_sources where id=${lit(emailSource)}`),'t');
  });
  const directorySeed = async () => {
   await waSeed();
   await query(`update eco_private.inbox_sources set sender_authority='directory';
    update eco_private.users set phone=case when id=${lit(owners[1])} then '+85298472818' when id=${lit(owners[2])} then '+85290000002' else '' end;`);
  };
  const adminPhone = async (i,phone) => call(0,'eco_update_user',{id:owners[i],expectedRevision:Number(await query(`select revision from eco_private.users where id=${lit(owners[i])}`)),displayName:'Fixture Owner',officeId:'hk',isAdmin:false,isSpcTrader:false,isManager:false,isActive:true,phone});
  await t.test('directory routing defaults to supported protocols and has no browser or direct service helper access',async()=>{
   await directorySeed();const id=randomUUID();
   await query(`insert into eco_private.inbox_sources(id,provider,account_id,destination_id,channel,identity_namespace) values(${lit(id)},'meta-whatsapp-cloud','fixture-new-account','fixture-new-destination','whatsapp','meta-whatsapp-signed-v1')`);
   assert.equal(await query(`select sender_authority from eco_private.inbox_sources where id=${lit(id)}`),'directory');
   await assert.rejects(query(`update eco_private.inbox_sources set provider='other' where id=${lit(id)}`),/eco_inbox_directory_protocol/);
   for(const role of ['anon','authenticated','service_role'])await assert.rejects(query(`set role ${role};select eco_private.inbox_sender_resolution(null,'85290000002')`),/permission denied/);
   for(const role of ['anon','authenticated','service_role'])await assert.rejects(query(`set role ${role};update eco_private.inbox_sources set sender_authority='manual'`),/permission denied/);
   await query(`update eco_private.inbox_sources set enabled=false where id=${lit(sourceId)}`);
   await assert.rejects(waIngest(waPayload()),/unavailable/);
  });
  await t.test('approved directory phones override every stale manual binding and preserve historical ownership on replay',async()=>{
   await directorySeed();await query(`update eco_private.inbox_sender_bindings set owner_id=${lit(owners[2])},sender_display='STALE' where source_id=${lit(sourceId)} and sender_identity='85298472818'`);
   const input=waPayload(),accepted=await waIngest(input);assert.equal(accepted.status,'accepted');assert.equal((await list(1)).items[0].id,accepted.id);assert.equal((await list(1)).items[0].sender,'Fixture Owner');assert.equal((await list(2)).items.length,0);
   await adminPhone(1,'+85290000003');
   assert.equal((await waIngest(waPayload())).reason,'unknown_sender','No stale manual fallback after current phone changes.');
   await adminPhone(2,'+85298472818');
   assert.equal((await waIngest(input)).duplicate,true);assert.equal((await list(1)).items[0].id,accepted.id);
   const next=await waIngest(waPayload());assert.equal(next.status,'accepted');assert.equal((await list(2)).items[0].id,next.id);
   assert.equal(await query(`select count(*) from eco_private.access_audit where target_id=${lit(owners[1])} and action='update-user' and before_access->>'phone'='+85298472818' and after_access->>'phone'='+85290000003'`),'1');
  });
  await t.test('pending and declined phone requests do not route; approval updates future routing with audit and quarantine replay stability',async()=>{
   await directorySeed();const requestId=randomUUID(),phone='+85290000004';
   await JSON.parse(await as(1,`select public.eco_request_phone_change(${lit(requestId)}::uuid,${lit(phone)})`));
   const rejectedInput=waPayload({senderIdentity:phone.slice(1)}),rejected=await waIngest(rejectedInput);assert.equal(rejected.reason,'unknown_sender');
   assert.equal((await waIngest(waPayload())).status,'accepted','Old approved phone still routes while request is pending.');
   await as(0,`select public.eco_review_phone_change(${lit(requestId)}::uuid,'approve')`);
   assert.equal((await waIngest(waPayload({senderIdentity:phone.slice(1)}))).status,'accepted');
   assert.equal((await waIngest(waPayload())).reason,'unknown_sender');assert.equal((await waIngest(rejectedInput)).status,'quarantined');assert.equal((await waIngest(rejectedInput)).duplicate,true);
   const declined=randomUUID();await as(1,`select public.eco_request_phone_change(${lit(declined)}::uuid,'+85290000005')`);await as(0,`select public.eco_review_phone_change(${lit(declined)}::uuid,'decline')`);
   assert.equal((await waIngest(waPayload({senderIdentity:'85290000005'}))).reason,'unknown_sender');
   assert.equal(await query(`select count(*) from eco_private.access_audit where target_id=${lit(owners[1])} and action='review-phone-change' and after_access->>'status'='approved'`),'1');
   assert.equal(await query(`select raw_text is null and content_hash is null and owner_id is null from eco_private.inbox_messages where id=${lit(rejected.id)}`),'t');
  });
  await t.test('duplicate directory phones fail closed even beside an inactive user; all owner eligibility gates remain enforced',async()=>{
   await directorySeed();await adminPhone(2,'+85298472818');const duplicate=await waIngest(waPayload());assert.equal(duplicate.reason,'ambiguous_sender');
   await query(`update eco_private.users set is_active=false where id=${lit(owners[2])}`);assert.equal((await waIngest(waPayload())).reason,'ambiguous_sender');
   assert.equal(await query(`select raw_text is null and content_hash is null and owner_id is null from eco_private.inbox_messages where id=${lit(duplicate.id)}`),'t');
   for(const change of ["is_active=false","activated_at=null",`access_hold_request=${lit(randomUUID())}::uuid`]){
    await directorySeed();await query(`update eco_private.users set ${change} where id=${lit(owners[1])}`);assert.equal((await waIngest(waPayload())).reason,'inactive_owner');
   }
   await directorySeed();await query(`update auth.users set email_confirmed_at=null where id=${lit(owners[1])}`);assert.equal((await waIngest(waPayload())).reason,'inactive_owner');
   await directorySeed();await query(`update eco_private.users set deleted_at=now(),is_active=false where id=${lit(owners[1])}`);assert.equal((await waIngest(waPayload())).reason,'unknown_sender');
  });
  await t.test('directory email pre-body resolution uses current email, preserves lease and independent provenance, and never follows stale bindings',async()=>{
   await directorySeed();const claim=await svc('eco_claim_inbox_source',{sourceId:emailSource,requestId:randomUUID()}),fence={sourceId:emailSource,leaseToken:claim.leaseToken};
   const resolve=senderIdentity=>svc('eco_resolve_inbox_sender',{...fence,senderIdentity,identityNamespace:'exchange-authenticated-internal-v1'});
   assert.deepEqual(await resolve('FIXTURE-1@EXAMPLE.TEST'),{approved:true});assert.deepEqual(await resolve('fixture1@example.test'),{approved:false},'Old manual alias is not a directory email.');
   const input=payload({...fence,provider:'microsoft-graph',accountId:'fixture-tenant',destinationId:'fixture-mailbox',identityNamespace:'exchange-authenticated-internal-v1',senderIdentity:'fixture-1@example.test'});
   assert.equal((await ingest({...input,messageId:randomUUID(),identityVerified:false,rawText:''})).reason,'unverified_identity','Matching directory email never substitutes for Internal provenance.');
   const accepted=await ingest(input);assert.equal(accepted.status,'accepted');
   await query(`update eco_private.users set email='renamed@example.test' where id=${lit(owners[1])}`);assert.deepEqual(await resolve('fixture-1@example.test'),{approved:false});assert.deepEqual(await resolve('renamed@example.test'),{approved:true});
   assert.deepEqual(await svc('eco_get_inbox_receipt',{...fence,messageId:input.messageId}),{id:accepted.id,status:'accepted'});assert.equal((await ingest(input)).duplicate,true);
   await query(`update eco_private.users set email='RENAMED@example.test' where id=${lit(owners[2])}`);assert.deepEqual(await resolve('renamed@example.test'),{approved:false},'Case-insensitive duplicate identities fail closed.');
   await assert.rejects(svc('eco_resolve_inbox_sender',{...fence,leaseToken:randomUUID(),senderIdentity:'renamed@example.test',identityNamespace:'exchange-authenticated-internal-v1'}),/lease expired/);
  });
  await t.test('directory contact changes between email precheck and ingestion are rechecked before any owner receipt',async()=>{
   await directorySeed();const claim=await svc('eco_claim_inbox_source',{sourceId:emailSource,requestId:randomUUID()}),fence={sourceId:emailSource,leaseToken:claim.leaseToken};
   const senderIdentity='fixture-1@example.test';assert.deepEqual(await svc('eco_resolve_inbox_sender',{...fence,senderIdentity,identityNamespace:'exchange-authenticated-internal-v1'}),{approved:true});
   await query(`update eco_private.users set is_active=false where id=${lit(owners[1])}`);
   const receipt=await ingest(payload({...fence,provider:'microsoft-graph',accountId:'fixture-tenant',destinationId:'fixture-mailbox',identityNamespace:'exchange-authenticated-internal-v1',senderIdentity}));assert.equal(receipt.reason,'inactive_owner');
   assert.equal(await query(`select raw_text is null and subject is null and owner_id is null from eco_private.inbox_messages where id=${lit(receipt.id)}`),'t');
  });
  await t.test('intake waits for the same Users & Access advisory lock and sees the committed approved phone',async()=>{
   await directorySeed();const tag='eco-directory-race-'+randomUUID();
   const pending=query(`set application_name=${lit(tag)};begin;select pg_advisory_xact_lock(1857,2026);update eco_private.users set phone='+85290000006' where id=${lit(owners[1])};select pg_sleep(0.5);commit;`);
   let locked=false;for(let i=0;i<30&&!locked;i++)locked=await query(`select exists(select 1 from pg_locks l join pg_stat_activity a on a.pid=l.pid where a.application_name=${lit(tag)} and l.locktype='advisory' and l.granted)`) === 't';assert.equal(locked,true);
   const receipt=await waIngest(waPayload());await pending;assert.equal(receipt.reason,'unknown_sender');
   assert.equal((await waIngest(waPayload({senderIdentity:'85290000006'}))).status,'accepted');
  });
  await t.test('email leases fence ingestion, resolve and checkpoint; durable receipt replay works after reclaim',async()=>{
   await seed();const claimInput={sourceId:emailSource,requestId:randomUUID()},claim=await svc('eco_claim_inbox_source',claimInput);assert.equal(claim.cursor,null);assert.deepEqual(await svc('eco_claim_inbox_source',claimInput),claim);
   await assert.rejects(svc('eco_claim_inbox_source',{...claimInput,requestId:randomUUID()}),/busy/);
   const fence={sourceId:emailSource,leaseToken:claim.leaseToken},input=payload({...fence,provider:'microsoft-graph',accountId:'fixture-tenant',destinationId:'fixture-mailbox',identityNamespace:'exchange-authenticated-internal-v1',senderIdentity:'fixture1@example.test'});
   const resolution=await svc('eco_resolve_inbox_sender',{...fence,senderIdentity:input.senderIdentity,identityNamespace:input.identityNamespace});assert.deepEqual(resolution,{approved:true});assert.deepEqual(await svc('eco_resolve_inbox_sender',{...fence,senderIdentity:'unknown@example.test',identityNamespace:input.identityNamespace}),{approved:false});
   await assert.rejects(ingest({...input,leaseToken:randomUUID()}),/lease expired/);assert.equal(await svc('eco_get_inbox_receipt',{...fence,messageId:input.messageId}),null);const accepted=await ingest(input);
   await query(`update eco_private.inbox_sender_bindings set enabled=false where source_id=${lit(emailSource)}`);assert.deepEqual(await svc('eco_get_inbox_receipt',{...fence,messageId:input.messageId}),{id:accepted.id,status:'accepted'});
   await assert.rejects(svc('eco_get_inbox_receipt',{...fence,leaseToken:randomUUID(),messageId:input.messageId}),/lease expired/);
   const checkpoint={...fence,expectedCursor:null,cursor:'https://graph.microsoft.com/v1.0/fixture-delta',receiptIds:[accepted.id]};await svc('eco_checkpoint_inbox_source',checkpoint);await assert.rejects(svc('eco_checkpoint_inbox_source',checkpoint),/cursor conflict/);
   await assert.rejects(svc('eco_checkpoint_inbox_source',{...checkpoint,expectedCursor:checkpoint.cursor,receiptIds:[randomUUID()]}),/not found/);
   const foreign=await ingest(payload());await assert.rejects(svc('eco_checkpoint_inbox_source',{...checkpoint,expectedCursor:checkpoint.cursor,receiptIds:[foreign.id]}),/not found/);
   await query(`update eco_private.inbox_sources set lease_expires_at=now()-interval '1 second' where id=${lit(emailSource)}`);await assert.rejects(ingest(input),/lease expired/);await assert.rejects(svc('eco_release_inbox_source',fence),/lease expired/);
   const next=await svc('eco_claim_inbox_source',{sourceId:emailSource,requestId:randomUUID()});assert.notEqual(next.leaseToken,claim.leaseToken);assert.equal(next.cursor,checkpoint.cursor);assert.equal((await ingest({...input,leaseToken:next.leaseToken})).duplicate,true);
   await assert.rejects(svc('eco_checkpoint_inbox_source',{...checkpoint,expectedCursor:checkpoint.cursor}),/lease expired/);
   await svc('eco_release_inbox_source',{sourceId:emailSource,leaseToken:next.leaseToken,errorCode:'provider_error'});assert.equal(await query(`select lease_token is null from eco_private.inbox_sources where id=${lit(emailSource)}`),'t');
  });
 }finally{if(started)await exec(join(bin,'pg_ctl'),['-D',data,'-m','immediate','-w','stop'],{env});await rm(root,{recursive:true,force:true});}
});
