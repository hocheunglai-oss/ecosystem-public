import { applySchemaMigrations } from './fixtures/migrations.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

const exec = promisify(execFile), lit = value => `'${String(value).replaceAll("'", "''")}'`, json = value => `${lit(JSON.stringify(value))}::jsonb`;
const ids = ['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333'];
const sessions = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','cccccccc-cccc-4ccc-8ccc-cccccccccccc'];
const rawText = 'SYNTHETIC TEST ENQUIRY — no customer data';
const ai = extra => ({ requestId:randomUUID(), rawText, sourceHash:createHash('sha256').update(rawText).digest('hex'), sourceRevision:'fixture-1', parserVersion:'fixture-parser', dataMode:'live', current:{}, ...extra });
const report = extra => ({ requestId:randomUUID(), rawText, sourceRevision:'fixture-1', parserVersion:'fixture-parser', parsed:{}, corrected:{}, notes:'Synthetic regression fixture', dataMode:'live', ...extra });

test('parser workspace SQL against isolated native PostgreSQL 17', async t => {
  const bin = process.env.ECO_NATIVE_PG_BIN;
  assert.ok(bin && isAbsolute(bin), 'Set ECO_NATIVE_PG_BIN to a trusted native PostgreSQL bin directory; no remote fallback.');
  assert.match((await exec(join(bin,'postgres'), ['--version'])).stdout, /PostgreSQL\) 17\./, 'Use the production PostgreSQL major version.');
  const root = await mkdtemp(join(tmpdir(),'eco-parser-pg-')), socket = join(root,'socket'), data = join(root,'data');
  await mkdir(socket,{mode:0o700});
  // Deliberately omit inherited PGHOST/PGPORT/PGDATABASE/PGSERVICE and credentials.
  const env = { PATH:process.env.PATH, LANG:'C', LC_ALL:'C', PGPASSFILE:join(root,'none') };
  let started = false;
  const query = async sql => (await exec(join(bin,'psql'), ['-X','-q','-A','-t','--no-password','-h',socket,'-p','55494','-U','eco_fixture','-d','postgres','-v','ON_ERROR_STOP=1','-c',sql], {env})).stdout.trim();
  const as = (i,sql,aal='aal1') => query(`begin;set local role authenticated;do $$begin perform set_config('request.jwt.claims',${lit(JSON.stringify({sub:ids[i],session_id:sessions[i],aal}))},true);end$$;${sql};commit;`);
  const call = async (i,name,input,aal='aal1') => JSON.parse(await as(i,`select public.${name}(${input===undefined?'':json(input)})`,aal));
  const service = async (name,args) => JSON.parse(await query(`begin;set local role service_role;select public.${name}(${args});commit;`));
  const finish = (i,id,result={vessel:'SYNTHETIC'},error=null) => service('eco_finish_parser_ai',`${lit(ids[i])}::uuid,${lit(id)}::uuid,${result===null?'null':json(result)},${error===null?'null':lit(error)}`);
  const generation = async () => (await call(0,'eco_test_workspace_policy')).generation;
  const seed = async () => {
    await query(`truncate eco_private.parser_reports,eco_private.parser_ai_requests cascade;truncate auth.users cascade;truncate eco_private.access_audit,eco_private.login_attempts;
      insert into auth.users(id,email,email_confirmed_at,encrypted_password) values ${ids.map((id,i)=>`(${lit(id)},${lit(i===0?'owner@example.test':`person${i}@example.test`)},now(),'synthetic')`).join(',')};
      update eco_private.users set office_id='hk',display_name='Fixture Person',is_active=true,activated_at=now(),is_admin=id in (${lit(ids[0])},${lit(ids[1])});
      insert into auth.sessions(id,user_id) values ${ids.map((id,i)=>`(${lit(sessions[i])},${lit(id)})`).join(',')};
      update eco_private.test_workspace_policy set enabled=true,generation=gen_random_uuid();
      insert into eco_private.owner_capabilities(singleton,owner_id,appearance_preview,test_workspace) values(true,${lit(ids[0])},true,true);`);
  };
  try {
    await exec(join(bin,'initdb'), ['-D',data,'-U','eco_fixture','-A','trust','--no-locale','--encoding=UTF8'], {env});
    await exec(join(bin,'pg_ctl'), ['-D',data,'-l',join(root,'server.log'),'-o',`-k ${socket} -p 55494 -c listen_addresses=''`,'-w','start'], {env}); started=true;
    assert.equal(await query("select current_setting('listen_addresses')"),'');
    assert.equal(await query('select inet_server_addr() is null'),'t','All verification uses a private Unix socket.');
    await query(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,encrypted_password text,raw_app_meta_data jsonb not null default '{}');
      create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),not_after timestamptz);
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
      create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
      grant usage on schema auth to authenticated,service_role;grant execute on function auth.uid(),auth.jwt() to authenticated,service_role;`);
    await applySchemaMigrations(query);
    assert.equal(await query('select count(*) from eco_private.owner_capabilities'),'0','A fresh installation never grants owner capabilities implicitly.');
    await query("insert into eco_private.offices values('hk','Hong Kong'),('sg','Singapore') on conflict do nothing");

    await t.test('private tables, helpers, completion and purge are unavailable to browser roles', async () => {
      await seed();
      for (const table of ['owner_capabilities','test_workspace_policy','parser_ai_requests','parser_reports']) {
        assert.equal(await query(`select relrowsecurity from pg_class where oid='eco_private.${table}'::regclass`),'t');
        for (const role of ['anon','authenticated','service_role']) await assert.rejects(query(`set role ${role};select * from eco_private.${table}`),/permission denied/);
      }
      for (const name of ['eco_test_workspace_policy','eco_begin_parser_ai','eco_create_parser_report','eco_list_parser_reports']) await assert.rejects(query(`set role anon;select public.${name}(${name==='eco_test_workspace_policy'?'':"'{}'::jsonb"})`),/permission denied/);
      await assert.rejects(as(0,"select eco_private.parser_scope(null,'{}')"),/permission denied/);
      await assert.rejects(as(0,"select eco_private.member_owner_capabilities(null)"),/permission denied/);
      for (const role of ['anon','authenticated','service_role']) await assert.rejects(query(`set role ${role};update eco_private.owner_capabilities set test_workspace=true`),/permission denied/);
      await assert.rejects(as(0,`select public.eco_finish_parser_ai(${lit(ids[0])},${lit(randomUUID())},'{}',null)`),/permission denied/);
      await assert.rejects(as(0,`select public.eco_purge_test_workspace(${lit(await generation())})`),/permission denied/);
    });
    await t.test('owner capabilities are private UUID grants, independent of email and client metadata', async () => {
      await seed();
      const granted={appearancePreview:true,testWorkspace:true}, denied={appearancePreview:false,testWorkspace:false};
      assert.deepEqual((await call(0,'eco_current_user')).capabilities,granted);
      for(const i of [1,2]) assert.deepEqual((await call(i,'eco_current_user')).capabilities,denied);
      const directory=await call(0,'eco_list_users');
      assert.ok(directory.users.every(member=>!Object.hasOwn(member,'capabilities')),'Directory profiles never expose another member’s capabilities.');
      await query(`update eco_private.users set email='renamed-owner@example.test' where id=${lit(ids[0])}`);
      assert.deepEqual((await call(0,'eco_current_user')).capabilities,granted,'Owner identity survives an email change.');
      await query(`update eco_private.users set email='owner@example.test' where id=${lit(ids[1])};delete from eco_private.owner_capabilities`);
      for(const i of [0,1]) {
        assert.deepEqual((await call(i,'eco_current_user')).capabilities,denied);
        assert.deepEqual(await call(i,'eco_test_workspace_policy'),{enabled:false,generation:''});
        await assert.rejects(call(i,'eco_begin_parser_ai',ai({dataMode:'test',generation:randomUUID()})),/Forbidden/);
      }
      const claims={sub:ids[1],session_id:sessions[1],aal:'aal1',capabilities:granted,user_metadata:{capabilities:granted}};
      const forged=JSON.parse(await query(`begin;set local role authenticated;do $$begin perform set_config('request.jwt.claims',${lit(JSON.stringify(claims))},true);end$$;select public.eco_current_user();commit;`));
      assert.deepEqual(forged.capabilities,denied,'JWT metadata cannot manufacture the private SQL row.');
    });
    await t.test('independent owner flags fail closed after revocation, demotion or loss of live membership', async () => {
      await seed();const gen=await generation();const pending=ai({dataMode:'test',generation:gen});await call(0,'eco_begin_parser_ai',pending);
      await query('update eco_private.owner_capabilities set test_workspace=false');
      assert.deepEqual((await call(0,'eco_current_user')).capabilities,{appearancePreview:true,testWorkspace:false});
      assert.deepEqual(await call(0,'eco_test_workspace_policy'),{enabled:false,generation:''});
      await assert.rejects(finish(0,pending.requestId),/Forbidden/,'AI completion rechecks the current grant.');
      await query('update eco_private.owner_capabilities set appearance_preview=false,test_workspace=true');
      assert.deepEqual((await call(0,'eco_current_user')).capabilities,{appearancePreview:false,testWorkspace:true});
      await query(`update eco_private.users set is_admin=false where id=${lit(ids[0])}`);
      assert.deepEqual((await call(0,'eco_current_user')).capabilities,{appearancePreview:false,testWorkspace:false});
      await assert.rejects(call(0,'eco_begin_parser_ai',ai({dataMode:'test',generation:gen})),/Forbidden/);
      for(const condition of [
        `update eco_private.users set is_active=false where id=${lit(ids[0])}`,
        `update eco_private.users set activated_at=null where id=${lit(ids[0])}`,
        `update eco_private.users set access_hold_request=gen_random_uuid() where id=${lit(ids[0])}`,
        `update auth.users set email_confirmed_at=null where id=${lit(ids[0])}`,
        `insert into eco_private.revoked_sessions(session_id,user_id) values(${lit(sessions[0])},${lit(ids[0])})`,
      ]) {await seed();await query(condition);await assert.rejects(call(0,'eco_current_user'),/Unauthorized/);await assert.rejects(call(0,'eco_test_workspace_policy'),/Unauthorized/);}
    });
    await t.test('test namespace needs explicitly provisioned owner admin and current generation; invalid scopes fail closed', async () => {
      await seed(); const gen=await generation(); assert.match(gen,/^[a-f0-9-]{36}$/);
      for (const i of [1,2]) {
        assert.deepEqual(await call(i,'eco_test_workspace_policy'),{enabled:false,generation:''});
        await assert.rejects(call(i,'eco_begin_parser_ai',ai({dataMode:'test',generation:gen})),/Forbidden/);
        await assert.rejects(call(i,'eco_create_parser_report',report({dataMode:'test',generation:gen})),/Forbidden/);
      }
      for (const extra of [{dataMode:null},{dataMode:'other'},{dataMode:{}},{dataMode:'live',generation:gen}]) await assert.rejects(call(0,'eco_begin_parser_ai',ai(extra)),/Invalid (data mode|generation)/);
      for (const extra of [{generation:null},{generation:randomUUID()},{}]) await assert.rejects(call(0,'eco_begin_parser_ai',ai({dataMode:'test',...extra})),/expired/);
      await query('update eco_private.test_workspace_policy set enabled=false');
      await assert.rejects(call(0,'eco_begin_parser_ai',ai({dataMode:'test',generation:gen})),/expired/);
      await query(`update eco_private.users set is_admin=false where id=${lit(ids[0])}`);
      assert.deepEqual(await call(0,'eco_test_workspace_policy'),{enabled:false,generation:''});
    });
    await t.test('view as, revoked, expired and inactive sessions cannot start or report parser activity', async () => {
      await seed(); await as(0,"select public.eco_set_preview('trader','hk')");
      await assert.rejects(call(0,'eco_begin_parser_ai',ai()),/read.only/); await assert.rejects(call(0,'eco_create_parser_report',report()),/read.only/);
      await assert.rejects(call(0,'eco_list_parser_reports',{dataMode:'live'}),/Forbidden/);
      await query(`insert into eco_private.revoked_sessions(session_id,user_id) values(${lit(sessions[1])},${lit(ids[1])});update auth.sessions set not_after=now()-interval '1 second' where id=${lit(sessions[2])}`);
      for (const i of [1,2]) for (const [name,input] of [['eco_begin_parser_ai',ai()],['eco_create_parser_report',report()]]) await assert.rejects(call(i,name,input),/Unauthorized/);
      await seed(); await query(`update eco_private.users set is_active=false where id=${lit(ids[2])}`); await assert.rejects(call(2,'eco_begin_parser_ai',ai()),/Unauthorized/);
    });
    await t.test('AI begin validates hashes and sizes, and concurrent retries run the provider once', async () => {
      await seed(); const input=ai();
      for (const bad of [{sourceHash:'0'.repeat(64)},{current:[]},{requestId:'bad'},{rawText:'x'.repeat(20001)},{extra:true}]) await assert.rejects(call(2,'eco_begin_parser_ai',{...input,...bad}),/Invalid|too large/);
      const results=await Promise.all(Array.from({length:8},()=>call(2,'eco_begin_parser_ai',input)));
      assert.equal(results.filter(result=>result.runProvider).length,1); assert.ok(results.every(result=>result.state==='pending'));
      assert.equal(await query('select count(*) from eco_private.parser_ai_requests'),'1');
      await assert.rejects(call(2,'eco_begin_parser_ai',{...input,sourceRevision:'changed'}),/Request conflict/);
      const other=await call(1,'eco_begin_parser_ai',input); assert.equal(other.runProvider,true,'Request identifiers are scoped to the owner.');
    });
    await t.test('concurrent independent calls obey both minute and daily quotas', async () => {
      await seed(); const race=await Promise.allSettled(Array.from({length:12},()=>call(2,'eco_begin_parser_ai',ai())));
      assert.equal(race.filter(result=>result.status==='fulfilled').length,10); assert.ok(race.filter(result=>result.status==='rejected').every(result=>/AI rate limit/.test(String(result.reason))));
      assert.equal(await query(`select count(*) from eco_private.parser_ai_requests where owner_id=${lit(ids[2])}`),'10');
      await seed(); const input=ai();
      await query(`insert into eco_private.parser_ai_requests(id,owner_id,session_id,data_mode,input,created_at) select gen_random_uuid(),${lit(ids[2])},${lit(sessions[2])},'live',${json(input)},now()-interval '2 hours' from generate_series(1,200)`);
      await assert.rejects(call(2,'eco_begin_parser_ai',ai()),/daily limit/);
      assert.equal((await call(1,'eco_begin_parser_ai',ai())).runProvider,true,'Other owners retain an independent budget.');
    });
    await t.test('service completion is one-way, owner-bound and stale work never runs again', async () => {
      await seed(); const input=ai(); await call(2,'eco_begin_parser_ai',input);
      await assert.rejects(finish(1,input.requestId),/Unknown request/);
      await assert.rejects(finish(2,input.requestId,[]),/Invalid result/);
      await assert.rejects(finish(2,input.requestId,null,'sensitive error text'),/Invalid error code/);
      const done=await finish(2,input.requestId); assert.equal(done.state,'complete');
      assert.deepEqual(await finish(2,input.requestId,{vessel:'CHANGED'}),done);
      assert.deepEqual(await call(2,'eco_begin_parser_ai',input),done);
      const expired=ai(); await call(2,'eco_begin_parser_ai',expired); await query(`update eco_private.parser_ai_requests set created_at=now()-interval '3 minutes' where id=${lit(expired.requestId)}`);
      const outcome=await call(2,'eco_begin_parser_ai',expired); assert.equal(outcome.state,'failed'); assert.equal(outcome.errorCode,'REQUEST_EXPIRED'); assert.equal(outcome.runProvider,false);
      assert.equal((await finish(2,expired.requestId)).state,'failed');
    });
    await t.test('completion rechecks preview, revocation, member activation and test generation', async () => {
      await seed(); const input=ai(); await call(0,'eco_begin_parser_ai',input); await as(0,"select public.eco_set_preview('trader','hk')"); await assert.rejects(finish(0,input.requestId),/read.only/);
      await seed(); const second=ai(); await call(2,'eco_begin_parser_ai',second); await query(`insert into eco_private.revoked_sessions(session_id,user_id) values(${lit(sessions[2])},${lit(ids[2])})`); await assert.rejects(finish(2,second.requestId),/Unauthorized/);
      await seed(); const third=ai(); await call(2,'eco_begin_parser_ai',third); await query(`update eco_private.users set is_active=false where id=${lit(ids[2])}`); await assert.rejects(finish(2,third.requestId),/Unauthorized/);
      await seed(); const testInput=ai({dataMode:'test',generation:await generation()}); await call(0,'eco_begin_parser_ai',testInput); await query('update eco_private.test_workspace_policy set generation=gen_random_uuid()'); await assert.rejects(finish(0,testInput.requestId),/expired/);
    });
    await t.test('completion stops when an account enters an access hold or loses confirmed email', async () => {
      for (const condition of [`update eco_private.users set access_hold_request=gen_random_uuid() where id=${lit(ids[2])}`, `update auth.users set email_confirmed_at=null where id=${lit(ids[2])}`]) {
        await seed(); const input=ai(); await call(2,'eco_begin_parser_ai',input); await query(condition);
        await assert.rejects(call(2,'eco_begin_parser_ai',input),/Unauthorized/);
        await assert.rejects(finish(2,input.requestId),/Unauthorized/);
        assert.equal(await query(`select state from eco_private.parser_ai_requests where id=${lit(input.requestId)}`),'pending');
      }
    });
    await t.test('completion retains the original trusted AAL when MFA requirements change', async () => {
      await seed(); const low=ai(); await call(2,'eco_begin_parser_ai',low);
      assert.equal(await query(`select origin_aal from eco_private.parser_ai_requests where id=${lit(low.requestId)}`),'aal1');
      await query(`update eco_private.users set mfa_required=true where id=${lit(ids[2])}`);
      await assert.rejects(call(2,'eco_begin_parser_ai',ai()),/Unauthorized/);
      await assert.rejects(finish(2,low.requestId),/Unauthorized/);
      assert.equal((await call(2,'eco_begin_parser_ai',low,'aal2')).runProvider,false);
      await assert.rejects(finish(2,low.requestId),/Unauthorized/,'A later elevated retry cannot rewrite original request assurance.');
      const elevated=ai(); await call(2,'eco_begin_parser_ai',elevated,'aal2');
      assert.equal(await query(`select origin_aal from eco_private.parser_ai_requests where id=${lit(elevated.requestId)}`),'aal2');
      assert.equal((await finish(2,elevated.requestId)).state,'complete');
      await assert.rejects(call(2,'eco_begin_parser_ai',ai({originAal:'aal2'}),'aal2'),/Invalid input/);
    });
    await t.test('reports are idempotent and AI references cannot cross owner, raw input or namespace', async () => {
      await seed(); const input=ai(); await call(2,'eco_begin_parser_ai',input);
      const payload=report({aiRequestId:input.requestId}); const both=await Promise.all([call(2,'eco_create_parser_report',payload),call(2,'eco_create_parser_report',payload)]); assert.deepEqual(both[0],both[1]);
      await assert.rejects(call(2,'eco_create_parser_report',{...payload,notes:'Changed'}),/Request conflict/);
      await assert.rejects(call(1,'eco_create_parser_report',{...payload,requestId:randomUUID()}),/Invalid AI reference/);
      await assert.rejects(call(2,'eco_create_parser_report',{...payload,requestId:randomUUID(),rawText:'Different source'}),/Invalid AI reference/);
      const otto=ai(); await call(0,'eco_begin_parser_ai',otto);
      await assert.rejects(call(0,'eco_create_parser_report',report({dataMode:'test',generation:await generation(),aiRequestId:otto.requestId})),/Invalid AI reference/);
      assert.equal(await query('select count(*) from eco_private.parser_reports'),'1');
      await assert.rejects(call(2,'eco_list_parser_reports',{dataMode:'live'}),/Forbidden/);
    });
    await t.test('admin report pagination is stable and test reports are isolated from live reports', async () => {
      await seed(); const gen=await generation();
      const live=[]; for (let i=0;i<5;i++) live.push(await call(i%3,'eco_create_parser_report',report({notes:`Live fixture ${i}`})));
      const privateReport=await call(0,'eco_create_parser_report',report({dataMode:'test',generation:gen,notes:'Test fixture'}));
      await query(`update eco_private.parser_reports set created_at='2026-10-15T00:00:00Z';insert into eco_private.parser_reports(request_id,owner_id,owner_name,data_mode,generation,input) values(gen_random_uuid(),${lit(ids[1])},'Another owner','test',${lit(gen)},${json(report({dataMode:'test',generation:gen}))})`);
      const received=[]; let cursor; do { const page=await call(1,'eco_list_parser_reports',{dataMode:'live',limit:2,...(cursor?{cursor}:{})}); received.push(...page.items); cursor=page.nextCursor; } while(cursor);
      assert.equal(received.length,5); assert.deepEqual(new Set(received.map(item=>item.id)),new Set(live.map(item=>item.id))); assert.ok(received.every(item=>item.dataMode==='live'));
      assert.deepEqual((await call(0,'eco_list_parser_reports',{dataMode:'test',generation:gen})).items.map(item=>item.id),[privateReport.id]);
      await assert.rejects(call(1,'eco_list_parser_reports',{dataMode:'test',generation:gen}),/Forbidden/);
      for (const extra of [{limit:0},{limit:51},{cursor:'bad'},{cursor:'not-a-time|not-a-uuid'}]) await assert.rejects(call(0,'eco_list_parser_reports',{dataMode:'live',...extra}),/Invalid/);
    });
    const fields = {vessel:'SYNTHETIC',imo:'',buyerText:'',portText:'Singapore',eta:'',hsfo:'',vlsfo:'100',lsmgo:'',remarks:''};
    const snapshot = {fields,standardText:'SYNTHETIC\nSingapore\nVLSFO 100 MT',warnings:[],rmk:false,viscosity:[]};
    const capturedReport = extra => report({parsed:fields,corrected:fields,capture:{original:snapshot,submitted:snapshot,originalRevision:'original-v1',parseOrigin:'initial'},...extra});
    const identity = (id,revision=0,extra={}) => ({requestId:randomUUID(),reportId:id,expectedRevision:revision,dataMode:'live',...extra});
    const getDetail = (id,extra={}) => call(0,'eco_list_parser_reports',{dataMode:'live',id,...extra});
    const reviewFinish = (actor,id,result,error=null) => service('eco_finish_parser_review',`${lit(ids[actor])}::uuid,${lit(id)}::uuid,${result===null?'null':json(result)},${error===null?'null':lit(error)}`);
    const analysis = input => ({requestId:input.requestId,reportId:input.reportId,revision:input.expectedRevision,model:'synthetic-model',diagnosis:'Fixture diagnosis',proposedFix:'Fixture conceptual rule',regressionExamples:[{rawText:'SYNTHETIC VLSFO 100 MT',reason:'Quantity'}],warnings:[]});
    const approved = async (extra={}) => {const created=await call(0,'eco_create_parser_report',capturedReport(extra));const scope={dataMode:extra.dataMode??'live',...(extra.generation?{generation:extra.generation}:{})};const action={...identity(created.id,0,scope),action:'approve',expected:snapshot,notes:'Human approved'};return {created,scope,action,detail:await call(0,'eco_review_parser_report',action)};};
    await t.test('review private tables and service-only finish are denied to every browser role',async()=>{
      await seed();
      for(const table of ['parser_review_history','parser_review_actions','parser_review_requests']) {assert.equal(await query(`select relrowsecurity from pg_class where oid='eco_private.${table}'::regclass`),'t');for(const role of ['anon','authenticated','service_role'])await assert.rejects(query(`set role ${role};select * from eco_private.${table}`),/permission denied/);}
      for(const name of ['eco_review_parser_report','eco_begin_parser_review'])await assert.rejects(query(`set role anon;select public.${name}('{}')`),/permission denied/);
      await assert.rejects(as(0,`select public.eco_finish_parser_review(${lit(ids[0])},${lit(randomUUID())},'{}',null)`),/permission denied/);
      const r=await call(0,'eco_create_parser_report',capturedReport());await assert.rejects(call(2,'eco_review_parser_report',{...identity(r.id),action:'approve',expected:snapshot,notes:''}),/Forbidden/);
      await query(`insert into eco_private.role_previews(session_id,user_id,role,office_id) values(${lit(sessions[0])},${lit(ids[0])},'admin','hk')`);
      await assert.rejects(call(0,'eco_review_parser_report',{...identity(r.id),action:'approve',expected:snapshot,notes:''}),/Forbidden/);
    });
    await t.test('full captures validate, remain immutable and hydrate exact historical AI baseline/differences',async()=>{
      await seed();const input=ai({current:fields});await call(0,'eco_begin_parser_ai',input);const stored={requestId:input.requestId,suggestions:[{field:'vlsfo',value:'200',evidence:'200'}],warnings:[]};await finish(0,input.requestId,stored);
      const reportInput=capturedReport({aiRequestId:input.requestId});const r=await call(0,'eco_create_parser_report',reportInput);const detail=await getDetail(r.id);
      assert.deepEqual(detail.capture,reportInput.capture);assert.deepEqual(detail.originalAi.input.current,fields);assert.deepEqual(detail.originalAi.result,stored);assert.equal(detail.originalAi.state,'complete');assert.equal(detail.workflow.stage,'pending_user');assert.equal(detail.buildFingerprint,null);
      await query(`set role service_role;select public.eco_stamp_parser_report(${lit(ids[0])},${lit(r.id)},${lit('a'.repeat(64))});select public.eco_stamp_parser_report(${lit(ids[0])},${lit(r.id)},${lit('b'.repeat(64))})`);
      assert.equal((await getDetail(r.id)).buildFingerprint,'a'.repeat(64));
      for(const capture of [{...reportInput.capture,original:{...snapshot,rmk:'true'}},{...reportInput.capture,submitted:{...snapshot,fields:{...fields,vlsfo:'200'}}},{...reportInput.capture,original:{...snapshot,viscosity:['120']}}])await assert.rejects(call(0,'eco_create_parser_report',capturedReport({capture})),/Invalid|Capture fields/);
      await assert.rejects(call(0,'eco_create_parser_report',{...reportInput,notes:'mutated'}),/Request conflict/);assert.equal((await getDetail(r.id)).notes,reportInput.notes);
    });
    await t.test('human approval uses CAS, immutable retry and server-filtered queues; AI completion cannot be fabricated',async()=>{
      await seed();const {created,action,detail}=await approved();assert.equal(detail.workflow.revision,1);assert.equal(detail.workflow.stage,'pending_ai');assert.deepEqual(detail.workflow.expected,snapshot);assert.equal(detail.history.length,1);assert.equal(detail.history[0].action,'approve');
      assert.deepEqual(await call(0,'eco_review_parser_report',action),detail);
      await assert.rejects(call(0,'eco_review_parser_report',{...action,notes:'different'}),/Request conflict/);
      await assert.rejects(call(1,'eco_review_parser_report',{...action,requestId:randomUUID()}),/Report changed/);
      await assert.rejects(call(0,'eco_review_parser_report',{...identity(created.id,1),action:'complete',aiRequestId:randomUUID()}),/successful AI review/);
      assert.equal((await call(0,'eco_list_parser_reports',{dataMode:'live',stage:'pending_user'})).items.length,0);assert.equal((await call(0,'eco_list_parser_reports',{dataMode:'live',stage:'pending_ai'})).items[0].id,created.id);
      const summary=(await call(0,'eco_list_parser_reports',{dataMode:'live',stage:'pending_ai',summary:true})).items[0];assert.equal(summary.rawText,undefined);assert.equal(summary.history,undefined);assert.equal((await call(0,'eco_list_parser_reports',{dataMode:'live'})).items[0].rawText,rawText);
      assert.deepEqual((await getDetail(created.id)).capture.original,snapshot);
    });
    await t.test('AI review receipts deduplicate concurrent starts and load stored evidence rather than request corrections',async()=>{
      await seed();const {created}=await approved();const input={...identity(created.id,1),kind:'ai'};
      const calls=await Promise.all([call(0,'eco_begin_parser_review',input),call(0,'eco_begin_parser_review',input)]);assert.equal(calls.filter(v=>v.runProvider).length,1);const first=calls.find(v=>v.runProvider);assert.deepEqual(first.evidence.workflow.expected,snapshot);assert.equal(first.evidence.rawText,rawText);assert.equal(first.evidence.workflow.notes,'Human approved');
      await assert.rejects(call(0,'eco_begin_parser_review',{...input,expected:{fields}}),/Unknown|Invalid/);
      const result=analysis(input);assert.equal((await reviewFinish(0,input.requestId,result)).state,'complete');assert.deepEqual((await call(0,'eco_begin_parser_review',input)).result,result);assert.deepEqual((await reviewFinish(0,input.requestId,{...result,diagnosis:'mutated'})).result,result);
      const complete={...identity(created.id,1),action:'complete',aiRequestId:input.requestId};const done=await call(1,'eco_review_parser_report',complete);assert.equal(done.workflow.stage,'reviewed');assert.equal(done.workflow.revision,2);assert.deepEqual(done.workflow.aiReview,result);assert.equal(done.workflow.replay,null);
    });
    await t.test('reopen invalidates current AI/replay but preserves human evidence and history; old AI cannot complete a new approval',async()=>{
      await seed();const {created}=await approved();const input={...identity(created.id,1),kind:'ai'};await call(0,'eco_begin_parser_review',input);await reviewFinish(0,input.requestId,analysis(input));
      let r=await call(0,'eco_review_parser_report',{...identity(created.id,1),action:'reopen'});assert.equal(r.workflow.stage,'pending_user');assert.equal(r.workflow.aiReview,null);assert.deepEqual(r.workflow.expected,snapshot);
      r=await call(0,'eco_review_parser_report',{...identity(created.id,2),action:'approve',expected:snapshot,notes:'Re-approved'});assert.equal(r.workflow.revision,3);
      await assert.rejects(call(0,'eco_review_parser_report',{...identity(created.id,3),action:'complete',aiRequestId:input.requestId}),/successful AI review/);assert.deepEqual(r.history.map(item=>item.action),['approve','ai_review','reopen','approve']);
    });
    await t.test('review late completion rechecks revision, active session, admin rights, MFA and preview',async()=>{
      for(const change of ['revision','session','revoked','expired','admin','mfa','preview']) {
        await seed();const {created}=await approved();const input={...identity(created.id,1),kind:'ai'};await call(0,'eco_begin_parser_review',input);
        if(change==='revision'){await call(0,'eco_review_parser_report',{...identity(created.id,1),action:'reopen'});assert.equal((await reviewFinish(0,input.requestId,analysis(input))).state,'failed');continue;}
        if(change==='session')await query(`delete from auth.sessions where id=${lit(sessions[0])}`);
        if(change==='revoked')await query(`insert into eco_private.revoked_sessions(session_id,user_id) values(${lit(sessions[0])},${lit(ids[0])})`);
        if(change==='expired')await query(`update auth.sessions set not_after=now()-interval '1 second' where id=${lit(sessions[0])}`);
        if(change==='admin')await query(`update eco_private.users set is_admin=false where id=${lit(ids[0])}`);
        if(change==='mfa')await query(`update eco_private.users set mfa_required=true where id=${lit(ids[0])}`);
        if(change==='preview')await query(`insert into eco_private.role_previews(session_id,user_id,role,office_id) values(${lit(sessions[0])},${lit(ids[0])},'admin','hk')`);
        await assert.rejects(reviewFinish(0,input.requestId,analysis(input)),/Unauthorized|Preview|Forbidden|revoked|session/i);
      }
    });
    await t.test('replay requires reviewed state, exact revision and trusted service finish; stored match never changes review stage',async()=>{
      await seed();const {created}=await approved();await assert.rejects(call(0,'eco_begin_parser_review',{...identity(created.id,1),kind:'replay'}),/Invalid review stage/);
      const aiInput={...identity(created.id,1),kind:'ai'};await call(0,'eco_begin_parser_review',aiInput);await reviewFinish(0,aiInput.requestId,analysis(aiInput));await call(0,'eco_review_parser_report',{...identity(created.id,1),action:'complete',aiRequestId:aiInput.requestId});
      const replayInput={...identity(created.id,2),kind:'replay'};await call(0,'eco_begin_parser_review',replayInput);
      const replay={status:'matched',actual:snapshot,differences:[],directorySensitiveDifferences:[],provenance:{reportId:created.id,reportRevision:2},executedWith:{parserVersion:'fixture',buildFingerprint:'a'.repeat(64)}};
      const done=await reviewFinish(0,replayInput.requestId,replay);assert.equal(done.result.workflow.replay.status,'matched');assert.equal(done.result.workflow.stage,'reviewed');assert.equal(done.result.workflow.revision,3);assert.deepEqual((await call(0,'eco_begin_parser_review',replayInput)).result,done.result);
    });
    await t.test('review TEST is real-Otto-only, rotates fail closed and operator purge cascades history, receipts and actions',async()=>{
      await seed();const gen=await generation();const {created,scope}=await approved({dataMode:'test',generation:gen});
      for(const i of [1,2])await assert.rejects(call(i,'eco_begin_parser_review',{...identity(created.id,1,scope),kind:'ai'}),/Forbidden/);
      const input={...identity(created.id,1,scope),kind:'ai'};await call(0,'eco_begin_parser_review',input);await reviewFinish(0,input.requestId,analysis(input));assert.equal((await getDetail(created.id,scope)).history.length,2);
      await service('eco_purge_test_workspace',lit(gen));for(const table of ['parser_review_history','parser_review_actions','parser_review_requests'])assert.equal(await query(`select count(*) from eco_private.${table}`),'0');
      await assert.rejects(call(0,'eco_begin_parser_review',input),/expired/);await assert.rejects(reviewFinish(0,input.requestId,analysis(input)),/Unknown/);
    });

    await t.test('operator purge is generation-guarded, disables retained copies and leaves live records intact', async () => {
      await seed(); const gen=await generation();
      await call(0,'eco_begin_parser_ai',ai({dataMode:'test',generation:gen})); await call(2,'eco_begin_parser_ai',ai());
      await call(0,'eco_create_parser_report',report({dataMode:'test',generation:gen})); await call(2,'eco_create_parser_report',report());
      await assert.rejects(service('eco_purge_test_workspace',`${lit(randomUUID())}::uuid`),/Generation conflict/);
      const purged=await service('eco_purge_test_workspace',`${lit(gen)}::uuid`); assert.equal(purged.enabled,false); assert.notEqual(purged.generation,gen); assert.equal(purged.reportsRemoved,1); assert.equal(purged.aiRequestsRemoved,1);
      for (const table of ['parser_reports','parser_ai_requests']) { assert.equal(await query(`select count(*) from eco_private.${table} where data_mode='test'`),'0'); assert.equal(await query(`select count(*) from eco_private.${table} where data_mode='live'`),'1'); }
      await assert.rejects(call(0,'eco_begin_parser_ai',ai({dataMode:'test',generation:gen})),/expired/);
      await assert.rejects(call(0,'eco_list_parser_reports',{dataMode:'test',generation:gen}),/expired/);
      assert.equal((await call(1,'eco_list_parser_reports',{dataMode:'live'})).items.length,1);
    });
  } finally {
    if(started) await exec(join(bin,'pg_ctl'),['-D',data,'-m','immediate','-w','stop'],{env});
    await rm(root,{recursive:true,force:true});
  }
});
