import { captureStorage, StorageCaptureError } from './capture-storage.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const AUTHORIZATION_HTTP_STATUSES = Object.freeze([400, 401, 403, 404, 405, 408, 409, 413, 429, 500, 502, 503, 504]);
const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
// Only these fixed scalar codes may cross into public workflow diagnostics.
export const AUTHORIZATION_DIAGNOSTIC_CODES = Object.freeze(['OIDC', 'STORAGE_AUTH'].flatMap(stage => [
  ...AUTHORIZATION_HTTP_STATUSES.map(status => `${stage}_HTTP_${status}`), `${stage}_HTTP_OTHER`,
  `${stage}_RESPONSE_INVALID`, `${stage}_RESPONSE_TOO_LARGE`, `${stage}_TRANSPORT_FAILED`,
]));

// GitHub supplies these short-lived request credentials to this job only. They
// are passed by the launcher, never read from a stored connector/session token.
const PATH = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/([a-f0-9]{64})\.pdf$/u;
const ATTACHMENT_PATH = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.bin$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const fail = code => { throw new StorageCaptureError(code); };
const check = (condition, code) => { if (!condition) fail(code); };
function lockUrl(value) {
  let url; try { url = new URL(value); } catch { fail('OIDC_CONFIGURATION_INVALID'); }
  check(url.protocol === 'https:' && url.hostname.endsWith('.actions.githubusercontent.com')
    && !url.port && !url.username && !url.password && !url.hash, 'OIDC_CONFIGURATION_INVALID');
  return url;
}
async function jsonResponse(response, expectedUrl, stage, limit = 32_768) {
  check(!response.redirected && (!response.url || response.url === expectedUrl), `${stage}_RESPONSE_INVALID`);
  check(response.status === 200, `${stage}_HTTP_${AUTHORIZATION_HTTP_STATUSES.includes(response.status) ? response.status : 'OTHER'}`);
  check(response.headers.get('content-type')?.split(';')[0].trim() === 'application/json'
    && response.body, `${stage}_RESPONSE_INVALID`);
  const reader = response.body.getReader(), chunks = []; let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength; check(bytes <= limit, `${stage}_RESPONSE_TOO_LARGE`); chunks.push(next.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(`${stage}_RESPONSE_INVALID`); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function createStorageCapture({ target, secrets, signal, fetchImpl = fetch, now = () => Date.now(),
  sleep = (ms, requestSignal) => delay(ms, undefined, { signal: requestSignal }) }) {
  check(target && /^[a-z0-9]{20}$/u.test(target.supabaseProjectRef ?? '') && target.backup
    && target.productionOrigin === new URL(target.productionOrigin).origin
    && new URL(target.productionOrigin).protocol === 'https:'
    && target.backup.storagePath === '/api/backup/storage-downloads'
    && typeof target.supplierReportsBucket === 'string', 'TARGET_MISMATCH');
  check(secrets && typeof secrets === 'object' && !Array.isArray(secrets)
    && Object.keys(secrets).sort().join(',') === 'oidcRequestToken,oidcRequestUrl'
    && typeof secrets.oidcRequestToken === 'string' && secrets.oidcRequestToken.length > 0
    && secrets.oidcRequestToken.length < 32_768 && !/[\r\n]/u.test(secrets.oidcRequestToken), 'OIDC_CONFIGURATION_INVALID');
  const endpoint = target.productionOrigin + target.backup.storagePath;
  const requestUrl = lockUrl(secrets.oidcRequestUrl);
  requestUrl.searchParams.set('audience', endpoint);
  const requestToken = secrets.oidcRequestToken;
  const sourceOrigin = `https://${target.supabaseProjectRef}.supabase.co`;
  let pendingToken, cachedToken, tokenExpires = 0;
  const requestSignal = extra => AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : []), ...(extra ? [extra] : [])]);
  async function authorizeJson(url, options, stage, extraSignal) {
    const cancelled = () => signal?.aborted || extraSignal?.aborted;
    // These calls only obtain a job token or a short-lived GET link. Retrying
    // does not write source data. Permanent auth/conflict failures stay closed.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (cancelled()) fail('CAPTURE_CANCELLED');
      let response;
      try {
        const attemptOptions = typeof options === 'function' ? await options() : options;
        if (cancelled()) fail('CAPTURE_CANCELLED');
        response = await fetchImpl(url, { ...attemptOptions, redirect: 'error', signal: requestSignal(extraSignal) });
        return await jsonResponse(response, url, stage);
      } catch (error) {
        if (cancelled()) fail('CAPTURE_CANCELLED');
        const retryable = error instanceof StorageCaptureError
          ? TRANSIENT_HTTP_STATUSES.has(response?.status) && error.code === `${stage}_HTTP_${response.status}`
          : true;
        if (!retryable || attempt === 2) {
          if (error instanceof StorageCaptureError) throw error;
          fail(`${stage}_TRANSPORT_FAILED`);
        }
      } finally {
        // Discard error bodies without logging their possibly sensitive content.
        if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
      }
      try { await sleep(500 * 2 ** attempt, AbortSignal.any([...(signal ? [signal] : []), ...(extraSignal ? [extraSignal] : [])])); }
      catch { fail('CAPTURE_CANCELLED'); }
    }
  }
  async function getToken() {
    if (cachedToken && now() + 60_000 < tokenExpires) return cachedToken;
    if (!pendingToken) pendingToken = (async () => {
      const url = requestUrl.href;
      const data = await authorizeJson(url, { method: 'GET',
        headers: { Authorization: `Bearer ${requestToken}`, Accept: 'application/json' } }, 'OIDC');
      check(typeof data.value === 'string' && data.value.length < 16_384
        && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(data.value), 'OIDC_TOKEN_INVALID');
      // Expiry is used only for refreshing this cache. ECO verifies the signature
      // and all authorization claims independently before allowing any access.
      let claims; try { claims = JSON.parse(Buffer.from(data.value.split('.')[1], 'base64url').toString('utf8')); } catch { fail('OIDC_TOKEN_INVALID'); }
      check(Number.isSafeInteger(claims.exp) && claims.exp * 1000 > now() + 30_000
        && claims.exp * 1000 <= now() + 660_000, 'OIDC_TOKEN_INVALID');
      cachedToken = data.value; tokenExpires = claims.exp * 1000; return cachedToken;
    })().finally(() => { pendingToken = undefined; });
    return pendingToken;
  }
  return async (objects, outputDir) => {
    try {
      check(Array.isArray(objects), 'INVALID_OBJECT_LIST');
      const sources = new Map();
      const copied = objects.map(object => {
        check(object && typeof object==='object','UNEXPECTED_STORAGE_INVENTORY');
        const report=object.bucket_id===target.supplierReportsBucket;
        const attachment=typeof target.profileAttachmentsBucket==='string' && object.bucket_id===target.profileAttachmentsBucket;
        check((report || attachment) && typeof object.name==='string' && (report ? PATH.test(object.name) : ATTACHMENT_PATH.test(object.name))
          && UUID.test(object.id ?? '') && Number.isSafeInteger(object.metadata?.size)
          && object.metadata.size >= (report ? 5 : 0) && object.metadata.size <= (report ? 20 : 50)*1024*1024
          && (report ? object.metadata.mimetype==='application/pdf' : typeof object.metadata.mimetype==='string'
            && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(object.metadata.mimetype)
            && ['pending','active'].includes(object.attachmentState))
          && (object.version===null || typeof object.version==='string' && /^[A-Za-z0-9_.-]{1,200}$/.test(object.version)), 'UNEXPECTED_STORAGE_INVENTORY');
        const hash=report ? PATH.exec(object.name)[1] : object.attachmentState==='active' ? object.expectedSha256 : undefined;
        check((hash===undefined || typeof hash==='string' && /^[a-f0-9]{64}$/.test(hash))
          && (object.expectedSha256===undefined || object.expectedSha256===hash)
          && (!attachment || object.attachmentState!=='active' || typeof hash==='string'), 'INVENTORY_CHECKSUM_MISMATCH');
        const url = `${sourceOrigin}/storage/v1/object/authenticated/${object.bucket_id}/${object.name}`;
        check(!sources.has(url), 'DUPLICATE_OBJECT');
        const snapshot = JSON.parse(JSON.stringify({ ...object, expectedSha256: hash }));
        sources.set(url, { id: snapshot.id, bucketId: snapshot.bucket_id, path: snapshot.name,
          size: snapshot.metadata.size, version: snapshot.version, expectedHash: hash });
        return snapshot;
      });
      return await captureStorage({ projectRef: target.supabaseProjectRef, expectedProjectRef: target.supabaseProjectRef,
        // captureStorage's transport contract accepts a credential; this marker
        // is deliberately non-secret and is never sent to any remote service.
        serviceKey: 'signed-download-transport', objects: copied, outputDir,
        async fetchImpl(input, init) {
          check(typeof input === 'string' && sources.has(input) && init?.method === 'GET', 'UNEXPECTED_STORAGE_REQUEST');
          const {expectedHash,...item} = sources.get(input);
          // Re-check expiry for every attempt: retries may outlast the cached
          // token's refresh margin even though the original request was valid.
          const result = await authorizeJson(endpoint, async () => ({ method: 'POST',
            headers: { Authorization: `Bearer ${await getToken()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ objects: [item] }) }), 'STORAGE_AUTH', init.signal);
          check(result?.schemaVersion === 1 && result.projectRef === target.supabaseProjectRef
            && Array.isArray(result.objects) && result.objects.length === 1, 'BACKUP_MANIFEST_INVALID');
          const entry = result.objects[0];
          check(entry && ['id', 'bucketId', 'path', 'size', 'version'].every(key => entry[key] === item[key])
            && (expectedHash ? entry.sha256===expectedHash : entry.sha256===null || typeof entry.sha256==='string' && /^[a-f0-9]{64}$/.test(entry.sha256)) && typeof entry.url === 'string'
            && Date.parse(entry.expiresAt) > now() && Date.parse(entry.expiresAt) <= now() + 305_000, 'BACKUP_MANIFEST_INVALID');
          const signed = new URL(entry.url);
          check(signed.origin === sourceOrigin && !signed.username && !signed.password && !signed.hash
            && signed.pathname === `/storage/v1/object/sign/${item.bucketId}/${item.path}`
            && [...signed.searchParams.keys()].join(',') === 'token' && signed.searchParams.get('token'), 'SIGNED_DOWNLOAD_TARGET_INVALID');
          const download = await fetchImpl(signed.href, { method: 'GET', redirect: 'error', signal: AbortSignal.any([init.signal, ...(signal ? [signal] : [])]),
            headers: { 'Accept-Encoding': 'identity' } });
          check(!download.redirected && (!download.url || download.url === signed.href)
            && download.status === 200, 'SIGNED_DOWNLOAD_FAILED');
          // Re-wrap only after validating the actual destination. The underlying
          // capture routine sees its original URL and still validates stream size,
          // MIME, hash, timeouts and private-file cleanup. No auth headers escape.
          return new Response(download.body, { status: download.status, headers: download.headers });
        },
      });
    } catch (error) {
      if (error instanceof StorageCaptureError) throw error;
      throw new StorageCaptureError('SIGNED_CAPTURE_FAILED');
    }
  };
}
