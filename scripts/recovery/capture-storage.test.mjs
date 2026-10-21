import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureStorage, StorageCaptureError, STORAGE_CAPTURE_LIMITS } from './capture-storage.mjs';

const REF = 'abcdefghijklmnopqrst';
const KEY = 'synthetic-test-key-never-a-real-credential';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const object = (overrides = {}) => ({
  id: 'synthetic-id', bucket_id: 'private-pdfs', name: 'reports/company background.pdf',
  metadata: { size: 3, mimetype: 'application/pdf' },
  updated_at: '2026-10-21T00:00:00Z', version: 'synthetic-version', ...overrides,
});
const response = (body = 'PDF', options = {}) => new Response(body, {
  status: 200, headers: { 'content-type': 'application/pdf' }, ...options,
});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'eco-storage-unit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, outputDir: join(root, 'capture') };
}
function args(outputDir, overrides = {}) {
  return { projectRef: REF, expectedProjectRef: REF, serviceKey: KEY,
    objects: [object()], outputDir, fetchImpl: async () => response(), ...overrides };
}
function isCode(code) {
  return (error) => error instanceof StorageCaptureError && error.code === code
    && !error.message.includes(KEY) && !error.message.includes('company background');
}
async function absent(path) {
  await assert.rejects(stat(path), { code: 'ENOENT' });
}

test('captures original bytes and reversible private inventory using an exact authenticated target', async (t) => {
  const { outputDir } = await fixture(t);
  const source = object({ name: 'reports/船 company?x=1#part.pdf', expectedSha256: digest('PDF') });
  let requests = 0;
  const inventory = await captureStorage(args(outputDir, {
    objects: [source],
    fetchImpl: async (url, options) => {
      requests++;
      assert.equal(url,
        `https://${REF}.supabase.co/storage/v1/object/authenticated/private-pdfs/reports/%E8%88%B9%20company%3Fx%3D1%23part.pdf`);
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.apikey, KEY);
      assert.equal(options.headers.Authorization, `Bearer ${KEY}`);
      assert.equal(options.headers['Accept-Encoding'], 'identity');
      return response('PDF', { headers: { 'content-length': '3', 'content-type': 'Application/PDF; charset=binary' } });
    },
  }));
  assert.equal(requests, 1);
  assert.equal(inventory.objectCount, 1);
  assert.equal(inventory.totalBytes, 3);
  const entry = inventory.objects[0];
  assert.equal(entry.name, source.name);
  assert.equal(entry.bucket_id, source.bucket_id);
  assert.equal(entry.version, source.version);
  assert.deepEqual(entry.metadata, source.metadata);
  assert.equal(entry.sha256, digest('PDF'));
  assert.equal(entry.mimeType, 'application/pdf');
  assert.match(entry.path, /^objects\/[a-f0-9]{64}\.bin$/u);
  assert.equal((await readFile(join(outputDir, entry.path))).toString(), 'PDF');
  assert.equal((await stat(outputDir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(outputDir, 'objects'))).mode & 0o777, 0o700);
  assert.equal((await stat(join(outputDir, entry.path))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(outputDir), ['objects']);
});

test('target mismatch prevents network and filesystem access', async (t) => {
  const { outputDir } = await fixture(t);
  let called = false;
  await assert.rejects(captureStorage(args(outputDir, {
    expectedProjectRef: 'zyxwvutsrqponmlkjihg', fetchImpl: async () => { called = true; },
  })), isCode('TARGET_MISMATCH'));
  assert.equal(called, false);
  await absent(outputDir);
});

test('rejects redirect status without exposing its location or error body', async (t) => {
  const { outputDir } = await fixture(t);
  await assert.rejects(captureStorage(args(outputDir, {
    fetchImpl: async () => response(`${KEY}: private detail`, {
      status: 302, headers: { location: 'https://untrusted.example/steal' },
    }),
  })), isCode('REDIRECT_REJECTED'));
  await absent(outputDir);
});

