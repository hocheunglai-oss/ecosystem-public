import { applyAction as actualApplyAction } from '../../src/lib/model';
import { historicalSupplierFixtures } from '../../src/lib/historicalSupplierFixtures';
/** Explicit injected catalog fixture. Runtime actions have no implicit supplier catalog. */
export const activeSupplierFixtures = historicalSupplierFixtures.map((item, index) => ({ ...item, id: `91000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, name: `TEST SHARED SUPPLIER ${index + 1}` }));
export function applyAction(...args: Parameters<typeof actualApplyAction>) { return actualApplyAction(args[0], args[1], args[2], args[3], { suppliers: activeSupplierFixtures }); }
