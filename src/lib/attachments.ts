import type { DemoState } from './model';
import { knowledgeDocument, knowledgeName, type KnowledgeReferences, type KnowledgeTarget } from './knowledge';
import { locationCountries, legacyLocationGroup } from './locations';
import { retiredSupplierIds, retiredSupplierTarget } from './supplierRetirement';

export type AttachmentTarget = KnowledgeTarget | { kind: 'credit'; id: string };
export interface AttachmentScope { target: AttachmentTarget; section?: { id: string; name: string } }
export interface AttachmentFolder { id: string; parentId: string | null; name: string; scope?: AttachmentScope; custom?: boolean; revision?: number; localOnly?: boolean }
export interface AttachmentItem {
  id: string; folderId: string; scope: AttachmentScope; name: string; type: 'file' | 'link';
  mime: string; size: number; createdAt: string; createdBy: string; url?: string;
  /** Existing request documents stay owned by the credit workflow. */
  legacy?: boolean;
  revision?: number;
  localOnly?: boolean;
}
export interface AttachmentCatalog { items: AttachmentItem[]; folders: AttachmentFolder[] }
export const attachmentFolderId = (scope: AttachmentScope) => `${scope.target.kind}:${encodeURIComponent(scope.target.id)}${scope.section ? `:section:${encodeURIComponent(scope.section.id)}` : ''}`;
export function attachmentLink(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('Enter a complete http or https link.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an http or https link without embedded credentials.');
  return url.href;
}
export function attachmentName(value: string): string {
  const name = value.trim();
  if (!name || name === '.' || name === '..' || name.length > 240 || /[\u0000-\u001f\u007f/\\]/.test(name)) throw new Error('Enter a name without slashes, up to 240 characters.');
  return name;
}
export function folderAncestors(folders: AttachmentFolder[], id: string): AttachmentFolder[] {
  const map = new Map(folders.map(folder => [folder.id, folder])), chain: AttachmentFolder[] = [], seen = new Set<string>();
  let folder = map.get(id);
  while (folder && !seen.has(folder.id)) { chain.unshift(folder); seen.add(folder.id); folder = folder.parentId ? map.get(folder.parentId) : undefined; }
  return chain;
}
export function insideFolder(folders: AttachmentFolder[], child: string, parent: string): boolean {
  return folderAncestors(folders, child).some(folder => folder.id === parent);
}
/** Hide retired targets and descendants without deleting recoverable browser-stored files. */
export function activeAttachmentCatalog(catalog: AttachmentCatalog): AttachmentCatalog {
  const roots = [...retiredSupplierIds].map(id => attachmentFolderId({ target: { kind: 'supplier', id } }));
  const retiredPath = (id: string) => roots.some(root => id === root || id.startsWith(`${root}:section:`));
  const hidden = new Set(catalog.folders.filter(folder => retiredSupplierTarget(folder.scope?.target) || retiredPath(folder.id) || Boolean(folder.parentId && retiredPath(folder.parentId))).map(folder => folder.id));
  let changed = true;
  while (changed) { changed = false; for (const folder of catalog.folders) if (folder.parentId && hidden.has(folder.parentId) && !hidden.has(folder.id)) { hidden.add(folder.id); changed = true; } }
  return { folders: catalog.folders.filter(folder => !hidden.has(folder.id)), items: catalog.items.filter(item => !retiredSupplierTarget(item.scope.target) && !retiredPath(item.folderId) && !hidden.has(item.folderId)) };
}
export function buildAttachmentFolders(state: DemoState, catalog: AttachmentCatalog, current?: AttachmentScope, references: KnowledgeReferences = {}): AttachmentFolder[] {
  catalog = activeAttachmentCatalog(catalog);
  const folders: AttachmentFolder[] = [
    { id: 'home', parentId: null, name: 'Home' },
    { id: 'locations', parentId: 'home', name: 'Countries & Ports' },
    { id: 'buyers', parentId: 'home', name: 'Buyers' },
    { id: 'credit', parentId: 'home', name: 'Credit' },
    { id: 'suppliers', parentId: 'home', name: 'Suppliers' },
  ];
  const add = (folder: AttachmentFolder) => {
    if (folders.some(item => item.id === folder.id)) return;
    if (folder.scope?.target.kind === 'area') {
      const group = legacyLocationGroup(state, folder.scope.target.id);
      const country = group && locationCountries(state).find(item => item.name === group.country);
      // Stable folder IDs preserve file references; new writes use a current country scope.
      folder = { ...folder, scope: country ? { ...folder.scope, target: { kind: 'country', id: country.id } } : undefined };
    }
    folders.push(folder);
  };
  for (const country of locationCountries(state)) add({ id: attachmentFolderId({ target: { kind: 'country', id: country.id } }), parentId: 'locations', name: country.name, scope: { target: { kind: 'country', id: country.id } } });
  for (const group of state.legacyLocationAreas ?? []) {
    const id = attachmentFolderId({ target: { kind: 'area', id: group.id } });
    const used = catalog.items.some(item => item.scope.target.kind === 'area' && item.scope.target.id === group.id || item.folderId === id || item.folderId.startsWith(`${id}:section:`))
      || catalog.folders.some(folder => folder.id === id || folder.parentId === id || folder.scope?.target.kind === 'area' && folder.scope.target.id === group.id)
      || current?.target.kind === 'area' && current.target.id === group.id;
    if (!used) continue;
    const country = locationCountries(state).find(item => item.name === group.country);
    add({ id, parentId: country ? attachmentFolderId({ target: { kind: 'country', id: country.id } }) : 'locations', name: group.name, custom: true,
      scope: country ? { target: { kind: 'country', id: country.id } } : undefined });
  }
  for (const port of state.ports) {
    const countryName = port.id === 'port-hong-kong' ? 'Hong Kong' : port.country;
    const country = locationCountries(state).find(item => item.name === countryName);
    add({ id: attachmentFolderId({ target: { kind: 'port', id: port.id } }), parentId: attachmentFolderId({ target: { kind: 'country', id: country?.id ?? countryName } }), name: `${port.name} (Port)`, scope: { target: { kind: 'port', id: port.id } } });
  }
  for (const buyer of state.companies) for (const kind of ['company', 'credit'] as const) add({ id: attachmentFolderId({ target: { kind, id: buyer.id } }), parentId: kind === 'company' ? 'buyers' : 'credit', name: buyer.name, scope: { target: { kind, id: buyer.id } } });
  for (const supplier of references.suppliers ?? []) add({ id: attachmentFolderId({ target: { kind: 'supplier', id: supplier.id } }), parentId: 'suppliers', name: supplier.name, scope: { target: { kind: 'supplier', id: supplier.id } } });
  const scopes = [...catalog.items.map(item => item.scope), ...catalog.folders.flatMap(folder => folder.scope ? [folder.scope] : []), ...(current ? [current] : [])];
  for (const scope of scopes) {
    if (retiredSupplierTarget(scope.target)) continue;
    const base = attachmentFolderId({ target: scope.target });
    if (!folders.some(folder => folder.id === base)) continue; // Deleted records do not leak into another record's folder.
    if (scope.section) {
      const block = scope.target.kind !== 'credit' ? knowledgeDocument(state, scope.target, references).sections.flatMap(section => section.blocks).find(block => block.id === scope.section!.id) : undefined;
      add({ id: attachmentFolderId(scope), parentId: base, name: block?.title || scope.section.name, scope });
    }
  }
  for (const folder of catalog.folders) add(folder);
  return folders;
}
export function legacyAttachmentItems(state: DemoState): AttachmentItem[] {
  const result: AttachmentItem[] = [];
  for (const buyer of state.companies) for (const file of buyer.files ?? []) {
    if (!/^(https?:\/\/|\/demo\/)/i.test(file.url)) continue;
    const scope: AttachmentScope = { target: { kind: 'company', id: buyer.id } };
    result.push({ id: `buyer-file:${buyer.id}:${file.id}`, folderId: attachmentFolderId(scope), scope, name: file.title, type: 'link', mime: '', size: 0, createdAt: '', createdBy: '', url: file.url, legacy: true });
  }
  for (const request of state.requests) for (const file of request.attachments ?? []) {
    const scope: AttachmentScope = { target: { kind: 'credit', id: request.companyId }, section: { id: request.id, name: request.requestNumber ?? request.id } };
    result.push({ id: `credit-file:${request.id}:${file.id}`, folderId: attachmentFolderId(scope), scope, name: file.name, type: 'file', mime: file.mimeType, size: file.size, createdAt: request.requestedAt, createdBy: request.requestedBy, url: file.dataUrl, legacy: true });
  }
  return result;
}
export function scopeLabel(state: DemoState, scope: AttachmentScope, references: KnowledgeReferences = {}): string {
  return scope.section?.name ?? (scope.target.kind === 'credit' ? state.companies.find(buyer => buyer.id === scope.target.id)?.name ?? 'Credit' : scope.target.kind === 'supplier' ? references.suppliers?.find(item => item.id === scope.target.id)?.name ?? 'Supplier' : knowledgeName(state, scope.target));
}
