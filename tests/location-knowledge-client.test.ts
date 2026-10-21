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

test('a save is acknowledged only by the matching committed request within the returned revision', async () => {
  const { locationKnowledgeApi } = await import('../src/lib/locationKnowledgeApi.ts');
  const original = globalThis.fetch;
  const input = { requestId: '10000000-0000-4000-8000-000000000001', revision: 1, dataMode: 'live' as const,
    action: { type: 'add-location' as const, kind: 'country' as const, name: 'Fixture' } };
  const payload = { revision: 3, snapshot: initialLocationSnapshot(), importedSources: [] };
  try {
    for (const ack of [undefined, { requestId: 'other', committedRevision: 2 }, { requestId: input.requestId, committedRevision: -1 }, { requestId: input.requestId, committedRevision: 4 }]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ ...payload, ack }), { status: 200 });
      await assert.rejects(locationKnowledgeApi.write(input), /could not be confirmed/);
    }
    globalThis.fetch = async () => new Response(JSON.stringify({ ...payload, ack: { requestId: input.requestId, committedRevision: 2 } }), { status: 200 });
    const result = await locationKnowledgeApi.write(input);
    assert.equal(result.revision, 3); assert.equal(result.ack?.committedRevision, 2);
  } finally { globalThis.fetch = original; }
});

test('malformed successful history and activity responses remain unavailable instead of rendering false totals', async () => {
  const { locationKnowledgeApi } = await import('../src/lib/locationKnowledgeApi.ts');
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ summary: { total: 'unknown' }, activeDates: [], nextCursor: null }), { status: 200 });
    await assert.rejects(locationKnowledgeApi.activity(['10000000-0000-4000-8000-000000000001'], '7d'), /unavailable/);
    globalThis.fetch = async () => new Response(JSON.stringify({ items: [{ before: {}, after: {} }], total: 1, nextCursor: null }), { status: 200 });
    await assert.rejects(locationKnowledgeApi.history([{ kind: 'port', id: 'port-singapore' }]));
  } finally { globalThis.fetch = original; }
});
