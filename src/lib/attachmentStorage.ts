import { assertLiveDataWritable, isTestWorkspace } from './testWorkspaceGuard';
import { useTestWorkspace } from '../TestWorkspace';
import { useEffect, useSyncExternalStore } from 'react';
import type { AttachmentCatalog, AttachmentFolder, AttachmentItem, AttachmentScope } from './attachments';

function requireLocalAttachmentScope(scope?: AttachmentScope): void {
  if (scope?.target.kind === 'supplier') throw new Error('Supplier attachments require shared storage. Browser-only uploads are disabled.');
}

// The browser adapter stores original bytes separately from metadata. A future
// cloud adapter can keep the same stable references without persisting blob URLs.
const DATABASE = 'ecosystem.attachments.v1';
type Snapshot = AttachmentCatalog & { ready: boolean; error: string };
const emptyTestCatalog: Snapshot = { items: [], folders: [], ready: true, error: '' };
let snapshot: Snapshot = { items: [], folders: [], ready: false, error: '' };
const listeners = new Set<() => void>();
const publish = (value: Snapshot) => { snapshot = value; listeners.forEach(listener => listener()); };
let connection: Promise<IDBDatabase> | undefined, initialization: Promise<void> | undefined;
let channel: BroadcastChannel | undefined;
function database(): Promise<IDBDatabase> {
  connection ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => { for (const name of ['items', 'folders', 'blobs']) request.result.createObjectStore(name, { keyPath: 'id' }); };
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); connection = undefined; }; resolve(request.result); };
    request.onerror = () => { connection = undefined; reject(new Error('Attachments could not be opened in this browser.')); };
  });
  return connection;
}
async function readCatalog(): Promise<void> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['items', 'folders'], 'readonly');
    const items = transaction.objectStore('items').getAll(), folders = transaction.objectStore('folders').getAll();
    transaction.oncomplete = () => { publish({ items: items.result, folders: folders.result, ready: true, error: '' }); resolve(); };
    transaction.onerror = () => reject(new Error('Attachments could not be loaded.'));
  });
}
export function initializeAttachments(): Promise<void> {
  if (isTestWorkspace()) return Promise.resolve();
  initialization ??= readCatalog().then(() => {
    if (typeof BroadcastChannel !== 'undefined') { channel ??= new BroadcastChannel(DATABASE); channel.onmessage = () => { void readCatalog().catch(error => publish({ ...snapshot, error: error.message })); }; }
  }).catch(error => { initialization = undefined; publish({ ...snapshot, ready: true, error: error.message }); });
  return initialization;
}
export function useAttachmentCatalog(): Snapshot {
  const { dataMode } = useTestWorkspace();
  useEffect(() => { if (dataMode === 'live') void initializeAttachments(); }, [dataMode]);
  const current = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => snapshot);
  return dataMode === 'test' ? emptyTestCatalog : current;
}
async function write(stores: string[], action: (transaction: IDBTransaction) => void): Promise<void> {
  assertLiveDataWritable();
  const db = await database();
  assertLiveDataWritable();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(stores, 'readwrite');
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(new Error('Attachments could not be saved. Check available browser storage and try again.'));
    try { action(transaction); } catch (error) { transaction.abort(); reject(error); }
  });
  await readCatalog();
  channel?.postMessage('changed');
}
export async function addAttachmentItems(entries: { item: AttachmentItem; blob?: Blob }[]): Promise<void> {
  entries.forEach(({ item }) => requireLocalAttachmentScope(item.scope));
  await write(['items', 'blobs'], transaction => { for (const { item, blob } of entries) { transaction.objectStore('items').add(item); if (blob) transaction.objectStore('blobs').add({ id: item.id, blob }); } });
}
export async function saveAttachmentFolder(folder: AttachmentFolder): Promise<void> {
  requireLocalAttachmentScope(folder.scope);
  await write(['folders'], transaction => transaction.objectStore('folders').put(folder));
}
export async function updateAttachmentItem(item: AttachmentItem): Promise<void> {
  requireLocalAttachmentScope(item.scope);
  await write(['items'], transaction => transaction.objectStore('items').put(item));
}
export async function deleteAttachmentItem(id: string): Promise<void> {
  await write(['items', 'blobs'], transaction => { transaction.objectStore('items').delete(id); transaction.objectStore('blobs').delete(id); });
}
export async function attachmentBlob(id: string): Promise<Blob> {
  assertLiveDataWritable();
  const db = await database();
  assertLiveDataWritable();
  return new Promise((resolve, reject) => {
    const request = db.transaction('blobs', 'readonly').objectStore('blobs').get(id);
    request.onsuccess = () => request.result?.blob ? resolve(request.result.blob) : reject(new Error('The original file is unavailable in this browser.'));
    request.onerror = () => reject(new Error('The original file could not be opened.'));
  });
}
