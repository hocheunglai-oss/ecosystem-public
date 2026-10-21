import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { rawParserSnapshot, replayParserCase, type ParserReplayInput, type ParserReplaySnapshot } from '../shared/parserReplay.ts';
import { parserFieldKeys } from '../shared/parserService.ts';
import { evaluateParserCases, exportApprovedParserCases, runParserRegression, writePrivateParserArtifact } from '../scripts/parser-regression.mjs';

const rawText = 'Vessel: SYNTHETIC REPLAY\nIMO: 9319466\nBuyer: ALPHA SHIPPING\nPort: Singapore\nETA: 15-17 October 2026\nVLSFO: 450 MT';
const expected: ParserReplaySnapshot = {
  fields: { vessel: 'SYNTHETIC REPLAY', imo: '9319466', buyerText: 'ALPHA SHIPPING', portText: 'singapore', eta: '15 - 17 oct 2026', hsfo: '', vlsfo: '450', lsmgo: '', remarks: '' },
  rmk: false, viscosity: [], warnings: [],
  standardText: 'SYNTHETIC REPLAY (9319466) / SG / 15 - 17 OCT 2026 / 450 MT VLSFO (0.5%)',
};
const input: ParserReplayInput = {
  rawText, expected, captureComplete: true,
  provenance: { reportId: '11111111-1111-4111-8111-111111111111', reportRevision: 3, sourceRevision: 'source-a',
    sourceHash: createHash('sha256').update(rawText).digest('hex'), parserVersion: 'historical-v1', buildFingerprint: 'a'.repeat(64), originalRevision: 'source-a', parseOrigin: 'initial' },
};
const execution = { parserVersion: 'candidate-v2', buildFingerprint: 'b'.repeat(64) };
const report = () => ({ dataMode: 'live', id: input.provenance.reportId, rawText, sourceRevision: 'source-a', sourceHash: input.provenance.sourceHash,
  parserVersion: 'historical-v1', buildFingerprint: 'a'.repeat(64), capture: { original: expected, submitted: expected, originalRevision: 'source-a', parseOrigin: 'initial' },
  workflow: { stage: 'reviewed', revision: 3, expected } });

test('raw replay reproduces all nine fields and standard text without directory or human hints', () => {
  assert.deepEqual(rawParserSnapshot(rawText), expected);
  const before = structuredClone(input), result = replayParserCase(input, execution);
  assert.equal(result.status, 'matched');
  assert.deepEqual(result.differences, []);
  assert.deepEqual(result.executedWith, execution);
  assert.deepEqual(result.provenance, input.provenance);
  assert.deepEqual(input, before, 'replay leaves the stored capture untouched');
  for (const key of parserFieldKeys) {
    const changed = structuredClone(expected); changed.fields[key] += ' DIFFERENT';
    const mismatch = replayParserCase({ ...input, expected: changed }, execution);
    assert.equal(mismatch.status, 'different', key);
    assert.ok(mismatch.differences.includes(key), key);
    assert.equal(mismatch.actual.fields[key], expected.fields[key], 'expected data cannot feed the parser');
  }
});

test('manual RMK, viscosity, standard text and source warnings cannot manufacture a replay pass', () => {
  for (const correction of [{ rmk: true }, { viscosity: ['180cst max'] }, { standardText: expected.standardText + ' / MANUAL' }, { warnings: ['WARNING: RMK spotted. Confirm RMK requirement before sending.'] }]) {
    const result = replayParserCase({ ...input, expected: { ...expected, ...correction } }, execution);
    assert.equal(result.status, 'different');
    assert.ok(result.differences.includes(Object.keys(correction)[0] as 'rmk'));
    assert.equal(result.actual.rmk, false);
    assert.deepEqual(result.actual.viscosity, []);
  }
  const cautions = rawParserSnapshot(rawText + '\nRemarks: RMK / 120 CST / 180 CST\nCBM');
  assert.equal(cautions.fields.vlsfo, '');
  assert.ok(cautions.warnings.some(warning => /^WARNING:.*RMK/.test(warning)));
  assert.ok(cautions.warnings.some(warning => /^WARNING: CBM.*non-MT/.test(warning)));
  assert.match(cautions.standardText, /CONFIRM QUANTITY/);
});

