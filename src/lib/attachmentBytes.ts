// WebKit can reject Blob/File values in IndexedDB. Store the original bytes in
// a structured-clone-safe form; retain the old Blob record format for reads.
export async function encodeAttachmentBytes(blob: Blob): Promise<{ bytes: ArrayBuffer; mime: string }> {
  return { bytes: await blob.arrayBuffer(), mime: blob.type };
}
export function decodeAttachmentBytes(value: unknown): Blob | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as { blob?: unknown; bytes?: unknown; mime?: unknown };
  if (item.blob instanceof Blob) return item.blob;
  if (item.bytes instanceof ArrayBuffer && typeof item.mime === 'string') return new Blob([item.bytes], { type: item.mime });
  return undefined;
}
