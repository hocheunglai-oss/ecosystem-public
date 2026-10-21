/** SPC source inventory, reviewed 2026-10-13. These IDs are not login claims. */
export const resources = [
  { id: 'enquiries', label: 'NEW ENQUIRY', spcId: 'spc-buyer-enquiries' },
  { id: 'daily-briefing', label: 'DAILY BRIEFING', spcId: 'spc-today-enquiries' },
  { id: 'whatsapp-extension', label: 'WHATSAPP EXTENSION', spcId: 'spc-chrome-extension' },
  { id: 'presentation', label: 'PRESENTATION', spcId: 'spc-readme' },
  { id: 'feedback', label: 'FEEDBACK', spcId: 'spc-feedback' },
  { id: 'fixtures', label: 'FIXTURES', spcId: 'spc-fixtures' },
  { id: 'lost-record', label: 'LOST RECORD', spcId: 'spc-lost-record' },
  { id: 'statistics', label: 'STATISTICS', spcId: 'spc-statistics' },
  { id: 'suppliers', label: 'SUPPLIER DATABASE', spcId: 'spc-suppliers' },
  { id: 'audit-log', label: 'AUDIT LOG', spcId: 'spc-audit-log' },
  { id: 'parser-reports', label: 'PARSER REPORT', spcId: 'spc-parser-reports' },
  { id: 'user-management', label: 'USER MANAGEMENT', spcId: 'spc-user-management' },
  { id: 'system-health', label: 'SYSTEM HEALTH', spcId: 'spc-system-health' },
  { id: 'tech-stack', label: 'TECH STACK', spcId: 'spc-tech-stack' },
] as const;

export type ResourceId = typeof resources[number]['id'];
const resourceIds: ReadonlySet<string> = new Set(resources.map(resource => resource.id));

export function isResourceId(value: string): value is ResourceId {
  return resourceIds.has(value);
}
