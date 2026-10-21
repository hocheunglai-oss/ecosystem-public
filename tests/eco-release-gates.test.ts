import test from 'node:test';
import assert from 'node:assert/strict';
import { canUseBuyerCredit, ECO_2_RELEASE_NOTICE, isBuyerCreditWorkspace, isBuyerCreditModal } from '../shared/ecoRelease';
import { projectPreviewUser } from '../shared/rolePreview';
import type { AccessUser, RolePreview, PreviewRole } from '../shared/access';
import { createSeedState } from '../src/lib/seed';
import { globalSearchRecords, queryGlobalSearch } from '../src/lib/globalSearch';
import { actorFromAccess } from '../src/lib/accessActor';
const admin: AccessUser = { id: 'release-admin', email: 'release@example.test', displayName: 'ADMIN', officeId: 'HONG KONG', officeName: 'HONG KONG', isAdmin: true, isManager: false, isSpcTrader: false, isActive: true, activated: true, passwordChangeSuggested: false, revision: 1 };
const preview = (role: PreviewRole): RolePreview => ({ role, officeId: role === 'credit' ? 'CREDIT' : 'HONG KONG', officeName: role === 'credit' ? 'CREDIT' : 'HONG KONG', readOnly: true });

test('ECO 1.0 buyer and credit availability follows active administrator access and effective preview role', () => {
  assert.equal(ECO_2_RELEASE_NOTICE, 'UNDER CONSTRUCTION: TO BE RELEASED WITH ECO 2.0');
  assert.equal(canUseBuyerCredit(admin), true);
  assert.equal(canUseBuyerCredit(projectPreviewUser(admin, preview('admin')), preview('admin')), true);
  for (const role of ['trader', 'spc-trader', 'manager', 'credit'] as const) {
    const selected = preview(role), effective = projectPreviewUser(admin, selected);
    assert.equal(canUseBuyerCredit(effective, selected), false, role);
    assert.equal(canUseBuyerCredit(admin, selected), false, `real administrator cannot bypass ${role} preview`);
    assert.equal(canUseBuyerCredit(effective), false, `ordinary ${role} account`);
  }
  assert.equal(canUseBuyerCredit({ ...admin, isActive: false }), false);
  assert.equal(canUseBuyerCredit({ ...admin, activated: false }), false);
  assert.equal(canUseBuyerCredit(null), false);
});

test('workspace and contextual modal entry points share the buyer/credit release classification', () => {
  for (const id of ['counterparties', 'credit-request']) assert.equal(isBuyerCreditWorkspace(id), true);
  for (const id of ['enquiry', 'fixtures', 'lost', 'suppliers', 'ports', 'settings']) assert.equal(isBuyerCreditWorkspace(id), false);
  for (const type of ['credit', 'decision', 'company']) assert.equal(isBuyerCreditModal({ type }), true);
  for (const targetType of ['company', 'buyer-group', 'buyer-team', 'buyer-competition']) assert.equal(isBuyerCreditModal({ type: 'contribute', targetType }), true);
  for (const spec of [{ type: 'outcome' }, { type: 'enquiry-detail' }, { type: 'contribute', targetType: 'port' }, { type: 'contribute', targetType: 'feedback' }]) assert.equal(isBuyerCreditModal(spec), false);
});

test('non-admin search cannot expose buyer directory results; operational records remain searchable', () => {
  const state = createSeedState();
  for (const role of ['trader', 'spc-trader', 'manager', 'credit'] as const) {
    const selected = preview(role), user = projectPreviewUser(admin, selected), actor = actorFromAccess(user);
    const records = globalSearchRecords(state, actor, [], [], canUseBuyerCredit(user, selected));
    assert.equal(records.some(item => item.category === 'Buyer' || item.workspace === 'counterparties'), false);
    assert.equal(queryGlobalSearch(records, 'ECO20001').length, 0);
    assert.equal(queryGlobalSearch(records, 'jptyo')[0]?.context?.portId, 'port-tokyo');
  }
  const adminResults = globalSearchRecords(state, actorFromAccess(admin), [], [], canUseBuyerCredit(admin));
  assert.equal(queryGlobalSearch(adminResults, 'ECO20001')[0].category, 'Buyer');
  assert.equal(globalSearchRecords(state, actorFromAccess(admin), []).some(item => item.category === 'Buyer'), false, 'search fails closed unless release access is supplied');
});

test('local mutation boundary rejects deferred buyer actions without disabling ordinary enquiry work', async () => {
  const { assertReleaseActionAvailable, isBuyerCreditAction } = await import('../src/lib/ecoRelease');
  const state = createSeedState(), trader = { ...admin, isAdmin: false };
  const actions = [
    { type: 'save-buyer-credit-remarks', buyerId: 'company-meridian', text: 'Changed' },
    { type: 'save-buyer-private-remark', buyerId: 'company-meridian', text: 'Changed' },
    { type: 'mark-credit-request-read', id: 'request-existing' },
    { type: 'acknowledge-credit', id: 'request-existing' },
    { type: 'submit-contribution', targetType: 'company', targetId: 'company-meridian', title: 'Changed', body: 'Changed' },
  ] as const;
  const before = JSON.stringify(state);
  for (const action of actions) {
    assert.throws(() => assertReleaseActionAvailable(action, state, trader), { message: ECO_2_RELEASE_NOTICE });
    assert.doesNotThrow(() => assertReleaseActionAvailable(action, state, admin));
  }
  assert.equal(JSON.stringify(state), before);
  for (const action of [{ type: 'confirm-enquiry', id: 'enquiry-existing' }, { type: 'record-loss', id: 'enquiry-existing', reasonId: 'loss-existing' }, { type: 'submit-contribution', targetType: 'port', targetId: 'port-tokyo', title: 'Changed', body: 'Changed' }] as const) {
    assert.equal(isBuyerCreditAction(action, state), false);
    assert.doesNotThrow(() => assertReleaseActionAvailable(action, state, trader));
  }
});
