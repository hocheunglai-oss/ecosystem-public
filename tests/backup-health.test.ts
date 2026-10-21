import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ecoConnections } from '../config/ecoConnections.ts';
import { createBackupHealthObserver, mergeBackupHealth } from '../server/backup/health.ts';
import { createHealthCollector } from '../server/admin/health.ts';

const HOUR = 3_600_000, NOW = Date.UTC(2026, 9, 21, 12);
const date = (at: number) => new Date(at).toISOString();
function fixture(capturedAt = NOW - HOUR) {
  const repo = { id:Number(ecoConnections.backup.githubRepositoryId), full_name:ecoConnections.githubRepository,
    owner:{id:Number(ecoConnections.backup.githubOwnerId), login:ecoConnections.githubRepository.split('/')[0]}, private:false, archived:false };
  const workflow = {id:42, path:ecoConnections.backup.githubWorkflowPath, state:'active'};
  const run = {id:120, workflow_id:42, path:workflow.path, head_branch:'main', head_sha:'a'.repeat(40),
    event:'schedule', pull_requests:[], run_attempt:2, status:'completed', conclusion:'success',
    repository:structuredClone(repo), head_repository:structuredClone(repo),
    created_at:date(capturedAt-600_000), updated_at:date(capturedAt+120_000)};
  const step = {name:ecoConnections.backup.githubCaptureStepName, status:'completed', conclusion:'success',
    started_at:date(capturedAt), completed_at:date(capturedAt+60_000)};
  const job = {id:200, run_id:120, run_attempt:2, head_sha:run.head_sha, name:'backup', status:'completed',
    conclusion:'success', started_at:date(capturedAt-300_000), completed_at:date(capturedAt+120_000), steps:[step]};
  const runs = {total_count:1, workflow_runs:[run]}, jobs = {total_count:1, jobs:[job]};
  const paths: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input); paths.push(url);
    assert.equal(init?.method, 'GET'); assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    assert.equal(new URL(url).origin, 'https://api.github.com');
    const base = `https://api.github.com/repos/${ecoConnections.githubRepository}`;
    const values: Record<string,unknown> = {
      [base]:repo,
      [`${base}/actions/workflows/nightly-backup.yml`]:workflow,
      [`${base}/actions/workflows/nightly-backup.yml/runs?branch=main&per_page=10&exclude_pull_requests=true`]:runs,
      [`${base}/actions/runs/120/attempts/${run.run_attempt}/jobs?per_page=100`]:jobs,
    };
    assert.ok(url in values, 'Only canonical metadata endpoints may be read');
    return Response.json(values[url]);
  };
  return {repo, workflow, run, step, job, runs, jobs, paths, fetchImpl};
}
const states = (result: Awaited<ReturnType<ReturnType<typeof createBackupHealthObserver>>>) => result.map(item => item.status);
async function observe(f: ReturnType<typeof fixture>) { return createBackupHealthObserver({fetchImpl:f.fetchImpl, now:()=>NOW})(true); }

test('disabled observer returns no replacement checks and makes no provider calls', async () => {
  let calls=0;
  assert.deepEqual(await createBackupHealthObserver({fetchImpl:async()=>{calls++; throw Error('unexpected');}})(false),[]);
  assert.equal(calls,0);
});

test('only the pinned successful capture step in the exact run attempt proves backup copies', async () => {
  const f=fixture(), result=await observe(f);
  assert.deepEqual(states(result),['healthy','healthy']);
  assert.deepEqual(result.map(c=>c.id),['database-backup','document-backup']);
  assert.match(result[0].detail,/RECOVERY TEST IS SEPARATE/);
  assert.equal(result[0].metrics?.attempt,2);
  assert.equal(result[0].metrics?.backupDate,'2026-10-21');
  assert.equal(result[0].metrics?.copyVerifiedAt,f.step.completed_at);
  assert.equal(result[0].metrics?.captureStartedAt,undefined);
  assert.ok(f.paths.at(-1)?.includes('/attempts/2/jobs'));
  assert.equal(f.paths.length,4);
  const workflow=await readFile(new URL('../.github/workflows/nightly-backup.yml',import.meta.url),'utf8');
  assert.equal(workflow.split(`- name: ${ecoConnections.backup.githubCaptureStepName}`).length,2);
});

