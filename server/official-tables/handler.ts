import type { AuthConfig } from '../auth/config.ts';
import type { AdministrationGateway } from '../admin/handler.ts';
import type { OfficialTableResult } from '../../shared/officialTables.ts';
import { officialTableFeedId } from '../../shared/officialTables.ts';
import { ApiError } from '../auth/validation.ts';

export async function handleOfficialTable(request: Request, config: AuthConfig, gateway: AdministrationGateway): Promise<Response> {
  const respond = (body: unknown, status = 200) => {
    const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store, max-age=0', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    for (const cookie of gateway.cookies) headers.append('Set-Cookie', cookie);
    return new Response(JSON.stringify(body), { status, headers });
  };
  try {
    if (request.method !== 'GET') throw new ApiError(405, 'Method not allowed.');
    const url = new URL(request.url);
    if (url.pathname !== '/api/official-tables/snapshot') throw new ApiError(404, 'Not found.');
    if (url.search) throw new ApiError(400, 'Invalid request.');
    const origin = request.headers.get('origin');
    if (request.headers.get('sec-fetch-site') === 'cross-site' || (origin && origin !== config.origin && origin !== config.deploymentOrigin)) throw new ApiError(403, 'Access denied.');
    const user = await gateway.currentUser();
    if (!user?.isActive || !user.activated) throw new ApiError(401, 'Sign in required.');
    const result = await gateway.authenticatedRpc<OfficialTableResult>('eco_official_table_snapshot');
    if (result?.snapshot?.feedId !== officialTableFeedId || !['current', 'stale', 'unavailable'].includes(result.snapshot.status) || !Array.isArray(result.snapshot.rows)) throw new Error('Invalid official table result');
    return respond(result);
  } catch (error) { return respond({ message: error instanceof ApiError ? error.message : 'Official table unavailable.' }, error instanceof ApiError ? error.status : 503); }
}
