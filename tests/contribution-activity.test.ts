import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { contributionActivity, contributionHistory, contributionStatus, projectLocationPublication, mergeLocationActivity } from '../src/lib/contributionActivity';
import type { Contribution, DemoState } from '../src/lib/model';
import type { KnowledgeChange, KnowledgeDocument } from '../src/lib/knowledge';
import type { HatAward } from '../src/lib/hats';
import { emptyIntelligenceKeyInfo } from '../src/lib/intelligenceFields';

const NOW = new Date('2026-10-13T07:00:00.000Z');
function state(contributions: Contribution[] = []): DemoState {
  return { version: 1, companies: [], ports: [], enquiries: [], requests: [], outcomes: [], contributions, audit: [], drops: [], goals: [] };
}
function entry(id: string, at = '2026-10-12T03:00:00.000Z', extra: Partial<Contribution> = {}): Contribution {
  return { id, targetType: 'feedback', targetId: 'ecosystem', title: `Feedback ${id}`, body: `Useful feedback about ${id}`, author: 'otto', createdAt: at, publishedAt: at, publication: 'direct', status: 'approved', ...extra };
}
function doc(texts: Record<string, string>, version = 0): KnowledgeDocument {
  return { version, sections: [{ id: 'general', title: 'Port Information', blocks: Object.entries(texts).map(([id, text]) => ({ id, type: 'text', title: `Title ${id}`, text })) }] };
}
function change(before: Record<string, string>, after: Record<string, string>, id = 'hong-kong'): KnowledgeChange {
  return { target: { kind: 'port', id }, baseVersion: 0, baseDocument: doc(before), document: doc(after, 1) };
}
function update(id: string, before: Record<string, string>, after: Record<string, string>, at = '2026-10-12T03:00:00.000Z', author = 'otto'): Contribution {
  return entry(id, at, { author, targetType: 'port', targetId: 'hong-kong', title: 'Hong Kong', knowledgeChange: change(before, after) });
}
function hat(id: string, awardedAt: string, extra: Partial<HatAward> = {}): HatAward {
  return { id, target: { kind: 'key-info', portId: 'hong-kong', field: 'isoSpecs' }, targetKey: id, readerId: 'elena', recipientId: 'otto',
    awardedAt, update: { updatedBy: 'otto', updatedAt: '2025-01-01T00:00:00.000Z' }, ...extra };
}

test('combined port-tab publication counts Key Info when the document edit is only whitespace', () => {
  const combined = update('combined', { note: 'Existing fact' }, { note: ' Existing fact ' });
  combined.keyInfoBase = emptyIntelligenceKeyInfo();
  combined.proposedKeyInfo = { ...emptyIntelligenceKeyInfo(), isoSpecs: 'CONFIRMED SPECIFICATION' };
  assert.equal(contributionActivity(state([combined]), 'otto', '7d', NOW).total, 1);
  combined.knowledgeChange = change({ note: 'Existing fact' }, { note: 'Updated verified fact' });
  assert.equal(contributionActivity(state([combined]), 'otto', '7d', NOW).total, 1, 'Both fact types still form one contribution');
});

test('contribution tiers use exactly the requested zero, ten and eleven boundaries', () => {
  for (const [total, key, label] of [
    [0, 'inactive', 'INACTIVE'],
    [1, 'active', 'ACTIVE'],
    [10, 'active', 'ACTIVE'],
    [11, 'outstanding', 'OUTSTANDING'],
    [20, 'outstanding', 'OUTSTANDING'],
  ] as const) {
    const actual = contributionStatus(total);
    assert.equal(actual.key, key, `${total} contributions`);
    assert.equal(actual.label, label);
  }
});

test('next-status requirements end at Outstanding and never require compliments', () => {
  assert.deepEqual(contributionStatus(0).next, { key: 'active', label: 'ACTIVE', contributionsNeeded: 1 });
  assert.deepEqual(contributionStatus(1).next, { key: 'outstanding', label: 'OUTSTANDING', contributionsNeeded: 10 });
  assert.deepEqual(contributionStatus(10).next, { key: 'outstanding', label: 'OUTSTANDING', contributionsNeeded: 1 });
  assert.equal(contributionStatus(11).next, null);
});

