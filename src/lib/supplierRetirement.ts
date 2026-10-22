import type { KnowledgeBlock } from './knowledge.ts';
import type { DemoState } from './model.ts';
import { historicalSupplierFixtures } from './historicalSupplierFixtures.ts';

export const retiredSupplierIds = new Set(historicalSupplierFixtures.map(item => item.id));
const names = new Set(historicalSupplierFixtures.flatMap(item => [item.name, ...item.aliases]).map(name => name.trim().toLocaleLowerCase('en-US')));
const retiredName = (value: string) => names.has(value.trim().toLocaleLowerCase('en-US'));
export const retiredSupplierTarget = (target?: { kind: string; id: string }) => target?.kind === 'supplier' && retiredSupplierIds.has(target.id);

/** Retire only identified supplier examples. Preserve financial history and archive edited knowledge. */
export function retireFictionalSupplierRecords(input: DemoState): DemoState {
  if (input.supplierRetirementVersion === 1) return input;
  const next = structuredClone(input);
  for (const [key, document] of Object.entries(next.knowledgeRecords ?? {})) {
    if (key.startsWith('supplier:') && retiredSupplierIds.has(key.slice('supplier:'.length))) {
      next.retiredSupplierKnowledge ??= {};
      next.retiredSupplierKnowledge[key] ??= structuredClone(document);
      delete next.knowledgeRecords![key];
      continue;
    }
    let changed = false;
    const sections = document.sections.map(section => ({ ...section, blocks: section.blocks.flatMap<KnowledgeBlock>(block => {
      if (block.type === 'text' && block.id.startsWith('supplier-intro-') && retiredName(block.title)) { changed = true; return []; }
      if (block.type !== 'table') return [block];
      const supplierColumn = block.columns.findIndex(column => /^supplier(?: name)?$/i.test(column.name.trim()));
      if (supplierColumn < 0) return [block];
      const rows = block.rows.filter(row => !retiredName(row.cells[supplierColumn] ?? ''));
      if (rows.length === block.rows.length) return [block];
      changed = true;
      return [{ ...block, rows }];
    }) }));
    if (changed) {
      next.retiredSupplierKnowledge ??= {};
      next.retiredSupplierKnowledge[key] ??= structuredClone(document);
      next.knowledgeRecords![key] = { ...document, sections };
    }
  }
  next.supplierRetirementVersion = 1;
  return next;
}
