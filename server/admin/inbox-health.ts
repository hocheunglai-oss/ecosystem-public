import type { HealthCheck } from '../../shared/system.ts';

export interface InboxHealthEvidence {
  observedAt: string; configuredSources: number; enabledSources: number; enabledEmailSources: number;
  lastSuccessfulCheckpoint: string | null; uncheckpointedEmailSources: number; staleEmailSources: number;
  staleLeaseCount: number; failedSources: number; quarantinedCount: number;
}
export function inboxHealthCheck(value: unknown, now: number): HealthCheck {
  const unknown: HealthCheck = {id:'email-intake',label:'EMAIL INTAKE',status:'unknown',checkedAt:null,detail:'EMAIL INTAKE HAS NOT BEEN VERIFIED.'};
  if (!value || typeof value !== 'object') return unknown;
  const data = value as InboxHealthEvidence;
  const counts = [data.configuredSources,data.enabledSources,data.enabledEmailSources,data.uncheckpointedEmailSources,data.staleEmailSources,data.staleLeaseCount,data.failedSources,data.quarantinedCount];
  const observed = Date.parse(data.observedAt);
  if (counts.some(n=>!Number.isSafeInteger(n)||n<0) || !Number.isFinite(observed) || Math.abs(now-observed)>60_000 ||
      data.enabledSources>data.configuredSources || data.enabledEmailSources>data.enabledSources ||
      data.uncheckpointedEmailSources>data.enabledEmailSources || data.staleEmailSources>data.enabledEmailSources ||
      data.staleLeaseCount>data.enabledSources || data.failedSources>data.enabledSources) return unknown;
  const metrics = {configured_sources:data.configuredSources,enabled_sources:data.enabledSources,enabled_email_sources:data.enabledEmailSources,
    last_checkpoint:data.lastSuccessfulCheckpoint,quarantined:data.quarantinedCount,failed_sources:data.failedSources,stale_leases:data.staleLeaseCount};
  if (!data.enabledEmailSources || data.uncheckpointedEmailSources || !data.lastSuccessfulCheckpoint) return {...unknown,checkedAt:data.observedAt,metrics};
  const checkpoint=Date.parse(data.lastSuccessfulCheckpoint);
  if (!Number.isFinite(checkpoint)||checkpoint>now+60_000) return unknown;
  const stale = data.staleEmailSources>0 || now-checkpoint>10*60_000;
  const failed = stale || data.failedSources>0 || data.staleLeaseCount>0;
  return {id:'email-intake',label:'EMAIL INTAKE',status:failed?'degraded':'healthy',checkedAt:data.observedAt,
    detail:failed?'EMAIL RECEIVING REQUIRES ATTENTION.':'VERIFIED RECEIVER CHECKPOINT IS CURRENT.',metrics};
}