test('seven-day status excludes older contributions and compliments never affect tiers', () => {
  const input = state(Array.from({ length: 11 }, (_, index) => entry(`published-${index}`, '2026-10-01T03:00:00Z')));
  input.hats = [hat('old', '2026-09-01T03:00:00Z')];
  const statusFor = (period: '28d' | '7d' | 'month' | 'all') => {
    const summary = contributionActivity(input, 'otto', period, NOW);
    return contributionStatus(summary.total).key;
  };
  assert.equal(statusFor('28d'), 'outstanding');
  assert.equal(statusFor('month'), 'outstanding');
  assert.equal(statusFor('7d'), 'inactive');
  assert.equal(statusFor('all'), 'outstanding');
  input.hats.push(hat('recent', '2026-10-12T03:00:00Z'));
  assert.equal(statusFor('28d'), 'outstanding');
  assert.equal(statusFor('month'), 'outstanding');
  assert.equal(statusFor('7d'), 'inactive');
});

test('authenticated profile IDs and an explicit roster count real users without accepting unknown authors', () => {
  const author = 'f4f8cfe0-c0d4-4426-a526-c693080a0297';
  const colleague = '04de09c5-11d9-407c-a151-a9ac89da7f23';
  const unknown = 'afe6fcf8-6cf3-4e36-a6b8-e2cf7b883c70';
  const input = state([
    entry('real-publication', undefined, { author }),
    entry('colleague-publication', undefined, { author: colleague }),
    entry('unrecognized-publication', undefined, { author: unknown }),
  ]);
  input.profiles = { [author]: { email: 'user@ecosystem.example', phone: '' } };
  input.hats = [hat('real-hat', '2026-10-12T01:00:00Z', { readerId: colleague, recipientId: author }),
    hat('unknown-hat', '2026-10-12T02:00:00Z', { readerId: unknown, recipientId: author })];
  assert.equal(contributionActivity(input, author, '28d', NOW).total, 1);
  assert.equal(contributionActivity(input, colleague, '28d', NOW).total, 0);
  assert.equal(contributionActivity(input, unknown, '28d', NOW).total, 0);
  const roster = [author, colleague];
  const summary = contributionActivity(input, [author, colleague, unknown], '28d', NOW, roster);
  assert.equal(summary.total, 2);
  assert.equal(summary.hatsReceived, 1);
  assert.deepEqual(summary.entries.map(item => item.author).sort(), [author, colleague].sort());
  assert.deepEqual(contributionHistory(input, colleague, NOW, roster).map(item => item.id), ['colleague-publication']);
  assert.equal(contributionActivity(input, unknown, '28d', NOW, roster).total, 0);
});

test('28-day windows use HKT inclusive midnight and current timestamp, with equal elapsed previous-period comparison', () => {
  const input = state([
    entry('start', '2026-09-15T16:00:00.000Z'),
    entry('last', NOW.toISOString()),
    entry('before', '2026-09-15T15:59:59.999Z'),
    entry('future', '2026-10-13T07:00:00.001Z'),
    entry('previous-start', '2026-08-18T16:00:00.000Z'),
    entry('previous-end', '2026-09-15T07:00:00.000Z'),
    entry('after-previous', '2026-09-15T07:00:00.001Z'),
    entry('too-old', '2026-08-18T15:59:59.999Z'),
  ]);
  const actual = contributionActivity(input, 'otto', '28d', NOW);
  assert.equal(actual.total, 2);
  assert.equal(actual.previousTotal, 2);
  assert.equal(actual.delta, 0);
  assert.equal(actual.activeDays, 2);
  assert.equal(actual.periodLabel, 'LAST 28 DAYS');
  assert.equal(actual.weeks.length, 4);
  assert.equal(actual.weeks[0].start, '2026-09-15T16:00:00.000Z');
  assert.equal(actual.weeks.at(-1)!.end, '2026-10-13T07:00:00.001Z');
  assert.equal(actual.weeks.reduce((sum, week) => sum + week.count, 0), actual.total);
});

