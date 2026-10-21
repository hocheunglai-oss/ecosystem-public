import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, ChevronDown, ChevronRight, Download, ExternalLink, File, FileText, Folder, FolderPlus, Home, Image, LayoutGrid, Link, List, Paperclip, Pencil, Search, Trash2, Upload, X } from 'lucide-react';
import { useDemo } from './store';
import { useIntelligence } from './Intelligence';
import { actors, uid } from './lib/model';
import { activeAttachmentCatalog, attachmentFolderId, attachmentLink, attachmentName, buildAttachmentFolders, folderAncestors, insideFolder, legacyAttachmentItems, type AttachmentFolder, type AttachmentItem, type AttachmentScope } from './lib/attachments';
import { addAttachmentItems, attachmentBlob, deleteAttachmentItem, saveAttachmentFolder, updateAttachmentItem, useAttachmentCatalog } from './lib/attachmentStorage';
import { date, Modal } from './ui';

const sizeText = (size: number) => size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.ceil(size / 1024))} KB`;
const fileKind = (item: AttachmentItem) => item.type === 'link' ? 'Link' : item.name.includes('.') ? item.name.split('.').pop()!.toUpperCase() : 'File';
function ItemIcon({ item }: { item: AttachmentItem }) { const Icon = item.type === 'link' ? Link : /^image\/(png|jpeg|webp|gif|avif)$/.test(item.mime) ? Image : /^(pdf|txt|docx?|xlsx?|csv)$/i.test(fileKind(item)) ? FileText : File; return <Icon aria-hidden="true" size={24} />; }
const rootId = (scope: AttachmentScope) => scope.target.kind === 'credit' && !scope.target.id ? 'credit' : attachmentFolderId(scope);

export default function AttachmentBrowser({ scope, onClose }: { scope: AttachmentScope; onClose: () => void }) {
  const { state, actor } = useDemo();
  const { snapshot: intelligence, loading: intelligenceLoading } = useIntelligence();
  const references = useMemo(() => ({ suppliers: intelligence?.suppliers }), [intelligence]);
  const catalog = useAttachmentCatalog();
  const activeCatalog = useMemo(() => activeAttachmentCatalog({ items: [...catalog.items, ...legacyAttachmentItems(state)], folders: catalog.folders }), [catalog.items, catalog.folders, state.companies, state.requests]);
  const items = activeCatalog.items;
  const folders = useMemo(() => buildAttachmentFolders(state, activeCatalog, scope, references), [state, activeCatalog, scope, references]);
  const initial = rootId(scope);
  const [history, setHistory] = useState({ paths: [initial], index: 0 });
  const folderId = folders.some(folder => folder.id === history.paths[history.index]) ? history.paths[history.index] : 'home';
  const current = folders.find(folder => folder.id === folderId)!;
  const ancestors = folderAncestors(folders, folderId);
  const [expanded, setExpanded] = useState(() => new Set(folderAncestors(folders, initial).map(folder => folder.id)));
  const [view, setView] = useState<'grid' | 'list'>('list');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string>();
  const selected = items.find(item => item.id === selectedId);
  const [form, setForm] = useState<'folder' | 'link' | 'rename' | 'move' | 'delete' | null>(null);
  const [name, setName] = useState(''), [url, setUrl] = useState('');
  const [destination, setDestination] = useState(folderId);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('');
  const [dropTarget, setDropTarget] = useState<string>();
  const [dropKind, setDropKind] = useState<'upload' | 'move'>('upload');
  const input = useRef<HTMLInputElement>(null);
  const selectedFolder = useRef<HTMLButtonElement>(null);
  useEffect(() => { selectedFolder.current?.scrollIntoView({ block: 'nearest' }); }, [folderId, expanded]);
  const ready = catalog.ready && !catalog.error;
  const supplierFolder = current.scope?.target.kind === 'supplier';
  const canUpload = ready && !!current.scope && !supplierFolder && !busy;
  const childFolders = folders.filter(folder => folder.parentId === folderId).sort((a, b) => a.name.localeCompare(b.name));
  const matching = items.filter(item => query.trim() ? [item.name, ...folderAncestors(folders, item.folderId).map(folder => folder.name)].join(' ').toLowerCase().includes(query.trim().toLowerCase()) : item.folderId === folderId).sort((a, b) => a.name.localeCompare(b.name));
  const editable = selected && !selected.legacy && selected.scope.target.kind !== 'supplier';
  const breadcrumb = (id: string) => folderAncestors(folders, id).map(folder => folder.name).join(' / ');
  const openFolder = (id: string) => {
    setHistory(value => ({ paths: [...value.paths.slice(0, value.index + 1), id], index: value.index + 1 }));
    setExpanded(value => new Set([...value, ...folderAncestors(folders, id).map(folder => folder.id)]));
    setQuery(''); setSelectedId(undefined); setForm(null); setError('');
  };
  async function perform(action: () => Promise<void>, message: string) {
    setBusy(true); setError(''); setStatus('');
    try { await action(); setForm(null); setStatus(message); } catch (error) { setError(error instanceof Error ? error.message : 'Attachments could not be saved.'); } finally { setBusy(false); }
  }
  async function upload(files: File[], destinationId = folderId) {
    const folder = folders.find(item => item.id === destinationId);
    if (!files.length || !folder?.scope || busy || !ready) return;
    await perform(async () => {
      if (files.some(file => file.size > 100 * 1024 * 1024)) throw new Error('Each file must be 100 MB or smaller in this demo.');
      const names = new Set(items.filter(item => item.folderId === destinationId).map(item => item.name.toLowerCase()));
      const entries = files.map(file => {
        const original = attachmentName(file.name);
        let name = original, number = 2;
        const dot = original.lastIndexOf('.'), base = dot > 0 ? original.slice(0, dot) : original, extension = dot > 0 ? original.slice(dot) : '';
        while (names.has(name.toLowerCase())) name = `${base} (${number++})${extension}`;
        names.add(name.toLowerCase());
        return { item: { id: uid('attachment'), folderId: destinationId, scope: folder.scope!, name, type: 'file' as const, mime: file.type || 'application/octet-stream', size: file.size, createdAt: new Date().toISOString(), createdBy: actor.id }, blob: file };
      });
      await addAttachmentItems(entries);
    }, `${files.length} file${files.length === 1 ? '' : 's'} saved in this browser.`);
  }
  const begin = (value: NonNullable<typeof form>) => { setForm(value); setName(value === 'rename' ? selected?.name ?? '' : ''); setUrl(''); setDestination(folderId); setError(''); };
  function dragOver(event: DragEvent, id: string) {
    if (!ready || busy || !folders.find(folder => folder.id === id)?.scope || folders.find(folder => folder.id === id)?.scope?.target.kind === 'supplier') return;
    if (!event.dataTransfer.types.includes('Files') && !event.dataTransfer.types.includes('application/x-eco-attachment')) return;
    event.preventDefault(); event.stopPropagation(); const uploading = event.dataTransfer.types.includes('Files'); event.dataTransfer.dropEffect = uploading ? 'copy' : 'move'; setDropKind(uploading ? 'upload' : 'move'); setDropTarget(id);
  }
  async function drop(event: DragEvent, id: string) {
    event.preventDefault(); event.stopPropagation(); setDropTarget(undefined);
    if (event.dataTransfer.files.length) { await upload(Array.from(event.dataTransfer.files), id); return; }
    const file = items.find(item => item.id === event.dataTransfer.getData('application/x-eco-attachment'));
    const folder = folders.find(item => item.id === id);
    if (!file || file.legacy || !folder?.scope || busy || !ready || file.folderId === id) return;
    await perform(() => updateAttachmentItem({ ...file, folderId: id, scope: folder.scope! }), `Moved to ${breadcrumb(id)}.`);
  }
  const dropProps = (id: string) => ({ onDragOver: (event: DragEvent) => dragOver(event, id), onDrop: (event: DragEvent) => { void drop(event, id); }, 'data-drop-target': dropTarget === id ? '' : undefined });
  function tree(folder: AttachmentFolder, depth = 0): ReactNode {
    const children = folders.filter(item => item.parentId === folder.id).sort((a, b) => a.name.localeCompare(b.name));
    const open = expanded.has(folder.id);
    return <li key={folder.id}><div className="attachment-tree-row" style={{ paddingLeft: 8 + depth * 14 }} {...dropProps(folder.id)}>
      {children.length ? <button type="button" className="attachment-tree-toggle" aria-label={`${open ? 'Collapse' : 'Expand'} ${folder.name}`} aria-expanded={open} onClick={() => setExpanded(value => { const next = new Set(value); if (open) next.delete(folder.id); else next.add(folder.id); return next; })}>{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button> : <span className="attachment-tree-spacer" />}
      <button ref={folder.id === folderId ? selectedFolder : undefined} type="button" className="attachment-tree-folder" aria-current={folder.id === folderId ? 'location' : undefined} onClick={() => openFolder(folder.id)}>{folder.id === 'home' ? <Home size={15} /> : <Folder size={15} />}<span>{folder.name}</span></button>
    </div>{open && children.length > 0 && <ul>{children.map(child => tree(child, depth + 1))}</ul>}</li>;
  }
  return <Modal title="Attachments" onClose={onClose} wide>
    <div className="attachment-browser" onDoubleClick={event => event.stopPropagation()} onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropTarget(undefined); }} onDragEnd={() => setDropTarget(undefined)}
      onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); setDropTarget(undefined); }}
      onDrop={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDropTarget(undefined); setError('Open a record or section folder before uploading.'); } }}>
      <div className="attachment-toolbar">
        <div className="attachment-history"><button type="button" className="icon-button" aria-label="Back" disabled={!history.index || busy} onClick={() => { setHistory(value => ({ ...value, index: value.index - 1 })); setSelectedId(undefined); setQuery(''); setForm(null); }}><ArrowLeft size={16} /></button><button type="button" className="icon-button" aria-label="Forward" disabled={history.index >= history.paths.length - 1 || busy} onClick={() => { setHistory(value => ({ ...value, index: value.index + 1 })); setSelectedId(undefined); setQuery(''); setForm(null); }}><ArrowRight size={16} /></button></div>
        <label className="attachment-search"><Search size={15} /><input type="search" aria-label="Search attachments" placeholder="Search attachments" value={query} onChange={event => { setQuery(event.target.value); setSelectedId(undefined); setForm(null); }} /></label>
        <div className="attachment-view"><button type="button" className="icon-button" aria-label="List view" aria-pressed={view === 'list'} onClick={() => setView('list')}><List size={17} /></button><button type="button" className="icon-button" aria-label="Grid view" aria-pressed={view === 'grid'} onClick={() => setView('grid')}><LayoutGrid size={17} /></button></div>
      </div>
      <nav className="attachment-breadcrumb" aria-label="Attachment path">{ancestors.map((folder, index) => <span key={folder.id}>{index > 0 && <ChevronRight size={12} />}<button type="button" onClick={() => openFolder(folder.id)} aria-current={folder.id === folderId ? 'location' : undefined}>{folder.name}</button></span>)}</nav>
      <div className="attachment-layout">
        <nav className="attachment-sidebar" aria-label="Attachment folders"><ul>{tree(folders[0])}</ul></nav>
        <main className="attachment-main" {...dropProps(folderId)}>
          <header className="attachment-folder-header"><h3>{query ? 'Search attachments' : current.name}</h3><div className="attachment-actions"><button type="button" className="button secondary small" disabled={!canUpload} onClick={() => input.current?.click()}><Upload size={14} />Upload files</button><button type="button" className="button secondary small" disabled={!canUpload} onClick={() => begin('link')}><Link size={14} />Add link</button><button type="button" className="button secondary small" disabled={!canUpload} onClick={() => begin('folder')}><FolderPlus size={14} />New folder</button></div></header>
          <input ref={input} className="attachment-file-input" type="file" multiple aria-label="Upload attachments" disabled={!canUpload} onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; void upload(files); }} />
          {dropTarget && <div className="attachment-drop-indicator" role="status">{dropKind === 'move' ? `Move ${selected?.name ?? 'attachment'}` : 'Upload files'} to {breadcrumb(dropTarget)} · A–Z</div>}
          {(current.id === "suppliers" || scope.target.kind === "supplier") && !intelligence && <p className="attachment-error" role="status">{intelligenceLoading ? "Loading supplier data…" : "Supplier data unavailable"}</p>}
          {supplierFolder && <p className="attachment-error" role="status">Supplier attachments require shared storage. Browser-only uploads are disabled.</p>}
          {(error || catalog.error) && <p className="attachment-error" role="alert">{error || catalog.error}</p>}
          {form && <form className="attachment-form" onSubmit={event => { event.preventDefault(); void perform(async () => {
            if (form === 'folder' && current.scope) { const validName = attachmentName(name); if (childFolders.some(folder => folder.name.toLowerCase() === validName.toLowerCase())) throw new Error('A folder with this name already exists.'); await saveAttachmentFolder({ id: uid('folder'), parentId: folderId, name: validName, scope: current.scope, custom: true }); }
            else if (form === 'link' && current.scope) await addAttachmentItems([{ item: { id: uid('attachment'), folderId, scope: current.scope, name: attachmentName(name), type: 'link', url: attachmentLink(url), mime: '', size: 0, createdAt: new Date().toISOString(), createdBy: actor.id } }]);
            else if (form === 'rename' && editable) await updateAttachmentItem({ ...selected, name: attachmentName(name) });
            else if (form === 'move' && editable) { const folder = folders.find(folder => folder.id === destination); if (!folder?.scope) throw new Error('Choose a record or section folder.'); await updateAttachmentItem({ ...selected, folderId: destination, scope: folder.scope }); setSelectedId(undefined); }
            else if (form === 'delete' && editable) { await deleteAttachmentItem(selected.id); setSelectedId(undefined); }
          }, form === 'delete' ? 'Attachment deleted from this browser.' : 'Saved in this browser.'); }}>
            <h4>{({ folder: 'New folder', link: 'Add link', rename: 'Rename attachment', move: 'Move attachment', delete: 'Delete attachment' })[form]}</h4>
            {['folder', 'link', 'rename'].includes(form) && <label>Name<input autoFocus data-preserve-case required value={name} onChange={event => setName(event.target.value)} maxLength={240} /></label>}
            {form === 'link' && <label>URL<input data-preserve-case required type="url" value={url} onChange={event => setUrl(event.target.value)} /></label>}
            {form === 'move' && <label>Destination<select aria-label="Move destination" value={destination} onChange={event => setDestination(event.target.value)}>{folders.filter(folder => folder.scope && folder.scope.target.kind !== 'supplier').map(folder => <option key={folder.id} value={folder.id}>{breadcrumb(folder.id)}</option>)}</select></label>}
            {form === 'delete' && <p>Delete {selected?.name}?</p>}
            <div className="attachment-actions"><button type="button" className="button secondary small" disabled={busy} onClick={() => setForm(null)}>Cancel</button><button type="submit" className={`button ${form === 'delete' ? 'danger' : 'primary'} small`} disabled={busy}>{form === 'delete' ? 'Delete' : form === 'move' ? 'Move' : 'Save'}</button></div>
          </form>}
          <div className={`attachment-files attachment-files--${view}`} aria-label="Folder contents" aria-busy={busy || !catalog.ready}>
            {!query && childFolders.map(folder => <button type="button" className="attachment-folder-tile" key={folder.id} onClick={() => openFolder(folder.id)} {...dropProps(folder.id)}><Folder size={view === 'grid' ? 42 : 23} /><span>{folder.name}</span><small>{items.filter(item => insideFolder(folders, item.folderId, folder.id)).length} attachments</small><ChevronRight size={14} /></button>)}
            {matching.map(item => <button type="button" className="attachment-file-tile" key={item.id} aria-pressed={selectedId === item.id} draggable={!item.legacy && item.scope.target.kind !== 'supplier' && !busy} onDragStart={event => { event.dataTransfer.setData('application/x-eco-attachment', item.id); event.dataTransfer.effectAllowed = 'move'; setSelectedId(item.id); }} onClick={() => { setSelectedId(item.id); setForm(null); }}><ItemIcon item={item} /><span>{item.name}<small>{query ? breadcrumb(item.folderId) : item.createdAt ? date(item.createdAt) : 'Existing document'}</small></span><small>{fileKind(item)}{item.type === 'file' ? ` · ${sizeText(item.size)}` : ''}</small></button>)}
            {catalog.ready && !matching.length && (query || !childFolders.length) && <div className="attachment-empty"><Paperclip size={28} /><p>{query ? 'No matching attachments.' : 'No attachments.'}</p></div>}
          </div>
        </main>
        {selected && <aside className="attachment-inspector" aria-label="Attachment details"><header><h3>{selected.name}</h3><button type="button" className="icon-button" aria-label="Close attachment details" onClick={() => setSelectedId(undefined)}><X size={16} /></button></header><AttachmentPreview key={selected.id} item={selected} />
          <dl><div><dt>Location</dt><dd>{breadcrumb(selected.folderId)}</dd></div><div><dt>Type</dt><dd>{fileKind(selected)}</dd></div>{selected.type === 'file' && <div><dt>Size</dt><dd>{sizeText(selected.size)}</dd></div>}{selected.createdBy && <div><dt>Added by</dt><dd>{actors.find(actor => actor.id === selected.createdBy)?.name ?? selected.createdBy}</dd></div>}{selected.createdAt && <div><dt>Date</dt><dd>{date(selected.createdAt)}</dd></div>}</dl>
          {editable && <div className="attachment-detail-actions"><button type="button" className="button secondary small" disabled={busy} onClick={() => begin('rename')}><Pencil size={13} />Rename</button><button type="button" className="button secondary small" disabled={busy} onClick={() => begin('move')}><Folder size={13} />Move</button><button type="button" className="button secondary small" disabled={busy} onClick={() => begin('delete')}><Trash2 size={13} />Delete</button></div>}
        </aside>}
      </div>
      <footer className="attachment-footer"><span role="status" aria-live="polite">{busy ? 'Saving…' : status || `${matching.length} attachment${matching.length === 1 ? '' : 's'}`}</span><span>Stored in this browser</span></footer>
    </div>
  </Modal>;
}

function AttachmentPreview({ item }: { item: AttachmentItem }) {
  const [resource, setResource] = useState<{ url: string; text?: string }>(), [error, setError] = useState('');
  useEffect(() => {
    if (item.type === 'link') return;
    let active = true, objectUrl: string | undefined;
    void (async () => {
      try {
        let blob: Blob;
        if (item.legacy && item.url?.startsWith('data:')) { const [head, bytes] = item.url.split(','); if (!head.endsWith(';base64') || !bytes) throw new Error('The original file is unavailable.'); blob = new Blob([Uint8Array.from(atob(bytes), char => char.charCodeAt(0))], { type: item.mime }); }
        else blob = await attachmentBlob(item.id);
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        const text = /^(text\/(plain|csv)|application\/json)$/.test(item.mime) && blob.size <= 1024 * 1024 ? await blob.text() : undefined;
        if (active) setResource({ url: objectUrl, text });
      } catch (error) { if (active) setError(error instanceof Error ? error.message : 'The original file could not be opened.'); }
    })();
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [item.id, item.type, item.mime, item.legacy, item.url]);
  if (item.type === 'link') return <div className="attachment-link-preview"><Link size={28} /><p data-preserve-case>{item.url}</p><a className="button secondary small" href={item.url} target="_blank" rel="noopener noreferrer">Open link<ExternalLink size={13} /></a></div>;
  return <div className="attachment-preview">{error ? <p role="alert">{error}</p> : !resource ? <p role="status">Loading file…</p> : <>
    {/^image\/(png|jpeg|gif|webp|avif)$/.test(item.mime) ? <img src={resource.url} alt={item.name} /> : /^(audio|video)\//.test(item.mime) ? item.mime.startsWith('audio/') ? <audio controls src={resource.url} /> : <video controls src={resource.url} /> : resource.text !== undefined ? <pre data-preserve-case>{resource.text}</pre> : <div className="attachment-no-preview"><ItemIcon item={item} /><p>Preview unavailable. Download to open.</p></div>}
    <a className="button secondary small" href={resource.url} download={item.name}><Download size={14} />Download</a>
  </>}</div>;
}
