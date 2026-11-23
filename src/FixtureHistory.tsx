import { useDeferredValue, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { fixtureHistoryPageSize, fixtureHistoryYears, type FixtureHistoryItem, type FixtureHistoryPage } from '../shared/fixtureHistory';
import { useAccess } from './auth';
import { useTestWorkspace } from './TestWorkspace';
import { canTrade } from './lib/model';
import RecordsPage from './RecordsPage';
import { useDemo } from './store';
import type { OpenModal } from './types';
import type { OpenWorkspace } from './workspaceNavigation';

const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const columns = ['DATE', 'SUPPLIER TRADER', 'BUYER TRADER', 'ACCT', 'ETA', 'VESSEL', 'IMO',
  'HSFO', 'VLSFO', 'LSMGO', 'SUPPLIER', 'PRICE', 'BARGING'] as const;
const dateFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });
const presentDate = (value: string | null) => value ? dateFormatter.format(new Date(value)) : '—';
const emptyFilters = { year: 0, month: 0, page: 0 };

function FixtureRow({ item, onOpen }: { item: FixtureHistoryItem; onOpen: OpenWorkspace }) {
  const number = (value: string | null) => <td className="record-sheet__number">{value ?? '—'}</td>;
  return <tr data-record-id={item.id}>
    <td className="record-sheet__date">{presentDate(item.date)}</td>
    <td title={item.supplierTrader}>{item.supplierTrader}<br /><small>{item.supplierOffice}</small></td>
    <td title={item.buyerTrader}>{item.buyerTrader}<br /><small>{item.buyerOffice}</small></td>
    <td>{item.account ?? '—'}</td>
    <td>{presentDate(item.eta)}</td>
    <td title={item.vessel}>{item.vessel}</td>
    <td>{item.imo ?? '—'}</td>
    {number(item.hsfo)}{number(item.vlsfo)}{number(item.lsmgo)}
    <td>{item.supplierAvailable
      ? <button type="button" className="text-button fixture-history__supplier"
          onClick={() => onOpen('suppliers', { supplierId: item.supplierId })}>{item.supplier}</button>
      : item.supplier}</td>
    {number(item.price)}{number(item.barging)}
  </tr>;
}

function HistoryTable({ onOpen }: { onOpen: OpenWorkspace }) {
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search.trim());
  const [filter, setFilter] = useState(emptyFilters);
  const [attempt, setAttempt] = useState(0);
  const query = new URLSearchParams({
    year: String(filter.year), month: String(filter.month), page: String(filter.page), search: deferredSearch,
  }).toString();
  const requestKey = query + '#' + attempt;
  const [result, setResult] = useState<{ key: string; data: FixtureHistoryPage | null } | null>(null);
  const settled = result?.key === requestKey ? result : null;
  const data = settled?.data;
  const busy = !settled || search.trim() !== deferredSearch;

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/access/fixture-history?' + query, {
          credentials: 'same-origin', cache: 'no-store', headers: { 'X-Eco-Data-Mode': 'live' },
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
        });
        if (!response.ok) throw new Error('Fixtures unavailable');
        const page = await response.json() as FixtureHistoryPage;
        if (!Array.isArray(page?.items) || page.items.length > fixtureHistoryPageSize || !Number.isSafeInteger(page.total) ||
            page.total < page.items.length) throw new Error('Invalid fixture page');
        if (!controller.signal.aborted) setResult({ key: requestKey, data: page });
      } catch {
        if (!controller.signal.aborted) setResult({ key: requestKey, data: null });
      }
    })();
    return () => controller.abort();
  }, [query, requestKey]);

  const first = filter.page * fixtureHistoryPageSize + 1;
  const last = first + (data?.items.length ?? 0) - 1;
  return <section className="record-sheet fixture-history" aria-label="Fixtures">
    <div className="record-sheet__toolbar">
      <label className="record-sheet__search"><Search size={15} aria-hidden="true" />
        <input type="search" aria-label="Search fixtures" placeholder="SEARCH" value={search} maxLength={120}
          onChange={event => { setSearch(event.target.value); setFilter(current => ({ ...current, page: 0 })); }} />
      </label>
      <label>YEAR<select aria-label="Fixture year" value={filter.year} onChange={event => {
        const year = Number(event.target.value);
        setFilter(current => ({ ...current, year, page: 0 }));
      }}><option value={0}>ALL YEARS</option>{fixtureHistoryYears.map(year => <option key={year}>{year}</option>)}</select></label>
      <label>MONTH<select aria-label="Fixture month" value={filter.month} onChange={event => {
        const month = Number(event.target.value);
        setFilter(current => ({ ...current, month, page: 0 }));
      }}><option value={0}>ALL MONTHS</option>{months.map((label, i) => <option key={label} value={i + 1}>{label}</option>)}</select></label>
      <button type="button" className="ui-button ui-button--secondary" disabled={busy} onClick={() => setAttempt(value => value + 1)}>REFRESH</button>
    </div>
    <div className="record-sheet__grid" role="region" aria-label="Fixture table" tabIndex={0} aria-busy={busy}>
      <table>
        <thead><tr>{columns.map((label, i) => <th key={label} scope="col" className={i === 0 ? 'record-sheet__date' : undefined}>{label}</th>)}</tr></thead>
        <tbody>{!busy && data?.items.map(item => <FixtureRow key={item.id} item={item} onOpen={onOpen} />)}</tbody>
      </table>
      {!busy && settled && !data && <p className="record-sheet__empty" role="alert">FIXTURES UNAVAILABLE. TRY REFRESH.</p>}
      {!busy && data && data.items.length === 0 && <p className="record-sheet__empty">NO MATCHING FIXTURES.</p>}
    </div>
    <footer className="record-sheet__pagination">
      <span role="status">{busy ? 'LOADING…' : data ? data.items.length ? `${first.toLocaleString()}–${last.toLocaleString()} OF ${data.total.toLocaleString()}` : '0 FIXTURES' : ''}</span>
      <div>
        <button type="button" className="ui-button ui-button--secondary" aria-label="Previous fixtures page"
          disabled={busy || filter.page === 0} onClick={() => setFilter(current => ({ ...current, page: current.page - 1 }))}><ChevronLeft size={15} /></button>
        <button type="button" className="ui-button ui-button--secondary" aria-label="Next fixtures page"
          disabled={busy || !data?.items.length || last >= data.total} onClick={() => setFilter(current => ({ ...current, page: current.page + 1 }))}><ChevronRight size={15} /></button>
      </div>
    </footer>
  </section>;
}

export default function FixtureHistory({ open, onOpen }: { open: OpenModal; onOpen: OpenWorkspace }) {
  const { user, preview } = useAccess();
  const { namespace, dataMode } = useTestWorkspace();
  const { state, actor } = useDemo();
  if (dataMode === 'test' || preview) return <RecordsPage open={open} kind="fixture" />;
  if (!user) return null;
  const hasLegacy = state.outcomes.some(outcome => outcome.kind === 'fixture' && (!canTrade(actor) || outcome.owner === actor.id));
  return <div className="fixture-history-layout">
    <HistoryTable key={namespace} onOpen={onOpen} />
    {hasLegacy && <details className="fixture-history__legacy">
      <summary>BROWSER FIXTURES</summary>
      <RecordsPage open={open} kind="fixture" />
    </details>}
  </div>;
}
