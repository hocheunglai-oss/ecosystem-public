#!/usr/bin/env node
/**
 * Exact-stage intelligence verification. No import, owner grant, outbound message or AI call.
 * Default is read-only target/anonymous preflight. Full checks require --allow-cloud-mutations.
 * Required: ECO_VERIFY_ORIGIN, ECO_VERIFY_DEPLOYMENT_ID, ECO_VERIFY_COMMIT,
 * ECO_PROTECTION_COOKIES (host-scoped protection cookie only).
 * Full mode additionally requires ECO_INTELLIGENCE_REQUEST_FILE (saved successful import),
 * ECO_OWNER_PREFLIGHT_FILE (private verified ownerId) and ECO_INTELLIGENCE_CREDENTIALS_FILE
 * ({projectRef,secretKey}, same owner-only format as import-snapshot.mjs).
 * Recovery: --allow-cloud-mutations --cleanup-only /absolute/recovery.private.json.
 * All output files are private. Public stdout contains fixed steps, hashes and verdicts only.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { ecoConnections as target } from '../../config/ecoConnections.ts';
import { installStagingCookies } from '../../tests/fixtures/protection-cookies.mjs';
import { sourceFingerprint, migrationFingerprint } from '../generate-system-information.mjs';
import { deploymentIdentity, mergeDeploymentMetadata } from '../verify-whatsapp-intake.mjs';
import { validateIntelligenceSnapshot } from '../../server/intelligence/validation.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const roleNames = ['admin', 'member', 'other'];
const noCapabilities = { appearancePreview: false, testWorkspace: false };
export function verificationMode(args) {
  let allow = false, cleanup = null;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    assert.ok(['--allow-cloud-mutations', '--cleanup-only'].includes(flag), 'Unknown verification argument.');
    assert.equal(args.indexOf(flag), index, 'Duplicate verification argument.');
    if (flag === '--allow-cloud-mutations') allow = true;
    else { cleanup = args[++index]; assert.ok(isAbsolute(cleanup ?? ''), 'Absolute recovery path required.'); }
  }
  assert.ok(!cleanup || allow, 'Cleanup requires explicit mutation authorization.');
  return { mode: cleanup ? 'cleanup' : allow ? 'full' : 'preflight', cleanup };
}
export function canonicalHash(value) {
  const canonical = item => Array.isArray(item) ? item.map(canonical) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function expectedSnapshot(saved) {
  assert.equal(saved?.projectRef, target.supabaseProjectRef, 'Private import target mismatch.');
  const input = saved?.input; assert.ok(input && uuid(input.requestId), 'Saved import request required.');
  assert.match(input.sourceHash ?? '', /^[a-f0-9]{64}$/, 'Saved source hash required.');
  const data = validateIntelligenceSnapshot(input.snapshot);
  // Match PostgreSQL calendar-year arithmetic, including 29 February clamping.
  const [year, month, day] = data.periodStart.split('-').map(Number);
  const nextYearDay = Math.min(day, new Date(Date.UTC(year + 1, month, 0)).getUTCDate());
  const inclusiveYearEnd = new Date(Date.UTC(year + 1, month - 1, nextYearDay) - 86400000).toISOString().slice(0, 10);
  const fixturePeriod = data.periodEnd === inclusiveYearEnd ? 'Last 12 months' : `${data.periodStart} – ${data.periodEnd}`;
  const totals = new Map(); for (const row of data.counts) totals.set(row.supplierId, (totals.get(row.supplierId) ?? 0) + row.count);
  return { ...data, id: input.requestId, suppliers: data.suppliers.map(s => ({ ...s, fixtureCount: totals.get(s.id) ?? 0, fixturePeriod, recordedAt: data.recordedAt })) };
}
export function validateManifest(value) {
  assert.equal(value?.kind, 'eco-intelligence-verification-v1');
  assert.equal(value.projectRef, target.supabaseProjectRef);
  assert.match(value.runId ?? '', /^[a-f0-9]{24}$/);
  assert.equal(value.identities?.length, roleNames.length);
  for (const [index, role] of roleNames.entries()) {
    const item = value.identities[index]; assert.equal(item.role, role); assert.ok(uuid(item.id));
    assert.equal(item.email, `eco-intelligence-${value.runId}-${role}@example.com`);
  }
  assert.equal(new Set(value.identities.map(item => item.id)).size, roleNames.length);
}
export function assertOwnedFixtures(manifest, users, profiles) {
  validateManifest(manifest);
  for (const row of users) {
    const expected = manifest.identities.find(item => item.id === row.id);
    assert.ok(expected && expected.email === row.email && row.tag === manifest.runId, 'Cleanup identity ownership mismatch.');
  }
  for (const row of profiles) {
    const expected = manifest.identities.find(item => item.id === row.id);
    // A failed create response may leave the trigger-created, unprovisioned profile.
    assert.ok(expected && row.email === expected.email && [expected.email, `ECO INTELLIGENCE ${expected.role.toUpperCase()}`].includes(row.display_name)
      && users.some(item => item.id === row.id && item.email === row.email), 'Cleanup profile ownership mismatch.');
  }
}
export function assertDeniedPayload(status, value) {
  assert.ok([401, 403].includes(status), 'Ineligible session must be denied.');
  assert.ok(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1
    && typeof value.message === 'string' && value.message.length <= 200, 'Denied response must not contain snapshot data.');
}
export function assertProtectionCookies(text, base) {
  const host = new URL(base).hostname;
  let found = false;
  for (let line of text.split('\n')) {
    if (line.startsWith('#HttpOnly_')) line = line.slice(10);
    else if (line.startsWith('#') || !line.trim()) continue;
    const [domain, , path, secure, , name, value] = line.split('\t');
    assert.equal(domain, host, 'Protection cookie must be host scoped.');
    assert.ok(path === '/' && secure === 'TRUE' && name === '_vercel_jwt' && value, 'Only a stage protection cookie is permitted; no application identity.');
    found = true;
  }
  assert.ok(found, 'Stage protection cookie required.');
}
function privateRead(path) {
  assert.ok(isAbsolute(path ?? ''), 'Absolute private path required.');
  const stat = lstatSync(path); assert.ok(stat.isFile() && !stat.isSymbolicLink());
  assert.equal(realpathSync(path), resolve(path), 'Private path cannot traverse symlinks.');
  assert.equal(stat.mode & 0o077, 0, 'Owner-only file permissions required.');
  assert.ok(stat.size <= 4194304, 'Private input exceeds limit.');
  const inside = relative(root, path);
  assert.ok(inside.startsWith(`..${sep}`) || isAbsolute(inside) || inside.startsWith(`output${sep}`), 'Private file cannot be public source.');
  if (inside.startsWith(`output${sep}`)) {
    execFileSync('git', ['check-ignore', '-q', '--', path], { cwd: root, stdio: 'ignore' });
  }
  return readFileSync(path, 'utf8');
}
function privateWrite(path, value) { writeFileSync(path, value, { mode: 0o600 }); chmodSync(path, 0o600); }
const command = args => execFileSync('pnpm', args, { cwd: root, encoding: 'utf8', timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 });
const sb = args => command(['dlx', '--allow-build=supabase', 'supabase@2.120.0', ...args]);
const vc = args => command(['dlx', 'vercel@63.1.2', ...args]);

export async function verify(args = process.argv.slice(2)) {
  const environment = process.env;
  const { mode, cleanup: cleanupPath } = verificationMode(args);
  let manifest, output, browser, service, step = 'arguments', failure = null;
  const contexts = [], checks = [];
  const save = () => privateWrite(join(output, 'recovery.private.json'), JSON.stringify(manifest, null, 2));
  const mark = next => { step = next; manifest.step = step; save(); console.log(JSON.stringify({ step })); };
  const rows = sql => {
    privateWrite(join(output, 'query.private.sql'), sql);
    const response = JSON.parse(sb(['db', 'query', '--linked', '--project-ref', target.supabaseProjectRef, '--file', join(output, 'query.private.sql'), '--output', 'json']));
    const result = Array.isArray(response) ? response : response.rows;
    assert.ok(Array.isArray(result), 'Unexpected SQL result.'); return result;
  };
  const ownedIds = () => manifest.identities.map(item => `${quote(item.id)}::uuid`).join(',');
  const ownedEmails = () => manifest.identities.map(item => quote(item.email)).join(',');
  const tagged = identity => `u.id=${quote(identity.id)}::uuid and u.email=${quote(identity.email)} and exists(select 1 from auth.users a where a.id=u.id and a.email=u.email and a.raw_app_meta_data->>'eco_intelligence_verification'=${quote(manifest.runId)})`;
  const post = (ctx, path, body = {}) => ctx.request.post(manifest.base + path, { data: body, headers: { origin: manifest.base, 'x-eco-request': '1' }, timeout: 45000, maxRedirects: 0 });
  const get = (ctx, path = '/api/intelligence/snapshot', headers = {}) => ctx.request.get(manifest.base + path, { headers, timeout: 45000, maxRedirects: 0 });
  async function json(response, status = 200) {
    assert.equal(response.status(), status, 'Unexpected staged response status.');
    assert.match(response.headers()['cache-control'] ?? '', /no-store/);
    return response.json();
  }
  async function denied(ctx, headers = {}) {
    const response = await get(ctx, '/api/intelligence/snapshot', headers);
    assert.match(response.headers()['cache-control'] ?? '', /no-store/);
    assertDeniedPayload(response.status(), await response.json());
  }
  async function context(identity, password) {
    const ctx = await browser.newContext(); contexts.push(ctx);
    if (environment.ECO_PROTECTION_COOKIES) assertProtectionCookies(privateRead(environment.ECO_PROTECTION_COOKIES), manifest.base);
    await installStagingCookies(ctx, manifest.base);
    if (identity) {
      const result = await json(await post(ctx, '/api/access/login', { email: identity.email, password }));
      assert.equal(result.user?.id, identity.id); assert.deepEqual(result.user.capabilities, noCapabilities);
    }
    return ctx;
  }
  async function cleanup() {
    if (!manifest.mutationStarted || manifest.cleanupComplete) return;
    mark('cleanup-owned-fixtures');
    // Also inspect exact generated emails so a provider identity mismatch cannot be
    // silently declared cleaned. A different ID fails ownership validation below.
    const users = rows(`select id,email,raw_app_meta_data->>'eco_intelligence_verification' as tag from auth.users where id in (${ownedIds()}) or email in (${ownedEmails()})`);
    const profiles = rows(`select id,email,display_name from eco_private.users where id in (${ownedIds()})`);
    assertOwnedFixtures(manifest, users, profiles);
    assert.equal(rows(`select id from eco_private.intelligence_snapshots where operator_id in (${ownedIds()})`).length, 0, 'Fixtures must never import data.');
    assert.equal(rows(`select owner_id from eco_private.owner_capabilities where owner_id in (${ownedIds()})`).length, 0, 'Fixtures must never receive owner grants.');
    rows(`begin;
      delete from eco_private.role_previews where user_id in (${ownedIds()});
      delete from eco_private.revoked_sessions where user_id in (${ownedIds()});
      delete from eco_private.users where id in (${ownedIds()});
      commit;`);
    for (const user of users) {
      const result = await service.auth.admin.deleteUser(user.id);
      if (result.error) assert.equal(rows(`select id from auth.users where id=${quote(user.id)}::uuid`).length, 0, 'Fixture Auth cleanup unresolved.');
    }
    assert.equal(rows(`select id from auth.users where id in (${ownedIds()}) or email in (${ownedEmails()})`).length, 0);
    assert.equal(rows(`select id from eco_private.users where id in (${ownedIds()})`).length, 0);
    manifest.cleanupComplete = true; save();
    privateWrite(join(output, 'query.private.sql'), '-- Owned synthetic verification accounts removed.\n');
  }
  try {
    if (cleanupPath) { manifest = JSON.parse(privateRead(cleanupPath)); output = dirname(cleanupPath); }
    else {
      const runId = randomBytes(12).toString('hex');
      manifest = { kind: 'eco-intelligence-verification-v1', projectRef: target.supabaseProjectRef, runId, mode,
        base: environment.ECO_VERIFY_ORIGIN, deploymentId: environment.ECO_VERIFY_DEPLOYMENT_ID, commit: environment.ECO_VERIFY_COMMIT,
        identities: roleNames.map(role => ({ role, id: randomUUID(), email: `eco-intelligence-${runId}-${role}@example.com` })),
        mutationStarted: false, cleanupComplete: false, completed: false };
      assert.ok(manifest.base && new URL(manifest.base).origin === manifest.base);
      assert.equal(new URL(manifest.base).protocol, 'https:');
      assert.match(new URL(manifest.base).hostname, /^[a-z0-9-]+\.vercel\.app$/, 'Exact immutable stage required.');
      assert.match(manifest.deploymentId ?? '', /^dpl_[A-Za-z0-9]+$/); assert.match(manifest.commit ?? '', /^[a-f0-9]{40}$/);
      output = join(root, 'output/access', `intelligence-${runId}`); mkdirSync(output, { recursive: true, mode: 0o700 });
    }
    validateManifest(manifest); save(); mark('verify-targets');
    assert.equal(JSON.parse(sb(['whoami', '--output-format', 'json'])).username, target.githubRepository.split('/')[0]);
    const project = JSON.parse(sb(['projects', 'list', '--output', 'json'])).find(p => p.id === target.supabaseProjectRef);
    assert.equal(project?.name, 'ECO'); assert.equal(project?.organization_id, target.supabaseOrganizationId);
    assert.equal(project?.region, target.supabaseRegion); assert.equal(project?.status, 'ACTIVE_HEALTHY');
    if (mode !== 'preflight') {
      const credentials = JSON.parse(privateRead(environment.ECO_INTELLIGENCE_CREDENTIALS_FILE));
      assert.equal(credentials.projectRef, target.supabaseProjectRef); assert.equal(typeof credentials.secretKey, 'string');
      assert.ok(credentials.secretKey.length > 20 && Object.keys(credentials).every(key => ['projectRef', 'secretKey'].includes(key)), 'Target-scoped service credentials required.');
      service = createClient(`https://${target.supabaseProjectRef}.supabase.co`, credentials.secretKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (url, init) => fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20000) }) } });
    }
    if (mode === 'cleanup') { await cleanup(); return { cleanupComplete: manifest.cleanupComplete }; }
    assert.equal(vc(['whoami']).trim(), 'hocheunglai-6535');
    const compact = JSON.parse(vc(['inspect', manifest.base, '--json', '--scope', target.vercel.teamId]));
    const raw = JSON.parse(vc(['api', `/v13/deployments/${manifest.deploymentId}?teamId=${target.vercel.teamId}`, '--scope', target.vercel.teamId]));
    manifest.deployment = deploymentIdentity(mergeDeploymentMetadata(compact, raw, manifest), manifest); save();
    browser = await chromium.launch({ headless: true });
    const anon = await context(); await denied(anon); checks.push('anonymous-no-data');
    if (mode === 'preflight') { manifest.completed = true; save(); return { completed: true, fullVerification: false, checks, deploymentId: manifest.deploymentId }; }

    const saved = JSON.parse(privateRead(environment.ECO_INTELLIGENCE_REQUEST_FILE));
    const expected = expectedSnapshot(saved), expectedHash = canonicalHash(expected);
    const ownerPreflight = JSON.parse(privateRead(environment.ECO_OWNER_PREFLIGHT_FILE));
    assert.equal(ownerPreflight.target?.id, target.supabaseProjectRef); assert.ok(ownerPreflight.checksPassed && uuid(ownerPreflight.ownerId));
    const owner = rows(`select c.owner_id=${quote(ownerPreflight.ownerId)}::uuid as expected_owner,c.appearance_preview,c.test_workspace,
      u.is_active and u.is_admin and u.activated_at is not null and u.access_hold_request is null and u.deleted_at is null and a.email_confirmed_at is not null and a.deleted_at is null as eligible,
      eco_private.member_owner_capabilities(u) as capabilities
      from eco_private.owner_capabilities c join eco_private.users u on u.id=c.owner_id join auth.users a on a.id=u.id where c.singleton`);
    assert.equal(owner.length, 1); assert.ok(owner[0].expected_owner && owner[0].appearance_preview && owner[0].test_workspace && owner[0].eligible);
    assert.deepEqual(owner[0].capabilities, { appearancePreview: true, testWorkspace: true });
    const importBefore = rows(`select s.id,s.source_hash,s.receipt from eco_private.intelligence_active_snapshot a join eco_private.intelligence_snapshots s on s.id=a.snapshot_id where a.singleton`);
    assert.equal(importBefore.length, 1); assert.equal(importBefore[0].id, saved.input.requestId); assert.equal(importBefore[0].source_hash, saved.input.sourceHash);
    const migrations = await migrationFingerprint(root), source = await sourceFingerprint(root);
    const newVersions = readdirSync(join(root, 'supabase/migrations')).filter(name => /^\d{14}_.*\.sql$/.test(name)).map(name => name.slice(0, 14)).sort();
    assert.ok(migrations.baseline?.head, 'Public baseline metadata required.');
    assert.equal(rows(`select version from supabase_migrations.schema_migrations where version=${quote(migrations.baseline.head)}`).length, 1, 'Legacy production head required.');
    assert.deepEqual(rows(`select version from supabase_migrations.schema_migrations where version>${quote(migrations.baseline.head)} order by version`).map(row => String(row.version)), newVersions);
    assert.equal(rows(`select id from auth.users where id in (${ownedIds()}) or email in (${manifest.identities.map(i => quote(i.email)).join(',')})`).length, 0);
    checks.push('private-import-receipt', 'owner-grant-private-authority');
    mark('create-owned-fixtures'); manifest.mutationStarted = true; save();
    const passwords = manifest.identities.map(() => `EcoIntelligence9-${randomBytes(24).toString('base64url')}`);
    for (const [index, identity] of manifest.identities.entries()) {
      const created = await service.auth.admin.createUser({ id: identity.id, email: identity.email, password: passwords[index], email_confirm: true, app_metadata: { eco_intelligence_verification: manifest.runId } });
      assert.ok(!created.error && created.data.user?.id === identity.id, 'Fixture creation failed or uncertain.');
      const profile = { displayName: `ECO INTELLIGENCE ${identity.role.toUpperCase()}`, officeId: 'HONG KONG', isAdmin: identity.role === 'admin', isSpcTrader: false, isManager: false, isActive: true, sourceSpcId: randomUUID() };
      rows(`begin;select eco_private.provision_user(${quote(identity.id)}::uuid,${quote(JSON.stringify(profile))}::jsonb);
        update eco_private.users u set activated_at=now(),password_prompt_dismissed_at=now() where ${tagged(identity)};commit;`);
    }
    const [admin, member, other] = await Promise.all(manifest.identities.map((identity, index) => context(identity, passwords[index])));
    const system = await json(await get(admin, '/api/admin/system-information'));
    assert.equal(system.targets.databaseProjectRef, target.supabaseProjectRef); assert.equal(system.targets.databaseRegion, target.supabaseRegion);
    assert.equal(system.build.gitCommit, manifest.commit); assert.equal(system.build.sourceSha256, source.sha256); assert.equal(system.migrations.sha256, migrations.sha256);
    manifest.build = { sourceSha256: source.sha256, migrationSha256: migrations.sha256 }; manifest.snapshotHash = expectedHash; save();
    const parity = async ctx => { const result = await json(await get(ctx)); assert.equal(result.available, true); assert.equal(canonicalHash(result.snapshot), expectedHash, 'Authenticated snapshot parity mismatch.'); };
    for (const ctx of [admin, member, other]) {
      await parity(ctx);
      assert.deepEqual(await json(await get(ctx, '/api/enquiries/test-policy')), { enabled: false, generation: '' });
    }
    checks.push('three-real-sessions-private-import-parity', 'nonowner-capabilities-denied');
    const preview = await json(await post(admin, '/api/access/preview', { role: 'trader', officeId: 'HONG KONG' }));
    assert.equal(preview.preview?.readOnly, true); assert.deepEqual(preview.effectiveUser.capabilities, noCapabilities); await parity(admin);
    await json(await post(admin, '/api/access/preview/end')); checks.push('preview-shared-read');
    const forbiddenWrite = await post(member, '/api/intelligence/snapshot', {}); await json(forbiddenWrite, 405);
    await denied(member, { origin: 'https://example.invalid', 'sec-fetch-site': 'cross-site' });
    const invalidQuery = await get(member, '/api/intelligence/snapshot?ownerId=' + manifest.identities[2].id); await json(invalidQuery, 400);
    checks.push('no-browser-write-or-owner-query');
    // Mutate only the owned synthetic profile; an existing JWT must not retain access.
    const a = manifest.identities[1], b = manifest.identities[2];
    for (const [label, blocked, restored] of [['paused', 'is_active=false', 'is_active=true'], ['held', `access_hold_request=${quote(randomUUID())}::uuid`, 'access_hold_request=null'], ['unactivated', 'activated_at=null', 'activated_at=now()']]) {
      assert.equal(rows(`update eco_private.users u set ${blocked} where ${tagged(a)} returning id`).length, 1);
      await denied(member);
      assert.equal(rows(`update eco_private.users u set ${restored} where ${tagged(a)} returning id`).length, 1);
      await parity(member); checks.push(`${label}-existing-session-denied`);
    }
    const sessions = rows(`select s.id from auth.sessions s join auth.users a on a.id=s.user_id where a.id=${quote(b.id)}::uuid and a.raw_app_meta_data->>'eco_intelligence_verification'=${quote(manifest.runId)}`);
    assert.ok(sessions.length > 0 && sessions.every(session => uuid(session.id)), 'Owned session required.');
    rows(`insert into eco_private.revoked_sessions(session_id,user_id) select s.id,s.user_id from auth.sessions s join auth.users a on a.id=s.user_id where a.id=${quote(b.id)}::uuid and a.raw_app_meta_data->>'eco_intelligence_verification'=${quote(manifest.runId)} on conflict(session_id) do nothing;`);
    await denied(other); checks.push('revoked-existing-session-denied');
    await json(await post(member, '/api/access/logout')); await denied(member);
    const relogin = await json(await post(member, '/api/access/login', { email: b.email, password: passwords[2] }));
    assert.equal(relogin.user.id, b.id); assert.deepEqual(relogin.user.capabilities, noCapabilities); await parity(member);
    checks.push('logout-and-cross-account-session');
    assert.equal(canonicalHash(rows(`select s.id,s.source_hash,s.receipt from eco_private.intelligence_active_snapshot a join eco_private.intelligence_snapshots s on s.id=a.snapshot_id where a.singleton`)), canonicalHash(importBefore), 'Verification cannot change imported data.');
    assert.equal(canonicalHash(rows(`select c.owner_id=${quote(ownerPreflight.ownerId)}::uuid as expected_owner,c.appearance_preview,c.test_workspace,
      u.is_active and u.is_admin and u.activated_at is not null and u.access_hold_request is null and u.deleted_at is null and a.email_confirmed_at is not null and a.deleted_at is null as eligible,
      eco_private.member_owner_capabilities(u) as capabilities from eco_private.owner_capabilities c join eco_private.users u on u.id=c.owner_id join auth.users a on a.id=u.id where c.singleton`)), canonicalHash(owner), 'Verification cannot change real owner authority.');
    checks.push('real-import-and-owner-unchanged'); manifest.completed = true; save();
  } catch (error) {
    failure = { step, kind: error?.name === 'AssertionError' ? 'verification-failed' : 'operation-failed' };
    if (manifest && output) { manifest.failure = failure; save(); }
  } finally {
    try { if (manifest && service) await cleanup(); }
    catch { failure = { step: 'cleanup-owned-fixtures', kind: 'cleanup-unconfirmed' }; if (manifest && output) { manifest.failure = failure; save(); } }
    for (const ctx of contexts) await ctx.close().catch(() => {});
    await browser?.close().catch(() => {});
    if (manifest && output) {
      // A read-only or cleanup-only run must never satisfy a full release gate.
      const report = { mode, completed: manifest.completed, passed: mode === 'full' && !failure && manifest.completed && manifest.cleanupComplete,
        preflightPassed: mode === 'preflight' && !failure && manifest.completed, cleanupComplete: manifest.cleanupComplete,
        deploymentId: manifest.deploymentId, commit: manifest.commit, build: manifest.build, snapshotHash: manifest.snapshotHash, checks, failure,
        limitations: 'API/session/database verification only; owner grant checked privately in SQL, not by signing in as the real owner. No browser layout screenshots, import, owner grant changes, outbound messages or provider calls.' };
      privateWrite(join(output, 'verification.private.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ mode, passed: report.passed, cleanupComplete: manifest.cleanupComplete, snapshotHash: manifest.snapshotHash, report: join(output, 'verification.private.json'), failure }));
    }
  }
  if (failure) throw new Error('Hosted intelligence verification failed; inspect the private recovery report.');
  return { completed: manifest.completed, cleanupComplete: manifest.cleanupComplete, checks };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verify().catch(() => { console.error('Hosted intelligence verification failed. Private recovery evidence retained; no data values are printed.'); process.exitCode = 1; });
}
