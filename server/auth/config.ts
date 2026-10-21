import { ecoConnections } from '../../config/ecoConnections.ts';

export interface AuthConfig {
  origin: string;
  supabaseUrl: string;
  publishableKey: string;
  secretKey: string;
  rateLimitSecret: string;
  secureCookies: boolean;
  deploymentOrigin?: string;
  newUserPassword?: string;
}

export function authConfig(env = process.env): AuthConfig {
  const { ECO_ORIGIN, ECO_SUPABASE_URL, ECO_SUPABASE_PUBLISHABLE_KEY, ECO_SUPABASE_SECRET_KEY, ECO_RATE_LIMIT_SECRET } = env;
  if (!ecoConnections.supabaseProjectRef || !ECO_ORIGIN || !ECO_SUPABASE_URL || !ECO_SUPABASE_PUBLISHABLE_KEY ||
      !ECO_SUPABASE_SECRET_KEY || !ECO_RATE_LIMIT_SECRET || ECO_RATE_LIMIT_SECRET.length < 32) throw new Error('AUTH_NOT_CONFIGURED');
  const origin = new URL(ECO_ORIGIN);
  const database = new URL(ECO_SUPABASE_URL);
  if ((env.VERCEL_ENV === 'production' && ECO_ORIGIN !== ecoConnections.productionOrigin) ||
      (env.VERCEL_PROJECT_ID && env.VERCEL_PROJECT_ID !== ecoConnections.vercel.projectId) ||
      (env.VERCEL_ORG_ID && env.VERCEL_ORG_ID !== ecoConnections.vercel.teamId)) throw new Error('AUTH_NOT_CONFIGURED');
  if (origin.origin !== ECO_ORIGIN || origin.username || origin.password ||
      (origin.protocol !== 'https:' && !(env.NODE_ENV !== 'production' && origin.hostname === '127.0.0.1')) ||
      database.origin !== ECO_SUPABASE_URL || database.protocol !== 'https:' ||
      database.hostname !== `${ecoConnections.supabaseProjectRef}.supabase.co`) throw new Error('AUTH_NOT_CONFIGURED');
  let deploymentOrigin: string | undefined;
  // Only Vercel's own deployment hostname for this exact project may supplement the canonical origin.
  if (env.VERCEL_PROJECT_ID === ecoConnections.vercel.projectId && env.VERCEL_ORG_ID === ecoConnections.vercel.teamId &&
      ['production','preview'].includes(env.VERCEL_ENV ?? '') && env.VERCEL_URL && /^[a-z0-9-]+\.vercel\.app$/.test(env.VERCEL_URL)) {
    deploymentOrigin = `https://${env.VERCEL_URL}`;
  }
  return { origin: origin.origin, deploymentOrigin, supabaseUrl: database.origin, publishableKey: ECO_SUPABASE_PUBLISHABLE_KEY,
    secretKey: ECO_SUPABASE_SECRET_KEY, rateLimitSecret: ECO_RATE_LIMIT_SECRET, secureCookies: origin.protocol === 'https:',
    newUserPassword: env.ECO_NEW_USER_PASSWORD };
}