test('7-day view has seven HKT daily bins, and all-time retains old history without a fabricated delta', () => {
  const input = state([entry('first', '2026-10-06T16:00:00.000Z'), entry('last', NOW.toISOString()), entry('older', '2025-01-01T00:00:00.000Z')]);
  const week = contributionActivity(input, 'otto', '7d', NOW);
  assert.equal(week.total, 2);
  assert.equal(week.weeks.length, 7);
  assert.deepEqual(week.weeks.map(day => day.count), [1, 0, 0, 0, 0, 0, 1]);
  const all = contributionActivity(input, 'otto', 'all', NOW);
  assert.equal(all.total, 3);
  assert.equal(all.previousTotal, 0);
  assert.equal(all.delta, 0);
  assert.equal(all.weeks.length, 4);
  assert.equal(all.weeks.reduce((sum, week) => sum + week.count, 0), 2);
});

test('seven-day tiers expire old activity at Hong Kong midnight without changing history', () => {
  const input = state([
    entry('boundary', '2026-10-06T16:00:00.000Z'),
    entry('before-boundary', '2026-10-06T15:59:59.999Z'),
    ...Array.from({ length: 10 }, (_, i) => entry(`recent-${i}`, '2026-10-12T03:00:00.000Z')),
  ]);
  const before = JSON.stringify(input);
  assert.equal(contributionStatus(contributionActivity(input, 'otto', '7d', NOW).total).key, 'outstanding');
  const nextDay = new Date('2026-10-13T16:00:00.000Z');
  assert.equal(contributionActivity(input, 'otto', '7d', nextDay).total, 10);
  assert.equal(contributionStatus(contributionActivity(input, 'otto', '7d', nextDay).total).key, 'active');
  assert.equal(contributionActivity(input, 'otto', 'all', nextDay).total, 12);
  assert.equal(JSON.stringify(input), before);
});

test('month-to-date comparison uses the same elapsed part of the preceding month, not the whole month', () => {
  const input = state([entry('this-month', '2026-09-30T16:00:00.000Z'), entry('prior', '2026-08-31T16:00:00.000Z'),
    entry('prior-boundary', '2026-09-13T07:00:00.000Z'), entry('prior-later', '2026-09-13T07:00:00.001Z')]);
  const actual = contributionActivity(input, 'otto', 'month', NOW);
  assert.equal(actual.total, 1);
  assert.equal(actual.previousTotal, 2);
  assert.equal(actual.delta, -1);
  assert.equal(actual.weeks.length, 2);
  assert.equal(actual.weeks[0].start, '2026-09-30T16:00:00.000Z');
});

test('month comparison handles a shorter previous month and HKT year boundaries', () => {
  const march = contributionActivity(state([entry('feb', '2026-02-28T15:59:59.999Z'), entry('march', '2026-02-28T16:00:00.000Z')]), 'otto', 'month', new Date('2026-03-31T07:00:00Z'));
  assert.equal(march.total, 1);
  assert.equal(march.previousTotal, 1);
  const january = contributionActivity(state([entry('dec', '2025-12-04T03:00:00Z'), entry('jan', '2026-01-04T03:00:00Z')]), 'otto', 'month', new Date('2026-01-05T03:00:00Z'));
  assert.equal(january.total, 1);
  assert.equal(january.previousTotal, 1);
});

