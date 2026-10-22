import test from 'node:test';
import assert from 'node:assert/strict';
import { advisoryUrl, auditInventory, coverageHash, githubAudit, lockedPairs, nextAdvisoryPage, primaryAudit, queryGithub, runAudit, transportFailure, validateAuditReport, validateGithubPage } from './dependency-audit.mjs';

const pair = (name = 'fixture', version = '1.0.0') => ({ name, version });
const pairs = [pair(), pair('@scope/optional', '2.0.0'), pair('fixture', '2.0.0')];
const lock = `lockfileVersion: '9.0'
importers:
  .:
packages:
  fixture@1.0.0:
    resolution: {integrity: fixture}
  fixture@2.0.0:
    resolution: {integrity: fixture}
  '@scope/optional@2.0.0':
    resolution: {integrity: fixture}
snapshots:
  fixture@1.0.0: {}
  fixture@2.0.0(@scope/optional@2.0.0): {}
  '@scope/optional@2.0.0': {}
`;
const roots = [{ dependencies: { fixture: { version: '1.0.0', dependencies: { fixture: { version: '2.0.0' } } } }, devDependencies: { fixture: { version: '2.0.0' } }, optionalDependencies: { '@scope/optional': { version: '2.0.0' } } }];
const emptyReport = (count = pairs.length) => ({ advisories: {}, metadata: { totalDependencies: count, vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } } });
const timeout = () => ({ code: 23, report: { error: { code: 23, message: 'The operation was aborted due to timeout' } } });
const advisory = (changes = {}) => ({ id: 1, ghsa_id: 'GHSA-2345-6789-cfgh', type: 'reviewed', severity: 'high', withdrawn_at: null,
  url: 'https://api.github.com/advisories/GHSA-2345-6789-cfgh', html_url: 'https://github.com/advisories/GHSA-2345-6789-cfgh',
  vulnerabilities: [{ package: { ecosystem: 'npm', name: 'fixture' }, vulnerable_version_range: '<2.0.0' }], ...changes });
const primaryAdvisory = severity => ({ id: 123, severity, module_name: 'fixture', vulnerable_versions: '<2.0.0', findings: [{ version: '1.0.0', paths: ['fixture'] }] });

test('lockfile inventory includes repeated versions, scopes, dev and optional cross-platform packages', () => {
  const result = auditInventory(lock, roots);
  assert.deepEqual(new Set(result.map(p => `${p.name}@${p.version}`)), new Set(pairs.map(p => `${p.name}@${p.version}`)));
  assert.equal(coverageHash(result), coverageHash([...result].reverse()));
  assert.notEqual(coverageHash(result), coverageHash(result.slice(1)));
});

test('missing, extra, non-registry or unresolved dependencies cannot produce a partial inventory', () => {
  const mutations = [r => { delete r[0].optionalDependencies; }, r => { r[0].dependencies.extra = { version: '1.0.0' }; },
    r => { r[0].dependencies.fixture.version = '^1.0.0'; }, r => { r[0].dependencies.fixture.version = 'file:../local'; },
    r => { r[0].dependencies.fixture.resolved = 'https://private.example/pkg.tgz'; }, r => { r[0].dependencies.fixture.resolved = 'https://user:secret@registry.npmjs.org/pkg.tgz'; },
    r => { r[0].dependencies.fixture = null; }, r => { r[0].dependencies = []; }];
  for (const mutate of mutations) { const r = structuredClone(roots); mutate(r); assert.throws(() => auditInventory(lock, r)); }
  for (const invalid of [lock.replace("'9.0'", "'10.0'"), lock.replace('  fixture@1.0.0: {}', ''), lock.replace('packages:', 'packages: {}'), `${lock}\npackages:\n`, lock.replace('fixture@1.0.0:', 'fixture@file:local:')]) assert.throws(() => lockedPairs(invalid));
  assert.throws(() => auditInventory(lock, []));
});

