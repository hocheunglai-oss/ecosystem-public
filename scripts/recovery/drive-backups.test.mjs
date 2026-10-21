import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createDriveBackupClient, DriveBackupError, hongKongNight } from './drive-backups.mjs';

const EMAIL = 'backup@example.invalid', FOLDER = 'expected_folder', NOW = '2026-10-21T00:00:00.000Z';
const hash = data => createHash('sha256').update(data).digest('hex');
const bytesFor = text => Buffer.from(`age-encryption.org/v1\nSYNTHETIC_CIPHERTEXT_ONLY_${text}`);
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
const noBody = (status, headers = {}) => new Response(null, { status, headers });
const config = { expectedEmail: EMAIL, folderId: FOLDER, chunkBytes: 256 * 1024, retryLimit: 2 };

function fileRecord(id, night, bytes, overrides = {}) {
  const value = { id, name: `ECO-nightly-${night}.tar.gz.age`, mimeType: 'application/octet-stream', parents: [FOLDER],
    owners: [{ emailAddress: EMAIL }], ownedByMe: true, shared: false, trashed: false, size: String(bytes.length),
    sha256Checksum: hash(bytes), version: '1', capabilities: { canEdit: true, canTrash: true },
    appProperties: { ecoBackupApp: 'eco-nightly-v1', ecoBackupKind: 'nightly-archive', ecoBackupNight: night,
      ecoBackupSha256: hash(bytes), ecoBackupSize: String(bytes.length), ecoBackupStatus: 'verified', ecoBackupFormat: 'age-v1',
      ecoBackupSnapshotAt: `${night}T00:00:00.000Z`, ecoBackupMethod: 'sha256-download-v1', ecoBackupVerifiedAt: `${night}T01:00:00.000Z` },
    ...overrides };
  return { meta: value, bytes: Buffer.from(bytes) };
}
class FakeDrive {
  files = new Map(); sessions = new Map(); calls = []; writes = []; generated = 0; started = 0;
  aboutEmail = EMAIL; quota = '999999999'; pageSize = 1000; permissionExtra = null;
  folder = { id: FOLDER, mimeType: 'application/vnd.google-apps.folder', owners: [{ emailAddress: EMAIL }],
    ownedByMe: true, shared: false, trashed: false, capabilities: { canAddChildren: true, canListChildren: true } };
  add(id, night, bytes = bytesFor(id), overrides) { const record = fileRecord(id, night, bytes, overrides); this.files.set(id, record); return record; }
  cleanProps(input) { return Object.fromEntries(Object.entries(input || {}).filter(([, value]) => value !== null)); }
  async fetch(value, options = {}) {
    const url = new URL(value), method = options.method || 'GET';
    assert.equal(url.origin, 'https://www.googleapis.com'); assert.equal(options.redirect, 'error');
    this.calls.push({ url: value, method });
    if (this.transportFailure) throw new Error('Bearer synthetic-secret; private failure body');
    if (url.pathname === '/drive/v3/about') return json({ user: { emailAddress: this.aboutEmail }, storageQuota: { usage: '1', limit: this.quota } });
    if (url.pathname.endsWith('/permissions')) {
      const own = { id: 'owner', type: 'user', role: 'owner', emailAddress: EMAIL };
      if (this.permissionExtra && !url.searchParams.has('pageToken')) return json({ permissions: [own], nextPageToken: 'permissions2' });
      return json({ permissions: this.permissionExtra ? [this.permissionExtra] : [own] });
    }
    if (url.pathname === '/drive/v3/files/generateIds') return json({ ids: [`generated_${++this.generated}`] });
    if (url.pathname === '/drive/v3/files' && method === 'GET') {
      assert.equal(url.searchParams.get('q'), `'${FOLDER}' in parents and trashed = false`);
      const all = [...this.files.values()].filter(record => !record.meta.trashed && record.meta.parents.includes(FOLDER)).map(record => record.meta);
      const offset = Number(url.searchParams.get('pageToken') || 0), files = all.slice(offset, offset + this.pageSize);
      return json({ files, ...(this.pageLoop ? { nextPageToken: '0' } : offset + this.pageSize < all.length ? { nextPageToken: String(offset + this.pageSize) } : {}) });
    }
    if (url.pathname.startsWith('/upload/drive/v3/files') && !url.searchParams.has('upload_id')) {
      const metadata = JSON.parse(options.body), id = metadata.id || url.pathname.split('/').at(-1);
      this.writes.push({ method, kind: 'start', id }); this.started++;
      if (this.initConflict && this.files.has(id)) return noBody(409);
      const session = { id, metadata, parts: [], received: 0, complete: false, attempt: this.started };
      this.sessions.set(String(this.started), session);
      return noBody(200, { location: this.evilSession || `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${this.started}` });
    }
    if (url.pathname.startsWith('/upload/drive/v3/files') && method === 'PUT') {
      const session = this.sessions.get(url.searchParams.get('upload_id')); assert.ok(session);
      const range = options.headers['Content-Range'];
      if (range.startsWith('bytes */')) {
        if (session.complete) return noBody(200);
        return noBody(308, session.received ? { range: `bytes=0-${session.received - 1}` } : {});
      }
      this.writes.push({ method, kind: 'chunk', id: session.id });
      if (this.failEveryChunk) throw new Error('synthetic disconnected upload');
      if (this.expireFirst && session.attempt === 1) return noBody(404);
      const match = range.match(/^bytes (\d+)-(\d+)\/(\d+)$/u); assert.ok(match);
      assert.equal(Number(match[1]), session.received); assert.equal(Number(match[2]) - Number(match[1]) + 1, options.body.length);
      session.parts.push(Buffer.from(options.body)); session.received += options.body.length;
      if (session.received < Number(match[3])) return noBody(308, { range: `bytes=0-${session.received - 1}` });
      session.complete = true;
      const bytes = Buffer.concat(session.parts), old = this.files.get(session.id);
      const meta = { ...fileRecord(session.id, session.metadata.appProperties.ecoBackupNight, bytes).meta,
        ...(old?.meta || {}), ...session.metadata, id: session.id, size: String(bytes.length), sha256Checksum: hash(bytes),
        appProperties: this.cleanProps(session.metadata.appProperties) };
      this.files.set(session.id, { meta, bytes });
      if (this.postUploadCollision) this.add('collision', session.metadata.appProperties.ecoBackupNight);
      if (this.failAfterComplete) { this.failAfterComplete = false; throw new Error('synthetic lost response after upload'); }
      return noBody(200);
    }
    const id = url.pathname.split('/').at(-1);
    if (id === FOLDER) return json(this.folder);
    const record = this.files.get(id); if (!record) return json({ error: 'not found' }, 404);
    if (method === 'GET' && url.searchParams.get('alt') === 'media') {
      if (this.redirectDownload) return noBody(302, { location: 'https://evil.example/file' });
      return new Response(this.corruptDownload === id ? Buffer.from('corrupt') : record.bytes);
    }
    if (method === 'PATCH') {
      const body = JSON.parse(options.body); this.writes.push({ method, kind: body.trashed ? 'trash' : 'complete', id });
      if (body.trashed && this.failTrash) return json({ error: 'temporary' }, 503);
      record.meta = { ...record.meta, ...body, version: String(Number(record.meta.version) + 1) };
      if (body.appProperties) record.meta.appProperties = this.cleanProps(body.appProperties);
    }
    return json(record.meta);
  }
}
async function fixture(t, bytes = bytesFor('new')) {
  const root = await mkdtemp(join(tmpdir(), 'eco-drive-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const archiveFile = join(root, 'synthetic.tar.gz.age'); await writeFile(archiveFile, bytes, { mode: 0o600 });
  return { archiveFile, expectedSha256: hash(bytes), snapshotAt: NOW };
}
function client(drive, overrides = {}) { return createDriveBackupClient({ authorizedFetch: drive.fetch.bind(drive), config: { ...config, ...overrides }, now: () => new Date(NOW), sleep: async () => {} }); }

test('Hong Kong dates are deterministic across UTC midnight boundaries', () => {
  assert.equal(hongKongNight('2026-10-20T15:59:59Z'), '2026-10-20');
  assert.equal(hongKongNight('2026-10-20T16:00:00Z'), '2026-10-21');
});
test('resumable upload completes only after private target and full downloaded SHA256 verification', async t => {
  const data = Buffer.concat([bytesFor('large'), Buffer.alloc(600_000, 7)]), input = await fixture(t, data), drive = new FakeDrive(), api = client(drive);
  const receipt = await api.uploadAndVerify(input);
  assert.equal(receipt.verified, true); assert.equal(receipt.sha256, input.expectedSha256); assert.equal(receipt.night, '2026-10-21');
  assert.equal(drive.writes.filter(write => write.kind === 'chunk').length, 3);
  assert.equal(drive.files.get(receipt.fileId).meta.appProperties.ecoBackupStatus, 'verified');
  assert.ok(drive.calls.some(call => new URL(call.url).searchParams.get('alt') === 'media'));
  assert.ok(drive.calls.filter(call => new URL(call.url).pathname === '/drive/v3/about').length >= 3);
  assert.equal(drive.writes.some(write => write.kind === 'trash'), false);
});
test('account or folder sharing mismatch blocks every write', async t => {
  const input = await fixture(t);
  for (const mode of ['account', 'folder', 'permissions']) {
    const drive = new FakeDrive();
    if (mode === 'account') drive.aboutEmail = 'wrong@gmail.com';
    if (mode === 'folder') drive.folder.shared = true;
    if (mode === 'permissions') drive.permissionExtra = { id: 'share', type: 'anyone', role: 'reader' };
    await assert.rejects(client(drive).uploadAndVerify(input), { code: mode === 'account' ? 'ACCOUNT_MISMATCH' : mode === 'folder' ? 'OWNER_OR_SHARING_MISMATCH' : 'NONPRIVATE_PERMISSIONS' });
    assert.equal(drive.writes.length, 0);
  }
});
test('quota exhaustion and local size bounds preserve existing files without writes', async t => {
  const input = await fixture(t), drive = new FakeDrive(); drive.quota = '2';
  await assert.rejects(client(drive).uploadAndVerify(input), { code: 'INSUFFICIENT_DRIVE_QUOTA' }); assert.equal(drive.writes.length, 0);
  await assert.rejects(client(new FakeDrive(), { maxArchiveBytes: 20 }).uploadAndVerify(input), { code: 'UNSAFE_LOCAL_ARCHIVE' });
});
test('only ciphertext with the expected local hash can be uploaded', async t => {
  const input = await fixture(t, Buffer.from('ordinary plaintext that must stay local')), drive = new FakeDrive();
  await assert.rejects(client(drive).uploadAndVerify(input), { code: 'AGE_CIPHERTEXT_REQUIRED' }); assert.equal(drive.calls.length, 0);
  await assert.rejects(client(drive).uploadAndVerify({ ...input, expectedSha256: '0'.repeat(64) }), { code: 'LOCAL_HASH_MISMATCH' });
});
test('an unsafe resumable location never receives an authenticated request', async t => {
  const input = await fixture(t), drive = new FakeDrive(); drive.evilSession = 'https://www.googleapis.com.evil.example/upload?upload_id=x';
  await assert.rejects(client(drive).uploadAndVerify(input), { code: 'UNSAFE_GOOGLE_ENDPOINT' });
  assert.equal(drive.writes.some(write => write.kind === 'chunk'), false);
});
test('download redirects and corrupt readback prevent completion metadata', async t => {
  for (const kind of ['redirect', 'corrupt']) {
    const input = await fixture(t), drive = new FakeDrive();
    if (kind === 'redirect') drive.redirectDownload = true; else drive.corruptDownload = 'generated_1';
    await assert.rejects(client(drive).uploadAndVerify(input), { code: kind === 'redirect' ? 'REDIRECT_REJECTED' : 'DOWNLOAD_HASH_MISMATCH' });
    assert.equal(drive.writes.some(write => ['complete', 'trash'].includes(write.kind)), false);
    assert.equal(drive.files.get('generated_1').meta.appProperties.ecoBackupStatus, 'pending');
  }
});
test('a lost final upload response is recovered by querying the same resumable session', async t => {
  const input = await fixture(t), drive = new FakeDrive(); drive.failAfterComplete = true;
  const receipt = await client(drive).uploadAndVerify(input);
  assert.equal(receipt.verified, true); assert.equal(drive.generated, 1); assert.equal(drive.files.size, 1); assert.equal(drive.started, 1);
});
test('expired sessions restart with the same pre-generated file ID', async t => {
  const input = await fixture(t), drive = new FakeDrive(); drive.expireFirst = true;
  const receipt = await client(drive).uploadAndVerify(input);
  assert.equal(receipt.verified, true); assert.equal(drive.generated, 1); assert.equal(drive.started, 2);
  assert.equal(new Set(drive.writes.filter(write => write.kind === 'start').map(write => write.id)).size, 1);
});
test('repeated transport failure is bounded and never triggers retention', async t => {
  const input = await fixture(t), drive = new FakeDrive(); drive.failEveryChunk = true;
  await assert.rejects(client(drive).uploadAndVerify(input), error => error instanceof DriveBackupError && ['UPLOAD_NO_PROGRESS', 'TRANSPORT_FAILED'].includes(error.code));
  assert.ok(drive.writes.filter(write => write.kind === 'chunk').length <= 4);
  assert.equal(drive.writes.some(write => ['complete', 'trash'].includes(write.kind)), false);
});
test('same-night same-hash retry is idempotent; changed ciphertext never overwrites a verified night', async t => {
  const input = await fixture(t), drive = new FakeDrive(), api = client(drive);
  const first = await api.uploadAndVerify(input), writes = drive.writes.length;
  const second = await api.uploadAndVerify(input);
  assert.equal(second.fileId, first.fileId); assert.equal(drive.writes.length, writes);
  const different = await fixture(t, bytesFor('randomized other ciphertext'));
  await assert.rejects(api.uploadAndVerify(different), { code: 'NIGHT_COLLISION' }); assert.equal(drive.writes.length, writes);
  const found = await api.findVerifiedNight({ snapshotAt: NOW }); assert.equal(found.fileId, first.fileId); assert.equal(found.sha256, first.sha256);
});
test('pending complete files recover verification, while corrupt pending files can resume by replacement', async t => {
  const drive = new FakeDrive(), record = drive.add('pending', '2026-10-21');
  record.meta.appProperties.ecoBackupStatus = 'pending'; delete record.meta.appProperties.ecoBackupMethod;
  const api = client(drive), receipt = await api.findVerifiedNight({ snapshotAt: NOW });
  assert.equal(receipt.fileId, 'pending'); assert.equal(drive.generated, 0);
  const broken = new FakeDrive(), pending = broken.add('pending', '2026-10-21');
  pending.meta.appProperties.ecoBackupStatus = 'pending'; pending.bytes = Buffer.from('broken'); pending.meta.size = '6'; pending.meta.sha256Checksum = hash(pending.bytes);
  const brokenApi = client(broken); assert.equal(await brokenApi.findVerifiedNight({ snapshotAt: NOW }), null);
  const completed = await brokenApi.uploadAndVerify(await fixture(t));
  assert.equal(completed.fileId, 'pending'); assert.equal(broken.generated, 0);
  assert.equal(broken.writes.find(write => write.kind === 'start').method, 'PATCH');
});
test('pre-existing or concurrent night collisions never overwrite or prune data', async t => {
  const input = await fixture(t), pre = new FakeDrive();
  pre.add('user_file', '2026-10-21', bytesFor('user'), { appProperties: {} });
  await assert.rejects(client(pre).uploadAndVerify(input), { code: 'NIGHT_NAME_COLLISION' }); assert.equal(pre.writes.length, 0);
  const concurrent = new FakeDrive(); concurrent.postUploadCollision = true;
  await assert.rejects(client(concurrent).uploadAndVerify(input), { code: 'NIGHT_COLLISION' });
  assert.equal(concurrent.writes.some(write => ['complete', 'trash'].includes(write.kind)), false);
});
test('retention paginates, keeps five distinct verified nights, and only trashes older managed archives', async t => {
  const drive = new FakeDrive(); drive.pageSize = 2;
  for (let day = 14; day <= 20; day++) drive.add(`night_${day}`, `2026-10-${day}`);
  drive.add('operator_kit', '2026-10-01', bytesFor('kit'), { name: 'ECO-operator-kit.tar.gz.age', appProperties: { ecoBackupApp: 'eco-nightly-v1', ecoBackupKind: 'operator-kit' } });
  drive.add('unrelated', '2026-09-01', bytesFor('other'), { name: 'unrelated.age', appProperties: {} });
  const api = client(drive), current = await api.uploadAndVerify(await fixture(t));
  const result = await api.retainLatestNights({ currentReceipt: current });
  assert.deepEqual(result.retainedNights, ['2026-10-21', '2026-10-20', '2026-10-19', '2026-10-18', '2026-10-17']);
  assert.deepEqual(result.trashed.map(value => value.night), ['2026-10-16', '2026-10-15', '2026-10-14']);
  assert.equal(result.permanentDeletionUsed, false);
  assert.equal(drive.files.get('operator_kit').meta.trashed, false); assert.equal(drive.files.get('unrelated').meta.trashed, false);
  assert.equal(drive.calls.some(call => call.method === 'DELETE'), false);
  assert.ok(drive.calls.some(call => new URL(call.url).searchParams.has('pageToken')));
});
test('retention cannot run with a forged receipt or fewer than five newer nights', async t => {
  const drive = new FakeDrive(), api = client(drive);
  await assert.rejects(api.retainLatestNights({ currentReceipt: { verified: true, fileId: 'fake' } }), { code: 'CURRENT_VERIFICATION_REQUIRED' });
  for (let day = 17; day <= 20; day++) drive.add(`night_${day}`, `2026-10-${day}`);
  const current = await api.uploadAndVerify(await fixture(t));
  assert.deepEqual((await api.retainLatestNights({ currentReceipt: current })).trashed, []);
});
test('a corrupted newer night or duplicate night preserves every older archive', async t => {
  for (const mode of ['corrupt', 'duplicate']) {
    const drive = new FakeDrive(); for (let day = 14; day <= 20; day++) drive.add(`night_${day}`, `2026-10-${day}`);
    const api = client(drive), receipt = await api.uploadAndVerify(await fixture(t));
    if (mode === 'corrupt') drive.corruptDownload = 'night_20'; else drive.add('duplicate_20', '2026-10-20');
    await assert.rejects(api.retainLatestNights({ currentReceipt: receipt }), { code: mode === 'corrupt' ? 'DOWNLOAD_HASH_MISMATCH' : 'RETENTION_NIGHT_COLLISION' });
    assert.equal(drive.writes.some(write => write.kind === 'trash'), false);
  }
});
test('pagination loops fail closed without writes', async t => {
  const drive = new FakeDrive(); drive.pageLoop = true;
  await assert.rejects(client(drive).uploadAndVerify(await fixture(t)), { code: 'PAGINATION_LOOP' }); assert.equal(drive.writes.length, 0);
});
test('transport diagnostics never expose opaque OAuth-client errors', async () => {
  const drive = new FakeDrive(); drive.transportFailure = true;
  await assert.rejects(client(drive).verifyTarget(), error => {
    assert.equal(error.code, 'TRANSPORT_FAILED'); assert.equal(error.cause, undefined);
    assert.equal(String(error.stack).includes('synthetic-secret'), false); return true;
  });
  assert.equal(drive.calls.length, 3);
});
test('loss of the caller lock during upload blocks the next chunk and completion', async t => {
  const input = await fixture(t, Buffer.concat([bytesFor('lock-loss'), Buffer.alloc(600_000, 5)]));
  const drive = new FakeDrive(); let alive = true;
  const api = createDriveBackupClient({ config, now: () => new Date(NOW), sleep: async () => {},
    beforeMutation: async () => { if (!alive) throw new Error('private lock diagnostic'); },
    authorizedFetch: async (url, options) => {
      const response = await drive.fetch(url, options);
      if (drive.writes.some(write => write.kind === 'chunk')) alive = false;
      return response;
    },
  });
  await assert.rejects(api.uploadAndVerify(input), error => error.code === 'MUTATION_AUTHORIZATION_FAILED'
    && !String(error).includes('private lock diagnostic'));
  assert.equal(drive.writes.filter(write => write.kind === 'chunk').length, 1);
  assert.equal(drive.writes.some(write => write.kind === 'complete'), false);
});
test('retention retry revalidates the lock and preserves older files if it was lost', async () => {
  const drive = new FakeDrive(); for (let day = 15; day <= 21; day++) drive.add(`night_${day}`, `2026-10-${day}`);
  let alive = true;
  const api = createDriveBackupClient({ config, now: () => new Date(NOW), sleep: async () => {},
    beforeMutation: async () => { if (!alive) throw new Error('private lock diagnostic'); },
    authorizedFetch: async (url, options) => {
      const response = await drive.fetch(url, options);
      if (drive.writes.some(write => write.kind === 'trash')) alive = false;
      return response;
    },
  });
  const receipt = await api.findVerifiedNight({ snapshotAt: NOW });
  drive.failTrash = true;
  await assert.rejects(api.retainLatestNights({ currentReceipt: receipt }), { code: 'MUTATION_AUTHORIZATION_FAILED' });
  assert.equal(drive.writes.filter(write => write.kind === 'trash').length, 1);
  assert.equal([...drive.files.values()].some(record => record.meta.trashed), false);
});
