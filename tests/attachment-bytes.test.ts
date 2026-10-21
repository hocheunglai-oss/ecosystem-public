import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeAttachmentBytes, decodeAttachmentBytes } from '../src/lib/attachmentBytes';

test('attachment byte storage retains original MIME and every byte across structured clone', async () => {
  const bytes = Uint8Array.from([0, 37, 80, 68, 70, 255, 0, 128]);
  const original = new File([bytes], 'Original.PDF', { type: 'application/pdf' });
  const encoded = await encodeAttachmentBytes(original);
  const restored = decodeAttachmentBytes(structuredClone({ id: 'fixture', ...encoded }));
  assert.equal(restored?.type, 'application/pdf');
  assert.deepEqual(new Uint8Array(await restored!.arrayBuffer()), bytes);
});
test('legacy Blob records remain readable without rewriting or migrating stored attachments', async () => {
  const blob = new Blob(['Old Case-sensitive text'], { type: 'text/plain' });
  assert.equal(decodeAttachmentBytes({ id: 'old-fixture', blob }), blob);
  assert.equal(await decodeAttachmentBytes({ blob })?.text(), 'Old Case-sensitive text');
  for (const invalid of [null, {}, { bytes: 'not-bytes', mime: 'text/plain' }, { blob: 'not-a-blob' }]) assert.equal(decodeAttachmentBytes(invalid), undefined);
});
