import type { IncomingMessage, ServerResponse } from 'node:http';
import { createClient } from '@supabase/supabase-js';
import { authConfig } from '../../server/auth/config.ts';
import { handleMonitorEvidence } from '../../server/admin/monitor.ts';

export default async function serveMonitorEvidence(req: IncomingMessage & { body?: unknown }, res: ServerResponse) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', 'application/json');
  try {
    const config = authConfig(process.env);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    let body: string | undefined;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (req.body !== undefined) body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      else {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) {
          const part = Buffer.from(chunk); size += part.length;
          if (size > 2048) { res.statusCode = 413; res.end(JSON.stringify({ message: 'Request too large.' })); return; }
          chunks.push(part);
        }
        body = Buffer.concat(chunks).toString('utf8');
      }
      if (Buffer.byteLength(body ?? '', 'utf8') > 2048) { res.statusCode = 413; res.end(JSON.stringify({ message: 'Request too large.' })); return; }
    }
    const request = new Request(new URL(req.url ?? '/', config.origin), { method: req.method, headers, body });
    const response = await handleMonitorEvidence(request, process.env.ECO_MONITOR_INGEST_SECRET, async evidence => {
      const client = createClient(config.supabaseUrl, config.secretKey, { auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(5_000) }) } });
      const { error } = await client.rpc('eco_record_monitor_evidence', { p_input: evidence });
      if (error) throw new Error('MONITOR_RECORD_UNAVAILABLE');
    });
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(await response.text());
  } catch { res.statusCode = 503; res.end(JSON.stringify({ message: 'Monitor evidence unavailable.' })); }
}
