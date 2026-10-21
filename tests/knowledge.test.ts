import test from "node:test";
import assert from "node:assert/strict";
import { createSeedState, upgradeDemoState } from "../src/lib/seed";
import {
  actors,
  applyAction,
  personalResources,
  resourceHistory,
} from "../src/lib/model";
import {
  knowledgeDocument,
  knowledgeKey,
  validateKnowledge,
  pasteKnowledgeTable,
  type KnowledgeChange,
  type KnowledgeBlock,
} from "../src/lib/knowledge";
const target = { kind: "port" as const, id: "port-hong-kong" };
function change(state = createSeedState()): KnowledgeChange {
  const base = knowledgeDocument(state, target),
    document = structuredClone(base);
  document.sections.push({
    id: "extra",
    title: "Additional information",
    blocks: [
      {
        id: "extra-text",
        type: "text",
        title: "Note",
        text: "Updated delivery arrangements.",
      },
    ],
  });
  return {
    target: { ...target },
    baseVersion: base.version,
    baseDocument: base,
    document,
  };
}
test("every role publishes information and earns exactly one immediate Gold without a reviewer", () => {
  for (const actor of actors) {
    const state = createSeedState(),
      gold = personalResources(state, actor.id).gold,
      edit = change(state);
    const originalRecords = structuredClone(state.knowledgeRecords);
    const next = applyAction(
      state,
      { type: "save-knowledge", change: edit, reason: "Updated source" },
      actor,
    );
    assert.equal(knowledgeDocument(next, target).version, 1);
    assert.equal(next.contributions[0].status, "approved");
    assert.equal(next.contributions[0].publication, "direct");
    assert.equal(next.contributions[0].reviewer, undefined);
    assert.equal(personalResources(next, actor.id).gold, gold + 1);
    assert.equal(next.knowledgeHistory?.[0].by, actor.id);
    assert.throws(
      () =>
        applyAction(
          next,
          { type: "save-knowledge", change: edit, reason: "Retry" },
          actor,
        ),
      /Information changed/,
    );
    assert.equal(
      resourceHistory(next, actor.id).filter(
        (e) => e.key === `gold:contribution:${next.contributions[0].id}`,
      ).length,
      1,
    );
    assert.deepEqual(state.knowledgeRecords, originalRecords);
  }
});
test("stale drafts, unchanged saves and invalid targets cannot publish or earn rewards", () => {
  const actor = actors[0],
    state = createSeedState(),
    edit = change(state);
  const saved = applyAction(
    state,
    { type: "save-knowledge", change: edit, reason: "Update" },
    actor,
  );
  assert.throws(
    () =>
      applyAction(
        saved,
        { type: "save-knowledge", change: edit, reason: "Stale" },
        actor,
      ),
    /Information changed/,
  );
  const doc = knowledgeDocument(saved, target);
  assert.throws(
    () =>
      applyAction(
        saved,
        {
          type: "save-knowledge",
          change: {
            target,
            baseVersion: doc.version,
            baseDocument: doc,
            document: doc,
          },
          reason: "No change",
        },
        actor,
      ),
    /No changes/,
  );
  edit.target.id = "bad";
  assert.throws(
    () =>
      applyAction(
        state,
        { type: "save-knowledge", change: edit, reason: "Bad" },
        actor,
      ),
    /valid/,
  );
});
test("country and port views own distinct records", () => {
  const s = createSeedState();
  for (const [id, name] of [
    ["port-singapore", "Singapore"],
    ["port-hong-kong", "Hong Kong"],
  ])
    assert.notEqual(
      knowledgeKey(s, { kind: "port", id }),
      knowledgeKey(s, { kind: "country", id: name }),
    );
  assert.notEqual(
    knowledgeKey(s, { kind: "port", id: "port-rotterdam" }),
    knowledgeKey(s, { kind: "country", id: "Netherlands" }),
  );
});
test("port keeps editable operational sections and an empty supplier tab without fictional entries", () => {
  const d = knowledgeDocument(createSeedState(), target);
  assert.ok(d.sections.length >= 7);
  assert.deepEqual(d.sections.find((s) => s.id === "suppliers")?.blocks, []);
  assert.ok(d.sections.some(section => section.id === 'grades-delivery' && section.blocks.some(block => block.id === 'demo-v2-grade-planning' && block.type === 'table')));
  validateKnowledge(d);
});
test("migration expands older records once without overwriting user data or restoring later deletions", () => {
  const s = createSeedState();
  delete s.knowledgeLayoutVersion;
  const doc = knowledgeDocument(s, target);
  s.knowledgeRecords = {
    [knowledgeKey(s, target)]: {
      version: 3,
      sections: [{ ...doc.sections[0], title: "My notes" }],
    },
  };
  const upgraded = upgradeDemoState(s),
    d = knowledgeDocument(upgraded, target);
  assert.equal(d.sections.find(section => section.title === "My notes")?.id, "general");
  assert.equal(d.version, 4);
  upgraded.knowledgeRecords![knowledgeKey(upgraded, target)]!.sections = d.sections.filter((section) => section.id !== "anchorage");
  assert.equal(
    knowledgeDocument(upgradeDemoState(upgraded), target).sections.some(
      (s) => s.id === "anchorage",
    ),
    false,
  );
});
test("TSV paste expands dimensions and preserves existing IDs", () => {
  const table: Extract<KnowledgeBlock, { type: "table" }> = {
    id: "t",
    type: "table",
    title: "",
    columns: [{ id: "c", name: "Name" }],
    rows: [{ id: "r", cells: ["Existing"] }],
  };
  let n = 0;
  const p = pasteKnowledgeTable(
    table,
    1,
    0,
    "Alpha\t10\r\nBeta\t20\r\n",
    () => `id-${++n}`,
  );
  assert.equal(p.rows[0].id, "r");
  assert.deepEqual(
    p.rows.map((r) => r.cells),
    [
      ["Existing", ""],
      ["Alpha", "10"],
      ["Beta", "20"],
    ],
  );
  assert.throws(
    () => pasteKnowledgeTable(table, 1000, 0, "a", () => `id-${++n}`),
    /1,000/,
  );
});
test("duplicate IDs and executable file links are rejected", () => {
  const doc = change().document;
  doc.sections[0].blocks.push({
    id: "bad",
    type: "file",
    title: "File",
    url: "javascript:alert(1)",
  });
  assert.throws(() => validateKnowledge(doc), /HTTPS/);
  const duplicate = change().document;
  duplicate.sections.push(structuredClone(duplicate.sections[0]));
  assert.throws(() => validateKnowledge(duplicate), /unique/);
});
test("ordinary contributions append into edited records and invalidate stale drafts", () => {
  let s = createSeedState();
  s = applyAction(
    s,
    { type: "save-knowledge", change: change(s), reason: "Update" },
    actors[0],
  );
  const doc = knowledgeDocument(s, target),
    old = structuredClone(doc);
  old.sections[0].title = "Another title";
  s = applyAction(
    s,
    {
      type: "submit-contribution",
      targetType: "port",
      targetId: target.id,
      title: "New note",
      body: "Confirm the updated schedule with the agent before fixing.",
    },
    actors[1],
  );
  assert.equal(knowledgeDocument(s, target).version, 2);
  assert.match(
    JSON.stringify(knowledgeDocument(s, target)),
    /updated schedule/,
  );
  assert.throws(
    () =>
      applyAction(
        s,
        {
          type: "save-knowledge",
          change: {
            target,
            baseVersion: doc.version,
            baseDocument: doc,
            document: old,
          },
          reason: "Stale",
        },
        actors[0],
      ),
    /Information changed/,
  );
});
test("refinery edits feed the enquiry abstract and survive reload", async () => {
  const { getLocationIntelligence } = await import("../src/lib/intelligence");
  let s = createSeedState();
  const t = { kind: "port" as const, id: "port-singapore" },
    base = knowledgeDocument(s, t),
    document = structuredClone(base);
  const table = document.sections.find(
    (section) => section.id === "refineries",
  )!.blocks[0];
  assert.equal(table.type, "table");
  if (table.type !== "table") throw Error("table");
  table.rows[0].cells[2] = "Updated capacity";
  s = applyAction(
    s,
    {
      type: "save-knowledge",
      change: {
        target: t,
        baseVersion: base.version,
        baseDocument: base,
        document,
      },
      reason: "Source updated",
    },
    actors[0],
  );
  assert.equal(
    getLocationIntelligence(s.ports[0], s.knowledgeRecords).refineries[0]
      .capacity,
    "Updated capacity",
  );
  assert.equal(
    getLocationIntelligence(
      upgradeDemoState(JSON.parse(JSON.stringify(s))).ports[0],
      s.knowledgeRecords,
    ).refineries[0].capacity,
    "Updated capacity",
  );
});
