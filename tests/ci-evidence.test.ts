import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareEvidence } from '../scripts/prepare-ci-evidence.mjs';

const commit = 'a'.repeat(40);
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'eco-ci-evidence-'));
  try {
    await mkdir(join(root, 'output/suite'), { recursive: true });
    await writeFile(join(root, 'output/suite/results.json'), JSON.stringify({ results: [{ ok: true }] }));
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
const input = (root: string) => ({ root, kind: 'browser', group: 'example', commit,
  directories: ['output/suite'], outcome: 'success', log: () => {} });

test('success evidence logs exact recoverable reports and all screenshot hashes without archiving pixels', async () => {
  await fixture(async root => {
    const bytes = Buffer.from('synthetic screenshot bytes');
    await writeFile(join(root, 'output/suite/phone.png'), bytes);
    const lines: string[] = [];
    const evidence = await prepareEvidence({ ...input(root), log: (value: string) => lines.push(value),
      summaryFile: join(root, 'summary.md') });
    const header = JSON.parse(lines[0].slice('ECO_EVIDENCE_BEGIN '.length));
    const restored = Buffer.from(lines.filter(line => line.startsWith('ECO_EVIDENCE_CHUNK '))
      .map(line => line.split(' ')[2]).join(''), 'base64');
    assert.equal(createHash('sha256').update(restored).digest('hex'), header.sha256);
    assert.equal(restored.toString(), evidence.serialized);
    assert.equal(evidence.manifest.counts.screenshots, 1);
    assert.equal(evidence.manifest.files.find((file: any) => file.path.endsWith('.png')).sha256,
      createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(evidence.manifest.reports[0].content, { results: [{ ok: true }] });
    const archived = await readdir(join(root, 'output/ci-evidence/example/compact/output/suite'));
    assert.deepEqual(archived, ['results.json']);
    assert.match(await readFile(join(root, 'summary.md'), 'utf8'), /Quality steps: \*\*success\*\*/);
    await assert.rejects(prepareEvidence(input(root)), { code: 'EEXIST' });
  });
});

test('success fails closed for missing or malformed reports; failed quality retains explicit missing evidence', async () => {
  await fixture(async root => {
    await assert.rejects(prepareEvidence({ ...input(root), directories: ['output/missing'] }), /every expected report/);
    const failed = await prepareEvidence({ ...input(root), outcome: 'failure', directories: ['output/missing'] });
    assert.deepEqual(failed.manifest.missingInputs, ['output/missing']);
    assert.equal(failed.manifest.qualityOutcome, 'failure');
    await writeFile(join(root, 'output/suite/results.json'), '{broken');
    await assert.rejects(prepareEvidence(input(root)), SyntaxError);
  });
});

test('symlinks, path escapes, oversized reports and wrong commit provenance cannot become quality evidence', async () => {
  await fixture(async root => {
    await assert.rejects(prepareEvidence({ ...input(root), directories: ['../outside'] }), /Invalid evidence path/);
    await writeFile(join(root, 'outside.json'), '{"credential":"must-not-log"}');
    await symlink(join(root, 'outside.json'), join(root, 'output/suite/private.json'));
    await assert.rejects(prepareEvidence(input(root)), /symlinks/);
    await rm(join(root, 'output/suite/private.json'));
    await writeFile(join(root, 'output/suite/results.json'), JSON.stringify({ big: 'x'.repeat(256 * 1024) }));
    await assert.rejects(prepareEvidence(input(root)), /bounded log size/);
  });
});

test('build evidence preserves inventory, build checks and generated metadata and rejects stale builds', async () => {
  await fixture(async root => {
    await mkdir(join(root, 'output/security'));
    await mkdir(join(root, 'server/generated'), { recursive: true });
    await writeFile(join(root, 'output/security/build-check.json'), '{"metrics":{},"findings":[]}');
    await writeFile(join(root, 'output/security/dependencies.cdx.json'), '{"bomFormat":"CycloneDX","components":[]}');
    const filename = join(root, 'server/generated/system-information.ts');
    const metadata = { build: { sourceSha256: 'b'.repeat(64), gitCommit: commit } };
    await writeFile(filename, `export const generatedSystemInformation: SystemBuildInformation = ${JSON.stringify(metadata)};\n`);
    const evidence = await prepareEvidence({ root, kind: 'build', commit, outcome: 'success', log: () => {} });
    assert.equal(evidence.manifest.reports.length, 3);
    assert.deepEqual(evidence.manifest.reports.find((item: any) => item.path.endsWith('.ts')).content, metadata);
    metadata.build.gitCommit = 'c'.repeat(40);
    await writeFile(filename, `export const generatedSystemInformation: SystemBuildInformation = ${JSON.stringify(metadata)};\n`);
    await assert.rejects(prepareEvidence({ root, kind: 'build', commit, outcome: 'success', log: () => {} }),
      /tested commit/);
  });
});

test('failure diagnostics retain quality failure, prioritize failure files and remain within 20 MiB', async () => {
  await fixture(async root => {
    await writeFile(join(root, 'output/suite/failure.png'), Buffer.alloc(11 * 1024 * 1024, 1));
    await writeFile(join(root, 'output/suite/earlier.png'), Buffer.alloc(11 * 1024 * 1024, 2));
    const evidence = await prepareEvidence({ ...input(root), outcome: 'failure' });
    assert.equal(evidence.manifest.qualityOutcome, 'failure');
    assert.deepEqual(evidence.manifest.diagnosticArchive.selected, ['output/suite/failure.png']);
    assert.equal(evidence.manifest.diagnosticArchive.omitted, 1);
    assert.ok(Buffer.byteLength(evidence.serialized) + 11 * 1024 * 1024 <= 20 * 1024 * 1024);
  });
});
