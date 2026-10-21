import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { verifyFcunoParser, adaptFcunoImports, sha256 } from '../scripts/check-fcuno-parser.mjs';

test('pinned FCUNO modules retain their reviewed hashes in every ECO test run', async () => {
  const result = await verifyFcunoParser();
  assert.equal(result.ok, true);
  assert.equal(result.files, 6);
  assert.match(result.pinnedRevision, /^[a-f0-9]{40}$/);
});

test('upstream comparisons require an explicit source and immutable revision together', async () => {
  await assert.rejects(verifyFcunoParser({ source: '/unused' }), /both/);
  await assert.rejects(verifyFcunoParser({ revision: 'a'.repeat(40) }), /both/);
  for (const revision of ['HEAD', 'main', 'abc123', '--upload-pack=bad']) await assert.rejects(verifyFcunoParser({ source: '/unused', revision }), /full 40-character/);
});

test('import adaptation only changes module paths and preserves parser behavior text', () => {
  const source = 'import { a } from "@/lib/core"\nimport { b } from "@/data/list"\nconst example = "@/lib/keep-literal"\n';
  assert.equal(adaptFcunoImports(source), 'import { a } from "./core.ts"\nimport { b } from "../data/list.ts"\nconst example = "@/lib/keep-literal"\n');
});

test('upstream verifier ignores dirty worktrees, detects new revisions, and never installs them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eco-parser-pin-'));
  try {
    const source = join(root, 'source'), vendor = join(root, 'src/vendor/fcuno');
    await mkdir(source, { recursive: true });
    const git = (...args: string[]) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q'); git('config', 'user.name', 'Parser Fixture'); git('config', 'user.email', 'parser@example.test');
    git('config', 'commit.gpgsign', 'false'); git('config', 'core.hooksPath', '/dev/null');
    git('remote', 'add', 'origin', 'https://github.com/hocheunglai-oss/bunker-map.git');
    const baseline = JSON.parse(await readFile(new URL('../src/vendor/fcuno/version.json', import.meta.url), 'utf8'));
    const original = 'export const synthetic = 1;\n';
    for (const file of baseline.files) {
      await mkdir(dirname(join(source, file.path)), { recursive: true });
      await mkdir(dirname(join(vendor, file.path)), { recursive: true });
      await writeFile(join(source, file.path), original);
      await writeFile(join(vendor, file.path), original);
      file.sourceSha256 = sha256(original); file.vendorSha256 = sha256(original);
    }
    git('add', '.'); git('commit', '-qm', 'Synthetic pinned parser');
    baseline.sourceCommit = git('rev-parse', 'HEAD');
    await writeFile(join(vendor, 'version.json'), JSON.stringify(baseline));
    const changedFile = baseline.files[0].path;
    await writeFile(join(source, changedFile), 'export const synthetic = 2;\n');
    assert.equal((await verifyFcunoParser({ root, source, revision: baseline.sourceCommit })).ok, true, 'compare immutable source blobs, never dirty files');
    git('add', '.'); git('commit', '-qm', 'Synthetic upstream update');
    const revision = git('rev-parse', 'HEAD');
    const result = await verifyFcunoParser({ root, source, revision });
    assert.equal(result.ok, false);
    assert.deepEqual(result.upstreamChanged, [changedFile]);
    assert.equal(await readFile(join(vendor, changedFile), 'utf8'), original, 'comparison must not install a new parser');
    git('remote', 'set-url', 'origin', 'https://github.com/other/example.git');
    await assert.rejects(verifyFcunoParser({ root, source, revision }), /identity mismatch/);
    await writeFile(join(vendor, changedFile), 'unreviewed local edit');
    await assert.rejects(verifyFcunoParser({ root }), /vendor files changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
