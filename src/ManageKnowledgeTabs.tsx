import { useRef, useState } from 'react';
import type { ProfileTab, ProfileTabCollection } from '../shared/profileTabs';
import { defaultKnowledgeSections, sameKnowledge, type KnowledgeChange, type KnowledgeDocument, type KnowledgeSection, type KnowledgeTarget } from './lib/knowledge';
import { useDemo } from './store';
import { useAccess } from './auth';
import { ManageProfileTabs, type ProfileTabDescriptor } from './ProfileTabs';
import type { PrivateProfileTabsController } from './PrivateProfileTabs';

export interface KnowledgeTabSource {
  target: KnowledgeTarget;
  document: KnowledgeDocument;
  sectionId: string;
}
export interface ManagedKnowledgeTab {
  id: string;
  title: string;
  sources: KnowledgeTabSource[];
  blockCount: number;
  role?: KnowledgeSection['role'];
}
type DraftTab = ProfileTabDescriptor & { sources: KnowledgeTabSource[]; role?: KnowledgeSection['role']; added?: boolean };
const sourceKey = (target: KnowledgeTarget) => `${target.kind}:${target.id}`;

/** One manager, with separate persistence for shared knowledge and owner-only tabs. */
export function ManageKnowledgeTabs({ tabs, primary, activeTabId, onSaved, onClose, privateTabs, countryPrivateTabs }: {
  tabs: ManagedKnowledgeTab[];
  primary: { target: KnowledgeTarget; document: KnowledgeDocument };
  activeTabId?: string;
  onSaved: (id: string) => void;
  onClose: () => void;
  privateTabs?: PrivateProfileTabsController;
  countryPrivateTabs?: PrivateProfileTabsController;
}) {
  const { run } = useDemo();
  const { realUser, preview } = useAccess();
  const [base] = useState(() => structuredClone({ tabs, primary }));
  const privateBase = useRef<ProfileTabCollection | null>(privateTabs?.data ? structuredClone(privateTabs.data) : null);
  const countryPrivateBase = useRef<ProfileTabCollection | null>(countryPrivateTabs?.data ? structuredClone(countryPrivateTabs.data) : null);
  const canManageShared = Boolean(realUser?.isActive && realUser.activated && !preview);
  const canManagePrivate = Boolean(privateTabs?.allowed && privateBase.current);
  const own = (tab: ManagedKnowledgeTab) => tab.sources.some(source => sourceKey(source.target) === sourceKey(primary.target));
  const [initial] = useState<DraftTab[]>(() => [
    ...(privateTabs?.tabs ?? []).map(tab => ({ ...tab, id: `private:${tab.id}`, sources: [], entryCount: tab.content?.trim() ? 1 : 0, reorderGroup: 'private' })),
    ...(countryPrivateTabs?.tabs ?? []).map(tab => ({ ...tab, id: `private-country:${tab.id}`, sources: [], entryCount: tab.content?.trim() ? 1 : 0, reorderGroup: 'private-country' })),
    ...tabs.map(tab => ({ ...tab, visibility: 'shared' as const, entryCount: tab.blockCount, builtin: tab.role, reorderGroup: own(tab) ? 'primary' : 'inherited' })),
  ]);
  const defaults = defaultKnowledgeSections(base.primary.target.kind).map(section => ({ title: section.title, builtin: section.role }));
  async function save(draft: DraftTab[]) {
    // Save only the private scope first. Retain its acknowledged revision if a shared save fails.
    const records: ProfileTab[] = draft.filter(tab => tab.visibility === 'private' && tab.id.startsWith('private:')).map(tab => ({
      id: tab.id.replace(/^private:/, ''), title: tab.title, visibility: 'private', content: tab.content ?? '',
    }));
    if (privateBase.current && JSON.stringify(records) !== JSON.stringify(privateBase.current.private.tabs)) {
      if (!canManagePrivate || !privateTabs) throw new Error('Private tabs unavailable.');
      const saved = await privateTabs.save(records, privateBase.current);
      if (!saved) throw new Error('Profile changed. Reopen Manage Tabs.');
      privateBase.current = saved;
    }
    const countryRecords: ProfileTab[] = draft.filter(tab => tab.visibility === 'private' && tab.id.startsWith('private-country:')).map(tab => ({
      id: tab.id.slice('private-country:'.length), title: tab.title, visibility: 'private', content: tab.content ?? '',
    }));
    if (countryPrivateBase.current && JSON.stringify(countryRecords) !== JSON.stringify(countryPrivateBase.current.private.tabs)) {
      if (!countryPrivateTabs?.allowed) throw new Error('Private tabs unavailable.');
      const saved = await countryPrivateTabs.save(countryRecords, countryPrivateBase.current);
      if (!saved) throw new Error('Profile changed. Reopen Manage Tabs.');
      countryPrivateBase.current = saved;
    }
    const documents = new Map<string, { target: KnowledgeTarget; document: KnowledgeDocument }>();
    documents.set(sourceKey(base.primary.target), base.primary);
    for (const tab of base.tabs) for (const source of tab.sources) documents.set(sourceKey(source.target), source);
    const changes: KnowledgeChange[] = [];
    for (const [key, source] of documents) {
      const sections: KnowledgeSection[] = [];
      for (const tab of draft.filter(item => item.visibility === 'shared')) {
        if (tab.added) {
          if (key === sourceKey(base.primary.target)) sections.push({ id: tab.id, title: tab.title.trim(), ...(tab.role ? { role: tab.role } : {}), blocks: [] });
          continue;
        }
        for (const owner of tab.sources) {
          if (sourceKey(owner.target) !== key) continue;
          const section = source.document.sections.find(item => item.id === owner.sectionId);
          if (section) sections.push({ ...structuredClone(section), title: tab.title.trim() });
        }
      }
      const document: KnowledgeDocument = { ...structuredClone(source.document), sections };
      if (!sameKnowledge(source.document, document)) changes.push({ target: source.target, baseVersion: source.document.version, baseDocument: source.document, document });
    }
    if (changes.length && (!canManageShared || !run({ type: 'manage-knowledge-tabs', changes }, 'Updated.'))) throw new Error('Shared tabs could not be saved. Your changes are still here.');
    const added = draft.find(tab => !initial.some(entry => entry.id === tab.id));
    onSaved(added?.id ?? draft.find(tab => tab.id === activeTabId)?.id ?? draft[0]?.id ?? '');
  }
  return <ManageProfileTabs tabs={initial} defaults={defaults} privateCreationGroup="private" maxTabs={{ shared: 57, private: 30 }} maxTitleLength={{ shared: 150, private: 80 }}
    canManageShared={canManageShared} canManagePrivate={canManagePrivate}
    createTab={entry => {
      if (entry.visibility === 'private') return { ...entry, id: `private:${entry.id}`, content: '', sources: [], reorderGroup: 'private' };
      const restored = entry.builtin ? initial.find(tab => tab.visibility === 'shared' && tab.builtin === entry.builtin) : undefined;
      return restored ?? { ...entry, role: entry.builtin as KnowledgeSection['role'], sources: [], added: true, reorderGroup: 'primary' };
    }} onSave={save} onClose={onClose} />;
}
