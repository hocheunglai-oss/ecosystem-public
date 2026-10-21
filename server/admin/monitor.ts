import { createHash, timingSafeEqual } from 'node:crypto';
import type { MonitorEvidenceRecord } from '../../shared/system.ts';

const keys = ['checkRun', 'observedAt', 'status', 'latencyMs', 'source', 'kind'];
export function validMonitorEvidence(value: unknown, now: number): value is MonitorEvidenceRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== keys.length || Object.keys(input).some(key => !keys.includes(key))) return false;
  const observed = typeof input.observedAt === 'string' ? Date.parse(input.observedAt) : NaN;
  return typeof input.checkRun === 'string' && /^\d{1,30}$/.test(input.checkRun) &&
    Number.isFinite(observed) && observed >= now - 10 * 60_000 && observed <= now + 2 * 60_000 &&
    typeof input.status === 'string' && ['healthy', 'degraded', 'unavailable'].includes(input.status) &&
    Number.isSafeInteger(input.latencyMs) && Number(input.latencyMs) >= 0 && Number(input.latencyMs) <= 60_000 &&
    input.source === 'github-actions' && input.kind === 'external-availability';
}
function authorized(header: string | null, secret: string | undefined) {
  if (!secret || secret.length < 32 || secret.length > 512) return false;
  const supplied = header?.startsWith('Bearer ') ? header.slice(7) : '';
  if (supplied.length > 512) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(supplied), digest(secret));
}
export async function handleMonitorEvidence(request: Request, secret: string | undefined,
  record: (evidence: MonitorEvidenceRecord) => Promise<void>, now = Date.now()): Promise<Response> {
  const reply = (status: number, message: string) => Response.json({ message }, { status,
    headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
  if (request.method !== 'POST') return reply(405, 'Method not allowed.');
  if (!secret || secret.length < 32) return reply(503, 'Monitor evidence is not configured.');
  if (!authorized(request.headers.get('authorization'), secret)) return reply(401, 'Monitor authorization required.');
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return reply(415, 'JSON required.');
  const body = await request.text();
  if (Buffer.byteLength(body) > 2048) return reply(413, 'Request too large.');
  let value: unknown;
  try { value = JSON.parse(body); } catch { return reply(400, 'Invalid monitor evidence.'); }
  if (!validMonitorEvidence(value, now)) return reply(400, 'Invalid monitor evidence.');
  try { await record(value); return reply(200, 'Recorded.'); }
  catch { return reply(503, 'Monitor evidence could not be recorded.'); }
}
