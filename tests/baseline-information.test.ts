import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error local release metadata module
import { migrationFingerprint, sourceFingerprint } from '../scripts/generate-system-information.mjs';

const sql = '-- BOOTSTRAP SECTION 20250101000000_example.sql\nselect 1;\n';
const metadata = { schemaVersion: 1, legacyHead: '20250101000000', sections: 1, purpose: 'Synthetic bootstrap fixture' };
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'eco-baseline-metadata-'));
  try {
    await mkdir(join(root, 'supabase/baseline'), { recursive: true });
    await mkdir(join(root, 'supabase/migrations'), { recursive: true });
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
const schemaPath = (root: string) => join(root, 'supabase/baseline/schema.sql');
const metadataPath = (root: string) => join(root, 'supabase/baseline/metadata.json');

test('release metadata permits no bootstrap but fails closed if either bootstrap file is missing', async () => {
  await fixture(async root => {
    const absent = await migrationFingerprint(root);
    assert.equal(absent.bundledHead, null);
    assert.equal(absent.baseline, undefined);
    await writeFile(schemaPath(root), sql);
    await assert.rejects(migrationFingerprint(root), /Incomplete bootstrap/);
    await rm(schemaPath(root));
    await writeFile(metadataPath(root), JSON.stringify(metadata));
    await assert.rejects(migrationFingerprint(root), /Incomplete bootstrap/);
  });
});

test('bootstrap identity participates in migration and runtime-source digests and provides the legacy head', async () => {
  await fixture(async root => {
    await writeFile(schemaPath(root), sql);
    await writeFile(metadataPath(root), JSON.stringify(metadata));
    const before = await migrationFingerprint(root), sourceBefore = await sourceFingerprint(root);
    assert.equal(before.bundledHead, metadata.legacyHead);
    assert.equal(before.count, 0);
    assert.deepEqual(before.baseline, { head: metadata.legacyHead, sections: 1, sha256: createHash('sha256').update(sql).digest('hex') });
    await writeFile(schemaPath(root), sql.replace('select 1', 'select 2'));
    assert.notEqual((await migrationFingerprint(root)).sha256, before.sha256);
    assert.notEqual((await sourceFingerprint(root)).sha256, sourceBefore.sha256);
    await writeFile(schemaPath(root), sql);
    await writeFile(metadataPath(root), JSON.stringify({ ...metadata, purpose: 'Updated synthetic bootstrap provenance' }));
    assert.notEqual((await migrationFingerprint(root)).sha256, before.sha256);
    assert.notEqual((await sourceFingerprint(root)).sha256, sourceBefore.sha256);
    await writeFile(join(root, 'supabase/migrations/20250102000000_additive.sql'), 'select 3;');
    const additive = await migrationFingerprint(root);
    assert.equal(additive.bundledHead, '20250102000000');
    assert.equal(additive.count, 1);
    assert.equal(additive.baseline.head, metadata.legacyHead);
  });
});

test('bootstrap schema version, head and actual SQL section count are validated', async () => {
  await fixture(async root => {
    await writeFile(schemaPath(root), sql);
    for (const invalid of [
      { ...metadata, schemaVersion: 2 }, { ...metadata, schemaVersion: '1' },
      { ...metadata, legacyHead: 'not-a-version' }, { ...metadata, legacyHead: null },
      { ...metadata, sections: 0 }, { ...metadata, sections: 2 },
      { ...metadata, sections: 1.5 }, { ...metadata, sections: '1' },
    ]) {
      await writeFile(metadataPath(root), JSON.stringify(invalid));
      await assert.rejects(migrationFingerprint(root), /Invalid bootstrap metadata/);
    }
    await writeFile(metadataPath(root), '{');
    await assert.rejects(migrationFingerprint(root), SyntaxError);
    await writeFile(metadataPath(root), JSON.stringify(metadata));
    await writeFile(schemaPath(root), 'select 1;\n');
    await assert.rejects(migrationFingerprint(root), /Invalid bootstrap metadata/);
  });
});

test('additive migration versions cannot overlap or precede the private legacy history', async () => {
  await fixture(async root => {
    await writeFile(schemaPath(root), sql);
    await writeFile(metadataPath(root), JSON.stringify(metadata));
    for (const version of ['20241231000000', metadata.legacyHead]) {
      const path = join(root, `supabase/migrations/${version}_overlap.sql`);
      await writeFile(path, 'select 1;');
      await assert.rejects(migrationFingerprint(root), /precedes or duplicates bootstrap history/);
      await rm(path);
    }
    await writeFile(join(root, 'supabase/migrations/20250102000000_first.sql'), 'select 1;');
    await writeFile(join(root, 'supabase/migrations/20250102000000_duplicate.sql'), 'select 2;');
    await assert.rejects(migrationFingerprint(root), /Duplicate migration version/);
  });
});
