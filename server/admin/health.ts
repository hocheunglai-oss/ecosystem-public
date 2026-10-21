import { performance } from 'node:perf_hooks';
import { inboxHealthCheck } from './inbox-health.ts';
import type { DatabaseHealthEvidence, HealthCheck, HealthStatus, OperationalEvidence, OperationalEvidenceId, MonitorEvidenceRecord, SystemHealth } from '../../shared/system.ts';
import { generatedSystemInformation } from '../generated/system-information.ts';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;
/** A new provider integration registers here and supplies a trusted server evidence adapter. */
export const operationalCheckRegistry: ReadonlyArray<{ id: OperationalEvidenceId; label: string; maximumAgeMs: number; missing: string }> = [
  { id: 'external-availability', label: 'EXTERNAL AVAILABILITY', maximumAgeMs: 75 * MINUTE, missing: 'NO CURRENT INDEPENDENT MONITOR EVIDENCE CONNECTED.' },
  { id: 'error-alerting', label: 'ERROR ALERT DELIVERY', maximumAgeMs: DAY, missing: 'ALERT DELIVERY HAS NOT BEEN VERIFIED.' },
  { id: 'database-backup', label: 'DATABASE BACKUP', maximumAgeMs: 36 * 60 * MINUTE, missing: 'NO VERIFIED PROVIDER BACKUP EVIDENCE CONNECTED.' },
  { id: 'document-backup', label: 'DOCUMENT BACKUP', maximumAgeMs: 36 * 60 * MINUTE, missing: 'DOCUMENT BACKUP EVIDENCE IS NOT CONNECTED.' },
  { id: 'restore-test', label: 'RECOVERY TEST', maximumAgeMs: 90 * DAY, missing: 'NO VERIFIED RECOVERY EXERCISE RECORDED.' },
];

export function operationalChecks(evidence: readonly OperationalEvidence[], now: number): HealthCheck[] {
  return operationalCheckRegistry.map(definition => {
    const matches = evidence.filter(value => value.id === definition.id);
    if (matches.length !== 1) return { id: definition.id, label: definition.label, status: 'unknown', checkedAt: null, detail: definition.missing };
    const value = matches[0];
    const observed = Date.parse(value.observedAt), until = Date.parse(value.validUntil);
    const valid = Number.isFinite(observed) && observed <= now + MINUTE && now - observed <= definition.maximumAgeMs &&
      Number.isFinite(until) && until > now && until > observed && until - observed <= definition.maximumAgeMs &&
      ['healthy', 'degraded', 'unavailable'].includes(value.status) && /^[a-zA-Z0-9 ._:/-]{1,120}$/.test(value.source) &&
      /^[a-zA-Z0-9._:/-]{1,160}$/.test(value.reference);
    if (!valid) return { id: definition.id, label: definition.label, status: 'unknown', checkedAt: Number.isFinite(observed) ? value.observedAt : null,
      detail: 'EVIDENCE IS STALE OR INCOMPLETE. VERIFY THE CONNECTED CHECK.' };
    return { id: definition.id, label: definition.label, status: value.status, checkedAt: value.observedAt,
      detail: 'TRUSTED OPERATIONAL EVIDENCE.', metrics: { source: value.source, reference: value.reference, validUntil: value.validUntil } };
  });
}

function aggregate(checks: HealthCheck[]): HealthStatus {
  for (const status of ['unavailable', 'degraded', 'unknown'] as const) if (checks.some(check => check.status === status)) return status;
  return 'healthy';
}
function databaseEvidenceIsValid(value: DatabaseHealthEvidence, now: number): boolean {
  const observed = Date.parse(value.observedAt);
  return Number.isFinite(observed) && Math.abs(now - observed) <= MINUTE &&
    (value.migrationHead === null || /^\d{14}$/.test(value.migrationHead)) &&
    Number.isSafeInteger(value.pendingImports) && value.pendingImports >= 0 &&
    Number.isSafeInteger(value.failedImports) && value.failedImports >= 0 &&
    (value.oldestPendingImportAt === null || Number.isFinite(Date.parse(value.oldestPendingImportAt)));
}
async function bounded<T>(task: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([task(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('HEALTH_TIMEOUT')), timeoutMs); })]);
  } finally { if (timer) clearTimeout(timer); }
}
export interface HealthCollectorOptions {
  now?: () => number;
  cacheTtlMs?: number;
  timeoutMs?: number;
  bundledHead?: string | null;
  /** A server-owned adapter; browser clients must never assert backup or monitor success. */
  readOperationalEvidence?: () => Promise<readonly OperationalEvidence[]>;
}

