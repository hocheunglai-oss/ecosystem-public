import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, ChevronLeft, ChevronRight, Plus, Search, X } from 'lucide-react';
import { useAccess } from './auth';
import { useDemo } from './store';
import { useTestWorkspace } from './TestWorkspace';
import { isCurrentWorkspace } from './lib/testWorkspaceGuard';
import { supplierPorts, supplierPortById, supplierPortForLocation, type SupplierPort } from '../shared/supplierPorts';
import type { Port } from './lib/model';
import { Modal } from './ui';
import { supplierApi, announceSupplierUpdate, useSupplierList } from './lib/supplierApi';
import { supplierGrades, supplierName, supplierShortName } from './lib/supplierPresentation';
import SupplierQuickView, { useSupplierFixtureCounts, type SupplierQuickViewType } from './SupplierQuickView';
import SupplierPicEditor, { SupplierPicDialog } from './SupplierPicEditor';
import { useSupplierPicOptions } from './lib/supplierPicOptions';
import SharedSupplierProfile, { type SupplierTab } from './SharedSupplierProfile';
import type { SupplierRecord, SupplierCreate, SupplierSummary } from '../shared/suppliers';
import type { OpenModal } from './types';
import type { OpenWorkspace, WorkspaceNavigationContext } from './workspaceNavigation';
import './shared-suppliers.css';
import './supplier-comparison.css';