test('primary clean, low and high results preserve the high/critical failure policy without a fallback', async () => {
  for (const severity of [null, 'info', 'low', 'moderate', 'high', 'critical']) {
    const report = emptyReport();
    if (severity) { report.advisories['123'] = primaryAdvisory(severity); report.metadata.vulnerabilities[severity] = 1; }
    const result = await runAudit({ pairs, primary: async () => ({ code: severity ? 1 : 0, report }), requestGithub: () => { throw Error('Must not fall back'); } });
    assert.equal(result.blocked, ['high', 'critical'].includes(severity));
    assert.equal(result.source, 'npm-bulk-via-pnpm');
  }
});

test('malformed, filtered, contradictory and incomplete primary reports fail rather than fall back', async () => {
  const mutations = [r => { r.metadata.vulnerabilities.high = 1; }, r => { delete r.metadata.totalDependencies; },
    r => { r.metadata.totalDependencies--; }, r => { r.muted = ['ignored']; }, r => { r.metadata.vulnerabilities.high = -1; },
    r => { r.metadata.vulnerabilities.unknown = 1; }, r => { r.advisories['123'] = primaryAdvisory('high'); },
    r => { r.advisories = []; }, r => { r.error = { code: 23 }; }];
  for (const mutate of mutations) {
    const report = emptyReport(); mutate(report);
    await assert.rejects(runAudit({ pairs, primary: async () => ({ code: 1, report }), requestGithub: () => assert.fail('No malformed-report fallback') }));
  }
  const r = emptyReport(); r.advisories['123'] = primaryAdvisory('high'); r.metadata.vulnerabilities.high = 1;
  r.advisories['123'].findings[0].version = '9.0.0'; assert.throws(() => validateAuditReport(r, pairs));
  await assert.rejects(runAudit({ pairs, primary: async () => ({ code: 1, report: emptyReport() }), requestGithub: () => assert.fail() }));
});

test('only explicit transport failures permit an alternate provider', () => {
  assert.equal(transportFailure(timeout()), true);
  for (const code of ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'UND_ERR_HEADERS_TIMEOUT']) assert.equal(transportFailure({ report: { error: { code } } }), true);
  for (const status of [408, 429, 500, 502, 503, 504]) assert.equal(transportFailure({ report: { error: { code: 'ERR_PNPM_AUDIT_BAD_RESPONSE', message: `The audit endpoint (at https://registry.npmjs.org/-/npm/v1/security/advisories/bulk) responded with ${status}: unavailable` } } }), true);
  for (const result of [{}, { report: {} }, { report: { error: { code: 'ERR_PNPM_AUDIT_BAD_RESPONSE', message: 'returned invalid JSON' } } }, { report: { error: { code: '23', message: 'different failure' } } }, { report: { ...emptyReport(), error: timeout().report.error } }]) assert.equal(transportFailure(result), false);
});

test('every locked version is queried once for both reviewed and malware, including duplicate names', async () => {
  const large = Array.from({ length: 128 }, (_, i) => pair(`fixture-${i}`)).concat([pair('same', '1.0.0'), pair('same', '2.0.0')]);
  const seen = { reviewed: [], malware: [] };
  const result = await runAudit({ pairs: large, primary: async () => timeout(), requestGithub: async url => {
    const parsed = new URL(url), type = parsed.searchParams.get('type');
    assert.equal(parsed.origin + parsed.pathname, 'https://api.github.com/advisories'); assert.equal(parsed.searchParams.get('ecosystem'), 'npm');
    assert.equal(parsed.searchParams.get('is_withdrawn'), 'false'); assert.equal(parsed.searchParams.has('severity'), false);
    seen[type].push(...parsed.searchParams.get('affects').split(',')); return { body: [], link: null };
  } });
  assert.equal(result.requests, 6); assert.deepEqual(result.queriesByType, { reviewed: 3, malware: 3 }); assert.equal(result.blocked, false);
  for (const list of Object.values(seen)) assert.deepEqual(list, large.map(p => `${p.name}@${p.version}`));
  assert.equal(result.inventorySha256, coverageHash(large));
});

