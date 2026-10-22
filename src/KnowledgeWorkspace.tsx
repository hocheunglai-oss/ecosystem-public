import { ProfileTabs } from "./ProfileTabs";
import { usePrivateProfileTabs, PrivateProfileTabPanel, PrivateProfileTabsStatus } from "./PrivateProfileTabs";
import KnowledgeUpdateButton from "./KnowledgeUpdateButton";
import AttachmentsButton from "./AttachmentsButton";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Check, FileText, History, Plus, Search, X } from "lucide-react";
import { useDemo } from "./store";
import { actors } from "./lib/model";
import { isEmailText } from "./lib/uppercase";
import TextWithLinks from './TextWithLinks';
import { useIntelligence } from "./Intelligence";
import { getLocationIntelligence, getSupplierIntelligence } from "./lib/intelligence";
import { hatForEntry, type HatTarget } from "./lib/hats";
import { knowledgeBlockMatches, knowledgeRowMatches, matchesKnowledgeSearch, portBuyPriceRows } from "./lib/knowledgeSearch";
import { indexSupplierFixtures, querySupplierFixtures } from "./lib/supplierFixtures";
import {
  canonicalTarget,
  knowledgeSectionRole,
  isReadOnlyKnowledgeSection,
  knowledgeDocument,
  knowledgeKey,
  knowledgeName,
  knowledgeEntryUpdateLookup,
  knowledgeKeyInfoUpdate,
  type KnowledgeDocument,
  type KnowledgeEntryUpdate,
  type KnowledgeTarget,
  type KnowledgeBlock,
  type KnowledgeRevision,
} from "./lib/knowledge";
import { KnowledgeEditor, KnowledgeComparison } from "./KnowledgeEditor";
import { KnowledgeTopSuppliers } from "./KnowledgeTopSuppliers";
import { SupplierFixtures } from "./SupplierFixtures";
import SupplierWorkspace from "./SupplierWorkspace";
import { useSupplierList } from "./lib/supplierApi";
import { supplierPortForLocation } from "../shared/supplierPorts";
import { ManageKnowledgeTabs, type KnowledgeTabSource } from "./ManageKnowledgeTabs";
import { date, Modal } from "./ui";
import { ResourceIcon } from "./ResourceWallet";
import PortBuyPrices from "./PortBuyPrices";
import type { OpenModal } from "./types";
import type {
  OpenWorkspace,
  WorkspaceNavigationContext,
} from "./workspaceNavigation";
import "./knowledge.css";
import "./knowledge-attribution.css";
import SearchableSelect from "./SearchableSelect";
import { useAccess } from "./auth";
import { locationCountries, locationProfileTarget, profileCountryTarget, locationCountryForPort, locationChildren } from "./lib/locations";
import { portLocalTime } from "./lib/portTime";
import type { Port } from "./lib/model";
import CountryPublicHolidays from "./CountryPublicHolidays";
import OfficialFuelTable, { officialTableMatches, useOfficialFuelTable } from './OfficialFuelTable';
import { isOfficialNotes, officialNotes } from './lib/officialTableNotes';
import LocationStorageStatus from './LocationStorageStatus';
import { useLocationHistory } from './lib/useLocationHistory';
import { useTestWorkspace } from './TestWorkspace';

const keyInfoFields = [
  ["qualityClaim", "30 days quality claim period"],
  ["isoSpecs", "ISO Specs"],
  ["sampleLocation", "Sample Location"],
  ["debunkering", "Debunkering"],
] as const;

export function KnowledgePage({
  kind,
  context,
  open,
  onOpen,
}: {
  kind: "port" | "country";
  context?: WorkspaceNavigationContext;
  open: OpenModal;
  onOpen: OpenWorkspace;
}) {
  const { state } = useDemo();
  const records =
    kind === "port"
      ? state.ports.map((p) => ({
          id: p.id,
          name: p.name,
          detail: getLocationIntelligence(p).countryName,
        }))
      : locationCountries(state).map(({ id, name }) => ({ id, name, detail: "" }));
  const initial = kind === "port" ? context?.portId : context?.country;
  const [selected, setSelected] = useState(initial ?? records[0]?.id ?? "");
  const profileDirty = useRef(false);
  useEffect(() => {
    if (initial && initial !== selected) {
      if (profileDirty.current && !window.confirm('DISCARD UNSAVED CHANGES?')) return;
      profileDirty.current = false; setSelected(initial);
    }
  }, [initial]);
  const current = records.find((r) => r.id === selected) ?? records[0];
  if (!current) return null;
  return (
    <div className="knowledge-page">
      <LocationStorageStatus />
      <div className="knowledge-record-picker">
        <SearchableSelect
          label={kind === "port" ? "Port record" : "Country record"}
          value={current.id}
          onChange={id => { if (id !== selected && profileDirty.current && !window.confirm('DISCARD UNSAVED CHANGES?')) return; profileDirty.current = false; setSelected(id); }}
          options={records.map((r) => ({
            value: r.id,
            label: r.name,
            keywords: r.detail,
          }))}
          placeholder={`Search ${kind === "port" ? "ports" : "countries"}`}
        />
      </div>
      <KnowledgePanel
        key={`${kind}:${current.id}`}
        target={{ kind, id: current.id }}
        onDirtyChange={dirty => { profileDirty.current = dirty; }}
        open={open}
        onOpen={onOpen}
      />
    </div>
  );
}

