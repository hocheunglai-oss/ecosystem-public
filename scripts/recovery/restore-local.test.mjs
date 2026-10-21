import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { restoreLocal, LocalRestoreError, RESTORE_CHECK, validateRestoreVersions } from './restore-local.mjs';

const BIN = process.env.ECO_NATIVE_PG_BIN || '/usr/lib/postgresql/17/bin';
const BASE = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
const SHA = value => createHash('sha256').update(value).digest('hex');
function command(name, args, env = {}, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(join(BIN, name), args, { env: { ...BASE, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; let error = '';
    child.stdout.on('data', bytes => chunks.push(bytes)); child.stderr.on('data', bytes => { error += bytes; });
    child.stdin.on('error', () => {}); child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(Buffer.concat(chunks).toString()) : reject(new Error(`Synthetic ${name} failed: ${error}`)));
    child.stdin.end(input);
  });
}
async function query(env, value) { return command('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], env, value); }
async function rows(env, select) { return JSON.parse(await query(env, `SELECT coalesce(json_agg(q),'[]'::json) FROM (${select}) q;`)); }
const schemaCondition = "('public','eco_private','auth','storage','supabase_migrations')";
async function saveJson(path, value) { await writeFile(path, JSON.stringify(value), { mode: 0o600 }); }

async function syntheticCapture(root) {
  const fixture = join(root, 'fixture'), data = join(fixture, 'data'), socket = join(fixture, 's'), capture = join(root, 'capture');
  await mkdir(fixture, { mode: 0o700 }); await mkdir(socket, { mode: 0o700 }); await mkdir(capture, { mode: 0o700 });
  await command('initdb', ['-D', data, '-U', 'postgres', '--no-locale', '--encoding=UTF8', '--auth-local=trust', '--auth-host=reject', '--no-instructions']);
  await writeFile(join(data, 'postgresql.auto.conf'), `listen_addresses=''\nunix_socket_directories='${socket}'\nunix_socket_permissions=0700\nshared_buffers='16MB'\nmax_connections=10\n`, { mode: 0o600 });
  const log = join(fixture, 'startup.log');
  const env = { PGHOST: socket, PGPORT: '5432', PGUSER: 'postgres', PGDATABASE: 'postgres', PGSSLMODE: 'disable' };
  let started = false;
  try {
    await command('pg_ctl', ['-D', data, '-l', log, '-w', 'start']); started = true;
    await query(env, `
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA eco_private; CREATE SCHEMA auth; CREATE SCHEMA storage; CREATE SCHEMA supabase_migrations;
      CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
      CREATE TABLE public.items(id bigserial PRIMARY KEY, owner text NOT NULL, amount int NOT NULL);
      INSERT INTO public.items(owner,amount) VALUES('authenticated',7),('synthetic-user',9);
      ALTER TABLE public.items ENABLE ROW LEVEL SECURITY; ALTER TABLE public.items FORCE ROW LEVEL SECURITY;
      CREATE POLICY own_items ON public.items TO authenticated USING(owner=current_user);
      GRANT SELECT ON public.items TO authenticated;
      CREATE FUNCTION public.touch_amount() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.amount := OLD.amount+1; RETURN NEW; END $$;
      CREATE TRIGGER touch_amount BEFORE UPDATE ON public.items FOR EACH ROW EXECUTE FUNCTION public.touch_amount();
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
      CREATE TABLE auth.users(id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid()); INSERT INTO auth.users DEFAULT VALUES;
      CREATE TABLE eco_private.notes(id int PRIMARY KEY, value text); INSERT INTO eco_private.notes VALUES(1,'invented only');
      CREATE TABLE storage.objects(id int PRIMARY KEY, name text); INSERT INTO storage.objects VALUES(1,'synthetic.pdf');
      CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY); INSERT INTO supabase_migrations.schema_migrations VALUES('20261021000000');
    `);
    const tables = await rows(env, `SELECT n.nspname AS schema,c.relname AS name,c.relrowsecurity AS rls,c.relforcerowsecurity AS force_rls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname IN ${schemaCondition} ORDER BY n.nspname,c.relname`);
    for (const table of tables) table.rows = (await rows(env, `SELECT count(*)::text AS rows FROM "${table.schema}"."${table.name}"`))[0].rows;
    const inventory = {
      schemaVersion: 1, sourceProjectRef: 'synthetic-no-cloud',
      source: { server_version: (await rows(env, "SELECT current_setting('server_version') AS version"))[0].version }, tables,
      roles: await rows(env, 'SELECT rolname,rolinherit,rolbypassrls FROM pg_roles ORDER BY rolname'),
      memberships: await rows(env, 'SELECT r.rolname AS role,m.rolname AS member,a.admin_option,a.inherit_option,a.set_option FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member ORDER BY r.rolname,m.rolname'),
      extensions: await rows(env, 'SELECT e.extname,e.extversion,n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace ORDER BY e.extname'),
      functions: await rows(env, `SELECT n.nspname AS schema,p.proname AS name,pg_get_function_identity_arguments(p.oid) AS arguments,md5(pg_get_functiondef(p.oid)) AS definition_hash FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ${schemaCondition} AND p.prokind IN ('f','p') ORDER BY n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)`),
      triggers: await rows(env, `SELECT n.nspname AS schema,c.relname AS table_name,t.tgname AS name,t.tgenabled,md5(pg_get_triggerdef(t.oid)) AS definition_hash FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ${schemaCondition} AND NOT t.tgisinternal ORDER BY n.nspname,c.relname,t.tgname`),
      policies: await rows(env, `SELECT schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname IN ${schemaCondition} ORDER BY schemaname,tablename,policyname`),
    };
    // This provider-managed extension is intentionally outside the selected-schema restore.
    inventory.extensions.push({ extname: 'supabase_vault', extversion: '0.3.1', schema: 'vault' });
    await command('pg_dump', ['--format=custom', '--compress=0', '--file', join(capture, 'database.dump')], env);
    await chmod(join(capture, 'database.dump'), 0o600);
    await mkdir(join(capture, 'storage'), { mode: 0o700 }); await mkdir(join(capture, 'storage/objects'), { mode: 0o700 });
    const objects = [];
    for (let i = 0; i < 5; i++) {
      const bytes = Buffer.from(`%PDF-1.7\nSYNTHETIC DOCUMENT ${i}\n`), path = `objects/${SHA(`object-${i}`)}.bin`;
      await writeFile(join(capture, 'storage', path), bytes, { mode: 0o600 });
      objects.push({ path, size: bytes.length, sha256: SHA(bytes) });
    }
    inventory.storage = { objectCount: 5, totalBytes: objects.reduce((sum, object) => sum + object.size, 0), objects };
    await saveJson(join(capture, 'database-inventory.json'), inventory);
    return { capture, inventory };
  } finally {
    if (started) await command('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    await rm(fixture, { recursive: true, force: true });
  }
}

test('restore version check accepts official package labels and maintained same-major patches', () => {
  for (const banner of ['postgres (PostgreSQL) 17.11',
    'postgres (PostgreSQL) 17.11 (Ubuntu 17.11-1.pgdg24.04+2)',
    'postgres (PostgreSQL) 17.11 (Debian 17.11-1.pgdg12+1)'])
    assert.deepEqual(validateRestoreVersions('17.11', banner), { source: '17.11', local: '17.11' });
  assert.deepEqual(validateRestoreVersions('17.11 (Ubuntu 17.11-1.pgdg24.04+2)',
    'postgres (PostgreSQL) 17.12 (Ubuntu 17.12-1.pgdg24.04+1)'), { source: '17.11', local: '17.12' });
  assert.deepEqual(validateRestoreVersions('17.12', 'postgres (PostgreSQL) 17.12'), { source: '17.12', local: '17.12' });
});

test('restore version check rejects older local tools, other majors, pre-releases and malformed labels', () => {
  for (const banner of ['postgres (PostgreSQL) 17.10', 'postgres (PostgreSQL) 18.11',
    'postgres (PostgreSQL) 16.11', 'postgres (PostgreSQL) 17.11beta1', 'postgres (PostgreSQL) 17.11.1',
    'postgres (PostgreSQL) 17.011', 'postgres (PostgreSQL) 17.11 (Ubuntu) trailing',
    'postgres (PostgreSQL) 17.11 (Ubuntu\n17.11)', 'psql (PostgreSQL) 17.11', null])
    assert.throws(() => validateRestoreVersions('17.11', banner), { code: 'LOCAL_VERSION_UNSUPPORTED' });
  assert.throws(() => validateRestoreVersions('17.12', 'postgres (PostgreSQL) 17.11'), { code: 'LOCAL_VERSION_UNSUPPORTED' });
  for (const source of ['17.10', '18.11', '16.11', '17.11beta1', '17.11.1', '17.11\n', undefined])
    assert.throws(() => validateRestoreVersions(source, 'postgres (PostgreSQL) 17.11'), { code: 'SOURCE_VERSION_UNSUPPORTED' });
});

test('native local restore verifies data and documents without retaining a cluster', async t => {
  // Unix-domain sockets have a small path limit; some OS temporary roots are very long.
  const nativeTemp = tmpdir().length > 40 ? '/tmp' : tmpdir();
  const root = await mkdtemp(join(nativeTemp, 'ert-')); await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const { capture, inventory } = await syntheticCapture(root);
  const inventoryPath = join(capture, 'database-inventory.json');
  const originalInventory = await readFile(inventoryPath), originalDump = SHA(await readFile(join(capture, 'database.dump')));
  await t.test('complete selected-schema round trip and five document checks succeed', async () => {
    const receipt = await restoreLocal({ captureDir: capture, bin: BIN, workParent: root });
    assert.equal(receipt.check, RESTORE_CHECK); assert.equal(receipt.status, 'VERIFIED');
    assert.equal(receipt.tableCount, 5); assert.equal(receipt.totalRows, '6');
    assert.equal(receipt.functionCount, 2); assert.equal(receipt.triggerCount, 1); assert.equal(receipt.policyCount, 1);
    assert.equal(receipt.storageObjectCount, 5); assert.match(receipt.databaseVersion, /^17\./);
    assert.deepEqual(receipt.installedExtensions, ['pgcrypto', 'plpgsql']);
    assert.deepEqual(receipt.excludedExtensions, ['supabase_vault']);
    assert.equal(receipt.isolation.listenAddresses, ''); assert.equal(receipt.isolation.providerLoginsDisabled, true);
    assert.equal(receipt.clusterStopped, true); assert.equal(receipt.restoredDataRemoved, true);
    assert.equal((await stat(receipt.receiptPath)).mode & 0o777, 0o600);
    assert.equal((await readdir(root)).some(name => name.startsWith('.eco-restore-')), false);
    assert.deepEqual(await readFile(inventoryPath), originalInventory);
    assert.equal(SHA(await readFile(join(capture, 'database.dump'))), originalDump);
    const text = await readFile(receipt.receiptPath, 'utf8');
    assert.equal(text.includes('invented only'), false); assert.equal(text.includes('synthetic.pdf'), false);
  });
  await t.test('mismatched source row counts fail and cluster data is removed', async () => {
    const changed = structuredClone(inventory); changed.tables.find(table => table.schema === 'public').rows = '999';
    await saveJson(inventoryPath, changed);
    try {
      await assert.rejects(restoreLocal({ captureDir: capture, bin: BIN, workParent: root }), error => {
        assert.ok(error instanceof LocalRestoreError); assert.equal(error.code, 'TABLE_ROW_COUNT_MISMATCH');
        return true;
      });
      assert.equal((await readdir(root)).some(name => name.startsWith('.eco-restore-')), false);
    } finally { await writeFile(inventoryPath, originalInventory, { mode: 0o600 }); }
  });
  await t.test('changed function definition fails even when row counts match', async () => {
    const changed = structuredClone(inventory); changed.functions[0].definition_hash = '0'.repeat(32);
    await saveJson(inventoryPath, changed);
    try {
      await assert.rejects(restoreLocal({ captureDir: capture, bin: BIN, workParent: root }), { code: 'FUNCTION_DEFINITION_MISMATCH' });
      assert.equal((await readdir(root)).some(name => name.startsWith('.eco-restore-')), false);
    } finally { await writeFile(inventoryPath, originalInventory, { mode: 0o600 }); }
  });
  await t.test('missing selected table cannot be silently ignored', async () => {
    const changed = structuredClone(inventory);
    changed.tables.push({ schema: 'public', name: 'missing', rows: '0', rls: false, force_rls: false });
    await saveJson(inventoryPath, changed);
    try { await assert.rejects(restoreLocal({ captureDir: capture, bin: BIN, workParent: root }), { code: 'TABLE_SET_MISMATCH' }); }
    finally { await writeFile(inventoryPath, originalInventory, { mode: 0o600 }); }
  });
  await t.test('document mismatch fails before a PostgreSQL cluster is started', async () => {
    const changed = structuredClone(inventory); changed.storage.objects[0].sha256 = '0'.repeat(64);
    await saveJson(inventoryPath, changed);
    try {
      await assert.rejects(restoreLocal({ captureDir: capture, bin: BIN, workParent: root }), { code: 'STORAGE_INTEGRITY_MISMATCH' });
      assert.equal((await readdir(root)).some(name => name.startsWith('.eco-restore-')), false);
    } finally { await writeFile(inventoryPath, originalInventory, { mode: 0o600 }); }
  });
  await t.test('failure receipts contain only sanitized status and preserve original capture', async () => {
    const receipts = (await readdir(root)).filter(name => name.startsWith('eco-restore-receipt-'));
    assert.equal(receipts.length, 5);
    const failed = [];
    for (const filename of receipts) {
      const value = JSON.parse(await readFile(join(root, filename), 'utf8'));
      if (value.status === 'FAILED') failed.push(value);
      assert.equal(value.clusterStopped, true); assert.equal(value.restoredDataRemoved, true);
    }
    assert.equal(failed.length, 4);
    assert.deepEqual(await readFile(inventoryPath), originalInventory);
    assert.equal(SHA(await readFile(join(capture, 'database.dump'))), originalDump);
  });
});
