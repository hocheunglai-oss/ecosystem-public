import test from 'node:test';
import assert from 'node:assert/strict';
import { signalBackupMonitor } from './heartbeat.mjs';
import { ecoConnections as target } from '../../config/ecoConnections.ts';
const ping = target.backup.heartbeatOrigin + '/11111111-2222-4333-8444-555555555555';
const env = () => ({ GITHUB_ACTIONS:'true', RUNNER_ENVIRONMENT:'github-hosted', GITHUB_REPOSITORY:target.githubRepository,
  GITHUB_REPOSITORY_ID:target.backup.githubRepositoryId, GITHUB_REPOSITORY_OWNER_ID:target.backup.githubOwnerId,
  GITHUB_REF:target.backup.githubRef, GITHUB_REF_PROTECTED:'true', GITHUB_EVENT_NAME:'schedule',
  ECO_BACKUP_HEARTBEAT_URL:ping, ECO_BACKUP_CAPTURE_OUTCOME:'success', ECO_BACKUP_JOB_STATUS:'success' });
test('only a completed verified capture and successful job signal success; all other outcomes signal failure',async()=>{
  for (const outcome of ['success','failure','cancelled','skipped','',undefined]) for (const job of ['success','failure','cancelled']) {
    const seen=[];
    const result=await signalBackupMonitor('finish',{...env(),ECO_BACKUP_CAPTURE_OUTCOME:outcome,ECO_BACKUP_JOB_STATUS:job},{fetchImpl:async(url,options)=>{
      seen.push(url); assert.equal(options.body,'');assert.equal(options.method,'POST');assert.equal(options.redirect,'error');
      assert.deepEqual(Object.keys(options.headers),['Content-Type']);return new Response('OK');
    }});
    assert.deepEqual(result,{configured:true,delivered:true});
    assert.deepEqual(seen,[ping+(outcome==='success'&&job==='success'?'':'/fail')]);
  }
});
test('missing capture evidence never becomes a success and unexpected status values fail before sending',async()=>{
  const environment=env();delete environment.ECO_BACKUP_CAPTURE_OUTCOME;
  const seen=[];
  assert.deepEqual(await signalBackupMonitor('finish',environment,{fetchImpl:async url=>{
    seen.push(url);return new Response('OK');
  }}),{configured:true,delivered:true});
  assert.deepEqual(seen,[ping+'/fail']);
  for(const change of [{ECO_BACKUP_CAPTURE_OUTCOME:'unknown'}, {ECO_BACKUP_CAPTURE_OUTCOME:'private-value'},
    {ECO_BACKUP_JOB_STATUS:''},{ECO_BACKUP_JOB_STATUS:undefined},{ECO_BACKUP_JOB_STATUS:'skipped'}]) {
    await assert.rejects(signalBackupMonitor('finish',{...env(),...change},{fetchImpl:async()=>assert.fail('Invalid status sent a ping')}),
      {message:'Backup monitor configuration is invalid.'});
  }
});
test('start signal and absent configuration never fabricate delivery',async()=>{
  const seen=[];const options={fetchImpl:async(url)=>{seen.push(url);return new Response('OK');}};
  await signalBackupMonitor('start',env(),options);assert.deepEqual(seen,[ping+'/start']);
  assert.deepEqual(await signalBackupMonitor('finish',{...env(),ECO_BACKUP_HEARTBEAT_URL:''},options),{configured:false,delivered:false});
  assert.equal(seen.length,1);
});
test('wrong contexts and redirected, credential-bearing or malformed destinations never receive a request',async()=>{
  for(const change of [{GITHUB_REPOSITORY:'other/repo'},{GITHUB_REPOSITORY_ID:'0'},{GITHUB_REPOSITORY_OWNER_ID:'0'},
    {GITHUB_REF:'refs/heads/unreviewed'},{GITHUB_REF_PROTECTED:'false'},{RUNNER_ENVIRONMENT:'self-hosted'},{GITHUB_EVENT_NAME:'pull_request'},
    ...['https://attacker.invalid/11111111-2222-4333-8444-555555555555',ping+'?secret=x',ping+'#x',ping+'/',ping.replace('https:','http:'),ping.replace('https://','https://user:password@')].map(ECO_BACKUP_HEARTBEAT_URL=>({ECO_BACKUP_HEARTBEAT_URL}))]){
    let called=false;await assert.rejects(signalBackupMonitor('start',{...env(),...change},{fetchImpl:async()=>{called=true;}}));assert.equal(called,false);
  }
});
test('provider failures have bounded retries and HTTP200 alone does not establish monitor acceptance',async()=>{
  for(const body of ['OK (not found)','OK (rate limited)','x'.repeat(33)]){
    let count=0;const waits=[];
    assert.deepEqual(await signalBackupMonitor('finish',env(),{fetchImpl:async()=>{count++;return new Response(body);},sleep:async ms=>waits.push(ms)}),{configured:true,delivered:false});
    assert.equal(count,3);assert.deepEqual(waits,[500,1000]);
  }
  let count=0;assert.deepEqual(await signalBackupMonitor('finish',env(),{fetchImpl:async()=>{if(++count<3)throw Error(ping);return new Response('OK');},sleep:async()=>{}}),{configured:true,delivered:true});
});
