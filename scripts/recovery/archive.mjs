/** Standalone recovery packaging. No provider calls, credentials or custom cryptography. */
import { constants, createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createGunzip } from 'node:zlib';

export const MANIFEST_NAME = 'recovery-manifest.json';
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 100_000;
const MAX_FILE_BYTES = 0o77777777777;
const MAX_TOTAL_BYTES = 64 * 1024 ** 3;
const PRIVATE_KEY_MARKER = 'AGE-SECRET-KEY-1';
const fail = code => { throw new Error(code); };
const check = (condition, code) => { if (!condition) fail(code); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const parseManifest = bytes => { try { return JSON.parse(bytes.toString('utf8')); } catch { fail('MALFORMED_MANIFEST'); } };
async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) { const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset); check(bytesWritten > 0, 'ARCHIVE_WRITE_FAILED'); offset += bytesWritten; }
}

/** All owned cleanup is attempted, even if a descriptor close itself fails. */
export async function cleanupPrivateArtifacts({ handles = [], paths = [] }) {
  const closed = await Promise.allSettled(handles.filter(Boolean).map(handle => Promise.resolve().then(() => handle.close())));
  const removed = await Promise.allSettled(paths.filter(Boolean).map(path => rm(path, { recursive: true, force: true })));
  check([...closed, ...removed].every(result => result.status === 'fulfilled'), 'PRIVATE_CLEANUP_FAILED');
}

export function validateRelativePath(value) {
  check(typeof value === 'string' && value.length > 0 && value.length <= 240 && !isAbsolute(value), 'UNSAFE_ARCHIVE_PATH');
  const pieces = value.split('/');
  check(pieces.every(piece => /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(piece) && piece !== '.' && piece !== '..'), 'UNSAFE_ARCHIVE_PATH');
  check(value.lastIndexOf('/') <= 155, 'USTAR_PATH_TOO_LONG');
  return value;
}

export function validateManifest(value) {
  check(exactKeys(value, ['schemaVersion', 'recovery', 'files']) && value.schemaVersion === 1 && plain(value.recovery), 'INVALID_MANIFEST');
  check(Array.isArray(value.files) && value.files.length <= MAX_FILES, 'INVALID_MANIFEST_FILES');
  const seen = new Set();
  let totalBytes = 0;
  for (const file of value.files) {
    check(exactKeys(file, ['path', 'size', 'sha256']), 'INVALID_MANIFEST_FILE');
    validateRelativePath(file.path);
    check(file.path !== MANIFEST_NAME && !file.path.startsWith(`${MANIFEST_NAME}/`) && !seen.has(file.path), 'DUPLICATE_MANIFEST_PATH');
    seen.add(file.path);
    check(Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= MAX_FILE_BYTES, 'INVALID_MANIFEST_SIZE');
    check(typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/.test(file.sha256), 'INVALID_MANIFEST_HASH');
    totalBytes += file.size;
    check(totalBytes <= MAX_TOTAL_BYTES, 'ARCHIVE_SIZE_LIMIT');
  }
  for (const path of seen) {
    const pieces = path.split('/');
    while (pieces.length > 1) { pieces.pop(); check(!seen.has(pieces.join('/')), 'MANIFEST_PATH_COLLISION'); }
  }
  check(!JSON.stringify(value).includes(PRIVATE_KEY_MARKER), 'PRIVATE_IDENTITY_IN_SOURCE');
  return { manifest: value, totalBytes };
}

async function canonicalRegularFile(path, privateMode = true) {
  check(typeof path === 'string' && isAbsolute(path), 'ABSOLUTE_FILE_REQUIRED');
  const info = await lstat(path);
  check(info.isFile() && !info.isSymbolicLink() && info.nlink === 1, 'REGULAR_EXCLUSIVE_FILE_REQUIRED');
  check(!privateMode || !(info.mode & 0o077), 'OWNER_ONLY_FILE_REQUIRED');
  return realpath(path);
}

async function canonicalPrivateDirectory(path) {
  check(typeof path === 'string' && isAbsolute(path), 'ABSOLUTE_DIRECTORY_REQUIRED');
  const info = await lstat(path);
  check(info.isDirectory() && !info.isSymbolicLink() && !(info.mode & 0o077), 'OWNER_ONLY_DIRECTORY_REQUIRED');
  return realpath(path);
}

