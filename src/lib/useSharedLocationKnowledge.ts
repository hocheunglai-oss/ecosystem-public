import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AccessUser } from '../../shared/access';
import type { Action, DemoState } from './model';
import { locationKnowledgeApi, type LocationKnowledgeEnvelope, type LocationKnowledgeWrite } from './locationKnowledgeApi';
import { isCurrentWorkspace } from './testWorkspaceGuard';
import { assertPreviewWritable } from './previewGuard';
import { canonicalLocationSnapshotJson, mergeLegacyLocationSnapshot, type LocationConflict, type LocationSnapshot } from './sharedLocationKnowledge';

/** These responses establish an invalid/uncommitted request in the current API.
 * Authentication/permission failures cannot resolve an earlier lost response:
 * they occur before the server consults that actor's durable receipt. */
export function isDefinitiveLocationWriteFailure(status: unknown): boolean {
  return typeof status === 'number' && [400, 409, 413, 415, 422].includes(status);
}
export async function locationImportDigest(snapshot: LocationSnapshot): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalLocationSnapshotJson(snapshot));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function locationImportAssessment(current: LocationSnapshot | undefined, legacy: LocationSnapshot | null): { conflicts: LocationConflict[]; error: string } {
  if (!current || !legacy) return { conflicts: [], error: '' };
  try { return { conflicts: mergeLegacyLocationSnapshot(current, legacy).conflicts, error: '' }; }
  catch (cause) { return { conflicts: [], error: cause instanceof Error && cause.message.length <= 240 ? cause.message : 'The browser archive could not be reviewed. The original is retained.' }; }
}

export function isLocationAction(action: Action, state: DemoState): boolean {
  switch (action.type) {
    case 'add-location': case 'save-port-information': case 'save-extracted-knowledge': return true;
    case 'save-knowledge': case 'suggest-knowledge': return ['country', 'port', 'area'].includes(action.change.target.kind);
    case 'manage-knowledge-tabs': return action.changes.some(change => ['country', 'port', 'area'].includes(change.target.kind));
    case 'submit-contribution': return ['country', 'port', 'area'].includes(action.targetType);
    case 'review-contribution': return state.contributions.some(item => item.id === action.id && ['country', 'port', 'area'].includes(item.targetType));
    default: return false;
  }
}

