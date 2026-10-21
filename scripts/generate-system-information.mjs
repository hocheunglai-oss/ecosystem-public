import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ecoConnections } from '../config/ecoConnections.ts';

const exec = promisify(execFile);
const sourceRoots = ['src', 'server', 'api', 'shared', 'config', 'public', 'supabase/migrations', 'supabase/baseline'];
const sourceFiles = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'vite.config.ts', 'tsconfig.json', 'tsconfig.server.json', 'vercel.json', 'scripts/generate-system-information.mjs'];
const generatedPath = 'server/generated/system-information.ts';
const hash = value => createHash('sha256').update(value).digest('hex');

// Vercel minifies vercel.json and supplies these two identity/schema defaults
// during its build. Compare its full effective JSON rather than that serialization.
function canonicalVercelConfiguration(contents) {
  const config = JSON.parse(contents.toString('utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Vercel configuration must be a JSON object');
  if (Object.hasOwn(config, 'name') && config.name !== ecoConnections.vercel.projectName) throw new Error('Vercel configuration project name mismatch');
  if (Object.hasOwn(config, 'version') && config.version !== 2) throw new Error('Vercel configuration version mismatch');
  function sorted(value) {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
    return value;
  }
  return JSON.stringify(sorted({ ...config, name: ecoConnections.vercel.projectName, version: 2 }));
}

export async function sourceFingerprint(root) {
  const files = [];
  async function visit(path) {
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      const name = `${path}/${entry.name}`;
      if (name === 'server/generated') continue;
      if (entry.isSymbolicLink()) throw new Error('Source symlinks are not permitted in release metadata');
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) files.push(name);
    }
  }
  for (const path of sourceRoots) {
    try { await visit(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const path of sourceFiles) {
    try { await readFile(join(root, path)); files.push(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  files.sort();
  const digest = createHash('sha256');
  for (const file of files) {
    const contents = await readFile(join(root, file));
    digest.update(`${file}\0${hash(file === 'vercel.json' ? canonicalVercelConfiguration(contents) : contents)}\n`);
  }
  return { sha256: digest.digest('hex'), count: files.length };
}

export function resolvedDependencies(packageJson, roots) {
  const root = roots[0];
  if (!root) throw new Error('Installed dependency inventory is missing');
  const dependencies = [];
  for (const group of ['dependencies', 'devDependencies']) {
    for (const name of Object.keys(packageJson[group] ?? {}).sort()) {
      const version = root[group]?.[name]?.version;
      if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version)) {
        throw new Error(`No exact installed version for ${name}`);
      }
      dependencies.push({ name, version, scope: group === 'dependencies' ? 'runtime' : 'development' });
    }
  }
  return dependencies;
}

export async function migrationFingerprint(root) {
  const path = join(root, 'supabase/migrations');
  const names = (await readdir(path)).filter(name => /^\d{14}_[a-z0-9_]+\.sql$/.test(name)).sort();
  const versions = names.map(name => name.slice(0, 14));
  if (new Set(versions).size !== versions.length) throw new Error('Duplicate migration version');
  const digest = createHash('sha256');
  let baseline = null;
  const bootstrapPaths = ['schema.sql', 'metadata.json'].map(name => join(root, 'supabase/baseline', name));
  const bootstrapFiles = await Promise.all(bootstrapPaths.map(async path => {
    try { return await readFile(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }));
  if (bootstrapFiles.some(file => file !== null)) {
    if (bootstrapFiles.some(file => file === null)) throw new Error('Incomplete bootstrap: schema and metadata are both required');
    const [sql, metadataBytes] = bootstrapFiles;
    const metadata = JSON.parse(metadataBytes.toString('utf8'));
    const sections = [...sql.toString('utf8').matchAll(/^-- BOOTSTRAP SECTION [^\n]+\.sql$/gm)].length;
    if (metadata.schemaVersion !== 1 || !/^\d{14}$/.test(metadata.legacyHead) || !Number.isSafeInteger(metadata.sections) || metadata.sections < 1 || metadata.sections !== sections) throw new Error('Invalid bootstrap metadata');
    if (versions.some(version => version <= metadata.legacyHead)) throw new Error('Migration precedes or duplicates bootstrap history');
    baseline = { head: metadata.legacyHead, sections: metadata.sections, sha256: hash(sql) };
    digest.update(`baseline/schema.sql\0${baseline.sha256}\n`);
    digest.update(`baseline/metadata.json\0${hash(JSON.stringify(metadata))}\n`);
  }
  for (const name of names) digest.update(`${name}\0${hash(await readFile(join(path, name)))}\n`);
  return { bundledHead: versions.at(-1) ?? baseline?.head ?? null, count: names.length, sha256: digest.digest('hex'), ...(baseline ? { baseline } : {}) };
}

async function gitInformation(root, environment) {
  let gitCommit = /^[a-f0-9]{40}$/i.test(environment.VERCEL_GIT_COMMIT_SHA ?? '') ? environment.VERCEL_GIT_COMMIT_SHA.toLowerCase() : null;
  let gitWorktree = 'unknown';
  try {
    const { stdout } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: root });
    if (resolve(stdout.trim()) !== resolve(root)) return { gitCommit, gitWorktree };
    const status = await exec('git', ['status', '--porcelain', '--untracked-files=normal', '--', '.', ':(exclude)server/generated/**'], { cwd: root });
    gitWorktree = status.stdout.trim() ? 'dirty' : 'clean';
    const head = await exec('git', ['rev-parse', 'HEAD'], { cwd: root });
    if (/^[a-f0-9]{40}$/i.test(head.stdout.trim())) gitCommit = head.stdout.trim().toLowerCase();
  } catch { /* A CLI deployment may intentionally omit Git. The source digest remains authoritative. */ }
  return { gitCommit, gitWorktree };
}

export async function collectBuildInformation(root, environment = process.env) {
  if ((environment.VERCEL_PROJECT_ID && environment.VERCEL_PROJECT_ID !== ecoConnections.vercel.projectId) ||
      (environment.VERCEL_ORG_ID && environment.VERCEL_ORG_ID !== ecoConnections.vercel.teamId)) throw new Error('ECO build target mismatch');
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const { stdout } = await exec('pnpm', ['list', '--json', '--depth', '0'], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
  const source = await sourceFingerprint(root);
  const lockfileSha256 = hash(await readFile(join(root, 'pnpm-lock.yaml')));
  const vercel = JSON.parse(await readFile(join(root, 'vercel.json'), 'utf8'));
  return {
    schemaVersion: 1,
    application: { name: packageJson.name, version: packageJson.version },
    build: { builtAt: new Date().toISOString(), releaseId: `eco-${source.sha256.slice(0, 16)}`, sourceSha256: source.sha256,
      sourceFileCount: source.count, lockfileSha256, ...await gitInformation(root, environment),
      buildNode: process.version, requiredNode: packageJson.engines.node },
    dependencies: resolvedDependencies(packageJson, JSON.parse(stdout)),
    migrations: await migrationFingerprint(root),
    targets: { databaseRegion: ecoConnections.supabaseRegion, databaseProjectRef: ecoConnections.supabaseProjectRef,
      computeRegions: vercel.regions, identityMode: ecoConnections.identityMode },
  };
}

export function comparableBuildInformation(value) {
  const { builtAt, ...build } = value.build;
  return { ...value, build };
}

async function main() {
  const root = resolve('.');
  const value = await collectBuildInformation(root);
  const file = join(root, generatedPath);
  if (process.argv.includes('--check')) {
    const text = await readFile(file, 'utf8');
    const marker = 'export const generatedSystemInformation: SystemBuildInformation = ';
    const stored = JSON.parse(text.slice(text.indexOf(marker) + marker.length).trim().replace(/;$/, ''));
    if (JSON.stringify(comparableBuildInformation(value)) !== JSON.stringify(comparableBuildInformation(stored))) {
      throw new Error('System information is stale; source, dependencies or configuration changed during this build');
    }
    console.log(`Verified system information ${value.build.releaseId}.`);
    return;
  }
  await mkdir(join(root, 'server/generated'), { recursive: true });
  await writeFile(file, `// GENERATED BY scripts/generate-system-information.mjs. No credentials or user data.\nimport type { SystemBuildInformation } from '../../shared/system.ts';\nexport const generatedSystemInformation: SystemBuildInformation = ${JSON.stringify(value, null, 2)};\n`);
  console.log(`Generated system information ${value.build.releaseId}: ${value.dependencies.length} installed dependencies, ${value.migrations.count} migrations.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'System information generation failed'); process.exitCode = 1; });
}
