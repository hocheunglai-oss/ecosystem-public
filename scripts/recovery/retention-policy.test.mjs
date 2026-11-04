import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { planBackupRetention } from './retention-policy.mjs';
import { hongKongNight } from './drive-backups.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const point = (snapshotAt,extra={}) => ({sha256:hash(snapshotAt),snapshotAt,night:hongKongNight(snapshotAt),size:1024,provenanceKnown:true,...extra});
const now = '2026-11-04T03:00:00.000Z';
const current = point('2026-11-04T02:00:00.000Z');
const plan = (points,extra={}) => planBackupRetention({now,points:[...points,current],currentSha256:current.sha256,
  restore:{sha256:hash('legacy-restored'),verifiedAt:'2026-11-03T03:00:00.000Z'},...extra});

test('14 distinct HK dates and calendar weekly/monthly union keep their independent reasons',()=>{
  const points = Array.from({length:420},(_,index)=>point(new Date(Date.parse('2026-11-03T02:00:00.000Z')-index*86400000).toISOString()));
  const result = plan(points);
  assert.equal(result.entries.filter(entry=>entry.drive.retain).length,14);
  assert.equal(result.entries.filter(entry=>entry.nextcloud.reasons.includes('WEEKLY_8')).length,8);
  assert.equal(result.entries.filter(entry=>entry.nextcloud.reasons.includes('MONTHLY_12')).length,12);
  assert.ok(result.entries.filter(entry=>entry.nextcloud.retain).length <= 34);
  assert.deepEqual(result.missingPeriods,{weekly:[],monthly:[]});
  assert.ok(result.entries.find(entry=>entry.night==='2026-10-31').nextcloud.reasons.includes('MONTHLY_12'));
  assert.ok(result.entries.find(entry=>entry.night==='2026-11-01').nextcloud.reasons.includes('WEEKLY_8'));
  assert.ok(!result.entries.find(entry=>entry.night==='2026-11-03').nextcloud.reasons.includes('WEEKLY_8'));
});
test('HK midnight, year and leap-month boundaries use completed calendar periods',()=>{
  const localCurrent = point('2025-01-01T16:01:00.000Z');
  const result = planBackupRetention({now:'2025-01-01T17:00:00.000Z',points:[localCurrent,
    point('2024-12-31T15:59:00.000Z'),point('2024-12-29T15:59:00.000Z'),point('2024-02-29T15:59:00.000Z')],
    currentSha256:localCurrent.sha256,restore:{sha256:hash('legacy'),verifiedAt:'2025-01-01T00:00:00.000Z'}});
  assert.ok(result.entries.find(entry=>entry.night==='2024-12-31').nextcloud.reasons.includes('MONTHLY_12'));
  assert.ok(result.entries.find(entry=>entry.night==='2024-12-29').nextcloud.reasons.includes('WEEKLY_8'));
  assert.ok(result.entries.find(entry=>entry.night==='2024-02-29').nextcloud.reasons.includes('MONTHLY_12'));
  assert.equal(result.missingPeriods.monthly.length,10);
});
test('missing periods are reported rather than filled with arbitrary older history',()=>{
  const result = plan([point('2024-01-01T01:00:00.000Z')]);
  assert.equal(result.missingPeriods.weekly.length,8);
  assert.equal(result.missingPeriods.monthly.length,12);
  assert.equal(result.entries[0].nextcloud.reasons.some(reason=>reason.startsWith('MONTHLY')),false);
});
test('legacy provenance, conflicting captures, future points and restored point remain protected',()=>{
  const old = point('2024-01-01T01:00:00.000Z'), points = [old,
    point('2024-02-01T01:00:00.000Z',{provenanceKnown:false}),point('2024-03-01T01:00:00.000Z'),
    point('2024-03-01T02:00:00.000Z'),point('2027-01-01T01:00:00.000Z')];
  const result = plan(points,{protectedHashes:[old.sha256]});
  assert.ok(result.entries.every(entry=>entry.drive.retain && entry.nextcloud.retain));
  assert.ok(result.entries.find(entry=>entry.sha256===old.sha256).drive.reasons.includes('PROTECTED_RESTORE'));
});
test('missing, future or stale restore prevents every cleanup candidate',()=>{
  const points = Array.from({length:20},(_,index)=>point(new Date(Date.parse('2026-11-03T02:00:00.000Z')-index*86400000).toISOString()));
  for (const restore of [null,{sha256:hash('x'),verifiedAt:'2026-09-01T00:00:00.000Z'},{sha256:hash('x'),verifiedAt:'2026-12-01T00:00:00.000Z'}]) {
    const result = plan(points,{restore});
    assert.equal(result.cleanupEligible,false);
    assert.ok(result.entries.every(entry=>entry.drive.retain && entry.nextcloud.retain));
  }
});
test('reject malformed or duplicate identities and a current point from another HK night',()=>{
  for (const points of [[current],[point('2026-10-01T00:00:00.000Z',{size:NaN})],
    [point('2026-10-01T00:00:00.000Z',{night:'2026-10-02'})]]) assert.throws(()=>plan(points),/RETENTION_INPUT_INVALID/);
  assert.throws(()=>plan([],{currentSha256:hash('missing')}),/RETENTION_INPUT_INVALID/);
});
