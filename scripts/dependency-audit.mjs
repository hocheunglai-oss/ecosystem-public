import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const ADVISORY_ENDPOINT = 'https://api.github.com/advisories';
const REGISTRY = 'https://registry.npmjs.org/';
const GROUPS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
const NAME = /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ensure = (condition, code) => { if (!condition) throw new Error(code); };
const pairId = ({ name, version }) => `${name}@${version}`;
const validPair = ({ name, version }) => typeof name === 'string' && NAME.test(name) && name.length <= 214 && typeof version === 'string' && VERSION.test(version);
const sortedIds = values => [...values].sort().join('\n');
export const coverageHash = pairs => createHash('sha256').update(sortedIds(pairs.map(pairId))).digest('hex');

// Read only the package/snapshot keys in pnpm's v9 lock format. Do not silently
// guess at a new format, local dependencies, custom registries or unresolved versions.
export function lockedPairs(lockText) {
  ensure(typeof lockText === 'string' && /^lockfileVersion: ['"]9\.0['"]$/m.test(lockText), 'AUDIT_LOCK_FORMAT_UNSUPPORTED');
  const sections = new Map(); let section;
  for (const line of lockText.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      section = /^(packages|snapshots):$/.exec(line)?.[1];
      if (section) { ensure(!sections.has(section), 'AUDIT_LOCK_DUPLICATE_SECTION'); sections.set(section, new Map()); }
      continue;
    }
    if (!section || !/^  \S/.test(line)) continue;
    const match = /^  (.+):(?: \{\})?$/.exec(line);
    ensure(match, 'AUDIT_LOCK_KEY_INVALID');
    let key = match[1];
    if (key.startsWith("'")) { ensure(key.endsWith("'") && !key.slice(1, -1).includes("'"), 'AUDIT_LOCK_KEY_INVALID'); key = key.slice(1, -1); }
    else if (key.startsWith('"')) { try { key = JSON.parse(key); } catch { throw new Error('AUDIT_LOCK_KEY_INVALID'); } }
    const plain = key.split('(')[0], at = plain.lastIndexOf('@');
    const pair = { name: plain.slice(0, at), version: plain.slice(at + 1) };
    ensure(at > 0 && validPair(pair), 'AUDIT_LOCK_PACKAGE_UNSUPPORTED');
    ensure(!sections.get(section).has(key), 'AUDIT_LOCK_DUPLICATE_KEY');
    sections.get(section).set(key, pair);
  }
  ensure(sections.has('packages') && sections.has('snapshots') && sections.get('packages').size > 0, 'AUDIT_LOCK_INCOMPLETE');
  const packages = new Map([...sections.get('packages').values()].map(pair => [pairId(pair), pair]));
  const snapshots = new Set([...sections.get('snapshots').values()].map(pairId));
  ensure(sortedIds(packages.keys()) === sortedIds(snapshots), 'AUDIT_LOCK_SNAPSHOT_MISMATCH');
  return [...packages.values()].sort((a, b) => pairId(a).localeCompare(pairId(b)));
}

export function auditInventory(lockText, roots) {
  const locked = lockedPairs(lockText), observed = new Map(); let nodes = 0;
  ensure(Array.isArray(roots) && roots.length > 0, 'AUDIT_TREE_INVALID');
  const visit = (node, depth = 0) => {
    ensure(object(node) && depth < 250 && ++nodes < 100000, 'AUDIT_TREE_INVALID');
    for (const group of GROUPS) {
      if (node[group] === undefined) continue;
      ensure(object(node[group]), 'AUDIT_TREE_INVALID');
      for (const [key, detail] of Object.entries(node[group])) {
        ensure(object(detail), 'AUDIT_TREE_INVALID');
        const pair = { name: detail.from ?? key, version: detail.version };
        ensure(validPair(pair), 'AUDIT_TREE_PACKAGE_UNSUPPORTED');
        if (detail.resolved !== undefined) {
          let url; try { url = new URL(detail.resolved); } catch { throw new Error('AUDIT_TREE_REGISTRY_UNSUPPORTED'); }
          ensure(url.origin === REGISTRY.slice(0, -1) && !url.username && !url.password, 'AUDIT_TREE_REGISTRY_UNSUPPORTED');
        }
        observed.set(pairId(pair), pair); visit(detail, depth + 1);
      }
    }
  };
  for (const root of roots) visit(root);
  ensure(sortedIds(observed.keys()) === sortedIds(locked.map(pairId)), 'AUDIT_TREE_COVERAGE_MISMATCH');
  return locked;
}

export function validateAuditReport(report, pairs) {
  ensure(object(report) && object(report.advisories) && object(report.metadata) && object(report.metadata.vulnerabilities), 'AUDIT_REPORT_INVALID');
  ensure(!report.error && (!report.muted || Array.isArray(report.muted) && report.muted.length === 0), 'AUDIT_REPORT_FILTERED');
  ensure(report.metadata.totalDependencies === pairs.length, 'AUDIT_REPORT_COVERAGE_MISMATCH');
  const counts = Object.fromEntries(SEVERITIES.map(severity => [severity, 0]));
  const expected = new Set(pairs.map(pairId));
  const advisories = [];
  for (const [key, advisory] of Object.entries(report.advisories)) {
    ensure(object(advisory) && String(advisory.id) === key && /^\d+$/.test(key) && SEVERITIES.includes(advisory.severity)
      && typeof advisory.module_name === 'string' && typeof advisory.vulnerable_versions === 'string' && advisory.vulnerable_versions.length > 0
      && Array.isArray(advisory.findings) && advisory.findings.length > 0, 'AUDIT_ADVISORY_INVALID');
    ensure(advisory.findings.every(finding => object(finding) && expected.has(`${advisory.module_name}@${finding.version}`)
      && Array.isArray(finding.paths) && finding.paths.length > 0 && finding.paths.every(path => typeof path === 'string' && path.length > 0)), 'AUDIT_ADVISORY_COVERAGE_INVALID');
    counts[advisory.severity]++;
    advisories.push({ id: advisory.id, name: advisory.module_name, severity: advisory.severity });
  }
  for (const severity of SEVERITIES) ensure(Number.isSafeInteger(report.metadata.vulnerabilities[severity])
    && report.metadata.vulnerabilities[severity] === counts[severity], 'AUDIT_REPORT_COUNTS_MISMATCH');
  ensure(Object.keys(report.metadata.vulnerabilities).every(key => SEVERITIES.includes(key)), 'AUDIT_REPORT_COUNTS_MISMATCH');
  return { counts, advisories, blocked: counts.high > 0 || counts.critical > 0 };
}

export function transportFailure(result) {
  // A real report, including a positive or malformed advisory report, never falls back.
  if (object(result.report) && ('advisories' in result.report || 'metadata' in result.report)) return false;
  const error = result.report?.error;
  if (!object(error)) return false;
  const code = String(error.code ?? ''), message = String(error.message ?? '');
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code)) return true;
  if (code === '23' && message === 'The operation was aborted due to timeout') return true;
  return code === 'ERR_PNPM_AUDIT_BAD_RESPONSE' && /^The audit endpoint \(at https:\/\/registry\.npmjs\.org\/-\/npm\/v1\/security\/advisories\/bulk\) responded with (?:408|429|500|502|503|504):/.test(message);
}

