import { ecoConnections } from '../../config/ecoConnections.ts';
import type { HealthCheck, HealthStatus, SystemHealth } from '../../shared/system.ts';

const HOUR = 3_600_000, MAX_AGE = 36 * HOUR, CACHE_MS = 10 * 60_000, DEADLINE_MS = 3500;
const DAY = 24 * HOUR, HK_OFFSET = 8 * HOUR;
const API = 'https://api.github.com';
type Json = Record<string, unknown>;
interface Observation { observedAt: number; status: HealthStatus; detail: string; completedAt?: number; earliestSnapshotAt?: number; backupDate?: string; runId?: string; attempt?: number }
const record = (v: unknown): Json => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('INVALID_METADATA'); return v as Json; };
function check(value: unknown): asserts value { if (!value) throw Error('INVALID_METADATA'); }
const id = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : '';
const stamp = (value: unknown, now: number): number => {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  check(Number.isFinite(parsed) && parsed <= now + 60_000); return parsed;
};
function repository(value: unknown): void {
  const r = record(value), owner = record(r.owner);
  check(id(r.id) === ecoConnections.backup.githubRepositoryId && r.full_name === ecoConnections.githubRepository
    && id(owner.id) === ecoConnections.backup.githubOwnerId && owner.login === ecoConnections.githubRepository.split('/')[0]
    && r.private === false);
}
function healthChecks(value: Observation, now: number): HealthCheck[] {
  let status = value.status, detail = value.detail;
  if (value.observedAt > now + 60_000 || now - value.observedAt > CACHE_MS + 5000) {
    status = 'unknown'; detail = 'BACKUP MONITOR EVIDENCE IS STALE.';
  } else if (status === 'healthy' && (value.earliestSnapshotAt === undefined || now - value.earliestSnapshotAt > MAX_AGE)) {
    status = 'unavailable'; detail = 'BACKUP FRESHNESS CANNOT BE VERIFIED WITHIN 36 HOURS.';
  }
  return [['database-backup','DATABASE BACKUP'], ['document-backup','DOCUMENT BACKUP']].map(([key, label]) => ({
    id:key, label, status, checkedAt:new Date(value.observedAt).toISOString(), detail,
    metrics:{ source:'GITHUB ACTIONS', runId:value.runId ?? null, attempt:value.attempt ?? null,
      copyVerifiedAt:value.completedAt === undefined ? null : new Date(value.completedAt).toISOString(),
      backupDate:value.backupDate ?? null },
  }));
}

