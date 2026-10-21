import KnowledgeUpdateButton from "./KnowledgeUpdateButton";
import { useState, useEffect, useRef } from "react";
import { ArrowLeft, ArrowRight, FileText, GripVertical, Plus, Table2, Trash2, Type, Pencil } from "lucide-react";
import { dropDestination, dropEdge, type DropEdge } from "./lib/dropPosition";
import { Modal } from "./ui";
import { useDemo } from "./store";
import { uid } from "./lib/model";
import { isEmailText, uppercaseText } from "./lib/uppercase";
import {
  countryKnowledgeSections,
  isReadOnlyKnowledgeSection,
  sameKnowledge,
  type KnowledgeBlock,
  type KnowledgeDocument,
  type KnowledgeTarget,
} from "./lib/knowledge";
import KnowledgeTableEditor from "./KnowledgeTableEditor";
import "./knowledge-editor.css";

const blockNames = { text: "Text", table: "Table", file: "File" };
const blockIcons = { text: Type, table: Table2, file: FileText };
function makeBlock(type: KnowledgeBlock["type"]): KnowledgeBlock {
  const common = { id: uid("block"), title: "" };
  return type === "text" ? { ...common, type, text: "" }
    : type === "file" ? { ...common, type, url: "" }
      : { ...common, type, columns: [{ id: uid("column"), name: "Name" }, { id: uid("column"), name: "Information" }], rows: [{ id: uid("row"), cells: ["", ""] }] };
}
function blockSummary(block: KnowledgeBlock) {
  return block.title || (block.type === "text" ? block.text.split("\n")[0] : block.type === "file" ? block.url : "") || blockNames[block.type];
}
function fixedTab(title: string, target: KnowledgeTarget) {
  if (target.kind !== "country" && target.kind !== "port") return false;
  const names: string[] = countryKnowledgeSections.map(section => section.title);
  if (target.kind === "port") names.push("Port Information");
  return names.some(name => name.toLowerCase() === title.trim().toLowerCase());
}

