import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommercialEnquiry, CommercialEnquiryScope, CommercialEnquirySummary } from '../shared/commercialEnquiries';
import { commercialEnquiryApi } from './lib/commercialEnquiryApi';

export function useCommercialEnquiries(owner: string, enabled: boolean) {
  const [scope, setScope] = useState<CommercialEnquiryScope>('mine');
  const [rows, setRows] = useState<CommercialEnquirySummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const epoch = useRef(0);
  const active = useRef({ owner, enabled, scope });
  active.current = { owner, enabled, scope };
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(async (next?: string) => {
    if (!enabled) return;
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    const request = ++epoch.current;
    setBusy(true); setError('');
    try {
      const result = await commercialEnquiryApi.page(owner, scope, next, abort.signal);
      if (request !== epoch.current || !active.current.enabled || active.current.owner !== owner || active.current.scope !== scope) return;
      setRows(current => next ? [...current, ...result.items.filter(item => !current.some(row => row.id === item.id))] : result.items);
      setCursor(result.nextCursor);
    } catch (error) {
      if (request === epoch.current && !abort.signal.aborted) setError(error instanceof Error ? error.message : 'Enquiries are unavailable.');
    } finally { if (request === epoch.current && !abort.signal.aborted) setBusy(false); }
  }, [enabled, owner, scope]);
  useEffect(() => {
    setRows([]); setCursor(null); setError('');
    if (enabled) void load(); else setBusy(false);
    return () => { epoch.current++; controller.current?.abort(); };
  }, [load, enabled]);
  useEffect(() => {
    if (!enabled) return;
    const refresh = () => { if (!document.hidden) void load(); };
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    return () => { window.removeEventListener('focus', refresh); window.removeEventListener('online', refresh); };
  }, [enabled, load]);
  function accept(item: CommercialEnquiry) {
    if (!active.current.enabled || item.ownerId !== active.current.owner) return;
    if (active.current.scope === 'singapore' && !item.queue) return;
    setRows(current => [item, ...current.filter(row => row.id !== item.id)]);
  }
  return { scope, setScope, rows: enabled ? rows : [], cursor: enabled ? cursor : null, busy, error,
    reload: () => load(), more: () => cursor ? load(cursor) : Promise.resolve(), accept };
}