test('workflow success without a completed successful capture step never counts as a backup', async () => {
  for(const mode of ['missing','duplicate','skipped','failure','running','job-skipped','no-job','extra-job']) {
    const f=fixture();
    if(mode==='missing') f.job.steps=[];
    if(mode==='duplicate') f.job.steps.push({...f.step});
    if(mode==='skipped'||mode==='failure') f.step.conclusion=mode;
    if(mode==='running') f.step.status='in_progress';
    if(mode==='job-skipped') f.job.conclusion='skipped';
    if(mode==='no-job'){f.jobs.jobs=[];f.jobs.total_count=0;}
    if(mode==='extra-job'){f.jobs.jobs.push({...f.job});f.jobs.total_count=2;}
    assert.ok(states(await observe(f)).every(status=>status!=='healthy'),mode);
  }
});

test('missing, disabled, failed and unfinished schedules remain visible', async () => {
  const noRuns=fixture(); noRuns.runs.workflow_runs=[];noRuns.runs.total_count=0;
  assert.deepEqual(states(await observe(noRuns)),['unknown','unknown']);
  for(const state of ['disabled_manually','disabled_inactivity','disabled_fork','deleted']) {
    const f=fixture();f.workflow.state=state; assert.deepEqual(states(await observe(f)),['unavailable','unavailable']);
  }
  for(const conclusion of ['failure','cancelled','timed_out','skipped','neutral','action_required','startup_failure']) {
    const f=fixture();f.run.conclusion=conclusion;
    f.runs.workflow_runs.push({...f.run,id:119,conclusion:'success',updated_at:date(NOW-2*HOUR),created_at:date(NOW-3*HOUR)});
    f.runs.total_count=2;
    assert.deepEqual(states(await observe(f)),['unavailable','unavailable'],conclusion);
    assert.equal(f.paths.length,3,'An older success must not mask the latest failure');
  }
  const queued=fixture(); queued.run.status='queued';
  assert.deepEqual(states(await observe(queued)),['degraded','degraded']);
});

test('forks, changed identity, non-main runs and untrusted jobs are rejected', async () => {
  const mutations: ((f:ReturnType<typeof fixture>)=>void)[] = [
    f=>{f.repo.id++;}, f=>{f.repo.owner.id++;}, f=>{f.repo.private=true;},f=>{f.repo.archived=true;},
    f=>{f.run.head_repository.id++;}, f=>{f.run.repository.full_name='untrusted/fork';},
    f=>{f.run.head_branch='untrusted';},f=>{f.run.event='pull_request';},f=>{f.run.path='.github/workflows/other.yml';},
    f=>{f.run.workflow_id++;},f=>{f.workflow.path='.github/workflows/other.yml';},f=>{f.run.path+='@feature';},
    f=>{f.job.name='untrusted';},f=>{f.job.run_id++;},f=>{f.job.run_attempt=1;},f=>{f.job.head_sha='b'.repeat(40);},
    f=>{f.run.head_sha='invalid';},f=>{f.run.run_attempt=0;},f=>{f.step.completed_at=date(NOW+120_000);},
    f=>{f.step.started_at=date(NOW-2*HOUR);},f=>{f.runs.total_count=-1;},
  ];
  for(const [index,mutate] of mutations.entries()) {const f=fixture();mutate(f);assert.deepEqual(states(await observe(f)),['unknown','unknown'],String(index));}
});

test('reruns require current-attempt job evidence, never a successful old attempt', async () => {
  const f=fixture();f.run.run_attempt=3;
  assert.deepEqual(states(await observe(f)),['unknown','unknown']);
  assert.ok(f.paths.at(-1)?.includes('/attempts/3/jobs'));
  f.job.run_attempt=3;
  assert.deepEqual(states(await observe(f)),['healthy','healthy']);
});

