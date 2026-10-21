/// <reference path="./pdf-worker.d.ts" />
import type { OfficialTableRow, OfficialTableSnapshot } from '../../shared/officialTables.ts';
import { baselineReleases, fetchOfficialSource, mediaFeed, providerIndex } from './sources.ts';
import { discoverRegister, discoverReleases, parseRelease, registerRow, releaseRow, type PdfText } from './parser.ts';

export interface OfficialTableStore {
  read(): Promise<OfficialTableSnapshot>;
  publish(checkedAt: string, rows: OfficialTableRow[] | null, failureReason?: 'source-unavailable' | 'publication-gap'): Promise<{ status: string }>;
}
class PublicationGap extends Error {}
function checkPublicationCoverage(previous: OfficialTableSnapshot, releases: { date: string }[], checkedAt: string) {
  // Bootstrap uses the approved source set. Failed attempts never advance this checkpoint.
  if (!previous.rows.length) return;
  const verified = Math.min(...previous.rows.map(row => Date.parse(row.checkedAt)));
  if (!Number.isFinite(verified)) throw new PublicationGap();
  if (Date.parse(checkedAt) - verified <= 48 * 3600000) return;
  const verifiedDay = new Date(verified + 8 * 3600000).toISOString().slice(0, 10);
  const oldestFeedDay = releases.map(item => item.date).sort()[0];
  if (!oldestFeedDay || oldestFeedDay > verifiedDay) throw new PublicationGap();
}
export async function readRegisterPdf(bytes: Uint8Array): Promise<PdfText[]> {
  // Literal import makes the Node worker traceable by the serverless bundler.
  await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: bytes, useSystemFonts: false, disableFontFace: true, stopAtErrors: true });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 10) throw new Error('Official register too long');
    const result: PdfText[] = [];
    for (let page = 1; page <= pdf.numPages; page++) {
      const content = await (await pdf.getPage(page)).getTextContent();
      for (const item of content.items) if ('str' in item) result.push({ text: item.str, x: item.transform[4], y: item.transform[5], page });
      if (result.length > 20_000) throw new Error('Official register too large');
    }
    return result;
  } finally { await task.destroy(); }
}
export interface RefreshDependencies { fetchSource: typeof fetchOfficialSource; readPdf: typeof readRegisterPdf; now: () => Date }
const defaults: RefreshDependencies = { fetchSource: fetchOfficialSource, readPdf: readRegisterPdf, now: () => new Date() };
export async function refreshOfficialTable(store: OfficialTableStore, deps: RefreshDependencies = defaults) {
  const checkedAt = deps.now().toISOString();
  const previous = await store.read();
  try {
    const text = async (url: string) => new TextDecoder().decode(await deps.fetchSource(url));
    const [index, feed] = await Promise.all([text(providerIndex), text(mediaFeed)]);
    const register = discoverRegister(index), releases = discoverReleases(feed);
    checkPublicationCoverage(previous, releases, checkedAt);
    const rows: OfficialTableRow[] = [registerRow(await deps.readPdf(await deps.fetchSource(register.url)), register, checkedAt)];
    const cache = new Map<string, Promise<ReturnType<typeof parseRelease>>>();
    const load = (url: string) => { if (!cache.has(url)) cache.set(url, text(url).then(html => parseRelease(html, url))); return cache.get(url)!; };
    const broad = releases.filter(item => /multi.fuel|alternative.fuel|bunkering capabilities/i.test(item.text)).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3);
    const broadPages = await Promise.all(broad.map(item => load(item.url)));
    rows.push(...await Promise.all((['methanol', 'ammonia', 'ethanol'] as const).map(async id => {
      const relevance = id === 'methanol' ? /methanol.{0,180}(?:licen[cs]|bunker)|(?:licen[cs]|bunker).{0,180}methanol/i : new RegExp(`${id}.{0,180}bunker|bunker.{0,180}${id}`, 'i');
      const candidates = releases.filter(item => relevance.test(item.text)).sort((a, b) => b.date.localeCompare(a.date));
      const urls = new Set([baselineReleases[id], previous.rows.find(row => row.id === id)?.sourceUrl, ...candidates.slice(0, 2).map(item => item.url)].filter((url): url is string => Boolean(url)));
      const relevantBroad = broadPages.filter(page => id === 'methanol' ? /methanol/i.test(page.title) || /methanol.{0,180}licen[cs]|licen[cs].{0,180}methanol/i.test(page.body) : new RegExp(id, 'i').test(page.body));
      const pages = [...await Promise.all([...urls].map(load)), ...relevantBroad].sort((a, b) => b.date.localeCompare(a.date));
      const newest = pages[0];
      if (new Set(pages.filter(page => page.date === newest.date).map(page => page.url)).size > 1) throw new Error('Same-day official releases require review');
      if (candidates[0] && candidates[0].date > newest.date) throw new Error('Feed and release date disagree');
      // A newly discovered publication must parse successfully; no fallback to an older, easier sentence.
      return releaseRow(id, newest, checkedAt);
    })));
    for (const row of rows) { const old = previous.rows.find(item => item.id === row.id); if (old && row.publishedAt < old.publishedAt) throw new Error('Official source date regressed'); }
    return await store.publish(checkedAt, rows);
  } catch (error) {
    // Do not persist/log raw pages, contacts, provider errors, or incomplete factual rows.
    return await store.publish(checkedAt, null, error instanceof PublicationGap ? 'publication-gap' : 'source-unavailable');
  }
}
