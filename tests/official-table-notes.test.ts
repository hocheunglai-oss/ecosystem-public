import test from 'node:test';
import assert from 'node:assert/strict';
import { isOfficialNotes, officialNotes, officialNotesId, officialTableTitle, updateOfficialNote } from '../src/lib/officialTableNotes';
import { validateKnowledge, type KnowledgeSection } from '../src/lib/knowledge';

test('automatic table notes preserve prior facts, row IDs, source and unrelated tables', () => {
  const section: KnowledgeSection = { id: 'grades', title: 'Grades', blocks: [{ id: 'manual', title: officialTableTitle, type: 'table', provenance: { source: 'https://example.test/report', evidence: 'Prior verified facts' }, columns: [{ id: 'f', name: 'Fuel' }, { id: 'v', name: 'Verified position' }, { id: 'c', name: 'Commercial implication' }], rows: ['LNG', 'Methanol', 'Ammonia', 'Ethanol'].map((fuel, i) => ({ id: `row${i}`, cells: [fuel, `PRIOR FACT ${i}`, `MANUAL NOTE ${i}`] })) }] };
  const before = structuredClone(section);
  updateOfficialNote(section, 'methanol', 'KEEP MY CASE https://example.test/Case?Key=AbC');
  assert.equal(section.blocks.length, 1);
  const table = section.blocks[0]; assert.ok(isOfficialNotes(table));
  assert.deepEqual(table.provenance, before.blocks[0].provenance);
  assert.deepEqual(table.rows.map(row => [row.id, row.cells[0], row.cells[1]]), ['LNG', 'Methanol', 'Ammonia', 'Ethanol'].map((fuel, i) => [`row${i}`, fuel, `PRIOR FACT ${i}`]));
  assert.equal(officialNotes(section).methanol, 'KEEP MY CASE https://example.test/Case?Key=AbC');
  assert.equal(officialNotes(section).lng, 'MANUAL NOTE 0');
});
test('first note creates a valid notes-only table; empty or unknown notes do not create blocks', () => {
  const section: KnowledgeSection = { id: 'grades', title: 'Grades', blocks: [] };
  updateOfficialNote(section, 'lng', ''); updateOfficialNote(section, 'diesel', 'unknown'); assert.equal(section.blocks.length, 0);
  updateOfficialNote(section, 'lng', 'CONTACT CONTRACTUAL SELLER');
  assert.equal(section.blocks.length, 1); assert.equal(officialNotes(section).lng, 'CONTACT CONTRACTUAL SELLER');
  const table = section.blocks[0]; assert.ok(isOfficialNotes(table)); assert.equal(table.columns.length, 2);
  assert.doesNotThrow(() => validateKnowledge({ version: 1, sections: [section] }));
  updateOfficialNote(section, 'lng', 'x'.repeat(5001)); assert.equal(officialNotes(section).lng, 'CONTACT CONTRACTUAL SELLER');
});
test('similar titles, duplicate fuels and additional rows remain ordinary user tables', () => {
  const section: KnowledgeSection = { id: 'grades', title: 'Grades', blocks: [] };
  updateOfficialNote(section, 'lng', 'note'); const original = section.blocks[0]; assert.ok(isOfficialNotes(original));
  for (const altered of [{ ...original, title: 'My alternative fuel review' }, { ...original, rows: [...original.rows, original.rows[0]] }, { ...original, rows: [original.rows[0], original.rows[0], original.rows[2], original.rows[3]] }]) assert.equal(isOfficialNotes(altered), false);
});
test('new note IDs avoid section, block, column and row IDs across the whole document', () => {
  const section: KnowledgeSection = { id: 'grades', title: 'Grades', blocks: [] };
  const other: KnowledgeSection = { id: officialNotesId, title: 'Other', blocks: [{ id: officialNotesId + '-notes', title: 'Existing table', type: 'table', columns: [{ id: officialNotesId + '-notes-notes-fuel', name: 'Value' }], rows: [{ id: officialNotesId + '-notes-notes-notes-lng', cells: ['Existing value'] }] }] };
  const before = structuredClone(other);
  updateOfficialNote(section, 'lng', 'New manual note', [section, other]);
  assert.doesNotThrow(() => validateKnowledge({ version: 1, sections: [section, other] }));
  assert.deepEqual(other, before);
});
test('editing the selected official notes preserves a second matching manual table', () => {
  const section: KnowledgeSection = { id: 'grades', title: 'Grades', blocks: [] };
  updateOfficialNote(section, 'lng', 'Original note');
  const second = structuredClone(section.blocks[0]); assert.ok(isOfficialNotes(second)); second.id = 'second-table'; for (const item of [...second.columns, ...second.rows]) item.id += '-second'; section.blocks.push(second);
  const before = structuredClone(second);
  updateOfficialNote(section, 'lng', 'Updated note');
  assert.deepEqual(section.blocks[1], before);
  assert.equal(officialNotes(section).lng, 'Updated note');
});