test('repeat same-entry edits are one contribution per author and HKT day, preserving all publication IDs', () => {
  const input = state([
    update('one', { a: 'Before' }, { a: 'After' }, '2026-10-11T16:10:00Z'),
    update('two', { a: 'After' }, { a: 'Revised' }, '2026-10-12T15:59:00Z'),
    update('three', { a: 'Revised' }, { a: 'Tomorrow' }, '2026-10-12T16:00:00Z'),
    update('different-author', { a: 'Tomorrow' }, { a: 'Other author' }, '2026-10-12T16:01:00Z', 'elena'),
    update('different-entry', { b: 'Original' }, { b: 'New details' }, '2026-10-12T03:00:00Z'),
  ]);
  const history = contributionHistory(input, ['otto', 'elena'], NOW);
  assert.equal(history.length, 4);
  const grouped = history.find(item => item.id === 'one')!;
  assert.deepEqual(grouped.contributionIds, ['one', 'two']);
  assert.equal(grouped.at, '2026-10-12T15:59:00.000Z');
  assert.equal(grouped.recordCount, 1);
  assert.equal(contributionActivity(input, 'otto', '28d', NOW).activeDays, 2);
});

test('recurring structured updates count again at later document versions while an exact old revision replay does not', () => {
  const january = update('jan', { a: 'Unavailable' }, { a: 'Available' }, '2026-01-12T03:00:00Z');
  const february = update('feb', { a: 'Available' }, { a: 'Unavailable' }, '2026-02-12T03:00:00Z');
  const october = update('oct', { a: 'Unavailable' }, { a: 'Available' }, '2026-10-12T03:00:00Z');
  for (const [index, contribution] of [january, february, october].entries()) {
    contribution.knowledgeChange!.baseVersion = index + 1;
    contribution.knowledgeChange!.baseDocument.version = index + 1;
    contribution.knowledgeChange!.document.version = index + 2;
  }
  const revisionReplay = { ...structuredClone(january), id: 'jan-replay', publishedAt: '2026-10-13T02:00:00Z' };
  const idReplay = { ...structuredClone(january), publishedAt: '2026-10-13T03:00:00Z' };
  for (const middleAuthor of ['otto', 'elena']) {
    february.author = middleAuthor;
    const input = state([october, idReplay, january, revisionReplay, february]);
    const recent = contributionActivity(input, 'otto', '28d', NOW);
    assert.equal(recent.total, 1);
    assert.equal(recent.entries[0].id, 'oct');
    const lifetime = contributionActivity(input, 'otto', 'all', NOW);
    assert.equal(lifetime.total, middleAuthor === 'otto' ? 3 : 2);
    assert.deepEqual(lifetime.entries.find(item => item.id === 'jan')!.contributionIds, ['jan', 'jan-replay']);
  }
});

test('one multi-entry save joins overlapping same-day edit groups instead of counting each field', () => {
  const input = state([
    update('a', { a: 'One' }, { a: 'Two' }, '2026-10-12T00:00:00Z'),
    update('b', { b: 'One' }, { b: 'Two' }, '2026-10-12T01:00:00Z'),
    update('both', { a: 'Two', b: 'Two' }, { a: 'Three', b: 'Three' }, '2026-10-12T02:00:00Z'),
  ]);
  const entries = contributionHistory(input, 'otto', NOW);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].contributionIds, ['a', 'b', 'both']);
});

test('country-name aliases use their stored record ID without merging separate country and port records', () => {
  const first = update('country-name', { a: 'First' }, { a: 'Second' });
  first.knowledgeChange!.target = { kind: 'country', id: 'Japan' };
  const second = update('country-id', { a: 'Second' }, { a: 'Third' }, '2026-10-12T04:00:00Z');
  second.knowledgeChange!.target = { kind: 'country', id: 'jp' };
  const input = state([first, second, update('port', { a: 'First' }, { a: 'Second' })]);
  input.locationCountries = [{ id: 'jp', name: 'Japan' }];
  const actual = contributionActivity(input, 'otto', '28d', NOW);
  assert.equal(actual.total, 2);
  assert.deepEqual(actual.entries.find(item => item.id === 'country-name')!.contributionIds, ['country-name', 'country-id']);
});

test('case/spacing, attribution stamps, block order and unchanged saves do not create activity', () => {
  const format = update('format', { a: 'Agent confirmed', b: 'Second text' }, { b: ' second   TEXT ', a: '\n AGENT confirmed ' });
  format.knowledgeChange!.document.sections[0].blocks[0].update = { updatedBy: 'otto', updatedAt: NOW.toISOString() };
  const unchanged = update('unchanged', { a: 'Original' }, { a: 'Original' });
  const tabs = entry('tabs', undefined, { tabChanges: [change({ a: 'First' }, { a: 'First' })] });
  const actual = contributionActivity(state([format, unchanged, tabs]), 'otto', '28d', NOW);
  assert.equal(actual.total, 0);
});

