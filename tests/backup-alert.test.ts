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
test('missing, expired or invalid evidence stays unverified rather than claiming backup failure', () => {
  for (const value of [null, { ...health('healthy'), checks: [] }, { ...health('healthy'), checks: [health('healthy').checks[0], health('healthy').checks[0]] },
    { ...health('healthy'), expiresAt: new Date(now).toISOString() }, { ...health('healthy'), observedAt: new Date(now + 120_000).toISOString() }, health('unknown')]) {
    const notice = backupNotice(value, now);
    assert.equal(notice?.status, 'unknown');
    assert.equal(notice?.title, 'BACKUP STATUS UNVERIFIED');
    assert.doesNotMatch(notice!.detail, /FAILED|DID NOT COMPLETE/);
  }
});
