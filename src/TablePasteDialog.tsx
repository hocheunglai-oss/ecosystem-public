import { useEffect, useRef, useState } from 'react';
import { Modal } from './ui';
import { assertPreviewWritable } from './lib/previewGuard';
import { uppercaseText } from './lib/uppercase';
import { parseClipboardTable, preparePastedTable, tableToTsv, type ImportedTable, type ParsedTable, type TableClipboard } from './lib/tablePaste';
import './table-paste.css';

export default function TablePasteDialog({ onClose, onImport, initialClipboard, replaceExisting = false }: {
  onClose: () => void;
  onImport: (table: ImportedTable) => void;
  initialClipboard?: TableClipboard;
  replaceExisting?: boolean;
}) {
  const [raw, setRaw] = useState(initialClipboard?.text ?? '');
  const [parsed, setParsed] = useState<ParsedTable>();
  const [header, setHeader] = useState(true), [page, setPage] = useState(0);
  const [error, setError] = useState(''), [reading, setReading] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null), alive = useRef(true);
  const clipboardGeneration = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  function preview(clipboard: TableClipboard) {
    clipboardGeneration.current++;
    setRaw(clipboard.text); setError(''); setParsed(undefined); setPage(0);
    try {
      const result = parseClipboardTable(clipboard);
      setParsed(result); setHeader(result.header);
      if (!clipboard.text || result.format === 'HTML') setRaw(tableToTsv(result.cells));
    } catch (failure) { setError((failure as Error).message); }
  }
  useEffect(() => { if (initialClipboard) preview(initialClipboard); }, []); // Initial clipboard belongs to this dialog instance.
  let imported: ImportedTable | undefined, validation = '';
  if (parsed) { try { imported = preparePastedTable(parsed, header); } catch (failure) { validation = (failure as Error).message; } }
  async function readClipboard() {
    const generation = ++clipboardGeneration.current;
    setReading(true); setError('');
    try {
      let clipboard: TableClipboard;
      if (navigator.clipboard?.read) {
        const items = await navigator.clipboard.read();
        if (items.length !== 1) throw new Error('Paste one table.');
        const item = items[0];
        const [text, html] = await Promise.all(['text/plain', 'text/html'].map(async type => item.types.includes(type) ? (await item.getType(type)).text() : ''));
        clipboard = { text, html };
      } else clipboard = { text: await navigator.clipboard.readText() };
      if (alive.current && generation === clipboardGeneration.current) preview(clipboard);
    } catch {
      if (alive.current && generation === clipboardGeneration.current) { setError('CLIPBOARD ACCESS UNAVAILABLE. PASTE INTO THE TABLE DATA FIELD.'); input.current?.focus(); }
    } finally { if (alive.current) setReading(false); }
  }
  function apply() {
    if (!imported || reading) return;
    try {
      assertPreviewWritable();
      if (replaceExisting && !window.confirm('REPLACE THIS TABLE? EXISTING ROWS AND COLUMNS WILL BE REPLACED.')) return;
      onImport({ columns: imported.columns.map(uppercaseText), rows: imported.rows.map(row => row.map(uppercaseText)) });
    } catch (failure) { setError((failure as Error).message); }
  }
  const rows = imported?.rows ?? [], current = Math.min(page, Math.max(0, Math.ceil(rows.length / 25) - 1));
  return <div style={{ display: 'contents' }} onKeyDownCapture={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); apply(); } }}><Modal title="PASTE TABLE" onClose={onClose} wide>
    <div className="table-paste">
      <div className="table-paste-actions"><button type="button" className="button secondary" disabled={reading} onClick={() => void readClipboard()}>{reading ? 'READING…' : 'PASTE FROM CLIPBOARD'}</button></div>
      <label className="knowledge-field">TABLE DATA
        <textarea ref={input} aria-label="Table data" data-preserve-case rows={4} value={raw} placeholder="PASTE A TABLE HERE" onChange={event => { clipboardGeneration.current++; setRaw(event.target.value); setParsed(undefined); setError(''); }}
          onPaste={event => { event.preventDefault(); preview({ text: event.clipboardData.getData('text/plain'), html: event.clipboardData.getData('text/html') }); }} />
      </label>
      <div className="table-paste-actions"><button type="button" className="button secondary" disabled={!raw.trim() || reading} onClick={() => preview({ text: raw })}>PREVIEW TABLE</button>
        {parsed && <label className="table-paste-header"><input type="checkbox" checked={header} onChange={event => { clipboardGeneration.current++; setHeader(event.target.checked); setPage(0); }} />FIRST ROW AS HEADERS</label>}</div>
      {(error || validation) && <p className="notice rose" role="alert">{error || validation}</p>}
      {parsed?.notes.map(note => <p key={note} className="muted">{note}</p>)}
      {imported && <>
        <p role="status">{rows.length} ROWS · {imported.columns.length} COLUMNS · {parsed!.format}</p>
        <div className="table-paste-preview knowledge-table-wrap" tabIndex={0} role="region" aria-label="Table preview"><table style={{ minWidth: imported.columns.length * 140, tableLayout: 'fixed' }}><thead><tr>{imported.columns.map((name, index) => <th scope="col" key={index} data-preserve-case>{name}</th>)}</tr></thead>
          <tbody>{rows.slice(current * 25, current * 25 + 25).map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column} data-preserve-case>{cell}</td>)}</tr>)}</tbody></table></div>
        {rows.length > 25 && <div className="table-paste-actions"><button type="button" disabled={!current} onClick={() => setPage(current - 1)}>Previous</button><span>{current + 1} / {Math.ceil(rows.length / 25)}</span><button type="button" disabled={(current + 1) * 25 >= rows.length} onClick={() => setPage(current + 1)}>Next</button></div>}
      </>}
      <footer className="table-paste-actions"><button type="button" className="button secondary" onClick={onClose}>CANCEL</button><button type="button" className="button primary" disabled={!imported || reading} onClick={apply}>USE TABLE</button></footer>
    </div>
  </Modal></div>;
}
