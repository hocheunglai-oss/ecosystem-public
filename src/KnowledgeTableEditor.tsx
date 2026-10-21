import { useState, useEffect, useLayoutEffect, useRef, type KeyboardEvent, type DragEvent, type PointerEvent } from "react";
import { ChevronDown, Plus, Copy, ArrowDownAZ } from "lucide-react";
import { useDemo } from "./store";
import { uid } from "./lib/model";
import { isEmailText, uppercaseText } from "./lib/uppercase";
import { pasteKnowledgeTable, type KnowledgeBlock } from "./lib/knowledge";
import { knowledgeCellAddress, knowledgeColumnLetter, moveKnowledgeColumn, moveKnowledgeRow, sortKnowledgeRows } from "./lib/knowledgeTableEditor";
import { dropDestination, dropEdge, type DropEdge } from "./lib/dropPosition";
import "./knowledge-sheet.css";

type Table = Extract<KnowledgeBlock, { type: "table" }>;
type Point = { row: number; col: number };
type Header = { kind: "row" | "column"; index: number };
type Menu = Header & { left: number; top: number };
type Resize = { column: number; startX: number; startWidth: number; width: number };
const clampWidth = (width: number) => Math.max(100, Math.min(600, Math.round(width)));

export default function KnowledgeTableEditor({ table, onChange }: { table: Table; onChange: (value: Table) => void }) {
  const { notify } = useDemo();
  const [focus, setFocus] = useState<Point>({ row: 0, col: 0 });
  const [page, setPage] = useState(0);
  const [menu, setMenu] = useState<Menu>();
  const [drop, setDrop] = useState<Header & { edge: DropEdge }>();
  const [resize, setResize] = useState<Resize>();
  const grid = useRef<HTMLDivElement>(null);
  const menuElement = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const dragging = useRef<Header | undefined>(undefined);
  const resizing = useRef<Resize | undefined>(undefined);
  const pendingFocus = useRef<Point | null>(null);
  const row = Math.min(focus.row, Math.max(0, table.rows.length - 1));
  const col = Math.min(focus.col, table.columns.length - 1);
  const index = Math.min(page, Math.max(0, Math.ceil(table.rows.length / 50) - 1));
  const address = `${knowledgeColumnLetter(col)}${table.rows.length ? row + 1 : ""}`;
  const [addressDraft, setAddressDraft] = useState<string>();
  useEffect(() => {
    if (!pendingFocus.current) return;
    const point = pendingFocus.current;
    const cell = grid.current?.querySelector<HTMLInputElement>(`[data-row="${point.row}"][data-col="${point.col}"]`);
    cell?.focus(); cell?.select(); pendingFocus.current = null;
  }, [table, index, focus]);
  useEffect(() => {
    const viewport = grid.current;
    const cell = viewport?.querySelector<HTMLElement>(`[data-row="${table.rows.length ? row : -1}"][data-col="${col}"]`);
    if (!viewport || !cell) return;
    const bounds = viewport.getBoundingClientRect(), selected = cell.getBoundingClientRect();
    const headerHeight = viewport.querySelector("thead")?.getBoundingClientRect().height ?? 0;
    const rowHeaderWidth = 52;
    if (selected.left < bounds.left + rowHeaderWidth) viewport.scrollLeft -= bounds.left + rowHeaderWidth - selected.left;
    else if (selected.right > bounds.right) viewport.scrollLeft += selected.right - bounds.right;
    if (table.rows.length && selected.top < bounds.top + headerHeight) viewport.scrollTop -= bounds.top + headerHeight - selected.top;
    else if (selected.bottom > bounds.bottom) viewport.scrollTop += selected.bottom - bounds.bottom;
  }, [row, col, index, table.rows.length]);
  useLayoutEffect(() => {
    if (!menu || !menuElement.current) return;
    const node = menuElement.current;
    const bounds = node.getBoundingClientRect();
    node.style.left = `${Math.max(8, Math.min(menu.left, window.innerWidth - bounds.width - 8))}px`;
    node.style.top = `${Math.max(8, Math.min(menu.top, window.innerHeight - bounds.height - 8))}px`;
    node.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: globalThis.PointerEvent) => {
      if (!menuElement.current?.contains(event.target as Node) && !menuTrigger.current?.contains(event.target as Node)) setMenu(undefined);
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [menu]);
  function selectCell(nextRow: number, nextCol: number, focusInput = false) {
    if (nextRow < 0 || nextRow >= table.rows.length || nextCol < 0 || nextCol >= table.columns.length) return;
    if (focusInput) pendingFocus.current = { row: nextRow, col: nextCol };
    setFocus({ row: nextRow, col: nextCol }); setPage(Math.floor(nextRow / 50));
  }
  function focusCell(nextRow: number, nextCol: number) { selectCell(nextRow, nextCol, true); }
  function mutate(fn: (value: Table) => void) { const next = structuredClone(table); fn(next); onChange(next); }
  function closeMenu(restoreFocus = true) { setMenu(undefined); if (restoreFocus) menuTrigger.current?.focus({ preventScroll: true }); }
  function openMenu(kind: Header["kind"], at: number, trigger: HTMLButtonElement, x?: number, y?: number) {
    setFocus(kind === "row" ? { row: at, col } : { row, col: at });
    menuTrigger.current = trigger;
    const bounds = trigger.getBoundingClientRect();
    setMenu({ kind, index: at, left: x ?? bounds.left, top: y ?? bounds.bottom + 3 });
  }
  function insertRow(at: number) {
    if (table.rows.length >= 1000) return;
    mutate(value => value.rows.splice(at, 0, { id: uid("row"), cells: value.columns.map(() => "") }));
    pendingFocus.current = { row: at, col }; setFocus(pendingFocus.current); setPage(Math.floor(at / 50));
  }
  function insertColumn(at: number) {
    if (table.columns.length >= 30) return;
    mutate(value => { value.columns.splice(at, 0, { id: uid("column"), name: "Column " + (value.columns.length + 1) }); value.rows.forEach(item => item.cells.splice(at, 0, "")); });
    pendingFocus.current = { row: table.rows.length ? row : -1, col: at }; setFocus({ row, col: at });
  }
  function moveRow(from: number, to: number) { onChange(moveKnowledgeRow(table, from, to)); focusCell(to, col); }
  function moveColumn(from: number, to: number) {
    onChange(moveKnowledgeColumn(table, from, to));
    pendingFocus.current = { row: table.rows.length ? row : -1, col: to }; setFocus({ row, col: to });
  }
  function rowAction(action: string, at: number) {
    closeMenu();
    if (action === "above" || action === "below") insertRow(at + (action === "below" ? 1 : 0));
    if (action === "up" || action === "down") moveRow(at, at + (action === "up" ? -1 : 1));
    if (action === "delete" && (!table.rows[at]?.cells.some(Boolean) || window.confirm("DELETE THIS ROW?"))) {
      mutate(value => value.rows.splice(at, 1));
      const nextRow = Math.max(0, Math.min(at, table.rows.length - 2));
      pendingFocus.current = { row: table.rows.length > 1 ? nextRow : -1, col }; setFocus({ row: nextRow, col }); setPage(Math.floor(nextRow / 50));
    }
  }
  function columnAction(action: string, at: number) {
    closeMenu();
    if (action === "left" || action === "right") insertColumn(at + (action === "right" ? 1 : 0));
    if (action === "leftward" || action === "rightward") moveColumn(at, at + (action === "leftward" ? -1 : 1));
    if (action === "delete" && table.columns.length > 1 && (!table.rows.some(item => item.cells[at]) || window.confirm("DELETE THIS COLUMN?"))) {
      mutate(value => { value.columns.splice(at, 1); value.rows.forEach(item => item.cells.splice(at, 1)); });
      const nextCol = Math.max(0, Math.min(at, table.columns.length - 2));
      pendingFocus.current = { row: table.rows.length ? row : -1, col: nextCol }; setFocus({ row, col: nextCol });
    }
  }
  function sort(direction: "asc" | "desc", column = col) {
    if (menu) closeMenu();
    const selectedId = table.rows[row]?.id;
    const sorted = sortKnowledgeRows(table, column, direction);
    onChange(sorted);
    const nextRow = Math.max(0, sorted.rows.findIndex(item => item.id === selectedId));
    setFocus({ row: nextRow, col: column }); setPage(Math.floor(nextRow / 50));
  }
  function menuKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); event.stopPropagation(); closeMenu(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)'));
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const target = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[target]?.focus();
  }
  function dragStart(event: DragEvent<HTMLButtonElement>, header: Header) {
    closeMenu(false); dragging.current = header; event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-knowledge-header", `${header.kind}:${header.index}`);
    setFocus(header.kind === "row" ? { row: header.index, col } : { row, col: header.index });
  }
  function dragOver(event: DragEvent<HTMLElement>, header: Header) {
    if (dragging.current?.kind !== header.kind) return;
    event.preventDefault(); event.dataTransfer.dropEffect = "move";
    const bounds = event.currentTarget.getBoundingClientRect();
    setDrop({ ...header, edge: header.kind === "row" ? dropEdge(event.clientY, bounds.top, bounds.height) : dropEdge(event.clientX, bounds.left, bounds.width) });
  }
  function dropHeader(event: DragEvent<HTMLElement>, header: Header) {
    const source = dragging.current;
    if (!source || source.kind !== header.kind) return;
    event.preventDefault(); dragging.current = undefined; setDrop(undefined);
    const bounds = event.currentTarget.getBoundingClientRect();
    const edge = header.kind === "row" ? dropEdge(event.clientY, bounds.top, bounds.height) : dropEdge(event.clientX, bounds.left, bounds.width);
    const destination = dropDestination(source.index, header.index, edge);
    if (source.kind === "row") moveRow(source.index, destination); else moveColumn(source.index, destination);
  }
  function resizeStart(event: PointerEvent<HTMLButtonElement>, column: number) {
    if (event.button !== 0) return;
    event.preventDefault(); closeMenu(false); setFocus({ row, col: column });
    const value = { column, startX: event.clientX, startWidth: table.columns[column].width ?? 160, width: table.columns[column].width ?? 160 };
    resizing.current = value; setResize(value); event.currentTarget.setPointerCapture(event.pointerId);
  }
  function resizeMove(event: PointerEvent<HTMLButtonElement>) {
    if (!resizing.current) return;
    const value = { ...resizing.current, width: clampWidth(resizing.current.startWidth + event.clientX - resizing.current.startX) };
    resizing.current = value; setResize(value);
  }
  function resizeEnd(event: PointerEvent<HTMLButtonElement>, commit: boolean) {
    const value = resizing.current; resizing.current = undefined; setResize(undefined);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (value && commit) mutate(next => { next.columns[value.column].width = value.width; });
  }
  function navigate(event: KeyboardEvent<HTMLInputElement>, cellRow: number, cellCol: number) {
    if (event.metaKey || event.ctrlKey || event.nativeEvent.isComposing) return;
    const input = event.currentTarget;
    const caretStart = input.selectionStart === 0 && input.selectionEnd === 0;
    const caretEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
    let nextRow = cellRow, nextCol = cellCol;
    if (event.key === "Enter") nextRow += event.shiftKey ? -1 : 1;
    else if (event.key === "ArrowUp") nextRow--;
    else if (event.key === "ArrowDown") nextRow++;
    else if (event.key === "ArrowLeft" && (caretStart || event.altKey)) nextCol--;
    else if (event.key === "ArrowRight" && (caretEnd || event.altKey)) nextCol++;
    else if (event.key === "Tab") {
      const offset = cellRow * table.columns.length + cellCol + (event.shiftKey ? -1 : 1);
      if (offset < 0 || offset >= table.rows.length * table.columns.length) return;
      nextRow = Math.floor(offset / table.columns.length); nextCol = offset % table.columns.length;
    } else return;
    if (event.key === "Enter" || (nextRow >= 0 && nextRow < table.rows.length && nextCol >= 0 && nextCol < table.columns.length)) { event.preventDefault(); focusCell(nextRow, nextCol); }
  }
  const widths = table.columns.map((item, column) => resize?.column === column ? resize.width : item.width ?? 160);
  const totalWidth = 52 + widths.reduce((total, width) => total + width, 0);
  return <div className="knowledge-grid-editor knowledge-sheet knowledge-spreadsheet">
    <div className="knowledge-sheet-toolbar" role="group" aria-label="Table controls">
      <input className="sheet-address" aria-label="Selected cell" value={addressDraft ?? address} disabled={!table.rows.length} maxLength={8}
        onChange={event => setAddressDraft(event.target.value.toUpperCase())}
        onBlur={event => { const point = knowledgeCellAddress(event.currentTarget.value, table.rows.length, table.columns.length); setAddressDraft(undefined); if (point) selectCell(point.row, point.col); }}
        onKeyDown={event => { if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) { event.preventDefault(); const point = knowledgeCellAddress(event.currentTarget.value, table.rows.length, table.columns.length); setAddressDraft(undefined); if (point) focusCell(point.row, point.col); } }} />
      <span className="sheet-selected-column" title={table.columns[col].name}>{table.columns[col].name}</span>
      <button type="button" disabled={table.rows.length < 2} onClick={() => sort("asc")}><ArrowDownAZ size={14} /> Sort A–Z</button>
      <button type="button" disabled={table.rows.length >= 1000} onClick={() => insertRow(table.rows.length)}><Plus size={13} /> Add Row</button>
      <button type="button" disabled={table.columns.length >= 30} onClick={() => insertColumn(table.columns.length)}><Plus size={13} /> Add Column</button>
      <button type="button" aria-label="Copy table" title="Copy table" onClick={() => {
        const value = [table.columns.map(item => item.name), ...table.rows.map(item => item.cells)].map(item => item.join("\t")).join("\n");
        void navigator.clipboard.writeText(uppercaseText(value)).then(() => notify("Table copied."), () => notify("Copy unavailable. Select and copy the table.", true));
      }}><Copy size={14} /><span>Copy</span></button>
    </div>
    <div className="knowledge-table-wrap" ref={grid} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(undefined); }} onWheel={() => { if (menu) closeMenu(false); }}>
      <table style={{ tableLayout: "fixed", width: totalWidth, minWidth: totalWidth }}>
        <colgroup><col style={{ width: 52 }} />{table.columns.map((item, column) => <col key={item.id} style={{ width: widths[column] }} />)}</colgroup>
        <thead><tr><th scope="col" className="sheet-corner">#</th>{table.columns.map((item, column) => <th key={item.id} scope="col" className={`${col === column ? "selected-column" : ""} ${drop?.kind === "column" && drop.index === column ? `sheet-drop-column-${drop.edge}` : ""}`}
          onContextMenu={event => { event.preventDefault(); const trigger = event.currentTarget.querySelector<HTMLButtonElement>(".sheet-header-menu")!; openMenu("column", column, trigger, event.clientX, event.clientY); }}
          onDragOver={event => dragOver(event, { kind: "column", index: column })} onDrop={event => dropHeader(event, { kind: "column", index: column })}>
          <div className="sheet-column-heading">
            <button type="button" className="sheet-header-menu sheet-column-menu" aria-label={`Column ${column + 1} actions`} aria-haspopup="menu" aria-expanded={menu?.kind === "column" && menu.index === column} title={`Column ${knowledgeColumnLetter(column)} actions · Drag to move`} draggable
              onDragStart={event => dragStart(event, { kind: "column", index: column })} onDragEnd={() => { dragging.current = undefined; setDrop(undefined); }}
              onClick={event => openMenu("column", column, event.currentTarget)}>{knowledgeColumnLetter(column)}<ChevronDown size={11} /></button>
            <input data-row={-1} data-col={column} aria-label={`Column ${column + 1} name`} required maxLength={150} value={item.name} onFocus={() => setFocus({ row, col: column })} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); focusCell(index * 50, column); } }}
              onChange={event => mutate(value => { value.columns[column].name = event.target.value; })} />
          </div>
          <button type="button" className="sheet-resize-handle" aria-label={`Resize column ${column + 1}`} title={`Column width ${widths[column]} px`} onPointerDown={event => resizeStart(event, column)} onPointerMove={resizeMove} onPointerUp={event => resizeEnd(event, true)} onPointerCancel={event => resizeEnd(event, false)}
            onKeyDown={event => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); setFocus({ row, col: column }); mutate(value => { value.columns[column].width = clampWidth((value.columns[column].width ?? 160) + (event.key === "ArrowLeft" ? -10 : 10)); }); }} />
        </th>)}</tr></thead>
        <tbody>{table.rows.slice(index * 50, index * 50 + 50).map((item, offset) => {
          const absolute = index * 50 + offset;
          return <tr key={item.id} className={`${row === absolute ? "selected-table-row" : ""} ${drop?.kind === "row" && drop.index === absolute ? `sheet-drop-row-${drop.edge}` : ""}`}
            onDragOver={event => dragOver(event, { kind: "row", index: absolute })} onDrop={event => dropHeader(event, { kind: "row", index: absolute })}>
            <th scope="row" className={row === absolute ? "selected-row-number" : ""}
              onContextMenu={event => { event.preventDefault(); openMenu("row", absolute, event.currentTarget.querySelector<HTMLButtonElement>("button")!, event.clientX, event.clientY); }}>
              <button type="button" className="sheet-header-menu sheet-row-menu" aria-label={`Row ${absolute + 1} actions`} aria-haspopup="menu" aria-expanded={menu?.kind === "row" && menu.index === absolute} title={`Row ${absolute + 1} actions · Drag to move`} draggable
                onDragStart={event => dragStart(event, { kind: "row", index: absolute })} onDragEnd={() => { dragging.current = undefined; setDrop(undefined); }}
                onClick={event => openMenu("row", absolute, event.currentTarget)}>{absolute + 1}<ChevronDown size={10} /></button>
            </th>{item.cells.map((value, column) => <td key={table.columns[column].id} className={`${row === absolute && col === column ? "selected-cell" : col === column ? "selected-table-column" : ""} ${drop?.kind === "column" && drop.index === column ? `sheet-drop-column-${drop.edge}` : ""}`}>
              <input data-row={absolute} data-col={column} aria-label={`Row ${absolute + 1}, ${table.columns[column].name}`} value={value} data-email-value={isEmailText(value) ? "" : undefined} maxLength={5000}
                onFocus={() => setFocus({ row: absolute, col: column })} onKeyDown={event => navigate(event, absolute, column)}
                onChange={event => mutate(next => { next.rows[absolute].cells[column] = event.target.value; })}
                onPaste={event => {
                  const clipboard = event.clipboardData.getData("text/plain");
                  if (!/[\t\n\r]/.test(clipboard)) return;
                  event.preventDefault();
                  try { onChange(pasteKnowledgeTable(table, absolute, column, uppercaseText(clipboard), () => uid("cell"))); }
                  catch (error) { notify((error as Error).message, true); }
                }} />
            </td>)}</tr>;
        })}</tbody>
      </table>
    </div>
    <div className="knowledge-pagination"><span>{table.rows.length} rows · {table.columns.length} columns</span>
      {table.rows.length > 50 && <><button type="button" disabled={!index} onClick={() => focusCell((index - 1) * 50, col)}>Previous</button><span>{index + 1} / {Math.ceil(table.rows.length / 50)}</span><button type="button" disabled={(index + 1) * 50 >= table.rows.length} onClick={() => focusCell((index + 1) * 50, col)}>Next</button></>}
    </div>
    {menu && <div ref={menuElement} className="knowledge-sheet-menu" role="menu" aria-label={menu.kind === "row" ? `Row ${menu.index + 1} actions` : `Column ${knowledgeColumnLetter(menu.index)} actions`} style={{ left: menu.left, top: menu.top }} onKeyDown={menuKeys}>
      <span className="sheet-menu-heading">{menu.kind === "row" ? `Row ${menu.index + 1}` : `${knowledgeColumnLetter(menu.index)} · ${table.columns[menu.index].name}`}</span>
      {menu.kind === "row" ? <>
        <button type="button" role="menuitem" disabled={table.rows.length >= 1000} onClick={() => rowAction("above", menu.index)}>Insert row above</button>
        <button type="button" role="menuitem" disabled={table.rows.length >= 1000} onClick={() => rowAction("below", menu.index)}>Insert row below</button>
        <button type="button" role="menuitem" disabled={menu.index === 0} onClick={() => rowAction("up", menu.index)}>Move row up</button>
        <button type="button" role="menuitem" disabled={menu.index === table.rows.length - 1} onClick={() => rowAction("down", menu.index)}>Move row down</button>
        <button type="button" role="menuitem" className="sheet-menu-delete" onClick={() => rowAction("delete", menu.index)}>Delete row</button>
      </> : <>
        <button type="button" role="menuitem" disabled={table.rows.length < 2} onClick={() => sort("asc", menu.index)}>Sort A–Z</button>
        <hr />
        <button type="button" role="menuitem" disabled={table.columns.length >= 30} onClick={() => columnAction("left", menu.index)}>Insert column left</button>
        <button type="button" role="menuitem" disabled={table.columns.length >= 30} onClick={() => columnAction("right", menu.index)}>Insert column right</button>
        <button type="button" role="menuitem" disabled={menu.index === 0} onClick={() => columnAction("leftward", menu.index)}>Move column left</button>
        <button type="button" role="menuitem" disabled={menu.index === table.columns.length - 1} onClick={() => columnAction("rightward", menu.index)}>Move column right</button>
        <button type="button" role="menuitem" className="sheet-menu-delete" disabled={table.columns.length === 1} onClick={() => columnAction("delete", menu.index)}>Delete column</button>
      </>}
    </div>}
  </div>;
}
