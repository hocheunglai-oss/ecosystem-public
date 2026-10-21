import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { ecoConnections } from '../config/ecoConnections.ts';
import { verifyBackupToken, createGithubJwksLoader, BackupAuthError } from '../server/backup/oidc.ts';
import { handleBackupDownloads, type BackupStorage, BACKUP_DOWNLOAD_LIMITS } from '../server/backup/handler.ts';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'test-signing-key', alg: 'RS256', use: 'sig' };
const pins = ecoConnections.backup, now = 1_800_000_000;
const workflow = `${ecoConnections.githubRepository}/${pins.githubWorkflowPath}@${pins.githubRef}`;
const base = {
  iss: 'https://token.actions.githubusercontent.com', aud: ecoConnections.productionOrigin + pins.storagePath,
  sub: `repo:hocheunglai-oss@${pins.githubOwnerId}/ecosystem-public@${pins.githubRepositoryId}:environment:${pins.githubEnvironment}`,
  repository: ecoConnections.githubRepository, repository_id: pins.githubRepositoryId,
  repository_owner: 'hocheunglai-oss', repository_owner_id: pins.githubOwnerId,
  ref: pins.githubRef, ref_type: 'branch', environment: pins.githubEnvironment, workflow_ref: workflow,
  runner_environment: 'github-hosted', repository_visibility: 'public', event_name: 'schedule',
  sha: 'a'.repeat(40), workflow_sha: 'a'.repeat(40), jti: 'test-job-id', run_id: '1234', run_attempt: '1',
  iat: now - 10, nbf: now - 10, exp: now + 290,
};
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(changes: Record<string, unknown> = {}, header: Record<string, unknown> = {}, key = keys.privateKey) {
  const value = `${encode({ alg: 'RS256', typ: 'JWT', kid: jwk.kid, ...header })}.${encode({ ...base, ...changes })}`;
  return value + '.' + sign('RSA-SHA256', Buffer.from(value), key).toString('base64url');
}
const verifyTest = (value: string) => verifyBackupToken(value, { getKey: async () => jwk, nowSeconds: now });

test('backup OIDC verifies real RSA signatures and both exact documented subjects with mandatory immutable IDs', async () => {
  await verifyTest(token());
  await verifyTest(token({ event_name: 'workflow_dispatch', sub: `repo:${ecoConnections.githubRepository}:environment:${pins.githubEnvironment}` }));
  await verifyTest(token({ job_workflow_ref: workflow, job_workflow_sha: base.sha }));
  await assert.rejects(verifyTest(token({}, {}, otherKeys.privateKey)), BackupAuthError);
  const valid = token();
  await assert.rejects(verifyTest(valid.slice(0, -10) + 'AAAAAAAAAA'), BackupAuthError);
  await assert.rejects(verifyTest(valid + '=') , BackupAuthError);
  await assert.rejects(verifyTest('a'.repeat(17_000)), BackupAuthError);
});

test('GitHub ten-minute not-before backdating is accepted only within its documented bound', async () => {
  // GitHub's example has iat=1632493567, nbf=1632492967 and exp=1632493867:
  // https://docs.github.com/en/actions/concepts/security/openid-connect#understanding-the-oidc-token
  // Shift those intervals to the fixture clock and keep real signature verification.
  for (const backdate of [0, 30, 599, 600]) {
    await verifyTest(token({ iat: now, nbf: now - backdate, exp: now + 300 }));
  }
  for (const backdate of [601, 3600, 86400]) {
    await assert.rejects(verifyTest(token({ iat: now, nbf: now - backdate, exp: now + 300 })), BackupAuthError);
  }
});

test('backdated not-before cannot extend issuance or expiry limits or bypass workflow identity and signature', async () => {
  const backdated = { nbf: base.iat - 600 };
  for (const changes of [
    { ...backdated, exp: now },
    { iat: now - 601, nbf: now - 1201, exp: now + 1 },
    { iat: now + 31, nbf: now - 569, exp: now + 331 },
    { ...backdated, exp: base.iat + 601 },
    { ...backdated, nbf: now + 31 },
    { ...backdated, environment: 'other' },
    { ...backdated, ref: 'refs/heads/other' },
    { ...backdated, repository_id: '999' },
    { ...backdated, aud: `${base.aud}/other` },
  ]) await assert.rejects(verifyTest(token(changes)), BackupAuthError);
  await assert.rejects(verifyTest(token(backdated, {}, otherKeys.privateKey)), BackupAuthError);
});

