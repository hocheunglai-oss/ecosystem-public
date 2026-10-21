import test from 'node:test';
import assert from 'node:assert/strict';
import {verificationMode, deploymentIdentity, mergeDeploymentMetadata, buildLogFingerprint, validateManifest, directoryPhoneAssignments, verifyDirectoryReassignment, verifySource} from '../scripts/verify-whatsapp-intake.mjs';
import {ecoConnections} from '../config/ecoConnections.ts';

test('disabled verification cannot enable cloud mutations or cleanup and ordinary runs keep explicit authorization',()=>{
 assert.equal(verificationMode(['--disabled-preflight']),'disabled-preflight');
 assert.equal(verificationMode(['--allow-cloud-mutations']),'active');
 assert.equal(verificationMode(['--allow-cloud-mutations','--cleanup-only','/private/tmp/owned-recovery.private.json']),'cleanup');
 for(const args of [[],['--cleanup-only','/private/tmp/owned.json'],['--disabled-preflight','--allow-cloud-mutations'],['--disabled-preflight','--cleanup-only','/private/tmp/owned.json'],['--allow-cloud-mutations','--cleanup-only','relative.json'],['--disabled-preflight','--disabled-preflight'],['--unknown']])assert.throws(()=>verificationMode(args));
});
test('deployment evidence requires exact immutable target, production configuration and source metadata',()=>{
 const expected={base:'https://ecosystem-synthetic.vercel.app',deploymentId:'dpl_synthetic',commit:'a'.repeat(40)};
 const deployment={id:expected.deploymentId,url:new URL(expected.base).hostname,readyState:'READY',name:ecoConnections.vercel.projectName,target:'production',meta:{githubCommitSha:expected.commit,githubCommitOrg:ecoConnections.githubRepository.split('/')[0],githubCommitRepo:ecoConnections.githubRepository.split('/')[1]},builds:[{output:[{digest:`${ecoConnections.vercel.projectId}/api.js`}]}]};
 assert.equal(deploymentIdentity(deployment,expected).commit,expected.commit);
 for(const patch of [{id:'dpl_other'},{url:'other.vercel.app'},{readyState:'BUILDING'},{name:'other'},{target:'preview'},{meta:{}},{meta:{...deployment.meta,githubCommitSha:'b'.repeat(40)}},{meta:{...deployment.meta,githubCommitRepo:'bunker-map'}},{gitSource:{sha:'b'.repeat(40)}},{builds:[{output:[{digest:'other/api.js'}]}]}])assert.throws(()=>deploymentIdentity({...deployment,...patch},expected));
});
test('build log fingerprint must include matching generation and completed verification',()=>{
 const hash='a'.repeat(64),id=`eco-${hash.slice(0,16)}`;
 const logs=`Generated system information ${id}: 12 installed dependencies, 3 migrations.\nVerified system information ${id}.`;
 assert.equal(buildLogFingerprint(logs,hash),id);
 for(const invalid of ['',`Generated system information ${id}: 12 dependencies.`, `Verified system information ${id}.\nVerified system information ${id}.`,logs.replaceAll(id,'eco-'+'b'.repeat(16)),logs+'\nGenerated system information eco-'+'b'.repeat(16)+': 12 dependencies.'])assert.throws(()=>buildLogFingerprint(invalid,hash));
});

test('compact CLI deployment projection requires authoritative raw metadata with matching ownership',()=>{
 const expected={base:'https://ecosystem-synthetic.vercel.app',deploymentId:'dpl_synthetic',commit:'a'.repeat(40)};
 const compact={id:expected.deploymentId,name:ecoConnections.vercel.projectName,url:new URL(expected.base).hostname,target:'production',readyState:'READY',createdAt:1,duration:1,buildMachine:{},aliases:[],builds:[{output:[{digest:`${ecoConnections.vercel.projectId}/api.js`}]}],routes:[],contextName:'team'};
 const raw={id:compact.id,url:compact.url,name:compact.name,target:compact.target,readyState:compact.readyState,projectId:ecoConnections.vercel.projectId,ownerId:ecoConnections.vercel.teamId,team:{id:ecoConnections.vercel.teamId},meta:{githubCommitSha:expected.commit,githubCommitOrg:ecoConnections.githubRepository.split('/')[0],githubCommitRepo:ecoConnections.githubRepository.split('/')[1]},env:['UNRELATED_SYNTHETIC_VALUE']};
 assert.throws(()=>deploymentIdentity(compact,expected));
 const merged=mergeDeploymentMetadata(compact,raw,expected);
 assert.equal(deploymentIdentity(merged,expected).commit,expected.commit);
 assert.equal(merged.builds,compact.builds); assert.equal('env' in merged,false);
 for(const patch of [{id:'dpl_other'},{url:'other.vercel.app'},{projectId:'prj_other'},{team:{id:'team_other'}},{team:undefined},{ownerId:'team_other'},{project:{id:'prj_other'}},{name:'other'},{target:'preview'},{readyState:'BUILDING'}])assert.throws(()=>mergeDeploymentMetadata(compact,{...raw,...patch},expected));
 // A misleading compact response cannot replace missing or mismatched raw commit metadata.
 for(const meta of [undefined,{}, {...raw.meta,githubCommitSha:'b'.repeat(40)}])assert.throws(()=>deploymentIdentity(mergeDeploymentMetadata({...compact,meta:raw.meta},{...raw,meta},expected),expected));
 assert.equal(deploymentIdentity(mergeDeploymentMetadata({...compact,meta:{githubCommitSha:'b'.repeat(40)}},raw,expected),expected).commit,expected.commit);
 assert.throws(()=>mergeDeploymentMetadata({...compact,id:'dpl_other'},raw,expected));
});

