import { useState } from 'react';
import { ArrowUpRight, FileText } from 'lucide-react';
import { AttachmentPreview } from './AttachmentBrowser';
import { useAttachmentCatalog, refreshAttachments } from './lib/attachmentStorage';
import { activeAttachmentCatalog, type AttachmentScope } from './lib/attachments';
import { Modal } from './ui';
import { useTestWorkspace } from './TestWorkspace';

export default function PortDocuments({ scopes, showEmpty = false, search = '' }: {
  scopes: AttachmentScope[]; showEmpty?: boolean; search?: string;
}) {
  const catalog = useAttachmentCatalog();
  const { dataMode } = useTestWorkspace();
  const [selectedId, setSelectedId] = useState<string>();
  if (dataMode === 'test') return null;

  const query = search.trim().toLowerCase();
  const items = activeAttachmentCatalog(catalog).items.filter(item =>
    scopes.some(({ target, section }) => item.scope.target.kind === target.kind && item.scope.target.id === target.id
      && (!section || item.scope.section?.id === section.id))
    && (!query || item.name.toLowerCase().includes(query)));
  const selected = items.find(item => item.id === selectedId);
  return <>
    {items.length ? <ul className="port-document-list">
      {items.map(item => <li key={item.id}><button type="button" aria-label={item.name} aria-haspopup="dialog" onClick={() => setSelectedId(item.id)}>
        <FileText size={15} aria-hidden="true" />
        <span data-preserve-case>{item.name}</span>
        {showEmpty && item.scope.section && <small>{item.scope.section.name}</small>}
        <ArrowUpRight size={14} aria-hidden="true" />
      </button></li>)}
    </ul> : showEmpty && !catalog.error && <p className="knowledge-empty" role="status">
      {catalog.ready ? 'NO UPLOADED DOCUMENTS.' : 'LOADING DOCUMENTS…'}
    </p>}
    {showEmpty && catalog.error && <div className="port-report-toolbar" role="alert">
      <span>{catalog.error}</span><button type="button" className="button secondary" onClick={() => void refreshAttachments()}>RETRY</button>
    </div>}
    {selected && <Modal title={selected.name} onClose={() => setSelectedId(undefined)} wide>
      <AttachmentPreview key={selected.id} item={selected} />
    </Modal>}
  </>;
}
