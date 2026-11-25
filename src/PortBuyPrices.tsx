import { useDeferredValue, useState } from "react";
import type { PortFixturePrices } from "../shared/portFixtureReports";
import { useDemo } from "./store";
import { useTestWorkspace } from "./TestWorkspace";
import { portBuyPriceRows } from "./lib/knowledgeSearch";
import { usePortFixtureReport } from "./lib/portFixtureReports";
import { money, SearchBox } from "./ui";

const reportDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' });

export default function PortBuyPrices({ portId, scopeId, title, search, searchResults }: {
  portId: string; scopeId?: string; title: string; search?: string; searchResults?: PortFixturePrices;
}) {
  const { state } = useDemo();
  const { dataMode } = useTestWorkspace();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const deferredQuery = useDeferredValue(query.trim());
  const report = usePortFixtureReport('prices', scopeId, search === undefined, deferredQuery, page);
  const shared = search === undefined ? report.data : searchResults;
  const useLocal = dataMode === 'test' || !scopeId;
  const local = useLocal ? portBuyPriceRows(state, portId, search ?? query).flatMap(row =>
    row.buyPrice != null && Number.isFinite(row.buyPrice) && row.buyPrice > 0
      ? [{ ...row, quantity: row.quantityText, price: row.buyPrice }] : []) : [];
  const total = shared?.total ?? local.length;
  const pageSize = shared?.pageSize ?? 50;
  const rows = shared?.items ?? local.slice(page * pageSize, (page + 1) * pageSize);
  const loading = report.loading || deferredQuery !== query.trim();
  const pageable = search === undefined && (page > 0 || total > pageSize);
  return (
    <section className="port-buy-prices" aria-label={title} aria-busy={loading}>
      <div className="card-heading knowledge-data-heading"><h3>{title}</h3></div>
      {search === undefined && <SearchBox value={query} onChange={value => { setQuery(value.slice(0, 160)); setPage(0); }}
        placeholder={'Search ' + title.toLowerCase()} />}
      {report.error && <div className="port-report-toolbar" role="alert">
        <span>PRICE HISTORY UNAVAILABLE.</span><button className="button secondary" onClick={report.refresh}>RETRY</button>
      </div>}
      {loading && <p className="knowledge-empty" role="status">LOADING PRICES…</p>}
      {!loading && !report.error && <div className="port-report-table table-wrap" role="region" aria-label="Historical buy prices" tabIndex={0}>
        <table>
          <thead><tr><th scope="col">DATE</th><th scope="col">SUPPLIER</th><th scope="col">VESSEL</th>
            <th scope="col">GRADE</th><th scope="col">QUANTITY (MT)</th><th scope="col">BUY PRICE (USD / MT)</th></tr></thead>
          <tbody>{rows.length ? rows.map(row => (
            <tr key={row.id}><td>{reportDate.format(new Date(row.date))}</td><td>{row.supplier}</td>
              <td>{row.vessel}</td><td>{row.grade}</td><td>{row.quantity}</td><td>{money(row.price)}</td></tr>
          )) : <tr><td colSpan={6}>NO PRICES FOUND.</td></tr>}</tbody>
        </table>
      </div>}
      {pageable && <div className="knowledge-pagination">
        <button disabled={!page || loading} onClick={() => setPage(page - 1)}>PREVIOUS</button>
        <span>{page * pageSize + (rows.length ? 1 : 0)}–{page * pageSize + rows.length} / {total}</span>
        <button disabled={(page + 1) * pageSize >= total || loading} onClick={() => setPage(page + 1)}>NEXT</button>
      </div>}
    </section>
  );
}