/** Cache is per server instance, never an authorization cache. Guard every caller first. */
export function createHealthCollector(options: HealthCollectorOptions = {}) {
  const now = options.now ?? Date.now;
  const ttl = options.cacheTtlMs ?? 30 * SECOND;
  const timeout = options.timeoutMs ?? 4 * SECOND;
  const bundledHead = options.bundledHead === undefined ? generatedSystemInformation.migrations.bundledHead : options.bundledHead;
  let cached: SystemHealth | undefined;
  let pending: Promise<SystemHealth> | undefined;
  return async function collect(probe: () => Promise<DatabaseHealthEvidence>, readEvidence?: () => Promise<readonly OperationalEvidence[]>, readInbox?: () => Promise<unknown>): Promise<SystemHealth> {
    if (cached && now() < Date.parse(cached.expiresAt)) return structuredClone(cached);
    if (!pending) pending = (async () => {
      const startedAt = now(), clock = performance.now();
      let databaseLatencyMs = 0;
      const [database, evidence, inbox] = await Promise.allSettled([
        bounded(probe, timeout).finally(() => { databaseLatencyMs = Math.round(performance.now() - clock); }),
        (readEvidence ?? options.readOperationalEvidence) ? bounded((readEvidence ?? options.readOperationalEvidence)!, timeout) : Promise.resolve([]),
        readInbox ? bounded(readInbox, timeout) : Promise.resolve(null),
      ]);
      const timestamp = new Date(now()).toISOString();
      const checks: HealthCheck[] = [];
      const latencyMs = databaseLatencyMs;
      if (database.status === 'fulfilled' && databaseEvidenceIsValid(database.value, now())) {
        const data = database.value;
        checks.push({ id: 'database', label: 'DATABASE CONNECTION', status: latencyMs > 1500 ? 'degraded' : 'healthy',
          checkedAt: data.observedAt, latencyMs, detail: 'LIVE AUTHORIZED DATABASE CHECK.' });
        checks.push({ id: 'migrations', label: 'DATABASE MIGRATIONS', status: data.migrationHead && bundledHead ? data.migrationHead === bundledHead ? 'healthy' : 'degraded' : 'unknown',
          checkedAt: data.observedAt, detail: data.migrationHead === bundledHead && bundledHead ? 'DATABASE AND RELEASE MIGRATION HEADS MATCH.' : 'VERIFY DATABASE MIGRATIONS AGAINST THIS RELEASE.',
          metrics: { appliedHead: data.migrationHead, bundledHead } });
        const age = data.oldestPendingImportAt ? Math.max(0, Math.floor((now() - Date.parse(data.oldestPendingImportAt)) / SECOND)) : null;
        checks.push({ id: 'imports', label: 'IMPORT ACTIVITY', status: data.failedImports > 0 || (age !== null && age > 5 * 60) ? 'degraded' : 'healthy',
          checkedAt: data.observedAt, detail: 'QUEUED OR PROCESSING IMPORTS; REVIEW DRAFTS ARE EXCLUDED.',
          metrics: { pending: data.pendingImports, failed: data.failedImports, oldestPendingSeconds: age } });
      } else {
        checks.push({ id: 'database', label: 'DATABASE CONNECTION', status: database.status === 'rejected' ? 'unavailable' : 'unknown', checkedAt: timestamp,
          latencyMs, detail: 'DATABASE CHECK COULD NOT BE CONFIRMED.' });
        for (const [id, label] of [['migrations', 'DATABASE MIGRATIONS'], ['imports', 'IMPORT ACTIVITY']])
          checks.push({ id, label, status: 'unknown', checkedAt: null, detail: 'DATABASE CHECK REQUIRED.' });
      }
      checks.push(inboxHealthCheck(inbox.status === 'fulfilled' ? inbox.value : null, now()));
      checks.push(...operationalChecks(evidence.status === 'fulfilled' ? evidence.value : [], now()));
      // Even a slow/failed check gets a short bounded cache to avoid amplifying an incident.
      const result: SystemHealth = { schemaVersion: 1, status: aggregate(checks), observedAt: timestamp,
        expiresAt: new Date(Math.max(startedAt, now()) + ttl).toISOString(), cacheTtlSeconds: ttl / SECOND, checks };
      cached = result;
      return result;
    })().finally(() => { pending = undefined; });
    return structuredClone(await pending);
  };
}

export const collectSystemHealth = createHealthCollector();

/** Translate only known, server-validated monitor rows; expire old results automatically. */
export function monitoringEvidence(items: readonly MonitorEvidenceRecord[]): OperationalEvidence[] {
  const latest = items.filter(item => item.kind === 'external-availability' && item.source === 'github-actions' &&
    Number.isFinite(Date.parse(item.observedAt)) && /^\d{1,30}$/.test(item.checkRun))
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
  return latest ? [{ id: 'external-availability', status: latest.status, observedAt: latest.observedAt,
    validUntil: new Date(Date.parse(latest.observedAt) + 45 * MINUTE).toISOString(),
    source: 'GITHUB ACTIONS', reference: latest.checkRun }] : [];
}
