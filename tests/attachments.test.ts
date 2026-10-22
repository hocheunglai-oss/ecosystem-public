import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSeedState } from '../src/lib/seed';
import { attachmentFolderId, attachmentLink, attachmentName, attachmentSupplierReferences, buildAttachmentFolders, folderAncestors, insideFolder, legacyAttachmentItems, type AttachmentScope } from '../src/lib/attachments';

test('Country and port identities stay separate when both are named Singapore', () => {
  const state = createSeedState();
  const country: AttachmentScope = { target: { kind: 'country', id: 'Singapore' } }, port: AttachmentScope = { target: { kind: 'port', id: 'port-singapore' }, section: { id: 'evidence', name: 'Debunkering' } };
  const folders = buildAttachmentFolders(state, { items: [], folders: [] }, port);
  assert.notEqual(attachmentFolderId(country), attachmentFolderId({ target: port.target }));
  assert.deepEqual(folderAncestors(folders, attachmentFolderId(port)).map(folder => folder.name), ['Home', 'Countries & Ports', 'Singapore', 'Singapore (Port)', 'Debunkering']);
  assert.equal(insideFolder(folders, attachmentFolderId(port), attachmentFolderId(country)), true);
});
test('Stable section IDs preserve attachments after section titles change', () => {
  const state = createSeedState();
  const target = { kind: 'port' as const, id: 'port-singapore' };
  state.knowledgeRecords = { 'port:port-singapore': { version: 1, sections: [{ id: 'info', title: 'Information', blocks: [{ id: 'permission', title: 'Port permission', type: 'text', text: 'Example' }] }] } };
  const scope = { target, section: { id: 'permission', name: 'Old name' } };
  const folders = buildAttachmentFolders(state, { items: [], folders: [] }, scope);
  assert.equal(folders.find(folder => folder.id === attachmentFolderId(scope))?.name, 'Port permission');
});
test('Attachment links preserve URL case and reject executable schemes and credentials', () => {
  assert.equal(attachmentLink('https://example.com/CaseSensitive.pdf?Token=AbC'), 'https://example.com/CaseSensitive.pdf?Token=AbC');
  for (const link of ['javascript:alert(1)', 'data:text/html,test', 'file:///secret', 'https://user:password@example.com', 'example.com']) assert.throws(() => attachmentLink(link));
  for (const name of ['../report', '..', 'folder/report', 'x\\y', '\u0000file']) assert.throws(() => attachmentName(name));
  assert.equal(attachmentName('Report.final.PDF'), 'Report.final.PDF');
});
test('Buyer legacy files and request documents retain their own folders and ownership', () => {
  const state = createSeedState();
  const buyer = state.companies[0], request = state.requests[0];
  buyer.files = [{ id: 'old', title: 'Buyer profile', url: '/demo/profile.txt' }];
  request.attachments = [{ id: 'request-doc', name: 'application.txt', mimeType: 'text/plain', size: 4, dataUrl: 'data:text/plain;base64,dGVzdA==' }];
  const items = legacyAttachmentItems(state), folders = buildAttachmentFolders(state, { items, folders: [] });
  const file = items.find(item => item.name === 'application.txt')!;
  assert.equal(file.legacy, true);
  assert.equal(folderAncestors(folders, file.folderId)[1].id, 'credit');
  assert.equal(file.scope.section?.id, request.id);
  assert.equal(items.find(item => item.name === 'Buyer profile')?.scope.target.kind, 'company');
});

test('supplier attachment folders use explicit authenticated references without a bundled fallback', () => {
  const state = createSeedState(), empty = { items: [], folders: [] };
  assert.equal(buildAttachmentFolders(state, empty).filter(folder => folder.scope?.target.kind === 'supplier').length, 0);
  const references = { suppliers: [{ id: 'synthetic-reference-supplier', name: 'SYNTHETIC REFERENCE SUPPLIER' }] };
  const folders = buildAttachmentFolders(state, empty, undefined, references);
  const supplier = folders.find(folder => folder.scope?.target.id === 'synthetic-reference-supplier');
  assert.equal(supplier?.name, 'SYNTHETIC REFERENCE SUPPLIER');
  assert.equal(supplier?.id, 'supplier:synthetic-reference-supplier');
});

test('active supplier masters provide writable folders without intelligence or fixture history', () => {
  const catalog = { items: [], folders: [] }, id = '90000000-0000-4000-8000-000000000001';
  const suppliers = attachmentSupplierReferences([{ id, legalName: 'CURRENT SUPPLIER PTE. LTD.' }], catalog,
    [{ id: 'old-import-key', name: 'OUTDATED INTELLIGENCE NAME' }]);
  const folders = buildAttachmentFolders(createSeedState(), catalog, undefined, { suppliers });
  assert.equal(folders.filter(folder => folder.parentId === 'suppliers').length, 1);
  const current = folders.find(folder => folder.id === `supplier:${id}`)!;
  assert.equal(current.scope?.target.id, id);
  assert.equal(current.name, 'CURRENT SUPPLIER PTE LTD');
  assert.equal(current.localOnly, undefined);
  assert.equal(folders.some(folder => folder.id === 'supplier:old-import-key'), false);
});

test('retained legacy supplier paths remain read-only and are never silently remapped to a master', () => {
  const scope = { target: { kind: 'supplier' as const, id: 'old-import-key' } }, folderId = attachmentFolderId(scope);
  const catalog = { items: [{ id: 'preserved', folderId, scope, name: 'Original source', type: 'link' as const, mime: '', size: 0,
    createdAt: '2026-10-15T00:00:00Z', createdBy: 'owner', url: 'https://example.test/original', localOnly: true }], folders: [] };
  const original = structuredClone(catalog);
  const references = { suppliers: attachmentSupplierReferences([{ id: 'canonical-id', legalName: 'CURRENT SUPPLIER' }], catalog,
    [{ id: 'old-import-key', name: 'ORIGINAL SOURCE LABEL' }]) };
  const folders = buildAttachmentFolders(createSeedState(), catalog, undefined, references);
  assert.equal(folders.find(folder => folder.id === folderId)?.localOnly, true);
  assert.equal(folders.find(folder => folder.id === folderId)?.name, 'ORIGINAL SOURCE LABEL');
  assert.deepEqual(catalog, original);
  assert.deepEqual(attachmentSupplierReferences([], catalog, references.suppliers), [{ id: 'old-import-key', name: 'ORIGINAL SOURCE LABEL', localOnly: true }],
    'A missing supplier service cannot create writable fallback identities');
  assert.equal(attachmentSupplierReferences([], { items: [{ ...catalog.items[0], scope: { target: { kind: 'supplier', id: 'supplier-meridian' } } }], folders: [] }).length, 0);
});
