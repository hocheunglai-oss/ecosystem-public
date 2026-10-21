import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSpcRoster, type SpcRosterRow } from '../server/access/spcRoster';
const row=(id:string, admin=false):SpcRosterRow=>({id,username:`${id}@example.test`,display_name:id,role:'buyer_trader',is_active:true,
  assigned_roles:admin?[{role:'ADMIN'}]:[],profiles:[{office:'Hong Kong',isSupplierTrader:false}]});
const none={demoteIds:[],excludeIds:[],managerIds:[]};
test('office grouping and independent flags preserve approved admin overrides without transferring credentials',()=>{
  const source=[row('a',true),row('b',true),row('c')]; source[1].profiles[0].isSupplierTrader=true;
  const result=prepareSpcRoster(source,{...none,demoteIds:['b'],managerIds:['c']});
  assert.equal(result.offices.length,1);assert.equal(result.users[0].isAdmin,true);
  assert.equal(result.users[1].isAdmin,false);assert.equal(result.users[1].isSpcTrader,true);
  assert.equal(result.users[2].isManager,true);assert.equal(result.users[2].isAdmin,false);
  assert.ok(result.users.every(user=>!('password' in user)&&!('password_hash' in user)));
});
test('test accounts are excluded only by explicit source ID, never by a guessed display name',()=>{
  const source=[row('admin',true),row('security',true),row('test')];
  assert.equal(prepareSpcRoster(source,none).users.length,3);
  assert.equal(prepareSpcRoster(source,{...none,excludeIds:['test']}).users.length,2);
});
test('missing offices, duplicate emails, unknown decisions and loss of all administrators block migration',()=>{
  const admin=row('admin',true),missing=row('missing');missing.profiles=[];
  assert.throws(()=>prepareSpcRoster([admin,missing],none));
  assert.throws(()=>prepareSpcRoster([admin,{...row('other'),username:admin.username}],none));
  assert.throws(()=>prepareSpcRoster([admin],{...none,demoteIds:['unknown']}));
  assert.throws(()=>prepareSpcRoster([admin],{...none,demoteIds:['admin']}));
});
