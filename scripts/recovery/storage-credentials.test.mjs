import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AUTHORIZATION_DIAGNOSTIC_CODES, createStorageCapture } from './storage-credentials.mjs';

const target = { productionOrigin: 'https://eco.example.invalid', supabaseProjectRef: 'abcdefghijklmnopqrst',
  supplierReportsBucket: 'eco-supplier-reports', backup: { storagePath: '/api/backup/storage-downloads' } };
const bytes = Buffer.from('%PDF-1.7\nSynthetic recovery fixture\n%%EOF\n');
const digest = createHash('sha256').update(bytes).digest('hex');
const makeObject = (n = 1) => ({ id: `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`,
  bucket_id: target.supplierReportsBucket,
  name: `22222222-2222-4222-8222-222222222222/11111111-1111-4111-8111-${String(n).padStart(12, '0')}/${digest}.pdf`,
  metadata: { size: bytes.length, mimetype: 'application/pdf' }, version: 'version-1', updated_at: '2026-01-01T00:00:00Z', expectedSha256: digest });
const secrets = { oidcRequestUrl: 'https://run.actions.githubusercontent.com/idtoken?api-version=2', oidcRequestToken: 'synthetic-job-credential' };
const now = () => 1_800_000_000_000;
function fixture({ mutateManifest, downloadBytes = bytes, downloadHeaders, error, redirect } = {}) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push({ url: String(input), init });
    assert.equal(init.redirect, 'error'); assert.ok(init.signal);
    if (init.signal.aborted) throw Error('cancelled synthetic secret');
    if (String(input).startsWith('https://run.actions.githubusercontent.com/')) {
      assert.equal(new URL(input).searchParams.get('audience'), target.productionOrigin + target.backup.storagePath);
      assert.equal(init.headers.Authorization, `Bearer ${secrets.oidcRequestToken}`);
      const value = 'eyJhbGciOiJSUzI1NiJ9.' + Buffer.from(JSON.stringify({ exp: now() / 1000 + 300 })).toString('base64url') + '.c2lnbmF0dXJl';
      return Response.json({ value });
    }
    if (input === target.productionOrigin + target.backup.storagePath) {
      if (error) return new Response('provider secret token and private data', { status: 503 });
      assert.match(init.headers.Authorization, /^Bearer ey/);
      assert.equal(init.headers.apikey, undefined);
      const item = JSON.parse(init.body).objects[0];
      const entry = { ...item, sha256: digest, expiresAt: new Date(now() + 300_000).toISOString(),
        url: `https://${target.supabaseProjectRef}.supabase.co/storage/v1/object/sign/${item.bucketId}/${item.path}?token=synthetic-link` };
      return Response.json(mutateManifest ? mutateManifest(entry) : { schemaVersion: 1, projectRef: target.supabaseProjectRef, objects: [entry] });
    }
    assert.match(input, new RegExp(`^https://${target.supabaseProjectRef}\\.supabase\\.co/storage/v1/object/sign/`));
    assert.deepEqual(init.headers, { 'Accept-Encoding': 'identity' });
    if (redirect) return new Response(null, { status: 302, headers: { location: 'https://attacker.invalid' } });
    return new Response(downloadBytes, { headers: { 'Content-Type': 'application/pdf', ...downloadHeaders } });
  };
  return { fetchImpl, calls };
}
async function directory(run) {
  const parent = await mkdtemp(join(tmpdir(), 'eco-signed-capture-test-'));
  try { await run(join(parent, 'capture')); } finally { await rm(parent, { recursive: true, force: true }); }
}

test('signed capture obtains one job token, downloads exact inventory privately and never forwards administrative credentials', async () => {
  await directory(async outputDir => {
    const f = fixture(), capture = createStorageCapture({ target, secrets, fetchImpl: f.fetchImpl, now });
    const result = await capture([makeObject(1), makeObject(2)], outputDir);
    assert.equal(result.objectCount, 2); assert.equal(result.totalBytes, bytes.length * 2);
    for (const object of result.objects) {
      assert.equal(object.sha256, digest); assert.equal(object.size, bytes.length);
      assert.deepEqual(await readFile(join(outputDir, object.path)), bytes);
      assert.equal((await stat(join(outputDir, object.path))).mode & 0o777, 0o600);
    }
    assert.equal(f.calls.filter(call => call.url.startsWith('https://run.actions.githubusercontent.com')).length, 1);
    assert.equal(f.calls.filter(call => call.url === target.productionOrigin + target.backup.storagePath).length, 2);
    assert.doesNotMatch(JSON.stringify(f.calls), /signed-download-transport|apikey/);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-link|synthetic-job-credential|eyJhb/);
  });
});

