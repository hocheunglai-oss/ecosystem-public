/** Offline synthetic tests only. No source database, Google account or production keys. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, symlink, chmod, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { validateConnection } from './capture-postgres.mjs';
import { validateExecutionContext, validateRuntime, readPrivateFile, loadSecrets, runNightly,
  superviseWorker, createGoogleAuthorizedFetch, publicStatus, writeManifest } from './nightly.mjs';

const ref = 'abcdefghijklmnopqrst', password = 'SYNTHETIC_SECRET_DO_NOT_LOG', now = '2026-10-21T18:17:00.000Z';
const target = { supabaseProjectRef:ref, githubRepository:'example/eco-source', identityMode:'independent-password', productionOrigin:'https://eco.example.test', supplierReportsBucket:'synthetic-reports' };
const runtime = () => ({ target, config:{ schemaVersion:1, expectedProjectRef:ref, expectedSourceRole:'eco_backup_reader',
  database:{PGHOST:`db.${ref}.supabase.co`, PGPORT:'5432', PGUSER:'eco_backup_reader', PGDATABASE:'postgres', PGSSLMODE:'verify-full',PGSSLROOTCERT:'/synthetic/ca.pem'},
  pgBin:'/synthetic/pg/bin', ageBin:'/synthetic/age', recipient:'age1'+'a'.repeat(58), timeoutMs:120000,
  drive:{expectedEmail:'backup@example.invalid',folderId:'SYNTHETIC_PRIVATE_FOLDER',applicationTag:'eco-nightly-v1',namePrefix:'ECO-nightly',propertyPrefix:'ecoBackup',keepNights:5,maxArchiveBytes:1024*1024} },
  secrets:{dbPassword:password,driveClientId:'fake-client',driveClientSecret:'fake-secret',driveRefreshToken:'fake-refresh',storage:{opaque:'fake-token'}} });
const context = () => ({GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:target.githubRepository,GITHUB_REF:'refs/heads/main',GITHUB_REF_PROTECTED:'true',GITHUB_EVENT_NAME:'schedule',GITHUB_SHA:'a'.repeat(40),GITHUB_RUN_ID:'123'});
const exists = async path => { try {await access(path); return true;} catch {return false;} };
const root = prefix => mkdtemp(join(tmpdir(),prefix));
const clone = value => structuredClone(value);

 test('trusted workflow gate rejects fork/PR/unprotected/debug/self-hosted runs', () => {
  assert.equal(validateExecutionContext(context(),target).commit,'a'.repeat(40));
  for(const patch of [{GITHUB_REPOSITORY:'other/eco-source'},{GITHUB_REF:'refs/heads/feature'},{GITHUB_REF_PROTECTED:'false'},
    {GITHUB_EVENT_NAME:'pull_request_target'},{GITHUB_EVENT_NAME:'pull_request'},{RUNNER_ENVIRONMENT:'self-hosted'},
    {RUNNER_DEBUG:'1'},{ACTIONS_STEP_DEBUG:'true'},{GITHUB_SHA:'not-sha'},{GITHUB_ACTIONS:'false'}]) {
    assert.throws(()=>validateExecutionContext({...context(),...patch},target),error=>!String(error).includes(password));
  }
});

test('runtime pins, nonprivileged role, TLS, public key and retention fail closed', () => {
  assert.equal(validateRuntime(runtime()).PGUSER,'eco_backup_reader');
  for(const change of [r=>r.config.expectedProjectRef='zyxwvutsrqponmlkjihg',r=>r.config.expectedSourceRole='postgres',
    r=>r.config.database.PGHOST='attacker.example',r=>r.config.database.PGSSLMODE='require',r=>r.config.database.PGPORT='6543',
    r=>r.config.database.PGOPTIONS='-c role=postgres',r=>r.config.drive.keepNights=1,r=>r.config.drive.expectedEmail='not-an-email',
    r=>r.config.recipient='AGE-SECRET-KEY-1_FAKE',r=>r.secrets.storage.extra='AGE-SECRET-KEY-1_FAKE',
    r=>r.config.timeoutMs=99999999,r=>r.secrets.extra=password,r=>r.config.extra='anything']) {
    const r=runtime(); change(r); assert.throws(()=>validateRuntime(r),error=>!String(error).includes(password));
  }
  const r=runtime(); r.config.database.PGHOST='aws-0-ap-southeast-1.pooler.supabase.com';r.config.database.PGUSER=`eco_backup_reader.${ref}`;
  assert.doesNotThrow(()=>validateRuntime(r));
});

test('capture connection remains backward compatible and explicitly pins dedicated reader', () => {
  const r=runtime(), c={...r.config.database,PGPASSWORD:password};
  assert.doesNotThrow(()=>validateConnection(c,ref,'eco_backup_reader'));
  assert.throws(()=>validateConnection(c,ref));
  assert.doesNotThrow(()=>validateConnection({...c,PGUSER:'postgres'},ref));
  assert.throws(()=>validateConnection({...c,PGUSER:'postgres'},ref,'eco_backup_reader'));
  assert.throws(()=>validateConnection(c,ref,'evil;role'));
});

test('private secret files reject symlinks, permissive files, duplicates and private identity', async () => {
  const dir=await root('eco-nightly-secret-test-');
  try {
    const file=join(dir,'secret'); await writeFile(file,password,{mode:0o600});
    assert.equal(await readPrivateFile(file),password);
    const link=join(dir,'link');await symlink(file,link);await assert.rejects(readPrivateFile(link));
    await chmod(file,0o644); await assert.rejects(readPrivateFile(file));await chmod(file,0o600);
    await assert.rejects(readPrivateFile(file,1));
    const env={ECO_BACKUP_DB_PASSWORD_FILE:file,ECO_DRIVE_CLIENT_ID:'id',ECO_DRIVE_CLIENT_SECRET:'secret',ECO_DRIVE_REFRESH_TOKEN:'refresh',ECO_BACKUP_STORAGE_JSON:'{"opaque":"fake"}'};
    assert.equal((await loadSecrets(env)).dbPassword,password);
    await assert.rejects(loadSecrets({...env,ECO_BACKUP_DB_PASSWORD:'duplicate'}));
    await assert.rejects(loadSecrets({...env,AGE_IDENTITY_FILE:'/do/not/read'}));
    await assert.rejects(loadSecrets({...env,ECO_BACKUP_STORAGE_JSON:'not json'}));
  } finally {await rm(dir,{recursive:true,force:true});}
});

async function fixture({existing=false,failAt,wrongReceipt=false}={}) {
  const directory=await root('eco-nightly-engine-test-'), events=[], r=runtime();
  const hash='b'.repeat(64), receipt={fileId:'synthetic_file',night:'2026-10-22',sha256:hash,size:123,verified:true};
  const step=name=>{events.push(name);if(failAt===name)throw new Error(password+' provider details');};
  const deps={ now:()=>new Date(now),captureObjects:async()=>{},
    lock:async()=>{step('lock');return{assertAlive:async()=>step('alive'),close:async()=>step('close')};},
    capture:async options=>{step('capture');assert.equal(options.expectedSourceRole,'eco_backup_reader');assert.equal(options.expectedProjectRef,ref);
      await mkdir(options.outputDir,{mode:0o700});await writeFile(join(options.outputDir,'database.dump'),'SYNTHETIC_DATABASE',{mode:0o600});
      return{sourceProjectRef:ref,source:{role:'eco_backup_reader',snapshot_time:now,server_version:'17.11'}};},
    seal:async options=>{step('seal');assert.equal(options.recipient,r.config.recipient);assert.equal(Object.hasOwn(options,'identityFile'),false);
      const manifest=JSON.parse(await readFile(join(options.sourceDir,'recovery-manifest.json'),'utf8'));
      assert.equal(manifest.recovery.restorationVerified,false);assert.equal(manifest.files.length,1);
      await writeFile(options.outputFile,'age-encryption.org/v1\nSYNTHETIC_CIPHERTEXT',{mode:0o600});
      return{archiveFile:options.outputFile,sha256:hash,size:123};},
    drive:{verifyTarget:async()=>step('target'),findVerifiedNight:async()=>{step('find');return existing?receipt:null;},
      uploadAndVerify:async({archiveFile})=>{step('upload');assert.equal(await exists(join(directory,'capture')),false);assert.equal(await exists(archiveFile),true);
        return wrongReceipt?{...receipt,sha256:'c'.repeat(64)}:receipt;},
      retainLatestNights:async({currentReceipt})=>{step('retain');assert.equal(currentReceipt,receipt);return{keepNights:5,permanentDeletionUsed:false,retainedNights:[receipt.night],trashed:[]};}},
  };
  return{directory,events,deps,payload:{...r,runDirectory:directory,provenance:{synthetic:true}}};
}
test('new capture encrypts and verifies before retention; plaintext removed before upload',async()=>{
  const f=await fixture();try{
    const result=await runNightly(f.payload,f.deps);
    assert.equal(result.verified,true);assert.equal(result.restorationVerified,false);assert.equal(result.reused,false);
    assert.deepEqual(f.events,['lock','target','find','capture','seal','alive','upload','alive','retain','close']);
  }finally{await rm(f.directory,{recursive:true,force:true});}
});
test('same-night retry uses newly readback-verified receipt without new randomized ciphertext',async()=>{
  const f=await fixture({existing:true});try{
    const result=await runNightly(f.payload,f.deps);assert.equal(result.reused,true);
    assert.deepEqual(f.events,['lock','target','find','alive','retain','close']);
  }finally{await rm(f.directory,{recursive:true,force:true});}
});
test('real client factory receives a lock check for every Drive mutation',async()=>{
  const f=await fixture({existing:true});let beforeMutation;
  f.deps.createDrive=options=>{beforeMutation=options.beforeMutation;return f.deps.drive;};
  try{
    await runNightly(f.payload,f.deps);assert.equal(typeof beforeMutation,'function');
    const before=f.events.length;await beforeMutation();assert.equal(f.events[before],'alive');
  }finally{await rm(f.directory,{recursive:true,force:true});}
});
test('pre-verification failure never invokes retention and redacts underlying exception',async t=>{
  for(const failAt of ['lock','target','find','capture','seal','alive','upload'])await t.test(failAt,async()=>{
    const f=await fixture({failAt});try{
      await assert.rejects(runNightly(f.payload,f.deps),error=>error.code==='RUN_FAILED'&&!String(error).includes(password));
      assert.equal(f.events.includes('retain'),false);
      if(failAt!=='lock')assert.equal(f.events.at(-1),'close');
    }finally{await rm(f.directory,{recursive:true,force:true});}
  });
});
test('mismatched upload hash prevents retention',async()=>{
  const f=await fixture({wrongReceipt:true});try{await assert.rejects(runNightly(f.payload,f.deps));assert.equal(f.events.includes('retain'),false);}
  finally{await rm(f.directory,{recursive:true,force:true});}
});
test('capture identity/midnight mismatch prevents encryption and upload',async()=>{
  for(const value of [{sourceProjectRef:'zyxwvutsrqponmlkjihg',source:{role:'eco_backup_reader',snapshot_time:now}},
    {sourceProjectRef:ref,source:{role:'postgres',snapshot_time:now}},
    {sourceProjectRef:ref,source:{role:'eco_backup_reader',snapshot_time:'2026-10-21T15:59:59.000Z'}}]){
    const f=await fixture();f.deps.capture=async()=>value;try{await assert.rejects(runNightly(f.payload,f.deps));assert.equal(f.events.includes('seal'),false);}
    finally{await rm(f.directory,{recursive:true,force:true});}
  }
});
test('manifest contains file integrity and rejects symlink plaintext',async()=>{
  const dir=await root('eco-nightly-manifest-test-');try{
    await writeFile(join(dir,'safe.bin'),'SYNTHETIC',{mode:0o600});
    const manifest=await writeManifest(dir,{synthetic:true});assert.equal(manifest.files[0].sha256,createHash('sha256').update('SYNTHETIC').digest('hex'));
    await rm(join(dir,'recovery-manifest.json'));await symlink('/etc/passwd',join(dir,'linked'));
    await assert.rejects(writeManifest(dir,{synthetic:true}));
  }finally{await rm(dir,{recursive:true,force:true});}
});

const jsonResponse=value=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
test('OAuth adapter sends refresh credential only to token endpoint and bearer only to Drive',async()=>{
  const calls=[];let clock=1000;
  const auth=createGoogleAuthorizedFetch({clientId:'id',clientSecret:'secret',refreshToken:'refresh',now:()=>clock,fetchImpl:async(url,options)=>{
    calls.push({url,options});if(url==='https://oauth2.googleapis.com/token')return jsonResponse({access_token:'fake-access-token',token_type:'Bearer',expires_in:3600,scope:'https://www.googleapis.com/auth/drive.file'});
    assert.equal(options.headers.get('authorization'),'Bearer fake-access-token');assert.equal(options.redirect,'error');return jsonResponse({ok:true});
  }});
  await auth('https://www.googleapis.com/drive/v3/about',{redirect:'error'});await auth('https://www.googleapis.com/drive/v3/files',{redirect:'error'});
  assert.equal(calls.filter(x=>x.url.includes('oauth2')).length,1);
  assert.match(calls[0].options.body,/refresh_token=refresh/);
  clock+=3600000;await auth('https://www.googleapis.com/drive/v3/about',{redirect:'error'});
  assert.equal(calls.filter(x=>x.url.includes('oauth2')).length,2);
  const before=calls.length;
  for(const [url,options]of[['https://attacker.example/drive/v3/about',{redirect:'error'}],['https://www.googleapis.com/not-drive',{redirect:'error'}],
    ['https://www.googleapis.com/drive/v3/about',{redirect:'follow'}],['https://www.googleapis.com/drive/v3/about',{redirect:'error',headers:{Authorization:'caller'}}]])await assert.rejects(auth(url,options));
  assert.equal(calls.length,before);
});
test('OAuth errors and broader Drive scope fail without provider secret leakage',async()=>{
  for(const result of [{access_token:'token',token_type:'Bearer',expires_in:3600,scope:'https://www.googleapis.com/auth/drive'},
    {access_token:'bad\nsecret',token_type:'Bearer',expires_in:3600},{access_token:'token',token_type:'Bearer',expires_in:1},
    {access_token:'token',token_type:'Bearer',expires_in:3600},
    {access_token:'token',token_type:'Bearer',expires_in:3600,scope:'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/gmail.readonly'},null]){
    const auth=createGoogleAuthorizedFetch({clientId:'id',clientSecret:password,refreshToken:password,fetchImpl:async()=>{
      if(!result)throw new Error(password);return jsonResponse(result);}});
    await assert.rejects(auth('https://www.googleapis.com/drive/v3/about',{redirect:'error'}),error=>!String(error).includes(password));
  }
});
test('OAuth adapter never replays a 401 upload body',async()=>{
  let requests=0;
  const auth=createGoogleAuthorizedFetch({clientId:'id',clientSecret:'secret',refreshToken:'refresh',fetchImpl:async url=>{
    if(url.includes('oauth2'))return jsonResponse({access_token:'token',token_type:'Bearer',expires_in:3600,scope:'https://www.googleapis.com/auth/drive.file'});requests++;return new Response('',{status:401});}});
  assert.equal((await auth('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable',{method:'PUT',redirect:'error',body:'ciphertext'})).status,401);
  assert.equal(requests,1);
});

async function fakeWorker(parent,mode){
  const file=join(parent,`worker-${mode}.mjs`);
  await writeFile(file,`import {readFile,writeFile,mkdir} from 'node:fs/promises';import{spawn}from'node:child_process';import{join}from'node:path';
let text='';for await(const x of process.stdin)text+=x;const input=JSON.parse(text);await mkdir(join(input.runDirectory,'plain'),{mode:0o700});await writeFile(join(input.runDirectory,'plain','data'),'SYNTHETIC_PRIVATE_DATA');process.stderr.write('SYNTHETIC_SECRET_DO_NOT_LOG');
const mode=${JSON.stringify(mode)};
if(mode==='success'){process.stdout.write(JSON.stringify({schemaVersion:1,verified:true,environment:Object.keys(process.env)}));}
else if(mode==='failure'){process.exitCode=7;}
else if(mode==='noisy'){process.stdout.write('x'.repeat(70000));setInterval(()=>{},1000);}
else {spawn(process.execPath,['-e',"require('fs').writeFileSync(process.argv[1],String(process.pid));setTimeout(()=>require('fs').writeFileSync(process.argv[2],'SURVIVED'),700);setInterval(()=>{},1000)",input.pidFile,input.markerFile],{stdio:'ignore'});setInterval(()=>{},1000);}
`,{mode:0o600});return file;
}
test('supervisor isolates environment and removes plaintext after worker success/failure/output overflow',async t=>{
  const parent=await root('eco-nightly-supervisor-test-');try{
    for(const mode of ['success','failure','noisy'])await t.test(mode,async()=>{
      const workerFile=await fakeWorker(parent,mode);
      process.env.ECO_SYNTHETIC_AMBIENT_SECRET=password;
      try{
        const promise=superviseWorker({payload:{secret:password},workParent:parent,timeoutMs:2000,workerFile});
        if(mode==='success'){const result=await promise;assert.equal(result.environment.includes('ECO_SYNTHETIC_AMBIENT_SECRET'),false);}
        else await assert.rejects(promise,error=>!String(error).includes(password));
        assert.equal((await readdir(parent)).some(name=>name.startsWith('eco-nightly-')),false);
      }finally{delete process.env.ECO_SYNTHETIC_AMBIENT_SECRET;}
    });
  }finally{await rm(parent,{recursive:true,force:true});}
});
test('timeout and cancellation kill worker descendants before private-directory cleanup',async t=>{
  const parent=await root('eco-nightly-interrupt-test-');try{
    for(const mode of ['timeout','signal'])await t.test(mode,async()=>{
      const workerFile=await fakeWorker(parent,mode),pidFile=join(parent,mode+'.pid'),markerFile=join(parent,mode+'.marker');
      const controller=new AbortController();let timer;
      if(mode==='signal')timer=setTimeout(()=>controller.abort(),250);
      try{await assert.rejects(superviseWorker({payload:{pidFile,markerFile},workParent:parent,timeoutMs:mode==='timeout'?250:2000,signal:controller.signal,workerFile}));}
      finally{clearTimeout(timer);}
      assert.equal(await exists(pidFile),true);
      await new Promise(resolve=>setTimeout(resolve,800));assert.equal(await exists(markerFile),false);
      assert.equal((await readdir(parent)).some(name=>name.startsWith('eco-nightly-')),false);
    });
  }finally{await rm(parent,{recursive:true,force:true});}
});
test('pre-cancelled worker is never started and allocated directory is removed',async()=>{
  const parent=await root('eco-nightly-preabort-test-'),controller=new AbortController();controller.abort();
  try{await assert.rejects(superviseWorker({payload:{},workParent:parent,timeoutMs:1000,signal:controller.signal}));assert.deepEqual(await readdir(parent),[]);}
  finally{await rm(parent,{recursive:true,force:true});}
});
test('public status never reports a hosted restore and contains no secret or source metadata',()=>{
  assert.doesNotMatch(publicStatus(true),/restore|table|row|email|SYNTHETIC/iu);
  assert.doesNotMatch(publicStatus(false),/SYNTHETIC/iu);
});
