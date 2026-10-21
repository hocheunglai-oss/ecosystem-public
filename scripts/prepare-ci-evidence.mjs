import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, writeFile, appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_REPORT_BYTES = 256 * 1024;
const DIAGNOSTIC_BYTES = 20 * 1024 * 1024;
const BUILD_FILES = [
  'output/security/build-check.json',
  'output/security/dependencies.cdx.json',
  'server/generated/system-information.ts',
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const isObject = value => value !== null && typeof value === 'object';

async function fileHash(filename) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest('hex');
}

function safeRelative(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value)
    || value.split('/').some(part => !part || part === '..' || part.startsWith('.'))
    || /[\r\n\\]/.test(value)) throw new Error('Invalid evidence path');
  return value;
}

async function inspectPath(root, relative) {
  // Check every parent as well as the leaf: evidence must not follow a symlink.
  let current = root;
  for (const part of safeRelative(relative).split('/')) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error('Evidence paths must not contain symlinks');
  }
  return lstat(current);
}

async function collect(root, relative, files) {
  const info = await inspectPath(root, relative);
  if (info.isDirectory()) {
    for (const name of (await readdir(path.join(root, relative))).sort()) {
      await collect(root, `${relative}/${name}`, files);
    }
  } else if (info.isFile()) {
    files.push({
      path: relative, bytes: info.size,
      sha256: await fileHash(path.join(root, relative)),
      modifiedAt: info.mtimeMs,
    });
  } else throw new Error('Evidence must contain regular files');
}

function parseReport(relative, text) {
  const jsonText = relative.endsWith('.ts')
    ? text.match(/export const generatedSystemInformation: SystemBuildInformation = ([\s\S]*);\s*$/)?.[1]
    : text;
  if (!jsonText) throw new Error('Build metadata is not a generated JSON object');
  const value = JSON.parse(jsonText);
  if (!isObject(value)) throw new Error('Evidence report must be an object or array');
  if (relative.endsWith('system-information.ts')
    && (!/^[a-f0-9]{64}$/.test(value.build?.sourceSha256)
      || !/^[a-f0-9]{40}$/.test(value.build?.gitCommit))) {
    throw new Error('Build metadata is missing source provenance');
  }
  return value;
}

