import { hostedMigrationHistory, assertHostedMigrationHistory, hostedMigrationVersion } from './hosted-migration-history.mjs';
/** Operator-only verification against one exact ECO staged deployment. No staff fixtures. */
import assert from 'node:assert/strict';
import { chromium, webkit, expect as baseExpect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { ecoConnections as target } from '../config/ecoConnections.ts';
import { installStagingCookies } from '../tests/fixtures/protection-cookies.mjs';
import { sourceFingerprint, migrationFingerprint } from './generate-system-information.mjs';
import { PARSER_VERSION, emptyParserFields } from '../shared/parserService.ts';
import { rawParserSnapshot } from '../shared/parserReplay.ts';

const expect = baseExpect.configure({ timeout: 30_000 });
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runId = randomBytes(8).toString('hex');
const output = join(root, 'output', 'access', `release-gates-${runId}`);
const notice = 'UNDER CONSTRUCTION: TO BE RELEASED WITH ECO 2.0';
const roles = [['trader', 'Normal trader'], ['spc-trader', 'SPC Trader'], ['manager', 'Manager'], ['credit', 'Credit']];
const identities = ['admin', 'trader'].map(role => ({ role, id: randomUUID(), email: `eco-release-${runId}-${role}@example.com` }));
const passwords = Object.fromEntries(identities.map(i => [i.role, `EcoRelease9-${randomBytes(24).toString('base64url')}`]));
const fixtures = ['buyer', 'country', 'port'].map(kind => ({ kind, id: `eco-release-${runId}-${kind}` }));
const [buyer] = fixtures;
const requests = [], parserRequests = [], parserReports = [], parserReviewRequests = [], contexts = [], browsers = [], checks = [], browserResults = [];
const parserSource = `Vessel: SYNTHETIC RELEASE ${runId}\nIMO: 9319466\nBuyer: ALPHA SHIPPING\nPort: Singapore\nETA: 15-17 October 2026\nVLSFO: 450 MT\nRemarks: SYNTHETIC RELEASE CHECK — no customer content`;
const verifyParserReview = process.argv.includes('--allow-live-ai-review');
let liveAiRequests = 0, parserReviewVerified = false;
const parserRevision = `cloud:${runId}`;
const inboxSource = `SYNTHETIC INBOX VERIFICATION ${runId} — no staff content`;
const inboxRequests = [];
const inboxFixture = { id: randomUUID(), provider: `verification-${runId}`, account: `account-${runId}`, destination: `destination-${runId}`, namespace: `verification-${runId}`, sender: `sender-${runId}`, receivedAt: new Date().toISOString(), messages: Array.from({length:4},()=>randomUUID()) };
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const privateWrite = (path, contents) => { writeFileSync(path, contents, { mode: 0o600 }); chmodSync(path, 0o600); };
const command = args => execFileSync('pnpm', args, { cwd: root, encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 });
const sb = args => command(['dlx', '--allow-build=supabase', 'supabase@2.120.0', ...args]);
const vc = args => command(['dlx', 'vercel@63.1.2', ...args]);
let step = 'arguments', base, service, publishable, completed = false, cleanupComplete = false, mutationStarted = false, deploymentId, failure, currentPage;
function save() { privateWrite(join(output, 'recovery.private.json'), JSON.stringify({ runId, step, base, deploymentId, projectRef: target.supabaseProjectRef, identities, fixtures, requests, parserRequests, parserReports, parserReviewRequests, verifyParserReview, liveAiRequests, parserReviewVerified, inboxFixture, inboxRequests, mutationStarted, completed, cleanupComplete, failure }, null, 2)); }
function mark(value) { step = value; save(); console.log(JSON.stringify({ step })); }
function rows(sql) {
  privateWrite(join(output, 'query.private.sql'), sql);
  const result = JSON.parse(sb(['db', 'query', '--linked', '--project-ref', target.supabaseProjectRef, '--file', join(output, 'query.private.sql'), '--output', 'json']));
  const data = Array.isArray(result) ? result : result.rows;
  assert.ok(Array.isArray(data), 'SQL result must contain rows.'); return data;
}
const post = (context, path, data = {}) => context.request.post(base + path, { headers: { origin: base, 'x-eco-request': '1' }, data, timeout: 45_000 });
const get = (context, path) => context.request.get(base + path, { timeout: 45_000 });
const tabsUrl = item => `/api/profile-tabs/list?${new URLSearchParams(item)}`;
async function json(response, status = 200) {
  assert.equal(response.status(), status, `${new URL(response.url()).pathname}: unexpected HTTP status`);
  assert.match(response.headers()['cache-control'] ?? '', /no-store/, 'Application responses must not be cached.');
  return response.json();
}
function writeInput(item, revision = 0, tabs = [], visibility = 'private') {
  const input = { requestId: randomUUID(), target: item, visibility, revision, tabs };
  requests.push(input.requestId); save(); return input;
}
const tab = text => ({ id: randomUUID(), title: `SYNTHETIC ${text}`, visibility: 'private', content: `Owned verification only: ${runId} ${text}` });
async function directRpc(context, name, args) {
  const cookies = await context.cookies(base);
  // Use the application's exact provider session, so VIEW AS cannot be tested with another JWT.
  const sessionReader = createServerClient(`https://${target.supabaseProjectRef}.supabase.co`, publishable, {
    auth: { persistSession: false, autoRefreshToken: false },
    cookieOptions: { name: 'eco-auth' },
    cookies: { getAll: () => cookies.map(({ name, value }) => ({ name, value })), setAll: () => {} },
  });
  const session = await sessionReader.auth.getSession();
  assert.ifError(session.error); assert.ok(session.data.session?.access_token, 'Expected authenticated fixture session.');
  const response = await fetch(`https://${target.supabaseProjectRef}.supabase.co/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { apikey: publishable, Authorization: `Bearer ${session.data.session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args), signal: AbortSignal.timeout(30_000), redirect: 'error',
  });
  return { status: response.status, body: await response.json() };
}
async function deniedRpc(context, name, args) {
  const result = await directRpc(context, name, args);
  assert.equal(result.status, 403, `${name}: direct RPC must deny access`);
  assert.equal(result.body.code, '42501');
}
async function buyerDenied(context) {
  await json(await get(context, tabsUrl(buyer)), 403);
  const input = writeInput(buyer, 0, [tab('DENIED')]);
  for (const [path, body, rpc] of [
    ['save', input, 'eco_save_profile_tabs'],
    ['delete', { requestId: input.requestId, target: buyer, visibility: 'private', revision: 0, id: input.tabs[0].id }, 'eco_delete_profile_tab'],
    ['reorder', { requestId: input.requestId, target: buyer, visibility: 'private', revision: 0, ids: [] }, 'eco_reorder_profile_tabs'],
  ]) {
    await json(await post(context, `/api/profile-tabs/${path}`, body), 403);
    await deniedRpc(context, rpc, { p_input: body });
  }
  await deniedRpc(context, 'eco_list_profile_tabs', { p_target: buyer });
  for (const item of fixtures.slice(1)) {
    const result = await json(await get(context, tabsUrl(item))); assert.deepEqual(result.target, item);
    const direct = await directRpc(context, 'eco_list_profile_tabs', { p_target: item }); assert.equal(direct.status, 200);
  }
}
function parserInput(dataMode = 'live') {
  const input = { requestId: randomUUID(), rawText: parserSource, sourceRevision: parserRevision, parserVersion: PARSER_VERSION, dataMode, current: emptyParserFields(), ...(dataMode === 'test' ? { generation: randomUUID() } : {}) };
  parserRequests.push(input.requestId); save(); return input;
}
function parserReportInput(extra = {}) {
  const input = { requestId: randomUUID(), rawText: parserSource, sourceRevision: parserRevision, parserVersion: PARSER_VERSION, dataMode: 'live', parsed: emptyParserFields(), corrected: { ...emptyParserFields(), vessel: 'SYNTHETIC RELEASE CHECK' }, notes: `Owned verification only: ${runId}`, ...extra };
  parserReports.push(input.requestId); save(); return input;
}
async function parserDenied(context, { preview = false } = {}) {
  assert.deepEqual(await json(await get(context, '/api/enquiries/test-policy')), { enabled: false, generation: '' });
  const input = parserInput('test');
  // Never POST a live request to /fix. A fixture is never Otto; SQL rejects this
  // namespace before a provider can run, regardless of model configuration.
  await deniedRpc(context, 'eco_begin_parser_ai', { p_input: { ...input, sourceHash: createHash('sha256').update(parserSource).digest('hex') } });
  await json(await post(context, '/api/parser/fix', input), 403);
  const report = parserReportInput({ dataMode: 'test', generation: input.generation });
  await json(await post(context, '/api/parser/reports', report), 403);
  await deniedRpc(context, 'eco_create_parser_report', { p_input: report });
  await json(await get(context, `/api/parser/reports?dataMode=test&generation=${input.generation}`), 403);
  if (preview) {
    await json(await post(context, '/api/parser/reports', parserReportInput()), 403);
    await json(await get(context, '/api/parser/reports?dataMode=live'), 403);
  }
}
async function parserProtocol(admin, trader, fingerprint) {
  mark('parser-owned-receipt-and-report-protocol');
  for (const context of [admin, trader]) await parserDenied(context);
  await json(await get(trader, '/api/parser/reports?dataMode=live'), 403);
  const original = rawParserSnapshot(parserSource);
  assert.ok(original.fields.vessel && original.fields.portText && original.fields.vlsfo);
  const input = { ...parserInput(), current: original.fields }, sourceHash = createHash('sha256').update(parserSource).digest('hex');
  // This direct receipt call has no provider integration. The only completion
  // below is an explicitly synthetic result for the exact owned request.
  const begun = await directRpc(trader, 'eco_begin_parser_ai', { p_input: { ...input, sourceHash } });
  assert.equal(begun.status, 200); assert.equal(begun.body.runProvider, true); assert.equal(begun.body.state, 'pending');
  const retry = await directRpc(trader, 'eco_begin_parser_ai', { p_input: { ...input, sourceHash } });
  assert.equal(retry.status, 200); assert.equal(retry.body.runProvider, false);
  const result = { requestId: input.requestId, sourceHash, sourceRevision: parserRevision, parserVersion: PARSER_VERSION, model: 'fixture-no-provider', suggestions: [{ field: 'remarks', value: 'SYNTHETIC AI PROPOSAL NOT APPLIED', evidence: 'SYNTHETIC RELEASE CHECK' }], warnings: [] };
  const finishArgs = { p_actor_id: identities[1].id, p_request_id: input.requestId, p_result: result, p_error_code: null };
  await deniedRpc(trader, 'eco_finish_parser_ai', finishArgs);
  const finished = await service.rpc('eco_finish_parser_ai', finishArgs); assert.ifError(finished.error); assert.equal(finished.data.state, 'complete'); assert.deepEqual(finished.data.result, result);
  const completed = await directRpc(trader, 'eco_begin_parser_ai', { p_input: { ...input, sourceHash } });
  assert.equal(completed.status, 200); assert.equal(completed.body.runProvider, false); assert.deepEqual(completed.body.result, result);
  const submitted = structuredClone(original); submitted.fields.vessel = 'SYNTHETIC TRADER CORRECTION';
  submitted.standardText = original.standardText.replace(original.fields.vessel.toUpperCase(), submitted.fields.vessel);
  const report = parserReportInput({ aiRequestId: input.requestId, parsed: original.fields, corrected: submitted.fields,
    capture: { original, submitted, originalRevision: parserRevision, parseOrigin: 'initial' } });
  const saved = await json(await post(trader, '/api/parser/reports', report)); assert.match(saved.id, /^[a-f0-9-]{36}$/);
  assert.deepEqual(await json(await post(trader, '/api/parser/reports', report)), saved);
  await json(await post(trader, '/api/parser/reports', { ...report, notes: 'Changed retry' }), 409);
  await json(await post(admin, '/api/parser/reports', parserReportInput({ aiRequestId: input.requestId })), 400);
  const adminSaved = await json(await post(admin, '/api/parser/reports', parserReportInput()));
  const page = await json(await get(admin, '/api/parser/reports?dataMode=live&limit=50'));
  assert.ok(Array.isArray(page.items));
  for (const id of [saved.id, adminSaved.id]) {
    const owned = page.items.find(item => item.id === id); assert.ok(owned, 'New owned report must be available to an administrator.');
    assert.equal(owned.rawText, parserSource); assert.equal(owned.sourceRevision, parserRevision); assert.equal(owned.dataMode, 'live');
  }
  // Only use the opaque cursor. Never persist or print genuine report content.
  const firstPage = await json(await get(admin, '/api/parser/reports?dataMode=live&limit=1'));
  assert.ok(firstPage.nextCursor, 'At least two owned reports must produce a real database cursor.');
  await json(await get(admin, `/api/parser/reports?${new URLSearchParams({ dataMode: 'live', limit: '1', cursor: firstPage.nextCursor })}`));
  if (verifyParserReview) await parserReviewProtocol(admin, trader, saved.id, adminSaved.id, original, submitted, result, fingerprint);
  checks.push('parser:non-Otto-test-denied', 'parser:direct-receipt-idempotency-no-provider', 'parser:service-only-completion', 'parser:owned-live-reports');
}
function parserReviewInput(reportId, expectedRevision, extra = {}) {
  const input = { requestId: randomUUID(), reportId, expectedRevision, dataMode: 'live', ...extra };
  parserReviewRequests.push(input.requestId); save(); return input;
}
async function parserReviewProtocol(admin, trader, reportId, legacyId, original, submitted, originalAi, fingerprint) {
  mark('parser-review-owned-full-capture');
  const detail = id => get(admin, `/api/parser/reports?${new URLSearchParams({ dataMode: 'live', id })}`).then(response => json(response));
  const act = (id, revision, extra) => parserReviewInput(id, revision, extra);
  const review = input => post(admin, '/api/parser/review', input).then(response => json(response));
  const initial = await detail(reportId);
  assert.deepEqual(initial.capture.original, original); assert.deepEqual(initial.capture.submitted, submitted);
  assert.equal(initial.capture.originalRevision, parserRevision); assert.equal(initial.capture.parseOrigin, 'initial');
  assert.equal(initial.buildFingerprint, fingerprint); assert.deepEqual(initial.originalAi.result, originalAi);
  assert.notEqual(initial.capture.submitted.fields.remarks, originalAi.suggestions[0].value, 'Original AI proposal must remain unapplied.');
  assert.equal(initial.workflow.stage, 'pending_user'); assert.equal(initial.workflow.revision, 0); assert.deepEqual(initial.history, []);
  const approval = act(reportId, 0, { action: 'approve', expected: original, notes: 'Synthetic review: preserve the raw-only deterministic result.' });
  const aiDenied = act(reportId, 0);
  await json(await post(trader, '/api/parser/review', approval), 403);
  await deniedRpc(trader, 'eco_review_parser_report', { p_input: approval });
  await json(await post(trader, '/api/parser/review-ai', aiDenied), 403);
  await deniedRpc(trader, 'eco_begin_parser_review', { p_input: { ...aiDenied, kind: 'ai' } });
  await json(await get(trader, `/api/parser/reports?dataMode=live&id=${reportId}`), 403);
  await deniedRpc(trader, 'eco_list_parser_reports', { p_query: { dataMode: 'live', id: reportId } });
  await json(await post(admin, '/api/access/preview', { role: 'admin', officeId: 'HONG KONG' }));
  try {
    await json(await post(admin, '/api/parser/review', approval), 403);
    await deniedRpc(admin, 'eco_review_parser_report', { p_input: approval });
    await json(await post(admin, '/api/parser/review-ai', aiDenied), 403);
    await deniedRpc(admin, 'eco_begin_parser_review', { p_input: { ...aiDenied, kind: 'ai' } });
    await json(await get(admin, `/api/parser/reports?dataMode=live&id=${reportId}`), 403);
    await deniedRpc(admin, 'eco_list_parser_reports', { p_query: { dataMode: 'live', id: reportId } });
  } finally { await json(await post(admin, '/api/access/preview/end')); }
  assert.deepEqual((await detail(reportId)).history, [], 'Denied actions cannot create private review history.');
  const approved = await review(approval);
  assert.equal(approved.workflow.stage, 'pending_ai'); assert.equal(approved.workflow.revision, 1);
  assert.deepEqual(approved.workflow.expected, original);
  assert.deepEqual(await review(approval), approved, 'Approval retry must be idempotent.');
  await json(await post(admin, '/api/parser/review', { ...approval, notes: 'Changed retry' }), 409);
  const stale = act(reportId, 0, { action: 'approve', expected: submitted, notes: 'Stale synthetic approval' });
  await json(await post(admin, '/api/parser/review', stale), 409);
  const staleRpc = await directRpc(admin, 'eco_review_parser_report', { p_input: stale });
  assert.equal(staleRpc.status, 409); assert.equal(staleRpc.body.code, 'PT409');
  await json(await post(admin, '/api/parser/review', act(reportId, 1, { action: 'complete', aiRequestId: randomUUID() })), 409);

  const analyzeAndComplete = async (id, revision) => {
    const input = act(id, revision);
    // This is the only live provider boundary in this verifier. The flag is
    // explicit; the exact report IDs and source are owned synthetic fixtures.
    const before = await detail(id);
    assert.equal(before.rawText, parserSource); assert.equal(before.sourceRevision, parserRevision);
    assert.equal(before.workflow.stage, 'pending_ai'); assert.equal(before.workflow.revision, revision);
    await deniedRpc(admin, 'eco_finish_parser_review', { p_actor_id: identities[0].id, p_request_id: input.requestId, p_result: null, p_error_code: 'SYNTHETIC_DENIED' });
    liveAiRequests++; save();
    const analysis = await json(await post(admin, '/api/parser/review-ai', input));
    assert.equal(analysis.requestId, input.requestId); assert.equal(analysis.reportId, id); assert.equal(analysis.revision, revision);
    assert.equal(analysis.model, process.env.ECO_VERIFY_AI_MODEL || 'gpt-6-luna', 'Live analysis must use the approved model.');
    assert.ok(typeof analysis.diagnosis === 'string' && analysis.diagnosis.trim());
    assert.ok(typeof analysis.proposedFix === 'string' && analysis.proposedFix.trim());
    assert.ok(Array.isArray(analysis.regressionExamples) && Array.isArray(analysis.warnings));
    assert.deepEqual(await json(await post(admin, '/api/parser/review-ai', input)), analysis, 'Completed AI receipt must be reused.');
    const after = await detail(id);
    assert.equal(after.workflow.revision, revision); assert.equal(after.workflow.stage, 'pending_ai');
    assert.deepEqual(after.workflow.expected, before.workflow.expected, 'AI review cannot rewrite the approved correction.');
    assert.deepEqual(after.capture, before.capture); assert.deepEqual(after.originalAi, before.originalAi);
    const complete = act(id, revision, { action: 'complete', aiRequestId: input.requestId });
    const completed = await review(complete);
    assert.equal(completed.workflow.stage, 'reviewed'); assert.equal(completed.workflow.revision, revision + 1);
    assert.deepEqual(completed.workflow.aiReview, analysis);
    assert.deepEqual(await review(complete), completed);
    return { completed, aiRequestId: input.requestId };
  };
  const replay = async (id, revision, status, expected) => {
    const input = act(id, revision, { action: 'replay' });
    const result = await review(input), evidence = result.workflow.replay;
    assert.equal(result.workflow.revision, revision + 1); assert.equal(result.workflow.stage, 'reviewed');
    assert.equal(evidence.status, status); assert.deepEqual(evidence.actual, original);
    assert.equal(evidence.provenance.reportId, id); assert.equal(evidence.provenance.reportRevision, revision);
    assert.equal(evidence.provenance.sourceHash, createHash('sha256').update(parserSource).digest('hex'));
    assert.equal(evidence.provenance.buildFingerprint, fingerprint);
    assert.deepEqual(evidence.executedWith, { parserVersion: PARSER_VERSION, buildFingerprint: fingerprint });
    assert.deepEqual(result.workflow.expected, expected);
    assert.deepEqual(await review(input), result, 'Replay retry cannot rerun or increment revision.');
    return result;
  };
  const firstReview = await analyzeAndComplete(reportId, 1);
  const matched = await replay(reportId, 2, 'matched', original);
  assert.deepEqual(matched.workflow.replay.differences, []);
  assert.deepEqual(matched.history.map(item => item.action), ['approve', 'ai_review', 'complete', 'replay']);
  assert.deepEqual(matched.history.map(item => item.revision), [1, 1, 2, 3]);
  const reopened = await review(act(reportId, 3, { action: 'reopen' }));
  assert.equal(reopened.workflow.revision, 4); assert.equal(reopened.workflow.stage, 'pending_user');
  assert.equal(reopened.workflow.aiReview, null); assert.equal(reopened.workflow.replay, null);
  assert.deepEqual(reopened.capture, initial.capture); assert.deepEqual(reopened.originalAi, initial.originalAi);
  const different = structuredClone(original);
  different.fields.vessel = 'SYNTHETIC MANUAL EXPECTATION';
  different.standardText = original.standardText.replace(original.fields.vessel.toUpperCase(), different.fields.vessel);
  const reapproved = await review(act(reportId, 4, { action: 'approve', expected: different, notes: 'Synthetic deliberate mismatch: verify raw replay does not consume expected fields.' }));
  assert.equal(reapproved.workflow.revision, 5);
  await json(await post(admin, '/api/parser/review', act(reportId, 5, { action: 'complete', aiRequestId: firstReview.aiRequestId })), 409);
  await analyzeAndComplete(reportId, 5);
  const mismatched = await replay(reportId, 6, 'different', different);
  assert.ok(mismatched.workflow.replay.differences.includes('vessel'));
  assert.equal(mismatched.workflow.replay.actual.fields.vessel, original.fields.vessel);
  assert.equal(mismatched.history.length, 9);

  // Historical rows may be reviewed, but missing original capture can never
  // become a matched regression merely because current output looks correct.
  const legacy = await detail(legacyId); assert.equal(legacy.capture, undefined);
  await review(act(legacyId, 0, { action: 'approve', expected: original, notes: 'Synthetic legacy report: historical capture is unavailable.' }));
  await analyzeAndComplete(legacyId, 1);
  const legacyReplay = await replay(legacyId, 2, 'legacy-unverified', original);
  assert.deepEqual(legacyReplay.workflow.replay.differences, []);
  const final = await detail(reportId);
  assert.deepEqual(final.history, mismatched.history); assert.deepEqual(final.capture, initial.capture);
  assert.deepEqual(final.originalAi, initial.originalAi);
  const privateTables = rows(`select c.relname,c.relrowsecurity,
    has_table_privilege('anon',c.oid,'SELECT') as anon_select,
    has_table_privilege('authenticated',c.oid,'SELECT') as authenticated_select,
    has_table_privilege('service_role',c.oid,'SELECT') as service_select
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='eco_private' and c.relname in ('parser_review_history','parser_review_actions','parser_review_requests')`);
  assert.equal(privateTables.length, 3);
  assert.ok(privateTables.every(table => table.relrowsecurity && !table.anon_select && !table.authenticated_select && !table.service_select));
  assert.equal(liveAiRequests, 3, 'Exactly three owned synthetic analysis revisions are expected.');
  parserReviewVerified = true;
  checks.push('parser-review:immutable-original-unapplied-AI-and-submitted-captures', 'parser-review:admin-only-API+RPC-and-VIEW-AS-denial',
    'parser-review:CAS-and-idempotent-actions', 'parser-review:real-synthetic-provider-analysis-before-complete',
    'parser-review:matched-different-and-legacy-raw-replay', 'parser-review:reopen-invalidates-old-review', 'parser-review:private-history-and-receipts');
  save();
}

