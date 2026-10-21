import test from 'node:test';
import assert from 'node:assert/strict';
import { actorFromAccess } from '../src/lib/accessActor';
import { canTrade, isAdmin } from '../src/lib/model';
import type { AccessUser } from '../shared/access';
const user:AccessUser={id:'new-user',email:'person@example.test',displayName:'Person',officeId:'hk',officeName:'Hong Kong',
  isAdmin:false,isManager:false,isSpcTrader:false,isActive:true,activated:true,passwordChangeSuggested:true,revision:1};
test('administrator access does not remove the user’s normal trading identity',()=>{
  const actor=actorFromAccess({...user,isAdmin:true});
  assert.equal(canTrade(actor),true);assert.equal(isAdmin(actor),true);assert.equal(actor.id,user.id);
});
test('SPC Trader and Manager remain independent of administrator access',()=>{
  for(const flags of [{isSpcTrader:true},{isManager:true},{isSpcTrader:true,isManager:true}]){
    const actor=actorFromAccess({...user,...flags});assert.equal(isAdmin(actor),false);assert.equal(canTrade(actor),true);
    assert.equal(actor.officeId,'hk');
  }
});
