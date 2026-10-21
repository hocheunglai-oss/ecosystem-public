import type { IncomingMessage, ServerResponse } from 'node:http';
import { createClient } from '@supabase/supabase-js';
import { authConfig, type AuthConfig } from '../auth/config.ts';
import { createAuthGateway } from '../auth/gateway.ts';
import { cronAuthorized } from '../inbox-email/node.ts';
import type { OfficialTableResult } from '../../shared/officialTables.ts';
import { handleOfficialTable } from './handler.ts';
import { refreshOfficialTable, type OfficialTableStore } from './refresh.ts';

export function officialTableStore(config: AuthConfig): OfficialTableStore {
  const client = createClient(config.supabaseUrl, config.secretKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: (url, init) => fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) }) } });
  const rpc = async <T>(name: string, input?: Record<string, unknown>): Promise<T> => { const { data, error } = await client.rpc(name, input); if (error) throw new Error('Official table persistence unavailable'); return data as T; };
  return {
    read: async () => (await rpc<OfficialTableResult>('eco_official_table_refresh_context')).snapshot,
    publish: (checkedAt, rows, failureReason) => rpc('eco_publish_official_table', { p_input: { checkedAt, rows, ...(failureReason ? { failureReason } : {}) } }),
  };
}
interface Dependencies { configure: typeof authConfig; store: typeof officialTableStore; refresh: typeof refreshOfficialTable }
const defaults: Dependencies = { configure: authConfig, store: officialTableStore, refresh: refreshOfficialTable };
export async function handleOfficialTableRefresh(request: Request, env = process.env, deps: Dependencies = defaults): Promise<Response> {
  const answer = (status: number, body: unknown) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store, max-age=0', 'X-Content-Type-Options': 'nosniff' } });
  if (!cronAuthorized(request.headers.get('authorization'), env.CRON_SECRET)) return answer(401, { error: 'unauthorized' });
  if (request.method !== 'GET') return answer(405, { error: 'method_not_allowed' });
  const url = new URL(request.url), cookie = request.headers.get('cookie');
  if (url.pathname !== '/api/official-tables/refresh' || url.search || request.headers.has('origin') || request.headers.has('sec-fetch-site') || request.headers.has('transfer-encoding') || (request.headers.has('content-length') && request.headers.get('content-length') !== '0') ||
    (cookie !== null && (cookie.length > 4096 || !/^_vercel_jwt=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cookie)))) return answer(400, { error: 'invalid_request' });
  try {
    const config = deps.configure(env); // Canonical ECO project/team/origin are checked before any service client is made.
    if (env.ECO_OFFICIAL_TABLES_ENABLED !== 'true') return answer(200, { status: 'disabled' });
    return answer(200, await deps.refresh(deps.store(config)));
  } catch { return answer(503, { error: 'official_table_refresh_unavailable' }); }
}
async function serve(req: IncomingMessage, res: ServerResponse, refresh: boolean, environment: NodeJS.ProcessEnv) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0'); res.setHeader('Content-Type', 'application/json'); res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    if (req.method !== 'GET') { res.statusCode = 405; res.end(JSON.stringify({ message: 'Method not allowed.' })); return; }
    if (req.headers['transfer-encoding'] || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')) { res.statusCode = 400; res.end(JSON.stringify({ message: 'Invalid request.' })); return; }
    const headers = new Headers(); for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    let response: Response;
    if (refresh) response = await handleOfficialTableRefresh(new Request(new URL(req.url ?? '/', 'https://eco.invalid'), { headers }), environment);
    else { const config = authConfig(environment), request = new Request(new URL(req.url ?? '/', config.origin), { headers }); response = await handleOfficialTable(request, config, createAuthGateway(request, config)); }
    res.statusCode = response.status; response.headers.forEach((value, key) => { if (key !== 'set-cookie') res.setHeader(key, value); });
    const cookies = response.headers.getSetCookie(); if (cookies.length) res.setHeader('Set-Cookie', cookies); res.end(await response.text());
  } catch { res.statusCode = 503; res.end(JSON.stringify({ message: 'Official table unavailable.' })); }
}
export const serveOfficialTable = (req: IncomingMessage, res: ServerResponse) => serve(req, res, false, process.env);
export const serveOfficialTableRefresh = (req: IncomingMessage, res: ServerResponse) => serve(req, res, true, process.env);
export const serveOfficialTables = (req: IncomingMessage, res: ServerResponse, environment = process.env) => serve(req, res, req.url?.split('?')[0] === '/api/official-tables/refresh', environment);
