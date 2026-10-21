import type { IncomingMessage, ServerResponse } from 'node:http';
import { createClient } from '@supabase/supabase-js';
import { authConfig, type AuthConfig } from '../auth/config.ts';
import { createAuthGateway } from '../auth/gateway.ts';
import { ApiError } from '../auth/validation.ts';
import { handleLocationKnowledge, LOCATION_REQUEST_MAX_BYTES, type LocationStore } from './handler.ts';

export function locationKnowledgeStore(config: AuthConfig): LocationStore {
  const client = createClient(config.supabaseUrl, config.secretKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: (url, init) => fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) }) } });
  const rpc = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await client.rpc(name, args);
    if (error) {
      if (error.code === '28000') throw new ApiError(401, 'Sign in again.');
      if (error.code === '42501') throw new ApiError(403, 'Access denied.');
      if (error.code === 'PT409') throw new ApiError(409, 'This information or request changed. Reload and review your update.');
      if (error.code === '22023') throw new ApiError(400, 'Invalid location information or no changes to save.');
      throw new ApiError(503, 'The update could not be confirmed. Retry the same request.');
    }
    return data as T;
  };
  return {
    prepare: (identity, operation, input) => rpc('eco_prepare_location_knowledge', { p_actor_id: identity.actorId, p_session_id: identity.sessionId, p_aal: identity.aal, p_operation: operation, p_input: input, p_matching_body: operation==='mutate' && input.action && typeof input.action==='object' && 'body' in input.action && typeof input.action.body==='string' ? input.action.body.trim().toLowerCase() : null }),
    commit: (identity, revision, operation, input, snapshot, digest, archives) => rpc('eco_commit_location_knowledge', { p_actor_id: identity.actorId, p_session_id: identity.sessionId, p_aal: identity.aal, p_actor_revision: revision, p_operation: operation, p_input: input, p_snapshot: snapshot, p_source_digest: digest, p_history: archives.history, p_contributions: archives.contributions, p_publications: archives.publications, p_normalized_bodies: Object.fromEntries(archives.contributions.map(item=>[item.id,item.body.trim().toLowerCase()])) }),
  };
}
export async function serveLocationKnowledge(req: IncomingMessage & { body?: unknown }, res: ServerResponse, environment = process.env) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0'); res.setHeader('Content-Type', 'application/json'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    const config = authConfig(environment), headers = new Headers(); for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    let body: string | undefined;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (req.body !== undefined) body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      else { const chunks: Buffer[] = []; let size = 0; for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > LOCATION_REQUEST_MAX_BYTES) throw new ApiError(413, 'Request too large.'); chunks.push(bytes); } body = Buffer.concat(chunks).toString('utf8'); }
      if (Buffer.byteLength(body ?? '') > LOCATION_REQUEST_MAX_BYTES) throw new ApiError(413, 'Request too large.');
    }
    const request = new Request(new URL(req.url ?? '/', config.origin), { method: req.method, headers, body });
    const response = await handleLocationKnowledge(request, config, createAuthGateway(request, config), locationKnowledgeStore(config));
    res.statusCode = response.status; response.headers.forEach((value, key) => { if (key !== 'set-cookie') res.setHeader(key, value); });
    const cookies = response.headers.getSetCookie(); if (cookies.length) res.setHeader('Set-Cookie', cookies); res.end(await response.text());
  } catch (error) { res.statusCode = error instanceof ApiError ? error.status : 503; res.end(JSON.stringify({ message: error instanceof ApiError ? error.message : 'Shared location information is unavailable.' })); }
}