export interface KnowledgeEditorTab { id: string; title: string; visibility: 'shared' | 'private' }
export function KnowledgeEditor({ target, initial, initialSection, initialBlock, onSaved, onManageTabs, reservedTabNames = [], mode = "edit", onClose,
  embedded = false, onCommit, onDirtyChange, editorTabs, editorTabId, onSelectEditorTab, readOnlyNames = false, saveLabel,
}: {
  embedded?: boolean;
  onCommit?: (document: KnowledgeDocument) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  editorTabs?: readonly KnowledgeEditorTab[];
  editorTabId?: string;
  onSelectEditorTab?: (id: string) => void;
  readOnlyNames?: boolean;
  saveLabel?: string;
  target: KnowledgeTarget;
  initial: KnowledgeDocument;
  initialSection?: string;
  initialBlock?: string;
  onSaved?: (id: string, title?: string) => void;
  onManageTabs?: () => void;
  reservedTabNames?: string[];
  mode?: "edit" | "section" | "rename" | "text" | "table";
  onClose: () => void;
}) {
  const { run, toast } = useDemo();
  const [saving, setSaving] = useState(false), [saveError, setSaveError] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const editableSections = initial.sections.filter(section => !isReadOnlyKnowledgeSection(section));
  const initialTabId = editableSections.find(section => section.id === initialSection)?.id ?? editableSections[0]?.id ?? initial.sections[0].id;
  const [base] = useState(() => structuredClone(initial));
  const [newSectionId] = useState(() => uid("section"));
  const [draft, setDraft] = useState(() => {
    const document = structuredClone(initial);
    if (mode === "section") document.sections.push({ id: newSectionId, title: "", blocks: [] });
    if (mode === "text" || mode === "table") {
      (document.sections.find(section => section.id === initialTabId) ?? document.sections[0]).blocks.push(makeBlock(mode));
    }
    return document;
  });
  const [active, setActive] = useState(mode === "section" ? newSectionId : initialTabId);
  const section = draft.sections.find(section => section.id === active) ?? draft.sections[0];
  const [selected, setSelected] = useState(() => initialBlock ?? ((mode === "text" || mode === "table") ? section.blocks.at(-1)?.id : section.blocks[0]?.id));
  const [dragging, setDragging] = useState<string>();
  const [dropTarget, setDropTarget] = useState<{ id: string; edge: DropEdge }>();
  const touchDrag = useRef<{ id: string; y: number; active: boolean; destination?: { id: string; edge: DropEdge } }>(undefined);
  const [orderStatus, setOrderStatus] = useState("");
  const [naming, setNaming] = useState(mode === "section" || mode === "rename");
  const nameInput = useRef<HTMLInputElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const block = section.blocks.find(item => item.id === selected) ?? section.blocks[0];
  const blockIndex = section.blocks.findIndex(item => item.id === block?.id);
  const baseSection = base.sections.find(item => item.id === section.id);
  const isFixed = Boolean(baseSection && fixedTab(baseSection.title, target));
  const tabOnly = mode === "section" || mode === "rename";
  const dirty = !sameKnowledge(base, draft);
  const editorChoices = editorTabs ? [...editorTabs.filter(tab => tab.visibility === 'private'), ...editorTabs.filter(tab => tab.visibility === 'shared')] : undefined;
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => { if (!dirty) return; const handler = (event: BeforeUnloadEvent) => event.preventDefault(); window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler); }, [dirty]);
  const titleChanged = section.title.trim().toLowerCase() !== baseSection?.title.trim().toLowerCase();
  const nameError = !section.title.trim() ? "Enter a tab name."
    : titleChanged && draft.sections.some(item => item.id !== section.id && item.title.trim().toLowerCase() === section.title.trim().toLowerCase()) ? "This tab name is already in use."
      : target.kind === "port" && section.title.trim().toLowerCase() === "price history" && baseSection?.title.trim().toLowerCase() !== "price history" ? "This tab name is already in use."
        : titleChanged && reservedTabNames.some(name => name.trim().toLowerCase() === section.title.trim().toLowerCase()) ? "This tab name is already in use." : "";
  useEffect(() => {
    if (naming) { nameInput.current?.focus(); nameInput.current?.select(); }
  }, [naming]);
  function change(fn: (document: KnowledgeDocument) => void) {
    setDraft(document => { const next = structuredClone(document); fn(next); return next; });
  }
  function close() {
    if (!saving && (!dirty || window.confirm("DISCARD UNSAVED CHANGES?"))) onClose();
  }
  function updateBlock(next: KnowledgeBlock) {
    change(document => {
      const current = document.sections.find(item => item.id === section.id)!;
      current.blocks = current.blocks.map(item => item.id === next.id ? next : item);
    });
  }
  function add(type: "text" | "table") {
    const next = makeBlock(type);
    const destination = section;
    change(document => document.sections.find(item => item.id === destination.id)!.blocks.push(next));
    setActive(destination.id);
    setNaming(false);
    setSelected(next.id);
  }
  function addTab() {
    const id = uid("section");
    change(document => document.sections.push({ id, title: "", blocks: [] }));
    setActive(id);
    setSelected(undefined);
    setNaming(true);
  }
  function moveTab(delta: number) {
    change(document => {
      const from = document.sections.findIndex(item => item.id === section.id);
      const to = from + delta;
      if (to < 0 || to >= document.sections.length || fixedTab(document.sections[to].title, target)) return;
      [document.sections[from], document.sections[to]] = [document.sections[to], document.sections[from]];
    });
  }
  function moveBlock(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= section.blocks.length || to >= section.blocks.length) return;
    const moved = section.blocks[from];
    change(document => {
      const blocks = document.sections.find(item => item.id === section.id)!.blocks;
      const [item] = blocks.splice(from, 1);
      blocks.splice(to, 0, item);
    });
    setSelected(moved.id);
    setOrderStatus(`${blockSummary(moved)} moved to position ${to + 1}.`);
    setDragging(undefined); setDropTarget(undefined);
  }
  async function save() {
    if (saving || !dirty) return;
    if (nameError) { setNaming(true); return; }
    const untitledSection = draft.sections.find(item => item.blocks.some(entry => !entry.title.trim()));
    if (untitledSection) {
      setActive(untitledSection.id);
      setSelected(untitledSection.blocks.find(entry => !entry.title.trim())!.id);
      requestAnimationFrame(() => { titleInput.current?.focus(); titleInput.current?.reportValidity(); });
      return;
    }
    if (onCommit) {
      setSaving(true); setSaveError("");
      try { await onCommit(structuredClone(draft)); if (alive.current) { onSaved?.(section.id, section.title.trim()); onClose(); } }
      catch (error) { if (alive.current) setSaveError(error instanceof Error ? error.message : "Unable to save information."); }
      finally { if (alive.current) setSaving(false); }
      return;
    }
    if (run({ type: "save-knowledge", change: { target, baseVersion: base.version, baseDocument: base, document: draft }, reason: section.title + " updated" }, "Updated.")) {
      onSaved?.(section.id, section.title.trim());
      onClose();
    }
  }
  const nameField = <label className="knowledge-field">
    Tab name
    <input ref={nameInput} aria-label="Tab name" required maxLength={150} value={section.title} readOnly={isFixed}
      aria-invalid={Boolean(nameError)} onChange={event => change(document => { document.sections.find(item => item.id === section.id)!.title = event.target.value; })} />
    {section.title && nameError && <span className="knowledge-name-error" role="alert">{nameError}</span>}
  </label>;
  const form = <form className={"knowledge-editor knowledge-editor-focused" + (embedded ? " knowledge-editor-embedded" : "") + (tabOnly ? " knowledge-tab-form" : "")} aria-busy={saving} inert={saving}
      onSubmit={event => { event.preventDefault(); void save(); }}
      onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); event.currentTarget.requestSubmit(); } }}>
      {saveError && <p className="notice rose" role="alert">{saveError}</p>}
      {!onCommit && toast?.error && <p className="notice rose" role="alert">{toast.message}</p>}
      {tabOnly ? nameField : <>
        {!embedded && <div className="knowledge-editor-topbar">
          <select aria-label="Edit tab" value={editorTabId ?? section.id} onChange={event => {
            if (onSelectEditorTab) { if (!dirty || window.confirm("DISCARD UNSAVED CHANGES?")) { onDirtyChange?.(false); onSelectEditorTab(event.target.value); } }
            else { setActive(event.target.value); setSelected(undefined); setNaming(false); }
          }}>
            {editorChoices ? editorChoices.map(item => <option key={item.id} value={item.id}>{item.title}{item.visibility === 'private' ? ' (PRIVATE)' : ''}</option>) : draft.sections.filter(item => !isReadOnlyKnowledgeSection(item)).map(item => <option key={item.id} value={item.id}>{item.title || "New tab"}</option>)}
          </select>
          {onManageTabs ? <button type="button" onClick={() => { if (!dirty || window.confirm("DISCARD UNSAVED CHANGES?")) { onDirtyChange?.(false); onManageTabs(); } }}>Manage Tabs</button> : !readOnlyNames && <>
          {!isFixed && <button type="button" className="knowledge-icon-control" aria-label="Rename Tab" title="Rename Tab" onClick={() => setNaming(!naming)}><Pencil size={15} /></button>}
          <button type="button" onClick={addTab} disabled={draft.sections.length >= 57}><Plus size={14} /> Add Tab</button>
          {!isFixed && <>
            <button type="button" className="knowledge-icon-control" aria-label="Move tab left" title="Move tab left" disabled={draft.sections.findIndex(item => item.id === section.id) === 0 || fixedTab(draft.sections[draft.sections.findIndex(item => item.id === section.id) - 1]?.title ?? "", target)} onClick={() => moveTab(-1)}><ArrowLeft size={14} /></button>
            <button type="button" className="knowledge-icon-control" aria-label="Move tab right" title="Move tab right" disabled={draft.sections.at(-1)?.id === section.id || fixedTab(draft.sections[draft.sections.findIndex(item => item.id === section.id) + 1]?.title ?? "", target)} onClick={() => moveTab(1)}><ArrowRight size={14} /></button>
          </>}
          {!isFixed && <button type="button" className="knowledge-icon-control" aria-label="Delete tab" title="Delete tab" disabled={draft.sections.length === 1} onClick={() => {
            if (window.confirm(uppercaseText('Delete tab “' + section.title + '”?'))) {
              const nextActive = draft.sections.find(item => item.id !== section.id)!.id;
              change(document => { document.sections = document.sections.filter(item => item.id !== section.id); });
              setActive(nextActive); setSelected(undefined); setNaming(false);
            }
          }}><Trash2 size={14} /></button>}
          </>}
        </div>}
        {naming && nameField}
        <span className="knowledge-sr-only" role="status">{orderStatus}</span>
        <div className="knowledge-editor-canvas">
          <nav className="knowledge-block-outline" aria-label="Information sections" onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(undefined); }}>
            <header className="knowledge-outline-header"><h3>Sections</h3>
              <div className="knowledge-editor-additions" role="group" aria-label="Add section">
                <button type="button" disabled={section.blocks.length >= 100} onClick={() => add("text")}><Type size={14} />Add Text</button>
                <button type="button" disabled={section.blocks.length >= 100} onClick={() => add("table")}><Table2 size={14} />Add Table</button>
              </div>
            </header>
            <div className="knowledge-outline-list">
            {section.blocks.map((item, index) => {
              const Icon = blockIcons[item.type];
              return <div key={item.id} className={`knowledge-outline-item${item.id === block?.id ? " is-selected" : ""}${dragging === item.id ? " is-dragging" : ""}${dropTarget?.id === item.id ? ` is-drop-${dropTarget.edge}` : ""}`} data-block-id={item.id}
                onDragOver={event => { if (dragging) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; const bounds = event.currentTarget.getBoundingClientRect(); setDropTarget({ id: item.id, edge: dropEdge(event.clientY, bounds.top, bounds.height) }); } }}
                onDrop={event => { event.preventDefault(); if (dragging) { const bounds = event.currentTarget.getBoundingClientRect(); moveBlock(section.blocks.findIndex(entry => entry.id === dragging), dropDestination(section.blocks.findIndex(entry => entry.id === dragging), index, dropEdge(event.clientY, bounds.top, bounds.height))); } setDragging(undefined); setDropTarget(undefined); }}>
                <span className="knowledge-outline-grip" draggable onDragStart={event => { setDragging(item.id); event.dataTransfer.setData("text/plain", item.id); event.dataTransfer.effectAllowed = "move"; }}
                  onPointerDown={event => { if (event.pointerType === "mouse") return; touchDrag.current = { id: item.id, y: event.clientY, active: false }; event.currentTarget.setPointerCapture(event.pointerId); }}
                  onPointerMove={event => { const touch = touchDrag.current; if (!touch) return; if (!touch.active && Math.abs(event.clientY - touch.y) < 6) return; touch.active = true; setDragging(touch.id); const node = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".knowledge-outline-item"); if (node && node.closest(".knowledge-block-outline") === event.currentTarget.closest(".knowledge-block-outline")) { const bounds = node.getBoundingClientRect(); touch.destination = { id: node.dataset.blockId!, edge: dropEdge(event.clientY, bounds.top, bounds.height) }; setDropTarget(touch.destination); } else { touch.destination = undefined; setDropTarget(undefined); } }}
                  onPointerUp={event => { const touch = touchDrag.current; touchDrag.current = undefined; if (touch?.active && touch.destination) { const from = section.blocks.findIndex(entry => entry.id === touch.id); const to = section.blocks.findIndex(entry => entry.id === touch.destination!.id); if (to >= 0) moveBlock(from, dropDestination(from, to, touch.destination.edge)); } if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); setDragging(undefined); setDropTarget(undefined); }}
                  onPointerCancel={() => { touchDrag.current = undefined; setDragging(undefined); setDropTarget(undefined); }}
                  onDragEnd={() => { setDragging(undefined); setDropTarget(undefined); }} title="Drag to reorder" aria-hidden="true"><GripVertical size={14} /></span>
                <button className="knowledge-outline-select" type="button" aria-label={"Edit " + blockNames[item.type] + " " + (index + 1)} aria-pressed={item.id === block?.id} title={blockSummary(item)}
                  onKeyDown={event => { if (event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); moveBlock(index, index + (event.key === "ArrowUp" ? -1 : 1)); } }}
                  onClick={() => setSelected(item.id)}><Icon size={14} /><span><strong>{blockSummary(item)}</strong><small>{index + 1} · {blockNames[item.type]}{item.type === "table" ? " · " + item.rows.length + " rows" : ""}</small></span></button>
              </div>;
            })}
            </div>
          </nav>
          {block ? <div className="knowledge-block-detail" key={block.id}>
            <header className="knowledge-block-detail-head">
              <input ref={titleInput} className="knowledge-block-title" aria-label={"Block " + (blockIndex + 1) + " title"} placeholder={block.type === "file" ? "File name" : "Title"}
                required pattern={".*\\S.*"} maxLength={150} value={block.title} onChange={event => updateBlock({ ...block, title: event.target.value })} />
              <button type="button" className="knowledge-icon-control" aria-label={"Delete block " + (blockIndex + 1)} title="Delete block" onClick={() => {
                if (window.confirm("DELETE THIS BLOCK?")) {
                  change(document => { const current = document.sections.find(item => item.id === section.id)!; current.blocks = current.blocks.filter(item => item.id !== block.id); });
                  setSelected(section.blocks[blockIndex + 1]?.id ?? section.blocks[blockIndex - 1]?.id);
                }
              }}><Trash2 size={14} /></button>
            </header>
            {block.type === "text" ? <textarea className="knowledge-text-canvas" aria-label={"Block " + (blockIndex + 1) + " text"} rows={12} placeholder="Text" maxLength={30000} value={block.text}
              onChange={event => updateBlock({ ...block, text: event.target.value })} />
              : block.type === "file" ? <label className="knowledge-field knowledge-file-field">HTTPS file link<input type="url" required value={block.url} onChange={event => updateBlock({ ...block, url: event.target.value })} /></label>
                : <KnowledgeTableEditor table={block} onChange={updateBlock} />}
          </div> : <div className="knowledge-editor-empty"><span>No information</span></div>}
        </div>
      </>}
      <footer className="knowledge-editor-tools knowledge-editor-actions">
        <button type="button" onClick={close}>Cancel</button>
        <KnowledgeUpdateButton disabled={saving || !dirty || Boolean(nameError)} type="submit">{saving ? "SAVING…" : saveLabel ?? (tabOnly ? mode === "section" ? "Add Tab" : "Save" : "CONTRIBUTE +1")}</KnowledgeUpdateButton>
      </footer>
    </form>;
  return embedded ? form : <Modal title={tabOnly ? mode === "section" ? "Add Tab" : "Rename Tab" : "Update information"} onClose={close} wide={!tabOnly}>{form}</Modal>;
}


