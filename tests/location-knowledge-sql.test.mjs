import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { applySchemaMigrations } from './fixtures/migrations.mjs';

const exec = promisify(execFile), lit = value => `'${String(value).replaceAll("'", "''")}'`, json = value => `${lit(JSON.stringify(value))}::jsonb`;
const ids = [randomUUID(), randomUUID()], sessions = ids.map(() => randomUUID());
const snapshot = () => ({ schemaVersion:1, ports:[{id:'port-synthetic',name:'Synthetic',country:'Synthetic Country',code:'',timezone:'',leadTime:'',summary:'',notes:[],tags:[],updatedAt:''}],locationCountries:[{id:'Synthetic Country',name:'Synthetic Country'}],knowledgeRecords:{},knowledgeHistory:[],contributions:[],historicalContributionIds:[],legacyLocationAreas:[],legacyPortAreaIds:{} });
const input = (revision = 0) => ({requestId:randomUUID(),revision,dataMode:'live',action:{type:'add-location',kind:'country',name:'Synthetic Country'}});
test('location persistence permissions, revisions and retry receipts on isolated PostgreSQL', async t => {
 const bin=process.env.ECO_NATIVE_PG_BIN;assert.ok(bin&&isAbsolute(bin),'Set ECO_NATIVE_PG_BIN; no remote fallback.');
 const root=await mkdtemp(join(tmpdir(),'eco-location-pg-')),socket=join(root,'socket'),data=join(root,'data');await mkdir(socket,{mode:0o700});
 let initialSnapshot;
 const env={PATH:process.env.PATH,LANG:'C',LC_ALL:'C',PGPASSFILE:join(root,'none')};let started=false;
 const query=sql=>new Promise((resolve,reject)=>{const proc=spawn(join(bin,'psql'),['-X','-q','-A','-t','--no-password','-h',socket,'-p','55509','-U','eco_fixture','-d','postgres','-v','ON_ERROR_STOP=1'],{env});let output='',errors='';proc.stdout.on('data',v=>output+=v);proc.stderr.on('data',v=>errors+=v);proc.on('error',reject);proc.on('close',code=>code===0?resolve(output.trim()):reject(new Error(errors)));proc.stdin.on('error',reject);proc.stdin.end(sql);});
 const as=(index,sql,claims={})=>query(`begin;set local role authenticated;do $$begin perform set_config('request.jwt.claims',${lit(JSON.stringify({sub:ids[index],session_id:sessions[index],aal:'aal1',...claims}))},true);end$$;${sql};commit;`);
 const read=index=>as(index,'select public.eco_location_knowledge_context()').then(JSON.parse);
 const service=sql=>query(`begin;set local role service_role;${sql};commit;`).then(JSON.parse);
 const prepare=(index,value,operation='mutate',overrides={})=>service(`select public.eco_prepare_location_knowledge(${lit(overrides.actor??ids[index])}::uuid,${lit(overrides.session??sessions[index])}::uuid,${lit(overrides.aal??'aal1')},${lit(operation)},${json(value)},${typeof value.action?.body==='string'?lit(value.action.body.trim().toLowerCase()):'null'})`);
 const commit=(index,value,next=snapshot(),operation='mutate',digest=null,revision=1,archives={history:[],contributions:[],publications:[]})=>service(`select public.eco_commit_location_knowledge(${lit(ids[index])}::uuid,${lit(sessions[index])}::uuid,'aal1',${revision},${lit(operation)},${json(value)},${json(next)},${digest===null?'null':lit(digest)},${json(archives.history)},${json(archives.contributions)},${json(archives.publications)},${json(Object.fromEntries(archives.contributions.map(item=>[item.id,item.body.trim().toLowerCase()])))})`);
 const seed=async()=>{await query(`truncate eco_private.location_knowledge_revisions,eco_private.location_knowledge_requests,eco_private.location_knowledge_imports,eco_private.location_knowledge_history,eco_private.location_knowledge_contributions,eco_private.location_contribution_revisions restart identity;update eco_private.location_knowledge_state set revision=0,snapshot=${json(initialSnapshot)},updated_at=null;truncate auth.users cascade;
 insert into auth.users(id,email,email_confirmed_at,encrypted_password) values ${ids.map((id,index)=>`(${lit(id)},'location-${index}@example.test',now(),'synthetic')`).join(',')};
 update eco_private.users set office_id='hk',display_name='Synthetic member',is_active=true,activated_at=now(),is_admin=id=${lit(ids[0])};
 insert into auth.sessions(id,user_id) values ${ids.map((id,index)=>`(${lit(sessions[index])},${lit(id)})`).join(',')};`);};
 try {
  await exec(join(bin,'initdb'),['-D',data,'-U','eco_fixture','-A','trust','--no-locale','--encoding=UTF8'],{env});
  await exec(join(bin,'pg_ctl'),['-D',data,'-l',join(root,'server.log'),'-o',`-k ${socket} -p 55509 -c listen_addresses=''`,'-w','start'],{env});started=true;
  await query(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
   create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,encrypted_password text,raw_app_meta_data jsonb not null default '{}');
   create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),not_after timestamptz);
   create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
   create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
   grant usage on schema auth to authenticated,service_role;grant execute on function auth.uid(),auth.jwt() to authenticated,service_role;
   create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);
   create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb,version text,updated_at timestamptz default now());`);
  await applySchemaMigrations(query);await query("insert into eco_private.offices values('hk','Hong Kong') on conflict do nothing");
  initialSnapshot=JSON.parse(await query('select snapshot from eco_private.location_knowledge_state'));
  await t.test('authenticated reads only; RLS and execute grants prevent browser-authored snapshot commits',async()=>{
   await seed();const initial=await read(1);assert.equal(initial.envelope.revision,0);assert.deepEqual(initial.envelope.snapshot,initialSnapshot);assert.equal(initial.actorId,ids[1]);assert.equal(initial.sessionId,sessions[1]);
   for(const table of ['location_knowledge_state','location_knowledge_revisions','location_knowledge_requests','location_knowledge_imports','location_knowledge_history','location_knowledge_contributions','location_contribution_revisions']){
    assert.equal(await query(`select relrowsecurity from pg_class where oid='eco_private.${table}'::regclass`),'t');for(const role of ['anon','authenticated','service_role'])await assert.rejects(query(`set role ${role};select * from eco_private.${table}`),/permission denied/);
   }
   await assert.rejects(query('set role anon;select public.eco_location_knowledge_context()'),/permission denied/);
   for(const fn of [`eco_prepare_location_knowledge(${lit(ids[1])},${lit(sessions[1])},'aal1','mutate',${json(input())})`,`eco_commit_location_knowledge(${lit(ids[1])},${lit(sessions[1])},'aal1',1,'mutate',${json(input())},${json(snapshot())},null)`])await assert.rejects(as(1,`select public.${fn}`,{role:'service_role'}),/permission denied/);
   assert.equal(await query("select eco_private.eco_location_target_exists('port','port-synthetic')"),'f');
   assert.equal(await query("select eco_private.eco_location_target_exists('port','port-singapore')"),'t');assert.equal(await query("select eco_private.eco_location_target_exists('country','Singapore')"),'t');
  });
  await t.test('ordinary member publication is shared, immutable and exactly replayable before stale revision checks',async()=>{
   await seed();const request=input(),prepared=await prepare(1,request);assert.equal(prepared.actor.id,ids[1]);assert.equal(prepared.actor.isAdmin,false);
   const result=await commit(1,request);assert.equal(result.revision,1);const {ack,...published}=result;assert.deepEqual(ack,{requestId:request.requestId,committedRevision:1});assert.deepEqual((await read(0)).envelope,published);
   assert.deepEqual((await prepare(1,request)).result,result);assert.deepEqual(await commit(1,request,{...snapshot(),ports:[]}),result);
   assert.equal(await query('select count(*) from eco_private.location_knowledge_revisions'),'1');assert.equal(await query('select count(*) from eco_private.location_knowledge_requests'),'1');
   await assert.rejects(prepare(1,{...request,action:{...request.action,name:'Changed payload'}}),/Request conflict/);
   await assert.rejects(commit(1,input()),/Revision conflict/);
   assert.equal(await query("select eco_private.eco_location_target_exists('port','port-synthetic')"),'t');assert.equal(await query("select eco_private.eco_location_target_exists('country','Synthetic Country')"),'t');assert.equal(await query("select eco_private.eco_location_target_exists('area','Synthetic Country')"),'f');
  });
  await t.test('retry receipt acknowledges original commit and refreshes current state without retaining snapshots',async()=>{
   await seed();const first=input();await commit(1,first);const newer={...snapshot(),locationCountries:[{id:'Later Country',name:'Later Country'}]};await commit(0,input(1),newer);
   const replay=(await prepare(1,first)).result;assert.equal(replay.revision,2);assert.deepEqual(replay.snapshot,newer);assert.deepEqual(replay.ack,{requestId:first.requestId,committedRevision:1});
   assert.equal(await query("select count(*) from information_schema.columns where table_schema='eco_private' and table_name in ('location_knowledge_requests','location_knowledge_revisions') and column_name in ('result','snapshot')"),'0');
   assert.ok(Number(await query('select max(octet_length(row_to_json(r)::text)) from eco_private.location_knowledge_requests r'))<500);
  });
  await t.test('history archives page by immutable sequence; new saves do not shift older pages',async()=>{
   await seed();const history=Array.from({length:25},(_,i)=>({target:{kind:'port',id:'port-synthetic'},version:i+1,by:ids[1],at:'2026-10-21T12:00:00Z',reason:'Synthetic edit',before:{},after:{}}));
   await commit(1,input(),snapshot(),'mutate',null,1,{history,contributions:[],publications:[]});
   const targets=[{kind:'port',id:'port-synthetic'}],page=await as(0,`select public.eco_location_knowledge_history(${json(targets)})`).then(JSON.parse);assert.equal(page.items.length,20);assert.equal(page.total,25);assert.equal(page.items[0].version,25);assert.equal(page.nextCursor,'6');
   await commit(1,input(1),snapshot(),'mutate',null,1,{history:[{...history[0],version:26}],contributions:[],publications:[]});
   const next=await as(0,`select public.eco_location_knowledge_history(${json(targets)},${page.nextCursor})`).then(JSON.parse);assert.deepEqual(next.items.map(x=>x.version),[5,4,3,2,1]);assert.equal(next.nextCursor,null);
   assert.deepEqual((await read(0)).envelope.snapshot.knowledgeHistory,[]);assert.equal(await query('select count(*) from eco_private.location_knowledge_history'),'26');
   for(const args of [`'[]'::jsonb,null`,`${json([{kind:'company',id:'secret'}])},null`,`${json(targets)},-1`])await assert.rejects(as(0,`select public.eco_location_knowledge_history(${args})`),/Invalid/);
   const importInput={requestId:randomUUID(),revision:2,dataMode:'live',snapshot:snapshot()};
   await assert.rejects(commit(0,importInput,snapshot(),'migrate','b'.repeat(64),1,{history:[{...history[0],reason:'Conflicting original'}],contributions:[],publications:[]}),/History conflict/);
   assert.equal((await read(0)).envelope.revision,2);assert.equal(await query('select count(*) from eco_private.location_knowledge_imports'),'0');
  });
  await t.test('history response obeys its byte budget independently of total retained history',async()=>{
   await seed();const history=Array.from({length:3},(_,i)=>({target:{kind:'country',id:'Synthetic Country'},version:i+1,by:ids[1],at:'2026-10-21T12:00:00Z',reason:'Synthetic large audit',before:{text:'x'.repeat(1_600_000)},after:{}}));
   await commit(1,input(),snapshot(),'mutate',null,1,{history,contributions:[],publications:[]});
   const page=await as(0,`select public.eco_location_knowledge_history(${json([{kind:'country',id:'Synthetic Country'}])})`).then(JSON.parse);assert.equal(page.items.length,1);assert.equal(page.total,3);assert.ok(Buffer.byteLength(JSON.stringify(page))<3_200_000);assert.equal(page.nextCursor,'3');
  });
  await t.test('full contribution details are separate, historical imports do not recredit, prepare loads only the relevant proposal',async()=>{
   await seed();const detail={id:'synthetic-detail',targetType:'country',targetId:'Synthetic Country',author:ids[1],createdAt:'2026-10-20T00:00:00Z',status:'pending',title:'Synthetic pending',body:'  TEXT\n',historicalImport:true};
   const pub={...detail,body:'',locationPublication:{version:1,eligible:false,kind:'country',keys:[],records:[],fingerprint:'',keyInfoTransitions:[]}};
   const migrated={requestId:randomUUID(),revision:0,dataMode:'live',snapshot:snapshot()};await commit(0,migrated,snapshot(),'migrate','c'.repeat(64),1,{history:[],contributions:[detail],publications:[pub]});
   assert.deepEqual((await read(1)).envelope.snapshot.contributions,[]);
   const loaded=await as(1,`select public.eco_location_knowledge_contribution('synthetic-detail')`).then(JSON.parse);assert.deepEqual(loaded.item,detail);
   assert.equal((await prepare(1,input(1))).contributions.length,0);
   const review={requestId:randomUUID(),revision:1,dataMode:'live',action:{type:'review-contribution',id:detail.id,status:'approved'}};
   assert.deepEqual((await prepare(0,review)).contributions,[detail]);const approved={...detail,status:'approved',reviewer:ids[0],reviewedAt:'2026-10-21T00:00:00Z'};
   await commit(0,review,snapshot(),'mutate',null,1,{history:[],contributions:[approved],publications:[{...pub,status:'approved',reviewer:ids[0],reviewedAt:approved.reviewedAt}]});
   assert.equal(await query('select count(*) from eco_private.location_contribution_revisions'),'2');assert.equal(await query('select bool_and(historical) from eco_private.location_contribution_revisions'),'t');
   const duplicate={requestId:randomUUID(),revision:2,dataMode:'live',action:{type:'submit-contribution',targetType:'country',targetId:'Synthetic Country',title:'Duplicate',body:'text'}};assert.equal((await prepare(1,duplicate)).contributions.length,1);
   const facts=await as(1,'select public.eco_location_knowledge_publications(0,2)').then(JSON.parse);assert.equal(facts.items.length,1);assert.equal(facts.items[0].body,'');assert.equal(facts.items[0].historicalImport,true);assert.ok(facts.directoryIds.includes(ids[1]));
   await assert.rejects(as(1,'select public.eco_location_knowledge_publications(0,1)'),/Activity changed/);
   await assert.rejects(as(1,"select public.eco_location_knowledge_contribution('missing')"),/Not found/);
   const pending=await as(1,'select public.eco_location_knowledge_pending()').then(JSON.parse);assert.equal(pending.items.length,0);assert.equal(pending.total,0);
  });
  await t.test('same-revision competitors serialize; the loser cannot replace the first publication',async()=>{
   await seed();const requests=[input(),input()],results=await Promise.allSettled(requests.map((value,index)=>commit(index,value,{...snapshot(),locationCountries:[{id:`Country ${index}`,name:`Country ${index}`}]})));
   assert.equal(results.filter(v=>v.status==='fulfilled').length,1);assert.equal(results.filter(v=>v.status==='rejected').length,1);assert.equal(await query('select count(*) from eco_private.location_knowledge_revisions'),'1');
  });
  await t.test('VIEW AS, inactive/revoked/expired/mismatched sessions and MFA are checked again at commit',async()=>{
   await seed();const request=input();await prepare(0,request);await as(0,"select public.eco_set_preview('trader','hk')");assert.equal((await read(0)).envelope.revision,0);await assert.rejects(commit(0,request),/Preview is read only/);
   await seed();await assert.rejects(prepare(1,input(),'mutate',{session:sessions[0]}),/Unauthorized/);
   for(const change of [`update eco_private.users set is_active=false where id=${lit(ids[1])}`,`insert into eco_private.revoked_sessions(session_id,user_id) values(${lit(sessions[1])},${lit(ids[1])})`,`update auth.sessions set not_after=now()-interval '1 second' where id=${lit(sessions[1])}`,`update auth.users set email_confirmed_at=null where id=${lit(ids[1])}`,`update eco_private.users set mfa_required=true where id=${lit(ids[1])}`]){
    await seed();const request=input();await prepare(1,request);await query(change);await assert.rejects(commit(1,request),/Unauthorized/);assert.equal(await query('select revision from eco_private.location_knowledge_state'),'0');
   }
   await seed();await query(`update eco_private.users set revision=revision+1 where id=${lit(ids[1])}`);await assert.rejects(commit(1,input()),/Account changed/);
  });
  await t.test('admin-only migration records separate provenance; malformed/TEST payloads and no-op edits roll back',async()=>{
   await seed();const incoming=snapshot(),request={requestId:randomUUID(),revision:0,dataMode:'live',snapshot:incoming};
   await assert.rejects(prepare(1,request,'migrate'),/Forbidden/);await assert.rejects(commit(1,request,incoming,'migrate','a'.repeat(64)),/Forbidden/);
   const result=await commit(0,request,incoming,'migrate','a'.repeat(64));assert.equal(result.importedSources[0].importedBy,ids[0]);assert.equal(result.importedSources[0].digest,'a'.repeat(64));assert.equal(result.snapshot.contributions.length,0);
   await assert.rejects(commit(0,{...request,requestId:randomUUID(),revision:1},incoming,'migrate','a'.repeat(64)),/Source already imported/);
   await assert.rejects(commit(1,input(1),incoming),/No changes/);
   for(const bad of [{...input(1),dataMode:'test'},{...input(1),actor:ids[0]},{...input(1),revision:-1}])await assert.rejects(prepare(1,bad),/Invalid/);
   await assert.rejects(commit(1,input(1),{...incoming,privateNotes:{secret:'Synthetic'}}),/Invalid input/);
   assert.equal(await query('select count(*) from eco_private.location_knowledge_revisions'),'1');assert.equal(await query("select migration_head from eco_private.platform_versions where component='location-knowledge'"),'20261021113304');
  });
 } finally {if(started)await exec(join(bin,'pg_ctl'),['-D',data,'-m','immediate','-w','stop'],{env}).catch(()=>{});await rm(root,{recursive:true,force:true});}
});
