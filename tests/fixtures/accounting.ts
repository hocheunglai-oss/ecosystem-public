import { currentMonth, type Outcome } from '../../src/lib/model';
import { createSeedState } from '../../src/lib/seed';

/** Accounting tests own their ledger; extra public walkthrough history must not change totals. */
export function accountingTestState(at: string) {
  const state = createSeedState();
  const month = currentMonth(new Date(at));
  const previous = new Date(`${month}-01T00:00:00.000Z`);
  previous.setUTCMonth(previous.getUTCMonth() - 1);
  const rows: [string, number, number, Outcome['kind'], string][] = [
    ['meridian', 1400, 18, 'fixture', month],
    ['northern-star', 1100, 14, 'fixture', month],
    ['pacific-orbit', 1800, 17, 'fixture', month],
    ['aurelia', 900, 20, 'fixture', month],
    ['coral-route', 800, 15, 'lost', month],
    ['cape-union', 1200, 16, 'fixture', currentMonth(previous)],
    ['southwind', 500, 13, 'lost', currentMonth(previous)],
  ];
  state.outcomes = rows.map(([buyer, quantity, margin, kind, bookedMonth], index) => ({
    id: `outcome-${index + 1}`, enquiryId: `enquiry-closed-${index + 1}`,
    kind, buyerId: `company-${buyer}`, portId: 'port-singapore', vessel: `TEST VESSEL ${index + 1}`,
    grade: 'VLSFO', quantity, margin, price: 575,
    bookedAt: `${bookedMonth}-01T09:00:00.000Z`, owner: 'otto', reason: 'Accounting test fixture',
  }));
  return state;
}
