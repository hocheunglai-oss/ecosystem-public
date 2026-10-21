export const intelligenceFields = [
  { key: 'qualityClaim', label: '30 days quality claim period' },
  { key: 'isoSpecs', label: 'ISO Specs' },
  { key: 'sampleLocation', label: 'Sample Location' },
  { key: 'debunkering', label: 'Debunkering' },
] as const;

export const INTELLIGENCE_VALUE_MAX_LENGTH = 1000;
export type IntelligenceKeyInfo = {
  [Field in typeof intelligenceFields[number] as Field['key']]: string | null;
};

export function emptyIntelligenceKeyInfo(): IntelligenceKeyInfo {
  return { qualityClaim: null, isoSpecs: null, sampleLocation: null, debunkering: null };
}

/** Validate local saved actions too; TypeScript alone cannot validate restored data. */
export function validateIntelligenceKeyInfo(value: unknown): IntelligenceKeyInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Enter valid Key Info values.');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !intelligenceFields.some(field => field.key === key))) {
    throw new Error('Enter valid Key Info fields.');
  }
  const result = emptyIntelligenceKeyInfo();
  for (const field of intelligenceFields) {
    const entered = record[field.key];
    if (entered !== null && typeof entered !== 'string') throw new Error(`Enter a valid ${field.label} value.`);
    if (typeof entered === 'string' && entered.length > INTELLIGENCE_VALUE_MAX_LENGTH) throw new Error(`${field.label} must be ${INTELLIGENCE_VALUE_MAX_LENGTH.toLocaleString('en-US')} characters or fewer.`);
    // Preserve existing nonblank text, line breaks and casing; only empty fields become unknown.
    result[field.key] = typeof entered === 'string' && entered.trim() ? entered : null;
  }
  return result;
}

export function sameIntelligenceKeyInfo(first: IntelligenceKeyInfo, second: IntelligenceKeyInfo): boolean {
  return intelligenceFields.every(field => first[field.key] === second[field.key]);
}

export function intelligenceChangeSummary(before: IntelligenceKeyInfo, after: IntelligenceKeyInfo): string {
  return intelligenceFields.filter(field => before[field.key] !== after[field.key])
    .map(field => `${field.label}: ${before[field.key] ?? '—'} → ${after[field.key] ?? '—'}`).join('; ');
}
