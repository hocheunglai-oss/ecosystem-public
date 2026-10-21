import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { MANIFEST_NAME, sealDirectory, verifyArchive, validateManifest, cleanupPrivateArtifacts } from './archive.mjs';

const ageBin = process.env.ECO_AGE_BIN || '/usr/local/bin/age', keygen = process.env.ECO_AGE_KEYGEN_BIN || '/usr/local/bin/age-keygen';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const exists = async path => { try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
async function save(path, bytes) { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, bytes, { mode: 0o600 }); }
async function makeKey(root, name) {
  const path = join(root, name);
  execFileSync(keygen, ['--output', path], { stdio: ['ignore', 'pipe', 'pipe'] });
  await chmod(path, 0o600);
  const text = await readFile(path, 'utf8'), recipient = text.match(/^# public key: (age1[0-9a-z]+)$/m)?.[1];
  assert.ok(recipient); return { path, recipient, text };
}
function manifest(files) {
  return { schemaVersion: 1, recovery: { project: 'synthetic-only', capturedAt: '2026-10-21T00:00:00.000Z' }, files: Object.entries(files).map(([path, bytes]) => ({ path, size: Buffer.byteLength(bytes), sha256: sha(bytes) })) };
}
async function fixture(root, name, files) {
  const dir = join(root, name); await mkdir(dir, { mode: 0o700 });
  for (const [path, bytes] of Object.entries(files)) await save(join(dir, path), bytes);
  const value = manifest(files); await save(join(dir, MANIFEST_NAME), JSON.stringify(value)); return dir;
}
function tarEntry(path, bytes, { type = '0', link = '', mode = 0o600 } = {}) {
  const data = Buffer.from(bytes), header = Buffer.alloc(512);
  header.write(path, 0, 100, 'ascii');
  for (const [offset, length, value] of [[100, 8, mode], [108, 8, 0], [116, 8, 0], [124, 12, data.length], [136, 12, 0]]) header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length, 'ascii');
  header.fill(32, 148, 156); header.write(type, 156); header.write(link, 157, 100, 'ascii'); header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii');
  let checksum = 0; for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)]);
}
async function maliciousArchive(root, name, recipient, entries) {
  const compressed = gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)])), input = join(root, `${name}.tar.gz`), output = join(root, `${name}.tar.gz.age`);
  await save(input, compressed);
  const bytes = execFileSync(ageBin, ['--encrypt', '--recipient', recipient, input], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
  await save(output, bytes); await rm(input); return output;
}

