import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

export const RESTORE_CHECK = 'DATABASE_AND_DOCUMENT_INTEGRITY_ONLY';
export const RESTORE_SCHEMAS = Object.freeze(['public', 'eco_private', 'auth', 'storage', 'supabase_migrations']);
const SCHEMA_SQL = RESTORE_SCHEMAS.map(s => `'${s}'`).join(',');
const SAFE_EXTENSIONS = new Set(['plpgsql', 'pgcrypto', 'uuid-ossp', 'citext', 'pg_trgm', 'btree_gist',
  'btree_gin', 'unaccent', 'ltree', 'hstore', 'intarray', 'fuzzystrmatch']);
const BASE_ENV = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' };
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const ADMIN = 'eco_restore_admin';
const DATABASE = 'eco_restore';
const ident = value => '"' + value.replaceAll('"', '""') + '"';
const literal = value => "'" + value.replaceAll("'", "''") + "'";
export class LocalRestoreError extends Error {
  constructor(code, receiptPath) { super(`Local restore verification failed (${code}).`); this.name = 'LocalRestoreError'; this.code = code; if (receiptPath) this.receiptPath = receiptPath; }
}
const fail = code => { throw new LocalRestoreError(code); };
const check = (condition, code) => { if (!condition) fail(code); };
const validName = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 63 && !/[\u0000-\u001f\u007f]/u.test(value);

async function privateRegular(path) {
  const info = await lstat(path);
  check(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && !(info.mode & 0o077), 'UNSAFE_CAPTURE_FILE');
  return info;
}
async function privateDirectory(path) {
  const info = await lstat(path);
  check(info.isDirectory() && !info.isSymbolicLink() && !(info.mode & 0o077), 'UNSAFE_DIRECTORY');
  return realpath(path);
}
async function hashFile(path) {
  await privateRegular(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash('sha256'); let size = 0;
  try {
    const before = await handle.stat();
    for await (const bytes of handle.createReadStream({ autoClose: false })) { size += bytes.length; hash.update(bytes); }
    const after = await handle.stat();
    check(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && size === before.size, 'CAPTURE_FILE_CHANGED');
    return { size, sha256: hash.digest('hex') };
  } finally { await handle.close(); }
}

// SQL and diagnostics can contain business data. Neither appears in errors or receipts.
function run(bin, name, args, { env = {}, input, timeoutMs = 120_000, maxBytes = MAX_JSON_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(join(bin, name), args, { env: { ...BASE_ENV, ...env }, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let bytes = 0, chunks = [], failure, settled = false;
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(() => { failure = new LocalRestoreError('LOCAL_COMMAND_TIMEOUT'); kill(); }, timeoutMs);
    child.stderr.on('data', () => {});
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) { failure = new LocalRestoreError('LOCAL_OUTPUT_LIMIT'); kill(); }
      else chunks.push(chunk);
    });
    child.stdin.on('error', () => {});
    child.once('error', () => { failure = new LocalRestoreError('LOCAL_COMMAND_START_FAILED'); });
    child.once('close', code => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (failure || code !== 0) reject(failure || new LocalRestoreError(`LOCAL_${name.toUpperCase()}_FAILED`));
      else resolve(Buffer.concat(chunks).toString('utf8'));
      chunks = [];
    });
    child.stdin.end(input);
  });
}

async function sql(bin, env, text) {
  return run(bin, 'psql', ['-X', '-qAt', '--no-password', '-v', 'ON_ERROR_STOP=1'], { env, input: text });
}
async function rows(bin, env, select) {
  const result = await sql(bin, env, `SELECT coalesce(json_agg(q),'[]'::json) FROM (${select}) q;`);
  try { return JSON.parse(result); } catch { fail('INVALID_LOCAL_METADATA'); }
}

