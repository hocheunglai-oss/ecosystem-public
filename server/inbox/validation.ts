import { INBOX_PAGE_LIMIT, type InboxMutation } from '../../shared/inbox.ts';
import { ApiError } from '../auth/validation.ts';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw new ApiError(400, 'Invalid inbox request.');
  return value.toLowerCase();
}
export function inboxQuery(url: URL): { dataMode: 'live'; limit: number; cursor?: string } {
  const keys = [...url.searchParams.keys()];
  if (keys.some(key => !['limit', 'cursor'].includes(key)) || new Set(keys).size !== keys.length) throw new ApiError(400, 'Invalid inbox query.');
  const limitText = url.searchParams.get('limit') ?? '25';
  if (!/^[1-9][0-9]?$/.test(limitText) || Number(limitText) > INBOX_PAGE_LIMIT) throw new ApiError(400, 'Invalid inbox limit.');
  const cursor = url.searchParams.get('cursor');
  if (cursor !== null && (!cursor || cursor.length > 100 || /[\u0000-\u001f\u007f]/.test(cursor))) throw new ApiError(400, 'Invalid inbox cursor.');
  return { dataMode: 'live', limit: Number(limitText), ...(cursor === null ? {} : { cursor }) };
}
export function inboxMutation(value: unknown): InboxMutation & { dataMode: 'live' } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'Invalid inbox request.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['requestId', 'action', 'id'].includes(key)) || !['read', 'dismiss', 'dismiss-all'].includes(String(input.action))) throw new ApiError(400, 'Invalid inbox request.');
  if (input.action === 'dismiss-all' && Object.hasOwn(input, 'id')) throw new ApiError(400, 'Invalid inbox request.');
  return { dataMode: 'live', requestId: uuid(input.requestId), action: input.action as InboxMutation['action'], ...(input.action === 'dismiss-all' ? {} : { id: uuid(input.id) }) };
}
