/** Operator-only role preview verification. Own disposable identities only; no staff mutations. */
import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { ecoConnections } from '../config/ecoConnections.ts';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runId = randomBytes(8).toString('hex');
const output = join(root, 'output', 'access', `role-cloud-${runId}`);
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
const privateWrite = (path, value) => { writeFileSync(path, value, { mode: 0o600 }); chmodSync(path, 0o600); };
const run = args => execFileSync('pnpm', args, { cwd: root, encoding: 'utf8', timeout: 90_000,
  stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 });
const sb = args => run(['dlx', '--allow-build=supabase', 'supabase@2.120.0', ...args]);
const vc = args => run(['dlx', 'vercel@63.1.2', ...args]);
let step = 'authorization';

async function verify() {
  assert.ok(process.argv.includes('--allow-cloud-mutations'));
  const base = process.env.ECO_VERIFY_ORIGIN ?? ecoConnections.productionOrigin;
  const origin = new URL(base), staged = origin.hostname.endsWith('.vercel.app');
  assert.equal(origin.origin, base); assert.equal(origin.protocol, 'https:');
  assert.ok(base === ecoConnections.productionOrigin || /^[a-z0-9-]+\.vercel\.app$/.test(origin.hostname));
  assert.equal(JSON.parse(sb(['whoami', '--output-format', 'json'])).username, 'hocheunglai-oss');
  const project = JSON.parse(sb(['projects', 'list', '--output', 'json'])).find(p => p.id === ecoConnections.supabaseProjectRef);
  assert.equal(project?.organization_id, ecoConnections.supabaseOrganizationId);
  assert.equal(project?.region, ecoConnections.supabaseRegion); assert.equal(project?.name, 'ECO');
  assert.equal(project?.status, 'ACTIVE_HEALTHY');
  const deployment = JSON.parse(vc(['inspect', base, '--json', '--scope', ecoConnections.vercel.teamId]));
  assert.equal(deployment.name, ecoConnections.vercel.projectName); assert.equal(deployment.readyState, 'READY');
  assert.ok(deployment.builds.some(b => b.output?.some(o => o.digest?.startsWith(ecoConnections.vercel.projectId + '/'))));
  mkdirSync(output, { recursive: true, mode: 0o700 }); chmodSync(output, 0o700);
  const identities = ['admin', 'trader'].map(role => ({ role, id: randomUUID(), email: `eco-role-${runId}-${role}@example.com` }));
  const manifest = { runId, projectRef: project.id, base, deploymentId: deployment.id, identities, completed: false, cleanupComplete: false };
  const save = () => privateWrite(join(output, 'recovery.private.json'), JSON.stringify({ ...manifest, step }, null, 2));
  const checkpoint = value => { step = value; save(); console.log(JSON.stringify({ check: step })); };
  const sql = value => { const path = join(output, 'query.private.sql'); privateWrite(path, value);
    const result = JSON.parse(sb(['db', 'query', '--linked', '--project-ref', project.id, '--file', path, '--output', 'json']));
    const rows = Array.isArray(result) ? result : result.rows; assert.ok(Array.isArray(rows)); return rows; };
  const keys = JSON.parse(readFileSync(join(root, 'output/access/eco-api-keys.private.json'), 'utf8'));
  const secret = keys.find(k => k.type === 'secret')?.api_key; assert.ok(secret);
  const service = createClient(`https://${project.id}.supabase.co`, secret, { auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(20_000) }) } });
  const passwords = Object.fromEntries(identities.map(i => [i.role, 'EcoRole9-' + randomBytes(24).toString('base64url')]));
  const cookies = staged ? readFileSync(join(root, 'output/access/staging-cookies.private.txt'), 'utf8').split('\n')
    .filter(line => line.includes('\t') && (!line.startsWith('#') || line.startsWith('#HttpOnly_'))).map(line => {
      const f = line.replace(/^#HttpOnly_/, '').split('\t'); assert.equal(f[0].replace(/^\./, ''), origin.hostname);
      return { name: f[5], value: f[6], domain: origin.hostname, path: f[2], secure: f[3] === 'TRUE',
        httpOnly: line.startsWith('#HttpOnly_'), expires: Number(f[4]) || -1 };
    }) : [];
  if (staged) assert.ok(cookies.length);
  let browser; const contexts = []; const errors = [];
  const post = (context, path, body = {}) => context.request.post(base + '/api/access/' + path,
    { headers: { origin: base, 'x-eco-request': '1' }, data: body, timeout: 45_000 });
  const payload = async response => { assert.equal(response.status(), 200); return response.json(); };
  try {
    checkpoint('preflight');
    assert.equal(sql("select id from eco_private.offices where id='CREDIT' and name='CREDIT'").length, 1);
    for (const identity of identities) {
      const result = await service.auth.admin.createUser({ id: identity.id, email: identity.email, password: passwords[identity.role],
        email_confirm: true, app_metadata: { eco_role_verification: runId } });
      assert.ok(!result.error); assert.equal(result.data.user?.id, identity.id);
    }
    sql('begin;' + identities.map(i => {
      const profile = { displayName: `ECO ROLE ${i.role.toUpperCase()}`, officeId: i.role === 'admin' ? 'HONG KONG' : 'CREDIT',
        isAdmin: i.role === 'admin', isManager: false, isSpcTrader: false, isActive: true, sourceSpcId: randomUUID() };
      return `select eco_private.provision_user(${quote(i.id)}::uuid,${quote(JSON.stringify(profile))}::jsonb);
        update eco_private.users set activated_at=now(),password_prompt_dismissed_at=now() where id=${quote(i.id)}::uuid;`;
    }).join('') + 'commit;');
    browser = await chromium.launch({ headless: true });
    const context = async () => { const c = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      await c.addCookies(cookies); contexts.push(c); return c; };
    const admin = await context(), trader = await context();
    const login = async (c, i) => payload(await post(c, 'login', { email: i.email, password: passwords[i.role] }));
    const adminUser = (await login(admin, identities[0])).user;
    const creditUser = (await login(trader, identities[1])).user;
    assert.equal(creditUser.officeId, 'CREDIT'); assert.equal(creditUser.isAdmin, false);
    assert.equal(creditUser.isManager, false); assert.equal(creditUser.isSpcTrader, false);
    const options = await payload(await admin.request.get(base + '/api/access/preview/options'));
    assert.ok(options.offices.some(o => o.id === 'CREDIT'));
    assert.equal((await trader.request.get(base + '/api/access/preview/options')).status(), 403);
    assert.equal((await post(trader, 'preview', { role: 'admin', officeId: 'HONG KONG' })).status(), 403);
    assert.equal((await post(admin, 'preview', { role: 'manager', officeId: 'not-an-office' })).status(), 400);
    checkpoint('all-five-presets-and-read-only-api');
    for (const role of ['admin', 'trader', 'spc-trader', 'manager', 'credit']) {
      const officeId = role === 'credit' ? 'CREDIT' : 'HONG KONG';
      const result = await payload(await post(admin, 'preview', { role, officeId }));
      assert.equal(result.user.id, adminUser.id); assert.equal(result.user.isAdmin, true);
      assert.equal(result.effectiveUser.id, adminUser.id); assert.equal(result.effectiveUser.officeId, officeId);
      assert.equal(result.effectiveUser.isAdmin, role === 'admin');
      assert.equal(result.effectiveUser.isManager, role === 'manager');
      assert.equal(result.effectiveUser.isSpcTrader, role === 'spc-trader');
      assert.equal(result.preview.role, role); assert.equal(result.preview.readOnly, true);
      const again = await payload(await admin.request.get(base + '/api/access/session'));
      assert.equal(again.preview.role, role);
      assert.equal((await admin.request.get(base + '/api/access/users')).status(), role === 'admin' ? 200 : 403);
      for (const path of ['users', 'users/create', 'users/reset-password', 'password', 'password-prompt', 'activate', 'login']) {
        assert.equal((await post(admin, path)).status(), 403, `${role}: ${path} must remain read-only`);
      }
    }
    const ended = await payload(await post(admin, 'preview/end'));
    assert.equal(ended.preview ?? null, null); assert.equal(ended.user.id, adminUser.id);
    assert.equal(ended.user.officeId, 'HONG KONG'); assert.equal(ended.user.isAdmin, true);
    checkpoint('browser-quick-switch-and-return');
    const page = await admin.newPage(); page.on('pageerror', () => errors.push(true));
    await page.goto(base); await page.getByRole('main', { name: 'ECOSYSTEM workspace' }).waitFor();
    // UI selectors are finalized alongside RolePreview; fail closed if the control is absent.
    await page.getByRole('button', { name: 'Personal details', exact: true }).click();
    await page.getByRole('button', { name: 'View as', exact: true }).click();
    await page.getByLabel('Preview role', { exact: true }).selectOption('manager');
    await page.getByLabel('Preview office', { exact: true }).selectOption('SINGAPORE');
    await page.getByRole('button', { name: 'Start preview', exact: true }).click();
    await page.getByRole('status').filter({ hasText: /PREVIEW/i }).waitFor();
    const previewSession = await payload(await admin.request.get(base + '/api/access/session'));
    assert.equal(previewSession.preview.role, 'manager'); assert.equal(previewSession.preview.officeId, 'SINGAPORE');
    await page.screenshot({ path: join(output, 'manager-preview-light.png') });
    const exitResponse = page.waitForResponse(response => response.url() === base + '/api/access/preview/end' && response.request().method() === 'POST');
    await page.getByRole('button', { name: /Back to ECO ROLE ADMIN/i }).click();
    assert.equal((await exitResponse).status(), 200);
    await page.getByRole('status', { name: 'Role preview' }).waitFor({ state: 'hidden' });
    const returned = await payload(await admin.request.get(base + '/api/access/session'));
    assert.equal(returned.preview ?? null, null); assert.equal(returned.user.id, adminUser.id);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Users & Access', exact: true }).waitFor();
    assert.equal(errors.length, 0);
    checkpoint('logout-clears-preview-and-roles-unchanged');
    await payload(await post(admin, 'preview', { role: 'credit', officeId: 'CREDIT' }));
    assert.equal((await post(admin, 'logout')).status(), 200);
    assert.equal((await admin.request.get(base + '/api/access/session')).status(), 401);
    const fresh = await login(admin, identities[0]);
    assert.equal(fresh.preview ?? null, null); assert.equal(fresh.user.isAdmin, true);
    assert.equal(fresh.user.officeId, adminUser.officeId); assert.equal(fresh.user.revision, adminUser.revision);
    manifest.completed = true; save();
    console.log(JSON.stringify({ realCloud: true, allFivePresets: true, creditOfficeOrdinaryTrader: true,
      serverReadOnly: true, realIdentityPreserved: true, normalTraderDenied: true, browserSwitchAndReturn: true,
      sessionPersistence: true, logoutClearsPreview: true, noRoleChanges: true, browserErrors: errors.length, invitationsSent: 0 }));
  } finally {
    const verifiedStep = step;
    for (const c of contexts) await post(c, 'logout').catch(() => {});
    await browser?.close().catch(() => {});
    checkpoint('cleanup-own-fixtures');
    const candidates = sql(`select id,email,raw_app_meta_data->>'eco_role_verification' as marker from auth.users
      where id in (${identities.map(i => quote(i.id) + '::uuid').join(',')});`);
    assert.ok(candidates.every(c => c.marker === runId && identities.some(i => i.id === c.id && i.email === c.email)));
    if (candidates.length) {
      const ids = candidates.map(c => quote(c.id) + '::uuid').join(',');
      sql(`begin;update eco_private.users set is_active=false where id in (${ids});
        delete from eco_private.admin_operations where actor_id in (${ids}) or target_id in (${ids});
        delete from eco_private.revoked_sessions where user_id in (${ids});
        delete from eco_private.users where id in (${ids});commit;`);
      for (const c of candidates) { const result = await service.auth.admin.deleteUser(c.id); assert.ok(!result.error); }
    }
    assert.equal(sql(`select id from auth.users where id in (${identities.map(i => quote(i.id) + '::uuid').join(',')});`).length, 0);
    manifest.cleanupComplete = true; save();
    privateWrite(join(output, 'query.private.sql'), '-- Complete; see recovery.private.json.\n');
    console.log(JSON.stringify({ cleanupComplete: true, verificationIdentitiesRemoved: candidates.length,
      recoveryManifest: join(output, 'recovery.private.json') }));
    step = verifiedStep;
  }
}
verify().catch(error => {
  console.error(JSON.stringify({ verificationFailed: true, step, type: error?.name,
    code: typeof error?.code === 'string' ? error.code : undefined,
    commandSignal: typeof error?.signal === 'string' ? error.signal : undefined,
    actual: ['number', 'boolean'].includes(typeof error?.actual) ? error.actual : undefined,
    expected: ['number', 'boolean'].includes(typeof error?.expected) ? error.expected : undefined,
    location: error?.stack?.split('\n').find(line => line.includes('verify-role-preview-cloud.mjs:'))?.trim() }));
  process.exitCode = 1;
});
