import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// tsx/Vite resolve extensionless TS imports that native deployed Node ESM rejects.
// Compile without bundling, rewrite explicit TS extensions, then use plain Node.
// This test runs in pnpm test and therefore the Application CI job.
test('compiled parser APIs load in native Node, deny anonymous requests and sanitize suggestions without network', { timeout: 60_000 }, async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const output = await mkdtemp(join(tmpdir(), 'eco-parser-runtime-'));
  try {
    execFileSync(join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.server.json', '--noEmit', 'false', '--rewriteRelativeImportExtensions', '--rootDir', root, '--outDir', output], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    await writeFile(join(output, 'package.json'), JSON.stringify({ type: 'module' }));
    await symlink(join(root, 'node_modules'), join(output, 'node_modules'), 'dir');
    const providerCode = await readFile(join(output, 'server/parser/provider.js'), 'utf8');
    const parserCode = await readFile(join(output, 'src/lib/parser.js'), 'utf8');
    assert.doesNotMatch(providerCode + parserCode, /from\s+["'][^"']*\/model(?:\.[jt]s)?["']/,
      'The server parser must not import the application state/model graph at runtime.');
    await writeFile(join(output, 'native-smoke.mjs'), `
import assert from 'node:assert/strict';
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('NETWORK_FORBIDDEN_IN_RUNTIME_SMOKE'); };
const [{default: reports}, {default: fix}, {default: policy}, {default: picOptions}, {default: inbox}, {default: emailSync}, {produceSuggestions}, {emptyParserFields}, {ecoConnections}] = await Promise.all([
  import('./api/parser/reports.js'), import('./api/parser/fix.js'), import('./api/enquiries/test-policy.js'), import('./api/suppliers/pic-options.js'), import('./api/enquiries/inbox.js'), import('./api/enquiries/email-sync.js'),
  import('./server/parser/provider.js'), import('./shared/parserService.js'), import('./config/ecoConnections.js'),
]);
const environment = { ECO_ORIGIN:'https://eco.example.test', ECO_SUPABASE_URL:'https://' + ecoConnections.supabaseProjectRef + '.supabase.co',
  ECO_SUPABASE_PUBLISHABLE_KEY:'synthetic-publishable-key', ECO_SUPABASE_SECRET_KEY:'synthetic-service-key', ECO_RATE_LIMIT_SECRET:'synthetic-runtime-fixture-secret-32-characters' };
for (const [handler, method, url] of [[reports,'GET','/api/parser/reports?dataMode=live'],[fix,'POST','/api/parser/fix'],[policy,'GET','/api/enquiries/test-policy'],[picOptions,'GET','/api/suppliers/pic-options'],[inbox,'GET','/api/enquiries/inbox']]) {
  assert.equal(typeof handler, 'function');
  let body;
  const response = { statusCode:200, setHeader() {}, end(value) { body = value; } };
  await handler({method,url,headers:{'x-eco-data-mode':'live'}, ...(method === 'POST' ? {body:{}} : {})}, response, environment);
  assert.equal(response.statusCode, 401, url);
  assert.equal(JSON.parse(body).message, 'Sign in required.');
}
let emailResponseBody;
const emailResponse = {statusCode:200,setHeader(){},end(value){emailResponseBody=value}};
await emailSync({method:'GET',url:'/api/enquiries/email-sync',headers:{}},emailResponse,environment);
assert.equal(emailResponse.statusCode,401);
assert.equal(JSON.parse(emailResponseBody).error,'unauthorized');
const rawText = 'Vessel: ALPHA\\nETA: 31 April 2026\\nVLSFO: 450 KG';
const result = await produceSuggestions({model:'synthetic-model',extract:async()=>({
  fields:{...emptyParserFields(),vessel:'ALPHA',eta:'31 April 2026',vlsfo:'450'},
  evidence:{...emptyParserFields(),vessel:'ALPHA',eta:'31 April 2026',vlsfo:'450 KG'},warnings:[],
})},{requestId:'10000000-0000-4000-8000-000000000001',rawText,sourceRevision:'native-smoke-v1',sourceHash:'a'.repeat(64),current:emptyParserFields()});
assert.ok(result.suggestions.some(item=>item.field==='vessel' && item.value==='ALPHA'));
assert.ok(!result.suggestions.some(item=>item.field==='eta' || item.field==='vlsfo'));
assert.equal(networkCalls, 0);
console.log('Native parser API smoke passed');
`);
    assert.match(execFileSync(process.execPath, [join(output, 'native-smoke.mjs')], { cwd: output, encoding: 'utf8', stdio: 'pipe' }), /Native parser API smoke passed/);
    // Negative control: reproduce the exact staged failure in the temporary build.
    await writeFile(join(output, 'src/lib/parser.js'), parserCode.replace('../vendor/fcuno/lib/enquiryWorksheetParser.js', '../vendor/fcuno/lib/enquiryWorksheetParser'));
    assert.throws(() => execFileSync(process.execPath, [join(output, 'native-smoke.mjs')], { cwd: output, encoding: 'utf8', stdio: 'pipe' }), /ERR_MODULE_NOT_FOUND/);
  } finally { await rm(output, { recursive: true, force: true }); }
});
