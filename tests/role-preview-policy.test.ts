import test from 'node:test';
import assert from 'node:assert/strict';
import type { AccessUser, RolePreview, PreviewRole } from '../shared/access';
import { projectPreviewUser } from '../shared/rolePreview';
import { actorFromAccess } from '../src/lib/accessActor';
import { canTrade, isAdmin } from '../src/lib/model';
import { setPreviewReadOnly, assertPreviewWritable } from '../src/lib/previewGuard';
import { extractKnowledge } from '../src/lib/knowledgeExtractionApi';

const administrator: AccessUser = Object.freeze({
  id: '11111111-1111-4111-8111-111111111111', email: 'Administrator@example.test',
  displayName: 'VERIFIED ADMINISTRATOR', phone: '+85200000001',
  officeId: 'HONG KONG', officeName: 'HONG KONG',
  isAdmin: true, isManager: true, isSpcTrader: true,
  isActive: true, activated: true, passwordChangeSuggested: true, revision: 17,
});
const preview = (role: PreviewRole, officeId = 'SINGAPORE'): RolePreview => ({
  role, officeId, officeName: officeId, readOnly: true,
});

test('ending preview restores the unchanged authoritative user', () => {
  assert.equal(projectPreviewUser(administrator, null), administrator);
  projectPreviewUser(administrator, preview('trader'));
  assert.equal(administrator.officeId, 'HONG KONG');
  assert.equal(administrator.isAdmin, true);
  assert.equal(administrator.isManager, true);
  assert.equal(administrator.isSpcTrader, true);
  assert.equal(projectPreviewUser(administrator, null), administrator);
});

test('preview preserves verified identity, contact and credential state despite extra input properties', () => {
  const selection = Object.freeze({ ...preview('manager'), id: 'forged-person', email: 'other@example.test',
    displayName: 'ANOTHER PERSON', phone: '+39000000002', revision: 999,
    activated: false, passwordChangeSuggested: false });
  const result = projectPreviewUser(administrator, selection);
  for (const key of ['id', 'email', 'displayName', 'phone', 'revision', 'activated', 'isActive', 'passwordChangeSuggested'] as const) {
    assert.equal(result[key], administrator[key], `${key} must remain authoritative`);
  }
  assert.equal(result.officeId, 'SINGAPORE');
  assert.equal(selection.id, 'forged-person');
});

test('reduced presets cannot inherit the administrator’s other permission flags', () => {
  for (const role of ['admin', 'trader', 'spc-trader', 'manager', 'credit'] as const) {
    const result = projectPreviewUser(administrator, preview(role, role === 'credit' ? 'CREDIT' : 'SINGAPORE'));
    assert.deepEqual([result.isAdmin, result.isManager, result.isSpcTrader],
      [role === 'admin', role === 'manager', role === 'spc-trader'], role);
    assert.equal(result.id, administrator.id);
  }
});

test('CREDIT previews an ordinary trader in CREDIT office, without legacy credit approval authority', () => {
  const result = projectPreviewUser(administrator, preview('credit', 'CREDIT'));
  const actor = actorFromAccess(result);
  assert.equal(result.officeId, 'CREDIT');
  assert.equal(actor.role, 'trader');
  assert.equal(canTrade(actor), true);
  assert.equal(isAdmin(actor), false);
  assert.equal(actor.isManager, false);
  assert.equal(actor.isSpcTrader, false);
  assert.equal(actor.id, administrator.id);
});

test('a stale preview cannot restore authority after demotion, suspension or removal of activation', () => {
  for (const state of [{ isAdmin: false }, { isActive: false }, { activated: false }]) {
    const latest = { ...administrator, ...state, revision: administrator.revision + 1 };
    assert.throws(() => projectPreviewUser(latest, preview('admin')), /Invalid role preview/);
    assert.equal(projectPreviewUser(latest, null), latest);
  }
});

test('malformed or writable preview selections fail closed at the shared projection boundary', () => {
  for (const selection of [
    { ...preview('admin'), readOnly: false },
    { ...preview('admin'), role: 'super-admin' },
    { ...preview('manager'), officeId: '' },
    { ...preview('manager'), officeName: '' },
    preview('credit', 'SINGAPORE'),
  ]) {
    assert.throws(() => projectPreviewUser(administrator, selection as RolePreview), /Invalid role preview/);
  }
});

test('preview blocks external extraction before any network request and releases its local write guard on exit', async () => {
  const fetchBefore = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('Unexpected network request'); };
  try {
    setPreviewReadOnly(true);
    assert.throws(assertPreviewWritable, /READ ONLY/);
    await assert.rejects(extractKnowledge({ text: 'Synthetic source', source: '', sourceDate: '', contextKey: '', locations: [] }, new AbortController().signal), /READ ONLY/);
    assert.equal(requests, 0);
    setPreviewReadOnly(false);
    assert.doesNotThrow(assertPreviewWritable);
  } finally { setPreviewReadOnly(false); globalThis.fetch = fetchBefore; }
});
