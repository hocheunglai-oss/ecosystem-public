import { assertReleaseActionAvailable } from './lib/ecoRelease';
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  applyAction,
  type Action,
  type ActionReferences,
  type Actor,
  type DemoState,
} from "./lib/model";
import { readWorkspaceState } from './lib/testWorkspace';
import { useTestWorkspace } from './TestWorkspace';
import { useAccess } from './auth';
import { isCurrentWorkspace } from './lib/testWorkspaceGuard';
import type { AccessUser } from '../shared/access';
import { actorFromAccess } from './lib/accessActor';
import { assertPreviewWritable, isPreviewReadOnly } from './lib/previewGuard';
import { assertLocalCommercialAction } from './lib/commercialLocalGuard';
import { isLocationAction, useSharedLocationKnowledge } from './lib/useSharedLocationKnowledge';
import { initialLocationSnapshot, locationStateWithSnapshot, readLegacyLocationCandidate } from './lib/sharedLocationKnowledge';
import { locationKnowledgeApi, type LocationKnowledgeEnvelope } from './lib/locationKnowledgeApi';
type Toast = { message: string; error?: boolean };
type Store = {
  state: DemoState;
  actor: Actor;
  run: (action: Action, success?: string, references?: ActionReferences) => boolean;
  runKnowledge: (action: Action, success?: string, references?: ActionReferences) => Promise<boolean>;
  locations: ReturnType<typeof useSharedLocationKnowledge> & { migrationError: string };
  notify: (message: string, error?: boolean) => void;
  toast: Toast | null;
  storageWarning: boolean;
};
const Context = createContext<Store | null>(null);
export function DemoProvider({ children, user }: { children: ReactNode; user?: AccessUser | null }) {
  const { realUser } = useAccess();
  const { namespace, dataMode, policy } = useTestWorkspace();
  // The original LIVE state remains untouched as a recovery source. New local
  // state excludes the authoritative location slice, which is loaded per session.
  const legacyKey = `${namespace}:state`;
  const KEY = dataMode === 'live' ? `${namespace}:state:v2` : legacyKey;
  const [legacy] = useState(() => {
    if (dataMode !== 'live' || !realUser) return { candidate: null, error: '' };
    try {
      const raw = localStorage.getItem(legacyKey);
      return { candidate: readLegacyLocationCandidate({ ownerId: realUser.id, namespace, raw }), error: '' };
    } catch (error) { return { candidate: null, error: error instanceof Error ? error.message : 'Browser data could not be read. The original is retained.' }; }
  });
  const [state, setState] = useState<DemoState>(() => {
    let raw: string | null = null;
    try { raw = localStorage.getItem(KEY) ?? localStorage.getItem(legacyKey); } catch { /* Storage is optional for reading. */ }
    return withProfile(readWorkspaceState(raw, dataMode, realUser, policy));
  });
  function withProfile(value: DemoState): DemoState {
    if (user) value.profiles = { ...value.profiles, [user.id]: { email: user.email, phone: user.phone ?? value.profiles?.[user.id]?.phone ?? '' } };
    return value;
  }
  const ref = useRef(state);
  const accessRef = useRef(user);
  accessRef.current = user;
  const actor: Actor = user ? actorFromAccess(user) : { id: 'signed-out', name: '', role: 'trader' };
  const [toast, setToast] = useState<Toast | null>(null);
  const [storageWarning, setStorageWarning] = useState(false);
  function acceptLocations(value: LocationKnowledgeEnvelope) {
    const next = locationStateWithSnapshot(ref.current, value.snapshot);
    ref.current = next; setState(next);
  }
  const locations = useSharedLocationKnowledge({ enabled: dataMode === 'live', namespace, user: realUser, accept: acceptLocations,
    legacy: legacy.candidate?.snapshot ?? null, notify });
  function persisted(value: DemoState) {
    return JSON.stringify(dataMode === 'live' ? locationStateWithSnapshot(value, initialLocationSnapshot()) : value);
  }
  useEffect(() => {
    if (!realUser || !isCurrentWorkspace(namespace) || isPreviewReadOnly()) return;
    try {
      localStorage.setItem(KEY, persisted(state));
      setStorageWarning(false);
    } catch {
      setStorageWarning(true);
    }
  }, [state, KEY, realUser]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  function notify(message: string, error = false) {
    setToast({ message, error });
  }
  function run(action: Action, success?: string, references?: ActionReferences) {
    try {
      assertPreviewWritable();
      if (!isCurrentWorkspace(namespace)) throw new Error('Workspace changed. Try again.');
      if (!accessRef.current?.isActive || !accessRef.current.activated) throw new Error('Sign in with an active account.');
      assertLocalCommercialAction(action, dataMode);
      if (dataMode === 'live' && isLocationAction(action, ref.current)) throw new Error('Use the shared save for country and port information.');
      assertReleaseActionAvailable(action, ref.current, accessRef.current);
      const next = applyAction(ref.current, action, actor, undefined, references);
      // Persist requests and attachments before their forms report success.
      try {
        localStorage.setItem(KEY, persisted(next));
        setStorageWarning(false);
      } catch {
        setStorageWarning(true);
        throw new Error('Changes could not be saved in this browser. Free some browser storage or remove attachments, then try again.');
      }
      ref.current = next;
      setState(next);
      if (success) notify(success);
      return true;
    } catch (e) {
      notify(
        e instanceof Error ? e.message : "This action could not be completed.",
        true,
      );
      return false;
    }
  }
  async function runKnowledge(action: Action, success?: string, references?: ActionReferences): Promise<boolean> {
    let shared = isLocationAction(action, ref.current);
    if (dataMode === 'live' && action.type === 'review-contribution' && !ref.current.contributions.some(item => item.id === action.id)) {
      try { const { item } = await locationKnowledgeApi.contribution(action.id); shared = ['country', 'port', 'area'].includes(item.targetType); }
      catch (cause) { notify(cause instanceof Error ? cause.message : 'Update unavailable.', true); return false; }
    }
    if (dataMode !== 'live' || !shared) return run(action, success, references);
    const saved = await locations.write(action);
    if (saved && success) notify(success);
    return saved;
  }
  return (
    <Context.Provider
      value={{
        state,
        actor,
        run,
        runKnowledge,
        locations: { ...locations, migrationError: legacy.error },
        notify,
        toast,
        storageWarning,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useDemo() {
  const store = useContext(Context);
  if (!store) throw new Error("Missing demo context");
  return store;
}
