import test from 'node:test';
import assert from 'node:assert/strict';
import { assessBackupCapacity, CapacityAssessmentError, CAPACITY_DIAGNOSTIC_CODES } from './capacity.mjs';

const MIB = 1024 ** 2, GIB = 1024 ** 3;
const base = () => ({ archiveBytes: 8 * MIB, historySizes: [], durationMs: 60_000,
  drive: { usageBytes: GIB, limitBytes: 15 * GIB, knownNightlyBytes: 100 * MIB },
  nextcloud: { usedBytes: GIB, totalBytes: 500 * GIB, freeBytes: 499 * GIB, knownNightlyBytes: 100 * MIB } });
const codes = input => assessBackupCapacity(input).publicStatus.codes;
const invalid = input => assert.throws(() => assessBackupCapacity(input), error =>
  error instanceof CapacityAssessmentError && error.code === 'CAPACITY_INPUT_INVALID'
    && error.message === 'Backup capacity inputs are invalid.');

test('returns an exact public status and separate private forecast without mutating inputs', () => {
  const input = base(), saved = structuredClone(input);
  const result = assessBackupCapacity(input);
  assert.deepEqual(result.publicStatus, { schemaVersion: 1, status: 'healthy', codes: [] });
  assert.deepEqual(Object.keys(result), ['publicStatus','forecasts']);
  assert.equal(result.forecasts.physicalOverheadMeasured, false);
  assert.deepEqual(input, saved);
  assert.ok(Object.isFrozen(result.publicStatus.codes));
  assert.ok(Object.isFrozen(result.forecasts.nextcloud));
});

test('uses max latest and nearest-rank p95 of the last thirty successful captures', () => {
  const input = base();
  input.historySizes = [512 * MIB, ...Array(28).fill(10 * MIB), 20 * MIB, 30 * MIB];
  const before = [...input.historySizes];
  assert.equal(assessBackupCapacity(input).forecasts.archiveEstimateBytes, 20 * MIB);
  assert.equal(assessBackupCapacity(input).forecasts.sampleCount, 30);
  assert.deepEqual(input.historySizes, before);
  input.archiveBytes = 40 * MIB;
  assert.equal(assessBackupCapacity(input).forecasts.archiveEstimateBytes, 40 * MIB);
  input.historySizes = [50 * MIB];
  assert.equal(assessBackupCapacity(input).forecasts.archiveEstimateBytes, 50 * MIB);
});

test('Drive includes unrelated usage, fourteen active dates, thirty trash dates and two new captures', () => {
  const input = base(), { drive } = assessBackupCapacity(input).forecasts;
  assert.equal(drive.retainedAndTrashArchiveCount, 44);
  assert.equal(drive.projectedBytes, GIB - 100 * MIB + 46 * 8 * MIB);
  input.drive.knownNightlyBytes = input.drive.usageBytes;
  assert.equal(assessBackupCapacity(input).forecasts.drive.projectedBytes, GIB + 16 * MIB,
    'a forecast never assumes the present usage has already been freed');
  input.drive.knownNightlyBytes = 0;
  assert.equal(assessBackupCapacity(input).forecasts.drive.projectedBytes, GIB + 46 * 8 * MIB);
});

test('Drive capacity thresholds are inclusive and exact at seventy and eighty-five percent', () => {
  for (const [usageBytes, expected] of [[697, []],[698, ['DRIVE_CAPACITY_WARNING']],
    [847, ['DRIVE_CAPACITY_WARNING']],[848, ['DRIVE_CAPACITY_URGENT']]]) {
    const input = base(); input.archiveBytes = 1;
    input.drive = { usageBytes, limitBytes: 1000, knownNightlyBytes: usageBytes };
    assert.deepEqual(codes(input), expected);
  }
});

test('over-quota usage is urgent and never becomes a negative estimate', () => {
  const input = base(); input.drive.usageBytes = 16 * GIB;
  input.nextcloud.usedBytes = 501 * GIB; input.nextcloud.freeBytes = 0;
  const result = assessBackupCapacity(input);
  assert.ok(result.publicStatus.codes.includes('DRIVE_CAPACITY_URGENT'));
  assert.ok(result.publicStatus.codes.includes('NEXTCLOUD_CAPACITY_URGENT'));
  assert.equal(result.forecasts.drive.availableBytes, 0);
  assert.equal(result.forecasts.nextcloud.usableFreeBytes, 0);
});

test('Nextcloud forecasts thirty more days without subtracting quarantined nightly bytes', () => {
  const input = base(); input.nextcloud.knownNightlyBytes = GIB;
  const result = assessBackupCapacity(input).forecasts.nextcloud;
  assert.equal(result.projectedBytes, GIB + 32 * 8 * MIB);
  assert.equal(result.minimumFreeBytes, 100 * GIB + 16 * MIB);
  assert.equal(result.reservedHeadroomBytes, 100 * GIB);
});

test('Nextcloud thresholds and the independent free-space reserve cannot mask each other', () => {
  for (const [projected, expected] of [[350 * GIB - 1, []],
    [350 * GIB, ['NEXTCLOUD_CAPACITY_WARNING']], [425 * GIB, ['NEXTCLOUD_CAPACITY_URGENT']]]) {
    const input = base(); input.archiveBytes = 1;
    input.nextcloud.usedBytes = projected - 32;
    input.nextcloud.freeBytes = 500 * GIB - input.nextcloud.usedBytes;
    assert.deepEqual(codes(input), expected);
  }
  const input = base();
  input.nextcloud.freeBytes = 100 * GIB + 2 * input.archiveBytes;
  assert.deepEqual(codes(input), []);
  input.nextcloud.freeBytes -= 1;
  assert.deepEqual(codes(input), ['NEXTCLOUD_CAPACITY_URGENT']);
});

