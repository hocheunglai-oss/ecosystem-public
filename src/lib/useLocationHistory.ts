import { useCallback, useEffect, useRef, useState } from 'react';
import type { KnowledgeTarget } from './knowledge';
import { locationKnowledgeApi, type LocationHistoryPage } from './locationKnowledgeApi';

/** History is read on demand. It never becomes part of a subsequent save. */
export function useLocationHistory(targets: KnowledgeTarget[], enabled: boolean, revision: number, namespace: string) {
  const identity = JSON.stringify([namespace, targets, revision]);
  const [result, setResult] = useState<{ identity: string; page: LocationHistoryPage } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const request = useRef<AbortController | null>(null);
  const page = enabled && result?.identity === identity ? result.page : null;
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController(); request.current?.abort(); request.current = controller;
    setLoading(true); setError('');
    void locationKnowledgeApi.history(targets, undefined, controller.signal).then(page => {
      if (!controller.signal.aborted) setResult({ identity, page });
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'History unavailable.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [enabled, identity, retry]);
  const loadMore = useCallback(async () => {
    if (!enabled || !page?.nextCursor || loading) return;
    const controller = new AbortController(); request.current?.abort(); request.current = controller;
    setLoading(true); setError('');
    try {
      const next = await locationKnowledgeApi.history(targets, page.nextCursor, controller.signal);
      if (!controller.signal.aborted) setResult({ identity, page: { ...next, items: [...page.items, ...next.items] } });
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'History unavailable.'); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, [enabled, identity, page, loading]);
  useEffect(() => () => request.current?.abort(), [identity, enabled]);
  return { page, error, loading, loadMore, refresh: () => setRetry(value => value + 1) };
}
