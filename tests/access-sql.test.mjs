import { applySchemaMigrations } from './fixtures/migrations.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';

const exec = promisify(execFile);
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
const ids = ['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333'];
const sessions = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','cccccccc-cccc-4ccc-8ccc-cccccccccccc'];

test('access SQL against isolated native PostgreSQL', async t => {
  const bin = process.env.ECO_NATIVE_PG_BIN;
  assert.ok(bin && isAbsolute(bin), 'Set ECO_NATIVE_PG_BIN to a trusted native PostgreSQL bin directory. No remote database fallback.');
  const root = await mkdtemp(join(tmpdir(), 'eco-access-pg-'));
  const socket = join(root,'socket'), data = join(root,'data'); await mkdir(socket, { mode: 0o700 });
  const env = { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C', PGPASSFILE: join(root,'no-password-file') };
  let started = false;
  const query = async sql => (await exec(join(bin,'psql'), ['-X','-q','-A','-t','--no-password','-h',socket,'-p','55491','-U','eco_fixture','-d','postgres','-v','ON_ERROR_STOP=1','-c',sql], { env })).stdout.trim();
  const as = (index, sql, aal='aal1') => query(`begin;set local role authenticated;do $$ begin perform set_config('request.jwt.claims',${literal(JSON.stringify({ sub:ids[index], session_id:sessions[index], aal }))},true);end $$;${sql};commit;`);
  const patch = (id=ids[2], extra={}) => ({ id, expectedRevision:1,displayName:'Trader',officeId:'hk',isAdmin:false,isManager:false,isSpcTrader:false,isActive:true,...extra });
  const update = input => `select public.eco_update_user(${literal(JSON.stringify(input))}::jsonb)`;
  async function seed() {
    await query(`truncate auth.users cascade;truncate eco_private.access_audit,eco_private.login_attempts;
      insert into auth.users(id,email,email_confirmed_at,encrypted_password) values
      ${ids.map((id,i)=>`(${literal(id)},'person${i}@example.test',now(),'synthetic-fixture-no-real-password')`).join(',')};
      update eco_private.users set office_id='hk',display_name='Person',is_active=true,activated_at=now(),is_admin=id in (${literal(ids[0])},${literal(ids[1])});
      insert into auth.sessions(id,user_id) values ${ids.map((id,i)=>`(${literal(sessions[i])},${literal(id)})`).join(',')};`);
  }
  try {
    await exec(join(bin,'initdb'), ['-D',data,'-U','eco_fixture','-A','trust','--no-locale','--encoding=UTF8'], { env });
    await exec(join(bin,'pg_ctl'), ['-D',data,'-l',join(root,'server.log'),'-o',`-k ${socket} -p 55491 -c listen_addresses=''`,'-w','start'], { env }); started=true;
    assert.equal(await query("select current_setting('listen_addresses')"), '');
    await query(`create role anon;create role authenticated;create role service_role bypassrls;
      create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,encrypted_password text,raw_app_meta_data jsonb not null default '{}');
      create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),not_after timestamptz);
      create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb) $$;
      create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
      grant usage on schema auth to authenticated,service_role;grant execute on function auth.uid(),auth.jwt() to authenticated,service_role;`);
    await applySchemaMigrations(query);
    await query("insert into eco_private.offices values('hk','Hong Kong'),('sg','Singapore')");
    await t.test('unknown identities default to inactive with no admin, manager or SPC authority', async () => {
      await seed();
      const id='44444444-4444-4444-8444-444444444444';
      await query(`insert into auth.users(id,email) values(${literal(id)},'unknown@example.test')`);
      assert.equal(await query(`select (not is_active and not is_admin and not is_manager and not is_spc_trader and activated_at is null)::text from eco_private.users where id=${literal(id)}`),'true');
    });
    await t.test('anon cannot call access RPCs; signed-in users cannot read or change private tables or audit', async () => {
      await seed();
      for (const sql of ['select public.eco_current_user()', 'select * from eco_private.users']) {
        await assert.rejects(query(`set role anon;${sql}`), /permission denied/);
      }
      for (const sql of ['select * from eco_private.users','delete from eco_private.access_audit']) await assert.rejects(as(0,sql), /permission denied/);
      assert.equal(JSON.parse(await as(2,'select public.eco_current_user()')).isAdmin,false);
      await assert.rejects(as(2,'select public.eco_list_users()'),/Forbidden/);
      await assert.rejects(as(2,update(patch())),/Forbidden/);
    });
    await t.test('profile changes, audit and old-session revocation commit together', async () => {
      await seed();
      const changed=JSON.parse(await as(0,update(patch(ids[2],{ isManager:true,isSpcTrader:true }))));
      assert.equal(changed.isAdmin,false); assert.equal(changed.isManager,true); assert.equal(changed.revision,2);
      assert.equal(await query('select count(*) from eco_private.access_audit'),'1');
      await assert.rejects(as(2,'select public.eco_current_user()'),/Unauthorized/);
      await assert.rejects(as(0,update(patch())),/Conflict/);
    });
    await t.test('direct RPC cannot omit conflict checks or coerce privilege flags', async () => {
      await seed();
      for (const input of [patch(ids[2],{expectedRevision:null}),patch(ids[2],{isAdmin:'true'}),patch(ids[2],{officeId:'foreign'}),patch(ids[2],{displayName:null})]) {
        await assert.rejects(as(0,update(input)),/Invalid update/);
      }
      assert.equal(await query('select count(*) from eco_private.access_audit'),'0');
    });
    await t.test('suspension then reactivation cannot resurrect old sessions', async () => {
      await seed(); await as(0,update(patch(ids[2],{isActive:false})));
      await assert.rejects(as(2,'select public.eco_current_user()'),/Unauthorized/);
      await as(0,update(patch(ids[2],{expectedRevision:2,isActive:true})));
      await assert.rejects(as(2,'select public.eco_current_user()'),/Unauthorized/);
    });
    await t.test('a revoked or expired provider session cannot use the directory', async () => {
      await seed(); await query(`delete from auth.sessions where id=${literal(sessions[0])}`);
      await assert.rejects(as(0,'select public.eco_list_users()'),/Unauthorized/);
      await query(`update auth.sessions set not_after=now()-interval '1 second' where id=${literal(sessions[1])}`);
      await assert.rejects(as(1,'select public.eco_current_user()'),/Unauthorized/);
    });
    await t.test('future mandatory two-factor policy rejects aal1 and accepts aal2', async () => {
      await seed(); await query(`update eco_private.users set mfa_required=true where id=${literal(ids[2])}`);
      await assert.rejects(as(2,'select public.eco_current_user()'),/Unauthorized/);
      assert.equal(JSON.parse(await as(2,'select public.eco_current_user()','aal2')).id,ids[2]);
    });
    await t.test('activation cannot bypass an unset password or disabled membership', async () => {
      await seed(); await query(`update eco_private.users set activated_at=null where id=${literal(ids[2])};update auth.users set encrypted_password='' where id=${literal(ids[2])}`);
      await assert.rejects(as(2,'select public.eco_current_user()'),/Unauthorized/);
      await assert.rejects(as(2,'select public.eco_finish_activation()'),/Unauthorized/);
      await query(`update auth.users set encrypted_password='synthetic-fixture-new-password' where id=${literal(ids[2])}`);
      await as(2,'select public.eco_finish_activation()');
      const activated=JSON.parse(await as(2,'select public.eco_current_user()'));
      assert.equal(activated.activated,true); assert.equal(activated.passwordChangeSuggested,false);
    });
    await t.test('optional password advice does not gate access; dismissal is durable and idempotent', async () => {
      await seed();
      assert.equal(JSON.parse(await as(2,'select public.eco_current_user()')).passwordChangeSuggested,true);
      const skipped=JSON.parse(await as(2,'select public.eco_dismiss_password_prompt()'));
      assert.equal(skipped.passwordChangeSuggested,false); assert.equal(skipped.isAdmin,false);
      await as(2,'select public.eco_dismiss_password_prompt()');
      assert.equal(await query("select count(*) from eco_private.access_audit where action='dismiss-password-prompt'"),'1');
      assert.equal(await query('select count(*) from eco_private.revoked_sessions'),'0');
      await assert.rejects(query('set role anon;select public.eco_dismiss_password_prompt()'),/permission denied/);
    });
    await t.test('password finalization cannot be forged by a browser and immediately revokes other sessions', async () => {
      await seed();
      const other='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      await query(`insert into auth.sessions(id,user_id) values(${literal(other)},${literal(ids[2])})`);
      const finish=`select public.eco_complete_password_change(${literal(ids[2])},${literal(sessions[2])})`;
      await assert.rejects(as(2,finish),/permission denied/);
      await assert.rejects(query(`set role service_role;select public.eco_complete_password_change(${literal(ids[2])},${literal(sessions[0])})`),/Unauthorized/);
      await assert.rejects(as(2,`select public.eco_begin_password_change(${literal(ids[2])},${literal(sessions[2])})`),/permission denied/);
      await query(`set role service_role;select public.eco_begin_password_change(${literal(ids[2])},${literal(sessions[2])})`);
      const changed=JSON.parse(await query(`set role service_role;${finish}`));
      assert.equal(changed.passwordChangeSuggested,false);
      assert.equal(await query(`select count(*) from eco_private.revoked_sessions where session_id=${literal(other)}`),'1');
      assert.equal(JSON.parse(await as(2,'select public.eco_current_user()')).id,ids[2]);
      await assert.rejects(query(`begin;set local role authenticated;select set_config('request.jwt.claims',${literal(JSON.stringify({sub:ids[2],session_id:other,aal:'aal1'}))},true);select public.eco_current_user();commit;`),/Unauthorized/);
      assert.equal(await query("select count(*) from eco_private.access_audit where action='change-password'"),'1');
    });
    await t.test('failed password completion leaves already committed revocations intact and permits a safe retry', async () => {
      await seed();
      const other='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      await query(`insert into auth.sessions(id,user_id) values(${literal(other)},${literal(ids[2])})`);
      const begin=`select public.eco_begin_password_change(${literal(ids[2])},${literal(sessions[2])})`;
      const finish=`select public.eco_complete_password_change(${literal(ids[2])},${literal(sessions[2])})`;
      await query(`set role service_role;${begin}`);
      await query(`create function eco_private.fixture_fail_password_audit() returns trigger language plpgsql as $$ begin if new.action='change-password' then raise exception 'fixture audit failure';end if;return new;end $$;
        create trigger fixture_fail_password_audit before insert on eco_private.access_audit for each row execute function eco_private.fixture_fail_password_audit();`);
      try {
        await assert.rejects(query(`set role service_role;${finish}`),/fixture audit failure/);
        assert.equal(await query(`select count(*) from eco_private.revoked_sessions where session_id=${literal(other)}`),'1');
        assert.equal(JSON.parse(await as(2,'select public.eco_current_user()')).passwordChangeSuggested,true);
      } finally { await query('drop trigger fixture_fail_password_audit on eco_private.access_audit;drop function eco_private.fixture_fail_password_audit()'); }
      await query(`set role service_role;${begin};${finish}`);
      assert.equal(JSON.parse(await as(2,'select public.eco_current_user()')).passwordChangeSuggested,false);
      assert.equal(await query(`select count(*) from eco_private.revoked_sessions where session_id=${literal(other)}`),'1');
    });
    await t.test('inactive or revoked users cannot acknowledge a password prompt or finalize a change', async () => {
      await seed();
      await query(`update eco_private.users set is_active=false where id=${literal(ids[2])}`);
      await assert.rejects(as(2,'select public.eco_dismiss_password_prompt()'),/Unauthorized/);
      await assert.rejects(query(`set role service_role;select public.eco_begin_password_change(${literal(ids[2])},${literal(sessions[2])})`),/Unauthorized/);
      await assert.rejects(query(`set role service_role;select public.eco_complete_password_change(${literal(ids[2])},${literal(sessions[2])})`),/Unauthorized/);
      await query(`update eco_private.users set is_active=true where id=${literal(ids[2])};insert into eco_private.revoked_sessions(session_id,user_id) values(${literal(sessions[2])},${literal(ids[2])})`);
      await assert.rejects(as(2,'select public.eco_dismiss_password_prompt()'),/Unauthorized/);
      await assert.rejects(query(`set role service_role;select public.eco_begin_password_change(${literal(ids[2])},${literal(sessions[2])})`),/Unauthorized/);
      await assert.rejects(query(`set role service_role;select public.eco_complete_password_change(${literal(ids[2])},${literal(sessions[2])})`),/Unauthorized/);
    });
    await t.test('failed audit insertion rolls back user change and session revocations', async () => {
      await seed();
      await query(`create function eco_private.fixture_fail_audit() returns trigger language plpgsql as $$ begin raise exception 'fixture audit failure';end $$;
        create trigger fixture_fail_audit before insert on eco_private.access_audit for each row execute function eco_private.fixture_fail_audit();`);
      try {
        await assert.rejects(as(0,update(patch(ids[2],{isManager:true}))),/fixture audit failure/);
        assert.equal(await query(`select (revision=1 and not is_manager)::text from eco_private.users where id=${literal(ids[2])}`),'true');
        assert.equal(await query('select count(*) from eco_private.revoked_sessions'),'0');
      } finally { await query('drop trigger fixture_fail_audit on eco_private.access_audit;drop function eco_private.fixture_fail_audit()'); }
    });
    await t.test('concurrent administrators cannot remove both administrators', async () => {
      await seed();
      const first=as(0,`${update(patch(ids[1],{isAdmin:false}))};select pg_sleep(0.4)`);
      // Wait until the first transaction holds the common lock, rather than relying on timing alone.
      for(let attempt=0;attempt<100;attempt++) {
        if(await query("select exists(select 1 from pg_locks where locktype='advisory' and granted)::text")==='true') break;
        await new Promise(resolve=>setTimeout(resolve,5));
      }
      const second=as(1,update(patch(ids[0],{isAdmin:false})));
      const results=await Promise.allSettled([first,second]);
      assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
      assert.equal(await query('select count(*) from eco_private.users where is_admin and is_active and activated_at is not null'),'1');
      await assert.rejects(as(0,update(patch(ids[0],{isAdmin:false}))),/Cannot remove own/);
    });
    const requestId='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const profile={email:'new-user@example.test',displayName:'New User',phone:'+85261234567',officeId:'sg',isAdmin:false,isManager:true,isSpcTrader:true,isActive:true};
    const beginOperation=(kind,input,request=requestId,actor=0,fingerprint='a'.repeat(64))=>`select public.eco_begin_admin_operation(${literal(ids[actor])},${literal(sessions[actor])},${literal(request)},${literal(kind)},${literal(JSON.stringify(input))}::jsonb,${literal(fingerprint)})`;
    const completeOperation=(request=requestId,actor=0)=>`select public.eco_complete_admin_operation(${literal(ids[actor])},${literal(sessions[actor])},${literal(request)})`;
    const failOperation=(request=requestId,actor=0)=>`select public.eco_fail_admin_operation(${literal(ids[actor])},${literal(sessions[actor])},${literal(request)})`;
    const service=sql=>query(`set role service_role;${sql}`);
    await t.test('phone edits preserve existing values for old clients, can clear, reject invalid and remain audited',async()=>{
      await seed();
      let user=JSON.parse(await as(0,update(patch(ids[2],{phone:'+85261234567'}))));assert.equal(user.phone,'+85261234567');
      user=JSON.parse(await as(0,update(patch(ids[2],{expectedRevision:2}))));assert.equal(user.phone,'+85261234567');
      user=JSON.parse(await as(0,update(patch(ids[2],{expectedRevision:3,phone:''}))));assert.equal(user.phone,'');
      for(const phone of [null,'85261234567','+01234567','+852 61234567'])await assert.rejects(as(0,update(patch(ids[2],{expectedRevision:4,phone}))),/Invalid phone/);
      assert.equal(await query("select count(*) from eco_private.access_audit where action='update-user'"),'3');
      assert.equal(await query('select count(*) from eco_private.revoked_sessions'),'0');
    });
    await t.test('administrator operations cannot be invoked from browser roles, traders, disabled or revoked administrators',async()=>{
      await seed();
      for(const role of ['anon','authenticated']){
        await assert.rejects(query(`set role ${role};${beginOperation('create-user',profile)}`),/permission denied/);
        await assert.rejects(query(`set role ${role};select * from eco_private.admin_operations`),/permission denied/);
        await assert.rejects(query(`set role ${role};${completeOperation()}`),/permission denied/);
        await assert.rejects(query(`set role ${role};${failOperation()}`),/permission denied/);
      }
      await assert.rejects(service(beginOperation('create-user',profile,requestId,2)),/Unauthorized administrator/);
      await query(`update eco_private.users set is_active=false where id=${literal(ids[0])}`);
      await assert.rejects(service(beginOperation('create-user',profile)),/Unauthorized administrator/);
      await query(`update eco_private.users set is_active=true where id=${literal(ids[0])};insert into eco_private.revoked_sessions(session_id,user_id) values(${literal(sessions[0])},${literal(ids[0])})`);
      await assert.rejects(service(beginOperation('create-user',profile)),/Unauthorized administrator/);
      assert.equal(await query('select count(*) from eco_private.admin_operations'),'0');
    });
    await t.test('create reserves one identity, only confirms the exact provider marker and completes once',async()=>{
      await seed();
      const begun=JSON.parse(await service(beginOperation('create-user',profile)));assert.equal(begun.runProvider,true);
      const retry=JSON.parse(await service(beginOperation('create-user',profile)));assert.equal(retry.targetId,begun.targetId);assert.equal(retry.runProvider,false);
      await assert.rejects(service(beginOperation('create-user',{...profile,isAdmin:true})),/Request conflict/);
      await assert.rejects(service(beginOperation('create-user',profile,requestId,0,'b'.repeat(64))),/Request conflict/);
      await assert.rejects(service(beginOperation('create-user',profile,'ffffffff-ffff-4fff-8fff-ffffffffffff')),/Duplicate user email/);
      await assert.rejects(service(completeOperation()),/Provider outcome pending/);
      await query(`insert into auth.users(id,email,email_confirmed_at,encrypted_password) values(${literal(begun.targetId)},${literal(profile.email)},now(),'synthetic')`);
      await assert.rejects(service(completeOperation()),/Provider outcome pending/);
      await query(`update auth.users set raw_app_meta_data=jsonb_build_object('eco_access_create_request',${literal(requestId)}) where id=${literal(begun.targetId)}`);
      const added=JSON.parse(await service(completeOperation()));assert.equal(added.id,begun.targetId);assert.equal(added.phone,profile.phone);assert.equal(added.isManager,true);assert.equal(added.isAdmin,false);assert.equal(added.activated,true);assert.equal(added.passwordChangeSuggested,true);
      assert.deepEqual(JSON.parse(await service(completeOperation())),added);
      assert.equal(JSON.parse(await service(beginOperation('create-user',profile))).state,'complete');
      assert.equal(await query("select count(*) from eco_private.access_audit where action='create-user'"),'1');
      assert.equal(await query(`select count(*) from auth.users where email=${literal(profile.email)}`),'1');
    });
    await t.test('concurrent duplicate operations obtain only one provider attempt',async()=>{
      await seed();
      const results=await Promise.all([service(beginOperation('create-user',profile)),service(beginOperation('create-user',profile))]);
      assert.equal(results.map(JSON.parse).filter(r=>r.runProvider).length,1);assert.equal(new Set(results.map(JSON.parse).map(r=>r.targetId)).size,1);
      assert.equal(await query("select count(*) from eco_private.access_audit where action='begin-create-user'"),'1');
    });
    await t.test('reset blocks all target logins while pending, revokes old sessions and preserves permissions on completion',async()=>{
      await seed();
      const input={id:ids[2],expectedRevision:1};
      await service(beginOperation('reset-password',input));
      await assert.rejects(as(2,'select public.eco_current_user()'),/Unauthorized/);
      const fresh='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      await query(`insert into auth.sessions(id,user_id) values(${literal(fresh)},${literal(ids[2])})`);
      const claims=literal(JSON.stringify({sub:ids[2],session_id:fresh,aal:'aal1'}));
      await assert.rejects(query(`begin;set local role authenticated;select set_config('request.jwt.claims',${claims},true);select public.eco_current_user();commit;`),/Unauthorized/);
      await assert.rejects(as(0,update(patch())),/Account operation pending/);
      await assert.rejects(service(`select public.eco_begin_password_change(${literal(ids[2])},${literal(fresh)})`),/Unauthorized/);
      await assert.rejects(service(completeOperation()),/Provider outcome pending/);
      await query(`update auth.users set raw_app_meta_data=jsonb_build_object('eco_access_reset_request',${literal(requestId)}) where id=${literal(ids[2])}`);
      const changed=JSON.parse(await service(completeOperation()));assert.equal(changed.isActive,true);assert.equal(changed.isAdmin,false);assert.equal(changed.officeId,'hk');assert.equal(changed.revision,2);assert.equal(changed.passwordChangeSuggested,true);
      assert.equal(await query(`select count(*) from eco_private.revoked_sessions where user_id=${literal(ids[2])}`),'2');
      assert.deepEqual(JSON.parse(await service(completeOperation())),changed);
      assert.equal(await query("select count(*) from eco_private.access_audit where action='reset-password'"),'1');
    });
    await t.test('reset refuses self/stale requests; inactive target stays inactive and admission hold cannot be bypassed by activation',async()=>{
      await seed();
      await assert.rejects(service(beginOperation('reset-password',{id:ids[0],expectedRevision:1})),/Use own password change/);
      await assert.rejects(service(beginOperation('reset-password',{id:ids[2],expectedRevision:2})),/User conflict/);
      await query(`update eco_private.users set is_active=false where id=${literal(ids[2])}`);
      await service(beginOperation('reset-password',{id:ids[2],expectedRevision:1}));
      await assert.rejects(as(2,'select public.eco_finish_activation()'),/Unauthorized/);
      await query(`update auth.users set raw_app_meta_data=jsonb_build_object('eco_access_reset_request',${literal(requestId)}) where id=${literal(ids[2])}`);
      assert.equal(JSON.parse(await service(completeOperation())).isActive,false);
    });
    await t.test('provider rejection releases hold but never restores revoked sessions; a provider success cannot be marked failed',async()=>{
      await seed();
      await service(beginOperation('reset-password',{id:ids[2],expectedRevision:1}));
      await service(failOperation());
      assert.equal(await query(`select (access_hold_request is null)::text from eco_private.users where id=${literal(ids[2])}`),'true');
      await assert.rejects(as(2,'select public.eco_current_user()'),/Unauthorized/);
      assert.equal(JSON.parse(await service(beginOperation('reset-password',{id:ids[2],expectedRevision:1}))).state,'failed');
      const second='ffffffff-ffff-4fff-8fff-ffffffffffff';await service(beginOperation('reset-password',{id:ids[2],expectedRevision:1},second));
      await query(`update auth.users set raw_app_meta_data=jsonb_build_object('eco_access_reset_request',${literal(second)}) where id=${literal(ids[2])}`);
      await assert.rejects(service(failOperation(second)),/Provider operation already succeeded/);
      assert.equal(await query(`select (access_hold_request=${literal(second)})::text from eco_private.users where id=${literal(ids[2])}`),'true');
    });
    await t.test('demotion before finalization prevents provider-created account receiving access',async()=>{
      await seed();
      const op=JSON.parse(await service(beginOperation('create-user',profile)));
      await query(`insert into auth.users(id,email,email_confirmed_at,encrypted_password,raw_app_meta_data) values(${literal(op.targetId)},${literal(profile.email)},now(),'synthetic',jsonb_build_object('eco_access_create_request',${literal(requestId)}))`);
      await as(1,update(patch(ids[0],{isAdmin:false})));
      await assert.rejects(service(completeOperation()),/Unauthorized administrator/);
      assert.equal(await query(`select (not is_active and not is_admin and activated_at is null)::text from eco_private.users where id=${literal(op.targetId)}`),'true');
    });
    await t.test('operator recovery is private, delayed, audited, and cannot abandon a provider-confirmed mutation',async()=>{
      await seed();
      const reason=literal('Fixture incident REF-123: provider logs confirm no request remains running.');
      const abandon=`select public.eco_abandon_admin_operation(${literal(requestId)},${reason})`;
      await service(beginOperation('reset-password',{id:ids[2],expectedRevision:1}));
      await assert.rejects(as(0,abandon),/permission denied/);
      await assert.rejects(service(abandon),/Operation not recoverable yet/);
      await query(`update eco_private.admin_operations set created_at=now()-interval '11 minutes' where request_id=${literal(requestId)}`);
      await assert.rejects(service(`select public.eco_abandon_admin_operation(${literal(requestId)},'')`),/Reconciliation reason required/);
      await service(abandon);
      assert.equal(await query(`select state from eco_private.admin_operations where request_id=${literal(requestId)}`),'failed');
      assert.equal(await query(`select (access_hold_request is null)::text from eco_private.users where id=${literal(ids[2])}`),'true');
      assert.equal(await query("select count(*) from eco_private.access_audit where action='operator-abandon-reset-password'"),'1');
      await assert.rejects(as(2,'select public.eco_current_user()'),/Unauthorized/);
      await seed();
      await service(beginOperation('reset-password',{id:ids[2],expectedRevision:1}));
      await query(`update eco_private.admin_operations set created_at=now()-interval '11 minutes';update auth.users set raw_app_meta_data=jsonb_build_object('eco_access_reset_request',${literal(requestId)}) where id=${literal(ids[2])}`);
      await assert.rejects(service(abandon),/Provider identity exists/);
      assert.equal(await query(`select state from eco_private.admin_operations where request_id=${literal(requestId)}`),'pending');
      await service(completeOperation());
    });
    await t.test('audit finalization failure leaves reset held and retry safely completes without another provider mutation',async()=>{
      await seed();await service(beginOperation('reset-password',{id:ids[2],expectedRevision:1}));
      await query(`update auth.users set raw_app_meta_data=jsonb_build_object('eco_access_reset_request',${literal(requestId)}) where id=${literal(ids[2])};
        create function eco_private.fixture_fail_admin_audit() returns trigger language plpgsql as $$ begin if new.action='reset-password' then raise exception 'fixture audit failure';end if;return new;end $$;
        create trigger fixture_fail_admin_audit before insert on eco_private.access_audit for each row execute function eco_private.fixture_fail_admin_audit();`);
      try{
        await assert.rejects(service(completeOperation()),/fixture audit failure/);
        assert.equal(await query(`select (access_hold_request is not null and revision=1)::text from eco_private.users where id=${literal(ids[2])}`),'true');
        assert.equal(await query(`select state from eco_private.admin_operations where request_id=${literal(requestId)}`),'pending');
      }finally{await query('drop trigger fixture_fail_admin_audit on eco_private.access_audit;drop function eco_private.fixture_fail_admin_audit()');}
      assert.equal(JSON.parse(await service(beginOperation('reset-password',{id:ids[2],expectedRevision:1}))).runProvider,false);
      assert.equal(JSON.parse(await service(completeOperation())).revision,2);
      assert.equal(await query("select count(*) from eco_private.access_audit where action='reset-password'"),'1');
    });
    const ownBegin=(user=2,session=sessions[user],activation=false)=>`select public.${activation?'eco_begin_password_activation':'eco_begin_password_change_v2'}(${literal(ids[user])},${literal(session)})`;
    const ownComplete=(user=2,request=sessions[user],session='dddddddd-dddd-4ddd-8ddd-dddddddddddd')=>`select public.eco_complete_password_change_v2(${literal(ids[user])},${literal(request)},${literal(session)})`;
    const replacement='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const providerOwnSuccess=async(user=2,request=sessions[user])=>query(`delete from auth.sessions where user_id=${literal(ids[user])};update auth.users set encrypted_password='synthetic-new-password',raw_app_meta_data=jsonb_build_object('eco_access_change_request',${literal(request)}) where id=${literal(ids[user])};insert into auth.sessions(id,user_id) values(${literal(replacement)},${literal(ids[user])})`);
    const reconcile=request=>`select public.eco_reconcile_admin_operation(${literal(request)},'Operator fixture REF-456: provider ended, user state reviewed and safe resolution approved.')`;
    await t.test('self change and administrator reset exclude one another across provider write and replacement-session creation',async()=>{
      await seed();await service(ownBegin());
      await assert.rejects(service(beginOperation('reset-password',{id:ids[2],expectedRevision:1})),/User conflict/);
      await assert.rejects(service(ownBegin()),/Unauthorized or credential operation pending/);
      await query(`insert into auth.sessions(id,user_id) values(${literal(replacement)},${literal(ids[2])})`);
      await assert.rejects(service(ownBegin(2,replacement)),/Unauthorized or credential operation pending/);
      await assert.rejects(service(ownComplete()),/Provider success not confirmed/);
      await providerOwnSuccess();
      const changed=JSON.parse(await service(ownComplete()));assert.equal(changed.revision,2);assert.equal(changed.passwordChangeSuggested,false);
      assert.equal(await query(`select count(*) from eco_private.revoked_sessions where session_id=${literal(replacement)}`),'0');
      await service(beginOperation('reset-password',{id:ids[2],expectedRevision:2}));
      await assert.rejects(service(ownBegin(2,replacement)),/Unauthorized or credential operation pending/);
      assert.equal(await query(`select count(*) from eco_private.admin_operations where kind='change-password'`),'1');
    });
    await t.test('activation/recovery and administrator reset use the same fence and keep replacement provider session usable',async()=>{
      await seed();await query(`update eco_private.users set activated_at=null where id=${literal(ids[2])};update auth.users set encrypted_password='' where id=${literal(ids[2])}`);
      await service(ownBegin(2,sessions[2],true));
      await assert.rejects(service(beginOperation('reset-password',{id:ids[2],expectedRevision:1})),/User conflict/);
      await assert.rejects(service(ownBegin(2,sessions[2],true)),/Unauthorized or credential operation pending/);
      await providerOwnSuccess();
      const activated=JSON.parse(await service(ownComplete()));assert.equal(activated.activated,true);assert.equal(activated.passwordChangeSuggested,false);
      assert.equal(await query("select count(*) from eco_private.access_audit where action='activate-or-recover'"),'1');
      await service(beginOperation('reset-password',{id:ids[2],expectedRevision:2}));
      await assert.rejects(service(ownBegin(2,replacement,true)),/Unauthorized or credential operation pending/);
    });
    await t.test('operator reconciliation resolves a confirmed reset after admin demotion and preserves target roles and suspension',async()=>{
      await seed();await query(`update eco_private.users set is_active=false,is_manager=true where id=${literal(ids[2])}`);
      await service(beginOperation('reset-password',{id:ids[2],expectedRevision:1}));
      await as(1,update(patch(ids[0],{isAdmin:false})));
      await query(`update auth.users set raw_app_meta_data=jsonb_build_object('eco_access_reset_request',${literal(requestId)}) where id=${literal(ids[2])};update eco_private.admin_operations set created_at=now()-interval '11 minutes'`);
      await assert.rejects(service(completeOperation()),/Unauthorized administrator/);
      await assert.rejects(as(1,reconcile(requestId)),/permission denied/);
      const resolved=JSON.parse(await service(reconcile(requestId)));assert.equal(resolved.isActive,false);assert.equal(resolved.isManager,true);assert.equal(resolved.isAdmin,false);assert.equal(resolved.officeId,'hk');
      assert.equal(await query(`select (access_hold_request is null)::text from eco_private.users where id=${literal(ids[2])}`),'true');
      assert.equal(await query("select count(*) from eco_private.access_audit where action='operator-reconcile-reset-password'"),'1');
    });
    await t.test('operator reconciliation after confirmed self change retains suspension and cannot grant a demoted creator privileges',async()=>{
      await seed();await service(ownBegin());await providerOwnSuccess();
      await query(`update eco_private.users set is_active=false where id=${literal(ids[2])};update eco_private.admin_operations set created_at=now()-interval '11 minutes'`);
      await assert.rejects(service(ownComplete()),/Unauthorized/);
      assert.equal(JSON.parse(await service(reconcile(sessions[2]))).isActive,false);
      assert.equal(await query(`select count(*) from eco_private.revoked_sessions where session_id=${literal(replacement)}`),'1');
      await seed();const op=JSON.parse(await service(beginOperation('create-user',{...profile,isAdmin:true})));
      await query(`insert into auth.users(id,email,email_confirmed_at,encrypted_password,raw_app_meta_data) values(${literal(op.targetId)},${literal(profile.email)},now(),'synthetic',jsonb_build_object('eco_access_create_request',${literal(requestId)}));update eco_private.admin_operations set created_at=now()-interval '11 minutes'`);
      await as(1,update(patch(ids[0],{isAdmin:false})));
      const resolved=JSON.parse(await service(reconcile(requestId)));assert.equal(resolved.isActive,false);assert.equal(resolved.isAdmin,false);assert.equal(resolved.isManager,false);assert.equal(resolved.isSpcTrader,false);assert.equal(resolved.activated,true);assert.equal(resolved.officeId,profile.officeId);assert.equal(resolved.displayName,profile.displayName);assert.equal(resolved.phone,profile.phone);
      assert.equal(await query(`select state from eco_private.admin_operations where request_id=${literal(requestId)}`),'failed');
    });
    await t.test('self mutation failure is recoverable without replay: definite rejection releases, unknown outcome requires reconciled operator action',async()=>{
      await seed();await service(ownBegin());
      await service(`select public.eco_fail_password_change(${literal(ids[2])},${literal(sessions[2])})`);
      assert.equal(JSON.parse(await as(2,'select public.eco_current_user()')).isActive,true);
      assert.equal(await query(`select state from eco_private.admin_operations where request_id=${literal(sessions[2])}`),'failed');
      await seed();await service(ownBegin());
      await assert.rejects(service(reconcile(sessions[2])),/Operation not recoverable yet/);
      await query(`update eco_private.admin_operations set created_at=now()-interval '11 minutes'`);
      await assert.rejects(service(reconcile(sessions[2])),/Provider success not confirmed/);
      await service(`select public.eco_abandon_admin_operation(${literal(sessions[2])},'Operator REF-789: provider confirms request never executed or is still running nowhere.')`);
      assert.equal(await query(`select (access_hold_request is null)::text from eco_private.users where id=${literal(ids[2])}`),'true');
      await assert.rejects(as(2,'select public.eco_current_user()'),/Unauthorized/);
    });
    await t.test('role preview is session-bound, private, audited and never changes stored authority', async () => {
      await seed();
      const before=JSON.parse(await as(0,'select public.eco_current_user()'));
      const preview=JSON.parse(await as(0,"select public.eco_set_preview('trader','sg')"));
      assert.deepEqual(preview,{role:'trader',officeId:'sg',officeName:'Singapore',readOnly:true});
      assert.deepEqual(JSON.parse(await as(0,'select public.eco_current_user()')),before);
      assert.equal(JSON.parse(await as(0,'select public.eco_preview_state()')).preview.role,'trader');
      assert.equal(JSON.parse(await as(1,'select public.eco_preview_state()')).preview,null);
      for(const sql of ['select * from eco_private.role_previews',"select eco_private.update_user_before_preview('{}'::jsonb)",'select eco_private.list_users_before_preview()']) await assert.rejects(as(0,sql),/permission denied/);
      await assert.rejects(as(2,"select public.eco_set_preview('admin','hk')"),/Forbidden/);
      await assert.rejects(as(2,'select public.eco_preview_options()'),/Forbidden/);
      assert.equal(await query("select count(*) from eco_private.access_audit where action='set-role-preview'"),'1');
      await as(0,'select public.eco_set_preview(null,null)');
      assert.equal(JSON.parse(await as(0,'select public.eco_preview_state()')).preview,null);
    });
    await t.test('every preview role denies direct authenticated writes; only ADMIN may read the directory', async () => {
      await seed();
      for(const role of ['admin','trader','spc-trader','manager','credit']){
        await as(0,`select public.eco_set_preview(${literal(role)},${literal(role==='credit'?'CREDIT':'hk')})`);
        for(const sql of [update(patch()),'select public.eco_dismiss_password_prompt()','select public.eco_finish_activation()']) await assert.rejects(as(0,sql),/Preview is read only/);
        if(role==='admin')assert.ok(JSON.parse(await as(0,'select public.eco_list_users()')).users.length);else await assert.rejects(as(0,'select public.eco_list_users()'),/Forbidden/);
      }
      await assert.rejects(as(0,"select public.eco_set_preview('credit','hk')"),/Invalid preview/);
      await assert.rejects(as(0,"select public.eco_set_preview('root','hk')"),/Invalid preview/);
      await assert.rejects(as(0,"select public.eco_set_preview('admin','unknown')"),/Invalid preview/);
    });
    await t.test('preview cannot follow a revoked/deleted session or restore authority after demotion', async () => {
      await seed();await as(0,"select public.eco_set_preview('admin','hk')");
      await query(`update eco_private.users set is_admin=false where id=${literal(ids[0])}`);
      assert.equal(JSON.parse(await as(0,'select public.eco_preview_state()')).preview,null);
      await assert.rejects(as(0,"select public.eco_set_preview('admin','hk')"),/Forbidden/);
      await seed();await as(0,"select public.eco_set_preview('manager','sg')");
      await query(`insert into eco_private.revoked_sessions(session_id,user_id) values(${literal(sessions[0])},${literal(ids[0])})`);
      await assert.rejects(as(0,'select public.eco_preview_state()'),/Unauthorized/);
      await query(`delete from auth.sessions where id=${literal(sessions[0])}`);
      assert.equal(await query('select count(*) from eco_private.role_previews'),'0');
    });
    await t.test('fresh password proof cannot escape original-session preview and pending credentials block entry', async () => {
      await seed();const proof='dddddddd-dddd-4ddd-8ddd-dddddddddddd', req='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      await query(`insert into auth.sessions(id,user_id) values(${literal(proof)},${literal(ids[0])})`);
      const reset=`select public.eco_begin_admin_operation_v2(${literal(ids[0])},${literal(proof)},${literal(req)},'reset-password',${literal(JSON.stringify({id:ids[2],expectedRevision:1}))}::jsonb,${literal('a'.repeat(64))},${literal(sessions[0])})`;
      const own=`select public.eco_begin_password_change_v3(${literal(ids[0])},${literal(proof)},${literal(sessions[0])})`;
      await as(0,"select public.eco_set_preview('trader','hk')");
      await assert.rejects(query(`set role service_role;${reset}`),/Preview is read only/);
      await assert.rejects(query(`set role service_role;${own}`),/Preview is read only/);
      assert.equal(await query('select count(*) from eco_private.admin_operations'),'0');
      await as(0,'select public.eco_set_preview(null,null)');
      await query(`set role service_role;${reset}`);
      await assert.rejects(as(0,"select public.eco_set_preview('admin','hk')"),/Account operation pending/);
      await assert.rejects(as(0,reset),/permission denied/);
    });
    await t.test('concurrent preview and password approval serialize on the same lock in either order', async () => {
      const proof='dddddddd-dddd-4ddd-8ddd-dddddddddddd', req='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      const waitForLock=async()=>{
        for(let n=0;n<100;n++){
          if(await query("select exists(select 1 from pg_catalog.pg_locks where locktype='advisory' and classid=1857 and objid=2026 and granted)")==='t')return;
          await new Promise(resolve=>setTimeout(resolve,5));
        }
        assert.fail('Test transaction never acquired its lock');
      };
      for(const operation of ['own','admin'])for(const previewFirst of [true,false]){
        await seed();await query(`insert into auth.sessions(id,user_id) values(${literal(proof)},${literal(ids[0])})`);
        const start=operation==='own'?`select public.eco_begin_password_change_v3(${literal(ids[0])},${literal(proof)},${literal(sessions[0])})`:
          `select public.eco_begin_admin_operation_v2(${literal(ids[0])},${literal(proof)},${literal(req)},'reset-password',${literal(JSON.stringify({id:ids[2],expectedRevision:1}))}::jsonb,${literal('a'.repeat(64))},${literal(sessions[0])})`;
        const held="select pg_catalog.pg_advisory_xact_lock(1857,2026);select pg_catalog.pg_sleep(0.2);";
        const first=previewFirst?as(0,held+"select public.eco_set_preview('trader','hk')"):
          query(`begin;set local role service_role;${held}${start};commit`);
        await waitForLock();
        const rejected=previewFirst?query(`set role service_role;${start}`):as(0,"select public.eco_set_preview('admin','hk')");
        await assert.rejects(rejected,previewFirst?/Preview is read only/:/Account operation pending|Unauthorized/);
        await first;
        assert.equal(await query("select count(*) from eco_private.admin_operations where state='pending'"),previewFirst?'0':'1');
        assert.equal(await query('select count(*) from eco_private.role_previews'),previewFirst?'1':'0');
      }
    });
    const deletion=(target=ids[2],revision=1,request='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',actor=0,proof=sessions[actor],origin=sessions[actor])=>
      `select public.eco_delete_user(${literal(ids[actor])},${literal(proof)},${literal(origin)},${literal(request)},${literal(target)},${revision})`;
    await t.test('deletion atomically removes directory access, revokes all sessions, preserves history and is retry safe',async()=>{
      await seed();
      const deleted=JSON.parse(await service(deletion()));assert.equal(deleted.deletedUserId,ids[2]);
      assert.equal(JSON.parse(await as(0,'select public.eco_list_users()')).users.some(user=>user.id===ids[2]),false);
      assert.equal(await query(`select (deleted_at is not null and not is_active and not is_admin and not is_spc_trader and not is_manager)::text from eco_private.users where id=${literal(ids[2])}`),'true');
      assert.equal(await query(`select count(*) from auth.users where id=${literal(ids[2])}`),'1');
      await assert.rejects(as(2,'select public.eco_current_user()'),/Unauthorized/);
      await query(`delete from auth.sessions where id=${literal(sessions[2])};delete from eco_private.revoked_sessions where session_id=${literal(sessions[2])};insert into auth.sessions(id,user_id) values(${literal(sessions[2])},${literal(ids[2])})`);
      await assert.rejects(as(2,'select public.eco_current_user()'),/Unauthorized/);
      assert.deepEqual(JSON.parse(await service(deletion())),deleted);
      assert.equal(await query("select count(*) from eco_private.access_audit where action='delete-user'"),'1');
      await assert.rejects(service(deletion(ids[1])),/Request conflict/);
      await assert.rejects(as(0,update(patch(ids[2],{expectedRevision:2,isActive:true}))),/Unknown user/);
      await assert.rejects(service(beginOperation('reset-password',{id:ids[2],expectedRevision:2},'ffffffff-ffff-4fff-8fff-ffffffffffff')),/Unknown user/);
      await assert.rejects(query(`update eco_private.users set is_active=true where id=${literal(ids[2])}`),/eco_deleted_user_has_no_access/);
      await assert.rejects(query(`update eco_private.users set deleted_at=null where id=${literal(ids[2])}`),/Deleted account cannot be restored/);
    });
    await t.test('delete requires service role, live administrator proof, writable origin and protects self',async()=>{
      await seed();
      await assert.rejects(query('set role anon;'+deletion()),/permission denied/);
      await assert.rejects(as(0,deletion()),/permission denied/);
      await assert.rejects(service(deletion(ids[1],1,requestId,2)),/Unauthorized administrator/);
      await assert.rejects(service(deletion(ids[0])),/Cannot delete own account/);
      await assert.rejects(service(deletion(ids[2],1,requestId,0,sessions[1])),/Unauthorized/);
      const proof='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      await query(`insert into auth.sessions(id,user_id) values(${literal(proof)},${literal(ids[0])})`);
      await as(0,"select public.eco_set_preview('admin','hk')");
      await assert.rejects(service(deletion(ids[2],1,requestId,0,proof)),/Preview is read only/);
      assert.equal(await query("select count(*) from eco_private.access_audit where action='delete-user'"),'0');
    });
    await t.test('delete refuses stale revisions and pending credential writes',async()=>{
      await seed();await assert.rejects(service(deletion(ids[2],2)),/User conflict/);
      await service(beginOperation('reset-password',{id:ids[2],expectedRevision:1}));
      await assert.rejects(service(deletion(ids[2],1,'ffffffff-ffff-4fff-8fff-ffffffffffff')),/User conflict/);
      assert.equal(await query(`select (deleted_at is null)::text from eco_private.users where id=${literal(ids[2])}`),'true');
    });
    await t.test('concurrent administrators cannot delete both remaining administrators',async()=>{
      await seed();
      const outcomes=await Promise.allSettled([service(deletion(ids[1],1,'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',0)),
        service(deletion(ids[0],1,'ffffffff-ffff-4fff-8fff-ffffffffffff',1))]);
      assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);
      assert.equal(await query('select count(*) from eco_private.users where is_admin and is_active and deleted_at is null'),'1');
    });
    await t.test('failed delete audit rolls back deletion and revocation; the exact retry can then complete',async()=>{
      await seed();
      await query(`create function eco_private.fixture_delete_audit_failure() returns trigger language plpgsql as $$ begin if new.action='delete-user' then raise exception 'fixture audit failure';end if;return new;end $$;
        create trigger fixture_delete_audit_failure before insert on eco_private.access_audit for each row execute function eco_private.fixture_delete_audit_failure()`);
      try {
        await assert.rejects(service(deletion()),/fixture audit failure/);
        assert.equal(await query(`select (deleted_at is null and is_active)::text from eco_private.users where id=${literal(ids[2])}`),'true');
        assert.equal(JSON.parse(await as(2,'select public.eco_current_user()')).id,ids[2]);
        assert.equal(await query("select count(*) from eco_private.admin_operations where kind='delete-user'"),'0');
      } finally { await query('drop trigger fixture_delete_audit_failure on eco_private.access_audit;drop function eco_private.fixture_delete_audit_failure()'); }
      assert.equal(JSON.parse(await service(deletion())).deletedUserId,ids[2]);
    });
    const phoneRequest=(phone='+6591815902',request='aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa')=>`select public.eco_request_phone_change(${literal(request)},${literal(phone)})`;
    const phoneReview=(decision='approve',request='aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa')=>`select public.eco_review_phone_change(${literal(request)},${literal(decision)})`;
    await t.test('phone request private data and guarded operations reject anon and privilege forgery',async()=>{
      await seed();
      for(const sql of ['select public.eco_list_phone_requests()',phoneRequest(),phoneReview()]) await assert.rejects(query(`set role anon;${sql}`),/permission denied/);
      await assert.rejects(as(2,'select * from eco_private.phone_change_requests'),/permission denied/);
      await assert.rejects(as(2,phoneReview()),/Forbidden/);
      await assert.rejects(as(2,phoneRequest('not-a-number')),/Invalid phone/);
      await assert.rejects(as(2,'select public.eco_request_phone_change(null,null)'),/Invalid phone/);
      assert.equal(await query("select relrowsecurity::text from pg_class where oid='eco_private.phone_change_requests'::regclass"),'true');
    });
    await t.test('requesting a phone change leaves phone unchanged and exact retries create one request and audit',async()=>{
      await seed();
      const created=JSON.parse(await as(2,phoneRequest()));assert.equal(created.userId,ids[2]);assert.equal(created.status,'pending');assert.equal(created.currentPhone,'');
      assert.equal(JSON.parse(await as(2,'select public.eco_current_user()')).phone,'');
      assert.deepEqual(JSON.parse(await as(2,phoneRequest())),created);
      assert.equal(await query('select count(*) from eco_private.phone_change_requests'),'1');
      assert.equal(await query("select count(*) from eco_private.access_audit where action='request-phone-change'"),'1');
      await assert.rejects(as(2,phoneRequest('+6591815999')),/Request conflict/);
      await assert.rejects(as(1,phoneRequest()),/Request conflict/);
      await assert.rejects(as(2,phoneRequest('+6591815999','bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb')),/Phone request pending/);
    });
    await t.test('phone queue exposes own history to traders and all pending requests only to administrators outside preview',async()=>{
      await seed();await as(2,phoneRequest());await as(0,phoneRequest('+85268885575','bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb'));
      const own=JSON.parse(await as(2,'select public.eco_list_phone_requests()')).requests;assert.equal(own.length,1);assert.equal(own[0].userId,ids[2]);
      assert.equal(JSON.parse(await as(1,'select public.eco_list_phone_requests()')).requests.length,2);
      await as(1,"select public.eco_set_preview('trader','hk')");
      assert.deepEqual(JSON.parse(await as(1,'select public.eco_list_phone_requests()')).requests,[]);
      await assert.rejects(as(1,phoneRequest('+85268885576','cccccccc-1111-4111-8111-cccccccccccc')),/Preview is read only/);
      await assert.rejects(as(1,phoneReview()),/Preview is read only/);
      await as(1,'select public.eco_set_preview(null,null)');await as(1,phoneReview());
      assert.equal(JSON.parse(await as(0,'select public.eco_list_phone_requests()')).requests.length,1);
      assert.equal(JSON.parse(await as(2,'select public.eco_list_phone_requests()')).requests[0].status,'approved');
    });
    await t.test('approval atomically updates contact and revision without revoking sessions or changing authority',async()=>{
      await seed();await as(2,phoneRequest());
      const approved=JSON.parse(await as(0,phoneReview()));assert.equal(approved.status,'approved');assert.equal(approved.reviewedBy,ids[0]);
      const member=JSON.parse(await as(2,'select public.eco_current_user()'));assert.equal(member.phone,'+6591815902');assert.equal(member.revision,2);assert.equal(member.isAdmin,false);
      assert.equal(await query('select count(*) from eco_private.revoked_sessions'),'0');
      assert.deepEqual(JSON.parse(await as(1,phoneReview())),approved);
      await assert.rejects(as(1,phoneReview('decline')),/Request conflict/);
      assert.equal(await query("select count(*) from eco_private.access_audit where action='review-phone-change'"),'1');
      await assert.rejects(as(2,phoneRequest('+6591815902','bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb')),/Phone is unchanged/);
    });
    await t.test('decline leaves contact unchanged, supports exact retry and permits a later new request',async()=>{
      await seed();await as(2,phoneRequest());assert.equal(JSON.parse(await as(0,phoneReview('decline'))).status,'declined');
      assert.equal(JSON.parse(await as(0,phoneReview('decline'))).status,'declined');
      assert.equal(JSON.parse(await as(2,'select public.eco_current_user()')).phone,'');
      assert.equal(JSON.parse(await as(2,phoneRequest('+6591815999','bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb'))).status,'pending');
    });
    await t.test('administrator contact edits supersede old requests so a stale approval cannot overwrite newer contact',async()=>{
      await seed();await as(2,phoneRequest());await as(0,update(patch(ids[2],{phone:'+85268885575'})));
      assert.equal(JSON.parse(await as(0,phoneReview())).status,'superseded');
      assert.equal(JSON.parse(await as(2,'select public.eco_current_user()')).phone,'+85268885575');
      assert.equal(await query("select count(*) from eco_private.access_audit where action='supersede-phone-change'"),'1');
      assert.equal(await query("select count(*) from eco_private.access_audit where action='review-phone-change'"),'0');
    });
    await t.test('unrelated profile edits do not invalidate pending contact requests, but suspension does',async()=>{
      await seed();await as(2,phoneRequest());await as(0,update(patch(ids[2],{displayName:'Updated name'})));
      assert.equal(JSON.parse(await as(0,phoneReview())).status,'approved');
      await seed();await as(2,phoneRequest());await as(0,update(patch(ids[2],{isActive:false})));
      assert.equal(JSON.parse(await as(0,phoneReview())).status,'superseded');
      await assert.rejects(as(2,phoneRequest('+85268885575','bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb')),/Unauthorized/);
      await assert.rejects(as(2,'select public.eco_list_phone_requests()'),/Unauthorized/);
    });
    await t.test('deleted targets and revoked administrator sessions cannot approve a phone change',async()=>{
      await seed();await as(2,phoneRequest());await service(deletion());
      assert.equal(JSON.parse(await as(0,phoneReview())).status,'superseded');
      await seed();await as(2,phoneRequest());await query(`delete from auth.sessions where id=${literal(sessions[0])}`);
      await assert.rejects(as(0,phoneReview()),/Unauthorized/);
      assert.equal(await query("select status from eco_private.phone_change_requests"),'pending');
    });
    await t.test('competing administrators make exactly one phone-review decision',async()=>{
      await seed();await as(2,phoneRequest());
      const results=await Promise.allSettled([as(0,phoneReview('approve')),as(1,phoneReview('decline'))]);
      assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
      assert.equal(await query("select count(*) from eco_private.access_audit where action='review-phone-change'"),'1');
      const status=await query('select status from eco_private.phone_change_requests');
      assert.equal(JSON.parse(await as(2,'select public.eco_current_user()')).phone,status==='approved'?'+6591815902':'');
    });
    await t.test('failed phone approval audit rolls back both contact and request status; retry succeeds',async()=>{
      await seed();await as(2,phoneRequest());
      await query(`create function eco_private.fixture_phone_audit_failure() returns trigger language plpgsql as $$ begin if new.action='review-phone-change' then raise exception 'fixture audit failure';end if;return new;end $$;
        create trigger fixture_phone_audit_failure before insert on eco_private.access_audit for each row execute function eco_private.fixture_phone_audit_failure()`);
      try {
        await assert.rejects(as(0,phoneReview()),/fixture audit failure/);
        assert.equal(await query('select status from eco_private.phone_change_requests'),'pending');
        const member=JSON.parse(await as(2,'select public.eco_current_user()'));assert.equal(member.phone,'');assert.equal(member.revision,1);
      } finally {await query('drop trigger fixture_phone_audit_failure on eco_private.access_audit;drop function eco_private.fixture_phone_audit_failure()');}
      assert.equal(JSON.parse(await as(0,phoneReview())).status,'approved');
    });
    await t.test('login throttle remains bounded across concurrent function instances', async () => {
      await seed();
      const results=await Promise.all(Array.from({length:12},()=>query(`set role service_role;select public.eco_consume_login_attempt('${'a'.repeat(64)}')`)));
      assert.equal(results.filter(value=>value==='t').length,10);
      await assert.rejects(as(2,`select public.eco_consume_login_attempt('${'b'.repeat(64)}')`),/permission denied/);
    });
  } finally {
    if(started) await exec(join(bin,'pg_ctl'),['-D',data,'-m','fast','-w','stop'],{env});
    await rm(root,{recursive:true,force:true});
  }
});