test('a changed Nextcloud allocation warns and cannot expand the pinned budget', () => {
  const input = base(); input.nextcloud.totalBytes = 1000 * GIB; input.nextcloud.freeBytes = 999 * GIB;
  let result = assessBackupCapacity(input);
  assert.deepEqual(result.publicStatus.codes, ['NEXTCLOUD_QUOTA_MISMATCH']);
  assert.equal(result.forecasts.nextcloud.budgetBytes, 500 * GIB);
  input.nextcloud.totalBytes = 100 * GIB; input.nextcloud.freeBytes = 99 * GIB;
  result = assessBackupCapacity(input);
  assert.deepEqual(result.publicStatus.codes, ['NEXTCLOUD_QUOTA_MISMATCH','NEXTCLOUD_CAPACITY_URGENT']);
  assert.equal(result.forecasts.nextcloud.budgetBytes, 100 * GIB);
});

test('missing provider quota is attention, deduplicated and never reported healthy', () => {
  for (const missing of ['drive','nextcloud','both']) {
    const input = base();
    if (missing !== 'nextcloud') input.drive = null;
    if (missing !== 'drive') input.nextcloud = null;
    const result = assessBackupCapacity(input);
    assert.deepEqual(result.publicStatus, { schemaVersion: 1, status: 'attention', codes: ['CAPACITY_UNKNOWN'] });
    if (missing !== 'nextcloud') assert.equal(result.forecasts.drive, null);
    if (missing !== 'drive') assert.equal(result.forecasts.nextcloud, null);
  }
});

test('archive and elapsed-run warnings include their exact boundaries', () => {
  let input = base(); input.archiveBytes = 384 * MIB - 1; input.durationMs = 30 * 60_000 - 1;
  assert.ok(!codes(input).includes('ARCHIVE_NEAR_LIMIT'));
  assert.ok(!codes(input).includes('BACKUP_DURATION_WARNING'));
  input.archiveBytes += 1; input.durationMs += 1;
  assert.ok(codes(input).includes('ARCHIVE_NEAR_LIMIT'));
  assert.ok(codes(input).includes('BACKUP_DURATION_WARNING'));
  input.archiveBytes = 512 * MIB;
  assert.ok(codes(input).includes('ARCHIVE_NEAR_LIMIT'));
  input.archiveBytes += 1; invalid(input);
  input = base(); input.historySizes = [384 * MIB];
  assert.ok(codes(input).includes('ARCHIVE_NEAR_LIMIT'), 'a small latest capture cannot hide a large p95');
});

test('rejects malformed numeric inputs without coercion or private values in errors', () => {
  for (const value of [-1, NaN, Infinity, 1.5, 'secret-value', 1n, Number.MAX_SAFE_INTEGER + 1]) {
    for (const field of ['archiveBytes','durationMs']) { const input = base(); input[field] = value; invalid(input); }
    for (const field of ['usageBytes','limitBytes','knownNightlyBytes']) { const input = base(); input.drive[field] = value; invalid(input); }
    for (const field of ['usedBytes','totalBytes','freeBytes','knownNightlyBytes']) { const input = base(); input.nextcloud[field] = value; invalid(input); }
    const input = base(); input.historySizes = [value]; invalid(input);
  }
  for (const value of [undefined, [], null, {}, 'private']) invalid(value);
  const input = base(); input.archiveBytes = 0; invalid(input);
});

test('rejects impossible metadata and arithmetic overflow instead of underestimating capacity', () => {
  for (const mutate of [
    input => { input.drive.knownNightlyBytes = input.drive.usageBytes + 1; },
    input => { input.nextcloud.knownNightlyBytes = input.nextcloud.usedBytes + 1; },
    input => { input.nextcloud.freeBytes = input.nextcloud.totalBytes + 1; },
    input => { input.drive.limitBytes = 0; },
    input => { input.nextcloud.totalBytes = 0; },
    input => { input.drive.usageBytes = Number.MAX_SAFE_INTEGER; },
    input => { input.nextcloud.usedBytes = Number.MAX_SAFE_INTEGER; },
    input => { input.historySizes = [512 * MIB + 1]; },
    input => { input.historySizes = Array(10_001).fill(MIB); },
    input => { input.historySizes = Array(2); },
    input => { input.drive.extra = 'private'; },
  ]) { const input = base(); mutate(input); invalid(input); }
});

test('all combined alerts remain fixed codes and public output excludes operational numbers', () => {
  const input = base(); input.archiveBytes = 512 * MIB; input.durationMs = 40 * 60_000;
  input.drive.usageBytes = 15 * GIB;
  input.nextcloud.usedBytes = 495 * GIB; input.nextcloud.freeBytes = 5 * GIB;
  const { publicStatus } = assessBackupCapacity(input);
  assert.deepEqual(Object.keys(publicStatus), ['schemaVersion','status','codes']);
  assert.equal(new Set(publicStatus.codes).size, publicStatus.codes.length);
  assert.ok(publicStatus.codes.every(code => CAPACITY_DIAGNOSTIC_CODES.includes(code)));
  assert.equal(JSON.stringify(publicStatus).includes(String(input.archiveBytes)), false);
  assert.equal(JSON.stringify(publicStatus).includes(String(input.drive.usageBytes)), false);
});
