import { constants } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

// Protocol references (Google primary documentation only):
// https://developers.google.com/workspace/drive/api/guides/manage-uploads
// https://developers.google.com/workspace/drive/api/reference/rest/v3/files
// https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions/list
// https://developers.google.com/workspace/drive/api/guides/delete
const ORIGIN = 'https://www.googleapis.com';
const MIME = 'application/octet-stream';
const AGE_HEADER = 'age-encryption.org/v1\n';
const FILE_FIELDS = 'id,name,mimeType,parents,owners(emailAddress),ownedByMe,shared,driveId,trashed,size,sha256Checksum,version,appProperties,capabilities(canEdit,canTrash,canAddChildren,canListChildren)';
const DEFAULTS = Object.freeze({ applicationTag: 'eco-nightly-v1',
  namePrefix: 'ECO-nightly', propertyPrefix: 'ecoBackup', keepNights: 5, maxArchiveBytes: 512 * 1024 ** 2,
  chunkBytes: 8 * 1024 ** 2, requestTimeoutMs: 120_000, verificationTimeoutMs: 300_000,
  maxPages: 100, maxFiles: 10_000, retryLimit: 3 });
const ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/u;
const validId = value => typeof value === 'string' && ID_PATTERN.test(value);
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const fail = code => { throw new DriveBackupError(code); };
const check = (condition, code) => { if (!condition) fail(code); };
export class DriveBackupError extends Error {
  constructor(code) { super(`Drive backup operation failed (${code}).`); this.name = 'DriveBackupError'; this.code = code; }
}
// Public diagnostics must use this finite vocabulary, never an arbitrary error's
// message/code or a Google response body. The caller supplies the operation phase.
export const DRIVE_BACKUP_DIAGNOSTIC_CODES = Object.freeze([
  'ACCOUNT_MISMATCH', 'AGE_CIPHERTEXT_REQUIRED', 'ARCHIVE_NOT_VERIFIED', 'COMPLETION_MISMATCH',
  'CURRENT_ARCHIVE_CHANGED', 'CURRENT_ARCHIVE_MISSING', 'CURRENT_VERIFICATION_REQUIRED',
  'DOWNLOAD_HASH_MISMATCH', 'DOWNLOAD_FAILED', 'DUPLICATE_LIST_ENTRY', 'FILE_ID_MISMATCH', 'FILE_LIST_LIMIT',
  'FILE_SCOPE_MISMATCH', 'FIVE_NEWER_NIGHTS_REQUIRED', 'FOLDER_MISMATCH', 'FUTURE_SNAPSHOT',
  'HTTP_400', 'HTTP_401', 'HTTP_403', 'HTTP_404', 'HTTP_408', 'HTTP_409', 'HTTP_410',
  'HTTP_412', 'HTTP_413', 'HTTP_429', 'HTTP_500', 'HTTP_502', 'HTTP_503', 'HTTP_504',
  'ID_COLLISION', 'INCOMPLETE_FOLDER_LIST', 'INSUFFICIENT_DRIVE_QUOTA', 'INVALID_ARCHIVE_METADATA',
  'INVALID_CLIENT', 'INVALID_FILE_ID', 'INVALID_FILE_TAGS', 'INVALID_GENERATED_ID',
  'INVALID_GOOGLE_RESPONSE', 'INVALID_LIMITS', 'INVALID_LOCAL_ARCHIVE', 'INVALID_PERMISSIONS',
  'INVALID_SNAPSHOT_TIME', 'INVALID_TARGET', 'INVALID_UPLOAD_RANGE', 'INVALID_UPLOAD_SESSION',
  'INVALID_VERIFICATION_METADATA', 'LOCAL_FILE_CHANGED', 'LOCAL_HASH_MISMATCH',
  'MISSING_FILE_VERSION', 'MISSING_RESPONSE_BODY', 'MUTATION_AUTHORIZATION_FAILED',
  'NIGHT_COLLISION', 'NIGHT_NAME_COLLISION', 'NONPRIVATE_PERMISSIONS', 'OWNER_OR_SHARING_MISMATCH',
  'OPERATION_CANCELLED',
  'PAGINATION_LIMIT', 'PAGINATION_LOOP', 'PENDING_ARCHIVE_CHANGED', 'PERMISSIONS_LIMIT',
  'QUOTA_UNAVAILABLE', 'REDIRECT_REJECTED', 'REMOTE_CHANGED_BEFORE_COMPLETION',
  'REMOTE_CHANGED_DURING_VERIFICATION', 'REMOTE_ARCHIVE_METADATA_CHANGED', 'REMOTE_CHECKSUM_CHANGED',
  'REMOTE_CHECKSUM_UNSTABLE', 'REMOTE_METADATA_UNSTABLE', 'REMOTE_VERSION_REGRESSED', 'REMOTE_VERSION_UNSTABLE',
  'REMOTE_SIZE_OR_HASH_MISMATCH', 'REQUEST_TIMEOUT',
  'RESPONSE_SIZE_LIMIT', 'RETAINED_ARCHIVE_CHANGED', 'RETENTION_FILE_CHANGED',
  'RETENTION_NIGHT_COLLISION', 'TRANSPORT_FAILED', 'TRASH_READBACK_FAILED', 'UNMANAGED_FILE',
  'UNSAFE_GOOGLE_ENDPOINT', 'UNSAFE_LOCAL_ARCHIVE', 'UPLOADED_METADATA_MISMATCH',
  'UPLOAD_FAILED', 'UPLOAD_NO_PROGRESS', 'UPLOAD_RETRY_LIMIT',
]);
const diagnosticCodes = new Set(DRIVE_BACKUP_DIAGNOSTIC_CODES);
export function classifyDriveBackupError(error) {
  try {
    if (!(error instanceof DriveBackupError)) return null;
    const code = error.code;
    return typeof code === 'string' && diagnosticCodes.has(code) ? code : null;
  } catch { return null; }
}
export function hongKongNight(value) {
  const date = new Date(value); check(Number.isFinite(date.getTime()), 'INVALID_SNAPSHOT_TIME');
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function dateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function urlFor(path, params = {}) {
  const url = new URL(path, ORIGIN);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));
  return url.href;
}
function allowedUrl(value, session = false) {
  let url; try { url = new URL(value); } catch { fail('UNSAFE_GOOGLE_ENDPOINT'); }
  check(url.origin === ORIGIN && !url.username && !url.password && !url.hash, 'UNSAFE_GOOGLE_ENDPOINT');
  check(/^\/(?:drive\/v3\/(?:about|files(?:\/[A-Za-z0-9_-]+(?:\/permissions)?)?)|upload\/drive\/v3\/files(?:\/[A-Za-z0-9_-]+)?)$/u.test(url.pathname), 'UNSAFE_GOOGLE_ENDPOINT');
  if (session) check(url.pathname.startsWith('/upload/drive/v3/files')
    && url.searchParams.get('uploadType') === 'resumable' && Boolean(url.searchParams.get('upload_id')), 'INVALID_UPLOAD_SESSION');
  return url.href;
}
function abortRace(promise, signal, code = 'REQUEST_TIMEOUT') {
  if (signal.aborted) return Promise.reject(new DriveBackupError(code));
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new DriveBackupError(code)); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
async function consume(response, signal, { hash = false, maxBytes = 2 * 1024 ** 2, writeChunk } = {}) {
  check(response.body && typeof response.body.getReader === 'function', 'MISSING_RESPONSE_BODY');
  const reader = response.body.getReader(), chunks = [], digest = hash ? createHash('sha256') : null;
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await abortRace(reader.read(), signal); if (done) break;
      size += value.byteLength; check(size <= maxBytes, 'RESPONSE_SIZE_LIMIT');
      if (hash) digest.update(value); else chunks.push(value);
      // Complete each local write before retrying or closing its descriptor;
      // racing a write against cancellation could leave a stale write in flight.
      if (writeChunk) { await writeChunk(value, size - value.byteLength); check(!signal.aborted, 'REQUEST_TIMEOUT'); }
    }
  } finally {
    void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch {}
  }
  return hash ? { size, sha256: digest.digest('hex') } : Buffer.concat(chunks);
}

