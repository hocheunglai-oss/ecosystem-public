import { createHash } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, parse } from 'node:path';

// Limits fail closed: an operator must deliberately review larger datasets.
export const STORAGE_CAPTURE_LIMITS = Object.freeze({
  concurrency: 4,
  requestTimeoutMs: 120_000,
  maxObjectBytes: 1_073_741_824,
  maxTotalBytes: 8_589_934_592,
  maxObjects: 100_000,
});

export class StorageCaptureError extends Error {
  constructor(code) {
    super(`Storage capture failed (${code}).`);
    this.name = 'StorageCaptureError';
    this.code = code;
  }
}

const fail = (code) => { throw new StorageCaptureError(code); };
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const encodedSegment = (value) => encodeURIComponent(value).replace(/[!'()*]/g,
  (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);

function safeSegment(value) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..'
    || /[\/\\\u0000-\u001f\u007f]/u.test(value)
    || /%(?:2e|2f|5c|00|25)/iu.test(value)) fail('INVALID_OBJECT_PATH');
  // Reject ill-formed UTF-16 rather than changing the source object's name.
  try { return encodedSegment(value); } catch { fail('INVALID_OBJECT_PATH'); }
}

function mediaType(value, code) {
  if (typeof value !== 'string') fail(code);
  const type = value.split(';', 1)[0].trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(type)) fail(code);
  return type;
}

function preflight({ projectRef, expectedProjectRef, serviceKey, objects, outputDir, fetchImpl }) {
  if (typeof projectRef !== 'string' || !/^[a-z0-9]{20}$/u.test(projectRef)
    || projectRef !== expectedProjectRef) fail('TARGET_MISMATCH');
  if (typeof serviceKey !== 'string' || !serviceKey.trim() || serviceKey.length > 16_384
    || /[\r\n]/u.test(serviceKey)) fail('INVALID_CREDENTIAL');
  if (typeof fetchImpl !== 'function') fail('INVALID_FETCH');
  if (typeof outputDir !== 'string' || !isAbsolute(outputDir)
    || normalize(outputDir) === parse(outputDir).root || dirname(outputDir) === outputDir)
    fail('INVALID_OUTPUT_DIRECTORY');
  if (!Array.isArray(objects) || objects.length > STORAGE_CAPTURE_LIMITS.maxObjects)
    fail('INVALID_OBJECT_LIST');

  const seenKeys = new Set();
  const seenIds = new Set();
  let totalBytes = 0;
  const origin = `https://${projectRef}.supabase.co`;
  const prepared = objects.map((object) => {
    if (!object || typeof object !== 'object' || Array.isArray(object)) fail('INVALID_OBJECT');
    if (typeof object.id !== 'string' || !object.id) fail('INVALID_OBJECT_ID');
    if (seenIds.has(object.id)) fail('DUPLICATE_OBJECT');
    seenIds.add(object.id);
    const bucket = safeSegment(object.bucket_id);
    if (typeof object.name !== 'string' || object.name.length > 16_384) fail('INVALID_OBJECT_PATH');
    const objectPath = object.name.split('/').map(safeSegment).join('/');
    const key = JSON.stringify([object.bucket_id, object.name]);
    if (seenKeys.has(key)) fail('DUPLICATE_OBJECT');
    seenKeys.add(key);
    const metadata = object.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
      || !Number.isSafeInteger(metadata.size) || metadata.size < 0
      || metadata.size > STORAGE_CAPTURE_LIMITS.maxObjectBytes) fail('INVALID_OBJECT_SIZE');
    totalBytes += metadata.size;
    if (totalBytes > STORAGE_CAPTURE_LIMITS.maxTotalBytes) fail('TOTAL_SIZE_LIMIT');
    const expectedType = metadata.mimetype == null ? null
      : mediaType(metadata.mimetype, 'INVALID_EXPECTED_MIME');
    if (object.expectedSha256 != null
      && (typeof object.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/iu.test(object.expectedSha256)))
      fail('INVALID_EXPECTED_CHECKSUM');
    // Clone before any network wait: caller mutations cannot alter the snapshot.
    let snapshot;
    try {
      snapshot = JSON.parse(JSON.stringify({
        id: object.id, bucket_id: object.bucket_id, name: object.name,
        metadata, updated_at: object.updated_at ?? null, version: object.version ?? null,
      }));
    } catch { fail('INVALID_OBJECT_METADATA'); }
    return {
      snapshot,
      url: `${origin}/storage/v1/object/authenticated/${bucket}/${objectPath}`,
      path: `objects/${sha256(key)}.bin`,
      expectedSize: metadata.size,
      expectedType,
      expectedSha256: object.expectedSha256?.toLowerCase() ?? null,
    };
  });
  return { prepared, totalBytes };
}

