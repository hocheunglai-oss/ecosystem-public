/** Post-readback maintenance. Private ledger detail never enters public logs. */
import { createHash } from 'node:crypto';
import { hongKongNight } from './drive-backups.mjs';
import { planBackupRetention } from './retention-policy.mjs';
import { assessBackupCapacity } from './capacity.mjs';
import { CAPACITY_DIAGNOSTIC_CODES } from './capacity.mjs';

const HASH=/^[a-f0-9]{64}$/u, SHA=/^[a-f0-9]{40}$/u, ID=/^[A-Za-z0-9_-]{1,200}$/u;
const check=value=>{if(!value)throw new Error('BACKUP_MAINTENANCE_INVALID');};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)
  &&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const iso=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const hash=value=>createHash('sha256').update(value).digest('hex');
const publicAttention=codes=>({schemaVersion:1,status:'attention',codes:[...new Set(codes)]});
export const MAINTENANCE_DIAGNOSTIC_CODES=Object.freeze(['RETENTION_REVIEW_REQUIRED','RETENTION_FAILED','LEDGER_UNAVAILABLE','CAPACITY_UNKNOWN']);
export function validCapacityStatus(value) {
  return exact(value,['schemaVersion','status','codes'])&&value.schemaVersion===1&&['healthy','attention'].includes(value.status)
    &&Array.isArray(value.codes)&&value.codes.length<=20&&new Set(value.codes).size===value.codes.length
    &&value.codes.every(code=>[...CAPACITY_DIAGNOSTIC_CODES,...MAINTENANCE_DIAGNOSTIC_CODES].includes(code))
    &&(value.status==='healthy'?value.codes.length===0:value.codes.length>0);
}
export function withDurationWarning(status,durationMs) {
  check(validCapacityStatus(status)&&Number.isSafeInteger(durationMs)&&durationMs>=0);
  return durationMs>=30*60_000?publicAttention([...status.codes,'BACKUP_DURATION_WARNING']):status;
}
export function validateMaintenanceConfiguration(value) {
  check(exact(value,['mode','restore','trashCanary','protectedHashes'])&&['plan','enabled'].includes(value.mode)
    &&exact(value.restore,['sha256','verifiedAt'])&&HASH.test(value.restore.sha256)&&iso(value.restore.verifiedAt)
    &&exact(value.trashCanary,['sha256','verifiedAt'])&&HASH.test(value.trashCanary.sha256)&&iso(value.trashCanary.verifiedAt)
    &&Array.isArray(value.protectedHashes)&&value.protectedHashes.length<=100&&value.protectedHashes.every(item=>typeof item==='string'&&HASH.test(item)));
}
function provenance(value) {
  return value===null||(exact(value,['repository','commit','runId'])&&/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value.repository)
    &&SHA.test(value.commit)&&/^[1-9][0-9]*$/u.test(value.runId));
}
export function validatePairReceipt(value) {
  check(exact(value,['schemaVersion','kind','snapshotAt','night','sha256','size','captureProvenance','drive','nextcloud','firstPairVerifiedAt'])
    &&value.schemaVersion===1&&value.kind==='verified-pair'&&iso(value.snapshotAt)&&value.night===hongKongNight(value.snapshotAt)
    &&HASH.test(value.sha256)&&Number.isSafeInteger(value.size)&&value.size>0&&value.size<=512*1024**2
    &&provenance(value.captureProvenance)&&exact(value.drive,['fileId'])&&ID.test(value.drive.fileId)
    &&exact(value.nextcloud,['archiveName'])&&value.nextcloud.archiveName===`ECO-nightly-${value.night}-${value.sha256}.tar.gz.age`
    &&iso(value.firstPairVerifiedAt)&&Date.parse(value.firstPairVerifiedAt)>=Date.parse(value.snapshotAt));
  return value;
}
const eventName=(kind,destination,sha256)=>`ECO-maintenance-v1-${hash(kind+':'+destination+':'+sha256)}.json`;
const recent=(stamp,now)=>Date.parse(stamp)<=Date.parse(now)&&Date.parse(now)-Date.parse(stamp)<=30*86_400_000;
const safeNumber=value=>typeof value==='bigint'&&value>=0n&&value<=BigInt(Number.MAX_SAFE_INTEGER)?Number(value):null;