function startPostgres(bin, data) {
  const child = spawn(join(bin, 'postgres'), ['-D', data], { env: BASE_ENV, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const state = { child, ended: false, error: false };
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  child.once('error', () => { state.error = true; });
  state.closed = new Promise(resolve => child.once('close', () => { state.ended = true; resolve(); }));
  return state;
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function stopPostgres(state) {
  if (!state) return;
  const signal = name => { try { process.kill(-state.child.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  if (!state.ended) {
    signal('SIGINT');
    const awaitClose = () => new Promise(resolve => {
      const timer = setTimeout(resolve, 5_000);
      state.closed.then(() => { clearTimeout(timer); resolve(); });
    });
    await awaitClose();
    if (!state.ended) { signal('SIGKILL'); await awaitClose(); }
    check(state.ended, 'LOCAL_CLUSTER_STOP_FAILED');
  }
  // A postmaster crash must not leave backend children behind.
  signal('SIGKILL');
}

function validateInventory(value) {
  check(value && value.schemaVersion === 1 && Array.isArray(value.tables) && Array.isArray(value.roles)
    && Array.isArray(value.extensions) && Array.isArray(value.functions) && Array.isArray(value.triggers)
    && Array.isArray(value.policies) && Array.isArray(value.memberships), 'INVALID_CAPTURE_INVENTORY');
  check(value.source && /^17\.11(?:\D|$)/u.test(value.source.server_version), 'SOURCE_VERSION_UNSUPPORTED');
  check(value.roles.every(role => validName(role.rolname) && role.rolname !== ADMIN), 'INVALID_ROLE_INVENTORY');
  const roleNames = value.roles.map(role => role.rolname);
  check(new Set(roleNames).size === roleNames.length && roleNames.includes('postgres'), 'INVALID_ROLE_INVENTORY');
  const keys = new Set();
  for (const table of value.tables) {
    check(RESTORE_SCHEMAS.includes(table.schema) && validName(table.name) && /^\d+$/u.test(String(table.rows))
      && typeof table.rls === 'boolean' && typeof table.force_rls === 'boolean', 'INVALID_TABLE_INVENTORY');
    const key = JSON.stringify([table.schema, table.name]); check(!keys.has(key), 'DUPLICATE_TABLE_INVENTORY'); keys.add(key);
  }
  for (const extension of value.extensions) check(validName(extension.extname) && validName(extension.schema)
    && typeof extension.extversion === 'string' && /^[0-9A-Za-z._-]+$/u.test(extension.extversion), 'INVALID_EXTENSION_INVENTORY');
  for (const membership of value.memberships) check(roleNames.includes(membership.role) && roleNames.includes(membership.member), 'INVALID_MEMBERSHIP');
  return value;
}

async function verifyStorage(capture, inventory) {
  const storage = inventory.storage;
  check(storage && Array.isArray(storage.objects) && storage.objectCount === storage.objects.length
    && Number.isSafeInteger(storage.totalBytes) && storage.totalBytes >= 0, 'INVALID_STORAGE_INVENTORY');
  const directory = await privateDirectory(join(capture, 'storage'));
  await privateDirectory(join(directory, 'objects'));
  const paths = new Set(); let totalBytes = 0;
  for (const object of storage.objects) {
    check(/^objects\/[a-f0-9]{64}\.bin$/u.test(object.path) && !paths.has(object.path)
      && Number.isSafeInteger(object.size) && object.size >= 0 && /^[a-f0-9]{64}$/u.test(object.sha256), 'INVALID_STORAGE_ENTRY');
    paths.add(object.path);
    const actual = await hashFile(join(directory, object.path));
    check(actual.size === object.size && actual.sha256 === object.sha256, 'STORAGE_INTEGRITY_MISMATCH');
    totalBytes += actual.size;
  }
  const actualNames = (await readdir(join(directory, 'objects'))).map(name => `objects/${name}`).sort();
  check(JSON.stringify(actualNames) === JSON.stringify([...paths].sort()), 'STORAGE_FILE_SET_MISMATCH');
  check(totalBytes === storage.totalBytes, 'STORAGE_TOTAL_MISMATCH');
  return { storageObjectCount: paths.size, storageBytes: totalBytes };
}

async function prepareRoles(bin, env, inventory) {
  const existing = new Set((await rows(bin, env, 'SELECT rolname FROM pg_roles')).map(row => row.rolname));
  const statements = ['BEGIN;'];
  for (const role of inventory.roles) {
    if (role.rolname.startsWith('pg_')) { check(existing.has(role.rolname), 'MISSING_BUILTIN_ROLE'); continue; }
    check(!existing.has(role.rolname), 'LOCAL_ROLE_COLLISION');
    statements.push(`CREATE ROLE ${ident(role.rolname)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION ${role.rolinherit ? 'INHERIT' : 'NOINHERIT'} ${role.rolbypassrls ? 'BYPASSRLS' : 'NOBYPASSRLS'};`);
  }
  // Privileged global memberships are deliberately not granted to this integrity-check cluster.
  // Preserve ordinary application memberships used by policies, including INHERIT/SET behavior.
  let excludedMemberships = 0;
  for (const membership of inventory.memberships) {
    if (membership.role.startsWith('pg_') || membership.member.startsWith('pg_')) { excludedMemberships++; continue; }
    statements.push(`GRANT ${ident(membership.role)} TO ${ident(membership.member)} WITH ADMIN ${membership.admin_option ? 'TRUE' : 'FALSE'}, INHERIT ${membership.inherit_option ? 'TRUE' : 'FALSE'}, SET ${membership.set_option ? 'TRUE' : 'FALSE'};`);
  }
  statements.push('COMMIT;'); await sql(bin, env, statements.join('\n'));
  return excludedMemberships;
}

async function prepareExtensions(bin, env, inventory) {
  const available = new Set((await rows(bin, env, 'SELECT name FROM pg_available_extensions')).map(row => row.name));
  const installed = [], excluded = [];
  for (const extension of inventory.extensions) {
    if (!SAFE_EXTENSIONS.has(extension.extname)) { excluded.push(extension.extname); continue; }
    check(available.has(extension.extname), 'REQUIRED_SAFE_EXTENSION_UNAVAILABLE');
    if (extension.extname === 'plpgsql') {
      check(extension.schema === 'pg_catalog', 'UNEXPECTED_EXTENSION_SCHEMA'); installed.push(extension.extname); continue;
    }
    // The original schema must be retained. Selected-schema extensions need a separate schema-TOC plan.
    check(!RESTORE_SCHEMAS.includes(extension.schema) && extension.schema !== 'pg_catalog', 'SELECTED_SCHEMA_EXTENSION_REQUIRES_PLAN');
    await sql(bin, env, `CREATE SCHEMA IF NOT EXISTS ${ident(extension.schema)}; CREATE EXTENSION ${ident(extension.extname)} WITH SCHEMA ${ident(extension.schema)} VERSION ${literal(extension.extversion)};`);
    installed.push(extension.extname);
  }
  return { installedExtensions: installed, excludedExtensions: excluded };
}

async function compareDatabase(bin, env, inventory) {
  const tables = await rows(bin, env, `SELECT n.nspname AS schema,c.relname AS name,c.relrowsecurity AS rls,c.relforcerowsecurity AS force_rls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname IN (${SCHEMA_SQL}) ORDER BY n.nspname,c.relname`);
  check(tables.length === inventory.tables.length, 'TABLE_SET_MISMATCH');
  const expected = new Map(inventory.tables.map(table => [JSON.stringify([table.schema, table.name]), table]));
  let totalRows = 0n;
  for (const table of tables) {
    const original = expected.get(JSON.stringify([table.schema, table.name]));
    check(original && table.rls === original.rls && table.force_rls === original.force_rls, 'TABLE_SECURITY_MISMATCH');
    const [result] = await rows(bin, env, `SELECT count(*)::text AS rows FROM ${ident(table.schema)}.${ident(table.name)}`);
    check(result.rows === String(original.rows), 'TABLE_ROW_COUNT_MISMATCH'); totalRows += BigInt(result.rows);
  }
  const functions = await rows(bin, env, `SELECT n.nspname AS schema,p.proname AS name,pg_get_function_identity_arguments(p.oid) AS arguments,md5(pg_get_functiondef(p.oid)) AS definition_hash FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN (${SCHEMA_SQL}) AND p.prokind IN ('f','p') ORDER BY n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)`);
  const triggers = await rows(bin, env, `SELECT n.nspname AS schema,c.relname AS table_name,t.tgname AS name,t.tgenabled,md5(pg_get_triggerdef(t.oid)) AS definition_hash FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN (${SCHEMA_SQL}) AND NOT t.tgisinternal ORDER BY n.nspname,c.relname,t.tgname`);
  const policies = await rows(bin, env, `SELECT schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname IN (${SCHEMA_SQL}) ORDER BY schemaname,tablename,policyname`);
  const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  check(stable(functions) === stable(inventory.functions), 'FUNCTION_DEFINITION_MISMATCH');
  check(stable(triggers) === stable(inventory.triggers), 'TRIGGER_DEFINITION_MISMATCH');
  const normalizePolicies = values => values.map(value => ({ ...value, roles: [...value.roles].sort() }));
  check(stable(normalizePolicies(policies)) === stable(normalizePolicies(inventory.policies)), 'POLICY_DEFINITION_MISMATCH');
  const [providerRoles] = await rows(bin, env, `SELECT count(*)::int AS count FROM pg_roles WHERE rolname <> ${literal(ADMIN)} AND rolcanlogin`);
  check(providerRoles.count === 0, 'PROVIDER_ROLE_LOGIN_ENABLED');
  return { tableCount: tables.length, totalRows: totalRows.toString(), functionCount: functions.length,
    triggerCount: triggers.length, policyCount: policies.length };
}

/** Restore a trusted, authenticated capture into a disposable local PostgreSQL 17.11 cluster.
 * No cloud connection or source credential is read. Original capture files are never changed.
 * All returned checks concern database/document integrity, not a running Supabase deployment.
 */
export async function restoreLocal({ captureDir, bin, workParent }) {
  check([captureDir, bin, workParent].every(value => typeof value === 'string' && isAbsolute(value)), 'ABSOLUTE_PATHS_REQUIRED');
  const capture = await privateDirectory(captureDir), parent = await realpath(workParent);
  check((await lstat(parent)).isDirectory(), 'INVALID_WORK_PARENT');
  const relation = relative(capture, parent); check(relation.startsWith('..') || isAbsolute(relation), 'WORK_PARENT_INSIDE_CAPTURE');
  const receiptPath = join(parent, `eco-restore-receipt-${randomUUID()}.json`);
  const receipt = { schemaVersion: 1, check: RESTORE_CHECK, status: 'FAILED', startedAt: new Date().toISOString(),
    selectedSchemas: [...RESTORE_SCHEMAS], limits: [
      'Verifies selected PostgreSQL schema definitions, row counts, RLS flags, policies, functions, triggers and captured document bytes.',
      'Does not test Supabase Auth login, API, Storage service, Realtime, hosted configuration, external integrations or full application operation.',
      'Provider login, superuser/role-management privileges, role settings and privileged builtin memberships are not recreated.',
      'Provider-managed extensions outside the safe local allowlist are excluded; their dependent selected-schema objects must still restore without errors.',
      'The cluster listens only on its private Unix socket; no network-capable extension or background scheduler is installed.',
    ] };
  let root, state, failure, cleanupFailed = false;
  try {
    const inventoryPath = join(capture, 'database-inventory.json');
    const inventoryInfo = await privateRegular(inventoryPath); check(inventoryInfo.size <= MAX_JSON_BYTES, 'INVENTORY_SIZE_LIMIT');
    let inventory; try { inventory = JSON.parse(await readFile(inventoryPath, 'utf8')); } catch { fail('INVALID_CAPTURE_INVENTORY'); }
    validateInventory(inventory);
    const dump = join(capture, 'database.dump');
    const before = await hashFile(dump);
    const magic = await open(dump, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const bytes = Buffer.alloc(5); await magic.read(bytes, 0, 5, 0); check(bytes.toString('ascii') === 'PGDMP', 'CUSTOM_ARCHIVE_REQUIRED'); }
    finally { await magic.close(); }
    Object.assign(receipt, await verifyStorage(capture, inventory));
    const version = (await run(bin, 'postgres', ['--version'])).trim();
    check(/^postgres \(PostgreSQL\) 17\.11$/u.test(version), 'LOCAL_VERSION_UNSUPPORTED');
    receipt.databaseVersion = '17.11';
    root = await mkdtemp(join(parent, '.eco-restore-')); await chmod(root, 0o700);
    const data = join(root, 'data'), socket = join(root, 's'); await mkdir(socket, { mode: 0o700 });
    check(Buffer.byteLength(join(socket, '.s.PGSQL.5432')) < 100, 'UNIX_SOCKET_PATH_TOO_LONG');
    await run(bin, 'initdb', ['-D', data, '-U', ADMIN, '--encoding=UTF8', '--locale=C', '--auth-local=trust', '--auth-host=reject', '--no-instructions']);
    await writeFile(join(data, 'pg_hba.conf'), `local all ${ADMIN} trust\nlocal all all reject\nhost all all 0.0.0.0/0 reject\nhost all all ::0/0 reject\n`, { mode: 0o600 });
    await writeFile(join(data, 'postgresql.auto.conf'), [
      "listen_addresses = ''", `unix_socket_directories = ${literal(socket)}`, 'unix_socket_permissions = 0700',
      'port = 5432', 'max_connections = 10', "shared_buffers = '16MB'", "shared_preload_libraries = ''",
      "session_preload_libraries = ''", "local_preload_libraries = ''", "archive_mode = 'off'",
      'max_wal_senders = 0', 'max_worker_processes = 0', 'max_parallel_workers = 0',
      "log_statement = 'none'", "log_min_messages = 'panic'", "statement_timeout = '120s'",
    ].join('\n') + '\n', { mode: 0o600 });
    state = startPostgres(bin, data);
    const env = { PGHOST: socket, PGPORT: '5432', PGUSER: ADMIN, PGDATABASE: 'postgres', PGSSLMODE: 'disable', PGCONNECT_TIMEOUT: '3' };
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      check(!state.error && !state.ended, 'LOCAL_CLUSTER_START_FAILED');
      try { await run(bin, 'pg_isready', ['--quiet', '--timeout=1'], { env, timeoutMs: 3_000 }); ready = true; break; } catch {}
      await pause(100);
    }
    check(ready, 'LOCAL_CLUSTER_START_TIMEOUT');
    const [isolation] = await rows(bin, env, "SELECT current_setting('listen_addresses') AS listen_addresses,current_setting('unix_socket_directories') AS socket,current_setting('shared_preload_libraries') AS preload");
    check(isolation.listen_addresses === '' && isolation.socket === socket && isolation.preload === '', 'LOCAL_ISOLATION_MISMATCH');
    receipt.phase = 'PREPARE_ROLES';
    receipt.excludedPrivilegedMemberships = await prepareRoles(bin, env, inventory);
    await run(bin, 'createdb', ['--no-password', '--template=template0', '--owner=postgres', DATABASE], { env });
    env.PGDATABASE = DATABASE;
    receipt.phase = 'PREPARE_EXTENSIONS';
    Object.assign(receipt, await prepareExtensions(bin, env, inventory));
    const schemaArgs = RESTORE_SCHEMAS.flatMap(schema => ['--schema', schema]);
    const selectedList = await run(bin, 'pg_restore', ['--list', ...schemaArgs, dump]);
    const completeList = await run(bin, 'pg_restore', ['--list', dump]);
    const selectedIds = new Set(selectedList.split('\n').map(line => line.match(/^(\d+);/u)?.[1]).filter(Boolean));
    const namespacePattern = new RegExp(`^\\d+;\\s+\\d+\\s+\\d+\\s+(?:SCHEMA -|ACL - SCHEMA|COMMENT - SCHEMA)\\s+(${RESTORE_SCHEMAS.join('|')})(?:\\s|$)`);
    // pg_restore -n omits the namespace definitions themselves. Include their TOC entries
    // explicitly, preserving archive order, so all selected objects restore in one transaction.
    const selectedToc = completeList.split('\n').filter(line => {
      const id = line.match(/^(\d+);/u)?.[1]; return id && (selectedIds.has(id) || namespacePattern.test(line));
    });
    check(selectedToc.length > 0, 'EMPTY_SELECTED_ARCHIVE');
    const tocFile = join(root, 'selected.toc'); await writeFile(tocFile, selectedToc.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
    // Inspect selected definitions without executing them. Native C/untrusted procedural code is outside this drill.
    receipt.phase = 'INSPECT_SELECTED_DEFINITIONS';
    const definitionSql = await run(bin, 'pg_restore', ['--schema-only', ...schemaArgs, '--file=-', dump]);
    check(!/\bLANGUAGE\s+(?:"?(?:c|plpython3u|plperlu|pltclu)"?)\b/iu.test(definitionSql), 'UNSAFE_PROCEDURAL_LANGUAGE');
    receipt.phase = 'RESTORE_SELECTED_SCHEMAS';
    await run(bin, 'pg_restore', ['--no-password', '--exit-on-error', '--single-transaction',
      '--no-publications', '--no-subscriptions', '--no-tablespaces', '--use-list', tocFile, '--dbname', DATABASE, dump], { env, timeoutMs: 10 * 60_000 });
    receipt.phase = 'COMPARE_RESTORED_DATA';
    Object.assign(receipt, await compareDatabase(bin, env, inventory));
    const after = await hashFile(dump); check(before.sha256 === after.sha256 && before.size === after.size, 'CAPTURE_FILE_CHANGED');
    Object.assign(receipt, await verifyStorage(capture, inventory));
    receipt.isolation = { privateUnixSocketOnly: true, listenAddresses: '', providerLoginsDisabled: true, networkCapableExtensionsInstalled: false };
    receipt.status = 'VERIFIED'; receipt.phase = 'COMPLETE';
  } catch (error) { failure = error instanceof LocalRestoreError ? error : new LocalRestoreError('LOCAL_RESTORE_FAILED'); receipt.error = failure.code; }
  finally {
    try { await stopPostgres(state); receipt.clusterStopped = true; } catch { cleanupFailed = true; receipt.clusterStopped = false; }
    if (root && receipt.clusterStopped) {
      try { await rm(root, { recursive: true, force: true }); receipt.restoredDataRemoved = true; }
      catch { cleanupFailed = true; receipt.restoredDataRemoved = false; }
    } else receipt.restoredDataRemoved = !root;
    if (cleanupFailed) { receipt.status = 'FAILED'; receipt.error = 'LOCAL_CLEANUP_FAILED'; failure = new LocalRestoreError('LOCAL_CLEANUP_FAILED'); }
    receipt.completedAt = new Date().toISOString();
    try { await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch { failure = new LocalRestoreError('RECEIPT_WRITE_FAILED'); }
  }
  if (failure) { const error = new LocalRestoreError(failure.code, receiptPath); error.phase = receipt.phase; throw error; }
  return { receiptPath, ...receipt };
}
