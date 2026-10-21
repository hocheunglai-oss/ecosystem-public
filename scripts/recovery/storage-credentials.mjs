import { captureStorage, StorageCaptureError } from './capture-storage.mjs';

// GitHub supplies these short-lived request credentials to this job only. They
// are passed by the launcher, never read from a stored connector/session token.
const PATH = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/([a-f0-9]{64})\.pdf$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const fail = code => { throw new StorageCaptureError(code); };
const check = (condition, code) => { if (!condition) fail(code); };
function lockUrl(value) {
  let url; try { url = new URL(value); } catch { fail('OIDC_CONFIGURATION_INVALID'); }
  check(url.protocol === 'https:' && url.hostname.endsWith('.actions.githubusercontent.com')
    && !url.port && !url.username && !url.password && !url.hash, 'OIDC_CONFIGURATION_INVALID');
  return url;
}
async function jsonResponse(response, expectedUrl, limit = 32_768) {
  check(response.status === 200 && !response.redirected && (!response.url || response.url === expectedUrl)
    && response.headers.get('content-type')?.split(';')[0].trim() === 'application/json'
    && response.body, 'AUTHORIZATION_RESPONSE_INVALID');
  const reader = response.body.getReader(), chunks = []; let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength; check(bytes <= limit, 'AUTHORIZATION_RESPONSE_TOO_LARGE'); chunks.push(next.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('AUTHORIZATION_RESPONSE_INVALID'); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function createStorageCapture({ target, secrets, signal, fetchImpl = fetch, now = () => Date.now() }) {
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
  async function getToken() {
    if (cachedToken && now() + 60_000 < tokenExpires) return cachedToken;
    if (!pendingToken) pendingToken = (async () => {
      const url = requestUrl.href;
      const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: requestSignal(),
        headers: { Authorization: `Bearer ${requestToken}`, Accept: 'application/json' } });
      const data = await jsonResponse(response, url);
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
        check(object && typeof object === 'object' && object.bucket_id === target.supplierReportsBucket
          && typeof object.name === 'string' && PATH.test(object.name) && UUID.test(object.id ?? '')
          && Number.isSafeInteger(object.metadata?.size) && object.metadata.size >= 5 && object.metadata.size <= 20 * 1024 * 1024
          && object.metadata.mimetype === 'application/pdf'
          && (object.version === null || (typeof object.version === 'string' && /^[A-Za-z0-9_.-]{1,200}$/u.test(object.version))), 'UNEXPECTED_STORAGE_INVENTORY');
        const hash = PATH.exec(object.name)[1];
        check(object.expectedSha256 === undefined || object.expectedSha256 === hash, 'INVENTORY_CHECKSUM_MISMATCH');
        const url = `${sourceOrigin}/storage/v1/object/authenticated/${object.bucket_id}/${object.name}`;
        check(!sources.has(url), 'DUPLICATE_OBJECT');
        const snapshot = JSON.parse(JSON.stringify({ ...object, expectedSha256: hash }));
        sources.set(url, { id: snapshot.id, bucketId: snapshot.bucket_id, path: snapshot.name,
          size: snapshot.metadata.size, version: snapshot.version });
        return snapshot;
      });
      return await captureStorage({ projectRef: target.supabaseProjectRef, expectedProjectRef: target.supabaseProjectRef,
        // captureStorage's transport contract accepts a credential; this marker
        // is deliberately non-secret and is never sent to any remote service.
        serviceKey: 'signed-download-transport', objects: copied, outputDir,
        async fetchImpl(input, init) {
          check(typeof input === 'string' && sources.has(input) && init?.method === 'GET', 'UNEXPECTED_STORAGE_REQUEST');
          const item = sources.get(input), authSignal = requestSignal(init.signal);
          const response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error', signal: authSignal,
            headers: { Authorization: `Bearer ${await getToken()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ objects: [item] }) });
          const result = await jsonResponse(response, endpoint);
          check(result?.schemaVersion === 1 && result.projectRef === target.supabaseProjectRef
            && Array.isArray(result.objects) && result.objects.length === 1, 'BACKUP_MANIFEST_INVALID');
          const entry = result.objects[0];
          check(entry && ['id', 'bucketId', 'path', 'size', 'version'].every(key => entry[key] === item[key])
            && entry.sha256 === PATH.exec(item.path)[1] && typeof entry.url === 'string'
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
