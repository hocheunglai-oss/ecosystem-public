import test from 'node:test';
import assert from 'node:assert/strict';
import { createHealthCollector, operationalChecks, monitoringEvidence } from '../server/admin/health.ts';
import { handleMonitorEvidence, validMonitorEvidence } from '../server/admin/monitor.ts';
import type { DatabaseHealthEvidence, MonitorEvidenceRecord, OperationalEvidence } from '../shared/system.ts';

const now = Date.UTC(2026, 9, 14, 12);
function database(overrides: Partial<DatabaseHealthEvidence> = {}): DatabaseHealthEvidence {
  return { observedAt: new Date(now).toISOString(), migrationHead: '20261014095316', pendingImports: 0, failedImports: 0, oldestPendingImportAt: null, ...overrides };
}
function monitor(overrides: Partial<MonitorEvidenceRecord> = {}): MonitorEvidenceRecord {
  return { checkRun: '12345001', kind: 'external-availability', source: 'github-actions', observedAt: new Date(now).toISOString(), status: 'healthy', latencyMs: 74, ...overrides };
}

test('healthy DB does not claim unconfigured availability, backup or recovery readiness', async () => {
  const collect = createHealthCollector({ now: () => now, bundledHead: '20261014095316' });
  const result = await collect(async () => database());
  assert.equal(result.status, 'unknown');
  assert.equal(result.checks.find(check => check.id === 'database')?.status, 'healthy');
  assert.equal(result.checks.find(check => check.id === 'restore-test')?.status, 'unknown');
  assert.equal(result.checks.find(check => check.id === 'database-backup')?.checkedAt, null);
});

test('concurrent requests coalesce, cached results cannot be mutated and expiry forces a fresh probe', async () => {
  let time = now, calls = 0;
  const collect = createHealthCollector({ now: () => time, bundledHead: '20261014095316' });
  const probe = async () => { calls++; return database({ observedAt: new Date(time).toISOString() }); };
  const [first, second] = await Promise.all([collect(probe), collect(probe)]);
  assert.equal(calls, 1);
  first.checks.length = 0;
  assert.ok(second.checks.length > 0);
  assert.ok((await collect(probe)).checks.length > 0);
  assert.equal(calls, 1);
  time += 30_001;
  await collect(probe);
  assert.equal(calls, 2);
});

test('mismatch, failed or stalled imports degrade health while a timeout is unavailable', async () => {
  const collect = createHealthCollector({ now: () => now, bundledHead: '20261014095316' });
  const result = await collect(async () => database({ migrationHead: '20261013000000', pendingImports: 1, oldestPendingImportAt: new Date(now - 6 * 60_000).toISOString() }));
  assert.equal(result.status, 'degraded');
  assert.equal(result.checks.find(check => check.id === 'migrations')?.status, 'degraded');
  assert.equal(result.checks.find(check => check.id === 'imports')?.status, 'degraded');
  const failed = await createHealthCollector({ now: () => now, timeoutMs: 5 })(() => new Promise(() => {}));
  assert.equal(failed.status, 'unavailable');
  assert.equal(failed.checks.find(check => check.id === 'imports')?.status, 'unknown');
});

test('stale, future, duplicated or indefinite evidence cannot remain healthy', () => {
  const valid: OperationalEvidence = { id: 'external-availability', status: 'healthy', observedAt: new Date(now).toISOString(),
    validUntil: new Date(now + 45 * 60_000).toISOString(), source: 'GITHUB ACTIONS', reference: '12345001' };
  const status = (items: OperationalEvidence[], at = now) => operationalChecks(items, at).find(check => check.id === valid.id)?.status;
  assert.equal(status([valid]), 'healthy');
  assert.equal(status([valid], now + 46 * 60_000), 'unknown');
  assert.equal(status([valid, valid]), 'unknown');
  assert.equal(status([{ ...valid, observedAt: new Date(now + 2 * 60_000).toISOString() }]), 'unknown');
  assert.equal(status([{ ...valid, validUntil: new Date(now + 100 * 60_000).toISOString() }]), 'unknown');
});

test('monitor adapter picks latest trusted result and expires it after 45 minutes', () => {
  const rows = [monitor({ checkRun: '1', observedAt: new Date(now - 60_000).toISOString(), status: 'unavailable' }), monitor()];
  const result = monitoringEvidence(rows);
  assert.equal(result.length, 1);
  assert.equal(result[0].status, 'healthy');
  assert.equal(Date.parse(result[0].validUntil), now + 45 * 60_000);
});

const secret = 'test-only-monitor-secret-with-ample-length';
function request(value: unknown, authorization = `Bearer ${secret}`) {
  return new Request('https://eco.example.test/api/monitor/evidence', { method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
}

test('monitor requires the scoped secret before any database mutation and accepts only bounded evidence', async () => {
  let calls = 0;
  assert.equal((await handleMonitorEvidence(request(monitor(), 'Bearer incorrect'), secret, async () => { calls++; }, now)).status, 401);
  assert.equal(calls, 0);
  assert.equal((await handleMonitorEvidence(request(monitor()), undefined, async () => { calls++; }, now)).status, 503);
  assert.equal((await handleMonitorEvidence(request(monitor()), secret, async input => { assert.deepEqual(input, monitor()); calls++; }, now)).status, 200);
  assert.equal(calls, 1);
  for (const invalid of [ { ...monitor(), secret: 'never accept' }, monitor({ latencyMs: -1 }), monitor({ observedAt: new Date(now - 11 * 60_000).toISOString() }),
    monitor({ observedAt: new Date(now + 3 * 60_000).toISOString() }), monitor({ checkRun: 'not-an-action-run' }), { ...monitor(), kind: 'database-backup' } ]) {
    assert.equal(validMonitorEvidence(invalid, now), false);
    assert.equal((await handleMonitorEvidence(request(invalid), secret, async () => { calls++; }, now)).status, 400);
  }
  assert.equal(calls, 1);
});

test('monitor never leaks the secret or database errors and rejects large bodies', async () => {
  const result = await handleMonitorEvidence(request(monitor()), secret, async () => { throw new Error(secret); }, now);
  assert.equal(result.status, 503);
  assert.ok(!(await result.text()).includes(secret));
  assert.equal((await handleMonitorEvidence(request({ data: 'a'.repeat(2100) }), secret, async () => {}, now)).status, 413);
});
