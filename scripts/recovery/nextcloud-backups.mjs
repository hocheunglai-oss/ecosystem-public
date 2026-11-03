/** Optional private Storage Share copy. Never delete or overwrite an existing archive. */
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { hongKongNight } from './drive-backups.mjs';

const AGE_HEADER = 'age-encryption.org/v1\n';
const HASH = /^[a-f0-9]{64}$/u;
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
export const NEXTCLOUD_DIAGNOSTIC_CODES = Object.freeze([
  'NEXTCLOUD_CONFIGURATION_INVALID', 'NEXTCLOUD_ACCOUNT_MISMATCH', 'NEXTCLOUD_ACCOUNT_SHARED',
  'NEXTCLOUD_FOLDER_NOT_PRIVATE', 'NEXTCLOUD_METADATA_INVALID', 'NEXTCLOUD_HTTP_FAILED',
  'NEXTCLOUD_AUTHORIZATION_FAILED', 'NEXTCLOUD_REQUEST_FAILED', 'NEXTCLOUD_REDIRECT_REJECTED',
  'NEXTCLOUD_TIMEOUT', 'NEXTCLOUD_QUOTA_INSUFFICIENT', 'NEXTCLOUD_LOCAL_ARCHIVE_INVALID',
  'NEXTCLOUD_LOCAL_ARCHIVE_CHANGED', 'NEXTCLOUD_REMOTE_CHANGED', 'NEXTCLOUD_CHECKSUM_MISMATCH',
  'NEXTCLOUD_LOCK_LOST', 'NEXTCLOUD_EXISTING_COPY_INVALID',
]);
const codes = new Set(NEXTCLOUD_DIAGNOSTIC_CODES);
export class NextcloudBackupError extends Error {
  constructor(code) { super('Encrypted secondary backup did not complete.'); this.code = code; }
}
const fail = code => { throw new NextcloudBackupError(code); };
const check = (value, code) => { if (!value) fail(code); };
export function classifyNextcloudBackupError(error) {
  try { return error instanceof NextcloudBackupError && codes.has(error.code) ? error.code : null; }
  catch { return null; }
}
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
export function validateNextcloudConfiguration(config, appPassword) {
  check(exact(config, ['origin','expectedUser','folder','maxArchiveBytes']), 'NEXTCLOUD_CONFIGURATION_INVALID');
  let url; try { url = new URL(config.origin); } catch { fail('NEXTCLOUD_CONFIGURATION_INVALID'); }
  check(url.origin === config.origin && url.protocol === 'https:' && !url.port && !url.username && !url.password
    && /^nx[0-9]+\.your-storageshare\.de$/u.test(url.hostname)
    && typeof config.expectedUser === 'string' && /^eco-backup(?:-[a-z0-9]+)*$/u.test(config.expectedUser)
    && typeof config.folder === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(config.folder)
    && Number.isSafeInteger(config.maxArchiveBytes) && config.maxArchiveBytes > AGE_HEADER.length
    && config.maxArchiveBytes <= 8 * 1024 ** 3
    && typeof appPassword === 'string' && appPassword.length > 0 && appPassword.length <= 4096
    && !/[\r\n\0]/u.test(appPassword) && !appPassword.includes('AGE-SECRET-KEY-1'), 'NEXTCLOUD_CONFIGURATION_INVALID');
}
const abortRace = (promise, signal) => new Promise((resolve, reject) => {
  const abort = () => { cleanup(); reject(new NextcloudBackupError('NEXTCLOUD_TIMEOUT')); };
  const cleanup = () => signal.removeEventListener('abort', abort);
  if (signal.aborted) return abort();
  signal.addEventListener('abort', abort, { once: true });
  Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
});
async function consume(response, signal, maxBytes, hash = false) {
  check(response.body && typeof response.body.getReader === 'function', 'NEXTCLOUD_METADATA_INVALID');
  const reader = response.body.getReader(), chunks = [], digest = hash ? createHash('sha256') : null;
  let size = 0;
  try {
    for (;;) {
      const chunk = await abortRace(reader.read(), signal); if (chunk.done) break;
      size += chunk.value.byteLength; check(size <= maxBytes, hash ? 'NEXTCLOUD_CHECKSUM_MISMATCH' : 'NEXTCLOUD_METADATA_INVALID');
      if (digest) digest.update(chunk.value); else chunks.push(chunk.value);
    }
    return digest ? { size, sha256: digest.digest('hex') } : Buffer.concat(chunks);
  } finally {
    void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* Abort also releases native transport. */ }
  }
}
export async function parseNextcloudFolder(xml) {
  check(Buffer.isBuffer(xml) && xml.length <= 65_536, 'NEXTCLOUD_METADATA_INVALID');
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', ['-I', fileURLToPath(new URL('./nextcloud-props.py', import.meta.url))],
      { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['pipe','pipe','ignore'] });
    let output = '', failed = false;
    const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, 5000);
    child.on('error', () => { failed = true; });
    child.stdin.on('error', () => { failed = true; });
    child.stdout.on('data', bytes => { output += bytes.toString(); if (output.length > 8192) { failed = true; child.kill('SIGKILL'); } });
    child.on('close', code => {
      clearTimeout(timer);
      try {
        check(!failed && code === 0, 'NEXTCLOUD_METADATA_INVALID');
        const value = JSON.parse(output);
        check(exact(value, ['href','ownerId','mountType','isMountRoot','shareTypes','collection']), 'NEXTCLOUD_METADATA_INVALID');
        resolve(value);
      } catch { reject(new NextcloudBackupError('NEXTCLOUD_METADATA_INVALID')); }
    });
    child.stdin.end(xml);
  });
}
const PROPERTIES = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns"><d:prop><d:resourcetype/><oc:owner-id/><nc:mount-type/><nc:is-mount-root/><oc:share-types/></d:prop></d:propfind>';

