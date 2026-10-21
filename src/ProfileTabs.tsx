import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, GripVertical, LockKeyhole, Plus, SlidersHorizontal, Trash2 } from 'lucide-react';
import { Modal } from './ui';
import { dropDestination, dropEdge, type DropEdge } from './lib/dropPosition';
import { KnowledgeEditor, type KnowledgeEditorTab } from './KnowledgeEditor';
import { decodeProfileTabContent, encodeProfileTabContent, profileTabDocument, type ProfileContentBlock } from './lib/profileTabContent';
import { isEmailText } from './lib/uppercase';
import './profile-tabs.css';

export interface ProfileTabDescriptor { id: string; title: string; visibility: 'shared' | 'private'; builtin?: string; entryCount?: number; content?: string; reorderGroup?: string }

const privateFirst = <T extends { visibility: 'shared' | 'private' }>(tabs: readonly T[]): T[] => [...tabs.filter(tab => tab.visibility === 'private'), ...tabs.filter(tab => tab.visibility === 'shared')];

/** Presentation only. Each profile's adapter owns its shared/private persistence and permissions. */
export function ProfileTabs({ tabs, activeId, onSelect, onManage, label = 'Profile sections', idPrefix, children }: {
  tabs: readonly ProfileTabDescriptor[]; activeId: string; onSelect: (id: string) => void; onManage?: () => void;
  label?: string; idPrefix: string; children?: ReactNode;
}) {
  tabs = privateFirst(tabs);
  const refs = useRef(new Map<string, HTMLButtonElement>()), list = useRef<HTMLDivElement>(null);
  const tabIds = tabs.map(tab => tab.id).join('|');
  useLayoutEffect(() => {
    const strip = list.current, button = refs.current.get(activeId);
    if (!strip || !button) return;
    const bounds = strip.getBoundingClientRect(), active = button.getBoundingClientRect();
    if (active.left < bounds.left) strip.scrollLeft -= bounds.left - active.left;
    else if (active.right > bounds.right) strip.scrollLeft += active.right - bounds.right;
  }, [activeId, tabIds]);
  return <div className="profile-tabs-bar"><div ref={list} role="tablist" aria-label={label} className="profile-tabs-list">{tabs.map((tab, index) => <button type="button" key={tab.id} data-visibility={tab.visibility} role="tab" id={`${idPrefix}-${tab.id}`} aria-controls={`${idPrefix}-panel`} aria-selected={activeId === tab.id} tabIndex={activeId === tab.id ? 0 : -1} ref={node => { if (node) refs.current.set(tab.id, node); else refs.current.delete(tab.id); }} onClick={() => onSelect(tab.id)} onKeyDown={event => {
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
    if (next >= 0) { event.preventDefault(); onSelect(tabs[next].id); refs.current.get(tabs[next].id)?.focus(); }
  }}>{tab.visibility === 'private' && <LockKeyhole size={12} aria-hidden="true" />}{tab.title}{tab.visibility === 'private' && <span className="profile-tab-private-label">PRIVATE</span>}</button>)}</div>{children}{onManage && <button type="button" className="button secondary profile-tabs-manage" onClick={onManage}><SlidersHorizontal size={13} />Manage tabs</button>}</div>;
}