test('documented workflow ref suffixes and optional job attempt field remain bound to main and the attempt endpoint', async () => {
  for(const suffix of ['@main','@refs/heads/main']) {
    const f=fixture();f.run.path+=suffix;
    Reflect.deleteProperty(f.job,'run_attempt');
    assert.deepEqual(states(await observe(f)),['healthy','healthy']);
    assert.ok(f.paths.at(-1)?.includes('/attempts/2/jobs'));
  }
});

test('ten-minute cache coalesces calls but freshness uses the current time', async () => {
  const initial=Date.UTC(2026,9,21,3,59);
  let time=initial;const f=fixture(Date.UTC(2026,9,20,15));
  const observer=createBackupHealthObserver({fetchImpl:f.fetchImpl,now:()=>time});
  const [first,second]=await Promise.all([observer(true),observer(true)]);
  assert.equal(f.paths.length,4);assert.deepEqual(states(first),['healthy','healthy']);
  first[0].status='unavailable';assert.equal(second[0].status,'healthy');
  time+=120_000;
  assert.deepEqual(states(await observer(true)),['unavailable','unavailable']);
  assert.equal(f.paths.length,4,'Cached evidence must still expire at 36 hours');
  time=initial+600_000;await observer(true);assert.equal(f.paths.length,8);
});

test('late same-Hong-Kong-night retries cannot extend the snapshot freshness bound', async () => {
  const early=fixture(Date.UTC(2026,9,19,18,17)); // 02:17 Hong Kong, 20 October.
  const retry=fixture(Date.UTC(2026,9,20,15,55)); // 23:55 Hong Kong, same stored backup date.
  const checkedAt=Date.UTC(2026,9,21,4,1); // 36 hours and one minute after that HK date began.
  const results=await Promise.all([early,retry].map(f=>createBackupHealthObserver({fetchImpl:f.fetchImpl,now:()=>checkedAt})(true)));
  for(const result of results) {
    assert.deepEqual(states(result),['unavailable','unavailable']);
    assert.equal(result[0].metrics?.backupDate,'2026-10-20');
  }
  assert.notEqual(results[0][0].metrics?.copyVerifiedAt,results[1][0].metrics?.copyVerifiedAt);
  // Even a successful late retry cannot stay healthy through a second missed night.
  assert.deepEqual(states(await createBackupHealthObserver({fetchImpl:retry.fetchImpl,now:()=>Date.UTC(2026,9,21,20)})(true)),['unavailable','unavailable']);
});

test('API denial, malformed/oversized bodies, redirects and bounded timeout return sanitized unknown', async () => {
  const failures: typeof fetch[] = [
    async()=>Response.json({private:'must not escape'}, {status:429}),
    async()=>Response.json({private:'must not escape'}, {status:403}),
    async()=>new Response('not json',{headers:{'Content-Type':'application/json'}}),
    async()=>new Response('x'.repeat(512*1024+1),{headers:{'Content-Type':'application/json'}}),
    async()=>{throw Error('private credentials must not escape');},
    async()=>{const response=Response.json({});Object.defineProperty(response,'redirected',{value:true});return response;},
    async()=>new Promise(()=>{}),
  ];
  for(const fetchImpl of failures) {
    const result=await createBackupHealthObserver({fetchImpl,now:()=>NOW,deadlineMs:10})(true);
    assert.deepEqual(states(result),['unknown','unknown']);
    assert.ok(!JSON.stringify(result).includes('must not escape'));
  }
});

test('merging backup visibility preserves restore and every unrelated check', async () => {
  const system=await createHealthCollector({now:()=>NOW})(async()=>({observedAt:date(NOW),migrationHead:'fixture',pendingImports:0,failedImports:0,oldestPendingImportAt:null}));
  const restore=system.checks.find(c=>c.id==='restore-test');
  assert.strictEqual(mergeBackupHealth(system,[]),system);
  const result=mergeBackupHealth(system,await observe(fixture()));
  assert.strictEqual(result.checks.find(c=>c.id==='restore-test'),restore);
  assert.equal(restore?.status,'unknown');assert.notEqual(result.status,'healthy');
  assert.throws(()=>mergeBackupHealth(system,[result.checks.find(c=>c.id==='database-backup')!]));
});
