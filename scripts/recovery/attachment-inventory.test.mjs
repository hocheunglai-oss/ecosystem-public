import test from 'node:test';
import assert from 'node:assert/strict';
import {validateAttachmentInventory} from './capture-postgres.mjs';
const bucket='eco-profile-attachments',path='11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.bin';
const object={id:'object',bucket_id:bucket,name:path,metadata:{size:10,mimetype:'text/plain'},version:'v1'};
const active={object_path:path,state:'active',sha256:'a'.repeat(64),size_bytes:10,expected_mime:'text/plain',storage_object_id:'object',storage_version:'v1'};
test('every published attachment must match the same-snapshot identity, version, size, MIME and verified hash',()=>{
 const objects=[structuredClone(object)];validateAttachmentInventory(objects,[active],bucket);assert.equal(objects[0].expectedSha256,active.sha256);assert.equal(objects[0].attachmentState,'active');
 for(const changed of [{storage_object_id:'other'},{storage_version:'v2'},{size_bytes:11},{expected_mime:'text/html'},{sha256:'invalid'}])assert.throws(()=>validateAttachmentInventory([structuredClone(object)],[{...active,...changed}],bucket));
 assert.throws(()=>validateAttachmentInventory([],[active],bucket));assert.throws(()=>validateAttachmentInventory([structuredClone(object)],[],bucket));
});
test('known pending reservations are captured as actual bytes without trusting proposed digest or size',()=>{
 const pending={...active,state:'pending',sha256:null,size_bytes:null,storage_object_id:null,storage_version:null};
 const objects=[structuredClone(object)];validateAttachmentInventory(objects,[pending],bucket);assert.equal(objects[0].attachmentState,'pending');assert.equal(objects[0].expectedSha256,undefined);
 validateAttachmentInventory([], [pending],bucket); // A reservation can precede arrival of any bytes.
 assert.throws(()=>validateAttachmentInventory(objects,[pending,pending],bucket));
});

import {verifyRecordedAttachmentFiles} from './restore-local.mjs';
test('restore verifies published references against recovered hashes and includes known pending originals',()=>{
 const file={...object,path:'objects/'+('b'.repeat(64))+'.bin',size:10,sha256:active.sha256,mimeType:'text/plain'};
 const inventory={attachmentBucket:bucket,attachmentUploads:[active],storage:{objects:[file]}};
 verifyRecordedAttachmentFiles(inventory);
 assert.throws(()=>verifyRecordedAttachmentFiles({...inventory,storage:{objects:[{...file,sha256:'c'.repeat(64)}]}}),/ATTACHMENT_REFERENCE_MISMATCH/);
 assert.throws(()=>verifyRecordedAttachmentFiles({...inventory,attachmentUploads:[]}),/UNRECOGNIZED_ATTACHMENT_FILE/);
 verifyRecordedAttachmentFiles({...inventory,attachmentUploads:[{...active,state:'pending',sha256:null,size_bytes:null}]});
});