export function ManageProfileTabs<T extends ProfileTabDescriptor>({ tabs, defaults = [], canManageShared, canManagePrivate, createTab, onSave, onClose, alternateAction, onReload, maxTabs = {}, maxTitleLength = {}, privateCreationGroup }: {
  tabs: readonly T[]; defaults?: readonly Pick<ProfileTabDescriptor, 'title' | 'builtin'>[];
  canManageShared: boolean; canManagePrivate: boolean; privateCreationGroup?: string; maxTabs?: { shared?: number; private?: number }; maxTitleLength?: { shared?: number; private?: number };
  createTab: (input: ProfileTabDescriptor) => T; onSave: (tabs: T[]) => Promise<void>; onClose: () => void; alternateAction?: { label: string; run: () => void }; onReload?: () => void;
}) {
  const [base] = useState(() => structuredClone(privateFirst(tabs)));
  const [draft, setDraft] = useState<T[]>(() => structuredClone(privateFirst(tabs)));
  const limit = (visibility: 'shared' | 'private') => maxTabs[visibility] ?? 30;
  const count = (visibility: 'shared' | 'private') => draft.filter(tab => tab.visibility === visibility && (visibility !== 'private' || !privateCreationGroup || tab.reorderGroup === privateCreationGroup)).length;
  const [error, setError] = useState(''), [saving, setSaving] = useState(false), [conflict, setConflict] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [dragging, setDragging] = useState<string>(), [destination, setDestination] = useState<{ id: string; edge: DropEdge }>();
  const [orderStatus, setOrderStatus] = useState('');
  const id = useId(), inputs = useRef(new Map<string, HTMLInputElement>());
  const editable = (tab: ProfileTabDescriptor) => tab.visibility === 'private' ? canManagePrivate : canManageShared;
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  const invalid = draft.some(tab => !tab.title.trim() || (tab.title.trim().toLocaleLowerCase() !== base.find(entry => entry.id === tab.id)?.title.trim().toLocaleLowerCase() && draft.some(other => other.id !== tab.id && other.visibility === tab.visibility && other.title.trim().toLocaleLowerCase() === tab.title.trim().toLocaleLowerCase())));
  const close = () => { if (!saving && (!dirty || window.confirm('Discard unsaved tab changes?'))) onClose(); };
  function add(visibility: 'shared' | 'private', template?: Pick<ProfileTabDescriptor, 'title' | 'builtin'>) {
    if (count(visibility) >= limit(visibility)) return;
    const tab = createTab({ id: crypto.randomUUID(), title: template?.title ?? '', visibility, ...(template?.builtin ? { builtin: template.builtin } : {}) });
    setDraft(current => {
      const sameGroup = current.reduce((last, item, index) => item.visibility === visibility && item.reorderGroup === tab.reorderGroup ? index : last, -1);
      return privateFirst(sameGroup < 0 ? [...current, tab] : [...current.slice(0, sameGroup + 1), tab, ...current.slice(sameGroup + 1)]);
    });
    requestAnimationFrame(() => inputs.current.get(tab.id)?.focus());
  }
  const movable = (from: number, to: number) => from >= 0 && to >= 0 && from < draft.length && to < draft.length && editable(draft[from]) && draft.slice(Math.min(from, to), Math.max(from, to) + 1).every(tab => tab.visibility === draft[from].visibility && tab.reorderGroup === draft[from].reorderGroup);
  function move(from: number, to: number) {
    if (!movable(from, to) || from === to) return;
    setDraft(current => { const next = [...current], [tab] = next.splice(from, 1); next.splice(to, 0, tab); return next; });
    setOrderStatus(`${draft[from].title} moved to position ${to + 1}.`); setDragging(undefined); setDestination(undefined);
  }
  async function save() {
    if (!dirty || saving || invalid) return;
    setSaving(true); setError(''); setConflict(false);
    try { await onSave(draft.map(tab => ({ ...tab, title: tab.title.trim() }))); if (alive.current) onClose(); }
    catch (failure) { if (alive.current) { setError((failure as Error).message); setConflict((failure as { status?: number }).status === 409); setSaving(false); } }
  }
  const missingDefaults = defaults.filter(template => !draft.some(tab => tab.builtin === template.builtin));
  return <Modal title="Manage tabs" onClose={close}><form className="profile-tabs-manager" onSubmit={event => { event.preventDefault(); void save(); }}>
    {error && <div role="alert" className="shared-supplier-message">{error}{conflict && onReload && <button type="button" className="button secondary" onClick={() => { if (!dirty || window.confirm('Discard unsaved tab changes?')) onReload(); }}>Reload latest</button>}</div>}
    <span className="profile-tabs-instruction">Drag to reorder</span><span className="profile-tabs-sr" role="status">{orderStatus}</span>
    <div className="profile-tabs-manager-list" onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDestination(undefined); }}>
      {draft.map((tab, index) => <div key={tab.id} data-profile-tab-id={tab.id} data-visibility={tab.visibility} className={`profile-tabs-manager-row${destination?.id === tab.id ? ` is-drop-${destination.edge}` : ''}`} onDragOver={event => {
        const bounds = event.currentTarget.getBoundingClientRect(), edge = dropEdge(event.clientY, bounds.top, bounds.height), from = draft.findIndex(item => item.id === dragging), to = dropDestination(from, index, edge);
        if (!saving && movable(from, to)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDestination({ id: tab.id, edge }); } else setDestination(undefined);
      }} onDrop={event => { event.preventDefault(); const bounds = event.currentTarget.getBoundingClientRect(), from = draft.findIndex(item => item.id === dragging); if (!saving) move(from, dropDestination(from, index, dropEdge(event.clientY, bounds.top, bounds.height))); setDragging(undefined); setDestination(undefined); }}>
        <span className="profile-tabs-grip" draggable={editable(tab) && !saving} aria-hidden="true" title="Drag to reorder" onDragStart={event => { setDragging(tab.id); event.dataTransfer.setData('text/plain', tab.id); event.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => { setDragging(undefined); setDestination(undefined); }}><GripVertical size={15} /></span>
        <label htmlFor={`${id}-${tab.id}`}><span>{tab.visibility === 'private' ? 'Private' : 'Shared'}</span><input id={`${id}-${tab.id}`} aria-label={`Tab ${index + 1} name`} value={tab.title} required maxLength={maxTitleLength[tab.visibility] ?? 80} disabled={saving || !editable(tab)} ref={node => { if (node) inputs.current.set(tab.id, node); else inputs.current.delete(tab.id); }} onChange={event => setDraft(current => current.map(item => item.id === tab.id ? { ...item, title: event.target.value } : item))} onKeyDown={event => { if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); move(index, index + (event.key === 'ArrowUp' ? -1 : 1)); } }} /></label>
        <div className="profile-tabs-row-actions"><button type="button" className="icon-button" aria-label={`Move tab ${index + 1} up`} disabled={saving || !movable(index, index - 1)} onClick={() => move(index, index - 1)}><ArrowUp size={15} /></button><button type="button" className="icon-button" aria-label={`Move tab ${index + 1} down`} disabled={saving || !movable(index, index + 1)} onClick={() => move(index, index + 1)}><ArrowDown size={15} /></button><button type="button" className="icon-button" aria-label={`Remove tab ${tab.title || index + 1}`} disabled={saving || !editable(tab) || (tab.visibility === 'shared' && draft.filter(item => item.visibility === 'shared').length <= 1)} onClick={() => { if ((tab.entryCount || tab.content?.trim()) && !window.confirm(`Remove “${tab.title}” and its contents?`)) return; setDraft(current => current.filter(item => item.id !== tab.id)); }}><Trash2 size={15} /></button></div>
      </div>)}
    </div>
    <div className="profile-tabs-additions">{alternateAction && <button type="button" className="button secondary" disabled={saving} onClick={() => { if (!dirty || window.confirm('Discard unsaved tab changes?')) alternateAction.run(); }}>{alternateAction.label}</button>}{canManageShared && <button type="button" className="button secondary" disabled={saving || draft.filter(tab => tab.visibility === 'shared').length >= limit('shared')} onClick={() => add('shared')}><Plus size={14} />Add tab</button>}{canManagePrivate && <button type="button" className="button secondary" disabled={saving || count('private') >= limit('private')} onClick={() => add('private')}><Plus size={14} />PRIVATE TAB</button>}{canManageShared && missingDefaults.length > 0 && <select aria-label="Restore default tab" value="" disabled={saving || draft.filter(tab => tab.visibility === 'shared').length >= limit('shared')} onChange={event => { const template = missingDefaults.find(item => item.builtin === event.target.value); if (template) add('shared', template); }}><option value="">Restore default tab</option>{missingDefaults.map(template => <option key={template.builtin} value={template.builtin}>{template.title}</option>)}</select>}</div>
    {invalid && <span className="profile-tabs-instruction">Use a different name for each tab.</span>}
    <footer><button type="button" className="button secondary" disabled={saving} onClick={close}>Cancel</button><button type="submit" className="button primary" disabled={saving || invalid || !dirty}>{saving ? 'Saving…' : 'Save'}</button></footer>
  </form></Modal>;
}


