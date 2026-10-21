import type { SystemInformation } from '../../shared/system.ts';
import { generatedSystemInformation } from '../generated/system-information.ts';

/** Call only after an active, effective administrator has been authorized. */
export function getSystemInformation(environment: NodeJS.ProcessEnv = process.env): SystemInformation {
  return {
    ...structuredClone(generatedSystemInformation),
    runtime: {
      node: process.version,
      requiredNode: generatedSystemInformation.build.requiredNode,
      environment: environment.VERCEL_ENV === 'production' ? 'production' : environment.VERCEL_ENV === 'preview' ? 'preview' :
        environment.VERCEL_ENV === 'development' ? 'development' : 'local',
      deploymentId: /^dpl_[a-zA-Z0-9]{10,80}$/.test(environment.VERCEL_DEPLOYMENT_ID ?? '') ? environment.VERCEL_DEPLOYMENT_ID! : null,
      region: /^[a-z]{3}\d{1,2}$/.test(environment.VERCEL_REGION ?? '') ? environment.VERCEL_REGION! : null,
    },
  };
}
