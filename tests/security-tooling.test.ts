import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// These build-only scripts also run under plain Node in CI.
// @ts-expect-error JavaScript tooling deliberately has no runtime TypeScript dependency.
import { credentialFindings, inspectBuild } from '../scripts/check-build-security.mjs';
// @ts-expect-error JavaScript tooling deliberately has no runtime TypeScript dependency.
import { inventoryComponents } from '../scripts/dependency-inventory.mjs';

test('bundle credential check catches privileged tokens without returning their values', () => {
  const secret = 'sb_secret_' + 'fixture'.repeat(6);
  const legacy = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.synthetic`;
  const rules = credentialFindings(`const first='${secret}';const second='${legacy}'`);
  assert.deepEqual(rules.sort(), ['legacy-service-role-token', 'supabase-secret-key']);
  assert.ok(!JSON.stringify(rules).includes(secret));
  const anon = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role: 'anon' })).toString('base64url')}.synthetic`;
  assert.deepEqual(credentialFindings(`sb_publishable_fixture ${anon}`), []);
  assert.deepEqual(credentialFindings('private-hmac-value', { ECO_RATE_LIMIT_SECRET: 'private-hmac-value' }), ['environment:ECO_RATE_LIMIT_SECRET']);
});

test('build check blocks leaked files, source maps, symlinks and excessive payloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eco-build-check-'));
  const budgets = { maxJavaScriptGzipBytes: 1000, maxCssGzipBytes: 1000, maxTotalBuildBytes: 10000 };
  try {
    await writeFile(join(root, 'index.html'), '<html></html>');
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'assets', 'app.js'), 'export const okay=true;');
    assert.equal((await inspectBuild(root, budgets)).findings.length, 0);
    await writeFile(join(root, '.env.local'), 'fixture');
    await writeFile(join(root, 'assets', 'app.js.map'), '{}');
    await symlink(join(root, 'index.html'), join(root, 'linked.html'));
    const report = await inspectBuild(root, { ...budgets, maxJavaScriptGzipBytes: 1 });
    assert.deepEqual(new Set(report.findings.map((finding: { rule: string }) => finding.rule)), new Set(['private-build-path', 'public-source-map', 'build-symlink', 'budget:javaScriptGzipBytes']));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('dependency inventory preserves transitive versions, deduplicates and strips local paths', () => {
  const components = inventoryComponents([{ devDependencies: { tool: { version: '1.0.0', dependencies: { shared: { version: '2.0.0' } } } }, dependencies: { '@scope/app': { version: '3.0.0', path: '/private/fixture', dependencies: { shared: { version: '2.0.0' }, old: { version: '1.0.0' } } } } }]);
  assert.equal(components.length, 4);
  assert.equal(components.find((component: { name: string }) => component.name === 'shared').properties[0].value, 'runtime');
  assert.equal(components.find((component: { name: string }) => component.name === '@scope/app').purl, 'pkg:npm/%40scope/app@3.0.0');
  assert.ok(!JSON.stringify(components).includes('/private/fixture'));
  assert.throws(() => inventoryComponents([{ dependencies: { broken: {} } }]), /Unresolved/);
});
