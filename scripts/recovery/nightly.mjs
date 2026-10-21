/** ECO nightly recovery worker. Only the supervisor is a supported production entrypoint. */
import { constants, createReadStream } from 'node:fs';
import { open, lstat, realpath, readdir, mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { capturePostgres, validateConnection, SqlSession, assertReadOnlySourceRole } from './capture-postgres.mjs';
import { sealDirectory, MANIFEST_NAME, validateRelativePath, validateManifest } from './archive.mjs';
import { createDriveBackupClient, hongKongNight } from './drive-backups.mjs';

const fail = code => { throw new NightlyError(code); };
const check = (value, code) => { if (!value) fail(code); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const MAX_RUNTIME_BYTES = 64 * 1024;
const MAX_DURATION_MS = 45 * 60_000;
const PRIVATE_MARKER = 'AGE-SECRET-KEY-1';
const DIAGNOSTIC_PREFIX = 'ECO_BACKUP_DIAGNOSTIC ';
const DIAGNOSTIC_PHASES = new Set(['CONFIGURATION','RUN_LOCK','DRIVE_TARGET','DATABASE_CAPTURE','STORAGE','ENCRYPTION','DRIVE_UPLOAD','RETENTION','CLEANUP','WORKER']);
const DIAGNOSTIC_CODES = new Set(['STARTED','COMPLETED','FAILED','TIMEOUT','CANCELLED','CLEANUP_FAILED','AUTHORIZATION_FAILED','OIDC_TOKEN_INVALID','SOURCE_LOCK_LOST','CHECKSUM_MISMATCH']);

/** Rebuild exactly three allowlisted scalar fields; never serialize an exception. */
export function safeDiagnostic(value) {
  try {
    if (!exact(value,['phase','code','elapsedSeconds']) || !DIAGNOSTIC_PHASES.has(value.phase)
      || !DIAGNOSTIC_CODES.has(value.code) || !Number.isSafeInteger(value.elapsedSeconds)
      || value.elapsedSeconds < 0 || value.elapsedSeconds > MAX_DURATION_MS / 1000) return null;
    return { phase:value.phase, code:value.code, elapsedSeconds:value.elapsedSeconds };
  } catch { return null; }
}
export function diagnosticLine(value) {
  const safe = safeDiagnostic(value); return safe ? DIAGNOSTIC_PREFIX + JSON.stringify(safe) + '\n' : null;
}
export function publicDiagnostic(value) {
  const safe = safeDiagnostic(value);
  return safe ? `ECO backup phase=${safe.phase} code=${safe.code} elapsed=${safe.elapsedSeconds}s.` : null;
}
/** Bounded parser for untrusted subprocess stderr. Invalid/noisy text is discarded. */
export function diagnosticReader(onDiagnostic = () => {}) {
  let pending = '', dropping = false, total = 0;
  return bytes => {
    total += bytes.length; if (total > 16 * 1024) { pending = ''; return; }
    for (const part of bytes.toString('utf8').split(/(?<=\n)/u)) {
      if (!dropping) { pending += part; if (pending.length > 512) { pending = ''; dropping = true; } }
      if (!part.endsWith('\n')) continue;
      if (!dropping && pending.startsWith(DIAGNOSTIC_PREFIX)) {
        try { const safe = safeDiagnostic(JSON.parse(pending.slice(DIAGNOSTIC_PREFIX.length))); if (safe) onDiagnostic(safe); } catch {}
      }
      pending = ''; dropping = false;
    }
  };
}
function diagnosticCode(error) {
  try {
    if (['AUTHORIZATION_RESPONSE_INVALID','DRIVE_AUTH_FAILED','HTTP_401','HTTP_403'].includes(error?.code)) return 'AUTHORIZATION_FAILED';
    if (error?.code === 'OIDC_TOKEN_INVALID') return 'OIDC_TOKEN_INVALID';
    if (['RUN_LOCK_LOST','RUN_LOCK_UNAVAILABLE'].includes(error?.code)) return 'SOURCE_LOCK_LOST';
    if (['INVENTORY_CHECKSUM_MISMATCH','DOWNLOAD_HASH_MISMATCH','STORAGE_CHECKSUM_MISMATCH'].includes(error?.code)) return 'CHECKSUM_MISMATCH';
  } catch {}
  return 'FAILED';
}
function diagnosticEmitter(onDiagnostic = () => {}) {
  const started = performance.now();
  return (phase,code) => {
    const safe = safeDiagnostic({phase,code,elapsedSeconds:Math.min(MAX_DURATION_MS/1000,Math.max(0,Math.floor((performance.now()-started)/1000)))});
    if (safe) try { onDiagnostic(safe); } catch {}
  };
}
export class NightlyError extends Error {
  constructor(code) { super(`Nightly backup failed (${code}).`); this.name = 'NightlyError'; this.code = code; }
}

/** No provider exception, URL, business count, source path or secret enters public logs. */
export function publicStatus(ok) {
  return ok ? 'ECO encrypted backup verified; retention completed.' : 'ECO backup did not complete. Previous verified copies were preserved unless retention had already verified five newer nights.';
}
export function validateExecutionContext(env, target) {
  check(env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted', 'TRUSTED_RUNNER_REQUIRED');
  check(env.GITHUB_REPOSITORY === target.githubRepository && env.GITHUB_REF === 'refs/heads/main'
    && env.GITHUB_REF_PROTECTED === 'true' && ['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME), 'TRUSTED_MAIN_EVENT_REQUIRED');
  check(/^[a-f0-9]{40}$/u.test(env.GITHUB_SHA || '') && /^[1-9][0-9]*$/u.test(env.GITHUB_RUN_ID || ''), 'INVALID_RUN_IDENTITY');
  check(env.RUNNER_DEBUG !== '1' && env.ACTIONS_STEP_DEBUG !== 'true' && env.ACTIONS_RUNNER_DEBUG !== 'true', 'DEBUG_LOGGING_REJECTED');
  return { repository: target.githubRepository, commit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID };
}
export function validateRuntime({ target, config, secrets }) {
  check(plain(target) && /^[a-z]{20}$/u.test(target.supabaseProjectRef || '')
    && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(target.githubRepository || '')
    && target.identityMode === 'independent-password' && /^https:\/\/[^/]+$/u.test(target.productionOrigin || '')
    && /^[a-z0-9][a-z0-9._-]{0,99}$/u.test(target.supplierReportsBucket || ''), 'INVALID_CANONICAL_TARGET');
  check(exact(config, ['schemaVersion','expectedProjectRef','expectedSourceRole','database','pgBin','ageBin','recipient','drive','timeoutMs'])
    && config.schemaVersion === 1 && config.expectedProjectRef === target.supabaseProjectRef, 'TARGET_CONFIGURATION_MISMATCH');
  check(config.expectedSourceRole === 'eco_backup_reader', 'DEDICATED_READ_ROLE_REQUIRED');
  check(exact(config.database, ['PGHOST','PGPORT','PGUSER','PGDATABASE','PGSSLMODE','PGSSLROOTCERT']), 'UNEXPECTED_CONNECTION_OPTION');
  check(exact(secrets, ['dbPassword','driveClientId','driveClientSecret','driveRefreshToken','storage']), 'INVALID_CREDENTIAL_FIELDS');
  for (const key of ['dbPassword','driveClientId','driveClientSecret','driveRefreshToken'])
    check(typeof secrets[key] === 'string' && secrets[key].length > 0 && secrets[key].length <= 16_384
      && !/[\r\n\0]/u.test(secrets[key]), 'INVALID_CREDENTIAL');
  check(plain(secrets.storage), 'STORAGE_PROVIDER_REQUIRED');
  check(!JSON.stringify({ config, secrets }).includes(PRIVATE_MARKER), 'RECOVERY_IDENTITY_FORBIDDEN');
  check(typeof config.recipient === 'string' && /^age1[0-9a-z]{58}$/u.test(config.recipient), 'PUBLIC_RECIPIENT_REQUIRED');
  check(isAbsolute(config.pgBin) && isAbsolute(config.ageBin), 'ABSOLUTE_TOOLS_REQUIRED');
  check(Number.isInteger(config.timeoutMs) && config.timeoutMs >= 60_000 && config.timeoutMs <= MAX_DURATION_MS, 'INVALID_DURATION');
  check(exact(config.drive, ['expectedEmail','folderId','applicationTag','namePrefix','propertyPrefix','keepNights','maxArchiveBytes'])
    && config.drive.keepNights === 5 && config.drive.applicationTag === 'eco-nightly-v1'
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(config.drive.expectedEmail || '') && /^[A-Za-z0-9_-]{10,200}$/u.test(config.drive.folderId || ''), 'INVALID_DRIVE_CONFIGURATION');
  const connection = { ...config.database, PGPASSWORD: secrets.dbPassword };
  try { validateConnection(connection, target.supabaseProjectRef, config.expectedSourceRole); }
  catch { fail('INVALID_DATABASE_TARGET_OR_TLS'); }
  return connection;
}

/** O_NOFOLLOW plus inode/mode checks protect private runtime files; contents are never logged. */
export async function readPrivateFile(path, maxBytes = MAX_RUNTIME_BYTES) {
  check(typeof path === 'string' && isAbsolute(path), 'ABSOLUTE_PRIVATE_FILE_REQUIRED');
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    check(before.isFile() && before.nlink === 1 && !(before.mode & 0o077)
      && before.uid === process.getuid() && before.size <= maxBytes, 'PRIVATE_FILE_REQUIRED');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    check(bytes.length <= maxBytes && before.size === bytes.length && before.mtimeMs === after.mtimeMs
      && before.ctimeMs === after.ctimeMs, 'PRIVATE_FILE_CHANGED');
    return bytes.toString('utf8');
  } catch (error) { if (error instanceof NightlyError) throw error; fail('PRIVATE_FILE_UNAVAILABLE'); }
  finally { await handle?.close(); }
}
export async function loadSecrets(env) {
  for (const name of ['AGE_SECRET_KEY','AGE_IDENTITY_FILE','ECO_BACKUP_AGE_IDENTITY','ECO_BACKUP_AGE_IDENTITY_FILE'])
    check(!env[name], 'RECOVERY_IDENTITY_FORBIDDEN');
  const names = { dbPassword:'ECO_BACKUP_DB_PASSWORD', driveClientId:'ECO_DRIVE_CLIENT_ID',
    driveClientSecret:'ECO_DRIVE_CLIENT_SECRET', driveRefreshToken:'ECO_DRIVE_REFRESH_TOKEN', storage:'ECO_BACKUP_STORAGE_JSON' };
  const values = {};
  for (const [key, name] of Object.entries(names)) {
    check(Boolean(env[name]) !== Boolean(env[`${name}_FILE`]), 'ONE_CREDENTIAL_SOURCE_REQUIRED');
    values[key] = env[name] || (await readPrivateFile(env[`${name}_FILE`])).replace(/\r?\n$/u, '');
  }
  try { values.storage = JSON.parse(values.storage); } catch { fail('INVALID_STORAGE_CONFIGURATION'); }
  return values;
}

async function digest(path) {
  const hash = createHash('sha256'); let size = 0;
  for await (const chunk of createReadStream(path)) { size += chunk.length; hash.update(chunk); }
  return { size, sha256: hash.digest('hex') };
}
export async function writeManifest(directory, recovery) {
  const files = [];
  async function walk(base, prefix = '') {
    for (const entry of await readdir(base, { withFileTypes: true })) {
      const relative = prefix + entry.name; validateRelativePath(relative);
      const path = join(base, entry.name), info = await lstat(path);
      check(!(info.mode & 0o077) && !info.isSymbolicLink(), 'UNSAFE_CAPTURE_CONTENT');
      if (info.isDirectory()) await walk(path, relative + '/');
      else {
        check(info.isFile() && info.nlink === 1 && relative !== MANIFEST_NAME, 'UNSAFE_CAPTURE_CONTENT');
        files.push({ path: relative, ...(await digest(path)) });
      }
    }
  }
  await walk(directory);
  const manifest = { schemaVersion: 1, recovery, files: files.sort((a,b) => a.path.localeCompare(b.path)) };
  validateManifest(manifest);
  await writeFile(join(directory, MANIFEST_NAME), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
  return manifest;
}

/** Extra database lock covers Drive verification/retention too; capture owns a separate snapshot lock. */
export async function acquireRunLock({ bin, connection, projectRef, expectedSourceRole }) {
  const session = new SqlSession({ bin, connection });
  let originalPid;
  try {
    await assertReadOnlySourceRole(session, expectedSourceRole);
    const [row] = await session.rows(`SELECT pg_backend_pid() AS pid,current_user AS role,pg_try_advisory_lock(hashtextextended('eco-nightly:${projectRef}',0)) AS acquired`);
    check(row?.acquired === true && row.role === expectedSourceRole && Number.isInteger(row.pid), 'RUN_LOCK_UNAVAILABLE');
    originalPid = row.pid;
  } catch { await session.close(); fail('RUN_LOCK_UNAVAILABLE'); }
  return {
    async assertAlive() {
      check(!session.ended, 'RUN_LOCK_LOST');
      const [row] = await session.rows('SELECT pg_backend_pid() AS pid,current_user AS role');
      check(row?.pid === originalPid && row.role === expectedSourceRole, 'RUN_LOCK_LOST');
    },
    close: () => session.close(),
  };
}

/** Worker engine is separately testable; production runs only inside superviseWorker(). */
export async function runNightly({ target, config, secrets, runDirectory, provenance }, dependencies) {
  const connection = validateRuntime({ target, config, secrets });
  check(dependencies && typeof dependencies.captureObjects === 'function', 'STORAGE_PROVIDER_REQUIRED');
  const info = await lstat(runDirectory);
  check(info.isDirectory() && !info.isSymbolicLink() && !(info.mode & 0o077), 'PRIVATE_RUN_DIRECTORY_REQUIRED');
  const deps = { now: () => new Date(), capture: capturePostgres, seal: sealDirectory, lock: acquireRunLock,
    manifest: writeManifest, ...dependencies };
  const startedAt = deps.now().toISOString(), runId = randomUUID();
  const emit = diagnosticEmitter(deps.onDiagnostic);
  let lock, phase = 'RUN_LOCK';
  const enter = value => { phase = value; emit(phase,'STARTED'); };
  try {
    enter('RUN_LOCK');
    lock = await deps.lock({ bin: config.pgBin, connection, projectRef: target.supabaseProjectRef, expectedSourceRole: config.expectedSourceRole });
    const drive = deps.createDrive ? deps.createDrive({ beforeMutation: () => lock.assertAlive() }) : deps.drive;
    check(drive && typeof drive.verifyTarget === 'function', 'DRIVE_CLIENT_REQUIRED');
    enter('DRIVE_TARGET');
    await drive.verifyTarget();
    const existing = await drive.findVerifiedNight({ snapshotAt: startedAt });
    let receipt, reused = false;
    if (existing) {
      check(existing.verified === true && existing.night === hongKongNight(startedAt), 'INVALID_EXISTING_RECEIPT');
      receipt = existing; reused = true;
    } else {
      const sourceDir = join(runDirectory, 'capture');
      enter('DATABASE_CAPTURE');
      const inventory = await deps.capture({ bin: config.pgBin, connection, expectedProjectRef: target.supabaseProjectRef,
        expectedSourceRole: config.expectedSourceRole, supplierReportsBucket: target.supplierReportsBucket, profileAttachmentsBucket: target.profileAttachmentsBucket,
        outputDir: sourceDir, captureObjects: async (...args) => {
          enter('STORAGE');
          const result = await deps.captureObjects(...args);
          emit('STORAGE','COMPLETED'); enter('DATABASE_CAPTURE'); return result;
        } });
      check(inventory?.sourceProjectRef === target.supabaseProjectRef && inventory.source?.role === config.expectedSourceRole
        && Number.isFinite(Date.parse(inventory.source.snapshot_time))
        && Math.abs(Date.parse(inventory.source.snapshot_time) - Date.parse(startedAt)) <= config.timeoutMs, 'CAPTURE_IDENTITY_MISMATCH');
      // A midnight crossing must not create a second differently-labelled snapshot in the same run.
      check(hongKongNight(inventory.source.snapshot_time) === hongKongNight(startedAt), 'NIGHT_CHANGED_DURING_CAPTURE');
      enter('ENCRYPTION');
      await deps.manifest(sourceDir, { runId, sourceProjectRef: target.supabaseProjectRef,
        snapshotTime: inventory.source.snapshot_time, databaseServer: inventory.source.server_version,
        toolVersion: 'eco-nightly-v1', unattended: true, restorationVerified: false, provenance });
      const encrypted = await deps.seal({ sourceDir, outputFile: join(runDirectory, 'backup.tar.gz.age'), recipient: config.recipient, ageBin: config.ageBin });
      check(/^[a-f0-9]{64}$/u.test(encrypted?.sha256 || '') && Number.isSafeInteger(encrypted.size) && encrypted.size > 0, 'ENCRYPTION_RECEIPT_INVALID');
      // Plaintext is no longer needed during the network upload/readback phase.
      enter('CLEANUP');
      await rm(sourceDir, { recursive: true, force: true });
      enter('RUN_LOCK');
      await lock.assertAlive();
      enter('DRIVE_UPLOAD');
      receipt = await drive.uploadAndVerify({ archiveFile: encrypted.archiveFile,
        snapshotAt: inventory.source.snapshot_time, expectedSha256: encrypted.sha256 });
      check(receipt?.verified === true && receipt.sha256 === encrypted.sha256 && receipt.size === encrypted.size
        && receipt.night === hongKongNight(startedAt), 'UPLOAD_RECEIPT_MISMATCH');
    }
    enter('RUN_LOCK');
    await lock.assertAlive();
    enter('RETENTION');
    const retention = await drive.retainLatestNights({ currentReceipt: receipt });
    check(retention?.keepNights === 5 && retention.permanentDeletionUsed === false, 'INVALID_RETENTION_RESULT');
    emit('RETENTION','COMPLETED');
    return { schemaVersion: 1, runId, completedAt: deps.now().toISOString(), verified: true, reused,
      encryptedCopy: { fileId: receipt.fileId, night: receipt.night, sha256: receipt.sha256, size: receipt.size },
      retention, restorationVerified: false, provenance };
  } catch (error) { emit(phase,diagnosticCode(error)); fail('RUN_FAILED'); }
  finally { try { await lock?.close(); } catch { emit('CLEANUP','CLEANUP_FAILED'); fail('RUN_FAILED'); } }
}

/** Refresh tokens remain in memory; only fixed Google OAuth/Drive endpoints receive credentials. */
export function createGoogleAuthorizedFetch({ clientId, clientSecret, refreshToken, fetchImpl = fetch, now = () => Date.now() }) {
  let token, expiresAt = 0, refresh;
  async function accessToken() {
    if (token && now() < expiresAt - 60_000) return token;
    if (!refresh) refresh = (async () => {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30_000);
      try {
        const response = await fetchImpl('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type':'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id:clientId, client_secret:clientSecret, refresh_token:refreshToken, grant_type:'refresh_token' }).toString() });
        check(response.status === 200 && !response.redirected && (!response.url || response.url === 'https://oauth2.googleapis.com/token'), 'DRIVE_AUTH_FAILED');
        const bytes = await boundedResponse(response, MAX_RUNTIME_BYTES);
        const value = JSON.parse(bytes);
        check(typeof value.access_token === 'string' && /^[A-Za-z0-9._~+\/-]{1,16384}$/u.test(value.access_token)
          && value.token_type?.toLowerCase() === 'bearer' && Number.isFinite(value.expires_in) && value.expires_in >= 120 && value.expires_in <= 86_400, 'DRIVE_AUTH_FAILED');
        check(value.scope === 'https://www.googleapis.com/auth/drive.file', 'DRIVE_AUTH_SCOPE_MISMATCH');
        token = value.access_token; expiresAt = now() + value.expires_in * 1000; return token;
      } catch { fail('DRIVE_AUTH_FAILED'); } finally { clearTimeout(timer); }
    })().finally(() => { refresh = undefined; });
    return refresh;
  }
  return async (url, options = {}) => {
    try {
      const target = new URL(url), headers = new Headers(options.headers);
      check(target.origin === 'https://www.googleapis.com' && !target.username && !target.password && !target.hash
        && /^\/(?:drive\/v3\/(?:about|files(?:\/[A-Za-z0-9_-]+(?:\/permissions)?)?)|upload\/drive\/v3\/files(?:\/[A-Za-z0-9_-]+)?)$/u.test(target.pathname), 'UNSAFE_DRIVE_ENDPOINT');
      check(!headers.has('authorization') && options.redirect === 'error', 'UNSAFE_DRIVE_REQUEST');
      headers.set('Authorization', `Bearer ${await accessToken()}`);
      const response = await fetchImpl(url, { ...options, headers, redirect:'error' });
      if (response.status === 401) { token = undefined; expiresAt = 0; }
      return response; // Never replay a potentially consumed upload body.
    } catch { fail('DRIVE_REQUEST_FAILED'); }
  };
}
async function boundedResponse(response, maxBytes) {
  check(response.body && typeof response.body.getReader === 'function', 'INVALID_RESPONSE');
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength;
      check(length <= maxBytes, 'RESPONSE_TOO_LARGE'); chunks.push(value); }
    return Buffer.concat(chunks).toString('utf8');
  } finally { try { await reader.cancel(); } catch {} try { reader.releaseLock(); } catch {} }
}

/** All spawned tools share the worker's process group. Stop them before removing owned plaintext. */
export async function superviseWorker({ payload, workParent = tmpdir(), timeoutMs, signal,
  workerFile = fileURLToPath(import.meta.url), nodeBin = process.execPath, onDiagnostic = () => {} }) {
  check(process.platform !== 'win32' && Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_DURATION_MS, 'SUPERVISOR_CONFIGURATION_INVALID');
  process.umask(0o077);
  const runDirectory = await mkdtemp(join(workParent, 'eco-nightly-'));
  const input = JSON.stringify({ ...payload, runDirectory });
  let child, timer, aborted = false, output = '', outputBytes = 0, failure = false, phase = 'WORKER', reportedFailure = false;
  const emit = diagnosticEmitter(onDiagnostic);
  const report = diagnosticReader(value => {
    phase = value.phase;
    if (!['STARTED','COMPLETED'].includes(value.code)) reportedFailure = true;
    emit(value.phase,value.code);
  });
  const kill = () => {
    aborted = true;
    if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') failure = true; } }
  };
  const cancel = () => { emit(phase,'CANCELLED'); reportedFailure = true; kill(); };
  try {
    check(Buffer.byteLength(input) <= MAX_RUNTIME_BYTES && !input.includes(PRIVATE_MARKER), 'WORKER_INPUT_INVALID');
    check(!signal?.aborted, 'RUN_CANCELLED');
    child = spawn(nodeBin, [workerFile, '--worker'], { detached: true, stdio: ['pipe','pipe','pipe'],
      env: { PATH:'/usr/bin:/bin', LANG:'C', LC_ALL:'C', TZ:'UTC' } });
    const closed = new Promise(resolveClose => {
      child.once('error', () => { failure = true; }); child.once('close', code => resolveClose(code));
    });
    child.stderr.on('data', report);
    child.stdout.on('data', bytes => { outputBytes += bytes.length; if (outputBytes > MAX_RUNTIME_BYTES) { failure = true; kill(); }
      else output += bytes.toString('utf8'); });
    child.stdin.on('error', () => { failure = true; kill(); });
    timer = setTimeout(() => { emit(phase,'TIMEOUT'); reportedFailure = true; kill(); }, timeoutMs);
    signal?.addEventListener('abort', cancel, { once:true });
    child.stdin.end(input);
    const exitCode = await closed;
    check(!aborted && !failure && exitCode === 0, 'WORKER_FAILED');
    let receipt; try { receipt = JSON.parse(output); } catch { fail('WORKER_RECEIPT_INVALID'); }
    check(receipt?.verified === true && receipt.schemaVersion === 1, 'WORKER_RECEIPT_INVALID');
    return receipt;
  } catch (error) {
    if (!reportedFailure) emit(phase,'FAILED'); throw error;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', cancel);
    // A worker can finish while a descendant still exists; stop the group before cleanup either way.
    if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') failure = true; } }
    try { await rm(runDirectory, { recursive:true, force:true, maxRetries:3, retryDelay:100 }); }
    catch { emit('CLEANUP','CLEANUP_FAILED'); fail('PRIVATE_CLEANUP_FAILED'); }
    check(!failure, 'WORKER_FAILED');
  }
}

async function readStdin() {
  let size = 0, chunks = [];
  for await (const bytes of process.stdin) { size += bytes.length; check(size <= MAX_RUNTIME_BYTES, 'INPUT_TOO_LARGE'); chunks.push(bytes); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('INPUT_INVALID'); }
}
async function workerMain() {
  const payload = await readStdin();
  validateRuntime(payload);
  // This provider must be reviewed and colocated in the trusted checkout; no path from secrets is executed.
  const { createStorageCapture } = await import('./storage-credentials.mjs');
  const captureObjects = await createStorageCapture({ target:payload.target, secrets:payload.secrets.storage });
  const authorizedFetch = createGoogleAuthorizedFetch({ clientId:payload.secrets.driveClientId,
    clientSecret:payload.secrets.driveClientSecret, refreshToken:payload.secrets.driveRefreshToken });
  const createDrive = ({ beforeMutation }) => createDriveBackupClient({ authorizedFetch, config:payload.config.drive, beforeMutation });
  const result = await runNightly(payload, { captureObjects, createDrive,
    onDiagnostic: value => process.stderr.write(diagnosticLine(value)) });
  process.stdout.write(JSON.stringify(result));
}
async function cliMain() {
  const args = process.argv.slice(2);
  check(args.length === 4 && args[0] === '--canonical' && args[2] === '--config'
    && isAbsolute(args[1]) && isAbsolute(args[3]), 'CLI_ARGUMENTS_INVALID');
  const { ecoConnections: target } = await import(pathToFileURL(await realpath(args[1])));
  const provenance = validateExecutionContext(process.env, target);
  let config; try { config = JSON.parse(await readPrivateFile(args[3])); } catch { fail('CONFIGURATION_INVALID'); }
  const secrets = await loadSecrets(process.env);
  validateRuntime({ target, config, secrets });
  const controller = new AbortController(), abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    await superviseWorker({ payload:{ target, config, secrets, provenance }, timeoutMs:config.timeoutMs, signal:controller.signal,
      onDiagnostic:value => process.stderr.write(diagnosticLine(value)) });
    process.stdout.write(publicStatus(true) + '\n');
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  try { if (process.argv.length === 3 && process.argv[2] === '--worker') await workerMain(); else await cliMain(); }
  catch { process.stderr.write(publicStatus(false) + '\n'); process.exitCode = 1; }
}
