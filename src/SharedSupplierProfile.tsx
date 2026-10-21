import KnowledgeUpdateButton from './KnowledgeUpdateButton';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowUpRight, Plus, Trash2 } from 'lucide-react';
import type { SupplierRecord, SupplierUpdate, SupplierInfo, SupplierSource } from '../shared/suppliers';
import type { SupplierReport } from '../shared/supplierReports';
import { supplierReportsApi } from './lib/supplierReportsApi';
import type { ProfileTab, ProfileTabCollection } from '../shared/profileTabs';
import { useAccess } from './auth';
import { useTestWorkspace } from './TestWorkspace';
import { supplierApi, announceSupplierUpdate } from './lib/supplierApi';
import { announceFeedbackUpdate } from './lib/adminApi';
import { supplierBackground, supplierContacts, supplierDate, supplierInfospectrumSummary, supplierName, supplierShortName, supplierSourceUrl } from './lib/supplierPresentation';
import { useSupplierPicOptions } from './lib/supplierPicOptions';
import { supplierPicChoices } from './lib/supplierPicSelection';
import SupplierKeyInfo from './SupplierKeyInfo';
import { profileTabsApi, useProfileTabs } from './lib/profileTabsApi';
import { ProfileTabs, ManageProfileTabs, ProfileTabContent } from './ProfileTabs';

// Legacy BDN links open Key Info; BDN no longer owns a separate tab.
export type SupplierTab = 'information' | 'bdn' | 'contacts' | 'barges' | 'sources';
const defaultTabs: ProfileTab[] = [
  { id: 'builtin:information', title: 'Supplier information', visibility: 'shared', builtin: 'information' },
  { id: 'builtin:contacts', title: 'Contacts', visibility: 'shared', builtin: 'contacts' },
  { id: 'builtin:barges', title: 'Barge fleet', visibility: 'shared', builtin: 'barges' },
  { id: 'builtin:sources', title: 'Sources', visibility: 'shared', builtin: 'sources' },
];
const infoFields: [keyof SupplierInfo, string][] = [['paymentTerms', 'Payment terms'], ['qualityClaimBar', 'Quality claim bar'], ['supplierTrader', 'Supplier trader'], ['availableGrade', 'Available grades'], ['foBdn', 'FO BDN'], ['goBdn', 'GO BDN']];
const copyDraft = (item: SupplierRecord) => ({ id: item.id, revision: item.revision, legalName: item.legalName, shortName: item.shortName, background: item.background || supplierBackground(item).map(fact => fact.value).join(' '), info: { ...item.info }, contacts: item.contacts.map(value => ({ ...value })), barges: item.barges.map(value => ({ ...value })) });
type Draft = Omit<SupplierUpdate, 'requestId'>;
const initialKey = (tab: SupplierTab) => `builtin:${tab === 'bdn' ? 'information' : tab}`;
const sameTabs = (left: readonly ProfileTab[], right: readonly ProfileTab[]) => {
  const fields = (tabs: readonly ProfileTab[]) => tabs.map(({ id, title, visibility, builtin, content }) => ({ id, title, visibility, builtin: builtin ?? '', content: content ?? '' }));
  return JSON.stringify(fields(left)) === JSON.stringify(fields(right));
};

