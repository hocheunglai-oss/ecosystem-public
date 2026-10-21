import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error local operational verification module
import { hostedMigrationHistory, assertHostedMigrationHistory, hostedMigrationVersion } from '../scripts/hosted-migration-history.mjs';

const oldNames = ['20250101000000_example.sql', '20250102000000_example_review.sql'];
const newName = '20250103000000_additive.sql';
const schema = (names = oldNames) => names.map(name => `-- BOOTSTRAP SECTION ${name}\nselect 1;\n`).join('');
const metadata = { schemaVersion: 1, legacyHead: '20250102000000', sections: 2, purpose: 'Synthetic fixture' };
async function fixture(run: (root: string) => Promise<void>, baseline = true) {
  const root = await mkdtemp(join(tmpdir(), 'eco-hosted-history-'));
  try {
    await mkdir(join(root, 'supabase/baseline'), { recursive: true });
    await mkdir(join(root, 'supabase/migrations'), { recursive: true });
    if (baseline) {
      await writeFile(join(root, 'supabase/baseline/schema.sql'), schema());
      await writeFile(join(root, 'supabase/baseline/metadata.json'), JSON.stringify(metadata));
    }
    await writeFile(join(root, `supabase/migrations/${newName}`), 'select 2;');
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('hosted history joins retained baseline versions to additive files without rewriting either source', async () => {
  await fixture(async root => {
    const before = await readFile(join(root, 'supabase/baseline/schema.sql'), 'utf8');
    const history = await hostedMigrationHistory(root);
    assert.deepEqual(history, { names: [...oldNames, newName], versions: ['20250101000000', '20250102000000', '20250103000000'], legacyCount: 2 });
    assert.doesNotThrow(() => assertHostedMigrationHistory([...history.versions].reverse(), history));
    assert.equal(await readFile(join(root, 'supabase/baseline/schema.sql'), 'utf8'), before);
  });
});

test('exact remote check rejects missing legacy/additive rows, unexpected old/new rows and duplicates', async () => {
  await fixture(async root => {
    const history = await hostedMigrationHistory(root);
    for (const applied of [history.versions.slice(1), history.versions.slice(0, -1), ['20241231000000', ...history.versions], [...history.versions, '20250104000000'], [...history.versions, history.versions[0]]]) {
      assert.throws(() => assertHostedMigrationHistory(applied, history), /exactly match|Duplicate remote/);
    }
    for (const invalid of [null, {}, [20250101000000], ['invalid'], ['2025010100000'], [' 20250101000000']]) {
      assert.throws(() => assertHostedMigrationHistory(invalid, history), /version array|Invalid remote migration/);
    }
  });
});

test('component heads resolve retained sections and later additive versions, never guess an absent component', async () => {
  await fixture(async root => {
    let history = await hostedMigrationHistory(root);
    assert.equal(hostedMigrationVersion(history, 'example'), '20250101000000');
    assert.equal(hostedMigrationVersion(history, 'additive'), '20250103000000');
    assert.equal(hostedMigrationVersion(history, ['example', 'example_review']), '20250102000000');
    assert.throws(() => hostedMigrationVersion(history, 'absent'), /absent/);
    for (const invalid of ['', '../example', [], [null]]) assert.throws(() => hostedMigrationVersion(history, invalid), /Invalid migration component/);
    await writeFile(join(root, 'supabase/migrations/20250104000000_example.sql'), 'select 3;');
    history = await hostedMigrationHistory(root);
    assert.equal(hostedMigrationVersion(history, 'example'), '20250104000000');
    assert.equal(history.versions.length, 4);
  });
});

test('baseline metadata version/count/head and section order/names/uniqueness fail closed', async () => {
  for (const change of [{ schemaVersion: 2 }, { schemaVersion: '1' }, { sections: 1 }, { legacyHead: '20250101000000' }, { legacyHead: '20250102595959' }]) {
    await fixture(async root => {
      await writeFile(join(root, 'supabase/baseline/metadata.json'), JSON.stringify({ ...metadata, ...change }));
      await assert.rejects(hostedMigrationHistory(root), /bootstrap|Bootstrap|duplicates bootstrap/);
    });
  }
  for (const names of [[...oldNames].reverse(), [oldNames[1], oldNames[1]], ['not-a-version.sql', oldNames[1]], ['20250101000000_bad-name.sql', oldNames[1]]]) {
    await fixture(async root => {
      await writeFile(join(root, 'supabase/baseline/schema.sql'), schema(names));
      await assert.rejects(hostedMigrationHistory(root), /Bootstrap|bootstrap|Duplicate hosted/);
    });
  }
});

test('partial baselines, overlapping or duplicate additive versions and malformed SQL filenames fail closed', async () => {
  for (const file of ['schema.sql', 'metadata.json']) await fixture(async root => {
    await rm(join(root, `supabase/baseline/${file}`));
    await assert.rejects(hostedMigrationHistory(root), /Incomplete bootstrap/);
  });
  for (const name of ['20250101000000_overlap.sql', '20250102000000_overlap.sql', '20250103000000_duplicate.sql', 'bad_version.sql']) await fixture(async root => {
    await writeFile(join(root, `supabase/migrations/${name}`), 'select 3;');
    await assert.rejects(hostedMigrationHistory(root), /precedes or duplicates|Duplicate migration|Invalid additive/);
  });
});

test('pre-baseline source still verifies its full individual migration history', async () => {
  await fixture(async root => {
    const history = await hostedMigrationHistory(root);
    assert.deepEqual(history, { names: [newName], versions: ['20250103000000'], legacyCount: 0 });
    assert.doesNotThrow(() => assertHostedMigrationHistory(history.versions, history));
  }, false);
});

test('the public repository preserves the existing hosted component history across the clean baseline', async () => {
  const root = new URL('..', import.meta.url).pathname;
  const history = await hostedMigrationHistory(root);
  const actualMetadata = JSON.parse(await readFile(join(root, 'supabase/baseline/metadata.json'), 'utf8'));
  assert.equal(history.legacyCount, actualMetadata.sections);
  assert.equal(history.versions[history.legacyCount - 1], actualMetadata.legacyHead);
  assert.doesNotThrow(() => assertHostedMigrationHistory(history.versions, history));
  for (const component of ['eco_whatsapp_intake', 'eco_parser_test_workspace_release', 'eco_parser_review_workflow', 'eco_shared_enquiry_inbox', 'eco_commercial_enquiries', 'eco_private_intelligence', 'eco_owner_capabilities']) {
    assert.match(hostedMigrationVersion(history, component), /^\d{14}$/);
  }
});
