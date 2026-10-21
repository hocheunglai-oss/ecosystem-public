import test from 'node:test';
import assert from 'node:assert/strict';
import { addAttachmentItems, saveAttachmentFolder, updateAttachmentItem, deleteAttachmentItem } from '../src/lib/attachmentStorage';
import type { AttachmentItem } from '../src/lib/attachments';
import { setPreviewReadOnly, setSessionUnavailable } from '../src/lib/previewGuard';
const item: AttachmentItem = { id:'local-file',folderId:'supplier:spc-nunchi',scope:{target:{kind:'supplier',id:'spc-nunchi'}},name:'Test.pdf',type:'file',mime:'application/pdf',size:10,createdAt:'2026-10-14T00:00:00Z',createdBy:'test-user' };
test('supplier master records cannot silently acquire browser-only attachments or folders', async()=>{
 await assert.rejects(addAttachmentItems([{item}]),/shared storage/);
 await assert.rejects(updateAttachmentItem(item),/shared storage/);
 await assert.rejects(saveAttachmentFolder({id:'folder',parentId:item.folderId,name:'Subfolder',scope:item.scope}),/shared storage/);
});

test('unverified sessions and VIEW AS cannot mutate local attachment bytes, metadata, folders or deletions', async () => {
 const local = { ...item, folderId: 'country:Japan', scope: { target: { kind: 'country' as const, id: 'Japan' } } };
 try {
  for (const guard of ['session', 'preview']) {
   setSessionUnavailable(guard === 'session'); setPreviewReadOnly(guard === 'preview');
   const message = guard === 'session' ? /SESSION TO RECONNECT/ : /PREVIEW IS READ ONLY/;
   // No IndexedDB exists in this test process: each rejection must happen before opening storage.
   await assert.rejects(addAttachmentItems([{ item: local, blob: new Blob(['fixture']) }]), message);
   await assert.rejects(updateAttachmentItem(local), message);
   await assert.rejects(saveAttachmentFolder({ id: 'folder', parentId: local.folderId, name: 'Subfolder', scope: local.scope }), message);
   await assert.rejects(deleteAttachmentItem(local.id), message);
  }
 } finally { setSessionUnavailable(false); setPreviewReadOnly(false); }
});