/** Writes remain pending after ambiguous failures; changing a draft never changes a retry. */
export function useSharedLocationKnowledge({ enabled, namespace, user, accept, legacy, notify }: {
  enabled: boolean; namespace: string; user: AccessUser | null | undefined;
  accept: (value: LocationKnowledgeEnvelope) => void;
  legacy: LocationSnapshot | null;
  notify: (message: string, error?: boolean) => void;
}) {
  const [data, setData] = useState<LocationKnowledgeEnvelope | null>(null);
  const dataRef = useRef(data);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const active = useRef(true);
  const sequence = useRef(0);
  const pendingKey = `${namespace}:location-pending:v1`;
  const migratedKey = `${namespace}:location-imported:v1`;
  const [pending, setPending] = useState<LocationKnowledgeWrite | null>(() => {
    if (!enabled) return null;
    try {
      const value = JSON.parse(localStorage.getItem(pendingKey) || 'null');
      return value?.dataMode === 'live' && typeof value.requestId === 'string' && Number.isSafeInteger(value.revision) && ('action' in value || 'snapshot' in value) ? value : null;
    } catch { return null; }
  });
  const pendingRef = useRef(pending);
  const [imported, setImported] = useState(() => { try { return localStorage.getItem(migratedKey) || ''; } catch { return ''; } });
  const [digestState, setDigestState] = useState<{ identity: string; digest: string; error: string } | null>(null);
  const acceptRef = useRef(accept); acceptRef.current = accept;
  const legacyIdentity = useMemo(() => legacy ? JSON.stringify(legacy) : '', [legacy]);
  const migrationDigest = digestState?.identity === legacyIdentity ? digestState.digest : '';
  const migrationDigestError = digestState?.identity === legacyIdentity ? digestState.error : '';
  const sourceImported = Boolean(legacy && (imported === legacyIdentity || migrationDigest && (imported === `sha256:${migrationDigest}` || data?.importedSources?.some(source => source.digest === migrationDigest))));
  // Wait for the canonical digest rather than briefly offering an already
  // imported archive while the asynchronous hash is still being calculated.
  const migration = legacy && migrationDigest && !sourceImported ? legacy : null;
  useEffect(() => {
    let cancelled = false;
    if (!enabled || !legacy) { setDigestState(null); return; }
    void locationImportDigest(legacy).then(digest => { if (!cancelled) setDigestState({ identity: legacyIdentity, digest, error: '' }); }, () => {
      if (!cancelled) setDigestState({ identity: legacyIdentity, digest: '', error: 'The browser archive could not be checked. The original is retained.' });
    });
    return () => { cancelled = true; };
  }, [enabled, legacy, legacyIdentity]);
  const valid = () => active.current && isCurrentWorkspace(namespace);
  function accepted(value: LocationKnowledgeEnvelope) {
    if (!valid() || value.revision < (dataRef.current?.revision ?? -1)) return;
    dataRef.current = value; setData(value); setError(''); setLoading(false); acceptRef.current(value);
  }
  const refresh = useCallback(async () => {
    if (!enabled || !user?.isActive || inFlight.current) return;
    const request = ++sequence.current;
    try {
      const value = await locationKnowledgeApi.list();
      if (valid() && request === sequence.current) accepted(value);
    } catch (cause) {
      if (valid() && request === sequence.current) { setError(cause instanceof Error ? cause.message : 'Shared country and port data unavailable.'); setLoading(false); }
    }
  }, [enabled, namespace, user?.id]);
  useEffect(() => {
    active.current = true;
    if (!enabled) { setLoading(false); return () => { active.current = false; }; }
    void refresh();
    const visible = () => { if (!document.hidden) void refresh(); };
    const timer = window.setInterval(visible, 30_000);
    window.addEventListener('focus', visible); document.addEventListener('visibilitychange', visible);
    return () => { active.current = false; sequence.current++; clearInterval(timer); window.removeEventListener('focus', visible); document.removeEventListener('visibilitychange', visible); };
  }, [enabled, refresh]);

  async function send(input: LocationKnowledgeWrite): Promise<boolean> {
    if (inFlight.current) return false;
    let started = false;
    try {
      assertPreviewWritable();
      if (!enabled || !valid() || !user?.isActive || !user.activated) throw new Error('Shared country and port data unavailable.');
      // Durably retain the exact request before any network operation.
      localStorage.setItem(pendingKey, JSON.stringify(input));
      pendingRef.current = input; setPending(input);
      inFlight.current = true; started = true; setBusy(true); sequence.current++;
      const value = await locationKnowledgeApi.write(input);
      if (!valid()) return false;
      accepted(value);
      if ('snapshot' in input) {
        const receipt = value.importedSources?.find(source => source.requestId === input.requestId && source.importedBy === user.id);
        const identity = receipt?.digest ? `sha256:${receipt.digest}` : JSON.stringify(input.snapshot);
        setImported(identity);
        try { localStorage.setItem(migratedKey, identity); } catch { /* Server receipt still makes an exact retry safe. */ }
      }
      pendingRef.current = null; setPending(null);
      try { localStorage.removeItem(pendingKey); } catch { /* A reload retries the acknowledged request, never reapplies it. */ }
      return true;
    } catch (cause) {
      if (!valid()) return false;
      const status = (cause as { status?: number })?.status;
      const definitive = isDefinitiveLocationWriteFailure(status);
      if (started && definitive) {
        pendingRef.current = null; setPending(null);
        try { localStorage.removeItem(pendingKey); } catch { /* Keep original content intact. */ }
      }
      const message = cause instanceof Error ? cause.message : 'Save could not be confirmed. Retry the same save.';
      setError(message); notify(message, true);
      return false;
    } finally {
      if (started) { inFlight.current = false; if (valid()) setBusy(false); }
    }
  }
  async function write(action: Action): Promise<boolean> {
    if (!dataRef.current) { notify('Shared country and port data unavailable.', true); return false; }
    const prior = pendingRef.current;
    if (prior && (!('action' in prior) || JSON.stringify(prior.action) !== JSON.stringify(action))) {
      notify('Retry the previous save before making another change. Your draft is retained.', true); return false;
    }
    const success = await send(prior ?? { requestId: crypto.randomUUID(), revision: dataRef.current.revision, dataMode: 'live', action });
    if (!success && !pendingRef.current) await refresh();
    return success;
  }
  async function importLegacy(): Promise<boolean> {
    if (!user?.isAdmin || !migration || !dataRef.current || pendingRef.current) return false;
    const success = await send({ requestId: crypto.randomUUID(), revision: dataRef.current.revision, dataMode: 'live', snapshot: migration });
    if (!success && !pendingRef.current) await refresh();
    return success;
  }
  return { enabled, data, loading, ready: !enabled || Boolean(data), error, busy, pending: Boolean(pending), migration, migrationDigestError,
    canImport: Boolean(user?.isAdmin), refresh, write, importLegacy, retry: () => pendingRef.current ? send(pendingRef.current) : Promise.resolve(false) };
}
