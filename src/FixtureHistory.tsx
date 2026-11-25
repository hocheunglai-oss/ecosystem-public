import { useDeferredValue, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ListFilter, Search } from 'lucide-react';
import { fixtureHistoryPageSize, fixtureHistoryYears, type FixtureHistoryItem, type FixtureHistoryPage, type FixtureTraderFilter } from '../shared/fixtureHistory';
import { useAccess } from './auth';
import { useTestWorkspace } from './TestWorkspace';
import { canTrade } from './lib/model';
import RecordsPage from './RecordsPage';
import { useDemo } from './store';
import type { OpenModal } from './types';
import type { OpenWorkspace } from './workspaceNavigation';
import { FixtureDetails, fixtureEta } from './FixtureDialogs';
import FixtureEditor from './FixtureEditor';

const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const columns = ['DATE', 'SUPPLIER TRADER', 'BUYER TRADER', 'VESSEL', 'ETA', 'HSFO', 'VLSFO', 'LSMGO'] as const;
const dateFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });
const presentDate = (value: string | null) => value ? dateFormatter.format(new Date(value)) : '—';
const emptyTraderFilter = { office: '', trader: '' };
const emptyFilters = { year: 0, month: 0, page: 0, supplier: emptyTraderFilter, buyer: emptyTraderFilter, deleted: false };
const traderColumns = { supplier: 'SUPPLIER TRADER', buyer: 'BUYER TRADER' } as const;
type TraderColumn = keyof typeof traderColumns;
type TraderFilter = typeof emptyTraderFilter;
const shortTrader = (name: string, office: string) => [name.trim().split(/\s+/)[0], office && `(${office})`].filter(Boolean).join(' ');
const vesselLabel = (item: FixtureHistoryItem) => item.imo ? `${item.vessel} (${item.imo})` : item.vessel;

function FixtureRow({ item, onDetails, onEdit }: { item: FixtureHistoryItem; onDetails: () => void; onEdit: () => void }) {
  const click = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(click.current), []);
  const number = (value: string | null) => <td className="record-sheet__number">{value ?? '—'}</td>;
  const status = item.deleted ? 'DELETED' : item.cancelled ? 'CANCELLED' : item.status === 'pending' ? 'PENDING' : '';
  const vessel = vesselLabel(item);
  return <tr data-record-id={item.id} onDoubleClick={item.canEdit ? () => {
    window.clearTimeout(click.current);
    onEdit();
  } : undefined}>
    <td className="record-sheet__date">{presentDate(item.date)}</td>
    <td title={`${item.supplierTrader} · ${item.supplierOffice}`}>{shortTrader(item.supplierTrader, item.supplierOfficeCode ?? item.supplierOffice)}</td>
    <td title={`${item.buyerTrader} · ${item.buyerOffice}`}>{shortTrader(item.buyerTrader, item.buyerOfficeCode ?? item.buyerOffice)}</td>
    <td><button type="button" className="text-button fixture-vessel" title={vessel} onClick={event => {
      if (item.deleted) { onEdit(); return; }
      if (!item.canEdit || !event.detail || !window.matchMedia('(any-pointer: fine)').matches ||
        (event.nativeEvent instanceof PointerEvent && event.nativeEvent.pointerType === 'touch')) { onDetails(); return; }
      window.clearTimeout(click.current);
      if (event.detail === 1) click.current = window.setTimeout(onDetails, 450);
    }}><span>{vessel}</span>{status && <span className={item.cancelled && !item.deleted ? 'fixture-cancelled' : undefined}>{status}</span>}</button></td>
    <td>{fixtureEta(item.eta, item.etaKind, item.etaEnd)}</td>
    {number(item.hsfo)}{number(item.vlsfo)}{number(item.lsmgo)}
  </tr>;
}

function TraderFilters({ column, options, value, onChange, onClose }: {
  column: TraderColumn; options: FixtureTraderFilter[]; value: TraderFilter;
  onChange: (value: TraderFilter) => void; onClose: () => void;
}) {
  const office = useRef<HTMLSelectElement>(null);
  useEffect(() => office.current?.focus({ preventScroll: true }), [column]);
  const offices = new Map(options.filter(option => option.code).map(option => [option.code, option.office]));
  const available = options.filter(option => !value.office || option.code === value.office);
  const traders = new Map<string, { name: string; codes: Set<string> }>();
  for (const { id, name, code } of available) {
    if (!traders.has(id)) traders.set(id, { name, codes: new Set() });
    if (code) traders.get(id)?.codes.add(code);
  }
  return <div className="record-sheet__toolbar" id="fixture-trader-filters" role="group" aria-label={traderColumns[column]} onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
  }}>
    <label>OFFICE<select ref={office} aria-label={`${traderColumns[column]} OFFICE`} value={value.office} onChange={event => {
      const office = event.target.value;
      onChange({ office, trader: options.some(option => option.id === value.trader && (!office || option.code === office)) ? value.trader : '' });
    }}><option value="">ALL OFFICES</option>{[...offices].sort((a, b) => a[1].localeCompare(b[1])).map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></label>
    <label>TRADER<select aria-label={`${traderColumns[column]} NAME`} value={value.trader}
      onChange={event => onChange({ ...value, trader: event.target.value })}>
      <option value="">ALL TRADERS</option>{[...traders].map(([id, trader]) => <option key={id} value={id}>{trader.name}{trader.codes.size ? ` (${[...trader.codes].join(' / ')})` : ''}</option>)}
    </select></label>
    <button type="button" className="ui-button ui-button--secondary" onClick={onClose}>DONE</button>
  </div>;
}

