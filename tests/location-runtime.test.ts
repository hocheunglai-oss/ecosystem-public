import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Vite/tsx resolve extensionless imports that a deployed Node ESM function cannot.
// Match Vercel's unbundled emit and explicit-extension rewriting, then use plain Node.
test('location API entrypoints load natively and reject anonymous reads/writes without browser or network access', { timeout: 90_000 }, async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const output = await mkdtemp(join(tmpdir(), 'eco-location-runtime-'));
  const nativeEnvironment = { PATH: process.env.PATH ?? '', LANG: 'C', TZ: 'UTC' };
  try {
    await writeFile(join(output, 'package.json'), JSON.stringify({ type: 'module' }));
    await symlink(join(root, 'node_modules'), join(output, 'node_modules'), 'dir');
    const smokePath = join(output, 'native-location-smoke.mjs');
    await writeFile(smokePath, `
import assert from 'node:assert/strict';
const [base, extension] = process.argv.slice(2);
assert.ok(['ts', 'js'].includes(extension));
assert.equal(process.env.NODE_OPTIONS, undefined, 'A custom loader must not mask missing imports');
const browserGlobals = ['window', 'document', 'localStorage', 'sessionStorage'];
for (const name of browserGlobals) assert.equal(typeof globalThis[name], 'undefined', name);
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('NETWORK_FORBIDDEN_IN_RUNTIME_SMOKE'); };
const load = path => import(new URL(path + '.' + extension, base).href);
const names = ['list', 'history', 'activity', 'activity-ids', 'contribution', 'contributions', 'migrate', 'mutate'];
const modules = await Promise.all(names.map(name => load('api/location-knowledge/' + name)));
const { initialLocationSnapshot } = await load('src/lib/sharedLocationKnowledge');
const { ecoConnections } = await load('config/ecoConnections');
const origin = 'https://eco.example.test';
const environment = {
  ECO_ORIGIN: origin,
  ECO_SUPABASE_URL: 'https://' + ecoConnections.supabaseProjectRef + '.supabase.co',
  ECO_SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable-key',
  ECO_SUPABASE_SECRET_KEY: 'synthetic-service-key',
  ECO_RATE_LIMIT_SECRET: 'synthetic-runtime-fixture-secret-32-characters',
};
const actor = '10000000-0000-4000-8000-000000000001';
const queries = {
  history: new URLSearchParams({ targets: JSON.stringify([{ kind: 'country', id: 'Singapore' }]) }),
  activity: new URLSearchParams({ actors: JSON.stringify([actor]), period: 'all' }),
  'activity-ids': new URLSearchParams({ entryId: 'synthetic-entry', actor, period: 'all' }),
  contribution: new URLSearchParams({ id: 'synthetic-contribution' }),
  contributions: new URLSearchParams({ status: 'pending' }),
};
for (const [index, name] of names.entries()) {
  const handler = modules[index].default;
  assert.equal(typeof handler, 'function', name);
  const write = name === 'mutate' || name === 'migrate';
  const body = { requestId: actor, revision: 0, dataMode: 'live', ...(name === 'migrate'
    ? { snapshot: initialLocationSnapshot() }
    : { action: { type: 'add-location', kind: 'country', name: 'Synthetic country' } }) };
  const headers = { origin, 'x-eco-request': '1', 'x-eco-data-mode': 'live', 'content-type': 'application/json' };
  const url = '/api/location-knowledge/' + name + (queries[name] ? '?' + queries[name] : '');
  const responseHeaders = new Map();
  let responseBody;
  const response = { statusCode: 200, setHeader(key, value) { responseHeaders.set(key.toLowerCase(), value); }, end(value) { responseBody = value; } };
  await handler({ method: write ? 'POST' : 'GET', url, headers, ...(write ? { body } : {}) }, response, environment);
  assert.equal(response.statusCode, 401, name);
  assert.equal(JSON.parse(responseBody).message, 'Sign in required.', name);
  assert.match(responseHeaders.get('cache-control'), /private.*no-store/, name);
  assert.equal(responseHeaders.get('x-content-type-options'), 'nosniff', name);
}
for (const name of browserGlobals) assert.equal(typeof globalThis[name], 'undefined', name);
assert.equal(networkCalls, 0);
console.log('Native location APIs: eight anonymous routes denied without network or browser globals');
`);
    const smoke = (directory: string, extension: 'ts' | 'js') => execFileSync(process.execPath,
      [smokePath, pathToFileURL(directory.endsWith('/') ? directory : directory + '/').href, extension],
      { cwd: directory, env: nativeEnvironment, encoding: 'utf8', stdio: 'pipe', timeout: 20_000 });
    assert.match(smoke(root, 'ts'), /eight anonymous routes denied/);
    execFileSync(join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.server.json', '--noEmit', 'false', '--rewriteRelativeImportExtensions', '--rootDir', root, '--outDir', output],
      { cwd: root, env: nativeEnvironment, encoding: 'utf8', stdio: 'pipe', timeout: 60_000 });
    assert.match(smoke(output, 'js'), /eight anonymous routes denied/);
    // Negative control recreates the hosted initialization crash in this disposable build.
    const sharedModule = join(output, 'src/lib/sharedLocationKnowledge.js');
    const compiled = await readFile(sharedModule, 'utf8');
    assert.match(compiled, /from\s+['"]\.\/model\.js['"]/);
    await writeFile(sharedModule, compiled.replace(/(from\s+['"]\.\/model)\.js(['"])/, '$1$2'));
    assert.throws(() => smoke(output, 'js'), /ERR_MODULE_NOT_FOUND/);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
