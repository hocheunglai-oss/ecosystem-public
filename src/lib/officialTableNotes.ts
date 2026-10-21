import type { KnowledgeBlock, KnowledgeSection } from './knowledge';

export const officialTableTitle = 'Current alternative-fuel supply position';
export const officialFuels = ['LNG', 'Methanol', 'Ammonia', 'Ethanol'] as const;
export const officialNotesId = 'mpa-alternative-fuels-notes';
const normalized = (value: string) => value.trim().toLowerCase();
type Table = Extract<KnowledgeBlock, { type: 'table' }>;
/** Only the approved table's exact four fuel rows participate; other user tables stay untouched. */
export function isOfficialNotes(block: KnowledgeBlock): block is Table {
  return block.type === 'table' && normalized(block.title) === normalized(officialTableTitle)
    && block.columns.length >= 2 && block.columns.length <= 3
    && normalized(block.columns[0].name) === 'fuel'
    && normalized(block.columns.at(-1)!.name) === 'commercial implication'
    && (block.columns.length === 2 || normalized(block.columns[1].name) === 'verified position')
    && block.rows.length === 4 && officialFuels.every(fuel => block.rows.filter(row => normalized(row.cells[0]) === normalized(fuel)).length === 1);
}
export function officialNotes(section?: Pick<KnowledgeSection, 'blocks'>): Record<string, string> {
  const table = section?.blocks.find(isOfficialNotes);
  return Object.fromEntries(officialFuels.map(fuel => [fuel.toLowerCase(), table?.rows.find(row => normalized(row.cells[0]) === normalized(fuel))?.cells.at(-1) ?? '']));
}
export function updateOfficialNote(section: KnowledgeSection, fuel: string, value: string, sections: readonly KnowledgeSection[] = [section]): void {
  if (!officialFuels.some(item => item.toLowerCase() === fuel) || value.length > 5000) return;
  let table = section.blocks.find(isOfficialNotes);
  if (!table) {
    if (!value.trim()) return;
    const ids = new Set<string>();
    for (const item of sections) { ids.add(item.id); for (const block of item.blocks) { ids.add(block.id); if (block.type === 'table') for (const child of [...block.columns, ...block.rows]) ids.add(child.id); } }
    const suffixes = ['', '-fuel', '-note', ...officialFuels.map(item => '-' + item.toLowerCase())];
    let id = officialNotesId; while (suffixes.some(suffix => ids.has(id + suffix))) id += '-notes';
    table = { id, title: officialTableTitle, type: 'table', columns: [{ id: id + '-fuel', name: 'Fuel' }, { id: id + '-note', name: 'Commercial implication' }], rows: officialFuels.map(item => ({ id: id + '-' + item.toLowerCase(), cells: [item, ''] })) };
    section.blocks.push(table);
  }
  const row = table.rows.find(item => normalized(item.cells[0]) === fuel)!;
  row.cells[table.columns.length - 1] = value;
}
