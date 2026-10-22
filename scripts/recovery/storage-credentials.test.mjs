import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStorageCapture } from './storage-credentials.mjs';

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
    assert.equal(f.calls.length, 1);
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
