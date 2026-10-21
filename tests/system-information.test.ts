import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSystemInformation } from '../server/admin/system.ts';
import { ecoConnections } from '../config/ecoConnections.ts';
import { sourceFingerprint, migrationFingerprint, resolvedDependencies, comparableBuildInformation } from '../scripts/generate-system-information.mjs';

test('system metadata exposes only allowlisted runtime values and exact installed dependencies', () => {
  const info = getSystemInformation({ ECO_SUPABASE_SECRET_KEY: 'private-never-show', UNRELATED_SECRET: 'other-private',
    VERCEL_ENV: 'production', VERCEL_REGION: 'sin1', VERCEL_DEPLOYMENT_ID: 'dpl_123456789012345' });
  assert.equal(info.runtime.environment, 'production');
  assert.equal(info.runtime.region, 'sin1');
  assert.match(info.build.sourceSha256, /^[a-f0-9]{64}$/);
  assert.match(info.build.lockfileSha256, /^[a-f0-9]{64}$/);
  assert.equal(info.targets.databaseRegion, 'ap-southeast-1');
  assert.ok(info.dependencies.some(item => item.name === 'react'));
  for (const item of info.dependencies) assert.match(item.version, /^\d+\.\d+\.\d+/);
  assert.ok(!JSON.stringify(info).includes('private'));
  assert.equal(getSystemInformation({ VERCEL_REGION: 'secret/value', VERCEL_DEPLOYMENT_ID: 'secret/value' }).runtime.region, null);
  info.dependencies.length = 0;
  assert.ok(getSystemInformation().dependencies.length > 0);
});

test('unresolved dependency ranges cannot become a misleading inventory', () => {
  const packageJson = { dependencies: { react: '^19.3.0' }, devDependencies: { vite: '^8.3.0' } };
  assert.deepEqual(resolvedDependencies(packageJson, [{ dependencies: { react: { version: '19.3.0' } }, devDependencies: { vite: { version: '8.3.0' } } }]), [
    { name: 'react', version: '19.3.0', scope: 'runtime' }, { name: 'vite', version: '8.3.0', scope: 'development' },
  ]);
  assert.throws(() => resolvedDependencies(packageJson, [{ dependencies: { react: { version: '^19.3.0' } } }]), /exact installed version/);
});

test('source fingerprint changes with runtime source but excludes generated output and private env files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eco-system-info-'));
  try {
    await mkdir(join(root, 'src'));
    await mkdir(join(root, 'server/generated'), { recursive: true });
    await writeFile(join(root, 'src/main.ts'), 'first');
    const first = await sourceFingerprint(root);
    await writeFile(join(root, 'server/generated/system-information.ts'), 'generated timestamp');
    await writeFile(join(root, '.env.local'), 'TOP_SECRET=value');
    assert.deepEqual(await sourceFingerprint(root), first);
    await writeFile(join(root, 'src/main.ts'), 'second');
    assert.notEqual((await sourceFingerprint(root)).sha256, first.sha256);
    await symlink(join(root, '.env.local'), join(root, 'src/private-link'));
    await assert.rejects(sourceFingerprint(root), /symlinks/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('migration inventory changes for altered SQL and rejects duplicate versions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eco-migration-info-'));
  try {
    const path = join(root, 'supabase/migrations');
    await mkdir(path, { recursive: true });
    await writeFile(join(path, '20261014000000_first.sql'), 'select 1;');
    const before = await migrationFingerprint(root);
    assert.equal(before.bundledHead, '20261014000000');
    await writeFile(join(path, '20261014000000_first.sql'), 'select 2;');
    assert.notEqual((await migrationFingerprint(root)).sha256, before.sha256);
    await writeFile(join(path, '20261014000000_second.sql'), 'select 3;');
    await assert.rejects(migrationFingerprint(root), /Duplicate migration/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('stale-manifest comparison ignores only generation time', () => {
  const info = getSystemInformation();
  const changed = structuredClone(info);
  changed.build.builtAt = '2000-01-01T00:00:00Z';
  assert.deepEqual(comparableBuildInformation(info), comparableBuildInformation(changed));
  changed.build.sourceSha256 = '0'.repeat(64);
  assert.notDeepEqual(comparableBuildInformation(info), comparableBuildInformation(changed));
});


test('Vercel build serialization preserves the fingerprint with validated implicit defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eco-vercel-hash-'));
  try {
    const config = { framework: 'vite', regions: ['sin1'], headers: [{ source: '/(.*)', headers: [{ key: 'X-Test', value: 'Case Sensitive' }] }] };
    await writeFile(join(root, 'vercel.json'), JSON.stringify(config, null, 2) + '\n');
    const baseline = await sourceFingerprint(root);
    // Exact transformation observed in Vercel's build workspace.
    await writeFile(join(root, 'vercel.json'), JSON.stringify({ ...config, name: ecoConnections.vercel.projectName, version: 2 }) + '\n');
    assert.deepEqual(await sourceFingerprint(root), baseline);
    await writeFile(join(root, 'vercel.json'), JSON.stringify({ version: 2, name: ecoConnections.vercel.projectName, headers: [{ headers: [{ value: 'Case Sensitive', key: 'X-Test' }], source: '/(.*)' }], regions: ['sin1'], framework: 'vite' }, null, '\t'));
    assert.deepEqual(await sourceFingerprint(root), baseline);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Vercel fingerprint retains regions, routes, headers, unknown fields and array order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eco-vercel-values-'));
  try {
    const config = { regions: ['sin1', 'hnd1'], rewrites: [{ source: '/a', destination: '/b' }, { source: '/c', destination: '/d' }], headers: [{ source: '/(.*)', headers: [{ key: 'X-Test', value: 'Original' }] }], custom: { enabled: false } };
    await writeFile(join(root, 'vercel.json'), JSON.stringify(config));
    const baseline = await sourceFingerprint(root);
    const changes = [
      (value: typeof config) => { value.regions[0] = 'iad1'; },
      (value: typeof config) => { value.rewrites[0].destination = '/elsewhere'; },
      (value: typeof config) => { value.headers[0].headers[0].value = 'original'; },
      (value: typeof config) => { value.regions.reverse(); },
      (value: typeof config) => { value.rewrites.reverse(); },
      (value: typeof config) => { value.custom.enabled = true; },
    ];
    for (const change of changes) {
      const changed = structuredClone(config); change(changed);
      await writeFile(join(root, 'vercel.json'), JSON.stringify(changed));
      assert.notEqual((await sourceFingerprint(root)).sha256, baseline.sha256);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Vercel hashing rejects malformed JSON and conflicting project/schema identities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eco-vercel-invalid-'));
  try {
    for (const invalid of ['{', 'null', '[]', '{"name":"another-project"}', '{"name":null}', '{"version":1}', '{"version":"2"}']) {
      await writeFile(join(root, 'vercel.json'), invalid);
      await assert.rejects(sourceFingerprint(root));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('source fingerprint continues to hash all other files byte for byte', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eco-byte-hash-'));
  try {
    await writeFile(join(root, 'package.json'), '{"name":"example"}');
    const baseline = await sourceFingerprint(root);
    await writeFile(join(root, 'package.json'), '{\n  "name": "example"\n}\n');
    assert.notEqual((await sourceFingerprint(root)).sha256, baseline.sha256);
  } finally { await rm(root, { recursive: true, force: true }); }
});
