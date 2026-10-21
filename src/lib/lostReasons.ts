/** Supplier-side defaults from SPC; IDs and saved outcome labels remain stable when edited. */
export interface LostReason { id: string; label: string; active: boolean }

export const DEFAULT_SUPPLIER_LOST_REASONS = [
  "SUPPLIER NO AVAILS",
  "SUPPLIER LATE RESPONSE",
  "LIMITED SUPPLIER POOL - SIZE",
  "LIMITED SUPPLIER POOL - SPECS",
  "LIMITED SUPPLIER POOL - SPECIAL REQUIREMENTS",
  "UNABLE TO MEET REQUIRED OFFER TIMING",
  "SUPPLIER WITHDREW",
  "CREDIT OR COMPLIANCE",
  "OTHER",
] as const;

export const defaultLostReasons: LostReason[] = DEFAULT_SUPPLIER_LOST_REASONS.map((label, index) => ({
  id: `spc-supplier-lost-${index + 1}`,
  label,
  active: true,
}));

export function lostReasonsFor(state: { lostReasons?: LostReason[] }): LostReason[] {
  return state.lostReasons ?? defaultLostReasons;
}
