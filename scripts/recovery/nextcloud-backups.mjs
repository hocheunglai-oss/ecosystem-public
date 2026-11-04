/** Private Storage Share copy. No permanent deletion or overwrite operations. */
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { hongKongNight } from './drive-backups.mjs';

const AGE_HEADER = 'age-encryption.org/v1\n';
const HASH = /^[a-f0-9]{64}$/u;
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
export const NEXTCLOUD_DIAGNOSTIC_CODES = Object.freeze([
  'NEXTCLOUD_CONFIGURATION_INVALID', 'NEXTCLOUD_ACCOUNT_MISMATCH', 'NEXTCLOUD_ACCOUNT_SHARED',
  'NEXTCLOUD_FOLDER_NOT_PRIVATE', 'NEXTCLOUD_METADATA_INVALID', 'NEXTCLOUD_HTTP_FAILED',
  'NEXTCLOUD_AUTHORIZATION_FAILED', 'NEXTCLOUD_REQUEST_FAILED', 'NEXTCLOUD_REDIRECT_REJECTED',
  'NEXTCLOUD_TIMEOUT', 'NEXTCLOUD_QUOTA_INSUFFICIENT', 'NEXTCLOUD_LOCAL_ARCHIVE_INVALID',
  'NEXTCLOUD_LOCAL_ARCHIVE_CHANGED', 'NEXTCLOUD_REMOTE_CHANGED', 'NEXTCLOUD_CHECKSUM_MISMATCH',
  'NEXTCLOUD_LOCK_LOST', 'NEXTCLOUD_EXISTING_COPY_INVALID',
  'NEXTCLOUD_LEDGER_INVALID', 'NEXTCLOUD_LEDGER_LIMIT', 'NEXTCLOUD_RETENTION_UNVERIFIED',
  'NEXTCLOUD_TRASH_UNAVAILABLE', 'NEXTCLOUD_TRASH_UNVERIFIED', 'NEXTCLOUD_RESTORE_UNVERIFIED',
]);
const codes = new Set(NEXTCLOUD_DIAGNOSTIC_CODES);
export class NextcloudBackupError extends Error {
  constructor(code) { super('Encrypted secondary backup did not complete.'); this.code = code; }
}
const fail = code => { throw new NextcloudBackupError(code); };
const check = (value, code) => { if (!value) fail(code); };
export function classifyNextcloudBackupError(error) {
  try { return error instanceof NextcloudBackupError && codes.has(error.code) ? error.code : null; }
  catch { return null; }
}
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
export function validateNextcloudConfiguration(config, appPassword) {
  check(exact(config, ['origin','expectedUser','folder','maxArchiveBytes']), 'NEXTCLOUD_CONFIGURATION_INVALID');
  let url; try { url = new URL(config.origin); } catch { fail('NEXTCLOUD_CONFIGURATION_INVALID'); }
  check(url.origin === config.origin && url.protocol === 'https:' && !url.port && !url.username && !url.password
    && /^nx[0-9]+\.your-storageshare\.de$/u.test(url.hostname)
    && typeof config.expectedUser === 'string' && /^eco-backup(?:-[a-z0-9]+)*$/u.test(config.expectedUser)
    && typeof config.folder === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(config.folder)
    && Number.isSafeInteger(config.maxArchiveBytes) && config.maxArchiveBytes > AGE_HEADER.length
    && config.maxArchiveBytes <= 8 * 1024 ** 3
    && typeof appPassword === 'string' && appPassword.length > 0 && appPassword.length <= 4096
    && !/[\r\n\0]/u.test(appPassword) && !appPassword.includes('AGE-SECRET-KEY-1'), 'NEXTCLOUD_CONFIGURATION_INVALID');
}
const abortRace = (promise, signal) => new Promise((resolve, reject) => {
  const abort = () => { cleanup(); reject(new NextcloudBackupError('NEXTCLOUD_TIMEOUT')); };
  const cleanup = () => signal.removeEventListener('abort', abort);
  if (signal.aborted) return abort();
  signal.addEventListener('abort', abort, { once: true });
  Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
});
async function consume(response, signal, maxBytes, hash = false) {
  check(response.body && typeof response.body.getReader === 'function', 'NEXTCLOUD_METADATA_INVALID');
  const reader = response.body.getReader(), chunks = [], digest = hash ? createHash('sha256') : null;
  let size = 0;
  try {
    for (;;) {
      const chunk = await abortRace(reader.read(), signal); if (chunk.done) break;
      size += chunk.value.byteLength; check(size <= maxBytes, hash ? 'NEXTCLOUD_CHECKSUM_MISMATCH' : 'NEXTCLOUD_METADATA_INVALID');
      if (digest) digest.update(chunk.value); else chunks.push(chunk.value);
    }
    return digest ? { size, sha256: digest.digest('hex') } : Buffer.concat(chunks);
  } finally {
    void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* Abort also releases native transport. */ }
  }
}
export async function parseNextcloudFolder(xml) {
  check(Buffer.isBuffer(xml) && xml.length <= 65_536, 'NEXTCLOUD_METADATA_INVALID');
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', ['-I', fileURLToPath(new URL('./nextcloud-props.py', import.meta.url))],
      { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['pipe','pipe','ignore'] });
    let output = '', failed = false;
    const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, 5000);
    child.on('error', () => { failed = true; });
    child.stdin.on('error', () => { failed = true; });
    child.stdout.on('data', bytes => { output += bytes.toString(); if (output.length > 8192) { failed = true; child.kill('SIGKILL'); } });
    child.on('close', code => {
      clearTimeout(timer);
      try {
        check(!failed && code === 0, 'NEXTCLOUD_METADATA_INVALID');
        const value = JSON.parse(output);
        check(exact(value, ['href','ownerId','mountType','isMountRoot','shareTypes','collection']), 'NEXTCLOUD_METADATA_INVALID');
        resolve(value);
      } catch { reject(new NextcloudBackupError('NEXTCLOUD_METADATA_INVALID')); }
    });
    child.stdin.end(xml);
  });
}
const PROPERTIES = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns"><d:prop><d:resourcetype/><oc:owner-id/><nc:mount-type/><nc:is-mount-root/><oc:share-types/></d:prop></d:propfind>';
const LEDGER_NAME = /^ECO-(?:pair|maintenance)-v1-[a-f0-9]{64}\.json$/u;
const LEDGER_LIMIT = name => name.startsWith('ECO-maintenance-') ? 1024 * 1024 : 65_536;
const INVENTORY_PROPERTIES = PROPERTIES.replace('</d:prop>', '<oc:fileid/><d:getetag/><d:getcontentlength/></d:prop>');
const TRASH_PROPERTIES = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns"><d:prop><d:resourcetype/><oc:fileid/><d:getetag/><d:getcontentlength/><nc:trashbin-filename/><nc:trashbin-original-location/><nc:trashbin-deletion-time/></d:prop></d:propfind>';
const CANARY_NAME = /^ECO-trash-canary-v1-[a-f0-9]{32}\.bin$/u;
const RETENTION_QUOTA = 500 * 1024 ** 3, RETENTION_HEADROOM = 100 * 1024 ** 3;
const same = (left,right) => JSON.stringify(left) === JSON.stringify(right);
async function parseListing(xml, trash = false) {
  check(Buffer.isBuffer(xml) && xml.length <= 2 * 1024 * 1024,'NEXTCLOUD_LEDGER_INVALID');
  return new Promise((resolve,reject) => {
    const child = spawn('/usr/bin/python3',['-I',fileURLToPath(new URL(trash ? './nextcloud-trash.py' : './nextcloud-list.py',import.meta.url))],
      {env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},stdio:['pipe','pipe','ignore']});
    let output = '', failed = false;
    const timer = setTimeout(()=>{failed=true;child.kill('SIGKILL');},5000);
    child.on('error',()=>{failed=true;}); child.stdin.on('error',()=>{failed=true;});
    child.stdout.on('data',bytes=>{output+=bytes.toString();if(output.length>1024*1024){failed=true;child.kill('SIGKILL');}});
    child.on('close',code=>{
      clearTimeout(timer);
      try { check(!failed&&code===0,'NEXTCLOUD_LEDGER_INVALID');const paths=JSON.parse(output);
        check(Array.isArray(paths)&&paths.length<=4097&&paths.every(path=>path&&typeof path==='object'),'NEXTCLOUD_LEDGER_INVALID');resolve(paths);
      } catch { reject(new NextcloudBackupError('NEXTCLOUD_LEDGER_INVALID')); }
    });
    child.stdin.end(xml);
  });
}

