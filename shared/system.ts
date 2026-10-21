/** Safe operator metadata. No credentials, user records or arbitrary environment values. */
export type HealthStatus = 'healthy' | 'degraded' | 'unavailable' | 'unknown';
export interface SystemDependency { name: string; version: string; scope: 'runtime' | 'development' }
export interface SystemBuildInformation {
  schemaVersion: 1;
  application: { name: string; version: string };
  build: { builtAt: string; releaseId: string; sourceSha256: string; sourceFileCount: number; lockfileSha256: string;
    gitCommit: string | null; gitWorktree: 'clean' | 'dirty' | 'unknown'; buildNode: string; requiredNode: string };
  dependencies: SystemDependency[];
  migrations: { bundledHead: string | null; count: number; sha256: string; baseline?: { head: string; sections: number; sha256: string } };
  targets: { databaseRegion: string; databaseProjectRef: string | null; computeRegions: string[]; identityMode: string };
}
export interface SystemInformation extends SystemBuildInformation {
  runtime: { node: string; requiredNode: string; environment: 'production' | 'preview' | 'development' | 'local';
    deploymentId: string | null; region: string | null };
}
export interface DatabaseHealthEvidence {
  observedAt: string;
  migrationHead: string | null;
  pendingImports: number;
  failedImports: number;
  /** Only queued/processing work, never a draft legitimately waiting for human review. */
  oldestPendingImportAt: string | null;
}
export interface HealthCheck {
  id: string; label: string; status: HealthStatus; detail: string;
  checkedAt: string | null; latencyMs?: number;
  metrics?: Record<string, string | number | null>;
}
export interface SystemHealth {
  schemaVersion: 1; status: HealthStatus; observedAt: string; expiresAt: string; cacheTtlSeconds: number;
  checks: HealthCheck[];
}
export interface MonitorEvidenceRecord { kind: 'external-availability'; source: 'github-actions'; observedAt: string; status: Exclude<HealthStatus, 'unknown'>; latencyMs: number; checkRun: string }
export type OperationalEvidenceId = 'external-availability' | 'error-alerting' | 'database-backup' | 'document-backup' | 'restore-test';
/** Trusted server adapter output only. Never accept this shape from ordinary browser requests. */
export interface OperationalEvidence {
  id: OperationalEvidenceId; status: Exclude<HealthStatus, 'unknown'>; observedAt: string;
  validUntil: string; source: string; reference: string;
}