test('table layout changes do not count but edited cell contents do', () => {
  const table: KnowledgeDocument = { version: 0, sections: [{ id: 'general', title: 'General', blocks: [{ id: 'table', type: 'table', title: 'Contacts',
    columns: [{ id: 'name', name: 'Name', width: 100 }, { id: 'tel', name: 'Telephone', width: 100 }], rows: [{ id: 'a', cells: ['Agent A', '123'] }, { id: 'b', cells: ['Agent B', '456'] }] }] }] };
  const after = structuredClone(table);
  const block = after.sections[0].blocks[0];
  if (block.type !== 'table') throw new Error('Invalid test fixture');
  block.columns.reverse(); block.columns[0].width = 500;
  block.rows.reverse(); block.rows.forEach(row => row.cells.reverse());
  const onlyLayout = entry('layout', undefined, { knowledgeChange: { target: { kind: 'supplier', id: 'supplier-a' }, baseVersion: 0, baseDocument: table, document: after } });
  assert.equal(contributionActivity(state([onlyLayout]), 'otto', '28d', NOW).total, 0);
  const changed = structuredClone(onlyLayout); changed.id = 'cell';
  const changedTable = changed.knowledgeChange!.document.sections[0].blocks[0];
  if (changedTable.type === 'table') changedTable.rows[0].cells[0] = '789';
  assert.equal(contributionActivity(state([changed]), 'otto', '28d', NOW).total, 1);
});

test('empty text cards and table scaffolds do not count as added information', () => {
  const empty = update('scaffold', {}, { card: '   ' });
  empty.knowledgeChange!.document.sections[0].blocks.push({ id: 'table', title: 'Contacts', type: 'table', columns: [{ id: 'name', name: 'Name' }], rows: [{ id: 'blank', cells: [' '] }] });
  assert.equal(contributionActivity(state([empty]), 'otto', '28d', NOW).total, 0);
});

test('Key Info changes count once per editor and port/day; format-only Key Info is excluded', () => {
  const empty = emptyIntelligenceKeyInfo(), first = { ...empty, isoSpecs: 'ISO 8217' }, second = { ...first, sampleLocation: 'Manifold' };
  const input = state([
    entry('key-1', undefined, { targetType: 'port', targetId: 'hong-kong', keyInfoBase: empty, proposedKeyInfo: first }),
    entry('key-2', '2026-10-12T04:00:00Z', { targetType: 'port', targetId: 'hong-kong', keyInfoBase: first, proposedKeyInfo: second }),
    entry('key-format', '2026-10-12T05:00:00Z', { targetType: 'port', targetId: 'hong-kong', keyInfoBase: second, proposedKeyInfo: { ...second, sampleLocation: ' manifold ' } }),
  ]);
  const actual = contributionActivity(input, 'otto', '28d', NOW);
  assert.equal(actual.total, 1);
  assert.equal(actual.entries[0].kind, 'key-info');
  assert.deepEqual(actual.entries[0].contributionIds, ['key-1', 'key-2']);
});