export function advisoryUrl(pairs, type) {
  ensure(Array.isArray(pairs) && pairs.length > 0 && pairs.length <= 50 && pairs.every(validPair)
    && new Set(pairs.map(pairId)).size === pairs.length && ['reviewed', 'malware'].includes(type), 'AUDIT_BATCH_INVALID');
  const url = new URL(ADVISORY_ENDPOINT);
  url.search = new URLSearchParams({ ecosystem: 'npm', type, affects: pairs.map(pairId).join(','), per_page: '100', is_withdrawn: 'false' });
  return url.href;
}

export function nextAdvisoryPage(link, initial) {
  if (link === null || link === '') return null;
  ensure(typeof link === 'string', 'AUDIT_PAGINATION_INVALID');
  const matches = [...link.matchAll(/<([^>]+)>;\s*rel="(next|prev|first|last)"/g)];
  ensure(matches.length > 0 && matches.map(match => match[0]).join(', ').replace(/\s/g, '') === link.replace(/\s/g, ''), 'AUDIT_PAGINATION_INVALID');
  ensure(new Set(matches.map(match => match[2])).size === matches.length, 'AUDIT_PAGINATION_AMBIGUOUS');
  let next = null;
  const expected = new URL(initial);
  for (const [, href, rel] of matches) {
    const url = new URL(href);
    ensure(url.origin === expected.origin && url.pathname === expected.pathname && !url.username && !url.password && !url.hash, 'AUDIT_PAGINATION_TARGET');
    const cursor = url.searchParams.get('after') ?? url.searchParams.get('before');
    const params = new URLSearchParams(url.search);
    ensure(!(params.has('before') && params.has('after')) && params.getAll('before').length <= 1 && params.getAll('after').length <= 1, 'AUDIT_PAGINATION_INVALID');
    params.delete('before'); params.delete('after');
    ensure([...params].length === [...expected.searchParams].length && [...expected.searchParams].every(([key, value]) => params.get(key) === value)
      && [...params.keys()].every(key => params.getAll(key).length === 1), 'AUDIT_PAGINATION_QUERY_CHANGED');
    if (rel === 'next') { ensure(typeof cursor === 'string' && cursor.length > 0 && cursor.length <= 2048, 'AUDIT_PAGINATION_INVALID'); next = url.href; }
  }
  return next;
}

