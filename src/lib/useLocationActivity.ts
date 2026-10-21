import { useEffect, useRef, useState } from 'react';
import { useDemo } from '../store';
import { useTestWorkspace } from '../TestWorkspace';
import { contributionActivity, mergeLocationActivity, type ContributionPeriod } from './contributionActivity';
import { locationKnowledgeApi, type LocationActivityPage } from './locationKnowledgeApi';

/** Server totals include the complete archive; only the requested history page travels to the browser. */
export function useLocationActivity(actorIds: string | string[], period: ContributionPeriod, now: number, directoryIds: readonly string[] = [], allowed = true) {
  const { state, locations } = useDemo();
  const { namespace } = useTestWorkspace();
  const actors = Array.isArray(actorIds) ? actorIds : [actorIds];
  const identity = JSON.stringify([namespace, [...actors].sort(), period, locations.data?.revision, Math.floor(now / 60_000)]);
  const enabled = locations.enabled && allowed;
  const [result, setResult] = useState<{ identity: string; page: LocationActivityPage } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const request = useRef<AbortController | null>(null);
  const page = enabled && result?.identity === identity ? result.page : null;
  useEffect(() => {
    if (!enabled || !locations.ready) return;
    const controller = new AbortController(); request.current?.abort(); request.current = controller;
    setLoading(true); setError('');
    void locationKnowledgeApi.activity(actors, period, undefined, controller.signal).then(page => {
      if (!controller.signal.aborted) setResult({ identity, page });
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Shared contributions unavailable.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [enabled, locations.ready, identity, retry]);
  useEffect(() => () => request.current?.abort(), [identity, enabled]);
  async function loadMore() {
    if (!enabled || !page?.nextCursor || loading) return;
    const controller = new AbortController(); request.current?.abort(); request.current = controller;
    setLoading(true); setError('');
    try {
      const next = await locationKnowledgeApi.activity(actors, period, page.nextCursor, controller.signal);
      if (!controller.signal.aborted) setResult({ identity, page: { ...next, summary: { ...next.summary, entries: [...page.summary.entries, ...next.summary.entries] } } });
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Shared contributions unavailable.'); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }
  const local = contributionActivity(state, actors, period, now, directoryIds);
  return { byActor: page?.byActor, activity: page ? mergeLocationActivity(local, page) : local,
    status: !enabled ? 'ready' as const : error || locations.error ? 'unavailable' as const : page ? 'ready' as const : 'loading' as const,
    error, loading, hasMore: Boolean(page?.nextCursor), loadMore, refresh: () => setRetry(value => value + 1) };
}
