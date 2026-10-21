import type { IncomingMessage, ServerResponse } from 'node:http';
import { authConfig } from './config.ts';
import { createAuthGateway } from './gateway.ts';
import { handleAuth } from './handler.ts';

/** Shared by the Vercel Function and the isolated Vite development server. */
export async function serveAccess(req: IncomingMessage & { body?: unknown }, res: ServerResponse, environment = process.env) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', 'application/json');
  try {
    const config = authConfig(environment);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    let body: string | undefined;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (req.body !== undefined) body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      else {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) {
          const buffer = Buffer.from(chunk); size += buffer.length;
          if (size > 8192) { res.statusCode = 413; res.end(JSON.stringify({ message: 'Request too large.' })); return; }
          chunks.push(buffer);
        }
        body = Buffer.concat(chunks).toString('utf8');
      }
      if (Buffer.byteLength(body ?? '', 'utf8') > 8192) { res.statusCode = 413; res.end(JSON.stringify({ message: 'Request too large.' })); return; }
    }
    const request = new Request(new URL(req.url ?? '/', config.origin), { method: req.method, headers, body });
    const response = await handleAuth(request, config, createAuthGateway(request, config));
    res.statusCode = response.status;
    response.headers.forEach((value, key) => { if (key !== 'set-cookie') res.setHeader(key, value); });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) res.setHeader('Set-Cookie', cookies);
    res.end(await response.text());
  } catch {
    res.statusCode = 503;
    res.end(JSON.stringify({ message: 'Sign-in is not available yet.' }));
  }
}
