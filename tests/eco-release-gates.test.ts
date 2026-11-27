import test from 'node:test';
import assert from 'node:assert/strict';
import { canUseBuyerCredit, ECO_2_RELEASE_NOTICE, isBuyerCreditWorkspace, isBuyerCreditModal } from '../shared/ecoRelease';
import { projectPreviewUser } from '../shared/rolePreview';
import type { AccessUser, RolePreview, PreviewRole } from '../shared/access';
import { createSeedState } from '../src/lib/seed';
import { globalSearchRecords, queryGlobalSearch } from '../src/lib/globalSearch';
import { actorFromAccess } from '../src/lib/accessActor';
const admin: AccessUser = { id: 'release-admin', email: 'release@example.test', displayName: 'ADMIN', officeId: 'HONG KONG', officeName: 'HONG KONG', isAdmin: true, isManager: false, isSpcTrader: true, isActive: true, activated: true, passwordChangeSuggested: false, revision: 1, capabilities: { appearancePreview: false, testWorkspace: true } };
const preview = (role: PreviewRole): RolePreview => ({ role, officeId: role === 'credit' ? 'CREDIT' : 'HONG KONG', officeName: role === 'credit' ? 'CREDIT' : 'HONG KONG', readOnly: true });

test('buyer and credit availability requires the staging administrator in developer mode', () => {
  assert.equal(ECO_2_RELEASE_NOTICE, 'COMING IN ECO 2.0');
  assert.equal(canUseBuyerCredit(admin), false);
  assert.equal(canUseBuyerCredit(admin, null, true), true);
  assert.equal(canUseBuyerCredit({ ...admin, capabilities: undefined }, null, true), false);
  for (const role of ['admin', 'trader', 'spc-trader', 'manager', 'credit'] as const) {
    const selected = preview(role), effective = projectPreviewUser(admin, selected);
    assert.equal(canUseBuyerCredit(effective, selected, true), false, role);
    assert.equal(canUseBuyerCredit(admin, selected, true), false, `real administrator cannot bypass ${role} preview`);
    assert.equal(canUseBuyerCredit(effective), false, `ordinary ${role} account`);
  }
  assert.equal(canUseBuyerCredit({ ...admin, isActive: false }, null, true), false);
  assert.equal(canUseBuyerCredit({ ...admin, activated: false }, null, true), false);
  assert.equal(canUseBuyerCredit(null), false);
});

test('workspace and contextual modal entry points share the buyer/credit release classification', () => {
  for (const id of ['counterparties', 'credit-request']) assert.equal(isBuyerCreditWorkspace(id), true);
  for (const id of ['enquiry', 'fixtures', 'lost', 'suppliers', 'ports', 'settings']) assert.equal(isBuyerCreditWorkspace(id), false);
  for (const type of ['credit', 'decision', 'company']) assert.equal(isBuyerCreditModal({ type }), true);
  for (const type of ['outcome', 'enquiry-detail', 'feedback']) assert.equal(isBuyerCreditModal({ type }), false);
});

test('non-admin search cannot expose buyer directory results; operational records remain searchable', () => {
  const state = createSeedState();
  for (const role of ['trader', 'spc-trader', 'manager', 'credit'] as const) {
    const selected = preview(role), user = projectPreviewUser(admin, selected), actor = actorFromAccess(user);
    const records = globalSearchRecords(state, actor, [], [], canUseBuyerCredit(user, selected));
    assert.equal(records.some(item => item.category === 'Buyer' || item.workspace === 'counterparties'), false);
    assert.equal(queryGlobalSearch(records, 'ECO20001').length, 0);
    assert.equal(queryGlobalSearch(records, 'sgsin')[0]?.context?.portId, 'port-singapore');
    assert.equal(queryGlobalSearch(records, 'jptyo').length, 0);
  }
  const adminResults = globalSearchRecords(state, actorFromAccess(admin), [], [], canUseBuyerCredit(admin, null, true));
  assert.equal(queryGlobalSearch(adminResults, 'ECO20001')[0].category, 'Buyer');
  assert.equal(globalSearchRecords(state, actorFromAccess(admin), []).some(item => item.category === 'Buyer'), false, 'search fails closed unless release access is supplied');
});

test('local mutation boundary rejects deferred buyer actions without disabling ordinary enquiry work', async () => {
  const { assertReleaseActionAvailable, isBuyerCreditAction } = await import('../src/lib/ecoRelease');
  const state = createSeedState(), trader = { ...admin, isAdmin: false };
  const actions = [
    { type: 'save-buyer-credit-remarks', buyerId: 'company-meridian', text: 'Changed' },
    { type: 'save-buyer-private-list', buyerId: 'company-meridian', baseEntries: [], entries: [{ id: 'private', text: 'Changed' }] },
    { type: 'mark-credit-request-read', id: 'request-existing' },
    { type: 'acknowledge-credit', id: 'request-existing' },
    { type: 'submit-contribution', targetType: 'company', targetId: 'company-meridian', title: 'Changed', body: 'Changed' },
  ] as const;
  const before = JSON.stringify(state);
  for (const action of actions) {
    assert.throws(() => assertReleaseActionAvailable(action, state, trader, true), { message: ECO_2_RELEASE_NOTICE });
    assert.throws(() => assertReleaseActionAvailable(action, state, admin, false), { message: ECO_2_RELEASE_NOTICE });
    assert.doesNotThrow(() => assertReleaseActionAvailable(action, state, admin, true));
  }
  assert.equal(JSON.stringify(state), before);
  for (const action of [{ type: 'confirm-enquiry', id: 'enquiry-existing' }, { type: 'record-loss', id: 'enquiry-existing', reasonId: 'loss-existing' }, { type: 'submit-contribution', targetType: 'port', targetId: 'port-tokyo', title: 'Changed', body: 'Changed' }] as const) {
    assert.equal(isBuyerCreditAction(action, state), false);
    assert.doesNotThrow(() => assertReleaseActionAvailable(action, state, trader, false));
  }
});
