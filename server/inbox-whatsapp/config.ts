import { ecoConnections } from '../../config/ecoConnections.ts';

export const WHATSAPP_PROVIDER = 'meta-whatsapp-cloud';
export const WHATSAPP_IDENTITY_NAMESPACE = 'meta-whatsapp-signed-v1';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const META_ID = /^[1-9][0-9]{5,29}$/;
export interface WhatsAppPins {
  businessPortfolioId: string | null; appId: string | null; accountId: string | null;
  phoneNumberId: string | null; displayPhoneNumber: string; sourceId: string | null;
  graphApiVersion: string | null; identityNamespace: string;
}
export interface WhatsAppConfig {
  accountId: string; phoneNumberId: string; displayPhoneNumber: string; sourceId: string;
  verifyToken: string; appSecret: string; supabaseUrl: string; supabaseKey: string;
}
export class WhatsAppError extends Error {
  readonly code: 'not_configured' | 'invalid_request' | 'invalid_signature' | 'body_too_large' | 'unavailable';
  readonly status: number;
  constructor(code: WhatsAppError['code'], status: number) { super(code); this.code = code; this.status = status; }
}
/** Challenge setup is deliberately independent of activation and the database. */
export function whatsappConfig(env: NodeJS.ProcessEnv, phase: 'challenge' | 'delivery', pins: Readonly<WhatsAppPins> = ecoConnections.whatsappReceiver): WhatsAppConfig {
  if (env.VERCEL_ENV !== 'production' || env.ECO_ORIGIN !== ecoConnections.productionOrigin ||
      env.VERCEL_PROJECT_ID !== ecoConnections.vercel.projectId || env.VERCEL_ORG_ID !== ecoConnections.vercel.teamId ||
      ![pins.businessPortfolioId, pins.appId, pins.accountId, pins.phoneNumberId].every(id => typeof id === 'string' && META_ID.test(id)) ||
      !UUID.test(pins.sourceId ?? '') || !/^\+[1-9][0-9]{7,14}$/.test(pins.displayPhoneNumber) ||
      !/^v[1-9][0-9]*\.0$/.test(pins.graphApiVersion ?? '') || pins.identityNamespace !== WHATSAPP_IDENTITY_NAMESPACE ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(env.ECO_WHATSAPP_VERIFY_TOKEN ?? '')) throw new WhatsAppError('not_configured', 503);
  if (phase === 'delivery' && (env.ECO_WHATSAPP_ENABLED !== 'true' || env.ECO_WHATSAPP_SUBSCRIPTION_VERIFIED !== 'true' ||
      !/^[0-9a-f]{32}$/i.test(env.ECO_WHATSAPP_APP_SECRET ?? '') ||
      env.ECO_SUPABASE_URL !== `https://${ecoConnections.supabaseProjectRef}.supabase.co` || !env.ECO_SUPABASE_SECRET_KEY)) throw new WhatsAppError('not_configured', 503);
  return { accountId: pins.accountId!, phoneNumberId: pins.phoneNumberId!, displayPhoneNumber: pins.displayPhoneNumber,
    sourceId: pins.sourceId!, verifyToken: env.ECO_WHATSAPP_VERIFY_TOKEN!, appSecret: env.ECO_WHATSAPP_APP_SECRET ?? '',
    supabaseUrl: env.ECO_SUPABASE_URL ?? '', supabaseKey: env.ECO_SUPABASE_SECRET_KEY ?? '' };
}
