import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allowedFiles = [
  'lib/enquiryWorksheetParser.ts', 'lib/enquiryPortIndex.ts', 'lib/enquiryShortener.ts',
  'lib/spcEnquiryText.ts', 'data/priceSetterTabs.ts', 'data/reportSections.ts',
];
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function adaptFcunoImports(source) {
  return source.replace(/(from\s+["'])@\/lib\//g, '$1./').replace(/(from\s+["'])@\/data\//g, '$1../data/')
    .replace(/(from\s+["'])(\.{1,2}\/[^"']+)(["'])/g, (_, before, path, after) => `${before}${path.endsWith('.ts') ? path : path + '.ts'}${after}`);
}
function git(source, args) {
  try { return execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { throw new Error('Cannot read the specified FCUNO repository/revision. No files were changed.'); }
}
function githubRepository(remote) {
  return remote.trim().match(/^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?$/)?.[1];
}
export async function verifyFcunoParser({ root = repositoryRoot, source, revision } = {}) {
  if (Boolean(source) !== Boolean(revision)) throw new Error('Provide both --source and an explicit full --revision, or neither.');
  if (revision && !/^[a-f0-9]{40}$/.test(revision)) throw new Error('Revision must be an explicit full 40-character Git commit SHA.');
  const directory = resolve(root, 'src/vendor/fcuno');
  const manifest = JSON.parse(await readFile(resolve(directory, 'version.json'), 'utf8'));
  if (manifest.version !== 1 || !/^[a-f0-9]{40}$/.test(manifest.sourceCommit) || manifest.importAdaptation !== 'relative-imports-explicit-ts-v2' ||
      typeof manifest.sourceRepository !== 'string' || !Array.isArray(manifest.files) || manifest.files.length !== allowedFiles.length ||
      allowedFiles.some(path => manifest.files.filter(file => file.path === path).length !== 1) ||
      manifest.files.some(file => !allowedFiles.includes(file.path) || !/^[a-f0-9]{64}$/.test(file.sourceSha256) || !/^[a-f0-9]{64}$/.test(file.vendorSha256))) {
    throw new Error('Invalid FCUNO parser version manifest.');
  }
  const changed = [];
  for (const file of manifest.files) {
    const local = await readFile(resolve(directory, file.path));
    if (sha256(local) !== file.vendorSha256) changed.push(file.path);
  }
  if (changed.length) throw new Error(`Pinned FCUNO vendor files changed: ${changed.join(', ')}. Review the upstream version and update its manifest deliberately.`);
  if (!source) return { ok: true, sourceRepository: manifest.sourceRepository, pinnedRevision: manifest.sourceCommit, files: manifest.files.length, comparedRevision: null };
  if (githubRepository(git(source, ['remote', 'get-url', 'origin'])) !== manifest.sourceRepository) throw new Error('FCUNO source repository identity mismatch.');
  if (git(source, ['cat-file', '-t', revision]).trim() !== 'commit') throw new Error('The supplied revision is not a commit.');
  const upstreamChanged = [];
  for (const file of manifest.files) {
    const original = git(source, ['show', `${revision}:${file.path}`]);
    if (revision === manifest.sourceCommit && sha256(original) !== file.sourceSha256) throw new Error(`Pinned FCUNO source hash mismatch: ${file.path}.`);
    if (sha256(adaptFcunoImports(original)) !== file.vendorSha256) upstreamChanged.push(file.path);
  }
  return { ok: upstreamChanged.length === 0, sourceRepository: manifest.sourceRepository, pinnedRevision: manifest.sourceCommit,
    comparedRevision: revision, files: manifest.files.length, upstreamChanged };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--source', '--revision'].includes(args[i]) || !args[i + 1] || options[args[i].slice(2)]) throw new Error('Usage: node scripts/check-fcuno-parser.mjs [--source <local FCUNO checkout> --revision <full commit SHA>]');
      options[args[i].slice(2)] = args[i + 1];
    }
    const result = await verifyFcunoParser(options);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
