/** Optional independent dead-man monitor. Never send archives, logs or credentials. */
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ecoConnections as target } from '../../config/ecoConnections.ts';

function check(value) { if (!value) throw Error('Backup monitor configuration is invalid.'); }
export async function signalBackupMonitor(mode, environment = process.env, { fetchImpl = fetch, sleep = delay } = {}) {
  check(['start','finish'].includes(mode));
  check(environment.GITHUB_ACTIONS === 'true' && environment.RUNNER_ENVIRONMENT === 'github-hosted'
    && environment.GITHUB_REPOSITORY === target.githubRepository
    && environment.GITHUB_REPOSITORY_ID === target.backup.githubRepositoryId
    && environment.GITHUB_REPOSITORY_OWNER_ID === target.backup.githubOwnerId
    && environment.GITHUB_REF === target.backup.githubRef && environment.GITHUB_REF_PROTECTED === 'true'
    && ['schedule','workflow_dispatch'].includes(environment.GITHUB_EVENT_NAME));
  const value = environment.ECO_BACKUP_HEARTBEAT_URL;
  if (!value) return { configured: false, delivered: false };
  let url; try { url = new URL(value); } catch { check(false); }
  check(url.origin === target.backup.heartbeatOrigin && !url.username && !url.password && !url.search && !url.hash
    && /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(url.pathname)
    && url.href === value);
  if (mode === 'start') url.pathname += '/start';
  else {
    // A capture step that never completed can be absent from the steps context;
    // GitHub renders a missing property as ''. It must still send a failure ping.
    check(['success','failure','cancelled','skipped','',undefined].includes(environment.ECO_BACKUP_CAPTURE_OUTCOME)
      && ['success','failure','cancelled'].includes(environment.ECO_BACKUP_JOB_STATUS));
    if (environment.ECO_BACKUP_CAPTURE_OUTCOME !== 'success' || environment.ECO_BACKUP_JOB_STATUS !== 'success') url.pathname += '/fail';
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await fetchImpl(url.href, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { 'Content-Type': 'text/plain' }, body: '' });
      if (response.status === 200 && !response.redirected && (!response.url || response.url === url.href)) {
        const reader = response.body?.getReader();
        if (reader) {
          let body = '', size = 0;
          try {
            for (;;) { const chunk = await reader.read(); if (chunk.done) break;
              size += chunk.value.byteLength; if (size > 32) break;
              body += Buffer.from(chunk.value).toString('utf8');
            }
          } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
          // The service also returns 200 for nonexistent/rate-limited checks.
          if (size <= 32 && body.trim() === 'OK') return { configured: true, delivered: true };
        }
      }
    } catch { /* Never log the private ping URL, provider errors or response. */ }
    finally { if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {}); }
    if (attempt < 2) await sleep(500 * 2 ** attempt);
  }
  return { configured: true, delivered: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await signalBackupMonitor(process.argv[2]);
    if (!result.configured) console.warn('::warning::Independent backup email monitoring is not configured.');
    else if (!result.delivered) { console.error('Backup monitor delivery failed.'); process.exitCode = 1; }
    else console.log('Backup monitor signal delivered. Email delivery still requires a verified monitoring integration.');
  } catch { console.error('Backup monitor configuration is invalid.'); process.exitCode = 1; }
}
