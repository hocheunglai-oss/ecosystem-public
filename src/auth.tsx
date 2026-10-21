import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AccessUser, AccessSession, PreviewInput, RolePreview } from '../shared/access';
import { projectPreviewUser } from '../shared/rolePreview';
import { assertPreviewWritable, setPreviewReadOnly, setSessionUnavailable } from './lib/previewGuard';
import { assertLiveDataWritable } from './lib/testWorkspaceGuard';

export async function accessRequest<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  if (body !== undefined) {
    // Credentials establish authority independently of a failed session check.
    // Authenticated account/data mutations still wait for verified authority.
    if (!['login', 'activate', 'preview', 'preview/end', 'logout'].includes(path)) assertPreviewWritable();
    if (!['login', 'activate', 'password', 'password-prompt', 'logout', 'preview', 'preview/end'].includes(path)) {
      // Account management and contact approval always affect real members.
      // Mark a local rejection as definite so Users & Access does not create an uncertain-operation retry.
      try { assertLiveDataWritable(); } catch (failure) { throw Object.assign(failure as Error, { status: 403 }); }
    }
  }
  const response = await fetch(`/api/access/${path}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Eco-Request': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
  });
  const result = await response.json().catch(() => ({ message: 'Access service unavailable.' }));
  if (!response.ok) throw Object.assign(new Error(result.message ?? 'Sign in required.'), { status: response.status, ...(['failed', 'pending'].includes(result.operationState) ? { operationState: result.operationState as 'failed' | 'pending' } : {}) });
  return result as T;
}
type Access = { user: AccessUser | null; realUser: AccessUser | null; preview: RolePreview | null; loading: boolean; error: string; refresh(): Promise<void>;
  signIn(email: string, password: string): Promise<void>; activate(tokenHash: string, password: string, type: 'invite' | 'recovery'): Promise<void>;
  changePassword(currentPassword: string, newPassword: string): Promise<void>; dismissPasswordPrompt(): Promise<void>;
  startPreview(input: PreviewInput): Promise<void>; endPreview(): Promise<void>; signOut(): Promise<void> };
const Context = createContext<Access | null>(null);
export function AccessProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<{ user: AccessUser | null; realUser: AccessUser | null; preview: RolePreview | null }>({ user: null, realUser: null, preview: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const mutating = useRef(false);
  const refreshAfterMutation = useRef(false);
  const refreshing = useRef<{ promise: Promise<void>; controller: AbortController } | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const retryCount = useRef(0);
  const sessionRef = useRef(session);
  const channel = useRef<BroadcastChannel | null>(null);
  function acceptSession(result: { user: AccessUser; preview?: RolePreview | null }) {
    const preview = result.preview ?? null;
    const next = { realUser: result.user, user: projectPreviewUser(result.user, preview), preview };
    const previous = sessionRef.current.preview;
    const viewChanged = previous?.role !== preview?.role || previous?.officeId !== preview?.officeId;
    setSessionUnavailable(false); setPreviewReadOnly(Boolean(preview)); sessionRef.current = next; setSession(next);
    if (viewChanged) requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
  }
  function clearSession() {
    const next = { user: null, realUser: null, preview: null };
    setSessionUnavailable(false); setPreviewReadOnly(false); sessionRef.current = next; setSession(next);
  }
  function stopRefresh() {
    clearTimeout(retryTimer.current);
    refreshing.current?.controller.abort();
    refreshing.current = null;
  }
  const refresh = useCallback((): Promise<void> => {
    if (mutating.current) return Promise.resolve();
    if (refreshing.current) return refreshing.current.promise;
    clearTimeout(retryTimer.current);
    const current = ++generation.current;
    const controller = new AbortController();
    const operation = (async () => {
    try {
      const result = await accessRequest<AccessSession>('session', undefined, controller.signal);
      if (current === generation.current) { acceptSession(result); setError(''); retryCount.current = 0; }
    } catch (failure) {
      if (current === generation.current) {
        if ((failure as { status?: number }).status === 401) {
          clearSession(); setError(''); retryCount.current = 0;
        } else {
          // Keep the already verified in-memory view during a transient outage.
          // Freeze local writes until live authority is checked again. Every API
          // still verifies its session; no identity is restored from storage.
          setSessionUnavailable(true);
          setError('Connection unavailable. Reconnecting…');
          const delay = Math.min(30_000, 2_000 * 2 ** Math.min(retryCount.current++, 4));
          retryTimer.current = setTimeout(() => { void refresh(); }, delay);
        }
      }
    } finally {
      if (refreshing.current?.controller === controller) refreshing.current = null;
      if (current === generation.current) setLoading(false);
    }
    })();
    refreshing.current = { promise: operation, controller };
    return operation;
  }, []);
  useEffect(() => {
    // Browser-local demo identity is never accepted as authentication.
    try { sessionStorage.removeItem('ecosystem.session.v1'); } catch { /* storage is optional */ }
    void refresh();
    const focus = () => { void refresh(); };
    const visible = () => { if (!document.hidden) void refresh(); };
    window.addEventListener('focus', focus);
    window.addEventListener('online', focus);
    document.addEventListener('visibilitychange', visible);
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 30_000);
    return () => {
      generation.current++; stopRefresh();
      window.removeEventListener('focus', focus); window.removeEventListener('online', focus);
      document.removeEventListener('visibilitychange', visible); window.clearInterval(timer);
    };
  }, [refresh]);
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const connection = new BroadcastChannel('eco-access-invalidation');
    channel.current = connection;
    connection.onmessage = () => {
      // Cross-tab messages carry no identity, roles or permissions. Only a fresh
      // authenticated server response can restore access after invalidation.
      setPreviewReadOnly(true);
      generation.current++;
      stopRefresh();
      if (mutating.current) refreshAfterMutation.current = true;
      else void refresh();
    };
    return () => { channel.current = null; connection.close(); };
  }, [refresh]);
  async function authenticate(path: string, body: unknown) {
    if (mutating.current) throw new Error('Wait for the current request to finish.');
    mutating.current = true;
    const current = ++generation.current;
    stopRefresh();
    try {
      const result = await accessRequest<{ user: AccessUser; preview?: RolePreview | null }>(path, body);
      if (current === generation.current) { acceptSession(result); setError(''); setLoading(false); }
    } finally {
      mutating.current = false;
      if (refreshAfterMutation.current) {
        refreshAfterMutation.current = false;
        await refresh();
      }
    }
  }
  async function signOut() {
    if (mutating.current) throw new Error('Wait for the current request to finish.');
    mutating.current = true; generation.current++;
    stopRefresh();
    try { await accessRequest('logout', {}); generation.current++; clearSession(); setError(''); channel.current?.postMessage('refresh-needed'); }
    finally {
      mutating.current = false;
      if (refreshAfterMutation.current) {
        refreshAfterMutation.current = false;
        await refresh();
      }
    }
  }
  async function changePreview(input: PreviewInput | null) {
    if (!sessionRef.current.realUser?.isAdmin) throw new Error('Access denied.');
    if (mutating.current) throw new Error('Wait for the current request to finish.');
    // Freeze local mutations before a server preview transition can take effect.
    setPreviewReadOnly(true);
    try { await authenticate(input ? 'preview' : 'preview/end', input ?? {}); channel.current?.postMessage('refresh-needed'); }
    catch (failure) {
      // An uncertain response may already have changed the server session. Refresh
      // from the server before restoring local mutation access.
      await refresh();
      channel.current?.postMessage('refresh-needed');
      throw failure;
    }
  }
  return <Context.Provider value={{ ...session, loading, error, refresh,
    signIn: (email, password) => authenticate('login', { email, password }),
    changePassword: (currentPassword, newPassword) => { assertPreviewWritable(); return authenticate('password', { currentPassword, newPassword }); },
    dismissPasswordPrompt: () => { assertPreviewWritable(); return authenticate('password-prompt', {}); },
    activate: (tokenHash, password, type) => authenticate('activate', { tokenHash, password, type }),
    startPreview: input => changePreview(input), endPreview: () => changePreview(null), signOut }}>{children}</Context.Provider>;
}
export function useAccess(): Access {
  const value = useContext(Context);
  if (!value) throw new Error('Missing access context.');
  return value;
}
