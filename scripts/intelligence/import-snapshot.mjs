#!/usr/bin/env node
/** Private operator tool. Default: offline validation. No records or secrets in logs. */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, lstat, realpath, open, mkdir } from 'node:fs/promises';
import { dirname, resolve, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { ecoConnections as target } from '../../config/ecoConnections.ts';
import { validateIntelligenceSnapshot } from '../../server/intelligence/validation.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha = value => createHash('sha256').update(value).digest('hex');
function check(condition, message) { if (!condition) throw new Error(message); }
const record = value => value && typeof value === 'object' && !Array.isArray(value);
function stamp(value) {
  check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z)?$/.test(value) && Number.isFinite(Date.parse(value)), 'Invalid private source date.');
  const result = new Date(value).toISOString(); check(result.slice(0, 10) === value.slice(0, 10), 'Invalid private source date.'); return result;
}
/** Explicit mapping only: unknown aliases are rejected instead of dropping rows or guessing identities. */
export function buildPrivateIntelligence(supplierSource, countSource, aliases = {}, now = new Date()) {
  check(record(supplierSource) && record(countSource) && Array.isArray(supplierSource.suppliers) && Array.isArray(countSource.counts) && record(aliases), 'Invalid private source files.');
  check(supplierSource.portId === countSource.portId, 'Private source coverage differs.');
  const allowed = ['id','name','companyId','portIds','grades','paymentTerms','qualityClaimBar','supplierTrader','foBdn','goBdn','bargeCount','sourceUrl'];
  const suppliers = supplierSource.suppliers.map(s => { check(record(s), 'Invalid private supplier.'); return Object.fromEntries(allowed.filter(k => s[k] !== undefined).map(k => [k, s[k]])); });
  const byKey = new Map();
  for (const s of suppliers) {
    check(typeof s.id === 'string', 'Invalid private supplier identity.');
    const key = s.id.replace(/^spc-/, '').toLowerCase(); check(!byKey.has(key), 'Ambiguous private supplier identity.'); byKey.set(key, s.id);
  }
  for (const [key, id] of Object.entries(aliases)) {
    check(/^[a-z0-9][a-z0-9_-]{0,159}$/.test(key) && typeof id === 'string' && suppliers.some(s => s.id === id), 'Invalid private alias mapping.');
    check(!byKey.has(key) || byKey.get(key) === id, 'Private alias conflicts with a stable identity.'); byKey.set(key, id);
  }
  const seen = new Set(), combined = new Map();
  for (const row of countSource.counts) {
    check(record(row) && typeof row.key === 'string' && typeof row.date === 'string' && Number.isInteger(row.count) && row.count >= 0 && row.count <= 1_000_000, 'Invalid private count row.');
    const key = row.key.toLowerCase(), original = `${key}:${row.date}`;
    check(!seen.has(original), 'Duplicate private source count.'); seen.add(original);
    const supplierId = byKey.get(key); check(supplierId, 'Unmapped private count identity; supply an explicit alias file.');
    const combinedKey = `${supplierId}:${row.date}`, existing = combined.get(combinedKey);
    if (existing) existing.count += row.count; else combined.set(combinedKey, { supplierId, date: row.date, count: row.count });
  }
  const snapshot = { schemaVersion: 1, portId: countSource.portId, recordedAt: stamp(countSource.recordedAt), supplierRecordedAt: stamp(supplierSource.recordedAt), periodStart: countSource.periodStart, periodEnd: countSource.periodEnd, sourceUrl: countSource.sourceUrl, supplierSourceUrl: supplierSource.supplierSourceUrl, suppliers, counts: [...combined.values()].sort((a,b) => a.supplierId.localeCompare(b.supplierId, 'en') || a.date.localeCompare(b.date, 'en')) };
  return validateIntelligenceSnapshot(snapshot, now);
}
export function parseImportArgs(args) {
  const options = {}; let apply = false;
  for (let i=0;i<args.length;i++) {
    if (args[i] === '--apply') { check(!apply, 'Duplicate apply flag.'); apply = true; continue; }
    const key = args[i]?.replace(/^--/, '');
    check(['suppliers','counts','aliases','operator-id','expected-active-id','request','credentials','supabase-cli'].includes(key) && !Object.hasOwn(options,key) && args[i+1] && !args[i+1].startsWith('--'), 'Invalid import arguments.'); options[key] = args[++i];
  }
  check(options.suppliers && options.counts, 'Supply private --suppliers and --counts files.');
  if (apply) check(uuid.test(options['operator-id'] ?? '') && (options['expected-active-id'] === 'none' || uuid.test(options['expected-active-id'] ?? '')) && options.request && options.credentials && isAbsolute(options['supabase-cli'] ?? ''), 'Apply requires --operator-id --expected-active-id (UUID or none) --request --credentials and an absolute --supabase-cli.');
  return { options, apply };
}
async function privatePath(value, { create = false, secret = false } = {}) {
  check(typeof value === 'string' && isAbsolute(value), 'Private paths must be absolute.');
  const path = resolve(value), local = relative(root, path);
  check(local.startsWith(`..${sep}`) || isAbsolute(local) || local.startsWith(`output${sep}`), 'Private source/request files must be outside the public checkout or under ignored output/.');
  if (local.startsWith(`output${sep}`)) {
    try { execFileSync('git', ['ls-files','--error-unmatch','--',path], {cwd:root,stdio:'ignore'}); throw new Error('Tracked private file'); } catch (error) { if (error.message === 'Tracked private file') throw new Error('Private output files must not be tracked.'); }
    try { execFileSync('git', ['check-ignore','-q','--no-index',path], {cwd:root,stdio:'ignore'}); } catch { throw new Error('Private output path is not ignored.'); } }
  let stat; try { stat = await lstat(path); } catch (error) { if (!create || error.code !== 'ENOENT') throw new Error('Private file is unavailable.'); }
  if (stat) { check(stat.isFile() && !stat.isSymbolicLink(), 'Private files must be regular files.'); check(await realpath(path) === path, 'Private path cannot traverse symlinks.'); if (secret) check((stat.mode & 0o077) === 0, 'Private credentials/request must have owner-only permissions.'); }
  if (secret) check(path.endsWith('.private.json'), 'Private credentials/request must end in .private.json.');
  return path;
}
async function readPrivate(path) { const stat = await lstat(path); check(stat.size <= 4_194_304, 'Private file exceeds import size limit.'); try { return await readFile(path,'utf8'); } catch { throw new Error('Private file cannot be read.'); } }
function parsePrivate(text) { try { return JSON.parse(text); } catch { throw new Error('Invalid private JSON file.'); } }
async function writeRequest(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  check(await realpath(dirname(path)) === dirname(path), 'Private path cannot traverse symlinks.');
  const file = await open(path,'wx',0o600); try { await file.writeFile(JSON.stringify(value)+'\n'); await file.sync(); } finally { await file.close(); }
}
function verifiedCli(binary, args) {
  try { return JSON.parse(execFileSync(binary,args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:90_000,maxBuffer:2_097_152})); }
  catch { throw new Error('Target verification failed; no captured CLI output is printed.'); }
}
export async function importIntelligence(args) {
  const { options, apply } = parseImportArgs(args);
  const supplierPath = await privatePath(options.suppliers), countPath = await privatePath(options.counts);
  const supplierText = await readPrivate(supplierPath), countText = await readPrivate(countPath), aliasText = options.aliases ? await readPrivate(await privatePath(options.aliases)) : '{}';
  const snapshot = buildPrivateIntelligence(parsePrivate(supplierText),parsePrivate(countText),parsePrivate(aliasText));
  const sourceHash = sha(JSON.stringify({ suppliers: sha(supplierText), counts: sha(countText), aliases: sha(aliasText) }));
  const summary = { apply, sourceHash, suppliers: snapshot.suppliers.length, counts: snapshot.counts.length };
  if (!apply) return summary;
  check(target.supabaseProjectRef && target.supabaseOrganizationId && target.supabaseRegion, 'Canonical ECO target missing.');
  const who = verifiedCli(options['supabase-cli'],['whoami','--output-format','json']);
  check(who.username === target.githubRepository.split('/')[0], 'Authenticated operator account mismatch.');
  const projects = verifiedCli(options['supabase-cli'],['projects','list','--output','json']);
  const matches = Array.isArray(projects) ? projects.filter(p => p.id === target.supabaseProjectRef) : [];
  check(matches.length === 1 && matches[0].organization_id === target.supabaseOrganizationId && matches[0].region === target.supabaseRegion && matches[0].name === 'ECO' && matches[0].status === 'ACTIVE_HEALTHY', 'Canonical ECO project identity/health mismatch.');
  const credentialsPath = await privatePath(options.credentials,{secret:true}), requestPath = await privatePath(options.request,{secret:true,create:true});
  check(![supplierPath,countPath,credentialsPath,options.aliases].includes(requestPath), 'Private request cannot replace an input.');
  const credentials = parsePrivate(await readPrivate(credentialsPath));
  check(record(credentials) && Object.keys(credentials).every(k => ['projectRef','secretKey'].includes(k)) && credentials.projectRef === target.supabaseProjectRef && typeof credentials.secretKey === 'string' && credentials.secretKey.length > 20, 'Target-scoped service credentials required.');
  let request;
  try { request = parsePrivate(await readPrivate(requestPath)); } catch (error) {
    if ((await lstat(requestPath).catch(e => { if(e.code==='ENOENT') return null; throw e; })) !== null) throw new Error('Existing private request cannot be read; preserve it.');
    request = { requestId: randomUUID(), operatorId: options['operator-id'].toLowerCase(), expectedActiveId: options['expected-active-id'] === 'none' ? null : options['expected-active-id'].toLowerCase(), sourceHash, snapshot };
    await writeRequest(requestPath, { projectRef: target.supabaseProjectRef, input: request });
    request = { projectRef: target.supabaseProjectRef, input: request };
  }
  const input = request.input;
  check(request.projectRef === target.supabaseProjectRef && record(input) && uuid.test(input.requestId ?? '') && input.operatorId === options['operator-id'].toLowerCase() && input.expectedActiveId === (options['expected-active-id'] === 'none' ? null : options['expected-active-id'].toLowerCase()) && input.sourceHash === sourceHash && JSON.stringify(input.snapshot) === JSON.stringify(snapshot), 'Saved request differs from source/operator/target. Preserve it; never change an uncertain retry.');
  const client = createClient(`https://${target.supabaseProjectRef}.supabase.co`, credentials.secretKey, { auth: { persistSession:false,autoRefreshToken:false,detectSessionInUrl:false }, global: { fetch:(url,init)=>fetch(url,{...init,signal:AbortSignal.timeout(45_000)}) } });
  let result;
  try { const response = await client.rpc('eco_import_intelligence_snapshot',{p_input:input}); if(response.error) throw new Error('Import failed'); result=response.data; }
  catch { throw new Error('Import outcome is unconfirmed. Preserve the private request and retry the identical command; no business data or provider details are printed.'); }
  check(result?.snapshotId === input.requestId && result.sourceHash === sourceHash && result.suppliers === snapshot.suppliers.length && result.counts === snapshot.counts.length && result.previousSnapshotId === input.expectedActiveId, 'Import receipt could not be verified; preserve the request and investigate.');
  return { ...summary, snapshotId:result.snapshotId, previousSnapshotId:result.previousSnapshotId };
}
if(process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) importIntelligence(process.argv.slice(2)).then(result=>console.log(JSON.stringify(result))).catch(error=>{ console.error(error instanceof Error ? error.message : 'Private intelligence import failed.'); process.exitCode=1; });
