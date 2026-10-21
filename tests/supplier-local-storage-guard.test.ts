import test from 'node:test';
import assert from 'node:assert/strict';
import { addAttachmentItems, saveAttachmentFolder, updateAttachmentItem } from '../src/lib/attachmentStorage';
import type { AttachmentItem } from '../src/lib/attachments';
const item: AttachmentItem = { id:'local-file',folderId:'supplier:spc-nunchi',scope:{target:{kind:'supplier',id:'spc-nunchi'}},name:'Test.pdf',type:'file',mime:'application/pdf',size:10,createdAt:'2026-10-14T00:00:00Z',createdBy:'test-user' };
test('supplier master records cannot silently acquire browser-only attachments or folders', async()=>{
 await assert.rejects(addAttachmentItems([{item}]),/shared storage/);
 await assert.rejects(updateAttachmentItem(item),/shared storage/);
 await assert.rejects(saveAttachmentFolder({id:'folder',parentId:item.folderId,name:'Subfolder',scope:item.scope}),/shared storage/);
});
