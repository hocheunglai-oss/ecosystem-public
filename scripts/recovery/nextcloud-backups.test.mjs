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
const ledgerBase=folderPath+'ECO-ledger-v1/';
const pairFolder=ledgerBase+'pairs/2026/';
const eventFolder=ledgerBase+'events/2026/11/';
const trashPath = '/remote.php/dav/trashbin/eco-backup/trash/';
const restorePath = '/remote.php/dav/trashbin/eco-backup/restore/';
const name = `ECO-nightly-2026-11-04-${sha256}.tar.gz.age`;
const xml = (path=folderPath, owner='eco-backup') => Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns"><d:response><d:href>${path}</d:href><d:propstat><d:prop><d:resourcetype>${path.endsWith('/')?'<d:collection/>':''}</d:resourcetype><oc:owner-id>${owner}</oc:owner-id><nc:mount-type/><nc:is-mount-root>${path===rootPath?'true':'false'}</nc:is-mount-root><oc:share-types/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`);
const ocs = data => new Response(JSON.stringify({ocs:{meta:{status:'ok',statuscode:200},data}}), {headers:{'content-type':'application/json'}});
const responsePart = value => value.toString().match(/<d:response>.*<\/d:response>/s)[0];
const multi = rows => '<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">'+rows.join('')+'</d:multistatus>';
function trashXml(items) {
  const properties=['oc:fileid','d:getetag','d:getcontentlength','nc:trashbin-filename','nc:trashbin-original-location','nc:trashbin-deletion-time'];
  const root=`<d:response><d:href>${trashPath}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop>${properties.map(x=>`<${x}/>`).join('')}</d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>`;
  return multi([root,...items.map(item=>`<d:response><d:href>${item.path}</d:href><d:propstat><d:prop><d:resourcetype/><oc:fileid>${item.id}</oc:fileid><d:getetag>${item.deletionTime}</d:getetag><d:getcontentlength>${item.bytes.length}</d:getcontentlength><nc:trashbin-filename>${item.name}</nc:trashbin-filename><nc:trashbin-original-location>${item.location}</nc:trashbin-original-location><nc:trashbin-deletion-time>${item.deletionTime}</nc:trashbin-deletion-time></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`)]);
}
async function fixture(options={}) {
  const directory = await mkdtemp(join(tmpdir(),'eco-nextcloud-test-'));
  await chmod(directory,0o700);
  const archiveFile=join(directory,'backup.age');await writeFile(archiveFile,archive,{mode:0o600});
  const calls=[], files=new Map(), trash=new Map(), ids=new Map(),folders=new Set([rootPath,folderPath]);let nextId=100;
  const state={free:499*1024**3,used:1024**3,total:500*1024**3,quota:500*1024**3,
    user:'eco-backup',groups:[],subadmin:[],outgoing:[],incoming:[],etag:'"v1"',...options};
  const fileId=path=>{if(!ids.has(path))ids.set(path,String(nextId++));return ids.get(path);};
  const inventoryXml=path=>responsePart(state.xml?.(path)??xml(path)).replace('</d:prop>',
    `<oc:fileid>${fileId(path)}</oc:fileid><d:getetag>${state.etag}</d:getetag><d:getcontentlength>${files.get(path)?.length??0}</d:getcontentlength></d:prop>`);
  const fetchImpl = async (url, request) => {
    calls.push({url,method:request.method,headers:request.headers});
    assert.equal(new URL(url).origin, config.origin);
    assert.equal(request.redirect,'error');
    assert.equal(request.headers.Authorization,'Basic '+Buffer.from('eco-backup:'+password).toString('base64'));
    const intercepted=await state.intercept?.(url,request,{files,trash,ids,folders,state,calls});if(intercepted)return intercepted;
    const path=new URL(url).pathname;
    if(path==='/ocs/v2.php/cloud/user')return ocs({id:state.user,groups:state.groups,subadmin:state.subadmin,
      quota:{free:state.free,used:state.used,total:state.total,quota:state.quota}});
    if(path==='/ocs/v2.php/apps/files_sharing/api/v1/shares')return ocs(url.includes('shared_with_me')?state.incoming:state.outgoing);
    if(request.method==='PROPFIND'){
      if(path===trashPath){assert.equal(request.headers.Depth,'1');return new Response(trashXml([...trash.values()]),{status:207});}
      if(!folders.has(path)&&!files.has(path))return new Response(null,{status:404});
      if(String(request.body).includes('<oc:fileid/>')){
        const paths=request.headers.Depth==='1'?[path,...[...files.keys(),...folders]
          .filter(key=>key!==path&&key.startsWith(path)&&!key.slice(path.length).replace(/\/$/u,'').includes('/'))]:[path];
        return new Response(multi(paths.map(inventoryXml)),{status:207});
      }
      assert.equal(request.headers.Depth,'0');return new Response(state.xml?.(path)??xml(path),{status:207});
    }
    if(request.method==='MKCOL'){
      assert.ok(path.startsWith(ledgerBase)&&path.endsWith('/'));
      assert.ok(folders.has(path.slice(0,-1).slice(0,path.slice(0,-1).lastIndexOf('/')+1)));
      if(folders.has(path))return new Response(null,{status:405});
      folders.add(path);return new Response(null,{status:201});
    }
    if(path.startsWith(trashPath)){
      const item=trash.get(path);if(!item)return new Response(null,{status:404});
      assert.notEqual(request.method,'DELETE','trash DELETE would be permanent');
      if(request.method==='MOVE'){
        assert.equal(request.headers.Destination,config.origin+restorePath+path.slice(trashPath.length));
        assert.equal(request.headers.Overwrite,'T');assert.equal(request.headers['If-Match'],'*');
        const original=rootPath+item.location;
        if(files.has(original))return new Response(null,{status:412});
        files.set(original,item.bytes);trash.delete(path);return new Response(null,{status:201});
      }
      if(request.method==='HEAD')return new Response(null,{headers:{etag:'','content-length':String(item.bytes.length)}});
      assert.equal(request.method,'GET');assert.equal(request.headers['If-Match'],'*');
      return new Response(item.bytes,{headers:{etag:item.deletionTime}});
    }
    assert.ok(path.startsWith(folderPath));
    if(request.method==='PUT'){
      assert.equal(request.headers['If-None-Match'],'*');
      if(files.has(path))return new Response(null,{status:412});
      const chunks=[];if(!Buffer.isBuffer(request.body))for await(const chunk of request.body)chunks.push(chunk);
      const bytes=Buffer.isBuffer(request.body)?request.body:Buffer.concat(chunks);assert.equal(String(bytes.length),request.headers['Content-Length']);
      files.set(path,bytes);return new Response(null,{status:201});
    }
    if(!files.has(path))return new Response(null,{status:404});
    const bytes=files.get(path);
    if(request.method==='DELETE'){
      assert.equal(request.headers['If-Match'],state.etag);
      const originalName=path.slice(folderPath.length), deletionTime=Math.floor(Date.parse(snapshotAt)/1000);
      const item={path:trashPath+originalName+'.d'+deletionTime,name:originalName,location:'ECO/'+originalName,
        deletionTime:String(deletionTime),id:String(nextId++),bytes};
      trash.set(item.path,item);files.delete(path);return new Response(null,{status:204});
    }
    if(request.method==='HEAD')return new Response(null,{headers:{etag:state.etag,'content-length':String(bytes.length)}});
    assert.equal(request.method,'GET');assert.equal(request.headers['If-Match'],state.etag);
    return new Response(bytes,{headers:{etag:state.etag}});
  };
  const client=createNextcloudBackupClient({config,appPassword:password,fetchImpl,now:()=>new Date(state.now??snapshotAt),sleep:async()=>{},
    beforeMutation:async()=>{state.lockChecks=(state.lockChecks??0)+1;if(state.lockLost)throw new Error(password);},
    requestTimeoutMs:state.timeout??1000});
  return {client,calls,files,trash,ids,folders,state,archiveFile,upload:()=>client.uploadAndVerify({archiveFile,snapshotAt,expectedSha256:sha256}),
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

const pairName = hash => `ECO-pair-v1-${hash}.json`;
const maintenanceName = hash => `ECO-maintenance-v1-${hash}.json`;
function seedLedger(f,name,value,base=pairFolder){
  const relative=base.slice(folderPath.length).split('/').filter(Boolean);let path=folderPath;
  for(const part of relative){path+=part+'/';f.folders.add(path);}
  f.files.set(base+name,Buffer.from(JSON.stringify(value)));
}
async function retentionFixture() {
  const f=await fixture(), points=[];
  for(let index=1;index<=15;index++){
    const bytes=Buffer.from(archive.toString()+' '+index),hash=createHash('sha256').update(bytes).digest('hex');
    const archiveName=`ECO-nightly-2026-10-${String(index).padStart(2,'0')}-${hash}.tar.gz.age`;
    f.files.set(folderPath+archiveName,bytes);
    points.push(await f.client.verifyForRetention({archiveName,sha256:hash,size:bytes.length}));
  }
  return {...f,candidateReceipt:points[0],retainedReceipts:points.slice(1),protectedHashes:[]};
}

test('private ledgers are immutable, collision-checked, and maintenance plans have a larger bounded body',async()=>{
  const f=await fixture();try{
    const ledger=pairName(sha256),value={schemaVersion:1,hash:sha256,snapshotAt};
    assert.equal(await f.client.readLedger(ledger,true),null);
    assert.deepEqual(await f.client.writeLedger(ledger,value),value);
    assert.deepEqual((await f.client.listPairReceipts()).map(x=>x.name),[ledger]);
    assert.deepEqual(await f.client.writeLedger(ledger,value),value);
    await rejectsCode(f.client.writeLedger(ledger,{schemaVersion:2}),'NEXTCLOUD_LEDGER_INVALID');
    assert.deepEqual(JSON.parse(f.files.get(pairFolder+ledger)),value);
    const big={text:'x'.repeat(70_000)};
    await rejectsCode(f.client.writeLedger(pairName('a'.repeat(64)),big),'NEXTCLOUD_LEDGER_INVALID');
    assert.deepEqual(await f.client.writeLedger(maintenanceName('b'.repeat(64)),big),big);
    await rejectsCode(f.client.writeLedger(maintenanceName('c'.repeat(64)),{text:'x'.repeat(1024*1024)}),'NEXTCLOUD_LEDGER_INVALID');
    const cycle={};cycle.self=cycle;await rejectsCode(f.client.writeLedger(ledger,cycle),'NEXTCLOUD_LEDGER_INVALID');
    assert.equal(f.calls.some(call=>['DELETE','MOVE'].includes(call.method)),false);
  }finally{await f.close();}
});

test('ledger readback rejects changed metadata, oversized content and misleading encoding',async()=>{
  const ledger=pairName(sha256);
  for(const variant of ['changed','overflow','encoding']){
    const f=await fixture({intercept:async(url,request,{state})=>{
      if(url.endsWith(ledger)&&request.method==='GET'){
        if(variant==='changed')state.etag='"changed"';
        return new Response(variant==='overflow'?Buffer.alloc(65537):'{}',
          {headers:variant==='encoding'?{'content-encoding':'gzip'}:{}});
      }
    }});seedLedger(f,ledger,{});
    try{await assert.rejects(f.client.readLedger(ledger));assert.equal(f.calls.some(call=>call.method==='PUT'),false);}
    finally{await f.close();}
  }
});

test('depth-one ledger inventory rejects incomplete, foreign, mounted and duplicate entries',async()=>{
  const ledger=pairName(sha256);
  for(const variant of ['owner','mount','duplicate','foreign','status','entity']){
    const f=await fixture({intercept:async(url,request)=>{
      if(request.method!=='PROPFIND'||request.headers.Depth!=='1')return;
      const row=responsePart(xml(pairFolder+ledger)).replace('</d:prop>',
        '<oc:fileid>501</oc:fileid><d:getetag>"v1"</d:getetag><d:getcontentlength>2</d:getcontentlength></d:prop>');
      const root=responsePart(xml(pairFolder)).replace('</d:prop>',
        '<oc:fileid>500</oc:fileid><d:getetag>"v1"</d:getetag><d:getcontentlength>0</d:getcontentlength></d:prop>');
      let body=multi([root,row]);
      if(variant==='owner')body=body.replace('<oc:owner-id>eco-backup','<oc:owner-id>other');
      if(variant==='mount')body=body.replace('<nc:mount-type/>','<nc:mount-type>external</nc:mount-type>');
      if(variant==='duplicate')body=multi([root,row,row]);
      if(variant==='foreign')body=body.replace(pairFolder+ledger,'/remote.php/dav/files/other/'+ledger);
      if(variant==='status')body=body.replace('HTTP/1.1 200 OK','HTTP/1.1 404 Not Found');
      if(variant==='entity')body='<!DOCTYPE a [<!ENTITY b "unsafe">]>'+body;
      return new Response(body,{status:207});
    }});seedLedger(f,ledger,{snapshotAt});
    try{await assert.rejects(f.client.listPairReceipts());assert.equal(f.calls.some(call=>call.method==='DELETE'),false);}
    finally{await f.close();}
  }
});

test('more than512 pair ledgers fails closed instead of silently skipping history',async()=>{
  const f=await fixture();try{
    for(let i=0;i<513;i++)seedLedger(f,pairName(i.toString(16).padStart(64,'0')),{snapshotAt});
    await rejectsCode(f.client.listPairReceipts(),'NEXTCLOUD_LEDGER_LIMIT');
    assert.equal(f.calls.some(call=>call.method==='GET'&&call.url.endsWith('.json')),false);
  }finally{await f.close();}
});

test('trash capability requires exact assigned500GiB, sufficient physical free space and valid trash listing',async()=>{
  for(const options of [{quota:undefined},{quota:501*1024**3},{total:499*1024**3},{free:100*1024**3-1},
    {used:401*1024**3},{intercept:async(url,request)=>request.method==='PROPFIND'&&url.endsWith('/trash/')?new Response(null,{status:404}):undefined}]){
    const f=await fixture(options);try{await assert.rejects(f.client.verifyTrashCapability());assert.equal(f.calls.some(call=>call.method==='DELETE'),false);}
    finally{await f.close();}
  }
  const f=await fixture();try{
    const proof=await f.client.verifyTrashCapability();assert.equal(proof.available,true);
    assert.equal(proof.providerAutomaticExpiryPossible,true);assert.equal(proof.permanentDeletionUsed,false);
  }finally{await f.close();}
});

test('synthetic canary proves full upload, trash GET, individual restore and original-path readback',async()=>{
  const f=await fixture();try{
    const proof=await f.client.runTrashCanary();
    assert.equal(proof.canary,true);assert.equal(proof.verified,true);assert.equal(proof.trashReadbackVerified,true);
    assert.equal(proof.permanentDeletionUsed,false);assert.equal(f.trash.size,0);
    assert.equal(f.files.size,1,'restored synthetic file remains protected');
    assert.ok(f.files.has(folderPath+proof.archiveName));
    assert.equal(f.state.lockChecks,3,'create, normal DELETE and restore MOVE all recheck lock');
    const mutations=f.calls.filter(call=>['PUT','DELETE','MOVE'].includes(call.method));
    assert.deepEqual(mutations.map(call=>call.method),['PUT','DELETE','MOVE']);
    assert.ok(mutations[1].url.startsWith(config.origin+folderPath));
    assert.ok(mutations[2].url.startsWith(config.origin+trashPath));
    assert.equal(f.calls.filter(call=>call.method==='GET'&&call.url.startsWith(config.origin+trashPath)).length,2);
  }finally{await f.close();}
});

test('ordinary archive metadata still rejects unquoted tags without weakening conditional deletion',async()=>{
  const f=await fixture({etag:'1793765820'});try{
    await rejectsCode(f.upload(),'NEXTCLOUD_METADATA_INVALID');
    assert.equal(f.calls.some(call=>['DELETE','MOVE'].includes(call.method)),false);
  }finally{await f.close();}
});

test('trash HEAD tags can be empty but must be present, bounded and stable independently of listing',async()=>{
  for(const variant of ['missing','changed-tag','changed-size','oversized']){
    let heads=0;
    const f=await fixture({intercept:async(url,request,{trash})=>{
      if(request.method!=='HEAD'||!url.startsWith(config.origin+trashPath))return;
      const item=trash.get(new URL(url).pathname);if(!item)return;heads++;
      return new Response(null,{headers:{...(variant==='missing'?{}:{etag:variant==='oversized'?'x'.repeat(257):
        variant==='changed-tag'?'opaque-'+heads:''}),
        'content-length':String(item.bytes.length+(variant==='changed-size'?1:0))}});
    }});
    try{await rejectsCode(f.client.runTrashCanary(),variant==='changed-tag'?'NEXTCLOUD_REMOTE_CHANGED':'NEXTCLOUD_TRASH_UNVERIFIED');
      assert.equal(f.calls.filter(call=>call.method==='DELETE').length,1);
      assert.equal(f.calls.some(call=>call.method==='MOVE'),false);assert.equal(f.trash.size,1);
    }finally{await f.close();}
  }
});

test('trash full readback detects changed identity, forged response tags and conditional failure without retry',async()=>{
  for(const variant of ['file-id','get-tag','get-numeric-tag','precondition']){
    let reads=0;
    const f=await fixture({intercept:async(url,request,{trash})=>{
      if(request.method!=='GET'||!url.startsWith(config.origin+trashPath))return;
      reads++;assert.equal(request.headers['If-Match'],'*','existence only; fake timestamp must not be sent');
      const item=trash.get(new URL(url).pathname);
      if(variant==='file-id'){item.id='999999';return;}
      if(variant==='get-tag'||variant==='get-numeric-tag')return new Response(item.bytes,
        {headers:{etag:variant==='get-tag'?'forged':String(Number(item.deletionTime)+1)}});
      return new Response(null,{status:412});
    }});
    try{await rejectsCode(f.client.runTrashCanary(),variant==='file-id'?'NEXTCLOUD_REMOTE_CHANGED':
      variant.startsWith('get-')?'NEXTCLOUD_TRASH_UNVERIFIED':'NEXTCLOUD_HTTP_FAILED');
      assert.equal(reads,1);assert.equal(f.calls.some(call=>call.method==='MOVE'),false);assert.equal(f.trash.size,1);
    }finally{await f.close();}
  }
});

test('verified cleanup preserves retained points and confirms exact ciphertext in provider trash',async()=>{
  const f=await retentionFixture();try{
    let called=0;
    const receipt=await f.client.trashVerified({...f,beforeDelete:async()=>{called++;}});
    assert.equal(called,1);assert.equal(receipt.recoverable,true);assert.equal(receipt.sha256,f.candidateReceipt.sha256);
    assert.equal(f.files.size,14);assert.equal(f.trash.size,1);
    assert.equal(f.calls.filter(call=>call.method==='DELETE').length,1);
    assert.ok(f.retainedReceipts.every(point=>f.files.has(folderPath+point.archiveName)));
    const result=await f.client.restoreTrashed({trashReceipt:receipt});
    assert.equal(result.verified,true);assert.equal(f.files.size,15);assert.equal(f.trash.size,0);
    await rejectsCode(f.client.restoreTrashed({trashReceipt:receipt}),'NEXTCLOUD_RESTORE_UNVERIFIED');
    await rejectsCode(f.client.assertRetentionReceipt(f.candidateReceipt),'NEXTCLOUD_RETENTION_UNVERIFIED');
  }finally{await f.close();}
});

test('cleanup requires minted distinct points and mandatory durable-intent callback, with rechecks afterward',async()=>{
  const f=await retentionFixture();try{
    for(const input of [
      {...f,beforeDelete:undefined}, {...f,candidateReceipt:{...f.candidateReceipt},beforeDelete:async()=>{}},
      {...f,protectedHashes:undefined,beforeDelete:async()=>{}},
      {...f,protectedHashes:[f.candidateReceipt.sha256],beforeDelete:async()=>{}},
      {...f,retainedReceipts:Array(14).fill(f.retainedReceipts[0]),beforeDelete:async()=>{}},
      {...f,retainedReceipts:f.retainedReceipts.slice(1),beforeDelete:async()=>{}},
    ])await rejectsCode(f.client.trashVerified(input),'NEXTCLOUD_RETENTION_UNVERIFIED');
    const path=folderPath+f.retainedReceipts[0].archiveName;
    await rejectsCode(f.client.trashVerified({...f,beforeDelete:async()=>{f.ids.set(path,'999999');}}),'NEXTCLOUD_REMOTE_CHANGED');
    assert.equal(f.calls.some(call=>call.method==='DELETE'),false);
  }finally{await f.close();}
});

test('lost DELETE responses are never replayed and uncertain ciphertext is preserved in trash',async()=>{
  let deletes=0;
  const f=await fixture({intercept:async(url,request,{files,trash})=>{
    if(request.method!=='DELETE')return;deletes++;
    const path=new URL(url).pathname,bytes=files.get(path),originalName=path.slice(folderPath.length);
    const deletionTime=String(Math.floor(Date.parse(snapshotAt)/1000)),item={path:trashPath+originalName+'.d'+deletionTime,
      name:originalName,location:'ECO/'+originalName,deletionTime,id:'9988',bytes};
    trash.set(item.path,item);files.delete(path);throw new Error(password);
  }});
  try{await rejectsCode(f.client.runTrashCanary(),'NEXTCLOUD_REQUEST_FAILED');assert.equal(deletes,1);assert.equal(f.trash.size,1);}
  finally{await f.close();}
});

test('a lost restore response is never replayed and preserves the already-restored synthetic file',async()=>{
  let moves=0;
  const f=await fixture({intercept:async(url,request,{files,trash})=>{
    if(request.method!=='MOVE')return;moves++;
    const path=new URL(url).pathname,item=trash.get(path);assert.ok(item);
    assert.equal(request.headers['If-Match'],'*');assert.equal(request.headers.Overwrite,'T');
    files.set(rootPath+item.location,item.bytes);trash.delete(path);throw Error(password);
  }});
  try{await rejectsCode(f.client.runTrashCanary(),'NEXTCLOUD_REQUEST_FAILED');
    assert.equal(moves,1);assert.equal(f.trash.size,0);assert.equal(f.files.size,1);
    assert.equal(f.calls.filter(call=>call.method==='DELETE').length,1);
  }finally{await f.close();}
});

test('corrupt trash readback or changed original location prevents a recoverable receipt and restore',async()=>{
  for(const variant of ['bytes','location','duplicate']){
    const f=await fixture({intercept:async(url,request,{trash})=>{
      if(request.method==='GET'&&url.startsWith(config.origin+trashPath)&&variant==='bytes')return new Response('corrupt');
      if(request.method==='PROPFIND'&&url.endsWith('/trash/')&&trash.size&&variant!=='bytes'){
        const items=[...trash.values()].map(item=>({...item,location:variant==='location'?'OTHER/'+item.name:item.location}));
        if(variant==='duplicate')items.push({...items[0],path:items[0].path+'0'});
        return new Response(trashXml(items),{status:207});
      }
    }});
    try{await assert.rejects(f.client.runTrashCanary());assert.equal(f.trash.size,1);
      assert.equal(f.calls.some(call=>call.method==='MOVE'),false);}
    finally{await f.close();}
  }
});

test('restore fails closed on existing original path and never overwrites that file',async()=>{
  const f=await fixture({intercept:async(url,request,{files,trash})=>{
    if(request.method==='HEAD'&&url.startsWith(config.origin+folderPath)&&trash.size){
      const item=[...trash.values()][0];
      // Only introduce the competing file after the deleted source absence was established.
      if(f.calls.some(call=>call.method==='GET'&&call.url.startsWith(config.origin+trashPath)))files.set(rootPath+item.location,Buffer.from('KEEP'));
    }
  }});
  try{await rejectsCode(f.client.runTrashCanary(),'NEXTCLOUD_RESTORE_UNVERIFIED');
    assert.equal(f.calls.some(call=>call.method==='MOVE'),false);assert.equal(f.files.size,1);assert.equal(f.trash.size,1);}
  finally{await f.close();}
});

test('a concurrent restore collision is preserved and cannot be reported as an exact restoration',async()=>{
  let savedOriginal,savedRestored;
  const f=await fixture({intercept:async(url,request,{files,trash})=>{
    if(request.method!=='MOVE')return;
    assert.equal(request.headers.Overwrite,'T','only the virtual restore route uses this provider flag');
    const path=new URL(url).pathname,item=trash.get(path);
    savedOriginal=rootPath+item.location;savedRestored=savedOriginal+' (restored)';
    // Model the provider choosing a unique restored name after a late collision.
    files.set(savedOriginal,Buffer.from('KEEP CONCURRENT FILE'));
    files.set(savedRestored,item.bytes);trash.delete(path);
    return new Response(null,{status:201});
  }});
  try{await rejectsCode(f.client.runTrashCanary(),'NEXTCLOUD_CHECKSUM_MISMATCH');
    assert.equal(f.files.get(savedOriginal).toString(),'KEEP CONCURRENT FILE');
    assert.equal(f.files.get(savedRestored).length,163);
    assert.equal(f.calls.filter(call=>call.method==='MOVE').length,1);
    assert.equal(f.calls.filter(call=>call.method==='DELETE').length,1);
  }finally{await f.close();}
});

test('ledger partitions use HK year and month at the Dec31 UTC boundary, with private create-only parents',async()=>{
  const boundary='2026-12-31T16:00:00.000Z',before='2026-12-31T15:59:59.000Z';
  const f=await fixture({now:boundary});try{
    const oldName=pairName('1'.repeat(64)),newName=pairName('2'.repeat(64)),event=maintenanceName('3'.repeat(64));
    await f.client.writeLedger(oldName,{snapshotAt:before},before);
    await f.client.writeLedger(newName,{snapshotAt:boundary},boundary);
    await f.client.writeLedger(event,{kind:'intent'},boundary);
    assert.ok(f.files.has(ledgerBase+'pairs/2026/'+oldName));
    assert.ok(f.files.has(ledgerBase+'pairs/2027/'+newName));
    assert.ok(f.files.has(ledgerBase+'events/2027/01/'+event));
    assert.equal((await f.client.readLedger(newName,false,boundary)).value.snapshotAt,boundary);
    const pairs=await f.client.listPairReceipts();
    assert.deepEqual(pairs.map(item=>item.year),['2027','2026']);
    const creates=f.calls.filter(call=>call.method==='MKCOL');
    assert.equal(creates.length,7);assert.equal(new Set(creates.map(call=>call.url)).size,7);
    assert.equal(f.calls.some(call=>call.method==='DELETE'),false);
    await rejectsCode(f.client.writeLedger(newName,{},'2027/../01'),'NEXTCLOUD_LEDGER_INVALID');
  }finally{await f.close();}
});

test('only three HK calendar-year partitions are read, with four concurrent bounded file readbacks',async()=>{
  let active=0,peak=0;
  const f=await fixture({now:'2026-12-31T16:00:00.000Z',intercept:async(url,request,{files})=>{
    if(request.method==='GET'&&url.includes('/pairs/')){
      active++;peak=Math.max(peak,active);
      try{await new Promise(resolve=>setTimeout(resolve,15));return new Response(files.get(new URL(url).pathname));}
      finally{active--;}
    }
  }});
  try{
    for(const year of [2024,2025,2026,2027])for(let index=0;index<4;index++){
      const snapshot=`${year}-01-02T00:00:00.000Z`,hash=createHash('sha256').update(snapshot+index).digest('hex');
      seedLedger(f,pairName(hash),{snapshotAt:snapshot},ledgerBase+`pairs/${year}/`);
    }
    const results=await f.client.listPairReceipts();assert.equal(results.length,12);
    assert.equal(f.calls.some(call=>call.url.includes('/pairs/2024/')),false);
    assert.ok(peak>1&&peak<=4);assert.equal(active,0);
    assert.equal(f.calls.filter(call=>call.url.includes('/cloud/user')).length,2);
    assert.equal(f.files.size,16,'older partitions remain untouched');
    assert.equal(f.calls.some(call=>['PUT','MKCOL','DELETE','MOVE'].includes(call.method)),false);
  }finally{await f.close();}
});

test('a pair receipt relocated into a different HK-year partition is rejected',async()=>{
  const f=await fixture();try{
    seedLedger(f,pairName(sha256),{snapshotAt:'2025-01-02T00:00:00.000Z'});
    await rejectsCode(f.client.listPairReceipts(),'NEXTCLOUD_LEDGER_INVALID');
  }finally{await f.close();}
});

test('shared or mounted ledger parents prevent writes, and uncertain MKCOL is not replayed',async()=>{
  const f=await fixture({xml:path=>path===ledgerBase?xml(path,'other'):xml(path)});
  f.folders.add(ledgerBase);
  try{await rejectsCode(f.client.writeLedger(pairName(sha256),{snapshotAt}),'NEXTCLOUD_FOLDER_NOT_PRIVATE');
    assert.equal(f.calls.some(call=>['MKCOL','PUT'].includes(call.method)),false);}
  finally{await f.close();}
  let creates=0;
  const lost=await fixture({intercept:async(url,request,{folders})=>{
    if(request.method==='MKCOL'){creates++;folders.add(new URL(url).pathname);throw Error(password);}
  }});
  try{await rejectsCode(lost.client.writeLedger(pairName(sha256),{snapshotAt}),'NEXTCLOUD_REQUEST_FAILED');
    assert.equal(creates,1);assert.ok(lost.folders.has(ledgerBase));assert.equal(lost.files.size,0);}
  finally{await lost.close();}
});
