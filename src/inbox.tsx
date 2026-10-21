import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useDemo } from "./store";
import { incomingScenarioText, type IncomingScenarioId } from "./lib/incomingScenarios";
import type { Actor, DemoState } from "./lib/model";
import { actors, canTrade, contactsFor, normalizeContact } from "./lib/model";
import { isPreviewReadOnly } from './lib/previewGuard';
import { useTestWorkspace } from './TestWorkspace';
import { useAccess } from './auth';
import { inboxApi } from './lib/inboxApi';
import { createInboxPolling, type InboxRefreshResult } from './lib/inboxPolling';
import type { IncomingEnquiry as SharedIncomingEnquiry, InboxMutation } from '../shared/inbox';
import { isCurrentWorkspace } from './lib/testWorkspaceGuard';
import { isAccessActor } from './lib/accessActor';
export type { DemoContact } from "./lib/model";

export const INBOX_STORAGE_KEY = "ecosystem.inbox.v2";
export const WHATSAPP_BUSINESS_DESTINATION = "+85298472818";
export type InboxChannel = "whatsapp" | "email";

// The optional relation is browser navigation only, never a server-verified enquiry.
export interface IncomingEnquiry extends Omit<SharedIncomingEnquiry, 'dismissed'> { dismissed?: boolean; enquiryId?: string }

// Synthetic mappings are defaults only; current profiles drive new arrivals.
export const demoContacts = contactsFor({});
export const normalizeInboxSender = normalizeContact;

function tradingInboxOwner(owner: string, accessActor?: Actor): boolean {
  if (accessActor) return isAccessActor(accessActor) && accessActor.id === owner && canTrade(accessActor);
  const actor = actors.find(item => item.id === owner);
  return Boolean(actor && canTrade(actor));
}

/** Persisted messages retain ownership; only trading profiles have an actionable inbox. */
export function actionableInboxItems(items: IncomingEnquiry[], owner: string, accessActor?: Actor): IncomingEnquiry[] {
  if (!tradingInboxOwner(owner, accessActor)) return [];
  return items.filter(item => item.owner === owner)
    .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
}

export function routeInboxSender(
  channel: InboxChannel,
  sender: string,
  contacts = demoContacts,
) {
  const normalized = normalizeInboxSender(channel, sender);
  const owners = [
    ...new Set(
      contacts
        .filter(
          (contact) =>
            contact.verified &&
            normalized &&
            normalizeInboxSender(
              channel,
              channel === "whatsapp" ? contact.phone : contact.email,
            ) === normalized,
        )
        .map((contact) => contact.owner),
    ),
  ];
  if (owners.length === 1 && !tradingInboxOwner(owners[0])) return { owner: null, reason: "non-trading-owner" as const };
  return {
    owner: owners.length === 1 ? owners[0] : null,
    reason:
      owners.length > 1
        ? ("ambiguous-sender" as const)
        : owners.length === 0
          ? ("unknown-sender" as const)
          : null,
  };
}

type IncomingMessage = Pick<
  IncomingEnquiry,
  "id" | "providerMessageId" | "channel" | "sender" | "rawText" | "receivedAt"
>;

export function receiveInboxMessage(
  items: IncomingEnquiry[],
  message: IncomingMessage,
  contacts = demoContacts,
) {
  const route = routeInboxSender(message.channel, message.sender, contacts);
  if (!route.owner) return { items, received: null, reason: route.reason };
  if (
    !message.id.trim() ||
    !message.providerMessageId.trim() ||
    !message.rawText.trim() ||
    message.rawText.length > 20_000 ||
    !Number.isFinite(Date.parse(message.receivedAt))
  ) {
    return { items, received: null, reason: "invalid-message" as const };
  }
  const duplicate = items.find(
    (item) =>
      item.id === message.id ||
      (item.channel === message.channel &&
        item.providerMessageId === message.providerMessageId),
  );
  if (duplicate) return { items, received: null, reason: "duplicate" as const };
  const received: IncomingEnquiry = {
    ...message,
    sender: normalizeInboxSender(message.channel, message.sender),
    owner: route.owner,
    read: false,
  };
  return { items: [received, ...items], received, reason: null };
}

export function selectInboxMessage(
  items: IncomingEnquiry[],
  id: string,
  owner: string,
  accessActor?: Actor,
) {
  const selected = tradingInboxOwner(owner, accessActor)
    ? items.find((item) => item.id === id && item.owner === owner) ?? null
    : null;
  if (!selected) return { items, selected: null };
  const next = items.map((item) =>
    item.id === selected.id ? { ...item, read: true } : item,
  );
  return {
    items: next,
    selected: next.find((item) => item.id === selected.id)!,
  };
}

