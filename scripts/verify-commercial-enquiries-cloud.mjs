import { hostedMigrationHistory, assertHostedMigrationHistory } from './hosted-migration-history.mjs';
/**
 * Explicit operator verification against an exact staged ECO production build.
 * Creates only marked synthetic accounts/records; never invokes a dispatch provider.
 * A private recovery manifest is written before mutations and retained after cleanup.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit, expect as playwrightExpect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { ecoConnections as target } from '../config/ecoConnections.ts';
import { installStagingCookies } from '../tests/fixtures/protection-cookies.mjs';
import { sourceFingerprint, migrationFingerprint } from './generate-system-information.mjs';
import { deploymentIdentity, mergeDeploymentMetadata } from './verify-whatsapp-intake.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const expect = playwrightExpect.configure({ timeout: 30000 });
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const command = args => execFileSync('pnpm', args, { cwd: root, encoding: 'utf8', timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 });
const sb = args => command(['dlx', '--allow-build=supabase', 'supabase@2.120.0', ...args]);
const vc = args => command(['dlx', 'vercel@63.1.2', ...args]);
const privateWrite = (path, value) => { writeFileSync(path, value, { mode: 0o600 }); chmodSync(path, 0o600); };
function privateRead(path) {
  assert.ok(isAbsolute(path ?? ''), 'Absolute private file path required.');
  assert.equal(statSync(path).mode & 0o077, 0, 'Private file permissions required.');
  return readFileSync(path, 'utf8');
}
let manifest, output, service, browser, mobileBrowser;
const contexts = [], checks = [];
function save() { privateWrite(join(output, 'recovery.private.json'), JSON.stringify(manifest, null, 2)); }
function mark(step) { manifest.step = step; save(); console.log(JSON.stringify({ step })); }
function rows(sql) {
  privateWrite(join(output, 'query.private.sql'), sql);
  const value = JSON.parse(sb(['db', 'query', '--linked', '--project-ref', target.supabaseProjectRef, '--file', join(output, 'query.private.sql'), '--output', 'json']));
  const result = Array.isArray(value) ? value : value.rows;
  assert.ok(Array.isArray(result), 'Unexpected database result.'); return result;
}
const ids = () => manifest.identities.map(item => quote(item.id) + '::uuid').join(',');
const get = (ctx, suffix = '?scope=mine&limit=25', headers = {}) => ctx.request.get(manifest.base + '/api/enquiries/records' + suffix, { headers: { 'x-eco-data-mode': 'live', ...headers }, timeout: 45000, maxRedirects: 0 });
const post = (ctx, path, data, headers = {}) => ctx.request.post(manifest.base + path, { headers: { origin: manifest.base, 'x-eco-request': '1', 'x-eco-data-mode': 'live', ...headers }, data, timeout: 45000, maxRedirects: 0 });
async function result(response, status = 200) {
  assert.equal(response.status(), status, `Unexpected HTTP status at ${new URL(response.url()).pathname}`);
  assert.match(response.headers()['cache-control'] ?? '', /no-store/);
  return response.json();
}
async function context(identity, password, engine = browser, settings = {}) {
  const ctx = await engine.newContext(settings); contexts.push(ctx);
  await installStagingCookies(ctx, manifest.base);
  if (identity) {
    const login = await result(await post(ctx, '/api/access/login', { email: identity.email, password }));
    assert.equal(login.user.id, identity.id);
  }
  return ctx;
}
async function openEnquiries(page) {
  const nav = page.getByRole('navigation', { name: 'Workspace navigation' });
  const trading = nav.getByRole('button', { name: 'Trading', exact: true });
  if (await trading.getAttribute('aria-expanded') !== 'true') await trading.click();
  await nav.getByRole('button', { name: 'Enquiries', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Enquiries', exact: true });
  await expect(panel).toBeVisible();
  return panel;
}
async function browserWorkflow(identity, password, engine, width, theme, label) {
  const ctx = await context(identity, password, engine, {
    viewport: { width, height: 1000 }, isMobile: width < 760, hasTouch: width < 760,
    colorScheme: theme, reducedMotion: 'reduce',
  });
  await ctx.addInitScript(value => localStorage.setItem('ecosystem.theme.v1', value), theme);
  const page = await ctx.newPage(), errors = [];
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  const draft = input(`UI ${label}`);
  try {
    await page.goto(manifest.base, { waitUntil: 'domcontentloaded' });
    let panel = await openEnquiries(page);
    await panel.getByLabel('Raw enquiry', { exact: true }).fill(draft.source.rawText);
    await expect(panel.getByRole('button', { name: 'Send to SPC', exact: true })).toBeEnabled();
    await panel.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(panel.getByRole('button', { name: `Open ${draft.reviewed.vessel}`, exact: true })).toBeVisible();
    const list = await result(await get(ctx));
    const saved = list.items.find(item => item.vessel === draft.reviewed.vessel);
    assert.ok(saved); assert.equal(saved.status, 'draft');
    await page.reload({ waitUntil: 'domcontentloaded' }); panel = await openEnquiries(page);
    await panel.getByRole('button', { name: `Open ${draft.reviewed.vessel}`, exact: true }).click();
    await expect(panel.getByLabel('Raw enquiry', { exact: true })).toHaveValue(draft.source.rawText);
    await expect(panel.getByLabel('Raw enquiry', { exact: true })).toHaveAttribute('readonly', '');
    await panel.getByRole('button', { name: 'Send to SPC', exact: true }).click();
    await expect.poll(async () => (await result(await get(ctx, '?id=' + saved.id))).item.status).toBe('confirmed');
    await expect(panel.locator(`[data-commercial-id="${saved.id}"]`)).toContainText(/awaiting connection/i);
    await page.screenshot({ path: join(output, `${label}-${width}-${theme}.png`), fullPage: true, animations: 'disabled' });
    await panel.locator(`[data-commercial-id="${saved.id}"]`).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(output, `${label}-${width}-${theme}-saved-list.png`), fullPage: true, animations: 'disabled' });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Page must not overflow horizontally.');
    assert.deepEqual(errors, []);
    checks.push(`${label}-${width}-${theme}-real-save-reload-confirm`);
  } catch (error) {
    await page.screenshot({ path: join(output, `${label}-${width}-${theme}-failure.png`), fullPage: true, animations: 'disabled' }).catch(() => {});
    throw error;
  }
}
function input(label, extra = {}) {
  const vessel = `ECO QUEUE ${manifest.runId.toUpperCase()} ${label.toUpperCase()}`;
  return {
    dataMode: 'live', requestId: randomUUID(), id: randomUUID(), expectedRevision: 0, action: 'save',
    source: { rawText: `VESSEL: ${vessel}\nPORT: SINGAPORE\nETA: 25 OCT 2026\nVLSFO: 500 MT\nSYNTHETIC VERIFICATION ONLY`,
      parsed: null, parserVersion: null, inboxId: null },
    reviewed: { vessel, imo: '', eta: '25 OCT 2026', portId: 'port-singapore', buyerId: null,
      buyerText: 'SYNTHETIC PRIVATE BUYER', products: [{ grade: 'VLSFO', quantityText: '500' }],
      remarks: 'SYNTHETIC PRIVATE REMARK', rmk: false, viscosity: [], warnings: [],
      formattedText: `VESSEL: ${vessel}\nPORT: SINGAPORE\nETA: 25 OCT 2026\nVLSFO: 500 MT` },
    ...extra,
  };
}
function validateManifest(value) {
  assert.equal(value.kind, 'eco-commercial-verification-v1');
  assert.match(value.runId, /^[a-f0-9]{24}$/); assert.equal(value.projectRef, target.supabaseProjectRef);
  assert.equal(value.identities.length, 4);
  for (const [index, role] of ['owner', 'other', 'spc', 'admin'].entries()) {
    const identity = value.identities[index];
    assert.equal(identity.role, role); assert.ok(uuid(identity.id));
    assert.equal(identity.email, `eco-queue-${value.runId}-${role}@example.com`);
  }
  assert.equal(new Set(value.identities.map(item => item.id)).size, 4);
}
async function cleanup() {
  if (!manifest.mutationStarted || manifest.cleanupComplete) return;
  mark('cleanup-owned-fixtures');
  const existing = rows(`select id,email,raw_app_meta_data->>'eco_commercial_verification' as tag from auth.users where id in (${ids()})`);
  for (const item of existing) {
    const expected = manifest.identities.find(identity => identity.id === item.id);
    assert.equal(item.email, expected?.email); assert.equal(item.tag, manifest.runId, 'Cleanup ownership mismatch.');
  }
  const profiles = rows(`select id,email from eco_private.users where id in (${ids()})`);
  assert.ok(profiles.every(profile => existing.some(item => item.id === profile.id && item.email === profile.email)), 'Profile cleanup ownership mismatch.');
  const ownedRecords = rows(`select id,source->>'rawText' as raw from eco_private.commercial_enquiries where owner_id in (${ids()})`);
  assert.ok(ownedRecords.every(item => item.raw.includes(manifest.runId.toUpperCase()) && item.raw.includes('SYNTHETIC VERIFICATION ONLY')), 'Record cleanup ownership mismatch.');
  // No real source or destination configuration is changed. Safe audit metadata is retained.
  rows(`begin;
    delete from eco_private.commercial_enquiry_mutations where actor_id in (${ids()});
    delete from eco_private.commercial_enquiry_queue where enquiry_id in (select id from eco_private.commercial_enquiries where owner_id in (${ids()}));
    delete from eco_private.commercial_enquiry_history where enquiry_id in (select id from eco_private.commercial_enquiries where owner_id in (${ids()}));
    delete from eco_private.commercial_enquiries where owner_id in (${ids()});
    delete from eco_private.administration_requests where actor_id in (${ids()});
    delete from eco_private.admin_operations where actor_id in (${ids()}) or target_id in (${ids()});
    delete from eco_private.role_previews where user_id in (${ids()});
    delete from eco_private.revoked_sessions where user_id in (${ids()});
    delete from eco_private.users where id in (${ids()});
    commit;`);
  for (const item of existing) {
    const removed = await service.auth.admin.deleteUser(item.id);
    if (removed.error) assert.equal(rows(`select id from auth.users where id=${quote(item.id)}::uuid`).length, 0, 'Cleanup outcome unresolved.');
  }
  assert.equal(rows(`select id from auth.users where id in (${ids()})`).length, 0);
  assert.equal(rows(`select id from eco_private.commercial_enquiries where owner_id in (${ids()})`).length, 0);
  manifest.cleanupComplete = true; save();
  privateWrite(join(output, 'query.private.sql'), '-- Synthetic verification completed and cleaned.\n');
}
async function verify() {
  assert.ok(process.argv.includes('--allow-cloud-mutations'), 'Explicit synthetic cloud verification flag required.');
  const cleanupIndex = process.argv.indexOf('--cleanup-only');
  if (cleanupIndex >= 0) {
    const path = process.argv[cleanupIndex + 1]; manifest = JSON.parse(privateRead(path)); output = dirname(path);
  } else {
    const runId = randomBytes(12).toString('hex');
    manifest = { kind: 'eco-commercial-verification-v1', runId, projectRef: target.supabaseProjectRef,
      base: process.env.ECO_VERIFY_ORIGIN, deploymentId: process.env.ECO_VERIFY_DEPLOYMENT_ID, commit: process.env.ECO_VERIFY_COMMIT,
      identities: ['owner', 'other', 'spc', 'admin'].map(role => ({ role, id: randomUUID(), email: `eco-queue-${runId}-${role}@example.com` })),
      mutationStarted: false, completed: false, cleanupComplete: false };
    assert.ok(manifest.base && new URL(manifest.base).origin === manifest.base);
    assert.equal(new URL(manifest.base).protocol, 'https:');
    assert.match(new URL(manifest.base).hostname, /^[a-z0-9-]+\.vercel\.app$/, 'Exact staged deployment required.');
    assert.match(manifest.deploymentId ?? '', /^dpl_[A-Za-z0-9]+$/);
    assert.match(manifest.commit ?? '', /^[a-f0-9]{40}$/);
    output = join(root, 'output/access', `commercial-enquiries-${runId}`);
    mkdirSync(output, { recursive: true, mode: 0o700 });
  }
  validateManifest(manifest); save(); mark('verify-targets');
  assert.equal(JSON.parse(sb(['whoami', '--output-format', 'json'])).username, 'hocheunglai-oss');
  const project = JSON.parse(sb(['projects', 'list', '--output', 'json'])).find(item => item.id === target.supabaseProjectRef);
  assert.equal(project?.name, 'ECO'); assert.equal(project?.organization_id, target.supabaseOrganizationId);
  assert.equal(project?.region, target.supabaseRegion); assert.equal(project?.status, 'ACTIVE_HEALTHY');
  const keys = JSON.parse(privateRead(process.env.ECO_SERVICE_KEYS_FILE));
  const secret = keys.find(item => item.type === 'secret')?.api_key; assert.ok(secret);
  service = createClient(`https://${target.supabaseProjectRef}.supabase.co`, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (url, options) => fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) }) },
  });
  if (cleanupIndex >= 0) { await cleanup(); return; }
  assert.equal(vc(['whoami']).trim(), 'hocheunglai-6535');
  const compact = JSON.parse(vc(['inspect', manifest.base, '--json', '--scope', target.vercel.teamId]));
  const raw = JSON.parse(vc(['api', `/v13/deployments/${manifest.deploymentId}?teamId=${target.vercel.teamId}`, '--scope', target.vercel.teamId]));
  manifest.deployment = deploymentIdentity(mergeDeploymentMetadata(compact, raw, manifest), manifest); save();
  const expectedHistory = await hostedMigrationHistory(root);
  assertHostedMigrationHistory(rows('select version from supabase_migrations.schema_migrations order by version').map(item => item.version), expectedHistory);
  assert.equal(rows(`select id from auth.users where id in (${ids()}) or email in (${manifest.identities.map(item => quote(item.email)).join(',')})`).length, 0);
  try {
    browser = await chromium.launch({ headless: true });
    const anon = await context(); await result(await get(anon), 401);
    mark('create-owned-fixtures'); manifest.mutationStarted = true; save();
    const passwords = manifest.identities.map(() => `EcoQueue9-${randomBytes(24).toString('base64url')}`);
    for (const [index, identity] of manifest.identities.entries()) {
      const created = await service.auth.admin.createUser({ id: identity.id, email: identity.email, password: passwords[index], email_confirm: true,
        app_metadata: { eco_commercial_verification: manifest.runId } });
      assert.ifError(created.error); assert.equal(created.data.user?.id, identity.id);
      const profile = { displayName: `ECO QUEUE ${identity.role.toUpperCase()}`, officeId: 'HONG KONG',
        isAdmin: identity.role === 'admin', isSpcTrader: identity.role === 'spc', isManager: false, isActive: true, sourceSpcId: randomUUID() };
      rows(`begin;select eco_private.provision_user(${quote(identity.id)}::uuid,${quote(JSON.stringify(profile))}::jsonb);
        update eco_private.users set activated_at=now(),password_prompt_dismissed_at=now() where id=${quote(identity.id)}::uuid;commit;`);
    }
    const [owner, other, spc, admin] = await Promise.all(manifest.identities.map((identity, index) => context(identity, passwords[index])));
    const system = await result(await admin.request.get(manifest.base + '/api/admin/system-information', { maxRedirects: 0, timeout: 45000 }));
    const source = await sourceFingerprint(root), migrations = await migrationFingerprint(root);
    assert.equal(system.targets.databaseProjectRef, target.supabaseProjectRef); assert.equal(system.targets.databaseRegion, target.supabaseRegion);
    assert.equal(system.build.gitCommit, manifest.commit); assert.equal(system.build.sourceSha256, source.sha256);
    assert.equal(system.migrations.sha256, migrations.sha256); manifest.build = { sourceSha256: source.sha256, migrationSha256: migrations.sha256 }; save();

    mark('save-retry-revision-and-ownership');
    const draft = input('DRAFT');
    const saved = await result(await post(owner, '/api/enquiries/records', draft));
    assert.equal(saved.item.id, draft.id); assert.equal(saved.item.revision, 1);
    assert.deepEqual(await result(await post(owner, '/api/enquiries/records', draft)), saved);
    await result(await post(owner, '/api/enquiries/records', { ...draft, reviewed: { ...draft.reviewed, vessel: 'ALTERED' } }), 409);
    const second = await context(manifest.identities[0], passwords[0]);
    assert.deepEqual((await result(await get(second, '?id=' + draft.id))).item, saved.item);
    for (const ctx of [other, spc, admin]) await result(await get(ctx, '?id=' + draft.id), 404);
    const edited = { ...draft, requestId: randomUUID(), expectedRevision: 1, reviewed: { ...draft.reviewed, eta: '26 OCT 2026' } };
    const updated = await result(await post(second, '/api/enquiries/records', edited)); assert.equal(updated.item.revision, 2);
    await result(await post(owner, '/api/enquiries/records', { ...edited, requestId: randomUUID() }), 409);
    checks.push('durable-cross-session-draft', 'same-request-replay', 'changed-request-conflict', 'revision-conflict', 'private-owner-detail');

    mark('confirm-and-singapore-queue');
    const confirm = { ...edited, requestId: randomUUID(), expectedRevision: 2, action: 'confirm' };
    const responses = await Promise.all([post(owner, '/api/enquiries/records', confirm), post(second, '/api/enquiries/records', confirm)]);
    const confirmed = await result(responses[0]); assert.deepEqual(await result(responses[1]), confirmed);
    assert.equal(confirmed.item.status, 'confirmed');
    await result(await post(owner, '/api/enquiries/records', { ...confirm, action: 'save', requestId: randomUUID(), expectedRevision: confirmed.item.revision }), 409);
    await result(await get(other, '?scope=singapore&limit=25'), 403);
    for (const ctx of [spc, admin]) {
      const page = await result(await get(ctx, '?scope=singapore&limit=25'));
      const queued = page.items.find(item => item.id === draft.id); assert.ok(queued);
      const serialized = JSON.stringify(queued);
      assert.ok(serialized.includes('awaiting_connection'));
      for (const excluded of ['SYNTHETIC PRIVATE BUYER', 'SYNTHETIC PRIVATE REMARK', '"rawText"', '"source"', '"formattedText"', '"buyerText"']) assert.ok(!serialized.includes(excluded), 'Shared queue must exclude private source/commercial content.');
    }
    const nonSg = input('ROTTERDAM', { action: 'confirm' }); nonSg.reviewed.portId = 'port-rotterdam';
    const nonSgResult = await result(await post(owner, '/api/enquiries/records', nonSg)); assert.equal(nonSgResult.item.status, 'confirmed');
    assert.ok(!(await result(await get(spc, '?scope=singapore&limit=25'))).items.some(item => item.id === nonSg.id));
    const unknown = input('UNKNOWN', { action: 'confirm' }); unknown.reviewed.portId = null;
    await result(await post(owner, '/api/enquiries/records', unknown), 400);
    checks.push('atomic-confirm-and-queue', 'concurrent-submit-deduplicated', 'no-buyer-master-required', 'shared-queue-projection', 'non-singapore-not-queued', 'unknown-port-denied');

    mark('real-browser-save-reload-confirm');
    await browserWorkflow(manifest.identities[0], passwords[0], browser, 1440, 'light', 'chromium');
    mobileBrowser = await webkit.launch({ headless: true });
    await browserWorkflow(manifest.identities[0], passwords[0], mobileBrowser, 320, 'dark', 'webkit');

    mark('mode-origin-and-revocation');
    await result(await post(owner, '/api/enquiries/records', input('TEST'), { 'x-eco-data-mode': 'test' }), 403);
    await result(await post(owner, '/api/enquiries/records', input('ORIGIN'), { origin: 'https://example.invalid' }), 403);
    await result(await post(admin, '/api/access/preview', { role: 'trader', officeId: 'HONG KONG' }));
    await result(await post(admin, '/api/enquiries/records', input('PREVIEW')), 403);
    await result(await get(admin), 403);
    rows(`update eco_private.users set is_active=false where id=${quote(manifest.identities[1].id)}::uuid`);
    const denied = await get(other); assert.ok([401, 403].includes(denied.status()));
    checks.push('test-write-denied', 'cross-origin-denied', 'preview-write-denied', 'preview-live-data-hidden', 'deactivated-user-denied');
    manifest.completed = true; save();
  } catch (error) {
    manifest.failure = { name: error?.name, code: error?.code, step: manifest.step };
    save();
    throw error;
  } finally {
    manifest.checks = [...checks]; save();
    for (const ctx of contexts) await ctx.close().catch(() => {});
    await browser?.close().catch(() => {});
    await mobileBrowser?.close().catch(() => {});
    try { await cleanup(); }
    catch (error) {
      manifest.cleanupFailure = { name: error?.name, code: error?.code, step: manifest.step };
      save(); throw error;
    }
  }
  privateWrite(join(output, 'verification.json'), JSON.stringify({ ...manifest, checks, externalMessagesSent: 0,
    limits: 'Real staged API, database, separate authenticated sessions, Chromium desktop and WebKit phone save/reload/confirm flows. Companion fixtures cover the full responsive matrix. No dispatch provider is enabled; no physical device test.' }, null, 2));
  console.log(JSON.stringify({ completed: manifest.completed, cleanupComplete: manifest.cleanupComplete, report: join(output, 'verification.json') }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verify().catch(error => {
    if (manifest && output) {
      manifest.failure ??= { name: error?.name, code: error?.code, step: manifest.step }; save();
      // Local operator diagnostics stay private; stdout reports only the safe phase.
      privateWrite(join(output, 'failure.private.txt'), String(error?.stack ?? error?.message ?? error));
    }
    console.error(JSON.stringify({ failed: true, step: manifest?.failure?.step, errorType: error?.name, code: error?.code,
      cleanupComplete: manifest?.cleanupComplete, recovery: output ? join(output, 'recovery.private.json') : undefined }));
    process.exitCode = 1;
  });
}
