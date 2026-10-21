import type { KnowledgeBlock } from './knowledge';

export type TableClipboard = { text: string; html?: string };
export type ParsedTable = { cells: string[][]; header: boolean; format: 'HTML' | 'MARKDOWN' | 'TSV' | 'CSV' | 'TEXT'; notes: string[] };
export type ImportedTable = { columns: string[]; rows: string[][] };
type Table = Extract<KnowledgeBlock, { type: 'table' }>;
const limits = { input: 500000, columns: 30, rows: 1000, cell: 5000 };
const sizeError = 'TABLES SUPPORT UP TO 30 COLUMNS, 1,000 ROWS AND 5,000 CHARACTERS PER CELL.';

function checked(cells: string[][], extraHeader = false) {
  const width = Math.max(0, ...cells.map(row => row.length));
  if (!cells.length || !width || !cells.some(row => row.some(cell => cell.trim()))) throw new Error('NO TABLE DATA FOUND.');
  if (width > limits.columns || cells.length > limits.rows + Number(extraHeader) || cells.some(row => row.some(cell => cell.length > limits.cell))) throw new Error(sizeError);
  return cells.map(row => Array.from({ length: width }, (_, column) => row[column] ?? ''));
}

/** Preserve destinations exactly; never resolve copied relative URLs against ECO. */
function safeLink(value: string) {
  const trimmed = value.trim();
  if (!trimmed || /[\u0000-\u0020\u007f]/.test(trimmed)) return undefined;
  try {
    const url = new URL(trimmed);
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol) && !url.username && !url.password ? trimmed : undefined;
  } catch { return undefined; }
}

function delimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [], row: string[] = [];
  let cell = '', quoted = false, closed = false;
  const pushCell = () => { if (cell.length > limits.cell || row.length >= limits.columns) throw new Error(sizeError); row.push(cell); cell = ''; closed = false; };
  const pushRow = () => { pushCell(); rows.push([...row]); row.length = 0; if (rows.length > limits.rows + 1) throw new Error(sizeError); };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } }
      else cell += char;
    } else if (char === delimiter) pushCell();
    else if (char === '\n') pushRow();
    else if (char === '"' && !cell && !closed) quoted = true;
    else if (closed || (char === '"' && delimiter === ',')) throw new Error('INVALID QUOTED CELL. CHECK THE SEPARATORS AFTER THE CLOSING QUOTE.');
    else cell += char;
  }
  if (quoted) throw new Error('UNCLOSED QUOTED CELL. PASTE THE COMPLETE TABLE.');
  // A final line terminator is a record boundary, not an additional empty row.
  if (cell || row.length || closed || !text.endsWith('\n')) pushRow();
  return rows;
}

function markdownRow(line: string) {
  const cells: string[] = []; let cell = '', code = false;
  const value = line.trim();
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === '\\' && ['|', '\\', '`'].includes(value[i + 1])) { cell += value[++i]; continue; }
    if (char === '`') code = !code;
    if (char === '|' && !code) { cells.push(cell.trim()); cell = ''; } else cell += char;
  }
  cells.push(cell.trim());
  if (value.startsWith('|')) cells.shift();
  if (value.endsWith('|') && !value.endsWith('\\|')) cells.pop();
  return cells;
}

