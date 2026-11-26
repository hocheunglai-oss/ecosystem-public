import { useAccess } from './auth';
import { useTestWorkspace } from './TestWorkspace';
import { canUseBuyerCredit, ECO_2_RELEASE_NOTICE } from '../shared/ecoRelease';
import './release-gate.css';

export function useBuyerCreditAvailable(): boolean {
  const { user, preview } = useAccess();
  const { developerMode } = useTestWorkspace();
  return canUseBuyerCredit(user, preview, developerMode);
}

export function ReleaseNotice({ compact = false }: { compact?: boolean }) {
  return <p role="status" className={`release-notice${compact ? ' release-notice--compact' : ''}`}>{ECO_2_RELEASE_NOTICE}</p>;
}
