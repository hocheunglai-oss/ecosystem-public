import type { HealthCheck, SystemHealth } from '../../shared/system';

export interface BackupNotice {
  status: 'unavailable';
  title: string;
  detail: string;
}

/** Notify only confirmed failures; all health states remain in System Health. */
export function backupNotice(health: SystemHealth | null, now = Date.now()): BackupNotice | null {
  if (!health || health.schemaVersion !== 1 || !Array.isArray(health.checks) ||
      !Number.isFinite(Date.parse(health.observedAt)) || Date.parse(health.observedAt) > now + 60_000 ||
      !Number.isFinite(Date.parse(health.expiresAt)) || Date.parse(health.expiresAt) <= now ||
      Date.parse(health.expiresAt) <= Date.parse(health.observedAt) ||
      Date.parse(health.expiresAt) - Date.parse(health.observedAt) > 120_000) return null;
  const checks = health.checks.filter(check => check && ['database-backup', 'document-backup'].includes(check.id));
  if (checks.length !== 2 || new Set(checks.map(check => check.id)).size !== 2 ||
      checks.some(check => !['healthy', 'degraded', 'unavailable', 'unknown'].includes(check.status) ||
        ['healthy', 'unavailable'].includes(check.status) && (!check.checkedAt || !Number.isFinite(Date.parse(check.checkedAt)) ||
          Date.parse(check.checkedAt) > now + 60_000))) return null;
  const failures = checks.filter(check => check.status === 'unavailable');
  if (!failures.length) return null;
  const details = [...new Set(failures.map((check: HealthCheck) =>
    typeof check.detail === 'string' && check.detail.length > 0 && check.detail.length <= 240 ? check.detail : 'BACKUP STATUS COULD NOT BE VERIFIED.'))];
  return { status: 'unavailable', title: 'BACKUP REQUIRES ATTENTION', detail: details.join(' ') };
}
