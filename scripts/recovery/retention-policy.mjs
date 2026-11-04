/** Pure retention decisions. A plan is not authority to mutate either provider. */
import { hongKongNight } from './drive-backups.mjs';

const HASH = /^[a-f0-9]{64}$/u;
const DAY = 86_400_000;
const MAX_POINTS = 4_000;
const check = value => { if (!value) throw new Error('RETENTION_INPUT_INVALID'); };
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const monthOf = night => night.slice(0,7);
function weekOf(night) {
  const value = new Date(night + 'T00:00:00.000Z');
  value.setUTCDate(value.getUTCDate() - (value.getUTCDay() + 6) % 7);
  return value.toISOString().slice(0,10);
}
function previousPeriods(night, unit, count) {
  const result = [];
  if (unit === 'week') {
    const start = Date.parse(weekOf(night) + 'T00:00:00.000Z');
    for (let index = 1; index <= count; index++) result.push(new Date(start - index * 7 * DAY).toISOString().slice(0,10));
  } else {
    const start = new Date(monthOf(night) + '-01T00:00:00.000Z');
    for (let index = 1; index <= count; index++) result.push(new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()-index,1)).toISOString().slice(0,7));
  }
  return result;
}

/** Only append-only verified pair receipts may supply points. Unknown provider
 * objects never enter this input and must remain untouched. A missing original
 * capture provenance is explicitly protected, including recovered legacy runs.
 */
export function planBackupRetention({ now, points, currentSha256, restore, protectedHashes = [] }) {
  check(iso(now) && Array.isArray(points) && points.length > 0 && points.length <= MAX_POINTS
    && HASH.test(currentSha256) && Array.isArray(protectedHashes) && protectedHashes.length <= 100
    && protectedHashes.every(hash => typeof hash === 'string' && HASH.test(hash)));
  const today = hongKongNight(now), currentTime = Date.parse(now), byHash = new Map(), byNight = new Map();
  for (const point of points) {
    check(point && typeof point === 'object' && HASH.test(point.sha256) && iso(point.snapshotAt)
      && point.night === hongKongNight(point.snapshotAt) && Number.isSafeInteger(point.size) && point.size > 0
      && typeof point.provenanceKnown === 'boolean' && !byHash.has(point.sha256));
    byHash.set(point.sha256, point);
    const entries = byNight.get(point.night) || []; entries.push(point); byNight.set(point.night,entries);
  }
  const current = byHash.get(currentSha256);
  check(current && current.night === today && Date.parse(current.snapshotAt) <= currentTime);
  const restoreValid = restore && HASH.test(restore.sha256) && iso(restore.verifiedAt)
    && Date.parse(restore.verifiedAt) <= currentTime && currentTime - Date.parse(restore.verifiedAt) <= 30 * DAY;
  const protectedSet = new Set(protectedHashes);
  if (restore && HASH.test(restore.sha256)) protectedSet.add(restore.sha256);
  const reasons = new Map(points.map(point => [point.sha256, { drive:[], nextcloud:[] }]));
  const keep = (point, reason, destination) => reasons.get(point.sha256)[destination].push(reason);
  for (const point of points) {
    for (const destination of ['drive','nextcloud']) {
      if (point.sha256 === currentSha256) keep(point,'CURRENT_PAIR',destination);
      if (protectedSet.has(point.sha256)) keep(point,'PROTECTED_RESTORE',destination);
      if (!point.provenanceKnown) keep(point,'UNKNOWN_ORIGINAL_PROVENANCE',destination);
      if (Date.parse(point.snapshotAt) > currentTime) keep(point,'FUTURE_SNAPSHOT',destination);
      if (byNight.get(point.night).length > 1) keep(point,'CONFLICTING_NIGHT',destination);
      if (!restoreValid) keep(point,'RECENT_RESTORE_REQUIRED',destination);
    }
  }
  const nights = [...byNight.keys()].filter(night => night <= today).sort().reverse();
  for (const night of nights.slice(0,14)) for (const point of byNight.get(night)) {
    keep(point,'DAILY_14','drive'); keep(point,'DAILY_14','nextcloud');
  }
  const missingPeriods = { weekly:[], monthly:[] };
  for (const [unit,count,label,key] of [['week',8,'WEEKLY_8','weekly'],['month',12,'MONTHLY_12','monthly']]) {
    for (const period of previousPeriods(today,unit,count)) {
      const choices = points.filter(point => (unit === 'week' ? weekOf(point.night) : monthOf(point.night)) === period
        && Date.parse(point.snapshotAt) <= currentTime).sort((a,b) => b.snapshotAt.localeCompare(a.snapshotAt));
      if (!choices.length) { missingPeriods[key].push(period); continue; }
      // Every same-night conflicting capture is protected above; the latest
      // completed snapshot supplies the calendar tier without inventing gaps.
      keep(choices[0],label,'nextcloud');
    }
  }
  const entries = [...points].sort((a,b) => a.snapshotAt.localeCompare(b.snapshotAt) || a.sha256.localeCompare(b.sha256))
    .map(point => ({sha256:point.sha256,night:point.night,snapshotAt:point.snapshotAt,size:point.size,
      drive:{retain:reasons.get(point.sha256).drive.length > 0,reasons:reasons.get(point.sha256).drive},
      nextcloud:{retain:reasons.get(point.sha256).nextcloud.length > 0,reasons:reasons.get(point.sha256).nextcloud}}));
  return {schemaVersion:1,plannedAt:now,currentSha256,cleanupEligible:Boolean(restoreValid),
    missingPeriods,entries,permanentDeletionUsed:false};
}