export function validateGithubPage(body, pairs, type) {
  ensure(Array.isArray(body) && body.length <= 100, 'AUDIT_GITHUB_RESPONSE_INVALID');
  const names = new Set(pairs.map(pair => pair.name)), ids = new Set();
  return body.map(advisory => {
    ensure(object(advisory) && /^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/.test(advisory.ghsa_id)
      && !ids.has(advisory.ghsa_id) && advisory.type === type && advisory.withdrawn_at === null
      && ['low', 'medium', 'high', 'critical'].includes(advisory.severity), 'AUDIT_GITHUB_ADVISORY_INVALID');
    ids.add(advisory.ghsa_id);
    ensure(advisory.url === `${ADVISORY_ENDPOINT}/${advisory.ghsa_id}` && advisory.html_url === `https://github.com/advisories/${advisory.ghsa_id}`
      && Array.isArray(advisory.vulnerabilities) && advisory.vulnerabilities.length > 0, 'AUDIT_GITHUB_ADVISORY_INVALID');
    ensure(advisory.vulnerabilities.every(vulnerability => object(vulnerability) && object(vulnerability.package)
      && typeof vulnerability.package.ecosystem === 'string' && typeof vulnerability.package.name === 'string'
      && typeof vulnerability.vulnerable_version_range === 'string' && vulnerability.vulnerable_version_range.length > 0), 'AUDIT_GITHUB_ADVISORY_INVALID');
    const matchedNames = advisory.vulnerabilities.filter(vulnerability => vulnerability.package.ecosystem === 'npm' && names.has(vulnerability.package.name)).map(vulnerability => vulnerability.package.name);
    ensure(matchedNames.length > 0, 'AUDIT_GITHUB_UNREQUESTED_ADVISORY');
    return { id: advisory.ghsa_id, type, severity: advisory.severity === 'medium' ? 'moderate' : advisory.severity };
  });
}

export async function githubAudit(pairs, requestGithub) {
  ensure(Array.isArray(pairs) && pairs.length > 0 && pairs.length <= 10000 && pairs.every(validPair)
    && new Set(pairs.map(pairId)).size === pairs.length, 'AUDIT_INVENTORY_INVALID');
  const all = new Map(), queriesByType = { reviewed: 0, malware: 0 }; let requests = 0;
  for (const type of ['reviewed', 'malware']) {
    const covered = new Set();
    for (let offset = 0; offset < pairs.length; offset += 50) {
      const batch = pairs.slice(offset, offset + 50), initial = advisoryUrl(batch, type), seenUrls = new Set(), seenIds = new Set();
      let url = initial, pages = 0;
      do {
        ensure(++pages <= 10 && ++requests <= 200 && !seenUrls.has(url), 'AUDIT_PAGINATION_LIMIT'); seenUrls.add(url);
        queriesByType[type]++;
        const { body, link } = await requestGithub(url);
        const findings = validateGithubPage(body, batch, type);
        const next = nextAdvisoryPage(link, initial);
        ensure(body.length < 100 || next !== null, 'AUDIT_PAGINATION_INCOMPLETE');
        for (const finding of findings) {
          ensure(!seenIds.has(finding.id), 'AUDIT_PAGINATION_DUPLICATE'); seenIds.add(finding.id);
          const previous = all.get(finding.id);
          ensure(!previous || previous.type === finding.type && previous.severity === finding.severity, 'AUDIT_ADVISORY_CHANGED');
          all.set(finding.id, finding);
        }
        url = next;
      } while (url !== null);
      for (const pair of batch) { ensure(!covered.has(pairId(pair)), 'AUDIT_BATCH_DUPLICATE'); covered.add(pairId(pair)); }
    }
    ensure(covered.size === pairs.length, 'AUDIT_FALLBACK_INCOMPLETE');
  }
  const advisories = [...all.values()];
  const counts = Object.fromEntries(SEVERITIES.map(severity => [severity, advisories.filter(advisory => advisory.severity === severity).length]));
  return { source: 'github-reviewed-and-malware', packageVersions: pairs.length, inventorySha256: coverageHash(pairs), queriesByType, requests, counts, advisories,
    blocked: counts.high > 0 || counts.critical > 0 || advisories.some(advisory => advisory.type === 'malware') };
}

export async function runAudit({ pairs, primary, requestGithub }) {
  const initial = await primary();
  if (object(initial.report) && ('advisories' in initial.report || 'metadata' in initial.report)) {
    const verified = validateAuditReport(initial.report, pairs);
    ensure(initial.code === (verified.advisories.length > 0 ? 1 : 0), 'AUDIT_PRIMARY_EXIT_MISMATCH');
    return { source: 'npm-bulk-via-pnpm', ...verified, packageVersions: pairs.length, inventorySha256: coverageHash(pairs) };
  }
  ensure(initial.code !== 0 && transportFailure(initial), 'AUDIT_PRIMARY_UNVERIFIED');
  return githubAudit(pairs, requestGithub);
}

