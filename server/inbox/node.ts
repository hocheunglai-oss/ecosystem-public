import type { IncomingMessage, ServerResponse } from 'node:http';
import { authConfig } from '../auth/config.ts';
import { createAuthGateway } from '../auth/gateway.ts';
import { handleInbox } from './handler.ts';
import { ApiError } from '../auth/validation.ts';

export async function inboxNodeRequest(req: IncomingMessage & { body?: unknown }, origin: string): Promise<Request> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  let body: string | undefined;
  if (!['GET', 'HEAD'].includes(req.method ?? 'GET')) {
    if (req.body !== undefined) body = typeof req.body === 'string' ? req.body : Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body);
    else {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length;
        if (size > 4096) throw new ApiError(413, 'Request too large.');
        chunks.push(bytes);
      }
      body = Buffer.concat(chunks).toString('utf8');
    }
    if (Buffer.byteLength(body ?? '', 'utf8') > 4096) throw new ApiError(413, 'Request too large.');
  }
  return new Request(new URL(req.url ?? '/', origin), { method: req.method, headers, body });
}
export async function serveInbox(req: IncomingMessage & { body?: unknown }, res: ServerResponse, environment = process.env) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    const config = authConfig(environment);
    const request = await inboxNodeRequest(req, config.origin);
    const response = await handleInbox(request, config, createAuthGateway(request, config));
    res.statusCode = response.status;
    response.headers.forEach((value, key) => { if (key !== 'set-cookie') res.setHeader(key, value); });
    const cookies = response.headers.getSetCookie(); if (cookies.length) res.setHeader('Set-Cookie', cookies);
    res.end(await response.text());
  } catch (error) { res.statusCode = error instanceof ApiError ? error.status : 503; res.end(JSON.stringify({ message: error instanceof ApiError ? error.message : 'Inbox unavailable.' })); }
}
