import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';

const exec = promisify(execFile);
test('approved complete-source reader stays dormant and cannot write application records even in READ WRITE mode', async () => {
  const bin = process.env.ECO_NATIVE_PG_BIN;
  assert.ok(bin && isAbsolute(bin), 'Set ECO_NATIVE_PG_BIN; no remote database fallback.');
  const root = await mkdtemp(join(tmpdir(), 'eco-backup-role-'));
  const socket = join(root, 'socket'), data = join(root, 'data');
  await mkdir(socket, { mode: 0o700 });
  const env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', PGPASSFILE: join(root, 'none') };
  let started = false;
  const command = (name, args) => exec(join(bin, name), args, { env, timeout: 30000, maxBuffer: 1024 * 1024 });
  const connection = user => ['--no-password', '-h', socket, '-p', '55517', '-U', user, '-d', 'postgres'];
  const query = async (sql, user = 'eco_provider') => (await command('psql',
    ['-X', '-qAt', ...connection(user), '-v', 'ON_ERROR_STOP=1', '-c', sql])).stdout.trim();
  try {
    await command('initdb', ['-D', data, '-U', 'eco_provider', '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8']);
    await command('pg_ctl', ['-D', data, '-l', join(root, 'server.log'), '-o', `-k ${socket} -p 55517 -c listen_addresses=''`, '-w', 'start']);
    started = true;
    assert.equal(await query("select current_setting('listen_addresses')"), '');
    // Match the relevant Supabase customer/provider authority split. These are
    // isolated invented rows; no production host, password or secret is loaded.
    await query(`create role postgres login createdb createrole bypassrls;
      grant pg_read_all_data to postgres with admin option;
      alter database postgres owner to postgres;
      create role managed_auth_owner nologin; create role managed_storage_owner nologin;
      create schema eco_private authorization postgres;
      create schema auth authorization managed_auth_owner;
      create schema storage authorization managed_storage_owner;
      create schema future_provider authorization postgres;
      set role postgres; create table eco_private.existing(id bigserial);
      insert into eco_private.existing default values;
      alter table eco_private.existing enable row level security;
      alter table eco_private.existing force row level security;
      reset role; set role managed_auth_owner;
      create table auth.fixture(id bigserial); insert into auth.fixture default values;
      alter table auth.fixture enable row level security; alter table auth.fixture force row level security;
      reset role; set role managed_storage_owner;
      create table storage.fixture(id int); insert into storage.fixture values(1); reset role;`);
    assert.equal(await query("select has_table_privilege('postgres','auth.fixture','SELECT WITH GRANT OPTION')"), 'f');
    assert.equal(await query("select pg_has_role('postgres','managed_auth_owner','SET')"), 'f');
    const migration = await readFile(new URL('../supabase/migrations/20261021062520_backup_reader_role.sql', import.meta.url), 'utf8');
    // A PUBLIC write grant cannot be denied to one login; staging must refuse it.
    await query('grant update on auth.fixture to public');
    await assert.rejects(query(migration, 'postgres'), /inherits persistent application write privileges/);
    assert.equal(await query("select count(*) from pg_roles where rolname='eco_backup_reader'"), '0');
    await query('revoke update on auth.fixture from public');
    // Definer audit covers future/non-application schemas, not just public.
    await query(`set role postgres; create function future_provider.mutate() returns void
      language sql security definer as 'update eco_private.existing set id=id'; reset role;`);
    await assert.rejects(query(migration, 'postgres'), /non-system security-definer routine/);
    assert.equal(await query("select count(*) from pg_roles where rolname='eco_backup_reader'"), '0');
    await query('revoke execute on function future_provider.mutate() from public');
    await query(migration, 'postgres');
    assert.equal(await query("select rolcanlogin from pg_roles where rolname='eco_backup_reader'"), 'f');
    await assert.rejects(query('select 1', 'eco_backup_reader'), /not permitted to log in/);
    // Activation here is synthetic only; the migration itself never enables it.
    await query('alter role eco_backup_reader login');
    assert.equal(await query("select current_setting('default_transaction_read_only')", 'eco_backup_reader'), 'on');
    for (const table of ['eco_private.existing', 'auth.fixture', 'storage.fixture'])
      assert.equal(await query(`select count(*) from ${table}`, 'eco_backup_reader'), '1');
    assert.equal(await query('select last_value from auth.fixture_id_seq', 'eco_backup_reader'), '1');
    await query(`set role postgres; create table eco_private.future(id int); insert into eco_private.future values(2);
      alter table eco_private.future enable row level security; alter table eco_private.future force row level security;
      reset role; set role managed_auth_owner; create table auth.future(id bigserial); insert into auth.future default values;
      alter table auth.future enable row level security; alter table auth.future force row level security; reset role;
      create schema new_provider; create table new_provider.fixture(id int); insert into new_provider.fixture values(9);`);
    for (const table of ['eco_private.future', 'auth.future', 'new_provider.fixture'])
      assert.equal(await query(`select count(*) from ${table}`, 'eco_backup_reader'), '1');
    const dump = join(root, 'synthetic.dump');
    await command('pg_dump', [...connection('eco_backup_reader'), '--format=custom', '--file=' + dump]);
    assert.ok((await stat(dump)).size > 1000, 'Full ordinary pg_dump must include managed and new namespaces.');
    await assert.rejects(query('insert into eco_private.future values(3)', 'eco_backup_reader'), /read-only transaction/);
    // Default read-only is not the sole boundary: changing transaction mode must
    // not allow application records, sequences, ownership or administration writes.
    for (const sql of ['insert into eco_private.future values(3)', 'delete from eco_private.existing',
      'update auth.fixture set id=5', 'truncate storage.fixture',
      'alter table eco_private.future add column x text', 'create table public.no_write(id int)',
      'create schema no_create', 'create role no_admin', "select nextval('auth.fixture_id_seq')",
      'select future_provider.mutate()']) {
      await assert.rejects(query('begin read write; ' + sql + '; rollback', 'eco_backup_reader'), /permission denied|must be owner/);
    }
    assert.equal(await query("select (not rolsuper and not rolcreaterole and not rolcreatedb and not rolreplication and rolbypassrls and rolinherit)::text from pg_roles where rolname=current_user", 'eco_backup_reader'), 'true');
    assert.equal(await query("select count(*)=1 and bool_and(r.rolname='pg_read_all_data' and not m.admin_option and m.inherit_option and not m.set_option) from pg_auth_members m join pg_roles r on r.oid=m.roleid where m.member=(select oid from pg_roles where rolname=current_user)", 'eco_backup_reader'), 't');
    for (const role of ['postgres', 'eco_provider', 'managed_auth_owner', 'pg_read_all_data'])
      await assert.rejects(query('set role ' + role, 'eco_backup_reader'), /permission denied/);
    // Assert the deliberately broad read capability without reading credential values.
    assert.equal(await query("select has_any_column_privilege(current_user,'pg_catalog.pg_authid','SELECT') and has_any_column_privilege(current_user,'pg_catalog.pg_shadow','SELECT') and has_column_privilege(current_user,'pg_catalog.pg_subscription','subconninfo','SELECT')", 'eco_backup_reader'), 't');
    assert.equal(await query('select count(subdbid) from pg_catalog.pg_subscription', 'eco_backup_reader'), '0');
    await assert.rejects(query(migration, 'postgres'), /Backup reader already exists/);
  } finally {
    try { if (started) await command('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
});
