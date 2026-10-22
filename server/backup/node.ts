import type { IncomingMessage, ServerResponse } from 'node:http';
import { createClient } from '@supabase/supabase-js';
import { ecoConnections } from '../../config/ecoConnections.ts';
import { authConfig } from '../auth/config.ts';
import { BACKUP_DOWNLOAD_LIMITS, handleBackupDownloads } from './handler.ts';

export async function serveBackupDownloads(req: IncomingMessage & { body?: unknown }, res: ServerResponse, environment = process.env) {
  res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (environment.ECO_BACKUP_STORAGE_ENABLED !== 'true') { res.statusCode = 404; res.end('{"message":"Not found."}'); return; }
  try {
    const config = authConfig(environment);
    if (config.origin !== ecoConnections.productionOrigin) throw Error('Target mismatch');
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (value) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    let body: string | undefined;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (req.body !== undefined) body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      else {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) {
          const bytes = Buffer.from(chunk); size += bytes.length;
          if (size > BACKUP_DOWNLOAD_LIMITS.requestBytes) { res.statusCode = 413; res.end('{"message":"Request too large."}'); return; }
          chunks.push(bytes);
        }
        body = Buffer.concat(chunks).toString('utf8');
      }
      if (Buffer.byteLength(body ?? '') > BACKUP_DOWNLOAD_LIMITS.requestBytes) { res.statusCode = 413; res.end('{"message":"Request too large."}'); return; }
    }
    const request = new Request(new URL(req.url ?? '/', config.origin), { method: req.method, headers, body });
    const service = createClient(config.supabaseUrl, config.secretKey, { auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (input, init) => fetch(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) }) } });
    const getBucket = (id: string) => { if (!([ecoConnections.supplierReportsBucket, ecoConnections.profileAttachmentsBucket] as readonly string[]).includes(id)) throw Error('Unknown bucket'); return service.storage.from(id); };
    const response = await handleBackupDownloads(request, {
      async info(path, bucketId = ecoConnections.supplierReportsBucket) {
        const { data, error } = await getBucket(bucketId).info(path);
        if (error || !data) throw Error('Storage unavailable');
        let verified: {managed?: boolean;sha256?:string|null} = {};
        if (bucketId === ecoConnections.profileAttachmentsBucket) {
          const result = await service.rpc('eco_profile_attachment_backup', {p_path:path});
          if (result.error || !result.data || result.data.state === 'active' && (result.data.objectId !== data.id || result.data.version !== (data.version ?? null) || result.data.size !== data.size || result.data.mime !== data.contentType)) throw Error('Attachment inventory mismatch');
          verified = {managed:true,sha256:result.data.sha256};
        }
        return { ...verified, id: data.id, bucketId: data.bucketId, name: data.name, version: data.version ?? null,
          size: data.size ?? NaN, contentType: data.contentType ?? '' };
      },
      async sign(path, seconds, bucketId = ecoConnections.supplierReportsBucket) {
        const { data, error } = await getBucket(bucketId).createSignedUrl(path, seconds);
        if (error || !data?.signedUrl) throw Error('Storage unavailable');
        return data.signedUrl;
      },
    }, { enabled: true });
    res.statusCode = response.status; response.headers.forEach((value, name) => res.setHeader(name, value));
    res.end(await response.text());
  } catch { res.statusCode = 503; res.end('{"message":"Backup service unavailable."}'); }
}