export function linkInboxMessage(
  items: IncomingEnquiry[],
  id: string,
  enquiryId: string,
  owner: string,
  accessActor?: Actor,
) {
  if (!enquiryId.trim() || !tradingInboxOwner(owner, accessActor)) return items;
  return items.map((item) =>
    item.id === id && item.owner === owner
      ? { ...item, enquiryId, read: true }
      : item,
  );
}

export function dismissInboxNotification(
  items: IncomingEnquiry[],
  id: string,
  owner: string,
) {
  return items.map((item) =>
    item.id === id && item.owner === owner && !item.dismissed
      ? { ...item, dismissed: true }
      : item,
  );
}

export function clearInboxNotifications(
  items: IncomingEnquiry[],
  owner: string,
) {
  return items.map((item) =>
    item.owner === owner && !item.dismissed
      ? { ...item, dismissed: true }
      : item,
  );
}

function demoRawText(channel: InboxChannel, now: Date) {
  const start = new Date(now.getTime() + 3 * 86_400_000);
  const end = new Date(start.getTime() + 2 * 86_400_000);
  const date = (value: Date) =>
    value
      .toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "Asia/Hong_Kong",
      })
      .toUpperCase();
  return channel === "whatsapp"
    ? `Forwarded message\nBuyer: Meridian Shipping Pte Ltd\nVessel: MERIDIAN DAWN\nIMO: 9876543\nPort: Singapore\nETA: ${date(start)} - ${date(end)}\nHSFO: 350-400 MT\nVLSFO: 500-600 MT\nLSMGO: 60 MT\nRemarks: COQ REQUIRED`
    : `Forwarded email\nFrom: Purchasing <purchasing@pacific-orbit.example>\nSubject: PACIFIC LANTERN bunker enquiry\n\nBuyer: Pacific Orbit Lines KK\nVessel: PACIFIC LANTERN\nIMO: 9765433\nPort: Tokyo\nETA: ${date(start)} - ${date(end)}\nVLSFO: 400 MT\nLSMGO: 80-100 MT\nRemarks: Please confirm availability.`;
}

function uniqueId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

export function createDemoIncoming(
  channel: InboxChannel,
  owner: string,
  now = new Date(),
  messageId = uniqueId(),
  contacts = demoContacts,
  scenario?: { id: IncomingScenarioId; state: DemoState },
): IncomingMessage {
  const contact = contacts.find(
    (item) => item.owner === owner && item.verified,
  );
  if (!contact) throw new Error("No verified demo sender.");
  if (!tradingInboxOwner(owner)) throw new Error("This profile cannot receive trading enquiries.");
  return {
    id: `inbox-${messageId}`,
    providerMessageId: `demo-${channel}-${messageId}`,
    channel,
    sender: channel === "whatsapp" ? contact.phone : contact.email,
    rawText: scenario ? incomingScenarioText(scenario.state, scenario.id, now, owner) : demoRawText(channel, now),
    receivedAt: now.toISOString(),
  };
}

export function createSeedInbox(): IncomingEnquiry[] {
  return [];
}

export function deserializeInbox(raw: string, ownerId?: string): IncomingEnquiry[] | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !value ||
      typeof value !== "object" ||
      !("version" in value) ||
      value.version !== 2 ||
      !("items" in value) ||
      !Array.isArray(value.items)
    )
      return null;
    const items: IncomingEnquiry[] = [];
    for (const entry of value.items) {
      if (
        !entry ||
        typeof entry !== "object" ||
        ![
          "id",
          "providerMessageId",
          "sender",
          "owner",
          "rawText",
          "receivedAt",
        ].every((key) => typeof entry[key] === "string") ||
        !["whatsapp", "email"].includes(entry.channel) ||
        typeof entry.read !== "boolean" ||
        (entry.dismissed !== undefined &&
          typeof entry.dismissed !== "boolean") ||
        (entry.enquiryId !== undefined && typeof entry.enquiryId !== "string")
      )
        return null;
      // Ownership was established when this message arrived. Do not reroute old
      // messages after a trader edits their contact details or a demo name changes.
      if (
        !(ownerId ? entry.owner === ownerId : actors.some(actor => actor.id === entry.owner)) ||
        !entry.id.trim() || !entry.providerMessageId.trim() ||
        !entry.rawText.trim() || entry.rawText.length > 20_000 ||
        !Number.isFinite(Date.parse(entry.receivedAt)) ||
        !normalizeInboxSender(entry.channel, entry.sender) ||
        items.some(item => item.id === entry.id ||
          (item.channel === entry.channel && item.providerMessageId === entry.providerMessageId))
      ) return null;
      items.push({
        id: entry.id, providerMessageId: entry.providerMessageId,
        channel: entry.channel, sender: normalizeInboxSender(entry.channel, entry.sender),
        owner: entry.owner, rawText: entry.rawText, receivedAt: entry.receivedAt,
        read: entry.read,
        ...(entry.dismissed !== undefined ? { dismissed: entry.dismissed } : {}),
        ...(entry.enquiryId ? { enquiryId: entry.enquiryId } : {}),
      });
    }
    return items;
  } catch {
    return null;
  }
}

