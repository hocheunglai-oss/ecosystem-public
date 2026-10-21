import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, readdir, realpath, symlink, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { prepareGitHubBackup, runGitHubBackup, cleanupGitHubBackup } from '../scripts/recovery/run-github.mjs';
import { ecoConnections as target } from '../config/ecoConnections.ts';

const source = fileURLToPath(new URL('../scripts/recovery/install-tools.sh', import.meta.url));
const settings = { databaseHost: `aws-0-${target.supabaseRegion}.pooler.supabase.com`,
  driveEmail: 'backup-test@example.invalid', driveFolderId: 'synthetic-folder-id', recipient: `age1${'a'.repeat(58)}` };
function environment(directory = '/tmp/eco-synthetic') {
  return { ECO_NIGHTLY_BACKUP_ENABLED: 'true', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', RUNNER_TEMP: directory,
    GITHUB_REPOSITORY: target.githubRepository, GITHUB_REPOSITORY_ID: target.backup.githubRepositoryId,
    GITHUB_REPOSITORY_OWNER_ID: target.backup.githubOwnerId, GITHUB_REF: target.backup.githubRef,
    GITHUB_REF_PROTECTED: 'true', GITHUB_SHA: 'a'.repeat(40), GITHUB_WORKFLOW_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '12345',
    GITHUB_WORKFLOW_REF: `${target.githubRepository}/${target.backup.githubWorkflowPath}@${target.backup.githubRef}`,
    GITHUB_EVENT_NAME: 'schedule', ECO_BACKUP_CONFIGURATION: JSON.stringify(settings),
    ECO_BACKUP_DB_PASSWORD: 'synthetic-database-password', ECO_DRIVE_CLIENT_ID: 'synthetic-client-id',
    ECO_DRIVE_CLIENT_SECRET: 'synthetic-client-secret', ECO_DRIVE_REFRESH_TOKEN: 'synthetic-refresh-token',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.actions.githubusercontent.com/oidc?api-version=2.0',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-oidc-request-token' };
}