test('same-name forks, foreign workflows, PRs, other branches and missing/changed authorization claims fail closed', async () => {
  const variants: Record<string, unknown>[] = [
    { repository_id: '999' }, { repository_owner_id: '999' }, { repository_id: Number(pins.githubRepositoryId) },
    { repository: 'attacker/ecosystem-public' }, { repository_owner: 'attacker' },
    { sub: base.sub.replace(pins.githubRepositoryId, '999') }, { sub: `${base.sub}:anything` },
    { sub: `repo:${ecoConnections.githubRepository}:ref:${pins.githubRef}` },
    { ref: 'refs/heads/feature' }, { ref_type: 'tag' }, { workflow_ref: workflow.replace('nightly-backup', 'another-job') },
    { job_workflow_ref: 'attacker/repo/.github/workflows/reuse.yml@refs/heads/main' },
    { job_workflow_sha: 'b'.repeat(40) }, { workflow_sha: 'b'.repeat(40) },
    { event_name: 'pull_request_target' }, { event_name: 'pull_request' }, { event_name: 'push' },
    { environment: 'other' }, { runner_environment: 'self-hosted' }, { repository_visibility: 'private' },
    { head_ref: 'attacker' }, { base_ref: 'main' }, { iss: 'https://attacker.invalid' },
    { aud: `${base.aud}/extra` }, { aud: [base.aud] },
  ];
  for (const field of ['repository_id','repository_owner_id','workflow_ref','workflow_sha','environment','sub','runner_environment','jti','run_id','run_attempt']) variants.push({ [field]: undefined });
  for (const changes of variants) {
    let lookedUp = false;
    await assert.rejects(verifyBackupToken(token(changes), { nowSeconds: now, getKey: async () => { lookedUp = true; return jwk; } }), BackupAuthError);
    assert.equal(lookedUp, false);
  }
});

test('expired, premature, excessively long-lived and malformed JOSE tokens cannot authorize backup access', async () => {
  for (const changes of [{ exp: now }, { iat: now + 31 }, { nbf: now + 31 }, { iat: now - 601 },
    { exp: now + 1000 }, { iat: String(now) }, { nbf: undefined }, { nbf: now - 1000 }]) {
    await assert.rejects(verifyTest(token(changes)), BackupAuthError);
  }
  for (const changes of [{ alg: 'none' }, { alg: 'HS256' }, { typ: 'OTHER' }, { jku: 'https://attacker.invalid/jwks' },
    { jwk }, { crit: ['anything'] }, { kid: '../key' }]) await assert.rejects(verifyTest(token({}, changes)), BackupAuthError);
  for (const changed of [{ ...jwk, use: 'enc' }, { ...jwk, alg: 'HS256' }, { ...jwk, kid: 'other' }, { ...jwk, d: 'private' }]) {
    await assert.rejects(verifyBackupToken(token(), { nowSeconds: now, getKey: async () => changed }), BackupAuthError);
  }
});

test('JWKS is pinned, bounded, cached and rotates without attacker-controlled remote key lookup', async () => {
  let clock = 0, calls = 0;
  const loader = createGithubJwksLoader(async (url, init) => {
    calls++; assert.equal(url, 'https://token.actions.githubusercontent.com/.well-known/jwks');
    assert.equal(init?.redirect, 'error'); assert.ok(init?.signal);
    return Response.json({ keys: calls === 1 ? [jwk] : [{ ...jwk, kid: 'rotated-key' }] });
  }, () => clock);
  assert.equal((await loader(jwk.kid)).kid, jwk.kid); await loader(jwk.kid); assert.equal(calls, 1);
  await assert.rejects(loader('unknown'), BackupAuthError); assert.equal(calls, 1);
  clock = 31_000;
  assert.equal((await loader('rotated-key')).kid, 'rotated-key'); assert.equal(calls, 2);
  for (const response of [Response.json({ keys: [jwk, jwk] }), Response.json({ keys: [] }),
    new Response('x'.repeat(70_000), { headers: { 'Content-Type': 'application/json' } }),
    new Response(null, { status: 302, headers: { location: 'https://attacker.invalid' } })]) {
    const bad = createGithubJwksLoader(async () => response);
    await assert.rejects(verifyBackupToken(token(), { nowSeconds: now, getKey: bad }), BackupAuthError);
  }
});

