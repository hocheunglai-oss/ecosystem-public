import assert from 'node:assert/strict';
import test from 'node:test';
import { parseClipboardTable, pasteTableCells, preparePastedTable, tableToTsv } from '../src/lib/tablePaste';
import type { KnowledgeBlock } from '../src/lib/knowledge';

const parse = (text: string) => parseClipboardTable({ text });
test('quoted CSV keeps multiline text, commas, escaped quotes and URL case aligned', () => {
  const result = parse('NAME,NOTES,URL\r\nAcme,"first, line\r\nsecond ""quote""",https://Example.test/Path?Key=AbC\r\n');
  assert.equal(result.format, 'CSV');
  assert.deepEqual(preparePastedTable(result, true), { columns: ['NAME', 'NOTES', 'URL'], rows: [['Acme', 'first, line\nsecond "quote"', 'https://Example.test/Path?Key=AbC']] });
});
test('quoted tabs inside CSV cells do not change the delimiter', () => {
  assert.deepEqual(parse('A,B\n"tab\there",value').cells, [['A', 'B'], ['tab\there', 'value']]);
});
test('spreadsheet TSV handles quoted newline and embedded tab without adding rows', () => {
  const result = parse('A\tB\n"first\nsecond"\t"tab\there"\n');
  assert.equal(result.format, 'TSV'); assert.deepEqual(result.cells, [['A', 'B'], ['first\nsecond', 'tab\there']]);
});
test('single-column quoted multiline cell stays one cell', () => {
  assert.deepEqual(parse('"first\nsecond"').cells, [['first\nsecond']]);
});
test('Markdown headers, alignment markers, escaped pipes and safe URLs survive', () => {
  const result = parse('| Name | Source |\n| :--- | ---: |\n| **ACME** | [Main](https://Example.test/Case?Key=AbC) |\n| a\\|b | `c|d` |');
  assert.equal(result.format, 'MARKDOWN'); assert.equal(result.header, true);
  assert.deepEqual(preparePastedTable(result, true), { columns: ['Name', 'Source'], rows: [['ACME', 'Main (https://Example.test/Case?Key=AbC)'], ['a|b', 'c|d']] });
});
test('fenced Markdown is accepted and unsafe destinations are reduced to visible text', () => {
  const result = parse('```markdown\n| Name | Source |\n| --- | --- |\n| A | [No](data:text/html,test) |\n```');
  assert.equal(result.cells[1][1], 'No'); assert.equal(result.notes.length, 1);
});
test('ragged TSV pads missing cells without shifting or deleting supplied blank columns', () => {
  assert.deepEqual(parse('A\tB\tC\n1\t\t3\n2\t4\n').cells, [['A', 'B', 'C'], ['1', '', '3'], ['2', '4', '']]);
});
test('header option retains the first record as data and fills blank header names', () => {
  const result = parse('\tSOURCE\nA\thttps://example.test/Case');
  assert.deepEqual(preparePastedTable(result, true).columns, ['Column 1', 'SOURCE']);
  assert.deepEqual(preparePastedTable(result, false).rows, result.cells);
});
test('invalid quoting and inconsistent CSV/Markdown rows fail visibly', () => {
  for (const input of ['A,B\n"unfinished,B', 'A,B\n"closed"x,B', 'A,B\nA', '| A | B |\n| --- | --- |\n| one |']) assert.throws(() => parse(input));
});
test('oversized content is rejected before a table is applied', () => {
  assert.throws(() => parse('x'.repeat(500001)), /TOO LARGE/);
  assert.throws(() => parse('x'.repeat(5001)), /5,000 CHARACTERS/);
  assert.throws(() => parse(Array(31).fill('x').join('\t')), /30 COLUMNS/);
  assert.throws(() => parse(Array(1002).fill('x').join('\n')), /1,000 ROWS/);
});
test('1,000 data rows plus headers fit, but disabling headers cannot silently drop row 1,001', () => {
  const result = parse(Array(1001).fill('x').join('\n'));
  assert.equal(preparePastedTable(result, true).rows.length, 1000);
  assert.throws(() => preparePastedTable(result, false), /1,000 ROWS/);
});
test('long or multiline headers require keeping the first row as data, never truncation', () => {
  const result = parse(`"${'a'.repeat(151)}"\tx\ny\tz`);
  assert.throws(() => preparePastedTable(result, true), /HEADERS/);
  assert.equal(preparePastedTable(result, false).rows[0][0].length, 151);
});
const table: Extract<KnowledgeBlock, { type: 'table' }> = { id: 'table', type: 'table', title: 'SAVED', columns: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], rows: [{ id: 'one', cells: ['KEEP', 'OLD'], update: { updatedAt: '2026-10-01T00:00:00Z', updatedBy: 'owner' } }] };
test('cell paste expands atomically while retaining existing values and stable IDs', () => {
  let id = 0; const result = pasteTableCells(table, 0, 1, [['a', 'b'], ['c', 'd']], () => `new-${++id}`);
  assert.deepEqual(result.rows.map(row => row.cells), [['KEEP', 'a', 'b'], ['', 'c', 'd']]);
  assert.equal(result.rows[0].id, 'one'); assert.equal(result.columns[0].id, 'a'); assert.deepEqual(result.rows[0].update, table.rows[0].update);
  assert.deepEqual(table.rows[0].cells, ['KEEP', 'OLD']);
});
test('cell overflow rejects the complete paste and leaves its source unchanged', () => {
  const before = structuredClone(table);
  assert.throws(() => pasteTableCells(table, 0, 1, [Array(30).fill('x')], () => 'new'), /30 COLUMNS/);
  assert.throws(() => pasteTableCells(table, -1, 0, [['x']], () => 'new'), /VALID STARTING CELL/);
  assert.deepEqual(table, before);
});
test('copy serialization round-trips delimiters, newlines, quotes, empty cells and URL case', () => {
  const cells = [['Name', 'Text'], ['A', 'Line 1\nLine 2'], ['B', 'a\tb "quote"'], ['C', 'https://Example.test/Case'], ['', '']];
  assert.deepEqual(parse(tableToTsv(cells)).cells, cells);
});
test('single-column copies retain comma-containing cells and trailing empty records', () => {
  for (const cells of [[['FIRST, SECOND'], ['ALPHA, BETA']], [['NAME'], ['ALPHA'], ['']], [['NAME'], [''], ['']]]) {
    assert.deepEqual(parse(tableToTsv(cells)).cells, cells);
  }
});
