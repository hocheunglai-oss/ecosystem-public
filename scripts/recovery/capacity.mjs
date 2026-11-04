/** Pure capacity forecast. This never authorizes pruning or stops a possible backup. */
const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const ARCHIVE_LIMIT = 512 * MIB;
const NEXTCLOUD_BUDGET = 500 * GIB;
const NEXTCLOUD_RESERVE = 100 * GIB;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export const CAPACITY_DIAGNOSTIC_CODES = Object.freeze([
  'DRIVE_CAPACITY_WARNING', 'DRIVE_CAPACITY_URGENT',
  'NEXTCLOUD_CAPACITY_WARNING', 'NEXTCLOUD_CAPACITY_URGENT',
  'CAPACITY_UNKNOWN', 'ARCHIVE_NEAR_LIMIT', 'BACKUP_DURATION_WARNING',
  'NEXTCLOUD_QUOTA_MISMATCH',
]);

export class CapacityAssessmentError extends Error {
  constructor() { super('Backup capacity inputs are invalid.'); this.code = 'CAPACITY_INPUT_INVALID'; }
}
const check = value => { if (!value) throw new CapacityAssessmentError(); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const bytes = value => Number.isSafeInteger(value) && value >= 0;
const archiveSize = value => bytes(value) && value > 0 && value <= ARCHIVE_LIMIT;
function sum(...values) {
  const result = values.reduce((total, value) => total + BigInt(value), 0n);
  check(result <= MAX_SAFE);
  return Number(result);
}
const percentAtLeast = (value, total, percent) => BigInt(value) * 100n >= BigInt(total) * BigInt(percent);

/**
 * historySizes is chronological, oldest first; it must contain successful captures,
 * not repeat readbacks of the same capture. Only the latest 30 feed nearest-rank p95.
 * knownNightlyBytes counts measured nightly usage already included in provider usage;
 * pass 0 when it cannot be established, never a filename-based estimate.
 * forecasts is private operational detail. Only publicStatus is safe for public logs.
 * Account quota is not a measurement of host-wide trash, versions or other users.
 */
export function assessBackupCapacity(input) {
  check(exact(input, ['archiveBytes','historySizes','drive','nextcloud','durationMs']));
  const { archiveBytes, historySizes, drive, nextcloud, durationMs } = input;
  check(archiveSize(archiveBytes) && Array.isArray(historySizes) && historySizes.length <= 10_000
    && Array.from(historySizes).every(archiveSize) && bytes(durationMs));
  const history = historySizes.slice(-30).sort((a, b) => a - b);
  const p95Bytes = history.length ? history[Math.ceil(history.length * 0.95) - 1] : archiveBytes;
  const estimateBytes = Math.max(archiveBytes, p95Bytes);
  const twoCaptureBytes = 2 * estimateBytes;
  const codes = [];
  const add = code => { if (!codes.includes(code)) codes.push(code); };
  const forecasts = {
    sampleCount: history.length, archiveEstimateBytes: estimateBytes,
    archiveLimitBytes: ARCHIVE_LIMIT, drive: null, nextcloud: null,
    physicalOverheadMeasured: false,
  };
  if (estimateBytes >= 384 * MIB) add('ARCHIVE_NEAR_LIMIT');
  if (durationMs >= 30 * 60_000) add('BACKUP_DURATION_WARNING');

  if (drive === null) add('CAPACITY_UNKNOWN');
  else {
    check(exact(drive, ['usageBytes','limitBytes','knownNightlyBytes'])
      && bytes(drive.usageBytes) && bytes(drive.limitBytes) && drive.limitBytes > 0
      && bytes(drive.knownNightlyBytes) && drive.knownNightlyBytes <= drive.usageBytes);
    const unrelatedBytes = drive.usageBytes - drive.knownNightlyBytes;
    // Fourteen active dates plus thirty days of provider trash, without emptying it.
    const retentionBytes = 44 * estimateBytes;
    const projectedBytes = sum(Math.max(drive.usageBytes, sum(unrelatedBytes, retentionBytes)), twoCaptureBytes);
    const availableBytes = Math.max(0, drive.limitBytes - drive.usageBytes);
    if (percentAtLeast(projectedBytes, drive.limitBytes, 85) || availableBytes < twoCaptureBytes) add('DRIVE_CAPACITY_URGENT');
    else if (percentAtLeast(projectedBytes, drive.limitBytes, 70)) add('DRIVE_CAPACITY_WARNING');
    forecasts.drive = Object.freeze({ usageBytes: drive.usageBytes, limitBytes: drive.limitBytes,
      unrelatedBytes, knownNightlyBytes: drive.knownNightlyBytes,
      retainedAndTrashArchiveCount: 44, retainedAndTrashBytes: retentionBytes,
      twoCaptureBytes, projectedBytes, availableBytes });
  }

  if (nextcloud === null) add('CAPACITY_UNKNOWN');
  else {
    check(exact(nextcloud, ['usedBytes','totalBytes','freeBytes','knownNightlyBytes'])
      && bytes(nextcloud.usedBytes) && bytes(nextcloud.totalBytes) && nextcloud.totalBytes > 0
      && bytes(nextcloud.freeBytes) && nextcloud.freeBytes <= nextcloud.totalBytes
      && bytes(nextcloud.knownNightlyBytes) && nextcloud.knownNightlyBytes <= nextcloud.usedBytes);
    if (nextcloud.totalBytes !== NEXTCLOUD_BUDGET) add('NEXTCLOUD_QUOTA_MISMATCH');
    const budgetBytes = Math.min(NEXTCLOUD_BUDGET, nextcloud.totalBytes);
    // Conservatively reserve another month of growth without assuming trash
    // expiry, reclamation timing or unmeasured host-wide version/trash overhead.
    const growthBytes = 30 * estimateBytes;
    const projectedBytes = sum(nextcloud.usedBytes, growthBytes, twoCaptureBytes);
    const usableFreeBytes = Math.min(nextcloud.freeBytes, Math.max(0, budgetBytes - nextcloud.usedBytes));
    const minimumFreeBytes = sum(NEXTCLOUD_RESERVE, twoCaptureBytes);
    if (percentAtLeast(projectedBytes, budgetBytes, 85) || usableFreeBytes < minimumFreeBytes) add('NEXTCLOUD_CAPACITY_URGENT');
    else if (percentAtLeast(projectedBytes, budgetBytes, 70)) add('NEXTCLOUD_CAPACITY_WARNING');
    forecasts.nextcloud = Object.freeze({ usedBytes: nextcloud.usedBytes, totalBytes: nextcloud.totalBytes,
      freeBytes: nextcloud.freeBytes, knownNightlyBytes: nextcloud.knownNightlyBytes,
      budgetBytes, growthDays: 30, growthBytes, twoCaptureBytes, projectedBytes,
      reservedHeadroomBytes: NEXTCLOUD_RESERVE, minimumFreeBytes, usableFreeBytes });
  }
  return Object.freeze({
    publicStatus: Object.freeze({ schemaVersion: 1, status: codes.length ? 'attention' : 'healthy', codes: Object.freeze(codes) }),
    forecasts: Object.freeze(forecasts),
  });
}
