import test from 'node:test';
import assert from 'node:assert/strict';
import { resources } from '../server/access/catalog';
import { decideAccess, type AccessContext, type AccessRequest } from '../server/access/policy';

const now = Date.UTC(2026, 9, 13, 9);
function context(): AccessContext {
  return {
    expectedIssuer: 'https://identity.example.test', nowMs: now, maxIdentityAgeMs: 60_000,
    session: {
      membershipId: 'user-1', issuer: 'https://identity.example.test', subject: 'fcuno-subject-1',
      membershipRevision: 3, identityRevision: 2, credentialRevision: 4,
      authenticatedAtMs: now - 20_000, issuedAtMs: now - 10_000, expiresAtMs: now + 60_000, revokedAtMs: null,
    },
    membership: {
      id: 'user-1', issuer: 'https://identity.example.test', subject: 'fcuno-subject-1',
      active: true, revision: 3, officeId: 'office-1', administrator: false,
      grants: { enquiries: { permission: 'edit', scope: 'own' } },
    },
    identity: {
      issuer: 'https://identity.example.test', subject: 'fcuno-subject-1', active: true,
      revision: 2, credentialRevision: 4, revokedBeforeMs: 0, checkedAtMs: now - 1_000,
    },
  };
}
function request(): AccessRequest {
  return { resource: 'enquiries', action: 'edit', record: { ownerMembershipId: 'user-1', officeId: 'office-1' } };
}

test('the transition inventory retains all fourteen SPC capabilities without duplicate IDs', () => {
  assert.equal(resources.length, 14);
  assert.equal(new Set(resources.map(item => item.id)).size, 14);
  assert.equal(new Set(resources.map(item => item.spcId)).size, 14);
});

test('a current authenticated, explicitly granted owner may view and edit their enquiry', () => {
  assert.deepEqual(decideAccess(context(), request()), { allowed: true });
  assert.deepEqual(decideAccess(context(), { ...request(), action: 'view' }), { allowed: true });
});

const rejectedContexts: Array<[string, (value: AccessContext) => void]> = [
  ['missing session', value => { value.session = null; }],
  ['unprovisioned ECO user', value => { value.membership = null; }],
  ['missing identity state', value => { value.identity = null; }],
  ['disabled ECO membership', value => { value.membership!.active = false; }],
  ['disabled FCUNO identity', value => { value.identity!.active = false; }],
  ['expired session at exact boundary', value => { value.session!.expiresAtMs = now; }],
  ['revoked session', value => { value.session!.revokedAtMs = now - 1; }],
  ['missing explicit revocation state', value => { Object.assign(value.session!, { revokedAtMs: undefined }); }],
  ['stale membership after permission change', value => { value.membership!.revision += 1; }],
  ['stale identity revision', value => { value.identity!.revision += 1; }],
  ['credentials changed since login', value => { value.identity!.credentialRevision += 1; }],
  ['revocation at exact authentication time', value => { value.identity!.revokedBeforeMs = value.session!.authenticatedAtMs; }],
  ['old authentication concealed by new session issuance', value => { value.identity!.revokedBeforeMs = now - 15_000; }],
  ['session membership mismatch', value => { value.session!.membershipId = 'user-2'; }],
  ['session subject mismatch', value => { value.session!.subject = 'fcuno-subject-2'; }],
  ['identity subject mismatch', value => { value.identity!.subject = 'fcuno-subject-2'; }],
  ['wrong session issuer', value => { value.session!.issuer = 'https://other.example.test'; }],
  ['wrong membership issuer', value => { value.membership!.issuer = 'https://other.example.test'; }],
  ['wrong identity issuer', value => { value.identity!.issuer = 'https://other.example.test'; }],
  ['missing issuer configuration', value => { value.expectedIssuer = ''; }],
  ['expired identity freshness', value => { value.identity!.checkedAtMs = now - 60_001; }],
  ['future identity check', value => { value.identity!.checkedAtMs = now + 1; }],
  ['future session issuance', value => { value.session!.issuedAtMs = now + 1; }],
  ['authentication after session issuance', value => { value.session!.authenticatedAtMs = now; }],
  ['invalid expiration', value => { value.session!.expiresAtMs = NaN; }],
  ['invalid revocation boundary', value => { value.identity!.revokedBeforeMs = NaN; }],
  ['invalid authority clock', value => { value.nowMs = NaN; }],
  ['negative freshness window', value => { value.maxIdentityAgeMs = -1; }],
  ['invalid membership revision', value => { value.membership!.revision = 0; value.session!.membershipRevision = 0; }],
  ['invalid identity revision', value => { value.identity!.revision = 0; value.session!.identityRevision = 0; }],
  ['invalid credential revision', value => { value.identity!.credentialRevision = 0; value.session!.credentialRevision = 0; }],
];
for (const [name, mutate] of rejectedContexts) {
  test(`access fails closed: ${name}`, () => {
    const value = context(); mutate(value);
    assert.equal(decideAccess(value, request()).allowed, false);
  });
}