export async function queryGithub(url, { fetcher = fetch, token } = {}) {
  const parsed = new URL(url);
  ensure(parsed.origin === 'https://api.github.com' && parsed.pathname === '/advisories' && !parsed.username && !parsed.password && !parsed.hash, 'AUDIT_GITHUB_TARGET_INVALID');
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetcher(url, { method: 'GET', redirect: 'error', credentials: 'omit', headers, signal: AbortSignal.timeout(20000) });
  ensure(response.status === 200, 'AUDIT_GITHUB_UNAVAILABLE');
  ensure(response.body && !response.redirected && (!response.url || response.url === url), 'AUDIT_GITHUB_RESPONSE_INVALID');
  const reader = response.body.getReader(), chunks = []; let bytes = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length;
    if (bytes > 5 * 1024 * 1024) { await reader.cancel(); throw new Error('AUDIT_GITHUB_RESPONSE_TOO_LARGE'); } chunks.push(Buffer.from(value)); }
  let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('AUDIT_GITHUB_RESPONSE_INVALID'); }
  return { body, link: response.headers.get('link') };
}

export async function primaryAudit({ execute = exec, deadlineMs = 45000 } = {}) {
  // pnpm 11's String|Boolean --fix option turns --no-fix into the string
  // "false". Refuse any inherited mutation setting and omit that CLI option.
  for (const key of ['fix', 'ignore']) {
    const { stdout } = await execute('pnpm', ['config', 'get', key, '--json'], { timeout: 10000, maxBuffer: 1024 });
    ensure(['', 'undefined'].includes(stdout.trim()), 'AUDIT_MUTATING_CONFIG');
  }
  const controller = new AbortController(); let expired = false, result;
  const timer = setTimeout(() => { expired = true; controller.abort(); }, deadlineMs);
  try { result = { ...(await execute('pnpm', ['audit', '--json', '--audit-level', 'info', '--no-interactive', '--no-ignore-unfixable', '--no-ignore-registry-errors', '--registry', REGISTRY, '--fetch-retries', '0', '--fetch-timeout', '20000'],
    { signal: controller.signal, maxBuffer: 8 * 1024 * 1024 })), code: 0 }; }
  catch (error) { result = error; }
  finally { clearTimeout(timer); }
  let report; try { report = JSON.parse(result.stdout); } catch {
    // Only our own deadline is transport unavailability. A killed child,
    // partial report or other malformed output must never become a pass.
    if (expired && result.code === 'ABORT_ERR' && !String(result.stdout ?? '').trim()) return { code: 1, report: { error: { code: 'ETIMEDOUT' } } };
    throw new Error('AUDIT_PRIMARY_RESPONSE_INVALID');
  }
  return { code: result.code, report };
}

export async function main() {
  await rm('output/security/dependency-audit.json', { force: true });
  const lock = await readFile('pnpm-lock.yaml', 'utf8');
  const { stdout } = await exec('pnpm', ['list', '--recursive', '--lockfile-only', '--json', '--depth', 'Infinity'], { timeout: 45000, maxBuffer: 32 * 1024 * 1024 });
  const pairs = auditInventory(lock, JSON.parse(stdout));
  const result = await runAudit({ pairs, primary: primaryAudit, requestGithub: url => queryGithub(url, { token: process.env.GITHUB_TOKEN }) });
  ensure(await readFile('pnpm-lock.yaml', 'utf8') === lock, 'AUDIT_LOCK_CHANGED');
  const evidence = { ...result, lockfileSha256: createHash('sha256').update(lock).digest('hex'), checkedAt: new Date().toISOString() };
  await mkdir('output/security', { recursive: true, mode: 0o700 });
  await writeFile('output/security/dependency-audit.json', JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ event: 'dependency-audit', checkedAt: evidence.checkedAt, lockfileSha256: evidence.lockfileSha256, inventorySha256: evidence.inventorySha256, source: result.source, packageVersions: pairs.length, queriesByType: result.queriesByType, requests: result.requests, blocked: result.blocked, counts: result.counts, advisoryCount: result.advisories.length, advisoryIds: result.advisories.slice(0, 20).map(advisory => advisory.id) }));
  console.log(`Audited ${pairs.length} locked package versions using ${result.source}: ${result.counts.high} high, ${result.counts.critical} critical.`);
  if (result.blocked) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => {
  console.error(`Dependency audit did not complete (${String(error.message).replace(/[^A-Z_]/g, '').slice(0, 100) || 'UNVERIFIED'}). No passing verdict is available.`);
  process.exitCode = 1;
});