type SharedSupplierProfileProps = {
  id: string; initialTab?: SupplierTab; onBack: () => void; backLabel?: string; onOpenDirectory?: (id: string) => void;
};
export default function SharedSupplierProfile(props: SharedSupplierProfileProps) {
  const { realUser, preview } = useAccess();
  const { namespace } = useTestWorkspace();
  // Remount all local drafts before rendering a different account or preview.
  return <SupplierProfileContent key={`${realUser?.id ?? ''}:${Boolean(preview)}:${namespace}:${props.id}`} {...props} />;
}
function SupplierProfileContent({ id, initialTab = 'information', onBack, backLabel = 'Supplier results', onOpenDirectory }: SharedSupplierProfileProps) {
  const { realUser, preview } = useAccess();
  const { dataMode } = useTestWorkspace();
  const [item, setItem] = useState<SupplierRecord | null>(null), [tab, setTab] = useState(initialKey(initialTab));
  const [draft, setDraft] = useState<Draft | null>(null), [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [conflict, setConflict] = useState(false), [generation, setGeneration] = useState(0);
  const [reports, setReports] = useState<SupplierReport[]>([]), [reportError, setReportError] = useState(''), [reportGeneration, setReportGeneration] = useState(0), [tabDirty, setTabDirty] = useState(false);
  const [tabEditorGeneration, setTabEditorGeneration] = useState(0);
  const [inlineEditorTab, setInlineEditorTab] = useState<string | null>(null);
  const [manager, setManager] = useState<{ base: ProfileTabCollection } | null>(null);
  const managerProgress = useRef<ProfileTabCollection | null>(null);
  const tabAttempts = useRef<Partial<Record<'shared' | 'private', { body: string; id: string }>>>({});
  const attempt = useRef<{ body: string; id: string } | null>(null), archiveAttempt = useRef<string | null>(null), alive = useRef(true), tabId = useId();
  const target = { kind: 'supplier' as const, id: item?.id ?? id }, tabData = useProfileTabs(target, Boolean(item));
  const canEdit = Boolean(realUser?.isActive && item && !preview && dataMode === 'live' && (item.countryCode !== 'SG' || realUser.isAdmin || realUser.isSpcTrader));
  const picOptions = useSupplierPicOptions(Boolean(draft && item?.countryCode === 'SG' && canEdit));
  useEffect(() => {
    if (!item) return;
    const controller = new AbortController(); setReports([]); setReportError('');
    void supplierReportsApi.list(item.id, controller.signal).then(result => { if (!controller.signal.aborted) setReports(result.items); }).catch(failure => { if (!controller.signal.aborted) setReportError(failure.message); });
    return () => controller.abort();
  }, [item?.id, reportGeneration]);
  const canPrivate = Boolean(realUser?.isActive && !preview && dataMode === 'live');
  useEffect(() => { setTab(initialKey(initialTab)); }, [initialTab]);
  // initialEditing applies only to the newly selected editor instance.
  useEffect(() => { setInlineEditorTab(null); }, [tab]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(''); setConflict(false);
    void supplierApi.detail(id, controller.signal).then(result => { if (!controller.signal.aborted) { setItem(result.item); setLoading(false); } }).catch(failure => { if (!controller.signal.aborted) { setItem(null); setError(failure.message); setLoading(false); } });
    return () => controller.abort();
  }, [id, generation]);
  useEffect(() => {
    const refresh = () => { if (!draft && !saving && !manager && !tabDirty) setGeneration(value => value + 1); };
    window.addEventListener('eco-suppliers-updated', refresh); window.addEventListener('focus', refresh);
    return () => { window.removeEventListener('eco-suppliers-updated', refresh); window.removeEventListener('focus', refresh); };
  }, [draft, saving, manager, tabDirty]);
  const dirty = Boolean(draft && item && JSON.stringify(draft) !== JSON.stringify(copyDraft(item)));
  useEffect(() => { if (!dirty) return; const beforeUnload = (event: BeforeUnloadEvent) => event.preventDefault(); window.addEventListener('beforeunload', beforeUnload); return () => window.removeEventListener('beforeunload', beforeUnload); }, [dirty]);
  function leave(action: () => void) { if (!saving && (!(dirty || tabDirty) || window.confirm('Discard unsaved supplier changes?'))) action(); }
  function reload() { leave(() => { setDraft(null); setManager(null); managerProgress.current = null; attempt.current = null; tabAttempts.current = {}; tabData.refresh(); setGeneration(value => value + 1); }); }
  function selectTab(next: string) {
    if (next === tab) return;
    leave(() => { setDraft(null); attempt.current = null; setTabDirty(false); setTab(next); });
  }
  function selectEditorTab(next: string) {
    const nextTab = visibleTabs.find(entry => entry.id === next);
    setTabDirty(false); setTab(next); attempt.current = null;
    setDraft(item && canEdit && nextTab?.builtin && nextTab.builtin !== 'sources' ? copyDraft(item) : null);
    setInlineEditorTab(nextTab && !nextTab.builtin ? next : null);
  }
  function prepareManager() {
    if (!canPrivate || !tabData.data) return;
    const base = structuredClone(tabData.data);
    setDraft(null); setTabDirty(false); attempt.current = null; tabAttempts.current = {};
    setTabEditorGeneration(value => value + 1);
    managerProgress.current = structuredClone(base); setManager({ base });
  }
  function openManager() { leave(prepareManager); }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!draft || saving || !canEdit || !item) return;
    if (!draft.legalName?.trim() || !draft.shortName?.trim()) { setError(item.countryCode === 'SG' ? 'Enter the supplier name and SPC short name.' : 'Enter the supplier name and short name.'); return; }
    if (supplierContacts({ contacts: draft.contacts, sources: item.sources }).some(contact => ![contact.name, contact.phone].some(value => value.trim()))) { setError('Enter a name or phone for each contact.'); return; }
    const changes = { ...draft, background: !item.background && draft.background === supplierBackground(item).map(fact => fact.value).join(' ') ? '' : draft.background };
    const body = JSON.stringify(changes); if (attempt.current?.body !== body) attempt.current = { body, id: crypto.randomUUID() };
    setSaving(true); setError(''); setMessage(''); setConflict(false);
    try { const result = await supplierApi.update({ ...changes, requestId: attempt.current.id }); if (!alive.current) return; setItem(result.item); setDraft(null); attempt.current = null; setMessage('CONTRIBUTION +1'); announceSupplierUpdate(); announceFeedbackUpdate(); }
    catch (failure) { if (alive.current) { setError((failure as Error).message); setConflict((failure as { status?: number }).status === 409); if ((failure as { status?: number }).status === 422) { attempt.current = null; picOptions.refresh(); } } }
    finally { if (alive.current) setSaving(false); }
  }
  async function removeSupplier() {
    if (!item || !canEdit || saving || !window.confirm(`Remove ${item.shortName} from ${item.portName} suppliers?`)) return;
    archiveAttempt.current ??= crypto.randomUUID(); setSaving(true); setError('');
    try { await supplierApi.archive({ requestId: archiveAttempt.current, id: item.id, revision: item.revision }); if (!alive.current) return; announceSupplierUpdate(); onBack(); }
    catch (failure) { setError((failure as Error).message); setConflict((failure as { status?: number }).status === 409); }
    finally { if (alive.current) setSaving(false); }
  }
  async function saveTabs(visibility: 'shared' | 'private', tabs: ProfileTab[], base: ProfileTabCollection) {
    if (!alive.current || (visibility === 'shared' ? !canEdit : !canPrivate)) throw new Error('Tab changes unavailable.');
    const payload = { target, visibility, revision: base[visibility].revision, tabs }, body = JSON.stringify(payload);
    if (tabAttempts.current[visibility]?.body !== body) tabAttempts.current[visibility] = { body, id: crypto.randomUUID() };
    const result = await profileTabsApi.save({ ...payload, requestId: tabAttempts.current[visibility]!.id });
    if (!alive.current) throw new Error('Tab changes unavailable.');
    tabData.accept(result); delete tabAttempts.current[visibility];
    if (visibility === 'shared') announceFeedbackUpdate();
    return result;
  }
  async function saveManagedTabs(tabs: ProfileTab[]) {
    if (!manager || !managerProgress.current) return;
    // Each scope has its own revision and retry key. Keep a successful scope when the next one fails.
    for (const visibility of ['private', 'shared'] as const) {
      if (visibility === 'shared' ? !canEdit : !canPrivate) continue;
      const base: ProfileTabCollection = managerProgress.current;
      const previous = visibility === 'shared' && base.shared.revision === 0 ? defaultTabs : base[visibility].tabs;
      const next = tabs.filter(entry => entry.visibility === visibility);
      if (sameTabs(previous, next)) continue;
      try {
        const result = await saveTabs(visibility, next, base);
        managerProgress.current = { ...base, [visibility]: result[visibility] };
      } catch (failure) {
        if (base.private.revision !== manager.base.private.revision) {
          throw Object.assign(new Error(`PRIVATE TABS SAVED. ${(failure as Error).message}`), { status: (failure as { status?: number }).status });
        }
        throw failure;
      }
    }
    setTab(tabs.find(entry => entry.id === tab)?.id ?? tabs[0]?.id ?? defaultTabs[0].id);
  }
  function updateInfo(key: keyof SupplierInfo, value: string) { setDraft(current => current ? { ...current, info: { ...current.info, [key]: value } } : null); }
  const sharedTabs = tabData.data?.shared.revision ? tabData.data.shared.tabs : defaultTabs;
  const visibleTabs = [...sharedTabs, ...(canPrivate ? tabData.data?.private.tabs ?? [] : [])];
  const active = visibleTabs.find(entry => entry.id === tab) ?? visibleTabs[0];
  const value = draft ?? item, contacts = value && item ? supplierContacts({ contacts: value.contacts, sources: item.sources }) : [];
  const sources = item?.sources.filter(source => source.type !== 'spc') ?? [], background = item ? supplierBackground(item) : [];
  const infospectrumSummary = item ? supplierInfospectrumSummary(item) : undefined;
  const sourceById = new Map(sources.map(source => [source.id, source]));
  function sourceLabel(sourceId: string) { const source = sourceById.get(sourceId); return source ? <button type="button" className="shared-supplier-source-link" onClick={() => selectTab(sharedTabs.find(entry => entry.builtin === 'sources')?.id ?? active?.id ?? '')}>{source.title}{source.documentDate ? ` · ${supplierDate(source.documentDate)}` : ''}</button> : null; }
  return <div className="shared-supplier-profile">
    <div className="shared-supplier-profile-toolbar"><button className="button secondary" disabled={saving} onClick={() => leave(onBack)}><ArrowLeft size={14} />{backLabel}</button>{onOpenDirectory && item && <button className="button secondary" disabled={saving} onClick={() => leave(() => onOpenDirectory(item.id))}>Supplier profile<ArrowUpRight size={14} /></button>}</div>
    {loading && <p role="status" className="shared-supplier-empty">Loading supplier…</p>}
    {error && <div className="shared-supplier-message" role="alert">{error}{(!item || conflict) && <button className="button secondary" onClick={reload}>{conflict ? 'Reload latest' : 'Retry'}</button>}</div>}
    {message && <p className="shared-supplier-message" role="status">{message}</p>}
    {!loading && item && value && <>
      <header className="shared-supplier-profile-heading"><div><h2>{supplierName(item)}</h2>{item.countryCode === 'SG' && <span>SPC: {supplierShortName(item)}</span>}{item.nameStatus === 'needs-review' && <strong className="shared-supplier-review">OFFICIAL NAME TO VERIFY</strong>}</div><div className="shared-supplier-heading-actions">{canEdit && !draft && <button className="button danger" disabled={saving} onClick={() => void removeSupplier()}>REMOVE SUPPLIER</button>}</div></header>
      <ProfileTabs tabs={visibleTabs.map(entry => ({ ...entry, title: entry.builtin === 'contacts' ? `${entry.title} (${contacts.length})` : entry.builtin === 'barges' ? `${entry.title} (${value.barges.length})` : entry.title }))} activeId={active?.id ?? ''} idPrefix={tabId} label="Supplier sections" onSelect={selectTab} onManage={canPrivate && tabData.data ? openManager : undefined} />
      {tabData.error && <div className="shared-supplier-message" role="alert">{tabData.error}<button className="button secondary" onClick={tabData.refresh}>Retry</button></div>}
      <div className="shared-supplier-profile-form">
        <div className="shared-supplier-profile-content" role="tabpanel" id={`${tabId}-panel`} aria-labelledby={active ? `${tabId}-${active.id}` : undefined}>
          {canEdit && !draft && active?.builtin && active.builtin !== 'sources' && <div className="shared-supplier-content-toolbar"><KnowledgeUpdateButton disabled={saving} onClick={() => { setDraft(copyDraft(item)); setMessage(''); setError(''); }} /></div>}
          {draft && active?.builtin === 'information' && <section className="shared-supplier-section"><header><h3>Supplier</h3></header><div className="shared-supplier-edit-grid"><label>Official name<input value={draft.legalName ?? ''} maxLength={300} disabled={saving} onChange={event => setDraft(current => current ? { ...current, legalName: event.target.value } : null)} /></label><label>{item.countryCode === 'SG' ? 'SPC short name' : 'Short name'}<input value={draft.shortName ?? ''} maxLength={100} disabled={saving} onChange={event => setDraft(current => current ? { ...current, shortName: event.target.value } : null)} /></label></div></section>}
          {active?.builtin === 'information' && <>
            <section className="shared-supplier-section supplier-key-section"><header><h3>KEY INFO</h3></header>{draft ? <><div className="shared-supplier-edit-grid">{infoFields.map(([key, label]) => <label key={key}>{label}{key === 'supplierTrader' && item.countryCode === 'SG' ? <select value={draft.info[key]} disabled={saving || picOptions.loading || Boolean(picOptions.error)} onChange={event => updateInfo(key, event.target.value)}>{supplierPicChoices(picOptions.options, draft.info[key]).map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}</select> : <input value={draft.info[key]} maxLength={2000} disabled={saving} onChange={event => updateInfo(key, event.target.value)} />}</label>)}</div>{picOptions.error && <div className="shared-supplier-message" role="alert">{picOptions.error}<button type="button" className="button secondary" onClick={picOptions.refresh}>RETRY</button></div>}</> : <SupplierKeyInfo info={item.info} />}</section>
            {infospectrumSummary && <section className="shared-supplier-section supplier-summary-section"><header><h3>INFOSPECTRUM SUMMARY</h3></header><p className="shared-supplier-background">{infospectrumSummary.text}</p><footer>{sourceLabel(infospectrumSummary.source.id)}{reports.filter(report => report.sourceId === infospectrumSummary.source.id).map(report => <ReportDownload key={report.id} report={report} />)}</footer></section>}
            {(draft || item.background || (!infospectrumSummary && background.length > 0)) && <section className="shared-supplier-section supplier-summary-section"><header><h3>Company background</h3></header>{draft ? <div className="shared-supplier-edit-grid"><label className="shared-supplier-wide">Company background<textarea rows={6} maxLength={8000} value={draft.background ?? ''} disabled={saving} onChange={event => setDraft(current => current ? { ...current, background: event.target.value } : null)} /></label></div> : item.background ? <p className="shared-supplier-background">{item.background}</p> : <div className="shared-supplier-background"><p>{background.map(fact => fact.value).join(' ')}</p>{[...new Set(background.map(fact => fact.sourceId))].map(sourceId => <div key={sourceId}>{sourceLabel(sourceId)}{reports.filter(report => report.sourceId === sourceId).map(report => <ReportDownload key={report.id} report={report} />)}</div>)}</div>}</section>}
          </>}
          {active?.builtin === 'contacts' && <section className="shared-supplier-section"><header><h3>Contacts</h3>{draft && <button type="button" className="button secondary" disabled={saving || value.contacts.length >= 100} onClick={() => setDraft(current => current ? { ...current, contacts: [...current.contacts, { id: crypto.randomUUID(), role: 'sales', name: '', phone: '', email: '', sourceId: '' }] } : null)}><Plus size={14} />Add contact</button>}</header>
            {contacts.length ? <div className="shared-supplier-contact-groups">{(['sales', 'ops', 'general'] as const).filter(role => contacts.some(contact => contact.role === role)).map(role => <section key={role}><h4>{role === 'sales' ? 'Sales' : role === 'ops' ? 'Operation' : 'Contacts'}</h4><table><thead><tr><th>Name</th><th>Phone</th>{draft && <th>Role</th>}{draft && <th><span className="profile-tabs-sr">Actions</span></th>}</tr></thead><tbody>{contacts.filter(contact => contact.role === role).map(contact => <tr key={contact.id}>{(['name', 'phone'] as const).map(key => <td key={key}>{draft ? <input aria-label={`Contact ${contacts.findIndex(entry => entry.id === contact.id) + 1} ${key}`} value={contact[key]} maxLength={200} disabled={saving} onChange={event => setDraft(current => current ? { ...current, contacts: current.contacts.map(entry => entry.id === contact.id ? { ...entry, [key]: event.target.value } : entry) } : null)} /> : contact[key] || '—'}</td>)}{draft && <><td><select aria-label={`Contact ${contacts.findIndex(entry => entry.id === contact.id) + 1} role`} value={contact.role} disabled={saving} onChange={event => setDraft(current => current ? { ...current, contacts: current.contacts.map(entry => entry.id === contact.id ? { ...entry, role: event.target.value as typeof entry.role } : entry) } : null)}><option value="sales">Sales</option><option value="ops">Operation</option>{role === 'general' && <option value="general">Contacts</option>}</select></td><td><button type="button" className="icon-button" aria-label={`Remove contact ${contact.name || contact.id}`} disabled={saving} onClick={() => setDraft(current => current ? { ...current, contacts: current.contacts.filter(entry => entry.id !== contact.id) } : null)}><Trash2 size={14} /></button></td></>}</tr>)}</tbody></table></section>)}</div> : <p className="shared-supplier-empty">No contacts recorded.</p>}
          </section>}
          {active?.builtin === 'barges' && <section className="shared-supplier-section"><header><h3>Barge fleet</h3>{draft && <button type="button" className="button secondary" disabled={saving || value.barges.length >= 200} onClick={() => setDraft(current => current ? { ...current, barges: [...current.barges, { id: crypto.randomUUID(), name: '', imo: '', grade: '', capacity: '', sourceId: '' }] } : null)}><Plus size={14} />Add barge</button>}</header>{value.barges.length ? <div className="shared-supplier-records">{value.barges.map((barge, index) => <article className="shared-supplier-record" key={barge.id}>{draft ? <><div className="shared-supplier-edit-grid">{(['name', 'imo', 'grade', 'capacity'] as const).map(key => <label key={key}>{key}<input aria-label={`Barge ${index + 1} ${key}`} required={key === 'name'} value={barge[key]} maxLength={200} disabled={saving} onChange={event => setDraft(current => current ? { ...current, barges: current.barges.map(entry => entry.id === barge.id ? { ...entry, [key]: event.target.value } : entry) } : null)} /></label>)}</div><button type="button" className="button danger" aria-label={`Remove barge ${index + 1}`} disabled={saving} onClick={() => setDraft(current => current ? { ...current, barges: current.barges.filter(entry => entry.id !== barge.id) } : null)}><Trash2 size={14} />Remove</button></> : <><header><strong>{barge.name || '—'}</strong></header><dl><div><dt>IMO</dt><dd>{barge.imo || '—'}</dd></div><div><dt>Grade</dt><dd>{barge.grade || '—'}</dd></div><div><dt>Capacity</dt><dd>{barge.capacity || '—'}</dd></div></dl></>}</article>)}</div> : <p className="shared-supplier-empty">No barges recorded.</p>}</section>}
          {active?.builtin === 'sources' && <section className="shared-supplier-section"><header><h3>Sources</h3></header>{reportError && <div role="alert" className="shared-supplier-message">{reportError}<button type="button" className="button secondary" onClick={() => setReportGeneration(value => value + 1)}>Retry</button></div>}{sources.map(source => <Source key={source.id} source={source} reports={reports.filter(report => report.sourceId === source.id)} />)}{!sources.length && <p className="shared-supplier-empty">No sources recorded.</p>}</section>}
          {active && !active.builtin && tabData.data && <ProfileTabContent key={`${active.id}-${generation}-${tabEditorGeneration}`} tab={active} onDirtyChange={setTabDirty} canEdit={active.visibility === 'private' ? canPrivate : canEdit} editorTabs={visibleTabs} editorTabId={active.id} initialEditing={inlineEditorTab === active.id} onSelectEditorTab={selectEditorTab} onManageTabs={canPrivate && tabData.data ? prepareManager : undefined} onSave={async content => { try { await saveTabs(active.visibility, tabData.data![active.visibility].tabs.map(entry => entry.id === active.id ? { ...entry, content } : entry), tabData.data!); } catch (failure) { if ((failure as { status?: number }).status === 409) { setError((failure as Error).message); setConflict(true); } throw failure; } }} />}
        </div>
        {draft && <form className="shared-supplier-save" onSubmit={save}><button type="button" className="button secondary" disabled={saving} onClick={() => leave(() => { setDraft(null); attempt.current = null; setError(''); })}>Cancel</button><KnowledgeUpdateButton type="submit" disabled={saving || !canEdit || !dirty}>{saving ? 'SAVING…' : 'SAVE'}</KnowledgeUpdateButton></form>}
      </div>
      {manager && <ManageProfileTabs tabs={[...manager.base.private.tabs, ...(manager.base.shared.revision === 0 ? defaultTabs : manager.base.shared.tabs)]} defaults={defaultTabs} canManageShared={canEdit} canManagePrivate={canPrivate} createTab={entry => ({ id: entry.builtin ? `builtin:${entry.builtin}` : entry.id, title: entry.title, visibility: entry.visibility, ...(entry.builtin ? { builtin: entry.builtin as ProfileTab['builtin'] } : { content: '' }) })} onSave={saveManagedTabs} onClose={() => { setManager(null); managerProgress.current = null; }} onReload={reload} />}
    </>}
  </div>;
}
function Source({ source, reports }: { source: SupplierSource; reports: SupplierReport[] }) {
  const url = supplierSourceUrl(source.url);
  return <article className="shared-supplier-source"><h4>{url ? <a href={url} target="_blank" rel="noopener noreferrer">{source.title}<ArrowUpRight size={14} /></a> : source.title}</h4><dl><div><dt>Source</dt><dd>{source.type}</dd></div>{source.documentDate && <div><dt>Document date</dt><dd>{supplierDate(source.documentDate)}</dd></div>}{source.retrievedAt && <div><dt>Retrieved</dt><dd>{supplierDate(source.retrievedAt)}</dd></div>}{source.reference && <div><dt>Reference</dt><dd>{source.reference}</dd></div>}</dl>{reports.map(report => <ReportDownload key={report.id} report={report} />)}</article>;
}


function ReportDownload({ report }: { report: SupplierReport }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <span className="shared-supplier-report"><button type="button" className="button secondary" disabled={busy} onClick={() => { setBusy(true); setError(''); void supplierReportsApi.download(report.id).then(result => { const url = supplierSourceUrl(result.url); if (!url) throw new Error('Report download unavailable.'); const link = document.createElement('a'); link.href = url; link.download = report.fileName; link.rel = 'noopener'; link.click(); }).catch(failure => setError((failure as Error).message)).finally(() => setBusy(false)); }}>{busy ? 'Loading PDF…' : 'PDF'}</button>{error && <span role="alert">{error}</span>}</span>;
}