export async function prepareEvidence({
  root, kind, group = kind, commit, headCommit = null, runId = null,
  outcome, directories = [], summaryFile = null, log = console.log,
}) {
  if (!['build', 'browser'].includes(kind) || !/^[a-z][a-z0-9-]{0,39}$/.test(group)
    || !/^[a-f0-9]{40}$/.test(commit) || (headCommit && !/^[a-f0-9]{40}$/.test(headCommit))
    || !['success', 'failure', 'cancelled'].includes(outcome)) {
    throw new Error('Invalid evidence identity or quality outcome');
  }
  const inputs = kind === 'build' ? BUILD_FILES : directories;
  if (!inputs.length) throw new Error('Evidence input directories are required');
  for (const value of inputs) safeRelative(value);
  if (kind === 'browser' && inputs.some(value => !value.startsWith('output/')
    || value.startsWith('output/ci-evidence'))) throw new Error('Invalid browser evidence directory');
  const files = [];
  const missing = [];
  for (const relative of inputs) {
    try { await collect(root, relative, files); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.push(relative);
    }
  }
  const reports = [];
  for (const file of files) {
    if (!file.path.endsWith('.json') && !BUILD_FILES.includes(file.path)) continue;
    if (file.bytes > MAX_REPORT_BYTES) throw new Error('Evidence report exceeds the bounded log size');
    const content = parseReport(file.path, await readFile(path.join(root, file.path), 'utf8'));
    if (file.path.endsWith('system-information.ts') && content.build.gitCommit !== commit) {
      throw new Error('Build metadata does not match the tested commit');
    }
    reports.push({ path: file.path, sha256: file.sha256, bytes: file.bytes, content });
  }
  if (outcome === 'success' && (missing.length || inputs.some(input =>
    !reports.some(report => report.path === input || report.path.startsWith(`${input}/`))))) {
    throw new Error('A successful quality run requires every expected report');
  }

  const diagnosticCandidates = files.filter(file => /\.(png|html)$/.test(file.path))
    .sort((a, b) => Number(/fail|error/.test(b.path)) - Number(/fail|error/.test(a.path))
      || b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path));
  const diagnostics = [];
  // Reserve the maximum manifest size, ensuring the complete failure archive stays bounded.
  let remaining = DIAGNOSTIC_BYTES - MAX_MANIFEST_BYTES;
  if (outcome !== 'success') {
    for (const file of diagnosticCandidates) {
      if (file.bytes > remaining) continue;
      diagnostics.push(file.path);
      remaining -= file.bytes;
    }
  }
  const manifest = {
    schemaVersion: 1, kind, group, sourceCommit: commit, pullRequestHead: headCommit,
    runId, qualityOutcome: outcome,
    counts: {
      files: files.length, reports: reports.length,
      screenshots: files.filter(file => file.path.endsWith('.png')).length,
      totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    },
    missingInputs: missing,
    files: files.map(({ modifiedAt: _time, ...file }) => file),
    reports,
    diagnosticArchive: { maxBytes: DIAGNOSTIC_BYTES, selected: diagnostics,
      omitted: outcome === 'success' ? 0 : diagnosticCandidates.length - diagnostics.length },
    limitations: [
      'Successful screenshot pixels are not archived; hashes prove identity but cannot reconstruct images.',
      'Browser fixture reports prove the tested local flow, not live provider delivery.',
      'Final release evidence still requires inspection of the affected staged screenshots.',
    ],
  };
  const serialized = `${JSON.stringify(manifest)}\n`;
  if (Buffer.byteLength(serialized) > MAX_MANIFEST_BYTES) throw new Error('Evidence manifest exceeds 1 MiB');
  const directory = `output/ci-evidence/${group}`;
  const parent = 'output/ci-evidence';
  await mkdir(path.join(root, parent), { recursive: true });
  await inspectPath(root, parent);
  // An evidence directory belongs to one invocation. Never reuse stale images/reports.
  await mkdir(path.join(root, directory));
  const compact = path.join(root, directory, 'compact');
  await mkdir(compact);
  await writeFile(path.join(compact, 'evidence.json'), serialized);
  for (const report of reports) {
    const destination = path.join(compact, report.path);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(root, report.path), destination);
  }
  if (outcome !== 'success') {
    const destination = path.join(root, directory, 'diagnostics');
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, 'evidence.json'), serialized);
    for (const relative of diagnostics) {
      const target = path.join(destination, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(root, relative), target);
    }
  }

  // Base64 avoids interpreting report text as workflow commands and retains exact manifest bytes.
  const encoded = Buffer.from(serialized).toString('base64');
  const chunks = encoded.match(/.{1,16384}/g) || [];
  log(`ECO_EVIDENCE_BEGIN ${JSON.stringify({ group, bytes: Buffer.byteLength(serialized),
    sha256: hash(serialized), chunks: chunks.length })}`);
  chunks.forEach((chunk, i) => log(`ECO_EVIDENCE_CHUNK ${i + 1}/${chunks.length} ${chunk}`));
  log('ECO_EVIDENCE_END');
  if (summaryFile) {
    await appendFile(summaryFile, [
      `### ${group} quality evidence`,
      '',
      `Tested commit: \`${commit}\`. Quality steps: **${outcome}**.`,
      `Validated reports: **${reports.length}**. Files hashed: **${files.length}**. Screenshots: **${manifest.counts.screenshots}**.`,
      `Manifest SHA-256: \`${hash(serialized)}\`. Exact JSON is recoverable from the numbered base64 chunks in the evidence step log.`,
      '',
      'Compact artifact upload is supplementary. Its absence does not remove the mandatory logged evidence or alter test outcomes.',
      'Successful screenshot pixels are not archived. Failure image/HTML diagnostics are limited to 20 MiB; the manifest lists omissions.',
      'Final release verification must still inspect the affected staged screenshots.',
      '',
    ].join('\n'));
  }
  return { manifest, serialized, directory };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== commit) throw new Error('CI checkout commit mismatch');
  await prepareEvidence({
    root, kind: process.argv[2], group: process.env.ECO_EVIDENCE_GROUP || process.argv[2],
    commit, headCommit: process.env.ECO_EVIDENCE_HEAD || null,
    runId: process.env.GITHUB_RUN_ID || null, outcome: process.env.ECO_QUALITY_OUTCOME,
    directories: (process.env.ECO_EVIDENCE_DIRS || '').split('\n').map(value => value.trim()).filter(Boolean),
    summaryFile: process.env.GITHUB_STEP_SUMMARY || null,
  });
}
