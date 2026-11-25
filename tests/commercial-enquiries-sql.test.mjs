import { applySchemaMigrations } from './fixtures/migrations.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,readdir,rm} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {gzipSync} from 'node:zlib';
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
  await query(`truncate eco_private.fixture_supply_lines,eco_private.fixture_bookings,eco_private.commercial_enquiry_mutations,eco_private.commercial_enquiry_history,eco_private.commercial_enquiry_queue,eco_private.commercial_enquiries restart identity;truncate eco_private.administration_events,eco_private.administration_requests;truncate eco_private.inbox_mutations,eco_private.inbox_messages,eco_private.inbox_sender_bindings,eco_private.inbox_sources;truncate auth.users cascade;
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
  await t.test('buyer assignment, supplier confirmation and split fuel lines are atomic and account scoped', async () => {
   await seed();
   const input=payload({action:'confirm'});
   const enquiry=(await mutate(1,input)).item;
   const supplierA=randomUUID(),supplierB=randomUUID();
   await query(`insert into eco_private.suppliers (id,source_key,record) values
      (${lit(supplierA)},'test-shared-a','{"countryCode":"SG","legalName":"Synthetic A Ltd","shortName":"SYNTHETIC A"}'),
      (${lit(supplierB)},'test-shared-b','{"countryCode":"SG","legalName":"Synthetic B Ltd","shortName":"SYNTHETIC B"}')`);
   const write=(i,extra)=>call(i,'eco_mutate_fixture',{dataMode:'live',...extra});
   const read=(i,extra)=>call(i,'eco_get_fixtures',{dataMode:'live',...extra});
   const list=i=>as(i,"select public.eco_list_fixture_history(0,0,'',0)").then(JSON.parse);
   const assign={action:'assign',requestId:randomUUID(),enquiryId:enquiry.id,expectedRevision:0,
    supplierTraderId:users[2],date:'2026-10-20',eta:'2026-10-21',etaEnd:'2026-10-25',etaKind:'range',etaReviewed:false};
   const options=await read(1,{options:true});
   assert.deepEqual(options.traders.map(item=>item.id),[users[2]]);
   assert.ok(options.accounts.some(account=>account.id==='sg'));
   assert.equal(options.accounts.some(account=>account.id==='CREDIT'),false);
   await assert.rejects(write(2,assign),/Enquiry not found/);
   await assert.rejects(write(1,{...assign,supplierTraderId:users[3]}),/active SPC supplier trader/);
   await assert.rejects(write(1,{...assign,etaEnd:'2026-10-19'}),/Invalid ETA range/);
   const booking=await write(1,assign);
   assert.equal(booking.status,'pending');
   assert.deepEqual(await write(1,assign),booking);
   assert.equal((await get(1)).items[0].fixture.id,booking.id);
   assert.equal((await get(2,{scope:'singapore'})).items[0].fixture,undefined);
   assert.equal((await list(2)).items[0].vlsfo,'100-200');
   assert.deepEqual(await list(3),{total:0,items:[]});
   await assert.rejects(read(3,{id:booking.id}),/Fixture not found/);
   const revised=await write(1,{...assign,requestId:randomUUID(),expectedRevision:1,eta:'2026-10-22'});
   assert.equal(revised.id,booking.id);
   assert.equal(revised.revision,2);
   const line={grade:'VLSFO',quantity:500,supplierId:supplierA,accountId:'sg',buyPrice:510};
   const confirm={action:'confirm',requestId:randomUUID(),id:booking.id,expectedRevision:2,
     lines:[line,{...line,quantity:250,supplierId:supplierB,accountId:'hk',buyPrice:490}],quantityReviewed:false};
   await assert.rejects(write(1,confirm),/Assigned SPC supplier trader required/);
   await assert.rejects(write(2,{...confirm,expectedRevision:1}),/revision conflict/);
   await assert.rejects(write(2,{...confirm,lines:[line,{...line,quantity:'100-200'}]}),/agreed quantity/);
   await assert.rejects(write(2,{...confirm,lines:[{...line,accountId:'UNKNOWN'}]}),/office account/);
   await assert.rejects(write(2,{...confirm,lines:[{...line,accountId:'CREDIT'}]}),/office account/);
   await assert.rejects(write(2,{...confirm,lines:[{...line,quantity:10}]}),/unusually/);
   await query(`update eco_private.suppliers set closed_at=now() where id=${lit(supplierB)}`);
   await assert.rejects(write(2,confirm),/active Singapore supplier/);
   assert.equal(await query('select count(*) from eco_private.fixture_supply_lines'),'0');
   await query(`update eco_private.suppliers set closed_at=null where id=${lit(supplierB)}`);
   const [saved,retry]=await Promise.all([write(2,confirm),write(2,confirm)]);
   assert.deepEqual(saved,retry);
   assert.equal(saved.status,'confirmed');
   assert.equal(saved.canConfirm,false);
   assert.deepEqual(saved.lines.map(item=>[item.quantity,item.supplier,item.buyPrice,item.accountId,item.account]),
     [[500,'SYNTHETIC A',510,'sg','Singapore'],[250,'SYNTHETIC B',490,'hk','Hong Kong']]);
   assert.equal((await list(1)).items[0].vlsfo,'750');
   assert.equal((await list(1)).items[0].price,null);
   assert.equal((await read(1,{id:booking.id})).confirmedAt,saved.confirmedAt);
   assert.equal((await get(1)).items[0].fixture.status,'confirmed');
   await assert.rejects(write(1,{...assign,expectedRevision:saved.revision,requestId:randomUUID()}),/revision conflict/);
   assert.equal(await query('select count(*) from eco_private.fixture_supply_lines'),'2');
   const cancel={action:'cancel',requestId:randomUUID(),id:booking.id,expectedRevision:saved.revision,reason:'Fixture withdrawn'};
   assert.equal((await read(0,{id:booking.id})).canCancel,true);
   assert.equal((await read(1,{id:booking.id})).canCancel,false);
   assert.equal((await read(2,{id:booking.id})).canCancel,true);
   await assert.rejects(write(1,cancel),/cancellation is unavailable/);
   await assert.rejects(write(2,{...cancel,reason:' '}),/Invalid input/);
   await assert.rejects(write(2,{...cancel,reason:'\t\n'}),/Cancellation reason is required/);
   const cancelled=await write(2,cancel);
   assert.equal(cancelled.cancelled,true);
   assert.equal(cancelled.canCancel,false);
   assert.equal(cancelled.cancellation.reason,'Fixture withdrawn');
   assert.deepEqual(cancelled.lines,saved.lines);
   assert.deepEqual(await write(2,cancel),cancelled);
   assert.equal((await list(1)).items[0].cancelled,true);
   assert.equal((await get(1)).items[0].fixture.cancelled,true);
   await assert.rejects(write(2,{...confirm,expectedRevision:cancelled.revision,requestId:randomUUID()}),/revision conflict/);
   const pendingEnquiry=(await mutate(1,payload({action:'confirm'}))).item;
   const pending=await write(1,{...assign,enquiryId:pendingEnquiry.id,requestId:randomUUID()});
   const cancelPending={...cancel,id:pending.id,expectedRevision:pending.revision,requestId:randomUUID()};
   await assert.rejects(write(0,cancelPending),/cancellation is unavailable/);
   await assert.rejects(write(2,cancelPending),/cancellation is unavailable/);
   assert.equal((await write(1,cancelPending)).cancelled,true);
   await assert.rejects(write(1,{...assign,enquiryId:pendingEnquiry.id,expectedRevision:2,requestId:randomUUID()}),/revision conflict/);
   const newEnquiry = (await mutate(1,payload({action:'confirm'}))).item;
   const draft = await write(1,{...assign,enquiryId:newEnquiry.id,requestId:randomUUID()});
   const editor = i => as(i,`select public.eco_get_fixture_editor(${lit(draft.id)})`).then(JSON.parse);
   const edit = (i,body) => call(i,'eco_mutate_fixture_register',{dataMode:'live',id:draft.id,requestId:randomUUID(),...body});
   const change = (i,body) => call(i,'eco_change_fixture_cancellation',{dataMode:'live',id:draft.id,requestId:randomUUID(),...body});
   const cancelDraft = {action:'cancel',expectedRevision:draft.revision,requestId:randomUUID()};
   await assert.rejects(change(0,cancelDraft),/cancellation is unavailable/);
   const [cancelledDraft, retryDraft] = await Promise.all([change(1,cancelDraft),change(1,cancelDraft)]);
   assert.deepEqual(cancelledDraft,retryDraft);
   assert.equal(cancelledDraft.assignment.cancelled,true);
   assert.equal(await query(`select cancellation_reason is null from eco_private.fixture_bookings where id=${lit(draft.id)}`),'t');
   assert.equal((await read(1,{id:draft.id})).cancellation.reason,'');
   await assert.rejects(change(1,{action:'reinstate',expectedRevision:draft.revision}),/Fixture changed/);
   assert.equal((await change(1,{action:'reinstate',expectedRevision:cancelledDraft.assignment.revision})).assignment.cancelled,false);
   const before = await editor(2);
   assert.equal(before.canConfirm,true);
   assert.equal(before.canCancel,false);
   await assert.rejects(editor(1),/editing is unavailable/);
   const fields = {...before.fields,etaEnd:'2026-10-26',lines:[{grade:'VLSFO',quantity:'25',supplierId:supplierA,accountId:'sg',price:'510',barging:'1,500',cancelled:false}]};
   const saveDraft = {action:'update',version:before.version,fields,quantityReviewed:false};
   await edit(0,saveDraft);
   const draftEditor = await editor(2);
   assert.equal(draftEditor.item.status,'pending');
   assert.deepEqual(draftEditor.fields,fields);
   const complete = {...saveDraft,action:'complete',version:draftEditor.version};
   await assert.rejects(edit(0,complete),/Assigned SPC supplier trader required/);
   await assert.rejects(edit(2,complete),/Review unusually/);
   assert.equal((await read(2,{id:draft.id})).lines.length,0);
   await edit(2,{...complete,quantityReviewed:true});
   let finished = await editor(2);
   assert.equal(finished.item.status,'confirmed');
   assert.equal(finished.item.vlsfo,'25');
   assert.equal((await read(1,{id:draft.id})).lines[0].barging,'1,500');
   await change(2,{action:'cancel',version:finished.version});
   const canceledEditor = await editor(2);
   assert.equal(canceledEditor.canCancel,false);
   assert.equal(canceledEditor.canReinstate,true);
   assert.equal(canceledEditor.item.cancellation.reason,null);
   await assert.rejects(change(1,{action:'reinstate',expectedRevision:cancelledDraft.assignment.revision+3}),/cancellation is unavailable/);
   await change(0,{action:'reinstate',version:canceledEditor.version});
   finished = await editor(2);
   assert.equal(finished.item.cancelled,false);
   assert.deepEqual(finished.fields.lines,canceledEditor.fields.lines);
   await edit(2,{action:'delete',version:finished.version});
   await assert.rejects(read(1,{id:draft.id}),/Fixture not found/);
   await edit(0,{action:'restore',version:(await editor(0)).version});
   assert.equal((await read(1,{id:draft.id})).lines[0].quantity,25);
   for(const table of ['fixture_bookings','fixture_supply_lines']) {
    assert.equal(await query(`select relrowsecurity from pg_class where oid='eco_private.${table}'::regclass`),'t');
    await assert.rejects(as(2,`select * from eco_private.${table}`),/permission denied/);
   }
  });
  await t.test('fixture history links canonical records and limits reads to authorised live members', async () => {
   await seed();
   const supplier = randomUUID();
   const table = 'eco_private.fixture_history';
   const workbook = 'fixture_test_workbook';
   const insert = (row, seller, buyer, date = '2025-09-08', supplierId = supplier, digest = String(row).padStart(64, '0')) =>
    `insert into ${table} (fixture_date,supplier_trader_id,buyer_trader_id,supplier_id,vessel,vlsfo,
      source_workbook,source_tab,source_row,source_digest,source_labels)
     values (${lit(date)},${lit(seller)},${lit(buyer)},${lit(supplierId)},'SYNTHETIC SHIP','100–200',
      ${lit(workbook)},1,${row},${lit(digest)},'{"supplier":"OLD PROVIDER LABEL","supplierOffice":"SINGAPORE","buyerOffice":"GENOA"}')`;
   const list = (i, args = "0,0,'',0") => as(i, `select public.eco_list_fixture_history(${args})`).then(JSON.parse);
   await query(`insert into eco_private.suppliers (id,source_key,record) values (${lit(supplier)},'fixture-supplier',
    '{"countryCode":"SG","legalName":"Synthetic Supplier Limited","shortName":"SYNTHETIC SUPPLIER"}')`);
   await query(`${insert(2, users[1], users[2])};${insert(3, users[2], users[1], '2026-06-09')};${insert(4, users[2], users[0])}`);
   await assert.rejects(query(insert(2, users[1], users[2])), /duplicate key/);
   await assert.rejects(query(insert(5, users[1], users[2], '2024-12-31')), /check constraint/);
   await assert.rejects(query(insert(5, users[1], users[2], '2025-09-08', randomUUID())), /foreign key/);
   await assert.rejects(query(insert(5, users[1], randomUUID())), /foreign key/);
   for (const role of ['anon', 'authenticated', 'service_role'])
    await assert.rejects(query(`set role ${role}; select * from ${table}`), /permission denied/);
   for (const role of ['anon', 'service_role'])
    await assert.rejects(query(`set role ${role}; select public.eco_list_fixture_history(0,0,'',0)`), /permission denied/);
   const page = await list(1);
   assert.equal(page.total, 2);
   assert.deepEqual(page.items.map(item => item.date), ['2026-06-09', '2025-09-08']);
   assert.equal(page.items[0].supplier, 'SYNTHETIC SUPPLIER');
   assert.equal(page.items[0].supplierId, supplier);
   assert.equal(page.items[0].buyerOffice, 'GENOA');
   assert.equal(page.items[0].vlsfo, '100–200');
   assert.equal(page.items[0].imo, null);
   assert.doesNotMatch(JSON.stringify(page), /OLD PROVIDER LABEL|fixture_test_workbook|sourceDigest|sourceRow/);
   for (const i of [0, 2]) assert.equal((await list(i)).total, 3);
   assert.deepEqual(await list(3), { total: 0, items: [] });
   assert.equal((await list(1, "2025,9,'ship old provider',0")).total, 1);
   assert.equal((await list(1, "2025,9,'%',0")).total, 0);
   assert.deepEqual(await list(1, "0,0,'',1"), { total: 2, items: [] });
   await assert.rejects(list(1, "2100,0,'',0"), /Invalid fixture filters/);
   const reviews = 'eco_private.fixture_history_source_reviews';
   await query(`insert into ${reviews} (fixture_id,cancelled,vessel,vlsfo,source_modified_at,source_evidence)
     select id,false,'REPLACEMENT SHIP','150',now(),'{"original":"SYNTHETIC SOURCE REVIEW"}'::jsonb from ${table} where source_row=3
     union all select id,true,null,null,now(),'{}'::jsonb from ${table} where source_row=2`);
   const amended = (await list(1, "0,0,'replacement ship',0")).items[0];
   assert.equal(amended.vessel, 'REPLACEMENT SHIP');
   assert.equal(amended.vlsfo, '150');
   assert.equal(amended.cancelled, false);
   const cancelled = (await list(1, "2025,9,'synthetic ship',0")).items[0];
   assert.equal(cancelled.cancelled, true);
   assert.equal(cancelled.vlsfo, '100–200');
   await query(`update ${reviews} set vlsfo=null,removed_grades=array['VLSFO'],lsmgo='150',barging='1,500'
     where fixture_id=(select id from ${table} where source_row=3)`);
   const regraded = (await list(1, "0,0,'replacement ship',0")).items[0];
   assert.deepEqual([regraded.vlsfo,regraded.lsmgo,regraded.barging],[null,'150','1,500']);
   assert.equal(await query(`select vessel || ' ' || vlsfo from ${table} where source_row=3`), 'SYNTHETIC SHIP 100–200');
   assert.doesNotMatch(JSON.stringify(await list(1)), /SYNTHETIC SOURCE REVIEW|source_evidence/);
   await assert.rejects(as(1, `select * from ${reviews}`), /permission denied/);
   const group = randomUUID();
   await query(`${insert(5, users[1], users[2])};${insert(6, users[1], users[2])};
     update ${table} set booking_group_id=${lit(group)},vessel='SYNTHETIC GROUP',price='110' where source_row=5;
     update ${table} set booking_group_id=${lit(group)},vessel='SYNTHETIC GROUP',vlsfo=null,lsmgo='40–50',price='120' where source_row=6;`);
   const split = await list(1, "0,0,'synthetic group',0");
   assert.equal(split.total,1);
   assert.equal(split.items[0].id,group);
   assert.equal(split.items[0].vlsfo,'100–200');
   assert.equal(split.items[0].lsmgo,'40–50');
   assert.deepEqual(split.items[0].supplyRows.map(row=>[row.vlsfo,row.lsmgo,row.price]),[['100–200',null,'110'],[null,'40–50','120']]);
   const editor = i => as(i,`select public.eco_get_fixture_editor(${lit(group)})`).then(JSON.parse);
   const edit = (i,body) => call(i,'eco_mutate_fixture_register',{dataMode:'live',id:group,requestId:randomUUID(),...body});
   const firstEdit = await editor(1);
   assert.equal(firstEdit.item.canEdit,true);
   assert.deepEqual(firstEdit.fields.lines.map(line=>[line.grade,line.quantity,line.price]),[['VLSFO','100–200','110'],['LSMGO','40–50','120']]);
   await assert.rejects(editor(2),/editing is unavailable/);
   assert.equal((await editor(0)).item.id,group);
   const changed = {action:'update',version:firstEdit.version,requestId:randomUUID(),quantityReviewed:false,fields:{...firstEdit.fields,
     imo:'9876543',eta:'2025-09-09',etaEnd:'2025-09-10',etaKind:'range',lines:firstEdit.fields.lines.map(line=>({...line,price:'130'}))}};
   await assert.rejects(edit(2,changed),/editing is unavailable/);
   await assert.rejects(edit(1,{...changed,fields:{...changed.fields,etaEnd:'2025-09-08'}}),/Invalid ETA range/);
   assert.deepEqual(await Promise.all([edit(1,changed),edit(1,changed)]),[{id:group},{id:group}]);
   const revised = await editor(1);
   assert.deepEqual([revised.item.imo,revised.item.etaEnd,revised.fields.lines[0].price],['9876543','2025-09-10','130']);
   await assert.rejects(edit(1,{...changed,requestId:randomUUID()}),/Fixture changed/);
   assert.equal(await query(`select price from ${table} where source_row=5`),'110');
   await query(`insert into ${reviews}(fixture_id,cancelled,vlsfo,source_modified_at,source_evidence)
     select id,false,'175',now(),'{}' from ${table} where source_row=5`);
   const revisedSource = await editor(1);
   assert.equal(revisedSource.fields.imo,'9876543');
   assert.deepEqual(revisedSource.fields.lines.map(line=>[line.quantity,line.price]),[['175','110'],['40–50','120']]);
   assert.notEqual(revisedSource.version,revised.version);
   await edit(0,{action:'void',version:revisedSource.version,reason:'Synthetic withdrawal'});
   const withdrawn = await editor(1);
   assert.equal(withdrawn.item.cancellation.reason,'Synthetic withdrawal');
   await edit(1,{action:'delete',version:withdrawn.version});
   assert.equal((await list(1, "0,0,'synthetic group',0")).total,0);
   const removed = async i => call(i,'eco_list_fixture_register',{year:0,month:0,search:'synthetic group',page:0,deleted:true});
   assert.equal((await removed(1)).items[0].id,group);
   assert.equal((await removed(2)).total,0);
   await edit(0,{action:'restore',version:(await editor(0)).version});
   assert.equal((await list(1, "0,0,'synthetic group',0")).items[0].cancelled,true);
   assert.equal(await query(`select count(*) from eco_private.administration_events where target_id=${lit(group)}`),'4');

   await query(Array.from({length:51},(_,i)=>insert(100+i,users[2],users[0],'2026-06-09')).join(';'));
   const queryRegister = (i,extra) => call(i,'eco_list_fixture_register',{year:0,month:0,search:'',page:0,...extra});
   const filtered = await queryRegister(2,{supplierTrader:users[2],supplierOffice:'SG',buyerTrader:users[0],buyerOffice:'IT',page:1});
   assert.equal(filtered.total,52);
   assert.equal(filtered.items.length,2);
   assert.ok(filtered.filters.buyer.some(trader=>trader.id===users[0] && trader.code==='IT'));
   assert.equal((await queryRegister(1,{buyerTrader:users[0]})).total,0);
   assert.equal((await queryRegister(1,{})).filters.buyer.some(trader=>trader.id===users[0]),false);
   await query(Array.from({length:50},(_,i)=>insert(200+i,users[2],users[0],'2026-06-09')).join(';'));
   await query(`update ${table} set source_labels=jsonb_set(source_labels,'{supplierOffice}','"GENOA"') where source_row%2=0;
     update eco_private.users set office_id='sg' where id=${lit(users[2])}`);
   const filters={supplierTrader:users[2],buyerTrader:users[0]};
   const compact=await queryRegister(2,{view:'register',...filters,supplierOffice:'SG',buyerOffice:'HK'});
   assert.equal(compact.total,102);
   assert.equal(compact.items.length,100);
   assert.ok(compact.items.every(item=>item.supplierTraderId===users[2] && item.buyerTraderId===users[0]));
   assert.deepEqual(compact.filters.supplier.filter(trader=>trader.id===users[2]).map(trader=>trader.code),['SG']);
   assert.deepEqual(compact.filters.buyer.filter(trader=>trader.id===users[0]).map(trader=>trader.code),['HK']);
   assert.equal((await queryRegister(2,{view:'register',...filters,supplierOffice:'IT'})).total,0);
   const last=await queryRegister(2,{view:'register',...filters,supplierOffice:'SG',page:1});
   assert.equal(last.items.length,2);
   assert.equal(new Set([...compact.items,...last.items].map(item=>item.id)).size,102);
   assert.ok(compact.items.every(item=>!('supplyRows' in item)&&!('price' in item)&&!('buyerTrader' in item)));
   const legacyPage=await queryRegister(2,filters);
   assert.equal(legacyPage.items.length,50);
   assert.ok(legacyPage.filters.supplier.filter(trader=>trader.id===users[2]).length>1);
   const payloadSize = value => gzipSync(JSON.stringify(value)).length;
   t.diagnostic(`Compressed fixture list in the test dataset: ${payloadSize(legacyPage)} bytes at 50 rows and ${payloadSize(compact)} bytes at 100 rows`);
   await query(`insert into ${table}(fixture_date,supplier_trader_id,buyer_trader_id,supplier_id,vessel,vlsfo,
     source_workbook,source_tab,source_row,source_digest,source_labels)
     select '2026-06-09',${lit(users[2])},${lit(users[0])},${lit(supplier)},'SYNTHETIC LOAD','150',
       ${lit(workbook)},1,n,lpad(n::text,64,'0'),'{"supplierOffice":"SINGAPORE","buyerOffice":"GENOA"}'::jsonb
     from generate_series(300,1539) n`);
   const executionTimes = { legacy: [], compact: [] };
   for (let i=0;i<6;i++) for (const format of ['legacy','compact']) {
    const input = {year:0,month:0,search:'',page:0,...(format==='compact'?{view:'register'}:{})};
    const sql = `explain (analyze,timing off,format json) select public.eco_list_fixture_register(${json(input)})`;
    const milliseconds = JSON.parse(await as(2,sql))[0]['Execution Time'];
    if (i) executionTimes[format].push(milliseconds);
   }
   const median = values => values.sort((a,b)=>a-b)[2].toFixed(1);
   t.diagnostic(`Median fixture query at production scale: ${median(executionTimes.legacy)} ms at 50 rows, ${median(executionTimes.compact)} ms at 100 rows`);

   const crossedOut = cancelled.id;
   const loadCrossedOut = i => as(i,`select public.eco_get_fixture_editor(${lit(crossedOut)})`).then(JSON.parse);
   const extracted = await loadCrossedOut(1);
   assert.equal(extracted.canReinstate,true);
   const reinstate = {dataMode:'live',id:crossedOut,requestId:randomUUID(),action:'reinstate',version:extracted.version};
   await assert.rejects(call(2,'eco_change_fixture_cancellation',reinstate),/editing is unavailable/);
   await call(1,'eco_change_fixture_cancellation',reinstate);
   const reinstated = await loadCrossedOut(1);
   assert.equal(reinstated.item.cancelled,false);
   assert.equal(reinstated.item.sourceReinstated,true);
   assert.equal(await query(`select cancelled from ${reviews} where fixture_id=${lit(crossedOut)}`),'t');
   await query(`update ${reviews} set source_modified_at=now()+interval '1 minute' where fixture_id=${lit(crossedOut)}`);
   const reopened = await loadCrossedOut(1);
   assert.equal(reopened.item.cancelled,true);
   assert.notEqual(reopened.version,reinstated.version);
   await assert.rejects(call(1,'eco_change_fixture_cancellation',{...reinstate,requestId:randomUUID(),version:reinstated.version}),/Fixture changed/);
   await as(0, "select public.eco_set_preview('admin','hk')");
   await assert.rejects(list(0), /unavailable in preview/);
   await assert.rejects(editor(0),/read.only/);
   await query(`update eco_private.suppliers set archived_at=now() where id=${lit(supplier)}`);
   assert.equal((await list(1, "0,0,'replacement ship',0")).items[0].supplierAvailable, false);
   await query(`insert into eco_private.revoked_sessions(session_id,user_id) values(${lit(sessions[1])},${lit(users[1])})`);
   await assert.rejects(list(1), /Unauthorized/);
  });
 }finally{if(started)await exec(join(bin,'pg_ctl'),['-D',data,'-m','immediate','-w','stop'],{env}).catch(()=>{});await rm(root,{recursive:true,force:true});}
});
