import { useDeferredValue, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { useDemo } from './store';
import { indexSupplierFixtures, querySupplierFixtures, type SupplierFixtureQuery, type SupplierFixtureSort } from './lib/supplierFixtures';
import { date, money } from './ui';
import type { OpenModal } from './types';
import './supplier-fixtures.css';

export function SupplierFixtures({ supplierId, search: externalSearch }: { supplierId: string; open: OpenModal; search?: string }) {
  const { state, actor } = useDemo();
  const [search, setSearch] = useState('');
  const effectiveSearch = externalSearch ?? search;
  const deferredSearch = useDeferredValue(effectiveSearch);
  const [query, setQuery] = useState<SupplierFixtureQuery>({ sort: 'date', direction: 'desc', page: 0, pageSize: 50 });
  const records = useMemo(() => indexSupplierFixtures(state, actor, supplierId), [state.outcomes, state.enquiries, state.companies, state.ports, actor, supplierId]);
  const result = useMemo(() => querySupplierFixtures(records, { ...query, search: deferredSearch }), [records, query, deferredSearch]);
  const busy = effectiveSearch !== deferredSearch;
  function sort(key: SupplierFixtureSort) {
    setQuery(current => ({ ...current, sort: key, direction: current.sort === key && current.direction === 'asc' ? 'desc' : 'asc', page: 0 }));
  }
  const heading = (label: string, key: SupplierFixtureSort) => <th scope="col" aria-sort={query.sort === key ? query.direction === 'asc' ? 'ascending' : 'descending' : 'none'}>
    <button type="button" onClick={() => sort(key)}>{label}{query.sort === key && (query.direction === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}</button>
  </th>;
  return <section className="supplier-fixtures" aria-label="Supplier fixtures">
    <header className="knowledge-data-heading"><h3>Fixtures</h3></header>
    {externalSearch === undefined && <label className="supplier-fixtures__search"><Search size={15} aria-hidden="true" /><input aria-label="Search fixtures" placeholder="Search fixtures" value={search} onChange={event => { setSearch(event.target.value); setQuery(current => ({ ...current, page: 0 })); }} /></label>}
    <div className="supplier-fixtures__table-wrap" role="region" aria-label="Supplier fixture records" tabIndex={0} aria-busy={busy}>
      <table>
        <thead><tr>{heading('Date', 'date')}{heading('Vessel', 'vessel')}{heading('Buyer', 'buyer')}{heading('Port', 'port')}<th scope="col">Grade</th><th scope="col" className="supplier-fixtures__number">Quantity <small>MT</small></th><th scope="col" className="supplier-fixtures__number">Buy price <small>USD / MT</small></th></tr></thead>
        {result.rows.map(record => <tbody key={record.id} data-record-id={record.id}>
          {record.productLines.map((product, index) => <tr key={`${product.grade}-${index}`} data-grade={product.grade}>
            {index === 0 && <><td rowSpan={record.productLines.length}>{record.day ? date(record.bookedAt) : '—'}</td><td rowSpan={record.productLines.length}>{record.vessel || '—'}</td><td rowSpan={record.productLines.length}>{record.buyer}</td><td rowSpan={record.productLines.length}>{record.port}</td></>}
            <td>{product.grade || '—'}</td><td className="supplier-fixtures__number">{product.quantityText || '—'}</td><td className="supplier-fixtures__number">{product.buyPrice === undefined ? '—' : money(product.buyPrice)}</td>
          </tr>)}
        </tbody>)}
      </table>
      {!result.rows.length && <p className="supplier-fixtures__empty">No records match these filters.</p>}
    </div>
    <footer className="supplier-fixtures__pagination">
      <span role="status">{result.total ? `${result.page * result.pageSize + 1}–${Math.min((result.page + 1) * result.pageSize, result.total)} of ${result.total.toLocaleString('en-US')}` : '0 records'}</span>
      <label>Fixtures<select aria-label="Fixtures per page" value={result.pageSize} onChange={event => setQuery(current => ({ ...current, pageSize: Number(event.target.value), page: 0 }))}>{[25, 50, 100].map(size => <option key={size} value={size}>{size}</option>)}</select></label>
      <div><button type="button" aria-label="Previous fixtures page" disabled={result.page === 0 || busy} onClick={() => setQuery(current => ({ ...current, page: result.page - 1 }))}><ChevronLeft size={15} /></button><span>Page {result.page + 1} of {result.pages}</span><button type="button" aria-label="Next fixtures page" disabled={result.page + 1 >= result.pages || busy} onClick={() => setQuery(current => ({ ...current, page: result.page + 1 }))}><ChevronRight size={15} /></button></div>
    </footer>
  </section>;
}

export default SupplierFixtures;