test('unexpected inventory is rejected before network, including other buckets and non-immutable paths', async () => {
  for (const change of [{ bucket_id: 'other' }, { name: '../private.pdf' }, { name: makeObject().name + '?x=1' },
    { expectedSha256: 'b'.repeat(64) }, { metadata: { size: bytes.length, mimetype: 'text/html' } },
    { version: '../wrong' }, { metadata: { size: 21 * 1024 ** 2, mimetype: 'application/pdf' } }]) {
    const f = fixture(), capture = createStorageCapture({ target, secrets, fetchImpl: f.fetchImpl, now });
    await assert.rejects(capture([{ ...makeObject(), ...change }], join(tmpdir(), 'unused-backup-test-output')));
    assert.equal(f.calls.length, 0);
  }
  for (const url of ['https://attacker.invalid/idtoken', 'http://run.actions.githubusercontent.com/idtoken',
    'https://run.actions.githubusercontent.com.attacker.invalid/idtoken', 'https://user@run.actions.githubusercontent.com/idtoken']) {
    assert.throws(() => createStorageCapture({ target, secrets: { ...secrets, oidcRequestUrl: url } }));
  }
  assert.throws(() => createStorageCapture({ target, secrets: { serviceKey: 'not-allowed' } }));
});

test('wrong manifest identity, extra objects, altered paths, expiry and external signed links fail closed with cleanup', async () => {
  const changes = [entry => ({ ...entry, id: 'other' }), entry => ({ ...entry, version: 'other' }),
    entry => ({ ...entry, sha256: 'b'.repeat(64) }), entry => ({ ...entry, expiresAt: new Date(now() - 1).toISOString() }),
    entry => ({ ...entry, url: 'https://attacker.invalid/download' }),
    entry => ({ ...entry, url: entry.url + '&upload=1' }),
    entry => ({ ...entry, url: entry.url.replace('/object/sign/', '/object/authenticated/') })];
  for (const change of changes) {
    await directory(async outputDir => {
      const f = fixture({ mutateManifest: entry => ({ schemaVersion: 1, projectRef: target.supabaseProjectRef, objects: [change(entry)] }) });
      await assert.rejects(createStorageCapture({ target, secrets, fetchImpl: f.fetchImpl, now })([makeObject()], outputDir));
      await assert.rejects(stat(outputDir), { code: 'ENOENT' });
      assert.equal(f.calls.length, 2);
    });
  }
  for (const mutateManifest of [entry => ({ schemaVersion: 1, projectRef: 'other', objects: [entry] }),
    entry => ({ schemaVersion: 1, projectRef: target.supabaseProjectRef, objects: [entry, entry] })]) {
    await directory(async outputDir => {
      const f = fixture({ mutateManifest });
      await assert.rejects(createStorageCapture({ target, secrets, fetchImpl: f.fetchImpl, now })([makeObject()], outputDir));
      await assert.rejects(stat(outputDir), { code: 'ENOENT' });
    });
  }
});

test('signed downloads retain size/MIME/hash validation, reject redirects and redact provider failures', async () => {
  for (const options of [{ downloadBytes: Buffer.from('wrong') }, { downloadBytes: Buffer.alloc(bytes.length) },
    { downloadHeaders: { 'Content-Type': 'text/html' } }, { redirect: true }, { error: true }]) {
    await directory(async outputDir => {
      const f = fixture(options);
      await assert.rejects(createStorageCapture({ target, secrets, fetchImpl: f.fetchImpl, now })([makeObject()], outputDir), error => {
        assert.doesNotMatch(error.message, /synthetic-link|private data|provider secret|eyJhb/); return true;
      });
      await assert.rejects(stat(outputDir), { code: 'ENOENT' });
    });
  }
});

