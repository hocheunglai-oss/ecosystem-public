import test from 'node:test';
import assert from 'node:assert/strict';
import { actors, applyAction, personalResources } from '../src/lib/model';
import { createSeedState, upgradeDemoState } from '../src/lib/seed';
import { buyerGroupKey, buyerPrivateRemark } from '../src/lib/buyerProfile';
import { buyerPrivateEntries, buyerTeamEntries, buyerSharedDraft } from '../src/lib/buyerSharedLists';
const owner=actors.find(actor=>actor.id==='otto')!, other=actors.find(actor=>actor.id==='filippo')!;
const at='2026-10-09T09:00:00Z', later='2026-10-09T09:30:00Z', buyerId='company-meridian';

test('private list migrates the existing note, supports editing/removing, survives reload and stays owner-scoped without shared records or rewards',()=>{
  let state=createSeedState();
  state.buyerPrivateRemarks={ [JSON.stringify([owner.id,buyerId])]:{owner:owner.id,buyerId,text:'Existing private note',updatedAt:at} }; // Persisted single-note fixture from the retired editor.
  const legacy=buyerPrivateEntries(state,buyerId,owner.id), audit=structuredClone(state.audit), contributions=structuredClone(state.contributions), gold=personalResources(state,owner.id).gold;
  assert.equal(legacy[0].text,'Existing private note');
  state=applyAction(state,{type:'save-buyer-private-list',buyerId,baseEntries:buyerSharedDraft(legacy),entries:[{id:legacy[0].id,text:'Updated private note'},{id:'second',text:'A second private note'}]},owner,later);
  let current=buyerPrivateEntries(state,buyerId,owner.id);
  assert.equal(current[0].createdAt,at);assert.equal(current[0].updatedAt,later);
  assert.equal(buyerPrivateEntries(state,buyerId,other.id).length,0);
  assert.equal(buyerPrivateEntries(state,'company-bluewater',owner.id).length,0);
  assert.equal(personalResources(state,owner.id).gold,gold);
  assert.deepEqual(state.audit,audit);assert.deepEqual(state.contributions,contributions);
  state=upgradeDemoState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(buyerPrivateEntries(state,buyerId,owner.id),current);
  assert.match(buyerPrivateRemark(state,buyerId,owner.id),/second private note/);
  assert.throws(()=>applyAction(state,{type:'save-buyer-private-list',buyerId,baseEntries:buyerSharedDraft(legacy),entries:[]},owner,later),/list changed/);
  assert.throws(()=>applyAction(state,{type:'save-buyer-private-list',buyerId,baseEntries:buyerSharedDraft(current),entries:[{id:'1',text:'a'},{id:'2',text:' A '}]},owner,later),/duplicate/);
  state=applyAction(state,{type:'save-buyer-private-list',buyerId,baseEntries:buyerSharedDraft(current),entries:[]},owner,later);
  assert.deepEqual(buyerPrivateEntries(state,buyerId,owner.id),[]);
  assert.equal(buyerPrivateRemark(state,buyerId,owner.id),'');
});

test('Team Remarks preserve legacy group notes and new edits are shared between staff for the selected buyer only',()=>{
  let state=createSeedState();const buyer=state.companies.find(item=>item.id===buyerId)!;
  const sibling=state.companies.find(item=>item.id!==buyer.id&&buyerGroupKey(item)===buyerGroupKey(buyer))!;
  state=applyAction(state,{type:'save-buyer-shared-list',kind:'group',buyerId,baseEntries:[],entries:[{id:'legacy',text:'A pre-existing group note'}]},owner,at);
  const legacy=buyerTeamEntries(state,buyer),gold=personalResources(state,other.id).gold;
  assert.equal(legacy[0].text,'A pre-existing group note');
  state=applyAction(state,{type:'save-buyer-shared-list',kind:'team',buyerId,baseEntries:buyerSharedDraft(legacy),entries:[{id:'legacy',text:'Updated team note for this buyer'}]},other,later);
  assert.equal(buyerTeamEntries(state,buyer)[0].text,'Updated team note for this buyer');
  assert.equal(buyerTeamEntries(state,sibling)[0].text,'A pre-existing group note');
  assert.equal(personalResources(state,other.id).gold,gold+1);
  state=upgradeDemoState(JSON.parse(JSON.stringify(state)));
  const current=buyerTeamEntries(state,buyer);
  state=applyAction(state,{type:'save-buyer-shared-list',kind:'team',buyerId,baseEntries:buyerSharedDraft(current),entries:[]},owner,later);
  assert.deepEqual(buyerTeamEntries(state,buyer),[],'Clearing does not resurrect legacy notes');
  assert.equal(buyerTeamEntries(state,sibling).length,1);
});