test('an identity exactly within the allowed freshness interval remains eligible', () => {
  const value = context(); value.identity!.checkedAtMs = now - value.maxIdentityAgeMs;
  assert.equal(decideAccess(value, request()).allowed, true);
});

test('no grants means no access, even for an administrator, across the entire catalogue', () => {
  const value = context(); value.membership!.administrator = true; value.membership!.grants = {};
  for (const resource of resources) for (const action of ['view', 'edit'] as const) {
    assert.equal(decideAccess(value, { resource: resource.id, action }).allowed, false);
  }
});

test('unknown resources, actions, permissions and scopes cannot grant access', () => {
  for (const resource of ['new-future-page', '__proto__', 'constructor', 'toString']) {
    assert.equal(decideAccess(context(), { ...request(), resource }).allowed, false);
  }
  assert.equal(decideAccess(context(), { ...request(), action: 'approve' } as unknown as AccessRequest).allowed, false);
  for (const grant of [{ permission: 'administrator', scope: 'all' }, { permission: 'edit', scope: 'everything' }]) {
    const value = context(); Object.assign(value.membership!.grants, { enquiries: grant });
    assert.equal(decideAccess(value, request()).allowed, false);
  }
  const inherited = context(); inherited.membership!.grants = Object.create({ enquiries: { permission: 'edit', scope: 'all' } });
  assert.equal(decideAccess(inherited, request()).allowed, false);
});

test('view permission cannot write; explicit none overrides access', () => {
  const value = context(); value.membership!.grants.enquiries!.permission = 'view';
  assert.equal(decideAccess(value, { ...request(), action: 'view' }).allowed, true);
  assert.equal(decideAccess(value, request()).allowed, false);
  value.membership!.grants.enquiries!.permission = 'none';
  assert.equal(decideAccess(value, { ...request(), action: 'view' }).allowed, false);
});

test('own scope rejects other owners and requests without server-loaded ownership', () => {
  assert.equal(decideAccess(context(), { ...request(), record: { ownerMembershipId: 'user-2', officeId: 'office-1' } }).allowed, false);
  assert.equal(decideAccess(context(), { resource: 'enquiries', action: 'view' }).allowed, false);
});

test('office scope requires both a current assigned office and matching record office', () => {
  const value = context(); value.membership!.grants.enquiries!.scope = 'office';
  assert.equal(decideAccess(value, { ...request(), record: { ownerMembershipId: 'user-2', officeId: 'office-1' } }).allowed, true);
  assert.equal(decideAccess(value, { ...request(), record: { ownerMembershipId: 'user-1', officeId: 'office-2' } }).allowed, false);
  assert.equal(decideAccess(value, { resource: 'enquiries', action: 'view' }).allowed, false);
  value.membership!.officeId = null;
  assert.equal(decideAccess(value, { ...request(), record: { ownerMembershipId: 'user-1', officeId: null } }).allowed, false);
});

test('user management requires both administrator designation and explicit global permission', () => {
  const value = context(); const manage: AccessRequest = { resource: 'user-management', action: 'edit' };
  value.membership!.grants['user-management'] = { permission: 'edit', scope: 'all' };
  assert.equal(decideAccess(value, manage).allowed, false);
  value.membership!.administrator = true;
  assert.equal(decideAccess(value, manage).allowed, true);
  value.membership!.grants['user-management']!.scope = 'own';
  assert.equal(decideAccess(value, { ...manage, record: request().record }).allowed, false);
});

test('audit history remains read-only even with an edit page grant', () => {
  const value = context(); value.membership!.grants['audit-log'] = { permission: 'edit', scope: 'all' };
  assert.equal(decideAccess(value, { resource: 'audit-log', action: 'view' }).allowed, true);
  assert.equal(decideAccess(value, { resource: 'audit-log', action: 'edit' }).allowed, false);
});
