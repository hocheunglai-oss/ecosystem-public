import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/check-public-source.mjs',import.meta.url));
const env = {PATH:process.env.PATH,LANG:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'};
type Finding={path:string;rule:string};
async function repository(run:(root:string,git:(...args:string[])=>Promise<void>)=>Promise<void>){
 const parent=await mkdtemp(join(tmpdir(),'eco-public-source-guard-')),root=join(parent,'repository');
 await mkdir(root);
 const git=async(...args:string[])=>{await exec('git',args,{cwd:root,env});};
 try{await git('init','--quiet');await run(root,git);}finally{await rm(parent,{recursive:true,force:true});}
}
async function put(root:string,path:string,content:string){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),content);}
async function scan(root:string){
 let stdout='',stderr='',code=0;
 try{const r=await exec(process.execPath,[script],{cwd:root,env});stdout=r.stdout;stderr=r.stderr;}
 catch(error){const r=error as {code:number;stdout:string;stderr:string};code=r.code;stdout=r.stdout;stderr=r.stderr;}
 assert.equal(stderr,'','The scanner must not expose file contents or raw read errors.');
 const report=JSON.parse(stdout) as {checkedFiles:number;findings:Finding[]};
 assert.deepEqual(Object.keys(report).sort(),['checkedFiles','findings']);
 for(const item of report.findings)assert.deepEqual(Object.keys(item).sort(),['path','rule']);
 return {code,report,stdout};
}
const approvedContact=['otto','cosulich.com.hk'].join('@');
const privateContact=['private-fixture','cosulich.com.hk'].join('@');
const syntheticSecret=['sb','secret'].join('_')+'_'+'synthetic'.repeat(6);

test('public source guard admits ordinary source, placeholders and only the existing public privacy contact',async()=>{
 await repository(async(root,git)=>{
  await put(root,'README.md','# Synthetic public application\n');
  await put(root,'src/app.ts','export const ready = true;');
  await put(root,'.env.example','OPENAI_API_KEY=\nECO_SUPABASE_SECRET_KEY=\n');
  for(const path of ['public/privacy.html','tests/privacy-page.test.ts','tests/privacy-page.e2e.mjs'])await put(root,path,`Public privacy contact: ${approvedContact}`);
  await git('add','.');
  const {code,report}=await scan(root);assert.equal(code,0);assert.equal(report.checkedFiles,6);assert.deepEqual(report.findings,[]);
 });
});

test('credential scanning rejects both tracked source and untracked .env.example without logging values',async()=>{
 await repository(async(root,git)=>{
  await put(root,'src/client.ts',`export const forbidden = '${syntheticSecret}';`);await git('add','src/client.ts');
  const openAi=['sk','proj'].join('-')+'-'+'synthetic'.repeat(7);
  await put(root,'.env.example',`OPENAI_API_KEY=${openAi}\n`);
  const legacy=['eyJhbGciOiJIUzI1NiJ9',Buffer.from(JSON.stringify({role:'service_role'})).toString('base64url'),'synthetic-signature'].join('.');
  await put(root,'src/legacy.json',JSON.stringify({credential:legacy}));
  const {code,report,stdout}=await scan(root);assert.equal(code,1);
  assert.ok(report.findings.some(f=>f.path==='src/client.ts'&&f.rule==='supabase-secret-key'));
  assert.ok(report.findings.some(f=>f.path==='.env.example'&&f.rule==='openai-key'));
  assert.ok(report.findings.some(f=>f.path==='src/legacy.json'&&f.rule==='legacy-service-role-token'));
  for(const value of [syntheticSecret,openAi,legacy])assert.ok(!stdout.includes(value));
 });
});

test('private business snapshot and operational document paths fail even when their contents contain no secret pattern',async()=>{
 await repository(async(root,git)=>{
  const paths=['src/data/intelligence-snapshot.json','src/data/supplier-fixture-counts.json','docs/email-receiver-operations.md','docs/whatsapp-intake-operations.md','docs/backup-recovery-status-2026-01-01.md','docs/production-security-operations.md','local/receipt.private.json','.env.local'];
  for(const path of paths)await put(root,path,'Synthetic private operational evidence');
  await git('add','.');const {code,report}=await scan(root);assert.equal(code,1);
  assert.deepEqual(new Set(report.findings.map(f=>f.path)),new Set(paths));
  assert.ok(report.findings.every(f=>f.rule==='private-source-path'));
 });
});

test('privacy contact exception cannot admit a roster or allow the public contact in unrelated source',async()=>{
 await repository(async(root)=>{
  for(const path of ['public/privacy.html','tests/privacy-page.test.ts','tests/privacy-page.e2e.mjs'])await put(root,path,`${approvedContact}\n${privateContact}`);
  await put(root,'src/config.ts',`const contact = '${approvedContact}';`);
  const {code,report,stdout}=await scan(root);assert.equal(code,1);assert.equal(report.findings.length,4);
  assert.ok(report.findings.every(f=>f.rule==='private-directory-contact'));
  assert.ok(!stdout.includes(approvedContact)&&!stdout.includes(privateContact));
 });
});

test('ignored local evidence stays out of public scope, while force-tracked artifacts are rejected',async()=>{
 await repository(async(root,git)=>{
  await put(root,'.gitignore','output/\n.env.local\n');await put(root,'output/evidence.txt',syntheticSecret);await put(root,'.env.local',syntheticSecret);
  assert.deepEqual((await scan(root)).report.findings,[]);
  await git('add','--force','output/evidence.txt');const {code,report}=await scan(root);assert.equal(code,1);
  assert.ok(report.findings.some(f=>f.path==='output/evidence.txt'&&f.rule==='private-source-path'));
  assert.equal(report.findings.some(f=>f.path==='.env.local'),false);
 });
});

test('leaf, broken and replaced-parent symlinks are rejected before reading their targets',async()=>{
 await repository(async(root,git)=>{
  const external=join(dirname(root),'private-target');await mkdir(external);await writeFile(join(external,'value.ts'),syntheticSecret);
  await symlink(join(external,'value.ts'),join(root,'linked.ts'));
  await symlink(join(external,'missing.ts'),join(root,'broken.ts'));
  await put(root,'tracked/value.ts','export const safe = true;');await git('add','tracked/value.ts');
  await rm(join(root,'tracked'),{recursive:true});await symlink(external,join(root,'tracked'));
  const {code,report,stdout}=await scan(root);assert.equal(code,1);
  for(const path of ['linked.ts','broken.ts','tracked/value.ts'])assert.ok(report.findings.some(f=>f.path===path&&f.rule==='source-symlink'));
  assert.ok(report.findings.every(f=>f.rule==='source-symlink'),'No credential rule means the external target was never read.');
  assert.ok(!stdout.includes(syntheticSecret)&&!stdout.includes(external));
 });
});
