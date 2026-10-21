import { applySchemaMigrations } from './fixtures/migrations.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { feedbackCategories, feedbackStatuses, feedbackPriorities, importKinds, importStatuses } from '../shared/admin.ts';
const exec=promisify(execFile),lit=v=>`'${String(v).replaceAll("'","''")}'`,json=v=>`${lit(JSON.stringify(v))}::jsonb`;
const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333'];
const sessions=['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','cccccccc-cccc-4ccc-8ccc-cccccccccccc'];
const queryPage=extra=>({search:'',status:'',cursor:'',limit:25,scope:'all',...extra});
const feedback=extra=>({requestId:randomUUID(),title:'Fixture feedback '+randomUUID(),description:'Synthetic fixture details',category:'issue',pagePath:'/settings',...extra});
const begin=extra=>({requestId:randomUUID(),kind:'document',sourceName:'fixture.pdf',sourceType:'application/pdf',...extra});
test('administration SQL against isolated native PostgreSQL',async t=>{
 const bin=process.env.ECO_NATIVE_PG_BIN;assert.ok(bin&&isAbsolute(bin),'Set ECO_NATIVE_PG_BIN; no remote fallback.');
 const root=await mkdtemp(join(tmpdir(),'eco-admin-pg-')),socket=join(root,'socket'),data=join(root,'data');await mkdir(socket,{mode:0o700});
 const env={PATH:process.env.PATH,LANG:'C',LC_ALL:'C',PGPASSFILE:join(root,'none')};let started=false;
 const query=async sql=>(await exec(join(bin,'psql'),['-X','-q','-A','-t','--no-password','-h',socket,'-p','55492','-U','eco_fixture','-d','postgres','-v','ON_ERROR_STOP=1','-c',sql],{env})).stdout.trim();
 const as=(i,sql)=>query(`begin;set local role authenticated;do $$begin perform set_config('request.jwt.claims',${lit(JSON.stringify({sub:ids[i],session_id:sessions[i],aal:'aal1'}))},true);end$$;${sql};commit;`);
 const call=async(i,name,payload)=>JSON.parse(await as(i,`select public.${name}(${payload===undefined?'':json(payload)})`));
 const seed=async()=>{await query(`truncate eco_private.feedback_contributions,eco_private.feedback,eco_private.import_jobs,eco_private.administration_events,eco_private.administration_requests,eco_private.operational_evidence;truncate auth.users cascade;truncate eco_private.access_audit,eco_private.login_attempts;
 insert into auth.users(id,email,email_confirmed_at,encrypted_password) values ${ids.map((id,i)=>`(${lit(id)},'person${i}@example.test',now(),'synthetic')`).join(',')};
 update eco_private.users set office_id='hk',display_name='Person',is_active=true,activated_at=now(),is_admin=id=${lit(ids[0])};
 insert into auth.sessions(id,user_id) values ${ids.map((id,i)=>`(${lit(sessions[i])},${lit(id)})`).join(',')};`);};
 try {
 await exec(join(bin,'initdb'),['-D',data,'-U','eco_fixture','-A','trust','--no-locale','--encoding=UTF8'],{env});
 await exec(join(bin,'pg_ctl'),['-D',data,'-l',join(root,'server.log'),'-o',`-k ${socket} -p 55492 -c listen_addresses=''`,'-w','start'],{env});started=true;
 await query(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,encrypted_password text,raw_app_meta_data jsonb not null default '{}');
 create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),not_after timestamptz);
 create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
 create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
 grant usage on schema auth to authenticated,service_role;grant execute on function auth.uid(),auth.jwt() to authenticated,service_role;`);
 const migrationFiles=await applySchemaMigrations(query);
 const latestMigrationHead=migrationFiles.at(-1)?.slice(0,14) || '20261020075427';
 await query("insert into eco_private.offices values('hk','Hong Kong'),('sg','Singapore')");
 await t.test('tables and helper functions are denied to browser roles; anonymous RPC denied',async()=>{
  await seed();
  for(const table of ['feedback','import_jobs','administration_events','administration_requests','feedback_contributions','operational_evidence']){
   await assert.rejects(as(1,`select * from eco_private.${table}`),/permission denied/);
   assert.equal(await query(`select relrowsecurity::text from pg_class where oid='eco_private.${table}'::regclass`),'true');
  }
  await assert.rejects(query(`set role anon;select public.eco_list_feedback(${json(queryPage())})`),/permission denied/);
  await assert.rejects(as(0,"select eco_private.admin_finish(null,null,null)"),/permission denied/);
  await assert.rejects(as(0,`select public.eco_record_monitor_evidence('{}')`),/permission denied/);
 });
 await t.test('shared UI/API options match the applied database contract on every upgrade',async()=>{
  for(const [table,field,values] of [['feedback','category',feedbackCategories],['feedback','status',feedbackStatuses],['feedback','priority',feedbackPriorities],['import_jobs','kind',importKinds],['import_jobs','status',importStatuses]]){
   const definition=await query(`select pg_get_constraintdef(oid) from pg_constraint where conrelid='eco_private.${table}'::regclass and conname='${table}_${field}_check'`);
   const stored=[...definition.matchAll(/'([a-z-]+)'::text/g)].map(match=>match[1]);assert.deepEqual(stored.sort(),[...values].sort(),`${table}.${field} differs from shared contract`);
  }
 });
 await t.test('feedback, contribution and audit commit atomically with verified actor and idempotency',async()=>{
  await seed();const input=feedback();const [a,b]=await Promise.all([call(1,'eco_create_feedback',input),call(1,'eco_create_feedback',input)]);
  assert.equal(a.id,b.id);assert.equal(a.submitterId,ids[1]);assert.equal(a.submitterName,'Person');
  for(const table of ['feedback','feedback_contributions','administration_events'])assert.equal(await query(`select count(*) from eco_private.${table}`),'1');
  await assert.rejects(call(1,'eco_create_feedback',{...input,title:'Different request'}),/Request conflict/);
  await assert.rejects(call(1,'eco_create_feedback',{...feedback(),submitterId:ids[0]}),/Invalid input/);
  assert.equal((await call(1,'eco_feedback_contributions')).count,1);assert.equal((await call(0,'eco_feedback_contributions')).count,0);
 });
 await t.test('different request IDs with normalized identical content create issues but only one contribution',async()=>{
  await seed();const a=feedback({title:'Ｓame Title',description:'Same   description'});const b=feedback({title:'  same title  ',description:'same description'});
  const results=await Promise.all([call(1,'eco_create_feedback',a),call(1,'eco_create_feedback',b)]);assert.notEqual(results[0].id,results[1].id);
  assert.equal(await query('select count(*) from eco_private.feedback'),'2');assert.equal(await query('select count(*) from eco_private.feedback_contributions'),'1');assert.equal((await call(1,'eco_feedback_contributions')).count,1);
  await call(1,'eco_create_feedback',feedback({title:'SAME TITLE',description:'same description'}));assert.equal((await call(1,'eco_feedback_contributions')).count,1);
  await call(2,'eco_create_feedback',feedback({title:'same title',description:'same description'}));assert.equal((await call(2,'eco_feedback_contributions')).count,1);
 });
 await t.test('feedback rollback never leaves a contribution or unlogged operation',async()=>{
  await seed();await query(`create function eco_private.fixture_reject_event() returns trigger language plpgsql as $$begin raise exception 'fixture audit failure';end$$;create trigger fixture_reject_event before insert on eco_private.administration_events for each row execute function eco_private.fixture_reject_event()`);
  try {await assert.rejects(call(1,'eco_create_feedback',feedback()),/fixture audit failure/);for(const table of ['feedback','feedback_contributions','administration_requests'])assert.equal(await query(`select count(*) from eco_private.${table}`),'0');}
  finally{await query('drop trigger fixture_reject_event on eco_private.administration_events;drop function eco_private.fixture_reject_event()');}
 });
 await t.test('member list cannot reveal another user, including forced all scope; admin mine works',async()=>{
  await seed();const mine=await call(1,'eco_create_feedback',feedback());await call(2,'eco_create_feedback',feedback());
  assert.deepEqual((await call(1,'eco_list_feedback',queryPage())).items.map(x=>x.id),[mine.id]);
  assert.equal((await call(0,'eco_list_feedback',queryPage())).items.length,2);assert.equal((await call(0,'eco_list_feedback',queryPage({scope:'mine'}))).items.length,0);
  assert.equal((await call(1,'eco_list_feedback',queryPage({search:'not found'}))).items.length,0);
 });
 await t.test('admin triage enforces revision, active admin assignee, resolution and one receipt',async()=>{
  await seed();const item=await call(1,'eco_create_feedback',feedback());
  const input={requestId:randomUUID(),id:item.id,expectedRevision:1,status:'in-progress',priority:'high',assigneeId:ids[0],resolution:''};
  await assert.rejects(call(1,'eco_triage_feedback',input),/Forbidden/);
  await assert.rejects(call(0,'eco_triage_feedback',{...input,assigneeId:ids[2]}),/Invalid assignee/);
  await assert.rejects(call(0,'eco_triage_feedback',{...input,status:'resolved'}),/Resolution required/);
  const races=await Promise.allSettled([call(0,'eco_triage_feedback',input),call(0,'eco_triage_feedback',{...input,requestId:randomUUID(),priority:'low'})]);
  assert.equal(races.filter(x=>x.status==='fulfilled').length,1);assert.equal(races.filter(x=>x.status==='rejected').length,1);
  assert.equal(await query("select count(*) from eco_private.administration_events where action='feedback-triaged'"),'1');
 });
 await t.test('role preview blocks every write and trader preview hides admin evidence and audit',async()=>{
  await seed();await as(0,"select public.eco_set_preview('trader','hk')");
  for(const [name,payload] of [['eco_create_feedback',feedback()],['eco_begin_import',begin()],['eco_triage_feedback',{}],['eco_transition_import',{}],['eco_retry_import',{}]]) await assert.rejects(call(0,name,payload),/read.only|Forbidden/i);
  for(const name of ['eco_list_audit','eco_admin_health','eco_admin_evidence'])await assert.rejects(call(0,name,name==='eco_list_audit'?queryPage():undefined),/Forbidden/);
  assert.equal((await call(0,'eco_list_feedback',queryPage())).items.length,0);
 });
 await t.test('inactive, revoked and deleted users cannot use administration workflows',async()=>{
  await seed();await query(`update eco_private.users set is_active=false where id=${lit(ids[1])}`);await assert.rejects(call(1,'eco_create_feedback',feedback()),/Unauthorized/);
  await query(`insert into eco_private.revoked_sessions(session_id,user_id) values(${lit(sessions[2])},${lit(ids[2])})`);await assert.rejects(call(2,'eco_list_imports',queryPage()),/Unauthorized/);
 });
 await t.test('stable keyset pagination skips no records when new feedback arrives',async()=>{
  await seed();for(let i=0;i<4;i++)await call(1,'eco_create_feedback',feedback({title:`Feedback ${i}`}));
  const first=await call(0,'eco_list_feedback',queryPage({limit:2}));assert.equal(first.items.length,2);assert.ok(first.nextCursor);
  await call(1,'eco_create_feedback',feedback());
  const second=await call(0,'eco_list_feedback',queryPage({limit:2,cursor:first.nextCursor}));assert.equal(second.items.length,2);assert.equal(second.nextCursor,null);
  assert.equal(new Set([...first.items,...second.items].map(x=>x.id)).size,4);
 });
 await t.test('import lifecycle enforces owner, terminal outcome and cannot forge published or server provenance',async()=>{
  await seed();const item=await call(1,'eco_begin_import',begin());assert.equal(item.provenance,'client-reported');
  const input={requestId:randomUUID(),id:item.id,expectedRevision:1,status:'awaiting-review',warningCount:2,summary:'Two warnings'};
  await assert.rejects(call(2,'eco_transition_import',input),/Forbidden/);await assert.rejects(call(0,'eco_transition_import',input),/Forbidden/);
  await assert.rejects(call(1,'eco_transition_import',{...input,status:'published'}),/Invalid input/);
  await assert.rejects(call(1,'eco_transition_import',{...input,provenance:'server'}),/Invalid input/);
  const ready=await call(1,'eco_transition_import',input);assert.equal(ready.status,'awaiting-review');assert.equal(ready.warningCount,2);
  assert.equal((await call(1,'eco_transition_import',input)).revision,2);
  await assert.rejects(call(1,'eco_transition_import',{...input,requestId:randomUUID(),expectedRevision:2}),/Import conflict/);
  assert.equal((await call(2,'eco_list_imports',queryPage())).items.length,0);
 });
 await t.test('retry is owner action required, never an unclaimed queued task, with no duplicate attempts',async()=>{
  await seed();const source=begin();const item=await call(1,'eco_begin_import',source);
  const failed=await call(1,'eco_transition_import',{requestId:randomUUID(),id:item.id,expectedRevision:1,status:'failed',warningCount:0,errorCode:'PARSER_FAILED'});
  const retry={requestId:randomUUID(),id:item.id,expectedRevision:failed.revision};const waiting=await call(0,'eco_retry_import',retry);
  assert.equal(waiting.status,'awaiting-retry');assert.equal(waiting.attempt,1);assert.equal((await call(0,'eco_retry_import',retry)).revision,waiting.revision);
  const resumedInput={...source,requestId:randomUUID(),retryOf:item.id,expectedRevision:waiting.revision};
  await assert.rejects(call(0,'eco_begin_import',resumedInput),/Forbidden/);
  const [a,b]=await Promise.all([call(1,'eco_begin_import',resumedInput),call(1,'eco_begin_import',resumedInput)]);assert.equal(a.attempt,2);assert.equal(b.attempt,2);
  assert.equal(await query('select count(*) from eco_private.import_jobs'),'1');
 });
 await t.test('abandoned processing can be recovered explicitly after fifteen minutes',async()=>{
  await seed();const item=await call(1,'eco_begin_import',begin());const input={requestId:randomUUID(),id:item.id,expectedRevision:1};
  await assert.rejects(call(0,'eco_retry_import',input),/Retry conflict/);await query(`update eco_private.import_jobs set updated_at=now()-interval '16 minutes' where id=${lit(item.id)}`);
  assert.equal((await call(0,'eco_retry_import',input)).status,'awaiting-retry');
 });
 await t.test('audit unifies existing server access and admin events but exposes no profile secret fields',async()=>{
  await seed();await call(1,'eco_create_feedback',feedback());await query(`insert into eco_private.access_audit(actor_id,target_id,action,before_access,after_access) values(${lit(ids[0])},${lit(ids[1])},'update-user','{"password":"secret-sentinel","phone":"private-sentinel","isAdmin":false}','{"isAdmin":true}')`);
  const result=await call(0,'eco_list_audit',queryPage());assert.equal(result.items.length,2);assert.deepEqual(new Set(result.items.map(x=>x.source)),new Set(['access','administration']));assert.doesNotMatch(JSON.stringify(result),/sentinel/);
  const first=await call(0,'eco_list_audit',queryPage({limit:1}));const second=await call(0,'eco_list_audit',queryPage({limit:1,cursor:first.nextCursor}));assert.notEqual(first.items[0].id,second.items[0].id);
  await assert.rejects(call(1,'eco_list_audit',queryPage()),/Forbidden/);
 });
 await t.test('health derives real database state and excludes human review from processing backlog',async()=>{
  await seed();await call(1,'eco_begin_import',begin());const item=await call(1,'eco_begin_import',begin());await call(1,'eco_transition_import',{requestId:randomUUID(),id:item.id,expectedRevision:1,status:'awaiting-review',warningCount:0});
  const health=await call(0,'eco_admin_health');assert.equal(health.pendingImports,1);assert.equal(health.failedImports,0);assert.equal(health.migrationHead,latestMigrationHead);assert.ok(health.oldestPendingImportAt);
  await assert.rejects(call(1,'eco_admin_health'),/Forbidden/);
 });
 await t.test('health discovers future migration heads automatically from provider history',async()=>{
  await seed();await query(`create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key);insert into supabase_migrations.schema_migrations values(${lit(latestMigrationHead)}),('99990101120000')`);
  try{assert.equal((await call(0,'eco_admin_health')).migrationHead,'99990101120000');}finally{await query('drop schema supabase_migrations cascade');}
 });
 await t.test('HK contribution boundaries and previous period are server timed and receipts cannot be inserted',async()=>{
  await seed();const a=await call(1,'eco_create_feedback',feedback());const b=await call(1,'eco_create_feedback',feedback());const c=await call(1,'eco_create_feedback',feedback());const d=await call(1,'eco_create_feedback',feedback());
  await query(`update eco_private.feedback_contributions set created_at=(((now() at time zone 'Asia/Hong_Kong')::date-6)::timestamp at time zone 'Asia/Hong_Kong') where feedback_id=${lit(a.id)};update eco_private.feedback_contributions set created_at=(((now() at time zone 'Asia/Hong_Kong')::date-6)::timestamp at time zone 'Asia/Hong_Kong')-interval '1 second' where feedback_id=${lit(c.id)};update eco_private.feedback_contributions set created_at=now()-interval '7 days 1 minute' where feedback_id=${lit(b.id)};update eco_private.feedback_contributions set created_at=now()+interval '1 hour' where feedback_id=${lit(d.id)}`);
  const result=await call(1,'eco_feedback_contributions');assert.equal(result.count,1);assert.equal(result.previousCount,1);assert.equal(result.items[0].feedbackId,a.id);assert.ok(Date.parse(result.periodEnd)<Date.now()+1000);const all=JSON.parse(await as(1,"select public.eco_feedback_contributions('all')"));assert.equal(all.count,3);assert.equal(all.previousCount,0);const days28=JSON.parse(await as(1,"select public.eco_feedback_contributions('28d')"));assert.equal(days28.count,3);
  await assert.rejects(as(1,`insert into eco_private.feedback_contributions(user_id,feedback_id) values(${lit(ids[1])},${lit(a.id)})`),/permission denied/);
 });
 await t.test('month comparison starts at the actual previous Hong Kong calendar month',async()=>{
  await seed();await call(1,'eco_create_feedback',feedback());const previous=await call(1,'eco_create_feedback',feedback());const older=await call(1,'eco_create_feedback',feedback());
  const start="((date_trunc('month',now() at time zone 'Asia/Hong_Kong')-interval '1 month') at time zone 'Asia/Hong_Kong')";
  await query(`update eco_private.feedback_contributions set created_at=${start} where feedback_id=${lit(previous.id)};update eco_private.feedback_contributions set created_at=${start}-interval '1 minute' where feedback_id=${lit(older.id)}`);
  const result=JSON.parse(await as(1,"select public.eco_feedback_contributions('month')"));assert.equal(result.count,1);assert.equal(result.previousCount,1);
 });
 await t.test('monitor evidence requires service role, validates freshness and binds replay to exact run',async()=>{
  await seed();const input={checkRun:'123456789',observedAt:new Date().toISOString(),status:'healthy',latencyMs:234,source:'github-actions',kind:'external-availability'};
  const record=v=>query(`set role service_role;select public.eco_record_monitor_evidence(${json(v)})`);
  await assert.rejects(as(0,`select public.eco_record_monitor_evidence(${json(input)})`),/permission denied/);
  await record(input);await record(input);assert.equal(await query('select count(*) from eco_private.operational_evidence'),'1');
  await assert.rejects(record({...input,status:'degraded'}),/Evidence conflict/);
  await assert.rejects(record({...input,checkRun:'2',observedAt:'2020-01-01T00:00:00Z'}),/Stale evidence/);
  await assert.rejects(record({...input,checkRun:'3',kind:'database-backup'}),/Invalid evidence/);
  assert.equal((await call(0,'eco_admin_evidence')).items.length,1);await assert.rejects(call(1,'eco_admin_evidence'),/Forbidden/);
 });
 } finally {if(started)await exec(join(bin,'pg_ctl'),['-D',data,'-m','immediate','-w','stop'],{env});await rm(root,{recursive:true,force:true});}
});
