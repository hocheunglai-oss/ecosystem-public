import { applyAction, type Company } from '../src/lib/model';
import { addAttachmentItems, deleteAttachmentItem, attachmentBlob } from '../src/lib/attachmentStorage';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AccessUser } from '../shared/access';
import { canUseTestWorkspace, canReadParserReports, createLiveState, parseTestWorkspacePolicy, purgeObsoleteTestWorkspaces, readWorkspaceState, workspaceNamespace } from '../src/lib/testWorkspace';
import { actorFromAccess } from '../src/lib/accessActor';
import { knowledgeDocument } from '../src/lib/knowledge';
import { actionableInboxItems, deserializeInbox, selectInboxMessage, type IncomingEnquiry } from '../src/inbox';
import { setWorkspaceDataMode, assertLiveDataWritable } from '../src/lib/testWorkspaceGuard';
import { extractKnowledge } from '../src/lib/knowledgeExtractionApi';
import { adminApi } from '../src/lib/adminApi';
import { supplierApi } from '../src/lib/supplierApi';
import { profileTabsApi } from '../src/lib/profileTabsApi';
const otto: AccessUser = { id: '10000000-0000-4000-8000-000000000001', email: 'owner@example.test', displayName: 'OWNER FIXTURE', officeId: 'HONG KONG', officeName: 'HONG KONG', isAdmin: true, isManager: false, isSpcTrader: true, isActive: true, activated: true, passwordChangeSuggested: false, revision: 1, capabilities: { appearancePreview: true, testWorkspace: true } };
const policy = { enabled: true, generation: '10000000-0000-4000-8000-000000000010' };

test('parser report TEST access uses the real session capability and valid generation; LIVE admin access is preserved', () => {
  assert.equal(canReadParserReports(otto,null,'test',policy.generation),true);
  const other={...otto,capabilities:undefined};
  assert.equal(canReadParserReports(other,null,'live'),true);
  assert.equal(canReadParserReports(other,null,'test',policy.generation),false);
  for(const generation of [undefined,'','../invalid'])assert.equal(canReadParserReports(otto,null,'test',generation),false);
  for(const user of [null,{...otto,isAdmin:false},{...otto,isActive:false},{...otto,activated:false}])for(const mode of ['live','test'] as const)assert.equal(canReadParserReports(user,null,mode,policy.generation),false);
  for(const mode of ['live','test'] as const)assert.equal(canReadParserReports(otto,{role:'admin',officeId:'HONG KONG',officeName:'HONG KONG',readOnly:true},mode,policy.generation),false);
});

test('fictional workspace requires the real active activated owner administrator with explicit capability and a valid policy', () => {
  assert.equal(canUseTestWorkspace(otto), true);
  for (const user of [null, { ...otto, isAdmin: false }, { ...otto, isActive: false }, { ...otto, activated: false }, { ...otto, capabilities: undefined }, { ...otto, capabilities: { appearancePreview: true, testWorkspace: false } }, { ...otto, capabilities: { appearancePreview: true, testWorkspace: 'true' } as never }]) {
    assert.equal(canUseTestWorkspace(user), false);
    assert.throws(() => readWorkspaceState(null, 'test', user, policy));
  }
  assert.throws(() => readWorkspaceState(null, 'test', otto, null));
  assert.throws(() => readWorkspaceState(null, 'test', otto, { ...policy, enabled: false }));
  assert.equal(parseTestWorkspacePolicy({ enabled: true, generation: '' }), null);
  assert.equal(parseTestWorkspacePolicy({ enabled: true, generation: '../old' }), null);
  assert.deepEqual(parseTestWorkspacePolicy({ enabled: false, generation: '' }), { enabled: false, generation: '' });
});