function markdown(text: string): ParsedTable | undefined {
  const lines = text.trim().split('\n');
  if (/^```(?:markdown|md)?\s*$/i.test(lines[0]) && lines.at(-1)?.trim() === '```') { lines.shift(); lines.pop(); }
  if (lines.length < 2) return;
  const divider = markdownRow(lines[1]);
  if (!divider.length || !divider.every(value => /^:?-{3,}:?$/.test(value))) return;
  const cells = [markdownRow(lines[0]), ...lines.slice(2).map(markdownRow)];
  if (cells.some(row => row.length !== divider.length)) throw new Error('MARKDOWN ROWS MUST HAVE THE SAME NUMBER OF COLUMNS.');
  let omitted = false;
  const plain = cells.map(row => row.map(value => value.replace(/\[([^\]\n]*)\]\(([^)\n]*)\)/g, (_, label: string, href: string) => {
    const url = safeLink(href); if (!url) omitted = true;
    return url ? `${label} (${url})` : label;
  }).replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1')));
  return { cells: checked(plain, true), header: true, format: 'MARKDOWN', notes: omitted ? ['UNSUPPORTED LINK DESTINATIONS WERE OMITTED; THEIR TEXT IS RETAINED.'] : [] };
}

function htmlTable(html: string): ParsedTable | undefined {
  if (!/<table(?:\s|>)/i.test(html)) return;
  if (typeof document === 'undefined') throw new Error('HTML TABLE PASTE REQUIRES A BROWSER.');
  // Template contents stay inert: they are never attached to the document.
  // Read text/selected attributes only; no copied element enters the UI.
  const template = document.createElement('template'); template.innerHTML = html;
  const tables = template.content.querySelectorAll('table');
  if (tables.length !== 1) throw new Error('PASTE ONE TABLE AT A TIME. NESTED TABLES ARE NOT SUPPORTED.');
  const table = tables[0], sourceRows = [...table.querySelectorAll('tr')];
  if (!sourceRows.length) throw new Error('NO TABLE DATA FOUND.');
  if (sourceRows.length > limits.rows + 1) throw new Error(sizeError);
  let merged = false, omitted = false;
  const text = (node: Node): string => {
    if (node.nodeType === 3) return node.textContent ?? '';
    if (node.nodeType !== 1) return '';
    const element = node as Element, tag = element.tagName;
    if (['SCRIPT', 'STYLE', 'TEMPLATE', 'SVG', 'MATH', 'IFRAME', 'OBJECT', 'EMBED', 'NOSCRIPT'].includes(tag)) return '';
    if (tag === 'BR') return '\n';
    if (tag === 'IMG') return element.getAttribute('alt') ?? '';
    const content = [...element.childNodes].map(text).join('');
    if (tag === 'A' && element.hasAttribute('href')) {
      const url = safeLink(element.getAttribute('href') ?? '');
      if (!url) omitted = true;
      return url && content.trim() !== url ? `${content.trim()}${content.trim() ? ' ' : ''}(${url})` : content;
    }
    return ['P', 'DIV', 'LI'].includes(tag) ? `${content}\n` : content;
  };
  const cells: string[][] = [];
  sourceRows.forEach((source, r) => {
    cells[r] ??= []; let column = 0;
    const sourceCells = [...source.children].filter(node => ['TD', 'TH'].includes(node.tagName));
    if (!sourceCells.length && !cells[r].length) throw new Error('TABLE CONTAINS AN EMPTY OR INVALID ROW.');
    for (const cell of sourceCells) {
      while (cells[r][column] !== undefined) column++;
      const span = (key: string) => { const raw = cell.getAttribute(key); if (raw === null) return 1; if (!/^[1-9]\d*$/.test(raw)) throw new Error('INVALID MERGED CELL SIZE.'); return Number(raw); };
      const height = span('rowspan'), width = span('colspan');
      if (column + width > limits.columns || r + height > sourceRows.length) throw new Error('MERGED CELLS EXCEED THE TABLE BOUNDARIES.');
      const value = text(cell).replace(/\u00a0/g, ' ').trim();
      if (height > 1 || width > 1) merged = true;
      for (let y = 0; y < height; y++) { cells[r + y] ??= []; for (let x = 0; x < width; x++) {
        if (cells[r + y][column + x] !== undefined) throw new Error('MERGED CELLS OVERLAP.');
        cells[r + y][column + x] = y === 0 && x === 0 ? value : '';
      } }
      column += width;
    }
  });
  const notes = [];
  if (merged) notes.push('MERGED CELLS ARE EXPANDED; TEXT STAYS IN THE FIRST CELL.');
  if (omitted) notes.push('UNSUPPORTED LINK DESTINATIONS WERE OMITTED; THEIR TEXT IS RETAINED.');
  return { cells: checked(cells, true), header: [...sourceRows[0].children].every(cell => cell.tagName === 'TH') || sourceRows[0].parentElement?.tagName === 'THEAD', format: 'HTML', notes };
}

export function parseClipboardTable(input: TableClipboard): ParsedTable {
  if (input.text.length > limits.input || (input.html?.length ?? 0) > limits.input) throw new Error('PASTED TABLE IS TOO LARGE. USE UP TO 500,000 CHARACTERS.');
  const html = htmlTable(input.html || (/^\s*</.test(input.text) ? input.text : ''));
  if (html) return html;
  const text = input.text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const md = markdown(text); if (md) return md;
  let quoted = false, tabs = false, commas = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') { if (quoted && text[i + 1] === '"') i++; else quoted = !quoted; }
    else if (!quoted) { if (text[i] === '\t') tabs = true; if (text[i] === ',') commas = true; }
  }
  const format = tabs ? 'TSV' : commas ? 'CSV' : 'TEXT';
  const rows = delimited(text, format === 'CSV' ? ',' : '\t');
  if (format === 'CSV' && rows.some(row => row.length !== rows[0].length)) throw new Error('CSV ROWS MUST HAVE THE SAME NUMBER OF COLUMNS.');
  const ragged = rows.some(row => row.length !== rows[0].length);
  return { cells: checked(rows, true), header: format !== 'TEXT', format, notes: ragged ? ['MISSING CELLS ARE FILLED WITH BLANKS.'] : [] };
}

export function preparePastedTable(parsed: ParsedTable, firstRowHeaders: boolean): ImportedTable {
  const cells = checked(parsed.cells, firstRowHeaders);
  const columns = firstRowHeaders ? cells[0].map((value, index) => value.trim() || `Column ${index + 1}`) : cells[0].map((_, index) => `Column ${index + 1}`);
  if (columns.some(value => value.length > 150 || value.includes('\n'))) throw new Error('HEADERS NEED ONE LINE AND UP TO 150 CHARACTERS. TURN OFF FIRST ROW AS HEADERS TO KEEP THEM AS DATA.');
  const rows = firstRowHeaders ? cells.slice(1) : cells;
  if (rows.length > limits.rows) throw new Error(sizeError);
  return { columns, rows };
}

/** Atomic paste: validate every cell/limit before cloning or replacing data. */
export function pasteTableCells(table: Table, row: number, col: number, cells: string[][], makeId: () => string): Table {
  const values = checked(cells);
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 || row > table.rows.length || col >= table.columns.length) throw new Error('SELECT A VALID STARTING CELL.');
  const width = Math.max(table.columns.length, col + values[0].length), height = Math.max(table.rows.length, row + values.length);
  if (width > limits.columns || height > limits.rows) throw new Error(sizeError);
  const next = structuredClone(table);
  while (next.columns.length < width) next.columns.push({ id: makeId(), name: `Column ${next.columns.length + 1}` });
  while (next.rows.length < height) next.rows.push({ id: makeId(), cells: [] });
  next.rows.forEach(item => { while (item.cells.length < width) item.cells.push(''); });
  values.forEach((line, r) => line.forEach((value, c) => { next.rows[row + r].cells[col + c] = value; }));
  return next;
}

export function tableToTsv(cells: string[][]): string {
  // Quote commas so single-column copies cannot be mistaken for CSV, and
  // quote empty cells so a final empty record is not a mere line terminator.
  return cells.map(row => row.map(value => !value || /[,\t\n\r"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value).join('\t')).join('\n');
}