test('rejects already-followed or substituted response targets', async (t) => {
  for (const fields of [{ redirected: true }, { url: 'https://untrusted.example/file' }]) {
    const { outputDir } = await fixture(t);
    const reply = response();
    for (const [key, value] of Object.entries(fields)) Object.defineProperty(reply, key, { value });
    await assert.rejects(captureStorage(args(outputDir, { fetchImpl: async () => reply })),
      isCode(fields.redirected ? 'REDIRECT_REJECTED' : 'RESPONSE_TARGET_MISMATCH'));
    await absent(outputDir);
  }
});

test('missing files fail the whole capture and leave no partial directory', async (t) => {
  const { outputDir } = await fixture(t);
  await assert.rejects(captureStorage(args(outputDir, {
    fetchImpl: async () => response('secret details', { status: 404 }),
  })), isCode('OBJECT_NOT_FOUND'));
  await absent(outputDir);
});

test('detects oversized and truncated bodies even without Content-Length', async (t) => {
  for (const bytes of ['PD', 'PDFF']) {
    const { outputDir } = await fixture(t);
    await assert.rejects(captureStorage(args(outputDir, { fetchImpl: async () => response(bytes) })),
      isCode('SIZE_MISMATCH'));
    await absent(outputDir);
  }
});

test('rejects Content-Length mismatch before writing bytes', async (t) => {
  const { outputDir } = await fixture(t);
  await assert.rejects(captureStorage(args(outputDir, {
    fetchImpl: async () => response('PDF', { headers: { 'content-type': 'application/pdf', 'content-length': '99' } }),
  })), isCode('SIZE_MISMATCH'));
  await absent(outputDir);
});

test('path traversal and ambiguous encoded paths fail before fetching', async (t) => {
  const paths = ['../file', '/root/file', 'dir/../file', 'dir/./file', 'dir//file', 'dir\\file',
    'dir/%2e%2e/file', 'dir/%252e%252e/file', 'dir/%2Ffile', 'dir/\0file', ''];
  for (const name of paths) {
    const { outputDir } = await fixture(t);
    let called = false;
    await assert.rejects(captureStorage(args(outputDir, {
      objects: [object({ name })], fetchImpl: async () => { called = true; },
    })), isCode('INVALID_OBJECT_PATH'));
    assert.equal(called, false);
    await absent(outputDir);
  }
});

test('bucket traversal and foreign-host syntax cannot influence destination', async (t) => {
  for (const bucket_id of ['..', 'private/../../object', '//untrusted.example', 'private\\files']) {
    const { outputDir } = await fixture(t);
    let called = false;
    await assert.rejects(captureStorage(args(outputDir, {
      objects: [object({ bucket_id })], fetchImpl: async () => { called = true; },
    })), isCode('INVALID_OBJECT_PATH'));
    assert.equal(called, false);
  }
});

test('checksum mismatch detects equal-length object replacement', async (t) => {
  const { outputDir } = await fixture(t);
  await assert.rejects(captureStorage(args(outputDir, {
    objects: [object({ expectedSha256: digest('OLD') })],
  })), isCode('CHECKSUM_MISMATCH'));
  await absent(outputDir);
});

test('MIME mismatch and missing expected MIME fail closed', async (t) => {
  for (const headers of [{ 'content-type': 'text/plain' }, {}]) {
    const { outputDir } = await fixture(t);
    await assert.rejects(captureStorage(args(outputDir, {
      fetchImpl: async () => new Response(new Uint8Array([80, 68, 70]), { headers }),
    })), isCode('MIME_MISMATCH'));
    await absent(outputDir);
  }
});

test('zero-object snapshot succeeds without a request', async (t) => {
  const { outputDir } = await fixture(t);
  let called = false;
  const result = await captureStorage(args(outputDir, {
    objects: [], fetchImpl: async () => { called = true; },
  }));
  assert.deepEqual(result, { projectRef: REF, objectCount: 0, totalBytes: 0, objects: [] });
  assert.deepEqual(await readdir(join(outputDir, 'objects')), []);
  assert.equal(called, false);
});