test('live state retains geographic references without commercial fixtures or implicit fictional knowledge', () => {
  const live = createLiveState();
  for (const key of ['companies', 'enquiries', 'requests', 'outcomes', 'contributions', 'audit', 'drops', 'goals', 'hats', 'creditHistory', 'creditNotifications'] as const) assert.deepEqual(live[key], [], key);
  assert.equal(live.ports.find(port => port.code === 'SGSIN')?.name, 'Singapore');
  assert.equal(live.ports.find(port => port.code === 'NLRTM')?.timezone, 'Europe/Amsterdam');
  for (const port of live.ports) {
    assert.deepEqual(port.notes, []); assert.equal(port.intelligenceKeyInfo, undefined);
    const doc = knowledgeDocument(live, { kind: 'port', id: port.id });
    assert.equal(doc.sections.some(section => section.blocks.length), false);
  }
  assert.deepEqual(readWorkspaceState('{broken', 'live', otto, null), live);
  const edited = createLiveState(); edited.ports[0].summary = 'REAL EDIT';
  assert.equal(readWorkspaceState(JSON.stringify(edited), 'live', otto, null).ports[0].summary, 'REAL EDIT');
});

test('test state projects fixture ownership to real ID and never changes live state', () => {
  const live = createLiveState(), before = JSON.stringify(live);
  const fictional = readWorkspaceState(null, 'test', otto, policy);
  assert.ok(fictional.companies.length > 0); assert.ok(fictional.enquiries.length > 0);
  assert.ok(fictional.enquiries.some(item => item.owner === otto.id));
  assert.equal(fictional.enquiries.some(item => item.owner === 'otto'), false);
  fictional.companies[0].notes = 'otto'; fictional.companies[0].aliases.push('otto');
  const restored = readWorkspaceState(JSON.stringify(fictional), 'test', otto, policy);
  assert.equal(restored.companies[0].notes, 'otto'); assert.ok(restored.companies[0].aliases.includes('otto'));
  assert.equal(restored.enquiries.some(item => item.owner === 'otto'), false);
  assert.equal(JSON.stringify(live), before);
  assert.notEqual(workspaceNamespace(otto.id, 'test', policy.generation), workspaceNamespace(otto.id));
  assert.notEqual(workspaceNamespace(otto.id), workspaceNamespace('another-real-id'));
  assert.throws(() => workspaceNamespace(otto.id, 'test'));
});

test('operator revocation and generation rotation purge owned test keys only, preserving legacy and live edits', () => {
  const live = `${workspaceNamespace(otto.id)}:state`, legacy = `ecosystem.prototype.v2:${otto.id}`;
  const current = `${workspaceNamespace(otto.id, 'test', policy.generation)}:state`;
  const old = `${workspaceNamespace(otto.id, 'test', 'old-generation')}:inbox`;
  const other = `${workspaceNamespace('someone-else', 'test', 'old-generation')}:state`;
  const map = new Map([live, legacy, current, old, other, 'ecosystem.inbox.v2'].map(key => [key, 'PRESERVED EDIT']));
  const storage = { get length() { return map.size; }, key: (index: number) => [...map.keys()][index] ?? null, getItem: (key: string) => map.get(key) ?? null, removeItem: (key: string) => { map.delete(key); } };
  purgeObsoleteTestWorkspaces(storage, otto.id, policy);
  assert.equal(map.has(old), false); assert.equal(map.has(current), true);
  purgeObsoleteTestWorkspaces(storage, otto.id, { enabled: false, generation: '' });
  assert.equal(map.has(current), false);
  for (const key of [live, legacy, other, 'ecosystem.inbox.v2']) assert.equal(map.get(key), 'PRESERVED EDIT');
});

test('real UUID inbox ownership works without accepting another account or a copied actor', () => {
  const message: IncomingEnquiry = { id: 'test1', providerMessageId: 'test1', channel: 'email', sender: 'sender@example.test', owner: otto.id, rawText: 'Vessel: TEST', receivedAt: '2026-10-15T12:00:00.000Z', read: false };
  const raw = JSON.stringify({ version: 2, items: [message] });
  const actor = actorFromAccess(otto);
  assert.deepEqual(deserializeInbox(raw, otto.id), [message]);
  assert.equal(deserializeInbox(raw, 'another-id'), null);
  assert.equal(actionableInboxItems([message], otto.id, actor).length, 1);
  assert.equal(actionableInboxItems([message], otto.id, { ...actor }).length, 0);
  assert.equal(selectInboxMessage([message], message.id, otto.id, actor).selected?.read, true);
});

