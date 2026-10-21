import test from "node:test";
import assert from "node:assert/strict";
import {
  actors,
  applyAction,
  personalResources,
  type Action,
} from "../src/lib/model";
import { createSeedState, upgradeDemoState } from "../src/lib/seed";
import {
  emptyIntelligenceKeyInfo,
  INTELLIGENCE_VALUE_MAX_LENGTH,
  validateIntelligenceKeyInfo,
} from "../src/lib/intelligenceFields";
const portId = "port-singapore";
const values = {
  qualityClaim: "All",
  isoSpecs: "All",
  sampleLocation: "Vessel's manifold",
  debunkering: "No",
} as const;
const save = {
  type: "save-port-information" as const,
  portId,
  keyInfo: values,
  baseKeyInfo: createSeedState().ports[0].intelligenceKeyInfo ?? emptyIntelligenceKeyInfo(),
  reason: "New source",
};
test("all users can update Key Info; publication, audit and reward are immediate", () => {
  for (const actor of actors) {
    const s = createSeedState(),
      base = s.ports[0].intelligenceKeyInfo,
      gold = personalResources(s, actor.id).gold;
    const next = applyAction(s, { ...save, baseKeyInfo: base }, actor);
    assert.deepEqual(next.ports[0].intelligenceKeyInfo, values);
    assert.deepEqual(next.ports[0].notes, s.ports[0].notes);
    assert.equal(next.audit[0].action, "Information updated");
    assert.equal(next.contributions[0].publication, "direct");
    assert.equal(next.contributions[0].reviewer, undefined);
    assert.equal(personalResources(next, actor.id).gold, gold + 1);
    assert.deepEqual(
      upgradeDemoState(JSON.parse(JSON.stringify(next))).ports[0]
        .intelligenceKeyInfo,
      values,
    );
    assert.throws(() => applyAction(next, { ...save, baseKeyInfo: values }, actor), /No changes/);
  }
});
test("old amendment action also publishes immediately without requiring review", () => {
  const s = createSeedState(),
    actor = actors[0];
  const n = applyAction(
    s,
    {
      type: "submit-contribution",
      targetType: "port",
      targetId: portId,
      title: "Key Info",
      body: "Updated source",
      proposedKeyInfo: values,
      baseKeyInfo: s.ports[0].intelligenceKeyInfo,
    },
    actor,
  );
  assert.deepEqual(n.ports[0].intelligenceKeyInfo, values);
  assert.equal(n.contributions[0].status, "approved");
  assert.equal(
    personalResources(n, actor.id).gold,
    personalResources(s, actor.id).gold + 1,
  );
});
test("stale Key Info edits and malformed fields cannot partially publish or reward", () => {
  const s = createSeedState(),
    before = structuredClone(s);
  assert.throws(
    () =>
      applyAction(
        s,
        { ...save, baseKeyInfo: emptyIntelligenceKeyInfo() },
        actors[0],
      ),
    /changed/,
  );
  for (const keyInfo of [null, {}, [], { ...values, isoSpecs: 42 }, { ...values, extraField: "Unknown" }]) {
    assert.throws(() => validateIntelligenceKeyInfo(keyInfo), /valid/);
    assert.throws(
      () => applyAction(s, { ...save, keyInfo } as Action, actors[0]),
      /valid/,
    );
  }
  assert.deepEqual(s, before);
  assert.throws(
    () => applyAction(s, { ...save, portId: "missing" }, actors[0]),
    /valid port/,
  );
  assert.throws(
    () => applyAction(s, { ...save, reason: " " }, actors[0]),
    /Reason/,
  );
});

test("free Key Info text preserves line breaks, existing values and exact saved content within the shared bound", () => {
  const input = {
    qualityClaim: "Supplier agreement: 45 days after completion\nSubject to supporting analysis.",
    isoSpecs: "ISO 8217:2024 / RMG 380 — confirm nominated grade",
    sampleLocation: "Vessel manifold and retained barge sample — 香港",
    debunkering: "Available only after port authority approval; contact Supply.Team@example.com",
  };
  assert.deepEqual(validateIntelligenceKeyInfo(input), input);
  assert.deepEqual(validateIntelligenceKeyInfo(values), values, "Existing dropdown values remain unchanged");
  assert.deepEqual(validateIntelligenceKeyInfo({ ...input, isoSpecs: "", debunkering: " \n\t " }), { ...input, isoSpecs: null, debunkering: null });
  assert.equal(validateIntelligenceKeyInfo({ ...input, qualityClaim: "x".repeat(INTELLIGENCE_VALUE_MAX_LENGTH) }).qualityClaim?.length, INTELLIGENCE_VALUE_MAX_LENGTH);
  assert.throws(() => validateIntelligenceKeyInfo({ ...input, qualityClaim: "x".repeat(INTELLIGENCE_VALUE_MAX_LENGTH + 1) }), /1,000 characters/);
  for (const actor of actors) {
    const state = createSeedState();
    const next = applyAction(state, { ...save, baseKeyInfo: state.ports[0].intelligenceKeyInfo, keyInfo: input }, actor, "2026-10-09T08:00:00.000Z");
    const reloaded = upgradeDemoState(JSON.parse(JSON.stringify(next)));
    assert.deepEqual(reloaded.ports[0].intelligenceKeyInfo, input);
    assert.deepEqual(reloaded.contributions[0].proposedKeyInfo, input);
    assert.deepEqual(reloaded.contributions[0].proposedKeyInfo, input, 'Exact field values remain in the publication history');
    assert.match(reloaded.audit[0].detail, /contribution recorded/);
    for (const update of Object.values(reloaded.ports[0].intelligenceEntryUpdates!)) assert.deepEqual(update, { updatedBy: actor.id, updatedAt: "2026-10-09T08:00:00.000Z" });
  }
});

