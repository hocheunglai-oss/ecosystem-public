import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createNextcloudBackupClient, parseNextcloudFolder, classifyNextcloudBackupError,
  validateNextcloudConfiguration } from './nextcloud-backups.mjs';

const config = { origin:'https://nx123456.your-storageshare.de', expectedUser:'eco-backup', folder:'ECO', maxArchiveBytes:1024*1024 };
const password = 'SYNTHETIC_APP_PASSWORD_DO_NOT_LOG';
const snapshotAt = '2026-11-03T18:17:00.000Z';
const archive = Buffer.from('age-encryption.org/v1\nSYNTHETIC_ENCRYPTED_CONTENT');
const sha256 = createHash('sha256').update(archive).digest('hex');
const rootPath = '/remote.php/dav/files/eco-backup/';
const folderPath = rootPath + 'ECO/';
const name = `ECO-nightly-2026-11-04-${sha256}.tar.gz.age`;
const xml = (path=folderPath, owner='eco-backup') => Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns"><d:response><d:href>${path}</d:href><d:propstat><d:prop><d:resourcetype>${path.endsWith('/')?'<d:collection/>':''}</d:resourcetype><oc:owner-id>${owner}</oc:owner-id><nc:mount-type/><nc:is-mount-root>${path===rootPath?'true':'false'}</nc:is-mount-root><oc:share-types/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`);
const ocs = data => new Response(JSON.stringify({ocs:{meta:{status:'ok',statuscode:200},data}}), {headers:{'content-type':'application/json'}});
async function fixture(options={}) {
  const directory = await mkdtemp(join(tmpdir(),'eco-nextcloud-test-'));
  await chmod(directory,0o700);
  const archiveFile=join(directory,'backup.age');await writeFile(archiveFile,archive,{mode:0o600});
  const calls=[], files=new Map(), state={free:1024*1024,user:'eco-backup',groups:[],subadmin:[],outgoing:[],incoming:[],etag:'"v1"',...options};
  const fetchImpl = async (url, request) => {
    calls.push({url,method:request.method,headers:request.headers});
    assert.equal(new URL(url).origin, config.origin);
    assert.equal(request.redirect,'error');
    assert.equal(request.headers.Authorization,'Basic '+Buffer.from('eco-backup:'+password).toString('base64'));
    const intercepted=await state.intercept?.(url,request,{files,state,calls});if(intercepted)return intercepted;
    const path=new URL(url).pathname;
    if(path==='/ocs/v2.php/cloud/user')return ocs({id:state.user,groups:state.groups,subadmin:state.subadmin,quota:{free:state.free}});
    if(path==='/ocs/v2.php/apps/files_sharing/api/v1/shares')return ocs(url.includes('shared_with_me')?state.incoming:state.outgoing);
    if(request.method==='PROPFIND'){
      assert.equal(request.headers.Depth,'0');return new Response(state.xml?.(path)??xml(path),{status:207});
    }
    assert.equal(path,folderPath+name);
    if(request.method==='PUT'){
      assert.equal(request.headers['If-None-Match'],'*');
      if(files.has(path))return new Response(null,{status:412});
      const chunks=[];for await(const chunk of request.body)chunks.push(chunk);
      const bytes=Buffer.concat(chunks);assert.equal(String(bytes.length),request.headers['Content-Length']);
      files.set(path,bytes);return new Response(null,{status:201});
    }
    if(!files.has(path))return new Response(null,{status:404});
    const bytes=files.get(path);
    if(request.method==='HEAD')return new Response(null,{headers:{etag:state.etag,'content-length':String(bytes.length)}});
    assert.equal(request.method,'GET');assert.equal(request.headers['If-Match'],state.etag);
    return new Response(bytes,{headers:{etag:state.etag}});
  };
  const client=createNextcloudBackupClient({config,appPassword:password,fetchImpl,now:()=>new Date(snapshotAt),sleep:async()=>{},
    beforeMutation:async()=>{state.lockChecks=(state.lockChecks??0)+1;if(state.lockLost)throw new Error(password);},
    requestTimeoutMs:state.timeout??1000});
  return {client,calls,files,state,archiveFile,upload:()=>client.uploadAndVerify({archiveFile,snapshotAt,expectedSha256:sha256}),
    close:()=>rm(directory,{recursive:true,force:true})};
}
const rejectsCode = (promise,code) => assert.rejects(promise,error=>classifyNextcloudBackupError(error)===code&&!String(error).includes(password));

