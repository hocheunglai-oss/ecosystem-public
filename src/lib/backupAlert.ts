import type { HealthCheck, SystemHealth } from '../../shared/system';

export interface BackupNotice {
  status: 'unknown' | 'degraded' | 'unavailable';
  title: string;
  detail: string;
}

export const unverifiedBackupNotice = (): BackupNotice => ({
  status: 'unknown', title: 'BACKUP STATUS UNVERIFIED', detail: 'BACKUP STATUS COULD NOT BE VERIFIED.',
});

/** Only the authenticated server's current backup checks can dismiss this notice. */
export function backupNotice(health: SystemHealth | null, now = Date.now()): BackupNotice | null {
  if (!health || health.schemaVersion !== 1 || !Array.isArray(health.checks) ||
      !Number.isFinite(Date.parse(health.observedAt)) || Date.parse(health.observedAt) > now + 60_000 ||
      !Number.isFinite(Date.parse(health.expiresAt)) || Date.parse(health.expiresAt) <= now ||
      Date.parse(health.expiresAt) <= Date.parse(health.observedAt) ||
      Date.parse(health.expiresAt) - Date.parse(health.observedAt) > 120_000) return unverifiedBackupNotice();
  const checks = health.checks.filter(check => check && ['database-backup', 'document-backup'].includes(check.id));
  if (checks.length !== 2 || new Set(checks.map(check => check.id)).size !== 2 ||
      checks.some(check => !['healthy', 'degraded', 'unavailable', 'unknown'].includes(check.status) ||
        check.status === 'healthy' && (!check.checkedAt || !Number.isFinite(Date.parse(check.checkedAt)) ||
          Date.parse(check.checkedAt) > now + 60_000))) return unverifiedBackupNotice();
  if (checks.every(check => check.status === 'healthy')) return null;
  const status = (['unavailable', 'unknown', 'degraded'] as const).find(value => checks.some(check => check.status === value))!;
  if (status === 'unknown') return unverifiedBackupNotice();
  const details = [...new Set(checks.filter(check => check.status !== 'healthy').map((check: HealthCheck) =>
    typeof check.detail === 'string' && check.detail.length > 0 && check.detail.length <= 240 ? check.detail : 'BACKUP STATUS COULD NOT BE VERIFIED.'))];
  return { status, title: 'BACKUP REQUIRES ATTENTION', detail: details.join(' ') };
}