export default function SupplierWorkspace({ onOpen, context, singapore = false, port, embedded = false, initialSearch = '' }: {
  open: OpenModal; onOpen?: OpenWorkspace; context?: WorkspaceNavigationContext; singapore?: boolean; port?: Port; embedded?: boolean; initialSearch?: string;
}) {
  const { realUser, preview } = useAccess();
  const { state } = useDemo();
  const { dataMode, namespace } = useTestWorkspace();
  const scoped = Boolean(port || context?.portId);
  const location = port ?? state.ports.find(item => item.id === context?.portId);
  const scope = location ? supplierPortForLocation(location) : undefined;
  const scopeKey = scoped ? scope?.id ?? 'unmapped' : 'all';
  const defaultSpcView = Boolean(embedded && scope?.countryCode === 'SG');
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState(initialSearch);
  const [singaporeOnly, setSingaporeOnly] = useState(singapore);
  const [spcView, setSpcView] = useState(defaultSpcView);
  const createPort = scope ?? (spcView || singaporeOnly ? supplierPortById('port-singapore') : undefined);
  const canManage = Boolean(realUser?.isActive && !preview && dataMode === 'live' && (!scoped || scope) && (createPort?.countryCode !== 'SG' || realUser.isAdmin || realUser.isSpcTrader));
  const [traderFilter, setTraderFilter] = useState('');
  const [gradeFilter, setGradeFilter] = useState('');
  const [selectedPic, setSelectedPic] = useState<SupplierSummary | null>(null);
  const [quickView, setQuickView] = useState<{ supplier: SupplierSummary; view: SupplierQuickViewType } | null>(null);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(50);
  const [selected, setSelected] = useState<{ id: string; tab: SupplierTab } | null>(context?.supplierId ? { id: context.supplierId, tab: 'information' } : null);
  const rows = useSupplierList({ search, portId: scope?.id, country: scoped ? undefined : spcView || singaporeOnly ? 'SG' : undefined, trader: spcView ? traderFilter : undefined, grade: spcView ? gradeFilter : undefined, page, limit }, !selected && (!scoped || Boolean(scope)));
  const table = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const scroll = useRef(0);
  const focusId = useRef('');
  const items = rows.data?.items ?? [];
  const picOptions = useSupplierPicOptions(spcView && !selected);
  const fixtureCounts = useSupplierFixtureCounts(items);
  const pages = Math.max(1, Math.ceil((rows.data?.total ?? 0) / limit));
  useEffect(() => {
    setSelected(context?.supplierId ? { id: context.supplierId, tab: context.supplierTab ?? 'information' } : null);
    setSearch(initialSearch); setSingaporeOnly(singapore); setSpcView(defaultSpcView); setTraderFilter(''); setGradeFilter(''); setPage(1); setCreating(false); setSelectedPic(null); setQuickView(null); scroll.current = 0;
  }, [context?.supplierId, context?.supplierTab, singapore, scopeKey, defaultSpcView, initialSearch, namespace]);
  useLayoutEffect(() => {
    if (selected || rows.loading || !table.current) return;
    table.current.scrollTop = scroll.current;
    if (focusId.current) {
      const button = [...table.current.querySelectorAll<HTMLButtonElement>('button[data-supplier-id]')].find(item => item.dataset.supplierId === focusId.current);
      button?.focus({ preventScroll: true });
      focusId.current = '';
    }
  }, [selected, rows.loading]);
  function choose(id: string, tab: SupplierTab = 'information') {
    scroll.current = table.current?.scrollTop ?? 0; focusId.current = id; setSelected({ id, tab });
  }
  function reset() { setPage(1); scroll.current = 0; }
  const origin = embedded ? undefined : context?.returnTo;
  if (selected) return <SharedSupplierProfile key={selected.id} id={selected.id} initialTab={selected.tab}
    onBack={() => setSelected(null)} backLabel="Supplier results" />;
  return <div className={`shared-suppliers ${embedded ? 'shared-suppliers--embedded' : ''} ${spcView ? 'has-spc-view' : 'has-name-view'}`}>
    <div className="shared-supplier-toolbar">
      {(!scoped || scope?.countryCode === 'SG') && <button type="button" className={`button ${spcView ? 'primary' : 'secondary'}`} aria-pressed={spcView} onClick={() => { setSpcView(value => !value); reset(); }}>SPC VIEW</button>}
      <label className="shared-supplier-search"><Search size={16} aria-hidden="true" /><input ref={searchInput} type="search" aria-label="Search suppliers" maxLength={160} placeholder="Search suppliers" value={search} onChange={event => { setSearch(event.target.value); reset(); }} />{search && <button className="icon-button" aria-label="Clear supplier search" onClick={() => { setSearch(''); reset(); searchInput.current?.focus(); }}><X size={15} /></button>}</label>
      {canManage && <button className="button primary" onClick={() => setCreating(true)}><Plus size={14} />Add supplier</button>}
      {origin && onOpen && <button className="button secondary" onClick={() => onOpen(origin, { portId: context?.portId })}><ArrowLeft size={14} />{origin === 'enquiry' ? 'Enquiries' : 'Countries & Ports'}</button>}
    </div>
    {spcView && picOptions.error && <div className="shared-supplier-message" role="alert">{picOptions.error}<button className="button secondary" onClick={picOptions.refresh}>RETRY</button></div>}
    {scoped && !scope && <p className="shared-supplier-message" role="status">Supplier registration unavailable for this port.</p>}
    {rows.error && <div className="shared-supplier-message" role="alert">{rows.error}<button className="button secondary" onClick={rows.refresh}>Retry</button></div>}
    <div className={`shared-supplier-table-scroll ${spcView ? 'is-spc-view' : 'is-name-view'}`} ref={table} role="region" aria-label="Supplier records" tabIndex={0} aria-busy={rows.loading}>
      <table className="shared-supplier-table" aria-label="Supplier results">
        <thead><tr><th scope="col">SUPPLIER</th>{spcView && <><th scope="col">PAYMENT<br />TERMS</th><th scope="col">QUALITY CLAIM<br />BAR</th><th scope="col" className="shared-supplier-filter-heading"><select aria-label="Supplier PIC filter" value={traderFilter} onChange={event => { setTraderFilter(event.target.value); reset(); }}><option value="">ALL TRADERS</option>{[...new Set([...picOptions.options, ...items.map(item => item.info.supplierTrader), traderFilter].filter(Boolean))].sort().map(value => <option key={value} value={value}>{value}</option>)}</select></th><th scope="col" className="shared-supplier-filter-heading"><select aria-label="Grade filter" value={gradeFilter} onChange={event => { setGradeFilter(event.target.value); reset(); }}><option value="">ALL GRADES</option>{['HSFO', 'VLSFO', 'LSMGO'].map(value => <option key={value}>{value}</option>)}</select></th><th scope="col">INFORMATION</th></>}</tr></thead>
        <tbody>{items.map(item => <tr key={item.id}>
          <th scope="row"><button className="shared-supplier-name" data-supplier-id={item.id} onClick={() => choose(item.id)}><span>{spcView ? supplierShortName(item) : supplierName(item)}{!spcView && item.countryCode === 'SG' && item.shortName && supplierShortName(item) !== supplierName(item) && <small>(SPC: {supplierShortName(item)})</small>}</span><ArrowUpRight size={14} aria-hidden="true" /></button>{!spcView && item.nameStatus === 'needs-review' && <span className="shared-supplier-review">NAME TO VERIFY</span>}</th>
          {spcView && <><td data-label="PAYMENT TERMS" className="shared-supplier-terms"><TermValue value={item.info.paymentTerms} /></td>
          <td data-label="QUALITY CLAIM BAR" className="shared-supplier-terms"><TermValue value={item.info.qualityClaimBar} /></td>
          <td data-label="SUPPLIER PIC"><SupplierPicEditor supplier={item} onEdit={() => setSelectedPic(item)} /></td>
          <td data-label="GRADES"><span className="shared-supplier-grades">{['HSFO', 'VLSFO', 'LSMGO'].map(value => <span key={value} data-grade={value} className={supplierGrades(item.info.availableGrade).includes(value) ? '' : 'is-unavailable'} aria-label={supplierGrades(item.info.availableGrade).includes(value) ? value : `${value} unavailable`}>{supplierGrades(item.info.availableGrade).includes(value) ? value : <span aria-hidden="true">—</span>}</span>)}</span></td>
          <td data-label="INFORMATION"><div className="shared-supplier-row-actions">{([
            ['bdn', 'BDN', Boolean(item.info.foBdn.trim() || item.info.goBdn.trim())],
            ['contacts', `CONTACT (${item.contactCount})`, item.contactCount > 0],
            ['barges', `BARGE FLEET (${item.bargeCount})`, item.bargeCount > 0],
            ['fixtures', 'FIXTURES', (fixtureCounts.get(item.id) ?? 0) > 0],
          ] as const).map(([view, label, hasContent]) => <button key={view} className={`button secondary ${hasContent ? 'has-information' : 'is-empty'}`} onClick={() => setQuickView({ supplier: item, view })}>{label}</button>)}</div></td></>}
        </tr>)}</tbody>
      </table>
      {rows.loading && <p className="shared-supplier-empty" role="status">Loading suppliers…</p>}
      {!rows.loading && !rows.error && !items.length && <p className="shared-supplier-empty" role="status">No suppliers found.</p>}
    </div>
    <footer className="shared-supplier-pagination"><span role="status">{rows.data ? `${rows.data.total} suppliers` : '—'}</span><label>Per page<select aria-label="Suppliers per page" value={limit} onChange={event => { setLimit(Number(event.target.value)); reset(); }}>{[25, 50, 100].map(value => <option key={value}>{value}</option>)}</select></label><div><button className="icon-button" aria-label="Previous supplier page" disabled={rows.loading || page <= 1} onClick={() => { setPage(value => value - 1); scroll.current = 0; }}><ChevronLeft size={16} /></button><span>{page} / {pages}</span><button className="icon-button" aria-label="Next supplier page" disabled={rows.loading || !rows.data || page >= pages} onClick={() => { setPage(value => value + 1); scroll.current = 0; }}><ChevronRight size={16} /></button></div></footer>
    {selectedPic && <SupplierPicDialog supplier={selectedPic} options={picOptions.options} optionsLoading={picOptions.loading} optionsError={picOptions.error} onRetryOptions={picOptions.refresh} onClose={() => setSelectedPic(null)} onSaved={() => { setSelectedPic(null); rows.refresh(); }} />}
    {quickView && <SupplierQuickView supplier={quickView.supplier} view={quickView.view} onClose={() => setQuickView(null)} onOpenProfile={tab => { choose(quickView.supplier.id, tab); setQuickView(null); }} />}
    {creating && <CreateSupplier port={createPort} onClose={() => setCreating(false)} onSaved={item => { setCreating(false); choose(item.id); announceSupplierUpdate(); }} />}
  </div>;
}


