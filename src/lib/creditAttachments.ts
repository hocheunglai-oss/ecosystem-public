export interface CreditAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
}
export const CREDIT_ATTACHMENT_ACCEPT = '.pdf,.png,.jpg,.jpeg,.txt,.csv,.docx,.xlsx';
export const CREDIT_ATTACHMENT_MAX_FILES = 5;
export const CREDIT_ATTACHMENT_MAX_BYTES = 512 * 1024;
export const CREDIT_ATTACHMENT_TOTAL_BYTES = 1536 * 1024;
const formats: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  txt: 'text/plain', csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
function mimeFor(name: string): string | undefined { return formats[name.split('.').pop()?.toLowerCase() ?? '']; }
function hasSignature(bytes: Uint8Array, mime: string): boolean {
  const prefix = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (mime === 'application/pdf') return prefix(37, 80, 68, 70, 45);
  if (mime === 'image/png') return prefix(137, 80, 78, 71, 13, 10, 26, 10);
  if (mime === 'image/jpeg') return prefix(255, 216, 255);
  if (mime.includes('openxmlformats')) return prefix(80, 75, 3, 4);
  return !bytes.includes(0);
}
/** Download-only data; HTML, SVG, scripts, external URLs and unbounded payloads are rejected. */
export function validateCreditAttachments(input: CreditAttachment[] = []): CreditAttachment[] {
  if (!Array.isArray(input) || input.length > CREDIT_ATTACHMENT_MAX_FILES) throw new Error('Attach up to 5 files.');
  let total = 0;
  const ids = new Set<string>();
  return input.map(item => {
    if (!item || typeof item.id !== 'string' || !/^[\w-]{1,120}$/.test(item.id) || ids.has(item.id)) throw new Error('Invalid attachment reference.');
    ids.add(item.id);
    if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 160 || /[\u0000-\u001f\u007f/\\]/.test(item.name)) throw new Error('Invalid attachment name.');
    const mime = mimeFor(item.name);
    if (!mime || item.mimeType !== mime) throw new Error('Use PDF, PNG, JPG, TXT, CSV, DOCX or XLSX attachments.');
    if (!Number.isSafeInteger(item.size) || item.size < 1 || item.size > CREDIT_ATTACHMENT_MAX_BYTES) throw new Error('Each attachment must be 512 KB or smaller.');
    total += item.size;
    if (total > CREDIT_ATTACHMENT_TOTAL_BYTES) throw new Error('Attachments must total 1.5 MB or less.');
    const prefix = `data:${mime};base64,`;
    if (typeof item.dataUrl !== 'string' || !item.dataUrl.startsWith(prefix) || item.dataUrl.length > prefix.length + Math.ceil(CREDIT_ATTACHMENT_MAX_BYTES / 3) * 4) throw new Error('Invalid attachment data.');
    const encoded = item.dataUrl.slice(prefix.length);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('Invalid attachment encoding.');
    const decoded = atob(encoded);
    if (decoded.length !== item.size || !hasSignature(Uint8Array.from(decoded, char => char.charCodeAt(0)), mime)) throw new Error('Attachment contents do not match its format.');
    return { id: item.id, name: item.name.trim(), mimeType: mime, size: item.size, dataUrl: item.dataUrl };
  });
}

export async function readCreditAttachments(files: File[], existing: CreditAttachment[] = []): Promise<CreditAttachment[]> {
  if (existing.length + files.length > CREDIT_ATTACHMENT_MAX_FILES) throw new Error('Attach up to 5 files.');
  const added = await Promise.all(files.map(async file => {
    const mimeType = mimeFor(file.name);
    if (!mimeType) throw new Error('Use PDF, PNG, JPG, TXT, CSV, DOCX or XLSX attachments.');
    if (file.size < 1 || file.size > CREDIT_ATTACHMENT_MAX_BYTES) throw new Error('Each attachment must be 512 KB or smaller.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return { id: `credit-file-${crypto.randomUUID()}`, name: file.name, mimeType, size: bytes.length, dataUrl: `data:${mimeType};base64,${btoa(binary)}` };
  }));
  return validateCreditAttachments([...existing, ...added]);
}
