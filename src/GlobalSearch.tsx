import { useBuyerCreditAvailable } from './ReleaseGate';
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { useDemo } from './store';
import { useInbox } from './inbox';
import { globalSearchRecords, queryGlobalSearch, type GlobalSearchRecord } from './lib/globalSearch';
import type { OpenModal } from './types';
import type { OpenWorkspace } from './workspaceNavigation';
import './main-menu.css';
import { useSupplierList } from './lib/supplierApi';

export function GlobalSearch({ open, onOpen }: { open: OpenModal; onOpen: OpenWorkspace }) {
  const { state, actor } = useDemo();
  const buyerCreditAvailable = useBuyerCreditAvailable();
  const { items, select } = useInbox();
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [active, setActive] = useState(0);
  const deferred = useDeferredValue(query);
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const supplierResults = useSupplierList({ search: deferred.trim(), limit: 25 }, expanded && Boolean(deferred.trim()));
  const incomingKey = items.map(item => `${item.id}:${item.enquiryId ?? ''}:${Boolean(item.dismissed)}`).join('|');
  const records = useMemo(() => globalSearchRecords(state, actor, items, supplierResults.data?.items ?? [], buyerCreditAvailable), [state.companies, state.ports, state.locationAreas, state.locationCountries, state.enquiries, state.outcomes, actor.id, incomingKey, supplierResults.data, buyerCreditAvailable]);
  const results = useMemo(() => queryGlobalSearch(records, deferred), [records, deferred]);
  const focused = Math.min(active, Math.max(0, results.length - 1));
  const visible = expanded && Boolean(query.trim());
  const busy = query !== deferred || supplierResults.loading;
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !box.current?.contains(event.target)) setExpanded(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [expanded]);
  useEffect(() => { setExpanded(false); setQuery(''); }, [actor.id]);
  useEffect(() => { if (visible) document.getElementById(`${id}-${focused}`)?.scrollIntoView({ block: 'nearest' }); }, [focused, visible, id]);
  function choose(result: GlobalSearchRecord) {
    setExpanded(false); setQuery('');
    if (result.incomingId) select(result.incomingId);
    if (result.workspace) onOpen(result.workspace, result.context);
    if (result.modal) open(result.modal);
  }
  return <div className="main-search" ref={box} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setExpanded(false); }}>
    <div className="main-search-field"><Search size={16} aria-hidden="true"/><input ref={input} type="search" name="eco-global-query" autoComplete="off" autoCorrect="off" spellCheck={false} role="combobox" aria-label="Search ECO" aria-expanded={visible} aria-controls={`${id}-results`} aria-autocomplete="list" aria-activedescendant={visible && results.length && !busy ? `${id}-${focused}` : undefined} placeholder="Search" value={query} onFocus={() => setExpanded(true)} onChange={event => { setQuery(event.target.value); setExpanded(true); setActive(0); }} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setExpanded(false); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setExpanded(true); setActive(value => results.length ? (value + (event.key === 'ArrowDown' ? 1 : results.length - 1)) % results.length : 0); }
      if (event.key === 'Enter' && visible && !busy && results[focused]) { event.preventDefault(); choose(results[focused]); }
    }}/>{query && <button type="button" aria-label="Clear search" onClick={() => { setQuery(''); input.current?.focus(); }}><X size={14}/></button>}</div>
    {visible && <div className="main-search-results" role="listbox" id={`${id}-results`} aria-label="Search results" aria-busy={busy}>
      {results.map((result, index) => <button key={result.id} id={`${id}-${index}`} type="button" role="option" aria-selected={index === focused} tabIndex={-1} onMouseDown={event => event.preventDefault()} onMouseMove={() => setActive(index)} onClick={() => choose(result)}><span className="main-search-type">{result.category}</span><strong>{result.title}</strong><small>{result.detail}</small></button>)}
      {!results.length && <p role="status">{busy ? 'Searching…' : 'No results'}</p>}
      {supplierResults.error && <p role="status">Supplier search unavailable.</p>}
    </div>}
  </div>;
}
