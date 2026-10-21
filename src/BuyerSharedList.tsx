import { useEffect, useState, type ReactNode } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { actors, uid } from './lib/model';
import { buyerSharedDraft, sameBuyerSharedDraft, type BuyerSharedDraftEntry, type BuyerSharedEntry, type BuyerSharedListKind } from './lib/buyerSharedLists';
import { useDemo } from './store';
import { normalizedBuyerCompetition } from './lib/buyerCompetition';
import { date } from './ui';
import KnowledgeUpdateButton from './KnowledgeUpdateButton';
import './buyer-competition.css';

export default function BuyerSharedList({ buyerId, kind, label, entries, canEdit = true, headingIcon, editing, onEditingChange }: {
  buyerId: string; kind: BuyerSharedListKind | 'private'; headingIcon?: ReactNode; label: string; entries: BuyerSharedEntry[]; canEdit?: boolean;
  editing?: boolean; onEditingChange?: (editing: boolean) => void;
}) {
  const { run } = useDemo();
  const [draft, setDraft] = useState<BuyerSharedDraftEntry[] | null>(null);
  const [base, setBase] = useState<BuyerSharedDraftEntry[]>([]);
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(entries.length / 25)), currentPage = Math.min(page, pages - 1);
  const valid = draft !== null && draft.every(entry => entry.text.trim()) && !sameBuyerSharedDraft(base, draft) && JSON.stringify(base.map(entry => normalizedBuyerCompetition(entry.text))) !== JSON.stringify(draft.map(entry => normalizedBuyerCompetition(entry.text)));
  const start = () => { const snapshot = buyerSharedDraft(entries); setBase(snapshot); setDraft(snapshot.length ? snapshot : [{ id: uid('entry'), text: '' }]); };
  useEffect(() => { if (editing && canEdit) start(); else if (editing === false || !canEdit) setDraft(null); }, [editing, canEdit]);
  const close = () => { setDraft(null); onEditingChange?.(false); };
  return <>
    <header className="buyer-shared-list-heading">
      {kind !== 'competition' && <h4>{headingIcon}{label}</h4>}
      {canEdit && editing === undefined && draft === null && <KnowledgeUpdateButton contribution={kind !== 'private'} aria-label={`Edit ${label}`} onClick={start} />}
    </header>
    {draft !== null ? <form className="buyer-competition__form" onSubmit={event => {
      event.preventDefault();
      if (run(kind === 'private' ? { type: 'save-buyer-private-list', buyerId, entries: draft, baseEntries: base } : { type: 'save-buyer-shared-list', kind, buyerId, entries: draft, baseEntries: base }, `${label} updated.`)) { close(); setPage(0); }
    }}>
      {draft.map((entry, index) => <div className="buyer-shared-list-row" key={entry.id}>
        <textarea aria-label={`${label} ${index + 1}`} autoFocus={editing === undefined && index === 0} value={entry.text} maxLength={10000} rows={kind === 'competition' ? 1 : 3} required onChange={event => setDraft(draft.map(item => item.id === entry.id ? { ...item, text: event.target.value } : item))} />
        <button className="icon-button" type="button" aria-label={`Remove ${label} ${index + 1}`} onClick={() => setDraft(draft.filter(item => item.id !== entry.id))}><Trash2 size={14} /></button>
      </div>)}
      <button type="button" className="button secondary" disabled={draft.length >= 100} onClick={() => setDraft([...draft, { id: uid('entry'), text: '' }])}><Plus size={13} />Add</button>
      <div className="buyer-profile__form-actions"><button type="button" className="button secondary" onClick={close}>Cancel</button><KnowledgeUpdateButton type="submit" contribution={kind !== 'private'} disabled={!valid} /></div>
    </form> : entries.length ? <div className="buyer-competition__entries">
      {entries.slice(currentPage * 25, (currentPage + 1) * 25).map(entry => <article className="buyer-competition-entry" key={entry.id}>
        <p>{entry.text}</p><footer>{actors.find(person => person.id === (entry.updatedBy ?? entry.author))?.name || entry.updatedBy || entry.author} · <time dateTime={entry.updatedAt ?? entry.createdAt}>{date(entry.updatedAt ?? entry.createdAt)}</time></footer>
      </article>)}
    </div> : <p className="buyer-profile__empty">—</p>}
    {draft === null && pages > 1 && <footer className="buyer-table-footer"><span>{entries.length} entries</span><div className="buyer-profile__pages"><button type="button" aria-label={`Previous ${label} page`} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>‹</button><span>{currentPage + 1} / {pages}</span><button type="button" aria-label={`Next ${label} page`} disabled={currentPage === pages - 1} onClick={() => setPage(currentPage + 1)}>›</button></div></footer>}
  </>;
}