function fields(doc: KnowledgeDocument) {
  const result = new Map<string, { label: string; value: string; display?: string }>();
  result.set("order", {
    label: "Section order",
    value: doc.sections.map((s) => s.title).join(" → "),
  });
  doc.sections.forEach((s) => {
    result.set(s.id, { label: "Section title", value: s.title });
    result.set(`${s.id}:blocks`, {
      label: `${s.title} / Block order`,
      value: s.blocks.map((b) => b.title || b.type).join(" → "),
    });
    s.blocks.forEach((b, i) => {
      const label = `${s.title} / ${b.title || `Block ${i + 1}`}`;
      result.set(`${b.id}:title`, {
        label: `${s.title} / Block title`,
        value: b.title,
      });
      if (b.type === "text") result.set(b.id, { label, value: b.text });
      else if (b.type === "file") result.set(b.id, { label, value: b.url });
      else {
        result.set(`${b.id}:rows`, {
          label: `${label} / Rows`,
          value: String(b.rows.length),
        });
        result.set(`${b.id}:row-order`, {
          label: `${label} / Row order`,
          value: b.rows.map(row => row.id).join("|"),
          display: b.rows.map(row => row.cells.join(" | ")).join("\n"),
        });
        result.set(`${b.id}:order`, {
          label: `${label} / Columns`,
          value: b.columns.map((c) => c.name).join(" | "),
        });
        b.columns.forEach((c) =>
          result.set(`${b.id}:${c.id}:width`, {
            label: `${label} / ${c.name} / Column width`,
            value: String(c.width ?? 160),
          }),
        );
        b.rows.forEach((r, n) =>
          r.cells.forEach((v, c) =>
            result.set(`${b.id}:${r.id}:${b.columns[c].id}`, {
              label: `${label} / Row ${n + 1} / ${b.columns[c].name}`,
              value: v,
            }),
          ),
        );
      }
    });
  });
  return result;
}
export function KnowledgeComparison({
  before,
  after,
}: {
  before: KnowledgeDocument;
  after: KnowledgeDocument;
}) {
  const [page, setPage] = useState(0),
    left = fields(before),
    right = fields(after);
  const changes = [...new Set([...left.keys(), ...right.keys()])].filter(
      (k) => left.get(k)?.value !== right.get(k)?.value,
    ),
    index = Math.min(page, Math.max(0, Math.ceil(changes.length / 50) - 1));
  return (
    <div className="knowledge-comparison">
      <div className="knowledge-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Field</th>
              <th>Current</th>
              <th>Proposed</th>
            </tr>
          </thead>
          <tbody>
            {changes.slice(index * 50, index * 50 + 50).map((k) => (
              <tr key={k}>
                <th>{right.get(k)?.label ?? left.get(k)?.label}</th>
                <td data-email-value={isEmailText(left.get(k)?.value || "") ? "" : undefined}>{left.get(k)?.display ?? (left.get(k)?.value || "—")}</td>
                <td data-email-value={isEmailText(right.get(k)?.value || "") ? "" : undefined}>{right.get(k)?.display ?? (right.get(k)?.value || "—")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!changes.length && <p>No changes</p>}
      {changes.length > 50 && (
        <div className="knowledge-pagination">
          <button
            type="button"
            disabled={!index}
            onClick={() => setPage(index - 1)}
          >
            Previous
          </button>
          <span>
            {index + 1} / {Math.ceil(changes.length / 50)}
          </span>
          <button
            type="button"
            disabled={(index + 1) * 50 >= changes.length}
            onClick={() => setPage(index + 1)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
