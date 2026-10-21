import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AccessUser, AccessSession, PreviewInput, RolePreview } from '../shared/access';
import { projectPreviewUser } from '../shared/rolePreview';
import { assertPreviewWritable, setPreviewReadOnly } from './lib/previewGuard';
import { assertLiveDataWritable } from './lib/testWorkspaceGuard';

export async function accessRequest<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  if (body !== undefined) {
    if (!['preview', 'preview/end', 'logout'].includes(path)) assertPreviewWritable();
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
  const sessionRef = useRef(session);
  const channel = useRef<BroadcastChannel | null>(null);
  function acceptSession(result: { user: AccessUser; preview?: RolePreview | null }) {
    const preview = result.preview ?? null;
    const next = { realUser: result.user, user: projectPreviewUser(result.user, preview), preview };
    const previous = sessionRef.current.preview;
    const viewChanged = previous?.role !== preview?.role || previous?.officeId !== preview?.officeId;
    setPreviewReadOnly(Boolean(preview)); sessionRef.current = next; setSession(next);
    if (viewChanged) requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
  }
  function clearSession() {
    const next = { user: null, realUser: null, preview: null };
    setPreviewReadOnly(false); sessionRef.current = next; setSession(next);
  }
  const refresh = useCallback(async () => {
    if (mutating.current) return;
    const current = ++generation.current;
    try {
      const result = await accessRequest<AccessSession>('session');
      if (current === generation.current) { acceptSession(result); setError(''); }
    } catch (failure) {
      if (current === generation.current) {
        clearSession();
        setError((failure as { status?: number }).status === 401 ? '' : 'Sign-in is not available yet.');
      }
    } finally { if (current === generation.current) setLoading(false); }
  }, []);
  useEffect(() => {
    // Browser-local demo identity is never accepted as authentication.
    try { sessionStorage.removeItem('ecosystem.session.v1'); } catch { /* storage is optional */ }
    void refresh();
    const focus = () => { void refresh(); };
    window.addEventListener('focus', focus);
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 30_000);
    return () => { generation.current++; window.removeEventListener('focus', focus); window.clearInterval(timer); };
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
      if (mutating.current) refreshAfterMutation.current = true;
      else void refresh();
    };
    return () => { channel.current = null; connection.close(); };
  }, [refresh]);
  async function authenticate(path: string, body: unknown) {
    if (mutating.current) throw new Error('Wait for the current request to finish.');
    mutating.current = true;
    const current = ++generation.current;
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
    activate: (tokenHash, password, type) => { assertPreviewWritable(); return authenticate('activate', { tokenHash, password, type }); },
    startPreview: input => changePreview(input), endPreview: () => changePreview(null), signOut }}>{children}</Context.Provider>;
}
export function useAccess(): Access {
  const value = useContext(Context);
  if (!value) throw new Error('Missing access context.');
  return value;
}
