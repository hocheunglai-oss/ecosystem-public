import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { maintainVerifiedPair,validCapacityStatus,withDurationWarning } from './maintenance.mjs';
import { hongKongNight } from './drive-backups.mjs';
const now='2026-11-04T03:00:00.000Z',hash=value=>createHash('sha256').update(value).digest('hex');
const source={repository:'example/eco',commit:'a'.repeat(40),runId:'123'};
const config={mode:'enabled',restore:{sha256:hash('legacy'),verifiedAt:now},trashCanary:{sha256:hash('canary'),verifiedAt:now},protectedHashes:[]};
function point(index){const snapshotAt=new Date(Date.parse(now)-60_000-index*86400000).toISOString(),night=hongKongNight(snapshotAt),sha256=hash(snapshotAt);
  return {schemaVersion:1,kind:'verified-pair',snapshotAt,night,sha256,size:1024,captureProvenance:source,
    drive:{fileId:'file_'+index},nextcloud:{archiveName:`ECO-nightly-${night}-${sha256}.tar.gz.age`},firstPairVerifiedAt:snapshotAt};}
function fixture(count=40){
  const points=Array.from({length:count},(_,index)=>point(index)),ledger=new Map(),events=[];
  for(const value of points)ledger.set(`ECO-pair-v1-${value.sha256}.json`,structuredClone(value));
  const states={drive:new Set(),nextcloud:new Set()};
  const api=destination=>({
    verifyTarget:async()=>destination==='drive'?{quota:{usage:10000n,limit:15000000000n}}:
      {usedBytes:10000,totalBytes:500*1024**3,freeBytes:500*1024**3-10000},
    verifyForRetention:async value=>{events.push(['verify',destination,value.sha256]);
      if(states[destination].has(value.sha256))throw Error('missing');
      return {...value,verified:true};},
    assertRetentionReceipt:async value=>{assert.ok(value?.verified);if(states[destination].has(value.sha256))throw Error('changed');},
    trashVerified:async({candidateReceipt,beforeDelete})=>{await beforeDelete();events.push(['trash',destination,candidateReceipt.sha256]);
      states[destination].add(candidateReceipt.sha256);return {sha256:candidateReceipt.sha256,recoverable:true,permanentDeletionUsed:false};},
  });
  const drive=api('drive'),nextcloud={...api('nextcloud'),
    readLedger:async name=>ledger.has(name)?{value:structuredClone(ledger.get(name))}:null,
    writeLedger:async(name,value)=>{events.push(['ledger',name,value.kind]);if(ledger.has(name))assert.deepEqual(ledger.get(name),value);
      else ledger.set(name,structuredClone(value));return value;},
    listPairReceipts:async()=>[...ledger].filter(([,value])=>value.kind==='verified-pair').map(([name,value])=>({name,value:structuredClone(value)})),
  };
  const args={config,drive,nextcloud,current:points[0],runnerProvenance:source,durationMs:60_000,now};
  return {points,ledger,events,states,args,run:changes=>maintainVerifiedPair({...args,...changes})};
}
test('persist plan and mutation intents before bounded cleanup; preserve all retained union points',async()=>{
  const f=fixture(),result=await f.run();
  assert.equal(result.publicStatus.status,'healthy');assert.ok(result.actions.length>0&&result.actions.length<=16);
  const planWrite=f.events.findIndex(event=>event[0]==='ledger'&&event[2]==='retention-plan');
  assert.ok(planWrite>=0&&planWrite<f.events.findIndex(event=>event[0]==='trash'));
  for(const [index,event]of f.events.entries())if(event[0]==='trash'){
    assert.ok(f.events.slice(0,index).some(item=>item[0]==='ledger'&&item[2]==='retention-intent'));
    const entry=result.plan.entries.find(value=>value.sha256===event[2]);assert.equal(entry[event[1]].retain,false);
  }
  assert.ok(!f.states.drive.has(f.points[0].sha256)&&!f.states.nextcloud.has(f.points[0].sha256));
});
test('same-night reuse keeps first snapshot/source provenance, unknown legacy capture never relabelled',async()=>{
  const f=fixture(1),later={...source,commit:'b'.repeat(40),runId:'124'};
  const result=await f.run({current:{...f.points[0],captureProvenance:null,firstPairVerifiedAt:now},runnerProvenance:later});
  assert.deepEqual(result.pair.captureProvenance,source);assert.equal(result.pair.firstPairVerifiedAt,f.points[0].firstPairVerifiedAt);
  f.ledger.clear();
  const legacy=await f.run({current:{...f.points[0],captureProvenance:null},runnerProvenance:later});
  assert.equal(legacy.pair.captureProvenance,null);
  assert.ok(legacy.plan.entries[0].drive.reasons.includes('UNKNOWN_ORIGINAL_PROVENANCE'));
});
test('plan mode, stale restore or stale canary never trash and require visible review',async()=>{
  for(const change of [{mode:'plan'},{restore:{...config.restore,verifiedAt:'2026-01-01T00:00:00.000Z'}},
    {trashCanary:{...config.trashCanary,verifiedAt:'2026-01-01T00:00:00.000Z'}}]){
    const f=fixture(),result=await f.run({config:{...config,...change}});
    assert.ok(result.publicStatus.codes.includes('RETENTION_REVIEW_REQUIRED'));
    assert.equal(f.events.some(event=>event[0]==='trash'),false);
  }
});
test('ledger failure, duplicate/malformed historical identity, or changed current copy preserves candidates',async()=>{
  for(const variant of ['ledger','duplicate','identity','current']){
    const f=fixture();
    if(variant==='ledger')f.args.nextcloud.writeLedger=async()=>{throw Error('PRIVATE_PROVIDER_DETAIL');};
    if(variant==='duplicate')f.args.nextcloud.listPairReceipts=async()=>[{name:`ECO-pair-v1-${f.points[0].sha256}.json`,value:f.points[0]},
      {name:`ECO-pair-v1-${f.points[0].sha256}.json`,value:f.points[0]}];
    if(variant==='identity')f.ledger.get(`ECO-pair-v1-${f.points[0].sha256}.json`).drive.fileId='other';
    if(variant==='current')f.states.nextcloud.add(f.points[0].sha256);
    const result=await f.run();assert.ok(result.publicStatus.codes.includes('RETENTION_FAILED'));
    assert.equal(f.events.some(event=>event[0]==='trash'),false);assert.ok(!JSON.stringify(result).includes('PRIVATE_PROVIDER_DETAIL'));
  }
});
test('intent survives interrupted operation; rerun refuses to blindly repeat uncertain trash',async()=>{
  const f=fixture();let attempted=0;
  f.args.drive.trashVerified=async({beforeDelete})=>{await beforeDelete();attempted++;throw Error('lost response');};
  assert.equal((await f.run()).publicStatus.status,'attention');
  assert.equal((await f.run()).publicStatus.status,'attention');assert.equal(attempted,1);
  assert.ok([...f.ledger.values()].some(value=>value.kind==='retention-intent'));
});
test('completed receipts skip already retired objects while subsequent runs make bounded progress',async()=>{
  const f=fixture(60),first=await f.run(),firstActions=first.actions.length;
  assert.ok(firstActions>0);const second=await f.run();
  assert.equal(second.publicStatus.status,'healthy');assert.ok(second.actions.length>0);
  assert.equal(new Set([...first.actions,...second.actions].map(value=>value.destination+value.sha256)).size,firstActions+second.actions.length);
});
test('quota denial reports capacity unknown and preserves valid capture status; details remain private',async()=>{
  const f=fixture(1);f.args.drive.verifyTarget=async()=>{throw Error('PRIVATE_TOKEN');};
  const result=await f.run({config:{...config,mode:'plan'}});
  assert.ok(result.publicStatus.codes.includes('CAPACITY_UNKNOWN'));
  assert.ok(!JSON.stringify(result.publicStatus).includes('PRIVATE_TOKEN'));
});
test('public status rejects provider details, inconsistent healthy state and unknown codes',()=>{
  assert.equal(validCapacityStatus({schemaVersion:1,status:'attention',codes:['RETENTION_FAILED']}),true);
  for(const value of [{schemaVersion:1,status:'healthy',codes:['CAPACITY_UNKNOWN']},
    {schemaVersion:1,status:'attention',codes:['PRIVATE_TOKEN']},{schemaVersion:1,status:'healthy',codes:[],fileId:'private'}])
    assert.equal(validCapacityStatus(value),false);
});
test('elapsed maintenance time is included in the final duration warning',()=>{
  const healthy={schemaVersion:1,status:'healthy',codes:[]};
  assert.equal(withDurationWarning(healthy,29*60_000).status,'healthy');
  assert.deepEqual(withDurationWarning(healthy,35*60_000),{schemaVersion:1,status:'attention',codes:['BACKUP_DURATION_WARNING']});
  assert.deepEqual(withDurationWarning(withDurationWarning(healthy,35*60_000),36*60_000).codes,['BACKUP_DURATION_WARNING']);
});
