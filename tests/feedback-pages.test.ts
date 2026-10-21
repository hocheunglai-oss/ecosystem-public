import test from 'node:test';
import assert from 'node:assert/strict';
import { actors, applyAction, personalResources, type Action } from '../src/lib/model';
import { createSeedState, upgradeDemoState } from '../src/lib/seed';
import { feedbackPages, workspacePages, workspaceGroups, workspaceTitles, type WorkspaceId } from '../src/workspaceNavigation';

const actor = actors[0];
const now = '2026-10-09T08:00:00Z';
const feedback = { type: 'submit-contribution' as const, targetType: 'feedback' as const, targetId: 'ecosystem', title: 'Page selector feedback', body: 'Keep the selected page beside this feedback when reviewing it later.' };

test('feedback pages and launcher labels follow the workspace registry without duplicate aliases', () => {
  assert.deepEqual(feedbackPages, [{ id: 'home', label: 'Home' }, ...Object.entries(workspacePages)
    .filter(([, page]) => !('aliasOf' in page)).map(([id, page]) => ({ id, label: page.label }))]);
  assert.equal(new Set(feedbackPages.map(page => page.id)).size, feedbackPages.length);
  assert.equal(feedbackPages.filter(page => page.label === 'Countries & Ports').length, 1);
  for (const group of workspaceGroups) for (const page of group.items) {
    assert.equal(page.label, workspaceTitles[page.id]);
    assert.deepEqual(feedbackPages.find(item => item.id === page.id), page);
  }
  for (const id of Object.keys(workspacePages) as WorkspaceId[]) assert.ok(workspaceTitles[id]);
});

test('a page is optional and both tagged and untagged feedback keep the one Gold reward', () => {
  for (const page of [undefined, ...feedbackPages]) {
    const state = createSeedState();
    const before = personalResources(state, actor.id).gold;
    const next = applyAction(state, { ...feedback, feedbackPageId: page?.id }, actor, now);
    const record = next.contributions[0];
    assert.deepEqual(record.feedbackPage, page);
    if (page) assert.notEqual(record.feedbackPage, page, 'Store a label snapshot, not shared registry data');
    assert.equal(record.body, feedback.body);
    assert.equal(record.source, undefined);
    assert.equal(record.status, 'approved');
    assert.equal(personalResources(next, actor.id).gold, before + 1);
    const restored = upgradeDemoState(JSON.parse(JSON.stringify(next)));
    assert.deepEqual(restored.contributions[0].feedbackPage, page);
  }
});

test('invalid pages and pages attached to knowledge fail without changing state', () => {
  const state = createSeedState();
  const original = structuredClone(state);
  for (const id of ['', 'unknown-page', 'countries', 'achievements', 123, null]) {
    assert.throws(() => applyAction(state, { ...feedback, feedbackPageId: id } as Action, actor, now), /valid feedback page/);
  }
  assert.throws(() => applyAction(state, { ...feedback, targetType: 'port', targetId: state.ports[0].id, feedbackPageId: 'ports' }, actor, now), /only available for feedback/);
  assert.deepEqual(state, original);
});

test('changing the page cannot award Gold again for duplicate feedback', () => {
  const next = applyAction(createSeedState(), { ...feedback, feedbackPageId: 'enquiry' }, actor, now);
  assert.throws(() => applyAction(next, { ...feedback, feedbackPageId: 'fixtures' }, actor, now), /already been submitted/);
});
