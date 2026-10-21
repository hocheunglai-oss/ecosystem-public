import { tmpdir } from 'node:os';
/** Offline boundary/process tests. The executable is a fake psql; never connects to PostgreSQL. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SqlSession, validateConnection, assertSnapshotAlive, capturePostgres, assertReadOnlySourceRole } from './capture-postgres.mjs';

const projectRef = 'abcdefghijklmnopqrst';
const secret = 'SYNTHETIC_DB_SECRET_9c56f6a6';
const base = () => ({ PGHOST: `db.${projectRef}.supabase.co`, PGPORT: '5432', PGUSER: 'postgres', PGDATABASE: 'postgres', PGPASSWORD: secret, PGSSLMODE: 'verify-full', PGSSLROOTCERT: join(tmpdir(), 'synthetic-root-ca.crt') });
const exists = async path => { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const readRole = () => ({ rolname:'eco_backup_reader',rolsuper:false,rolcreaterole:false,rolcreatedb:false,rolreplication:false,rolbypassrls:true,rolcanlogin:true,rolinherit:true,
  default_read_only:'on',memberships:[{role:'pg_read_all_data',admin:false,inherit:true,set:false}],database_create:false,password_catalog_read:true,password_view_read:true,subscription_secret_read:true,subscription_metadata_read:true,missing_schema_reads:0,missing_table_reads:0,missing_sequence_reads:0,read_grant_options:0,schema_create:0,table_writes:0,sequence_writes:0,app_definers:0,owned_objects:0 });

test('reader privilege boundary rejects effective writes, ownership, elevated membership and callable definers', async () => {
  const session = value => ({ rows:async sql=>{assert.doesNotMatch(sql,/FROM\s+(?:pg_catalog\.)?pg_authid|FROM\s+(?:pg_catalog\.)?pg_shadow|rolpassword/iu);return[value];} });
  await assertReadOnlySourceRole(session(readRole()),'eco_backup_reader');
  const patches = [{rolname:'postgres'},{rolsuper:true},{rolcreaterole:true},{rolcreatedb:true},{rolreplication:true},{rolbypassrls:false},{rolcanlogin:false},{rolinherit:false},
    {default_read_only:'off'},{database_create:true},{subscription_metadata_read:false},{missing_schema_reads:1},{missing_table_reads:1},{missing_sequence_reads:1},{read_grant_options:1},{schema_create:1},{table_writes:1},{sequence_writes:1},{app_definers:1},{owned_objects:1},
    {memberships:[]},{memberships:[{role:'pg_read_all_data',admin:false,inherit:true,set:true}]},{memberships:[{role:'pg_write_all_data',admin:false,inherit:true,set:true}]},{memberships:[{role:'pg_read_all_data',admin:true,inherit:true,set:true}]},
    {memberships:[{role:'pg_read_all_data',admin:false,inherit:true,set:true},{role:'postgres',admin:false,inherit:false,set:true}]}];
  for (const patch of patches) await assert.rejects(assertReadOnlySourceRole(session({...readRole(),...patch}),'eco_backup_reader'),/isolated read-only/);
});

async function fakeBin(root, name, mode) {
  const bin = join(root, name); await mkdir(bin, { mode: 0o700 });
  const source = `#!${process.execPath}
import {createInterface} from 'node:readline';
const mode=${JSON.stringify(mode)}, secret=${JSON.stringify(secret)};
let query=[],hold=false;
if(mode==='ignore-close') { setInterval(()=>{},1000); process.on('SIGTERM',()=>{}); }
createInterface({input:process.stdin}).on('line',line=>{
  if(line==='\\\\q') { if(mode!=='ignore-close')process.exit(0);return; }
  if(line.startsWith('\\\\echo ')) {
    const sql=query.join('\\n');query=[];
    if(hold||sql.includes('HOLD')) {hold=true;return;}
    if(mode==='exit-error') { process.stderr.write(secret+' provider failure\\n');process.exit(7);return; }
    if(mode==='malformed')process.stdout.write(secret+' {malformed metadata\\n');
    else if(mode==='oversize')process.stdout.write(secret+'x'.repeat(33*1024*1024)+'\\n');
    else if(sql.includes('ENV_KEYS'))process.stdout.write(JSON.stringify(Object.keys(process.env).sort())+'\\n');
    else if(sql.includes('json_agg'))process.stdout.write(JSON.stringify([{safe:true}])+'\\n');
    else process.stdout.write('1\\n');
    process.stdout.write(line.slice(6)+'\\n');
  } else if(line!=='ROLLBACK;')query.push(line);
});

`;
  // Fake executable uses CommonJS because no package.json is present in fixture directories.
  await writeFile(join(bin, 'psql'), source.replace("import {createInterface} from 'node:readline';", "const {createInterface}=require('node:readline');"), { flag: 'wx', mode: 0o700 });
  return bin;
}

test('database connection pins reject alternate targets and TLS/environment overrides', async t => {
  await t.test('accepts exact direct source and its session-pooler identity', () => {
    assert.doesNotThrow(() => validateConnection(base(), projectRef));
    assert.doesNotThrow(() => validateConnection({ ...base(), PGHOST: 'aws-0-ap-southeast-1.pooler.supabase.com', PGUSER: `postgres.${projectRef}` }, projectRef));
  });
  await t.test('rejects wrong project, identity, database, host and transaction-pooler port', () => {
    for (const patch of [
      { PGHOST: 'db.zyxwvutsrqponmlkjihg.supabase.co' }, { PGHOST: `${base().PGHOST}.evil.example` }, { PGHOST: 'localhost' },
      { PGUSER: 'postgres.otherproject' }, { PGDATABASE: 'template1' }, { PGPORT: '6543' }, { PGPORT: 5432 },
      { PGHOST: 'aws-0-ap-southeast-1.pooler.supabase.com', PGUSER: 'postgres.zyxwvutsrqponmlkjihg' },
    ]) assert.throws(() => validateConnection({ ...base(), ...patch }, projectRef));
    assert.throws(() => validateConnection(base(), 'invalid-ref'));
  });
  await t.test('requires verify-full, absolute certificate and nonempty credential', () => {
    for (const patch of [{ PGSSLMODE: 'require' }, { PGSSLMODE: 'disable' }, { PGSSLROOTCERT: 'root.crt' }, { PGSSLROOTCERT: '' }, { PGPASSWORD: '' }, { PGPASSWORD: undefined }]) assert.throws(() => validateConnection({ ...base(), ...patch }, projectRef));
  });
  await t.test('rejects every unapproved libpq route or TLS override', () => {
    for (const key of ['PGOPTIONS', 'PGSERVICE', 'PGSERVICEFILE', 'PGPASSFILE', 'PGHOSTADDR', 'PGSSLCERT', 'PGSSLKEY', 'PGSSLSNI', 'PGTARGETSESSIONATTRS', 'DATABASE_URL', 'LD_PRELOAD']) {
      assert.throws(() => validateConnection({ ...base(), [key]: secret }, projectRef), error => error.message === 'Unexpected connection option' && !String(error).includes(secret));
    }
  });
});

test('SqlSession with isolated fake psql', async t => {
  const root = await mkdtemp(join(tmpdir(), 'eco-postgres-process-test-'));
  try {
    await t.test('rows parse and sequential queries work; close waits for process exit', async () => {
      const bin = await fakeBin(root, 'normal', 'normal'), session = new SqlSession({ bin, connection: base(), timeoutMs: 2000 });
      try { assert.equal(await session.query('SELECT 1;'), '1'); assert.deepEqual(await session.rows('SELECT true AS safe'), [{ safe: true }]); }
      finally { await session.close(); }
      assert.equal(session.ended, true); assert.equal(session.child.exitCode, 0); await session.close();
      assert.throws(() => session.query('SELECT 1;'), /session unavailable/);
    });
    await t.test('only allowlisted connection variables enter child environment', async () => {
      const bin = await fakeBin(root, 'environment', 'normal');
      const previous = process.env.ECO_SYNTHETIC_AMBIENT_SECRET; process.env.ECO_SYNTHETIC_AMBIENT_SECRET = secret;
      const session = new SqlSession({ bin, connection: { ...base(), PGOPTIONS: secret, UNRELATED_TOKEN: secret }, timeoutMs: 2000 });
      try {
        const keys = JSON.parse(await session.query('ENV_KEYS'));
        // macOS CoreFoundation may add this process-local encoding hint after exec.
        const runtimeKeys = process.platform === 'darwin' ? keys.filter(key => key !== '__CF_USER_TEXT_ENCODING') : keys;
        assert.deepEqual(runtimeKeys, ['LANG', 'LC_ALL', 'PATH', ...Object.keys(base())].sort());
        assert.equal(keys.includes('ECO_SYNTHETIC_AMBIENT_SECRET'), false);
      } finally { if (previous === undefined) delete process.env.ECO_SYNTHETIC_AMBIENT_SECRET; else process.env.ECO_SYNTHETIC_AMBIENT_SECRET = previous; await session.close(); }
    });
    await t.test('overlapping query fails; close rejects pending query and exits', async () => {
      const bin = await fakeBin(root, 'pending', 'normal'), session = new SqlSession({ bin, connection: base(), timeoutMs: 2000 });
      const pending = assert.rejects(session.query('HOLD'), /session closing/);
      assert.throws(() => session.query('SELECT 1;'), /session unavailable/);
      await session.close(); await pending; assert.equal(session.ended, true);
    });
    await t.test('query timeout kills child and releases pending operation', async () => {
      const bin = await fakeBin(root, 'timeout', 'normal'), session = new SqlSession({ bin, connection: base(), timeoutMs: 150 });
      try { await assert.rejects(session.query('HOLD'), /query timed out/); await session.closed; assert.equal(session.ended, true); assert.equal(session.child.signalCode, 'SIGKILL'); }
      finally { await session.close(); }
    });
    await t.test('unresponsive graceful shutdown is killed and close awaits actual exit', async () => {
      const bin = await fakeBin(root, 'ignore-close', 'ignore-close'), session = new SqlSession({ bin, connection: base(), timeoutMs: 2000 });
      assert.equal(await session.query('SELECT 1;'), '1');
      const closing = session.close(); assert.equal(session.ended, false); await closing;
      assert.equal(session.ended, true); assert.equal(session.child.signalCode, 'SIGKILL');
    });
    await t.test('invalid JSON fails without leaking returned secret-bearing content', async () => {
      const bin = await fakeBin(root, 'malformed', 'malformed'), session = new SqlSession({ bin, connection: base(), timeoutMs: 2000 });
      try { await assert.rejects(session.rows('SELECT malformed'), error => error.message === 'Invalid PostgreSQL metadata response' && !String(error).includes(secret)); }
      finally { await session.close(); }
    });
    await t.test('provider stderr and failing process expose only a fixed failure message', async () => {
      const bin = await fakeBin(root, 'exit-error', 'exit-error'), session = new SqlSession({ bin, connection: base(), timeoutMs: 2000 });
      try { await assert.rejects(session.query('SELECT 1;'), error => /^PostgreSQL session ended \(7\)$/.test(error.message) && !String(error).includes(secret)); }
      finally { await session.close(); }
    });
    await t.test('missing executable rejects safely and close still resolves', async () => {
      const session = new SqlSession({ bin: join(root, 'nonexistent-bin'), connection: base(), timeoutMs: 2000 });
      try { await assert.rejects(session.query('SELECT 1;'), error => error.message === 'PostgreSQL process could not start' && !String(error).includes(secret)); }
      finally { await session.close(); }
      assert.equal(session.ended, true);
    });
    await t.test('oversized metadata is rejected and child terminated without content leakage', async () => {
      const bin = await fakeBin(root, 'oversize', 'oversize'), session = new SqlSession({ bin, connection: base(), timeoutMs: 5000 });
      try { await assert.rejects(session.query('SELECT 1;'), error => error.message === 'PostgreSQL metadata exceeded limit' && !String(error).includes(secret)); await session.closed; assert.equal(session.child.signalCode, 'SIGKILL'); }
      finally { await session.close(); }
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('snapshot keeper rejects a closed or replaced original transaction', async t => {
  const original = { backend_pid: 123, snapshot_time: '2026-10-21T00:00:00+00:00', read_only: 'on', isolation: 'repeatable read', snapshot_view: '100:200:150,175' };
  await t.test('unchanged keeper passes without exporting or replacing a snapshot', async () => {
    let calls = 0;
    await assertSnapshotAlive({ ended: false, rows: async sql => { calls++; assert.match(sql, /pg_current_snapshot/); assert.doesNotMatch(sql, /pg_export_snapshot|pg_try_advisory_lock|BEGIN|COMMIT/); return [{ ...original }]; } }, original);
    assert.equal(calls, 1);
  });
  await t.test('closed connection fails before another query', async () => {
    await assert.rejects(assertSnapshotAlive({ ended: true, rows: async () => { throw new Error('must not query'); } }, original), /Original PostgreSQL snapshot is no longer active/);
  });
  for (const patch of [{ backend_pid: 456 }, { snapshot_time: '2026-10-21T00:00:01+00:00' }, { read_only: 'off' }, { isolation: 'read committed' }, { snapshot_view: '200:300:' }]) {
    await t.test(`changed ${Object.keys(patch)[0]} fails closed`, async () => {
      await assert.rejects(assertSnapshotAlive({ ended: false, rows: async () => [{ ...original, ...patch }] }, original), /Original PostgreSQL snapshot is no longer active/);
    });
  }
});

async function fakeCaptureBin(root, loseAfterFirstDump, sourceRole = 'postgres') {
  const bin = join(root, 'bin'), control = join(root, 'keeper-lost'), log = join(root, 'dump-calls');
  await mkdir(bin, { mode: 0o700 });
  const psql = `#!${process.execPath}
const {createInterface}=require('node:readline');const fs=require('node:fs');
const control=${JSON.stringify(control)};
const original={database:'postgres',role:${JSON.stringify(sourceRole)},server_version:'17.11',read_only:'on',isolation:'repeatable read',snapshot_time:'2026-10-21T00:00:00+00:00',snapshot:'00000001-00000001-1',backend_pid:process.pid,snapshot_view:'100:200:'};
const reader=${JSON.stringify(readRole())};
let query=[];
createInterface({input:process.stdin}).on('line',line=>{
  if(line==='\\\\q')process.exit(0);
  if(line.startsWith('\\\\echo ')){
    const text=query.join('\\n');query=[];let rows=[];
    if(text.includes('WITH RECURSIVE memberships'))rows=[{...reader,rolname:original.role}];
    else if(text.includes('pg_try_advisory_lock'))rows=[{acquired:true}];
    else if(text.includes('pg_export_snapshot'))rows=[original];
    else if(text.includes('pg_current_snapshot'))rows=[{...original,...(fs.existsSync(control)?{read_only:'off',isolation:'read committed'}:{})}];
    else if(text.includes('vault.secrets'))rows=[{vault_secrets:0,subscriptions:0}];
    process.stdout.write(JSON.stringify(rows)+'\\n'+line.slice(6)+'\\n');
  }else query.push(line);
});
`;
  const dump = `#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2), path=args.find(a=>a.startsWith('--file=')).slice(7);
fs.appendFileSync(${JSON.stringify(log)},args.includes('--schema-only')?'schema\\n':'custom\\n',{mode:0o600});
fs.writeFileSync(path,Buffer.alloc(1001,32),{flag:'wx',mode:0o600});
if(${Boolean(loseAfterFirstDump)}&&!args.includes('--schema-only'))fs.writeFileSync(${JSON.stringify(control)},'lost',{mode:0o600});
`;
  await writeFile(join(bin, 'psql'), psql, { flag: 'wx', mode: 0o700 });
  await writeFile(join(bin, 'pg_dump'), dump, { flag: 'wx', mode: 0o700 });
  return { bin, control, log };
}

test('capture refuses successful completion after snapshot loss between phases', async t => {
  const root = await mkdtemp(join(tmpdir(), 'eco-capture-liveness-test-'));
  try {
    await t.test('loss after first dump stops the second dump and removes incomplete output', async () => {
      const work = join(root, 'after-first'); await mkdir(work, { mode: 0o700 });
      const runtime = await fakeCaptureBin(work, true), outputDir = join(work, 'capture'); let storageCalls = 0;
      await assert.rejects(capturePostgres({ bin: runtime.bin, connection: base(), expectedProjectRef: projectRef, outputDir,
        captureObjects: async () => { storageCalls++; return { objectCount: 0, objects: [], totalBytes: 0 }; } }), /Original PostgreSQL snapshot is no longer active/);
      assert.equal(await readFile(runtime.log, 'utf8'), 'custom\n'); assert.equal(storageCalls, 0); assert.equal(await exists(outputDir), false);
    });
    await t.test('loss while Storage is copied invalidates the whole set', async () => {
      const work = join(root, 'after-storage'); await mkdir(work, { mode: 0o700 });
      const runtime = await fakeCaptureBin(work, false), outputDir = join(work, 'capture');
      await assert.rejects(capturePostgres({ bin: runtime.bin, connection: base(), expectedProjectRef: projectRef, outputDir,
        captureObjects: async () => { await writeFile(runtime.control, 'lost', { mode: 0o600 }); return { objectCount: 0, objects: [], totalBytes: 0 }; } }), /Original PostgreSQL snapshot is no longer active/);
      assert.equal(await readFile(runtime.log, 'utf8'), 'custom\nschema\n'); assert.equal(await exists(outputDir), false);
    });
    await t.test('unchanged keeper permits both dumps and a complete inventory', async () => {
      const work = join(root, 'intact'); await mkdir(work, { mode: 0o700 });
      const runtime = await fakeCaptureBin(work, false), outputDir = join(work, 'capture');
      const result = await capturePostgres({ bin: runtime.bin, connection: base(), expectedProjectRef: projectRef, outputDir,
        captureObjects: async () => ({ objectCount: 0, objects: [], totalBytes: 0 }) });
      assert.equal(result.source.isolation, 'repeatable read'); assert.equal(result.source.snapshot_view, '100:200:');
      assert.equal(await readFile(runtime.log, 'utf8'), 'custom\nschema\n'); assert.equal(await exists(join(outputDir, 'database-inventory.json')), true);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('capture enforces dedicated source role in returned database identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eco-capture-reader-test-'));
  try {
    for (const sourceRole of ['eco_backup_reader', 'postgres']) {
      const work = join(root, sourceRole); await mkdir(work, { mode: 0o700 });
      const runtime = await fakeCaptureBin(work, false, sourceRole), outputDir = join(work, 'capture');
      const capture = capturePostgres({ bin: runtime.bin, connection: { ...base(), PGUSER: 'eco_backup_reader' },
        expectedProjectRef: projectRef, expectedSourceRole: 'eco_backup_reader', outputDir,
        captureObjects: async () => ({ objectCount: 0, objects: [], totalBytes: 0 }) });
      if (sourceRole === 'eco_backup_reader') assert.equal((await capture).source.role, 'eco_backup_reader');
      else { await assert.rejects(capture, /Unexpected database identity|isolated read-only/); assert.equal(await exists(outputDir), false); assert.equal(await exists(runtime.log), false); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('native PostgreSQL keeper and readonly role boundaries are enforced', async () => {
  const bin = process.env.ECO_NATIVE_PG_BIN || '/usr/lib/postgresql/17/bin';
  const root = await mkdtemp(join(tmpdir(), 'enk-')), data = join(root, 'd'), socket = join(root, 's');
  const env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
  let started = false, keeper, writer, reader;
  const command = (name, args) => execFileSync(join(bin, name), args, { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  try {
    await mkdir(socket, { mode: 0o700 });
    command('initdb', ['-D', data, '-U', 'postgres', '--no-locale', '--encoding=UTF8', '--auth-local=trust', '--auth-host=reject', '--no-instructions']);
    command('pg_ctl', ['-D', data, '-l', join(root, 'startup.log'), '-o', `-k ${socket} -c listen_addresses=''`, '-w', 'start']); started = true;
    const connection = { PGHOST: socket, PGPORT: '5432', PGUSER: 'postgres', PGDATABASE: 'postgres', PGSSLMODE: 'disable' };
    keeper = new SqlSession({ bin, connection }); writer = new SqlSession({ bin, connection });
    await keeper.query('CREATE TABLE snapshot_fixture(n integer); BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;');
    const [original] = await keeper.rows("SELECT pg_backend_pid() AS backend_pid,transaction_timestamp() AS snapshot_time,current_setting('transaction_read_only') AS read_only,current_setting('transaction_isolation') AS isolation,pg_current_snapshot()::text AS snapshot_view,pg_export_snapshot() AS snapshot");
    await assertSnapshotAlive(keeper, original);
    await writer.query('INSERT INTO snapshot_fixture VALUES(1);');
    assert.deepEqual(await keeper.rows('SELECT count(*)::int AS rows FROM snapshot_fixture'), [{ rows: 0 }]);
    assert.deepEqual(await writer.rows('SELECT count(*)::int AS rows FROM snapshot_fixture'), [{ rows: 1 }]);
    await assertSnapshotAlive(keeper, original);
    await keeper.query('ROLLBACK;');
    await assert.rejects(assertSnapshotAlive(keeper, original), /Original PostgreSQL snapshot is no longer active/);
    await writer.query("CREATE ROLE eco_backup_reader LOGIN INHERIT BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION; GRANT pg_read_all_data TO eco_backup_reader WITH ADMIN FALSE, INHERIT TRUE, SET FALSE; ALTER ROLE eco_backup_reader SET default_transaction_read_only=on;");
    reader = new SqlSession({ bin, connection: { ...connection, PGUSER: 'eco_backup_reader' } });
    await assertReadOnlySourceRole(reader, 'eco_backup_reader');
    assert.deepEqual(await reader.rows('SELECT count(subdbid)::int AS total FROM pg_subscription'), [{total:0}]);
    // Test privileges, never password/catalog values: the approved contract is explicitly broad read.
    assert.deepEqual(await reader.rows("SELECT has_any_column_privilege(current_user,'pg_catalog.pg_authid','SELECT') AS auth_catalog,has_column_privilege(current_user,'pg_catalog.pg_subscription','subconninfo','SELECT') AS subscription_catalog"), [{auth_catalog:true,subscription_catalog:true}]);
    await writer.query('GRANT pg_read_all_data TO eco_backup_reader WITH SET TRUE;');
    await assert.rejects(assertReadOnlySourceRole(reader, 'eco_backup_reader'), /isolated read-only/);
    await writer.query('GRANT pg_read_all_data TO eco_backup_reader WITH SET FALSE;');
    await assertReadOnlySourceRole(reader, 'eco_backup_reader');
    await writer.query('GRANT INSERT ON snapshot_fixture TO PUBLIC;');
    await assert.rejects(assertReadOnlySourceRole(reader, 'eco_backup_reader'), /isolated read-only/);
    await writer.query('REVOKE INSERT ON snapshot_fixture FROM PUBLIC; CREATE FUNCTION public.synthetic_definer() RETURNS integer LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;');
    await assert.rejects(assertReadOnlySourceRole(reader, 'eco_backup_reader'), /isolated read-only/);
    await writer.query('REVOKE ALL ON FUNCTION public.synthetic_definer() FROM PUBLIC;');
    await assertReadOnlySourceRole(reader, 'eco_backup_reader');
    await writer.query('GRANT pg_write_all_data TO eco_backup_reader;');
    await assert.rejects(assertReadOnlySourceRole(reader, 'eco_backup_reader'), /isolated read-only/);
    await writer.query('REVOKE pg_write_all_data FROM eco_backup_reader;');
    await assertReadOnlySourceRole(reader, 'eco_backup_reader');
  } finally {
    await Promise.allSettled([keeper, writer, reader].filter(Boolean).map(session => session.close()));
    try { if (started) command('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
});
