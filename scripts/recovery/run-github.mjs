import { mkdtemp, writeFile, rm, lstat, realpath, readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ecoConnections } from '../../config/ecoConnections.ts';

const reject = () => { throw new Error('Invalid backup startup configuration.'); };
const check = value => { if (!value) reject(); };
const credentials = ['ECO_BACKUP_DB_PASSWORD', 'ECO_DRIVE_CLIENT_ID', 'ECO_DRIVE_CLIENT_SECRET', 'ECO_DRIVE_REFRESH_TOKEN'];
const context = ['GITHUB_ACTIONS', 'GITHUB_REPOSITORY', 'GITHUB_REPOSITORY_ID', 'GITHUB_REPOSITORY_OWNER_ID',
  'GITHUB_REF', 'GITHUB_REF_PROTECTED', 'GITHUB_EVENT_NAME', 'GITHUB_SHA', 'GITHUB_WORKFLOW_REF',
  'GITHUB_WORKFLOW_SHA', 'GITHUB_RUN_ID', 'RUNNER_ENVIRONMENT', 'RUNNER_OS', 'RUNNER_ARCH', 'RUNNER_TEMP'];
const allowedEco = new Set([...credentials, 'ECO_BACKUP_CONFIGURATION', 'ECO_NIGHTLY_BACKUP_ENABLED']);
const workflow = `${ecoConnections.githubRepository}/${ecoConnections.backup.githubWorkflowPath}@${ecoConnections.backup.githubRef}`;

/** Pure preparation: no network, subprocess, credential logging or filesystem access. */
export function prepareGitHubBackup(env) {
  // An authorized manual dispatch verifies the first backup before the schedule is enabled.
  check(env.ECO_NIGHTLY_BACKUP_ENABLED === 'true' || env.GITHUB_EVENT_NAME === 'workflow_dispatch');
  check(env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted'
    && env.RUNNER_OS === 'Linux' && env.RUNNER_ARCH === 'X64'
    && env.GITHUB_REPOSITORY === ecoConnections.githubRepository
    && env.GITHUB_REPOSITORY_ID === ecoConnections.backup.githubRepositoryId
    && env.GITHUB_REPOSITORY_OWNER_ID === ecoConnections.backup.githubOwnerId
    && env.GITHUB_REF === ecoConnections.backup.githubRef && env.GITHUB_REF_PROTECTED === 'true'
    && env.GITHUB_WORKFLOW_REF === workflow && env.GITHUB_WORKFLOW_SHA === env.GITHUB_SHA
    && /^[a-f0-9]{40}$/u.test(env.GITHUB_SHA || '') && /^[1-9][0-9]*$/u.test(env.GITHUB_RUN_ID || '')
    && ['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME));
  check(typeof env.RUNNER_TEMP === 'string' && isAbsolute(env.RUNNER_TEMP)
    && resolve(env.RUNNER_TEMP) === env.RUNNER_TEMP && !/[\r\n\0]/u.test(env.RUNNER_TEMP));
  check(env.RUNNER_DEBUG !== '1' && env.ACTIONS_STEP_DEBUG !== 'true' && env.ACTIONS_RUNNER_DEBUG !== 'true');
  // These options can execute code or replace trust roots before a child starts.
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED',
    'LD_PRELOAD', 'LD_LIBRARY_PATH', 'BASH_ENV', 'ENV', 'AGE_SECRET_KEY', 'AGE_IDENTITY_FILE']) check(!env[key]);
  for (const key of Object.keys(env)) if (key.startsWith('ECO_') && !allowedEco.has(key)) check(!env[key]);
  for (const key of [...credentials, 'ACTIONS_ID_TOKEN_REQUEST_TOKEN'])
    check(typeof env[key] === 'string' && env[key].length > 0 && env[key].length <= 16_384
      && !/[\r\n\0]/u.test(env[key]) && !env[key].includes('AGE-SECRET-KEY-1'));
  let oidc;
  try { oidc = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL); } catch { reject(); }
  check(oidc.protocol === 'https:' && oidc.hostname.endsWith('.actions.githubusercontent.com')
    && !oidc.username && !oidc.password && !oidc.port && !oidc.hash && oidc.href.length < 8_192);
  check(typeof env.ECO_BACKUP_CONFIGURATION === 'string' && env.ECO_BACKUP_CONFIGURATION.length <= 4_096);
  let settings;
  try { settings = JSON.parse(env.ECO_BACKUP_CONFIGURATION); } catch { reject(); }
  const keys = ['databaseHost', 'driveEmail', 'driveFolderId', 'recipient'];
  check(settings && typeof settings === 'object' && !Array.isArray(settings)
    && Object.keys(settings).length === keys.length && keys.every(key => typeof settings[key] === 'string'));
  check(settings.databaseHost === `aws-0-${ecoConnections.supabaseRegion}.pooler.supabase.com`
    && /^[^\s@]{1,64}@[^\s@]{1,189}\.[^\s@]{2,63}$/u.test(settings.driveEmail)
    && /^[A-Za-z0-9_-]{10,200}$/u.test(settings.driveFolderId) && /^age1[0-9a-z]{58}$/u.test(settings.recipient));
  const tools = join(env.RUNNER_TEMP, 'eco-backup-tools');
  const config = {
    schemaVersion: 1, expectedProjectRef: ecoConnections.supabaseProjectRef, expectedSourceRole: 'eco_backup_reader',
    database: { PGHOST: settings.databaseHost, PGPORT: '5432',
      PGUSER: `eco_backup_reader.${ecoConnections.supabaseProjectRef}`, PGDATABASE: 'postgres',
      PGSSLMODE: 'verify-full', PGSSLROOTCERT: join(tools, 'source-ca.crt') },
    pgBin: '/usr/lib/postgresql/17/bin', ageBin: join(tools, 'age/age'), recipient: settings.recipient,
    drive: { expectedEmail: settings.driveEmail, folderId: settings.driveFolderId,
      applicationTag: 'eco-nightly-v1', namePrefix: 'ECO-nightly', propertyPrefix: 'ecoBackup',
      keepNights: 5, maxArchiveBytes: 512 * 1024 ** 2 }, timeoutMs: 40 * 60_000,
  };
  // Do not inherit ambient GitHub tokens, proxy settings, PG* overrides or unrelated secrets.
  const childEnv = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC', TMPDIR: env.RUNNER_TEMP };
  for (const key of [...context, ...credentials]) childEnv[key] = env[key];
  childEnv.ECO_BACKUP_STORAGE_JSON = JSON.stringify({
    oidcRequestUrl: oidc.href, oidcRequestToken: env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  });
  return { config, childEnv };
}