test('Key Info activity survives recurring state changes, including an intervening change by another author', () => {
  const unavailable = { ...emptyIntelligenceKeyInfo(), debunkering: 'Unavailable' }, available = { ...unavailable, debunkering: 'Available' };
  const january = entry('key-jan', '2026-01-12T03:00:00Z', { targetType: 'port', targetId: 'hong-kong', keyInfoBase: unavailable, proposedKeyInfo: available });
  const february = entry('key-feb', '2026-02-12T03:00:00Z', { targetType: 'port', targetId: 'hong-kong', keyInfoBase: available, proposedKeyInfo: unavailable });
  const october = entry('key-oct', '2026-10-12T03:00:00Z', { targetType: 'port', targetId: 'hong-kong', keyInfoBase: unavailable, proposedKeyInfo: available });
  const repeatedSave = { ...structuredClone(october), id: 'key-oct-copy', publishedAt: '2026-10-13T01:00:00Z' };
  const oldIdReplay = { ...structuredClone(january), publishedAt: '2026-10-13T02:00:00Z' };
  for (const middleAuthor of ['otto', 'elena']) {
    february.author = middleAuthor;
    const input = state([repeatedSave, october, entry('invalid-clock', 'invalid'), oldIdReplay, february, january]);
    const recent = contributionActivity(input, 'otto', '28d', NOW);
    assert.equal(recent.total, 1);
    assert.equal(recent.entries[0].at, '2026-10-12T03:00:00.000Z');
    assert.deepEqual(recent.entries[0].contributionIds, ['key-oct', 'key-oct-copy']);
    assert.equal(contributionActivity(input, 'otto', 'all', NOW).total, middleAuthor === 'otto' ? 3 : 2);
    assert.equal(contributionActivity(input, ['otto', 'elena'], 'all', NOW).total, 3);
  }
});

test('AI Key Info cycles observe other editors and immutable batch replay cannot advance their transition history', () => {
  const unavailable = { ...emptyIntelligenceKeyInfo(), debunkering: 'Unavailable' }, available = { ...unavailable, debunkering: 'Available' };
  const imported = entry('ai-jan', '2026-01-12T03:00:00Z', { extractionBatch: { id: 'january-batch', changes: [], intelligenceChanges: [{ portId: 'hong-kong', baseKeyInfo: unavailable, keyInfo: available }] } });
  const intervening = entry('other-editor', '2026-02-12T03:00:00Z', { author: 'elena', targetType: 'port', targetId: 'hong-kong', keyInfoBase: available, proposedKeyInfo: unavailable });
  const repeatedBatch = { ...structuredClone(imported), id: 'ai-replay', publishedAt: '2026-10-11T03:00:00Z' };
  const october = entry('ai-oct', '2026-10-12T03:00:00Z', { extractionBatch: { id: 'october-batch', changes: [], intelligenceChanges: [{ portId: 'hong-kong', baseKeyInfo: unavailable, keyInfo: available }] } });
  const input = state([imported, intervening, repeatedBatch, october]);
  assert.equal(contributionActivity(input, 'otto', '28d', NOW).total, 1);
  const lifetime = contributionActivity(input, 'otto', 'all', NOW);
  assert.equal(lifetime.total, 2);
  assert.deepEqual(lifetime.entries.find(item => item.id === 'ai-jan')!.contributionIds, ['ai-jan', 'ai-replay']);
  assert.equal(lifetime.entries.find(item => item.id === 'ai-oct')!.recordCount, 1);
});

test('AI imports are one contribution per batch with a distinct changed-profile count', () => {
  const empty = emptyIntelligenceKeyInfo();
  const ai = entry('ai', undefined, { extractionBatch: { id: 'batch-a', changes: [change({ a: 'Old' }, { a: 'New' }), change({ a: 'Old' }, { a: 'New' }, 'singapore'), change({ a: 'Same' }, { a: ' SAME ' }, 'osaka')],
    intelligenceChanges: [{ portId: 'hong-kong', baseKeyInfo: empty, keyInfo: { ...empty, isoSpecs: 'ISO 8217' } }] } });
  const replay = { ...ai, id: 'ai-replayed', publishedAt: '2026-10-13T05:00:00Z' };
  const actual = contributionActivity(state([ai, replay]), 'otto', '28d', NOW);
  assert.equal(actual.total, 1);
  assert.equal(actual.entries[0].kind, 'ai-import');
  assert.equal(actual.entries[0].recordCount, 2);
  assert.deepEqual(actual.entries[0].contributionIds, ['ai', 'ai-replayed']);
  assert.equal(actual.entries[0].at, '2026-10-12T03:00:00.000Z');
});