export function KnowledgePanel({
  target,
  open,
  onOpen,
  onOpenSupplier,
  fixedLayout = false,
  navigation,
  supplierInformation,
  supplierInformationSearch,
  onDirtyChange,
  onOpenPort,
}: {
  target: KnowledgeTarget;
  open: OpenModal;
  onOpen?: OpenWorkspace;
  onOpenSupplier?: (portId: string, supplierId: string) => void;
  fixedLayout?: boolean;
  navigation?: ReactNode;
  supplierInformation?: ReactNode;
  supplierInformationSearch?: string;
  onDirtyChange?: (dirty: boolean) => void;
  onOpenPort?: (portId: string) => void;
}) {
  const { state, actor, locations } = useDemo();
  const { realUser, preview } = useAccess();
  const { snapshot: intelligence } = useIntelligence();
  const canEdit = Boolean(realUser?.isActive && realUser.activated && !preview && (!['country', 'port', 'area'].includes(target.kind) || locations.ready));
  const tabId = useId();
  const content = useRef<HTMLDivElement>(null);
  const actual = canonicalTarget(state, locationProfileTarget(state, target));
  const isLocation = actual.kind === "country" || actual.kind === "port";
  const managedProfile = isLocation || actual.kind === "supplier";
  const countryTarget = profileCountryTarget(state, actual);
  const privateTabs = usePrivateProfileTabs({ kind: actual.kind === "country" ? "country" : "port", id: actual.id }, isLocation);
  const countryPrivateTabs = usePrivateProfileTabs({ kind: "country", id: countryTarget?.id ?? "" }, Boolean(countryTarget));
  const privateEntries = [
    ...privateTabs.tabs.map(tab => ({ id: `private:${tab.id}`, tab, controller: privateTabs })),
    ...countryPrivateTabs.tabs.map(tab => ({ id: `private-country:${tab.id}`, tab, controller: countryPrivateTabs })),
  ];
  const canManageTabs = canEdit && managedProfile && [privateTabs, countryPrivateTabs].every(controller => !controller.allowed || Boolean(controller.data));
  const key = knowledgeKey(state, actual);
  const doc = useMemo(() => knowledgeDocument(state, actual), [state, actual.kind, actual.id]);
  const countryDoc = useMemo(() => countryTarget ? knowledgeDocument(state, countryTarget) : undefined, [state, countryTarget?.kind, countryTarget?.id]);
  const entryUpdate = useMemo(() => knowledgeEntryUpdateLookup(state, actual, doc), [state, actual.kind, actual.id, doc]);
  const countryEntryUpdate = useMemo(() => countryTarget && countryDoc ? knowledgeEntryUpdateLookup(state, countryTarget, countryDoc) : undefined, [state, countryTarget?.kind, countryTarget?.id, countryDoc]);
  const profileSections = useMemo(() => {
    const sections = doc.sections.map((section) => ({
      id: section.id, title: section.title, role: knowledgeSectionRole(section), target: actual, document: doc, sectionId: section.id,
      sources: [{ target: actual, document: doc, sectionId: section.id }] as KnowledgeTabSource[],
      entries: section.blocks.map((block) => ({ block, target: actual, document: doc, sectionId: section.id })),
    }));
    if (countryTarget && countryDoc) for (const section of countryDoc.sections) {
      const entries = section.blocks.map((block) => ({ block, target: countryTarget, document: countryDoc, sectionId: section.id }));
      const role = knowledgeSectionRole(section);
      const source = { target: countryTarget, document: countryDoc, sectionId: section.id };
      const match = sections.find((item) => role ? item.role === role : !item.role && item.title.trim().toLowerCase() === section.title.trim().toLowerCase());
      if (match) { match.entries.push(...entries); match.sources.push(source); }
      else sections.push({ id: `country:${section.id}`, title: section.title, role, ...source, sources: [source], entries });
    }
    return sections;
  }, [doc, countryDoc, actual.kind, actual.id, countryTarget?.kind, countryTarget?.id]);
  const port = actual.kind === "port"
    ? state.ports.find((item) => item.id === actual.id)
    : undefined;
  const info = port ? getLocationIntelligence(port, state.knowledgeRecords) : undefined;
  const [sectionId, setSectionId] = useState(doc.sections[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [panel, setPanel] = useState<"history" | null>(null);
  const [editing, setEditing] = useState<{
    mode: "edit" | "section" | "rename" | "text" | "table";
    target: KnowledgeTarget;
    document: KnowledgeDocument;
    sectionId?: string;
    blockId?: string;
  }>();
  const [editingDirty, setEditingDirty] = useState(false);
  const [privateEditorId, setPrivateEditorId] = useState<string>();
  useEffect(() => { onDirtyChange?.(editingDirty || privateTabs.dirty || countryPrivateTabs.dirty); return () => onDirtyChange?.(false); }, [editingDirty, privateTabs.dirty, countryPrivateTabs.dirty, onDirtyChange]);
  const [revision, setRevision] = useState<KnowledgeRevision>();
  const [managing, setManaging] = useState(false);
  const countryKey = countryTarget ? knowledgeKey(state, countryTarget) : undefined;
  const { namespace } = useTestWorkspace();
  const sharedHistory = useLocationHistory(countryTarget ? [actual, countryTarget] : [actual],
    locations.enabled && isLocation && panel === 'history', locations.data?.revision ?? 0, namespace);
  const localHistory = (state.knowledgeHistory ?? []).filter((item) => {
    const itemKey = knowledgeKey(state, item.target);
    return itemKey === key || itemKey === countryKey;
  }).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const history = locations.enabled && isLocation ? sharedHistory.page?.items ?? [] : localHistory;
  const historyTotal = locations.enabled && isLocation ? sharedHistory.page?.total : history.length;
  const activePrivateEntry = privateEntries.find(entry => entry.id === sectionId);
  const activePrivate = activePrivateEntry?.tab;
  const active = profileSections.find((section) => section.id === sectionId) ?? profileSections[0];
  const countryPorts = actual.kind === "country" ? locationChildren(state, actual) : [];
  const hasPortsTab = actual.kind === "country" && countryPorts.length > 1;
  const reservedTabIds = new Set([...profileSections.map(section => section.id), ...privateEntries.map(entry => entry.id)]);
  let portsTabId = "location-ports";
  while (reservedTabIds.has(portsTabId)) portsTabId += "-list";
  const showingPorts = hasPortsTab && sectionId === portsTabId;
  const showingPrices = Boolean(port && active?.role === "price-history");
  const showingFixtures = actual.kind === "supplier" && active?.role === "supplier-fixtures";
  const showingSupplierDirectory = Boolean(port && active?.role === "suppliers");
  const readOnlySection = showingPorts || showingPrices || showingFixtures || (showingSupplierDirectory && !active?.entries.length);
  const tabs = profileSections;
  const selectedTabId = activePrivateEntry?.id ?? (showingPorts ? portsTabId : active?.id);
  const editorTabs = [
    ...privateEntries.map(({ id, tab }) => ({ id, title: tab.title, visibility: 'private' as const })),
    ...tabs.filter(tab => !isReadOnlyKnowledgeSection({ id: tab.id, title: tab.title, role: tab.role, blocks: [] })).map(tab => ({ id: tab.id, title: tab.title, visibility: 'shared' as const })),
  ];
  const searching = Boolean(query.trim());
  const officialSection = port?.id === 'port-singapore' ? profileSections.find(section => section.entries.some(entry => isOfficialNotes(entry.block))) ?? profileSections.find(section => section.role === 'grades-delivery') : undefined;
  const officialEntry = officialSection?.entries.find(entry => isOfficialNotes(entry.block));
  const officialNotesValues = officialNotes(officialSection ? { blocks: officialSection.entries.map(entry => entry.block) } : undefined);
  const officialFeed = useOfficialFuelTable(Boolean(officialSection && (searching || active?.id === officialSection.id)));
  const renderOfficialTable = (query = '') => <OfficialFuelTable {...officialFeed} notes={officialNotesValues} query={query} />;
  const supplierSearch = query.trim();
  const supplierScope = port ? supplierPortForLocation(port) : undefined;
  const supplierSections = profileSections.filter(section => section.role === "suppliers");
  const checkSupplierMatches = Boolean(searching && supplierScope && supplierSections.some(section => !matchesKnowledgeSearch(supplierSearch, section.title)));
  const supplierMatches = useSupplierList({ portId: supplierScope?.id, search: supplierSearch, limit: 1 }, checkSupplierMatches);
  const matchingPorts = hasPortsTab && searching ? countryPorts.filter(item => matchesKnowledgeSearch(query, "Ports", item.name, item.country)) : [];
  const supplierFixtureRecords = useMemo(() => actual.kind === "supplier" && searching
    ? indexSupplierFixtures(state, actor, actual.id) : [],
  [actual.kind, actual.id, searching, state.outcomes, state.enquiries, state.companies, state.ports, actor]);
  const searchSections = searching ? profileSections.map(section => {
    const titleMatches = matchesKnowledgeSearch(query, section.title);
    const sectionQuery = titleMatches ? "" : query;
    const entries = section.entries.filter(entry => entry !== officialEntry && knowledgeBlockMatches(entry.block, sectionQuery));
    const official = section.id === officialSection?.id && officialTableMatches(officialFeed.snapshot, officialNotesValues, sectionQuery);
    const facts = Boolean(port && info && section.role === "port-information" && keyInfoFields.some(([field, label]) => matchesKnowledgeSearch(sectionQuery, "Key Info", label, info.keyInfo[field])));
    const suppliers = Boolean(port && section.role === "port-information" && getSupplierIntelligence(port.id, intelligence).suppliers.some(supplier => matchesKnowledgeSearch(sectionQuery, "Top Suppliers", supplier.name, ...supplier.grades)));
    const prices = Boolean(port && section.role === "price-history" && (titleMatches || portBuyPriceRows(state, port.id, sectionQuery).length));
    const fixtures = actual.kind === "supplier" && section.role === "supplier-fixtures" && (titleMatches || querySupplierFixtures(supplierFixtureRecords, { search: sectionQuery }).total > 0);
    const supplierDirectory = Boolean(port && section.role === "suppliers" && (titleMatches || (checkSupplierMatches && (supplierMatches.data?.total ?? 0) > 0)));
    const supplierDetails = actual.kind === "supplier" && section.role === "supplier-information" && Boolean(supplierInformation) && matchesKnowledgeSearch(sectionQuery, supplierInformationSearch);
    return { ...section, entries, facts, suppliers, prices, fixtures, supplierDetails, supplierDirectory, official, query: sectionQuery.trim() };
  }).filter(section => section.entries.length || section.facts || section.suppliers || section.prices || section.fixtures || section.supplierDetails || section.supplierDirectory || section.official || matchesKnowledgeSearch(query, section.title)) : [];
  const openEditor = (
    mode: NonNullable<typeof editing>["mode"],
    source: { target: KnowledgeTarget; document: KnowledgeDocument; sectionId: string } = active,
    blockId?: string,
  ) => setEditing({ mode, target: source.target, document: source.document, sectionId: source.sectionId, blockId });
  const countries = locationCountries(state);
  const portCountry = !countryTarget ? countries.find((country) => country.name === info?.countryName) : undefined;
  const countryName = countries.find((country) => country.id === actual.id)?.name;
  const holidayCountry = port ? locationCountryForPort(state, port)?.name ?? port.country : countryName;
  const leaveEditor = (action: () => void) => {
    if (editingDirty && !window.confirm('DISCARD UNSAVED CHANGES?')) return;
    privateTabs.leave(() => countryPrivateTabs.leave(() => { setEditing(undefined); setEditingDirty(false); setPrivateEditorId(undefined); action(); }));
  };
  const manageTabs = () => leaveEditor(() => setManaging(true));
  const selectEditorTab = (id: string) => {
    setEditingDirty(false); privateTabs.setDirty(false); countryPrivateTabs.setDirty(false); setSectionId(id); setQuery(''); setPanel(null);
    if (privateEntries.some(entry => entry.id === id)) { setEditing(undefined); setPrivateEditorId(id); }
    else { const next = tabs.find(tab => tab.id === id); if (next) openEditor('edit', next); setPrivateEditorId(undefined); }
  };
  const selectSection = (id: string) => leaveEditor(() => {
    setSectionId(id);
    setQuery("");
    setPanel(null);
    content.current?.scrollTo({ top: 0 });
  });
  const renderKeyInfo = (search = "") => port && info && <div className="knowledge-facts">
    <header>
      <h3>Key Info</h3>
      <AttachmentsButton scope={{ target: actual, section: { id: 'key-info', name: 'Key Info' } }} />
    </header>
    <dl>{keyInfoFields.filter(([field, label]) => matchesKnowledgeSearch(search, "Key Info", label, info.keyInfo[field])).map(([field, label]) => <div key={field}>
      <dt className="knowledge-fact-title"><span>{label}</span><KnowledgeEntryAttribution label={label} update={knowledgeKeyInfoUpdate(state, port.id, field)} hatTarget={{ kind: "key-info", portId: port.id, field }} /></dt>
      <dd className="knowledge-fact-value">
        <span>{info.keyInfo[field] || "—"}</span>
      </dd>
    </div>)}</dl>
  </div>;
  const renderTopSuppliers = (search = "") => port && <KnowledgeTopSuppliers portId={port.id} search={search} onOpen={onOpenSupplier
    ? supplierId => onOpenSupplier(port.id, supplierId)
    : onOpen ? supplierId => onOpen("suppliers", { portId: port.id, supplierId }) : undefined} />;
  const renderEntry = (entry: typeof profileSections[number]["entries"][number], search = "") => {
    const { block } = entry;
    if (entry === officialEntry) return null;
    const getUpdate = entry.target.kind === "country" && countryEntryUpdate ? countryEntryUpdate : entryUpdate;
    return <KnowledgeBlockView key={`${knowledgeKey(state, entry.target)}:${block.id}`} block={block} query={search} showUpdate
      hatTarget={{ kind: "knowledge", target: entry.target, blockId: block.id }}
      update={getUpdate(block.id)}
      rowUpdates={block.type === "table" ? Object.fromEntries(block.rows.map(row => [row.id, getUpdate(block.id, row.id)])) : undefined}
      onEdit={canEdit ? () => openEditor("edit", entry, block.id) : undefined} />;
  };
  const renderPortList = (items: typeof countryPorts) => <section className="location-directory" aria-label="Ports in this country">
    <div className="location-filter-bar"><h3>Ports</h3><span>{items.length}</span></div>
    <div className="location-table-wrap"><table className="location-table"><thead><tr><th>Port</th><th>Country</th><th /></tr></thead><tbody>
      {items.map(item => {
        const openPort = () => { if (onOpenPort) onOpenPort(item.target.id); else onOpen?.("ports", { portId: item.target.id }); };
        return <tr key={item.key}><td><button onClick={openPort}>{item.name}</button></td><td>{item.country}</td><td><button aria-label={`Open ${item.name}`} onClick={openPort}><ArrowUpRight size={14} /></button></td></tr>;
      })}
    </tbody></table></div>
  </section>;
  const editingSources = editing ? profileSections.find(section => section.sources.some(source => source.target.kind === editing.target.kind && source.target.id === editing.target.id && source.sectionId === editing.sectionId))?.sources ?? [] : [];
  return (
    <section className={`knowledge${managedProfile ? " knowledge--open" : ""}${fixedLayout ? " knowledge-fixed-layout" : ""}`} aria-label={`${knowledgeName(state, actual)} information`}>
      <header className="knowledge-header">
        <div className="knowledge-name">
          {target.kind === "company" ? (
            <h3>General Information</h3>
          ) : (
            <h2>{knowledgeName(state, actual)}</h2>
          )}
          {port && <PortCurrentTime port={port} />}
          {port && countryTarget && holidayCountry && holidayCountry.toLowerCase() !== port.name.toLowerCase() && <span className="knowledge-profile-country">{holidayCountry}</span>}
          {isLocation && holidayCountry && <CountryPublicHolidays country={holidayCountry} port={port} />}
          {navigation}
        </div>
        <label className="knowledge-profile-search">
          <Search size={14} aria-hidden="true" />
          <input aria-label="Search all tabs" placeholder="Search all tabs" maxLength={160} value={query}
            onChange={event => { const value = event.target.value; leaveEditor(() => { setQuery(value); setPanel(null); content.current?.scrollTo({ top: 0 }); }); }}
            onKeyDown={event => { if (event.key === "Escape" && query) { event.preventDefault(); event.stopPropagation(); setQuery(""); } }} />
          {query && <button type="button" aria-label="Clear information search" onClick={() => setQuery("")}><X size={13} /></button>}
        </label>
        <div className="knowledge-tools">
          {!activePrivate && <AttachmentsButton scope={{ target: actual }} />}
          {!activePrivate && <button
            className={panel === "history" ? "selected" : ""}
            onClick={() => leaveEditor(() => setPanel(panel === "history" ? null : "history"))}
            aria-pressed={panel === "history"}
          >
            <History size={14} /> History {historyTotal !== undefined && <small>{historyTotal}</small>}
          </button>}
        </div>
      </header>
      <div className="knowledge-layout">
        <ProfileTabs tabs={[...(hasPortsTab ? [{ id: portsTabId, title: "Ports", visibility: 'shared' as const }] : []), ...tabs.map(tab => ({ id: tab.id, title: tab.title, visibility: 'shared' as const })), ...privateEntries.map(({ id, tab }) => ({ ...tab, id }))]}
          activeId={panel ? '' : selectedTabId ?? ''} idPrefix={`${tabId}-tab`} label="Information sections" onSelect={selectSection}
          onManage={canManageTabs ? manageTabs : undefined}>
          {!managedProfile && canEdit && <button className="knowledge-manage-button" onClick={() => openEditor("section")}><Plus size={14} /> Add Tab</button>}
        </ProfileTabs>
        <PrivateProfileTabsStatus controller={privateTabs} />
        <PrivateProfileTabsStatus controller={countryPrivateTabs} />
        <div className={`knowledge-content${showingSupplierDirectory && !active?.entries.length && !activePrivate && !panel && !searching ? " knowledge-content--suppliers" : ""}`}
          ref={content}
          onScroll={(event) => event.currentTarget.querySelectorAll<HTMLElement>("[popover]:popover-open").forEach(popover => popover.hidePopover())}
          id={`${tabId}-tab-panel`}
          role={panel || searching ? "region" : "tabpanel"}
          aria-label={searching ? "Search all tabs" : panel ? "History" : undefined}
          aria-labelledby={panel || searching ? undefined : `${tabId}-tab-${selectedTabId}`}
          tabIndex={panel ? undefined : 0}
        >
          {!editing && !activePrivate && !panel && !searching && active && !readOnlySection && <header className="knowledge-content-toolbar">
            <h3>{active.title}</h3>
            {canEdit && <div className="knowledge-inline-tools">
              <KnowledgeUpdateButton onClick={() => openEditor('edit')} />
            </div>}
          </header>}
          {editing ? (<>
        {editingSources.length > 1 && <label className="knowledge-edit-source">Information source<select aria-label="Information source" value={`${editing.target.kind}:${editing.target.id}:${editing.sectionId}`} onChange={event => {
          const source = editingSources.find(item => `${item.target.kind}:${item.target.id}:${item.sectionId}` === event.target.value);
          if (source) leaveEditor(() => openEditor('edit', source));
        }}>{editingSources.map(source => <option key={`${source.target.kind}:${source.target.id}`} value={`${source.target.kind}:${source.target.id}:${source.sectionId}`}>{knowledgeName(state, source.target)} ({source.target.kind})</option>)}</select></label>}
        <KnowledgeEditor
          key={`${editing.target.kind}:${editing.target.id}:${editing.sectionId}:${editing.blockId ?? ''}:${editing.mode}`}
          embedded
          onDirtyChange={setEditingDirty}
          editorTabs={editorTabs}
          editorTabId={selectedTabId}
          onSelectEditorTab={selectEditorTab}
          target={editing.target}
          initial={editing.document}
          initialSection={editing.sectionId}
          initialBlock={editing.blockId}
          officialTable={Boolean(officialSection && editing.sectionId === (officialEntry?.sectionId ?? officialSection.sectionId) && editing.target.kind === (officialEntry?.target.kind ?? officialSection.target.kind) && editing.target.id === (officialEntry?.target.id ?? officialSection.target.id))}
          keyInfoPortId={port && editing.target.kind === 'port' && editing.target.id === port.id && editing.document.sections.some(section => section.id === editing.sectionId && knowledgeSectionRole(section) === 'port-information') ? port.id : undefined}
          mode={editing.mode}
          reservedTabNames={tabs.map((tab) => tab.title)}
          onManageTabs={canManageTabs ? () => { setEditing(undefined); setEditingDirty(false); setManaging(true); } : undefined}
          onClose={() => { setEditing(undefined); setEditingDirty(false); }}
          onSaved={(id, title) => {
            const countrySource = countryTarget && knowledgeKey(state, editing.target) === countryKey;
            const savedTitle = title ?? editing.document.sections.find((section) => section.id === id)?.title;
            const savedRole = knowledgeSectionRole(editing.document.sections.find((section) => section.id === id) ?? { id, title: savedTitle ?? "", blocks: [] });
            const matchingPort = countrySource ? doc.sections.find((section) => savedRole ? knowledgeSectionRole(section) === savedRole : !knowledgeSectionRole(section) && section.title.trim().toLowerCase() === savedTitle?.trim().toLowerCase()) : undefined;
            setSectionId(countrySource ? matchingPort?.id ?? `country:${id}` : id);
            setQuery("");
            setPanel(null);
          }}
        /></>
      ) : panel === "history" ? (
            <>
              <header className="knowledge-section-head">
                <h3>History</h3>
                <button aria-label="Close information panel" onClick={() => setPanel(null)}><X size={16} /></button>
              </header>
              {locations.enabled && isLocation && sharedHistory.loading && <p role="status">Loading history…</p>}
              {locations.enabled && isLocation && sharedHistory.error && <div role="alert">{sharedHistory.error} <button className="button secondary small" onClick={sharedHistory.refresh}>Retry</button></div>}
              {history.length ? history.map((item) => (
                <button className="knowledge-history-row" key={`${knowledgeKey(state, item.target)}:${item.version}:${item.at}`} onClick={() => setRevision(item)}>
                  <span>
                    <strong>{actors.find((person) => person.id === item.by)?.name ?? item.by}</strong>
                    <small>{item.reason}</small>
                  </span>
                  <span>{date(item.at)} · v{item.version}</span>
                </button>
              )) : !(locations.enabled && isLocation && (sharedHistory.loading || sharedHistory.error)) && <p className="knowledge-empty">No changes</p>}
              {locations.enabled && isLocation && sharedHistory.page?.nextCursor && <button className="button secondary small" disabled={sharedHistory.loading} onClick={() => void sharedHistory.loadMore()}>Load more</button>}
            </>
          ) : searching ? (
            <>
            {checkSupplierMatches && supplierMatches.loading && <p className="knowledge-empty" role="status">Searching suppliers…</p>}
            {checkSupplierMatches && supplierMatches.error && <div className="knowledge-empty" role="alert">Supplier search unavailable. {supplierMatches.error}<button type="button" className="button secondary" onClick={supplierMatches.refresh}>Retry supplier search</button></div>}
            {searchSections.length || matchingPorts.length ? <>{matchingPorts.length > 0 && renderPortList(matchingPorts)}{searchSections.map(section => <section className="knowledge-search-section" key={section.id} aria-label={section.title}>
              <header className="knowledge-search-section-head"><button type="button" onClick={() => selectSection(section.id)}>{section.title}<ArrowUpRight size={13} aria-hidden="true" /></button></header>
              {section.facts && renderKeyInfo(section.query)}
              {section.official && renderOfficialTable(section.query)}
              {section.suppliers && renderTopSuppliers(section.query)}
              {section.supplierDetails && supplierInformation}
              {section.prices && port && <PortBuyPrices portId={port.id} title={section.title} search={section.query} />}
              {section.supplierDirectory && port && <div className="knowledge-supplier-search-results"><SupplierWorkspace key={`${port.id}:${section.query}`} open={open} onOpen={onOpen} port={port} embedded initialSearch={section.query} /></div>}
              {section.fixtures && <SupplierFixtures supplierId={actual.id} open={open} search={section.query} />}
              {section.entries.map(entry => renderEntry(entry, section.query))}
              {!section.facts && !section.suppliers && !section.supplierDetails && !section.prices && !section.fixtures && !section.supplierDirectory && !section.official && !section.entries.length && <p className="knowledge-empty">—</p>}
            </section>)}</> : !(checkSupplierMatches && (supplierMatches.loading || supplierMatches.error)) && <p className="knowledge-empty" role="status">No results</p>}
            </>
          ) : activePrivateEntry?.controller.data ? (
            <PrivateProfileTabPanel key={`${activePrivateEntry.controller.scopeKey}:${activePrivateEntry.tab.id}:${activePrivateEntry.controller.data.private.revision}:${privateEditorId ?? ''}`} controller={activePrivateEntry.controller} tab={activePrivateEntry.tab}
              initialEditing={privateEditorId === selectedTabId} editorTabs={editorTabs} editorTabId={selectedTabId} onSelectEditorTab={selectEditorTab} onManageTabs={() => { activePrivateEntry.controller.setDirty(false); setPrivateEditorId(undefined); setManaging(true); }} />
          ) : showingPorts ? (
            renderPortList(countryPorts)
          ) : showingSupplierDirectory && port ? (
            <>
              {active.id === officialSection?.id && renderOfficialTable()}
              {active.entries.length ? <div className="knowledge-supplier-search-results"><SupplierWorkspace key={port.id} open={open} onOpen={onOpen} port={port} embedded /></div> : <SupplierWorkspace key={port.id} open={open} onOpen={onOpen} port={port} embedded />}
              {active.entries.map(entry => renderEntry(entry))}
            </>
          ) : showingPrices && port ? (
            <PortBuyPrices portId={port.id} title={active.title} />
          ) : showingFixtures ? (
            <SupplierFixtures supplierId={actual.id} open={open} />
          ) : active ? (
            <>
              {active.id === officialSection?.id && renderOfficialTable()}
              {port && info && active.role === "port-information" && (
                <>
                  <div className="knowledge-port-summary">{renderKeyInfo()}{renderTopSuppliers()}</div>
                  {onOpen && portCountry && <div className="knowledge-related"><button onClick={() => onOpen("countries", { country: portCountry.id })}>Countries &amp; Ports ↗</button></div>}
                </>
              )}
              {actual.kind === "supplier" && active.role === "supplier-information" && supplierInformation}
              {active.entries.length ? active.entries.map(entry => renderEntry(entry)) : active.id === officialSection?.id || (actual.kind === "supplier" && active.role === "supplier-information" && supplierInformation) ? null : <p className="knowledge-empty">—</p>}
            </>
          ) : <p>No results</p>}
        </div>
      </div>
      {managing && <ManageKnowledgeTabs
        key={`${privateTabs.scopeKey}:${countryPrivateTabs.scopeKey}`}
        tabs={tabs.map((tab) => ({ id: tab.id, title: tab.title, sources: tab.sources, blockCount: tab.entries.length, role: tab.role }))}
        primary={{ target: actual, document: doc }}
        activeTabId={selectedTabId}
        privateTabs={privateTabs}
        countryPrivateTabs={countryTarget ? countryPrivateTabs : undefined}
        onClose={() => setManaging(false)}
        onSaved={(id) => { setSectionId(id); setPanel(null); setQuery(""); }}
      />}

      {revision && (
        <Modal title="History" onClose={() => setRevision(undefined)} wide>
          <KnowledgeComparison before={revision.before} after={revision.after} />
        </Modal>
      )}
    </section>
  );
}

function PortCurrentTime({ port }: { port: Port }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const local = portLocalTime(port, now);
  return <span className="knowledge-local-time">Time now {local ? <time dateTime={now.toISOString()}>{local}</time> : "—"}</span>;
}

export function KnowledgeEntryAttribution({ update, label = "information", hatTarget }: { update?: KnowledgeEntryUpdate; label?: string; hatTarget?: HatTarget }) {
  const { state, actor, run } = useDemo();
  const { preview, previewPerson } = useAccess();
  const viewer = previewPerson ? { id: previewPerson.id, name: previewPerson.name } : actor;
  if (!update?.updatedBy.trim() || !Number.isFinite(Date.parse(update.updatedAt))) return null;
  const contributorLabel = (id: string) => {
    const person = id === viewer.id ? viewer : id === actor.id ? actor : actors.find(candidate => candidate.id === id);
    const email = person ? undefined : state.profiles?.[id]?.email?.trim() || undefined;
    return { text: person?.name ?? email ?? "CONTRIBUTOR", email: Boolean(email) };
  };
  const updatedBy = contributorLabel(update.updatedBy);
  const formattedDate = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(update.updatedAt));
  const shortDate = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" }).format(new Date(update.updatedAt));
  const award = hatTarget ? hatForEntry(state, hatTarget, viewer.id) : undefined;
  const awarded = Boolean(award && !award.undoneAt);
  const knownAuthor = actors.some(person => person.id === update.updatedBy) || Object.hasOwn(state.profiles ?? {}, update.updatedBy);
  const eligible = Boolean(hatTarget && knownAuthor && update.updatedBy !== viewer.id && (!award || award.recipientId === update.updatedBy));
  const recipient = awarded ? contributorLabel(award!.recipientId) : updatedBy;
  const action = `Hats Off to ${recipient.text}`;
  const attribution = <span className="knowledge-attribution-stamp">
    <span className="knowledge-attribution-name" data-email-value={updatedBy.email ? "" : undefined}>{updatedBy.text}</span>
    <span className="knowledge-attribution-separator" aria-hidden="true">·</span>
    <time dateTime={update.updatedAt}>{shortDate}</time>
    {awarded && <Check size={11} className="knowledge-hat-check" aria-hidden="true" />}
  </span>;
  if (!eligible && !awarded) return <span className="knowledge-entry-audit knowledge-attribution-static" title={`Updated by ${updatedBy.text} · ${formattedDate}`}>{attribution}</span>;
  return (
    <span className="knowledge-entry-audit">
      <button
        type="button"
        className={`knowledge-audit-trigger${awarded ? " knowledge-hat-awarded" : ""}`}
        aria-label={`${action} for ${label}`}
        aria-pressed={awarded}
        aria-disabled={Boolean(preview)}
        title={preview ? "PREVIEW IS READ ONLY" : awarded ? "HAT GIVEN · CLICK AGAIN TO REMOVE" : `${action} · ${formattedDate}`}
        onClick={(event) => {
          event.stopPropagation();
          if (hatTarget && !preview) run({ type: "set-hat", target: hatTarget, expectedUpdate: update, active: !awarded });
        }}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        {attribution}
        <span className="knowledge-hat-action" aria-hidden="true"><span>Hats Off to <span data-email-value={recipient.email ? "" : undefined}>{recipient.text}</span></span><span className="knowledge-hat-unit"><ResourceIcon kind="hat" size={15} />{awarded ? <Check size={12} /> : "+1"}</span></span>
      </button>
    </span>
  );
}

export function KnowledgeBlockView({
  block,
  query = "",
  onEdit,
  showUpdate = false,
  update,
  rowUpdates,
  hatTarget,
}: {
  showUpdate?: boolean;
  update?: KnowledgeEntryUpdate;
  rowUpdates?: Record<string, KnowledgeEntryUpdate | undefined>;
  hatTarget?: Extract<HatTarget, { kind: "knowledge" }>;
  onEdit?: () => void;
  block: KnowledgeBlock;
  query?: string;
}) {
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [query]);
  const rows =
    block.type === "table"
      ? block.rows.filter(
          (r) =>
            knowledgeRowMatches(block, r.cells, query),
        )
      : [];
  const index = Math.min(page, Math.max(0, Math.ceil(rows.length / 50) - 1));
  // Row edits already carry the table's newest attribution. A separate table
  // stamp remains useful for structural changes that have no matching row.
  const showBlockUpdate = showUpdate && (block.type !== "table" || !block.rows.some(row => {
    const rowUpdate = rowUpdates?.[row.id];
    return update && rowUpdate?.updatedBy === update.updatedBy && rowUpdate.updatedAt === update.updatedAt;
  }));
  return (
    <article className="knowledge-block" onDoubleClick={onEdit}>
      <header className={`knowledge-block-head${block.title ? "" : " knowledge-block-head-inline"}`}>
        {block.title && <h4>{block.title}</h4>}
        <div className="knowledge-block-actions">
        {showBlockUpdate && <KnowledgeEntryAttribution label={block.title || block.type} update={update} hatTarget={hatTarget} />}
        {hatTarget && <AttachmentsButton scope={{ target: hatTarget.target, section: { id: block.id, name: block.title || 'General Information' } }} />}
        </div>
      </header>
      {block.type === "text" ? (
        <p className="knowledge-prose"><TextWithLinks text={block.text} /></p>
      ) : block.type === "file" ? (
        <a href={block.url} target="_blank" rel="noreferrer">
          <FileText size={14} /> {block.title} ↗
        </a>
      ) : (
        <>
          <div
            className="knowledge-table-wrap"
            tabIndex={0}
            role="region"
            aria-label={block.title || "Information table"}
          >
            <table
              style={{
                minWidth: block.columns.reduce(
                  (n, c) => n + (c.width ?? 160),
                  0,
                ),
              }}
            >
              <colgroup>
                {block.columns.map((c) => (
                  <col key={c.id} style={{ width: c.width ?? 160 }} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  {block.columns.map((c) => (
                    <th key={c.id} scope="col">
                      {c.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(index * 50, index * 50 + 50).map((r) => (
                  <tr key={r.id}>
                    {r.cells.map((v, i) => (
                      <td key={block.columns[i].id} data-email-value={isEmailText(v) ? "" : undefined}>
                        <span className="knowledge-cell-value"><TextWithLinks text={v || "—"} /></span>
                        {i === 0 && showUpdate && rowUpdates?.[r.id] && <span className="knowledge-row-attribution"><KnowledgeEntryAttribution label={`${block.title || "table"}, ${r.cells[0] || "row"}`} update={rowUpdates[r.id]} hatTarget={hatTarget ? { ...hatTarget, rowId: r.id } : undefined} /></span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > 50 && (
            <div className="knowledge-pagination">
              <button disabled={!index} onClick={() => setPage(index - 1)}>
                Previous
              </button>
              <span>
                {index * 50 + 1}–{Math.min(index * 50 + 50, rows.length)} /{" "}
                {rows.length}
              </span>
              <button
                disabled={(index + 1) * 50 >= rows.length}
                onClick={() => setPage(index + 1)}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
      {block.provenance && (
        <details className="knowledge-source">
          <summary>
            Source
            {block.provenance.source ? ` · ${block.provenance.source}` : ""}
            {block.provenance.date ? ` · ${block.provenance.date}` : ""}
          </summary>
          <blockquote>{block.provenance.evidence}</blockquote>
        </details>
      )}
    </article>
  );
}
