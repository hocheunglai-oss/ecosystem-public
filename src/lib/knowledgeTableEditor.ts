import type { KnowledgeBlock } from './knowledge';

type Table = Extract<KnowledgeBlock, { type: 'table' }>;

/** Move complete row records, including their stable IDs and update history. */
export function moveKnowledgeRow(table: Table, from: number, to: number): Table {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= table.rows.length || to >= table.rows.length || from === to) return table;
  const next = structuredClone(table);
  const [row] = next.rows.splice(from, 1);
  next.rows.splice(to, 0, row);
  return next;
}

/** A column move carries its ID, width, heading, and every row's matching cell. */
export function moveKnowledgeColumn(table: Table, from: number, to: number): Table {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= table.columns.length || to >= table.columns.length || from === to) return table;
  const next = structuredClone(table);
  const [column] = next.columns.splice(from, 1);
  next.columns.splice(to, 0, column);
  for (const row of next.rows) {
    const [cell] = row.cells.splice(from, 1);
    row.cells.splice(to, 0, cell);
  }
  return next;
}

const naturalOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Sort complete records, never individual cells. Equal values retain their order; blanks stay last. */
export function sortKnowledgeRows(table: Table, column: number, direction: 'asc' | 'desc'): Table {
  if (!Number.isInteger(column) || column < 0 || column >= table.columns.length || table.rows.length < 2) return table;
  const ordered = table.rows.map((row, index) => ({ row, index, value: row.cells[column].trim() }));
  ordered.sort((a, b) => {
    if (!a.value || !b.value) return a.value ? -1 : b.value ? 1 : a.index - b.index;
    return naturalOrder.compare(a.value, b.value) * (direction === 'asc' ? 1 : -1) || a.index - b.index;
  });
  if (ordered.every((item, index) => item.index === index)) return table;
  return { ...structuredClone(table), rows: ordered.map(item => structuredClone(item.row)) };
}

export function knowledgeColumnLetter(column: number): string {
  let value = column + 1, label = '';
  while (value > 0) { value--; label = String.fromCharCode(65 + value % 26) + label; value = Math.floor(value / 26); }
  return label;
}

export function knowledgeCellAddress(address: string, rows: number, columns: number): { row: number; col: number } | undefined {
  const match = /^([A-Z]+)([1-9]\d*)$/i.exec(address.trim());
  if (!match) return undefined;
  const col = [...match[1].toUpperCase()].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
  const row = Number(match[2]) - 1;
  return row >= 0 && row < rows && col >= 0 && col < columns ? { row, col } : undefined;
}
