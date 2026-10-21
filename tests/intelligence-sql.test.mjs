import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { applySchemaMigrations } from './fixtures/migrations.mjs';
const exec=promisify(execFile),lit=v=>`'${String(v).replaceAll("'","''")}'`,json=v=>`${lit(JSON.stringify(v))}::jsonb`;
const ids=[randomUUID(),randomUUID()],sessions=ids.map(()=>randomUUID());
const snapshot=()=>({schemaVersion:1,portId:'port-example',recordedAt:'2025-01-31T23:59:59.000Z',supplierRecordedAt:'2025-01-31T00:00:00.000Z',periodStart:'2025-01-01',periodEnd:'2025-01-31',sourceUrl:'https://example.test/fixtures',supplierSourceUrl:'https://example.test/suppliers',suppliers:[{id:'spc-example',name:'Synthetic Private Supplier',portIds:['port-example'],grades:['VLSFO'],paymentTerms:'Synthetic private terms'}],counts:[{supplierId:'spc-example',date:'2025-01-03',count:3},{supplierId:'spc-example',date:'2025-01-04',count:2}]});
const batch=extra=>({requestId:randomUUID(),operatorId:ids[0],expectedActiveId:null,sourceHash:'a'.repeat(64),snapshot:snapshot(),...extra});
test('private intelligence on isolated native PostgreSQL',async t=>{
 const bin=process.env.ECO_NATIVE_PG_BIN;assert.ok(bin&&isAbsolute(bin),'Set ECO_NATIVE_PG_BIN; no remote fallback.');
 const root=await mkdtemp(join(tmpdir(),'eco-intelligence-pg-')),socket=join(root,'socket'),data=join(root,'data');await mkdir(socket,{mode:0o700});
 const env={PATH:process.env.PATH,LANG:'C',LC_ALL:'C',PGPASSFILE:join(root,'none')};let started=false;
 const query=sql=>new Promise((resolve,reject)=>{
  const p=spawn(join(bin,'psql'),['-X','-q','-A','-t','--no-password','-h',socket,'-p','55499','-U','eco_fixture','-d','postgres','-v','ON_ERROR_STOP=1'],{env});let output='',errors='';
  p.stdout.on('data',b=>output+=b);p.stderr.on('data',b=>errors+=b);p.on('error',reject);p.on('close',code=>code===0?resolve(output.trim()):reject(new Error(errors)));p.stdin.on('error',reject);p.stdin.end(sql);
 });
 const as=(i,sql,claims={})=>query(`begin;set local role authenticated;do $$begin perform set_config('request.jwt.claims',${lit(JSON.stringify({sub:ids[i],session_id:sessions[i],aal:'aal1',...claims}))},true);end$$;${sql};commit;`);
 const read=i=>as(i,'select public.eco_intelligence_snapshot()').then(JSON.parse);
 const service=input=>query(`begin;set local role service_role;select public.eco_import_intelligence_snapshot(${json(input)});commit;`).then(JSON.parse);
 const seed=async()=>{
  await query(`truncate eco_private.intelligence_active_snapshot,eco_private.intelligence_snapshots;truncate eco_private.administration_events;truncate auth.users cascade;
  insert into auth.users(id,email,email_confirmed_at,encrypted_password) values ${ids.map((id,i)=>`(${lit(id)},'person${i}@example.test',now(),'synthetic')`).join(',')};
  update eco_private.users set office_id='hk',display_name='Synthetic member',is_active=true,activated_at=now(),is_admin=id=${lit(ids[0])};
  insert into auth.sessions(id,user_id) values ${ids.map((id,i)=>`(${lit(sessions[i])},${lit(id)})`).join(',')};`);
 };
 try{
  await exec(join(bin,'initdb'),['-D',data,'-U','eco_fixture','-A','trust','--no-locale','--encoding=UTF8'],{env});
  await exec(join(bin,'pg_ctl'),['-D',data,'-l',join(root,'server.log'),'-o',`-k ${socket} -p 55499 -c listen_addresses=''`,'-w','start'],{env});started=true;
  await query(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
  create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,encrypted_password text,raw_app_meta_data jsonb not null default '{}');
  create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),not_after timestamptz);
  create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
  create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
  grant usage on schema auth to authenticated,service_role;grant execute on function auth.uid(),auth.jwt() to authenticated,service_role;`);
  await applySchemaMigrations(query);await query("insert into eco_private.offices values('hk','Hong Kong') on conflict do nothing");
  await t.test('empty bootstrap is unavailable; private tables/RLS and exact RPC grants',async()=>{
   await seed();assert.deepEqual(await read(1),{available:false,snapshot:null});
   for(const table of ['intelligence_snapshots','intelligence_active_snapshot']){
    assert.equal(await query(`select count(*) from eco_private.${table}`),'0');assert.equal(await query(`select relrowsecurity from pg_class where oid='eco_private.${table}'::regclass`),'t');
    for(const role of ['anon','authenticated','service_role'])await assert.rejects(query(`set role ${role};select * from eco_private.${table}`),/permission denied/);
   }
   await assert.rejects(query('set role anon;select public.eco_intelligence_snapshot()'),/permission denied/);
   await assert.rejects(as(0,`select public.eco_import_intelligence_snapshot(${json(batch())})`,{role:'service_role'}),/permission denied/);
   assert.equal(await query("select migration_head from eco_private.platform_versions where component='intelligence'"),'20261021020652');
  });
  await t.test('service import preserves IDs/dates, derives totals, records private history and permits read-only preview',async()=>{
   await seed();const input=batch(),receipt=await service(input);assert.equal(receipt.snapshotId,input.requestId);assert.equal(receipt.previousSnapshotId,null);
   const result=await read(1);assert.equal(result.available,true);assert.equal(result.snapshot.id,input.requestId);assert.equal(result.snapshot.suppliers[0].id,'spc-example');assert.equal(result.snapshot.suppliers[0].fixtureCount,5);assert.deepEqual(result.snapshot.counts,input.snapshot.counts);assert.equal(result.snapshot.suppliers[0].fixturePeriod,'2025-01-01 – 2025-01-31');assert.equal(result.snapshot.suppliers[0].recordedAt,input.snapshot.recordedAt);
   await as(0,"select public.eco_set_preview('trader','hk')");assert.deepEqual(await read(0),result);
   assert.equal(await query('select count(*) from eco_private.intelligence_snapshots'),'1');assert.doesNotMatch(await query("select details::text from eco_private.administration_events where action='intelligence-import'"),/Synthetic|paymentTerms|rawText/);
  });
  await t.test('exact retries, concurrent imports and compare-and-swap never restore obsolete data',async()=>{
   await seed();const first=batch();const receipts=await Promise.all(Array.from({length:3},()=>service(first)));assert.deepEqual(receipts[0],receipts[1]);assert.equal(await query('select count(*) from eco_private.intelligence_snapshots'),'1');
   await assert.rejects(service({...first,sourceHash:'b'.repeat(64)}),/request conflict/);
   const second=batch({expectedActiveId:first.requestId,sourceHash:'b'.repeat(64)});second.snapshot.counts[0].count=8;
   await service(second);assert.equal((await read(1)).snapshot.suppliers[0].fixtureCount,10);
   assert.deepEqual(await service(first),receipts[0]);assert.equal((await read(1)).snapshot.id,second.requestId);
   await assert.rejects(service(batch({expectedActiveId:first.requestId})),/snapshot changed/);assert.equal(await query('select count(*) from eco_private.intelligence_snapshots'),'2');
   const races=await Promise.allSettled([service(batch({expectedActiveId:second.requestId})),service(batch({expectedActiveId:second.requestId}))]);assert.equal(races.filter(x=>x.status==='fulfilled').length,1);
  });
  await t.test('SQL independently rejects unknown fields/IDs, duplicate or invalid dates and forged aggregates',async()=>{
   await seed();const base=snapshot();
   const invalid=[{...base,secret:'private'},{...base,suppliers:[{...base.suppliers[0],fixtureCount:999}]},{...base,suppliers:[...base.suppliers,...base.suppliers]},{...base,counts:[...base.counts,...base.counts]},{...base,counts:[{supplierId:'unknown',date:'2025-01-03',count:2}]},{...base,counts:[{supplierId:'spc-example',date:'2025-02-30',count:2}]},{...base,counts:[{supplierId:'spc-example',date:'2025-01-03',count:0.1}]},{...base,periodEnd:'2099-01-01'},{...base,recordedAt:'2099-01-01T00:00:00Z'},{...base,sourceUrl:'https://user:secret@example.test/source'},{...base,suppliers:[{...base.suppliers[0],portIds:['other-port']}]},{...base,suppliers:[{...base.suppliers[0],name:'control\ntext'}]}];
   for(const item of invalid)await assert.rejects(service(batch({snapshot:item})));
   await assert.rejects(service(batch({operatorId:ids[1]})),/administrator/);await assert.rejects(service({...batch(),dataMode:'test'}),/Invalid input/);
   assert.deepEqual(await read(1),{available:false,snapshot:null});
  });
  await t.test('live profile/session revocation, activation, held access, verification and deletion fail closed',async()=>{
   await seed();await service(batch());
   const changes=[`update eco_private.users set is_active=false where id=${lit(ids[1])}`,`update eco_private.users set activated_at=null where id=${lit(ids[1])}`,`update eco_private.users set access_hold_request=${lit(randomUUID())} where id=${lit(ids[1])}`,`update auth.users set email_confirmed_at=null where id=${lit(ids[1])}`,`update auth.sessions set not_after=now()-interval '1 second' where id=${lit(sessions[1])}`,`insert into eco_private.revoked_sessions(session_id,user_id) values(${lit(sessions[1])},${lit(ids[1])})`,`update eco_private.users set deleted_at=now(),is_active=false,is_admin=false,is_spc_trader=false,is_manager=false where id=${lit(ids[1])}`];
   for(const sql of changes){await seed();await service(batch());await query(sql);await assert.rejects(read(1),/Unauthorized/);}
   await seed();await assert.rejects(as(1,'select public.eco_intelligence_snapshot()',{session_id:randomUUID()}),/Unauthorized/);
   await query(`update eco_private.users set is_active=false where id=${lit(ids[0])}`);await assert.rejects(service(batch()),/administrator/);
  });
 }finally{if(started)await exec(join(bin,'pg_ctl'),['-D',data,'-m','immediate','-w','stop'],{env});await rm(root,{recursive:true,force:true});}
});
