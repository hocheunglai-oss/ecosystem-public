/**
 * Operator-only verification against ECO's real Auth, API and database.
 * Run after the reviewed migration/deployment, with --allow-cloud-mutations.
 * Creates only this run's temporary accounts, never sends invitations, and never
 * changes an existing staff account. Do not enable Playwright traces: forms hold
 * generated fixture credentials. Recovery manifests contain IDs, never passwords.
 */
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
const output = join(root, 'output', 'access', `admin-cloud-${runId}`);
const recoveryPath = join(output, 'recovery.private.json');
let step = 'authorization';
const check = (condition, description) => { if (!condition) throw new Error(description); };
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const privateWrite = (path, text) => { writeFileSync(path, text, { mode: 0o600 }); chmodSync(path, 0o600); };
const run = (args, timeout = 90_000) => execFileSync('pnpm', args, {
  cwd: root, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024,
});
const supabase = args => run(['dlx', '--allow-build=supabase', 'supabase@2.120.0', ...args]);
const vercel = args => run(['dlx', 'vercel@63.1.2', ...args]);

async function verify() {
  check(process.argv.includes('--allow-cloud-mutations'), 'The operator must explicitly enable disposable cloud fixtures.');
  const base = process.env.ECO_VERIFY_ORIGIN ?? ecoConnections.productionOrigin;
  const origin = new URL(base);
  const staged = origin.hostname.endsWith('.vercel.app');
  check(origin.origin === base && origin.protocol === 'https:' && (base === ecoConnections.productionOrigin ||
    /^[a-z0-9-]+\.vercel\.app$/.test(origin.hostname)), 'Unapproved verification origin.');
  const projectRef = ecoConnections.supabaseProjectRef;
  check(typeof projectRef === 'string' && /^[a-z]+$/.test(projectRef), 'Missing canonical ECO project.');

  step = 'verify-operator-and-targets';
  const operator = JSON.parse(supabase(['whoami', '--output-format', 'json']));
  assert.equal(operator.username, 'hocheunglai-oss');
  const project = JSON.parse(supabase(['projects', 'list', '--output', 'json'])).find(item => item.id === projectRef);
  assert.equal(project?.organization_id, ecoConnections.supabaseOrganizationId);
  assert.equal(project?.region, ecoConnections.supabaseRegion);
  assert.equal(project?.name, 'ECO');
  assert.equal(project?.status, 'ACTIVE_HEALTHY');
  const deployment = JSON.parse(vercel(['inspect', base, '--json', '--scope', ecoConnections.vercel.teamId]));
  assert.equal(deployment.name, ecoConnections.vercel.projectName);
  assert.equal(deployment.readyState, 'READY');
  check(deployment.builds?.some(build => build.output?.some(item =>
    item.digest?.startsWith(ecoConnections.vercel.projectId + '/'))), 'Deployment is not ECO.');

  mkdirSync(output, { recursive: true, mode: 0o700 }); chmodSync(output, 0o700);
  const manifest = { runId, projectRef, base, deploymentId: deployment.id, step, completed: false,
    cleanupComplete: false, expectedEmails: [], requestIds: [], identities: [] };
  const save = () => privateWrite(recoveryPath, JSON.stringify({ ...manifest, step }, null, 2));
  const checkpoint = value => { step = value; save(); console.log(JSON.stringify({ check: step })); };
  const sql = text => {
    const path = join(output, 'query.private.sql'); privateWrite(path, text);
    return JSON.parse(supabase(['db', 'query', '--linked', '--project-ref', projectRef, '--file', path, '--output', 'json']));
  };
  const rows = text => { const result = sql(text); const data = Array.isArray(result) ? result : result.rows;
    check(Array.isArray(data), 'Unexpected database response shape.'); return data; };
  const expectRequest = id => { check(uuid(id), 'Invalid fixture request ID.');
    if (!manifest.requestIds.includes(id)) { manifest.requestIds.push(id); save(); } };
  const remember = (id, email) => { check(uuid(id) && manifest.expectedEmails.includes(email), 'Unexpected fixture identity.');
    if (!manifest.identities.some(item => item.id === id)) { manifest.identities.push({ id, email }); save(); } };
  const adminEmail = `eco-admin-check-${runId}-admin@example.com`;
  const traderEmail = `eco-admin-check-${runId}-trader@example.com`;
  const inactiveEmail = `eco-admin-check-${runId}-inactive@example.com`;
  const newAdminEmail = `eco-admin-check-${runId}-newadmin@example.com`;
  manifest.expectedEmails.push(adminEmail, traderEmail, inactiveEmail, newAdminEmail); save();
  const defaultPassword = process.env.ECO_VERIFY_NEW_USER_PASSWORD;
  check(typeof defaultPassword === 'string' && defaultPassword.length >= 8, 'Missing server-default verification credential.');
  const credentials = {
    admin: 'EcoAdmin9-' + randomBytes(20).toString('base64url'),
    trader: defaultPassword,
    changed: 'EcoChanged9-' + randomBytes(20).toString('base64url'),
    inactive: defaultPassword,
    inactiveChanged: 'EcoInactiveNext9-' + randomBytes(20).toString('base64url'),
    wrong: 'EcoWrong9-' + randomBytes(20).toString('base64url'),
  };
  const keys = JSON.parse(readFileSync(join(root, 'output/access/eco-api-keys.private.json'), 'utf8'));
  const secret = keys.find(key => key.type === 'secret')?.api_key;
  check(typeof secret === 'string' && secret.length > 20, 'Missing operator key.');
  const service = createClient(`https://${projectRef}.supabase.co`, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(20_000) }) },
  });
  const protectionCookies = staged ? readFileSync(process.env.ECO_VERIFY_STAGING_COOKIES ??
    join(root, 'output/access/staging-cookies.private.txt'), 'utf8').split('\n')
    .filter(line => line.includes('\t') && (!line.startsWith('#') || line.startsWith('#HttpOnly_')))
    .map(line => {
      const fields = line.replace(/^#HttpOnly_/, '').split('\t');
      check(fields[0].replace(/^\./, '') === origin.hostname, 'Protection cookie belongs to another deployment.');
      return { name: fields[5], value: fields[6], domain: origin.hostname, path: fields[2], secure: fields[3] === 'TRUE',
        httpOnly: line.startsWith('#HttpOnly_'), expires: Number(fields[4]) || -1 };
    }) : [];
  if (staged) check(protectionCookies.length > 0, 'Missing staged-deployment protection cookies.');

  let browser;
  let verificationError;
  const contexts = [];
  const browserErrors = [];
  const post = (context, path, body, headers = {}) => context.request.post(base + '/api/access/' + path, {
    headers: { origin: base, 'x-eco-request': '1', ...headers }, data: body, timeout: 45_000,
  });
  const resultUser = async response => { assert.equal(response.status(), 200); return (await response.json()).user; };
  try {
    checkpoint('preflight-schema-and-empty-fixture-names');
    assert.equal(rows(`select id from auth.users where email in (${manifest.expectedEmails.map(quote).join(',')});`).length, 0);
    const schema = rows("select to_regprocedure('public.eco_delete_user(uuid,uuid,uuid,uuid,uuid,integer)') is not null as ready;");
    assert.equal(schema[0]?.ready, true);
    const office = rows('select id,name from eco_private.offices order by name limit 1;')[0];
    check(office?.id && office?.name, 'No office available.');

    checkpoint('bootstrap-own-administrator');
    const adminId = randomUUID(); remember(adminId, adminEmail);
    const created = await service.auth.admin.createUser({ id: adminId, email: adminEmail, password: credentials.admin,
      email_confirm: true, app_metadata: { eco_verification: runId } });
    check(!created.error && created.data.user?.id === adminId, 'Disposable administrator was not created.');
    const profile = { displayName: 'ECO VERIFY ADMIN', officeId: office.id, isAdmin: true, isManager: false,
      isSpcTrader: false, isActive: true, sourceSpcId: randomUUID() };
    sql(`begin;select eco_private.provision_user(${quote(adminId)}::uuid,${quote(JSON.stringify(profile))}::jsonb);
      update eco_private.users set activated_at=now(),password_prompt_dismissed_at=now() where id=${quote(adminId)}::uuid;commit;`);
    browser = await chromium.launch({ headless: true });
    const context = async () => { const value = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      await value.addCookies(protectionCookies); contexts.push(value); return value; };
    const admin = await context();
    assert.equal((await admin.request.get(base + '/api/access/session')).status(), 401);
    const adminMember = await resultUser(await post(admin, 'login', { email: adminEmail, password: credentials.admin }));
    assert.equal(adminMember.id, adminId); assert.equal(adminMember.isAdmin, true);
    let page = await admin.newPage(); page.setDefaultTimeout(30_000);
    page.on('pageerror', () => browserErrors.push(true));
    page.on('request', request => {
      if (request.method() === 'POST' && [base + '/api/access/users/create', base + '/api/access/users/reset-password', base + '/api/access/users/delete'].includes(request.url())) {
        const body = request.postDataJSON(); if (body?.requestId) expectRequest(body.requestId);
      }
    });
    const openDirectory = async () => {
      await page.goto(base); await page.getByRole('main', { name: 'ECOSYSTEM workspace' }).waitFor();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('button', { name: 'Users & Access', exact: true }).click();
      await page.getByRole('region', { name: 'Users & Access', exact: true }).waitFor();
    };
    const directory = () => page.getByRole('region', { name: 'Users & Access', exact: true });
    const creation = { requestId: randomUUID(), email: traderEmail, displayName: 'ECO VERIFY TRADER', phone: '+85255550101',
      officeId: office.id, isAdmin: false, isManager: false, isSpcTrader: false, isActive: true,
      administratorPassword: credentials.admin };

    checkpoint('reject-origin-and-wrong-administrator-password');
    assert.equal((await post(admin, 'users/create', creation, { origin: 'https://untrusted.example' })).status(), 403);
    assert.equal((await post(admin, 'users/create', creation, { 'sec-fetch-site': 'cross-site' })).status(), 403);
    assert.equal((await post(admin, 'users/create', { ...creation, administratorPassword: credentials.wrong })).status(), 400);

    checkpoint('browser-add-user');
    await openDirectory();
    await directory().getByRole('button', { name: 'Add user', exact: true }).click();
    const editor = page.getByRole('complementary', { name: 'Add user', exact: true });
    await editor.getByLabel('Name', { exact: true }).fill(creation.displayName);
    await editor.getByLabel('Email', { exact: true }).fill(traderEmail);
    await editor.getByLabel('WhatsApp phone', { exact: true }).fill('+852 (5555)-0101');
    await editor.getByLabel('Office', { exact: true }).selectOption(office.id);
    assert.equal(await editor.getByLabel('New password', { exact: true }).count(), 0);
    assert.equal(await editor.getByLabel('Confirm password', { exact: true }).count(), 0);
    await editor.getByLabel('Your administrator password', { exact: true }).fill(credentials.admin);
    const addResponse = page.waitForResponse(response => response.url() === base + '/api/access/users/create' && response.request().method() === 'POST');
    await editor.getByRole('button', { name: 'Add user', exact: true }).click();
    const addedResponse = await addResponse;
    const createBody = addedResponse.request().postDataJSON();
    assert.equal(Object.hasOwn(createBody, 'password'), false);
    let trader = await resultUser(addedResponse); remember(trader.id, trader.email);
    assert.equal(trader.email, traderEmail); assert.equal(trader.phone, creation.phone);
    assert.equal(trader.activated, true); assert.equal(trader.passwordChangeSuggested, true);
    assert.equal(trader.isActive, true); assert.equal(trader.isAdmin, false);
    await directory().getByRole('status').filter({ hasText: 'User added.' }).waitFor();

    checkpoint('create-replay-and-duplicate-email');
    const replay = await resultUser(await post(admin, 'users/create', createBody));
    assert.equal(replay.id, trader.id); assert.equal(replay.revision, trader.revision);
    const duplicateRequest = { ...createBody, requestId: randomUUID() }; expectRequest(duplicateRequest.requestId);
    assert.equal((await post(admin, 'users/create', duplicateRequest)).status(), 400);
    assert.equal(rows(`select id from auth.users where email=${quote(traderEmail)};`).length, 1);

    checkpoint('browser-edit-phone');
    const edit = page.getByRole('complementary', { name: 'Edit user', exact: true });
    await edit.getByLabel('WhatsApp phone', { exact: true }).fill('+852–(5555) 0102');
    const editResponse = page.waitForResponse(response => response.url() === base + '/api/access/users' && response.request().method() === 'POST');
    await edit.getByRole('button', { name: 'Save changes', exact: true }).click();
    trader = await resultUser(await editResponse); assert.equal(trader.phone, '+85255550102');
    await directory().getByLabel('Search users', { exact: true }).fill(traderEmail);
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light' && document.documentElement.dataset.themePending === 'false');
    await page.screenshot({ path: join(output, 'users-access-light.png') });
    await page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('button', { name: 'Dark mode', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark' && document.documentElement.dataset.themePending === 'false');
    // The theme commits before the 420ms native view-transition snapshot fades.
    // Let that finite visual transition settle before capturing the actual dark UI.
    await page.waitForTimeout(650);
    const darkSurface = await edit.evaluate(element => ({
      background: getComputedStyle(element).backgroundColor,
      text: getComputedStyle(element).color,
    }));
    assert.equal(darkSurface.background, 'rgb(25, 43, 60)');
    assert.equal(darkSurface.text, 'rgb(237, 245, 251)');
    await page.screenshot({ path: join(output, 'users-access-dark.png') });

    checkpoint('trader-admission-and-optional-first-login-prompt');
    const member = await context(); const peer = await context();
    let signedIn = await resultUser(await post(member, 'login', { email: traderEmail, password: credentials.trader }));
    assert.equal(signedIn.id, trader.id); assert.equal(signedIn.phone, '+85255550102');
    assert.equal(signedIn.passwordChangeSuggested, true);
    await resultUser(await post(peer, 'login', { email: traderEmail, password: credentials.trader }));
    const traderPage = await member.newPage(); traderPage.on('pageerror', () => browserErrors.push(true));
    await traderPage.goto(base);
    await traderPage.getByRole('complementary', { name: 'Change password invitation' }).waitFor();
    const skipResponse = traderPage.waitForResponse(response => response.url() === base + '/api/access/password-prompt' && response.request().method() === 'POST');
    await traderPage.getByRole('button', { name: 'Skip', exact: true }).click();
    signedIn = await resultUser(await skipResponse); assert.equal(signedIn.passwordChangeSuggested, false);
    trader = signedIn;
    assert.equal((await member.request.get(base + '/api/access/users')).status(), 403);
    assert.equal((await post(member, 'users/create', creation)).status(), 403);
    assert.equal((await post(member, 'users/reset-password', { requestId: randomUUID(), id: adminId,
      expectedRevision: adminMember.revision, newPassword: credentials.changed, administratorPassword: credentials.trader })).status(), 403);
    await traderPage.getByRole('button', { name: 'Settings', exact: true }).click();
    assert.equal(await traderPage.getByRole('button', { name: 'Users & Access', exact: true }).count(), 0);

    checkpoint('browser-admin-password-reset');
    // Reload after the member skipped the prompt, which legitimately changes revision.
    await openDirectory();
    await directory().getByLabel('Search users', { exact: true }).fill(traderEmail);
    await directory().getByRole('button').filter({ hasText: 'ECO VERIFY TRADER' }).click();
    await page.getByRole('complementary', { name: 'Edit user', exact: true }).getByRole('button', { name: 'Reset password', exact: true }).click();
    const resetForm = page.getByRole('form', { name: 'Reset password', exact: true });
    await resetForm.getByLabel('New password', { exact: true }).fill(credentials.changed);
    await resetForm.getByLabel('Confirm password', { exact: true }).fill(credentials.changed);
    await resetForm.getByLabel('Your administrator password', { exact: true }).fill(credentials.admin);
    const resetResponse = page.waitForResponse(response => response.url() === base + '/api/access/users/reset-password' && response.request().method() === 'POST');
    await resetForm.getByRole('button', { name: 'Reset password', exact: true }).click();
    const resetResult = await resetResponse; const resetBody = resetResult.request().postDataJSON();
    trader = await resultUser(resetResult); assert.equal(trader.passwordChangeSuggested, true);
    assert.equal(trader.phone, '+85255550102'); assert.equal(trader.isActive, true);
    await directory().getByRole('status').filter({ hasText: 'Password reset.' }).waitFor();
    assert.equal((await member.request.get(base + '/api/access/session')).status(), 401);
    assert.equal((await peer.request.get(base + '/api/access/session')).status(), 401);
    assert.equal((await post(member, 'login', { email: traderEmail, password: credentials.trader })).status(), 401);
    const afterReset = await resultUser(await post(member, 'login', { email: traderEmail, password: credentials.changed }));
    assert.equal(afterReset.id, trader.id); assert.equal(afterReset.passwordChangeSuggested, true);
    const resetReplay = await resultUser(await post(admin, 'users/reset-password', resetBody));
    assert.equal(resetReplay.revision, trader.revision);
    // A retry must not reset again or revoke a session opened after the first success.
    assert.equal((await member.request.get(base + '/api/access/session')).status(), 200);

    checkpoint('inactive-create-and-reset-preserve-suspension');
    const inactiveBody = { ...creation, requestId: randomUUID(), email: inactiveEmail, displayName: 'ECO VERIFY INACTIVE',
      phone: '', isActive: false }; expectRequest(inactiveBody.requestId);
    let inactive = await resultUser(await post(admin, 'users/create', inactiveBody)); remember(inactive.id, inactive.email);
    assert.equal(inactive.isActive, false); assert.equal(inactive.activated, true);
    const inactiveContext = await context();
    assert.equal((await post(inactiveContext, 'login', { email: inactiveEmail, password: credentials.inactive })).status(), 401);
    const inactiveReset = { requestId: randomUUID(), id: inactive.id, expectedRevision: inactive.revision,
      newPassword: credentials.inactiveChanged, administratorPassword: credentials.admin }; expectRequest(inactiveReset.requestId);
    inactive = await resultUser(await post(admin, 'users/reset-password', inactiveReset));
    assert.equal(inactive.isActive, false);
    assert.equal((await post(inactiveContext, 'login', { email: inactiveEmail, password: credentials.inactiveChanged })).status(), 401);
    assert.equal((await inactiveContext.request.get(base + '/api/access/session')).status(), 401);

    checkpoint('new-administrator-uses-the-same-server-default');
    const newAdminBody = { ...creation, requestId: randomUUID(), email: newAdminEmail,
      displayName: 'ECO VERIFY NEW ADMIN', isAdmin: true, password: credentials.wrong };
    expectRequest(newAdminBody.requestId);
    const newAdmin = await resultUser(await post(admin, 'users/create', newAdminBody)); remember(newAdmin.id, newAdmin.email);
    const newAdminContext = await context();
    assert.equal((await post(newAdminContext, 'login', {email:newAdminEmail,password:credentials.wrong})).status(),401);
    const signedNewAdmin=await resultUser(await post(newAdminContext, 'login', {email:newAdminEmail,password:defaultPassword}));
    assert.equal(signedNewAdmin.id,newAdmin.id);assert.equal(signedNewAdmin.isAdmin,true);

    // Exercise the second independently created administrator for deletion so this
    // intentionally dense suite respects each identity's real login/proof throttle.
    // Do not clear, disable or bypass the production rate limiter.
    await resultUser(await post(newAdminContext,'password-prompt',{}));
    await page.close();
    page=await newAdminContext.newPage();page.setDefaultTimeout(30_000);
    page.on('pageerror',()=>browserErrors.push(true));
    page.on('request',request=>{
      if(request.method()==='POST'&&request.url()===base+'/api/access/users/delete'){
        const body=request.postDataJSON();if(body?.requestId)expectRequest(body.requestId);
      }
    });
    checkpoint('delete-protections-before-browser-confirmation');
    const deleteBody={requestId:randomUUID(),id:trader.id,expectedRevision:trader.revision,administratorPassword:defaultPassword};
    expectRequest(deleteBody.requestId);
    assert.equal((await post(member,'users/delete',deleteBody)).status(),403);
    assert.equal((await post(newAdminContext,'users/delete',{...deleteBody,id:newAdmin.id,expectedRevision:signedNewAdmin.revision})).status(),400);
    assert.equal((await post(newAdminContext,'users/delete',{...deleteBody,administratorPassword:credentials.wrong})).status(),400);
    assert.equal((await post(newAdminContext,'users/delete',{...deleteBody,expectedRevision:trader.revision+1})).status(),409);
    assert.equal((await post(newAdminContext,'preview',{role:'admin',officeId:office.id})).status(),200);
    assert.equal((await post(newAdminContext,'users/delete',deleteBody)).status(),403);
    assert.equal((await post(newAdminContext,'preview/end',{})).status(),200);

    checkpoint('browser-delete-user-and-retry');
    await openDirectory();await directory().getByLabel('Search users',{exact:true}).fill(traderEmail);
    await directory().getByRole('button').filter({hasText:'ECO VERIFY TRADER'}).click();
    await page.getByRole('complementary',{name:'Edit user',exact:true}).getByRole('button',{name:'Delete user',exact:true}).click();
    const deleteForm=page.getByRole('form',{name:'Delete user',exact:true});
    await deleteForm.getByLabel('Your administrator password',{exact:true}).fill(defaultPassword);
    const deleteResponse=page.waitForResponse(response=>response.url()===base+'/api/access/users/delete'&&response.request().method()==='POST');
    await deleteForm.getByRole('button',{name:'Delete user',exact:true}).click();
    const removedResponse=await deleteResponse;assert.equal(removedResponse.status(),200);
    assert.deepEqual(await removedResponse.json(),{deletedUserId:trader.id});
    const removedBody=removedResponse.request().postDataJSON();
    const deleteReplay=await post(newAdminContext,'users/delete',removedBody);assert.equal(deleteReplay.status(),200);
    assert.deepEqual(await deleteReplay.json(),{deletedUserId:trader.id});
    await directory().getByRole('status').filter({hasText:'User deleted.'}).waitFor();
    assert.equal((await member.request.get(base+'/api/access/session')).status(),401);
    assert.equal((await post(member,'login',{email:traderEmail,password:credentials.changed})).status(),401);
    const remaining=await admin.request.get(base+'/api/access/users');assert.equal(remaining.status(),200);
    assert.equal((await remaining.json()).users.some(user=>user.id===trader.id),false);
    const tombstone=rows(`select deleted_at is not null as deleted,is_active,is_admin,is_manager,is_spc_trader from eco_private.users where id=${quote(trader.id)}::uuid;`)[0];
    assert.deepEqual(tombstone,{deleted:true,is_active:false,is_admin:false,is_manager:false,is_spc_trader:false});

    checkpoint('audit-and-provider-contact-separation');
    const audits = rows(`select action,before_access,after_access from eco_private.access_audit where actor_id in (${quote(adminId)}::uuid,${quote(newAdmin.id)}::uuid) order by id;`);
    assert.equal(audits.filter(audit => audit.action === 'create-user').length, 3);
    assert.equal(audits.filter(audit => audit.action === 'reset-password').length, 2);
    assert.equal(audits.filter(audit => audit.action === 'delete-user').length, 1);
    check(audits.some(audit => audit.action === 'update-user'), 'Phone update audit is missing.');
    const ledger = rows(`select input,state from eco_private.admin_operations where actor_id in (${quote(adminId)}::uuid,${quote(newAdmin.id)}::uuid);`);
    check(ledger.every(operation => operation.state === 'complete'), 'An account operation remains pending.');
    const auditText = JSON.stringify({ audits, ledger });
    check(Object.values(credentials).every(password => !auditText.includes(password)), 'A credential leaked into an audit record.');
    const providerMember = await service.auth.admin.getUserById(trader.id);
    check(!providerMember.error && !providerMember.data.user?.phone, 'Contact phone was wrongly made an authentication phone.');
    assert.equal(browserErrors.length, 0);
    manifest.completed = true; save();
    console.log(JSON.stringify({ realCloud: true, browserAddUser: true, browserPhoneEdit: true, browserAdminReset: true, browserDeleteUser: true, deleteRetryIdempotent: true, deletedUserAdmissionDenied: true, sameDefaultForNewAdmins: true,
      activeAndInactiveCreate: true, inactiveResetPreservesSuspension: true, oldSessionsRevoked: true,
      oldPasswordDenied: true, newPasswordAccepted: true, createRetryIdempotent: true, resetRetryIdempotent: true,
      duplicateEmailDenied: true, wrongAdministratorPasswordDenied: true, traderDenied: true, crossOriginDenied: true,
      optionalFirstLoginPrompt: true, contactPhoneSeparateFromLogin: true, credentialFreeAudit: true,
      desktopLightAndDarkScreenshots: true, browserErrors: 0, invitationsSent: 0 }));
  } catch (error) {
    verificationError = error; throw error;
  } finally {
    const failedStep = step;
    // Logout and close only contexts made above; do not touch the operator's browser.
    for (const context of contexts) await post(context, 'logout', {}).catch(() => {});
    if (browser) await browser.close().catch(() => {});
    step = 'cleanup-own-fixtures'; save();
    try {
      // Discover by exact reserved emails AND a server-only run/request marker, so a
      // response lost after provider creation is still cleaned up without broad scans.
      const candidates = rows(`select id,email,raw_app_meta_data->>'eco_verification' as verification,
        raw_app_meta_data->>'eco_access_create_request' as create_request from auth.users
        where email in (${manifest.expectedEmails.map(quote).join(',')});`);
      const own = candidates.filter(candidate => candidate.verification === runId || manifest.requestIds.includes(candidate.create_request));
      assert.equal(own.length, candidates.length);
      for (const candidate of own) remember(candidate.id, candidate.email);
      if (own.length) {
        const ids = own.map(candidate => quote(candidate.id) + '::uuid').join(',');
        sql(`begin;
          update eco_private.users set is_active=false where id in (${ids});
          delete from eco_private.admin_operations where actor_id in (${ids}) or target_id in (${ids});
          delete from eco_private.revoked_sessions where user_id in (${ids});
          delete from eco_private.users where id in (${ids});commit;`);
        for (const candidate of own) {
          const removed = await service.auth.admin.deleteUser(candidate.id);
          check(!removed.error, 'Disposable provider identity cleanup failed.');
        }
      }
      // Remove reservations whose provider creation was rejected/lost before an identity existed.
      if (manifest.requestIds.length) sql(`delete from eco_private.admin_operations where request_id in
        (${manifest.requestIds.map(id => quote(id) + '::uuid').join(',')}) and actor_id in
        (${manifest.identities.map(identity => quote(identity.id) + '::uuid').join(',') || 'null'});`);
      assert.equal(rows(`select id from auth.users where email in (${manifest.expectedEmails.map(quote).join(',')});`).length, 0);
      manifest.cleanupComplete = true; manifest.failedStep = verificationError ? failedStep : undefined; save();
      console.log(JSON.stringify({ verificationIdentitiesRemoved: own.length, cleanupComplete: true, recoveryManifest: recoveryPath }));
    } catch (cleanupError) {
      manifest.cleanupComplete = false; manifest.failedStep = verificationError ? failedStep : undefined; save();
      console.error(JSON.stringify({ cleanupComplete: false, recoveryManifest: recoveryPath }));
      if (!verificationError) throw cleanupError;
    } finally {
      // Query text contains fixture contact IDs only; no credentials were persisted.
      privateWrite(join(output, 'query.private.sql'), '-- Verification finished. See recovery.private.json for cleanup status.\n');
      step = failedStep;
    }
  }
}

verify().catch(error => {
  console.error(JSON.stringify({ verificationFailed: true, step, errorType: error?.name ?? 'Error',
    code: typeof error?.code === 'string' ? error.code : undefined,
    commandExitStatus: typeof error?.status === 'number' ? error.status : undefined,
    commandSignal: typeof error?.signal === 'string' ? error.signal : undefined,
    actual: ['number', 'boolean'].includes(typeof error?.actual) ? error.actual : undefined,
    expected: ['number', 'boolean'].includes(typeof error?.expected) ? error.expected : undefined,
    location: error?.stack?.split('\n').find(line => line.includes('verify-admin-access-cloud.mjs:'))?.trim() }));
  process.exitCode = 1;
});
