import { createSeedState as createBaseState } from '../../src/lib/seed';
import { knowledgeDocument } from '../../src/lib/knowledge';
import type { DemoState } from '../../src/lib/model';

export const syntheticSupplier = { kind: 'supplier', id: 'synthetic-supplier' } as const;
export const syntheticSupplierReferences = { suppliers: [{ id: syntheticSupplier.id, name: 'SYNTHETIC SUPPLIER' }] };

/** Explicit test reference; production seed state contains no supplier catalog. */
export function addSyntheticSupplierKnowledge(state: DemoState): DemoState {
  state.knowledgeRecords = {
    ...state.knowledgeRecords,
    [`supplier:${syntheticSupplier.id}`]: knowledgeDocument(state, syntheticSupplier, syntheticSupplierReferences),
  };
  return state;
}

export function createSupplierKnowledgeState(): DemoState {
  return addSyntheticSupplierKnowledge(createBaseState());
}
