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
const stamp = delta => new Date(Date.now() - 60_000 + delta * 1000).toISOString();
const rows = checkedAt => ['lng', 'methanol', 'ammonia', 'ethanol'].map((id, index) => ({ id, fuel: ['LNG', 'Methanol', 'Ammonia', 'Ethanol'][index], position: `Synthetic verified ${id} position.`, sourceUrl: index ? `https://www.mpa.gov.sg/media-centre/details/synthetic-${id}` : 'https://www.mpa.gov.sg/api/media/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/synthetic-register.pdf', sourceTitle: 'Synthetic official source', publishedAt: '2025-01-01', checkedAt, evidenceHash: 'a'.repeat(64) }));
test('official tables publish privately on isolated native PostgreSQL', async t => {
  const bin = process.env.ECO_NATIVE_PG_BIN; assert.ok(bin && isAbsolute(bin), 'Set ECO_NATIVE_PG_BIN; no remote fallback.');
  const root = await mkdtemp(join(tmpdir(), 'eco-official-tables-pg-')), socket = join(root, 'socket'), data = join(root, 'data'); await mkdir(socket, { mode: 0o700 });
  const env = { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C', PGPASSFILE: join(root, 'none') }; let started = false;
  const query = sql => new Promise((resolve, reject) => {
    const proc = spawn(join(bin, 'psql'), ['-X', '-q', '-A', '-t', '--no-password', '-h', socket, '-p', '55507', '-U', 'eco_fixture', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { env }); let output = '', errors = '';
    proc.stdout.on('data', value => output += value); proc.stderr.on('data', value => errors += value); proc.on('error', reject); proc.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(errors))); proc.stdin.on('error', reject); proc.stdin.end(sql);
  });
  const as = (index, sql, claims = {}) => query(`begin;set local role authenticated;do $$begin perform set_config('request.jwt.claims',${lit(JSON.stringify({ sub: ids[index], session_id: sessions[index], aal: 'aal1', ...claims }))},true);end$$;${sql};commit;`);
  const read = index => as(index, 'select public.eco_official_table_snapshot()').then(JSON.parse);
  const publish = (checkedAt, value, failureReason) => query(`begin;set local role service_role;select public.eco_publish_official_table(${json({ checkedAt, rows: value, ...(failureReason ? { failureReason } : {}) })});commit;`).then(JSON.parse);
  const seed = async () => {
    await query(`truncate eco_private.official_table_state,eco_private.official_table_snapshots restart identity;truncate auth.users cascade;
    insert into auth.users(id,email,email_confirmed_at,encrypted_password) values ${ids.map((id, index) => `(${lit(id)},'official-fixture-${index}@example.test',now(),'synthetic')`).join(',')};
    update eco_private.users set office_id='hk',display_name='Synthetic member',is_active=true,activated_at=now(),is_admin=id=${lit(ids[0])};
    insert into auth.sessions(id,user_id) values ${ids.map((id, index) => `(${lit(sessions[index])},${lit(id)})`).join(',')};`);
  };
  try {
    await exec(join(bin, 'initdb'), ['-D', data, '-U', 'eco_fixture', '-A', 'trust', '--no-locale', '--encoding=UTF8'], { env });
    await exec(join(bin, 'pg_ctl'), ['-D', data, '-l', join(root, 'server.log'), '-o', `-k ${socket} -p 55507 -c listen_addresses=''`, '-w', 'start'], { env }); started = true;
    await query(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,encrypted_password text,raw_app_meta_data jsonb not null default '{}');
    create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),not_after timestamptz);
    create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
    create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
    grant usage on schema auth to authenticated,service_role;grant execute on function auth.uid(),auth.jwt() to authenticated,service_role;`);
    await applySchemaMigrations(query); await query("insert into eco_private.offices values('hk','Hong Kong') on conflict do nothing");
    await t.test('bootstrap is unavailable; RLS and grants expose only the authenticated read and service publisher', async () => {
      await seed(); const initial = (await read(1)).snapshot;
      assert.equal(initial.status, 'unavailable'); assert.deepEqual(initial.rows, []); assert.equal(initial.checkedAt, null);
      for (const table of ['official_table_state', 'official_table_snapshots']) {
        assert.equal(await query(`select relrowsecurity from pg_class where oid='eco_private.${table}'::regclass`), 't');
        for (const role of ['anon', 'authenticated', 'service_role']) await assert.rejects(query(`set role ${role};select * from eco_private.${table}`), /permission denied/);
      }
      for (const name of ['eco_official_table_snapshot()', 'eco_official_table_refresh_context()', `eco_publish_official_table(${json({ checkedAt: stamp(0), rows: rows(stamp(0)) })})`]) await assert.rejects(query(`set role anon;select public.${name}`), /permission denied/);
      await assert.rejects(as(0, 'select public.eco_official_table_refresh_context()', { role: 'service_role' }), /permission denied/);
      await assert.rejects(as(0, `select public.eco_publish_official_table(${json({ checkedAt: stamp(0), rows: [] })})`, { role: 'service_role' }), /permission denied/);
    });
    await t.test('service publication is shared with ordinary/VIEW AS readers, privately versioned, and earns no contribution', async () => {
      await seed(); const time = stamp(0), input = rows(time);
      assert.equal((await publish(time, input)).status, 'updated');
      assert.deepEqual((await read(1)).snapshot.rows, input);
      await as(0, "select public.eco_set_preview('trader','hk')"); assert.deepEqual(await read(0), await read(1));
      assert.equal(await query('select count(*) from eco_private.official_table_snapshots'), '1');
      for (const table of ['supplier_contributions', 'profile_tab_contributions', 'feedback_contributions']) assert.equal(await query(`select count(*) from eco_private.${table}`), '0');
      assert.equal(await query("select migration_head from eco_private.platform_versions where component='official-tables'"), '20261021073027');
    });
    await t.test('dedup refresh advances verification only; changed rows create immutable history', async () => {
      await seed(); const first = stamp(0), second = stamp(1), third = stamp(2);
      await publish(first, rows(first)); assert.equal((await publish(second, rows(second))).status, 'unchanged');
      const current = (await read(1)).snapshot; assert.equal(current.checkedAt, second); assert.equal(current.updatedAt, first); assert.equal(current.rows[0].checkedAt, second);
      assert.equal(await query('select count(*) from eco_private.official_table_snapshots'), '1');
      const changed = rows(third); changed[0].position = 'Synthetic revised LNG register position.'; changed[0].evidenceHash = 'b'.repeat(64);
      await publish(third, changed); assert.equal(await query('select count(*) from eco_private.official_table_snapshots'), '2');
      assert.equal((await read(1)).snapshot.updatedAt, third);
      assert.equal(await query("select rows->0->>'position' from eco_private.official_table_snapshots where id=1"), rows(first)[0].position);
    });
    await t.test('failed and overdue refreshes retain last verified rows and expose a truthful stale status', async () => {
      await seed(); const first = stamp(0), failed = stamp(1); await publish(first, rows(first));
      assert.equal((await publish(failed, null)).status, 'stale'); const stale = (await read(1)).snapshot;
      assert.equal(stale.status, 'stale'); assert.equal(stale.checkedAt, failed); assert.equal(stale.updatedAt, first); assert.deepEqual(stale.rows, rows(first));
      assert.equal(await query('select count(*) from eco_private.official_table_snapshots'), '1');
      await publish(stamp(2), null, 'publication-gap'); assert.match((await read(1)).snapshot.message, /need review after a gap/);
      assert.deepEqual((await read(1)).snapshot.rows, rows(first));
      const reviewed = stamp(3); await publish(reviewed, rows(reviewed)); assert.equal((await read(1)).snapshot.status, 'current'); assert.equal((await read(1)).snapshot.message, undefined);
      await query("update eco_private.official_table_state set status='current',verified_at=now()-interval '49 hours'"); assert.equal((await read(1)).snapshot.status, 'stale');
      await seed(); assert.equal((await publish(stamp(0), null)).status, 'unavailable'); assert.deepEqual((await read(1)).snapshot.rows, []);
    });
    await t.test('older overlapping completions and date regressions cannot replace the latest verified snapshot', async () => {
      await seed(); const old = stamp(0), recent = stamp(3);
      const revised = rows(recent); revised[0].publishedAt = '2025-02-01';
      await Promise.all([publish(recent, revised), publish(old, rows(old))]);
      assert.equal((await read(1)).snapshot.checkedAt, recent); assert.equal((await read(1)).snapshot.rows[0].publishedAt, '2025-02-01');
      assert.equal((await publish(old, null)).status, 'superseded');
      const before = await read(1), regressionTime = stamp(5); await assert.rejects(publish(regressionTime, rows(regressionTime)), /date regressed/); assert.deepEqual(await read(1), before);
    });
    await t.test('malformed or nonapproved rows reject atomically; revoked/inactive/deleted sessions cannot read', async () => {
      await seed(); const first = stamp(0); await publish(first, rows(first)); const before = await read(1);
      for (const mutate of [value => value.pop(), value => { value[2].sourceUrl = 'https://other.test/source'; }, value => { value[3].position = 'Contact person: private@example.test'; }, value => { value[1].publishedAt = '2025-02-30'; }, value => { value[1].secret = 'not allowed'; }]) {
        const time = stamp(10), value = rows(time); mutate(value); await assert.rejects(publish(time, value)); assert.deepEqual(await read(1), before);
      }
      await query(`insert into eco_private.revoked_sessions(session_id,user_id) values(${lit(sessions[1])},${lit(ids[1])})`); await assert.rejects(read(1), /Unauthorized/);
      await query(`delete from eco_private.revoked_sessions where session_id=${lit(sessions[1])};update eco_private.users set is_active=false where id=${lit(ids[1])}`); await assert.rejects(read(1), /Unauthorized/);
      await query(`update eco_private.users set deleted_at=now(),is_active=false,activated_at=null,is_admin=false,is_spc_trader=false,is_manager=false where id=${lit(ids[1])}`); await assert.rejects(read(1), /Unauthorized/);
    });
  } finally {
    if (started) await exec(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop'], { env }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
