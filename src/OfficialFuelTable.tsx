import { useEffect, useState } from 'react';
import { useAccess } from './auth';
import { useTestWorkspace } from './TestWorkspace';
import type { OfficialTableSnapshot } from '../shared/officialTables';
import { officialFuels, officialTableTitle } from './lib/officialTableNotes';
import { matchesKnowledgeSearch } from './lib/knowledgeSearch';
import TextWithLinks from './TextWithLinks';
import './official-fuel-table.css';

export function useOfficialFuelTable(enabled: boolean) {
  const { realUser, preview } = useAccess();
  const { namespace, dataMode } = useTestWorkspace();
  const allowed = enabled && Boolean(realUser?.isActive && realUser.activated) && dataMode === 'live';
  const scope = `${realUser?.id}:${namespace}:${preview?.role}:${preview?.officeId}:${allowed}`;
  const [state, setState] = useState<{ scope: string; snapshot?: OfficialTableSnapshot; loading: boolean; error: boolean }>({ scope: '', loading: false, error: false });
  useEffect(() => {
    if (!allowed) return;
    let disposed = false, request = 0, current: AbortController | undefined;
    async function refresh() {
      const epoch = ++request; current?.abort(); const controller = new AbortController(); current = controller;
      setState(value => ({ scope, snapshot: value.scope === scope ? value.snapshot : undefined, loading: true, error: false }));
      try {
        const response = await fetch('/api/official-tables/snapshot', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) });
        if (!response.ok) throw new Error();
        const { snapshot } = await response.json();
        if (!snapshot || snapshot.feedId !== 'mpa-singapore-alternative-fuels' || !['current', 'stale', 'unavailable'].includes(snapshot.status) || !Array.isArray(snapshot.rows) || snapshot.rows.length > 4 || !snapshot.rows.every((row: Record<string, unknown>) => officialFuels.some(fuel => fuel.toLowerCase() === row.id) && typeof row.position === 'string' && row.position.length < 6000 && typeof row.sourceUrl === 'string' && /^https:\/\/www\.mpa\.gov\.sg\//.test(row.sourceUrl))) throw new Error();
        if (!disposed && epoch === request) setState({ scope, snapshot, loading: false, error: false });
      } catch { if (!disposed && epoch === request && !controller.signal.aborted) setState(value => ({ scope, snapshot: value.scope === scope ? value.snapshot : undefined, loading: false, error: true })); }
    }
    void refresh(); const focus = () => { if (!document.hidden) void refresh(); };
    window.addEventListener('focus', focus); const timer = window.setInterval(focus, 300000);
    return () => { disposed = true; ++request; current?.abort(); clearInterval(timer); window.removeEventListener('focus', focus); };
  }, [scope, allowed]);
  return state.scope === scope && allowed ? state : { snapshot: undefined, loading: allowed, error: false };
}

export function officialTableMatches(snapshot: OfficialTableSnapshot | undefined, notes: Record<string, string>, query: string) {
  return officialFuels.some(fuel => matchesKnowledgeSearch(query, officialTableTitle, fuel, snapshot?.rows.find(row => row.id === fuel.toLowerCase())?.position, notes[fuel.toLowerCase()]));
}

export default function OfficialFuelTable({ snapshot, loading, error, notes, query = '', onNoteChange }: {
  snapshot?: OfficialTableSnapshot; loading?: boolean; error?: boolean; notes: Record<string, string>; query?: string;
  onNoteChange?: (fuel: string, value: string) => void;
}) {
  const stale = error || snapshot?.status === 'stale' || Boolean(snapshot?.checkedAt && Date.now() - Date.parse(snapshot.checkedAt) > 48 * 3600000);
  return <article className="knowledge-block official-fuel-table">
    <header className="knowledge-block-head"><h4>{officialTableTitle}</h4><span className="official-feed-status">MPA · {loading ? 'Checking…' : stale ? 'Update unavailable' : snapshot?.status === 'current' ? 'Automatic updates' : 'Unavailable'}</span></header>
    <div className="knowledge-table-wrap" tabIndex={0} role="region" aria-label={officialTableTitle}>
      <table><thead><tr><th>Fuel</th><th>Verified position</th><th>Commercial implication</th></tr></thead><tbody>
        {officialFuels.map(fuel => { const id = fuel.toLowerCase(), row = snapshot?.rows.find(item => item.id === id);
          if (!onNoteChange && !matchesKnowledgeSearch(query, officialTableTitle, fuel, row?.position, notes[id])) return null;
          return <tr key={id}><th scope="row">{fuel}</th><td>{row ? <><p>{row.position}</p><a href={row.sourceUrl} target="_blank" rel="noopener noreferrer" data-preserve-case>{row.sourceTitle}</a><small>{row.publishedAt}</small></> : <span>{loading ? 'Loading…' : 'Source unavailable'}</span>}</td><td>{onNoteChange ? <textarea aria-label={`${fuel} commercial implication`} rows={4} maxLength={5000} value={notes[id] ?? ''} onChange={event => onNoteChange(id, event.target.value)} /> : <TextWithLinks text={notes[id] || '—'} />}</td></tr>;
        })}
      </tbody></table>
    </div>
    {snapshot?.status !== 'current' && typeof snapshot?.message === 'string' && <p className="official-feed-message" role="status">{snapshot.message}</p>}
    {snapshot?.checkedAt && <footer>Last checked {new Date(snapshot.checkedAt).toLocaleString('en-GB')}</footer>}
  </article>;
}
