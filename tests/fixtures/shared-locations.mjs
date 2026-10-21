import { tsImport } from 'tsx/esm/api';

const domain = await tsImport('./shared-location-domain.ts', import.meta.url);
const { createLiveState } = domain;
const fixtures = new WeakMap();

/** Synthetic database paging uses immutable insertion sequence, as the SQL archive does. */
export function locationHistoryPage(history, { targets, cursor = null }) {
  const matches = history.map((item, index) => ({ item, sequence: index + 1 }))
    .filter(({ item }) => targets.some(target => target.kind === item.target.kind && target.id === item.target.id));
  const remaining = matches.filter(({ sequence }) => cursor === null || sequence < Number(cursor)).reverse();
  const items = []; let used = 0, last = null;
  for (const row of remaining) {
    const bytes = Buffer.byteLength(JSON.stringify(row.item));
    if (items.length >= 20 || items.length && used + bytes > 3_200_000) break;
    if (bytes > 3_200_000) throw new Error('Synthetic archive record exceeds the history page bound.');
    items.push(structuredClone(row.item)); used += bytes; last = row.sequence;
  }
  return { items, nextCursor: remaining.length > items.length ? String(last) : null, total: matches.length };
}


/** Isolated authenticated server fixture, never a production/browser fallback.
 * All reads/writes run through the same pure location domain used by the API. */
