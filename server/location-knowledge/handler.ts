import { createHash } from 'node:crypto';
import type { AccessUser } from '../../shared/access.ts';
import type { AuthConfig } from '../auth/config.ts';
import type { AuthGateway } from '../auth/gateway.ts';
import { ApiError } from '../auth/validation.ts';
import { actorFromAccess } from '../../src/lib/accessActor.ts';
import { applyCurrentLocationAction, canonicalLocationSnapshotJson, initialLocationSnapshot, mergeCurrentLocationSnapshot, locationStateWithSnapshot, parseLocationContribution,
  parseLocationAction, parseLocationSnapshot, type LocationSnapshot, type LocationSeparation } from '../../src/lib/sharedLocationKnowledge.ts';

import { contributionActivity, type ContributionPeriod } from '../../src/lib/contributionActivity.ts';
import type { Contribution, DemoState } from '../../src/lib/model.ts';

export const LOCATION_REQUEST_MAX_BYTES = 4_000_000;
type Operation = 'mutate' | 'migrate';
export interface ImportedLocationSource { digest: string; requestId: string; importedBy: string; importedAt: string }
export interface LocationEnvelope { revision: number; snapshot: LocationSnapshot; importedSources: ImportedLocationSource[]; ack?: {requestId:string;committedRevision:number} }
export interface LocationInput { requestId: string; revision: number; dataMode: 'live'; action?: unknown; snapshot?: unknown }
export interface LocationIdentity { actorId: string; sessionId: string; aal: 'aal1' | 'aal2' }
export interface LocationStore {
  prepare(identity: LocationIdentity, operation: Operation, input: LocationInput): Promise<{ result?: unknown; envelope?: unknown; actor?: AccessUser; contributions?: unknown[] }>;
  commit(identity: LocationIdentity, actorRevision: number, operation: Operation, input: LocationInput, snapshot: LocationSnapshot, sourceDigest: string | null, archives: Pick<LocationSeparation, 'history' | 'contributions' | 'publications'>): Promise<unknown>;
}
type Gateway = AuthGateway & { authenticatedRpc<T>(name: string, input?: Record<string, unknown>): Promise<T> };
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'Invalid request.'); return value as Record<string, unknown>; }
function domain<T>(fn: () => T): T {
  try { return fn(); } catch (error) { throw new ApiError(400, error instanceof Error && error.message.length <= 240 ? error.message : 'Invalid location information.'); }
}
async function domainAsync<T>(fn:()=>Promise<T>):Promise<T> { try{return await fn();}catch(error){throw new ApiError(400,error instanceof Error&&error.message.length<=240?error.message:'Invalid location information.');} }
export function locationInput(value: unknown, operation: Operation): LocationInput {
  const input = object(value), keys = ['requestId', 'revision', 'dataMode', operation === 'mutate' ? 'action' : 'snapshot'];
  if (Object.keys(input).some(key => !keys.includes(key)) || !uuid(input.requestId) || !Number.isSafeInteger(input.revision) || Number(input.revision) < 0 || Number(input.revision) >= 2_147_483_647)
    throw new ApiError(400, 'Invalid request.');
  if (input.dataMode !== 'live') throw new ApiError(403, 'Shared changes are unavailable in Test Data.');
  domain(() => operation === 'mutate' ? parseLocationAction(input.action) : parseLocationSnapshot(input.snapshot));
  // Preserve the complete validated payload for exact retry comparison; parsing
  // must not silently turn distinct caller payloads into the same receipt.
  return input as unknown as LocationInput;
}
export function locationEnvelope(value: unknown): LocationEnvelope {
  try {
    const input = object(value);
    if (Object.keys(input).some(key => !['revision', 'snapshot', 'importedSources', 'ack'].includes(key)) || !Number.isSafeInteger(input.revision) || Number(input.revision) < 0 || !Array.isArray(input.importedSources)) throw new Error();
    const importedSources = input.importedSources.map(value => {
      const source = object(value);
      if (Object.keys(source).some(key => !['digest', 'requestId', 'importedBy', 'importedAt'].includes(key)) || typeof source.digest !== 'string' || !/^[a-f0-9]{64}$/.test(source.digest) || !uuid(source.requestId) || !uuid(source.importedBy) || typeof source.importedAt !== 'string' || !Number.isFinite(Date.parse(source.importedAt))) throw new Error();
      return source as unknown as ImportedLocationSource;
    });
    const snapshot = input.revision === 0 && input.snapshot === null ? initialLocationSnapshot() : parseLocationSnapshot(input.snapshot);
    if (snapshot.knowledgeHistory.length || snapshot.contributions.length || snapshot.historicalContributionIds.length) throw new Error();
    let ack: LocationEnvelope['ack'];
    if (input.ack !== undefined) { const value = object(input.ack); if (Object.keys(value).some(key => !['requestId','committedRevision'].includes(key)) || !uuid(value.requestId) || !Number.isSafeInteger(value.committedRevision) || Number(value.committedRevision)<1 || Number(value.committedRevision)>Number(input.revision)) throw new Error(); ack={requestId:value.requestId,committedRevision:Number(value.committedRevision)}; }
    return { revision: Number(input.revision), snapshot, importedSources, ...(ack ? {ack} : {}) };
  } catch { throw new ApiError(503, 'Shared location information is unavailable.'); }
}
function queryKeys(url: URL, allowed: string[]) {
  if ([...url.searchParams.keys()].some(key => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1)) throw new ApiError(400, 'Invalid request.');
}
function identifier(value: string | null): string { if (!value || value.length>160 || /[\u0000-\u001f\u007f]/.test(value) || ['__proto__','constructor','prototype'].includes(value)) throw new ApiError(400,'Invalid identifier.'); return value; }
function numericCursor(value: string | null): string | null { if (value!==null && (!/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value)))) throw new ApiError(400,'Invalid cursor.'); return value; }
export function locationHistoryQuery(url: URL) {
 queryKeys(url,['targets','cursor']); let values:unknown;try {values=JSON.parse(url.searchParams.get('targets')??'');} catch {throw new ApiError(400,'Invalid targets.');}
 if (!Array.isArray(values) || values.length<1 || values.length>2) throw new ApiError(400,'Invalid targets.');
 const targets=values.map(value=>{const target=object(value);if(Object.keys(target).some(key=>!['kind','id'].includes(key)) || !['country','port','area'].includes(String(target.kind)) || typeof target.id!=='string') throw new ApiError(400,'Invalid target.');return {kind:target.kind as 'country'|'port'|'area',id:identifier(target.id)};});
 if(new Set(targets.map(t=>JSON.stringify(t))).size!==targets.length) throw new ApiError(400,'Duplicate targets.');
 return {targets,cursor:numericCursor(url.searchParams.get('cursor'))};
}
export function locationActivityQuery(url: URL) {
 queryKeys(url,['actors','period','cursor']);let actors:unknown;try{actors=JSON.parse(url.searchParams.get('actors')??'');}catch{throw new ApiError(400,'Invalid actors.');}
 if(!Array.isArray(actors)||actors.length<1||actors.length>100||actors.some(id=>!uuid(id))||new Set(actors).size!==actors.length)throw new ApiError(400,'Invalid actors.');
 const period=url.searchParams.get('period');if(!period||!['7d','28d','month','all'].includes(period))throw new ApiError(400,'Invalid period.');
 const cursor=url.searchParams.get('cursor');if(cursor!==null&&(!/^(0|[1-9][0-9]{0,9}):(0|[1-9][0-9]{0,8})$/.test(cursor)))throw new ApiError(400,'Invalid cursor.');
 return {actors:actors as string[],period:period as ContributionPeriod,cursor};
}
const activityDates=(entries:ReturnType<typeof contributionActivity>['entries'])=>[...new Set(entries.map(item=>new Date(Date.parse(item.at)+8*3_600_000).toISOString().slice(0,10)))].sort();
function activityEntry(entry:ReturnType<typeof contributionActivity>['entries'][number],revision:number) { return {...entry,contributionIds:entry.contributionIds.slice(0,100),...(entry.contributionIds.length>100?{contributionIdsTotal:entry.contributionIds.length,contributionIdsNextCursor:`${revision}:100`}:{})}; }
export function locationActivityIdsQuery(url:URL) {
 queryKeys(url,['entryId','actor','period','cursor']);const entryId=identifier(url.searchParams.get('entryId')),actor=url.searchParams.get('actor');
 if(!uuid(actor))throw new ApiError(400,'Invalid actor.');const converted=new URL(url);converted.search='';converted.searchParams.set('actors',JSON.stringify([actor]));converted.searchParams.set('period',url.searchParams.get('period')??'');if(url.searchParams.has('cursor'))converted.searchParams.set('cursor',url.searchParams.get('cursor')!);
 return {...locationActivityQuery(converted),entryId};
}
async function activityResponse(url:URL,gateway:Gateway,envelope:LocationEnvelope,at:string,idsOnly=false) {
 const query=idsOnly?locationActivityIdsQuery(url):locationActivityQuery(url), parts=query.cursor?.split(':').map(Number),offset=parts?.[1]??0;
 if(parts&&parts[0]!==envelope.revision)throw new ApiError(409,'Activity changed. Reload the latest activity.');
 const publications:Contribution[]=[];let after:string|null=null,directory:string[]=[];
 do {
  const page=await gateway.authenticatedRpc<{revision:number;items:unknown[];nextCursor:string|null;directoryIds:string[]}>('eco_location_knowledge_publications',{p_after:after??0,p_revision:envelope.revision});
  if(page.revision!==envelope.revision||!Array.isArray(page.items)||!Array.isArray(page.directoryIds))throw new ApiError(503,'Activity is unavailable.');
  if(after===null)directory=page.directoryIds.filter(uuid);
  publications.push(...page.items.map(parseLocationContribution));
  const next=numericCursor(page.nextCursor);if(next!==null&&Number(next)<=Number(after??0))throw new ApiError(503,'Activity is unavailable.');after=next;
 } while(after!==null);
 const empty:DemoState={version:1,companies:[],ports:[],enquiries:[],requests:[],outcomes:[],contributions:[],audit:[],drops:[],goals:[]};
 const state=locationStateWithSnapshot(empty,envelope.snapshot);state.contributions=publications;
 const full=contributionActivity(state,query.actors,query.period,new Date(at),directory),entries=[];let bytes=0;
 if(idsOnly){const entry=full.entries.find(item=>item.id===('entryId' in query?query.entryId:''));if(!entry)throw new ApiError(404,'Activity not found.');const ids=entry.contributionIds.slice(offset,offset+100);return {ids,total:entry.contributionIds.length,nextCursor:offset+ids.length<entry.contributionIds.length?`${envelope.revision}:${offset+ids.length}`:null};}
 for(const entry of full.entries.slice(offset,offset+25)){const compact=activityEntry(entry,envelope.revision),size=Buffer.byteLength(JSON.stringify(compact));if(bytes+size>1_000_000)break;entries.push(compact);bytes+=size;}
 const byActor=Object.fromEntries(query.actors.map(id=>{const summary=contributionActivity(state,id,query.period,new Date(at),directory);return[id,{summary:{...summary,entries:summary.entries.slice(0,1).map(entry=>activityEntry(entry,envelope.revision))},activeDates:activityDates(summary.entries)}];}));
 return {summary:{...full,entries},nextCursor:offset+entries.length<full.entries.length?`${envelope.revision}:${offset+entries.length}`:null,activeDates:activityDates(full.entries),byActor};
}
export async function handleLocationKnowledge(request: Request, config: AuthConfig, gateway: Gateway, store: LocationStore, now = () => new Date().toISOString()): Promise<Response> {
  const respond = (body: unknown, status = 200) => { const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store, max-age=0', 'Pragma': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); for (const cookie of gateway.cookies) headers.append('Set-Cookie', cookie); return new Response(JSON.stringify(body), { status, headers }); };
  try {
    const url = new URL(request.url);
    if (!['GET', 'POST'].includes(request.method)) throw new ApiError(405, 'Method not allowed.');
    const route=url.pathname.slice('/api/location-knowledge/'.length);
    if (route==='history') locationHistoryQuery(url); else if(route==='activity') locationActivityQuery(url); else if(route==='activity-ids') locationActivityIdsQuery(url); else if(route==='contribution') {queryKeys(url,['id']);identifier(url.searchParams.get('id'));} else if(route==='contributions') {queryKeys(url,['status','cursor']);if(url.searchParams.get('status')!=='pending')throw new ApiError(400,'Invalid status.');if(url.searchParams.has('cursor'))identifier(url.searchParams.get('cursor'));} else if(url.search) throw new ApiError(400,'Invalid request.');
    const operation = url.pathname === '/api/location-knowledge/mutate' ? 'mutate' : url.pathname === '/api/location-knowledge/migrate' ? 'migrate' : null;
    if (!(request.method === 'GET' && ['list','history','activity','activity-ids','contribution','contributions'].includes(route) && url.pathname === `/api/location-knowledge/${route}`) && !(request.method === 'POST' && operation)) throw new ApiError(404, 'Not found.');
    let input: LocationInput | undefined;
    if (request.method === 'POST') {
      const origin = request.headers.get('origin');
      if ((origin !== config.origin && (!config.deploymentOrigin || origin !== config.deploymentOrigin)) || request.headers.get('x-eco-request') !== '1' || request.headers.get('sec-fetch-site') === 'cross-site') throw new ApiError(403, 'Access denied.');
      if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new ApiError(415, 'JSON required.');
      const raw = await request.text(); if (Buffer.byteLength(raw) > LOCATION_REQUEST_MAX_BYTES) throw new ApiError(413, 'Request too large.');
      let value: unknown; try { value = JSON.parse(raw); } catch { throw new ApiError(400, 'Invalid request.'); }
      input = locationInput(value, operation!);
    }
    const user = await gateway.currentUser(); if (!user?.isActive || !user.activated) throw new ApiError(401, 'Sign in required.');
    if (request.method === 'POST') {
      if (await gateway.getPreview()) throw new ApiError(403, 'Preview is read only.');
      if (operation === 'migrate' && !user.isAdmin) throw new ApiError(403, 'Only an administrator can import archived location information.');
    }
    const context = await gateway.authenticatedRpc<{ envelope: unknown; actorId: string; sessionId: string; aal: 'aal1' | 'aal2' }>('eco_location_knowledge_context', { p_include_snapshot: request.method === 'GET' && ['list','activity','activity-ids'].includes(route) });
    if (context.actorId !== user.id || !uuid(context.sessionId) || !['aal1', 'aal2'].includes(context.aal)) throw new ApiError(401, 'Sign in again.');
    if (!input || !operation) {
      if(route==='history'){const query=locationHistoryQuery(url);return respond(await gateway.authenticatedRpc('eco_location_knowledge_history',{p_targets:query.targets,p_cursor:query.cursor}));}
      if(route==='contribution')return respond(await gateway.authenticatedRpc('eco_location_knowledge_contribution',{p_id:url.searchParams.get('id')}));
      if(route==='contributions')return respond(await gateway.authenticatedRpc('eco_location_knowledge_pending',{p_cursor:url.searchParams.get('cursor')}));
      const envelope=locationEnvelope(context.envelope);
      return respond(['activity','activity-ids'].includes(route)?await activityResponse(url,gateway,envelope,now(),route==='activity-ids'):envelope);
    }
    const identity: LocationIdentity = { actorId: user.id, sessionId: context.sessionId, aal: context.aal };
    // SQL rechecks the live identity and preview and consults the receipt before
    // the domain action. Retrying a committed request never runs it again.
    const prepared = await store.prepare(identity, operation, input);
    if (prepared.result) return respond(locationEnvelope(prepared.result));
    const current = locationEnvelope(prepared.envelope), actor = prepared.actor;
    if (!actor || actor.id !== user.id || !actor.isActive || !actor.activated || !Number.isSafeInteger(actor.revision)) throw new ApiError(503, 'Shared location information is unavailable.');
    if (current.revision !== input.revision) throw new ApiError(409, 'This information changed. Reload and review your update.');
    let separated: LocationSeparation, digest: string | null = null;
    if (operation === 'migrate') {
      if (!actor.isAdmin) throw new ApiError(403, 'Access denied.');
      const incoming = domain(() => parseLocationSnapshot(input!.snapshot));
      const merged = await domainAsync(() => mergeCurrentLocationSnapshot(current.snapshot, incoming));
      if (merged.conflicts.length) return respond({ message: 'Archived information conflicts with shared records. No information was imported.', conflicts: merged.conflicts }, 409);
      separated = merged; digest = createHash('sha256').update(canonicalLocationSnapshotJson(incoming)).digest('hex');
    } else separated = await domainAsync(() => applyCurrentLocationAction(current.snapshot, input!.action, actorFromAccess(actor), now(), {contributions:(prepared.contributions??[]).map(parseLocationContribution)}));
    const result = await store.commit(identity, actor.revision, operation, input, separated.snapshot, digest, separated);
    return respond(locationEnvelope(result));
  } catch (error) { return respond({ message: error instanceof ApiError ? error.message : 'Shared location information is unavailable.' }, error instanceof ApiError ? error.status : 503); }
}
