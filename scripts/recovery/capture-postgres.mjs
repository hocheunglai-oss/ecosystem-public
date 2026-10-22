import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, writeFile, stat, rm } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

const ident = value => '"' + String(value).replaceAll('"', '""') + '"';
const lit = value => "'" + String(value).replaceAll("'", "''") + "'";
const connectionKeys = new Set(['PGHOST','PGPORT','PGUSER','PGDATABASE','PGPASSWORD','PGSSLMODE','PGSSLROOTCERT']);
const processEnv = connection => ({ PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', ...Object.fromEntries(Object.entries(connection).filter(([k]) => connectionKeys.has(k))) });
export function validateConnection(connection, projectRef, expectedSourceRole = 'postgres') {
  if (Object.keys(connection).some(k => !connectionKeys.has(k))) throw new Error('Unexpected connection option');
  if (!/^[a-z]{20}$/.test(projectRef)) throw new Error('Invalid source project');
  if (typeof expectedSourceRole !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(expectedSourceRole)) throw new Error('Invalid source role');
  if (connection.PGDATABASE !== 'postgres' || connection.PGPORT !== '5432') throw new Error('Wrong database or pooler mode');
  const direct = connection.PGHOST === `db.${projectRef}.supabase.co` && connection.PGUSER === expectedSourceRole;
  const pooler = /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(connection.PGHOST) && connection.PGUSER === `${expectedSourceRole}.${projectRef}`;
  if (!direct && !pooler) throw new Error('Source project mismatch');
  if (connection.PGSSLMODE !== 'verify-full' || !isAbsolute(connection.PGSSLROOTCERT || '')) throw new Error('Verified TLS required');
  if (typeof connection.PGPASSWORD !== 'string' || !connection.PGPASSWORD) throw new Error('Missing source credential');
}

export class SqlSession {
  constructor({ bin, connection, timeoutMs = 30000 }) {
    this.timeoutMs = timeoutMs;
    this.child = spawn(join(bin, 'psql'), ['-X', '-qAt', '--no-password', '-v', 'ON_ERROR_STOP=1'], {
      env: processEnv(connection), stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.pending = null; this.ended = false;
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
    this.child.stdin.on('error', () => this.fail('PostgreSQL input closed'));
    // The provider can put queries, identifiers or credentials in errors. Never emit its stderr.
    this.child.stderr.on('data', () => {});
    createInterface({ input: this.child.stdout }).on('line', line => {
      const p = this.pending; if (!p) return;
      if (line === p.end) { clearTimeout(p.timer); this.pending = null; p.resolve(p.lines.join('\n')); }
      else { p.bytes += Buffer.byteLength(line); if (p.bytes > 32 * 1024 * 1024) { this.fail('PostgreSQL metadata exceeded limit'); this.child.kill('SIGKILL'); } else p.lines.push(line); }
    });
    this.child.on('error', () => this.fail('PostgreSQL process could not start'));
    this.child.on('close', code => { this.ended = true; this.fail(`PostgreSQL session ended (${code})`); this.resolveClosed(); });
  }
  fail(message) {
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new Error(message)); this.pending = null; }
  }
  query(sql) {
    if (this.pending || this.ended) throw new Error('PostgreSQL session unavailable');
    return new Promise((resolve, reject) => {
      const end = 'ECO_END_' + randomUUID().replaceAll('-', '');
      const timer = setTimeout(() => { this.fail('PostgreSQL query timed out'); this.child.kill('SIGKILL'); }, this.timeoutMs);
      this.pending = { resolve, reject, end, lines: [], bytes: 0, timer };
      this.child.stdin.write(`${sql}\n\\echo ${end}\n`);
    });
  }
  async rows(select) { const value = await this.query(`SELECT coalesce(json_agg(t),'[]'::json) FROM (${select}) t;`); try { return JSON.parse(value); } catch { throw new Error('Invalid PostgreSQL metadata response'); } }
  async close() {
    if (this.ended) return;
    this.fail('PostgreSQL session closing');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 3000);
    this.child.stdin.end('ROLLBACK;\n\\q\n');
    await this.closed;
    clearTimeout(timer);
  }
}

/** Approved full-project read contract: auth and password-catalog SELECT are included.
 * These checks inspect privileges only; password hashes/connection strings are never queried here.
 */
export async function assertReadOnlySourceRole(session, expectedSourceRole) {
  if (expectedSourceRole !== 'eco_backup_reader') throw new Error('Invalid full-read source role');
  const rows = await session.rows(`WITH RECURSIVE memberships AS (
    SELECT a.roleid,a.admin_option,a.inherit_option,a.set_option FROM pg_auth_members a WHERE a.member=(SELECT oid FROM pg_roles WHERE rolname=current_user)
    UNION SELECT a.roleid,a.admin_option,a.inherit_option,a.set_option FROM pg_auth_members a JOIN memberships m ON a.member=m.roleid
  ) SELECT r.rolname,r.rolsuper,r.rolcreaterole,r.rolcreatedb,r.rolreplication,r.rolbypassrls,r.rolcanlogin,r.rolinherit,
    current_setting('default_transaction_read_only') AS default_read_only,
    (SELECT coalesce(json_agg(json_build_object('role',mrole.rolname,'admin',m.admin_option,'inherit',m.inherit_option,'set',m.set_option) ORDER BY mrole.rolname),'[]'::json) FROM memberships m JOIN pg_roles mrole ON mrole.oid=m.roleid) AS memberships,
    has_database_privilege(current_user,current_database(),'CREATE') AS database_create,
    has_any_column_privilege(current_user,'pg_catalog.pg_authid','SELECT') AS password_catalog_read,
    has_any_column_privilege(current_user,'pg_catalog.pg_shadow','SELECT') AS password_view_read,
    has_column_privilege(current_user,'pg_catalog.pg_subscription','subconninfo','SELECT') AS subscription_secret_read,
    has_column_privilege(current_user,'pg_catalog.pg_subscription','subdbid','SELECT') AS subscription_metadata_read,
    (SELECT count(*)::int FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND NOT has_schema_privilege(current_user,n.oid,'USAGE')) AS missing_schema_reads,
    (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND CASE WHEN c.relkind IN ('r','p','m') THEN NOT has_table_privilege(current_user,c.oid,'SELECT') ELSE false END) AS missing_table_reads,
    (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND CASE WHEN c.relkind='S' THEN NOT has_sequence_privilege(current_user,c.oid,'SELECT') ELSE false END) AS missing_sequence_reads,
    ((SELECT count(*) FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND has_schema_privilege(current_user,n.oid,'USAGE WITH GRANT OPTION'))
      +(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND CASE WHEN c.relkind IN ('r','p','v','m','f') THEN has_table_privilege(current_user,c.oid,'SELECT WITH GRANT OPTION') ELSE false END)
      +(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND CASE WHEN c.relkind='S' THEN has_sequence_privilege(current_user,c.oid,'SELECT WITH GRANT OPTION') ELSE false END))::int AS read_grant_options,
    (SELECT count(*)::int FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND has_schema_privilege(current_user,n.oid,'CREATE')) AS schema_create,
    (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_temp_%' AND n.nspname NOT LIKE 'pg_toast_temp_%' AND c.oid <> 'pg_catalog.pg_settings'::regclass AND CASE WHEN c.relkind IN ('r','p','v','m','f') THEN has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') ELSE false END) AS table_writes,
    (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND CASE WHEN c.relkind='S' THEN has_sequence_privilege(current_user,c.oid,'USAGE,UPDATE') ELSE false END) AS sequence_writes,
    (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND p.prosecdef AND has_function_privilege(current_user,p.oid,'EXECUTE')) AS app_definers,
    ((SELECT count(*) FROM pg_class WHERE relowner=r.oid)+(SELECT count(*) FROM pg_namespace WHERE nspowner=r.oid)+(SELECT count(*) FROM pg_proc WHERE proowner=r.oid)+(SELECT count(*) FROM pg_type WHERE typowner=r.oid)+(SELECT count(*) FROM pg_database WHERE datdba=r.oid)+(SELECT count(*) FROM pg_extension WHERE extowner=r.oid))::int AS owned_objects
    FROM pg_roles r WHERE r.rolname=current_user`);
  const role = rows.length === 1 ? rows[0] : null;
  if (!role || role.rolname !== expectedSourceRole || role.rolsuper !== false || role.rolcreaterole !== false
    || role.rolcreatedb !== false || role.rolreplication !== false || role.rolbypassrls !== true
    || role.rolcanlogin !== true || role.rolinherit !== true || role.default_read_only !== 'on'
    || role.database_create !== false
    || role.subscription_metadata_read !== true
    || ['schema_create','table_writes','sequence_writes','app_definers','owned_objects','missing_schema_reads','missing_table_reads','missing_sequence_reads','read_grant_options'].some(key => role[key] !== 0)
    || !Array.isArray(role.memberships) || role.memberships.length !== 1 || role.memberships[0].role !== 'pg_read_all_data'
    || role.memberships[0].admin !== false || role.memberships[0].inherit !== true || role.memberships[0].set !== false) {
    throw new Error('Source role is not an isolated read-only backup role');
  }
}

/** Assert the original snapshot keeper survived; never reconnect or export a replacement. */
export async function assertSnapshotAlive(session, original) {
  const validSource = original && Number.isSafeInteger(original.backend_pid) && original.backend_pid > 0
    && typeof original.snapshot_time === 'string' && typeof original.snapshot_view === 'string'
    && /^\d+:\d+:(?:\d+(?:,\d+)*)?$/.test(original.snapshot_view)
    && original.read_only === 'on' && original.isolation === 'repeatable read';
  if (!validSource || session.ended) throw new Error('Original PostgreSQL snapshot is no longer active');
  const values = await session.rows("SELECT pg_backend_pid() AS backend_pid,transaction_timestamp() AS snapshot_time,current_setting('transaction_read_only') AS read_only,current_setting('transaction_isolation') AS isolation,pg_current_snapshot()::text AS snapshot_view");
  const current = values.length === 1 ? values[0] : null;
  if (!current || ['backend_pid','snapshot_time','read_only','isolation','snapshot_view'].some(key => current[key] !== original[key])) {
    throw new Error('Original PostgreSQL snapshot is no longer active');
  }
}

async function command(bin, name, args, connection) {
  return new Promise((resolve, reject) => {
    const child = spawn(join(bin, name), args, { env: processEnv(connection), stdio: ['ignore', 'ignore', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20 * 60 * 1000);
    child.stderr.on('data', () => {});
    child.once('error', () => { clearTimeout(timer); reject(new Error(`${name} failed to start`)); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${name} failed (${code}); no complete backup written`)); });
  });
}

export async function capturePostgres({ bin, connection, expectedProjectRef, expectedSourceRole = 'postgres', supplierReportsBucket = 'eco-supplier-reports', profileAttachmentsBucket, outputDir, captureObjects }) {
  validateConnection(connection, expectedProjectRef, expectedSourceRole);
  if (typeof supplierReportsBucket !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(supplierReportsBucket)) throw new Error('Invalid reports bucket');
  if (!isAbsolute(bin) || !isAbsolute(outputDir)) throw new Error('Absolute private paths required');
  process.umask(0o077);
  await mkdir(outputDir, { mode: 0o700 });
  const session = new SqlSession({ bin, connection });
  let complete = false;
  try {
    if (expectedSourceRole !== 'postgres') await assertReadOnlySourceRole(session, expectedSourceRole);
    const locked = await session.rows(`SELECT pg_try_advisory_lock(hashtextextended(${lit('eco-recovery:' + expectedProjectRef)},0)) AS acquired`);
    if (!locked[0]?.acquired) throw new Error('Another ECO recovery capture is running');
    await session.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='120s'; SET LOCAL idle_in_transaction_session_timeout='25min'; SET LOCAL row_security=off;");
    const [source] = await session.rows("SELECT current_database() AS database,current_user AS role,current_setting('server_version') AS server_version,current_setting('transaction_read_only') AS read_only,current_setting('transaction_isolation') AS isolation,transaction_timestamp() AS snapshot_time,pg_export_snapshot() AS snapshot,pg_backend_pid() AS backend_pid,pg_current_snapshot()::text AS snapshot_view");
    if (source.database !== 'postgres' || source.role !== expectedSourceRole || source.read_only !== 'on' || source.isolation !== 'repeatable read' || !/^17\./.test(source.server_version) || !/^[0-9A-F-]+$/.test(source.snapshot)) throw new Error('Unexpected database identity or snapshot');
    const schemas = await session.rows("SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema' ORDER BY nspname");
    const extensions = await session.rows('SELECT e.extname,e.extversion,n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace ORDER BY e.extname');
    const tables = await session.rows("SELECT n.nspname AS schema, c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname IN ('public','eco_private','auth','storage','supabase_migrations') ORDER BY n.nspname,c.relname");
    for (const table of tables) {
      const [r] = await session.rows(`SELECT count(*)::text AS rows FROM ${ident(table.schema)}.${ident(table.name)}`);
      table.rows = r.rows;
    }
    const roles = await session.rows('SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls, rolconfig FROM pg_roles ORDER BY rolname');
    const memberships = await session.rows('SELECT r.rolname AS role, m.rolname AS member, a.admin_option, a.inherit_option, a.set_option FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member ORDER BY r.rolname,m.rolname');
    const functions = await session.rows("SELECT n.nspname AS schema,p.proname AS name,pg_get_function_identity_arguments(p.oid) AS arguments,md5(pg_get_functiondef(p.oid)) AS definition_hash FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','eco_private','auth','storage','supabase_migrations') AND p.prokind IN ('f','p') ORDER BY n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)");
    const triggers = await session.rows("SELECT n.nspname AS schema,c.relname AS table_name,t.tgname AS name,t.tgenabled,md5(pg_get_triggerdef(t.oid)) AS definition_hash FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','eco_private','auth','storage','supabase_migrations') AND NOT t.tgisinternal ORDER BY n.nspname,c.relname,t.tgname");
    const policies = await session.rows("SELECT schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname IN ('public','eco_private','auth','storage','supabase_migrations') ORDER BY schemaname,tablename,policyname");
    const migrationHistory = await session.rows('SELECT version,name FROM supabase_migrations.schema_migrations ORDER BY version');
    const objects = await session.rows('SELECT id,bucket_id,name,metadata,updated_at,version FROM storage.objects ORDER BY bucket_id,name');
    const buckets = await session.rows('SELECT * FROM storage.buckets ORDER BY id');
    const reports = await session.rows('SELECT object_path,sha256,size_bytes FROM eco_private.supplier_reports ORDER BY object_path');
    const attachments = profileAttachmentsBucket ? await session.rows('SELECT object_path,state,sha256,size_bytes,expected_mime,storage_object_id,storage_version FROM eco_private.profile_attachment_uploads ORDER BY object_path') : [];
    validateAttachmentInventory(objects, attachments, profileAttachmentsBucket);
    const [safety] = await session.rows("SELECT (SELECT count(*) FROM vault.secrets)::int AS vault_secrets, (SELECT count(subdbid) FROM pg_subscription)::int AS subscriptions");
    if (safety.vault_secrets || safety.subscriptions) throw new Error('Recovery requires an explicit Vault/subscription procedure');
    for (const report of reports) {
      const object = objects.find(o => o.bucket_id === supplierReportsBucket && o.name === report.object_path);
      if (!object || Number(object.metadata?.size) !== Number(report.size_bytes)) throw new Error('Referenced report missing from Storage snapshot');
      object.expectedSha256 = report.sha256;
    }
    await assertSnapshotAlive(session, source);
    await command(bin, 'pg_dump', ['--no-password', '--format=custom', '--compress=0', '--snapshot=' + source.snapshot, '--file=' + join(outputDir, 'database.dump')], connection);
    if ((await stat(join(outputDir, 'database.dump'))).size < 1000) throw new Error('Database archive unexpectedly empty');
    // Capture all schema definitions separately, including managed-schema customizations.
    await assertSnapshotAlive(session, source);
    await command(bin, 'pg_dump', ['--no-password', '--schema-only', '--snapshot=' + source.snapshot, '--file=' + join(outputDir, 'schema.sql')], connection);
    await assertSnapshotAlive(session, source);
    const storage = await captureObjects(objects, join(outputDir, 'storage'));
    await assertSnapshotAlive(session, source);
    // Snapshot describes the intended set. Re-read current metadata separately to detect mid-copy mutation.
    const current = new SqlSession({ bin, connection });
    try {
      const latest = await current.rows('SELECT id,bucket_id,name,metadata,updated_at,version FROM storage.objects ORDER BY bucket_id,name');
      if (JSON.stringify(latest) !== JSON.stringify(objects.map(({expectedSha256, attachmentState, ...o}) => o))) throw new Error('Storage changed during capture; retry the complete set');
    } finally { await current.close(); }
    const inventory = { schemaVersion: 1, sourceProjectRef: expectedProjectRef, source, schemas, extensions, roles, memberships, tables, functions, triggers, policies, migrationHistory, buckets, storage, safety, attachmentUploads: attachments, attachmentBucket: profileAttachmentsBucket };
    await writeFile(join(outputDir, 'database-inventory.json'), JSON.stringify(inventory, null, 2), { flag: 'wx', mode: 0o600 });
    await assertSnapshotAlive(session, source);
    complete = true;
    return inventory;
  } finally {
    try { await session.close(); } finally { if (!complete) await rm(outputDir, { recursive: true, force: true }); }
  }
}

/** Validate known pending bytes and every active reference against the same DB snapshot. */
export function validateAttachmentInventory(objects, uploads, bucket) {
  if (!bucket) return;
  if (typeof bucket !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(bucket)) throw Error('Invalid attachments bucket');
  const byPath = new Map();
  for (const upload of uploads) {
    if (byPath.has(upload.object_path) || !['pending','active'].includes(upload.state)) throw Error('Attachment inventory invalid');
    byPath.set(upload.object_path,upload);
    const object=objects.find(o=>o.bucket_id===bucket && o.name===upload.object_path);
    if (upload.state === 'active' && (!object || object.id !== upload.storage_object_id || object.version !== upload.storage_version
      || Number(object.metadata?.size) !== Number(upload.size_bytes) || object.metadata?.mimetype !== upload.expected_mime
      || !/^[a-f0-9]{64}$/.test(upload.sha256))) throw Error('Published attachment missing or changed');
    if (object) { object.attachmentState=upload.state; if (upload.state==='active') object.expectedSha256=upload.sha256; }
  }
  for (const object of objects) if (object.bucket_id===bucket && !byPath.has(object.name)) throw Error('Unrecognized attachment object');
}
