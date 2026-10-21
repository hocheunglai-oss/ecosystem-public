import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isDefinitiveLocationWriteFailure, locationImportAssessment, locationImportDigest } from '../src/lib/useSharedLocationKnowledge.ts';
import { canonicalLocationSnapshotJson, initialLocationSnapshot, parseLocationSnapshot } from '../src/lib/sharedLocationKnowledge.ts';

test('auth, permission and availability failures retain an unresolved save; verified validation/conflict responses can reconcile', () => {
  for (const status of [undefined, null, 0, 401, 403, 404, 408, 429, 500, 502, 503, 504]) assert.equal(isDefinitiveLocationWriteFailure(status), false, String(status));
  for (const status of [400, 409, 413, 415, 422]) assert.equal(isDefinitiveLocationWriteFailure(status), true, String(status));
});
test('browser migration digest equals the server digest despite key-order differences, but changes with source content', async () => {
  const source = initialLocationSnapshot(); source.ports[0].summary = 'Synthetic retained source';
  const reversed = Object.fromEntries(Object.entries(source).reverse());
  const expected = createHash('sha256').update(canonicalLocationSnapshotJson(source)).digest('hex');
  assert.equal(await locationImportDigest(source), expected); assert.equal(await locationImportDigest(reversed as typeof source), expected);
  const changed = structuredClone(source); changed.ports[0].summary += ' changed'; assert.notEqual(await locationImportDigest(changed), expected);
});
test('two valid archives exceeding merged capacity report a review error without mutating either original', () => {
  const shared = initialLocationSnapshot(), local = initialLocationSnapshot();
  shared.ports.push({ ...shared.ports[0], id: 'port-shared-capacity', name: 'Shared capacity fixture', notes: Array.from({length:100}, () => 's'.repeat(20_000)) });
  local.ports.push({ ...local.ports[0], id: 'port-local-capacity', name: 'Local capacity fixture', notes: Array.from({length:100}, () => 'l'.repeat(20_000)) });
  parseLocationSnapshot(shared); parseLocationSnapshot(local);
  const beforeShared = JSON.stringify(shared), beforeLocal = JSON.stringify(local), assessment = locationImportAssessment(shared, local);
  assert.match(assessment.error, /too large/); assert.deepEqual(assessment.conflicts, []);
  assert.equal(JSON.stringify(shared), beforeShared); assert.equal(JSON.stringify(local), beforeLocal);
});
test('conflicting source records remain a review conflict, while absent sources need no import', () => {
  const shared = initialLocationSnapshot(), local = initialLocationSnapshot(); shared.ports[0].summary = 'Shared'; local.ports[0].summary = 'Local';
  const review = locationImportAssessment(shared, local); assert.equal(review.error, ''); assert.equal(review.conflicts[0].reason, 'RECORD_CONFLICT');
  assert.deepEqual(locationImportAssessment(shared, null), { conflicts: [], error: '' });
});