function abortRace(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

async function captureOne(item, outputDir, serviceKey, fetchImpl, batchSignal) {
  const controller = new AbortController();
  const onBatchAbort = () => controller.abort(new StorageCaptureError('CAPTURE_CANCELLED'));
  if (batchSignal.aborted) onBatchAbort();
  else batchSignal.addEventListener('abort', onBatchAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new StorageCaptureError('DOWNLOAD_TIMEOUT')),
    STORAGE_CAPTURE_LIMITS.requestTimeoutMs);
  let reader;
  let handle;
  let completed = false;
  try {
    const response = await abortRace(fetchImpl(item.url, {
      method: 'GET', redirect: 'error', signal: controller.signal,
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Accept-Encoding': 'identity' },
    }), controller.signal);
    if (response.redirected || (response.status >= 300 && response.status < 400)) fail('REDIRECT_REJECTED');
    if (response.url && response.url !== item.url) fail('RESPONSE_TARGET_MISMATCH');
    if (response.status !== 200) fail(response.status === 404 ? 'OBJECT_NOT_FOUND' : 'HTTP_FAILURE');
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) !== item.expectedSize))
      fail('SIZE_MISMATCH');
    const encoding = response.headers.get('content-encoding');
    if (encoding && encoding.toLowerCase() !== 'identity') fail('UNEXPECTED_CONTENT_ENCODING');
    const typeHeader = response.headers.get('content-type');
    const actualType = typeHeader ? mediaType(typeHeader, 'INVALID_RESPONSE_MIME') : null;
    if (item.expectedType && actualType !== item.expectedType) fail('MIME_MISMATCH');
    if (!response.body || typeof response.body.getReader !== 'function') fail('MISSING_RESPONSE_BODY');
    reader = response.body.getReader();
    handle = await open(join(outputDir, item.path), 'wx', 0o600);
    const hash = createHash('sha256');
    let bytes = 0;
    while (true) {
      const { done, value } = await abortRace(reader.read(), controller.signal);
      if (done) break;
      if (!(value instanceof Uint8Array)) fail('INVALID_RESPONSE_BODY');
      bytes += value.byteLength;
      if (bytes > item.expectedSize || bytes > STORAGE_CAPTURE_LIMITS.maxObjectBytes) fail('SIZE_MISMATCH');
      hash.update(value);
      let offset = 0;
      while (offset < value.byteLength) {
        const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset);
        if (!bytesWritten) fail('FILE_WRITE_FAILED');
        offset += bytesWritten;
      }
    }
    if (bytes !== item.expectedSize) fail('SIZE_MISMATCH');
    const digest = hash.digest('hex');
    if (item.expectedSha256 && digest !== item.expectedSha256) fail('CHECKSUM_MISMATCH');
    await handle.sync();
    completed = true;
    return { ...item.snapshot, path: item.path, sha256: digest, size: bytes, mimeType: actualType };
  } catch (error) {
    if (error instanceof StorageCaptureError) throw error;
    if (controller.signal.aborted && controller.signal.reason instanceof StorageCaptureError)
      throw controller.signal.reason;
    // Never propagate URL, response body, fetch error, or credential-bearing cause.
    throw new StorageCaptureError('DOWNLOAD_FAILED');
  } finally {
    clearTimeout(timer);
    batchSignal.removeEventListener('abort', onBatchAbort);
    if (!completed) controller.abort(new StorageCaptureError('CAPTURE_CANCELLED'));
    // Do not wait indefinitely for an uncooperative remote stream to cancel.
    if (reader) {
      if (!completed) Promise.resolve(reader.cancel()).catch(() => {});
      try { reader.releaseLock(); } catch { /* A pending read is cancelled by abort. */ }
    }
    if (handle) await handle.close();
  }
}

/** Capture bytes for rows from one consistent PG snapshot into a new private directory.
 * No inventory is written automatically; include the returned value in the encrypted manifest.
 * Storage bytes are not transactional with PG: size/MIME/hash checks detect only covered changes.
 */
export async function captureStorage({ projectRef, expectedProjectRef, serviceKey, objects, outputDir,
  fetchImpl = fetch }) {
  const { prepared, totalBytes } = preflight({ projectRef, expectedProjectRef, serviceKey, objects,
    outputDir, fetchImpl });
  let ownsDirectory = false;
  const batchController = new AbortController();
  let firstError;
  try {
    try { await mkdir(outputDir, { mode: 0o700 }); ownsDirectory = true; }
    catch { fail('OUTPUT_DIRECTORY_UNAVAILABLE'); }
    await mkdir(join(outputDir, 'objects'), { mode: 0o700 });
    const inventory = new Array(prepared.length);
    let cursor = 0;
    const worker = async () => {
      while (!batchController.signal.aborted && cursor < prepared.length) {
        const index = cursor++;
        try {
          inventory[index] = await captureOne(prepared[index], outputDir, serviceKey, fetchImpl,
            batchController.signal);
        } catch (error) {
          firstError ??= error instanceof StorageCaptureError ? error : new StorageCaptureError('CAPTURE_FAILED');
          batchController.abort();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(STORAGE_CAPTURE_LIMITS.concurrency, prepared.length) }, worker));
    if (firstError) throw firstError;
    return { projectRef, objectCount: inventory.length, totalBytes, objects: inventory };
  } catch (error) {
    if (ownsDirectory) {
      try { await rm(outputDir, { recursive: true, force: true }); }
      catch { throw new StorageCaptureError('PRIVATE_OUTPUT_CLEANUP_FAILED'); }
    }
    if (error instanceof StorageCaptureError) throw error;
    throw new StorageCaptureError('CAPTURE_FAILED');
  }
}