test("editing or clearing one free-text field preserves the other authors and rejects stale or oversized saves atomically", () => {
  const state = createSeedState();
  const first = applyAction(state, { ...save, keyInfo: { ...values, qualityClaim: "45 DAYS BY AGREEMENT" }, baseKeyInfo: state.ports[0].intelligenceKeyInfo }, actors[0], "2026-10-09T08:00:00.000Z");
  const before = first.ports[0].intelligenceKeyInfo!;
  const changed = applyAction(first, { ...save, keyInfo: { ...before, sampleLocation: "MANIFOLD\nDUPLICATE SAMPLE RETAINED" }, baseKeyInfo: before }, actors[1], "2026-10-09T09:00:00.000Z");
  for (const key of ["qualityClaim", "isoSpecs", "debunkering"] as const) assert.deepEqual(changed.ports[0].intelligenceEntryUpdates![key], first.ports[0].intelligenceEntryUpdates![key]);
  assert.deepEqual(changed.ports[0].intelligenceEntryUpdates!.sampleLocation, { updatedBy: actors[1].id, updatedAt: "2026-10-09T09:00:00.000Z" });
  const snapshot = structuredClone(changed);
  assert.throws(() => applyAction(changed, { ...save, baseKeyInfo: before, keyInfo: { ...before, debunkering: "AVAILABLE BY APPROVAL" } }, actors[0]), /Key Info changed/);
  assert.throws(() => applyAction(changed, { ...save, baseKeyInfo: changed.ports[0].intelligenceKeyInfo, keyInfo: { ...before, isoSpecs: "x".repeat(INTELLIGENCE_VALUE_MAX_LENGTH + 1) } }, actors[0]), /1,000 characters/);
  assert.deepEqual(changed, snapshot, "Rejected edits cannot publish, reward or alter history");
  const cleared = applyAction(changed, { ...save, baseKeyInfo: changed.ports[0].intelligenceKeyInfo, keyInfo: { ...changed.ports[0].intelligenceKeyInfo!, qualityClaim: "" } }, actors[1], "2026-10-09T10:00:00.000Z");
  assert.equal(cleared.ports[0].intelligenceKeyInfo!.qualityClaim, null);
  assert.deepEqual(cleared.ports[0].intelligenceEntryUpdates!.qualityClaim, { updatedBy: actors[1].id, updatedAt: "2026-10-09T10:00:00.000Z" });
  assert.deepEqual(cleared.ports[0].intelligenceEntryUpdates!.sampleLocation, changed.ports[0].intelligenceEntryUpdates!.sampleLocation);
});

test("direct and previously pending amendments accept free text with the same concurrency protection", () => {
  const state = createSeedState(), input = { ...values, debunkering: "SUBJECT TO LOCAL AUTHORITY\nAPPROVAL REQUIRED BEFORE NOMINATION" };
  const direct = applyAction(state, { type: "submit-contribution", targetType: "port", targetId: portId, title: "Key Info", body: "New terms", proposedKeyInfo: input, baseKeyInfo: state.ports[0].intelligenceKeyInfo }, actors[0], "2026-10-09T08:00:00.000Z");
  assert.deepEqual(direct.ports[0].intelligenceKeyInfo, input);
  state.contributions.unshift({ id: "pending-free-text", targetType: "port", targetId: portId, title: "Key Info", body: "Proposed terms", author: actors[0].id, createdAt: "2026-10-09T07:00:00.000Z", status: "pending", keyInfoBase: state.ports[0].intelligenceKeyInfo, proposedKeyInfo: input });
  const reviewer = actors.find(actor => actor.role === "admin")!;
  const reviewed = applyAction(state, { type: "review-contribution", id: "pending-free-text", approve: true, note: "Confirmed" }, reviewer, "2026-10-09T09:00:00.000Z");
  assert.deepEqual(reviewed.ports[0].intelligenceKeyInfo, input);
  assert.equal(reviewed.ports[0].intelligenceEntryUpdates!.debunkering!.updatedBy, reviewer.id);
  const concurrent = applyAction(state, { ...save, keyInfo: { ...values, qualityClaim: "SUPPLIER-SPECIFIC AGREEMENT" }, baseKeyInfo: state.ports[0].intelligenceKeyInfo }, actors[1]);
  const before = structuredClone(concurrent);
  assert.throws(() => applyAction(concurrent, { type: "review-contribution", id: "pending-free-text", approve: true, note: "Confirmed" }, reviewer), /Key Info changed/);
  assert.deepEqual(concurrent, before);
});
test("ordinary port updates publish to notes; feedback earns Gold without changing port facts", () => {
  const s = createSeedState(),
    actor = actors[0],
    body = "Confirm the receiving arrangement with the appointed agent.";
  const n = applyAction(
    s,
    {
      type: "submit-contribution",
      targetType: "port",
      targetId: portId,
      title: "Port note",
      body,
    },
    actor,
  );
  assert.ok(n.ports[0].notes.includes(body));
  const f = applyAction(
    n,
    {
      type: "submit-contribution",
      targetType: "feedback",
      targetId: "ecosystem",
      title: "Feedback",
      body: "Keep the enquiry visible when viewing information.",
    },
    actor,
  );
  assert.deepEqual(f.ports, n.ports);
  assert.equal(f.contributions[0].status, "approved");
  assert.equal(
    personalResources(f, actor.id).gold,
    personalResources(s, actor.id).gold + 2,
  );
});
