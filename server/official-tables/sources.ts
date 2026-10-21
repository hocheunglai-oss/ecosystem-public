export const mpaOrigin = 'https://www.mpa.gov.sg';
export const providerIndex = `${mpaOrigin}/port-marine-ops/marine-services/bunkering/bunkering-service-providers`;
export const mediaFeed = `${mpaOrigin}/feeds/media-releases`;
export const baselineReleases = {
  methanol: `${mpaOrigin}/media-centre/details/singapore-to-award-licences-for-methanol-bunkering`,
  ammonia: `${mpaOrigin}/media-centre/details/singapore-strengthens-multi-fuel-bunkering-capabilities-and-digitalisation-at-sibcon-2026`,
  ethanol: `${mpaOrigin}/media-centre/details/singapore-conducts-worlds-largest-ethanol-bunkering-operation`,
} as const;
export function officialSourceUrl(value: string): string {
  const url = new URL(value, mpaOrigin);
  if (url.origin !== mpaOrigin || url.username || url.password || url.search || url.hash ||
    !(url.href === providerIndex || url.href === mediaFeed || /^\/media-centre\/details\/[a-z0-9-]+$/i.test(url.pathname) || /^\/api\/media\/[a-f0-9-]+\/[a-zA-Z0-9%._-]+\.pdf$/i.test(url.pathname))) throw new Error('Unapproved official source');
  return url.href;
}
/** The caller cannot supply a URL; discoveries still pass the exact host/path allowlist. */
export async function fetchOfficialSource(value: string, fetcher: typeof fetch = fetch): Promise<Uint8Array> {
  let url = officialSourceUrl(value);
  const signal = AbortSignal.timeout(12_000);
  for (let redirects = 0; redirects <= 2; redirects++) {
    const response = await fetcher(url, { redirect: 'manual', signal, headers: { Accept: url.endsWith('.pdf') ? 'application/pdf' : 'text/html, application/rss+xml, application/xml' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location || redirects === 2) throw new Error('Official source redirect unavailable');
      url = officialSourceUrl(new URL(location, url).href); continue;
    }
    const pdf = url.toLowerCase().endsWith('.pdf'), max = pdf ? 4_000_000 : 2_000_000;
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > max) { await response.body?.cancel(); throw new Error('Official source unavailable'); }
    const type = response.headers.get('content-type') ?? '';
    if (pdf ? !/application\/pdf/i.test(type) : !/(?:text\/html|(?:application|text)\/(?:rss\+)?xml)/i.test(type)) { await response.body.cancel(); throw new Error('Official source format changed'); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const { done, value: chunk } = await reader.read(); if (done) break; size += chunk.length; if (size > max) throw new Error('Official source too large'); chunks.push(chunk); } }
    catch (error) { await reader.cancel(); throw error; }
    finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
    if (pdf && new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') throw new Error('Official register format changed');
    return bytes;
  }
  throw new Error('Official source unavailable');
}