export interface ProfileTabEditorNavigation {
  editorTabs?: readonly KnowledgeEditorTab[];
  editorTabId?: string;
  onSelectEditorTab?: (id: string) => void;
  onManageTabs?: () => void;
  initialEditing?: boolean;
}
function ProfileContentBlockView({ block }: { block: ProfileContentBlock }) {
  const [page, setPage] = useState(0);
  if (block.type === 'text') return <article className="knowledge-block">{block.id !== 'legacy-text' && <header className="knowledge-block-head"><h4>{block.title}</h4></header>}<p className="knowledge-prose">{block.text || '—'}</p></article>;
  const index = Math.min(page, Math.max(0, Math.ceil(block.rows.length / 50) - 1));
  return <article className="knowledge-block"><header className="knowledge-block-head"><h4>{block.title}</h4></header>
    <div className="knowledge-table-wrap" role="region" aria-label={block.title} tabIndex={0}>
      <table style={{ minWidth: block.columns.reduce((sum, column) => sum + (column.width ?? 160), 0) }}><colgroup>{block.columns.map(column => <col key={column.id} style={{ width: column.width ?? 160 }} />)}</colgroup>
        <thead><tr>{block.columns.map(column => <th key={column.id} scope="col">{column.name}</th>)}</tr></thead><tbody>{block.rows.slice(index * 50, index * 50 + 50).map(row => <tr key={row.id}>{row.cells.map((value, at) => <td key={block.columns[at].id} data-email-value={isEmailText(value) ? '' : undefined}>{value || '—'}</td>)}</tr>)}</tbody></table>
    </div>{block.rows.length > 50 && <div className="knowledge-pagination"><button type="button" disabled={!index} onClick={() => setPage(index - 1)}>Previous</button><span>{index * 50 + 1}–{Math.min(index * 50 + 50, block.rows.length)} / {block.rows.length}</span><button type="button" disabled={(index + 1) * 50 >= block.rows.length} onClick={() => setPage(index + 1)}>Next</button></div>}
  </article>;
}
export function ProfileTabContent({ tab, canEdit, onSave, onDirtyChange, initialEditing = false, ...navigation }: ProfileTabEditorNavigation & {
  tab: ProfileTabDescriptor; canEdit: boolean; onSave: (content: string) => Promise<void>; onDirtyChange?: (dirty: boolean) => void;
}) {
  const [editing, setEditing] = useState(initialEditing);
  const editable = useRef(canEdit); editable.current = canEdit;
  useEffect(() => { if (!canEdit) { setEditing(false); onDirtyChange?.(false); } }, [canEdit, onDirtyChange]);
  const content = decodeProfileTabContent(tab.content, tab.title);
  return <section className="profile-tab-content"><header><h3>{tab.title}</h3>{canEdit && !editing && <button type="button" className="button primary" onClick={() => setEditing(true)}>{tab.visibility === 'shared' ? 'CONTRIBUTE +1' : 'EDIT'}</button>}</header>
    {editing && canEdit ? <KnowledgeEditor embedded readOnlyNames target={{ kind: 'supplier', id: tab.id }} initial={profileTabDocument(tab)} initialSection={tab.id}
      {...navigation} onDirtyChange={onDirtyChange} saveLabel={tab.visibility === 'shared' ? 'CONTRIBUTE +1' : 'SAVE'}
      onCommit={async document => { if (!editable.current) throw new Error('Tab editing unavailable.'); await onSave(encodeProfileTabContent(document.sections[0].blocks)); }}
      onClose={() => setEditing(false)} /> : content.length ? content.map(block => <ProfileContentBlockView key={block.id} block={block} />) : <p>—</p>}
  </section>;
}