async function withDirectory(callback) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'eco-startup-test-')));
  try { await callback(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('schedule/manual prepare fixed TLS, source role and five-night retention without writing credentials into config', () => {
  for (const event of ['schedule', 'workflow_dispatch']) {
    const env = { ...environment(), GITHUB_EVENT_NAME: event };
    const { config, childEnv } = prepareGitHubBackup(env);
    assert.equal(config.expectedSourceRole, 'eco_backup_reader');
    assert.equal(config.database.PGUSER, `eco_backup_reader.${target.supabaseProjectRef}`);
    assert.equal(config.database.PGSSLMODE, 'verify-full');
    assert.equal(config.drive.keepNights, 5);
    assert.equal(config.drive.maxArchiveBytes, 512 * 1024 ** 2);
    assert.equal(childEnv.ECO_BACKUP_DB_PASSWORD, env.ECO_BACKUP_DB_PASSWORD);
    assert.equal(childEnv.TMPDIR, env.RUNNER_TEMP);
    for (const secret of [env.ECO_BACKUP_DB_PASSWORD, env.ECO_DRIVE_CLIENT_SECRET, env.ECO_DRIVE_REFRESH_TOKEN,
      env.ACTIONS_ID_TOKEN_REQUEST_TOKEN]) assert.ok(!JSON.stringify(config).includes(secret));
  }
});

test('unapproved activation, forks, wrong immutable IDs, unprotected refs and unexpected entrypoints fail closed', () => {
  const mutations = { ECO_NIGHTLY_BACKUP_ENABLED: '', GITHUB_ACTIONS: 'false', RUNNER_ENVIRONMENT: 'self-hosted',
    RUNNER_OS: 'Windows', RUNNER_ARCH: 'ARM64', GITHUB_REPOSITORY: 'attacker/ecosystem-public',
    GITHUB_REPOSITORY_ID: '1427776184', GITHUB_REPOSITORY_OWNER_ID: '265701761',
    GITHUB_REF: 'refs/heads/codex/test', GITHUB_REF_PROTECTED: 'false', GITHUB_SHA: 'invalid', GITHUB_RUN_ID: '0',
    GITHUB_WORKFLOW_SHA: 'b'.repeat(40), GITHUB_WORKFLOW_REF: `${target.githubRepository}/other.yml@refs/heads/main`,
    GITHUB_EVENT_NAME: 'pull_request_target', RUNNER_TEMP: '/tmp/../tmp/config' };
  for (const [key, value] of Object.entries(mutations))
    assert.throws(() => prepareGitHubBackup({ ...environment(), [key]: value }), /Invalid backup startup configuration/, key);
});

test('manual verification can run with scheduling off but retains every protected-source restriction', () => {
  const manual = { ...environment(), GITHUB_EVENT_NAME: 'workflow_dispatch', ECO_NIGHTLY_BACKUP_ENABLED: '' };
  assert.equal(prepareGitHubBackup(manual).config.drive.keepNights, 5);
  assert.throws(() => prepareGitHubBackup({ ...manual, GITHUB_EVENT_NAME: 'schedule' }));
  for (const changes of [{ GITHUB_REF_PROTECTED: 'false' }, { GITHUB_REF: 'refs/heads/codex/test' },
    { GITHUB_REPOSITORY_ID: '1427776184' }, { GITHUB_WORKFLOW_REF: 'other/workflow@refs/heads/main' },
    { RUNNER_ENVIRONMENT: 'self-hosted' }, { ECO_BACKUP_DB_PASSWORD: '' }])
    assert.throws(() => prepareGitHubBackup({ ...manual, ...changes }));
});

test('debug, recovery identities, injected executable configuration and alternative credential files are rejected', () => {
  for (const [key, value] of Object.entries({ RUNNER_DEBUG: '1', ACTIONS_STEP_DEBUG: 'true', ACTIONS_RUNNER_DEBUG: 'true',
    NODE_OPTIONS: '--import=other.mjs', NODE_PATH: '/tmp/modules', NODE_EXTRA_CA_CERTS: '/tmp/ca', NODE_TLS_REJECT_UNAUTHORIZED: '0',
    LD_PRELOAD: '/tmp/library', LD_LIBRARY_PATH: '/tmp/lib', BASH_ENV: '/tmp/env', ENV: '/tmp/env',
    AGE_SECRET_KEY: 'AGE-SECRET-KEY-1TEST', AGE_IDENTITY_FILE: '/tmp/identity', ECO_BACKUP_AGE_IDENTITY: 'private',
    ECO_BACKUP_DB_PASSWORD_FILE: '/tmp/password', ECO_BACKUP_STORAGE_JSON: '{}' }))
    assert.throws(() => prepareGitHubBackup({ ...environment(), [key]: value }), undefined, key);
});

test('configuration cannot redirect the database, weaken TLS, alter retention or smuggle a recovery identity', () => {
  for (const config of [null, [], { ...settings, sslMode: 'require' }, { ...settings, keepNights: 1 },
    { ...settings, databaseHost: 'attacker.invalid' }, { ...settings, databaseHost: 'aws-1-ap-southeast-1.pooler.supabase.com' },
    { ...settings, driveEmail: 'bad\n@example.invalid' }, { ...settings, driveFolderId: '../../path' },
    { ...settings, recipient: 'AGE-SECRET-KEY-1TEST' }, { ...settings, recipient: undefined }])
    assert.throws(() => prepareGitHubBackup({ ...environment(), ECO_BACKUP_CONFIGURATION: JSON.stringify(config) }));
  assert.throws(() => prepareGitHubBackup({ ...environment(), ECO_BACKUP_CONFIGURATION: '{invalid' }));
  assert.throws(() => prepareGitHubBackup({ ...environment(), ECO_BACKUP_CONFIGURATION: ' '.repeat(4097) }));
});

test('OIDC exchange and credentials reject remote redirection, missing values and header injection', () => {
  for (const url of ['http://example.actions.githubusercontent.com/oidc', 'https://actions.githubusercontent.com.attacker.invalid/oidc',
    'https://attacker.invalid/oidc', 'https://user@example.actions.githubusercontent.com/oidc',
    'https://example.actions.githubusercontent.com:8443/oidc', 'https://example.actions.githubusercontent.com/oidc#fragment'])
    assert.throws(() => prepareGitHubBackup({ ...environment(), ACTIONS_ID_TOKEN_REQUEST_URL: url }));
  for (const key of ['ECO_BACKUP_DB_PASSWORD', 'ECO_DRIVE_CLIENT_SECRET', 'ECO_DRIVE_REFRESH_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN'])
    for (const value of ['', 'line\r\ninjection', 'AGE-SECRET-KEY-1PRIVATE'])
      assert.throws(() => prepareGitHubBackup({ ...environment(), [key]: value }));
});

test('worker receives only intended credentials, never ambient GitHub tokens/proxy/database overrides', () => {
  const env = { ...environment(), GITHUB_TOKEN: 'not-for-worker', GH_TOKEN: 'not-for-worker',
    ACTIONS_RUNTIME_TOKEN: 'not-for-worker', HTTPS_PROXY: 'https://untrusted.invalid',
    PGSERVICEFILE: '/tmp/other-database', PGHOST: 'attacker.invalid', SUPABASE_SERVICE_ROLE_KEY: 'not-for-worker',
    UNRELATED_ACCOUNT_TOKEN: 'not-for-worker' };
  const { childEnv } = prepareGitHubBackup(env);
  assert.ok(!JSON.stringify(childEnv).includes('not-for-worker'));
  for (const key of ['ECO_BACKUP_CONFIGURATION', 'HTTPS_PROXY', 'PGHOST', 'PGSERVICEFILE',
    'ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN']) assert.equal(childEnv[key], undefined);
  assert.deepEqual(JSON.parse(childEnv.ECO_BACKUP_STORAGE_JSON), {
    oidcRequestUrl: env.ACTIONS_ID_TOKEN_REQUEST_URL, oidcRequestToken: env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  });
});

test('private runtime config is cleaned after success, child failure or an exception; logs remain generic', async () => {
  await withDirectory(async directory => {
    for (const outcome of [0, 1, 'throw']) {
      const logs = []; let launched = 0;
      const env = environment(directory);
      const ok = await runGitHubBackup(env, { log: message => logs.push(message), async launch({ configPath, env: childEnv }) {
        launched++;
        assert.equal((await stat(configPath)).mode & 0o777, 0o600);
        assert.equal((await stat(dirname(configPath))).mode & 0o777, 0o700);
        assert.ok(!(await readFile(configPath, 'utf8')).includes(env.ECO_BACKUP_DB_PASSWORD));
        assert.equal(childEnv.ECO_BACKUP_DB_PASSWORD, env.ECO_BACKUP_DB_PASSWORD);
        if (outcome === 'throw') throw new Error(`Provider leaked ${env.ECO_DRIVE_REFRESH_TOKEN}`);
        return outcome;
      } });
      assert.equal(ok, outcome === 0); assert.equal(launched, 1);
      assert.deepEqual(await readdir(directory), []);
      assert.equal(logs.length, 1);
      assert.ok(!logs[0].includes('synthetic-'));
    }
  });
});

test('invalid context and symlinked runner directory cannot create config or start the worker', async () => {
  await withDirectory(async directory => {
    const link = join(directory, 'link'); await symlink(directory, link, 'dir');
    for (const env of [{ ...environment(directory), ECO_NIGHTLY_BACKUP_ENABLED: '' }, environment(link)]) {
      let launched = false;
      assert.equal(await runGitHubBackup(env, { launch: async () => { launched = true; return 0; }, log() {} }), false);
      assert.equal(launched, false);
      assert.deepEqual(await readdir(directory), ['link']);
    }
  });
});

test('always cleanup removes only owned private backup prefixes and never follows nested links', async () => {
  await withDirectory(async directory => {
    const retained = join(directory, 'other-job'); await mkdir(retained);
    await writeFile(join(retained, 'keep.txt'), 'synthetic retained content');
    const config = await mkdtemp(join(directory, 'eco-backup-config-'));
    const capture = await mkdtemp(join(directory, 'eco-nightly-'));
    await writeFile(join(config, 'config.json'), 'synthetic runtime config');
    await symlink(retained, join(capture, 'nested-link'), 'dir');
    assert.equal(await cleanupGitHubBackup(environment(directory), { log() {} }), true);
    assert.deepEqual(await readdir(directory), ['other-job']);
    assert.equal(await readFile(join(retained, 'keep.txt'), 'utf8'), 'synthetic retained content');
  });
});

test('always cleanup refuses symlink candidates, broad permissions and wrong repository identities', async () => {
  await withDirectory(async directory => {
    const retained = join(directory, 'retained'); await mkdir(retained);
    const link = join(directory, 'eco-nightly-Abc123'); await symlink(retained, link, 'dir');
    assert.equal(await cleanupGitHubBackup(environment(directory), { log() {} }), false);
    assert.ok((await stat(retained)).isDirectory());
    await rm(link);
    const candidate = join(directory, 'eco-nightly-Def456'); await mkdir(candidate, { mode: 0o755 });
    assert.equal(await cleanupGitHubBackup(environment(directory), { log() {} }), false);
    assert.ok((await stat(candidate)).isDirectory());
    assert.equal(await cleanupGitHubBackup({ ...environment(directory), GITHUB_REPOSITORY_ID: '1' }, { log() {} }), false);
  });
});

function installerFunction(name, { input = '', env = {} } = {}) {
  return spawnSync('/bin/bash', ['-c', 'source "$1"; "$2"', 'offline-test', source, name], {
    encoding: 'utf8', input, env: { PATH: '/usr/bin:/bin', ...env }, timeout: 5_000,
  });
}
const pub = 'pub:-:4096:1:7FCC7D46ACCC4CF8:1328641284:::-:::scSC:::\n';
const fpr = 'fpr:::::::::B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8:\n';

test('installer verifies one exact PGDG primary key and rejects appended, revoked or incomplete keys', () => {
  const correct = pub + fpr;
  assert.equal(installerFunction('verify_pgdg_key_listing', { input: correct }).status, 0);
  assert.equal(installerFunction('verify_pgdg_key_listing', {
    input: correct + 'sub:-:4096:1:1234::::::e:\nfpr:::::::::UNRELATEDSUBKEY:\n',
  }).status, 0);
  for (const input of ['', pub, fpr, correct + correct, correct + pub,
    correct.replace('B97B0A', 'C97B0A'), correct.replace('pub:-', 'pub:r'), correct.replace('pub:-', 'pub:e')])
    assert.notEqual(installerFunction('verify_pgdg_key_listing', { input }).status, 0);
});

test('installer rejects source/OIDC credentials before any download or package command', () => {
  const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux',
    RUNNER_ARCH: 'X64', RUNNER_TEMP: '/tmp/never-contact-production' };
  assert.equal(installerFunction('verify_install_context', { env }).status, 0);
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'false', RUNNER_ENVIRONMENT: 'self-hosted',
    RUNNER_ARCH: 'ARM64', RUNNER_TEMP: 'relative', ECO_BACKUP_DB_PASSWORD: 'synthetic-password',
    ECO_DRIVE_REFRESH_TOKEN: 'synthetic-token', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic-token',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid', PGPASSWORD: 'synthetic-password', AGE_SECRET_KEY: 'synthetic-key' })) {
    const result = installerFunction('verify_install_context', { env: { ...env, [key]: value } });
    assert.notEqual(result.status, 0, key);
    assert.ok(!result.stdout.includes('synthetic-') && !result.stderr.includes('synthetic-'));
  }
});