/** authorizedFetch is an opaque OAuth-authorized fetch. It must honor redirect/signal options.
 * This module never reads or persists access/refresh tokens or resumable upload URLs.
 * A caller must enforce a cross-process execution lock: Drive filenames are not unique.
 */
export function createDriveBackupClient({ authorizedFetch, config, beforeMutation = async () => {}, now = () => new Date(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), signal: operationSignal }) {
  check(typeof authorizedFetch === 'function' && typeof beforeMutation === 'function' && config && typeof config === 'object', 'INVALID_CLIENT');
  check(operationSignal === undefined || operationSignal instanceof AbortSignal, 'INVALID_CLIENT');
  const cfg = { ...DEFAULTS, ...config };
  check(typeof cfg.expectedEmail === 'string' && /^[^\s@]+@[^\s@]+$/u.test(cfg.expectedEmail)
    && validId(cfg.folderId), 'INVALID_TARGET');
  check(/^[A-Za-z0-9_-]{1,40}$/u.test(cfg.applicationTag) && /^[A-Za-z0-9_-]{1,40}$/u.test(cfg.namePrefix)
    && /^[A-Za-z][A-Za-z0-9]{0,20}$/u.test(cfg.propertyPrefix), 'INVALID_FILE_TAGS');
  check(cfg.keepNights === 5 && Number.isSafeInteger(cfg.maxArchiveBytes) && cfg.maxArchiveBytes > 0
    && cfg.maxArchiveBytes <= 8 * 1024 ** 3 && Number.isSafeInteger(cfg.chunkBytes)
    && cfg.chunkBytes >= 256 * 1024 && cfg.chunkBytes <= 32 * 1024 ** 2 && cfg.chunkBytes % (256 * 1024) === 0,
  'INVALID_LIMITS');
  for (const key of ['requestTimeoutMs', 'maxPages', 'maxFiles', 'retryLimit']) check(Number.isSafeInteger(cfg[key]) && cfg[key] > 0, 'INVALID_LIMITS');
  check(Number.isSafeInteger(cfg.verificationTimeoutMs) && cfg.verificationTimeoutMs > 0
    && cfg.verificationTimeoutMs <= 300_000, 'INVALID_LIMITS');
  const email = cfg.expectedEmail.toLowerCase(), minted = new WeakSet();
  const key = name => `${cfg.propertyPrefix}${name}`;
  const get = (file, name) => file.appProperties?.[key(name)];
  const nameFor = night => `${cfg.namePrefix}-${night}.tar.gz.age`;

  async function request(url, options = {}, { allowed = [200], retries = cfg.retryLimit, mode = 'json', maxBytes, resume = false, writeChunk, signal: deadlineSignal } = {}) {
    url = allowedUrl(url, resume);
    // The caller may cancel its entire Drive preflight; verifyBytes has a
    // separate total readback deadline. Neither signal may shadow the other.
    const scopes = [operationSignal, deadlineSignal].filter(Boolean);
    const scopeSignal = scopes.length ? AbortSignal.any(scopes) : undefined;
    const checkActive = () => {
      check(!operationSignal?.aborted, 'OPERATION_CANCELLED');
      check(!deadlineSignal?.aborted, 'REQUEST_TIMEOUT');
    };
    const waitRetry = async attempt => {
      checkActive();
      const waiting = Promise.resolve().then(() => sleep(Math.min(250 * 2 ** attempt, 4000)));
      try { if (scopeSignal) await abortRace(waiting, scopeSignal); else await waiting; }
      catch (error) { checkActive(); throw error; }
    };
    for (let attempt = 0; ; attempt++) {
      checkActive();
      const controller = new AbortController();
      const cancel = () => controller.abort();
      scopeSignal?.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);
      let response;
      try {
        if (['POST', 'PATCH', 'PUT', 'DELETE'].includes((options.method || 'GET').toUpperCase())) {
          // Revalidate the caller's serialization lock immediately before every
          // mutation attempt, including retries and resumable status requests.
          try { await abortRace(Promise.resolve().then(() => beforeMutation()), controller.signal); }
          catch { fail('MUTATION_AUTHORIZATION_FAILED'); }
        }
        checkActive();
        response = await abortRace(authorizedFetch(url, { ...options, redirect: 'error', signal: controller.signal }), controller.signal);
        check(!response.redirected && (!response.url || response.url === url), 'REDIRECT_REJECTED');
        if (response.status >= 300 && response.status < 400)
          check(resume && response.status === 308 && !response.headers.get('location'), 'REDIRECT_REJECTED');
        if (!allowed.includes(response.status)) {
          if ([408, 429, 500, 502, 503, 504].includes(response.status) && attempt < retries) {
            await abortRace(response.body?.cancel().catch(() => {}) || Promise.resolve(), controller.signal);
            await waitRetry(attempt); continue;
          }
          fail(`HTTP_${Number(response.status) || 0}`);
        }
        if (mode === 'headers' || response.status === 308) return { status: response.status, headers: response.headers };
        const data = await consume(response, controller.signal, { hash: mode === 'hash', maxBytes, writeChunk });
        if (mode === 'hash') return { status: response.status, headers: response.headers, ...data };
        let json; try { json = JSON.parse(data.toString('utf8')); } catch { fail('INVALID_GOOGLE_RESPONSE'); }
        return { status: response.status, headers: response.headers, json };
      } catch (error) {
        checkActive();
        if ((!(error instanceof DriveBackupError) || error.code === 'REQUEST_TIMEOUT') && attempt < retries) {
          await waitRetry(attempt); continue;
        }
        if (error instanceof DriveBackupError) throw error;
        throw new DriveBackupError('TRANSPORT_FAILED');
      } finally {
        clearTimeout(timer); scopeSignal?.removeEventListener('abort', cancel); controller.abort();
        if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
      }
    }
  }
  async function metadata(id, options) {
    check(validId(id), 'INVALID_FILE_ID');
    const file = (await request(urlFor(`/drive/v3/files/${id}`, { fields: FILE_FIELDS }), {}, options)).json;
    check(file.id === id, 'FILE_ID_MISMATCH'); return file;
  }
  async function permissions(id, options) {
    const all = [], seen = new Set(); let pageToken;
    for (let page = 0; page < cfg.maxPages; page++) {
      const { json } = await request(urlFor(`/drive/v3/files/${id}/permissions`, {
        fields: 'nextPageToken,permissions(id,type,role,emailAddress,deleted,pendingOwner)', pageSize: 100, pageToken,
      }), {}, options);
      check(Array.isArray(json.permissions), 'INVALID_PERMISSIONS'); all.push(...json.permissions);
      check(all.length <= cfg.maxFiles, 'PERMISSIONS_LIMIT');
      if (!json.nextPageToken) return all;
      check(typeof json.nextPageToken === 'string' && !seen.has(json.nextPageToken), 'PAGINATION_LOOP');
      seen.add(json.nextPageToken); pageToken = json.nextPageToken;
    }
    fail('PAGINATION_LIMIT');
  }
  function privateOwner(file) {
    check(file && file.trashed === false && file.ownedByMe === true && file.shared === false && !file.driveId
      && Array.isArray(file.owners) && file.owners.length === 1 && file.owners[0].emailAddress?.toLowerCase() === email, 'OWNER_OR_SHARING_MISMATCH');
  }
  async function verifyPrivate(file, options) {
    privateOwner(file);
    const grants = await permissions(file.id, options);
    check(grants.length === 1 && grants[0].type === 'user' && grants[0].role === 'owner'
      && grants[0].emailAddress?.toLowerCase() === email && !grants[0].deleted && !grants[0].pendingOwner, 'NONPRIVATE_PERMISSIONS');
  }
  async function verifyTarget() {
    const { json: about } = await request(urlFor('/drive/v3/about', { fields: 'user(emailAddress),storageQuota(limit,usage)' }));
    check(about.user?.emailAddress?.toLowerCase() === email, 'ACCOUNT_MISMATCH');
    const folder = await metadata(cfg.folderId); check(folder.id === cfg.folderId
      && folder.mimeType === 'application/vnd.google-apps.folder' && folder.capabilities?.canAddChildren === true
      && folder.capabilities?.canListChildren === true, 'FOLDER_MISMATCH');
    await verifyPrivate(folder);
    const quota = about.storageQuota;
    check(quota && /^\d+$/u.test(String(quota.usage)) && (quota.limit === undefined || /^\d+$/u.test(String(quota.limit))), 'QUOTA_UNAVAILABLE');
    return { email, folderId: folder.id, quota: { usage: BigInt(quota.usage), limit: quota.limit === undefined ? null : BigInt(quota.limit) } };
  }
  async function listFolder() {
    const files = [], tokens = new Set(), ids = new Set(); let pageToken;
    for (let page = 0; page < cfg.maxPages; page++) {
      const { json } = await request(urlFor('/drive/v3/files', { q: `'${cfg.folderId}' in parents and trashed = false`,
        spaces: 'drive', pageSize: 1000, fields: `nextPageToken,incompleteSearch,files(${FILE_FIELDS})`, pageToken }));
      check(json.incompleteSearch !== true && Array.isArray(json.files), 'INCOMPLETE_FOLDER_LIST');
      for (const file of json.files) {
        check(validId(file.id) && !ids.has(file.id), 'DUPLICATE_LIST_ENTRY'); ids.add(file.id); files.push(file);
      }
      check(files.length <= cfg.maxFiles, 'FILE_LIST_LIMIT');
      if (!json.nextPageToken) return files;
      check(typeof json.nextPageToken === 'string' && !tokens.has(json.nextPageToken), 'PAGINATION_LOOP');
      tokens.add(json.nextPageToken); pageToken = json.nextPageToken;
    }
    fail('PAGINATION_LIMIT');
  }
  function isManaged(file) { return get(file, 'App') === cfg.applicationTag && get(file, 'Kind') === 'nightly-archive'; }
  function descriptor(file, { pending = false } = {}) {
    check(isManaged(file), 'UNMANAGED_FILE'); privateOwner(file);
    check(Array.isArray(file.parents) && file.parents.length === 1 && file.parents[0] === cfg.folderId
      && file.mimeType === MIME && file.capabilities?.canEdit === true, 'FILE_SCOPE_MISMATCH');
    const night = get(file, 'Night'), sizeText = get(file, 'Size'), sha256 = get(file, 'Sha256'), status = get(file, 'Status');
    check(dateKey(night) && file.name === nameFor(night) && HASH_PATTERN.test(sha256)
      && /^\d+$/u.test(sizeText) && Number(sizeText) > 0 && Number(sizeText) <= cfg.maxArchiveBytes
      && get(file, 'Format') === 'age-v1' && hongKongNight(get(file, 'SnapshotAt')) === night, 'INVALID_ARCHIVE_METADATA');
    check(status === 'verified' || (pending && status === 'pending'), 'ARCHIVE_NOT_VERIFIED');
    if (status === 'verified') check(get(file, 'Method') === 'sha256-download-v1'
      && Number.isFinite(Date.parse(get(file, 'VerifiedAt'))), 'INVALID_VERIFICATION_METADATA');
    check(typeof file.version === 'string' && /^\d+$/u.test(file.version), 'MISSING_FILE_VERSION');
    return { fileId: file.id, night, sha256, size: Number(sizeText), status };
  }
  function archiveFingerprint(file) {
    // Google returns appProperties as an unordered JSON map. Compare every key
    // and value in a stable order; a response's serialization order is not a change.
    const properties = Object.keys(file.appProperties).sort().map(name => [name, file.appProperties[name]]);
    return JSON.stringify([file.id, file.name, file.mimeType, file.parents, file.size, properties]);
  }
  function fingerprint(file) {
    return JSON.stringify([archiveFingerprint(file), file.version, file.sha256Checksum]);
  }
  async function verifyBytes(file, pending = false) {
    const value = descriptor(file, { pending }), pinned = archiveFingerprint(file);
    check(String(file.size) === String(value.size)
      && (file.sha256Checksum === undefined || file.sha256Checksum === value.sha256), 'REMOTE_SIZE_OR_HASH_MISMATCH');
    let lastVersion = BigInt(file.version), checksumSeen = false;
    const controller = new AbortController(), options = { signal: controller.signal };
    const verificationSignal = operationSignal ? AbortSignal.any([controller.signal, operationSignal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), cfg.verificationTimeoutMs);
    function observe(candidate) {
      descriptor(candidate, { pending });
      // Keep every original archive tag, snapshot, size and scope pinned across
      // retries. A server version bump never authorizes different content/tags.
      check(archiveFingerprint(candidate) === pinned, 'REMOTE_ARCHIVE_METADATA_CHANGED');
      check(String(candidate.size) === String(value.size), 'REMOTE_SIZE_OR_HASH_MISMATCH');
      const checksum = candidate.sha256Checksum;
      check(checksum === undefined || checksum === value.sha256, 'REMOTE_CHECKSUM_CHANGED');
      check(!checksumSeen || checksum === value.sha256, 'REMOTE_CHECKSUM_CHANGED');
      checksumSeen ||= checksum === value.sha256;
      const version = BigInt(candidate.version);
      check(version >= lastVersion, 'REMOTE_VERSION_REGRESSED'); lastVersion = version;
    }
    try {
      observe(file);
      for (let attempt = 0; attempt < 3; attempt++) {
        check(!operationSignal?.aborted, 'OPERATION_CANCELLED');
        check(!controller.signal.aborted, 'REQUEST_TIMEOUT');
        if (attempt) { file = await metadata(value.fileId, options); observe(file); }
        await verifyPrivate(file, options);
        const actual = await request(urlFor(`/drive/v3/files/${value.fileId}`, { alt: 'media' }), {},
          { ...options, mode: 'hash', maxBytes: value.size, retries: 0 });
        check(actual.size === value.size && actual.sha256 === value.sha256, 'DOWNLOAD_HASH_MISMATCH');
        const after = await metadata(value.fileId, options); observe(after);
        await verifyPrivate(after, options);
        if (fingerprint(after) === fingerprint(file)) return { file: after, value };
        // Google documents that version includes invisible server changes and
        // SHA256 is optional. It does not guarantee a settling interval. Only
        // an increasing version / newly available correct checksum may retry;
        // acceptance still requires a whole hash read within an unchanged window.
        if (attempt === 2) {
          const versionChanged = after.version !== file.version;
          const checksumChanged = after.sha256Checksum !== file.sha256Checksum;
          fail(versionChanged && checksumChanged ? 'REMOTE_METADATA_UNSTABLE'
            : versionChanged ? 'REMOTE_VERSION_UNSTABLE' : 'REMOTE_CHECKSUM_UNSTABLE');
        }
        await abortRace(sleep(250 * (attempt + 1)), verificationSignal);
      }
    } catch (error) {
      check(!operationSignal?.aborted, 'OPERATION_CANCELLED');
      throw error;
    } finally { clearTimeout(timer); controller.abort(); }
  }
  function mint(file) {
    const value = descriptor(file);
    const receipt = Object.freeze({ ...value, snapshotAt: get(file, 'SnapshotAt'), verified: true, verifiedAt: get(file, 'VerifiedAt'), readbackVerifiedAt: new Date(now()).toISOString(), folderId: cfg.folderId, email, version: file.version });
    minted.add(receipt); return receipt;
  }
  async function complete(file) {
    await verifyTarget(); const latest = await metadata(file.id);
    check(fingerprint(latest) === fingerprint(file), 'REMOTE_CHANGED_BEFORE_COMPLETION'); await verifyPrivate(latest);
    const appProperties = { ...latest.appProperties, [key('Status')]: 'verified', [key('Method')]: 'sha256-download-v1', [key('VerifiedAt')]: new Date(now()).toISOString() };
    await request(urlFor(`/drive/v3/files/${file.id}`, { fields: FILE_FIELDS }), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appProperties }),
    });
    const saved = await metadata(file.id); descriptor(saved); await verifyPrivate(saved);
    check(saved.size === latest.size && saved.sha256Checksum === latest.sha256Checksum && get(saved, 'Sha256') === get(latest, 'Sha256'), 'COMPLETION_MISMATCH');
    return saved;
  }
  function matchesNight(files, night) {
    const matches = files.filter(file => file.name === nameFor(night) || (isManaged(file) && get(file, 'Night') === night));
    check(matches.length <= 1, 'NIGHT_COLLISION');
    if (matches.length) check(isManaged(matches[0]), 'NIGHT_NAME_COLLISION');
    return matches[0];
  }
  async function findVerifiedNight({ snapshotAt }) {
    const night = hongKongNight(snapshotAt); await verifyTarget();
    const match = matchesNight(await listFolder(), night); if (!match) return null;
    const file = await metadata(match.id); const value = descriptor(file, { pending: true });
    try {
      const checked = await verifyBytes(file, true);
      return mint(value.status === 'pending' ? await complete(checked.file) : checked.file);
    } catch (error) {
      if (value.status === 'pending' && ['REMOTE_SIZE_OR_HASH_MISMATCH', 'DOWNLOAD_HASH_MISMATCH', 'HTTP_404'].includes(error.code)) return null;
      throw error;
    }
  }

  async function uploadAndVerify({ archiveFile, snapshotAt, expectedSha256 }) {
    check(typeof archiveFile === 'string' && isAbsolute(archiveFile) && archiveFile.endsWith('.age') && HASH_PATTERN.test(expectedSha256), 'INVALID_LOCAL_ARCHIVE');
    const initial = await lstat(archiveFile); check(initial.isFile() && !initial.isSymbolicLink() && initial.nlink === 1
      && !(initial.mode & 0o077) && initial.size > AGE_HEADER.length && initial.size <= cfg.maxArchiveBytes, 'UNSAFE_LOCAL_ARCHIVE');
    const handle = await open(archiveFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat(), digest = createHash('sha256'); let hashed = 0;
      for await (const bytes of handle.createReadStream({ autoClose: false, start: 0 })) { digest.update(bytes); hashed += bytes.length; }
      check(hashed === info.size && digest.digest('hex') === expectedSha256, 'LOCAL_HASH_MISMATCH');
      const header = Buffer.alloc(AGE_HEADER.length); await handle.read(header, 0, header.length, 0);
      check(header.toString() === AGE_HEADER, 'AGE_CIPHERTEXT_REQUIRED');
      const snapshot = new Date(snapshotAt).toISOString(), night = hongKongNight(snapshot);
      check(new Date(snapshot).getTime() <= new Date(now()).getTime() + 300_000, 'FUTURE_SNAPSHOT');
      const target = await verifyTarget(); let existing = matchesNight(await listFolder(), night), fileId;
      if (existing) {
        existing = await metadata(existing.id); const old = descriptor(existing, { pending: true }); await verifyPrivate(existing);
        if (old.status === 'verified') {
          check(old.sha256 === expectedSha256 && old.size === info.size, 'NIGHT_COLLISION');
          return mint((await verifyBytes(existing)).file);
        }
        try { return mint(await complete((await verifyBytes(existing, true)).file)); }
        catch (error) { if (!['REMOTE_SIZE_OR_HASH_MISMATCH', 'DOWNLOAD_HASH_MISMATCH', 'HTTP_404'].includes(error.code)) throw error; }
        fileId = existing.id;
      }
      check(target.quota.limit === null || target.quota.limit - target.quota.usage >= BigInt(info.size), 'INSUFFICIENT_DRIVE_QUOTA');
      if (!fileId) {
        const { json } = await request(urlFor('/drive/v3/files/generateIds', { count: 1, space: 'drive', type: 'files' }));
        check(Array.isArray(json.ids) && json.ids.length === 1 && validId(json.ids[0]), 'INVALID_GENERATED_ID'); fileId = json.ids[0];
      }
      const appProperties = { ...(existing?.appProperties || {}),
        [key('App')]: cfg.applicationTag, [key('Kind')]: 'nightly-archive', [key('Night')]: night,
        [key('Sha256')]: expectedSha256, [key('Size')]: String(info.size), [key('Status')]: 'pending',
        [key('Format')]: 'age-v1', [key('SnapshotAt')]: snapshot, [key('Method')]: null, [key('VerifiedAt')]: null,
      };
      const metadataBody = existing ? { name: nameFor(night), mimeType: MIME, appProperties }
        : { id: fileId, name: nameFor(night), mimeType: MIME, parents: [cfg.folderId], appProperties };
      let uploaded = false;
      for (let sessionAttempt = 0; sessionAttempt <= cfg.retryLimit && !uploaded; sessionAttempt++) {
        await verifyTarget();
        if (existing) {
          const fresh = await metadata(fileId), current = descriptor(fresh, { pending: true });
          await verifyPrivate(fresh);
          check(current.status === 'pending' && current.night === night
            && [get(existing, 'Sha256'), expectedSha256].includes(current.sha256), 'PENDING_ARCHIVE_CHANGED');
        }
        let start;
        try {
          start = await request(urlFor(`/upload/drive/v3/files${existing ? '/' + fileId : ''}`, { uploadType: 'resumable', fields: FILE_FIELDS }), {
            method: existing ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Upload-Content-Type': MIME, 'X-Upload-Content-Length': String(info.size) },
            body: JSON.stringify(metadataBody),
          }, { allowed: [200, 201, 409], mode: 'headers' });
        } catch (error) { if (sessionAttempt === cfg.retryLimit) throw error; continue; }
        if (start.status === 409) {
          // A pre-generated ID makes ambiguous create retries safe; inspect it, never generate another.
          const recovered = await metadata(fileId), value = descriptor(recovered, { pending: true });
          check(value.sha256 === expectedSha256 && value.size === info.size && value.night === night, 'ID_COLLISION');
          await verifyBytes(recovered, true); uploaded = true; break;
        }
        const sessionUrl = allowedUrl(start.headers.get('location'), true);
        let offset = 0, failures = 0;
        while (offset < info.size && !uploaded) {
          const length = Math.min(cfg.chunkBytes, info.size - offset), buffer = Buffer.alloc(length);
          const { bytesRead } = await handle.read(buffer, 0, length, offset); check(bytesRead === length, 'LOCAL_FILE_CHANGED');
          let reply;
          try {
            await verifyTarget();
            reply = await request(sessionUrl, { method: 'PUT', headers: { 'Content-Type': MIME,
              'Content-Length': String(length), 'Content-Range': `bytes ${offset}-${offset + length - 1}/${info.size}` }, body: buffer },
            { allowed: [200, 201, 308], retries: 0, mode: 'headers', resume: true });
          } catch (error) {
            if (error.code === 'HTTP_404') break;
            if (!['TRANSPORT_FAILED', 'REQUEST_TIMEOUT', 'HTTP_408', 'HTTP_429', 'HTTP_500', 'HTTP_502', 'HTTP_503', 'HTTP_504'].includes(error.code) || ++failures > cfg.retryLimit) throw error;
            await sleep(Math.min(250 * 2 ** (failures - 1), 4000));
            reply = await request(sessionUrl, { method: 'PUT', headers: { 'Content-Length': '0', 'Content-Range': `bytes */${info.size}` }, body: Buffer.alloc(0) },
              { allowed: [200, 201, 308, 404], mode: 'headers', resume: true });
            if (reply.status === 404) break;
          }
          if (reply.status === 200 || reply.status === 201) { uploaded = true; break; }
          const range = reply.headers.get('range');
          check(range === null || /^bytes=0-\d+$/u.test(range), 'INVALID_UPLOAD_RANGE');
          const next = range ? Number(range.slice(8)) + 1 : 0;
          check(Number.isSafeInteger(next) && next >= offset && next <= offset + length && next < info.size, 'INVALID_UPLOAD_RANGE');
          if (next === offset && ++failures > cfg.retryLimit) fail('UPLOAD_NO_PROGRESS');
          offset = next;
        }
      }
      check(uploaded, 'UPLOAD_RETRY_LIMIT');
      const after = await handle.stat(); check(after.size === info.size && after.mtimeMs === info.mtimeMs && after.ctimeMs === info.ctimeMs, 'LOCAL_FILE_CHANGED');
      const file = await metadata(fileId), value = descriptor(file, { pending: true });
      check(value.sha256 === expectedSha256 && value.size === info.size && value.night === night, 'UPLOADED_METADATA_MISMATCH');
      const checked = await verifyBytes(file, true);
      const unique = matchesNight(await listFolder(), night); check(unique?.id === fileId, 'NIGHT_COLLISION');
      return mint(value.status === 'verified' ? checked.file : await complete(checked.file));
    } catch (error) {
      if (error instanceof DriveBackupError) throw error; throw new DriveBackupError('UPLOAD_FAILED');
    } finally { await handle.close(); }
  }

  async function listManagedBackups() {
    await verifyTarget(); return (await listFolder()).filter(isManaged).map(file => descriptor(file, { pending: true }));
  }
  /** Diagnose an existing copy without completing it, uploading, or authorizing retention. */
  async function verifyArchiveReadOnly({ fileId }) {
    await verifyTarget();
    const checked = await verifyBytes(await metadata(fileId), true);
    return Object.freeze({ ...checked.value, readbackVerifiedAt: new Date(now()).toISOString() });
  }
  /** Export a freshly verified ciphertext for a second destination; never mutate Drive. */
  async function downloadVerifiedArchive({ currentReceipt, archiveFile }) {
    check(currentReceipt && minted.has(currentReceipt) && currentReceipt.verified === true, 'CURRENT_VERIFICATION_REQUIRED');
    check(typeof archiveFile === 'string' && isAbsolute(archiveFile) && archiveFile.endsWith('.age'), 'INVALID_LOCAL_ARCHIVE');
    let handle, created, complete = false;
    try {
      // A private parent prevents another account replacing our path during
      // cleanup. Exclusive creation protects any existing file or symlink.
      const parent = await lstat(dirname(archiveFile));
      check(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === process.getuid()
        && !(parent.mode & 0o077), 'UNSAFE_LOCAL_ARCHIVE');
      handle = await open(archiveFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = await handle.stat();
      check(created.isFile() && created.nlink === 1 && created.uid === process.getuid() && !(created.mode & 0o077), 'UNSAFE_LOCAL_ARCHIVE');
      await verifyTarget();
      const before = await metadata(currentReceipt.fileId), value = descriptor(before);
      check(value.sha256 === currentReceipt.sha256 && value.size === currentReceipt.size
        && value.night === currentReceipt.night && before.version === currentReceipt.version
        && get(before, 'SnapshotAt') === currentReceipt.snapshotAt, 'CURRENT_ARCHIVE_CHANGED');
      await verifyPrivate(before);
      check(String(before.size) === String(value.size) && (!before.sha256Checksum || before.sha256Checksum === value.sha256), 'REMOTE_SIZE_OR_HASH_MISMATCH');
      let header = Buffer.alloc(0);
      const actual = await request(urlFor(`/drive/v3/files/${before.id}`, { alt: 'media' }), {}, {
        mode: 'hash', maxBytes: value.size,
        writeChunk: async (bytes, position) => {
          if (position === 0) header = Buffer.alloc(0);
          if (header.length < AGE_HEADER.length) header = Buffer.concat([header, bytes.subarray(0, AGE_HEADER.length - header.length)]);
          let offset = 0;
          while (offset < bytes.length) {
            const written = await handle.write(bytes, offset, bytes.length - offset, position + offset);
            check(written.bytesWritten > 0, 'DOWNLOAD_FAILED'); offset += written.bytesWritten;
          }
        },
      });
      check(actual.size === value.size && actual.sha256 === value.sha256, 'DOWNLOAD_HASH_MISMATCH');
      check(header.toString() === AGE_HEADER, 'AGE_CIPHERTEXT_REQUIRED');
      const after = await metadata(before.id); descriptor(after); await verifyPrivate(after);
      check(fingerprint(after) === fingerprint(before), 'REMOTE_CHANGED_DURING_VERIFICATION');
      await verifyTarget();
      await handle.sync();
      const local = await handle.stat(), named = await lstat(archiveFile);
      check(local.size === value.size && local.nlink === 1 && !(local.mode & 0o077)
        && named.dev === created.dev && named.ino === created.ino && !named.isSymbolicLink(), 'LOCAL_FILE_CHANGED');
      await handle.close(); handle = undefined; complete = true;
      return Object.freeze({ archiveFile, expectedSha256: value.sha256, snapshotAt: currentReceipt.snapshotAt,
        size: value.size, fileId: before.id, verified: true });
    } catch (error) {
      if (error instanceof DriveBackupError) throw error;
      throw new DriveBackupError('DOWNLOAD_FAILED');
    } finally {
      await handle?.close().catch(() => {});
      if (!complete && created) {
        try {
          const current = await lstat(archiveFile);
          if (current.dev === created.dev && current.ino === created.ino && !current.isSymbolicLink()) await unlink(archiveFile);
        } catch { /* Never remove an unrelated path or expose a local filesystem error. */ }
      }
    }
  }
  async function retainLatestNights({ currentReceipt }) {
    check(currentReceipt && minted.has(currentReceipt) && currentReceipt.verified === true, 'CURRENT_VERIFICATION_REQUIRED');
    await verifyTarget();
    const files = (await listFolder()).filter(file => isManaged(file) && get(file, 'Status') === 'verified');
    const byNight = new Map();
    for (const file of files) {
      const value = descriptor(file);
      check(value.night <= currentReceipt.night && !byNight.has(value.night), 'RETENTION_NIGHT_COLLISION');
      byNight.set(value.night, file);
    }
    check(byNight.get(currentReceipt.night)?.id === currentReceipt.fileId, 'CURRENT_ARCHIVE_MISSING');
    const current = descriptor(byNight.get(currentReceipt.night));
    check(current.sha256 === currentReceipt.sha256 && current.size === currentReceipt.size, 'CURRENT_ARCHIVE_CHANGED');
    const nights = [...byNight.keys()].sort().reverse();
    const verified = new Map();
    // Verify every retained night before considering removal. A corrupt newer copy preserves all older copies.
    for (const night of nights) verified.set(night, (await verifyBytes(await metadata(byNight.get(night).id))).file);
    const trashed = [];
    for (const night of nights.slice(cfg.keepNights)) {
      check(nights.filter(value => value > night).length >= cfg.keepNights, 'FIVE_NEWER_NIGHTS_REQUIRED');
      await verifyTarget(); const saved = verified.get(night), fresh = await metadata(saved.id);
      check(fingerprint(fresh) === fingerprint(saved) && fresh.capabilities?.canTrash === true, 'RETENTION_FILE_CHANGED');
      await verifyPrivate(fresh);
      for (const protectedNight of nights.filter(value => value > night).slice(0, cfg.keepNights)) {
        const protectedFile = verified.get(protectedNight), currentFile = await metadata(protectedFile.id);
        descriptor(currentFile); await verifyPrivate(currentFile);
        check(fingerprint(currentFile) === fingerprint(protectedFile), 'RETAINED_ARCHIVE_CHANGED');
      }
      await request(urlFor(`/drive/v3/files/${fresh.id}`, { fields: 'id,trashed,parents,appProperties' }), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }),
      });
      const after = await metadata(fresh.id); check(after.id === fresh.id && after.trashed === true, 'TRASH_READBACK_FAILED');
      trashed.push({ fileId: fresh.id, night });
    }
    return { keepNights: cfg.keepNights, retainedNights: nights.slice(0, cfg.keepNights), trashed, permanentDeletionUsed: false };
  }
  return Object.freeze({ verifyTarget, findVerifiedNight, uploadAndVerify, retainLatestNights, listManagedBackups, verifyArchiveReadOnly, downloadVerifiedArchive });
}
