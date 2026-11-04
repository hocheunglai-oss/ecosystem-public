import test from 'node:test';
import assert from 'node:assert/strict';
import { backupNotice } from '../src/lib/backupAlert.ts';
import type { HealthStatus, SystemHealth } from '../shared/system.ts';

const now = Date.parse('2026-11-03T10:00:00Z');
function health(database: HealthStatus, documents = database): SystemHealth {
  return { schemaVersion: 1, status: 'unknown', observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 30_000).toISOString(), cacheTtlSeconds: 30,
    checks: ['database-backup', 'document-backup'].map((id, index) => ({ id, label: id, status: index ? documents : database,
      checkedAt: new Date(now).toISOString(), detail: 'THE LATEST BACKUP RUN DID NOT COMPLETE SUCCESSFULLY.' })) };
}
test('one archive incident combines database and document checks without inventing recovery status', () => {
  const notice = backupNotice(health('unavailable'), now);
  assert.equal(notice?.status, 'unavailable');
  assert.equal(notice?.detail, 'THE LATEST BACKUP RUN DID NOT COMPLETE SUCCESSFULLY.');
  assert.equal(backupNotice(health('healthy'), now), null);
  assert.equal(backupNotice(health('healthy', 'unavailable'), now)?.status, 'unavailable');
});
test('advisories, pending runs, uncertain status and successful checks do not notify or alter health', () => {
  for (const [status, detail] of [
    ['degraded', 'ENCRYPTED BACKUP COPIES VERIFIED. CAPACITY OR RETENTION NEEDS ATTENTION.'],
    ['degraded', 'THE LATEST BACKUP RUN HAS NOT COMPLETED.'],
    ['unknown', 'BACKUP STATUS COULD NOT BE VERIFIED.'],
    ['healthy', 'ENCRYPTED BACKUP COPY VERIFIED. RECOVERY TEST IS SEPARATE.'],
  ] as const) {
    const value = health(status);
    value.checks.forEach(check => { check.detail = detail; });
    const before = structuredClone(value);
    assert.equal(backupNotice(value, now), null);
    assert.deepEqual(value, before, 'Passive System Health evidence remains unchanged');
  }
});
test('only confirmed failure details appear when another check has an advisory or unknown status', () => {
  for (const status of ['healthy', 'degraded', 'unknown'] as const) {
    const value = health('unavailable', status);
    value.checks[1].detail = 'ADVISORY ONLY';
    if (status === 'unknown') value.checks[1].checkedAt = null;
    assert.equal(backupNotice(value, now)?.detail, value.checks[0].detail);
  }
});
test('missing, expired or invalid evidence cannot produce a failure notification', () => {
  const failure = health('unavailable');
  for (const value of [null, { ...failure, checks: [] }, { ...failure, checks: [failure.checks[0], failure.checks[0]] },
    { ...failure, expiresAt: new Date(now).toISOString() }, { ...failure, observedAt: new Date(now + 120_000).toISOString() },
    { ...failure, expiresAt: new Date(now + 121_000).toISOString() },
    ...[null, 'invalid', new Date(now + 120_000).toISOString()].map(checkedAt => ({ ...failure,
      checks: failure.checks.map(check => ({ ...check, checkedAt })) })),
    { ...failure, checks: failure.checks.map(check => ({ ...check, status: 'invalid' as HealthStatus })) },
  ]) assert.equal(backupNotice(value, now), null);
});
