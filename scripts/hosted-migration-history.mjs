import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { migrationFingerprint } from './generate-system-information.mjs';

/** Expected existing hosted history, not instructions to replay the fresh-database baseline. */
export async function hostedMigrationHistory(root) {
  // Reuse release checks for paired baseline files, metadata schema, section count,
  // duplicate additive versions and migrations that overlap the legacy boundary.
  const fingerprint = await migrationFingerprint(root);
  const additive = (await readdir(join(root, 'supabase/migrations'))).filter(name => name.endsWith('.sql')).sort();
  assert.ok(additive.every(name => /^\d{14}_[a-z0-9_]+\.sql$/.test(name)), 'Invalid additive migration filename.');
  let legacy = [];
  if (fingerprint.baseline) {
    const sql = await readFile(join(root, 'supabase/baseline/schema.sql'), 'utf8');
    legacy = [...sql.matchAll(/^-- BOOTSTRAP SECTION (\d{14}_[a-z0-9_]+\.sql)$/gm)].map(match => match[1]);
    assert.equal(legacy.length, fingerprint.baseline.sections, 'Invalid bootstrap migration section names.');
    assert.deepEqual(legacy, [...legacy].sort(), 'Bootstrap migration sections must be in version order.');
    assert.equal(legacy.at(-1)?.slice(0, 14), fingerprint.baseline.head, 'Bootstrap migration head must match its final section.');
  }
  const names = [...legacy, ...additive];
  const versions = names.map(name => name.slice(0, 14));
  assert.equal(new Set(versions).size, versions.length, 'Duplicate hosted migration version.');
  return { names, versions, legacyCount: legacy.length };
}

/** Verify full historical identity; never silently accept a gap, duplicate or newer deployment. */
export function assertHostedMigrationHistory(applied, expected) {
  assert.ok(Array.isArray(applied), 'Remote migration history must be a version array.');
  assert.ok(applied.every(version => typeof version === 'string' && /^\d{14}$/.test(version)), 'Invalid remote migration version.');
  assert.equal(new Set(applied).size, applied.length, 'Duplicate remote migration version.');
  assert.deepEqual([...applied].sort(), expected.versions, 'Remote migrations must exactly match this staged source: no pending or extra versions.');
}

/** Resolve component markers across the retained baseline and future additive migrations. */
export function hostedMigrationVersion(history, suffixes) {
  const accepted = Array.isArray(suffixes) ? suffixes : [suffixes];
  assert.ok(accepted.length > 0 && accepted.every(name => typeof name === 'string' && /^[a-z0-9_]+$/.test(name)), 'Invalid migration component name.');
  const version = history.names.filter(name => accepted.includes(name.slice(15, -4))).at(-1)?.slice(0, 14);
  assert.ok(version, 'Required component migration is absent from staged source.');
  return version;
}
