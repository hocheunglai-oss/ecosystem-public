import { ReleaseNotice, useBuyerCreditAvailable } from './ReleaseGate';
import { CreditUsage } from "./CreditUsage";
import { parserApi } from './lib/parserApi';
import { PARSER_VERSION, parserFieldKeys, type ParserField, type ParserFields, type ParserSuggestion, type ParserSnapshot, type ParserReportInput } from '../shared/parserService';
import ParserFixPanel from './ParserFixPanel';
import ParserReportPreview, { type CapturedAiAttempt } from './ParserReportPreview';
import { captureParserSnapshot } from './lib/parserCapture';
import { useAccess } from './auth';
import { useTestWorkspace } from './TestWorkspace';
import { commercialEnquiryApi } from './lib/commercialEnquiryApi';
import { useCommercialEnquiries } from './useCommercialEnquiries';
import type { CommercialEnquiry, CommercialEnquiryMutation, CommercialEnquirySummary } from '../shared/commercialEnquiries';
import { supplierPortForLocation } from '../shared/supplierPorts';
import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Flag, Check, ArrowUpRight } from "lucide-react";
import { useDemo } from "./store";
import { useInbox, type IncomingEnquiry } from "./inbox";
import { productSupplierName } from "./lib/fixtureSuppliers";
import { uppercaseText } from "./lib/uppercase";
import {
  activeAccountTraders,
  canTrade,
  availableCredit,
  enquiryImoHistory,
  outcomeQuantityText,
  isPendingOutcome,
  getOutcomePrivateNote,
  parseProductQuantity,
  uid,
  type Enquiry,
} from "./lib/model";
import {
  compareEnquiryPreview,
  formatEnquiry,
  parseEnquiry,
  productsFromFields,
  stripCommercialDetails,
  type ParsedEnquiry,
} from "./lib/parser";
import { effectiveCreditLimit } from "./lib/credit";
import { Field, money, date, Status } from "./ui";
import SearchableSelect from "./SearchableSelect";
import { BuyerProfile } from "./BuyerProfile";
import { KnowledgePanel } from "./KnowledgeWorkspace";
import type { OpenWorkspace, WorkspaceNavigationContext } from "./workspaceNavigation";
import type { OpenModal } from "./types";

type Tab = "Enquiry" | "Intelligence" | "Credit";
const tabLabels: Record<Tab, string> = {
  Enquiry: "Enquiries",
  Intelligence: "Ports & Suppliers",
  Credit: "Buyers and Credit",
};
type Selection = { kind: "new" | "incoming" | "record"; id: string };
type Draft = {
  raw: string;
  parsedRaw: string;
  fields: ParsedEnquiry;
  savedId: string;
  preview: string | null;
  rmk: boolean;
  viscosity: string[];
  original?: ParserSnapshot;
  originalRevision?: string;
  parseOrigin?: 'initial' | 'reparsed';
  aiRequest?: CapturedAiAttempt;
  shared?: CommercialEnquiry;
  sharedId?: string;
  pendingSave?: { body: string; input: CommercialEnquiryMutation };
};
const blank = (): ParsedEnquiry => ({
  vessel: "",
  imo: "",
  buyerText: "",
  buyerId: "",
  portId: "",
  eta: "",
  hsfo: "",
  vlsfo: "",
  lsmgo: "",
  remarks: "",
  rmk: false,
  vlsfoMaxRemarks: [],
  products: [],
  grade: "",
  quantity: 0,
  price: 0,
  margin: 0,
  warnings: [],
  confidence: "low",
});
const empty = (): Draft => ({
  raw: "",
  parsedRaw: "",
  fields: blank(),
  savedId: "",
  preview: null,
  rmk: false,
  viscosity: [],
});
const incomingVessel = (item: IncomingEnquiry) =>
  item.rawText.match(/^Vessel:\s*(.+)$/im)?.[1] || "Enquiry";
const incomingBuyer = (item: IncomingEnquiry) =>
  item.rawText.match(/^Buyer:\s*(.+)$/im)?.[1]?.toUpperCase() || "";

export default function EnquiryPage({ open, onOpen, context }: { open: OpenModal; onOpen: OpenWorkspace; context?: WorkspaceNavigationContext }) {
  const { realUser, preview } = useAccess();
  const { dataMode, generation } = useTestWorkspace();
  const accessScope = JSON.stringify([realUser?.id, realUser?.isAdmin, realUser?.isSpcTrader,
    realUser?.isManager, realUser?.isActive, realUser?.activated, realUser?.officeId]);
  return <EnquiryWorkspace key={`${accessScope}:${dataMode}:${generation}:${JSON.stringify(preview)}`} open={open} onOpen={onOpen} context={context} />;
}

