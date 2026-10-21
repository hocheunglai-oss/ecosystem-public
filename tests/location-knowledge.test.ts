import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { handleLocationKnowledge, locationEnvelope, locationInput, type LocationStore } from '../server/location-knowledge/handler.ts';
import { initialLocationSnapshot, canonicalLocationSnapshotJson } from '../src/lib/sharedLocationKnowledge.ts';
import type { AuthConfig } from '../server/auth/config.ts';
import type { AccessUser } from '../shared/access.ts';
import { ApiError } from '../server/auth/validation.ts';

const user: AccessUser = { id: randomUUID(), email: 'synthetic@example.test', displayName: 'Synthetic member', officeId: 'hk', officeName: 'Hong Kong', isActive: true, activated: true, isAdmin: false, isSpcTrader: false, isManager: false, passwordChangeSuggested: false, revision: 3 };
const sessionId = randomUUID();
const config = { origin: 'https://eco.example.test', deploymentOrigin: 'https://eco-stage.vercel.app' } as AuthConfig;
const input = () => ({ requestId: randomUUID(), revision: 0, dataMode: 'live', action: { type: 'add-location', kind: 'country', name: 'Synthetic Country' } });
const request = (path = 'list', body?: unknown, headers: Record<string,string> = {}) => new Request(`${config.origin}/api/location-knowledge/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: config.origin, 'X-Eco-Request': '1', 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
function fixture(options: { active?: boolean; activated?: boolean; signedIn?: boolean; admin?: boolean; preview?: boolean; revision?: number } = {}) {
  const actor = { ...user, isActive: options.active ?? true, activated: options.activated ?? true, isAdmin: options.admin ?? false }, calls: { name: string; value?: unknown }[] = [];
  let envelope: unknown = { revision: options.revision ?? 0, snapshot: options.revision ? initialLocationSnapshot() : null, importedSources: [] };
  const receipts = new Map<string, unknown>();
  const gateway = { cookies: ['eco-auth=synthetic; HttpOnly; Secure'], currentUser: async () => options.signedIn === false ? null : actor,
    getPreview: async () => options.preview ? { role: 'trader', readOnly: true } : null,
    authenticatedRpc: async (name: string) => { calls.push({ name }); return { envelope, actorId: actor.id, sessionId, aal: 'aal1' }; },
  } as unknown as Parameters<typeof handleLocationKnowledge>[2];
  const store: LocationStore = {
    prepare: async (identity, operation, value) => { calls.push({ name: 'prepare', value: { identity, operation, input: value } }); return receipts.has(value.requestId) ? { result: receipts.get(value.requestId) } : { envelope, actor }; },
    commit: async (identity, revision, operation, value, snapshot, digest) => {
      calls.push({ name: 'commit', value: { identity, revision, operation, input: value, snapshot, digest } });
      envelope = { revision: value.revision + 1, snapshot, importedSources: digest ? [{ digest, requestId: value.requestId, importedBy: identity.actorId, importedAt: '2026-10-21T12:00:00Z' }] : [] };
      receipts.set(value.requestId, envelope); return envelope;
    },
  };
  return { gateway, store, calls, actor, run: (req: Request) => handleLocationKnowledge(req, config, gateway, store, () => '2026-10-21T12:00:00Z') };
}
test('read authenticates and returns reference geography without writing; preview reads are allowed', async () => {
  for (const preview of [false,true]) { const f = fixture({ preview }), response = await f.run(request()); assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.revision, 0); assert.deepEqual(result.snapshot, initialLocationSnapshot()); assert.deepEqual(f.calls.map(c => c.name), ['eco_location_knowledge_context']); assert.match(response.headers.get('cache-control')!, /no-store/); assert.equal(response.headers.getSetCookie().length, 1); assert.equal(result.sessionId, undefined); assert.equal(result.actorId, undefined); }
  for (const options of [{ active: false }, { activated: false }, { signedIn: false }]) { const f = fixture(options); assert.equal((await f.run(request())).status, 401); assert.equal(f.calls.length, 0); }
});
test('migration reference seed exactly matches the shared geography-only initial snapshot', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20261021113304_eco_shared_location_knowledge.sql', import.meta.url), 'utf8');
  const literal = sql.match(/\$location_reference\$([\s\S]+?)\$location_reference\$/)?.[1]; assert.ok(literal); assert.deepEqual(JSON.parse(literal), initialLocationSnapshot());
});
test('mutations use fresh server actor and live session; exact committed retries never reapply', async () => {
  const f = fixture(), body = input(), first = await f.run(request('mutate', body)); assert.equal(first.status, 200); const expected = await first.json();
  assert.ok(expected.snapshot.locationCountries.some((country: { name: string }) => country.name === 'Synthetic Country'));
  const commit = f.calls.find(c => c.name === 'commit')!.value as any; assert.equal(commit.identity.actorId, user.id); assert.equal(commit.identity.sessionId, sessionId); assert.equal(commit.revision, user.revision);
  assert.equal(commit.snapshot.contributions.length, 0); assert.equal(commit.digest, null);
  const retry = await f.run(request('mutate', body)); assert.equal(retry.status, 200); assert.deepEqual(await retry.json(), expected); assert.equal(f.calls.filter(c => c.name === 'commit').length, 1);
});
test('writes reject preview, TEST, missing origin, foreign origin and unapproved transport before service commit', async () => {
  const f = fixture({ preview: true }); assert.equal((await f.run(request('mutate', input()))).status, 403); assert.equal(f.calls.length, 0);
  for (const patch of [{ dataMode: 'test' }, { actor: user }, { generation: randomUUID() }, { action: { type: 'save-enquiry', enquiry: {} } }]) { const f = fixture(); assert.ok([400,403].includes((await f.run(request('mutate', { ...input(), ...patch }))).status)); assert.equal(f.calls.length, 0); }
  for (const headers of [{ Origin: 'https://attacker.test' }, { Origin: '' }, { 'X-Eco-Request': '' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Content-Type': 'text/plain' }]) { const f = fixture(); assert.ok([403,415].includes((await f.run(request('mutate', input(), headers))).status)); assert.equal(f.calls.length, 0); }
  assert.equal((await fixture().run(request('mutate', input(), { Origin: config.deploymentOrigin! }))).status, 200);
});
test('stale revisions and domain no-change errors do not publish', async () => {
  const stale = fixture({ revision: 2 }); assert.equal((await stale.run(request('mutate', input()))).status, 409); assert.equal(stale.calls.filter(c => c.name === 'commit').length, 0);
  const f = fixture(), body = input(); body.action.name = 'Singapore'; const response = await f.run(request('mutate', body)); assert.equal(response.status, 400); assert.match(await response.text(), /already exists/); assert.equal(f.calls.filter(c => c.name === 'commit').length, 0);
});
test('legacy imports require real admin and attach deterministic provenance without a new award', async () => {
  const source = initialLocationSnapshot(); source.ports[0].summary = 'Synthetic historical information';
  const body = { requestId: randomUUID(), revision: 0, dataMode: 'live', snapshot: source };
  const denied = fixture(); assert.equal((await denied.run(request('migrate', body))).status, 403); assert.equal(denied.calls.length, 0);
  const f = fixture({ admin: true }), response = await f.run(request('migrate', body)); assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.snapshot.ports[0].summary, source.ports[0].summary); assert.equal(result.snapshot.contributions.length, 0);
  assert.equal(result.importedSources[0].digest, createHash('sha256').update(canonicalLocationSnapshotJson(source)).digest('hex')); assert.equal(result.importedSources[0].importedBy, user.id);
});
test('import conflicts are whole-batch and never replace shared records', async () => {
  const f = fixture({ admin: true, revision: 1 }); const base = initialLocationSnapshot(); base.ports[0].summary = 'Existing shared text';
  f.store.prepare = async () => ({ envelope: { revision: 1, snapshot: base, importedSources: [] }, actor: f.actor });
  const source = initialLocationSnapshot(); source.ports[0].summary = 'Conflicting browser text'; source.locationCountries.push({ id: 'Synthetic Country', name: 'Synthetic Country' });
  const response = await f.run(request('migrate', { requestId: randomUUID(), revision: 1, dataMode: 'live', snapshot: source })); assert.equal(response.status, 409); assert.match(await response.text(), /No information was imported/); assert.equal(f.calls.filter(c => c.name === 'commit').length, 0);
});
test('provider errors are sanitized, permission rechecks propagate, and malformed database snapshots fail closed', async () => {
  const f = fixture(); f.store.commit = async () => { throw new Error('SECRET provider response'); }; const response = await f.run(request('mutate', input())); assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /SECRET/);
  const revoked = fixture(); revoked.store.commit = async () => { throw new ApiError(401, 'Sign in again.'); }; assert.equal((await revoked.run(request('mutate', input()))).status, 401);
  assert.throws(() => locationEnvelope({ revision: 1, snapshot: { privateNotes: 'SECRET' }, importedSources: [] }), /unavailable/);
  assert.throws(() => locationInput({ ...input(), revision: -1 }, 'mutate')); assert.throws(() => locationInput({ ...input(), requestId: 'bad' }, 'mutate'));
});
test('unknown routes, query overrides and oversized body are rejected', async () => {
  for (const [req,status] of [[request('unknown'),404], [request('list?actor=other'),400], [new Request(`${config.origin}/api/location-knowledge/list`, { method:'DELETE' }),405], [request('mutate',{ ...input(), extra: 'x'.repeat(4_000_000) }),413]] as const) { const f=fixture(); assert.equal((await f.run(req)).status,status); assert.equal(f.calls.length,0); }
});
