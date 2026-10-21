/**
 * Operator-only signed synthetic webhook verification. Never sends to Meta or staff.
 * Run only on the exact staged artifact after its migration and pinned source exist:
 *   node scripts/verify-whatsapp-intake.mjs --allow-cloud-mutations
 * Required: ECO_VERIFY_ORIGIN, ECO_VERIFY_DEPLOYMENT_ID, ECO_VERIFY_COMMIT,
 * ECO_PROTECTION_COOKIES, ECO_WHATSAPP_APP_SECRET_FILE (private plain-text hex),
 * ECO_WHATSAPP_VERIFY_TOKEN_FILE (private plain text).
 * Stage 1: --disabled-preflight verifies callback setup and closed intake without fixtures/mutations.
 * It requires the same private token/secret files but never reads a database service key.
 * Recovery: same command plus --cleanup-only /absolute/recovery.private.json.
 * Cleanup-only does not require provider secrets or a running staged deployment.
 */
import assert from 'node:assert/strict';
import { chromium, webkit, expect as baseExpect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { ecoConnections as target } from '../config/ecoConnections.ts';
import { installStagingCookies } from '../tests/fixtures/protection-cookies.mjs';
import { sourceFingerprint, migrationFingerprint } from './generate-system-information.mjs';

export function verificationMode(args) {
  let cleanup = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    assert.ok(['--allow-cloud-mutations', '--disabled-preflight', '--cleanup-only'].includes(flag), 'Unknown verification argument.');
    assert.equal(args.indexOf(flag), index, 'Duplicate verification argument.');
    if (flag === '--cleanup-only') { assert.ok(isAbsolute(args[++index] ?? ''), 'Cleanup requires an absolute recovery path.'); cleanup = true; }
  }
  if (args.includes('--disabled-preflight')) {
    assert.ok(!cleanup && !args.includes('--allow-cloud-mutations'), 'Disabled preflight must remain read-only.');
    return 'disabled-preflight';
  }
  assert.ok(args.includes('--allow-cloud-mutations'), 'Explicit operator authorization flag required.');
  return cleanup ? 'cleanup' : 'active';
}
// `vercel inspect --json` intentionally omits source metadata. Keep its build
// evidence, but take commit/ownership only from the exact raw deployment API.
export function mergeDeploymentMetadata(compact, raw, expected) {
  assert.equal(compact.id, expected.deploymentId); assert.equal(compact.url, new URL(expected.base).hostname);
  assert.equal(raw.id, compact.id); assert.equal(raw.url, compact.url);
  assert.equal(raw.projectId, target.vercel.projectId); assert.equal(raw.team?.id, target.vercel.teamId);
  if (raw.ownerId !== undefined) assert.equal(raw.ownerId, target.vercel.teamId);
  if (raw.project?.id !== undefined) assert.equal(raw.project.id, target.vercel.projectId);
  for (const field of ['name', 'target', 'readyState']) assert.equal(raw[field], compact[field]);
  // Never retain the raw response's environment or other unrelated metadata.
  return {...compact, meta: raw.meta, gitSource: raw.gitSource, projectId: raw.projectId, teamId: raw.team.id};
}
export function deploymentIdentity(deployment, expected) {
  assert.equal(deployment.id, expected.deploymentId); assert.equal(deployment.url, new URL(expected.base).hostname);
  assert.equal(deployment.readyState, 'READY'); assert.equal(deployment.name, target.vercel.projectName); assert.equal(deployment.target, 'production');
  assert.ok(deployment.builds?.some(build => build.output?.some(item => item.digest?.startsWith(`${target.vercel.projectId}/`))), 'Deployment project evidence required.');
  assert.equal(deployment.meta?.githubCommitSha, expected.commit, 'Exact deployment source revision required.');
  if (deployment.gitSource?.sha) assert.equal(deployment.gitSource.sha, expected.commit);
  if (deployment.meta?.githubCommitOrg) assert.equal(deployment.meta.githubCommitOrg, target.githubRepository.split('/')[0]);
  if (deployment.meta?.githubCommitRepo) assert.equal(deployment.meta.githubCommitRepo, target.githubRepository.split('/')[1]);
  return {id: deployment.id, url: deployment.url, target: deployment.target, commit: deployment.meta.githubCommitSha, projectId: target.vercel.projectId};
}
export function buildLogFingerprint(logs, expectedHash) {
  assert.match(expectedHash, /^[a-f0-9]{64}$/);
  const ids = [...logs.matchAll(/(?:Generated|Verified) system information (eco-[a-f0-9]{16})/g)].map(match => match[1]);
  const expected = `eco-${expectedHash.slice(0, 16)}`;
  assert.ok(ids.length >= 2 && ids.every(id => id === expected), 'Build log fingerprint does not match current source.');
  assert.ok(logs.includes(`Generated system information ${expected}:`) && logs.includes(`Verified system information ${expected}.`), 'Completed build verification required.');
  return expected;
}
function loadServiceClient() {
  const keys = JSON.parse(privateFile(join(root, 'output/access/eco-api-keys.private.json')));
  const secret = keys.find(item => item.type === 'secret')?.api_key; assert.ok(secret);
  return createClient(`https://${target.supabaseProjectRef}.supabase.co`, secret, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input, init) => fetch(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(20000) }) } });
}

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const expect = baseExpect.configure({ timeout: 30000 });
const cleanupIndex = process.argv.indexOf('--cleanup-only');
const cleanupPath = cleanupIndex < 0 ? null : process.argv[cleanupIndex + 1];
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const privateWrite = (path, value) => { writeFileSync(path, value, { mode: 0o600 }); chmodSync(path, 0o600); };
const command = args => execFileSync('pnpm', args, { cwd: root, encoding: 'utf8', timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 });
const sb = args => command(['dlx', '--allow-build=supabase', 'supabase@2.120.0', ...args]);
const vc = args => command(['dlx', 'vercel@63.1.2', ...args]);
function deploymentLogs() {
  const result = spawnSync('pnpm', ['dlx', 'vercel@63.1.2', 'inspect', manifest.base, '--logs', '--scope', target.vercel.teamId], {cwd: root, encoding: 'utf8', timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024});
  assert.equal(result.status, 0, 'Could not read exact deployment build logs.');
  return `${result.stdout}\n${result.stderr}`;
}
const contexts = [], browsers = [], checks = [];
let manifest, output, recovery, service, step = 'arguments', mutationStarted = false, failure;
const pins = target.whatsappReceiver;
function save() { if (manifest && output) privateWrite(recovery, JSON.stringify({ ...manifest, step, failure }, null, 2)); }
function mark(value) { step = value; save(); console.log(JSON.stringify({ step })); }
function rows(text) {
  privateWrite(join(output, 'query.private.sql'), text);
  const result = JSON.parse(sb(['db', 'query', '--linked', '--project-ref', target.supabaseProjectRef, '--file', join(output, 'query.private.sql'), '--output', 'json']));
  const data = Array.isArray(result) ? result : result.rows;
  assert.ok(Array.isArray(data), 'Unexpected SQL result shape.'); return data;
}
function privateFile(path) {
  assert.ok(typeof path === 'string' && isAbsolute(path), 'Private credential path must be absolute.');
  assert.ok(statSync(path).isFile()); assert.equal(statSync(path).mode & 0o077, 0, 'Credential file must be private.');
  return readFileSync(path, 'utf8');
}
const bodyFor = role => `VESSEL: ECO WHATSAPP ${role.toUpperCase()}\nPORT: SINGAPORE\nETA: 25 OCT 2026\nVLSFO: 500 MT\nREMARKS: SYNTHETIC ${manifest.runId} ONLY`;
const identityIds = () => manifest.identities.map(item => `${quote(item.id)}::uuid`).join(',');
const messageIds = () => Object.values(manifest.messages).map(quote).join(',');
async function json(response, expected = 200) {
  assert.equal(response.status(), expected, `${new URL(response.url()).pathname}: unexpected status`);
  assert.match(response.headers()['cache-control'] ?? '', /no-store/); return response.json();
}
const post = (context, path, data = {}, headers = {}) => context.request.post(manifest.base + path, { headers: { origin: manifest.base, 'x-eco-request': '1', ...headers }, data, timeout: 45000, maxRedirects: 0 });
const get = (context, path, headers = {}) => context.request.get(manifest.base + path, { headers, timeout: 45000, maxRedirects: 0 });
const getResponse = context => get(context, '/api/enquiries/inbox?limit=50', { 'x-eco-data-mode': 'live' });
async function newContext(browser, options = {}) {
  const context = await browser.newContext(options); contexts.push(context);
  await installStagingCookies(context, manifest.base); return context;
}
async function login(context, identity, password) {
  const result = await json(await post(context, '/api/access/login', { email: identity.email, password }));
  assert.equal(result.user.id, identity.id); assert.equal(result.preview ?? null, null); return result;
}
function sourceMetadata() {
  return rows(`select id,provider,account_id,destination_id,channel,identity_namespace,sender_authority,enabled,provisioned_at,scopes_verified_at,cutover_at from eco_private.inbox_sources where id=${quote(manifest.sourceId)}::uuid`)[0];
}
export function verifySource(source, requireActive = true) {
  assert.ok(source, 'Pinned source must exist.');
  assert.equal(source.id, pins.sourceId); assert.equal(source.provider, 'meta-whatsapp-cloud');
  assert.equal(source.account_id, pins.accountId); assert.equal(source.destination_id, pins.phoneNumberId);
  assert.equal(source.channel, 'whatsapp'); assert.equal(source.identity_namespace, pins.identityNamespace);
  assert.equal(source.sender_authority, 'directory', 'Production routing must use Users & Access.');
  if (requireActive) { assert.equal(source.enabled, true); assert.ok(source.provisioned_at && source.scopes_verified_at && source.cutover_at); assert.ok(Date.parse(source.cutover_at) <= Date.now()); }
}
export function validateManifest(value) {
  const legacy = value.kind === 'eco-whatsapp-verification-v1';
  assert.ok(legacy || value.kind === 'eco-whatsapp-verification-v2'); assert.match(value.runId, /^[a-f0-9]{24}$/);
  assert.equal(value.projectRef, target.supabaseProjectRef); assert.equal(value.sourceId, pins.sourceId);
  assert.deepEqual(value.sourcePins, { accountId: pins.accountId, destinationId: pins.phoneNumberId, identityNamespace: pins.identityNamespace });
  assert.equal(value.identities.length, 2);
  if (legacy) assert.equal(value.bindings.length, 2);
  else { assert.equal(value.senderAuthority, 'directory'); assert.equal(value.bindings, undefined); }
  for (const [index, role] of ['owner', 'other'].entries()) {
    const identity = value.identities[index];
    assert.equal(identity.role, role); assert.ok(uuid(identity.id)); assert.equal(identity.email, `eco-whatsapp-${value.runId}-${role}@example.com`);
    if (legacy) { const binding = value.bindings[index]; assert.ok(uuid(binding.id)); assert.equal(binding.ownerId, identity.id); assert.match(binding.sender, /^1999[0-9]{11}$/); }
    else assert.match(identity.sender, /^1999[0-9]{11}$/);
  }
  assert.equal(new Set(value.identities.map(item => item.id)).size, 2);
  assert.match(value.unknownSender, /^1999[0-9]{11}$/);
  assert.equal(new Set([...fixtureSenders(value), value.unknownSender]).size, 3);
  const kinds = ['owner', 'other', 'unknown', 'invalid', 'wrongDestination', 'ok', 'receive', 'mobileReceive', 'otp', 'button', 'status', 'attachment', ...(legacy ? [] : ['ambiguous'])];
  assert.deepEqual(Object.keys(value.messages).sort(), kinds.sort());
  for (const [kind, id] of Object.entries(value.messages)) assert.equal(id, `wamid.eco_${value.runId}_${kind}`);
  assert.ok(Array.isArray(value.requests) && value.requests.every(uuid));
}
function fixtureSenders(value = manifest) { return value.kind === 'eco-whatsapp-verification-v1' ? value.bindings.map(item => item.sender) : value.identities.map(item => item.sender); }
export function directoryPhoneAssignments(value, scenario) {
  validateManifest(value); assert.equal(value.kind, 'eco-whatsapp-verification-v2');
  assert.ok(['normal', 'reassigned', 'ambiguous'].includes(scenario));
  const [owner, other] = value.identities;
  return [
    {id: owner.id, email: owner.email, phone: scenario === 'reassigned' ? '' : '+' + owner.sender},
    {id: other.id, email: other.email, phone: '+' + (scenario === 'normal' ? other.sender : owner.sender)},
  ];
}
function setDirectoryPhones(scenario) {
  const assignments = directoryPhoneAssignments(manifest, scenario);
  const updated = rows(`update eco_private.users u set phone=case ${assignments.map(item => `when u.id=${quote(item.id)}::uuid then ${quote(item.phone)}`).join(' ')} end
    where (${assignments.map(item => `(u.id=${quote(item.id)}::uuid and u.email=${quote(item.email)})`).join(' or ')})
    and exists(select 1 from auth.users a where a.id=u.id and a.email=u.email and a.raw_app_meta_data->>'eco_whatsapp_verification'=${quote(manifest.runId)}) returning u.id,u.phone`);
  assert.deepEqual(updated.sort((a,b) => a.id.localeCompare(b.id)), assignments.map(({id,phone}) => ({id,phone})).sort((a,b) => a.id.localeCompare(b.id)), 'Only exact owned fixture phones may change.');
}
export async function verifyDirectoryReassignment({assignPhones, deliver, receiptRows, ownerPayload, ambiguousPayload, ownerId, ownerMessageId, ambiguousMessageId}) {
  const assertAmbiguous = () => {
    const receipt = receiptRows().find(item => item.provider_message_id === ambiguousMessageId);
    assert.ok(receipt); assert.equal(receipt.status, 'quarantined'); assert.equal(receipt.reason, 'ambiguous_sender');
    for (const field of ['owner_id', 'raw_text', 'subject', 'content_hash']) assert.equal(receipt[field], null);
  };
  try {
    await assignPhones('reassigned'); await deliver(ownerPayload);
    assert.equal(receiptRows().find(item => item.provider_message_id === ownerMessageId)?.owner_id, ownerId, 'Replay must preserve historical ownership.');
    await assignPhones('ambiguous'); await deliver(ambiguousPayload); assertAmbiguous();
  } finally { await assignPhones('normal'); }
  // Removing the ambiguity must not recover content or reroute a quarantined receipt.
  await deliver(ambiguousPayload); assertAmbiguous();
}

