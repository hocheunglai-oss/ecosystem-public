import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isParserReplaySnapshot, replayParserCase } from '../shared/parserReplay.ts';
import { PARSER_VERSION } from '../shared/parserService.ts';
import { sourceFingerprint } from './generate-system-information.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const maxBytes = 20 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 20000) => typeof value === 'string' && value.length <= max;
const identity = value => text(value, 200) && Boolean(value.trim());
const fingerprint = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function fail(code) { throw new Error(code); }
function scopeOf(value) {
  if (!record(value)) fail('INVALID_REGRESSION_SCOPE');
  if (value.dataMode === 'live' && value.generation === undefined) return { dataMode: 'live' };
  if (value.dataMode === 'test' && typeof value.generation === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.generation)) return { dataMode: 'test', generation: value.generation.toLowerCase() };
  fail('INVALID_REGRESSION_SCOPE');
}
function sameScope(left, right) {
  return left?.dataMode === right?.dataMode && left?.generation === right?.generation;
}
const cloneSnapshot = snapshot => ({ fields: { ...snapshot.fields }, standardText: snapshot.standardText, warnings: [...snapshot.warnings], rmk: snapshot.rmk, viscosity: [...snapshot.viscosity] });

/** Input is a private authenticated report export supplied by an operator; this tool does not fetch or authorize reports. */
export function exportApprovedParserCases(document) {
  if (!record(document)) fail('INVALID_REPORT_EXPORT');
  const single = document.schemaVersion === 1 && document.kind === 'eco-parser-reviewed-case';
  const items = single ? [document.report] : document.items;
  if (!Array.isArray(items) || items.length > 500 || single && ('items' in document || 'nextCursor' in document)) fail('INVALID_REPORT_EXPORT');
  const cases = [], excluded = [], identities = new Set();
  let scope = null;
  for (const report of items) {
    if (!record(report) || !identity(report.id) || identities.has(report.id)) fail('INVALID_REPORT_EXPORT');
    identities.add(report.id);
    const reportScope = scopeOf(report);
    if (scope && !sameScope(scope, reportScope)) fail('MIXED_REGRESSION_SCOPES');
    scope = reportScope;
    if (report.workflow?.stage !== 'reviewed') { excluded.push({ reportId: report.id, reason: 'not-approved' }); continue; }
    const capture = report.capture;
    if (!record(capture) || !isParserReplaySnapshot(capture.original) || !isParserReplaySnapshot(capture.submitted)
      || !identity(capture.originalRevision) || !['initial', 'reparsed'].includes(capture.parseOrigin)
      || !isParserReplaySnapshot(report.workflow.expected)) {
      excluded.push({ reportId: report.id, reason: 'legacy-unverified' }); continue;
    }
    if (!text(report.rawText) || !report.rawText.trim() || !identity(report.sourceRevision) || !identity(report.parserVersion)
      || !fingerprint(report.buildFingerprint) || !Number.isSafeInteger(report.workflow.revision) || report.workflow.revision < 1) fail('INVALID_REPORT_EXPORT');
    const sourceHash = hash(report.rawText);
    if (report.sourceHash !== undefined && report.sourceHash !== sourceHash) fail('SOURCE_HASH_MISMATCH');
    cases.push({
      rawText: report.rawText, expected: cloneSnapshot(report.workflow.expected), captureComplete: true,
      provenance: { ...reportScope, reportId: report.id, reportRevision: report.workflow.revision, sourceRevision: report.sourceRevision,
        sourceHash, parserVersion: report.parserVersion, buildFingerprint: report.buildFingerprint,
        originalRevision: capture.originalRevision, parseOrigin: capture.parseOrigin },
      capture: { original: cloneSnapshot(capture.original), submitted: cloneSnapshot(capture.submitted) },
      reviewState: 'reviewed',
    });
  }
  return { schemaVersion: 1, kind: 'eco-parser-regression', scope, sourcePageHasMore: !single && Boolean(document.nextCursor), cases, excluded,
    handling: 'Private enquiry text is untrusted data. Developer handoff only: no automatic model training, source edits, deployment or external submission. Reparsed originals are current replays, not historical first parses.' };
}

