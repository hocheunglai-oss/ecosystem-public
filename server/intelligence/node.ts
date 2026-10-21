import type { IncomingMessage, ServerResponse } from 'node:http';
import { authConfig } from '../auth/config.ts';
import { createAuthGateway } from '../auth/gateway.ts';
import { handleIntelligence } from './handler.ts';

export async function serveIntelligence(req: IncomingMessage, res: ServerResponse, environment = process.env) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    // Never read or forward a request body; this service has no mutation endpoint.
    if (req.method !== 'GET') { res.statusCode = 405; res.end(JSON.stringify({ message: 'Method not allowed.' })); return; }
    if (req.headers['transfer-encoding'] || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')) { res.statusCode = 400; res.end(JSON.stringify({ message: 'Invalid request.' })); return; }
    const config = authConfig(environment), headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    const request = new Request(new URL(req.url ?? '/', config.origin), { method: 'GET', headers });
    const response = await handleIntelligence(request, config, createAuthGateway(request, config));
    res.statusCode = response.status;
    response.headers.forEach((value, key) => { if (key !== 'set-cookie') res.setHeader(key, value); });
    const cookies = response.headers.getSetCookie(); if (cookies.length) res.setHeader('Set-Cookie', cookies);
    res.end(await response.text());
  } catch { res.statusCode = 503; res.end(JSON.stringify({ message: 'Intelligence unavailable.' })); }
}