function EnquiryWorkspace({ open, onOpen, context }: { open: OpenModal; onOpen: OpenWorkspace; context?: WorkspaceNavigationContext }) {
  const { state, actor, run } = useDemo();
  const { realUser, preview } = useAccess();
  const { dataMode } = useTestWorkspace();
  const live = dataMode === 'live';
  const liveEnabled = live && !preview && Boolean(realUser?.isActive && realUser.activated);
  const commercial = useCommercialEnquiries(actor.id, liveEnabled);
  const [remote, setRemote] = useState<{ key: string; item: CommercialEnquiry | null } | null>(null);
  const [detailError, setDetailError] = useState('');
  const [detailReload, setDetailReload] = useState(0);
  const [linked, setLinked] = useState<Record<string, string>>({});
  const buyerCreditAvailable = useBuyerCreditAvailable();
  const { items, selected, select, clearSelection } = useInbox();
  const [selection, setSelection] = useState<Selection>(
    selected
      ? { kind: "incoming", id: selected.id }
      : { kind: "new", id: "initial" },
  );
  const [tab, setTab] = useState<Tab>("Enquiry");
  const [unreadOnly, setUnreadOnly] = useState(Boolean(context?.unreadOnly));
  const [buyerId, setBuyerId] = useState("");
  const [epoch, setEpoch] = useState(0);
  const [, refreshDrafts] = useState(0);
  const drafts = useRef(new Map<string, Draft>());
  const key = `${selection.kind}:${selection.id}`;
  const incoming =
    selection.kind === "incoming"
      ? (items.find((item) => item.id === selection.id) ?? null)
      : null;
  const recordId =
    selection.kind === "record" ? selection.id : incoming?.enquiryId;
  const saved = !live ? state.enquiries.find(
    (item) => item.id === recordId && item.owner === actor.id,
  ) : undefined;
  const buyer = state.companies.find((item) => item.id === buyerId);
  const active = !live ? state.enquiries.filter(
    (item) =>
      !unreadOnly && canTrade(actor) && item.owner === actor.id &&
      ["draft", "sent", "postponed"].includes(item.status),
  ) : [];
  const unlinked = items.filter(
    (item) =>
      (!unreadOnly || (!item.dismissed && !item.read) || selection.kind === 'incoming' && item.id === selection.id) && !linked[item.id] && !(live ? [] : state.enquiries).some(
        (enquiry) =>
          enquiry.id === item.enquiryId && enquiry.owner === actor.id,
      ),
  );
  const needsDetail = liveEnabled && (selection.kind === 'record' || selection.kind === 'incoming');
  const detailLoading = needsDetail && remote?.key !== key && !detailError;
  useEffect(() => {
    setDetailError(''); setRemote(null);
    if (!needsDetail) return;
    const controller = new AbortController();
    const request = selection.kind === 'record'
      ? commercialEnquiryApi.detail(actor.id, selection.id, controller.signal)
      : commercialEnquiryApi.byInbox(actor.id, selection.id, controller.signal);
    void request.then(item => {
      if (controller.signal.aborted) return;
      setRemote({ key, item });
      if (item?.source.inboxId) setLinked(current => ({ ...current, [item.source.inboxId!]: item.id }));
    }).catch(error => { if (!controller.signal.aborted) setDetailError(error instanceof Error ? error.message : 'Enquiry is unavailable.'); });
    return () => controller.abort();
  }, [actor.id, key, needsDetail, detailReload]);
  useEffect(() => {
    if (selected) {
      setSelection({ kind: "incoming", id: selected.id });
      setTab("Enquiry");
    }
  }, [selected?.id]);
  useEffect(() => {
    setUnreadOnly(Boolean(context?.unreadOnly));
    if (context?.enquiryId && (liveEnabled || state.enquiries.some(item => item.id === context.enquiryId && item.owner === actor.id))) {
      clearSelection(); setSelection({ kind: 'record', id: context.enquiryId }); setTab('Enquiry');
    }
  }, [context, actor.id]);
  const remember = useCallback(
    (draft: Draft) => {
      drafts.current.set(key, draft);
      setBuyerId(draft.fields.buyerId);
      refreshDrafts((value) => value + 1);
    },
    [key],
  );
  function initial(): Draft {
    const cached = drafts.current.get(key);
    if (cached) return cached;
    const shared = live && remote?.key === key ? remote.item : null;
    if (shared) {
      const fields = parseEnquiry(shared.source.rawText, [], state.ports);
      const reparsed = captureParserSnapshot(shared.source.rawText, fields, [], state.ports);
      Object.assign(fields, { vessel: shared.reviewed.vessel, imo: shared.reviewed.imo, buyerId: '',
        buyerText: shared.reviewed.buyerText ?? '', portId: shared.reviewed.portId ?? '', eta: shared.reviewed.eta,
        hsfo: '', vlsfo: '', lsmgo: '', remarks: shared.reviewed.remarks, warnings: shared.reviewed.warnings });
      for (const product of shared.reviewed.products) fields[product.grade.toLowerCase() as 'hsfo' | 'vlsfo' | 'lsmgo'] = product.quantityText;
      return { ...empty(), raw: shared.source.rawText, parsedRaw: shared.source.rawText, fields,
        savedId: shared.id, shared, preview: shared.reviewed.formattedText, rmk: shared.reviewed.rmk,
        viscosity: shared.reviewed.viscosity, original: reparsed,
        originalRevision: crypto.randomUUID(), parseOrigin: 'reparsed' };
    }
    if (!saved && !incoming) return empty();
    const raw = saved?.rawText || incoming?.rawText || "";
    const fields = parseEnquiry(raw, state.companies, state.ports);
    const original = captureParserSnapshot(raw, fields, state.companies, state.ports);
    if (saved) {
      Object.assign(fields, {
        vessel: saved.vessel,
        imo: saved.imo,
        buyerId: saved.buyerId,
        portId: saved.portId,
        eta: saved.eta,
        remarks: saved.remarks ?? fields.remarks,
      });
      if (saved.products?.length) {
        fields.hsfo = "";
        fields.vlsfo = "";
        fields.lsmgo = "";
        for (const product of saved.products)
          fields[product.grade.toLowerCase() as "hsfo" | "vlsfo" | "lsmgo"] =
            product.quantityText;
      } else if (!productsFromFields(fields).length && saved.quantity > 0) {
        fields[
          /HSFO|RMK/i.test(saved.grade)
            ? "hsfo"
            : /MGO/i.test(saved.grade)
              ? "lsmgo"
              : "vlsfo"
        ] = String(saved.quantity);
      }
    }
    return {
      ...empty(),
      raw,
      parsedRaw: raw,
      original,
      originalRevision: crypto.randomUUID(),
      parseOrigin: saved ? 'reparsed' : 'initial',
      fields,
      savedId: saved?.id || "",
      preview: saved?.products?.length
        ? stripCommercialDetails(saved.formattedText)
        : null,
      rmk: saved?.rmk ?? fields.rmk,
      viscosity: saved?.vlsfoMaxRemarks ?? fields.vlsfoMaxRemarks,
    };
  }
  const creditLimit = buyer ? effectiveCreditLimit(buyer) : 0;
  const creditAvailable = buyer ? availableCredit(buyer) : 0;
  function clearParser() {
    drafts.current.delete(key);
    clearSelection();
    setSelection({ kind: "new", id: uid("draft") });
    setTab("Enquiry");
  }
  function chooseRecord(id: string) {
    clearSelection();
    setSelection({ kind: "record", id });
    setTab("Enquiry");
  }
  function sharedSaved(item: CommercialEnquiry) {
    commercial.accept(item);
    if (item.source.inboxId) setLinked(current => ({ ...current, [item.source.inboxId!]: item.id }));
  }
  function reloadRecord(id?: string) {
    drafts.current.delete(key);
    if (id && selection.kind === 'new') setSelection({ kind: 'record', id });
    setRemote(null); setDetailError(''); setDetailReload(value => value + 1);
    setEpoch(value => value + 1);
  }
  function sharedRow(item: CommercialEnquirySummary) {
    const own = item.ownerId === actor.id;
    return <article key={item.id} className={`center-incoming-row${selection.kind === 'record' && selection.id === item.id ? ' is-selected' : ''}`} data-commercial-id={item.id}>
      {own ? <button className="center-incoming-open" aria-label={`Open ${item.vessel || item.reference}`} onClick={() => chooseRecord(item.id)}>
        <span><strong>{item.vessel || item.reference}</strong><br />
          <span>{item.reference} · {item.port?.portName || '—'}</span><br />
          <span>{item.queue ? 'Awaiting connection' : item.status} · {date(item.updatedAt)}</span></span>
      </button> : <div className="center-incoming-open">
        <span><strong>{item.vessel || item.reference}</strong><br />
          <span>{item.reference} · {item.ownerName}</span><br />
          <span>{item.products.map(product => `${product.grade} ${product.quantityText}${/\b(?:MTS?|metric tonnes?)\b/i.test(product.quantityText) ? '' : ' MT'}`).join(' / ')}</span><br />
          <span>{item.eta} · Awaiting connection</span></span>
      </div>}
    </article>;
  }
  function amend(enquiry: Enquiry) {
    if (
      !run(
        { type: "amend-enquiry", id: enquiry.id },
        "Enquiry reopened for amendment.",
      )
    )
      return;
    for (const [cacheKey, draft] of drafts.current)
      if (draft.savedId === enquiry.id) drafts.current.delete(cacheKey);
    drafts.current.delete(`record:${enquiry.id}`);
    chooseRecord(enquiry.id);
    setEpoch((value) => value + 1);
  }
  function queueRecord(enquiry: Enquiry) {
    return (
      <article
        key={enquiry.id}
        className={`center-incoming-row${saved?.id === enquiry.id || drafts.current.get(key)?.savedId === enquiry.id ? " is-selected" : ""}`}
        data-enquiry-id={enquiry.id}
      >
        <button
          className="center-incoming-open"
          aria-label={`Open ${enquiry.vessel}`}
          onClick={() => chooseRecord(enquiry.id)}
        >
          <strong>{enquiry.vessel}</strong>
          <span>
            {state.companies
              .find((company) => company.id === enquiry.buyerId)
              ?.name.toUpperCase()}
          </span>
          <small>
            {enquiry.status === "draft" && !enquiry.sentAt ? (
              <span className="new-enquiry-label">New enquiry</span>
            ) : enquiry.status === "postponed" ? (
              <Status value={enquiry.status} />
            ) : null}
            {date(enquiry.createdAt)}
          </small>
        </button>
        {["sent", "postponed"].includes(enquiry.status) && (
          <Lifecycle enquiry={enquiry} amend={amend} open={open} />
        )}
      </article>
    );
  }
  return (
    <div className={`enquiry-center${tab === "Intelligence" ? " enquiry-center-intelligence" : ""}`}>
      <div className="center-main">
        <div className="center-tabs" role="tablist" aria-label="Enquiries">
          {(["Enquiry", "Intelligence", "Credit"] as Tab[]).map((item) => (
            <button
              key={item}
              id={`center-tab-${item}`}
              type="button"
              role="tab"
              aria-selected={tab === item}
              aria-controls={`center-panel-${item}`}
              onClick={() => setTab(item)}
            >
              {tabLabels[item]}
            </button>
          ))}
        </div>
        {detailLoading ? <p role="status">Loading enquiry…</p> : detailError ? <div role="alert"><p>{detailError}</p><button className="button secondary" onClick={() => reloadRecord()}>Retry</button></div> : <Composer
          key={`${key}:${epoch}`}
          initial={initial()}
          incoming={incoming}
          tab={tab}
          open={open}
          onOpen={onOpen}
          onChange={remember}
          onClear={clearParser}
          onSaved={sharedSaved}
          onReload={reloadRecord}
        />}
      </div>
      <aside className="center-sidebar" hidden={tab === "Intelligence"}>
        <section className="center-credit-indicator" aria-label="Client credit" hidden={!buyerCreditAvailable && tab === "Credit"}>
          {buyerCreditAvailable ? <><strong className="center-client-name">
            {buyer?.name.toUpperCase() || "—"}
          </strong>
          <CreditUsage enquiry limit={creditLimit} used={buyer?.exposure ?? 0} available={creditAvailable} known={Boolean(buyer)} /></> : <ReleaseNotice compact />}
        </section>
        <section className="center-incoming" aria-label="Incoming Enquiries">
          <header>
            <h3>{commercial.scope === 'singapore' && live ? 'Singapore queue' : 'Incoming Enquiries'}</h3>
          </header>
          {liveEnabled && (realUser?.isAdmin || realUser?.isSpcTrader) && <div className="enquiry-terms" aria-label="Enquiry lists">
            <button type="button" aria-pressed={commercial.scope === 'mine'} onClick={() => commercial.setScope('mine')}>My enquiries</button>
            <button type="button" aria-pressed={commercial.scope === 'singapore'} onClick={() => commercial.setScope('singapore')}>Singapore queue</button>
          </div>}
          {live && <div aria-busy={commercial.busy}>
            {commercial.error && <div role="alert"><p>{commercial.error}</p><button className="button secondary" onClick={() => void commercial.reload()}>Retry</button></div>}
            {commercial.busy && <p role="status">Loading enquiries…</p>}
            {commercial.rows.map(sharedRow)}
            {commercial.cursor && <button className="button secondary" disabled={commercial.busy} onClick={() => void commercial.more()}>Load more</button>}
          </div>}
          {unreadOnly && <div className="enquiry-unread-filter"><span>Unread</span><button className="text-button" onClick={() => setUnreadOnly(false)}>Show all</button></div>}
          <div className="center-incoming-list" hidden={live && commercial.scope === 'singapore'}>
            {unreadOnly && !unlinked.length && <p className="enquiry-unread-filter">No unread enquiries</p>}
            <div className="center-queue-new" aria-label="Incoming enquiries">
              {[...drafts.current.entries()]
                .filter(
                  ([draftKey, draft]) =>
                    !unreadOnly && draftKey.startsWith("new:") &&
                    draft.raw.trim() &&
                    !draft.savedId,
                )
                .map(([draftKey, draft]) => (
                  <article
                    key={draftKey}
                    className={`center-incoming-row${key === draftKey ? " is-selected" : ""}`}
                    data-draft-id={draftKey}
                  >
                    <button
                      className="center-incoming-open"
                      aria-label={`Open ${draft.fields.vessel || "New enquiry"}`}
                      onClick={() => {
                        clearSelection();
                        setSelection({ kind: "new", id: draftKey.slice(4) });
                        setTab("Enquiry");
                      }}
                    >
                      <strong>{draft.fields.vessel || "New enquiry"}</strong>
                      <span>
                        {state.companies
                          .find(
                            (company) => company.id === draft.fields.buyerId,
                          )
                          ?.name.toUpperCase() ||
                          draft.fields.buyerText.toUpperCase()}
                      </span>
                      <small>
                        <span className="new-enquiry-label">New enquiry</span>
                      </small>
                    </button>
                  </article>
                ))}
              {unlinked.map((item) => (
                <article
                  key={item.id}
                  className={`center-incoming-row${selection.id === item.id ? " is-selected" : ""}`}
                  data-incoming-id={item.id}
                >
                  <button
                    className="center-incoming-open"
                    aria-label={`Open ${incomingVessel(item)}`}
                    onClick={() => {
                      select(item.id);
                      setSelection({ kind: "incoming", id: item.id });
                      setTab("Enquiry");
                    }}
                  >
                    <strong>{incomingVessel(item)}</strong>
                    <span>{incomingBuyer(item)}</span>
                    <small>
                      <span className="new-enquiry-label">New enquiry</span>
                      {date(item.receivedAt)}
                      {!item.read && <i aria-label="Unread" />}
                    </small>
                  </button>
                </article>
              ))}
              {active
                .filter((enquiry) => enquiry.status === "draft")
                .map(queueRecord)}
            </div>
            {active.some((enquiry) => enquiry.status !== "draft") && (
              <div
                className="center-queue-confirmed"
                aria-label="Confirmed enquiries"
              >
                <div
                  className="center-queue-divider"
                  role="separator"
                  aria-label="Incoming and confirmed enquiries"
                />
                {active
                  .filter((enquiry) => enquiry.status !== "draft")
                  .map(queueRecord)}
              </div>
            )}
          </div>
        </section>
      </aside>
    </div>
  );
}