test('a later missing batch, rejected request, rate limit or malformed response cannot pass', async () => {
  const large = Array.from({ length: 51 }, (_, i) => pair(`fixture-${i}`));
  let calls = 0;
  await assert.rejects(githubAudit(large, async () => { if (++calls === 2) throw Error('rate limited'); return { body: [], link: null }; }));
  assert.equal(calls, 2);
  for (const body of [null, {}, { message: 'rate limited' }, [null], [advisory({ severity: 'unknown' })], [advisory({ withdrawn_at: '2026-01-01' })]]) await assert.rejects(githubAudit(pairs, async () => ({ body, link: null })));
});

test('high, critical and malware advisories stay blocking; lower reviewed advisories remain visible', async () => {
  for (const severity of ['low', 'medium', 'high', 'critical']) {
    const result = await githubAudit(pairs, async url => ({ body: new URL(url).searchParams.get('type') === 'reviewed' ? [advisory({ severity })] : [], link: null }));
    assert.equal(result.blocked, ['high', 'critical'].includes(severity)); assert.equal(result.advisories.length, 1);
  }
  const result = await githubAudit(pairs, async url => ({ body: new URL(url).searchParams.get('type') === 'malware' ? [advisory({ type: 'malware', severity: 'low' })] : [], link: null }));
  assert.equal(result.blocked, true);
});

test('advisory IDs, provenance, requested package names and schema are mandatory', () => {
  for (const mutate of [a => { a.type = 'unreviewed'; }, a => { a.ghsa_id = 'bad'; }, a => { a.url = 'https://other.example'; },
    a => { a.html_url = 'https://other.example'; }, a => { a.vulnerabilities = []; }, a => { delete a.withdrawn_at; },
    a => { a.vulnerabilities[0].package.name = 'unrequested'; }, a => { a.vulnerabilities[0].package.ecosystem = 'pip'; }, a => { delete a.vulnerabilities[0].vulnerable_version_range; }]) {
    const a = advisory(); mutate(a); assert.throws(() => validateGithubPage([a], pairs, 'reviewed'));
  }
  assert.throws(() => validateGithubPage([advisory(), advisory()], pairs, 'reviewed'));
});

test('valid pagination follows exact same query and obtains a later blocking finding', async () => {
  const initial = advisoryUrl(pairs, 'reviewed'), next = `${initial}&after=cursor`;
  const urls = [];
  const result = await githubAudit(pairs, async url => {
    urls.push(url); if (url === initial) return { body: [], link: `<${next}>; rel="next"` };
    return { body: url === next ? [advisory()] : [], link: null };
  });
  assert.equal(result.blocked, true); assert.equal(urls.length, 3);
});

test('pagination rejects foreign origins, altered batches, malformed links, repeated cursors and duplicate findings', async () => {
  const initial = advisoryUrl(pairs, 'reviewed');
  for (const href of ['https://example.com/advisories?after=x', `${initial}&affects=other@1.0.0&after=x`, initial.replace('reviewed', 'malware') + '&after=x', `${initial}&after=x&before=y`, `${initial}&after=x&after=y`, `${initial}&before=x&before=y`, initial]) assert.throws(() => nextAdvisoryPage(`<${href}>; rel="next"`, initial));
  for (const link of ['garbage', `<${initial}&after=x>; rel="next", garbage`, `<${initial}&after=x>; rel="next", <${initial}&after=y>; rel="next"`]) assert.throws(() => nextAdvisoryPage(link, initial));
  await assert.rejects(githubAudit(pairs, async () => ({ body: [], link: `<${initial}&after=x>; rel="next"` })), /PAGINATION_LIMIT/);
  let calls = 0;
  await assert.rejects(githubAudit(pairs, async () => ({ body: [advisory()], link: ++calls === 1 ? `<${initial}&after=x>; rel="next"` : null })), /PAGINATION_DUPLICATE/);
  calls = 0;
  await assert.rejects(githubAudit(pairs, async () => ({ body: [], link: `<${initial}&after=${++calls}>; rel="next"` })), /PAGINATION_LIMIT/);
});

