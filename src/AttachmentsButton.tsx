import { useIntelligence } from './Intelligence';
import { useTestWorkspace } from './TestWorkspace';
import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Paperclip } from 'lucide-react';
import { useDemo } from './store';
import { useAttachmentCatalog } from './lib/attachmentStorage';
import { activeAttachmentCatalog, legacyAttachmentItems, scopeLabel, type AttachmentScope } from './lib/attachments';
import './attachments.css';

import AttachmentBrowser from './AttachmentBrowser';
export default function AttachmentsButton({ scope }: { scope: AttachmentScope }) {
  const { dataMode } = useTestWorkspace();
  const { state } = useDemo();
  const { snapshot } = useIntelligence();
  const catalog = useAttachmentCatalog();
  const [opened, setOpened] = useState(false);
  const legacy = useMemo(() => legacyAttachmentItems(state), [state.companies, state.requests]);
  const visibleItems = useMemo(() => activeAttachmentCatalog({ items: [...catalog.items, ...legacy], folders: catalog.folders }).items, [catalog.items, catalog.folders, legacy]);
  const count = visibleItems.filter(item => {
    const target = scope.target;
    const matches = item.scope.target.kind === target.kind && (!target.id || item.scope.target.id === target.id);
    return matches && (!scope.section || item.scope.section?.id === scope.section.id);
  }).length;
  if (dataMode === 'test') return null;
  return <span className="attachments-control" onDoubleClick={event => event.stopPropagation()}>
    <button type="button" className="attachments-trigger" aria-label={`Attachments${count ? ` (${count})` : ''} for ${scopeLabel(state, scope, { suppliers: snapshot?.suppliers })}`} aria-haspopup="dialog" onClick={event => { event.stopPropagation(); setOpened(true); }}>
      <Paperclip size={13} aria-hidden="true" />Attachments{count ? ` (${count})` : ''}
    </button>
    {opened && createPortal(<AttachmentBrowser scope={scope} onClose={() => setOpened(false)} />, document.getElementById('root')!)}
  </span>;
}
