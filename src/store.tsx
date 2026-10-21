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
type Toast = { message: string; error?: boolean };
type Store = {
  state: DemoState;
  actor: Actor;
  run: (action: Action, success?: string, references?: ActionReferences) => boolean;
  notify: (message: string, error?: boolean) => void;
  toast: Toast | null;
  storageWarning: boolean;
};
const Context = createContext<Store | null>(null);
export function DemoProvider({ children, user }: { children: ReactNode; user?: AccessUser | null }) {
  const { realUser } = useAccess();
  const { namespace, dataMode, policy } = useTestWorkspace();
  const KEY = `${namespace}:state`;
  const [state, setState] = useState<DemoState>(() => {
    let raw: string | null = null;
    try { raw = localStorage.getItem(KEY); } catch { /* Storage is optional for reading. */ }
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
  useEffect(() => {
    if (!realUser || !isCurrentWorkspace(namespace) || isPreviewReadOnly()) return;
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
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
      assertReleaseActionAvailable(action, ref.current, accessRef.current);
      const next = applyAction(ref.current, action, actor, undefined, references);
      // Persist requests and attachments before their forms report success.
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
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
  return (
    <Context.Provider
      value={{
        state,
        actor,
        run,
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
