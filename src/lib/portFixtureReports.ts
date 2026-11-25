import { useEffect, useState } from 'react';
import type { PortFixtureReports } from '../../shared/portFixtureReports';
import { useAccess } from '../auth';
import { useTestWorkspace } from '../TestWorkspace';

export function usePortFixtureReport<View extends keyof PortFixtureReports>(
  view: View, portId: string | undefined, enabled: boolean, search = '', page = 0,
) {
  const { realUser, preview } = useAccess();
  const { dataMode, namespace } = useTestWorkspace();
  const [retry, setRetry] = useState(0);
  const id = realUser?.id;
  const canRead = Boolean(enabled && portId && id && !preview && dataMode === 'live');
  const query = new URLSearchParams({ view, portId: portId ?? '', ...(view === 'prices' && { search, page: String(page) }) });
  const url = '/api/access/port-fixtures?' + query.toString();
  const key = canRead ? JSON.stringify([url, id, namespace, retry]) : '';
  const [result, setResult] = useState<{ key: string; data?: PortFixtureReports[View]; error?: true }>();
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(url, {
          credentials: 'same-origin', cache: 'no-store', headers: { 'X-Eco-Data-Mode': 'live' },
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
        });
        if (!response.ok) throw new Error('Fixture report unavailable');
        const data = await response.json() as PortFixtureReports[View];
        if (!controller.signal.aborted) setResult({ key, data });
      } catch {
        if (!controller.signal.aborted) setResult({ key, error: true });
      }
    };
    const delay = window.setTimeout(() => void load(), view === 'prices' && search ? 150 : 0);
    return () => { window.clearTimeout(delay); controller.abort(); };
  }, [key, url, view, search]);
  const current = result?.key === key ? result : undefined;
  return { data: current?.data, error: current?.error, loading: Boolean(key && !current), refresh: () => setRetry(value => value + 1) };
}
