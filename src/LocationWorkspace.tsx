import { uppercaseText } from "./lib/uppercase";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  ClipboardPaste,
  Plus,
  Search,
  X,
} from "lucide-react";
import { useDemo } from "./store";
import { KnowledgePanel } from "./KnowledgeWorkspace";
import { type KnowledgeTarget } from "./lib/knowledge";
import {
  locationCountries,
  locationProfileTarget,
  locationRecords,
  locationAncestors,
  type LocationRecord,
} from "./lib/locations";
import { Field, Modal } from "./ui";
import type { OpenModal } from "./types";
import type { OpenWorkspace, WorkspaceNavigationContext } from "./workspaceNavigation";
import "./locations.css";
const KnowledgeExtractor = lazy(() => import("./KnowledgeExtractor"));

type NewLocation = {
  kind: "country" | "port";
  name: string;
  country?: string;
};
const typeLabel = { country: "Country", port: "Port" };
function recentKeys(actor: string): string[] {
  try {
    const value = JSON.parse(
      localStorage.getItem(`ecosystem.locations.recent.${actor}`) || "[]",
    );
    return Array.isArray(value)
      ? value.filter((x) => typeof x === "string").slice(0, 6)
      : [];
  } catch {
    return [];
  }
}
function contextTarget(
  context: WorkspaceNavigationContext | undefined,
  areas: { id: string; country: string }[] = [],
): KnowledgeTarget | undefined {
  if (context?.areaId) {
    const area = areas.find((item) => item.id === context.areaId);
    if (area) return { kind: "country", id: area.country };
  }
  if (context?.country && !context.portId)
    return { kind: "country", id: context.country };
  if (context?.portId) return { kind: "port", id: context.portId };
}
export default function LocationWorkspace({
  open,
  onOpen,
  context,
}: {
  open: OpenModal;
  onOpen: OpenWorkspace;
  context?: WorkspaceNavigationContext;
}) {
  const { state, actor } = useDemo();
  const records = useMemo(
    () => locationRecords(state),
    [state],
  );
  const [selected, setSelected] = useState<string | undefined>(() => {
    const target = contextTarget(context, state.legacyLocationAreas);
    if (!target) return;
    const actual = locationProfileTarget(state, target);
    return `${actual.kind}:${actual.id}`;
  });
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState<"country" | "port" | undefined>();
  const [recent, setRecent] = useState(() => recentKeys(actor.id));
  const [adding, setAdding] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [created, setCreated] = useState<NewLocation>();
  const profileDirty = useRef(false);
  function leaveProfile() {
    if (profileDirty.current && !window.confirm('DISCARD UNSAVED CHANGES?')) return false;
    profileDirty.current = false;
    return true;
  }
  function profileKey(key: string) {
    const colon = key.indexOf(":");
    if (colon < 0) return key;
    const target = locationProfileTarget(state, { kind: key.slice(0, colon) as KnowledgeTarget["kind"], id: key.slice(colon + 1) });
    return `${target.kind}:${target.id}`;
  }
  const visibleRecent = [...new Set(recent.map(profileKey))];
  const current = records.find((r) => r.key === (selected ? profileKey(selected) : undefined));
  function choose(record: LocationRecord) {
    record = records.find(item => item.key === profileKey(record.key)) ?? record;
    if (record.key !== current?.key && !leaveProfile()) return;
    setSelected(record.key);
    setIndex(undefined);
    setQuery("");
    setRecent((previous) => {
      const next = [
        record.key,
        ...new Set(previous.map(profileKey).filter((key) => key !== record.key)),
      ].slice(0, 6);
      try {
        localStorage.setItem(
          `ecosystem.locations.recent.${actor.id}`,
          JSON.stringify(next),
        );
      } catch {}
      return next;
    });
  }
  function showLanding() {
    if (!leaveProfile()) return;
    setSelected(undefined);
    setIndex(undefined);
    setQuery("");
  }
  function showIndex(kind: "country" | "port") {
    if (!leaveProfile()) return;
    setSelected(undefined);
    setQuery("");
    setIndex(kind);
  }
  useEffect(() => {
    const target = contextTarget(context, state.legacyLocationAreas);
    if (target) {
      const actual = locationProfileTarget(state, target);
      const record = records.find(
        (r) => r.key === `${actual.kind}:${actual.id}`,
      );
      if (record) choose(record);
    } else showLanding();
  }, [context]);
  useEffect(() => {
    if (!created) return;
    const record = records.find(
            (r) =>
              r.kind === created.kind &&
              r.name.toLowerCase() === created.name.trim().toLowerCase() &&
              (!created.country || r.country === created.country),
          );
    if (record) choose(record);
    setCreated(undefined);
  }, [state, created]);
  const normalized = query.trim().toLocaleLowerCase();
  const matching = records.filter(
    (r) =>
      (!index || r.kind === index) &&
      `${r.name} ${r.path}`.toLocaleLowerCase().includes(normalized),
  );
  const filtered = index ? matching : [...new Map(matching.map(record => {
    const key = profileKey(record.key);
    return [key, records.find(item => item.key === key) ?? record] as const;
  })).values()];
  const ancestors = current
    ? locationAncestors(state, current.target)
    : [];
  const directory = !!index || !!normalized;
  const landing = !current && !directory;
  return (
    <div className={`location-workspace${current && !directory ? " location-workspace-profile" : ""}`}>
      <div className="location-toolbar">
        {!landing && <button className="location-back" aria-label="Back to Countries & Ports" title="Back to Countries & Ports" onClick={showLanding}><ArrowLeft size={17} /></button>}
        <label className="location-search">
          <Search size={16} />
          <input
            aria-label="Country or port"
            placeholder="Country or port"
            value={query}
            onChange={(e) => { if (e.target.value.trim() && !leaveProfile()) return; setQuery(e.target.value); }}
          />
          {query && (
            <button
              type="button"
              aria-label="Clear location search"
              onClick={() => setQuery("")}
            >
              <X size={15} />
            </button>
          )}
        </label>
        <div className="location-toolbar-actions">
          <button className="button secondary" onClick={() => { if (leaveProfile()) setExtracting(true); }}>
            <ClipboardPaste size={14} /> Information extractor
          </button>
          <button
            className="button secondary location-add"
            onClick={() => { if (leaveProfile()) setAdding(true); }}
          >
            <Plus size={14} /> Add location
          </button>
          <button
            className="button secondary"
            aria-pressed={index === "country"}
            onClick={() => showIndex("country")}
          >
            Country Index
          </button>
          <button
            className="button secondary"
            aria-pressed={index === "port"}
            onClick={() => showIndex("port")}
          >
            Port Index
          </button>
        </div>
      </div>
      {landing ? (
        <div className="location-body">
          <section className="location-recents" aria-label="Recently viewed">
            <span>Recently viewed</span>
            {visibleRecent.flatMap((key) => {
              const record = records.find((r) => r.key === key);
              return record
                ? [
                    <button
                      key={key}
                      onClick={() => choose(record)}
                      title={uppercaseText(record.path)}
                    >
                      {record.name}
                    </button>,
                  ]
                : [];
            })}
          </section>
        </div>
      ) : directory ? (
        <div className="location-body">
          <section
            className="location-directory"
            aria-label={
              index === "country"
                ? "Country Index"
                : index === "port"
                  ? "Port Index"
                  : "Search results"
            }
          >
            <div className="location-filter-bar">
              <h2>
                {index === "country"
                  ? "Country Index"
                  : index === "port"
                    ? "Port Index"
                    : "Search results"}
              </h2>
              <span>{filtered.length} locations</span>
            </div>
            <LocationTable records={filtered} onChoose={choose} />
          </section>
        </div>
      ) : current ? (
          <KnowledgePanel
            key={current.key}
            target={current.target}
            onDirtyChange={dirty => { profileDirty.current = dirty; }}
            open={open}
            onOpenSupplier={(portId, supplierId) => onOpen("suppliers", { portId, supplierId, returnTo: "ports" })}
            onOpenPort={portId => { const record = records.find(item => item.kind === "port" && item.target.id === portId); if (record) choose(record); }}
            fixedLayout
            navigation={(ancestors.length > 0) ? <nav className="location-parent-path" aria-label="Location breadcrumb">
              {ancestors.map(record => <button key={record.key} onClick={() => choose(record)}>{record.name}</button>)}
            </nav> : undefined}
          />
      ) : null}
      {extracting && <Suspense fallback={<span role="status">Loading…</span>}>
        <KnowledgeExtractor current={current} onClose={() => setExtracting(false)} onSaved={key => {
          setExtracting(false);
          const record = records.find(item => item.key === key);
          if (record) choose(record);
        }} />
      </Suspense>}
      {adding && (
        <AddLocation
          current={current}
          onClose={() => setAdding(false)}
          onCreated={(value) => {
            setCreated(value);
            setAdding(false);
          }}
        />
      )}
    </div>
  );
}
function LocationTable({
  records,
  onChoose,
}: {
  records: LocationRecord[];
  onChoose: (record: LocationRecord) => void;
}) {
  const [page, setPage] = useState(0);
  const size = 50;
  const signature = records.map((r) => r.key).join("|");
  useEffect(() => setPage(0), [signature]);
  const index = Math.min(
    page,
    Math.max(0, Math.ceil(records.length / size) - 1),
  );
  return (
    <>
      <div className="location-table-wrap">
        <table className="location-table">
          <thead>
            <tr>
              <th>Location</th>
              <th>Type</th>
              <th>Country</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {records.slice(index * size, (index + 1) * size).map((record) => (
              <tr key={record.key}>
                <td>
                  <button onClick={() => onChoose(record)}>
                    {record.name}
                  </button>
                </td>
                <td>{typeLabel[record.kind]}</td>
                <td>
                  {record.kind === "port" ? record.country || "—" : "—"}
                </td>
                <td>
                  <button
                    aria-label={`Open ${record.path}`}
                    onClick={() => onChoose(record)}
                  >
                    <ArrowUpRight size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!records.length && <p className="location-empty">No matches</p>}
      </div>
      {records.length > size && (
        <div className="location-pagination">
          <button disabled={index === 0} onClick={() => setPage(index - 1)}>
            Previous
          </button>
          <span>
            {index * size + 1}–{Math.min(records.length, (index + 1) * size)} /{" "}
            {records.length}
          </span>
          <button
            disabled={(index + 1) * size >= records.length}
            onClick={() => setPage(index + 1)}
          >
            Next
          </button>
        </div>
      )}
    </>
  );
}
function AddLocation({
  current,
  onClose,
  onCreated,
}: {
  current?: LocationRecord;
  onClose: () => void;
  onCreated: (value: NewLocation) => void;
}) {
  const { state, run, toast } = useDemo();
  const [kind, setKind] = useState<NewLocation["kind"]>("port");
  const [name, setName] = useState("");
  const [country, setCountry] = useState(
    current?.kind === "country" ? current.target.id : (current?.country ?? ""),
  );
  const countries = locationCountries(state);
  return (
    <Modal title="Add location" onClose={onClose}>
      <form
        className="location-create"
        onSubmit={(e) => {
          e.preventDefault();
          const value = {
            kind,
            name: name.trim(),
            ...(kind !== "country" ? { country } : {}),
          };
          if (run({ type: "add-location", ...value }, "Location added."))
            onCreated(value);
        }}
      >
        {toast?.error && (
          <p className="notice rose" role="alert">
            {toast.message}
          </p>
        )}
        <div className="form-grid">
          <Field label="Name">
            <input autoFocus required maxLength={150} value={name} onChange={e => setName(e.target.value)} />
          </Field>
          <Field label="Type">
            <select
              aria-label="Type"
              value={kind}
              onChange={(e) => setKind(e.target.value as NewLocation["kind"])}
            >
              <option value="country">Country</option>
              <option value="port">Port</option>
            </select>
          </Field>
          {kind !== "country" && (
            <Field label="Country">
              <select
                aria-label="Country"
                required
                value={country}
                onChange={(e) => {
                  setCountry(e.target.value);
                }}
              >
                <option value="">Select country</option>
                {countries.map((r) => (
                  <option value={r.id} key={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </Field>
          )}

        </div>
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" type="submit">
            Add location
          </button>
        </div>
      </form>
    </Modal>
  );
}