test('an aborted backup cancels outbound authorization and leaves no partial directory', async () => {
  await directory(async outputDir => {
    const controller = new AbortController(); controller.abort(); const f = fixture();
    await assert.rejects(createStorageCapture({ target, secrets, signal: controller.signal, fetchImpl: f.fetchImpl, now })([makeObject()], outputDir));
    await assert.rejects(stat(outputDir), { code: 'ENOENT' });
    assert.equal(f.calls.length, 0);
  });
});

test('temporary signing service and job-token failures retry a bounded number of times and retain byte validation', async () => {
  for (const stage of ['OIDC', 'STORAGE_AUTH']) for (const status of [408, 429, 500, 502, 503, 504, 'network']) {
    await directory(async outputDir => {
      const f = fixture(), sleeps = []; let attempts = 0;
      const fetchImpl = async (url, init) => {
        const selected = stage === 'OIDC' ? String(url).startsWith('https://run.actions.githubusercontent.com/') : url === target.productionOrigin + target.backup.storagePath;
        if (selected && ++attempts < 3) {
          if (status === 'network') throw new TypeError('private provider URL and token');
          return new Response('private provider response', { status });
        }
        return f.fetchImpl(url, init);
      };
      const result = await createStorageCapture({ target, secrets, fetchImpl, now, sleep: async ms => { sleeps.push(ms); } })([makeObject()], outputDir);
      assert.equal(attempts, 3); assert.deepEqual(sleeps, [500, 1000]);
      assert.equal(result.objects[0].sha256, digest); assert.deepEqual(await readFile(join(outputDir, result.objects[0].path)), bytes);
      assert.doesNotMatch(JSON.stringify(result), /private provider|token|synthetic-link/);
    });
  }
});

test('permanent HTTP failures never retry and safe diagnostics identify the exact stage and status', async () => {
  for (const stage of ['OIDC', 'STORAGE_AUTH']) for (const status of [400, 401, 403, 404, 405, 409, 413, 418]) {
    await directory(async outputDir => {
      const f = fixture(); let attempts = 0;
      const fetchImpl = async (url, init) => {
        const selected = stage === 'OIDC' ? String(url).startsWith('https://run.actions.githubusercontent.com/') : url === target.productionOrigin + target.backup.storagePath;
        if (selected) { attempts++; return new Response('secret-key private report token=abc', { status }); }
        return f.fetchImpl(url, init);
      };
      const code = `${stage}_HTTP_${status === 418 ? 'OTHER' : status}`;
      assert.ok(AUTHORIZATION_DIAGNOSTIC_CODES.includes(code));
      await assert.rejects(createStorageCapture({ target, secrets, fetchImpl, now, sleep: async () => assert.fail('Permanent failure retried') })([makeObject()], outputDir), error => {
        assert.equal(error.code, code); assert.doesNotMatch(error.message, /secret-key|private report|token=/); return true;
      });
      assert.equal(attempts, 1); await assert.rejects(stat(outputDir), { code: 'ENOENT' });
    });
  }
});

test('each signing retry refreshes a job token that entered its expiry margin during the previous attempt', async () => {
  await directory(async outputDir => {
    const f = fixture(), authorizations = []; let clock = now(), tokenRequests = 0;
    const fetchImpl = async (url, init) => {
      if (String(url).startsWith('https://run.actions.githubusercontent.com/')) {
        tokenRequests++;
        assert.equal(new URL(url).searchParams.get('audience'), target.productionOrigin + target.backup.storagePath);
        assert.equal(init.headers.Authorization, `Bearer ${secrets.oidcRequestToken}`);
        const value = 'eyJhbGciOiJSUzI1NiJ9.' + Buffer.from(JSON.stringify({ exp: clock / 1000 + 65 })).toString('base64url') + '.c2lnbmF0dXJl';
        return Response.json({ value });
      }
      if (url === target.productionOrigin + target.backup.storagePath) {
        authorizations.push(init.headers.Authorization);
        const claims = JSON.parse(Buffer.from(init.headers.Authorization.split('.')[1], 'base64url').toString());
        assert.ok(claims.exp * 1000 > clock + 60_000);
        if (authorizations.length < 3) { clock += 30_000; return new Response('temporary upstream failure', { status: 503 }); }
      }
      return f.fetchImpl(url, init);
    };
    const result = await createStorageCapture({ target, secrets, fetchImpl, now: () => clock, sleep: async () => {} })([makeObject()], outputDir);
    assert.equal(tokenRequests, 3); assert.equal(new Set(authorizations).size, 3);
    assert.equal(result.objects[0].sha256, digest);
  });
});