test('official age packaging and hostile-archive verification', async t => {
  assert.ok(ageBin && keygen, 'Set ECO_AGE_BIN and ECO_AGE_KEYGEN_BIN to verified official binaries; no crypto fallback.');
  const root = await mkdtemp(join(tmpdir(), 'eco-archive-test-')); await chmod(root, 0o700);
  try {
    const first = await makeKey(root, 'disposable-first.agekey'), other = await makeKey(root, 'disposable-other.agekey');
    const marker = 'SYNTHETIC_DATABASE_ONLY_b9624f9a', files = { 'database/schema.sql': `${marker}\nCREATE TABLE synthetic(id int);\n`, 'objects/abcd1234.pdf': Buffer.from('%PDF-1.7\nSYNTHETIC_PDF_ONLY\n'), 'database/empty.sql': '' };
    const source = await fixture(root, 'source', files), archiveFile = join(root, 'valid.tar.gz.age');
    let sealed;
    await t.test('descriptor close failure cannot skip remaining closes or private-file cleanup', async () => {
      const stage = join(root, 'cleanup-stage'), destination = join(root, 'cleanup-destination');
      await save(join(stage, 'plaintext.sql'), marker); await save(join(destination, 'partial.sql'), marker);
      let secondClosed = false;
      await assert.rejects(cleanupPrivateArtifacts({ handles: [{ close: async () => { throw new Error('synthetic close failure'); } }, { close: async () => { secondClosed = true; } }], paths: [stage, destination] }), /^Error: PRIVATE_CLEANUP_FAILED$/);
      assert.equal(secondClosed, true); assert.equal(await exists(stage), false); assert.equal(await exists(destination), false);
    });
    await t.test('round trip verifies every byte and produces only private output', async () => {
      sealed = await sealDirectory({ sourceDir: source, outputFile: archiveFile, recipient: first.recipient, ageBin });
      assert.equal(sealed.files, 3); assert.equal(sealed.sha256, sha(await readFile(archiveFile)));
      assert.equal((await lstat(archiveFile)).mode & 0o777, 0o600);
      const destinationDir = join(root, 'verified');
      const verified = await verifyArchive({ archiveFile, identityFile: first.path, destinationDir, ageBin });
      assert.equal(verified.files, 3); assert.deepEqual(verified.manifest, manifest(files));
      assert.equal((await lstat(destinationDir)).mode & 0o777, 0o700);
      for (const [path, bytes] of Object.entries(files)) { assert.deepEqual(await readFile(join(destinationDir, path)), Buffer.from(bytes)); assert.equal((await lstat(join(destinationDir, path))).mode & 0o777, 0o600); }
    });
    await t.test('upload artifact contains neither plaintext nor decryption private key', async () => {
      const ciphertext = await readFile(archiveFile);
      assert.equal(ciphertext.includes(Buffer.from(marker)), false);
      assert.equal(ciphertext.includes(Buffer.from('SYNTHETIC_PDF_ONLY')), false);
      assert.equal(ciphertext.includes(Buffer.from(MANIFEST_NAME)), false);
      assert.equal(ciphertext.includes(Buffer.from('AGE-SECRET-KEY-1')), false);
      assert.equal(ciphertext.includes(Buffer.from(first.text)), false);
      assert.ok(ciphertext.subarray(0, 24).toString().startsWith('age-encryption.org/v1'));
    });
    await t.test('modified authenticated ciphertext fails with no restoration residue', async () => {
      const changed = Buffer.from(await readFile(archiveFile)); changed[changed.length - 1] ^= 1;
      const path = join(root, 'tampered.tar.gz.age'), destinationDir = join(root, 'tampered-output'); await save(path, changed);
      await assert.rejects(verifyArchive({ archiveFile: path, identityFile: first.path, destinationDir, ageBin }), /ARCHIVE_TOOL_FAILED/);
      assert.equal(await exists(destinationDir), false);
    });
    await t.test('wrong private identity fails with no restoration residue', async () => {
      const destinationDir = join(root, 'wrong-key-output');
      await assert.rejects(verifyArchive({ archiveFile, identityFile: other.path, destinationDir, ageBin }), /ARCHIVE_TOOL_FAILED/);
      assert.equal(await exists(destinationDir), false);
    });
    await t.test('truncated ciphertext fails before extraction', async () => {
      const bytes = await readFile(archiveFile), truncated = join(root, 'truncated.tar.gz.age'), destinationDir = join(root, 'truncated-output');
      await save(truncated, bytes.subarray(0, bytes.length - 32));
      await assert.rejects(verifyArchive({ archiveFile: truncated, identityFile: first.path, destinationDir, ageBin }), /ARCHIVE_TOOL_FAILED/);
      assert.equal(await exists(destinationDir), false);
    });
    await t.test('existing archive and destination are never replaced', async () => {
      await assert.rejects(sealDirectory({ sourceDir: source, outputFile: archiveFile, recipient: first.recipient, ageBin }), /OUTPUT_ALREADY_EXISTS/);
      assert.equal(sha(await readFile(archiveFile)), sealed.sha256);
      await assert.rejects(verifyArchive({ archiveFile, identityFile: first.path, destinationDir: join(root, 'verified'), ageBin }), /OUTPUT_ALREADY_EXISTS/);
      assert.equal((await readFile(join(root, 'verified/database/schema.sql'), 'utf8')), files['database/schema.sql']);
    });
    await t.test('source symlinks and undeclared files reject before encryption', async () => {
      const link = join(source, 'link.sql'); await symlink(join(source, 'database/schema.sql'), link);
      await assert.rejects(sealDirectory({ sourceDir: source, outputFile: join(root, 'link.tar.gz.age'), recipient: first.recipient, ageBin }), /SYMLINK_IN_SOURCE/); await rm(link);
      const extra = join(source, 'extra.sql'); await save(extra, 'synthetic');
      await assert.rejects(sealDirectory({ sourceDir: source, outputFile: join(root, 'extra.tar.gz.age'), recipient: first.recipient, ageBin }), /SOURCE_INVENTORY_MISMATCH/); await rm(extra);
    });
    await t.test('source file changed since manifest rejects before encryption', async () => {
      const path = join(source, 'database/schema.sql'); await save(path, 'changed');
      await assert.rejects(sealDirectory({ sourceDir: source, outputFile: join(root, 'changed.tar.gz.age'), recipient: first.recipient, ageBin }), /SOURCE_SIZE_MISMATCH/); await save(path, files['database/schema.sql']);
    });
    await t.test('non-private source and identity modes are rejected', async () => {
      const path = join(source, 'database/schema.sql'); await chmod(path, 0o644);
      await assert.rejects(sealDirectory({ sourceDir: source, outputFile: join(root, 'mode.tar.gz.age'), recipient: first.recipient, ageBin }), /OWNER_ONLY_SOURCE_REQUIRED/); await chmod(path, 0o600);
      await chmod(first.path, 0o644);
      await assert.rejects(verifyArchive({ archiveFile, identityFile: first.path, destinationDir: join(root, 'bad-key-mode-output'), ageBin }), /OWNER_ONLY_FILE_REQUIRED/); await chmod(first.path, 0o600);
    });
    await t.test('private age identity may not be packaged even if declared', async () => {
      const keySource = await fixture(root, 'key-source', { 'private.txt': first.text });
      await assert.rejects(sealDirectory({ sourceDir: keySource, outputFile: join(root, 'key.tar.gz.age'), recipient: first.recipient, ageBin }), /PRIVATE_IDENTITY_IN_SOURCE/);
    });
    await t.test('manifest paths reject traversal, absolute paths and collisions', () => {
      for (const path of ['../outside', '/absolute', 'a/../../outside', 'a//b', 'a\\b', 'a/./b', '-C', 'a\nb']) assert.throws(() => validateManifest(manifest({ [path]: '' })), /UNSAFE_ARCHIVE_PATH/);
      assert.throws(() => validateManifest(manifest({ a: '', 'a/b': '' })), /MANIFEST_PATH_COLLISION/);
    });
    const safeBytes = 'safe', safeManifest = JSON.stringify(manifest({ 'data.txt': safeBytes }));
    for (const [name, entries, pattern] of [
      ['traversal', [tarEntry(MANIFEST_NAME, safeManifest), tarEntry('../outside', safeBytes)], /UNSAFE_ARCHIVE_PATH/],
      ['symlink', [tarEntry(MANIFEST_NAME, safeManifest), tarEntry('data.txt', '', { type: '2', link: '../outside' })], /TAR_LINK_OR_SPECIAL_ENTRY_REJECTED/],
      ['hardlink', [tarEntry(MANIFEST_NAME, safeManifest), tarEntry('data.txt', '', { type: '1', link: '../outside' })], /TAR_LINK_OR_SPECIAL_ENTRY_REJECTED/],
      ['unexpected', [tarEntry(MANIFEST_NAME, safeManifest), tarEntry('extra.txt', safeBytes)], /UNEXPECTED_TAR_FILE/],
      ['hash-mismatch', [tarEntry(MANIFEST_NAME, safeManifest), tarEntry('data.txt', 'evil')], /RESTORED_FILE_HASH_MISMATCH/],
      ['duplicate', [tarEntry(MANIFEST_NAME, safeManifest), tarEntry('data.txt', safeBytes), tarEntry('data.txt', safeBytes)], /DUPLICATE_TAR_PATH/],
      ['missing', [tarEntry(MANIFEST_NAME, safeManifest)], /INCOMPLETE_ARCHIVE/],
      ['unsafe-mode', [tarEntry(MANIFEST_NAME, safeManifest), tarEntry('data.txt', safeBytes, { mode: 0o777 })], /UNSAFE_TAR_FILE_MODE/],
      ['pax-rejected', [tarEntry(MANIFEST_NAME, safeManifest), tarEntry('pax', '11 path=x\n', { type: 'x' })], /TAR_LINK_OR_SPECIAL_ENTRY_REJECTED/],
      ['invalid-manifest-path', [tarEntry(MANIFEST_NAME, JSON.stringify(manifest({ '../outside': 'safe' })))], /UNSAFE_ARCHIVE_PATH/],
      ['invalid-header-checksum', [tarEntry(MANIFEST_NAME, safeManifest), (() => { const bytes = tarEntry('data.txt', safeBytes); bytes[148] ^= 1; return bytes; })()], /TAR_HEADER_CHECKSUM_MISMATCH|INVALID_TAR_NUMBER/],
    ]) await t.test(`authenticated but malformed ${name} archive is rejected without writing outside destination`, async () => {
      const archive = await maliciousArchive(root, name, first.recipient, entries), destinationDir = join(root, `${name}-output`);
      await assert.rejects(verifyArchive({ archiveFile: archive, identityFile: first.path, destinationDir, ageBin }), pattern);
      assert.equal(await exists(destinationDir), false); assert.equal(await exists(join(root, 'outside')), false);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});
