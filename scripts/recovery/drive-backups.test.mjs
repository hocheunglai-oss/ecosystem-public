import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createDriveBackupClient, DriveBackupError, DRIVE_BACKUP_DIAGNOSTIC_CODES, classifyDriveBackupError, hongKongNight } from './drive-backups.mjs';

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
  files = new Map(); sessions = new Map(); calls = []; writes = []; generated = 0; started = 0; metadataReads = 0;
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
    if (method === 'GET') {
      this.metadataReads++;
      this.onMetadataRead?.(record.meta, this.metadataReads);
      if (this.reorderMetadata && this.metadataReads % 2 === 0) {
        return json({ ...record.meta, appProperties: Object.fromEntries(Object.entries(record.meta.appProperties).reverse()) });
      }
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
test('reordered Google property maps preserve successful readback, same-night recovery and retention', async t => {
  const input = await fixture(t), drive = new FakeDrive(); drive.reorderMetadata = true;
  const api = client(drive), uploaded = await api.uploadAndVerify(input);
  assert.equal(uploaded.verified, true); assert.equal(uploaded.sha256, input.expectedSha256);
  const chunks = drive.writes.filter(write => write.kind === 'chunk').length;
  const recovered = await api.findVerifiedNight({ snapshotAt: input.snapshotAt });
  assert.equal(recovered.fileId, uploaded.fileId); assert.equal(recovered.verified, true);
  assert.equal(drive.writes.filter(write => write.kind === 'chunk').length, chunks);
  const retained = await api.retainLatestNights({ currentReceipt: recovered });
  assert.deepEqual(retained.retainedNights, ['2026-10-21']); assert.deepEqual(retained.trashed, []);
});
test('reordering does not hide real metadata, content hash, ownership or folder changes during readback', async t => {
  const input = await fixture(t);
  const changes = [
    [meta => { meta.size = String(Number(meta.size) + 1); }, 'REMOTE_ARCHIVE_METADATA_CHANGED'],
    [meta => { meta.sha256Checksum = 'b'.repeat(64); }, 'REMOTE_CHECKSUM_CHANGED'],
    [meta => { meta.appProperties.ecoBackupSha256 = 'b'.repeat(64); }, 'REMOTE_ARCHIVE_METADATA_CHANGED'],
    [meta => { meta.appProperties.additionalMetadata = 'changed'; }, 'REMOTE_ARCHIVE_METADATA_CHANGED'],
    [meta => { meta.parents = ['other_folder']; }, 'FILE_SCOPE_MISMATCH'],
    [meta => { meta.shared = true; }, 'OWNER_OR_SHARING_MISMATCH'],
    [meta => { meta.owners = [{ emailAddress: 'other@example.invalid' }]; }, 'OWNER_OR_SHARING_MISMATCH'],
  ];
  for (const [change, code] of changes) {
    const drive = new FakeDrive(); drive.reorderMetadata = true;
    drive.onMetadataRead = (meta, count) => { if (count === 2) change(meta); };
    await assert.rejects(client(drive).uploadAndVerify(input), { code });
    assert.equal(drive.writes.some(write => ['complete', 'trash'].includes(write.kind)), false);
    assert.equal(drive.files.get('generated_1').meta.appProperties.ecoBackupStatus, 'pending');
  }
});
test('a property value change after readback still blocks marking the archive verified', async t => {
  const input = await fixture(t), drive = new FakeDrive(); drive.reorderMetadata = true;
  drive.onMetadataRead = (meta, count) => { if (count === 3) meta.appProperties.additionalMetadata = 'changed-after-readback'; };
  await assert.rejects(client(drive).uploadAndVerify(input), { code: 'REMOTE_CHANGED_BEFORE_COMPLETION' });
  assert.equal(drive.writes.some(write => ['complete', 'trash'].includes(write.kind)), false);
});
const mediaReads = drive => drive.calls.filter(call => new URL(call.url).searchParams.get('alt') === 'media').length;
test('server version or newly available checksum must settle over a second complete readback before completion', async t => {
  for (const change of ['version', 'checksum', 'both']) {
    const input = await fixture(t), drive = new FakeDrive();
    drive.onMetadataRead = (meta, count) => {
      if (count === 1 && change !== 'version') delete meta.sha256Checksum;
      if (count === 2) {
        if (change !== 'checksum') meta.version = '2';
        if (change !== 'version') meta.sha256Checksum = input.expectedSha256;
      }
    };
    const result = await client(drive).uploadAndVerify(input);
    assert.equal(result.verified, true); assert.equal(result.sha256, input.expectedSha256);
    assert.equal(mediaReads(drive), 2); assert.equal(drive.started, 1);
    assert.equal(drive.writes.filter(write => write.kind === 'complete').length, 1);
    assert.equal(drive.writes.some(write => write.kind === 'trash'), false);
  }
});
test('an existing pending archive settles and recovers without new upload or different ciphertext', async () => {
  const drive = new FakeDrive(), existing = drive.add('pending', '2026-10-21');
  existing.meta.appProperties.ecoBackupStatus = 'pending';
  drive.onMetadataRead = (meta, count) => { if (count === 2) meta.version = '2'; };
  const receipt = await client(drive).findVerifiedNight({ snapshotAt: NOW });
  assert.equal(receipt.fileId, 'pending'); assert.equal(receipt.sha256, hash(existing.bytes));
  assert.equal(mediaReads(drive), 2); assert.equal(drive.started, 0); assert.equal(drive.generated, 0);
  assert.deepEqual(drive.writes.map(write => write.kind), ['complete']);
});
test('unstable metadata stops at three full readbacks and reports only a finite changed-field category', async t => {
  for (const field of ['version', 'checksum', 'both']) {
    const input = await fixture(t), drive = new FakeDrive(), pauses = [];
    drive.onMetadataRead = (meta, count) => {
      if (count === 1) delete meta.sha256Checksum;
      // Attempts end at metadata reads 2, 4 and 6; intervening reads start a
      // fresh stable-window check while retaining all original archive pins.
      if (count === 2 || count === 4 || (count === 6 && field !== 'checksum')) meta.version = String(BigInt(meta.version) + 1n);
      if (count === 6 && field !== 'version') meta.sha256Checksum = input.expectedSha256;
    };
    const api = createDriveBackupClient({ authorizedFetch: drive.fetch.bind(drive), config,
      now: () => new Date(NOW), sleep: async ms => { pauses.push(ms); } });
    const expected = field === 'both' ? 'REMOTE_METADATA_UNSTABLE'
      : field === 'version' ? 'REMOTE_VERSION_UNSTABLE' : 'REMOTE_CHECKSUM_UNSTABLE';
    await assert.rejects(api.uploadAndVerify(input), error => {
      assert.equal(classifyDriveBackupError(error), expected);
      assert.doesNotMatch(String(error), /generated_|example|Bearer|secret|2026|[a-f0-9]{64}/u);
      return true;
    });
    assert.equal(mediaReads(drive), 3); assert.deepEqual(pauses, [250, 500]);
    assert.equal(drive.files.get('generated_1').meta.appProperties.ecoBackupStatus, 'pending');
    assert.equal(drive.writes.some(write => ['complete', 'trash'].includes(write.kind)), false);
  }
});
test('versions retain exact integer precision and must be monotonic across every observation', async () => {
  const drive = new FakeDrive(), existing = drive.add('large_version', '2026-10-20');
  existing.meta.version = '9007199254740993';
  drive.onMetadataRead = (meta, count) => { if (count === 2) meta.version = '9007199254740994'; };
  const result = await client(drive).verifyArchiveReadOnly({ fileId: 'large_version' });
  assert.equal(result.sha256, hash(existing.bytes)); assert.equal(mediaReads(drive), 2); assert.equal(drive.writes.length, 0);
  for (const sequence of [['3', '2'], ['1', '3', '2']]) {
    const bad = new FakeDrive(); bad.add('regression', '2026-10-20');
    bad.onMetadataRead = (meta, count) => { meta.version = sequence[Math.min(count - 1, sequence.length - 1)]; };
    await assert.rejects(client(bad).verifyArchiveReadOnly({ fileId: 'regression' }), { code: 'REMOTE_VERSION_REGRESSED' });
    assert.equal(mediaReads(bad), 1); assert.equal(bad.writes.length, 0);
  }
});
test('a newly observed correct checksum can never disappear or change on a later read', async () => {
  for (const replacement of [undefined, null, '', 'b'.repeat(64)]) {
    const drive = new FakeDrive(), record = drive.add('checksum', '2026-10-20');
    drive.onMetadataRead = (meta, count) => {
      if (count === 1) delete meta.sha256Checksum;
      if (count === 2) meta.sha256Checksum = hash(record.bytes);
      if (count === 3) { if (replacement === undefined) delete meta.sha256Checksum; else meta.sha256Checksum = replacement; }
    };
    await assert.rejects(client(drive).verifyArchiveReadOnly({ fileId: 'checksum' }), { code: 'REMOTE_CHECKSUM_CHANGED' });
    assert.equal(mediaReads(drive), 1); assert.equal(drive.writes.length, 0);
  }
});
test('retry never rebaselines archive tags, content, scope or privacy to changed remote state', async t => {
  const input = await fixture(t);
  const changes = [
    [meta => { meta.appProperties.extra = 'Bearer SYNTHETIC_PRIVATE'; }, 'REMOTE_ARCHIVE_METADATA_CHANGED'],
    [meta => { meta.appProperties.ecoBackupSnapshotAt = '2026-10-21T01:00:00.000Z'; }, 'REMOTE_ARCHIVE_METADATA_CHANGED'],
    [meta => { meta.appProperties.ecoBackupSha256 = 'b'.repeat(64); }, 'REMOTE_ARCHIVE_METADATA_CHANGED'],
    [meta => { meta.appProperties.ecoBackupSize = String(Number(meta.appProperties.ecoBackupSize) + 1); }, 'REMOTE_ARCHIVE_METADATA_CHANGED'],
    [meta => { meta.size = String(Number(meta.size) + 1); }, 'REMOTE_ARCHIVE_METADATA_CHANGED'],
    [meta => { meta.parents = ['other_folder']; }, 'FILE_SCOPE_MISMATCH'],
    [meta => { meta.mimeType = 'text/plain'; }, 'FILE_SCOPE_MISMATCH'],
    [meta => { meta.owners = [{ emailAddress: 'other@example.invalid' }]; }, 'OWNER_OR_SHARING_MISMATCH'],
    [meta => { meta.shared = true; }, 'OWNER_OR_SHARING_MISMATCH'],
  ];
  for (const [change, code] of changes) {
    const drive = new FakeDrive();
    drive.onMetadataRead = (meta, count) => { if (count === 2) meta.version = '2'; if (count === 3) change(meta); };
    await assert.rejects(client(drive).uploadAndVerify(input), error => error.code === code && !String(error).includes('SYNTHETIC_PRIVATE'));
    assert.equal(mediaReads(drive), 1); assert.equal(drive.files.size, 1);
    assert.equal(drive.writes.some(write => ['complete', 'trash'].includes(write.kind)), false);
  }
});
test('a later full download or post-download permission failure cannot complete an archive', async t => {
  for (const mode of ['bytes', 'permissions', 'unauthorized']) {
    const input = await fixture(t), drive = new FakeDrive(); let reads = 0;
    drive.onMetadataRead = (meta, count) => { if (count === 2) meta.version = '2'; };
    const api = createDriveBackupClient({ config, now: () => new Date(NOW), sleep: async () => {},
      authorizedFetch: async (url, options) => {
        const parsed = new URL(url);
        if (parsed.searchParams.get('alt') === 'media' && ++reads === 2) {
          if (mode === 'bytes') drive.corruptDownload = 'generated_1';
          if (mode === 'unauthorized') return json({ error: 'Bearer SYNTHETIC_PRIVATE' }, 401);
        }
        if (mode === 'permissions' && reads === 2 && parsed.pathname.endsWith('/permissions'))
          drive.permissionExtra = { id: 'share', type: 'anyone', role: 'reader' };
        return drive.fetch(url, options);
      } });
    await assert.rejects(api.uploadAndVerify(input), { code: mode === 'bytes' ? 'DOWNLOAD_HASH_MISMATCH'
      : mode === 'permissions' ? 'NONPRIVATE_PERMISSIONS' : 'HTTP_401' });
    assert.equal(reads, 2); assert.equal(drive.writes.some(write => ['complete', 'trash'].includes(write.kind)), false);
  }
});
test('one total verification deadline covers metadata, ACL pages, streamed bytes and all backoff', async () => {
  for (const mode of ['metadata', 'permissions', 'body', 'backoff', 'http-retry']) {
    const drive = new FakeDrive(); drive.add('deadline', '2026-10-20');
    const operation = new AbortController();
    let aborted = false, bodyCancelled = false, stalled = false;
    if (mode === 'backoff') drive.onMetadataRead = (meta, count) => { if (count === 2) meta.version = '2'; };
    const api = createDriveBackupClient({ signal: operation.signal, config: { ...config, requestTimeoutMs: 1000, verificationTimeoutMs: 30 },
      now: () => new Date(NOW), sleep: () => new Promise(() => {}), authorizedFetch: async (url, options) => {
        const parsed = new URL(url), media = parsed.searchParams.get('alt') === 'media';
        const acl = parsed.pathname === '/drive/v3/files/deadline/permissions';
        if (mode === 'body' && media) return new Response(new ReadableStream({ cancel() { bodyCancelled = true; } }));
        if (mode === 'http-retry' && acl) return json({ error: 'SYNTHETIC_PRIVATE' }, 503);
        if (mode === 'permissions' && acl && !parsed.searchParams.has('pageToken'))
          return json({ permissions: [{ type: 'user', role: 'owner', emailAddress: EMAIL }], nextPageToken: 'next' });
        if ((mode === 'metadata' && parsed.pathname === '/drive/v3/files/deadline' && !media && mediaReads(drive) === 1)
          || (mode === 'permissions' && acl && parsed.searchParams.has('pageToken'))) {
          stalled = true; options.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
          return new Promise(() => {});
        }
        return drive.fetch(url, options);
      } });
    const start = performance.now();
    await assert.rejects(api.verifyArchiveReadOnly({ fileId: 'deadline' }), { code: 'REQUEST_TIMEOUT' });
    assert.ok(performance.now() - start < 2000); assert.ok(mediaReads(drive) <= 1);
    assert.equal(operation.signal.aborted, false);
    assert.equal(drive.writes.length, 0);
    if (stalled) assert.equal(aborted, true);
    if (mode === 'body') assert.equal(bodyCancelled, true);
  }
  for (const verificationTimeoutMs of [0, -1, 300001, Infinity, 1.5])
    assert.throws(() => client(new FakeDrive(), { verificationTimeoutMs }), { code: 'INVALID_LIMITS' });
});
test('caller cancellation overrides an active verification deadline in reads and settle backoff', async () => {
  for (const mode of ['metadata', 'body', 'backoff', 'http-retry']) {
    const drive = new FakeDrive(); drive.add('cancel_verify', '2026-10-20');
    const operation = new AbortController(); let fetchAborted = false, bodyCancelled = false;
    if (mode === 'backoff') drive.onMetadataRead = (meta, count) => { if (count === 2) meta.version = '2'; };
    const cancelSoon = () => { setTimeout(() => operation.abort(), 5); };
    const api = createDriveBackupClient({ signal: operation.signal,
      config: { ...config, requestTimeoutMs: 1000, verificationTimeoutMs: 1000 }, now: () => new Date(NOW),
      sleep: () => { cancelSoon(); return new Promise(() => {}); }, authorizedFetch: async (url, options) => {
        const parsed = new URL(url), media = parsed.searchParams.get('alt') === 'media';
        if (mode === 'body' && media) {
          cancelSoon();
          return new Response(new ReadableStream({ cancel() { bodyCancelled = true; } }));
        }
        if (mode === 'metadata' && parsed.pathname === '/drive/v3/files/cancel_verify' && !media && mediaReads(drive) === 1) {
          options.signal.addEventListener('abort', () => { fetchAborted = true; }, { once: true });
          cancelSoon(); return new Promise(() => {});
        }
        if (mode === 'http-retry' && parsed.pathname === '/drive/v3/files/cancel_verify/permissions') return json({}, 503);
        return drive.fetch(url, options);
      } });
    const start = performance.now();
    await assert.rejects(api.verifyArchiveReadOnly({ fileId: 'cancel_verify' }), { code: 'OPERATION_CANCELLED' });
    assert.ok(performance.now() - start < 500); assert.ok(mediaReads(drive) <= 1);
    assert.equal(drive.writes.length, 0);
    if (mode === 'metadata') assert.equal(fetchAborted, true);
    if (mode === 'body') assert.equal(bodyCancelled, true);
  }
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
test('read-only archive verification checks pending and verified bytes without changing metadata or minting retention authority', async () => {
  for (const status of ['pending', 'verified']) {
    const drive = new FakeDrive(), record = drive.add('diagnostic_archive', '2026-10-20');
    record.meta.appProperties.ecoBackupStatus = status;
    if (status === 'pending') { delete record.meta.appProperties.ecoBackupMethod; delete record.meta.appProperties.ecoBackupVerifiedAt; }
    const original = structuredClone(record.meta), api = client(drive);
    const checked = await api.verifyArchiveReadOnly({ fileId: record.meta.id });
    assert.deepEqual(checked, { fileId: 'diagnostic_archive', night: '2026-10-20',
      sha256: hash(record.bytes), size: record.bytes.length, status, readbackVerifiedAt: NOW });
    assert.equal(Object.isFrozen(checked), true);
    assert.deepEqual(record.meta, original);
    assert.equal(drive.calls.every(call => call.method === 'GET'), true);
    assert.equal(drive.calls.filter(call => new URL(call.url).searchParams.get('alt') === 'media').length, 1);
    await assert.rejects(api.retainLatestNights({ currentReceipt: checked }), { code: 'CURRENT_VERIFICATION_REQUIRED' });
    assert.equal(drive.writes.length, 0);
  }
});
test('read-only archive verification retains the exact identity, checksum, privacy and unchanged-metadata checks', async () => {
  for (const [configure, code] of [
    [(drive, record) => { record.meta.parents = ['other_folder']; }, 'FILE_SCOPE_MISMATCH'],
    [(drive, record) => { record.meta.appProperties = {}; }, 'UNMANAGED_FILE'],
    [(drive, record) => { record.meta.shared = true; }, 'OWNER_OR_SHARING_MISMATCH'],
    [drive => { drive.permissionExtra = { id: 'external', type: 'anyone', role: 'reader' }; }, 'NONPRIVATE_PERMISSIONS'],
    [drive => { drive.corruptDownload = 'diagnostic_archive'; }, 'DOWNLOAD_HASH_MISMATCH'],
    [drive => { drive.onMetadataRead = meta => { meta.version = String(BigInt(meta.version) + 1n); }; }, 'REMOTE_VERSION_UNSTABLE'],
  ]) {
    const drive = new FakeDrive(), record = drive.add('diagnostic_archive', '2026-10-20');
    configure(drive, record);
    await assert.rejects(client(drive).verifyArchiveReadOnly({ fileId: record.meta.id }), { code });
    assert.equal(drive.calls.every(call => call.method === 'GET'), true);
    assert.equal(drive.writes.length, 0);
  }
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
test('public Drive diagnostics distinguish upload verification failures without exposing provider details', async t => {
  const input = await fixture(t);
  for (const [configure, expected] of [
    [drive => { drive.corruptDownload = 'generated_1'; }, 'DOWNLOAD_HASH_MISMATCH'],
    [drive => { drive.onMetadataRead = meta => { meta.version = String(BigInt(meta.version) + 1n); }; }, 'REMOTE_VERSION_UNSTABLE'],
    [drive => { drive.redirectDownload = true; }, 'REDIRECT_REJECTED'],
    [drive => { drive.permissionExtra = { id: 'external', type: 'anyone', role: 'reader' }; }, 'NONPRIVATE_PERMISSIONS'],
  ]) {
    const drive = new FakeDrive(); configure(drive);
    await assert.rejects(client(drive).uploadAndVerify(input), error => {
      error.message = 'Bearer synthetic-private-token; private source path';
      error.cause = { url: 'https://private.example.invalid/secret', response: 'private response' };
      assert.equal(classifyDriveBackupError(error), expected);
      return true;
    });
    assert.equal(drive.writes.some(write => ['complete', 'trash'].includes(write.kind)), false);
  }
});
test('Drive diagnostic vocabulary is immutable and rejects untrusted, unknown or hostile error values', () => {
  assert.equal(Object.isFrozen(DRIVE_BACKUP_DIAGNOSTIC_CODES), true);
  assert.equal(new Set(DRIVE_BACKUP_DIAGNOSTIC_CODES).size, DRIVE_BACKUP_DIAGNOSTIC_CODES.length);
  for (const code of DRIVE_BACKUP_DIAGNOSTIC_CODES) {
    assert.match(code, /^[A-Z][A-Z0-9_]+$/u);
    assert.equal(classifyDriveBackupError(new DriveBackupError(code)), code);
  }
  const hostile = new DriveBackupError('DOWNLOAD_HASH_MISMATCH');
  Object.defineProperty(hostile, 'code', { get() { throw new Error('private getter content'); } });
  const unknown = new DriveBackupError('Bearer private-token');
  for (const value of [null, undefined, 'HTTP_403', new Error('HTTP_403'),
    { name: 'DriveBackupError', code: 'HTTP_403', message: 'private body' }, unknown, hostile]) {
    assert.equal(classifyDriveBackupError(value), null);
  }
  const safe = new DriveBackupError('HTTP_403');
  for (const key of ['message', 'cause', 'stack']) Object.defineProperty(safe, key, { get() { throw new Error('must not inspect private details'); } });
  assert.equal(classifyDriveBackupError(safe), 'HTTP_403');
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

async function downloadFixture(t, bytes = bytesFor('mirror')) {
  const root = await mkdtemp(join(tmpdir(), 'eco-drive-mirror-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const drive = new FakeDrive(), record = drive.add('mirror_archive', '2026-10-21', bytes);
  const api = client(drive), currentReceipt = await api.findVerifiedNight({ snapshotAt: NOW });
  return { root, drive, record, api, currentReceipt, archiveFile: join(root, 'copy.tar.gz.age') };
}
test('verified download streams exact ciphertext into a new private file without Drive mutations', async t => {
  const bytes = Buffer.concat([bytesFor('streaming'), Buffer.alloc(3 * 1024 ** 2, 17)]);
  const value = await downloadFixture(t, bytes), original = value.drive.fetch.bind(value.drive);
  let chunks = 0;
  // Build a client whose media body is generated incrementally, including a
  // split age header. Response.arrayBuffer/text are never needed.
  const api = createDriveBackupClient({ config, now: () => new Date(NOW), sleep: async () => {},
    authorizedFetch: async (url, options) => {
      if (new URL(url).searchParams.get('alt') !== 'media') return original(url, options);
      let offset = 0;
      return new Response(new ReadableStream({ pull(controller) {
        if (offset === bytes.length) return controller.close();
        const end = Math.min(bytes.length, offset + (offset === 0 ? 7 : 4096));
        controller.enqueue(bytes.subarray(offset, end)); offset = end; chunks++;
      } }));
    } });
  const currentReceipt = await api.findVerifiedNight({ snapshotAt: NOW });
  const downloaded = await api.downloadVerifiedArchive({ currentReceipt, archiveFile: value.archiveFile });
  assert.equal(currentReceipt.snapshotAt, value.record.meta.appProperties.ecoBackupSnapshotAt);
  assert.equal(downloaded.snapshotAt, currentReceipt.snapshotAt);
  assert.equal(downloaded.expectedSha256, hash(bytes)); assert.equal(downloaded.verified, true);
  assert.equal((await lstat(value.archiveFile)).mode & 0o777, 0o600);
  assert.deepEqual(await readFile(value.archiveFile), bytes); assert.ok(chunks > 1000);
  assert.equal(value.drive.calls.every(call => call.method === 'GET'), true); assert.equal(value.drive.writes.length, 0);
});
test('download requires this-client receipt and never overwrites an existing path or symlink', async t => {
  const value = await downloadFixture(t), untouched = Buffer.from('preserve existing content');
  const calls = value.drive.calls.length;
  await assert.rejects(value.api.downloadVerifiedArchive({ currentReceipt: { ...value.currentReceipt }, archiveFile: value.archiveFile }), { code: 'CURRENT_VERIFICATION_REQUIRED' });
  await assert.rejects(client(value.drive).downloadVerifiedArchive(value), { code: 'CURRENT_VERIFICATION_REQUIRED' });
  assert.equal(value.drive.calls.length, calls);
  await writeFile(value.archiveFile, untouched, { mode: 0o600 });
  await assert.rejects(value.api.downloadVerifiedArchive(value), { code: 'DOWNLOAD_FAILED' });
  assert.deepEqual(await readFile(value.archiveFile), untouched);
  const link = join(value.root, 'link.age'); await symlink(value.archiveFile, link);
  await assert.rejects(value.api.downloadVerifiedArchive({ ...value, archiveFile: link }), { code: 'DOWNLOAD_FAILED' });
  assert.equal((await lstat(link)).isSymbolicLink(), true); assert.deepEqual(await readFile(value.archiveFile), untouched);
  assert.equal(value.drive.writes.length, 0);
});
test('mirror rejects stale receipts and non-age bytes even when provider checksums agree', async t => {
  for (const mode of ['stale', 'plaintext']) {
    const bytes = mode === 'plaintext' ? Buffer.from('THIS IS NOT AGE CIPHERTEXT; DO NOT COPY IT') : bytesFor('stale');
    const value = await downloadFixture(t, bytes);
    if (mode === 'stale') value.record.meta.version = '999';
    await assert.rejects(value.api.downloadVerifiedArchive(value), { code: mode === 'stale' ? 'CURRENT_ARCHIVE_CHANGED' : 'AGE_CIPHERTEXT_REQUIRED' });
    await assert.rejects(lstat(value.archiveFile), { code: 'ENOENT' }); assert.equal(value.drive.writes.length, 0);
  }
});
test('failed mirror download removes only its new partial file and preserves Drive copies', async t => {
  for (const mode of ['corrupt', 'oversize', 'version', 'acl', 'folder']) {
    const value = await downloadFixture(t), initialReads = value.drive.metadataReads;
    if (mode === 'corrupt') value.drive.corruptDownload = value.record.meta.id;
    if (mode === 'oversize') value.record.bytes = Buffer.concat([value.record.bytes, Buffer.from('extra')]);
    if (mode === 'version') value.drive.onMetadataRead = (meta, count) => { if (count === initialReads + 2) meta.version = '999'; };
    if (mode === 'acl') value.drive.onMetadataRead = (meta, count) => { if (count === initialReads + 2) value.drive.permissionExtra = { id: 'reader', type: 'anyone', role: 'reader' }; };
    if (mode === 'folder') value.drive.onMetadataRead = (meta, count) => { if (count === initialReads + 2) value.drive.folder.shared = true; };
    await assert.rejects(value.api.downloadVerifiedArchive(value), { code: {
      corrupt: 'DOWNLOAD_HASH_MISMATCH', oversize: 'RESPONSE_SIZE_LIMIT', version: 'REMOTE_CHANGED_DURING_VERIFICATION',
      acl: 'NONPRIVATE_PERMISSIONS', folder: 'OWNER_OR_SHARING_MISMATCH',
    }[mode] });
    await assert.rejects(lstat(value.archiveFile), { code: 'ENOENT' });
    assert.equal(value.record.meta.trashed, false); assert.equal(value.drive.writes.length, 0);
  }
});
test('mirror retries reset write position after a partial response and enforce a bounded stalled body', async t => {
  for (const stall of [false, true]) {
    const value = await downloadFixture(t); let downloading = false, attempts = 0;
    const api = createDriveBackupClient({ config: { ...config, requestTimeoutMs: 25 }, now: () => new Date(NOW), sleep: async () => {},
      authorizedFetch: async (url, options) => {
        if (downloading && new URL(url).searchParams.get('alt') === 'media') {
          attempts++;
          if (stall) return new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }));
          if (attempts === 1) { let pulled = false; return new Response(new ReadableStream({ pull(controller) {
            if (pulled) return controller.error(new Error('synthetic private transport failure'));
            pulled = true; controller.enqueue(value.record.bytes.subarray(0, 9));
          } })); }
        }
        return value.drive.fetch(url, options);
      } });
    const currentReceipt = await api.findVerifiedNight({ snapshotAt: NOW }); downloading = true;
    if (stall) {
      const started = Date.now();
      await assert.rejects(api.downloadVerifiedArchive({ ...value, currentReceipt }), { code: 'REQUEST_TIMEOUT' });
      assert.ok(Date.now() - started < 1000); assert.equal(attempts, 3);
      await assert.rejects(lstat(value.archiveFile), { code: 'ENOENT' });
    } else {
      await api.downloadVerifiedArchive({ ...value, currentReceipt }); assert.equal(attempts, 2);
      assert.deepEqual(await readFile(value.archiveFile), value.record.bytes);
    }
    assert.equal(value.drive.writes.length, 0);
  }
});
test('a replaced local output is preserved when mirror verification fails', async t => {
  const value = await downloadFixture(t), originalReads = value.drive.metadataReads;
  const replacement = Buffer.from('unrelated replacement'); let replaced = false;
  const api = createDriveBackupClient({ config, now: () => new Date(NOW), sleep: async () => {},
    authorizedFetch: async (url, options) => {
      if (replaced && new URL(url).searchParams.get('alt') === 'media') {
        await rename(value.archiveFile, join(value.root, 'owned-partial.age'));
        await writeFile(value.archiveFile, replacement, { mode: 0o600 }); replaced = false;
      }
      return value.drive.fetch(url, options);
    } });
  const currentReceipt = await api.findVerifiedNight({ snapshotAt: NOW }); replaced = true;
  await assert.rejects(api.downloadVerifiedArchive({ ...value, currentReceipt }), { code: 'LOCAL_FILE_CHANGED' });
  assert.deepEqual(await readFile(value.archiveFile), replacement); assert.ok(value.drive.metadataReads > originalReads);
  assert.equal(value.drive.writes.length, 0);
});
test('an aborted Drive operation never starts or retries requests and exposes only a fixed code', async () => {
  for (const mode of ['before', 'fetch', 'backoff']) {
    const controller = new AbortController(); let calls = 0, transportAborted = false;
    if (mode === 'before') controller.abort(new Error('private cancellation reason'));
    const api = createDriveBackupClient({ config, signal: controller.signal,
      sleep: async () => { controller.abort(new Error('private backoff reason')); },
      authorizedFetch: async (url, options) => {
        calls++;
        options.signal.addEventListener('abort', () => { transportAborted = true; }, { once: true });
        if (mode === 'fetch') {
          queueMicrotask(() => controller.abort(new Error('private transport reason')));
          return new Promise(() => {});
        }
        return noBody(503);
      } });
    await assert.rejects(api.verifyTarget(), error => {
      assert.equal(classifyDriveBackupError(error), 'OPERATION_CANCELLED');
      assert.equal(String(error).includes('private'), false); return true;
    });
    assert.equal(calls, mode === 'before' ? 0 : 1);
    assert.equal(transportAborted, mode !== 'before');
    await assert.rejects(api.verifyTarget(), { code: 'OPERATION_CANCELLED' });
    assert.equal(calls, mode === 'before' ? 0 : 1);
  }
});
test('external cancellation stops streaming mirror download and removes its partial file without retries', async t => {
  const value = await downloadFixture(t), controller = new AbortController();
  let downloading = false, mediaCalls = 0, bodyCancelled = false;
  const api = createDriveBackupClient({ config, signal: controller.signal, now: () => new Date(NOW), sleep: async () => {},
    authorizedFetch: async (url, options) => {
      if (downloading && new URL(url).searchParams.get('alt') === 'media') {
        mediaCalls++;
        return new Response(new ReadableStream({ start(stream) { stream.enqueue(value.record.bytes.subarray(0, 7)); },
          pull() { controller.abort(new Error('private cancellation')); return new Promise(() => {}); },
          cancel() { bodyCancelled = true; } }));
      }
      return value.drive.fetch(url, options);
    } });
  const currentReceipt = await api.findVerifiedNight({ snapshotAt: NOW }); downloading = true;
  await assert.rejects(api.downloadVerifiedArchive({ ...value, currentReceipt }), { code: 'OPERATION_CANCELLED' });
  assert.equal(mediaCalls, 1); assert.equal(bodyCancelled, true);
  await assert.rejects(lstat(value.archiveFile), { code: 'ENOENT' }); assert.equal(value.drive.writes.length, 0);
});
test('cancellation while checking the lock never starts the pending mutation', async t => {
  const drive = new FakeDrive(), controller = new AbortController(), input = await fixture(t);
  const api = createDriveBackupClient({ config, signal: controller.signal, now: () => new Date(NOW), sleep: async () => {},
    authorizedFetch: drive.fetch.bind(drive), beforeMutation: async () => { controller.abort(); } });
  await assert.rejects(api.uploadAndVerify(input), { code: 'OPERATION_CANCELLED' });
  assert.equal(drive.writes.length, 0);
});
