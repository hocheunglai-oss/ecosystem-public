import { useTestWorkspace } from '../TestWorkspace';
import { assertLiveDataWritable, isTestWorkspace } from './testWorkspaceGuard';
import { useCallback, useEffect, useState } from 'react';
import type { ProfileTarget, ProfileTabCollection, ProfileTab } from '../../shared/profileTabs';
import { useAccess } from '../auth';
import { assertPreviewWritable } from './previewGuard';
export interface ProfileTabsSave { requestId: string; target: ProfileTarget; visibility: 'shared' | 'private'; revision: number; tabs: ProfileTab[] }
async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  if (body !== undefined) { assertPreviewWritable(); assertLiveDataWritable(); }
  const response = await fetch(`/api/profile-tabs/${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Eco-Request': '1' }, body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
  const result = await response.json().catch(() => ({ message: 'Profile tabs unavailable.' }));
  if (!response.ok) throw Object.assign(new Error(result.message ?? 'Profile tabs unavailable.'), { status: response.status });
  return result as T;
}
export const profileTabsApi = {
  list: async (target: ProfileTarget, signal?: AbortSignal): Promise<ProfileTabCollection> => {
    if (isTestWorkspace() && target.kind === 'buyer') return { target, shared: { revision: 0, tabs: [] }, private: { revision: 0, tabs: [] } };
    const result = await request<ProfileTabCollection>(`list?kind=${encodeURIComponent(target.kind)}&id=${encodeURIComponent(target.id)}`, undefined, signal);
    return isTestWorkspace() ? { ...result, private: { revision: 0, tabs: [] } } : result;
  },
  save: (input: ProfileTabsSave) => request<ProfileTabCollection>('save', input),
};
export function useProfileTabs(target: ProfileTarget, enabled = true) {
  const { dataMode } = useTestWorkspace();
  enabled = enabled && !(dataMode === 'test' && target.kind === 'buyer');
  const { realUser, preview } = useAccess(), key = `${dataMode}:${realUser?.id ?? ''}:${Boolean(preview)}:${enabled}:${target.kind}:${target.id}`;
  const [state, setState] = useState<{ key: string; data: ProfileTabCollection | null; error: string; loading: boolean }>({ key: '', data: null, error: '', loading: false });
  const [generation, setGeneration] = useState(0);
  const refresh = useCallback(() => setGeneration(value => value + 1), []);
  useEffect(() => {
    if (!enabled || !realUser) { setState({ key, data: null, error: '', loading: false }); return; }
    const controller = new AbortController(); setState({ key, data: null, error: '', loading: true });
    void profileTabsApi.list(target, controller.signal).then(data => { if (!controller.signal.aborted) setState({ key, data, error: '', loading: false }); }).catch(error => { if (!controller.signal.aborted) setState({ key, data: null, error: error.message, loading: false }); });
    return () => controller.abort();
  }, [key, generation]);
  const accept = (data: ProfileTabCollection) => { if (data.target.kind === target.kind && data.target.id === target.id) setState({ key, data, error: '', loading: false }); };
  return { data: state.key === key ? state.data : null, error: state.key === key ? state.error : '', loading: enabled && (state.key !== key || state.loading), refresh, accept };
}
