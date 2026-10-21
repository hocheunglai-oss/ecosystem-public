import type { KnowledgeBlock } from './knowledge';
import type { DemoState } from './model';
import { productSupplierName } from './fixtureSuppliers';

const normalize = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Search displayed information, never internal IDs, attribution or source metadata. */
export function matchesKnowledgeSearch(query: string, ...values: (string | number | null | undefined)[]) {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  const text = normalize(values.filter(value => value != null).join(' '));
  return words.every(word => text.includes(word));
}

export function knowledgeBlockMatches(block: KnowledgeBlock, query: string) {
  if (block.type === 'text') return matchesKnowledgeSearch(query, block.title, block.text);
  if (block.type === 'file') return matchesKnowledgeSearch(query, block.title, block.url);
  return matchesKnowledgeSearch(query, block.title, ...block.columns.map(column => column.name)) || block.rows.some(row => knowledgeRowMatches(block, row.cells, query));
}

export function knowledgeRowMatches(block: KnowledgeBlock, cells: string[], query: string) {
  return matchesKnowledgeSearch(query, block.title, ...(block.type === 'table' ? block.columns.map(column => column.name) : []), ...cells);
}

export function portBuyPriceRows(state: Pick<DemoState, 'outcomes'>, portId: string, query = '') {
  return state.outcomes.filter(outcome => outcome.kind === 'fixture' && outcome.portId === portId)
    .flatMap(outcome => (outcome.stemProducts || []).map(product => ({
      id: `${outcome.id}:${product.grade}`, date: outcome.bookedAt, vessel: outcome.vessel,
      supplier: productSupplierName(outcome, product) || '—', ...product,
    })))
    .filter(row => matchesKnowledgeSearch(query, row.supplier, row.grade, row.vessel, row.buyPrice, row.quantityText, row.date,
      new Date(row.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })))
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
}
