import type { IncomingMessage, ServerResponse } from 'node:http';
import { createClient } from '@supabase/supabase-js';
import { authConfig } from '../auth/config.ts';
import { createAuthGateway } from '../auth/gateway.ts';
import { ApiError } from '../auth/validation.ts';
import { commercialNodeRequest } from '../commercial-enquiries/node.ts';
import { handleWhatsAppDispatch } from './handler.ts';

export async function serveWhatsAppDispatch(req: IncomingMessage & { body?: unknown }, res: ServerResponse, env = process.env) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    const config = authConfig(env);
    const request = await commercialNodeRequest(req, config.origin);
    const response = await handleWhatsAppDispatch(request, config, createAuthGateway(request, config), async args => {
      const client = createClient(config.supabaseUrl, config.secretKey, { auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }) } });
      const { data, error } = await client.rpc('eco_whatsapp_dispatch', args);
      if (error?.code === '28000') throw new ApiError(401, 'Connect the ECO dispatcher.');
      if (error) throw new ApiError(503, 'Dispatcher unavailable. Try again.');
      return data;
    });
    res.statusCode = response.status;
    const cookies = response.headers.getSetCookie();
    if (cookies.length) res.setHeader('Set-Cookie', cookies);
    res.end(await response.text());
  } catch (error) {
    res.statusCode = error instanceof ApiError ? error.status : 503;
    res.end(JSON.stringify({ message: error instanceof ApiError ? error.message : 'Dispatcher unavailable.' }));
  }
}