type InboxStore = {
  items: IncomingEnquiry[];
  notifications: IncomingEnquiry[];
  unreadCount: number;
  loading: boolean;
  busy: boolean;
  error: string;
  hasMore: boolean;
  retry: () => void;
  loadMore: () => void;
  dismiss: (id: string) => void;
  clearNotifications: () => void;
  selected: IncomingEnquiry | null;
  select: (id: string) => void;
  testAvailable: boolean;
  receiveDemo: (channel: InboxChannel, scenario?: IncomingScenarioId) => IncomingEnquiry | null;
  markLinked: (id: string, enquiryId: string) => void;
  clearSelection: () => void;
};
type Snapshot = { scope: string; items: IncomingEnquiry[]; unreadCount: number; nextCursor: string | null };
const emptySnapshot = (scope: string): Snapshot => ({ scope, items: [], unreadCount: 0, nextCursor: null });
const InboxContext = createContext<InboxStore | null>(null);

export function InboxProvider({ children }: { children: ReactNode }) {
  const { actor, state, notify } = useDemo();
  const { realUser, preview } = useAccess();
  const { namespace, dataMode } = useTestWorkspace();
  const owner = realUser?.id ?? '';
  const allowed = Boolean(realUser?.isActive && realUser.activated && owner === actor.id && !preview && !isPreviewReadOnly() && tradingInboxOwner(actor.id, actor));
  const scope = `${namespace}:${allowed ? owner : 'hidden'}`;
  const mounted = useRef(true);
  const currentScope = useRef(scope); currentScope.current = scope;
  const key = `${namespace}:inbox`;
  const testAvailable = dataMode === 'test' && allowed;
  const [snapshot, setSnapshot] = useState<Snapshot>(() => emptySnapshot(scope));
  const snapshotRef = useRef(snapshot);
  const [status, setStatus] = useState({ scope, loading: false, busy: false, error: '' });
  const [selection, setSelection] = useState<{ id: string; scope: string } | null>(null);
  const pages = useRef(1);
  const requestVersion = useRef(0);
  const readController = useRef<AbortController | null>(null);
  const polling = useRef<ReturnType<typeof createInboxPolling> | null>(null);
  const mutations = useRef(new Map<string, { input: InboxMutation; controller?: AbortController }>());
  const links = useRef<Record<string, string>>({});
  const storageFailed = useRef(false);
  const current = useCallback(() => mounted.current && allowed && currentScope.current === scope && isCurrentWorkspace(namespace) && !isPreviewReadOnly(), [allowed, scope, namespace]);
  const publish = useCallback((next: Snapshot) => { if (!current()) return; snapshotRef.current = next; setSnapshot(next); }, [current]);
  const refresh = useCallback((more = false) => polling.current?.refresh(more), []);
  const read = useCallback(async (more: boolean): Promise<InboxRefreshResult> => {
    if (!current() || dataMode !== 'live') return 'cancelled';
    const previous = snapshotRef.current.scope === scope ? snapshotRef.current : emptySnapshot(scope);
    if (more && !previous.nextCursor) return 'cancelled';
    const controller = new AbortController(); readController.current = controller;
    const version = ++requestVersion.current;
    setStatus(value => ({ ...value, scope, loading: true }));
    try {
      let cursor = more ? previous.nextCursor! : undefined;
      let collected = more ? previous.items : [];
      let result;
      const pageCount = more ? 1 : pages.current;
      for (let index = 0; index < pageCount; index++) {
        result = await inboxApi.page(owner, cursor, controller.signal);
        if (!current() || version !== requestVersion.current || controller.signal.aborted) return 'cancelled';
        const byId = new Map(collected.map(item => [item.id, item]));
        result.items.forEach(item => byId.set(item.id, item)); collected = [...byId.values()];
        if (!result.nextCursor) break;
        if (result.nextCursor === cursor) throw new Error('Inbox unavailable. Try again.');
        cursor = result.nextCursor;
      }
      if (!result) return 'cancelled';
      if (more) pages.current++;
      publish({ scope, items: collected, unreadCount: result.unreadCount, nextCursor: result.nextCursor });
      setStatus(value => ({ ...value, scope, loading: false, error: mutations.current.size ? value.error : '' }));
      return 'success';
    } catch (failure) {
      if (current() && version === requestVersion.current && !controller.signal.aborted) {
        if ([401, 403].includes((failure as { status?: number }).status ?? 0)) { publish(emptySnapshot(scope)); setSelection(null); }
        setStatus(value => ({ ...value, scope, loading: false, error: 'Inbox unavailable. Try again.' }));
        return 'failure';
      }
      return 'cancelled';
    } finally {
      if (readController.current === controller) readController.current = null;
    }
  }, [current, dataMode, owner, publish, scope]);

  useEffect(() => {
    mounted.current = true;
    let initial = emptySnapshot(scope);
    links.current = {}; pages.current = 1; mutations.current.clear();
    setSelection(null); setStatus({ scope, loading: false, busy: false, error: '' });
    if (current() && dataMode === 'test') {
      try { const saved = localStorage.getItem(key); const restored = saved ? deserializeInbox(saved, owner) : null; if (restored) initial = { ...initial, items: restored }; } catch { /* Empty TEST inbox when storage is unavailable. */ }
    }
    // LIVE never loads old local messages. Only browser navigation links are retained.
    if (current() && dataMode === 'live') {
      try {
        const saved = JSON.parse(localStorage.getItem(`${namespace}:inbox-links`) ?? 'null');
        if (saved?.version === 1 && saved.links && typeof saved.links === 'object' && !Array.isArray(saved.links))
          for (const [id, enquiryId] of Object.entries(saved.links)) if (typeof enquiryId === 'string' && enquiryId.length <= 200) links.current[id] = enquiryId;
      } catch { /* Navigation can be reconstructed after confirmation. */ }
    }
    snapshotRef.current = initial; setSnapshot(initial);
    const loop = createInboxPolling({
      read,
      canRead: () => current() && dataMode === 'live',
      canPoll: () => current() && dataMode === 'live' && !document.hidden && navigator.onLine &&
        ![...mutations.current.values()].some(value => Boolean(value.controller)),
    });
    polling.current = loop;
    loop.wake();
    const onWake = () => loop.wake();
    window.addEventListener('focus', onWake);
    window.addEventListener('online', onWake);
    window.addEventListener('offline', onWake);
    document.addEventListener('visibilitychange', onWake);
    return () => {
      mounted.current = false;
      loop.stop();
      if (polling.current === loop) polling.current = null;
      requestVersion.current++; readController.current?.abort();
      mutations.current.forEach(value => value.controller?.abort()); mutations.current.clear();
      window.removeEventListener('focus', onWake);
      window.removeEventListener('online', onWake);
      window.removeEventListener('offline', onWake);
      document.removeEventListener('visibilitychange', onWake);
    };
  }, [scope, current, dataMode, key, namespace, owner, read]);

  function updateTest(next: IncomingEnquiry[]) {
    if (!current() || !testAvailable) return false;
    publish({ ...emptySnapshot(scope), items: next });
    try { localStorage.setItem(key, JSON.stringify({ version: 2, items: next })); storageFailed.current = false; }
    catch { if (!storageFailed.current) notify('Enquiries could not be saved in this browser.', true); storageFailed.current = true; }
    return true;
  }
  async function mutate(action: InboxMutation['action'], id?: string) {
    if (!current() || dataMode !== 'live') return;
    const operationKey = `${action}:${id ?? ''}`;
    const previous = mutations.current.get(operationKey);
    if (previous?.controller && !previous.controller.signal.aborted) return;
    const input: InboxMutation = previous?.input ?? { requestId: crypto.randomUUID(), action, ...(id ? { id } : {}) };
    const controller = new AbortController(); const operation = { input, controller };
    mutations.current.set(operationKey, operation);
    const loop = polling.current; loop?.pause();
    readController.current?.abort(); requestVersion.current++;
    setStatus(value => ({ ...value, scope, busy: true, loading: false, error: '' }));
    try {
      await inboxApi.mutate(owner, input, controller.signal);
      if (!current() || controller.signal.aborted) return;
      mutations.current.delete(operationKey);
      // A replayed receipt is immutable; fetch today's count instead of applying its stale total.
      await loop?.refreshAfterCurrent();
    } catch (failure) {
      if (!current() || controller.signal.aborted) return;
      if ([401, 403].includes((failure as { status?: number }).status ?? 0)) { publish(emptySnapshot(scope)); setSelection(null); mutations.current.delete(operationKey); }
      else mutations.current.set(operationKey, { input });
      setStatus(value => ({ ...value, scope, error: 'Inbox update failed. Try again.' }));
    } finally {
      if (current() && !controller.signal.aborted) {
        setStatus(value => ({ ...value, scope, busy: [...mutations.current.values()].some(value => Boolean(value.controller)) }));
        loop?.resume();
      }
    }
  }
  const visible = current() && snapshot.scope === scope ? snapshot.items : [];
  const items = visible.map(item => ({ ...item, ...(links.current[item.id] && state.enquiries.some(enquiry => enquiry.id === links.current[item.id] && enquiry.owner === owner) ? { enquiryId: links.current[item.id] } : {}) }));
  const notifications = items.filter(item => !item.dismissed);
  const selected = selection?.scope === scope ? items.find(item => item.id === selection.id) ?? null : null;
  function select(id: string) {
    if (!current()) return;
    const result = selectInboxMessage(snapshotRef.current.items, id, owner, actor);
    if (!result.selected) return;
    setSelection({ id, scope });
    if (testAvailable) updateTest(result.items);
    else if (!snapshotRef.current.items.find(item => item.id === id)?.read) void mutate('read', id);
  }
  function receiveDemo(channel: InboxChannel, scenario: IncomingScenarioId = 'normal') {
    if (!current() || !testAvailable) return null;
    const id = uniqueId(), now = new Date();
    const received: IncomingEnquiry = { id: `test-inbox-${id}`, providerMessageId: `test-${channel}-${id}`, channel,
      sender: channel === 'email' ? 'sender@example.test' : '+85200000001', owner,
      rawText: incomingScenarioText(state, scenario, now, owner), receivedAt: now.toISOString(), read: false };
    updateTest([received, ...snapshotRef.current.items]); return received;
  }
  function markLinked(id: string, enquiryId: string) {
    if (!current() || !snapshotRef.current.items.some(item => item.id === id && item.owner === owner) || !enquiryId.trim()) return;
    if (testAvailable) { updateTest(linkInboxMessage(snapshotRef.current.items, id, enquiryId, owner, actor)); return; }
    links.current = { ...links.current, [id]: enquiryId };
    try { localStorage.setItem(`${namespace}:inbox-links`, JSON.stringify({ version: 1, links: links.current })); } catch { /* Linking is browser-local, never published. */ }
    publish({ ...snapshotRef.current });
  }
  function dismiss(id: string) {
    if (!current() || !items.some(item => item.id === id)) return;
    if (testAvailable) updateTest(dismissInboxNotification(snapshotRef.current.items, id, owner)); else void mutate('dismiss', id);
  }
  function clearNotifications() {
    if (!current()) return;
    if (testAvailable) updateTest(clearInboxNotifications(snapshotRef.current.items, owner)); else void mutate('dismiss-all');
  }
  function retry() {
    if (!current()) return;
    const pending = [...mutations.current.values()].filter(value => !value.controller);
    if (pending.length) pending.forEach(({ input }) => { void mutate(input.action, input.id); }); else void refresh();
  }
  const visibleStatus = current() && status.scope === scope ? status : { loading: false, busy: false, error: '' };
  return <InboxContext.Provider value={{ items, notifications, selected, select, dismiss, clearNotifications, receiveDemo, testAvailable, markLinked,
    unreadCount: testAvailable ? notifications.filter(item => !item.read).length : current() && snapshot.scope === scope ? snapshot.unreadCount : 0,
    ...visibleStatus, hasMore: current() && Boolean(snapshot.nextCursor), retry, loadMore: () => { void refresh(true); }, clearSelection: () => setSelection(null) }}>{children}</InboxContext.Provider>;
}

export function useInbox() {
  const context = useContext(InboxContext);
  if (!context) throw new Error("Missing inbox context");
  return context;
}