function safeFailure(error) {
  return { step, name: error?.name, actual: typeof error?.actual === 'number' ? error.actual : undefined,
    expected: typeof error?.expected === 'number' ? error.expected : undefined,
    location: error?.stack?.split('\n').filter(line => line.includes('verify-whatsapp-intake.mjs:')).slice(0, 2) };
}
async function cleanup() {
  for (const context of contexts) await post(context, '/api/access/logout').catch(() => {});
  for (const browser of browsers) await browser.close().catch(() => {});
  if (!mutationStarted) return;
  mark('cleanup-owned-fixtures'); validateManifest(manifest); verifySource(sourceMetadata(), false);
  const knownIds = identityIds();
  const users = rows(`select id,email,raw_app_meta_data->>'eco_whatsapp_verification' as marker from auth.users where id in (${knownIds}) or email in (${manifest.identities.map(item => quote(item.email)).join(',')})`);
  assert.ok(users.every(row => row.marker === manifest.runId && manifest.identities.some(item => item.id === row.id && item.email === row.email)), 'Fixture account ownership mismatch.');
  const profiles = rows(`select id,email,phone from eco_private.users where id in (${knownIds})`);
  assert.ok(profiles.every(row => users.some(item => item.id === row.id && item.email === row.email)), 'Fixture profile ownership mismatch.');
  if (manifest.kind === 'eco-whatsapp-verification-v2') assert.ok(profiles.every(row => ['', ...fixtureSenders().map(sender => '+' + sender)].includes(row.phone)), 'Fixture phone ownership mismatch.');
  // Retain recovery for old, explicitly owned binding fixtures; new runs create none.
  const legacyBindings = manifest.kind === 'eco-whatsapp-verification-v1' ? manifest.bindings : [];
  const legacyBindingIds = legacyBindings.map(item => `${quote(item.id)}::uuid`).join(',');
  const bindings = rows(`select id,source_id,sender_identity,owner_id from eco_private.inbox_sender_bindings where ${legacyBindings.length ? `id in (${legacyBindingIds}) or ` : ''}owner_id in (${knownIds})`);
  assert.ok(bindings.every(row => row.source_id === manifest.sourceId && manifest.identities.some(item => item.id === row.owner_id) && legacyBindings.some(item => item.id === row.id && item.sender === row.sender_identity)), 'Unexpected binding on owned fixture.');
  const messages = rows(`select id,source_id,provider,account_id,destination_id,provider_message_id,sender_identity,owner_id,status,raw_text,subject,content_hash from eco_private.inbox_messages where provider_message_id in (${messageIds()}) or owner_id in (${knownIds})`);
  assert.ok(messages.every(row => row.source_id === manifest.sourceId && row.provider === 'meta-whatsapp-cloud' && row.account_id === pins.accountId && row.destination_id === pins.phoneNumberId && Object.values(manifest.messages).includes(row.provider_message_id) && [...fixtureSenders(), manifest.unknownSender].includes(row.sender_identity) && (row.status === 'quarantined' ? row.owner_id === null && row.raw_text === null && row.subject === null && row.content_hash === null : manifest.identities.some(item => item.id === row.owner_id) && [bodyFor('owner'), bodyFor('other')].includes(row.raw_text))), 'Fixture message ownership mismatch.');
  const mutations = rows(`select owner_id,input->>'id' as message_id from eco_private.inbox_mutations where owner_id in (${knownIds})`);
  assert.ok(mutations.every(row => manifest.identities.some(item => item.id === row.owner_id) && messages.some(item => item.id === row.message_id)), 'Fixture mutation ownership mismatch.');
  const auditBefore = rows(`select (select count(*) from eco_private.access_audit where actor_id in (${knownIds}) or target_id in (${knownIds})) as access_count,(select count(*) from eco_private.administration_events where actor_id in (${knownIds})) as event_count`)[0];
  rows(`begin;
    update eco_private.users set is_active=false where id in (${knownIds});
    delete from eco_private.inbox_mutations where owner_id in (${knownIds});
    delete from eco_private.inbox_messages where source_id=${quote(manifest.sourceId)}::uuid and provider_message_id in (${messageIds()});
    ${legacyBindings.length ? `delete from eco_private.inbox_sender_bindings where id in (${legacyBindingIds}) and source_id=${quote(manifest.sourceId)}::uuid;` : ''}
    delete from eco_private.administration_requests where actor_id in (${knownIds});
    delete from eco_private.admin_operations where actor_id in (${knownIds}) or target_id in (${knownIds});
    delete from eco_private.role_previews where user_id in (${knownIds});
    delete from eco_private.revoked_sessions where user_id in (${knownIds});
    delete from eco_private.users where id in (${knownIds});commit;`);
  for (const user of users) { const deleted = await service.auth.admin.deleteUser(user.id); if (deleted.error) assert.equal(rows(`select id from auth.users where id=${quote(user.id)}::uuid`).length, 0, 'Auth cleanup outcome unresolved.'); }
  assert.equal(rows(`select id from auth.users where id in (${knownIds})`).length, 0);
  assert.equal(rows(`select id from eco_private.users where id in (${knownIds})`).length, 0);
  assert.equal(rows(`select id from eco_private.inbox_sender_bindings where ${legacyBindings.length ? `id in (${legacyBindingIds}) or ` : ''}owner_id in (${knownIds})`).length, 0);
  assert.equal(rows(`select id from eco_private.inbox_messages where provider_message_id in (${messageIds()}) or owner_id in (${knownIds})`).length, 0);
  assert.equal(rows(`select request_id from eco_private.inbox_mutations where owner_id in (${knownIds})`).length, 0);
  const auditAfter = rows(`select (select count(*) from eco_private.access_audit where actor_id in (${knownIds}) or target_id in (${knownIds})) as access_count,(select count(*) from eco_private.administration_events where actor_id in (${knownIds})) as event_count`)[0];
  assert.deepEqual(auditAfter, auditBefore, 'Audit records must remain.');
  manifest.cleanupComplete = true; save(); privateWrite(join(output, 'query.private.sql'), '-- Exact owned fixtures removed; source and audit retained.\n');
}
async function verifyDisabled(sourceBefore) {
  mark('disabled-preflight'); assert.equal(sourceBefore.enabled, false, 'Stage 1 requires a disabled source.');
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(), manifest.commit);
  assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {cwd: root, encoding: 'utf8'}).trim(), '', 'Stage 1 requires a clean committed checkout.');
  const source = await sourceFingerprint(root), migration = await migrationFingerprint(root);
  const releaseId = buildLogFingerprint(deploymentLogs(), source.sha256);
  const appSecret = privateFile(process.env.ECO_WHATSAPP_APP_SECRET_FILE).trim(), verifyToken = privateFile(process.env.ECO_WHATSAPP_VERIFY_TOKEN_FILE).trim();
  assert.match(appSecret, /^[a-f0-9]{32}$/i); assert.match(verifyToken, /^[A-Za-z0-9_-]{32,256}$/);
  privateFile(process.env.ECO_PROTECTION_COOKIES);
  const browser = await chromium.launch({headless: true});
  try {
    const context = await browser.newContext(); await installStagingCookies(context, manifest.base);
    const response = await context.request.get(manifest.base, {timeout: 45000, maxRedirects: 0}); assert.equal(response.status(), 200);
    const html = await response.text(), localHtml = readFileSync(join(root, 'dist/index.html'), 'utf8');
    const assets = value => [...new Set([...value.matchAll(/(?:src|href)=["'](\/assets\/[^"'<>?]+)["']/g)].map(match => match[1]))].sort();
    const paths = assets(localHtml); assert.ok(paths.some(path => path.endsWith('.js')) && paths.some(path => path.endsWith('.css')));
    assert.deepEqual(assets(html), paths, 'Staged HTML must reference the locally verified entry assets.');
    const assetEvidence = [];
    for (const path of paths) {
      assert.match(path, /^\/assets\/[A-Za-z0-9_.-]+$/);
      const remote = await context.request.get(manifest.base + path, {timeout: 45000, maxRedirects: 0}); assert.equal(remote.status(), 200);
      const bytes = await remote.body(), local = readFileSync(join(root, 'dist', path.slice(1)));
      assert.deepEqual(bytes, local, 'Staged entry asset differs from local verified build.');
      assetEvidence.push({path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length});
    }
    await json(await getResponse(context), 401); checks.push('anonymous-inbox-denied');
    const challenge = String(Date.now());
    const challengeUrl = token => `${manifest.base}/api/enquiries/whatsapp?${new URLSearchParams({'hub.mode':'subscribe','hub.verify_token':token,'hub.challenge':challenge})}`;
    const accepted = await context.request.get(challengeUrl(verifyToken), {timeout: 45000, maxRedirects: 0}); assert.equal(accepted.status(), 200); assert.equal(await accepted.text(), challenge); assert.match(accepted.headers()['cache-control'] ?? '', /no-store/);
    await json(await context.request.get(challengeUrl((verifyToken[0] === '0' ? '1' : '0') + verifyToken.slice(1)), {timeout: 45000, maxRedirects: 0}), 403);
    // A status-only envelope cannot create a receipt even if an unexpected deployment is active.
    // Disabled mode runs before HMAC verification, so this proves the activation gate, not live signature handling.
    const bytes = Buffer.from(JSON.stringify({object:'whatsapp_business_account',entry:[{id:pins.accountId,changes:[{field:'messages',value:{messaging_product:'whatsapp',metadata:{phone_number_id:pins.phoneNumberId,display_phone_number:pins.displayPhoneNumber},messages:[],statuses:[]}}]}]}));
    const signature = createHmac('sha256', appSecret).update(bytes).digest('hex');
    for (const signatureValue of [signature, '0'.repeat(64)]) {
      const result = await json(await context.request.post(manifest.base + '/api/enquiries/whatsapp', {headers:{'content-type':'application/json','x-hub-signature-256':`sha256=${signatureValue}`},data:bytes,timeout:45000,maxRedirects:0}), 503);
      assert.deepEqual(result, {error:'not_configured'});
    }
    checks.push('challenge-accepted', 'wrong-verification-token-denied', 'signed-and-invalid-posts-disabled');
    assert.deepEqual(sourceMetadata(), sourceBefore, 'Preflight must not change source configuration.');
    manifest.build = {sourceSha256: source.sha256, releaseId, migrationSha256: migration.sha256, migrationHead: migration.bundledHead};
    manifest.completed = true; manifest.cleanupComplete = true; save();
    privateWrite(join(output, 'verification.json'), JSON.stringify({mode:'disabled-preflight',base:manifest.base,deploymentId:manifest.deploymentId,commit:manifest.commit,deploymentEvidence:manifest.deploymentEvidence,build:manifest.build,completed:true,cleanupComplete:true,cleanupRequired:false,cloudMutations:0,providerMessagesSent:0,actualMetaDeliveryVerified:false,assets:assetEvidence,checks,limits:'Read-only disabled-stage check. Status-only signed probes prove the activation gate, not live HMAC ingestion. No fixture identity, binding, receipt, app login, provider subscription or activation was created.'}, null, 2));
    console.log(JSON.stringify({mode:'disabled-preflight',completed:true,cloudMutations:0,report:join(output,'verification.json')}));
  } finally { await browser.close(); }
}