export async function installSharedLocations(context, { user, preview = () => null } = {}) {
  if (typeof user !== 'function' || typeof preview !== 'function') throw new Error('Provide the fixture session explicitly.');
  let envelope = { revision: 0, snapshot: domain.initialLocationSnapshot(), importedSources: [] };
  let archive = { history: [], contributions: [], historicalContributionIds: [], publications: [] }, pendingProjection = Promise.resolve();
  const fullSnapshot = () => ({ ...structuredClone(envelope.snapshot), knowledgeHistory: structuredClone(archive.history), contributions: archive.contributions.map(({historicalImport: _imported, ...record}) => structuredClone(record)), historicalContributionIds: [...archive.historicalContributionIds] });
  const mergeArchive = split => {
    const next = structuredClone(archive);
    for (const record of split.history) {
      const previous = next.history.find(row => row.target.kind === record.target.kind && row.target.id === record.target.id && row.version === record.version);
      if (previous && JSON.stringify(previous) !== JSON.stringify(record)) throw new Error('Archived history conflicts with shared records.');
      if (!previous) next.history.push(structuredClone(record));
    }
    for (const field of ['contributions', 'publications']) for (const record of split[field]) {
      const index = next[field].findIndex(row => row.id === record.id);
      if (index < 0) next[field].push(structuredClone(record)); else next[field][index] = structuredClone(record);
    }
    next.historicalContributionIds = next.publications.filter(row => row.historicalImport).map(row => row.id);
    archive = next;
  };
  const seedSnapshot = full => {
    archive = { history: structuredClone(full.knowledgeHistory), contributions: structuredClone(full.contributions), historicalContributionIds: [...full.historicalContributionIds], publications: [] };
    envelope = { ...envelope, revision: envelope.revision + 1, snapshot: { ...structuredClone(full), knowledgeHistory: [], contributions: [], historicalContributionIds: [] } };
    const seededArchive = archive;
    pendingProjection = domain.splitLocationSnapshot(full).then(split => { if (archive === seededArchive) { archive.publications = split.publications; envelope = { ...envelope, snapshot: split.snapshot }; } });
  };
  const receipts = new Map();
  const fixture = {
    requests: [], historyRequests: [], reads: 0, failRead: false, failWrite: false,
    snapshot: fullSnapshot,
    archive: () => structuredClone(archive),
    envelope: () => structuredClone(envelope),
    state: () => domain.locationStateWithSnapshot(createLiveState(), fullSnapshot()),
    async browserState(page, ownerId) {
      // Shared assertions read the server fixture; unrelated local hats, buyer
      // data and outcomes are still inspected from their actual v2 projection.
      const local = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), `ecosystem.live.v1:${encodeURIComponent(ownerId)}:state:v2`);
      if (!local) throw new Error('Wait for the live v2 local projection before comparing unrelated records.');
      return domain.locationStateWithSnapshot(local, fullSnapshot());
    },
    seed(callback, argument) {
      const local = fixture.state(), result = callback(local, argument);
      seedSnapshot(domain.locationSnapshotFromState(local));
      receipts.clear();
      return result;
    },
    seedState(local) { seedSnapshot(domain.locationSnapshotFromState(local)); envelope.importedSources = []; receipts.clear(); },
  };
  fixtures.set(context, fixture);
  await context.route('**/api/location-knowledge/**', async route => {
    await pendingProjection;
    const request = route.request(), url = new URL(request.url()), actor = user();
    const respond = (json, status = 200) => route.fulfill({ status, json, headers: { 'cache-control': 'private, no-store' } });
    const input = request.method() === 'POST' ? request.postDataJSON() : null;
    if (input) fixture.requests.push(structuredClone(input));
    if (url.pathname.endsWith('/list')) { fixture.reads++; if (fixture.failRead) return respond({ message: 'Shared location information is unavailable.' }, 503); }
    if (input && fixture.failWrite) return respond({ message: 'Shared location information is unavailable.' }, 503);
    const payload = JSON.stringify({ path: url.pathname, body: input }), receiptKey = `${actor?.id}:${input?.requestId}`;
    const gateway = { cookies: [], currentUser: async () => actor, getPreview: async () => preview(), authenticatedRpc: async (name, args = {}) => {
      if (name === 'eco_location_knowledge_context') return { envelope: fixture.envelope(), actorId: actor?.id, sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', aal: 'aal1' };
      if (name === 'eco_location_knowledge_history') { fixture.historyRequests.push(structuredClone(args)); return locationHistoryPage(archive.history, { targets: args.p_targets, cursor: args.p_cursor }); }
      if (name === 'eco_location_knowledge_contribution') { const item = archive.contributions.find(row => row.id === args.p_id); if (!item) throw new domain.ApiError(404, 'Contribution not found.'); return { item: structuredClone(item) }; }
      if (name === 'eco_location_knowledge_pending') {
        const rows = archive.contributions.filter(row => row.status === 'pending').sort((a,b) => a.id.localeCompare(b.id));
        const selected = rows.filter(row => !args.p_cursor || row.id > args.p_cursor), items = []; let used = 0;
        for (const row of selected) { const bytes = Buffer.byteLength(JSON.stringify(row)); if (items.length >= 20 || items.length && used + bytes > 3_200_000) break; if (bytes > 3_200_000) throw new domain.ApiError(503, 'Contribution too large.'); items.push(row); used += bytes; }
        return { items, nextCursor: selected.length > items.length ? items.at(-1).id : null, total: rows.length };
      }
      if (name === 'eco_location_knowledge_publications') {
        if (args.p_revision !== null && args.p_revision !== envelope.revision) throw new domain.ApiError(409, 'Activity changed. Reload and try again.');
        const offset = Number(args.p_after ?? 0), items = archive.publications.slice(offset, offset + 500);
        return { revision: envelope.revision, items, nextCursor: offset + items.length < archive.publications.length ? String(offset + items.length) : null, directoryIds: offset === 0 ? [...new Set([actor.id, ...archive.publications.map(row => row.author)])] : [] };
      }
      throw new Error('Unconfigured synthetic location RPC.');
    } };
    const store = {
      prepare: async () => {
        const receipt = receipts.get(receiptKey);
        if (receipt) { if (receipt.payload !== payload) throw new domain.ApiError(409, 'Request reference was already used.'); return { result: { ...fixture.envelope(), ack: { requestId: input.requestId, committedRevision: receipt.committedRevision } } }; }
        return { envelope: fixture.envelope(), actor, contributions: input?.action?.type === 'review-contribution' ? archive.contributions.filter(row => row.id === input.action.id) : [] };
      },
      commit: async (_identity, _actorRevision, operation, body, snapshot, digest, split) => {
        if (body.revision !== envelope.revision) throw new domain.ApiError(409, 'This information changed. Reload and review your update.');
        mergeArchive(split);
        envelope = { revision: envelope.revision + 1, snapshot, importedSources: [...envelope.importedSources, ...(operation === 'migrate' ? [{ digest, requestId: body.requestId, importedBy: actor.id, importedAt: new Date().toISOString() }] : [])] };
        receipts.set(receiptKey, { payload, committedRevision: envelope.revision });
        return { ...fixture.envelope(), ack: { requestId: body.requestId, committedRevision: envelope.revision } };
      },
    };
    const response = await domain.handleLocationKnowledge(new Request(request.url(), { method: request.method(), headers: request.headers(), ...(input ? { body: JSON.stringify(input) } : {}) }), { origin: url.origin }, gateway, store);
    return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
  });
  return fixture;
}

export function sharedLocations(pageOrContext) {
  const context = typeof pageOrContext.context === 'function' ? pageOrContext.context() : pageOrContext;
  const fixture = fixtures.get(context);
  if (!fixture) throw new Error('Install the isolated shared location fixture before opening the workspace.');
  return fixture;
}
