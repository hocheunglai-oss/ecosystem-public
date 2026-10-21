export type TextLinkPart = { text: string; href?: string };

/** Linkify web addresses only. Preserve path/query case and ordinary punctuation. */
export function textLinks(text: string): TextLinkPart[] {
  const result: TextLinkPart[] = [];
  let cursor = 0;
  for (const match of text.matchAll(/\b(?:https?:\/\/|www\.)[^\s<>"']+/gi)) {
    const start = match.index!;
    let value = match[0].replace(/[.,;:!?]+$/, '');
    for (const [left, right] of [['(', ')'], ['[', ']'], ['{', '}']]) {
      while (value.endsWith(right) && value.split(right).length > value.split(left).length) value = value.slice(0, -1);
    }
    try {
      const href = /^www\./i.test(value) ? `https://${value}` : value;
      const url = new URL(href);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) continue;
      if (start > cursor) result.push({ text: text.slice(cursor, start) });
      result.push({ text: value, href });
      cursor = start + value.length;
    } catch { /* Keep malformed addresses as ordinary text. */ }
  }
  if (cursor < text.length) result.push({ text: text.slice(cursor) });
  return result;
}
