import { createPrivateKey, type KeyObject } from 'node:crypto';
import { ecoConnections } from '../../config/ecoConnections.ts';

export const EMAIL_PROVIDER = 'microsoft-graph';
export const EMAIL_IDENTITY_NAMESPACE = 'exchange-authenticated-internal-v1';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface EmailPins { tenantId: string | null; clientId: string | null; mailboxId: string | null; sourceId: string | null }
// Replace only with independently verified ECO-only metadata. Null pins keep intake closed.
export const emailReceiverPins: Readonly<EmailPins> = ecoConnections.emailReceiver;
export class EmailSyncError extends Error {
  constructor(readonly code: 'configuration_error' | 'provider_error' | 'identity_unavailable' | 'lease_conflict' | 'cursor_invalid' | 'response_oversized' | 'deadline' | 'deferred' | 'message_unavailable', readonly retryAfter = 60) { super(code); }
}
export interface EmailConfig { tenantId:string; clientId:string; mailboxId:string; sourceId:string; privateKey:KeyObject; certificateSha256:string; supabaseUrl:string; supabaseKey:string }
export function emailConfig(env:NodeJS.ProcessEnv, pins:Readonly<EmailPins> = emailReceiverPins):EmailConfig {
  if (env.ECO_EMAIL_ENABLED !== 'true' || env.ECO_EMAIL_HEADER_PROVENANCE_VERIFIED !== 'true' ||
      env.VERCEL_ENV !== 'production' || env.ECO_ORIGIN !== ecoConnections.productionOrigin ||
      env.VERCEL_PROJECT_ID !== ecoConnections.vercel.projectId || env.VERCEL_ORG_ID !== ecoConnections.vercel.teamId ||
      Object.values(pins).some(id => typeof id !== 'string' || !UUID.test(id)) ||
      env.ECO_SUPABASE_URL !== `https://${ecoConnections.supabaseProjectRef}.supabase.co` || !env.ECO_SUPABASE_SECRET_KEY ||
      !env.ECO_EMAIL_PRIVATE_KEY || !/^[0-9a-f]{64}$/i.test(env.ECO_EMAIL_CERT_SHA256 ?? '')) throw new EmailSyncError('configuration_error');
  try {
    const privateKey=createPrivateKey(env.ECO_EMAIL_PRIVATE_KEY);
    if (privateKey.asymmetricKeyType !== 'rsa' || (privateKey.asymmetricKeyDetails?.modulusLength ?? 0)<2048) throw new Error('key');
    return {...pins as Required<{[K in keyof EmailPins]:string}>,privateKey,certificateSha256:env.ECO_EMAIL_CERT_SHA256!,supabaseUrl:env.ECO_SUPABASE_URL!,supabaseKey:env.ECO_SUPABASE_SECRET_KEY};
  } catch { throw new EmailSyncError('configuration_error'); }
}