/** Both supplied current receipts have already passed each client's full readback.
 * Current and historical objects are independently rechecked before any cleanup.
 * Ledger failures affect maintenance status, never erase successful archive copies.
 */
export async function maintainVerifiedPair({config,drive,nextcloud,current,runnerProvenance,durationMs,now}) {
  validateMaintenanceConfiguration(config);
  check(iso(now)&&provenance(runnerProvenance)&&runnerProvenance!==null);
  validatePairReceipt(current);
  check(current.captureProvenance===null||JSON.stringify(current.captureProvenance)===JSON.stringify(runnerProvenance));
  let capacity={publicStatus:publicAttention(['CAPACITY_UNKNOWN']),forecasts:null};
  try {
    const pairName=`ECO-pair-v1-${current.sha256}.json`, stored=await nextcloud.readLedger(pairName,true,current.snapshotAt);
    let pair=current;
    if(stored){
      pair=validatePairReceipt(stored.value);
      // A later runner/source revision cannot relabel an older sealed capture.
      check(pair.sha256===current.sha256&&pair.size===current.size&&pair.snapshotAt===current.snapshotAt
        &&pair.drive.fileId===current.drive.fileId&&pair.nextcloud.archiveName===current.nextcloud.archiveName);
    }else await nextcloud.writeLedger(pairName,pair,pair.snapshotAt);
    const inventory=await nextcloud.listPairReceipts();
    const points=inventory.map(item=>{
      const point=validatePairReceipt(item.value);
      check(item.name===`ECO-pair-v1-${point.sha256}.json`&&Date.parse(point.firstPairVerifiedAt)<=Date.parse(now)
        &&(item.year===undefined||String(item.year)===point.night.slice(0,4))
        &&(point.captureProvenance===null||point.captureProvenance.repository===runnerProvenance.repository));return point;
    });
    check(points.some(point=>point.sha256===current.sha256));
    const targets=await Promise.allSettled([drive.verifyTarget(),nextcloud.verifyTarget()]);
    const d=targets[0].status==='fulfilled'?targets[0].value:null,n=targets[1].status==='fulfilled'?targets[1].value:null;
    const usage=d?safeNumber(d.quota?.usage):null,limit=d?safeNumber(d.quota?.limit):null;
    capacity=assessBackupCapacity({archiveBytes:current.size,historySizes:[...points].sort((a,b)=>a.snapshotAt.localeCompare(b.snapshotAt)).map(point=>point.size),
      drive:usage!==null&&limit!==null?{usageBytes:usage,limitBytes:limit,knownNightlyBytes:0}:null,
      nextcloud:n&&Number.isSafeInteger(n.usedBytes)&&Number.isSafeInteger(n.totalBytes)?
        {usedBytes:n.usedBytes,totalBytes:n.totalBytes,freeBytes:n.freeBytes,knownNightlyBytes:0}:null,durationMs});
    const plan=planBackupRetention({now,points:points.map(point=>({...point,provenanceKnown:point.captureProvenance!==null})),
      currentSha256:current.sha256,restore:config.restore,protectedHashes:config.protectedHashes});
    const record={schemaVersion:1,kind:'retention-plan',runnerProvenance,plan,forecasts:capacity.forecasts};
    await nextcloud.writeLedger(`ECO-maintenance-v1-${hash(JSON.stringify(record))}.json`,record);
    if(config.mode!=='enabled'||!plan.cleanupEligible||!recent(config.trashCanary.verifiedAt,now))
      return {publicStatus:publicAttention([...capacity.publicStatus.codes,'RETENTION_REVIEW_REQUIRED']),plan,actions:[],pair};
    const byHash=new Map(points.map(point=>[point.sha256,point])), verified={drive:new Map(),nextcloud:new Map()},actions=[];
    const verify=async(destination,sha256)=>{
      if(verified[destination].has(sha256))return verified[destination].get(sha256);
      const point=byHash.get(sha256),api=destination==='drive'?drive:nextcloud;
      const receipt=await api.verifyForRetention({...point,...point[destination]});
      check(receipt?.verified===true&&receipt.sha256===point.sha256&&receipt.size===point.size);
      verified[destination].set(sha256,receipt);return receipt;
    };
    // Both current objects must still be present, private and exact after ledger I/O.
    await verify('drive',current.sha256);await verify('nextcloud',current.sha256);
    for(const destination of ['drive','nextcloud']) {
      const api=destination==='drive'?drive:nextcloud;
      const candidates=plan.entries.filter(entry=>!entry[destination].retain);
      let changed=0;
      for(const candidate of candidates) {
        const point=byHash.get(candidate.sha256),completeName=eventName('completed',destination,candidate.sha256);
        if(destination==='nextcloud'){
          // Retire Drive first while the active secondary twin still exists.
          // This also permits later expiry of a long-term secondary point whose
          // Drive copy left the fourteen-day tier months earlier.
          const prior=await nextcloud.readLedger(eventName('completed','drive',candidate.sha256),true,point.snapshotAt);
          if(!prior)continue;
          check(prior.value?.kind==='retention-completed'&&prior.value.destination==='drive'
            &&prior.value.sha256===point.sha256&&prior.value.snapshotAt===point.snapshotAt
            &&prior.value.recoverable===true&&prior.value.permanentDeletionUsed===false);
        }
        const completed=await nextcloud.readLedger(completeName,true,point.snapshotAt);
        if(completed){
          const value=completed.value;
          check(value?.schemaVersion===1&&value.kind==='retention-completed'&&value.destination===destination
            &&value.sha256===point.sha256&&value.snapshotAt===point.snapshotAt&&value.recoverable===true
            &&value.permanentDeletionUsed===false);continue;
        }
        if(changed>=8)break; // Bounded work; extra known copies remain protected until a later run.
        const intentName=eventName('intent',destination,candidate.sha256);
        // An interrupted operation is reviewed, never blindly replayed.
        check(!await nextcloud.readLedger(intentName,true,point.snapshotAt));
        const retained=[];
        for(const entry of plan.entries.filter(entry=>entry[destination].retain))retained.push(await verify(destination,entry.sha256));
        const candidateReceipt=await verify(destination,candidate.sha256);
        const counterpart=destination==='drive'?'nextcloud':'drive';
        // Nextcloud may retain long-term points after Drive's 14-day window. Before
        // discarding those active points, its own trash must be available and readback
        // is mandatory. Drive trashing additionally requires the exact Nextcloud copy.
        if(destination==='drive')await verify(counterpart,candidate.sha256);
        const intent={schemaVersion:1,kind:'retention-intent',destination,sha256:point.sha256,snapshotAt:point.snapshotAt,
          source:point[destination],policyVersion:1};
        const beforeDelete=async()=>{
          await drive.assertRetentionReceipt(verified.drive.get(current.sha256));
          await nextcloud.assertRetentionReceipt(verified.nextcloud.get(current.sha256));
          if(destination==='drive')await nextcloud.assertRetentionReceipt(verified.nextcloud.get(candidate.sha256));
          await nextcloud.writeLedger(intentName,intent,point.snapshotAt);
        };
        const result=await api.trashVerified({candidateReceipt,retainedReceipts:retained,
          protectedHashes:[config.restore.sha256,...config.protectedHashes],beforeDelete});
        check(result?.recoverable===true&&result.permanentDeletionUsed===false&&result.sha256===point.sha256);
        const completedReceipt={schemaVersion:1,kind:'retention-completed',destination,sha256:point.sha256,snapshotAt:point.snapshotAt,
          recoverable:true,permanentDeletionUsed:false,result};
        await nextcloud.writeLedger(completeName,completedReceipt,point.snapshotAt);actions.push(completedReceipt);changed++;
      }
    }
    return {publicStatus:capacity.publicStatus,plan,actions,pair};
  }catch{
    return {publicStatus:publicAttention([...capacity.publicStatus.codes,'RETENTION_FAILED']),actions:[],copiesVerified:true};
  }
}
