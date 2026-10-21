import test from 'node:test';
import assert from 'node:assert/strict';
import { knowledgeCellAddress, knowledgeColumnLetter, moveKnowledgeColumn, moveKnowledgeRow, sortKnowledgeRows } from '../src/lib/knowledgeTableEditor';
import { knowledgeDocument, knowledgeEntryUpdate, pasteKnowledgeTable, type KnowledgeBlock } from '../src/lib/knowledge';
import { actors, applyAction } from '../src/lib/model';
import { createSeedState, upgradeDemoState } from '../src/lib/seed';

type Table = Extract<KnowledgeBlock, { type: 'table' }>;
const table: Table = {
  id: 'table', type: 'table', title: 'Note',
  columns: [{ id: 'name', name: 'Name', width: 240 }, { id: 'value', name: 'Value', width: 140 }],
  rows: [
    { id: 'row-one', cells: ['Agent', 'Confirmed'], update: { updatedBy: 'Otto', updatedAt: '2026-10-05T00:00:00Z' } },
    { id: 'row-two', cells: ['Delivery', 'Barge'] },
  ],
};
test('moving a row preserves its identity, cells and audit history without mutating the source', () => {
  const moved = moveKnowledgeRow(table, 0, 1);
  assert.deepEqual(moved.rows.map(row => row.id), ['row-two', 'row-one']);
  assert.deepEqual(moved.rows[1], table.rows[0]);
  assert.equal(table.rows[0].id, 'row-one');
  assert.notEqual(moved.rows[1], table.rows[0]);
});
test('moving a column carries widths and every matching cell together', () => {
  const moved = moveKnowledgeColumn(table, 0, 1);
  assert.deepEqual(moved.columns.map(column => column.id), ['value', 'name']);
  assert.equal(moved.columns[1].width, 240);
  assert.deepEqual(moved.rows.map(row => row.cells), [['Confirmed', 'Agent'], ['Barge', 'Delivery']]);
  assert.deepEqual(moved.rows[0].update, table.rows[0].update);
  assert.deepEqual(table.rows[0].cells, ['Agent', 'Confirmed']);
});
test('moving beyond the table boundaries is a no-op', () => {
  assert.equal(moveKnowledgeRow(table, 0, -1), table);
  assert.equal(moveKnowledgeRow(table, 1, 2), table);
  assert.equal(moveKnowledgeColumn(table, 0, 2), table);
  assert.equal(moveKnowledgeColumn(table, -1, 1), table);
});
test('spreadsheet paste after column reordering preserves destination IDs', () => {
  const moved = moveKnowledgeColumn(table, 0, 1);
  const pasted = pasteKnowledgeTable(moved, 0, 0, 'Verified\tOperations\nTruck\tReceiving', () => 'new-id');
  assert.deepEqual(pasted.columns.map(column => column.id), ['value', 'name']);
  assert.deepEqual(pasted.rows.map(row => row.id), ['row-one', 'row-two']);
  assert.deepEqual(pasted.rows.map(row => row.cells), [['Verified', 'Operations'], ['Truck', 'Receiving']]);
});