test('zero-byte object is retained with an empty-content checksum', async (t) => {
  const { outputDir } = await fixture(t);
  const result = await captureStorage(args(outputDir, {
    objects: [object({ metadata: { size: 0, mimetype: 'application/pdf' } })],
    fetchImpl: async () => response(new Uint8Array()),
  }));
  assert.equal(result.objects[0].sha256, digest(''));
  assert.equal((await stat(join(outputDir, result.objects[0].path))).size, 0);
});

test('duplicate keys or IDs fail before fetching or creating output', async (t) => {
  for (const second of [object({ id: 'different-id' }), object({ name: 'different.pdf' })]) {
    const { outputDir } = await fixture(t);
    let called = false;
    await assert.rejects(captureStorage(args(outputDir, {
      objects: [object(), second], fetchImpl: async () => { called = true; },
    })), isCode('DUPLICATE_OBJECT'));
    assert.equal(called, false);
    await absent(outputDir);
  }
});

test('pre-existing output is never overwritten or removed', async (t) => {
  const { root } = await fixture(t);
  const sentinel = join(root, 'do-not-delete');
  await writeFile(sentinel, 'operator evidence');
  await assert.rejects(captureStorage(args(root)), isCode('OUTPUT_DIRECTORY_UNAVAILABLE'));
  assert.equal(await readFile(sentinel, 'utf8'), 'operator evidence');
});

test('one failed concurrent download aborts pending requests and deletes completed files', async (t) => {
  const { outputDir } = await fixture(t);
  const inputs = Array.from({ length: 8 }, (_, i) => object({ id: `id-${i}`, name: `${i}.pdf` }));
  let active = 0;
  let maxActive = 0;
  let aborted = 0;
  const result = captureStorage(args(outputDir, {
    objects: inputs,
    fetchImpl: (url, { signal }) => {
      active++;
      maxActive = Math.max(maxActive, active);
      const index = Number(new URL(url).pathname.match(/\/(\d+)\.pdf$/u)[1]);
      if (index === 0) { active--; return Promise.resolve(response()); }
      if (index === 1) return new Promise((resolve) => setImmediate(() => {
        active--; resolve(response('gone', { status: 404 }));
      }));
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => { active--; aborted++; reject(new Error('cancelled')); }, { once: true });
      });
    },
  }));
  await assert.rejects(result, isCode('OBJECT_NOT_FOUND'));
  assert.ok(maxActive <= STORAGE_CAPTURE_LIMITS.concurrency);
  assert.ok(aborted > 0);
  assert.equal(active, 0);
  await absent(outputDir);
});

test('deadline handles a fetch that ignores AbortSignal', async (t) => {
  const { outputDir } = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let announceFetch;
  const started = new Promise((resolve) => { announceFetch = resolve; });
  const pending = captureStorage(args(outputDir, {
    fetchImpl: () => { announceFetch(); return new Promise(() => {}); },
  }));
  const rejected = assert.rejects(pending, isCode('DOWNLOAD_TIMEOUT'));
  await started;
  t.mock.timers.tick(STORAGE_CAPTURE_LIMITS.requestTimeoutMs);
  await rejected;
  await absent(outputDir);
});

test('untrusted transport failures do not expose secrets or response text', async (t) => {
  const { outputDir } = await fixture(t);
  await assert.rejects(captureStorage(args(outputDir, {
    fetchImpl: async () => { throw new Error(`Authorization: Bearer ${KEY}; company background.pdf`); },
  })), (error) => {
    assert.equal(error.code, 'DOWNLOAD_FAILED');
    assert.equal(error.cause, undefined);
    assert.ok(!String(error.stack).includes(KEY));
    return true;
  });
  await absent(outputDir);
});

test('snapshot metadata is not altered by caller edits during the request', async (t) => {
  const { outputDir } = await fixture(t);
  const original = object();
  const result = await captureStorage(args(outputDir, {
    objects: [original], fetchImpl: async () => {
      original.name = 'changed.pdf'; original.metadata.size = 9;
      return response();
    },
  }));
  assert.equal(result.objects[0].name, 'reports/company background.pdf');
  assert.equal(result.objects[0].metadata.size, 3);
});
