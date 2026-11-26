import { createHash, randomBytes } from 'node:crypto';
import { ecoConnections } from '../../config/ecoConnections.ts';
import { formatEnquiry } from '../../src/lib/parser.ts';
import type { CommercialProduct } from '../../shared/commercialEnquiries.ts';
import type { AuthConfig } from '../auth/config.ts';
import type { createAuthGateway } from '../auth/gateway.ts';
import { ApiError } from '../auth/validation.ts';

type AccountGateway = Pick<ReturnType<typeof createAuthGateway>, 'authenticatedRpc' | 'cookies'>;
type DispatchRpc = (args: { p_token_hash: string; p_action: string; p_enquiry?: string; p_claim?: string }) => Promise<unknown>;
type Delivery = {
  id: string; claimToken: string; groupName: string; reference: string; vessel: string; imo: string; eta: string;
  products: CommercialProduct[]; rmk: boolean; viscosity: string[];
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

function outgoingText(job: Delivery): string {
  // Limit the device to the reviewed operational fields. The private source,
  // buyer, notes and user-editable preview never enter the delivery payload.
  const message = formatEnquiry({ vessel: job.vessel.replace(/\s+/g, ' '), imo: job.imo, eta: job.eta.replace(/\s+/g, ' '),
    portName: 'Singapore', buyerName: '', products: job.products, rmk: job.rmk, vlsfoMaxRemarks: job.viscosity });
  if (message.includes('[CONFIRM ') || !/^ECO-\d{8,}$/.test(job.reference)) throw new ApiError(422, 'Review the delivery details.');
  return message + '\n' + job.reference;
}

export async function handleWhatsAppDispatch(request: Request, config: AuthConfig, account: AccountGateway, run: DispatchRpc): Promise<Response> {
  const respond = (value: unknown, status = 200) => {
    const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    for (const cookie of account.cookies) headers.append('Set-Cookie', cookie);
    return new Response(JSON.stringify(value), { status, headers });
  };
  try {
    if (new URL(request.url).search) throw new ApiError(400, 'Invalid dispatcher request.');
    if (request.headers.get('sec-fetch-site') === 'cross-site' && !request.headers.has('authorization')) throw new ApiError(403, 'Access denied.');
    if (request.method === 'GET') return respond(await account.authenticatedRpc('eco_whatsapp_route'));
    if (request.method !== 'POST') throw new ApiError(405, 'Method not allowed.');
    if (request.headers.get('host') !== new URL(ecoConnections.productionOrigin).host) throw new ApiError(403, 'Connect on ECO.');
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new ApiError(415, 'JSON required.');
    const text = await request.text();
    if (Buffer.byteLength(text, 'utf8') > 2048) throw new ApiError(413, 'Request too large.');
    let input: Record<string, unknown>;
    try { input = JSON.parse(text); } catch { throw new ApiError(400, 'Invalid dispatcher request.'); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, 'Invalid dispatcher request.');
    if (input.action === 'connect') {
      if (Object.keys(input).length !== 1 || request.headers.has('authorization') || request.headers.get('origin') !== config.origin
        || request.headers.get('x-eco-request') !== '1' || request.headers.get('x-eco-data-mode') !== 'live') throw new ApiError(403, 'Access denied.');
      const token = randomBytes(32).toString('base64url');
      await account.authenticatedRpc('eco_connect_whatsapp_dispatcher', { p_token_hash: hash(token) });
      return respond({ token });
    }
    const token = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!token) throw new ApiError(401, 'Connect the ECO dispatcher.');
    const action = typeof input.action === 'string' ? input.action : '';
    const jobAction = ['reserve','sent','review'].includes(action);
    if (jobAction ? Object.keys(input).length !== 3 || typeof input.id !== 'string' || !uuid.test(input.id)
      || typeof input.claimToken !== 'string' || !uuid.test(input.claimToken)
      : !['heartbeat','claim'].includes(action) || Object.keys(input).length !== 1) throw new ApiError(400, 'Invalid dispatcher request.');
    const args = { p_token_hash: hash(token), p_action: action, ...(jobAction ? { p_enquiry: input.id as string, p_claim: input.claimToken as string } : {}) };
    const result = await run(args);
    if (action !== 'claim') return respond(result);
    const job = (result as { job: Delivery | null }).job;
    if (!job) return respond({ job: null });
    try {
      return respond({ job: { id: job.id, claimToken: job.claimToken, groupName: job.groupName, message: outgoingText(job) } });
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 422)) throw error;
      await run({ p_token_hash: args.p_token_hash, p_action: 'review', p_enquiry: job.id, p_claim: job.claimToken });
      return respond({ job: null });
    }
  } catch (error) {
    return respond({ message: error instanceof ApiError ? error.message : 'Dispatcher unavailable. Try again.' }, error instanceof ApiError ? error.status : 503);
  }
}