test('persistent transient failure stops after three attempts and malformed successes are not retried', async () => {
  for (const mode of ['503', 'network', 'json', 'large', 'redirect']) {
    await directory(async outputDir => {
      const f = fixture(); let attempts = 0;
      const fetchImpl = async (url, init) => {
        if (url !== target.productionOrigin + target.backup.storagePath) return f.fetchImpl(url, init);
        attempts++;
        if (mode === 'network') throw new TypeError('private token');
        if (mode === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://attacker.invalid' } });
        return new Response(mode === 'large' ? 'x'.repeat(33_000) : 'private invalid JSON', { status: mode === '503' ? 503 : 200, headers: { 'Content-Type': 'application/json' } });
      };
      const suffix = { '503':'HTTP_503', network:'TRANSPORT_FAILED', json:'RESPONSE_INVALID', large:'RESPONSE_TOO_LARGE', redirect:'HTTP_OTHER' }[mode];
      await assert.rejects(createStorageCapture({ target, secrets, fetchImpl, now, sleep: async () => {} })([makeObject()], outputDir), { code: `STORAGE_AUTH_${suffix}` });
      assert.equal(attempts, ['503', 'network'].includes(mode) ? 3 : 1);
      await assert.rejects(stat(outputDir), { code: 'ENOENT' });
    });
  }
});

test('cancelling during retry backoff prevents another request and cleans partial output', async () => {
  await directory(async outputDir => {
    const controller = new AbortController(), f = fixture(); let attempts = 0;
    const fetchImpl = async (url, init) => {
      if (url !== target.productionOrigin + target.backup.storagePath) return f.fetchImpl(url, init);
      attempts++; return new Response('private provider response', { status: 503 });
    };
    await assert.rejects(createStorageCapture({ target, secrets, fetchImpl, now, signal: controller.signal,
      sleep: async () => controller.abort() })([makeObject()], outputDir), { code: 'CAPTURE_CANCELLED' });
    assert.equal(attempts, 1); await assert.rejects(stat(outputDir), { code: 'ENOENT' });
  });
});

test('mixed protected reports and managed general pending/active originals are captured and checksummed',async()=>{
 await directory(async output=>{
  const expanded={...target,profileAttachmentsBucket:'eco-profile-attachments'};
  const general={...makeObject(2),bucket_id:expanded.profileAttachmentsBucket,name:'22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333.bin',attachmentState:'active',metadata:{size:bytes.length,mimetype:'application/pdf'}};
  const f=fixture();const capture=createStorageCapture({target:expanded,secrets,now,fetchImpl:f.fetchImpl});
  const result=await capture([makeObject(),general],output);assert.equal(result.objects.length,2);
 });
 await directory(async output=>{
  const expanded={...target,profileAttachmentsBucket:'eco-profile-attachments'},general={...makeObject(2),bucket_id:expanded.profileAttachmentsBucket,name:'22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333.bin',attachmentState:'pending'};delete general.expectedSha256;
  const f=fixture({mutateManifest:entry=>({schemaVersion:1,projectRef:target.supabaseProjectRef,objects:[{...entry,sha256:null}]})});
  const result=await createStorageCapture({target:expanded,secrets,now,fetchImpl:f.fetchImpl})([general],output);assert.equal(result.objects[0].sha256,digest);
 });
 for(const state of [undefined,'active','unknown']){
  const expanded={...target,profileAttachmentsBucket:'eco-profile-attachments'},general={...makeObject(2),bucket_id:expanded.profileAttachmentsBucket,name:'22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333.bin',attachmentState:state};delete general.expectedSha256;
  const f=fixture();await assert.rejects(createStorageCapture({target:expanded,secrets,now,fetchImpl:f.fetchImpl})([general],'/unused'));assert.equal(f.calls.length,0);
 }
});