async function canonicalNewPath(path) {
  check(typeof path === 'string' && isAbsolute(path), 'ABSOLUTE_OUTPUT_REQUIRED');
  const parent = await realpath(dirname(path));
  check((await stat(parent)).isDirectory(), 'OUTPUT_PARENT_REQUIRED');
  const result = join(parent, basename(path));
  try { await lstat(result); fail('OUTPUT_ALREADY_EXISTS'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return result;
}

function requireBinary(path) {
  check(typeof path === 'string' && isAbsolute(path), 'ABSOLUTE_AGE_BIN_REQUIRED');
  return path;
}

async function run(binary, args, stdio = ['ignore', 'ignore', 'pipe'], extraEnv = {}) {
  // Preserve no ambient provider credentials in child processes.
  const env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC', ...extraEnv };
  await new Promise((resolveRun, reject) => {
    const child = spawn(binary, args, { stdio, env });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30 * 60_000);
    let settled = false;
    child.stderr?.on('data', () => {}); // Never surface tool diagnostics containing private names or paths.
    const finish = error => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolveRun(); };
    child.once('error', () => finish(new Error('ARCHIVE_TOOL_FAILED')));
    child.once('close', code => finish(code === 0 ? null : new Error('ARCHIVE_TOOL_FAILED')));
  });
}

async function digestFile(path) {
  const hash = createHash('sha256'); let size = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk); size += chunk.length; }
  return { size, sha256: hash.digest('hex') };
}

async function inventory(directory, prefix = '') {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    validateRelativePath(path);
    const full = join(directory, entry.name), info = await lstat(full);
    check(!info.isSymbolicLink(), 'SYMLINK_IN_SOURCE');
    check(!(info.mode & 0o077), 'OWNER_ONLY_SOURCE_REQUIRED');
    if (info.isDirectory()) found.push(...await inventory(full, path));
    else { check(info.isFile() && info.nlink === 1, 'UNSUPPORTED_SOURCE_ENTRY'); found.push(path); }
  }
  return found.sort();
}

async function copyVerifiedFile(source, output, expected) {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let out;
  try {
    const info = await input.stat();
    check(info.isFile() && info.nlink === 1 && !(info.mode & 0o077), 'UNSAFE_SOURCE_FILE');
    check(info.size === expected.size, 'SOURCE_SIZE_MISMATCH');
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    out = await open(output, 'wx', 0o600);
    const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    let size = 0, tail = '';
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      const bytes = buffer.subarray(0, bytesRead);
      size += bytesRead; check(size <= expected.size, 'SOURCE_CHANGED');
      const search = tail + bytes.toString('latin1');
      check(!search.includes(PRIVATE_KEY_MARKER), 'PRIVATE_IDENTITY_IN_SOURCE');
      tail = search.slice(-(PRIVATE_KEY_MARKER.length - 1));
      hash.update(bytes); await writeAll(out, bytes);
    }
    check(size === expected.size && hash.digest('hex') === expected.sha256, 'SOURCE_HASH_MISMATCH');
    const after = await input.stat();
    check(after.size === info.size && after.mtimeMs === info.mtimeMs && after.ctimeMs === info.ctimeMs, 'SOURCE_CHANGED');
    await out.sync();
  } finally { await cleanupPrivateArtifacts({ handles: [out, input] }); }
}