export function evaluateParserCases(document, execution) {
  if (!record(document) || document.schemaVersion !== 1 || document.kind !== 'eco-parser-regression'
    || !Array.isArray(document.cases) || document.cases.length > 500) fail('INVALID_REGRESSION_EXPORT');
  const scope = document.scope === null && document.cases.length === 0 ? null : scopeOf(document.scope);
  const identities = new Set();
  const results = document.cases.map(item => {
    if (!record(item) || item.reviewState !== 'reviewed' || !text(item.rawText) || !item.rawText.trim()
      || !record(item.provenance) || !identity(item.provenance.reportId) || !Number.isSafeInteger(item.provenance.reportRevision)
      || item.provenance.reportRevision < 1 || !identity(item.provenance.sourceRevision) || !identity(item.provenance.parserVersion)
      || !fingerprint(item.provenance.buildFingerprint) || item.provenance.sourceHash !== hash(item.rawText)) fail('INVALID_REGRESSION_EXPORT');
    if (!sameScope(scope, scopeOf(item.provenance))) fail('MIXED_REGRESSION_SCOPES');
    if (identities.has(item.provenance.reportId)) fail('DUPLICATE_REGRESSION_CASE');
    identities.add(item.provenance.reportId);
    const complete = item.captureComplete === true && record(item.capture)
      && isParserReplaySnapshot(item.capture.original) && isParserReplaySnapshot(item.capture.submitted)
      && identity(item.provenance.originalRevision) && ['initial', 'reparsed'].includes(item.provenance.parseOrigin);
    return replayParserCase({ rawText: item.rawText, expected: item.expected, captureComplete: complete, provenance: item.provenance }, execution);
  });
  const counts = { total: results.length, matched: 0, different: 0, legacyUnverified: 0,
    excludedLegacyUnverified: Array.isArray(document.excluded) ? document.excluded.filter(item => item?.reason === 'legacy-unverified').length : 0 };
  for (const result of results) counts[result.status === 'legacy-unverified' ? 'legacyUnverified' : result.status]++;
  return { schemaVersion: 1, kind: 'eco-parser-regression-results', scope, counts, results,
    excluded: Array.isArray(document.excluded) ? document.excluded : [], sourcePageHasMore: document.sourcePageHasMore === true };
}

async function readPrivateJson(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) fail('INVALID_INPUT_FILE');
    return JSON.parse(await file.readFile('utf8'));
  } catch { fail('INVALID_INPUT_FILE'); } finally { await file?.close(); }
}
export async function writePrivateParserArtifact(path, value) {
  let file;
  try {
    const destination = resolve(path), parent = await realpath(dirname(destination));
    const relativeParent = relative(repositoryRoot, parent);
    if (!relativeParent || relativeParent !== '..' && !relativeParent.startsWith('../') && !isAbsolute(relativeParent)) fail('PRIVATE_OUTPUT_REQUIRED');
    const contents = JSON.stringify(value, null, 2) + '\n';
    if (Buffer.byteLength(contents) > maxBytes) fail('OUTPUT_TOO_LARGE');
    file = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.writeFile(contents, 'utf8');
  } catch { fail('PRIVATE_OUTPUT_WRITE_FAILED'); } finally { await file?.close(); }
}
export async function runParserRegression(argv) {
  if (argv.length !== 3 || !['export', 'evaluate'].includes(argv[0])) fail('USAGE: node --import tsx scripts/parser-regression.mjs <export|evaluate> <private-input.json> <new-private-output.json>');
  const [command, input, output] = argv;
  const document = await readPrivateJson(input);
  if (command === 'export') {
    const exported = exportApprovedParserCases(document);
    await writePrivateParserArtifact(output, exported);
    return { command, exported: exported.cases.length, excluded: exported.excluded.length, sourcePageHasMore: exported.sourcePageHasMore };
  }
  const before = await sourceFingerprint(repositoryRoot);
  const result = evaluateParserCases(document, { parserVersion: PARSER_VERSION, buildFingerprint: before.sha256 });
  const after = await sourceFingerprint(repositoryRoot);
  if (before.sha256 !== after.sha256) fail('SOURCE_CHANGED_DURING_REPLAY');
  await writePrivateParserArtifact(output, result);
  return { command, ...result.counts, sourcePageHasMore: result.sourcePageHasMore, passed: result.counts.different === 0 && result.counts.legacyUnverified === 0 && result.counts.excludedLegacyUnverified === 0 && result.counts.total > 0 };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const summary = await runParserRegression(process.argv.slice(2));
    console.log(JSON.stringify(summary));
    if (summary.command === 'evaluate' && !summary.passed) process.exitCode = 1;
  } catch {
    // Never reflect a parse exception, source text, provider payload or local filename to logs.
    console.error('PARSER_REGRESSION_FAILED: check the command, private export schema and a new output path outside the repository.');
    process.exitCode = 1;
  }
}