async function inboxProtocol(admin, trader) {
  mark('inbox-owned-receipt-protocol');
  const source = inboxFixture;
  rows(`insert into eco_private.inbox_sources(id,provider,account_id,destination_id,channel,identity_namespace,enabled,provisioned_at,scopes_verified_at,cutover_at,sender_authority)
    values(${quote(source.id)},${quote(source.provider)},${quote(source.account)},${quote(source.destination)},'whatsapp',${quote(source.namespace)},true,now(),now(),'2020-01-01','manual');
    insert into eco_private.inbox_sender_bindings(source_id,sender_identity,sender_display,owner_id,enabled,verified_at)
    values(${quote(source.id)},${quote(source.sender)},'SYNTHETIC INBOX SENDER',${quote(identities[1].id)},true,now());`);
  const liveGet = (context, query = '') => context.request.get(base + '/api/enquiries/inbox' + query, { headers: { 'X-Eco-Data-Mode': 'live' }, timeout: 45_000 });
  const livePost = (context, data, mode = 'live') => context.request.post(base + '/api/enquiries/inbox', { headers: { origin: base, 'X-Eco-Request': '1', 'X-Eco-Data-Mode': mode }, data, timeout: 45_000 });
  const mutate = (action, id) => { const value = { requestId: randomUUID(), action, ...(id ? { id } : {}) }; inboxRequests.push(value.requestId); save(); return value; };
  const payload = index => ({ sourceId: source.id, provider: source.provider, accountId: source.account, destinationId: source.destination,
    messageId: source.messages[index], senderIdentity: source.sender, identityNamespace: source.namespace, identityVerified: true,
    rawText: inboxSource, receivedAt: source.receivedAt });
  await json(await get(trader, '/api/enquiries/inbox'), 403);
  assert.deepEqual(await json(await liveGet(trader)), { items: [], nextCursor: null, unreadCount: 0 });
  const first = await service.rpc('eco_ingest_enquiry', { p_input: payload(0) }); assert.ifError(first.error); assert.equal(first.data.status, 'accepted'); assert.equal(first.data.duplicate, false);
  const duplicate = await service.rpc('eco_ingest_enquiry', { p_input: payload(0) }); assert.ifError(duplicate.error); assert.equal(duplicate.data.id, first.data.id); assert.equal(duplicate.data.duplicate, true);
  const changed = await service.rpc('eco_ingest_enquiry', { p_input: { ...payload(0), rawText: inboxSource + ' CHANGED' } }); assert.equal(changed.error?.code, 'PT409');
  const second = await service.rpc('eco_ingest_enquiry', { p_input: payload(1) }); assert.ifError(second.error);
  const quarantined = await service.rpc('eco_ingest_enquiry', { p_input: { ...payload(2), senderIdentity: 'unbound-verification-sender' } }); assert.ifError(quarantined.error); assert.equal(quarantined.data.status, 'quarantined');
  const page = await json(await liveGet(trader, '?limit=1')); assert.equal(page.items.length, 1); assert.equal(page.unreadCount, 2); assert.ok(page.nextCursor);
  assert.equal(page.items[0].owner, identities[1].id); assert.equal(page.items[0].rawText, inboxSource);
  const next = await json(await liveGet(trader, '?' + new URLSearchParams({ limit: '1', cursor: page.nextCursor }))); assert.equal(next.items.length, 1); assert.notEqual(next.items[0].id, page.items[0].id);
  assert.deepEqual(await json(await liveGet(admin)), { items: [], nextCursor: null, unreadCount: 0 });
  await json(await livePost(admin, mutate('read', first.data.id)), 404);
  await deniedRpc(trader, 'eco_ingest_enquiry', { p_input: payload(0) });
  await deniedRpc(trader, 'eco_list_enquiry_inbox', { p_query: { dataMode: 'test' } });
  await json(await livePost(trader, mutate('dismiss-all'), 'test'), 403);
  const read = mutate('read', first.data.id), saved = await json(await livePost(trader, read)); assert.equal(saved.item.read, true); assert.equal(saved.unreadCount, 1);
  assert.deepEqual(await json(await livePost(trader, read)), saved); await json(await livePost(trader, { ...read, action: 'dismiss' }), 409);
  const clear = mutate('dismiss-all'), cleared = await json(await livePost(trader, clear)); assert.equal(cleared.unreadCount, 0);
  const later = await service.rpc('eco_ingest_enquiry', { p_input: payload(3) }); assert.ifError(later.error);
  assert.deepEqual(await json(await livePost(trader, clear)), cleared); assert.equal((await json(await liveGet(trader))).unreadCount, 1);
  await json(await post(admin, '/api/access/preview', { role: 'admin', officeId: 'HONG KONG' }));
  assert.deepEqual(await json(await liveGet(admin)), { items: [], nextCursor: null, unreadCount: 0 });
  await json(await livePost(admin, mutate('dismiss-all')), 403);
  await deniedRpc(admin, 'eco_mutate_enquiry_inbox', { p_input: { ...mutate('dismiss-all'), dataMode: 'live' } });
  await json(await post(admin, '/api/access/preview/end'));
  assert.equal(rows(`select count(*)::integer as count from eco_private.inbox_messages where source_id=${quote(source.id)} and status='quarantined' and owner_id is null and raw_text is null and subject is null`)[0]?.count, 1);
  checks.push('inbox:owner-only-API+RPC', 'inbox:service-only-ingestion', 'inbox:immutable-delivery-retry', 'inbox:private-contentless-quarantine', 'inbox:read-dismiss-receipts', 'inbox:TEST-and-preview-denied');
}
function cleanupInboxFixtures() {
  const source = inboxFixture, owner = identities[1].id, sourceWhere = `id=${quote(source.id)}::uuid and provider=${quote(source.provider)} and account_id=${quote(source.account)} and destination_id=${quote(source.destination)} and identity_namespace=${quote(source.namespace)} and sender_authority='manual'`;
  const sources = rows(`select id,provider,account_id,destination_id,identity_namespace,sender_authority from eco_private.inbox_sources where id=${quote(source.id)}::uuid`);
  assert.ok(sources.every(row => row.provider===source.provider && row.account_id===source.account && row.destination_id===source.destination && row.identity_namespace===source.namespace && row.sender_authority==='manual'), 'Inbox source cleanup ownership mismatch.');
  const messages = rows(`select owner_id,provider_message_id,provider,account_id,destination_id,status,raw_text,subject from eco_private.inbox_messages where source_id=${quote(source.id)}::uuid`);
  assert.ok(messages.every(row => source.messages.includes(row.provider_message_id) && row.provider===source.provider && row.account_id===source.account && row.destination_id===source.destination &&
    (row.status==='accepted' ? row.owner_id===owner && row.raw_text===inboxSource : row.owner_id===null && row.raw_text===null && row.subject===null)), 'Inbox message cleanup ownership mismatch.');
  const bindings = rows(`select owner_id,sender_identity from eco_private.inbox_sender_bindings where source_id=${quote(source.id)}::uuid`);
  assert.ok(bindings.every(row=>row.owner_id===owner && row.sender_identity===source.sender), 'Inbox binding cleanup ownership mismatch.');
  const ownerIds = identities.map(identity=>`${quote(identity.id)}::uuid`).join(',');
  const mutations = rows(`select owner_id,request_id from eco_private.inbox_mutations where owner_id in (${ownerIds})`);
  assert.ok(mutations.every(row=>identities.some(identity=>identity.id===row.owner_id) && inboxRequests.includes(row.request_id)), 'Inbox mutation cleanup ownership mismatch.');
  rows(`begin;
    delete from eco_private.inbox_mutations where owner_id in (${ownerIds}) and ${inboxRequests.length ? `request_id in (${inboxRequests.map(id=>`${quote(id)}::uuid`).join(',')})` : 'false'};
    delete from eco_private.inbox_messages where source_id in(select id from eco_private.inbox_sources where ${sourceWhere}) and provider_message_id in (${source.messages.map(quote).join(',')});
    delete from eco_private.inbox_sender_bindings where source_id in(select id from eco_private.inbox_sources where ${sourceWhere}) and owner_id=${quote(owner)}::uuid and sender_identity=${quote(source.sender)};
    delete from eco_private.inbox_sources where ${sourceWhere}; commit;`);
  for (const table of ['inbox_messages','inbox_sender_bindings']) assert.equal(rows(`select source_id from eco_private.${table} where source_id=${quote(source.id)}::uuid`).length,0);
  assert.equal(rows(`select id from eco_private.inbox_sources where id=${quote(source.id)}::uuid`).length,0);
  assert.equal(rows(`select owner_id from eco_private.inbox_mutations where owner_id in (${ownerIds})`).length,0);
}
async function openDeferred(page, name) {
  await page.locator('.world-launcher').evaluate((node, route) => { const link = document.createElement('a'); link.href = route; link.textContent = 'TEST DEFERRED WORKSPACE LINK'; link.dataset.releaseTestLink = 'true'; node.append(link); }, name === 'Buyer Profiles' ? '#/companies' : '#/credit');
  const link = page.locator('[data-release-test-link]'); await link.click(); await link.evaluate(node => node.remove());
  const dialog = page.getByRole('dialog', { name, exact: true }); await expect(dialog).toBeVisible(); return dialog;
}
async function expectDeferredHeading(page) {
  const navigation = page.getByRole('navigation', { name: 'Workspace navigation' });
  const group = navigation.locator('[data-group="Buyers and Credit"]');
  const heading = group.getByRole('heading', { name: 'Buyers and Credit', exact: true });
  await expect(heading).toBeVisible(); await expect(heading).toHaveAccessibleDescription(notice);
  await expect(group.getByText(notice, { exact: true })).toBeVisible();
  await expect(group.locator('button, a, svg, [aria-expanded], [aria-controls], .launcher-expansion')).toHaveCount(0);
  await expect(navigation.getByRole('button', { name: 'Buyer Profiles', exact: true, includeHidden: true })).toHaveCount(0);
  await expect(navigation.getByRole('button', { name: 'Credit Requests', exact: true, includeHidden: true })).toHaveCount(0);
  await heading.click(); await expect(page.locator('dialog[open]')).toHaveCount(0);
  assert.ok(await heading.evaluate(node => node.tabIndex < 0), 'Deferred heading is not interactive.');
}
async function newContext(browser, options = {}) {
  const context = await browser.newContext(options); contexts.push(context);
  await installStagingCookies(context, base); return context;
}
async function login(context, identity) {
  const result = await json(await post(context, '/api/access/login', { email: identity.email, password: passwords[identity.role] }));
  assert.equal(result.user.id, identity.id); return result;
}
function setOwnedTraderRole(role) {
  const identity = identities[1];
  const result = rows(`update eco_private.users u set is_admin=${role === 'admin'},is_spc_trader=${role === 'spc-trader'},is_manager=${role === 'manager'},office_id=${quote(role === 'credit' ? 'CREDIT' : 'HONG KONG')},revision=revision+1,updated_at=now()
    where u.id=${quote(identity.id)}::uuid and u.email=${quote(identity.email)} and exists(select 1 from auth.users a where a.id=u.id and a.email=u.email and a.raw_app_meta_data->>'eco_release_verification'=${quote(runId)}) returning id;`);
  assert.equal(result.length, 1, 'Only the owned fixture can change roles.');
}
async function browserCheck(engine, browserType, width, theme) {
  mark(`browser-${engine}-${width}-${theme}`);
  const browser = await browserType.launch({ headless: true }); browsers.push(browser);
  const context = await newContext(browser, { viewport: { width, height: 1000 }, isMobile: width < 760, hasTouch: width < 760, reducedMotion: 'reduce' });
  await context.addInitScript(value => localStorage.setItem('ecosystem.theme.v1', value), theme);
  const page = await context.newPage(); currentPage = page; page.setDefaultTimeout(30_000);
  const errors = []; page.on('pageerror', () => errors.push('pageerror')); page.on('console', message => {
    const signedOutProbe = message.location().url === base + '/api/access/session' && /401/.test(message.text());
    if (message.type() === 'error' && !signedOutProbe) errors.push('console-error');
  });
  const shot = async label => {
    await page.screenshot({ path: join(output, `${engine}-${width}-${theme}-${label}.png`), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label}: horizontal overflow`);
  };
  const open = async name => {
    const navigation = page.getByRole('navigation', { name: 'Workspace navigation' });
    const group = navigation.getByRole('button', { name: 'Buyers and Credit', exact: true });
    if (await group.getAttribute('aria-expanded') !== 'true') await group.click();
    await navigation.getByRole('button', { name, exact: true }).click();
    const dialog = page.getByRole('dialog', { name, exact: true }); await expect(dialog).toBeVisible(); return dialog;
  };
  const close = () => page.getByRole('button', { name: 'Close workspace', exact: true }).click();
  await page.goto(base);
  await page.getByLabel('Email', { exact: true }).fill(identities[0].email);
  await page.getByLabel('Password', { exact: true }).fill(passwords.admin);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('main', { name: 'ECOSYSTEM workspace' })).toBeVisible();
  let dialog = await open('Buyer Profiles'); await expect(dialog.getByRole('textbox', { name: 'Search buyer profiles', exact: true })).toBeVisible(); await close();
  dialog = await open('Credit Requests'); await expect(dialog.locator('.credit-workspace')).toBeVisible(); await close();
  for (const [role, label] of roles) {
    await page.locator('.home-display-controls').getByRole('button', { name: 'View as', exact: true }).click();
    await page.locator('.home-display-controls').getByRole('button', { name: label, exact: true }).click();
    await expect(page.getByRole('status', { name: 'Role preview' }).first()).toContainText(label);
    const session = await json(await get(context, '/api/access/session')); assert.equal(session.preview.role, role); assert.equal(session.user.id, identities[0].id);
    await expectDeferredHeading(page);
    if (role === 'trader') await shot('preview-heading');
    for (const name of ['Buyer Profiles', 'Credit Requests']) {
      dialog = await openDeferred(page, name); await expect(dialog.locator('.release-notice:visible')).toHaveText(notice);
      await expect(dialog.locator('.buyer-profile, .buyer-profile-directory, .credit-workspace')).toHaveCount(0);
      if (role === 'trader') await shot(name === 'Buyer Profiles' ? 'buyer-gate' : 'credit-gate');
      await close();
    }
    await page.getByRole('button', { name: 'Back to ECO RELEASE ADMIN', exact: true }).first().click();
    await expect(page.getByRole('status', { name: 'Role preview' })).toHaveCount(0);
  }
  dialog = await open('Buyer Profiles'); await expect(dialog.getByRole('textbox', { name: 'Search buyer profiles', exact: true })).toBeVisible(); await close();
  await json(await post(context, '/api/access/logout'));
  await page.reload(); await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill(identities[1].email);
  await page.getByLabel('Password', { exact: true }).fill(passwords.trader);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('main', { name: 'ECOSYSTEM workspace' })).toBeVisible();
  await expectDeferredHeading(page); await shot('trader-heading');
  for (const name of ['Buyer Profiles', 'Credit Requests']) { dialog = await openDeferred(page, name); await expect(dialog.locator('.release-notice:visible')).toHaveText(notice); await expect(dialog.locator('.buyer-profile, .buyer-profile-directory, .credit-workspace')).toHaveCount(0); await close(); }
  await json(await post(context, '/api/access/logout'));
  // Expected unauthenticated session probes are filtered above; all other errors fail.
  await page.reload(); await expect(page.getByLabel('Email', { exact: true })).toBeVisible(); await shot('signed-out');
  assert.deepEqual(errors, [], 'Browser flow must have no unexpected runtime or console errors.');
  browserResults.push({ engine, width, theme, roles: roles.map(([role]) => role), actualTrader: true, staticHeading: true, legacyRoutes: true, passed: true });
  await context.close(); await browser.close(); currentPage = null;
}
function safeFailure(error) {
  // Do not serialize arbitrary assertions, response bodies, CLI errors, or Playwright call logs.
  return { step, type: error?.name, code: typeof error?.code === 'string' ? error.code : undefined,
    actual: typeof error?.actual === 'number' ? error.actual : undefined, expected: typeof error?.expected === 'number' ? error.expected : undefined,
    location: error?.stack?.split('\n').filter(line => line.includes('verify-release-gates-cloud.mjs:')).slice(0, 2) };
}
async function cleanup() {
  for (const context of contexts) await post(context, '/api/access/logout').catch(() => {});
  for (const browser of browsers) await browser.close().catch(() => {});
  if (!mutationStarted) return;
  mark('cleanup-owned-fixtures');
  cleanupInboxFixtures();
  const knownIds = identities.map(i => `${quote(i.id)}::uuid`).join(',');
  const candidates = rows(`select id,email,raw_app_meta_data->>'eco_release_verification' as marker from auth.users where id in (${knownIds}) or email in (${identities.map(i => quote(i.email)).join(',')})`);
  assert.ok(candidates.every(c => c.marker === runId && identities.some(i => i.id === c.id && i.email === c.email)), 'Identity cleanup ownership mismatch.');
  const profiles = rows(`select id,email from eco_private.users where id in (${knownIds})`);
  assert.ok(profiles.every(p => candidates.some(c => c.id === p.id && c.email === p.email)), 'Profile cleanup ownership mismatch.');
  const conditions = fixtures.map(f => `(target_kind=${quote(f.kind)} and target_id=${quote(f.id)})`).join(' or ');
  for (const table of ['profile_tab_collections', 'profile_tab_identities', 'profile_tab_revisions']) {
    const owned = rows(`select owner_id from eco_private.${table} where ${conditions}`);
    assert.ok(owned.every(row => identities.some(i => i.id === row.owner_id)), 'Tab cleanup ownership mismatch.');
  }
  const ownedParserReportIds = [];
  for (const [table, key, ownedIds] of [['parser_reports', 'request_id', parserReports], ['parser_ai_requests', 'id', parserRequests]]) {
    const owned = rows(`select id,${key} as request_id,owner_id,input->>'rawText' as raw_text,input->>'sourceRevision' as source_revision from eco_private.${table} where owner_id in (${knownIds})`);
    assert.ok(owned.every(row => identities.some(identity => identity.id === row.owner_id) && ownedIds.includes(row.request_id) && row.raw_text === parserSource && row.source_revision === parserRevision), 'Parser cleanup ownership mismatch.');
    if (table === 'parser_reports') ownedParserReportIds.push(...owned.map(row => row.id));
  }
  const reviewCondition = ownedParserReportIds.length ? `report_id in (${ownedParserReportIds.map(id => `${quote(id)}::uuid`).join(',')})` : 'false';
  for (const table of ['parser_review_actions', 'parser_review_requests']) {
    const owned = rows(`select actor_id,request_id,report_id,input->>'reportId' as input_report_id from eco_private.${table} where ${reviewCondition} or actor_id in (${knownIds})`);
    assert.ok(owned.every(row => identities.some(identity => identity.id === row.actor_id) && parserReviewRequests.includes(row.request_id) && ownedParserReportIds.includes(row.report_id) && row.input_report_id === row.report_id), 'Parser review cleanup ownership mismatch.');
  }
  const parserCondition = ids => `owner_id in (${knownIds}) and ${ids.length ? `request_id in (${ids.map(id => `${quote(id)}::uuid`).join(',')})` : 'false'} and input->>'rawText'=${quote(parserSource)} and input->>'sourceRevision'=${quote(parserRevision)}`;
  const reportCondition = parserCondition(parserReports);
  const aiCondition = parserCondition(parserRequests).replace('request_id in', 'id in');
  const auditBefore = rows(`select (select count(*) from eco_private.access_audit where actor_id in (${knownIds}) or target_id in (${knownIds})) as access_count,(select count(*) from eco_private.administration_events where actor_id in (${knownIds})) as event_count`)[0];
  rows(`begin;
    update eco_private.users set is_active=false where id in (${knownIds});
    delete from eco_private.parser_reports where ${reportCondition};
    delete from eco_private.parser_ai_requests where ${aiCondition};
    delete from eco_private.profile_tab_revisions where ${conditions};
    delete from eco_private.profile_tab_identities where ${conditions};
    delete from eco_private.profile_tab_collections where ${conditions};
    delete from eco_private.administration_requests where actor_id in (${knownIds});
    delete from eco_private.admin_operations where actor_id in (${knownIds}) or target_id in (${knownIds});
    delete from eco_private.role_previews where user_id in (${knownIds});
    delete from eco_private.revoked_sessions where user_id in (${knownIds});
    delete from eco_private.users where id in (${knownIds});
    commit;`);
  for (const identity of candidates) {
    const deleted = await service.auth.admin.deleteUser(identity.id);
    if (deleted.error) assert.equal(rows(`select id from auth.users where id=${quote(identity.id)}::uuid`).length, 0, 'Auth cleanup outcome unresolved.');
  }
  assert.equal(rows(`select id from auth.users where id in (${knownIds}) or email in (${identities.map(i => quote(i.email)).join(',')})`).length, 0);
  assert.equal(rows(`select id from eco_private.users where id in (${knownIds})`).length, 0);
  for (const table of ['profile_tab_collections', 'profile_tab_identities', 'profile_tab_revisions']) assert.equal(rows(`select target_id from eco_private.${table} where ${conditions}`).length, 0);
  for (const table of ['parser_reports','parser_ai_requests']) assert.equal(rows(`select owner_id from eco_private.${table} where owner_id in (${knownIds})`).length, 0, 'Owned parser fixtures must be removed.');
  for (const table of ['parser_review_history','parser_review_actions','parser_review_requests']) assert.equal(rows(`select report_id from eco_private.${table} where ${reviewCondition}`).length, 0, 'Owned review descendants must cascade.');
  const auditAfter = rows(`select (select count(*) from eco_private.access_audit where actor_id in (${knownIds}) or target_id in (${knownIds})) as access_count,(select count(*) from eco_private.administration_events where actor_id in (${knownIds})) as event_count`)[0];
  assert.deepEqual(auditAfter, auditBefore, 'Audit must be retained.');
  cleanupComplete = true; save(); privateWrite(join(output, 'query.private.sql'), '-- Owned fixture cleanup complete; audit retained.\n');
}
async function verify() {
  assert.ok(process.argv.includes('--allow-cloud-mutations'), 'Explicit operator flag required.');
  base = process.env.ECO_VERIFY_ORIGIN;
  assert.ok(base && new URL(base).origin === base && new URL(base).protocol === 'https:');
  assert.match(new URL(base).hostname, /^[a-z0-9-]+\.vercel\.app$/, 'Only an exact staged deployment is accepted.');
  assert.match(process.env.ECO_VERIFY_DEPLOYMENT_ID ?? '', /^dpl_[A-Za-z0-9]+$/);
  const expectedVercelUser = process.env.ECO_VERIFY_VERCEL_USER || 'hocheunglai-6535';
  assert.ok(process.env.ECO_PROTECTION_COOKIES, 'A host-scoped staging cookie file is required.');
  assert.equal(statSync(process.env.ECO_PROTECTION_COOKIES).mode & 0o077, 0, 'Staging credential file must be private.');
  const linked = JSON.parse(readFileSync(join(root, '.vercel/project.json'), 'utf8'));
  assert.equal(linked.projectId, target.vercel.projectId); assert.equal(linked.orgId, target.vercel.teamId);
  assert.equal(JSON.parse(sb(['whoami', '--output-format', 'json'])).username, 'hocheunglai-oss');
  assert.equal(vc(['whoami']).trim(), expectedVercelUser);
  const project = JSON.parse(sb(['projects', 'list', '--output', 'json'])).find(p => p.id === target.supabaseProjectRef);
  assert.equal(project?.organization_id, target.supabaseOrganizationId); assert.equal(project?.region, target.supabaseRegion);
  assert.equal(project?.name, 'ECO'); assert.equal(project?.status, 'ACTIVE_HEALTHY');
  const deployment = JSON.parse(vc(['inspect', base, '--json', '--scope', target.vercel.teamId]));
  assert.equal(deployment.id, process.env.ECO_VERIFY_DEPLOYMENT_ID); assert.equal(deployment.url, new URL(base).hostname);
  assert.equal(deployment.name, target.vercel.projectName); assert.equal(deployment.readyState, 'READY');
  assert.ok(deployment.builds?.some(b => b.output?.some(o => o.digest?.startsWith(`${target.vercel.projectId}/`))), 'Provider project evidence mismatch.');
  deploymentId = deployment.id;
  mkdirSync(output, { recursive: true, mode: 0o700 }); chmodSync(output, 0o700); save();
  mark('migration-preflight');
  const expectedHistory = await hostedMigrationHistory(root);
  assertHostedMigrationHistory(rows('select version from supabase_migrations.schema_migrations order by version').map(row => row.version), expectedHistory);
  assert.equal(rows("select id from eco_private.offices where id in ('HONG KONG','CREDIT')").length, 2);
  const parserHead = hostedMigrationVersion(expectedHistory, ['eco_parser_test_workspace', 'eco_parser_test_workspace_release']);
  assert.ok(parserHead && expectedHistory.versions.includes(parserHead), 'Parser migration must be in the exact applied source set.');
  assert.equal(rows("select migration_head from eco_private.platform_versions where component='parser-test-workspace'")[0]?.migration_head, parserHead);
  checks.push(`migration:parser-test-workspace:${parserHead}`);
  const reviewHead = hostedMigrationVersion(expectedHistory, 'eco_parser_review_workflow');
  assert.ok(reviewHead && expectedHistory.versions.includes(reviewHead));
  assert.equal(rows("select migration_head from eco_private.platform_versions where component='parser-review'")[0]?.migration_head, reviewHead);
  checks.push(`migration:parser-review:${reviewHead}`);
  const inboxHead = hostedMigrationVersion(expectedHistory, 'eco_shared_enquiry_inbox');
  assert.ok(inboxHead && expectedHistory.versions.includes(inboxHead));
  assert.equal(rows("select migration_head from eco_private.platform_versions where component='enquiry-inbox'")[0]?.migration_head,inboxHead);
  checks.push(`migration:enquiry-inbox:${inboxHead}`);
  const keyFile = join(root, 'output/access/eco-api-keys.private.json');
  assert.ok(statSync(keyFile).isFile()); assert.equal(statSync(keyFile).mode & 0o077, 0, 'ECO credential file must be private.');
  const keys = JSON.parse(readFileSync(keyFile, 'utf8'));
  const secret = keys.find(k => k.type === 'secret')?.api_key; publishable = keys.find(k => k.type === 'publishable')?.api_key;
  assert.ok(secret && publishable, 'ECO-only service and publishable keys required.');
  service = createClient(`https://${target.supabaseProjectRef}.supabase.co`, secret, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(20_000) }) } });
  try {
    const browser = await chromium.launch({ headless: true }); browsers.push(browser);
    const admin = await newContext(browser), trader = await newContext(browser), anonymous = await newContext(browser);
    // Fail on a stale/wrong protection cookie before any cloud fixture exists.
    await json(await get(anonymous, tabsUrl(buyer)), 401);
    await json(await get(anonymous, '/api/enquiries/test-policy'), 401);
    await json(await get(anonymous, '/api/suppliers/pic-options'), 401);
    await json(await get(anonymous, '/api/parser/reports?dataMode=live'), 401);
    await json(await post(anonymous, '/api/parser/fix', {}), 401);
    await json(await post(anonymous, '/api/parser/review', {}), 401);
    await json(await post(anonymous, '/api/parser/review-ai', {}), 401);
    mark('create-owned-identities'); mutationStarted = true; save();
    for (const identity of identities) {
      const created = await service.auth.admin.createUser({ id: identity.id, email: identity.email, password: passwords[identity.role], email_confirm: true, app_metadata: { eco_release_verification: runId } });
      assert.ifError(created.error); assert.equal(created.data.user?.id, identity.id);
      const profile = { displayName: `ECO RELEASE ${identity.role.toUpperCase()}`, officeId: 'HONG KONG', isAdmin: identity.role === 'admin', isSpcTrader: identity.role === 'admin', isManager: false, isActive: true, sourceSpcId: randomUUID() };
      rows(`begin;select eco_private.provision_user(${quote(identity.id)}::uuid,${quote(JSON.stringify(profile))}::jsonb);update eco_private.users set activated_at=now(),password_prompt_dismissed_at=now() where id=${quote(identity.id)}::uuid;commit;`);
    }
    await login(admin, identities[0]); await login(trader, identities[1]);
    mark('verify-staged-build');
    const system = await json(await get(admin, '/api/admin/system-information'));
    const source = await sourceFingerprint(root), migrations = await migrationFingerprint(root);
    assert.equal(system.targets.databaseProjectRef, target.supabaseProjectRef); assert.equal(system.targets.databaseRegion, target.supabaseRegion);
    assert.equal(system.build.sourceSha256, source.sha256); assert.equal(system.migrations.sha256, migrations.sha256); assert.equal(system.migrations.bundledHead, migrations.bundledHead);
    if (process.env.ECO_VERIFY_COMMIT) assert.equal(system.build.gitCommit, process.env.ECO_VERIFY_COMMIT);
    privateWrite(join(output, 'build-evidence.json'), JSON.stringify({ deploymentId, sourceSha256: source.sha256, migrationHead: migrations.bundledHead, migrationSha256: migrations.sha256 }, null, 2));
    mark('supplier-pic-names-only');
    for (const context of [admin, trader]) {
      const options = await json(await get(context, '/api/suppliers/pic-options'));
      assert.deepEqual(Object.keys(options), ['options']);
      assert.ok(Array.isArray(options.options) && options.options.every(name => typeof name === 'string' && name.trim()));
      for (const identity of identities) {
        assert.equal(options.options.includes(`ECO RELEASE ${identity.role.toUpperCase()}`), identity.role === 'admin', 'Only the active SPC fixture is selectable as PIC.');
        assert.ok(!JSON.stringify(options).includes(identity.email) && !JSON.stringify(options).includes(identity.id));
      }
    }
    checks.push('suppliers:PIC-options-authenticated-names-only-active-SPC');
    await parserProtocol(admin, trader, source.sha256);
    await inboxProtocol(admin, trader);
    mark('admin-own-private-buyer-tabs');
    const initial = await json(await get(admin, tabsUrl(buyer))); assert.equal(initial.private.revision, 0);
    const adminTab = tab('ADMIN PRIVATE');
    const adminInput = writeInput(buyer, 0, [adminTab]);
    const saved = await json(await post(admin, '/api/profile-tabs/save', adminInput)); assert.deepEqual(saved.private.tabs, [adminTab]);
    assert.deepEqual(await json(await post(admin, '/api/profile-tabs/save', adminInput)), saved, 'Replay must recover the same receipt.');
    assert.deepEqual((await directRpc(admin, 'eco_list_profile_tabs', { p_target: buyer })).body.private.tabs, [adminTab]);
    mark('four-nonadmin-previews');
    for (const [role] of roles) {
      await json(await post(admin, '/api/access/preview', { role, officeId: role === 'credit' ? 'CREDIT' : 'HONG KONG' }));
      await buyerDenied(admin);
      await parserDenied(admin, { preview: true });
      await json(await post(admin, '/api/profile-tabs/save', writeInput(fixtures[1], 0, [tab('PREVIEW DENIED')])), 403);
      checks.push(`preview:${role}:API+RPC`);
    }
    await json(await post(admin, '/api/access/preview', { role: 'admin', officeId: 'HONG KONG' }));
    const hidden = await json(await get(admin, tabsUrl(buyer))); assert.deepEqual(hidden.private, { revision: 0, tabs: [] });
    assert.deepEqual((await directRpc(admin, 'eco_list_profile_tabs', { p_target: buyer })).body.private, hidden.private);
    await json(await post(admin, '/api/profile-tabs/save', writeInput(buyer, 1, [tab('ADMIN PREVIEW DENIED')])), 403);
    await json(await post(admin, '/api/access/preview/end'));
    assert.deepEqual((await json(await get(admin, tabsUrl(buyer)))).private.tabs, [adminTab]);
    mark('four-real-nonadmin-roles');
    for (const [role] of roles) {
      setOwnedTraderRole(role);
      const session = await json(await get(trader, '/api/access/session')); assert.equal(session.user.isAdmin, false); assert.equal(session.user.isSpcTrader, role === 'spc-trader'); assert.equal(session.user.isManager, role === 'manager'); assert.equal(session.user.officeId, role === 'credit' ? 'CREDIT' : 'HONG KONG');
      await buyerDenied(trader);
      await parserDenied(trader);
      for (const item of fixtures.slice(1)) {
        const existing = await json(await get(trader, tabsUrl(item)));
        const savedLocation = await json(await post(trader, '/api/profile-tabs/save', writeInput(item, existing.private.revision, [tab(role)])));
        assert.equal(savedLocation.private.revision, existing.private.revision + 1);
      }
      checks.push(`real:${role}:API+RPC`);
    }
    mark('other-admin-private-owner-isolation');
    setOwnedTraderRole('admin');
    const isolated = await json(await get(trader, tabsUrl(buyer))); assert.deepEqual(isolated.private, { revision: 0, tabs: [] });
    const otherTab = tab('SECOND ADMIN PRIVATE');
    await json(await post(trader, '/api/profile-tabs/save', writeInput(buyer, 0, [otherTab])));
    assert.deepEqual((await json(await get(trader, tabsUrl(buyer)))).private.tabs, [otherTab]);
    assert.deepEqual((await json(await get(admin, tabsUrl(buyer)))).private.tabs, [adminTab]);
    setOwnedTraderRole('trader');
    await browserCheck('chromium', chromium, 1440, 'light');
    await browserCheck('webkit', webkit, 320, 'dark');
    mark('logout-and-anonymous-boundaries');
    await json(await post(admin, '/api/access/preview', { role: 'credit', officeId: 'CREDIT' }));
    await json(await post(admin, '/api/access/logout')); await json(await get(admin, '/api/access/session'), 401);
    for (const item of fixtures) await json(await get(admin, tabsUrl(item)), 401);
    await json(await get(admin, '/api/enquiries/test-policy'), 401);
    await json(await get(admin, '/api/parser/reports?dataMode=live'), 401);
    await json(await post(admin, '/api/parser/reports', parserReportInput()), 401);
    const fresh = await login(admin, identities[0]); assert.equal(fresh.preview ?? null, null); assert.equal(fresh.user.isAdmin, true);
    assert.deepEqual((await json(await get(admin, tabsUrl(buyer)))).private.tabs, [adminTab]);
    completed = true; save();
  } catch (error) {
    failure = safeFailure(error); save();
    if (currentPage && !currentPage.isClosed()) await currentPage.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally { await cleanup(); }
  privateWrite(join(output, 'verification.json'), JSON.stringify({ runId, base, deploymentId, completed, cleanupComplete, checks, browserResults, adminPrivateOwnerIsolation: true, adminPreviewPrivateHidden: true, countryPortUnaffected: true, auditRetained: true, ownedParserFixturesRemoved: true, ownedInboxFixturesRemoved: true, inboxProviderCalls: 0, liveAiRequests, parserReviewRequested: verifyParserReview, parserReviewVerified, globalTestPurgeInvoked: false, invitationsSent: 0, limits: 'Native Safari and physical devices not tested. Responsive fixture matrix is a separate gate. Original AI FIX completion is synthetic; it does not verify the live AI FIX provider. ' + (parserReviewVerified ? 'Three synthetic approved revisions across two owned reports exercised the live AI review provider on this exact deployment; no customer content was submitted and no parser source was changed.' : 'Live AI review was not requested or verified; rerun with --allow-live-ai-review to exercise that release gate.') }, null, 2));
  console.log(JSON.stringify({ completed, cleanupComplete, report: join(output, 'verification.json') }));
}
verify().catch(error => { console.error(JSON.stringify({ failed: true, failure: failure ?? safeFailure(error), step, cleanupComplete, recovery: mutationStarted ? join(output, 'recovery.private.json') : undefined })); process.exitCode = 1; });
