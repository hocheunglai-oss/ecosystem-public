import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error local operator verification module
import { verificationMode, canonicalHash, expectedSnapshot, validateManifest, assertOwnedFixtures, assertDeniedPayload, assertProtectionCookies } from '../scripts/intelligence/verify-snapshot.mjs';
import { ecoConnections } from '../config/ecoConnections.ts';

const source = () => ({ projectRef: ecoConnections.supabaseProjectRef, input: {
  requestId: '11111111-1111-4111-8111-111111111111', sourceHash: 'a'.repeat(64),
  snapshot: { schemaVersion: 1, portId: 'port-example', recordedAt: '2025-01-31T00:00:00.000Z', supplierRecordedAt: '2025-01-31T00:00:00.000Z',
    periodStart: '2025-01-01', periodEnd: '2025-01-31', sourceUrl: 'https://example.test/counts', supplierSourceUrl: 'https://example.test/suppliers',
    suppliers: [{ id: 'spc-example', name: 'Synthetic Supplier', portIds: ['port-example'], grades: ['VLSFO'] }, { id: 'spc-other', name: 'Synthetic Other', portIds: ['port-example'], grades: [] }],
    counts: [{ supplierId: 'spc-example', date: '2025-01-01', count: 2 }, { supplierId: 'spc-example', date: '2025-01-02', count: 3 }] },
} });
const manifest = () => ({ kind: 'eco-intelligence-verification-v1', projectRef: ecoConnections.supabaseProjectRef, runId: 'abcdef012345abcdef012345',
  identities: ['admin', 'member', 'other'].map((role, index) => ({ role, id: `${index + 1}1111111-1111-4111-8111-111111111111`, email: `eco-intelligence-abcdef012345abcdef012345-${role}@example.com` })) });

test('hosted verifier defaults read-only; full and cleanup mutations require the explicit flag', () => {
  assert.deepEqual(verificationMode([]), { mode: 'preflight', cleanup: null });
  assert.deepEqual(verificationMode(['--allow-cloud-mutations']), { mode: 'full', cleanup: null });
  assert.deepEqual(verificationMode(['--allow-cloud-mutations', '--cleanup-only', '/private/tmp/recovery.private.json']), { mode: 'cleanup', cleanup: '/private/tmp/recovery.private.json' });
  for (const args of [['--cleanup-only', '/private/tmp/recovery.private.json'], ['--allow-cloud-mutations', '--cleanup-only', 'relative'], ['--allow-cloud-mutations', '--allow-cloud-mutations'], ['--unknown']]) assert.throws(() => verificationMode(args));
});

test('private source parity derives totals and exact calendar period without leaking rows into aggregate hashes', () => {
  const saved = source(), before = structuredClone(saved);
  const value = expectedSnapshot(saved);
  assert.deepEqual(saved, before, 'Verification must not mutate the operator request.');
  assert.equal(value.suppliers[0].fixtureCount, 5); assert.equal(value.suppliers[1].fixtureCount, 0);
  assert.equal(value.suppliers[0].fixturePeriod, '2025-01-01 – 2025-01-31');
  assert.equal(value.suppliers[0].recordedAt, saved.input.snapshot.recordedAt);
  const hash = canonicalHash(value); assert.match(hash, /^[a-f0-9]{64}$/); assert.ok(!hash.includes('Synthetic'));
  assert.equal(canonicalHash({ a: 1, b: { c: 2, d: 3 } }), canonicalHash({ b: { d: 3, c: 2 }, a: 1 }));
  assert.notEqual(canonicalHash([1, 2]), canonicalHash([2, 1]));
  assert.notEqual(canonicalHash({ ...value, counts: [] }), hash);
  const annual = source(); annual.input.snapshot.periodStart = '2024-02-29'; annual.input.snapshot.periodEnd = '2025-02-27';
  annual.input.snapshot.recordedAt = '2025-02-28T00:00:00.000Z';
  assert.equal(expectedSnapshot(annual).suppliers[0].fixturePeriod, 'Last 12 months');
  assert.throws(() => expectedSnapshot({ ...saved, projectRef: 'different-project' }));
  const orphan = source(); orphan.input.snapshot.counts[0].supplierId = 'unknown'; assert.throws(() => expectedSnapshot(orphan));
});

test('cleanup requires the exact synthetic identity, application profile and immutable run tag', () => {
  const value = manifest(); validateManifest(value);
  const users = value.identities.map(identity => ({ id: identity.id, email: identity.email, tag: value.runId }));
  const profiles = value.identities.map(identity => ({ id: identity.id, email: identity.email, display_name: `ECO INTELLIGENCE ${identity.role.toUpperCase()}` }));
  assert.doesNotThrow(() => assertOwnedFixtures(value, users, profiles));
  assert.doesNotThrow(() => assertOwnedFixtures(value, users.slice(0, 1), [{ ...profiles[0], display_name: users[0].email }]), 'Unprovisioned trigger profile remains recoverable after an uncertain create.');
  assert.doesNotThrow(() => assertOwnedFixtures(value, users.slice(0, 1), profiles.slice(0, 1)), 'Partial fixture creation remains recoverable.');
  for (const replacement of [{ ...users[0], email: 'unrelated@example.com' }, { ...users[0], tag: 'another-run' }, { ...users[0], id: '99999999-9999-4999-8999-999999999999' }]) assert.throws(() => assertOwnedFixtures(value, [replacement], []));
  assert.throws(() => assertOwnedFixtures(value, [], profiles));
  assert.throws(() => assertOwnedFixtures(value, users, [{ ...profiles[0], display_name: 'Unrelated profile' }]));
  assert.throws(() => validateManifest({ ...value, projectRef: 'other-project' }));
  assert.throws(() => validateManifest({ ...value, identities: [value.identities[0], value.identities[0], value.identities[2]] }));
});

test('stage protection cannot smuggle an application session into the anonymous probe', () => {
  const base = 'https://example-stage.vercel.app';
  const cookie = 'example-stage.vercel.app\tFALSE\t/\tTRUE\t0\t_vercel_jwt\tsynthetic-protection';
  assert.doesNotThrow(() => assertProtectionCookies(cookie, base));
  assert.doesNotThrow(() => assertProtectionCookies('#HttpOnly_' + cookie, base));
  for (const invalid of ['', cookie.replace('_vercel_jwt', 'eco-auth'), cookie.replace('example-stage.vercel.app', 'other-stage.vercel.app'), '.' + cookie, cookie.replace('\tTRUE\t', '\tFALSE\t'), cookie + '\n' + cookie.replace('_vercel_jwt', 'eco-auth')]) assert.throws(() => assertProtectionCookies(invalid, base));
});

test('anonymous and ineligible responses must deny access and contain only a bounded message', () => {
  for (const status of [401, 403]) assert.doesNotThrow(() => assertDeniedPayload(status, { message: 'Sign in required.' }));
  for (const [status, payload] of [[200, { message: 'Denied' }], [503, { message: 'Unavailable' }], [401, { message: 'Denied', snapshot: { suppliers: [] } }], [401, { message: 'x'.repeat(201) }], [403, []], [401, null]]) assert.throws(() => assertDeniedPayload(status, payload));
});
