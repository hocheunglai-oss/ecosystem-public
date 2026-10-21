import { useAccess } from './auth';
import { canUseBuyerCredit, ECO_2_RELEASE_NOTICE } from '../shared/ecoRelease';
import './release-gate.css';

export function useBuyerCreditAvailable(): boolean {
  const { user, preview } = useAccess();
  return canUseBuyerCredit(user, preview);
}

export function ReleaseNotice({ compact = false }: { compact?: boolean }) {
  return <p role="status" className={`release-notice${compact ? ' release-notice--compact' : ''}`}>{ECO_2_RELEASE_NOTICE}</p>;
}
