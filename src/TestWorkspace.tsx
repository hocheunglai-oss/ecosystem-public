import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAccess } from './auth';
import { canUseTestWorkspace, parseTestWorkspacePolicy, purgeObsoleteTestWorkspaces, workspaceNamespace, type TestWorkspacePolicy, type WorkspaceDataMode } from './lib/testWorkspace';
import { setWorkspaceDataMode, setWorkspaceNamespace } from './lib/testWorkspaceGuard';

type TestWorkspace = { dataMode: WorkspaceDataMode; namespace: string; policy: TestWorkspacePolicy | null; generation: string | undefined;
  available: boolean; developerMode: boolean; toggleDeveloperMode(): void; toggleTestData(): void };
const Context = createContext<TestWorkspace | null>(null);
export function TestWorkspaceProvider({ children }: { children: ReactNode }) {
  const { realUser, preview } = useAccess();
  const eligible = canUseTestWorkspace(realUser);
  const ownerId = eligible ? realUser.id : null;
  const [verified, setVerified] = useState<{ ownerId: string; policy: TestWorkspacePolicy } | null>(null);
  const [selection, setSelection] = useState<{ ownerId: string; generation: string; dataMode: WorkspaceDataMode } | null>(null);
  const request = useRef(0);
  const verifiedRef = useRef(verified); verifiedRef.current = verified;
  useEffect(() => {
    if (!ownerId) { setVerified(null); setSelection(null); return; }
    const controller = new AbortController();
    async function refresh() {
      const current = ++request.current;
      try {
        const response = await fetch('/api/enquiries/test-policy', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
        if (!response.ok) throw new Error('Test data is unavailable.');
        const policy = parseTestWorkspacePolicy(await response.json());
        if (!policy) throw new Error('Test data is unavailable.');
        if (current !== request.current || controller.signal.aborted) return;
        if (!policy.enabled || verifiedRef.current?.policy.generation !== policy.generation) { setWorkspaceDataMode('live'); setWorkspaceNamespace(workspaceNamespace(ownerId!)); }
        purgeObsoleteTestWorkspaces(localStorage, ownerId!, policy);
        setSelection(value => value?.ownerId === ownerId && value.generation === policy.generation && policy.enabled ? value : null);
        setVerified({ ownerId: ownerId!, policy });
      } catch {
        if (current === request.current && !controller.signal.aborted) { setWorkspaceDataMode('live'); setWorkspaceNamespace(workspaceNamespace(ownerId!)); setVerified(null); setSelection(null); }
      }
    }
    void refresh();
    const onFocus = () => { void refresh(); };
    const interval = window.setInterval(() => { if (!document.hidden) void refresh(); }, 30000);
    window.addEventListener('focus', onFocus);
    return () => { request.current++; controller.abort(); clearInterval(interval); window.removeEventListener('focus', onFocus); };
  }, [ownerId]);
  useEffect(() => { if (preview) setSelection(null); }, [preview]);
  const policy = eligible && verified?.ownerId === realUser.id ? verified.policy : null;
  const available = Boolean(policy?.enabled) && !preview;
  const active = available && selection?.ownerId === ownerId && selection.generation === policy?.generation ? selection : null;
  const developerMode = active !== null;
  const dataMode = active?.dataMode ?? 'live';
  setWorkspaceDataMode(dataMode);
  const generation = dataMode === 'test' ? policy?.generation : undefined;
  const namespace = workspaceNamespace(realUser?.id, dataMode, policy?.generation);
  setWorkspaceNamespace(namespace);
  function toggleDeveloperMode() {
    if (!available || !ownerId || !policy) return;
    setSelection(developerMode ? null : { ownerId, generation: policy.generation, dataMode: 'live' });
  }
  function toggleTestData() {
    if (active) setSelection({ ...active, dataMode: dataMode === 'test' ? 'live' : 'test' });
  }
  return <Context.Provider value={{ dataMode, namespace, policy, generation, available, developerMode, toggleDeveloperMode, toggleTestData }}>{children}</Context.Provider>;
}
export function useTestWorkspace() {
  const context = useContext(Context);
  if (!context) throw new Error('Missing test workspace context');
  return context;
}
export function TestWorkspaceControl({ pending = false }: { pending?: boolean }) {
  const { dataMode, available, developerMode, toggleDeveloperMode, toggleTestData } = useTestWorkspace();
  if (!available) return null;
  return <>
    <button type="button" className="ui-button ui-button--secondary test-workspace-control" aria-pressed={developerMode}
      disabled={pending} onClick={toggleDeveloperMode}>Developer mode</button>
    {developerMode && <button type="button" className="ui-button ui-button--secondary test-workspace-control" aria-pressed={dataMode === 'test'}
      disabled={pending} onClick={toggleTestData}>Test data</button>}
  </>;
}
