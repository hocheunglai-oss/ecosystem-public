import test from 'node:test';
import assert from 'node:assert/strict';
import { officialTableFeedId, type OfficialTableSnapshot } from '../shared/officialTables.ts';
import { discoverRegister, discoverReleases, parseRelease, registerRow, releaseRow, sourceDate } from '../server/official-tables/parser.ts';
import { baselineReleases, fetchOfficialSource, mediaFeed, mpaOrigin, officialSourceUrl, providerIndex } from '../server/official-tables/sources.ts';
import { refreshOfficialTable, type OfficialTableStore, type RefreshDependencies } from '../server/official-tables/refresh.ts';
import { handleOfficialTable } from '../server/official-tables/handler.ts';
import { handleOfficialTableRefresh } from '../server/official-tables/node.ts';
import { authConfig, type AuthConfig } from '../server/auth/config.ts';
import type { AdministrationGateway } from '../server/admin/handler.ts';
import { ecoConnections } from '../config/ecoConnections.ts';

const checkedAt = '2026-10-21T08:00:00.000Z';
const unavailable = (): OfficialTableSnapshot => ({ feedId: officialTableFeedId, status: 'unavailable', checkedAt: null, updatedAt: null, rows: [] });
const release = (title: string, body: string, date = '20 Oct 2026') => `<h3 data-directus="collection:media_releases_and_circulars;fields:title;mode:popover">${title}</h3><div data-directus="fields:release_date;mode:popover">Published <!-- -->${date}</div><div data-directus="fields:main_content;mode:drawer"><div>${body}</div></div><footer>Contact person: private@example.test</footer>`;
const bodies = {
  methanol: 'Licences will be awarded to Example Energy Pte Ltd and Example Fuels Pte Ltd [1]. The licences will be valid for a five-year period, from 1 January 2026 to 31 December 2030, subject to applicants meeting relevant licensing conditions.',
  ammonia: 'The authority launched a Technical Reference for Ammonia Bunkering (TR 999). The ports will validate the TR through information from bunkering trials conducted locally.',
  ethanol: 'Example Port completed an ethanol bunkering operation. Bioethanol was bunkered using a mass flow meter (MFM). Example Vessel was bunkered with approximately 2500 metric tonnes of certified bioethanol from M.T. Example Tanker.',
};
const register = { url: `${mpaOrigin}/api/media/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/List-of-licensed-LNG-bunker-suppliers---20-Oct-2026.pdf`, date: '2026-10-20' };
const pdfItems = () => [{ text: 'S/N', x: 40, y: 500, page: 1 }, { text: 'LNG Bunker Supplier', x: 60, y: 500, page: 1 }, { text: '1', x: 45, y: 480, page: 1 }, { text: '2', x: 45, y: 450, page: 1 }, { text: '600', x: 300, y: 480, page: 1 }, { text: 'Contact: private@example.test', x: 600, y: 480, page: 1 }, { text: 'Correct as at 20 Oct 2026', x: 600, y: 20, page: 1 }];
const rss = (entries = [{ title: 'General port notice', body: 'Harbour notice', slug: 'general-port-notice', date: '2026-10-20' }]) => `<rss><channel>${entries.map(item => `<item><title><![CDATA[${item.title}]]></title><description><![CDATA[${item.body}]]></description><link>${mpaOrigin}/media-centre/details/${item.slug}</link><pubDate>${new Date(item.date).toUTCString()}</pubDate></item>`).join('')}</channel></rss>`;
function sources(extra: Record<string, string> = {}) {
  const data: Record<string, string> = { [providerIndex]: `<a href="${register.url}">Register</a>`, [mediaFeed]: rss(), [register.url]: '%PDF-synthetic', ...Object.fromEntries(Object.entries(baselineReleases).map(([id, url]) => [url, release(`${id} bunkering licences`, bodies[id as keyof typeof bodies])])), ...extra };
  const deps: RefreshDependencies = { now: () => new Date(checkedAt), readPdf: async () => pdfItems(), fetchSource: async url => { assert.ok(data[url], `Unexpected official request: ${url}`); return new TextEncoder().encode(data[url]); } };
  return { data, deps };
}
test('LNG register counts the sequential number column only and verifies the dated footer', () => {
  const row = registerRow(pdfItems(), register, checkedAt);
  assert.match(row.position, /^2 licensed/); assert.doesNotMatch(JSON.stringify(row), /private@|600|Contact/);
  assert.throws(() => registerRow(pdfItems().filter(item => item.text !== '1'), register, checkedAt), /numbering/);
  assert.throws(() => registerRow(pdfItems(), { ...register, date: '2026-10-19' }, checkedAt), /date changed/);
  assert.equal(discoverRegister(`<a href="${register.url}">Latest</a><a href="${register.url.replace('20-Oct', '19-Oct')}">Old</a>`).date, '2026-10-20');
  assert.throws(() => discoverRegister('<a href="https://other.test/register.pdf">Latest</a>'), /unavailable/);
});
test('release extraction excludes surrounding contacts and preserves explicit qualifications', () => {
  for (const id of ['methanol', 'ammonia', 'ethanol'] as const) {
    const row = releaseRow(id, parseRelease(release(`${id} bunkering licences`, bodies[id]), baselineReleases[id]), checkedAt);
    assert.equal(row.publishedAt, '2026-10-20'); assert.match(row.evidenceHash, /^[a-f0-9]{64}$/); assert.doesNotMatch(JSON.stringify(row), /private@example/);
    if (id === 'methanol') { assert.match(row.position, /2026-01-01 to 2030-12-31/); assert.match(row.position, /subject to/); }
    if (id === 'ammonia') assert.match(row.position, /will validate.*trials/);
    if (id === 'ethanol') { assert.match(row.position, /2500 metric tonnes/); assert.match(row.position, /M\.T\. Example Tanker\./); assert.match(row.position, /mass flow meter/); }
  }
  assert.throws(() => parseRelease('<p>New layout</p>', baselineReleases.ammonia), /metadata/);
  assert.throws(() => releaseRow('methanol', parseRelease(release('Methanol bunkering', 'Methanol bunker trials were completed.'), baselineReleases.methanol), checkedAt), /review/);
});
test('source dates reject invalid/future days and use Singapore day at UTC midnight boundary', () => {
  assert.throws(() => sourceDate('31 Feb 2026'));
  const parsed = parseRelease(release('Ammonia bunkering', bodies.ammonia, '21 Oct 2026'), baselineReleases.ammonia);
  assert.equal(releaseRow('ammonia', parsed, '2026-10-20T17:00:00.000Z').publishedAt, '2026-10-21');
  assert.throws(() => releaseRow('ammonia', parsed, '2026-10-19T17:00:00.000Z'), /Future/);
});
test('source fetch blocks unapproved URLs, credentials, redirects, wrong types and oversized streams', async () => {
  for (const url of ['http://www.mpa.gov.sg/media-centre/details/x', 'https://www.mpa.gov.sg.other.test/media-centre/details/x', 'https://user@www.mpa.gov.sg/media-centre/details/x', `${baselineReleases.ammonia}?redirect=other`, 'https://127.0.0.1/private']) assert.throws(() => officialSourceUrl(url));
  assert.equal(officialSourceUrl('/media-centre/details/example'), `${mpaOrigin}/media-centre/details/example`);
  await assert.rejects(fetchOfficialSource(providerIndex, async () => new Response(null, { status: 302, headers: { location: 'https://example.test/private' } })), /Unapproved/);
  await assert.rejects(fetchOfficialSource(providerIndex, async () => new Response('data', { headers: { 'content-type': 'application/json' } })), /format/);
  await assert.rejects(fetchOfficialSource(providerIndex, async () => new Response('x'.repeat(2_000_001), { headers: { 'content-type': 'text/html' } })), /large/);
  let requests = 0;
  const content = await fetchOfficialSource(providerIndex, async (_url, init) => { requests++; assert.equal(init?.redirect, 'manual'); assert.ok(init?.signal); return requests === 1 ? new Response(null, { status: 302, headers: { location: baselineReleases.ammonia } }) : new Response('verified', { headers: { 'content-type': 'text/html' } }); });
  assert.equal(new TextDecoder().decode(content), 'verified'); assert.equal(requests, 2);
});
test('RSS parsing is bounded, host-restricted and never resolves XML entities', () => {
  assert.equal(discoverReleases(rss()).length, 1);
  assert.equal(discoverReleases(rss().replace(/<pubDate>[^<]+<\/pubDate>/, '<pubDate>Tue, 20 Oct 2026 16:30:00 GMT</pubDate>'))[0].date, '2026-10-21', 'RSS timestamps use the same Singapore publication day as release pages');
  for (const xml of ['<!DOCTYPE rss><rss></rss>', rss().replace(mpaOrigin, 'https://other.test'), '<rss><channel/></rss>']) assert.throws(() => discoverReleases(xml));
});
test('refresh publishes four factual rows; an unmatched newer publication preserves prior rows as stale', async () => {
  const { deps } = sources(); const writes: unknown[] = [];
  const store = { read: async () => unavailable(), publish: async (_checkedAt: string, rows: unknown) => { writes.push(rows); return { status: rows ? 'updated' : 'stale' }; } };
  assert.equal((await refreshOfficialTable(store, deps)).status, 'updated');
  assert.deepEqual((writes[0] as { id: string }[]).map(row => row.id), ['lng', 'methanol', 'ammonia', 'ethanol']);
  const newer = `${mpaOrigin}/media-centre/details/new-methanol-bunkering`;
  const changed = sources({ [mediaFeed]: rss([{ title: 'New methanol bunkering', body: 'New policy announced', slug: 'new-methanol-bunkering', date: '2026-10-21' }]), [newer]: release('New methanol bunkering', 'Terms are being reconsidered.', '21 Oct 2026') });
  assert.equal((await refreshOfficialTable(store, changed.deps)).status, 'stale'); assert.equal(writes[1], null);
  const failed = sources(); failed.deps.fetchSource = async () => { throw new Error('Private provider diagnostic'); };
  assert.equal((await refreshOfficialTable(store, failed.deps)).status, 'stale'); assert.equal(writes[2], null);
});
test('refresh discovers newer explicit facts and refuses a date regression', async () => {
  const newer = `${mpaOrigin}/media-centre/details/new-ammonia-trials`, next = sources({ [mediaFeed]: rss([{ title: 'New ammonia bunkering trials', body: 'A verified trial update', slug: 'new-ammonia-trials', date: '2026-10-21' }]), [newer]: release('New ammonia bunkering trials', 'Example Port completed ammonia bunkering trials.', '21 Oct 2026') });
  let published: any;
  const store = { read: async () => unavailable(), publish: async (_: string, rows: unknown) => { published = rows; return { status: rows ? 'updated' : 'stale' }; } };
  await refreshOfficialTable(store, next.deps); assert.equal(published[2].sourceUrl, newer); assert.match(published[2].position, /completed/);
  const old = sources(); const prior = { ...unavailable(), rows: published };
  await refreshOfficialTable({ ...store, read: async () => prior }, { ...old.deps, fetchSource: async url => url === newer ? new TextEncoder().encode(release('New ammonia bunkering trials', bodies.ammonia, '19 Oct 2026')) : old.deps.fetchSource(url) });
  assert.equal(published, null);
});
test('publication gaps preserve evidence; bootstrap, ordinary missed days and covered outages recover', async () => {
  let previous = unavailable(); const attempts: { rows: OfficialTableSnapshot['rows'] | null; reason?: string }[] = [];
  const store: OfficialTableStore = { read: async () => previous, publish: async (_time, rows, reason) => { attempts.push({ rows, reason }); return { status: rows ? 'updated' : 'stale' }; } };
  const { deps } = sources();
  assert.equal((await refreshOfficialTable(store, deps)).status, 'updated', 'Approved bootstrap does not require historical RSS coverage');
  const seed = attempts[0].rows!;
  const setCheckpoint = (time: string) => { previous = { ...unavailable(), status: 'stale', checkedAt, rows: seed.map(row => ({ ...row, publishedAt: '2026-10-01', checkedAt: time })) }; };
  setCheckpoint('2026-10-19T08:00:00.000Z');
  assert.equal((await refreshOfficialTable(store, deps)).status, 'updated', 'One missed daily run remains recoverable at 48 hours');
  setCheckpoint('2026-10-17T08:00:00.000Z');
  assert.equal((await refreshOfficialTable(store, deps)).status, 'stale');
  assert.deepEqual(attempts.at(-1), { rows: null, reason: 'publication-gap' });
  assert.equal((await refreshOfficialTable(store, deps)).status, 'stale', 'A recent failed attempt cannot advance the verified checkpoint');
  const covered = sources({ [mediaFeed]: rss([{ title: 'General port notice', body: 'Harbour notice', slug: 'general-port-notice', date: '2026-10-16' }]) });
  assert.equal((await refreshOfficialTable(store, covered.deps)).status, 'updated', 'A complete feed window permits automatic recovery after a long outage');
  setCheckpoint('2026-10-20T08:00:00.000Z');
  assert.equal((await refreshOfficialTable(store, deps)).status, 'updated', 'A reviewed service publication restores the verified checkpoint');
});
test('same-day distinct releases require review instead of silently preferring the baseline', async () => {
  const latest = `${mpaOrigin}/media-centre/details/changed-methanol-policy`;
  const changed = sources({ [mediaFeed]: rss([{ title: 'Methanol bunkering policy', body: 'Terms reconsidered', slug: 'changed-methanol-policy', date: '2026-10-20' }]), [latest]: release('Methanol bunkering policy', 'Terms are being reconsidered.') });
  let published: unknown;
  const store: OfficialTableStore = { read: async () => unavailable(), publish: async (_time, rows) => { published = rows; return { status: rows ? 'updated' : 'stale' }; } };
  assert.equal((await refreshOfficialTable(store, changed.deps)).status, 'stale'); assert.equal(published, null);
  const baselineSlug = new URL(baselineReleases.ammonia).pathname.split('/').at(-1)!;
  const duplicateDiscovery = sources({ [mediaFeed]: rss([{ title: 'Multi-fuel ammonia bunkering capabilities', body: 'Ammonia trials', slug: baselineSlug, date: '2026-10-20' }]) });
  assert.equal((await refreshOfficialTable(store, duplicateDiscovery.deps)).status, 'updated', 'The same source found by multiple routes is not ambiguous');
});
const config = { origin: 'https://example.test', deploymentOrigin: 'https://stage.example.test' } as AuthConfig;
function gateway(options: { signedIn?: boolean; active?: boolean; activated?: boolean; failure?: boolean } = {}) {
  const calls: string[] = [];
  const value: AdministrationGateway = { cookies: ['renewed=synthetic; HttpOnly'], currentUser: async () => options.signedIn === false ? null : { isActive: options.active !== false, activated: options.activated !== false } as never, getPreview: async () => ({ readOnly: true }) as never, authenticatedRpc: async <T>(name: string) => { calls.push(name); if (options.failure) throw new Error('private diagnostic'); return { snapshot: unavailable() } as T; } };
  return { value, calls };
}
test('snapshot requires active real session, permits VIEW AS reads and has no mutation surface', async () => {
  for (const options of [{ signedIn: false }, { active: false }, { activated: false }]) { const g = gateway(options); assert.equal((await handleOfficialTable(new Request(`${config.origin}/api/official-tables/snapshot`), config, g.value)).status, 401); assert.deepEqual(g.calls, []); }
  const g = gateway(), response = await handleOfficialTable(new Request(`${config.origin}/api/official-tables/snapshot`), config, g.value);
  assert.equal(response.status, 200); assert.deepEqual(g.calls, ['eco_official_table_snapshot']); assert.match(response.headers.get('cache-control')!, /private, no-store/); assert.equal(response.headers.getSetCookie().length, 1);
  for (const [path, init, status] of [['/snapshot', { method: 'POST', body: '{}' }, 405], ['/refresh', {}, 404], ['/snapshot?feed=other', {}, 400], ['/snapshot', { headers: { origin: 'https://other.test' } }, 403]] as const) assert.equal((await handleOfficialTable(new Request(`${config.origin}/api/official-tables${path}`, init), config, gateway().value)).status, status);
  const failed = await handleOfficialTable(new Request(`${config.origin}/api/official-tables/snapshot`), config, gateway({ failure: true }).value); assert.equal(failed.status, 503); assert.doesNotMatch(await failed.text(), /private diagnostic/);
});
test('cron requires secret and exact transport; disabled/mismatched ECO configuration never starts publishing', async () => {
  const secret = 'synthetic-test-secret-'.repeat(3), headers = { authorization: `Bearer ${secret}` }, url = 'https://example.test/api/official-tables/refresh'; let called = 0;
  const env = { CRON_SECRET: secret, ECO_OFFICIAL_TABLES_ENABLED: 'true' };
  const deps = { configure: () => config, store: () => ({ read: async () => unavailable(), publish: async () => ({ status: 'updated' }) }), refresh: async () => { called++; return { status: 'updated' }; } };
  assert.equal((await handleOfficialTableRefresh(new Request(url), env, deps)).status, 401);
  assert.equal((await handleOfficialTableRefresh(new Request(url, { headers: { authorization: 'Bearer incorrect' } }), env, deps)).status, 401);
  assert.equal((await handleOfficialTableRefresh(new Request(url, { method: 'POST', headers, body: '{}' }), env, deps)).status, 405);
  for (const request of [new Request(`${url}?x=1`, { headers }), new Request(url, { headers: { ...headers, origin: config.origin } }), new Request(url, { headers: { ...headers, cookie: 'session=synthetic' } }), new Request(url, { headers: { ...headers, 'content-length': '2' } })]) assert.equal((await handleOfficialTableRefresh(request, env, deps)).status, 400);
  assert.equal(called, 0);
  assert.equal((await handleOfficialTableRefresh(new Request(url, { headers }), { ...env, ECO_OFFICIAL_TABLES_ENABLED: 'false' }, deps)).status, 200); assert.equal(called, 0);
  assert.equal((await handleOfficialTableRefresh(new Request(url, { headers }), env, deps)).status, 200); assert.equal(called, 1);
  assert.throws(() => authConfig({ ECO_ORIGIN: ecoConnections.productionOrigin, ECO_SUPABASE_URL: 'https://wrong.supabase.co', ECO_SUPABASE_PUBLISHABLE_KEY: 'synthetic', ECO_SUPABASE_SECRET_KEY: 'synthetic', ECO_RATE_LIMIT_SECRET: secret }), /NOT_CONFIGURED/);
});
