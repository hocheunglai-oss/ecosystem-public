import { createHash } from 'node:crypto';
import type { OfficialFuelId, OfficialTableRow } from '../../shared/officialTables.ts';
import { officialSourceUrl } from './sources.ts';

export const evidenceHash = (value: string) => createHash('sha256').update(value).digest('hex');
const singaporeDate = (checkedAt: string) => new Date(Date.parse(checkedAt) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', emsp: ' ' };
export function plainText(html: string): string {
  return html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (_, name: string) => name[0] === '#' ? String.fromCodePoint(Math.min(0x10ffff, parseInt(name.slice(name[1]?.toLowerCase() === 'x' ? 2 : 1), name[1]?.toLowerCase() === 'x' ? 16 : 10))) : entities[name.toLowerCase()] ?? ' ')
    .replace(/\s+/g, ' ').trim();
}
export function sourceDate(value: string): string {
  const clean = value.trim(), months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const match = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(clean);
  const result = match ? `${match[3]}-${String(months.indexOf(match[2].slice(0, 3).toLowerCase()) + 1).padStart(2, '0')}-${match[1].padStart(2, '0')}` : clean;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString().slice(0, 10) !== result) throw new Error('Official source date unavailable');
  return result;
}
/** Balanced extraction limits parsing to the published main-content element, excluding contacts/footer/scripts. */
function mainContent(html: string): string {
  const start = /<div\b[^>]*data-directus="[^"<>]*fields:main_content[^"<>]*"[^>]*>/i.exec(html);
  if (!start) throw new Error('Official release structure changed');
  const begin = start.index + start[0].length, tags = /<\/?div\b[^>]*>/gi; tags.lastIndex = begin; let depth = 1, token: RegExpExecArray | null;
  while ((token = tags.exec(html))) { depth += /^<\//.test(token[0]) ? -1 : 1; if (!depth) return plainText(html.slice(begin, token.index)); }
  throw new Error('Official release structure changed');
}
export interface Release { title: string; date: string; body: string; url: string }
export function parseRelease(html: string, url: string): Release {
  const heading = /<h[1-3]\b[^>]*data-directus="[^"<>]*fields:title[^"<>]*"[^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(html);
  const date = /fields:release_date[^"<>]*"[^>]*>([\s\S]*?)<\/div>/i.exec(html);
  const title = heading && plainText(heading[1]);
  if (!title || title.length > 300 || !date) throw new Error('Official release metadata changed');
  return { title, date: sourceDate(plainText(date[1]).replace(/^Published\s+/i, '')), body: mainContent(html), url: officialSourceUrl(url) };
}
export function releaseRow(id: Exclude<OfficialFuelId, 'lng'>, release: Release, checkedAt: string): OfficialTableRow {
  const body = release.body; let position = '', evidence = '';
  if (id === 'methanol') {
    // Named awards and licence term must both be explicit. Never infer availability from a trial or a technical reference.
    const companies = /Licen[cs]es (?:will be|were|have been|are) awarded to ([^.]{10,700}?)(?:\s*\[\d+\])?\./i.exec(body);
    const term = /licen[cs]es will be valid[^.]*?from (\d{1,2} \w+ \d{4}) to\s*(\d{1,2} \w+ \d{4})[^.]*subject to ([^.]+)\./i.exec(body);
    if (!/methanol/i.test(release.title) || !companies || !term) throw new Error('Methanol publication requires review');
    position = `MPA announced methanol licence awards to ${companies[1].replace(/\s*\[\d+\]$/, '')}. Licence term: ${sourceDate(term[1])} to ${sourceDate(term[2])}, subject to ${term[3]}.`;
    evidence = `${companies[0]}\n${term[0]}`;
  } else {
    // Retain complete factual sentences, including qualification and future tense, rather than synthesizing commercial claims.
    const protectedBody = body.replace(/\b(?:M\.T\.|Pte\.|Ltd\.|Mr\.|Ms\.)/g, value => value.replaceAll('.', '\uE000'));
    const sentences = protectedBody.match(/[^.!?]+[.!?](?=\s|$)/g)?.map(text => text.replaceAll('\uE000', '.').trim().replace(/^\d+\.\s*/, '')) ?? [];
    const relevant = id === 'ammonia'
      ? sentences.filter(text => /ammonia/i.test(text) && /bunker/i.test(text) && /launch|trial|pilot|licen[cs]|conduct|complet|supply|supplie/i.test(text))
      : sentences.filter(text => /(?:bio)?ethanol/i.test(text) && /bunker/i.test(text) && /complet|conduct|bunkered|will /i.test(text));
    if (!relevant.length) throw new Error('Official publication requires review');
    const selected = relevant.slice(0, 2);
    if (id === 'ammonia') { const trials = sentences.find(text => /validate.*\bTR\b.*trials/i.test(text)); if (trials && !selected.includes(trials)) selected.push(trials); }
    if (id === 'ethanol') { const quantity = relevant.find(text => /\d[\d,]*(?:\.\d+)?\s+(?:metric\s+)?tonnes/i.test(text)); if (quantity && !selected.includes(quantity)) selected.push(quantity); }
    position = selected.join(' ');
  }
  if (!position || position.length > 1800 || /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b(?:tel|fax|contact person|email address)\s*:/i.test(position)) throw new Error('Official excerpt requires review');
  if (release.date > singaporeDate(checkedAt)) throw new Error('Future publication date');
  return { id, fuel: id[0].toUpperCase() + id.slice(1), position, sourceUrl: release.url, sourceTitle: release.title, publishedAt: release.date, checkedAt, evidenceHash: evidenceHash(`${release.date}\n${evidence || position}`) };
}
export function discoverRegister(html: string): { url: string; date: string } {
  const choices = [...html.matchAll(/href=["']([^"']+\.pdf)["']/gi)].flatMap(match => {
    const path = decodeURIComponent(match[1]);
    if (!/list.of.licensed.LNG.bunker.suppliers/i.test(path)) return [];
    const date = /(?:-|\s)(\d{1,2})[-\s]+([A-Za-z]{3,9})[-\s]+(\d{4})\.pdf$/i.exec(path);
    if (!date) throw new Error('Register date requires review');
    return [{ url: officialSourceUrl(match[1]), date: sourceDate(`${date[1]} ${date[2]} ${date[3]}`) }];
  }).sort((a, b) => b.date.localeCompare(a.date));
  if (!choices.length || (choices[1]?.date === choices[0].date && choices[1].url !== choices[0].url)) throw new Error('Official LNG register unavailable or ambiguous');
  return choices[0];
}
export interface PdfText { text: string; x: number; y: number; page: number }
export function registerRow(items: PdfText[], register: { url: string; date: string }, checkedAt: string): OfficialTableRow {
  const headings = items.filter(item => /^S\/N$/i.test(item.text.trim()));
  if (!headings.length || !items.some(item => /LNG Bunker Supplier/i.test(item.text))) throw new Error('Register columns changed');
  const numbers: number[] = [];
  for (const heading of headings) for (const item of items) {
    if (item.page === heading.page && Math.abs(item.x - heading.x) < 12 && item.y < heading.y && /^\d{1,3}$/.test(item.text.trim())) numbers.push(Number(item.text.trim()));
  }
  if (!numbers.length || numbers.length > 100 || numbers.some((n, index) => n !== index + 1)) throw new Error('Register numbering changed');
  const footers = items.map(item => /^Correct as at\s+(.+)$/i.exec(item.text.trim())).filter(Boolean);
  if (footers.length !== 1 || sourceDate(footers[0]![1]) !== register.date || register.date > singaporeDate(checkedAt)) throw new Error('Register date changed');
  const position = `${numbers.length} licensed LNG bunker suppliers are listed in MPA's register dated ${register.date}.`;
  return { id: 'lng', fuel: 'LNG', position, sourceUrl: register.url, sourceTitle: 'MPA list of licensed LNG bunker suppliers', publishedAt: register.date, checkedAt, evidenceHash: evidenceHash(`${register.date}\n${numbers.join(',')}`) };
}
export function discoverReleases(xml: string): { url: string; date: string; text: string }[] {
  if (!/<rss\b/i.test(xml) || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Official feed format changed');
  const entries = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
  if (!entries.length || entries.length > 100) throw new Error('Official feed unavailable');
  return entries.map(([_, entry]) => {
    const field = (name: string) => (new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i').exec(entry)?.[1] ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
    const date = new Date(field('pubDate')); if (!Number.isFinite(+date)) throw new Error('Official feed date changed');
    return { url: officialSourceUrl(plainText(field('link'))), date: singaporeDate(date.toISOString()), text: plainText(`${field('title')} ${field('description')}`) };
  });
}
