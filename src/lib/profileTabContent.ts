import type { KnowledgeBlock, KnowledgeDocument } from './knowledge';

// Keep the owner-scoped API contract unchanged. Only this marked format is decoded.
export const PROFILE_CONTENT_PREFIX = 'ECO_PROFILE_CONTENT_V1\n';
export const PROFILE_CONTENT_LIMIT = 20_000;
export type ProfileContentBlock = Extract<KnowledgeBlock, { type: 'text' | 'table' }>;
const invalid = (): never => { throw new Error('Invalid tab content.'); };
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) return invalid();
  return value;
}
function blocks(value: unknown): ProfileContentBlock[] {
  if (!Array.isArray(value) || value.length > 100) return invalid();
  const ids = new Set<string>();
  function id(value: unknown) {
    const result = text(value, 100, true);
    if (ids.has(result)) return invalid();
    ids.add(result);
    return result;
  }
  return value.map(value => {
    const block = object(value, ['id', 'title', 'type', 'text', 'columns', 'rows']);
    const common = { id: id(block.id), title: text(block.title, 150, true) };
    if (block.type === 'text') {
      if ('columns' in block || 'rows' in block) return invalid();
      return { ...common, type: 'text' as const, text: text(block.text, PROFILE_CONTENT_LIMIT) };
    }
    if (block.type !== 'table' || 'text' in block || !Array.isArray(block.columns) || block.columns.length < 1 || block.columns.length > 30 || !Array.isArray(block.rows) || block.rows.length > 1000) return invalid();
    const columns = block.columns.map(value => {
      const column = object(value, ['id', 'name', 'width']);
      if (column.width !== undefined && (typeof column.width !== 'number' || !Number.isFinite(column.width) || column.width < 100 || column.width > 600)) return invalid();
      return { id: id(column.id), name: text(column.name, 150, true), ...(column.width === undefined ? {} : { width: column.width as number }) };
    });
    const rows = block.rows.map(value => {
      const row = object(value, ['id', 'cells']);
      if (!Array.isArray(row.cells) || row.cells.length !== columns.length) return invalid();
      return { id: id(row.id), cells: row.cells.map(value => text(value, 5000)) };
    });
    return { ...common, type: 'table' as const, columns, rows };
  });
}
/** Legacy and malformed marked content stays literal text; it is never discarded. */
export function decodeProfileTabContent(content: string | undefined, title: string): ProfileContentBlock[] {
  const value = content ?? '';
  if (value.startsWith(PROFILE_CONTENT_PREFIX) && value.length <= PROFILE_CONTENT_LIMIT) {
    try {
      const document = object(JSON.parse(value.slice(PROFILE_CONTENT_PREFIX.length)), ['version', 'blocks']);
      if (document.version === 1) return blocks(document.blocks);
    } catch { /* Preserve existing text, including unsupported future versions. */ }
  }
  return value ? [{ id: 'legacy-text', title, type: 'text', text: value }] : [];
}
export function encodeProfileTabContent(value: readonly KnowledgeBlock[]): string {
  const content = PROFILE_CONTENT_PREFIX + JSON.stringify({ version: 1, blocks: blocks(value) });
  if (content.length > PROFILE_CONTENT_LIMIT) throw new Error('Keep tab content within 20,000 characters, including table structure.');
  return content;
}
export function profileTabDocument(tab: { id: string; title: string; content?: string }): KnowledgeDocument {
  return { version: 1, sections: [{ id: tab.id, title: tab.title, blocks: decodeProfileTabContent(tab.content, tab.title) }] };
}