test('directory spelling differences stay explicit and missing port never defaults to Singapore', () => {
  const renamed = structuredClone(expected); renamed.fields.buyerText = 'Alpha Shipping Legal Entity Ltd'; renamed.fields.portText = 'SGSIN';
  const result = replayParserCase({ ...input, expected: renamed }, execution);
  assert.equal(result.status, 'different');
  assert.deepEqual(result.directorySensitiveDifferences, ['buyerText', 'portText']);
  const missing = rawParserSnapshot(rawText.replace('Port: Singapore\n', ''));
  assert.equal(missing.fields.portText, '');
  assert.match(missing.standardText, /CONFIRM PORT/);
  assert.equal(rawParserSnapshot(rawText + '\nPort: Rotterdam').fields.portText, '', 'conflicting source ports cannot match a selected first port');
  assert.equal(rawParserSnapshot(rawText + '\nBuyer: BETA SHIPPING').fields.buyerText, '', 'conflicting source buyers cannot match a selected first buyer');
});

test('raw replay rejects current-month guessing and is independent of the execution date', () => {
  const RealDate = Date;
  const snapshots = [];
  try {
    for (const date of ['2019-01-01T00:00:00Z', '2034-12-01T00:00:00Z']) {
      globalThis.Date = class extends RealDate { constructor(value?: string | number) { super(value ?? date); } } as DateConstructor;
      snapshots.push(rawParserSnapshot(rawText.replace('15-17 October 2026', '15-17')));
    }
  } finally { globalThis.Date = RealDate; }
  assert.deepEqual(snapshots[0], snapshots[1]);
  assert.equal(snapshots[0].fields.eta, '');
  assert.match(snapshots[0].standardText, /CONFIRM DATES/);
});

test('missing full capture is legacy-unverified even if current text happens to match', () => {
  assert.equal(replayParserCase({ ...input, captureComplete: false }, execution).status, 'legacy-unverified');
  assert.equal(replayParserCase({ ...input, expected: null }, execution).status, 'legacy-unverified');
  assert.equal(replayParserCase({ ...input, expected: { fields: expected.fields } as ParserReplaySnapshot }, execution).status, 'legacy-unverified');
  assert.throws(() => replayParserCase(input, { ...execution, buildFingerprint: '' }), /execution identity/);
});

test('private developer export includes only approved complete cases and retains capture and revision provenance', () => {
  const legacy = { ...report(), id: 'legacy', capture: undefined };
  const pending = { ...report(), id: 'pending', workflow: { ...report().workflow, stage: 'pending_ai' } };
  const exported = exportApprovedParserCases({ items: [report(), legacy, pending], nextCursor: 'next-page' });
  assert.equal(exported.cases.length, 1);
  assert.deepEqual(exported.cases[0].provenance, { dataMode: 'live', ...input.provenance });
  assert.deepEqual(exported.scope, { dataMode: 'live' });
  assert.deepEqual(exported.cases[0].capture, { original: expected, submitted: expected });
  assert.deepEqual(exported.excluded, [{ reportId: 'legacy', reason: 'legacy-unverified' }, { reportId: 'pending', reason: 'not-approved' }]);
  assert.equal(exported.sourcePageHasMore, true);
  const result = evaluateParserCases(exported, execution);
  assert.equal(result.counts.matched, 1);
  assert.equal(result.counts.excludedLegacyUnverified, 1);
  assert.equal(result.results[0].executedWith.buildFingerprint, execution.buildFingerprint);
  assert.throws(() => exportApprovedParserCases({ items: [{ ...report(), sourceHash: 'wrong' }] }), /SOURCE_HASH/);
  const tampered = structuredClone(exported); tampered.cases[0].rawText += '\nPRIVATE SENTINEL';
  assert.throws(() => evaluateParserCases(tampered, execution), /INVALID_REGRESSION/);
});