function runChild({ configPath, env }) {
  return new Promise((accept, rejectChild) => {
    // Suppress unexpected worker exceptions as well as normal provider output.
    const child = spawn(process.execPath, [fileURLToPath(new URL('./nightly.mjs', import.meta.url)),
      '--canonical', fileURLToPath(new URL('../../config/ecoConnections.ts', import.meta.url)), '--config', configPath],
    { env, stdio: 'ignore' });
    const interrupt = () => child.kill('SIGTERM');
    const cleanup = () => { process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt); };
    process.once('SIGTERM', interrupt); process.once('SIGINT', interrupt);
    child.once('error', error => { cleanup(); rejectChild(error); });
    child.once('close', code => { cleanup(); accept(code); });
  });
}

export async function runGitHubBackup(env = process.env, { launch = runChild, log = console.log } = {}) {
  let directory, ok = false;
  const previousMask = process.umask(0o077);
  try {
    const { config, childEnv } = prepareGitHubBackup(env);
    const temp = await lstat(env.RUNNER_TEMP);
    check(temp.isDirectory() && !temp.isSymbolicLink() && temp.uid === process.getuid()
      && !(temp.mode & 0o002) && await realpath(env.RUNNER_TEMP) === env.RUNNER_TEMP);
    directory = await mkdtemp(join(env.RUNNER_TEMP, 'eco-backup-config-'));
    const configPath = join(directory, 'config.json');
    await writeFile(configPath, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
    ok = await launch({ configPath, env: childEnv }) === 0;
  } catch { ok = false; }
  finally {
    if (directory) try { await rm(directory, { recursive: true, force: true, maxRetries: 3 }); } catch { ok = false; }
    process.umask(previousMask);
  }
  log(ok ? 'ECO encrypted backup verified; retention completed.'
    : 'ECO nightly backup did not complete. Check the private connection and reviewed configuration.');
  return ok;
}

/** Independent cancellation cleanup; only this runner's own two private prefixes. */
export async function cleanupGitHubBackup(env = process.env, { log = console.log } = {}) {
  let ok = false;
  try {
    check(env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted'
      && env.RUNNER_OS === 'Linux' && env.RUNNER_ARCH === 'X64'
      && env.GITHUB_REPOSITORY === ecoConnections.githubRepository
      && env.GITHUB_REPOSITORY_ID === ecoConnections.backup.githubRepositoryId
      && env.GITHUB_REPOSITORY_OWNER_ID === ecoConnections.backup.githubOwnerId
      && typeof env.RUNNER_TEMP === 'string' && isAbsolute(env.RUNNER_TEMP));
    const parent = await lstat(env.RUNNER_TEMP);
    check(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === process.getuid()
      && !(parent.mode & 0o002) && await realpath(env.RUNNER_TEMP) === env.RUNNER_TEMP);
    const names = (await readdir(env.RUNNER_TEMP)).filter(name => /^(?:eco-backup-config|eco-nightly)-[A-Za-z0-9]{6}$/u.test(name));
    check(names.length <= 32);
    // Inspect all candidates before removing any; preserve an unexpected object.
    for (const name of names) {
      const info = await lstat(join(env.RUNNER_TEMP, name));
      check(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() && !(info.mode & 0o077));
    }
    for (const name of names) await rm(join(env.RUNNER_TEMP, name), { recursive: true, force: true, maxRetries: 3 });
    ok = true;
  } catch { ok = false; }
  log(ok ? 'ECO temporary backup files cleaned.' : 'ECO temporary backup cleanup did not complete.');
  return ok;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  process.exitCode = args.length === 1 && args[0] === '--cleanup' ? (await cleanupGitHubBackup() ? 0 : 1)
    : args.length === 0 ? (await runGitHubBackup() ? 0 : 1) : 1;
}