test('pending, declined, unknown authors, invalid/future timestamps and duplicate publications are excluded', () => {
  const approved = entry('approved');
  const input = state([approved, structuredClone(approved), { ...approved, id: 'duplicate-body', title: 'Renamed title' },
    entry('pending', undefined, { status: 'pending' }), entry('declined', undefined, { status: 'declined' }),
    entry('unknown', undefined, { author: 'unknown' }), entry('future', '2026-10-14T00:00:00Z'), entry('invalid', 'invalid'), entry('empty', undefined, { body: ' ' })]);
  assert.equal(contributionActivity(input, 'otto', '28d', NOW).total, 1);
  assert.equal(contributionActivity(input, 'unknown', 'all', NOW).total, 0);
});

test('older reviewed contributions use their publication/review date rather than submission date', () => {
  const reviewed = entry('reviewed', '2025-01-01T00:00:00Z', { publishedAt: undefined, publication: undefined, reviewedAt: '2026-10-12T01:00:00Z' });
  assert.equal(contributionActivity(state([reviewed]), 'otto', '28d', NOW).total, 1);
});

test('legacy contribution evidence counts records once, never reward amounts or Gold grants', () => {
  const input = state([entry('recorded')]);
  input.drops = [
    { id: 'seed', key: 'seed:case-study', at: '2026-10-12T02:00:00Z', owner: 'otto', amount: 50, reason: 'Accepted case study' },
    { id: 'seed-copy', key: 'seed:case-study', at: '2026-10-12T02:00:00Z', owner: 'otto', amount: 50, reason: 'Same case study' },
    { id: 'old', key: 'contribution:archived', at: '2026-10-12T02:00:00Z', owner: 'otto', amount: 20, reason: 'Accepted information' },
    { id: 'exists', key: 'contribution:recorded', at: '2026-10-12T02:00:00Z', owner: 'otto', amount: 20, reason: 'Already recorded' },
    { id: 'transport', key: 'transport:one', at: '2026-10-12T02:00:00Z', owner: 'otto', amount: 5000, reason: 'Transport reward' },
  ];
  input.economy = { version: 2, grants: [{ id: 'grant', key: 'starter', at: '2026-10-12T02:00:00Z', owner: 'otto', resource: 'gold', amount: 9000, reason: 'Starter balance', teamId: 'team-gianmichele', source: 'demo' }] };
  const actual = contributionActivity(input, 'otto', '28d', NOW);
  assert.equal(actual.total, 3);
  assert.deepEqual(actual.entries.find(item => item.id === 'legacy:contribution:archived')?.contributionIds, ['archived']);
});

test('Hats count the received date and original recipient separately, excluding self, undone, duplicated and future awards', () => {
  const input = state();
  const first = hat('first', '2026-10-12T01:00:00Z');
  input.hats = [first, { ...first, id: 'duplicate' }, hat('second', NOW.toISOString(), { readerId: 'marco' }),
    hat('old', '2026-09-15T15:59:59Z'), hat('future', '2026-10-13T07:00:00.001Z'),
    hat('self', '2026-10-12T01:00:00Z', { readerId: 'otto' }), hat('unknown', '2026-10-12T01:00:00Z', { readerId: 'unknown' }),
    hat('undone', '2026-10-12T01:00:00Z', { undoneAt: '2026-10-12T02:00:00Z' }),
    hat('other-recipient', '2026-10-12T01:00:00Z', { recipientId: 'gianmichele', update: { updatedBy: 'gianmichele', updatedAt: '2025-01-01T00:00:00Z' } })];
  const actual = contributionActivity(input, 'otto', '28d', NOW);
  assert.equal(actual.total, 0);
  assert.equal(actual.hatsReceived, 2);
  assert.equal(contributionActivity(input, ['otto', 'gianmichele'], '28d', NOW).hatsReceived, 3);
  assert.equal(contributionActivity(input, 'otto', 'all', NOW).hatsReceived, 3);
});