const id = '11111111-1111-4111-8111-111111111111', supplierId = '22222222-2222-4222-8222-222222222222';
const path = `${supplierId}/${id}/${'a'.repeat(64)}.pdf`;
const item = { id, bucketId: ecoConnections.supplierReportsBucket, path, size: 100, version: 'storage-version-1' };
const supabase = `https://${ecoConnections.supabaseProjectRef}.supabase.co`;
function fixture() {
  const calls: string[] = [];
  const storage: BackupStorage = {
    async info(value) { calls.push(`info:${value}`); return { ...item, name: item.path, contentType: 'application/pdf' }; },
    async sign(value, seconds) { calls.push(`sign:${value}:${seconds}`); return `${supabase}/storage/v1/object/sign/${item.bucketId}/${value}?token=synthetic`; },
  };
  const authenticate = async (value: string) => verifyTest(value);
  return { calls, storage, options: { enabled: true, authenticate, now: () => now * 1000 } };
}
const request = (body: unknown = { objects: [item] }, authorization = token(), extra: Record<string,string> = {}) =>
  new Request(base.aud, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authorization}`, ...extra }, body: JSON.stringify(body) });

test('only an authenticated workflow receives the exact requested immutable PDF and short-lived GET URL', async () => {
  const f = fixture(), response = await handleBackupDownloads(request(undefined, token({ nbf: base.iat - 600 })), f.storage, f.options);
  assert.equal(response.status, 200); assert.match(response.headers.get('cache-control')!, /private, no-store/);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer'); assert.equal(response.headers.getSetCookie().length, 0);
  const result = await response.json();
  assert.equal(result.projectRef, ecoConnections.supabaseProjectRef); assert.equal(result.objects.length, 1);
  assert.equal(result.objects[0].path, path); assert.equal(result.objects[0].sha256, 'a'.repeat(64));
  assert.equal(Date.parse(result.objects[0].expiresAt), (now + 300) * 1000);
  assert.deepEqual(f.calls, [`info:${path}`, `sign:${path}:300`]);
});

test('authorization precedes inventory lookup; disabled, forged and browser requests issue no links', async () => {
  for (const [req, enabled, status] of [[request(), false, 404], [request({}, 'not-a-token'), true, 401],
    [request(undefined, token({ nbf: base.iat - 601 })), true, 401],
    [request(undefined, token({ repository_id: '999' })), true, 401], [request(undefined, token(), { Origin: ecoConnections.productionOrigin }), true, 403],
    [new Request(base.aud, { method: 'DELETE' }), true, 405], [new Request(base.aud + '?bucket=anything', { method: 'POST' }), true, 404]] as const) {
    const f = fixture(); const response = await handleBackupDownloads(req, f.storage, { ...f.options, enabled });
    assert.equal(response.status, status); assert.deepEqual(f.calls, []);
  }
});

test('bucket changes, traversal, oversized files, duplicates and unexpected inventory fields are rejected before lookup', async () => {
  const bad = [{ ...item, bucketId: 'another-bucket' }, { ...item, path: '../private.pdf' },
    { ...item, path: path.replace(supplierId, '%2e%2e') }, { ...item, path: `https://attacker.invalid/${path}` },
    { ...item, path: path.replace('.pdf', '.txt') }, { ...item, size: BACKUP_DOWNLOAD_LIMITS.objectBytes + 1 },
    { ...item, size: 0 }, { ...item, size: 100.1 }, { ...item, id: 'invalid' }, { ...item, version: undefined },
    { ...item, url: 'https://attacker.invalid' }];
  const bodies = [...bad.map(value => ({ objects: [value] })), { objects: [] }, { objects: [item, item] },
    { objects: Array(21).fill(item) }, { objects: [item], bucket: 'anything' }];
  for (const body of bodies) {
    const f = fixture(), response = await handleBackupDownloads(request(body), f.storage, f.options);
    assert.equal(response.status, 400); assert.deepEqual(f.calls, []);
  }
  const f = fixture(); assert.equal((await handleBackupDownloads(request({ objects: ['x'.repeat(25_000)] }), f.storage, f.options)).status, 413);
});

test('changed object identity/version/size/type and a malicious storage response cannot escape the configured target', async () => {
  for (const changed of [{ id: supplierId }, { version: 'changed' }, { size: 101 }, { contentType: 'text/html' },
    { bucketId: 'other' }, { name: 'other.pdf' }]) {
    const f = fixture(), original = f.storage.info;
    f.storage.info = async value => ({ ...await original(value), ...changed });
    assert.equal((await handleBackupDownloads(request(), f.storage, f.options)).status, 409);
    assert.equal(f.calls.length, 1);
  }
  for (const signed of ['https://attacker.invalid/report', `${supabase}/storage/v1/object/sign/other/${path}?token=a`,
    `${supabase}/storage/v1/object/sign/${item.bucketId}/${path}?token=a&download=b`,
    `${supabase}/storage/v1/object/sign/${item.bucketId}/${path}?token=a&token=b`]) {
    const f = fixture(); f.storage.sign = async () => signed;
    const response = await handleBackupDownloads(request(), f.storage, f.options);
    assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /token=|attacker/);
  }
  const f = fixture(); f.storage.info = async () => { throw Error('secret-key provider-body'); };
  const response = await handleBackupDownloads(request(), f.storage, f.options);
  assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /secret-key|provider-body/);
});
