import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { handleLocationKnowledge, locationEnvelope, locationInput, locationHistoryQuery, locationActivityQuery, locationActivityIdsQuery, type LocationStore } from '../server/location-knowledge/handler.ts';
import { initialLocationSnapshot, canonicalLocationSnapshotJson, locationStateWithSnapshot } from '../src/lib/sharedLocationKnowledge.ts';
import type { AuthConfig } from '../server/auth/config.ts';
import type { AccessUser } from '../shared/access.ts';
import { knowledgeDocument } from '../src/lib/knowledge.ts';
import { createLiveState } from '../src/lib/testWorkspace.ts';
import { ApiError } from '../server/auth/validation.ts';

const user: AccessUser = { id: randomUUID(), email: 'synthetic@example.test', displayName: 'Synthetic member', officeId: 'hk', officeName: 'Hong Kong', isActive: true, activated: true, isAdmin: false, isSpcTrader: false, isManager: false, passwordChangeSuggested: false, revision: 3 };
const sessionId = randomUUID();
const config = { origin: 'https://eco.example.test', deploymentOrigin: 'https://eco-stage.vercel.app' } as AuthConfig;
const input = () => ({ requestId: randomUUID(), revision: 0, dataMode: 'live', action: { type: 'add-location', kind: 'country', name: 'Synthetic Country' } });
const request = (path = 'list', body?: unknown, headers: Record<string,string> = {}) => new Request(`${config.origin}/api/location-knowledge/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: config.origin, 'X-Eco-Request': '1', 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
function fixture(options: { active?: boolean; activated?: boolean; signedIn?: boolean; admin?: boolean; preview?: boolean; revision?: number } = {}) {
  const actor = { ...user, isActive: options.active ?? true, activated: options.activated ?? true, isAdmin: options.admin ?? false }, calls: { name: string; value?: unknown }[] = [];
  let envelope: unknown = { revision: options.revision ?? 0, snapshot: options.revision ? initialLocationSnapshot() : null, importedSources: [] };
  const receipts = new Map<string, {requestId:string;committedRevision:number}>();
  const gateway = { cookies: ['eco-auth=synthetic; HttpOnly; Secure'], currentUser: async () => options.signedIn === false ? null : actor,
    getPreview: async () => options.preview ? { role: 'trader', readOnly: true } : null,
    authenticatedRpc: async (name: string) => { calls.push({ name }); return { envelope, actorId: actor.id, sessionId, aal: 'aal1' }; },
  } as unknown as Parameters<typeof handleLocationKnowledge>[2];
  const store: LocationStore = {
    prepare: async (identity, operation, value) => { calls.push({ name: 'prepare', value: { identity, operation, input: value } }); return receipts.has(value.requestId) ? { result: {...envelope as object,ack:receipts.get(value.requestId)} } : { envelope, actor }; },
    commit: async (identity, revision, operation, value, snapshot, digest, archives) => {
      calls.push({ name: 'commit', value: { identity, revision, operation, input: value, snapshot, digest, archives } });
      envelope = { revision: value.revision + 1, snapshot, importedSources: digest ? [{ digest, requestId: value.requestId, importedBy: identity.actorId, importedAt: '2026-10-21T12:00:00Z' }] : [] };
      const ack={requestId:value.requestId,committedRevision:value.revision+1};receipts.set(value.requestId, ack); return {...envelope as object,ack};
    },
  };
  return { gateway, store, calls, actor, run: (req: Request) => handleLocationKnowledge(req, config, gateway, store, () => '2026-10-21T12:00:00Z') };
}
test('read authenticates and returns reference geography without writing; preview reads are allowed', async () => {
  for (const preview of [false,true]) { const f = fixture({ preview }), response = await f.run(request()); assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.revision, 0); assert.deepEqual(result.snapshot, initialLocationSnapshot()); assert.deepEqual(f.calls.map(c => c.name), ['eco_location_knowledge_context']); assert.match(response.headers.get('cache-control')!, /no-store/); assert.equal(response.headers.getSetCookie().length, 1); assert.equal(result.sessionId, undefined); assert.equal(result.actorId, undefined); }
  for (const options of [{ active: false }, { activated: false }, { signedIn: false }]) { const f = fixture(options); assert.equal((await f.run(request())).status, 401); assert.equal(f.calls.length, 0); }
});
test('migration reference seed exactly matches the shared geography-only initial snapshot', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20261021113304_eco_shared_location_knowledge.sql', import.meta.url), 'utf8');
  const literal = sql.match(/\$location_reference\$([\s\S]+?)\$location_reference\$/)?.[1]; assert.ok(literal); assert.deepEqual(JSON.parse(literal), initialLocationSnapshot());
});
test('mutations use fresh server actor and live session; exact committed retries never reapply', async () => {
  const f = fixture(), body = input(), first = await f.run(request('mutate', body)); assert.equal(first.status, 200); const expected = await first.json();
  assert.ok(expected.snapshot.locationCountries.some((country: { name: string }) => country.name === 'Synthetic Country'));
  const commit = f.calls.find(c => c.name === 'commit')!.value as any; assert.equal(commit.identity.actorId, user.id); assert.equal(commit.identity.sessionId, sessionId); assert.equal(commit.revision, user.revision);
  assert.equal(commit.snapshot.contributions.length, 0); assert.equal(commit.digest, null);
  const retry = await f.run(request('mutate', body)); assert.equal(retry.status, 200); assert.deepEqual(await retry.json(), expected); assert.equal(f.calls.filter(c => c.name === 'commit').length, 1);
});
test('writes reject preview, TEST, missing origin, foreign origin and unapproved transport before service commit', async () => {
  const f = fixture({ preview: true }); assert.equal((await f.run(request('mutate', input()))).status, 403); assert.equal(f.calls.length, 0);
  for (const patch of [{ dataMode: 'test' }, { actor: user }, { generation: randomUUID() }, { action: { type: 'save-enquiry', enquiry: {} } }]) { const f = fixture(); assert.ok([400,403].includes((await f.run(request('mutate', { ...input(), ...patch }))).status)); assert.equal(f.calls.length, 0); }
  for (const headers of [{ Origin: 'https://attacker.test' }, { Origin: '' }, { 'X-Eco-Request': '' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Content-Type': 'text/plain' }]) { const f = fixture(); assert.ok([403,415].includes((await f.run(request('mutate', input(), headers))).status)); assert.equal(f.calls.length, 0); }
  assert.equal((await fixture().run(request('mutate', input(), { Origin: config.deploymentOrigin! }))).status, 200);
});
test('stale revisions and domain no-change errors do not publish', async () => {
  const stale = fixture({ revision: 2 }); assert.equal((await stale.run(request('mutate', input()))).status, 409); assert.equal(stale.calls.filter(c => c.name === 'commit').length, 0);
  const f = fixture(), body = input(); body.action.name = 'Singapore'; const response = await f.run(request('mutate', body)); assert.equal(response.status, 400); assert.match(await response.text(), /already exists/); assert.equal(f.calls.filter(c => c.name === 'commit').length, 0);
});
test('legacy imports require real admin and attach deterministic provenance without a new award', async () => {
  const source = initialLocationSnapshot(); source.ports[0].summary = 'Synthetic historical information';
  const body = { requestId: randomUUID(), revision: 0, dataMode: 'live', snapshot: source };
  const denied = fixture(); assert.equal((await denied.run(request('migrate', body))).status, 403); assert.equal(denied.calls.length, 0);
  const f = fixture({ admin: true }), response = await f.run(request('migrate', body)); assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.snapshot.ports[0].summary, source.ports[0].summary); assert.equal(result.snapshot.contributions.length, 0);
  assert.equal(result.importedSources[0].digest, createHash('sha256').update(canonicalLocationSnapshotJson(source)).digest('hex')); assert.equal(result.importedSources[0].importedBy, user.id);
});
test('import conflicts are whole-batch and never replace shared records', async () => {
  const f = fixture({ admin: true, revision: 1 }); const base = initialLocationSnapshot(); base.ports[0].summary = 'Existing shared text';
  f.store.prepare = async () => ({ envelope: { revision: 1, snapshot: base, importedSources: [] }, actor: f.actor });
  const source = initialLocationSnapshot(); source.ports[0].summary = 'Conflicting browser text'; source.locationCountries.push({ id: 'Synthetic Country', name: 'Synthetic Country' });
  const response = await f.run(request('migrate', { requestId: randomUUID(), revision: 1, dataMode: 'live', snapshot: source })); assert.equal(response.status, 409); assert.match(await response.text(), /No information was imported/); assert.equal(f.calls.filter(c => c.name === 'commit').length, 0);
});
test('provider errors are sanitized, permission rechecks propagate, and malformed database snapshots fail closed', async () => {
  const f = fixture(); f.store.commit = async () => { throw new Error('SECRET provider response'); }; const response = await f.run(request('mutate', input())); assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /SECRET/);
  const revoked = fixture(); revoked.store.commit = async () => { throw new ApiError(401, 'Sign in again.'); }; assert.equal((await revoked.run(request('mutate', input()))).status, 401);
  assert.throws(() => locationEnvelope({ revision: 1, snapshot: { privateNotes: 'SECRET' }, importedSources: [] }), /unavailable/);
  assert.throws(() => locationInput({ ...input(), revision: -1 }, 'mutate')); assert.throws(() => locationInput({ ...input(), requestId: 'bad' }, 'mutate'));
});
test('unknown routes, query overrides and oversized body are rejected', async () => {
  for (const [req,status] of [[request('unknown'),404], [request('list?actor=other'),400], [new Request(`${config.origin}/api/location-knowledge/list`, { method:'DELETE' }),405], [request('mutate',{ ...input(), extra: 'x'.repeat(4_000_000) }),413]] as const) { const f=fixture(); assert.equal((await f.run(req)).status,status); assert.equal(f.calls.length,0); }
});
test('archive query contracts reject scope overrides, duplicate parameters and unsafe cursors', () => {
 const url=(query:string)=>new URL(`${config.origin}/api/location-knowledge/history?${query}`);
 assert.deepEqual(locationHistoryQuery(url(`targets=${encodeURIComponent(JSON.stringify([{kind:'port',id:'port-singapore'}]))}&cursor=25`)),{targets:[{kind:'port',id:'port-singapore'}],cursor:'25'});
 for(const query of ['targets=[]','targets=null','targets=%5B%7B%22kind%22%3A%22company%22%2C%22id%22%3A%22secret%22%7D%5D','targets=[]&targets=[]','targets=[]&cursor=-1'])assert.throws(()=>locationHistoryQuery(url(query)));
 assert.throws(()=>locationActivityQuery(url(`actors=${encodeURIComponent(JSON.stringify([user.email]))}&period=7d`)));
 assert.throws(()=>locationActivityQuery(url(`actors=${encodeURIComponent(JSON.stringify([user.id]))}&period=7d&cursor=1:-1`)));
 assert.throws(()=>locationActivityIdsQuery(url(`actor=${user.id}&entryId=x&period=7d&extra=private`)));
});
test('retry acknowledgment retains committed revision while returning newer shared state',async()=>{
 const f=fixture(),first=input();await f.run(request('mutate',first));const second={...input(),revision:1,action:{type:'add-location',kind:'country',name:'Later synthetic country'}};
 assert.equal((await f.run(request('mutate',second))).status,200);
 const replay=await f.run(request('mutate',first));assert.equal(replay.status,200);const result=await replay.json();assert.equal(result.revision,2);assert.deepEqual(result.ack,{requestId:first.requestId,committedRevision:1});assert.ok(result.snapshot.locationCountries.some((country:any)=>country.name==='Later synthetic country'));assert.equal(f.calls.filter(c=>c.name==='commit').length,2);
});
test('activity pages compact facts, computes complete totals once and exposes all grouped audit links through bounded pages',async()=>{
 const f=fixture({revision:7}),facts=Array.from({length:150},(_,i)=>{
  const group=i<120?0:i-119,hash=createHash('sha256').update(String(group)).digest('hex');
  return {id:`a${String(i).padStart(3,'0')}`,targetType:'country',targetId:'Singapore',title:'Synthetic publication',body:'',author:user.id,createdAt:'2026-10-21T10:00:00Z',status:'approved',publication:'direct',publishedAt:'2026-10-21T10:00:00Z',locationPublication:{version:1,eligible:true,kind:'country',keys:[hash],records:[hash],fingerprint:hash,keyInfoTransitions:[]}};
 });
 const calls:string[]=[];
 f.gateway.authenticatedRpc=async<T>(name:string,args?:Record<string,unknown>):Promise<T>=>{
  calls.push(name);
  if(name==='eco_location_knowledge_context')return {envelope:{revision:7,snapshot:initialLocationSnapshot(),importedSources:[]},actorId:user.id,sessionId,aal:'aal1'} as T;
  assert.equal(name,'eco_location_knowledge_publications');assert.equal(args?.p_revision,7);
  const second=Number(args?.p_after)>0;return {revision:7,items:second?facts.slice(80):facts.slice(0,80),nextCursor:second?null:'80',directoryIds:second?[]:[user.id]} as T;
 };
 const query=`actors=${encodeURIComponent(JSON.stringify([user.id]))}&period=7d`,response=await f.run(request(`activity?${query}`));assert.equal(response.status,200);const result=await response.json();
 assert.equal(result.summary.total,31);assert.equal(result.summary.entries.length,25);assert.equal(result.nextCursor,'7:25');assert.equal(result.byActor[user.id].summary.total,31);assert.equal(result.byActor[user.id].summary.entries.length,1);assert.deepEqual(result.activeDates,['2026-10-21']);
 const group=result.summary.entries.find((item:any)=>item.contributionIdsTotal===120);assert.ok(group);assert.equal(group.contributionIds.length,100);assert.equal(group.contributionIdsNextCursor,'7:100');
 const next=await f.run(request(`activity?${query}&cursor=7:25`));assert.equal(next.status,200);const more=await next.json();assert.equal(more.summary.entries.length,6);assert.equal(more.summary.total,31);assert.equal(more.nextCursor,null);
 const ids=await f.run(request(`activity-ids?actor=${user.id}&period=7d&entryId=${group.id}&cursor=7:100`));assert.equal(ids.status,200);const detail=await ids.json();assert.equal(detail.total,120);assert.equal(detail.ids.length,20);assert.equal(detail.nextCursor,null);assert.equal(new Set([...group.contributionIds,...detail.ids]).size,120);
 assert.equal((await f.run(request(`activity?${query}&cursor=6:25`))).status,409);
 assert.equal(calls.filter(name=>name==='eco_location_knowledge_publications').length,6);
});
test('history and full-detail endpoints keep authentication and share only the fixed RPC arguments',async()=>{
 const f=fixture();const old=f.gateway.authenticatedRpc.bind(f.gateway),seen:{name:string;args:unknown}[]=[];
 f.gateway.authenticatedRpc=async<T>(name:string,args?:Record<string,unknown>):Promise<T>=>{if(name==='eco_location_knowledge_context')return old<T>(name,args);seen.push({name,args});return {items:[],nextCursor:null,total:0} as T;};
 const targets=[{kind:'country',id:'Singapore'}];assert.equal((await f.run(request(`history?targets=${encodeURIComponent(JSON.stringify(targets))}&cursor=21`))).status,200);
 assert.deepEqual(seen[0],{name:'eco_location_knowledge_history',args:{p_targets:targets,p_cursor:'21'}});
 assert.equal((await f.run(request('contributions?status=pending'))).status,200);assert.deepEqual(seen[1],{name:'eco_location_knowledge_pending',args:{p_cursor:null}});
 assert.equal((await fixture({signedIn:false}).run(request(`history?targets=${encodeURIComponent(JSON.stringify(targets))}`))).status,401);
 assert.equal((await f.run(request('contribution?id=secret&actor=other'))).status,400);
});

test('one published edit atomically separates current document, immutable history, full detail and compact fact',async()=>{
 const f=fixture(),target={kind:'port' as const,id:'port-singapore'},base=knowledgeDocument(locationStateWithSnapshot(createLiveState(),initialLocationSnapshot()),target),document=structuredClone(base);
 document.sections.push({id:'synthetic-note',title:'SYNTHETIC',blocks:[{id:'synthetic-text',type:'text',title:'SYNTHETIC',text:'Retained shared note'}]});
 const body={requestId:randomUUID(),revision:0,dataMode:'live',action:{type:'save-knowledge',change:{target,baseVersion:base.version,baseDocument:base,document},reason:'Synthetic history separation'}};
 const response=await f.run(request('mutate',body));assert.equal(response.status,200);const result=await response.json();assert.equal(result.snapshot.knowledgeHistory.length,0);assert.equal(result.snapshot.contributions.length,0);assert.equal(result.snapshot.historicalContributionIds.length,0);
 const commit=f.calls.find(call=>call.name==='commit')!.value as any;assert.equal(commit.archives.history.length,1);assert.equal(commit.archives.history[0].by,user.id);assert.equal(commit.archives.contributions.length,1);assert.ok(commit.archives.contributions[0].knowledgeChange);assert.equal(commit.archives.publications[0].body,'');assert.equal(commit.archives.publications[0].knowledgeChange,undefined);assert.equal(commit.archives.publications[0].locationPublication.eligible,true);
 assert.deepEqual(result.ack,{requestId:body.requestId,committedRevision:1});
});