test('cross-batch copies deduplicate but contradictory advisory severity fails closed', async () => {
  const many = Array.from({ length: 49 }, (_, i) => pair(`fixture-${i}`)).concat([pair('fixture', '1.0.0'), pair('fixture', '2.0.0')]);
  let calls = 0;
  const result = await githubAudit(many, async url => ({ body: new URL(url).searchParams.get('type') === 'reviewed' ? [advisory()] : [], link: null }));
  assert.equal(result.counts.high, 1);
  await assert.rejects(githubAudit(many, async url => ({ body: new URL(url).searchParams.get('type') === 'reviewed' ? [advisory({ severity: ++calls === 1 ? 'high' : 'low' })] : [], link: null })), /ADVISORY_CHANGED/);
});

test('network calls are fixed-origin GETs, reject redirects and never place credentials in URLs', async () => {
  const url = advisoryUrl(pairs, 'reviewed'); let calls = 0;
  const result = await queryGithub(url, { token: 'synthetic-token', fetcher: async (target, options) => {
    calls++; assert.equal(target, url); assert.ok(!target.includes('synthetic-token')); assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit'); assert.equal(options.headers.Authorization, 'Bearer synthetic-token');
    return new Response('[]', { status: 200 });
  } });
  assert.deepEqual(result, { body: [], link: null }); assert.equal(calls, 1);
  await assert.rejects(queryGithub('https://api.github.com.evil.example/advisories', { token: 'synthetic-token', fetcher: () => assert.fail('Cannot send credential') }));
  for (const status of [301, 401, 403, 429, 500]) await assert.rejects(queryGithub(url, { fetcher: async () => new Response('{}', { status }) }));
  await assert.rejects(queryGithub(url, { fetcher: async () => new Response('not-json') }));
  await assert.rejects(queryGithub(url, { fetcher: async () => new Response(' '.repeat(5 * 1024 * 1024 + 1)) }), /TOO_LARGE/);
});


test('pnpm mutation settings are rejected and only an explicitly expired own timer enables fallback', async () => {
  let calls = 0;
  for (const value of ['true', 'false', '"override"', '["GHSA-fixture"]']) await assert.rejects(primaryAudit({ execute: async () => ({ stdout: value }), deadlineMs: 100 }), /MUTATING_CONFIG/);
  const execute = async (_command, args, options) => {
    if (args[0] === 'config') return { stdout: '' };
    calls++; assert.ok(!args.some(arg => arg.startsWith('--fix') || arg === '--no-fix'));
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR', stdout: '' })), { once: true }));
  };
  const result = await primaryAudit({ execute, deadlineMs: 5 });
  assert.equal(calls, 1); assert.equal(transportFailure(result), true);
  for (const error of [{ code: null, killed: true, signal: 'SIGTERM', stdout: '' }, { code: 'ABORT_ERR', stdout: '' }, { code: 'ETIMEDOUT', stdout: '{"advisories":' }]) {
    await assert.rejects(primaryAudit({ execute: async (_command, args) => { if (args[0] === 'config') return { stdout: '' }; throw error; }, deadlineMs: 100 }), /RESPONSE_INVALID/);
  }
  await assert.rejects(primaryAudit({ execute: async (_command, args, options) => {
    if (args[0] === 'config') return { stdout: '' };
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject({ code: 'ABORT_ERR', stdout: '{"advisories":' }), { once: true }));
  }, deadlineMs: 5 }), /RESPONSE_INVALID/);
});
