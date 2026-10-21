import { applySchemaMigrations } from './fixtures/migrations.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,readdir,rm} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
const exec=promisify(execFile),lit=v=>`'${String(v).replaceAll("'","''")}'`,json=v=>`${lit(JSON.stringify(v))}::jsonb`;
const users=Array.from({length:4},()=>randomUUID()),sessions=users.map(()=>randomUUID()),sourceId=randomUUID(),inboxIds=users.map(()=>randomUUID());
const payload=extra=>({dataMode:'live',requestId:randomUUID(),id:randomUUID(),expectedRevision:0,action:'save',source:{rawText:'SYNTHETIC ORIGINAL PRIVATE',parsed:null,parserVersion:null,inboxId:null},reviewed:{vessel:'SYNTHETIC VESSEL',imo:'9876543',eta:'20 OCT',portId:'port-singapore',buyerText:'PRIVATE BUYER',buyerId:null,products:[{grade:'VLSFO',quantityText:'100-200'}],remarks:'PRIVATE REMARKS',rmk:false,viscosity:[],formattedText:'PRIVATE FORMATTED',warnings:['PRIVATE WARNING']},...extra});
test('commercial enquiry isolation, atomic confirmation and durable retry on isolated PostgreSQL17',async t=>{
 const bin=process.env.ECO_NATIVE_PG_BIN;assert.ok(bin&&isAbsolute(bin));assert.match((await exec(join(bin,'postgres'),['--version'])).stdout,/PostgreSQL\) 17\./);
 const root=await mkdtemp(join(tmpdir(),'eco-commercial-pg-')),socket=join(root,'socket'),data=join(root,'data');await mkdir(socket,{mode:0o700});
 const env={PATH:process.env.PATH,LANG:'C',LC_ALL:'C',PGPASSFILE:join(root,'none')};let started=false;
 const query=async sql=>(await exec(join(bin,'psql'),['-X','-q','-A','-t','--no-password','-h',socket,'-p','55497','-U','eco_fixture','-d','postgres','-v','ON_ERROR_STOP=1','-c',sql],{env,maxBuffer:10*1024*1024})).stdout.trim();
 const as=(i,sql,extra={})=>query(`begin;set local role authenticated;do $$begin perform set_config('request.jwt.claims',${lit(JSON.stringify({sub:users[i],session_id:sessions[i],aal:'aal1',...extra}))},true);end$$;${sql};commit;`);
 const call=async(i,name,input)=>JSON.parse(await as(i,`select public.${name}(${json(input)})`));
 const mutate=(i,input)=>call(i,'eco_mutate_commercial_enquiry',input),get=(i,extra={})=>call(i,'eco_get_commercial_enquiries',{dataMode:'live',...extra});
 const seed=async()=>{
  await query(`truncate eco_private.commercial_enquiry_mutations,eco_private.commercial_enquiry_history,eco_private.commercial_enquiry_queue,eco_private.commercial_enquiries restart identity;truncate eco_private.administration_events;truncate eco_private.inbox_mutations,eco_private.inbox_messages,eco_private.inbox_sender_bindings,eco_private.inbox_sources;truncate auth.users cascade;
   insert into auth.users(id,email,email_confirmed_at,encrypted_password) values ${users.map((id,i)=>`(${lit(id)},${lit(`commercial-fixture-${i}@example.test`)},now(),'synthetic')`).join(',')};
   update eco_private.users set office_id='hk',display_name='Synthetic Trader',is_active=true,activated_at=now(),is_admin=id=${lit(users[0])},is_spc_trader=id=${lit(users[2])},is_manager=id=${lit(users[3])};
   insert into auth.sessions(id,user_id) values ${users.map((id,i)=>`(${lit(sessions[i])},${lit(id)})`).join(',')};
   insert into eco_private.inbox_sources(id,provider,account_id,destination_id,channel,identity_namespace,sender_authority) values(${lit(sourceId)},'fixture','fixture-account','fixture-destination','whatsapp','fixture-v1','manual');
   insert into eco_private.inbox_messages(id,source_id,provider,account_id,destination_id,provider_message_id,fingerprint,channel,sender_identity,sender_display,owner_id,status,raw_text,received_at) values ${users.map((id,i)=>`(${lit(inboxIds[i])},${lit(sourceId)},'fixture','fixture-account','fixture-destination',${lit('fixture-'+i)},repeat('a',64),'whatsapp','fixture-sender','Synthetic Sender',${lit(id)},'accepted','SYNTHETIC ORIGINAL PRIVATE',now())`).join(',')};`);
 };
 try{
  await exec(join(bin,'initdb'),['-D',data,'-U','eco_fixture','-A','trust','--no-locale','--encoding=UTF8'],{env});
  await exec(join(bin,'pg_ctl'),['-D',data,'-l',join(root,'server.log'),'-o',`-k ${socket} -p 55497 -c listen_addresses=''`,'-w','start'],{env});started=true;
  assert.equal(await query("select current_setting('listen_addresses')"),'');assert.equal(await query('select inet_server_addr() is null'),'t');
  await query(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
   create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,encrypted_password text,raw_app_meta_data jsonb not null default '{}');
   create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),not_after timestamptz);
   create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
   create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
   grant usage on schema auth to authenticated,service_role;grant execute on function auth.uid(),auth.jwt() to authenticated,service_role;`);
    await applySchemaMigrations(query);
  await query("insert into eco_private.offices values('hk','Hong Kong'),('sg','Singapore'),('CREDIT','Credit') on conflict do nothing");
  await t.test('no fabricated data, private tables/RLS and RPC privileges',async()=>{
   for(const table of ['commercial_enquiries','commercial_enquiry_queue','commercial_enquiry_mutations','commercial_enquiry_history']){
    assert.equal(await query(`select count(*) from eco_private.${table}`),'0');assert.equal(await query(`select relrowsecurity from pg_class where oid='eco_private.${table}'::regclass`),'t');
    for(const role of ['anon','authenticated','service_role'])await assert.rejects(query(`set role ${role};select * from eco_private.${table}`),/permission denied/);
   }
   for(const name of ['eco_get_commercial_enquiries','eco_mutate_commercial_enquiry'])for(const role of ['anon','service_role'])await assert.rejects(query(`set role ${role};select public.${name}('{}')`),/permission denied/);
   assert.equal(await query("select migration_head from eco_private.platform_versions where component='commercial-enquiries'"),'20261020075427');
  });
  await t.test('own draft survives new sessions; admin cannot read private details; queue is a strict projection',async()=>{
   await seed();const input=payload();const saved=await mutate(1,input);assert.equal(saved.item.status,'draft');assert.equal(saved.item.revision,1);assert.equal(saved.item.source.rawText,input.source.rawText);assert.equal(saved.item.reference,'ECO-00000001');
   const replacement=randomUUID();await query(`insert into auth.sessions(id,user_id) values(${lit(replacement)},${lit(users[1])})`);
   assert.deepEqual(JSON.parse(await as(1,`select public.eco_get_commercial_enquiries(${json({dataMode:'live',id:input.id})})`,{session_id:replacement})).item,saved.item);
   for(const i of [0,2,3])await assert.rejects(get(i,{id:input.id}),/not found/);
   assert.equal((await get(1)).items.length,1);assert.equal((await get(0)).items.length,0);assert.equal((await get(0,{scope:'singapore'})).items.length,0);
   const confirmed=await mutate(1,{...input,requestId:randomUUID(),expectedRevision:1,action:'confirm'});assert.equal(confirmed.item.queue.status,'awaiting_connection');assert.equal(confirmed.item.revision,2);
   for(const i of [0,2]){const page=await get(i,{scope:'singapore'});assert.equal(page.items[0].id,input.id);assert.doesNotMatch(JSON.stringify(page),/PRIVATE|rawText|buyer|source|remarks|formattedText|warnings/);assert.deepEqual(Object.keys(page.items[0]).sort(),['id','reference','ownerId','ownerName','revision','status','vessel','imo','eta','products','port','queue','createdAt','updatedAt','confirmedAt'].sort());}
   for(const i of [1,3])await assert.rejects(get(i,{scope:'singapore'}),/Forbidden/);
   await query(`update eco_private.users set office_id='CREDIT' where id=${lit(users[3])}`);await assert.rejects(get(3,{scope:'singapore'}),/Forbidden/);
  });
  await t.test('retry receipt exact payload, concurrent calls, CAS and one atomic queue intent',async()=>{
   await seed();const input=payload({action:'confirm'});const results=await Promise.all(Array.from({length:6},()=>mutate(1,input)));assert.ok(results.every(r=>JSON.stringify(r)===JSON.stringify(results[0])));
   for(const table of ['commercial_enquiries','commercial_enquiry_queue','commercial_enquiry_mutations','commercial_enquiry_history'])assert.equal(await query(`select count(*) from eco_private.${table}`),'1');
   await assert.rejects(mutate(1,{...input,reviewed:{...input.reviewed,vessel:'CHANGED'}}),/Request payload conflict/);
   await assert.rejects(mutate(1,{...input,requestId:randomUUID(),expectedRevision:1}),/revision conflict/);
   await assert.rejects(mutate(0,{...input,requestId:randomUUID(),expectedRevision:1}),/not found/);
   const draft=payload(),saved=await mutate(1,draft);const attempts=await Promise.allSettled(['A','B'].map(vessel=>mutate(1,{...draft,requestId:randomUUID(),expectedRevision:saved.item.revision,reviewed:{...draft.reviewed,vessel}})));
   assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);assert.equal((await get(1,{id:draft.id})).item.revision,2);
   assert.doesNotMatch(await query("select details::text from eco_private.administration_events where action like 'commercial-enquiry-%'"),/PRIVATE|rawText|buyer/);
  });
  await t.test('original owned inbox linkage immutable, exact raw preserved, unique across fresh requests and reload',async()=>{
   await seed();const input=payload();input.source.inboxId=inboxIds[1];assert.deepEqual(await get(1,{inboxId:inboxIds[1]}),{item:null});const saved=await mutate(1,input);
   assert.deepEqual((await get(1,{inboxId:inboxIds[1]})).item,saved.item);await assert.rejects(get(0,{inboxId:inboxIds[1]}),/not found/);
   await assert.rejects(mutate(1,{...input,id:randomUUID(),requestId:randomUUID()}),/already exists/);
   await assert.rejects(mutate(0,{...input,id:randomUUID(),requestId:randomUUID()}),/Owned inbox/);
   await assert.rejects(mutate(1,{...input,requestId:randomUUID(),expectedRevision:1,source:{...input.source,rawText:'ALTERED'}}),/source cannot change/);
   const other=payload();other.source.inboxId=inboxIds[2];other.source.rawText='ALTERED';await assert.rejects(mutate(2,other),/Owned inbox/);
   await query(`update eco_private.inbox_messages set status='quarantined',owner_id=null,raw_text=null,sender_display=null,reason='unknown_sender' where id=${lit(inboxIds[2])}`);other.source.rawText=input.source.rawText;await assert.rejects(mutate(2,other),/Owned inbox/);
  });
  await t.test('draft unknown port allowed; canonical confirm without buyer; non-Singapore never queues',async()=>{
   await seed();const input=payload();input.reviewed.portId=null;input.reviewed.buyerText=null;input.reviewed.products=[];input.reviewed.vessel='';await mutate(1,input);
   await assert.rejects(mutate(1,{...input,requestId:randomUUID(),expectedRevision:1,action:'confirm'}),/Complete/);
   for(const portId of ['port-singapore','port-tokyo']){const p=payload({action:'confirm'});p.reviewed.buyerText=null;p.reviewed.portId=portId;const r=await mutate(1,p);assert.equal(r.item.port.id,portId);assert.equal(r.item.queue?.status,portId==='port-singapore'?'awaiting_connection':undefined);}
   assert.equal(await query('select count(*) from eco_private.commercial_enquiry_queue'),'1');
  });
  await t.test('direct RPC validates full input and cannot smuggle routing, ownership or malformed fields',async()=>{
   await seed();const changes=[p=>p.dataMode='test',p=>delete p.dataMode,p=>p.ownerId=users[0],p=>p.expectedRevision=-1,p=>p.action=null,p=>p.reviewed.portId='SINGAPORE',p=>p.reviewed.countryCode='SG',p=>p.reviewed.buyerId='prototype',p=>p.source.rawText='港'.repeat(6667),p=>p.source.receivedAt='2099-01-01',p=>p.reviewed.rmk='true',p=>p.reviewed.products.push(p.reviewed.products[0]),p=>p.reviewed.warnings=['\u0001'],p=>p.reviewed.viscosity=['180']];
   for(const change of changes){const p=payload({action:'confirm'});change(p);await assert.rejects(mutate(1,p),/Invalid|Unknown|connected|LIVE|Duplicate/);}
   for(const quantityText of ['0','200-100','1000001','1e3','1,00 MT','NaN','-1','1/-2']){const p=payload({action:'confirm'});p.reviewed.products[0].quantityText=quantityText;await assert.rejects(mutate(1,p),/Invalid quantity/);}
   assert.equal(await query('select count(*) from eco_private.commercial_enquiries'),'0');
   for(const quantityText of ['1,000 MT','500/700','500–700','500—700','500 to 700 MTS','500 ~ 700 metric tonnes','100.12345',' 100 MT ','100\tMT','\t100 MT','\n100 MT\n','\u00a0100\u00a0MT\u00a0','\ufeff500\u2009to\u2009700\u3000MT']){const p=payload({action:'confirm'});p.reviewed.products[0].quantityText=quantityText;assert.equal((await mutate(1,p)).item.products[0].quantityText,quantityText);}
  });
  await t.test('no preview, revoked/inactive/unconfirmed/expired/access-hold sessions or missing MFA can read or write',async()=>{
   await seed();await as(0,"select public.eco_set_preview('admin','hk')");for(const run of [()=>get(0),()=>mutate(0,payload())])await assert.rejects(run(),/read.only/);
   for(const sql of [`update eco_private.users set is_active=false where id=${lit(users[1])}`,`update auth.sessions set not_after=now()-interval '1 second' where id=${lit(sessions[1])}`,`insert into eco_private.revoked_sessions(session_id,user_id) values(${lit(sessions[1])},${lit(users[1])})`,`update eco_private.users set mfa_required=true where id=${lit(users[1])}`,`update auth.users set email_confirmed_at=null where id=${lit(users[1])}`,`update eco_private.users set access_hold_request=${lit(randomUUID())} where id=${lit(users[1])}`]){await seed();await query(sql);await assert.rejects(get(1),/Unauthorized/);await assert.rejects(mutate(1,payload()),/Unauthorized/);}
   await seed();await assert.rejects(as(1,`select public.eco_get_commercial_enquiries(${json({dataMode:'live'})})`,{session_id:randomUUID()}),/Unauthorized/);
  });
  await t.test('stable bounded keyset lists and malformed query rejection',async()=>{
   await seed();const ids=[];for(let i=0;i<5;i++)ids.push((await mutate(1,payload({action:'confirm'}))).item.id);
   for(const scope of ['mine','singapore']){const seen=[];let cursor;do{const page=await get(scope==='mine'?1:2,{scope,limit:2,...(cursor?{cursor}:{})});seen.push(...page.items.map(x=>x.id));cursor=page.nextCursor;}while(cursor);assert.deepEqual(seen,ids.toReversed());}
   for(const extra of [{limit:0},{limit:51},{limit:'1'},{cursor:'infinity|'+randomUUID()},{scope:'all'},{id:ids[0],limit:2},{inboxId:inboxIds[1],id:ids[0]},{owner:users[1]}])await assert.rejects(get(1,extra),/Invalid/);
   await assert.rejects(get(1,{dataMode:'test'}),/LIVE/);
  });
  await t.test('operator removal of exact synthetic enquiry cascades only its queue, history and receipts',async()=>{
   await seed();const first=await mutate(1,payload({action:'confirm'})),second=await mutate(1,payload({action:'confirm'}));await query(`delete from eco_private.commercial_enquiries where id=${lit(first.item.id)}`);
   for(const table of ['commercial_enquiry_queue','commercial_enquiry_history','commercial_enquiry_mutations']){assert.equal(await query(`select count(*) from eco_private.${table} where enquiry_id=${lit(first.item.id)}`),'0');assert.equal(await query(`select count(*) from eco_private.${table} where enquiry_id=${lit(second.item.id)}`),'1');}
   assert.equal((await get(1)).items.length,1);
  });
 }finally{if(started)await exec(join(bin,'pg_ctl'),['-D',data,'-m','immediate','-w','stop'],{env}).catch(()=>{});await rm(root,{recursive:true,force:true});}
});