/** Read-only public API observer. No GitHub token, backup credential, log or artifact access. */
export function createBackupHealthObserver(options: { fetchImpl?: typeof fetch; now?: () => number; deadlineMs?: number } = {}) {
  const fetchImpl = options.fetchImpl ?? fetch, now = options.now ?? Date.now;
  const deadline = options.deadlineMs ?? DEADLINE_MS;
  let cached: Observation | undefined, pending: Promise<Observation> | undefined;
  async function probe(): Promise<Observation> {
    const startedAt = now(), controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unknown = (): Observation => ({ observedAt:now(), status:'unknown', detail:'BACKUP STATUS COULD NOT BE VERIFIED.' });
    const work = async (): Promise<Observation> => {
      async function json(path: string): Promise<Json> {
        const url = API + path;
        const response = await fetchImpl(url, { method:'GET', redirect:'error', signal:controller.signal,
          headers:{ Accept:'application/vnd.github+json', 'X-GitHub-Api-Version':'2026-03-10', 'User-Agent':'ECO-Backup-Health' } });
        check(response.status === 200 && !response.redirected && (!response.url || response.url === url)
          && response.headers.get('content-type')?.split(';')[0].trim() === 'application/json' && response.body);
        const reader = response.body!.getReader(), chunks: Uint8Array[] = []; let size = 0;
        try {
          for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength;
            check(size <= 512 * 1024); chunks.push(chunk.value); }
          return record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } finally { void reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch { /* Aborted pending read. */ } }
      }
      const base = `/repos/${ecoConnections.githubRepository}`;
      const workflowPath = ecoConnections.backup.githubWorkflowPath;
      const workflowFile = encodeURIComponent(workflowPath.split('/').at(-1)!);
      const [repo, workflow, list] = await Promise.all([
        json(base), json(`${base}/actions/workflows/${workflowFile}`),
        json(`${base}/actions/workflows/${workflowFile}/runs?branch=main&per_page=10&exclude_pull_requests=true`),
      ]);
      repository(repo); check(repo.archived === false && workflow.path === workflowPath && id(workflow.id));
      if (workflow.state !== 'active') {
        check(['disabled_manually','disabled_inactivity','disabled_fork','deleted'].includes(String(workflow.state)));
        return { observedAt:now(), status:'unavailable', detail:'THE BACKUP WORKFLOW IS DISABLED.' };
      }
      check(Array.isArray(list.workflow_runs) && list.workflow_runs.length <= 10 && Number.isSafeInteger(list.total_count)
        && Number(list.total_count) >= list.workflow_runs.length);
      if (list.workflow_runs.length === 0) return { observedAt:now(), status:'unknown', detail:'NO VERIFIED BACKUP RUN HAS BEEN RECORDED.' };
      const runs = list.workflow_runs.map(value => {
        const run = record(value); repository(run.repository); repository(run.head_repository);
        // GitHub's run schema also represents the workflow path with a literal ref suffix.
        check(id(run.id) && run.workflow_id === workflow.id
          && [workflowPath, `${workflowPath}@main`, `${workflowPath}@${ecoConnections.backup.githubRef}`].includes(String(run.path))
          && run.head_branch === 'main'
          && ['schedule','workflow_dispatch'].includes(String(run.event)) && typeof run.head_sha === 'string'
          && /^[a-f0-9]{40}$/.test(run.head_sha) && Array.isArray(run.pull_requests) && run.pull_requests.length === 0
          && Number.isSafeInteger(run.run_attempt) && Number(run.run_attempt) >= 1);
        const created = stamp(run.created_at, now()), updated = stamp(run.updated_at, now()); check(updated >= created);
        return { run, updated };
      }).sort((a,b) => b.updated - a.updated);
      const run = runs[0].run, common = { observedAt:now(), runId:id(run.id), attempt:Number(run.run_attempt) };
      if (run.status !== 'completed') {
        check(['queued','in_progress','requested','waiting','pending'].includes(String(run.status)));
        return { ...common, status:'degraded', detail:'THE LATEST BACKUP RUN HAS NOT COMPLETED.' };
      }
      if (run.conclusion !== 'success') {
        check(['failure','cancelled','timed_out','action_required','skipped','neutral','stale','startup_failure'].includes(String(run.conclusion)));
        return { ...common, status:'unavailable', detail:'THE LATEST BACKUP RUN DID NOT COMPLETE SUCCESSFULLY.' };
      }
      const jobs = await json(`${base}/actions/runs/${id(run.id)}/attempts/${run.run_attempt}/jobs?per_page=100`);
      check(jobs.total_count === 1 && Array.isArray(jobs.jobs) && jobs.jobs.length === 1);
      const job = record(jobs.jobs[0]);
      // run_attempt is optional in GitHub's job schema; the endpoint itself pins it.
      check(job.name === 'backup' && job.run_id === run.id && (job.run_attempt === undefined || job.run_attempt === run.run_attempt)
        && job.head_sha === run.head_sha && id(job.id) && job.status === 'completed' && job.conclusion === 'success'
        && Array.isArray(job.steps));
      const matches = job.steps.map(record).filter(step => step.name === ecoConnections.backup.githubCaptureStepName);
      check(matches.length === 1);
      const step = matches[0];
      if (step.status !== 'completed' || step.conclusion !== 'success')
        return { ...common, status:'unavailable', detail:'BACKUP COPY VERIFICATION DID NOT COMPLETE.' };
      const captured = stamp(step.started_at, now()), completed = stamp(step.completed_at, now());
      const jobStart = stamp(job.started_at, now()), jobEnd = stamp(job.completed_at, now());
      check(completed >= captured && captured >= jobStart && jobStart >= stamp(run.created_at, now()) && completed <= jobEnd && jobEnd <= stamp(run.updated_at, now()) + 60_000
        && completed - captured <= 45 * 60_000 && captured >= startedAt - 30 * 24 * HOUR);
      // A same-night retry can verify an existing archive. Step time is not snapshot time.
      // The runner pins the HK backup date, so its day start is a conservative lower bound.
      const earliestSnapshotAt = Math.floor((captured + HK_OFFSET) / DAY) * DAY - HK_OFFSET;
      return { ...common, status:'healthy', detail:'ENCRYPTED BACKUP COPY VERIFIED. RECOVERY TEST IS SEPARATE.',
        earliestSnapshotAt, backupDate:new Date(captured + HK_OFFSET).toISOString().slice(0,10), completedAt:completed };
    };
    try {
      return await Promise.race([work(), new Promise<Observation>(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve(unknown()); }, deadline);
      })]);
    } catch { return unknown(); }
    finally { if (timer) clearTimeout(timer); controller.abort(); }
  }
  return async function observe(enabled: boolean): Promise<HealthCheck[]> {
    if (!enabled) return [];
    if (!cached || now() - cached.observedAt >= CACHE_MS || cached.observedAt > now()) {
      pending ??= probe().then(value => { cached = value; return value; }).finally(() => { pending = undefined; });
      await pending;
    }
    return healthChecks(cached!, now());
  };
}
export const observeBackupHealth = createBackupHealthObserver();

/** Preserve admin authorization and all other checks, especially restore-test. */
export function mergeBackupHealth(system: SystemHealth, backups: readonly HealthCheck[]): SystemHealth {
  if (backups.length === 0) return system;
  check(backups.length === 2 && backups.filter(c => c.id === 'database-backup').length === 1
    && backups.filter(c => c.id === 'document-backup').length === 1);
  const checks = system.checks.map(check => backups.find(item => item.id === check.id) ?? check);
  const status = (['unavailable','degraded','unknown'] as const).find(value => checks.some(check => check.status === value)) ?? 'healthy';
  return { ...system, checks, status };
}