async function verify() {
  const mode = verificationMode(process.argv.slice(2));
  const disabledPreflight = mode === 'disabled-preflight';
  assert.ok(pins && uuid(pins.sourceId) && /^[0-9]+$/.test(pins.accountId) && /^[0-9]+$/.test(pins.phoneNumberId), 'Verified canonical WhatsApp pins required.');
  assert.equal(pins.identityNamespace, 'meta-whatsapp-signed-v1');
  if (cleanupPath) {
    assert.ok(isAbsolute(cleanupPath)); manifest = JSON.parse(privateFile(cleanupPath)); validateManifest(manifest);
    output = dirname(cleanupPath); recovery = cleanupPath; mutationStarted = Boolean(manifest.mutationStarted);
  } else {
    const runId = randomBytes(12).toString('hex'), digits = String(BigInt('0x' + randomBytes(5).toString('hex')) % 10000000000n).padStart(10, '0');
    const identities = ['owner', 'other'].map((role, index) => ({ role, id: randomUUID(), email: `eco-whatsapp-${runId}-${role}@example.com`, sender: `1999${digits}${index + 1}` }));
    const kinds = ['owner', 'other', 'unknown', 'invalid', 'wrongDestination', 'ok', 'receive', 'mobileReceive', 'otp', 'button', 'status', 'attachment', 'ambiguous'];
    manifest = { kind: 'eco-whatsapp-verification-v2', senderAuthority: 'directory', mode, runId, base: process.env.ECO_VERIFY_ORIGIN, deploymentId: process.env.ECO_VERIFY_DEPLOYMENT_ID, commit: process.env.ECO_VERIFY_COMMIT, projectRef: target.supabaseProjectRef, sourceId: pins.sourceId, sourcePins: { accountId: pins.accountId, destinationId: pins.phoneNumberId, identityNamespace: pins.identityNamespace }, identities,
      unknownSender: `1999${digits}9`, messages: Object.fromEntries(kinds.map(kind => [kind, `wamid.eco_${runId}_${kind}`])), requests: [], mutationStarted: false, completed: false, cleanupComplete: false };
    validateManifest(manifest); output = join(root, 'output/access', `whatsapp-intake-${runId}`); recovery = join(output, 'recovery.private.json');
    assert.ok(manifest.base && new URL(manifest.base).origin === manifest.base && new URL(manifest.base).protocol === 'https:');
    assert.match(new URL(manifest.base).hostname, /^[a-z0-9-]+\.vercel\.app$/, 'Use an exact staged deployment.');
    assert.match(manifest.deploymentId ?? '', /^dpl_[A-Za-z0-9]+$/); assert.match(manifest.commit ?? '', /^[a-f0-9]{40}$/);
  }
  mkdirSync(output, { recursive: true, mode: 0o700 }); chmodSync(output, 0o700); save();
  mark('verify-targets');
  assert.equal(JSON.parse(sb(['whoami', '--output-format', 'json'])).username, 'hocheunglai-oss');
  const project = JSON.parse(sb(['projects', 'list', '--output', 'json'])).find(item => item.id === target.supabaseProjectRef);
  assert.equal(project?.organization_id, target.supabaseOrganizationId); assert.equal(project?.region, target.supabaseRegion); assert.equal(project?.name, 'ECO'); assert.equal(project?.status, 'ACTIVE_HEALTHY');
  if (!cleanupPath) {
    const linked = JSON.parse(readFileSync(join(root, '.vercel/project.json'), 'utf8')); assert.equal(linked.projectId, target.vercel.projectId); assert.equal(linked.orgId, target.vercel.teamId);
    assert.equal(vc(['whoami']).trim(), process.env.ECO_VERIFY_VERCEL_USER || 'hocheunglai-6535');
    const compact = JSON.parse(vc(['inspect', manifest.base, '--json', '--scope', target.vercel.teamId]));
    assert.equal(compact.id, manifest.deploymentId); assert.equal(compact.url, new URL(manifest.base).hostname);
    const raw = JSON.parse(vc(['api', `/v13/deployments/${manifest.deploymentId}?teamId=${target.vercel.teamId}`, '--scope', target.vercel.teamId]));
    manifest.deploymentEvidence = deploymentIdentity(mergeDeploymentMetadata(compact, raw, manifest), manifest); save();
  }
  if (cleanupPath) { service = loadServiceClient(); await cleanup(); console.log(JSON.stringify({ cleanupComplete: manifest.cleanupComplete, recovery })); return; }
  mark('migration-and-source-preflight');
  const required = readdirSync(join(root, 'supabase/migrations')).filter(name => /^\d{14}_.+\.sql$/.test(name)).map(name => name.slice(0, 14)).sort();
  assert.deepEqual(rows('select version from supabase_migrations.schema_migrations order by version').map(row => String(row.version)).sort(), required);
  const head = readdirSync(join(root, 'supabase/migrations')).find(name => /^\d{14}_eco_whatsapp_intake\.sql$/.test(name))?.slice(0, 14); assert.ok(head);
  assert.equal(rows("select migration_head from eco_private.platform_versions where component='whatsapp-intake'")[0]?.migration_head, head);
  const sourceBefore = sourceMetadata(); verifySource(sourceBefore, !disabledPreflight);
  if (disabledPreflight) { await verifyDisabled(sourceBefore); return; }
  service = loadServiceClient();
  assert.equal(rows("select id from eco_private.offices where id='HONG KONG'").length, 1, 'Fixture office must already exist.');
  assert.equal(rows(`select id from eco_private.inbox_sender_bindings where source_id=${quote(manifest.sourceId)}::uuid and sender_identity in (${[...fixtureSenders(), manifest.unknownSender].map(quote).join(',')})`).length, 0);
  assert.equal(rows(`select id from eco_private.users where phone in (${[...fixtureSenders(), manifest.unknownSender].map(sender => quote('+' + sender)).join(',')}) or id in (${identityIds()}) or lower(email) in (${manifest.identities.map(item => quote(item.email)).join(',')})`).length, 0, 'Synthetic directory identities must be unused.');
  assert.equal(rows(`select id from eco_private.inbox_messages where provider_message_id in (${messageIds()})`).length, 0);
  const appSecret = privateFile(process.env.ECO_WHATSAPP_APP_SECRET_FILE).trim(), verifyToken = privateFile(process.env.ECO_WHATSAPP_VERIFY_TOKEN_FILE).trim();
  assert.match(appSecret, /^[a-f0-9]{32}$/i); assert.ok(verifyToken.length >= 32 && verifyToken.length <= 256);
  privateFile(process.env.ECO_PROTECTION_COOKIES);
  const passwords = manifest.identities.map(() => `EcoWhatsApp9-${randomBytes(24).toString('base64url')}`);
  try {
    const browser = await chromium.launch({ headless: true }); browsers.push(browser);
    const owner = await newContext(browser), other = await newContext(browser), anonymous = await newContext(browser);
    await json(await getResponse(anonymous), 401);
    const challenge = String(Date.now());
    const handshake = await anonymous.request.get(`${manifest.base}/api/enquiries/whatsapp?${new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': verifyToken, 'hub.challenge': challenge })}`, {timeout: 45000, maxRedirects: 0});
    assert.equal(handshake.status(), 200); assert.equal(await handshake.text(), challenge); checks.push('verified-token-challenge');
    mark('create-owned-fixtures'); manifest.mutationStarted = mutationStarted = true; save();
    for (const [index, identity] of manifest.identities.entries()) {
      const result = await service.auth.admin.createUser({ id: identity.id, email: identity.email, password: passwords[index], email_confirm: true, app_metadata: { eco_whatsapp_verification: manifest.runId } });
      assert.ifError(result.error); assert.equal(result.data.user?.id, identity.id);
      const profile = { displayName: `ECO WHATSAPP ${identity.role.toUpperCase()}`, officeId: 'HONG KONG', isAdmin: index === 0, isSpcTrader: false, isManager: false, isActive: true, sourceSpcId: randomUUID() };
      rows(`begin;select eco_private.provision_user(${quote(identity.id)}::uuid,${quote(JSON.stringify(profile))}::jsonb);update eco_private.users set activated_at=now(),password_prompt_dismissed_at=now() where id=${quote(identity.id)}::uuid;commit;`);
    }
    await login(owner, manifest.identities[0], passwords[0]); await login(other, manifest.identities[1], passwords[1]);
    const system = await json(await get(owner, '/api/admin/system-information')), source = await sourceFingerprint(root), migration = await migrationFingerprint(root);
    assert.equal(system.targets.databaseProjectRef, target.supabaseProjectRef); assert.equal(system.targets.databaseRegion, target.supabaseRegion);
    assert.equal(system.build.gitCommit, manifest.commit); assert.equal(system.build.sourceSha256, source.sha256); assert.equal(system.migrations.sha256, migration.sha256); assert.equal(system.migrations.bundledHead, migration.bundledHead);
    manifest.build = { sourceSha256: source.sha256, migrationSha256: migration.sha256, migrationHead: migration.bundledHead }; save();
    setDirectoryPhones('normal');
    assert.equal(rows(`select id from eco_private.inbox_sender_bindings where owner_id in (${identityIds()})`).length, 0);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const message = (kind, sender, text) => ({ id: manifest.messages[kind], from: sender, timestamp, type: 'text', text: { body: text } });
    const envelope = (messages = [], statuses = [], destination = pins.phoneNumberId) => ({ object: 'whatsapp_business_account', entry: [{ id: pins.accountId, changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: destination, display_phone_number: pins.displayPhoneNumber }, contacts: [...new Set(messages.map(item => item.from))].map(wa_id => ({ wa_id })), messages, statuses } }] }] });
    const deliver = async (payload, valid = true) => {
      const bytes = Buffer.from(JSON.stringify(payload)), signature = createHmac('sha256', appSecret).update(bytes).digest('hex');
      const response = await anonymous.request.post(manifest.base + '/api/enquiries/whatsapp', { headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${valid ? signature : '0'.repeat(64)}` }, data: bytes, timeout: 45000, maxRedirects: 0 });
      const result = await json(response, valid ? 200 : 401); if (valid) assert.deepEqual(result, { received: true });
    };
    const receiptRows = () => rows(`select id,provider_message_id,owner_id,status,reason,raw_text,subject,content_hash,read_at from eco_private.inbox_messages where source_id=${quote(manifest.sourceId)}::uuid and provider_message_id in (${messageIds()})`);
    mark('signed-delivery-and-duplicate');
    const ownerPayload = envelope([message('owner', manifest.identities[0].sender, bodyFor('owner'))]);
    await deliver(ownerPayload); await deliver(ownerPayload);
    let receipts = receiptRows(); assert.equal(receipts.length, 1); assert.equal(receipts[0].owner_id, manifest.identities[0].id); assert.equal(receipts[0].status, 'accepted'); assert.equal(receipts[0].raw_text, bodyFor('owner')); const ownerReceiptId = receipts[0].id;
    await verifyDirectoryReassignment({assignPhones: setDirectoryPhones, deliver, receiptRows, ownerPayload,
      ambiguousPayload: envelope([message('ambiguous', manifest.identities[0].sender, bodyFor('owner'))]),
      ownerId: manifest.identities[0].id, ownerMessageId: manifest.messages.owner, ambiguousMessageId: manifest.messages.ambiguous});
    checks.push('directory-routing-without-bindings', 'signed-text-durable-once', 'duplicate-retains-original-owner', 'ambiguous-directory-contentless', 'quarantine-stays-after-directory-correction');
    mark('rejected-and-control-envelopes');
    await deliver(envelope([message('unknown', manifest.unknownSender, `SYNTHETIC UNKNOWN ${manifest.runId}`)]));
    await deliver(envelope([message('invalid', manifest.identities[0].sender, bodyFor('owner'))]), false);
    await deliver(envelope([message('wrongDestination', manifest.identities[0].sender, bodyFor('owner'))], [], pins.phoneNumberId === '1' ? '2' : '1'));
    await deliver(envelope([
      message('ok', manifest.identities[0].sender, 'OK'), message('receive', manifest.identities[0].sender, `RECEIVE_${manifest.runId}`),
      message('mobileReceive', manifest.identities[0].sender, `MOBILE_RECEIVE_${manifest.runId}`), message('otp', manifest.identities[0].sender, '123456'),
      { id: manifest.messages.button, from: manifest.identities[0].sender, timestamp, type: 'button', button: { payload: 'ACK', text: 'OK' } },
    ], [{ id: manifest.messages.status, status: 'delivered', timestamp, recipient_id: manifest.identities[0].sender }]));
    await deliver(envelope([{ id: manifest.messages.attachment, from: manifest.identities[0].sender, timestamp, type: 'image', image: { id: 'SYNTHETIC_MEDIA_NOT_FETCHED', caption: 'SYNTHETIC NOT IMPORTED' } }]));
    receipts = receiptRows(); assert.equal(receipts.length, 4);
    for (const [kind, reason] of [['unknown', 'unknown_sender'], ['attachment', 'unsupported_attachment']]) {
      const row = receipts.find(item => item.provider_message_id === manifest.messages[kind]); assert.ok(row); assert.equal(row.status, 'quarantined'); assert.equal(row.reason, reason);
      for (const field of ['owner_id', 'raw_text', 'subject', 'content_hash']) assert.equal(row[field], null);
    }
    checks.push('unknown-sender-contentless', 'unsupported-attachment-contentless', 'invalid-signature-denied', 'wrong-destination-ignored', 'status-controls-otp-ignored');
    await deliver(envelope([message('other', manifest.identities[1].sender, bodyFor('other'))]));
    const ownerItems = await json(await getResponse(owner)), otherItems = await json(await getResponse(other));
    assert.equal(ownerItems.items.length, 1); assert.equal(ownerItems.items[0].id, ownerReceiptId); assert.equal(ownerItems.items[0].rawText, bodyFor('owner')); assert.equal(ownerItems.items[0].channel, 'whatsapp');
    assert.equal(otherItems.items.length, 1); assert.equal(otherItems.items[0].owner, manifest.identities[1].id); assert.notEqual(otherItems.items[0].id, ownerReceiptId);
    const requestId = randomUUID(); manifest.requests.push(requestId); save();
    await json(await post(other, '/api/enquiries/inbox', { requestId, action: 'read', id: ownerReceiptId }, { 'x-eco-data-mode': 'live' }), 404);
    await json(await get(owner, '/api/enquiries/inbox?limit=50', { 'x-eco-data-mode': 'test' }), 403);
    await json(await post(owner, '/api/access/preview', { role: 'trader', officeId: 'HONG KONG' }));
    assert.deepEqual(await json(await getResponse(owner)), { items: [], nextCursor: null, unreadCount: 0 });
    const previewRequest = randomUUID(); manifest.requests.push(previewRequest); save();
    await json(await post(owner, '/api/enquiries/inbox', { requestId: previewRequest, action: 'read', id: ownerReceiptId }, { 'x-eco-data-mode': 'live' }), 403);
    await json(await post(owner, '/api/access/preview/end'));
    checks.push('other-owner-read-denied', 'test-mode-denied', 'view-as-denied', 'anonymous-read-denied');
    mark('real-owner-notification-to-parser');
    for (const [engine, kind, width, theme] of [['chromium', chromium, 1440, 'light'], ['webkit', webkit, 320, 'dark']]) {
      const activeBrowser = engine === 'chromium' ? browser : await kind.launch({ headless: true }); if (engine !== 'chromium') browsers.push(activeBrowser);
      const context = await newContext(activeBrowser, { viewport: { width, height: 1000 }, isMobile: width < 760, hasTouch: width < 760, colorScheme: theme, reducedMotion: 'reduce' });
      await login(context, manifest.identities[0], passwords[0]); await context.addInitScript(value => localStorage.setItem('ecosystem.theme.v1', value), theme);
      const page = await context.newPage(), errors = []; page.on('pageerror', () => errors.push('runtime'));
      page.on('request', req => { if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/enquiries/inbox') { const value = req.postDataJSON(); if (uuid(value?.requestId) && !manifest.requests.includes(value.requestId)) { manifest.requests.push(value.requestId); save(); } } });
      await page.goto(manifest.base, { waitUntil: 'domcontentloaded' }); await page.getByRole('button', { name: 'Notifications', exact: true }).click();
      const panel = page.getByRole('region', { name: 'Notifications', exact: true }); await expect(panel).toContainText('ECO WHATSAPP OWNER');
      await page.screenshot({ path: join(output, `${engine}-${width}-${theme}-notification.png`), fullPage: true });
      await panel.locator('.inbox-item').filter({ hasText: 'ECO WHATSAPP OWNER' }).click();
      const enquiry = page.getByRole('dialog', { name: 'Enquiries', exact: true });
      await expect(enquiry.getByRole('textbox', { name: 'Raw enquiry', exact: true })).toHaveValue(bodyFor('owner'));
      await expect(enquiry.getByRole('textbox', { name: 'Vessel', exact: true })).toHaveValue('ECO WHATSAPP OWNER');
      await expect(enquiry.getByRole('textbox', { name: 'VLSFO', exact: true })).toHaveValue('500');
      await expect.poll(() => Boolean(receiptRows().find(item => item.id === ownerReceiptId)?.read_at), { intervals: [500, 1000, 2000] }).toBe(true);
      await enquiry.getByRole('textbox', { name: 'Vessel', exact: true }).scrollIntoViewIfNeeded();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: join(output, `${engine}-${width}-${theme}-parser.png`), fullPage: true });
      await page.reload({ waitUntil: 'domcontentloaded' }); await page.getByRole('button', { name: 'Notifications', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Notifications', exact: true }).locator('.inbox-item')).not.toHaveClass(/is-unread/);
      assert.deepEqual(errors, []); await json(await post(context, '/api/access/logout')); await context.close();
      checks.push(`${engine}:${width}:${theme}:real-notification-parser-read-reload`);
    }
    assert.deepEqual(sourceMetadata(), sourceBefore, 'Verification must not mutate source configuration.');
    manifest.completed = true; save();
  } catch (error) { failure = safeFailure(error); save(); throw error; } finally { await cleanup(); }
  privateWrite(join(output, 'verification.json'), JSON.stringify({ base: manifest.base, deploymentId: manifest.deploymentId, commit: manifest.commit, build: manifest.build, completed: manifest.completed, cleanupComplete: manifest.cleanupComplete, checks, providerMessagesSent: 0, actualMetaDeliveryVerified: false, limits: 'Signed synthetic requests exercised the real staged receiver, database, owner API and browser. Upstream Meta subscription and a real handset message remain a separate activation check. Directory authority verified without manual sender bindings. No real user phones or source configuration changed. Native Safari/physical devices not tested.' }, null, 2));
  console.log(JSON.stringify({ completed: manifest.completed, cleanupComplete: manifest.cleanupComplete, report: join(output, 'verification.json') }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verify().catch(error => { console.error(JSON.stringify({ failed: true, failure: failure ?? safeFailure(error), cleanupComplete: manifest?.cleanupComplete, recovery: mutationStarted ? recovery : undefined })); process.exitCode = 1; });
}
