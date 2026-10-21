import { createPublicKey, verify, type JsonWebKeyInput } from 'node:crypto';
import { ecoConnections } from '../../config/ecoConnections.ts';

const ISSUER = 'https://token.actions.githubusercontent.com';
const JWKS_URL = `${ISSUER}/.well-known/jwks`;
const MAX_TOKEN_BYTES = 16_384;
// GitHub documents nbf ten minutes before iat. This bound does not extend the
// independent issuance-age, token-lifetime or expiry checks below.
// https://docs.github.com/en/actions/concepts/security/openid-connect#understanding-the-oidc-token
const MAX_NBF_BACKDATE_SECONDS = 600;
type RecordValue = Record<string, unknown>;
export class BackupAuthError extends Error {
  constructor() { super('Backup authentication failed.'); }
}
const deny = (): never => { throw new BackupAuthError(); };
function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return deny();
  return value as RecordValue;
}
function segment(value: string): Buffer {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return deny();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) return deny();
  return bytes;
}

// Both documented subject formats require the same immutable IDs in separate
// signed claims. No prefix/wildcard subject matching or missing-claim fallback.
export function checkBackupClaims(value: unknown, nowSeconds = Math.floor(Date.now() / 1000)): void {
  const c = record(value), pins = ecoConnections.backup;
  const [owner, repo] = ecoConnections.githubRepository.split('/');
  const workflow = `${ecoConnections.githubRepository}/${pins.githubWorkflowPath}@${pins.githubRef}`;
  const subjects = [
    `repo:${ecoConnections.githubRepository}:environment:${pins.githubEnvironment}`,
    `repo:${owner}@${pins.githubOwnerId}/${repo}@${pins.githubRepositoryId}:environment:${pins.githubEnvironment}`,
  ];
  if (c.iss !== ISSUER || c.aud !== ecoConnections.productionOrigin + pins.storagePath
    || !subjects.includes(c.sub as string)
    || c.repository !== ecoConnections.githubRepository || c.repository_id !== pins.githubRepositoryId
    || c.repository_owner !== owner || c.repository_owner_id !== pins.githubOwnerId
    || c.environment !== pins.githubEnvironment || c.ref !== pins.githubRef || c.ref_type !== 'branch'
    || c.workflow_ref !== workflow || c.repository_visibility !== 'public'
    || c.runner_environment !== 'github-hosted'
    || !['schedule', 'workflow_dispatch'].includes(c.event_name as string)
    || (c.job_workflow_ref !== undefined && c.job_workflow_ref !== workflow)
    || (c.head_ref !== undefined && c.head_ref !== '') || (c.base_ref !== undefined && c.base_ref !== '')) deny();
  if (typeof c.sha !== 'string' || !/^[a-f0-9]{40}$/.test(c.sha)
    || c.workflow_sha !== c.sha || (c.job_workflow_sha !== undefined && c.job_workflow_sha !== c.sha)
    || typeof c.jti !== 'string' || c.jti.length < 1 || c.jti.length > 200
    || typeof c.run_id !== 'string' || !/^\d{1,30}$/.test(c.run_id)
    || typeof c.run_attempt !== 'string' || !/^\d{1,6}$/.test(c.run_attempt)) deny();
  for (const field of ['exp', 'iat', 'nbf']) if (!Number.isSafeInteger(c[field])) deny();
  const exp = c.exp as number, iat = c.iat as number, nbf = c.nbf as number;
  if (exp <= nowSeconds || iat > nowSeconds + 30 || nbf > nowSeconds + 30
    || iat < nowSeconds - 600 || exp <= iat || exp - iat > 600
    || nbf < iat - MAX_NBF_BACKDATE_SECONDS || nbf > exp) deny();
}

/** Only the fixed GitHub JWKS endpoint is trusted; JWT headers cannot select a URL. */
export function createGithubJwksLoader(fetchImpl: typeof fetch = fetch, now = () => Date.now()) {
  let cached: RecordValue[] = [], expiresAt = 0, lastAttempt = -Infinity;
  let pending: Promise<void> | undefined;
  return async (kid: string): Promise<RecordValue> => {
    const found = cached.find(key => key.kid === kid);
    if (found && now() < expiresAt) return found;
    if (!pending) {
      // Bound unknown-kid traffic and failed fetch retries as well as normal caching.
      if (now() - lastAttempt < 30_000) return deny();
      lastAttempt = now();
      pending = (async () => {
        const response = await fetchImpl(JWKS_URL, { redirect: 'error', signal: AbortSignal.timeout(5000) });
        if (response.status !== 200 || response.redirected || (response.url && response.url !== JWKS_URL)
          || response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') deny();
        if (!response.body) deny();
        const reader = response.body!.getReader(), chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          for (;;) {
            const next = await reader.read(); if (next.done) break;
            bytes += next.value.byteLength; if (bytes > 65_536) deny(); chunks.push(next.value);
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const data = record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if (!Array.isArray(data.keys) || !data.keys.length || data.keys.length > 20) deny();
        const keys = (data.keys as unknown[]).map(record);
        if (new Set(keys.map(key => key.kid)).size !== keys.length) deny();
        cached = keys; expiresAt = now() + 300_000;
      })().finally(() => { pending = undefined; });
    }
    await pending;
    return cached.find(key => key.kid === kid) ?? deny();
  };
}
const githubKey = createGithubJwksLoader();

export async function verifyBackupToken(token: string, options: {
  getKey?: (kid: string) => Promise<RecordValue>; nowSeconds?: number;
} = {}): Promise<void> {
  try {
    if (typeof token !== 'string' || token.length > MAX_TOKEN_BYTES) deny();
    const parts = token.split('.'); if (parts.length !== 3) deny();
    const header = record(JSON.parse(segment(parts[0]).toString('utf8')));
    const claims = record(JSON.parse(segment(parts[1]).toString('utf8')));
    const signature = segment(parts[2]);
    if (header.alg !== 'RS256' || header.typ !== 'JWT' || typeof header.kid !== 'string'
      || !/^[A-Za-z0-9_-]{1,200}$/.test(header.kid)
      || Object.keys(header).some(key => !['alg', 'typ', 'kid', 'x5t'].includes(key))) deny();
    // Reject unrelated identities before fetching keys. Claims are not trusted
    // until signature verification below has also succeeded.
    checkBackupClaims(claims, options.nowSeconds);
    const jwk = record(await (options.getKey ?? githubKey)(header.kid as string));
    if (jwk.kid !== header.kid || jwk.kty !== 'RSA' || jwk.alg !== 'RS256' || jwk.use !== 'sig'
      || typeof jwk.n !== 'string' || typeof jwk.e !== 'string' || 'd' in jwk) deny();
    const publicKey = createPublicKey({ key: jwk as JsonWebKeyInput['key'], format: 'jwk' });
    const bits = publicKey.asymmetricKeyDetails?.modulusLength ?? 0;
    if (publicKey.asymmetricKeyType !== 'rsa' || bits < 2048 || bits > 8192
      || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, signature)) deny();
  } catch { throw new BackupAuthError(); }
}