function TermValue({ value }: { value: string }) {
  const parts = value.split(/(\d+(?:\.\d+)?)/);
  return <>{value ? parts.map((part, index) => /\d/.test(part) && Number(part) !== 30 ? <span key={index} className="is-nonstandard">{part}</span> : part) : '—'}</>;
}

function CreateSupplier({ port, onClose, onSaved }: { port?: SupplierPort; onClose: () => void; onSaved: (item: SupplierRecord) => void }) {
  const { realUser, preview } = useAccess();
  const [legalName, setLegalName] = useState(''), [shortName, setShortName] = useState(''), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const attempt = useRef<{ body: string; id: string } | null>(null);
  const { dataMode, namespace } = useTestWorkspace();
  const authority = Boolean(realUser?.isAdmin || realUser?.isSpcTrader);
  const [portId, setPortId] = useState<string>(port?.id ?? (authority ? 'port-singapore' : 'port-hong-kong'));
  const selectedPort = port ?? supplierPortById(portId);
  const allowed = Boolean(realUser?.isActive && selectedPort && (selectedPort.countryCode !== 'SG' || authority) && !preview && dataMode === 'live');
  const alive = useRef(true), current = useRef({ owner: realUser?.id, namespace, allowed });
  current.current = { owner: realUser?.id, namespace, allowed };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const stillCurrent = (started: typeof current.current) => alive.current && current.current.owner === started.owner && current.current.namespace === started.namespace && current.current.allowed && isCurrentWorkspace(started.namespace);
  const close = () => { if (!saving && ((!legalName && !shortName) || window.confirm('Discard unsaved supplier changes?'))) onClose(); };
  async function save() {
    const started = current.current;
    if (!stillCurrent(started) || !allowed || !selectedPort || saving || !legalName.trim() || !shortName.trim()) return;
    const payload: Omit<SupplierCreate, 'requestId'> = { legalName: legalName.trim(), shortName: shortName.trim(), portId: selectedPort.id, countryCode: selectedPort.countryCode, countryName: selectedPort.countryName, portName: selectedPort.portName, background: '', info: { paymentTerms: '', qualityClaimBar: '', supplierTrader: '', availableGrade: '', foBdn: '', goBdn: '' }, contacts: [], barges: [] };
    const body = JSON.stringify(payload); if (attempt.current?.body !== body) attempt.current = { body, id: crypto.randomUUID() };
    setSaving(true); setError('');
    try { const result = await supplierApi.create({ ...payload, requestId: attempt.current.id }); if (stillCurrent(started)) onSaved(result.item); }
    catch (failure) { if (stillCurrent(started)) { setError((failure as Error).message); setSaving(false); } }
  }
  return <Modal title="Add supplier" onClose={close}><form className="shared-supplier-create" onSubmit={event => { event.preventDefault(); void save(); }}>{error && <p role="alert" className="shared-supplier-message">{error}</p>}<label>Port<select aria-label="Supplier port" value={selectedPort?.id ?? ''} disabled={saving || Boolean(port)} onChange={event => setPortId(event.target.value)}>{supplierPorts.filter(item => authority || item.countryCode !== 'SG').map(item => <option key={item.id} value={item.id}>{item.portName} · {item.countryName}</option>)}</select></label><label>Official name<input required maxLength={300} value={legalName} disabled={saving} onChange={event => setLegalName(event.target.value)} /></label><label>{selectedPort?.countryCode === 'SG' ? 'SPC short name' : 'Short name'}<input required maxLength={100} value={shortName} disabled={saving} onChange={event => setShortName(event.target.value)} /></label><footer><button type="button" className="button secondary" disabled={saving} onClick={close}>Cancel</button><button type="submit" className="button primary" disabled={!allowed || saving || !legalName.trim() || !shortName.trim()}>{saving ? 'Saving…' : 'Add supplier'}</button></footer></form></Modal>;
}
