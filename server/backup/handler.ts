import { ecoConnections } from '../../config/ecoConnections.ts';
import { BackupAuthError, verifyBackupToken } from './oidc.ts';

export const BACKUP_DOWNLOAD_LIMITS = Object.freeze({ objects: 20, requestBytes: 24_576,
  objectBytes: 20 * 1024 * 1024, signedSeconds: 300 });
export interface BackupObject { id: string; bucketId: string; path: string; size: number; version: string | null }
export interface BackupStorage {
  info(path: string): Promise<{ id: string; bucketId: string; name: string; size: number; version: string | null; contentType: string }>;
  sign(path: string, seconds: number): Promise<string>;
}
class RequestError extends Error {
  readonly status: number;
  constructor(status: number) { super('Backup request rejected.'); this.status = status; }
}
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const objectPath = new RegExp(`^${uuid}/${uuid}/([a-f0-9]{64})\\.pdf$`);
const objectId = new RegExp(`^${uuid}$`);
const reject = (status = 400): never => { throw new RequestError(status); };
export function parseBackupObjects(value: unknown): BackupObject[] {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join(',') !== 'objects') reject();
  const objects = (value as { objects: unknown }).objects;
  if (!Array.isArray(objects) || !objects.length || objects.length > BACKUP_DOWNLOAD_LIMITS.objects) reject();
  const paths = new Set(), ids = new Set();
  return (objects as unknown[]).map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return reject();
    const item = value as BackupObject;
    if (Object.keys(item).sort().join(',') !== 'bucketId,id,path,size,version'
      || item.bucketId !== ecoConnections.supplierReportsBucket || typeof item.id !== 'string' || !objectId.test(item.id)
      || typeof item.path !== 'string' || item.path.length > 200 || !objectPath.test(item.path)
      || !Number.isSafeInteger(item.size) || item.size < 5 || item.size > BACKUP_DOWNLOAD_LIMITS.objectBytes
      || (item.version !== null && (typeof item.version !== 'string' || !/^[A-Za-z0-9_.-]{1,200}$/.test(item.version)))
      || paths.has(item.path) || ids.has(item.id)) reject();
    paths.add(item.path); ids.add(item.id);
    return { id: item.id, bucketId: item.bucketId, path: item.path, size: item.size, version: item.version };
  });
}
export async function handleBackupDownloads(request: Request, storage: BackupStorage, options: {
  enabled: boolean; authenticate?: typeof verifyBackupToken; now?: () => number;
}): Promise<Response> {
  const respond = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'private, no-store, max-age=0',
    Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  } });
  try {
    if (!options.enabled) return respond({ message: 'Not found.' }, 404);
    const url = new URL(request.url);
    if (url.pathname !== ecoConnections.backup.storagePath || url.search) reject(404);
    if (request.method !== 'POST') reject(405);
    const authorization = request.headers.get('authorization');
    if (!authorization || !/^Bearer [A-Za-z0-9_.-]{1,16384}$/.test(authorization)) throw new BackupAuthError();
    await (options.authenticate ?? verifyBackupToken)(authorization.slice(7));
    if (request.headers.has('origin') || request.headers.has('sec-fetch-site')) reject(403);
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') reject();
    const raw = await request.text(); if (Buffer.byteLength(raw) > BACKUP_DOWNLOAD_LIMITS.requestBytes) reject(413);
    let parsed: unknown; try { parsed = JSON.parse(raw); } catch { return reject(); }
    const items = parseBackupObjects(parsed), output = [];
    for (const item of items) {
      const current = await storage.info(item.path);
      if (current.id !== item.id || current.bucketId !== item.bucketId || current.name !== item.path
        || current.size !== item.size || current.version !== item.version || current.contentType !== 'application/pdf') reject(409);
      const expiresAt = new Date((options.now ?? Date.now)() + BACKUP_DOWNLOAD_LIMITS.signedSeconds * 1000).toISOString();
      const signed = new URL(await storage.sign(item.path, BACKUP_DOWNLOAD_LIMITS.signedSeconds));
      if (signed.origin !== `https://${ecoConnections.supabaseProjectRef}.supabase.co`
        || signed.username || signed.password || signed.hash
        || signed.pathname !== `/storage/v1/object/sign/${item.bucketId}/${item.path}`
        || [...signed.searchParams.keys()].join(',') !== 'token' || !signed.searchParams.get('token')) reject(503);
      output.push({ ...item, sha256: objectPath.exec(item.path)![1], url: signed.href, expiresAt });
    }
    return respond({ schemaVersion: 1, projectRef: ecoConnections.supabaseProjectRef, objects: output }, 200);
  } catch (error) {
    const status = error instanceof BackupAuthError ? 401 : error instanceof RequestError ? error.status : 503;
    return respond({ message: status === 401 ? 'Backup authentication failed.' : 'Backup request unavailable.' }, status);
  }
}