test('summaries preserve input publications, original audit, legacy records and Hat attribution', () => {
  const input = state([update('one', { a: 'Old' }, { a: 'New' }), entry('feedback')]);
  input.hats = [hat('one', '2026-10-12T01:00:00Z')];
  const before = structuredClone(input);
  for (const period of ['28d', '7d', 'month', 'all'] as const) contributionActivity(input, ['otto', 'otto', 'unknown'], period, NOW);
  assert.deepEqual(input, before);
});


test('hashed publication facts preserve full-payload grouping, recurring edits, batches and exclusions', async () => {
  const contributions = [
    update('a', { a: 'Before' }, { a: 'After' }, '2026-10-11T17:00:00Z'),
    update('b', { b: 'Before' }, { b: 'After' }, '2026-10-11T18:00:00Z'),
    update('both', { a: 'After', b: 'After' }, { a: 'Revised', b: 'Revised' }, '2026-10-11T19:00:00Z'),
    update('replay', { a: 'Before' }, { a: 'After' }, '2026-10-12T17:00:00Z'),
    entry('legacy', '2026-10-12T00:00:00Z', { targetType: 'country', targetId: 'Singapore', historicalImport: true }),
    entry('pending', undefined, { status: 'pending' }),
    entry('tabs', undefined, { tabChanges: [change({ a: 'First' }, { a: 'First' })] }),
  ];
  const empty = emptyIntelligenceKeyInfo(), filled = { ...empty, isoSpecs: 'ISO EXAMPLE' };
  contributions.push(entry('key-a', '2026-10-08T00:00:00Z', { targetType: 'port', targetId: 'hong-kong', keyInfoBase: empty, proposedKeyInfo: filled }),
    entry('key-b', '2026-10-09T00:00:00Z', { author: 'elena', targetType: 'port', targetId: 'hong-kong', keyInfoBase: filled, proposedKeyInfo: empty }),
    entry('key-c', '2026-10-10T00:00:00Z', { targetType: 'port', targetId: 'hong-kong', keyInfoBase: empty, proposedKeyInfo: filled }));
  const batch = entry('batch', '2026-10-12T01:00:00Z', { targetType: 'port', targetId: 'hong-kong', extractionBatch: { id: 'batch-1', changes: [change({ z: 'Before' }, { z: 'After' })], intelligenceChanges: [] } });
  contributions.push(batch, { ...batch, id: 'batch-retry', publishedAt: '2026-10-13T01:00:00Z' });
  const full = state(contributions), compact = state(await Promise.all(contributions.map(async contribution => {
    const { knowledgeChange: _c, tabChanges: _t, extractionBatch: _e, proposedKeyInfo: _p, keyInfoBase: _b, ...metadata } = contribution;
    return { ...metadata, body: '', locationPublication: await projectLocationPublication(full, contribution, value => createHash('sha256').update(value).digest('hex')) };
  })));
  for (const actor of ['otto', 'elena']) for (const period of ['7d', '28d', 'month', 'all'] as const) assert.deepEqual(contributionActivity(compact, actor, period, NOW), contributionActivity(full, actor, period, NOW));
  assert.doesNotMatch(JSON.stringify(compact), /ISO EXAMPLE|Before|Revised/);
});

test('remote complete totals merge with local entries without counting only the loaded page or duplicating active days', () => {
  const local = contributionActivity(state([entry('local', '2026-10-11T16:00:00Z')]), 'otto', '7d', NOW);
  local.hatsReceived = 3;
  const remote = contributionActivity(state([entry('remote1', '2026-10-11T17:00:00Z'), entry('remote2', '2026-10-12T17:00:00Z')]), 'otto', '7d', NOW);
  remote.hatsReceived = 50;
  const result = mergeLocationActivity(local, { summary: { ...remote, entries: remote.entries.slice(0, 1) }, activeDates: ['2026-10-12', '2026-10-13'] });
  assert.equal(result.total, 3); assert.equal(result.activeDays, 2); assert.equal(result.entries.length, 2); assert.equal(result.hatsReceived, 3);
  assert.equal(result.weeks.reduce((sum, week) => sum + week.count, 0), 3);
  assert.equal(mergeLocationActivity(local, null), local);
});