const unordered: Table = {
  ...structuredClone(table),
  rows: [
    { id: 'ten', cells: ['Agent 10', 'TEN'], update: { updatedBy: 'otto', updatedAt: '2026-10-05T00:00:00Z' } },
    { id: 'blank', cells: ['', 'BLANK'] },
    { id: 'two', cells: ['Agent 2', 'TWO'], update: { updatedBy: 'guido', updatedAt: '2026-10-04T00:00:00Z' } },
    { id: 'same-two', cells: ['agent 2', 'SECOND TWO'] },
    { id: 'spaces', cells: ['  ', 'SPACES'] },
    { id: 'one', cells: [' Agent 1 ', 'ONE'] },
  ],
};
test('A–Z sorts complete rows naturally and stably, retaining update records and blank rows last', () => {
  const before = structuredClone(unordered);
  const sorted = sortKnowledgeRows(unordered, 0, 'asc');
  assert.deepEqual(sorted.rows.map(row => row.id), ['one', 'two', 'same-two', 'ten', 'blank', 'spaces']);
  for (const row of sorted.rows) assert.deepEqual(row, unordered.rows.find(item => item.id === row.id));
  assert.deepEqual(sorted.columns, unordered.columns);
  assert.deepEqual(unordered, before);
  assert.notEqual(sorted.rows[1], unordered.rows[2]);
});
test('Z–A keeps blank values last and retains the original order of equal values', () => {
  const sorted = sortKnowledgeRows(unordered, 0, 'desc');
  assert.deepEqual(sorted.rows.map(row => row.id), ['ten', 'two', 'same-two', 'one', 'blank', 'spaces']);
  assert.deepEqual(sorted.rows[1].cells, ['Agent 2', 'TWO']);
  assert.deepEqual(sorted.rows[1].update, unordered.rows[2].update);
});
test('sorting uses the selected column and all rows across pages', () => {
  const large: Table = { ...table, rows: Array.from({ length: 60 }, (_, index) => ({ id: `row-${index}`, cells: [`Original ${index}`, String(60 - index)] })) };
  const sorted = sortKnowledgeRows(large, 1, 'asc');
  assert.equal(sorted.rows[0].id, 'row-59');
  assert.equal(sorted.rows[59].id, 'row-0');
  assert.deepEqual(sorted.rows[0].cells, ['Original 59', '1']);
  assert.deepEqual(sorted.rows[59].cells, ['Original 0', '60']);
});
test('already sorted and invalid column operations are no-ops', () => {
  const sorted = sortKnowledgeRows(unordered, 0, 'asc');
  assert.equal(sortKnowledgeRows(sorted, 0, 'asc'), sorted);
  for (const column of [-1, 2, NaN, 0.5]) assert.equal(sortKnowledgeRows(unordered, column, 'asc'), unordered);
  assert.equal(moveKnowledgeRow(table, NaN, 0), table);
  assert.equal(moveKnowledgeColumn(table, 0, .5), table);
});
test('spreadsheet addresses handle the final supported columns and reject invalid targets', () => {
  assert.equal(knowledgeColumnLetter(0), 'A');
  assert.equal(knowledgeColumnLetter(25), 'Z');
  assert.equal(knowledgeColumnLetter(26), 'AA');
  assert.equal(knowledgeColumnLetter(29), 'AD');
  assert.deepEqual(knowledgeCellAddress(' ad1000 ', 1000, 30), { row: 999, col: 29 });
  for (const address of ['A0', 'A1001', 'AE1', '2A', '', 'A1.5', 'A-2', '999']) assert.equal(knowledgeCellAddress(address, 1000, 30), undefined);
  assert.equal(knowledgeCellAddress('A1', 0, 1), undefined);
});
test('publishing and reloading sorted rows preserves per-entry attribution and source provenance', () => {
  const state = createSeedState(), target = { kind: 'supplier' as const, id: 'synthetic-supplier' };
  const current = knowledgeDocument(state, target, { suppliers: [{ id: target.id, name: 'SYNTHETIC SUPPLIER' }] });
  const source = { ...structuredClone(unordered), provenance: { source: 'Supplier list', evidence: 'Confirmed delivery contacts' } };
  current.sections[0].blocks.push(source);
  state.knowledgeRecords = { ...state.knowledgeRecords, 'supplier:synthetic-supplier': current };
  const proposed = structuredClone(current);
  proposed.sections[0].blocks = [sortKnowledgeRows(source, 0, 'asc')];
  const saved = applyAction(state, { type: 'save-knowledge', change: { target, baseVersion: current.version, baseDocument: current, document: proposed }, reason: 'Sort Name A–Z' }, actors[1], '2026-10-06T08:00:00Z');
  const reloaded = upgradeDemoState(JSON.parse(JSON.stringify(saved)));
  const sorted = knowledgeDocument(reloaded, target).sections[0].blocks[0] as Table;
  assert.deepEqual(sorted.rows.map(row => row.id), ['one', 'two', 'same-two', 'ten', 'blank', 'spaces']);
  assert.deepEqual(sorted.provenance, source.provenance);
  for (const original of source.rows) {
    assert.deepEqual(sorted.rows.find(row => row.id === original.id), original);
    assert.deepEqual(knowledgeEntryUpdate(reloaded, target, source.id, original.id), original.update);
  }
  assert.equal(saved.knowledgeHistory?.[0].by, actors[1].id);
});