/** Manifest and every source file must already be owner-only. Output must not exist. */
export async function sealDirectory({ sourceDir, outputFile, recipient, ageBin = process.env.AGE_BIN }) {
  requireBinary(ageBin);
  check(typeof recipient === 'string' && /^age1[0-9a-z]{58}$/.test(recipient), 'NATIVE_AGE_RECIPIENT_REQUIRED');
  const source = await canonicalPrivateDirectory(sourceDir), output = await canonicalNewPath(outputFile);
  check(output.endsWith('.tar.gz.age'), 'ENCRYPTED_ARCHIVE_EXTENSION_REQUIRED');
  const rel = relative(source, output);
  check(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel), 'OUTPUT_MUST_BE_OUTSIDE_SOURCE');
  const manifestPath = await canonicalRegularFile(join(source, MANIFEST_NAME));
  check((await stat(manifestPath)).size <= MAX_MANIFEST_BYTES, 'MANIFEST_SIZE_LIMIT');
  const manifestBytes = await readFile(manifestPath);
  check(manifestBytes.length <= MAX_MANIFEST_BYTES, 'MANIFEST_SIZE_LIMIT');
  const { manifest, totalBytes } = validateManifest(parseManifest(manifestBytes));
  const expectedPaths = [MANIFEST_NAME, ...manifest.files.map(file => file.path)].sort();
  check(JSON.stringify(await inventory(source)) === JSON.stringify(expectedPaths), 'SOURCE_INVENTORY_MISMATCH');
  const temp = await mkdtemp(join(dirname(output), '.eco-seal-')); await chmod(temp, 0o700);
  let outputHandle, createdOutput = false, success = false;
  try {
    const staged = join(temp, 'source'); await mkdir(staged, { mode: 0o700 });
    await writeFile(join(staged, MANIFEST_NAME), manifestBytes, { flag: 'wx', mode: 0o600 });
    for (const file of manifest.files) await copyVerifiedFile(join(source, file.path), join(staged, file.path), file);
    const listing = join(temp, 'files.txt');
    await writeFile(listing, [MANIFEST_NAME, ...manifest.files.map(file => file.path)].join('\n') + '\n', { flag: 'wx', mode: 0o600 });
    const tar = join(temp, 'payload.tar.gz');
    await run('/usr/bin/tar', ['--format=ustar', '--no-recursion', '-czf', tar, '-C', staged, '-T', listing], undefined, { COPYFILE_DISABLE: '1' });
    await chmod(tar, 0o600);
    outputHandle = await open(output, 'wx', 0o600); createdOutput = true;
    await run(ageBin, ['--encrypt', '--recipient', recipient, tar], ['ignore', outputHandle.fd, 'pipe']);
    await outputHandle.sync(); await outputHandle.close(); outputHandle = undefined;
    const ciphertext = await digestFile(output); check(ciphertext.size > 0, 'EMPTY_CIPHERTEXT');
    success = true;
    return { archiveFile: output, ...ciphertext, files: manifest.files.length, totalBytes };
  } finally {
    await cleanupPrivateArtifacts({ handles: [outputHandle], paths: [createdOutput && !success ? output : undefined, temp] });
  }
}

function tarString(bytes) {
  const zero = bytes.indexOf(0), end = zero < 0 ? bytes.length : zero;
  check(zero < 0 || bytes.subarray(zero).every(value => value === 0), 'INVALID_TAR_STRING');
  return bytes.subarray(0, end).toString('latin1');
}
function tarNumber(bytes) {
  const text = bytes.toString('latin1').replace(/[\0 ]+$/g, '').replace(/^ +/g, '');
  check(/^[0-7]+$/.test(text), 'INVALID_TAR_NUMBER');
  const value = Number.parseInt(text, 8); check(Number.isSafeInteger(value), 'INVALID_TAR_NUMBER'); return value;
}
function tarHeader(block) {
  check(block.subarray(257, 263).equals(Buffer.from('ustar\0')), 'UNSUPPORTED_TAR_FORMAT');
  check(block.subarray(263, 265).equals(Buffer.from('00')), 'UNSUPPORTED_TAR_VERSION');
  const expected = tarNumber(block.subarray(148, 156));
  let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : block[i];
  check(sum === expected, 'TAR_HEADER_CHECKSUM_MISMATCH');
  check(block[156] === 0 || block[156] === 48, 'TAR_LINK_OR_SPECIAL_ENTRY_REJECTED');
  check(tarString(block.subarray(157, 257)) === '', 'TAR_LINK_REJECTED');
  const name = tarString(block.subarray(0, 100)), prefix = tarString(block.subarray(345, 500));
  const path = validateRelativePath(prefix ? `${prefix}/${name}` : name);
  const mode = tarNumber(block.subarray(100, 108));
  check((mode & 0o7777) === 0o600, 'UNSAFE_TAR_FILE_MODE');
  const size = tarNumber(block.subarray(124, 136)); check(size <= MAX_FILE_BYTES, 'TAR_FILE_SIZE_LIMIT');
  return { path, size };
}