test('private destination pins reject alternate hosts, admin identities, paths and credential expansion',()=>{
  assert.doesNotThrow(()=>validateNextcloudConfiguration(config,password));
  for(const delta of [{origin:'http://nx123456.your-storageshare.de'},{origin:config.origin+'/'},{origin:config.origin+':444'},
    {origin:'https://evil.example'},{origin:'https://nx123456.your-storageshare.de@evil.example'},
    {expectedUser:'admin'},{expectedUser:'phonebook'},{folder:'../ECO'},{folder:'ECO/files'},
    {maxArchiveBytes:Infinity},{maxArchiveBytes:0},{privateKey:'forbidden'}])
    assert.throws(()=>validateNextcloudConfiguration({...config,...delta},password));
  for(const secret of ['',password+'\n','AGE-SECRET-KEY-1FORBIDDEN'])assert.throws(()=>validateNextcloudConfiguration(config,secret));
});
test('namespace-aware parser rejects ambiguous, unbounded and entity-bearing metadata',async()=>{
  assert.equal((await parseNextcloudFolder(xml())).ownerId,'eco-backup');
  const valid=xml().toString();
  for(const value of [Buffer.alloc(65537),Buffer.from(valid.replace('<oc:mount-type/>','')),
    Buffer.from(valid.replace('<nc:mount-type/>','')),Buffer.from(valid.replace('HTTP/1.1 200 OK','HTTP/1.1 404 Not Found')),
    Buffer.from(valid.replace('<oc:owner-id>','<oc:owner-id>x</oc:owner-id><oc:owner-id>')),
    Buffer.from(valid.replace('</d:multistatus>',valid.match(/<d:response>.*<\/d:response>/s)[0]+'</d:multistatus>')),
    Buffer.from('<!DOCTYPE d [<!ENTITY x "boom">]>'+valid),Buffer.from(valid,'utf16le'),
    Buffer.from(valid.replace('DAV:','urn:lookalike'))]) {
    if(value.equals(xml()))continue;
    await rejectsCode(parseNextcloudFolder(value),'NEXTCLOUD_METADATA_INVALID');
  }
});
test('uploads sealed bytes create-only and fully hashes readback with private account checks',async()=>{
  const f=await fixture();try{
    const receipt=await f.upload();
    assert.equal(receipt.verified,true);assert.equal(receipt.sha256,sha256);assert.equal(receipt.size,archive.length);
    assert.equal(receipt.snapshotAt,snapshotAt);assert.equal(receipt.reused,false);assert.equal(f.state.lockChecks,1);
    assert.deepEqual(f.files.get(folderPath+name),archive);
    assert.equal(f.calls.filter(x=>x.method==='GET'&&x.url.endsWith(name)).length,1);
    assert.equal(f.calls.filter(x=>x.url.includes('/cloud/user')).length,2);
    assert.ok(f.calls.every(x=>!['DELETE','MOVE','COPY','PATCH'].includes(x.method)));
  }finally{await f.close();}
});
test('same ciphertext is verified without upload or free-space requirement; corrupt copy never overwritten',async()=>{
  for(const corrupt of [false,true]){
    const f=await fixture({free:0});f.files.set(folderPath+name,corrupt?Buffer.from('corrupt'):archive);
    try{
      if(corrupt)await rejectsCode(f.upload(),'NEXTCLOUD_EXISTING_COPY_INVALID');
      else assert.equal((await f.upload()).reused,true);
      assert.equal(f.calls.some(x=>x.method==='PUT'),false);assert.equal(f.files.size,1);
    }finally{await f.close();}
  }
});
test('quota, identity, shares, mount and ownership errors prevent every upload',async()=>{
  const cases=[{free:0,code:'NEXTCLOUD_QUOTA_INSUFFICIENT'},{user:'other',code:'NEXTCLOUD_ACCOUNT_MISMATCH'},
    {groups:['admin'],code:'NEXTCLOUD_ACCOUNT_MISMATCH'},{subadmin:['team'],code:'NEXTCLOUD_ACCOUNT_MISMATCH'},
    {outgoing:[{id:1}],code:'NEXTCLOUD_ACCOUNT_SHARED'},{incoming:[{id:1}],code:'NEXTCLOUD_ACCOUNT_SHARED'},
    {xml:path=>xml(path,'other'),code:'NEXTCLOUD_FOLDER_NOT_PRIVATE'},
    {xml:path=>Buffer.from(xml(path).toString().replace('<nc:mount-type/>','<nc:mount-type>external</nc:mount-type>')),code:'NEXTCLOUD_FOLDER_NOT_PRIVATE'},
    {xml:path=>Buffer.from(xml(path).toString().replace('<nc:is-mount-root>false','<nc:is-mount-root>true')),code:'NEXTCLOUD_FOLDER_NOT_PRIVATE'}];
  for(const options of cases){const f=await fixture(options);try{await rejectsCode(f.upload(),options.code);assert.equal(f.calls.some(x=>x.method==='PUT'),false);}finally{await f.close();}}
});
test('normal personal root may report non-mount while a mounted archive is never accepted',async()=>{
  const f=await fixture({xml:path=>Buffer.from(xml(path).toString().replace('<nc:is-mount-root>true','<nc:is-mount-root>false'))});
  try{assert.equal((await f.upload()).verified,true);}finally{await f.close();}
  const mounted=await fixture({xml:path=>path.endsWith('.age')?Buffer.from(xml(path).toString().replace('<nc:is-mount-root>false','<nc:is-mount-root>true')):xml(path)});
  mounted.files.set(folderPath+name,archive);
  try{await rejectsCode(mounted.upload(),'NEXTCLOUD_FOLDER_NOT_PRIVATE');assert.equal(mounted.calls.some(x=>x.method==='PUT'),false);}
  finally{await mounted.close();}
});
test('readback detects corrupted bytes, size overflow, changed remote metadata and later sharing',async()=>{
  for(const variant of ['corrupt','overflow','changed','shared']){
    let reads=0,accounts=0;const f=await fixture({intercept:async(url,request,{state})=>{
      if(url.includes('/cloud/user')&&++accounts===2&&variant==='shared')state.outgoing=[{id:1}];
      if(url.endsWith(name)&&request.method==='GET'){
        reads++;if(variant==='corrupt')return new Response(Buffer.alloc(archive.length,42));
        if(variant==='overflow')return new Response(Buffer.alloc(archive.length+1));
        if(variant==='changed'){state.etag='"v2"';return new Response(archive);}
      }
    }});
    try{await assert.rejects(f.upload());assert.equal(reads,1);assert.equal(f.files.size,1);assert.equal(f.calls.some(x=>x.method==='DELETE'),false);}finally{await f.close();}
  }
});
test('lost upload response recovers only the committed exact ciphertext and never overwrites',async()=>{
  let puts=0;const f=await fixture({intercept:async(url,request,{files})=>{
    if(request.method!=='PUT')return;
    puts++;const chunks=[];for await(const chunk of request.body)chunks.push(chunk);files.set(folderPath+name,Buffer.concat(chunks));
    if(puts===1)throw new Error(password);return new Response(null,{status:412});
  }});
  try{assert.equal((await f.upload()).verified,true);assert.equal(puts,2);assert.equal(f.state.lockChecks,2);}finally{await f.close();}
});
test('final uncertain upload outcome is independently read back after all bounded attempts',async()=>{
  let puts=0;const f=await fixture({intercept:async(url,request,{files})=>{
    if(request.method!=='PUT')return;puts++;const chunks=[];for await(const chunk of request.body)chunks.push(chunk);
    files.set(folderPath+name,Buffer.concat(chunks));throw new Error(password);
  }});
  try{assert.equal((await f.upload()).verified,true);assert.equal(puts,3);}finally{await f.close();}
});
test('permanent authorization, redirect and lock failures never replay or expose provider details',async()=>{
  for(const status of [401,403,302]){
    let calls=0;const f=await fixture({intercept:async()=>{calls++;return new Response(password,{status,headers:{location:'https://evil.example'}});}});
    try{await rejectsCode(f.upload(),status===302?'NEXTCLOUD_REDIRECT_REJECTED':'NEXTCLOUD_AUTHORIZATION_FAILED');assert.equal(calls,1);}finally{await f.close();}
  }
  const f=await fixture({lockLost:true});try{await rejectsCode(f.upload(),'NEXTCLOUD_LOCK_LOST');assert.equal(f.files.size,0);}finally{await f.close();}
});
test('transient network errors retry boundedly and a stalled response body times out',async()=>{
  let calls=0;const f=await fixture({timeout:20,intercept:async()=>{calls++;return new Response(new ReadableStream({start(){}}),{headers:{'content-type':'application/json'}});}});
  try{await rejectsCode(f.upload(),'NEXTCLOUD_TIMEOUT');assert.equal(calls,3);}finally{await f.close();}
});
test('unsafe local files are rejected before any destination connection',async()=>{
  const f=await fixture();try{
    await chmod(f.archiveFile,0o644);await rejectsCode(f.upload(),'NEXTCLOUD_LOCAL_ARCHIVE_INVALID');await chmod(f.archiveFile,0o600);
    const link=f.archiveFile+'.age';await symlink(f.archiveFile,link);
    await rejectsCode(f.client.uploadAndVerify({archiveFile:link,snapshotAt,expectedSha256:sha256}),'NEXTCLOUD_LOCAL_ARCHIVE_INVALID');
    await rejectsCode(f.client.uploadAndVerify({archiveFile:f.archiveFile,snapshotAt,expectedSha256:'0'.repeat(64)}),'NEXTCLOUD_LOCAL_ARCHIVE_INVALID');
    assert.equal(f.calls.length,0);
  }finally{await f.close();}
});
