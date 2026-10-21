/** Requested quantities may be exact or ranges; no midpoint is inferred. */
export function parseProductQuantity(value: string): { min: number; max: number } | null {
  if (typeof value !== 'string') return null;
  const numeric = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;
  const normalized = value.trim().replace(/[–—−]/g, '-');
  const match = normalized.match(new RegExp(`^(${numeric})(?:\\s*(?:-|~|to|/)\\s*(${numeric}))?\\s*(?:MT|MTS|metric\\s+tonnes?)?$`, 'i'));
  if (!match) return null;
  const min = Number(match[1].replaceAll(',', ''));
  const max = Number((match[2] || match[1]).replaceAll(',', ''));
  return Number.isFinite(min) && Number.isFinite(max) && min > 0 && max >= min && max <= Number.MAX_SAFE_INTEGER ? { min, max } : null;
}
