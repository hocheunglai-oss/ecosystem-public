import { useTestWorkspace } from './TestWorkspace';
import { useCallback, useRef, useState } from 'react';
import type { ProfileTab, ProfileTabCollection, ProfileTarget } from '../shared/profileTabs';
import { useAccess } from './auth';
import { ManageProfileTabs, ProfileTabContent, type ProfileTabDescriptor, type ProfileTabEditorNavigation } from './ProfileTabs';
import { profileTabsApi, useProfileTabs } from './lib/profileTabsApi';

/** Private collections never enter the local knowledge store, search, history or Hats. */
export function usePrivateProfileTabs(target: ProfileTarget, enabled = true) {
  const { realUser, preview } = useAccess();
  const { dataMode, namespace } = useTestWorkspace();
  const allowed = Boolean(enabled && realUser?.isActive && !preview && dataMode === 'live');
  const identityKey = `${namespace}:${realUser?.id ?? ''}:${allowed}:${target.kind}:${target.id}`;
  const epoch = useRef({ key: identityKey, value: 0 });
  if (epoch.current.key !== identityKey) epoch.current = { key: identityKey, value: epoch.current.value + 1 };
  const scopeKey = `${identityKey}:${epoch.current.value}`;
  const currentScope = useRef(scopeKey); currentScope.current = scopeKey;
  const remote = useProfileTabs(target, allowed);
  const [managerState, setManager] = useState<{ key: string; base: ProfileTabCollection } | null>(null);
  const [dirtyState, setDirty] = useState<{ key: string; value: boolean }>({ key: '', value: false });
  const attempt = useRef<{ key: string; body: string; id: string } | null>(null);
  const dirty = dirtyState.key === scopeKey && dirtyState.value;
  const setContentDirty = useCallback((value: boolean) => setDirty(current => current.key === scopeKey && current.value === value ? current : { key: scopeKey, value }), [scopeKey]);
  const leave = (action: () => void) => { if (!dirty || window.confirm('Discard unsaved tab changes?')) { setDirty({ key: scopeKey, value: false }); action(); } };
  async function save(tabs: ProfileTab[], base: ProfileTabCollection) {
    if (!allowed || currentScope.current !== scopeKey) throw new Error('Private tabs unavailable.');
    const payload = { target, visibility: 'private' as const, revision: base.private.revision, tabs };
    const body = JSON.stringify(payload);
    if (attempt.current?.key !== scopeKey || attempt.current.body !== body) attempt.current = { key: scopeKey, body, id: crypto.randomUUID() };
    const result = await profileTabsApi.save({ ...payload, requestId: attempt.current.id });
    if (currentScope.current !== scopeKey) return false;
    remote.accept(result); attempt.current = null; return result;
  }
  return {
    scopeKey, allowed, data: allowed ? remote.data : null, tabs: allowed ? remote.data?.private.tabs ?? [] : [],
    error: remote.error, loading: remote.loading, dirty, leave, save,
    setDirty: setContentDirty,
    manager: allowed && managerState?.key === scopeKey ? managerState.base : null,
    openManager: () => leave(() => { if (allowed && remote.data) setManager({ key: scopeKey, base: structuredClone(remote.data) }); }),
    openManagerAfterDiscard: () => { if (allowed && remote.data) { setDirty({ key: scopeKey, value: false }); setManager({ key: scopeKey, base: structuredClone(remote.data) }); } },
    closeManager: () => setManager(null),
    reload: () => leave(() => { setManager(null); attempt.current = null; remote.refresh(); }),
  };
}
export type PrivateProfileTabsController = ReturnType<typeof usePrivateProfileTabs>;
type Controller = PrivateProfileTabsController;
export function PrivateProfileTabsManager({ controller, onSaved, sharedTabs = [] }: { controller: Controller; onSaved: (tabs: ProfileTab[]) => void; sharedTabs?: readonly ProfileTabDescriptor[] }) {
  const base = controller.manager;
  if (!base) return null;
  return <ManageProfileTabs key={`${controller.scopeKey}:${base.private.revision}`} tabs={[...base.private.tabs.map(tab => ({ ...tab, entryCount: tab.content?.trim() ? 1 : 0 })), ...sharedTabs.map(tab => ({ ...tab, visibility: 'shared' as const }))]}
    canManageShared={false} canManagePrivate={controller.allowed}
    createTab={tab => ({ id: tab.id, title: tab.title, visibility: 'private' as const, content: '', entryCount: 0 })}
    onSave={async tabs => { const records: ProfileTab[] = tabs.filter(tab => tab.visibility === 'private').map(tab => ({ id: tab.id, title: tab.title, visibility: 'private', content: tab.content ?? '' })); if (!await controller.save(records, base)) throw new Error('Workspace changed. Try again.'); onSaved(records); }}
    onClose={controller.closeManager} onReload={controller.reload} />;
}
export function PrivateProfileTabPanel({ controller, tab, ...navigation }: ProfileTabEditorNavigation & { controller: Controller; tab: ProfileTab }) {
  // Capture the edit revision. A concurrent change must conflict, never be silently overwritten.
  const [base] = useState(() => structuredClone(controller.data!));
  const [conflict, setConflict] = useState(false);
  return <>{conflict && <button type="button" className="button secondary" onClick={controller.reload}>Reload latest</button>}<ProfileTabContent {...navigation} tab={tab} canEdit={controller.allowed} onDirtyChange={controller.setDirty}
    onSave={async content => { try { if (!await controller.save(base.private.tabs.map(entry => entry.id === tab.id ? { ...entry, content } : entry), base)) throw new Error('Workspace changed. Try again.'); } catch (failure) { setConflict((failure as { status?: number }).status === 409); throw failure; } }} /></>;
}
export function PrivateProfileTabsStatus({ controller }: { controller: Controller }) {
  return controller.allowed && controller.error ? <p role="alert">{controller.error} <button type="button" className="button secondary" onClick={controller.reload}>Retry</button></p> : null;
}
