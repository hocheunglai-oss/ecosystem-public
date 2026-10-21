import test from 'node:test';
import assert from 'node:assert/strict';
import { personPreviewOptions, selectedPreviewPerson } from '../shared/personPreview';
import { projectPreviewUser } from '../shared/rolePreview';
import type { AccessUser } from '../shared/access';

const admin: AccessUser = { id:'admin', email:'Admin@example.test', displayName:'ADMIN', phone:'+85200000001', officeId:'HK', officeName:'Hong Kong', isAdmin:true,isManager:false,isSpcTrader:false,isActive:true,activated:true,passwordChangeSuggested:false,revision:1 };
const person = { ...admin,id:'person',displayName:'Vincent',email:'Vincent@example.test',isAdmin:false,isManager:true,officeId:'SG',officeName:'Singapore' };
test('person preview options expose only presentation fields from active directory entries and labelled fictional choices',()=>{
  const options=personPreviewOptions([admin,person,{...person,id:'inactive',isActive:false},{...person,id:'pending',activated:false}],admin);
  assert.deepEqual(options.map(option=>option.id),['person','preview-user','gianmichele']);
  assert.deepEqual(options[0],{id:'person',name:'Vincent',fictional:false,officeId:'SG',role:'manager'});
  assert.ok(options.slice(1).every(option=>option.fictional));
  assert.doesNotMatch(JSON.stringify(options),/email|phone|password|capabilities/);
});
test('unknown or forged target IDs are rejected and selection cannot change cached options',()=>{
  const options=personPreviewOptions([person],admin);
  assert.throws(()=>selectedPreviewPerson(options,'unknown'),/available user/);
  const selected=selectedPreviewPerson(options,'person');selected.role='admin';
  assert.equal(options[0].role,'manager');
});
test('selecting another person changes only a read-only role projection, never identity or private ownership',()=>{
  const selected=selectedPreviewPerson(personPreviewOptions([person],admin),'person');
  const projected=projectPreviewUser(admin,{role:selected.role,officeId:selected.officeId,officeName:'Singapore',readOnly:true});
  assert.equal(projected.id,admin.id);assert.equal(projected.email,admin.email);assert.equal(projected.displayName,admin.displayName);
  assert.equal(projected.isAdmin,false);assert.equal(projected.isManager,true);assert.equal(projected.officeId,'SG');
  assert.equal(admin.officeId,'HK');
});
test('non-administrators, suspended and unactivated accounts receive no person options',()=>{
  for(const extra of [{isAdmin:false},{isActive:false},{activated:false}]) assert.deepEqual(personPreviewOptions([person],{...admin,...extra}),[]);
});