async function unpackVerifiedTar(gzipFile, destination) {
  const source = createReadStream(gzipFile), unzip = createGunzip(); source.pipe(unzip);
  source.on('error', error => unzip.destroy(error));
  const iterator = unzip[Symbol.asyncIterator](); let pending = Buffer.alloc(0), ended = false, expanded = 0;
  async function readExact(length, eofOkay = false) {
    while (pending.length < length && !ended) {
      const next = await iterator.next(); ended = Boolean(next.done);
      if (!ended) { expanded += next.value.length; check(expanded <= MAX_TOTAL_BYTES + 1024 * MAX_FILES + MAX_MANIFEST_BYTES, 'EXPANDED_ARCHIVE_SIZE_LIMIT'); pending = Buffer.concat([pending, next.value]); }
    }
    if (eofOkay && ended && !pending.length) return null;
    check(pending.length >= length, 'TRUNCATED_TAR');
    const bytes = pending.subarray(0, length); pending = pending.subarray(length); return bytes;
  }
  const seen = new Set(); let manifest, expectations, totalBytes, zeroBlocks = 0;
  try {
    for (;;) {
      const headerBytes = await readExact(512, true);
      if (!headerBytes) break;
      if (headerBytes.every(value => value === 0)) { zeroBlocks++; continue; }
      check(zeroBlocks === 0, 'TAR_DATA_AFTER_END');
      const header = tarHeader(headerBytes);
      check(!seen.has(header.path), 'DUPLICATE_TAR_PATH'); seen.add(header.path);
      if (!manifest) {
        check(header.path === MANIFEST_NAME && header.size <= MAX_MANIFEST_BYTES, 'MANIFEST_MUST_BE_FIRST');
        const bytes = await readExact(header.size);
        ({ manifest, totalBytes } = validateManifest(parseManifest(bytes)));
        expectations = new Map(manifest.files.map(file => [file.path, file]));
        await writeFile(join(destination, MANIFEST_NAME), bytes, { flag: 'wx', mode: 0o600 });
      } else {
        const expected = expectations.get(header.path);
        check(expected && expected.size === header.size, 'UNEXPECTED_TAR_FILE');
        const output = join(destination, header.path); await mkdir(dirname(output), { recursive: true, mode: 0o700 });
        const handle = await open(output, 'wx', 0o600), hash = createHash('sha256');
        try {
          let remaining = header.size, tail = '';
          while (remaining) {
            const bytes = await readExact(Math.min(64 * 1024, remaining)); remaining -= bytes.length;
            const search = tail + bytes.toString('latin1'); check(!search.includes(PRIVATE_KEY_MARKER), 'PRIVATE_IDENTITY_IN_ARCHIVE'); tail = search.slice(-(PRIVATE_KEY_MARKER.length - 1));
            hash.update(bytes); await writeAll(handle, bytes);
          }
          check(hash.digest('hex') === expected.sha256, 'RESTORED_FILE_HASH_MISMATCH'); await handle.sync();
        } finally { await handle.close(); }
      }
      const padding = (512 - header.size % 512) % 512;
      if (padding) check((await readExact(padding)).every(value => value === 0), 'INVALID_TAR_PADDING');
    }
    check(zeroBlocks >= 2 && manifest && seen.size === manifest.files.length + 1, 'INCOMPLETE_ARCHIVE');
    check(manifest.files.every(file => seen.has(file.path)), 'MISSING_ARCHIVE_FILE');
    return { manifest, files: manifest.files.length, totalBytes };
  } finally { source.destroy(); unzip.destroy(); }
}

/** Fully authenticate age ciphertext before inspecting tar. Never invokes tar extraction. */
export async function verifyArchive({ archiveFile, identityFile, destinationDir, ageBin = process.env.AGE_BIN }) {
  requireBinary(ageBin);
  const archive = await canonicalRegularFile(archiveFile), identity = await canonicalRegularFile(identityFile);
  check((await stat(archive)).size <= MAX_TOTAL_BYTES + 1024 * MAX_FILES + MAX_MANIFEST_BYTES, 'CIPHERTEXT_SIZE_LIMIT');
  const destination = await canonicalNewPath(destinationDir);
  check(archive !== identity, 'IDENTITY_CANNOT_BE_ARCHIVE');
  await mkdir(destination, { mode: 0o700 });
  let temp, payloadHandle, identityHandle, archiveHandle, success = false;
  try {
    temp = await mkdtemp(join(dirname(destination), '.eco-unseal-')); await chmod(temp, 0o700);
    const payload = join(temp, 'payload.tar.gz'); payloadHandle = await open(payload, 'wx', 0o600);
    identityHandle = await open(identity, constants.O_RDONLY | constants.O_NOFOLLOW);
    archiveHandle = await open(archive, constants.O_RDONLY | constants.O_NOFOLLOW);
    await run(ageBin, ['--decrypt', '--identity', '/dev/fd/3'], [archiveHandle.fd, payloadHandle.fd, 'pipe', identityHandle.fd]);
    await payloadHandle.sync(); await payloadHandle.close(); payloadHandle = undefined;
    await identityHandle.close(); identityHandle = undefined; await archiveHandle.close(); archiveHandle = undefined;
    const result = await unpackVerifiedTar(payload, destination); success = true;
    return { destinationDir: destination, ...result };
  } finally {
    await cleanupPrivateArtifacts({ handles: [payloadHandle, identityHandle, archiveHandle], paths: [temp, !success ? destination : undefined] });
  }
}
