import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { IntelligenceSnapshot } from '../shared/intelligence';
import { useAccess } from './auth';
import { useTestWorkspace } from './TestWorkspace';
import { loadIntelligenceSnapshot } from './lib/intelligenceApi';

type IntelligenceState = { snapshot: IntelligenceSnapshot | null; loading: boolean };
const Context = createContext<IntelligenceState>({ snapshot: null, loading: false });

export function IntelligenceProvider({ children }: { children: ReactNode }) {
  const { realUser, preview } = useAccess();
  const { namespace } = useTestWorkspace();
  const enabled = Boolean(realUser?.isActive && realUser.activated);
  // Remount before children render on an authority/workspace change. Nothing is
  // persisted or shared between accounts, including a late in-flight response.
  const scope = realUser ? [realUser.id, enabled, realUser.isAdmin, realUser.isSpcTrader, realUser.isManager, realUser.officeId,
    preview?.role ?? 'real', preview?.officeId ?? '', namespace].join(':') : 'signed-out';
  return <ScopedIntelligence key={scope} enabled={enabled}>{children}</ScopedIntelligence>;
}

function ScopedIntelligence({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [state, setState] = useState<IntelligenceState>({ snapshot: null, loading: enabled });
  useEffect(() => {
    if (!enabled) return;
    let disposed = false, epoch = 0;
    let current: AbortController | undefined;
    async function refresh() {
      const request = ++epoch;
      current?.abort();
      const controller = new AbortController(); current = controller;
      if (!navigator.onLine) { setState({ snapshot: null, loading: false }); return; }
      setState(value => ({ ...value, loading: true }));
      try {
        const result = await loadIntelligenceSnapshot(controller.signal);
        if (!disposed && request === epoch && !controller.signal.aborted) setState({ snapshot: result.snapshot, loading: false });
      } catch {
        if (!disposed && request === epoch && !controller.signal.aborted) setState({ snapshot: null, loading: false });
      }
    }
    function offline() { ++epoch; current?.abort(); setState({ snapshot: null, loading: false }); }
    const focus = () => { if (!document.hidden) void refresh(); };
    void refresh();
    const interval = window.setInterval(focus, 300_000);
    window.addEventListener('focus', focus); window.addEventListener('online', focus); window.addEventListener('offline', offline);
    return () => {
      disposed = true; ++epoch; current?.abort(); window.clearInterval(interval);
      window.removeEventListener('focus', focus); window.removeEventListener('online', focus); window.removeEventListener('offline', offline);
    };
  }, [enabled]);
  return <Context.Provider value={state}>{children}</Context.Provider>;
}
export const useIntelligence = () => useContext(Context);
