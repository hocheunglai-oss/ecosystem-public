import { useEffect, useState } from 'react';
import { useDemo } from '../store';
import { useTestWorkspace } from '../TestWorkspace';
import type { Contribution } from './model';
import { locationKnowledgeApi } from './locationKnowledgeApi';

export function useLocationContribution(id: string, fallback?: Contribution, enabled = true) {
  const { locations } = useDemo();
  const { namespace } = useTestWorkspace();
  const shared = locations.enabled && (!fallback || ['country', 'port', 'area'].includes(fallback.targetType));
  const key = `${namespace}:${id}:${locations.data?.revision}`;
  const [result, setResult] = useState<{ key: string; item: Contribution } | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!enabled || !shared) return;
    const controller = new AbortController(); setError('');
    void locationKnowledgeApi.contribution(id, controller.signal).then(({ item }) => {
      if (!controller.signal.aborted) setResult({ key, item });
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Update unavailable.'); });
    return () => controller.abort();
  }, [enabled, shared, key, retry]);
  return { item: shared ? result?.key === key ? result.item : null : fallback ?? null, error,
    refresh: () => setRetry(value => value + 1) };
}