function Lifecycle({
  enquiry,
  amend,
  open,
}: {
  enquiry: Enquiry;
  amend: (enquiry: Enquiry) => void;
  open: OpenModal;
}) {
  const { run } = useDemo();
  return (
    <div className="center-lifecycle" aria-label={`${enquiry.vessel} actions`}>
      <button onClick={() => amend(enquiry)}>Amend</button>
      {enquiry.status === "sent" && (
        <>
          <button
            onClick={() =>
              open({ type: "outcome", id: enquiry.id, kind: "fixture" })
            }
          >
            Stem
          </button>
          <button
            onClick={() =>
              open({ type: "outcome", id: enquiry.id, kind: "lost" })
            }
          >
            Lost
          </button>
        </>
      )}
      <button
        onClick={() =>
          run({ type: "cancel-enquiry", id: enquiry.id }, "Enquiry cancelled.")
        }
      >
        Cancel
      </button>
    </div>
  );
}

function Composer({
  initial,
  incoming,
  tab,
  open,
  onOpen,
  onChange,
  onClear,
  onSaved,
  onReload,
}: {
  initial: Draft;
  incoming: IncomingEnquiry | null;
  tab: Tab;
  open: OpenModal;
  onOpen: OpenWorkspace;
  onChange: (draft: Draft) => void;
  onClear: () => void;
  onSaved: (item: CommercialEnquiry) => void;
  onReload: (id?: string) => void;
}) {
  const { state, actor, run, notify } = useDemo();
  const { preview } = useAccess();
  const { dataMode, generation } = useTestWorkspace();
  const manualFields = useRef(new Set<ParserField>(initial.savedId ? parserFieldKeys : []));
  const revision = useRef({ value: "", id: crypto.randomUUID() });
  const buyerCreditAvailable = useBuyerCreditAvailable();
  const { markLinked } = useInbox();
  const [draft, setDraft] = useState(initial);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveConflict, setSaveConflict] = useState(false);
  const [reloadPrompt, setReloadPrompt] = useState(false);
  const saveRequest = useRef<{ body: string; input: CommercialEnquiryMutation } | null>(initial.pendingSave ?? null);
  const newId = useRef(initial.sharedId ?? crypto.randomUUID());
  const saveEpoch = useRef(0);
  const saveController = useRef<AbortController | null>(null);
  useEffect(() => () => { saveEpoch.current++; saveController.current?.abort(); }, []);
  const reportRequest = useRef<{ body: string; id: string } | null>(null);
  const [reportBusy, setReportBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [reportPreview, setReportPreview] = useState<{ input: Omit<ParserReportInput, 'requestId'>; ai?: CapturedAiAttempt } | null>(null);
  const reportEpoch = useRef(0);
  useEffect(() => { reportEpoch.current++; setReportPreview(null); setReportBusy(false); return () => { reportEpoch.current++; }; }, [actor.id, dataMode, generation, preview]);
  const directories = useRef({
    companies: state.companies,
    ports: state.ports,
  });
  directories.current = { companies: state.companies, ports: state.ports };
  const { raw, fields, savedId, rmk, viscosity } = draft;
  const imoLookupQuery = [fields.vessel.trim(), /^\d{7}$/.test(fields.imo.trim()) ? `IMO ${fields.imo.trim()}` : 'vessel IMO'].join(' ').trim();
  const hasImoLookup = Boolean(fields.vessel.trim() || /^\d{7}$/.test(fields.imo.trim()));
  useEffect(() => {
    onChange(draft);
  }, [draft, onChange]);
  useEffect(() => {
    if (raw === draft.parsedRaw) return;
    const timer = window.setTimeout(() => {
      const fields = raw.trim()
        ? parseEnquiry(
            raw,
            directories.current.companies,
            directories.current.ports,
          )
        : blank();
      setDraft((current) =>
        current.raw !== raw
          ? current
          : {
              ...current,
              fields,
              parsedRaw: raw,
              original: captureParserSnapshot(raw, fields, directories.current.companies, directories.current.ports),
              originalRevision: crypto.randomUUID(),
              parseOrigin: 'initial',
              aiRequest: undefined,
              preview: null,
              rmk: fields.rmk,
              viscosity: fields.vlsfoMaxRemarks,
            },
      );
    }, 280);
    return () => window.clearTimeout(timer);
  }, [raw, draft.parsedRaw]);
  const pending = raw !== draft.parsedRaw;
  const buyer = state.companies.find((item) => item.id === fields.buyerId);
  const port = state.ports.find((item) => item.id === fields.portId);
  const unmatchedPort = draft.original?.fields.portText || raw.match(/^\s*Port:\s*(.+)$/im)?.[1]?.trim() || "";

  const saved = dataMode === 'test' ? state.enquiries.find(
    (item) => item.id === savedId && item.owner === actor.id,
  ) : undefined;
  const shared = draft.shared;
  const editable = !preview && canTrade(actor) && !saveBusy && (dataMode === 'live' ? !shared || shared.status === 'draft' : !saved || saved.status === "draft");
  const canonicalPort = port ? supplierPortForLocation(port) : undefined;
  const singapore = dataMode === 'live' && canonicalPort?.countryCode === 'SG';
  const snapshot = (value: ParsedEnquiry): ParserFields => ({ vessel: value.vessel, imo: value.imo,
    buyerText: state.companies.find(item => item.id === value.buyerId)?.name || value.buyerText,
    portText: state.ports.find(item => item.id === value.portId)?.name || unmatchedPort,
    eta: value.eta, hsfo: value.hsfo, vlsfo: value.vlsfo, lsmgo: value.lsmgo, remarks: value.remarks });
  const reviewWarnings = dataMode === 'live'
    ? fields.warnings.filter(warning => warning !== 'Buyer is not matched. Select an entity or request a new customer.')
    : fields.warnings;
  const currentSnapshot = snapshot(fields);
  const fingerprint = JSON.stringify([raw, currentSnapshot, draft.preview, rmk, viscosity, dataMode, generation]);
  if (revision.current.value !== fingerprint) revision.current = { value: fingerprint, id: crypto.randomUUID() };
  const sourceRevision = revision.current.id;
  const products = productsFromFields(fields);
  const peers = dataMode === 'test' ? activeAccountTraders(state, fields.buyerId, actor.id, savedId) : [];
  const history = dataMode === 'test' ? enquiryImoHistory(state, fields.imo, savedId) : { wins: [], losses: [] };
  const generated = raw.trim()
    ? formatEnquiry({
        ...fields,
        products,
        buyerName: buyer?.name || fields.buyerText,
        portName: port?.name || unmatchedPort,
        vlsfoMaxRemarks: viscosity,
        rmk,
      })
    : "";
  const formatted = draft.preview ?? generated;
  const previewMismatch =
    editable &&
    draft.preview !== null &&
    draft.preview !== generated &&
    !compareEnquiryPreview(
      stripCommercialDetails(formatted),
      {
        vessel: fields.vessel,
        imo: fields.imo,
        buyerId: fields.buyerId,
        portId: fields.portId,
        products,
        eta: fields.eta,
        rmk,
        vlsfoMaxRemarks: viscosity,
      },
      state.companies,
      state.ports,
    ).matches;
  const complete = Boolean(
    editable &&
      !pending &&
      !previewMismatch &&
      (dataMode === 'live' || buyer) &&
      (dataMode === 'live' ? canonicalPort : port) &&
      fields.vessel.trim() &&
      fields.eta.trim() &&
      products.length &&
      products.every((product) => parseProductQuantity(product.quantityText)) &&
      stripCommercialDetails(formatted).trim(),
  );
  function update<K extends keyof ParsedEnquiry>(
    key: K,
    value: ParsedEnquiry[K],
  ) {
    const protectedKey = key === 'buyerId' ? 'buyerText' : key === 'portId' ? 'portText' : key;
    if (parserFieldKeys.includes(protectedKey as ParserField)) manualFields.current.add(protectedKey as ParserField);
    setDraft((current) => ({
      ...current,
      fields: { ...current.fields, [key]: value },
      preview: null,
    }));
  }
  function toggleRemark(term: string) {
    const parts = fields.remarks.split(/\s*\/\s*|\n/).filter(Boolean);
    update(
      "remarks",
      (parts.some((part) => part.toUpperCase() === term)
        ? parts.filter((part) => part.toUpperCase() !== term)
        : [...parts, term]
      ).join(" / "),
    );
  }
  async function saveShared(action: 'save' | 'confirm') {
    if (dataMode !== 'live' || !editable || pending || aiBusy || saveBusy || !raw.trim() || action === 'confirm' && !complete) return;
    setSaveError(''); setSaveConflict(false);
    const payload: Omit<CommercialEnquiryMutation, 'requestId'> = {
      dataMode: 'live', id: shared?.id ?? newId.current, expectedRevision: shared?.revision ?? 0, action,
      source: shared?.source ?? { rawText: raw, parsed: draft.original ?? null, parserVersion: PARSER_VERSION, inboxId: incoming?.id ?? null },
      reviewed: { vessel: fields.vessel.trim(), imo: fields.imo.trim(), eta: fields.eta.trim(), portId: canonicalPort?.id ?? null,
        buyerText: fields.buyerText.trim() || null, buyerId: null, products,
        remarks: fields.remarks, rmk, viscosity: [...viscosity], formattedText: formatted, warnings: [...fields.warnings] },
    };
    const body = JSON.stringify(payload);
    if (saveRequest.current?.body !== body) saveRequest.current = { body, input: { ...payload, requestId: crypto.randomUUID() } };
    // Keep uncertain writes in this scope's in-memory draft when the composer is
    // remounted by navigation. A retry must not create a second manual enquiry.
    const pendingDraft = { ...draft, sharedId: newId.current, pendingSave: saveRequest.current };
    setDraft(pendingDraft); onChange(pendingDraft);
    const request = saveRequest.current.input;
    const epoch = ++saveEpoch.current;
    const controller = new AbortController(); saveController.current = controller;
    setSaveBusy(true);
    try {
      const result = await commercialEnquiryApi.mutate(actor.id, request, controller.signal);
      if (epoch !== saveEpoch.current || controller.signal.aborted) return;
      setDraft(current => ({ ...current, shared: result.item, sharedId: result.item.id, pendingSave: undefined, savedId: result.item.id, preview: result.item.reviewed.formattedText }));
      saveRequest.current = null;
      onSaved(result.item);
      notify(result.item.queue ? 'Awaiting connection.' : action === 'save' ? 'Draft saved.' : 'Enquiry confirmed.');
    } catch (error) {
      if (epoch !== saveEpoch.current || controller.signal.aborted) return;
      setSaveError(error instanceof Error ? error.message : 'Enquiry could not be saved. Try again.');
      setSaveConflict(Boolean(error && typeof error === 'object' && 'status' in error && error.status === 409));
    } finally { if (epoch === saveEpoch.current && !controller.signal.aborted) setSaveBusy(false); }
  }
  function confirm() {
    if (dataMode === 'live') { void saveShared('confirm'); return; }
    if (!complete) return;
    const id = savedId || uid("enquiry");
    const quantity =
      products.length === 1
        ? parseProductQuantity(products[0].quantityText)
        : null;
    const safeFormat = stripCommercialDetails(formatted);
    const enquiry: Enquiry = {
      ...(saved || {}),
      id,
      owner: actor.id,
      buyerId: fields.buyerId,
      portId: fields.portId,
      vessel: fields.vessel.trim(),
      imo: fields.imo.trim(),
      eta: fields.eta.trim(),
      grade: products.map((product) => product.grade).join(" / "),
      quantity: quantity?.min === quantity?.max ? quantity?.min || 0 : 0,
      price: 0,
      margin: 0,
      products,
      remarks: stripCommercialDetails(fields.remarks),
      rmk,
      vlsfoMaxRemarks: viscosity,
      rawText: raw,
      formattedText: safeFormat,
      status: "draft",
      createdAt: saved?.createdAt || new Date().toISOString(),
      complianceChecked: false,
      creditChecked: false,
      creditConfirmations: [],
    };
    if (!run({ type: "save-enquiry", enquiry })) return;
    setDraft((current) => ({ ...current, savedId: id, preview: safeFormat }));
    if (incoming) markLinked(incoming.id, id);
    run({ type: "confirm-enquiry", id }, "Enquiry confirmed.");
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(uppercaseText(stripCommercialDetails(formatted)));
      notify("Copied.");
    } catch {
      notify("Copy unavailable.", true);
    }
  }
  function applySuggestions(items: ParserSuggestion[], warnings: string[], requestId: string) {
    if (!editable || pending) return;
    const proposed = { ...currentSnapshot };
    for (const item of items) if (!manualFields.current.has(item.field)) proposed[item.field] = item.value;
    const text = [`Vessel: ${proposed.vessel}`, `IMO: ${proposed.imo}`, `Buyer: ${proposed.buyerText}`, `Port: ${proposed.portText}`, `ETA: ${proposed.eta}`,
      ...(['hsfo', 'vlsfo', 'lsmgo'] as const).filter(key => proposed[key]).map(key => `${key.toUpperCase()}: ${proposed[key]} MT`), `Remarks: ${proposed.remarks}`].join('\n');
    const checked = parseEnquiry(text, state.companies, state.ports);
    const next = { ...fields };
    let applied = 0;
    for (const item of items) {
      if (manualFields.current.has(item.field)) continue;
      if (item.field === 'portText') { if (!checked.portId) continue; next.portId = checked.portId; }
      else if (item.field === 'buyerText') { next.buyerText = proposed.buyerText; next.buyerId = checked.buyerId; }
      else { const value = checked[item.field]; if (!value && proposed[item.field]) continue; next[item.field] = value; }
      applied++;
    }
    if (!applied) { notify('Select the buyer or port manually.', true); return; }
    // AI changes to structured fields do not resolve cautions present in the original message.
    const sourceCautions = (draft.original?.warnings ?? fields.warnings).filter(warning => /^WARNING:/i.test(warning.trim()));
    next.warnings = [...new Set([...sourceCautions, ...checked.warnings, ...warnings])];
    setDraft(current => ({ ...current, fields: next, preview: null, aiRequest: { ...current.aiRequest, id: requestId, raw, state: 'complete' } }));
    notify('Selected suggestions applied.');
  }
  function report() {
    if (reportBusy || aiBusy || preview || pending || !draft.original || !draft.originalRevision || dataMode === 'test' && !generation) return;
    const payload: Omit<ParserReportInput, 'requestId'> = { rawText: raw, sourceRevision, parserVersion: PARSER_VERSION,
      parsed: draft.original.fields, corrected: currentSnapshot,
      capture: { original: draft.original, originalRevision: draft.originalRevision, parseOrigin: draft.parseOrigin ?? 'initial',
        submitted: { fields: currentSnapshot, standardText: formatted, warnings: [...fields.warnings], rmk, viscosity: [...viscosity] } },
      notes: '', dataMode, ...(dataMode === 'test' ? { generation } : {}),
      ...(draft.aiRequest?.raw === raw ? { aiRequestId: draft.aiRequest.id } : {}) };
    setReportPreview({ input: payload, ai: draft.aiRequest?.raw === raw ? draft.aiRequest : undefined });
  }
  async function submitReport(notes: string) {
    if (!reportPreview || reportBusy || aiBusy || preview) return;
    const payload = { ...reportPreview.input, notes };
    const run = reportEpoch.current;
    const body = JSON.stringify(payload);
    if (reportRequest.current?.body !== body) reportRequest.current = { body, id: crypto.randomUUID() };
    setReportBusy(true);
    try {
      await parserApi.report({ ...payload, requestId: reportRequest.current.id });
      if (run === reportEpoch.current) { setReportPreview(null); notify('Parser report submitted.'); }
    } catch (error) { if (run === reportEpoch.current) notify(error instanceof Error ? error.message : 'Parser report could not be submitted.', true); }
    finally { if (run === reportEpoch.current) setReportBusy(false); }
  }

  return (
    <>
      {reportPreview && <ParserReportPreview report={reportPreview.input} ai={reportPreview.ai} busy={reportBusy || aiBusy} onClose={() => setReportPreview(null)} onSubmit={notes => void submitReport(notes)} />}
      <section
        role="tabpanel"
        id="center-panel-Enquiry"
        aria-labelledby="center-tab-Enquiry"
        hidden={tab !== "Enquiry"}
      >
        <div className="center-editor-grid">
          <div className="center-parser-column">
            <label className="center-field-heading" htmlFor="center-raw">
              Parser
            </label>
            <div className="center-parser-wrap">
              <textarea
                id="center-raw"
                className="center-parser"
                aria-label="Raw enquiry"
                placeholder="Paste enquiry"
                value={raw}
                disabled={!editable}
                readOnly={Boolean(shared || incoming)}
                maxLength={20000}
                onChange={(event) => {
                  if (event.target.value !== raw) manualFields.current.clear();
                  setDraft((current) => ({
                    ...current,
                    raw: event.target.value,
                    preview: null,
                  }));
                }}
              />
              <button
                className="parser-clear"
                type="button"
                aria-label="Clear parser"
                disabled={Boolean(preview) || saveBusy || !raw}
                onClick={onClear}
              >
                Clear
              </button>
            </div>
            <div className="center-format-heading">
              <label htmlFor="center-standard">Standard format</label>
              <div>
                <button
                  className="enquiry-icon"
                  aria-label="Copy standard format"
                  disabled={!formatted || pending}
                  onClick={copy}
                >
                  <Copy size={14} />
                </button>
              </div>
            </div>
            <textarea
              id="center-standard"
              rows={3}
              className="center-standard"
              value={formatted}
              readOnly={!editable}
              disabled={pending}
              onChange={(event) => {
                manualFields.current = new Set(parserFieldKeys);
                setDraft(current => ({ ...current, preview: event.target.value }));
              }}
            />
            {previewMismatch && (
              <p className="enquiry-format-error" role="alert">
                Standard format differs from the details. Correct it or use AI
                FIX.
              </p>
            )}
            <div className="center-command-bar">
              <ParserFixPanel rawText={raw} current={currentSnapshot} sourceRevision={sourceRevision}
                manual={manualFields.current} disabled={!editable || pending} onApply={applySuggestions} onBusyChange={setAiBusy}
                onReceipt={attempt => setDraft(current => current.raw === attempt.raw ? { ...current, aiRequest: attempt } : current)} />
              <button
                className="button secondary"
                disabled={!raw || pending || reportBusy || aiBusy || Boolean(preview)} onClick={() => void report()}
              >
                <Flag size={15} />
                Report
              </button>
              <button
                className="button primary"
                disabled={!complete || aiBusy}
                onClick={confirm}
              >
                <Check size={15} />
                {singapore ? 'Send to SPC' : 'Confirm'}
              </button>
            </div>
            {dataMode === 'live' && <div className="enquiry-terms">
              <button className="button secondary" disabled={!editable || pending || aiBusy || !raw.trim()} onClick={() => void saveShared('save')}>Save draft</button>
              {saveBusy && <span role="status">Saving…</span>}
              {shared && <span>{shared.reference} · {shared.queue ? 'Awaiting connection' : shared.status}</span>}
            </div>}
            {saveError && <div className="enquiry-format-error" role="alert">
              <p>{saveError}</p>
              {saveConflict && !reloadPrompt && <button className="button secondary" onClick={() => setReloadPrompt(true)}>Load latest</button>}
              {reloadPrompt && <><p>Discard these unsaved changes?</p><div className="enquiry-terms">
                <button className="button secondary" onClick={() => setReloadPrompt(false)}>Keep editing</button>
                <button className="button secondary" onClick={() => onReload(shared?.id ?? newId.current)}>Discard and load latest</button>
              </div></>}
            </div>}
            {buyerCreditAvailable && buyer && (buyer.status !== "approved" || buyer.creditStatus && buyer.creditStatus !== "Active" || availableCredit(buyer) < 0 || buyer.overdue > 0) && <section className="center-enquiry-alerts" aria-label="Credit alerts">
              {buyer.status !== "approved" && <p>Buyer awaiting credit approval.</p>}
              {buyer.creditStatus && buyer.creditStatus !== "Active" && <p className="is-critical">Credit status: {buyer.creditStatus}. Credit approval required before STEM.</p>}
              {availableCredit(buyer) < 0 && <p className="is-critical">Insufficient credit · Shortfall {money(-availableCredit(buyer))}.</p>}
              {buyer.overdue > 0 && <p>Overdue payment: {money(buyer.overdue)}.</p>}
              <button className="text-button" type="button" onClick={() => open({ type: "credit", companyId: buyer.id, enquiryId: saved?.buyerId === buyer.id ? saved.id : undefined })}>Credit request</button>
            </section>}
            {peers.length > 0 && (
              <section
                className="center-account-notice"
                aria-label="Account activity"
              >
                {peers.map((peer) => {
                  const ownName = fields.vessel
                    .replace(/^M[VT][ .\/]+/i, "")
                    .replace(/[^A-Z0-9]/gi, "")
                    .toUpperCase();
                  const relations = [
                    ...new Set(
                      peer.enquiries
                        .map((enquiry) => {
                          if (
                            /^\d{7}$/.test(fields.imo.trim()) &&
                            /^\d{7}$/.test(enquiry.imo.trim())
                          )
                            return fields.imo.trim() === enquiry.imo.trim()
                              ? "SAME VESSEL"
                              : "DIFFERENT VESSEL";
                          const otherName = enquiry.vessel
                            .replace(/^M[VT][ .\/]+/i, "")
                            .replace(/[^A-Z0-9]/gi, "")
                            .toUpperCase();
                          return ownName && otherName
                            ? ownName === otherName
                              ? "SAME VESSEL"
                              : "DIFFERENT VESSEL"
                            : "";
                        })
                        .filter(Boolean),
                    ),
                  ];
                  return (
                    <p key={peer.trader.id}>
                      <strong>
                        {peer.trader.name.toUpperCase()} ALSO HAS AN ENQUIRY FOR{" "}
                        {peer.sameAccount
                          ? "THIS ACCOUNT"
                          : "THIS ACCOUNT GROUP"}
                        . PLEASE DOUBLE CHECK.
                      </strong>
                      {relations.length > 0 && (
                        <span>{relations.join(" / ")}</span>
                      )}
                    </p>
                  );
                })}
              </section>
            )}
            {(history.wins.length > 0 || history.losses.length > 0) && (
              <section
                className="center-history-compact"
                aria-label="Win and loss record"
              >
                <header>
                  <strong>Win / loss record</strong>
                  <span>
                    {history.wins.length} Win · {history.losses.length} Lost
                  </span>
                </header>
                {[...history.wins, ...history.losses]
                  .sort(
                    (a, b) => Date.parse(b.bookedAt) - Date.parse(a.bookedAt),
                  )
                  .map((outcome) => (
                    <details key={outcome.id}>
                      <summary>
                        <time>{date(outcome.bookedAt)}</time>
                        <strong>
                          {outcome.kind === "fixture" ? "Win" : "Lost"}
                        </strong>
                        <span>
                          {
                            state.ports.find(
                              (port) => port.id === outcome.portId,
                            )?.name
                          }
                        </span>
                        <span>{outcomeQuantityText(outcome)} MT</span>
                      </summary>
                      <div>
                        {outcome.reason && <p>{outcome.reason}</p>}
                        {outcome.groupNote && (
                          <p>Group note: {outcome.groupNote}</p>
                        )}
                        {getOutcomePrivateNote(state, outcome.id, actor.id) && (
                          <p>
                            Private note:{" "}
                            {getOutcomePrivateNote(state, outcome.id, actor.id)}
                          </p>
                        )}
                        {outcome.kind === "fixture" &&
                          isPendingOutcome(outcome) && (
                            <>
                              {outcome.stemProducts?.map((product) => (
                                <p key={product.grade}>
                                  {product.grade} · {productSupplierName(outcome, product).toUpperCase() || "—"} · Buy price{" "}
                                  {money(product.buyPrice)}
                                </p>
                              ))}
                            </>
                          )}
                        {outcome.kind === "fixture" &&
                          !isPendingOutcome(outcome) && (
                            <p>
                              Price {money(outcome.price)} · Margin{" "}
                              {money(outcome.margin)}
                            </p>
                          )}
                      </div>
                    </details>
                  ))}
              </section>
            )}
            {saved && saved.status !== "sent" && (
              <div className="center-saved-status">
                <Status value={saved.status} />
              </div>
            )}
            {reviewWarnings.length > 0 && (
              <details key={draft.parsedRaw} className="enquiry-review" open={reviewWarnings.some(warning => warning.startsWith("WARNING:"))}>
                <summary>Review ({reviewWarnings.length})</summary>
                <ul>
                  {reviewWarnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
          <div className="center-details-column">
            <fieldset
              className="enquiry-fields"
              disabled={!editable || pending}
            >
              <div className="enquiry-buyer-field">
                <Field label="Buyer">
                  {dataMode === 'live' ? <input aria-label="Buyer" value={fields.buyerText} maxLength={500} onChange={event => update('buyerText', event.target.value)} /> : <SearchableSelect
                    key={`buyer:${draft.parsedRaw}`}
                    label="Buyer"
                    value={fields.buyerId}
                    disabled={!editable || pending}
                    unmatched={fields.buyerText.toUpperCase()}
                    placeholder="Search buyer"
                    options={state.companies.map((company) => ({
                      value: company.id,
                      label: company.name.toUpperCase(),
                      keywords: [company.customerId, ...company.aliases].filter(Boolean).join(" "),
                    }))}
                    onChange={(value) => update("buyerId", value)}
                  />}
                </Field>
              </div>
              {dataMode === 'test' && !buyer && fields.buyerText && <div className="enquiry-unmatched">Buyer not found</div>}
              <div className="center-detail-grid">
                <Field label="Vessel">
                  <input
                    value={fields.vessel}
                    onChange={(event) => update("vessel", event.target.value)}
                  />
                </Field>
                <div className="enquiry-imo-row">
                  <Field label="IMO">
                    <input
                      value={fields.imo}
                      inputMode="numeric"
                      onChange={(event) => update("imo", event.target.value)}
                    />
                  </Field>
                  {hasImoLookup && !pending ? <a className="button secondary" href={`https://www.google.com/search?q=${encodeURIComponent(imoLookupQuery)}`} target="_blank" rel="noopener noreferrer">CHECK IMO<ArrowUpRight size={15} aria-hidden="true" /></a> : <button className="button secondary" type="button" disabled>CHECK IMO<ArrowUpRight size={15} aria-hidden="true" /></button>}
                </div>
                <Field label="Port">
                  <SearchableSelect
                    key={`port:${draft.parsedRaw}`}
                    label="Port"
                    value={fields.portId}
                    disabled={!editable || pending}
                    placeholder="Search port"
                    unmatched={!port ? unmatchedPort : undefined}
                    options={state.ports.map((port) => ({
                      value: port.id,
                      label: port.name,
                      keywords: `${port.code} ${port.country}`,
                    }))}
                    onChange={(value) => update("portId", value)}
                  />
                  {!port && unmatchedPort && <span className="enquiry-unmatched">Port not found · <button className="text-button" type="button" onClick={() => onOpen("ports", { returnTo: "enquiry" })}>Countries & Ports</button></span>}
                </Field>
                <Field label="ETA">
                  <input
                    value={fields.eta}
                    onChange={(event) => update("eta", event.target.value)}
                  />
                </Field>
              </div>
              <div className="enquiry-fuels">
                {(["hsfo", "vlsfo", "lsmgo"] as const).map((grade) => (
                  <Field key={grade} label={grade.toUpperCase()}>
                    <div className="quantity-field">
                      <input
                        aria-label={grade.toUpperCase()}
                        value={fields[grade]}
                        placeholder="—"
                        onChange={(event) => update(grade, event.target.value)}
                      />
                      <span aria-hidden="true">MT</span>
                    </div>
                  </Field>
                ))}
              </div>
              <Field label="Remarks">
                <textarea
                  rows={3}
                  value={fields.remarks}
                  onChange={(event) => update("remarks", event.target.value)}
                />
              </Field>
              <div className="enquiry-terms">
                <button
                  type="button"
                  aria-pressed={rmk}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      rmk: !current.rmk,
                      preview: null,
                    }))
                  }
                >
                  RMK
                </button>
                {["80cst min", "120cst max", "180cst max"].map((term) => (
                  <button
                    key={term}
                    type="button"
                    aria-pressed={viscosity.includes(term)}
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        preview: null,
                        viscosity: current.viscosity.includes(term)
                          ? current.viscosity.filter((item) => item !== term)
                          : [
                              ...current.viscosity.filter(
                                (item) =>
                                  !term.includes("max") ||
                                  !item.includes("max"),
                              ),
                              term,
                            ],
                      }))
                    }
                  >
                    {term}
                  </button>
                ))}
                {["COQ REQUIRED", "30D QUALITY TIME BAR", "BIMCO TERMS"].map(
                  (term) => (
                    <button
                      key={term}
                      type="button"
                      aria-pressed={fields.remarks
                        .toUpperCase()
                        .split(/\s*\/\s*|\n/)
                        .includes(term)}
                      onClick={() => toggleRemark(term)}
                    >
                      {term === "BIMCO TERMS" ? "BIMCO" : term}
                    </button>
                  ),
                )}
              </div>
            </fieldset>
          </div>
        </div>
      </section>
      <section
        role="tabpanel"
        id="center-panel-Intelligence"
        aria-labelledby="center-tab-Intelligence"
        hidden={tab !== "Intelligence"}
        className="center-intelligence-panel"
      >
        {port ? (
          <KnowledgePanel key={port.id} target={{ kind: "port", id: port.id }} open={open}
            onOpenSupplier={(portId, supplierId) => onOpen("suppliers", { portId, supplierId })} fixedLayout />
        ) : <p>Select a port in Enquiries.</p>}
      </section>
      <section
        role="tabpanel"
        id="center-panel-Credit"
        aria-labelledby="center-tab-Credit"
        hidden={tab !== "Credit"}
        className="center-buyer-profile-panel"
      >
        {!buyerCreditAvailable ? <ReleaseNotice /> : buyer ? <BuyerProfile key={`${actor.id}:${buyer.id}`} buyer={buyer} open={open} enquiryId={saved?.buyerId === buyer.id ? saved.id : undefined} /> : <p>Select a buyer in Enquiries.</p>}
      </section>
    </>
  );
}
