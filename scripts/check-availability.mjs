import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { ecoConnections } from '../config/ecoConnections.ts';

// Runs outside ECO. Its evidence can be inspected even when ECO itself is unavailable.
if (process.env.GITHUB_REPOSITORY !== ecoConnections.githubRepository || !/^\d{1,20}$/.test(process.env.GITHUB_RUN_ID ?? '') ||
    !/^\d{1,3}$/.test(process.env.GITHUB_RUN_ATTEMPT ?? '') || !process.env.ECO_MONITOR_INGEST_SECRET || process.env.ECO_MONITOR_INGEST_SECRET.length < 32) {
  throw new Error('Independent monitor identity or ingest secret is not configured');
}
const base = ecoConnections.productionOrigin;
const started = performance.now();
async function check(path, accepts) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(base + path, { redirect: 'manual', signal: AbortSignal.timeout(8_000), headers: { 'User-Agent': 'ECO-Availability-Monitor/1' } });
      if (await accepts(response)) return true;
    } catch { /* Record only bounded outcomes, never response content or credentials. */ }
    if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  return false;
}
const [loginPage, sessionBoundary] = await Promise.all([
  check('/', async response => response.status === 200 && (response.headers.get('content-type') ?? '').includes('text/html') && /id="root"/.test(await response.text())),
  check('/api/access/session', async response => response.status === 401 && /no-store/.test(response.headers.get('cache-control') ?? '') && (await response.json()).user === null),
]);
const evidence = { kind: 'external-availability', source: 'github-actions',
  checkRun: process.env.GITHUB_RUN_ID + process.env.GITHUB_RUN_ATTEMPT.padStart(3, '0'), observedAt: new Date().toISOString(),
  status: loginPage && sessionBoundary ? 'healthy' : !loginPage && !sessionBoundary ? 'unavailable' : 'degraded',
  latencyMs: Math.min(60_000, Math.round(performance.now() - started)) };
let recorded = false;
try {
  const response = await fetch(base + '/api/monitor/evidence', { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8_000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.ECO_MONITOR_INGEST_SECRET}` }, body: JSON.stringify(evidence) });
  recorded = response.status === 200;
} catch { /* The artifact remains the independent evidence during an application outage. */ }
await mkdir('output/monitoring', { recursive: true });
await writeFile('output/monitoring/availability.json', JSON.stringify({ ...evidence, checks: { loginPage, sessionBoundary }, recorded }, null, 2) + '\n');
console.log(JSON.stringify({ status: evidence.status, loginPage, sessionBoundary, recorded, observedAt: evidence.observedAt }));
if (evidence.status !== 'healthy' || !recorded) process.exitCode = 1;