function HistoryTable({ onOpen }: { onOpen: OpenWorkspace }) {
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search.trim());
  const [filter, setFilter] = useState(emptyFilters);
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<{ item: FixtureHistoryItem; editing: boolean }>();
  const [traderFilter, setTraderFilter] = useState<TraderColumn>();
  const filterButton = useRef<HTMLButtonElement | null>(null);
  const query = new URLSearchParams({
    year: String(filter.year), month: String(filter.month), page: String(filter.page), search: deferredSearch,
    ...(filter.supplier.office && { supplierOffice: filter.supplier.office }),
    ...(filter.supplier.trader && { supplierTrader: filter.supplier.trader }),
    ...(filter.buyer.office && { buyerOffice: filter.buyer.office }),
    ...(filter.buyer.trader && { buyerTrader: filter.buyer.trader }),
    ...(filter.deleted && { deleted: '1' }),
  }).toString();
  const requestKey = query + '#' + attempt;
  const [result, setResult] = useState<{ key: string; data: FixtureHistoryPage | null } | null>(null);
  const settled = result?.key === requestKey ? result : null;
  const data = settled?.data;
  const busy = !settled || search.trim() !== deferredSearch;
  const traderOptions = result?.data?.filters;

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
  function changed() {
    if (filter.page && data?.items.length === 1) setFilter(current => ({ ...current, page: current.page - 1 }));
    setAttempt(value => value + 1);
  }
  function closeFilter() {
    setTraderFilter(undefined);
    filterButton.current?.focus({ preventScroll: true });
  }
  function open(item: FixtureHistoryItem, editing: boolean) { setSelected({ item, editing }); }
  return <>
    <section className="record-sheet fixture-history" aria-label="Fixtures">
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
        {(filter.deleted || traderOptions?.canSeeDeleted) && <button type="button" className="ui-button ui-button--secondary" aria-pressed={filter.deleted} onClick={() => {
          setTraderFilter(undefined);
          setFilter(current => ({ ...current, supplier: emptyTraderFilter, buyer: emptyTraderFilter, deleted: !current.deleted, page: 0 }));
        }}>DELETED</button>}
      </div>
      {traderFilter && <TraderFilters column={traderFilter} options={traderOptions?.[traderFilter] ?? []} value={filter[traderFilter]}
        onChange={value => setFilter(current => ({ ...current, [traderFilter]: value, page: 0 }))} onClose={closeFilter} />}
      <div className="record-sheet__grid" role="region" aria-label="Fixture table" tabIndex={0} aria-busy={busy}>
        <table>
          <thead><tr>{columns.map((label, i) => {
            const column = label === 'SUPPLIER TRADER' ? 'supplier' : label === 'BUYER TRADER' ? 'buyer' : undefined;
            return <th key={label} scope="col" className={i === 0 ? 'record-sheet__date' : undefined}>{column ?
              <button type="button" aria-label={`FILTER ${label}`} aria-expanded={traderFilter === column} aria-controls={traderFilter === column ? 'fixture-trader-filters' : undefined}
                data-filtered={Boolean(filter[column].office || filter[column].trader)} onClick={event => {
                  filterButton.current = event.currentTarget;
                  if (traderFilter === column) closeFilter(); else setTraderFilter(column);
                }}>{label} <ListFilter size={14} aria-hidden="true" /></button> : label}</th>;
          })}</tr></thead>
          <tbody>{!busy && data?.items.map(item => <FixtureRow key={item.id} item={item} onDetails={() => open(item, false)} onEdit={() => open(item, true)} />)}</tbody>
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
    </section>
    {selected?.editing ? <FixtureEditor key={selected.item.id} item={selected.item} onClose={() => setSelected(undefined)} onChanged={changed} /> :
      selected && <FixtureDetails key={selected.item.id} item={selected.item} onOpen={onOpen} onChanged={changed}
        onEdit={selected.item.canEdit ? () => open(selected.item, true) : undefined} onClose={() => setSelected(undefined)} />}
  </>;
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
