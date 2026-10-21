import test from 'node:test';
import assert from 'node:assert/strict';
import { canPreviewAppearance } from '../shared/appearancePreview';
import { projectPreviewUser } from '../shared/rolePreview';
import type { AccessUser } from '../shared/access';
const owner: AccessUser = {id:'owner-fixture',email:'owner@example.test',displayName:'Owner Fixture',officeId:'hk',officeName:'Hong Kong',isAdmin:true,isManager:false,isSpcTrader:false,isActive:true,activated:true,passwordChangeSuggested:false,revision:1,capabilities:{appearancePreview:true,testWorkspace:true}};
test('appearance previews require the real active administrator and explicit server capability',()=>{
  assert.equal(canPreviewAppearance(owner),true);
  assert.equal(canPreviewAppearance({...owner,email:'changed@example.test'}),true,'Email is not the authority.');
  for(const user of [null,undefined,{...owner,capabilities:undefined},{...owner,capabilities:{appearancePreview:false,testWorkspace:true}}, {...owner,capabilities:{appearancePreview:'true',testWorkspace:true} as never}, {...owner,isAdmin:false}, {...owner,isActive:false},{...owner,activated:false}]) assert.equal(canPreviewAppearance(user),false);
});
test('VIEW AS projections never carry owner capabilities; the real session remains unchanged',()=>{
  for(const role of ['admin','trader','spc-trader','manager','credit'] as const) {
    const projected=projectPreviewUser(owner,{role,officeId:role==='credit'?'CREDIT':'hk',officeName:role==='credit'?'Credit':'Hong Kong',readOnly:true});
    assert.deepEqual(projected.capabilities,{appearancePreview:false,testWorkspace:false});
    assert.equal(canPreviewAppearance(projected),false);
  }
  assert.equal(canPreviewAppearance(owner),true);
  assert.equal(projectPreviewUser(owner,null),owner);
});