test('UI single-case export works directly and regression artifacts cannot silently mix LIVE/TEST generations', () => {
  const wrapped = { schemaVersion: 1, kind: 'eco-parser-reviewed-case', report: report() };
  const exported = exportApprovedParserCases(wrapped);
  assert.deepEqual(exported, exportApprovedParserCases({ items: [report()], nextCursor: null }));
  assert.equal(evaluateParserCases(exported, execution).counts.matched, 1);
  const generation = '22222222-2222-4222-8222-222222222222';
  const testReport = { ...report(), dataMode: 'test', generation };
  const testExport = exportApprovedParserCases({ ...wrapped, report: testReport });
  assert.deepEqual(testExport.scope, { dataMode: 'test', generation });
  const result = evaluateParserCases(testExport, execution);
  assert.deepEqual(result.scope, testExport.scope);
  assert.equal(result.results[0].provenance.generation, generation);
  assert.throws(() => exportApprovedParserCases({ items: [report(), { ...testReport, id: 'test-case' }] }), /MIXED_REGRESSION_SCOPES/);
  assert.throws(() => exportApprovedParserCases({ items: [testReport, { ...testReport, id: 'other-generation', generation: '33333333-3333-4333-8333-333333333333' }] }), /MIXED_REGRESSION_SCOPES/);
  for (const invalid of [{ ...report(), dataMode: undefined }, { ...report(), generation }, { ...testReport, generation: undefined }]) {
    assert.throws(() => exportApprovedParserCases({ items: [invalid] }), /INVALID_REGRESSION_SCOPE/);
  }
  const mixed = structuredClone(testExport); mixed.cases.push(exported.cases[0]);
  assert.throws(() => evaluateParserCases(mixed, execution), /MIXED_REGRESSION_SCOPES/);
  const duplicate = structuredClone(exported); duplicate.cases.push(structuredClone(duplicate.cases[0]));
  assert.throws(() => evaluateParserCases(duplicate, execution), /DUPLICATE_REGRESSION_CASE/);
  const missing = structuredClone(exported); delete missing.cases[0].provenance.dataMode;
  assert.throws(() => evaluateParserCases(missing, execution), /INVALID_REGRESSION_SCOPE/);
  assert.throws(() => exportApprovedParserCases({ ...wrapped, items: [report()] }), /INVALID_REPORT_EXPORT/);
});

test('private artifacts cannot overwrite files or follow output symlinks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eco-parser-replay-'));
  try {
    const destination = join(directory, 'cases.json');
    await writePrivateParserArtifact(destination, { fixture: true });
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
    await assert.rejects(writePrivateParserArtifact(destination, { changed: true }), /WRITE_FAILED/);
    assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), { fixture: true });
    const link = join(directory, 'link.json'); await symlink(destination, link);
    await assert.rejects(writePrivateParserArtifact(link, { changed: true }), /WRITE_FAILED/);
    await assert.rejects(writePrivateParserArtifact(new URL('../tests/private-data.json', import.meta.url).pathname, { fixture: true }), /WRITE_FAILED/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CLI exports/evaluates operator files and errors never echo private input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eco-parser-replay-cli-'));
  try {
    const inputPath = join(directory, 'input.json'), casesPath = join(directory, 'cases.json'), resultPath = join(directory, 'result.json');
    await writeFile(inputPath, JSON.stringify({ schemaVersion: 1, kind: 'eco-parser-reviewed-case', report: report() }), { mode: 0o600 });
    assert.equal((await runParserRegression(['export', inputPath, casesPath])).exported, 1);
    const summary = await runParserRegression(['evaluate', casesPath, resultPath]);
    assert.equal(summary.passed, true);
    assert.doesNotMatch(JSON.stringify(summary), /SYNTHETIC REPLAY|ALPHA SHIPPING|rawText/);
    const result = JSON.parse(await readFile(resultPath, 'utf8'));
    assert.match(result.results[0].executedWith.buildFingerprint, /^[a-f0-9]{64}$/);
    await writeFile(inputPath, '{PRIVATE-SOURCE-SENTINEL', { mode: 0o600 });
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/parser-regression.mjs', 'export', inputPath, join(directory, 'bad.json')], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /PARSER_REGRESSION_FAILED/);
    assert.doesNotMatch(child.stdout + child.stderr, /PRIVATE-SOURCE-SENTINEL|input\.json|SyntaxError/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