test('TEST DATA blocks every shared API write before fetch while allowing read-only reference access', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async input => { calls.push(String(input)); return new Response(JSON.stringify({ items: [] }), { status: 200 }); };
  try {
    setWorkspaceDataMode('test');
    assert.throws(assertLiveDataWritable, /Switch to LIVE/);
    await assert.rejects(adminApi.createFeedback({} as never), /Switch to LIVE/);
    await assert.rejects(supplierApi.create({} as never), /Switch to LIVE/);
    await assert.rejects(supplierApi.update({} as never), /Switch to LIVE/);
    await assert.rejects(profileTabsApi.save({} as never), /Switch to LIVE/);
    await assert.rejects(extractKnowledge({ text: 'fictional', source: '', sourceDate: '', contextKey: '', locations: [] }, new AbortController().signal), /Switch to LIVE/);
    assert.equal(calls.length, 0);
    await assert.rejects(addAttachmentItems([]), /Switch to LIVE/);
    await assert.rejects(deleteAttachmentItem('existing-real-file'), /Switch to LIVE/);
    await assert.rejects(attachmentBlob('existing-real-file'), /Switch to LIVE/);
    assert.deepEqual(await profileTabsApi.list({ kind: 'buyer', id: 'company-meridian' }), { target: { kind: 'buyer', id: 'company-meridian' }, shared: { revision: 0, tabs: [] }, private: { revision: 0, tabs: [] } });
    assert.equal(calls.length, 0);
    await supplierApi.list(); assert.equal(calls.length, 1);
    setWorkspaceDataMode('live'); assert.doesNotThrow(assertLiveDataWritable);
  } finally { globalThis.fetch = originalFetch; setWorkspaceDataMode('live'); }
});


test('LIVE lead creation uses authenticated ownership and office without fictional credit recipients', () => {
  const live = createLiveState(), actor = actorFromAccess(otto);
  const company: Company = { id: 'new-real-local-company', name: 'OWNER ENTERED COMPANY', aliases: [], country: 'Singapore', city: '', contact: '', email: '', status: 'pending', limit: 0, exposure: 0, overdue: 0, terms: 'Pending review', reviewDate: '2026-10-15', sellingEntity: 'OWNER ENTERED SELLER', notes: '', personInChargeId: actor.id, office: 'SPOOFED OFFICE' };
  const action = { type: 'add-company' as const, company, requestedLimit: 10000, reason: 'REQUESTED REVIEW', workflow: 'p1' as const };
  const next = applyAction(live, action, actor);
  assert.equal(next.companies[0].personInChargeId, otto.id);
  assert.equal(next.companies[0].office, otto.officeName);
  assert.equal(next.companies[0].sellingEntity, 'OWNER ENTERED SELLER');
  assert.throws(() => applyAction(live, { ...action, company: { ...company, sellingEntity: '' } }, actor), /Selling entity/);
  assert.equal(next.requests[0].requestedBy, otto.id);
  assert.deepEqual(next.requests[0].recipients?.map(item => item.actorId), [otto.id]);
  assert.ok(next.creditNotifications?.every(item => item.recipientId === otto.id));
  assert.throws(() => applyAction(live, { ...action, company: { ...company, personInChargeId: 'otto' } }, actor), /valid person in charge/);
  assert.throws(() => applyAction(live, { ...action, company: { ...company, personInChargeId: 'another-real-user' } }, actor), /valid person in charge/);
  assert.throws(() => applyAction(live, action, { ...actor }), /valid demo role/);
});
