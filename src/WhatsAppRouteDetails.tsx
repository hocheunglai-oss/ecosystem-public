import { useEffect, useState } from 'react';
import { useTestWorkspace } from './TestWorkspace';
import { assertPreviewWritable } from './lib/previewGuard';

type Route = { centre: string; groupName: string; canConnect: boolean; connected: boolean };

export function WhatsAppRouteDetails() {
  const { dataMode } = useTestWorkspace();
  const [routes, setRoutes] = useState<Route[]>([]);
  const [code, setCode] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    fetch('/api/enquiries/dispatcher', { cache: 'no-store', signal: abort.signal }).then(async response => {
      if (!response.ok) throw new Error('WhatsApp groups are unavailable.');
      const value = await response.json();
      if (!abort.signal.aborted && Array.isArray(value.routes)) setRoutes(value.routes);
    }).catch(() => { if (!abort.signal.aborted) setError('WhatsApp groups are unavailable.'); });
    return () => abort.abort();
  }, []);

  async function connect() {
    if (busy || code || dataMode !== 'live') return;
    setBusy(true); setError(''); setCopyStatus('');
    try {
      assertPreviewWritable();
      const response = await fetch('/api/enquiries/dispatcher', {
        method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(20_000),
        headers: { 'Content-Type': 'application/json', 'X-Eco-Request': '1', 'X-Eco-Data-Mode': 'live' },
        body: JSON.stringify({ action: 'connect' }),
      });
      const result = await response.json();
      if (!response.ok || !/^[A-Za-z0-9_-]{43}$/.test(result.token ?? '')) throw new Error('Could not connect the dispatcher.');
      setCode(result.token);
    } catch {
      setError('Could not connect the dispatcher.');
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCode('');
      setCopyStatus('Code copied.');
    } catch {
      setError('Could not copy the code.');
    }
  }
  if (!routes.length && !error) return null;
  return <div>
    <dt>WhatsApp group</dt>
    {routes.map(route => <dd key={route.centre} className="personal-phone-value">
      <span data-preserve-case>{route.groupName}</span>
      {route.canConnect && dataMode === 'live' && !code && <button type="button" className="ui-button" disabled={busy}
        onClick={() => void connect()}>{route.connected ? 'Reconnect dispatcher' : 'Connect dispatcher'}</button>}
    </dd>)}
    {code && <dd className="personal-phone-actions"><button type="button" className="ui-button" onClick={() => void copy()}>Copy connection code</button></dd>}
    {copyStatus && <dd role="status">{copyStatus}</dd>}
    {error && <dd role="alert">{error}</dd>}
  </div>;
}