export function createNextcloudBackupClient({ config, appPassword, fetchImpl = fetch, beforeMutation = async () => {},
  now = () => new Date(), sleep = delay, requestTimeoutMs = 120_000 }) {
  validateNextcloudConfiguration(config, appPassword);
  check(Number.isInteger(requestTimeoutMs) && requestTimeoutMs > 0 && requestTimeoutMs <= 120_000, 'NEXTCLOUD_CONFIGURATION_INVALID');
  const origin = config.origin, authorization = 'Basic ' + Buffer.from(config.expectedUser + ':' + appPassword).toString('base64');
  const folderPath = `/remote.php/dav/files/${config.expectedUser}/${config.folder}/`;
  const ledgerBase = folderPath+'ECO-ledger-v1/';
  const rootPath = `/remote.php/dav/files/${config.expectedUser}/`;
  const trashPath = `/remote.php/dav/trashbin/${config.expectedUser}/trash/`;
  const restorePath = `/remote.php/dav/trashbin/${config.expectedUser}/restore/`;
  const accountPath = '/ocs/v2.php/cloud/user?format=json';
  const sharesPath = '/ocs/v2.php/apps/files_sharing/api/v1/shares';
  const pinned = new Set([origin + accountPath, origin + sharesPath + '?format=json&reshares=true',
    origin + sharesPath + '?format=json&shared_with_me=true', origin + folderPath, origin + rootPath, origin + trashPath]);
  const archivePattern = /^ECO-nightly-\d{4}-\d{2}-\d{2}-[a-f0-9]{64}\.tar\.gz\.age$/u;
  const minted = new WeakMap(), mintedTrash = new WeakMap(), canaryNames = new Set();
  const normalName = name => archivePattern.test(name) || canaryNames.has(name);
  const ledgerCollection = path => path===ledgerBase || /^ECO-ledger-v1\/(?:pairs\/(?:[0-9]{4}\/)?|events\/(?:[0-9]{4}\/(?:[0-9]{2}\/)?)?)$/u.test(path.slice(folderPath.length));
  const ledgerFile = path => /^ECO-ledger-v1\/(?:pairs\/[0-9]{4}\/ECO-pair-v1-[a-f0-9]{64}\.json|events\/[0-9]{4}\/[0-9]{2}\/ECO-maintenance-v1-[a-f0-9]{64}\.json)$/u.test(path.slice(folderPath.length));
  const ledgerPath = (name,period=new Date(now()).toISOString()) => {
    check(typeof name==='string'&&LEDGER_NAME.test(name)&&typeof period==='string'
      &&/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u.test(period)
      &&Number.isFinite(Date.parse(period))&&new Date(period).toISOString()===period,'NEXTCLOUD_LEDGER_INVALID');
    const night=hongKongNight(period);
    return ledgerBase+(name.startsWith('ECO-pair-')?`pairs/${night.slice(0,4)}/`:`events/${night.slice(0,4)}/${night.slice(5,7)}/`)+name;
  };
  const trashName = name => {
    const match = /^(.*)\.d([0-9]{1,16})$/u.exec(name);
    return Boolean(match && (archivePattern.test(match[1]) || CANARY_NAME.test(match[1])));
  };
  function destination(path) {
    const url = new URL(path, origin);
    check(url.origin === origin && !url.username && !url.password && !url.hash
      && (pinned.has(url.href) || (!url.search && url.pathname.startsWith(folderPath)
        && (normalName(url.pathname.slice(folderPath.length))||ledgerCollection(url.pathname)||ledgerFile(url.pathname)))
        || (!url.search && [trashPath,restorePath].some(base=>url.pathname.startsWith(base)&&trashName(url.pathname.slice(base.length))))), 'NEXTCLOUD_CONFIGURATION_INVALID');
    return url.href;
  }
  async function request(path, { method = 'GET', headers = {}, body, allowed = [200], mode = 'json', limit = 65_536, retries = 2 } = {}) {
    const url = destination(path);
    const pathname = new URL(url).pathname;
    // A trash-bin DELETE is permanent. It is deliberately impossible through this client.
    if (method === 'DELETE') check(pathname.startsWith(folderPath)
      && (archivePattern.test(pathname.slice(folderPath.length)) || canaryNames.has(pathname.slice(folderPath.length)))
      && retries === 0 && typeof headers['If-Match'] === 'string','NEXTCLOUD_RETENTION_UNVERIFIED');
    if (method === 'MOVE') check(pathname.startsWith(trashPath) && trashName(pathname.slice(trashPath.length))
      && headers.Destination === origin + restorePath + pathname.slice(trashPath.length)
      && headers.Overwrite === 'T' && typeof headers['If-Match'] === 'string' && retries === 0,'NEXTCLOUD_RESTORE_UNVERIFIED');
    if (method === 'PUT') check(pathname.startsWith(folderPath) && (normalName(pathname.slice(folderPath.length))||ledgerFile(pathname)),'NEXTCLOUD_CONFIGURATION_INVALID');
    if (method === 'MKCOL') check(pathname.startsWith(ledgerBase)&&ledgerCollection(pathname)&&retries===0,'NEXTCLOUD_LEDGER_INVALID');
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      let response, stream;
      try {
        if (['PUT','MOVE','DELETE','MKCOL'].includes(method)) {
          try { await abortRace(beforeMutation(), controller.signal); } catch { fail('NEXTCLOUD_LOCK_LOST'); }
        }
        // Finish the local open so its stream is always owned and cleaned up,
        // including when the request deadline expires during filesystem access.
        stream = typeof body === 'function' ? await body() : body;
        check(!controller.signal.aborted, 'NEXTCLOUD_TIMEOUT');
        response = await abortRace(fetchImpl(url, { method, redirect: 'error', signal: controller.signal,
          headers: { ...headers, Authorization: authorization }, ...(stream === undefined ? {} : { body: stream }),
          ...(stream && typeof stream.pipe === 'function' ? { duplex: 'half' } : {}) }), controller.signal);
        check(!response.redirected && (!response.url || response.url === url)
          && !(response.status >= 300 && response.status < 400), 'NEXTCLOUD_REDIRECT_REJECTED');
        if (!allowed.includes(response.status)) {
          if (RETRY_STATUSES.has(response.status) && attempt < retries) { await sleep(500 * 2 ** attempt); continue; }
          fail([401,403].includes(response.status) ? 'NEXTCLOUD_AUTHORIZATION_FAILED' : 'NEXTCLOUD_HTTP_FAILED');
        }
        if (mode === 'headers') return { status: response.status, headers: response.headers };
        if (mode === 'xml-status' && response.status===404) return {status:404,bytes:Buffer.alloc(0)};
        if (mode === 'hash' || mode === 'bytes') {
          const encoding = response.headers.get('content-encoding');
          check(!encoding || encoding.toLowerCase() === 'identity', 'NEXTCLOUD_CHECKSUM_MISMATCH');
          if(mode==='hash')return { status: response.status, headers: response.headers, ...await consume(response, controller.signal, limit, true) };
        }
        const bytes = await consume(response, controller.signal, limit);
        if (mode === 'xml-status') return {status:response.status,bytes};
        if (mode === 'xml' || mode === 'bytes') return bytes;
        check(response.headers.get('content-type')?.split(';')[0].trim() === 'application/json', 'NEXTCLOUD_METADATA_INVALID');
        let result; try { result = JSON.parse(bytes.toString('utf8')); } catch { fail('NEXTCLOUD_METADATA_INVALID'); }
        check(result?.ocs?.meta?.status === 'ok' && result.ocs.meta.statuscode === 200, 'NEXTCLOUD_METADATA_INVALID');
        return result.ocs.data;
      } catch (error) {
        if ((!(error instanceof NextcloudBackupError) || error.code === 'NEXTCLOUD_TIMEOUT') && attempt < retries) { await sleep(500 * 2 ** attempt); continue; }
        if (error instanceof NextcloudBackupError) throw error;
        fail('NEXTCLOUD_REQUEST_FAILED');
      } finally {
        clearTimeout(timer); controller.abort();
        stream?.destroy?.();
        if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
      }
    }
  }
  async function verifyTarget() {
    const user = await request(accountPath, { headers: { 'OCS-APIRequest': 'true', Accept: 'application/json' } });
    check(user?.id === config.expectedUser && user.enabled !== false && Array.isArray(user.groups) && user.groups.length === 0
      && Array.isArray(user.subadmin) && user.subadmin.length === 0, 'NEXTCLOUD_ACCOUNT_MISMATCH');
    for (const query of ['?format=json&reshares=true', '?format=json&shared_with_me=true']) {
      const shares = await request(sharesPath + query, { headers: { 'OCS-APIRequest': 'true', Accept: 'application/json' } });
      check(Array.isArray(shares) && shares.length === 0, 'NEXTCLOUD_ACCOUNT_SHARED');
    }
    for (const path of [rootPath, folderPath]) {
      await verifyProperties(path, true, path === rootPath);
    }
    check(user.quota && Number.isSafeInteger(user.quota.free) && user.quota.free >= 0, 'NEXTCLOUD_METADATA_INVALID');
    // Absent quota details are unknown, not inferred from nominal provider storage.
    return { freeBytes: user.quota.free,
      usedBytes:Number.isSafeInteger(user.quota.used)&&user.quota.used>=0?user.quota.used:null,
      totalBytes:Number.isSafeInteger(user.quota.total)&&user.quota.total>0?user.quota.total:null,
      assignedQuotaBytes:Number.isSafeInteger(user.quota.quota)&&user.quota.quota>0?user.quota.quota:null };
  }
  async function verifyProperties(path, collection, root = false) {
    const props = await parseNextcloudFolder(await request(path, { method: 'PROPFIND', allowed: [207], mode: 'xml',
      headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' }, body: PROPERTIES }));
    let href; try { href = new URL(props.href, origin); } catch { fail('NEXTCLOUD_METADATA_INVALID'); }
    check(href.href === origin + path && props.ownerId === config.expectedUser && props.collection === collection
      && props.mountType === '' && props.shareTypes.trim() === ''
      && (root ? ['true','1','false','0'].includes(props.isMountRoot) : ['false','0'].includes(props.isMountRoot)), 'NEXTCLOUD_FOLDER_NOT_PRIVATE');
  }
  async function metadata(path, allowMissing = false) {
    // HEAD and conditional GET must describe the same uncompressed representation.
    const result = await request(path, { method: 'HEAD', mode: 'headers', allowed: allowMissing ? [200,404] : [200],
      headers: { 'Accept-Encoding': 'identity' } });
    if (result.status === 404) return null;
    const etag = result.headers.get('etag'), size = result.headers.get('content-length'), encoding = result.headers.get('content-encoding');
    check((!encoding || encoding.toLowerCase() === 'identity')
      && typeof etag === 'string' && /^"[^"\r\n]+"$/u.test(etag) && /^\d+$/u.test(size ?? '')
      && Number.isSafeInteger(Number(size)), 'NEXTCLOUD_METADATA_INVALID');
    return { etag, size: Number(size) };
  }
  async function verifyBytes(path, sha256, size) {
    await verifyProperties(path, false);
    const before = await metadata(path);
    check(before.size === size, 'NEXTCLOUD_CHECKSUM_MISMATCH');
    const actual = await request(path, { headers: { 'If-Match': before.etag, 'Accept-Encoding': 'identity' }, mode: 'hash', limit: size });
    check(actual.size === size && actual.sha256 === sha256, 'NEXTCLOUD_CHECKSUM_MISMATCH');
    const after = await metadata(path);
    check(before.etag === after.etag && before.size === after.size, 'NEXTCLOUD_REMOTE_CHANGED');
    await verifyProperties(path, false);
    await verifyTarget();
    return after;
  }
  async function ledgerCollectionExists(path) {
    const result=await request(path,{method:'PROPFIND',allowed:[207,404],mode:'xml-status',
      headers:{Depth:'0','Content-Type':'application/xml'},body:PROPERTIES});
    if(result.status===404)return false;
    const props=await parseNextcloudFolder(result.bytes);
    check(new URL(props.href,origin).href===origin+path&&props.collection&&props.ownerId===config.expectedUser
      &&props.mountType===''&&['false','0'].includes(props.isMountRoot)&&props.shareTypes.trim()==='',
    'NEXTCLOUD_FOLDER_NOT_PRIVATE');return true;
  }
  async function ledgerParents(path,create) {
    const parts=path.slice(folderPath.length).split('/').slice(0,-1);
    let parent=folderPath;
    for(const part of parts){
      const current=parent+part+'/';check(ledgerCollection(current),'NEXTCLOUD_LEDGER_INVALID');
      if(!await ledgerCollectionExists(current)){
        if(!create)return false;
        await verifyProperties(parent,true);
        // A lost create response is left for the next read; never replay MKCOL.
        await request(current,{method:'MKCOL',mode:'headers',allowed:[201,405],retries:0});
        await verifyProperties(current,true);
      }
      parent=current;
    }
    return true;
  }
  async function readLedgerBytes(name,path,allowMissing) {
    const before=await metadata(path,allowMissing);
    if (!before) return null;
    check(before.size>0&&before.size<=LEDGER_LIMIT(name),'NEXTCLOUD_LEDGER_INVALID');await verifyProperties(path,false);
    const bytes=await request(path,{headers:{'If-Match':before.etag,'Accept-Encoding':'identity'},mode:'bytes',limit:LEDGER_LIMIT(name)});
    const after=await metadata(path);await verifyProperties(path,false);
    check(bytes.length===before.size&&before.etag===after.etag&&before.size===after.size,'NEXTCLOUD_REMOTE_CHANGED');
    let value;try{value=JSON.parse(bytes.toString('utf8'));}catch{fail('NEXTCLOUD_LEDGER_INVALID');}
    return {value,sha256:createHash('sha256').update(bytes).digest('hex')};
  }
  /** Immutable private receipts. Existing bytes and older partitions are untouched. */
  async function readLedger(name, allowMissing = false, period) {
    check(typeof allowMissing==='boolean','NEXTCLOUD_LEDGER_INVALID');
    const path=ledgerPath(name,period);await verifyTarget();
    if(!await ledgerParents(path,false)){
      check(allowMissing,'NEXTCLOUD_LEDGER_INVALID');return null;
    }
    const result=await readLedgerBytes(name,path,allowMissing);await verifyTarget();return result;
  }
  async function writeLedger(name, value, period) {
    check(LEDGER_NAME.test(name),'NEXTCLOUD_LEDGER_INVALID');
    let bytes;try{bytes=Buffer.from(JSON.stringify(value));}catch{fail('NEXTCLOUD_LEDGER_INVALID');}
    check(bytes.length<=LEDGER_LIMIT(name),'NEXTCLOUD_LEDGER_INVALID');
    const path=ledgerPath(name,period);await verifyTarget();await ledgerParents(path,true);
    await verifyProperties(path.slice(0,path.lastIndexOf('/')+1),true);
    await request(path,{method:'PUT',mode:'headers',allowed:[201,412],
      headers:{'Content-Type':'application/json','Content-Length':String(bytes.length),'If-None-Match':'*'},body:bytes});
    const stored=await readLedgerBytes(name,path,false);await verifyTarget();
    check(stored.sha256===createHash('sha256').update(bytes).digest('hex'),'NEXTCLOUD_LEDGER_INVALID');
    return stored.value;
  }
  async function listPairReceipts() {
    await verifyTarget();
    const year=Number(hongKongNight(new Date(now()).toISOString()).slice(0,4)), locations=[];
    for(let offset=0;offset<3;offset++){
      const partition=String(year-offset).padStart(4,'0'),base=ledgerBase+`pairs/${partition}/`;
      if(!await ledgerParents(base+'ECO-pair-v1-'+ '0'.repeat(64)+'.json',false))continue;
      const xml=await request(base,{method:'PROPFIND',allowed:[207],mode:'xml',limit:2*1024*1024,
        headers:{Depth:'1','Content-Type':'application/xml'},body:INVENTORY_PROPERTIES});
      const paths=await parseListing(xml), names=[];let rootCount=0;
      for(const entry of paths){
        const url=privateInventoryEntry(entry);check(url.pathname.startsWith(base),'NEXTCLOUD_LEDGER_INVALID');
        const name=url.pathname.slice(base.length);
        if(!name){check(entry.collection,'NEXTCLOUD_LEDGER_INVALID');rootCount++;continue;}
        check(!name.replace(/\/$/u,'').includes('/'),'NEXTCLOUD_LEDGER_INVALID');
        if(/^ECO-pair-v1-[a-f0-9]{64}\.json$/u.test(name)){
          check(!entry.collection,'NEXTCLOUD_LEDGER_INVALID');names.push(name);
        }
      }
      check(rootCount===1,'NEXTCLOUD_LEDGER_INVALID');check(names.length<=512,'NEXTCLOUD_LEDGER_LIMIT');
      for(const name of names.sort())locations.push({name,path:base+name,year:partition});
    }
    check(locations.length<=1536,'NEXTCLOUD_LEDGER_LIMIT');
    const receipts=new Array(locations.length);let cursor=0,stopped=false;
    // Four bounded readbacks, with target checks around the entire inventory.
    // Await every in-flight read even on failure; no orphan work after returning.
    const workers=await Promise.allSettled(Array.from({length:Math.min(4,locations.length)},async()=>{
      try{for(;;){if(stopped)return;const index=cursor++;if(index>=locations.length)return;
        const item=locations[index],stored=await readLedgerBytes(item.name,item.path,false);
        check(typeof stored.value?.snapshotAt==='string'&&Number.isFinite(Date.parse(stored.value.snapshotAt))
          &&hongKongNight(stored.value.snapshotAt).slice(0,4)===item.year,'NEXTCLOUD_LEDGER_INVALID');
        receipts[index]={name:item.name,year:item.year,...stored};
      }}catch(error){stopped=true;throw error;}
    }));
    await verifyTarget();
    const failure=workers.find(result=>result.status==='rejected');if(failure)throw failure.reason;
    return receipts;
  }
  function privateInventoryEntry(entry) {
    let url;try{url=new URL(entry.href,origin);}catch{fail('NEXTCLOUD_LEDGER_INVALID');}
    check(url.origin===origin&&!url.username&&!url.password&&!url.search&&!url.hash
      &&url.pathname.startsWith(folderPath)&&entry.ownerId===config.expectedUser&&entry.mountType===''
      &&['false','0'].includes(entry.isMountRoot)&&entry.shareTypes.trim()===''
      &&/^[0-9]+$/u.test(entry.fileId||''),'NEXTCLOUD_FOLDER_NOT_PRIVATE');
    if(!entry.collection)check(/^"[^"\r\n]+"$/u.test(entry.etag||'')&&/^[0-9]+$/u.test(entry.size||'')
      &&Number.isSafeInteger(Number(entry.size)),'NEXTCLOUD_METADATA_INVALID');
    return url;
  }
  async function retentionMetadata(path) {
    const entries=await parseListing(await request(path,{method:'PROPFIND',allowed:[207],mode:'xml',
      headers:{Depth:'0','Content-Type':'application/xml'},body:INVENTORY_PROPERTIES}));
    check(entries.length===1,'NEXTCLOUD_METADATA_INVALID');
    const entry=entries[0],url=privateInventoryEntry(entry);
    check(url.href===origin+path&&!entry.collection,'NEXTCLOUD_RETENTION_UNVERIFIED');
    const head=await metadata(path);
    check(head.etag===entry.etag&&head.size===Number(entry.size),'NEXTCLOUD_REMOTE_CHANGED');
    return {path,fileId:entry.fileId,etag:entry.etag,size:Number(entry.size)};
  }
  async function verifyForRetention({archiveName,sha256,size}) {
    check(archivePattern.test(archiveName)&&HASH.test(sha256)&&archiveName.includes(sha256)
      &&Number.isSafeInteger(size)&&size>0&&size<=config.maxArchiveBytes,'NEXTCLOUD_RETENTION_UNVERIFIED');
    return mintRetention(archiveName,sha256,size);
  }
  async function mintRetention(archiveName,sha256,size) {
    await verifyTarget();
    const path=folderPath+archiveName, before=await retentionMetadata(path);
    await verifyBytes(path,sha256,size);
    const after=await retentionMetadata(path);
    check(same(before,after),'NEXTCLOUD_REMOTE_CHANGED');
    const receipt=Object.freeze({archiveName,sha256,size,verified:true});
    minted.set(receipt,Object.freeze({...after,verifiedAt:new Date(now()).getTime()}));return receipt;
  }
  async function assertRetentionReceipt(receipt) {
    const expected=minted.get(receipt);check(expected,'NEXTCLOUD_RETENTION_UNVERIFIED');
    check(new Date(now()).getTime()>=expected.verifiedAt
      &&new Date(now()).getTime()-expected.verifiedAt<=30*60_000,'NEXTCLOUD_RETENTION_UNVERIFIED');
    await verifyTarget();
    const current=await retentionMetadata(expected.path);
    check(same(current,{path:expected.path,fileId:expected.fileId,etag:expected.etag,size:expected.size}),'NEXTCLOUD_REMOTE_CHANGED');
    return Object.freeze({...expected});
  }
  async function trashInventory() {
    const entries=await parseListing(await request(trashPath,{method:'PROPFIND',allowed:[207],mode:'xml',limit:2*1024*1024,
      headers:{Depth:'1','Content-Type':'application/xml'},body:TRASH_PROPERTIES}),true);
    let roots=0;const items=[];
    for(const entry of entries){
      let url;try{url=new URL(entry.href,origin);}catch{fail('NEXTCLOUD_TRASH_UNAVAILABLE');}
      check(url.origin===origin&&!url.username&&!url.password&&!url.search&&!url.hash
        &&url.pathname.startsWith(trashPath),'NEXTCLOUD_TRASH_UNAVAILABLE');
      const name=url.pathname.slice(trashPath.length);
      if(!name){check(entry.collection,'NEXTCLOUD_TRASH_UNAVAILABLE');roots++;continue;}
      check(!name.replace(/\/$/u,'').includes('/'),'NEXTCLOUD_TRASH_UNAVAILABLE');
      items.push(Object.freeze({...entry,path:url.pathname}));
    }
    check(roots===1,'NEXTCLOUD_TRASH_UNAVAILABLE');return items;
  }
  async function verifyTrashCapability() {
    const quota=await verifyTarget();
    check(quota.assignedQuotaBytes===RETENTION_QUOTA&&quota.totalBytes===RETENTION_QUOTA
      &&quota.usedBytes!==null&&quota.usedBytes<=RETENTION_QUOTA
      &&Math.min(quota.freeBytes,RETENTION_QUOTA-quota.usedBytes)>=RETENTION_HEADROOM,'NEXTCLOUD_TRASH_UNAVAILABLE');
    const items=await trashInventory();
    return Object.freeze({available:true,verifiedAt:new Date(now()).toISOString(),items:Object.freeze(items),
      providerAutomaticExpiryPossible:true,permanentDeletionUsed:false});
  }
  function matchingTrash(items,archiveName) {
    return items.filter(item=>item.name===archiveName||item.originalLocation===`${config.folder}/${archiveName}`
      ||item.path.startsWith(trashPath+archiveName+'.d'));
  }
  // Nextcloud trash HEAD can expose an empty underlying ETag, while GET and
  // PROPFIND expose a numeric preview tag. These are not strong content
  // validators and must never enter the ordinary-file metadata path.
  async function trashMetadata(item) {
    const result=await request(item.path,{method:'HEAD',mode:'headers',allowed:[200]});
    const tag=result.headers.get('etag'),length=result.headers.get('content-length');
    check(typeof tag==='string'&&tag.length<=256&&!/[\u0000-\u001f\u007f]/u.test(tag)
      &&/^[0-9]+$/u.test(length||'')&&Number.isSafeInteger(Number(length))
      &&Number(length)===Number(item.size),'NEXTCLOUD_TRASH_UNVERIFIED');
    // Preserve even an empty HEAD tag as an opaque, stable metadata field.
    // The separate listing identity and full hash authenticate the content.
    return {tag,size:Number(length)};
  }
  async function verifyTrashed(item, archiveName, sha256, size) {
    check(!item.collection&&item.name===archiveName&&item.originalLocation===`${config.folder}/${archiveName}`
      &&item.path===trashPath+archiveName+'.d'+item.deletionTime&&trashName(item.path.slice(trashPath.length))
      &&/^[0-9]+$/u.test(item.fileId||'')&&/^[0-9]+$/u.test(item.deletionTime||'')
      &&Number.isSafeInteger(Number(item.deletionTime))&&/^[0-9]+$/u.test(item.etag||'')
      &&Number.isSafeInteger(Number(item.etag))
      &&Number(item.size)===size,'NEXTCLOUD_TRASH_UNVERIFIED');
    const before=await trashMetadata(item);
    check(before.size===size,'NEXTCLOUD_TRASH_UNVERIFIED');
    // '*' checks existence only. Content authority is the expected full SHA-256
    // and exact identity/metadata on both sides of the complete readback.
    const bytes=await request(item.path,{headers:{'If-Match':'*','Accept-Encoding':'identity'},mode:'hash',limit:size,retries:0});
    check(bytes.sha256===sha256&&bytes.size===size
      &&bytes.headers.get('etag')===item.etag,'NEXTCLOUD_TRASH_UNVERIFIED');
    const after=await trashMetadata(item);
    check(same(before,after),'NEXTCLOUD_REMOTE_CHANGED');
    const fresh=matchingTrash(await trashInventory(),archiveName);
    check(fresh.length===1&&same(fresh[0],item),'NEXTCLOUD_REMOTE_CHANGED');
    await verifyTarget();return {...before,item};
  }
  async function trashVerified({candidateReceipt,retainedReceipts,protectedHashes,beforeDelete}) {
    check(candidateReceipt&&archivePattern.test(candidateReceipt.archiveName)&&minted.has(candidateReceipt)
      &&Array.isArray(protectedHashes)&&protectedHashes.every(value=>typeof value==='string'&&HASH.test(value))
      &&!protectedHashes.includes(candidateReceipt.sha256)
      &&typeof beforeDelete==='function'&&Array.isArray(retainedReceipts)&&retainedReceipts.length>=14&&retainedReceipts.length<=100
      &&retainedReceipts.every(receipt=>minted.has(receipt)&&archivePattern.test(receipt.archiveName)
        &&receipt.archiveName!==candidateReceipt.archiveName)
      &&new Set(retainedReceipts.map(receipt=>receipt.archiveName)).size===retainedReceipts.length
      &&new Set(retainedReceipts.map(receipt=>receipt.archiveName.slice(12,22))
        .filter(night=>night>candidateReceipt.archiveName.slice(12,22))).size>=14,'NEXTCLOUD_RETENTION_UNVERIFIED');
    return deleteToTrash(candidateReceipt,retainedReceipts,beforeDelete);
  }
  async function deleteToTrash(candidateReceipt,retainedReceipts,beforeDelete) {
    await assertRetentionReceipt(candidateReceipt);
    for(const receipt of retainedReceipts)await assertRetentionReceipt(receipt);
    // Persist intent and reverify the counterpart before making the final local checks.
    await beforeDelete();
    const capability=await verifyTrashCapability();
    check(matchingTrash(capability.items,candidateReceipt.archiveName).length===0,'NEXTCLOUD_TRASH_UNVERIFIED');
    for(const receipt of retainedReceipts)await assertRetentionReceipt(receipt);
    const before=await assertRetentionReceipt(candidateReceipt), started=new Date(now()).getTime();
    await request(before.path,{method:'DELETE',mode:'headers',allowed:[204],retries:0,headers:{'If-Match':before.etag}});
    // A failed/lost response is never replayed. Its pending intent requires review.
    check(!await metadata(before.path,true),'NEXTCLOUD_TRASH_UNVERIFIED');
    const found=matchingTrash(await trashInventory(),candidateReceipt.archiveName);
    check(found.length===1&&Number(found[0].deletionTime)*1000>=started-300_000
      &&Number(found[0].deletionTime)*1000<=new Date(now()).getTime()+300_000,'NEXTCLOUD_TRASH_UNVERIFIED');
    const verified=await verifyTrashed(found[0],candidateReceipt.archiveName,candidateReceipt.sha256,candidateReceipt.size);
    const receipt=Object.freeze({archiveName:candidateReceipt.archiveName,sha256:candidateReceipt.sha256,size:candidateReceipt.size,
      trashPath:found[0].path,trashFileId:found[0].fileId,deletionTime:found[0].deletionTime,
      recoverable:true,verifiedAt:new Date(now()).toISOString(),providerAutomaticExpiryPossible:true,permanentDeletionUsed:false});
    mintedTrash.set(receipt,Object.freeze(verified));minted.delete(candidateReceipt);return receipt;
  }
  async function restoreTrashed({trashReceipt}) {
    const saved=mintedTrash.get(trashReceipt);check(saved,'NEXTCLOUD_RESTORE_UNVERIFIED');
    await verifyTrashCapability();
    const matches=matchingTrash(await trashInventory(),trashReceipt.archiveName);
    check(matches.length===1&&same(matches[0],saved.item),'NEXTCLOUD_RESTORE_UNVERIFIED');
    const verified=await verifyTrashed(matches[0],trashReceipt.archiveName,trashReceipt.sha256,trashReceipt.size);
    const original=folderPath+trashReceipt.archiveName;
    check(!await metadata(original,true),'NEXTCLOUD_RESTORE_UNVERIFIED');
    await verifyTarget();
    const latest=matchingTrash(await trashInventory(),trashReceipt.archiveName);
    check(latest.length===1&&same(latest[0],verified.item)
      &&same(await trashMetadata(latest[0]),{tag:verified.tag,size:verified.size}),'NEXTCLOUD_REMOTE_CHANGED');
    check(!await metadata(original,true),'NEXTCLOUD_RESTORE_UNVERIFIED');
    // Trash content is not writable through this endpoint. There is no strong
    // provider validator for an atomic restore: never retry a lost MOVE, refuse
    // an existing original, and verify the exact restored bytes immediately.
    // Nextcloud's virtual restore child returns null rather than NotFound;
    // Sabre rejects Overwrite:F before restoring anything. T is allowed only
    // on this exact virtual route. Nextcloud chooses a unique filename on an
    // ordinary collision; a renamed/conflicting result fails our postcheck.
    await request(saved.item.path,{method:'MOVE',mode:'headers',allowed:[201,204],retries:0,
      headers:{Destination:origin+restorePath+saved.item.path.slice(trashPath.length),Overwrite:'T','If-Match':'*'}});
    await verifyBytes(original,trashReceipt.sha256,trashReceipt.size);
    check(matchingTrash(await trashInventory(),trashReceipt.archiveName).length===0,'NEXTCLOUD_RESTORE_UNVERIFIED');
    mintedTrash.delete(trashReceipt);
    return Object.freeze({verified:true,archiveName:trashReceipt.archiveName,sha256:trashReceipt.sha256,size:trashReceipt.size,
      restoredAt:new Date(now()).toISOString(),permanentDeletionUsed:false});
  }
  /** Explicit operator canary only. Its restored synthetic file is deliberately preserved. */
  async function runTrashCanary() {
    await verifyTrashCapability();
    const archiveName=`ECO-trash-canary-v1-${randomBytes(16).toString('hex')}.bin`;
    const bytes=Buffer.from('ECO SYNTHETIC TRASH RESTORE CANARY\n'+randomBytes(64).toString('hex'));
    const sha256=createHash('sha256').update(bytes).digest('hex');canaryNames.add(archiveName);
    await request(folderPath+archiveName,{method:'PUT',mode:'headers',allowed:[201],retries:0,
      headers:{'Content-Type':'application/octet-stream','Content-Length':String(bytes.length),'If-None-Match':'*'},body:bytes});
    const candidate=await mintRetention(archiveName,sha256,bytes.length);
    const trashed=await deleteToTrash(candidate,[],async()=>{});
    const restored=await restoreTrashed({trashReceipt:trashed});
    return Object.freeze({schemaVersion:1,verified:true,canary:true,...restored,verifiedAt:restored.restoredAt,
      trashReadbackVerified:true,providerAutomaticExpiryPossible:true});
  }
  async function uploadAndVerify({ archiveFile, snapshotAt, expectedSha256 }) {
    check(typeof archiveFile === 'string' && isAbsolute(archiveFile) && archiveFile.endsWith('.age') && HASH.test(expectedSha256), 'NEXTCLOUD_LOCAL_ARCHIVE_INVALID');
    let initial, handle;
    try { initial = await lstat(archiveFile); } catch { fail('NEXTCLOUD_LOCAL_ARCHIVE_INVALID'); }
    check(initial.isFile() && !initial.isSymbolicLink() && initial.nlink === 1 && !(initial.mode & 0o077)
      && initial.uid === process.getuid() && initial.size > AGE_HEADER.length && initial.size <= config.maxArchiveBytes, 'NEXTCLOUD_LOCAL_ARCHIVE_INVALID');
    try { handle = await open(archiveFile, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { fail('NEXTCLOUD_LOCAL_ARCHIVE_INVALID'); }
    try {
      const info = await handle.stat(), digest = createHash('sha256');
      check(info.dev === initial.dev && info.ino === initial.ino, 'NEXTCLOUD_LOCAL_ARCHIVE_CHANGED');
      for await (const chunk of handle.createReadStream({ start: 0, end: info.size - 1, autoClose: false })) digest.update(chunk);
      check(digest.digest('hex') === expectedSha256, 'NEXTCLOUD_LOCAL_ARCHIVE_INVALID');
      const hashed = await handle.stat();
      check(info.size === hashed.size && info.mtimeMs === hashed.mtimeMs && info.ctimeMs === hashed.ctimeMs, 'NEXTCLOUD_LOCAL_ARCHIVE_CHANGED');
      const header = Buffer.alloc(AGE_HEADER.length); await handle.read(header, 0, header.length, 0);
      check(header.toString() === AGE_HEADER, 'NEXTCLOUD_LOCAL_ARCHIVE_INVALID');
      let snapshot; try { snapshot = new Date(snapshotAt).toISOString(); } catch { fail('NEXTCLOUD_LOCAL_ARCHIVE_INVALID'); }
      check(Date.parse(snapshot) <= new Date(now()).getTime() + 300_000, 'NEXTCLOUD_LOCAL_ARCHIVE_INVALID');
      const night = hongKongNight(snapshot), name = `ECO-nightly-${night}-${expectedSha256}.tar.gz.age`, path = folderPath + name;
      const quota = await verifyTarget();
      let reused = Boolean(await metadata(path, true));
      if (!reused) {
        check(quota.freeBytes >= info.size, 'NEXTCLOUD_QUOTA_INSUFFICIENT');
        try {
          const result = await request(path, { method: 'PUT', mode: 'headers', allowed: [201,412],
            headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(info.size), 'If-None-Match': '*' },
            body: async () => {
              const upload = await open(archiveFile, constants.O_RDONLY | constants.O_NOFOLLOW);
              try {
                const current = await upload.stat();
                check(info.dev === current.dev && info.ino === current.ino && info.size === current.size
                  && info.mtimeMs === current.mtimeMs && info.ctimeMs === current.ctimeMs, 'NEXTCLOUD_LOCAL_ARCHIVE_CHANGED');
                return upload.createReadStream({ start: 0, end: info.size - 1, autoClose: true });
              } catch (error) { await upload.close(); throw error; }
            } });
          reused = result.status === 412;
        } catch (error) {
          // A final lost response may still follow a complete remote commit.
          // Read-only verification is safe; authorization/lock failures are not retried here.
          if (!['NEXTCLOUD_REQUEST_FAILED','NEXTCLOUD_TIMEOUT','NEXTCLOUD_HTTP_FAILED'].includes(classifyNextcloudBackupError(error))) throw error;
          try { await verifyBytes(path, expectedSha256, info.size); reused = true; }
          catch { throw error; }
        }
      }
      // A lost upload response is recovered only by verifying the pre-existing
      // exact ciphertext. A partial or different object is preserved for review.
      try { await verifyBytes(path, expectedSha256, info.size); }
      catch (error) { if (reused && error.code === 'NEXTCLOUD_CHECKSUM_MISMATCH') fail('NEXTCLOUD_EXISTING_COPY_INVALID'); throw error; }
      const after = await handle.stat();
      check(info.size === after.size && info.mtimeMs === after.mtimeMs && info.ctimeMs === after.ctimeMs, 'NEXTCLOUD_LOCAL_ARCHIVE_CHANGED');
      return Object.freeze({ verified: true, destination: 'nextcloud', night, snapshotAt: snapshot,
        sha256: expectedSha256, size: info.size, archiveName: name, verifiedAt: new Date(now()).toISOString(), reused });
    } catch (error) {
      if (error instanceof NextcloudBackupError) throw error;
      fail('NEXTCLOUD_REQUEST_FAILED');
    } finally { try { await handle.close(); } catch { fail('NEXTCLOUD_LOCAL_ARCHIVE_CHANGED'); } }
  }
  return Object.freeze({ verifyTarget, uploadAndVerify,readLedger,writeLedger,listPairReceipts,
    verifyForRetention,assertRetentionReceipt,trashVerified,verifyTrashCapability,restoreTrashed,runTrashCanary });
}