function directoryManifest() {
 const runId='a'.repeat(24),pins=ecoConnections.whatsappReceiver;
 const kinds=['owner','other','unknown','invalid','wrongDestination','ok','receive','mobileReceive','otp','button','status','attachment','ambiguous'];
 return {kind:'eco-whatsapp-verification-v2',senderAuthority:'directory',runId,projectRef:ecoConnections.supabaseProjectRef,sourceId:pins.sourceId,sourcePins:{accountId:pins.accountId,destinationId:pins.phoneNumberId,identityNamespace:pins.identityNamespace},identities:['owner','other'].map((role,index)=>({role,id:`00000000-0000-4000-8000-00000000000${index+1}`,email:`eco-whatsapp-${runId}-${role}@example.com`,sender:`19990000000000${index+1}`})),unknownSender:'199900000000009',messages:Object.fromEntries(kinds.map(kind=>[kind,`wamid.eco_${runId}_${kind}`])),requests:[]};
}
test('production verifier requires directory authority and checks source activation independently',()=>{
 const pins=ecoConnections.whatsappReceiver;
 const source={id:pins.sourceId,provider:'meta-whatsapp-cloud',account_id:pins.accountId,destination_id:pins.phoneNumberId,channel:'whatsapp',identity_namespace:pins.identityNamespace,sender_authority:'directory',enabled:true,provisioned_at:'2026-01-01',scopes_verified_at:'2026-01-01',cutover_at:'2026-01-01'};
 verifySource(source); verifySource({...source,enabled:false},false);
 assert.throws(()=>verifySource({...source,sender_authority:'manual'}));
 assert.throws(()=>verifySource({...source,sender_authority:undefined},false));
 assert.throws(()=>verifySource({...source,enabled:false}));
});
test('directory fixture phones stay confined to validated run-owned users, with legacy cleanup compatibility',()=>{
 const manifest=directoryManifest(); validateManifest(manifest);
 const [owner,other]=manifest.identities;
 assert.deepEqual(directoryPhoneAssignments(manifest,'normal'),[{id:owner.id,email:owner.email,phone:'+'+owner.sender},{id:other.id,email:other.email,phone:'+'+other.sender}]);
 assert.deepEqual(directoryPhoneAssignments(manifest,'reassigned').map(item=>item.phone),['','+'+owner.sender]);
 assert.deepEqual(directoryPhoneAssignments(manifest,'ambiguous').map(item=>item.phone),['+'+owner.sender,'+'+owner.sender]);
 assert.throws(()=>directoryPhoneAssignments(manifest,'anything'));
 for(const patch of [{senderAuthority:'manual'},{bindings:[]},{sourceId:'00000000-0000-4000-8000-000000000099'},{identities:[{...owner,email:'unrelated@example.com'},other]},{identities:[{...owner,sender:'+15551234567'},other]},{identities:[owner,{...other,id:owner.id}]},{identities:[owner,{...other,sender:owner.sender}]}])assert.throws(()=>directoryPhoneAssignments({...manifest,...patch},'normal'));
 const legacy={...manifest,kind:'eco-whatsapp-verification-v1',bindings:manifest.identities.map((item,index)=>({id:`10000000-0000-4000-8000-00000000000${index+1}`,ownerId:item.id,sender:item.sender})),messages:Object.fromEntries(Object.entries(manifest.messages).filter(([kind])=>kind!=='ambiguous'))};
 validateManifest(legacy); assert.throws(()=>directoryPhoneAssignments(legacy,'normal'));
});
test('hosted directory scenario proves immutable ownership and quarantine, restoring phones on failure',async()=>{
 const ownerPayload={kind:'owner'},ambiguousPayload={kind:'ambiguous'};
 for(const failure of [null,'reroute-owner','retain-quarantine-content','replay-quarantine']) {
  const assignments:string[]=[],deliveries:string[]=[];
  const receipts:any[]=[{provider_message_id:'original',owner_id:'owner'}];
  let scenario='normal';
  const run=verifyDirectoryReassignment({
   assignPhones:(value:string)=>{scenario=value;assignments.push(value);},
   deliver:async(payload:{kind:string})=>{
    deliveries.push(`${scenario}:${payload.kind}`);
    if(payload===ownerPayload&&failure==='reroute-owner')receipts[0].owner_id='other';
    if(payload===ambiguousPayload&&!receipts.some(item=>item.provider_message_id==='ambiguous'))receipts.push({provider_message_id:'ambiguous',status:'quarantined',reason:'ambiguous_sender',owner_id:null,raw_text:failure==='retain-quarantine-content'?'synthetic leaked body':null,subject:null,content_hash:null});
    if(payload===ambiguousPayload&&scenario==='normal'&&failure==='replay-quarantine')receipts[1].owner_id='owner';
   },receiptRows:()=>receipts,ownerPayload,ambiguousPayload,ownerId:'owner',ownerMessageId:'original',ambiguousMessageId:'ambiguous',
  });
  if(failure)await assert.rejects(run);else {await run;assert.deepEqual(deliveries,['reassigned:owner','ambiguous:ambiguous','normal:ambiguous']);}
  assert.equal(assignments.at(-1),'normal','Fixture phones must restore even after a failed hosted assertion.');
 }
});