export function createNextcloudBackupClient({ config, appPassword, fetchImpl = fetch, beforeMutation = async () => {},
  now = () => new Date(), sleep = delay, requestTimeoutMs = 120_000 }) {
  validateNextcloudConfiguration(config, appPassword);
  check(Number.isInteger(requestTimeoutMs) && requestTimeoutMs > 0 && requestTimeoutMs <= 120_000, 'NEXTCLOUD_CONFIGURATION_INVALID');
  const origin = config.origin, authorization = 'Basic ' + Buffer.from(config.expectedUser + ':' + appPassword).toString('base64');
  const folderPath = `/remote.php/dav/files/${config.expectedUser}/${config.folder}/`;
  const rootPath = `/remote.php/dav/files/${config.expectedUser}/`;
  const accountPath = '/ocs/v2.php/cloud/user?format=json';
  const sharesPath = '/ocs/v2.php/apps/files_sharing/api/v1/shares';
  const pinned = new Set([origin + accountPath, origin + sharesPath + '?format=json&reshares=true',
    origin + sharesPath + '?format=json&shared_with_me=true', origin + folderPath, origin + rootPath]);
  const archivePattern = /^ECO-nightly-\d{4}-\d{2}-\d{2}-[a-f0-9]{64}\.tar\.gz\.age$/u;
  function destination(path) {
    const url = new URL(path, origin);
    check(url.origin === origin && !url.username && !url.password && !url.hash
      && (pinned.has(url.href) || (!url.search && url.pathname.startsWith(folderPath)
        && archivePattern.test(url.pathname.slice(folderPath.length)))), 'NEXTCLOUD_CONFIGURATION_INVALID');
    return url.href;
  }
  async function request(path, { method = 'GET', headers = {}, body, allowed = [200], mode = 'json', limit = 65_536, retries = 2 } = {}) {
    const url = destination(path);
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      let response, stream;
      try {
        if (method === 'PUT') {
          try { await abortRace(beforeMutation(), controller.signal); } catch { fail('NEXTCLOUD_LOCK_LOST'); }
        }
        // Finish the local open so its stream is always owned and cleaned up,
        // including when the request deadline expires during filesystem access.
        stream = typeof body === 'function' ? await body() : body;
        check(!controller.signal.aborted, 'NEXTCLOUD_TIMEOUT');
        response = await abortRace(fetchImpl(url, { method, redirect: 'error', signal: controller.signal,
          headers: { ...headers, Authorization: authorization }, ...(stream === undefined ? {} : { body: stream }),
          ...(stream && typeof stream.pipe === 'function' ? { duplex: 'half' } : {}) }), controller.signal);
        check(!response.redirected && (!response.url || response.url === url)
          && !(response.status >= 300 && response.status < 400), 'NEXTCLOUD_REDIRECT_REJECTED');
        if (!allowed.includes(response.status)) {
          if (RETRY_STATUSES.has(response.status) && attempt < retries) { await sleep(500 * 2 ** attempt); continue; }
          fail([401,403].includes(response.status) ? 'NEXTCLOUD_AUTHORIZATION_FAILED' : 'NEXTCLOUD_HTTP_FAILED');
        }
        if (mode === 'headers') return { status: response.status, headers: response.headers };
        if (mode === 'hash') {
          const encoding = response.headers.get('content-encoding');
          check(!encoding || encoding.toLowerCase() === 'identity', 'NEXTCLOUD_CHECKSUM_MISMATCH');
          return { status: response.status, headers: response.headers, ...await consume(response, controller.signal, limit, true) };
        }
        const bytes = await consume(response, controller.signal, limit);
        if (mode === 'xml') return bytes;
        check(response.headers.get('content-type')?.split(';')[0].trim() === 'application/json', 'NEXTCLOUD_METADATA_INVALID');
        let result; try { result = JSON.parse(bytes.toString('utf8')); } catch { fail('NEXTCLOUD_METADATA_INVALID'); }
        check(result?.ocs?.meta?.status === 'ok' && result.ocs.meta.statuscode === 200, 'NEXTCLOUD_METADATA_INVALID');
        return result.ocs.data;
      } catch (error) {
        if ((!(error instanceof NextcloudBackupError) || error.code === 'NEXTCLOUD_TIMEOUT') && attempt < retries) { await sleep(500 * 2 ** attempt); continue; }
        if (error instanceof NextcloudBackupError) throw error;
        fail('NEXTCLOUD_REQUEST_FAILED');
      } finally {
        clearTimeout(timer); controller.abort();
        stream?.destroy?.();
        if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
      }
    }
  }
  async function verifyTarget() {
    const user = await request(accountPath, { headers: { 'OCS-APIRequest': 'true', Accept: 'application/json' } });
    check(user?.id === config.expectedUser && user.enabled !== false && Array.isArray(user.groups) && user.groups.length === 0
      && Array.isArray(user.subadmin) && user.subadmin.length === 0, 'NEXTCLOUD_ACCOUNT_MISMATCH');
    for (const query of ['?format=json&reshares=true', '?format=json&shared_with_me=true']) {
      const shares = await request(sharesPath + query, { headers: { 'OCS-APIRequest': 'true', Accept: 'application/json' } });
      check(Array.isArray(shares) && shares.length === 0, 'NEXTCLOUD_ACCOUNT_SHARED');
    }
    for (const path of [rootPath, folderPath]) {
      await verifyProperties(path, true, path === rootPath);
    }
    check(user.quota && Number.isSafeInteger(user.quota.free) && user.quota.free >= 0, 'NEXTCLOUD_METADATA_INVALID');
    return { freeBytes: user.quota.free };
  }
  async function verifyProperties(path, collection, root = false) {
    const props = await parseNextcloudFolder(await request(path, { method: 'PROPFIND', allowed: [207], mode: 'xml',
      headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' }, body: PROPERTIES }));
    let href; try { href = new URL(props.href, origin); } catch { fail('NEXTCLOUD_METADATA_INVALID'); }
    check(href.href === origin + path && props.ownerId === config.expectedUser && props.collection === collection
      && props.mountType === '' && props.shareTypes.trim() === ''
      && (root ? ['true','1','false','0'].includes(props.isMountRoot) : ['false','0'].includes(props.isMountRoot)), 'NEXTCLOUD_FOLDER_NOT_PRIVATE');
  }
  async function metadata(path, allowMissing = false) {
    const result = await request(path, { method: 'HEAD', mode: 'headers', allowed: allowMissing ? [200,404] : [200] });
    if (result.status === 404) return null;
    const etag = result.headers.get('etag'), size = result.headers.get('content-length');
    check(typeof etag === 'string' && /^"[^"\r\n]+"$/u.test(etag) && /^\d+$/u.test(size ?? '')
      && Number.isSafeInteger(Number(size)), 'NEXTCLOUD_METADATA_INVALID');
    return { etag, size: Number(size) };
  }
  async function verifyBytes(path, sha256, size) {
    await verifyProperties(path, false);
    const before = await metadata(path);
    check(before.size === size, 'NEXTCLOUD_CHECKSUM_MISMATCH');
    const actual = await request(path, { headers: { 'If-Match': before.etag, 'Accept-Encoding': 'identity' }, mode: 'hash', limit: size });
    check(actual.size === size && actual.sha256 === sha256, 'NEXTCLOUD_CHECKSUM_MISMATCH');
    const after = await metadata(path);
    check(before.etag === after.etag && before.size === after.size, 'NEXTCLOUD_REMOTE_CHANGED');
    await verifyProperties(path, false);
    await verifyTarget();
  }
  async function uploadAndVerify({ archiveFile, snapshotAt, expectedSha256 }) {
    check(typeof archiveFile === 'string' && isAbsolute(archiveFile) && archiveFile.endsWith('.age') && HASH.test(expectedSha256), 'NEXTCLOUD_LOCAL_ARCHIVE_INVALID');
    let initial, handle;
    try { initial = await lstat(archiveFile); } catch { fail('NEXTCLOUD_LOCAL_ARCHIVE_INVALID'); }
    check(initial.isFile() && !initial.isSymbolicLink() && initial.nlink === 1 && !(initial.mode & 0o077)
      && initial.uid === process.getuid() && initial.size > AGE_HEADER.length && initial.size <= config.maxArchiveBytes, 'NEXTCLOUD_LOCAL_ARCHIVE_INVALID');
    try { handle = await open(archiveFile, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { fail('NEXTCLOUD_LOCAL_ARCHIVE_INVALID'); }
    try {
      const info = await handle.stat(), digest = createHash('sha256');
      check(info.dev === initial.dev && info.ino === initial.ino, 'NEXTCLOUD_LOCAL_ARCHIVE_CHANGED');
      for await (const chunk of handle.createReadStream({ start: 0, end: info.size - 1, autoClose: false })) digest.update(chunk);
      check(digest.digest('hex') === expectedSha256, 'NEXTCLOUD_LOCAL_ARCHIVE_INVALID');
      const hashed = await handle.stat();
      check(info.size === hashed.size && info.mtimeMs === hashed.mtimeMs && info.ctimeMs === hashed.ctimeMs, 'NEXTCLOUD_LOCAL_ARCHIVE_CHANGED');
      const header = Buffer.alloc(AGE_HEADER.length); await handle.read(header, 0, header.length, 0);
      check(header.toString() === AGE_HEADER, 'NEXTCLOUD_LOCAL_ARCHIVE_INVALID');
      let snapshot; try { snapshot = new Date(snapshotAt).toISOString(); } catch { fail('NEXTCLOUD_LOCAL_ARCHIVE_INVALID'); }
      check(Date.parse(snapshot) <= new Date(now()).getTime() + 300_000, 'NEXTCLOUD_LOCAL_ARCHIVE_INVALID');
      const night = hongKongNight(snapshot), name = `ECO-nightly-${night}-${expectedSha256}.tar.gz.age`, path = folderPath + name;
      const quota = await verifyTarget();
      let reused = Boolean(await metadata(path, true));
      if (!reused) {
        check(quota.freeBytes >= info.size, 'NEXTCLOUD_QUOTA_INSUFFICIENT');
        try {
          const result = await request(path, { method: 'PUT', mode: 'headers', allowed: [201,412],
            headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(info.size), 'If-None-Match': '*' },
            body: async () => {
              const upload = await open(archiveFile, constants.O_RDONLY | constants.O_NOFOLLOW);
              try {
                const current = await upload.stat();
                check(info.dev === current.dev && info.ino === current.ino && info.size === current.size
                  && info.mtimeMs === current.mtimeMs && info.ctimeMs === current.ctimeMs, 'NEXTCLOUD_LOCAL_ARCHIVE_CHANGED');
                return upload.createReadStream({ start: 0, end: info.size - 1, autoClose: true });
              } catch (error) { await upload.close(); throw error; }
            } });
          reused = result.status === 412;
        } catch (error) {
          // A final lost response may still follow a complete remote commit.
          // Read-only verification is safe; authorization/lock failures are not retried here.
          if (!['NEXTCLOUD_REQUEST_FAILED','NEXTCLOUD_TIMEOUT','NEXTCLOUD_HTTP_FAILED'].includes(classifyNextcloudBackupError(error))) throw error;
          try { await verifyBytes(path, expectedSha256, info.size); reused = true; }
          catch { throw error; }
        }
      }
      // A lost upload response is recovered only by verifying the pre-existing
      // exact ciphertext. A partial or different object is preserved for review.
      try { await verifyBytes(path, expectedSha256, info.size); }
      catch (error) { if (reused && error.code === 'NEXTCLOUD_CHECKSUM_MISMATCH') fail('NEXTCLOUD_EXISTING_COPY_INVALID'); throw error; }
      const after = await handle.stat();
      check(info.size === after.size && info.mtimeMs === after.mtimeMs && info.ctimeMs === after.ctimeMs, 'NEXTCLOUD_LOCAL_ARCHIVE_CHANGED');
      return Object.freeze({ verified: true, destination: 'nextcloud', night, snapshotAt: snapshot,
        sha256: expectedSha256, size: info.size, archiveName: name, verifiedAt: new Date(now()).toISOString(), reused });
    } catch (error) {
      if (error instanceof NextcloudBackupError) throw error;
      fail('NEXTCLOUD_REQUEST_FAILED');
    } finally { try { await handle.close(); } catch { fail('NEXTCLOUD_LOCAL_ARCHIVE_CHANGED'); } }
  }
  return Object.freeze({ verifyTarget, uploadAndVerify });
}
