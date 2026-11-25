import { useId } from "react";
import { ArrowUpRight } from "lucide-react";
import type { PortFixtureRanking } from "../shared/portFixtureReports";
import { matchesKnowledgeSearch } from "./lib/knowledgeSearch";

export function KnowledgeTopSuppliers({ data, loading, error, onOpen, search = "" }: {
  data?: PortFixtureRanking;
  loading: boolean;
  error?: boolean;
  onOpen?: (supplierId: string) => void;
  search?: string;
}) {
  const heading = useId();
  const suppliers = data?.items ?? [];
  const title = (data?.supplierCount ?? 0) >= 10 ? "Top 10 Suppliers" : "Top Suppliers";
  const maximum = Math.max(1, ...suppliers.map(supplier => supplier.fixtures));
  return <section className="knowledge-top-suppliers" aria-labelledby={heading} aria-busy={loading}>
    <header>
      <h3 id={heading}>{title}</h3>
      {data && suppliers.length > 0 && <span>{data.personal ? 'My fixtures' : 'Fixtures'} · Last 12 months · {data.through}</span>}
    </header>
    {suppliers.length ? <><div className="knowledge-supplier-columns" aria-hidden="true"><span>#</span><span>Supplier</span><span>Grades</span><span>Fixtures</span></div><ol>
      {suppliers.map(supplier => ({ supplier, rank: suppliers.findIndex(item => item.fixtures === supplier.fixtures) + 1 }))
        .filter(({ supplier }) => matchesKnowledgeSearch(search, "Top Suppliers", title, supplier.name, ...supplier.grades)).map(({ supplier, rank }) => {
        const content = <>
          <span className="knowledge-top-supplier-rank" aria-label={'Rank ' + rank}>{rank}</span>
          <span className="knowledge-top-supplier-name"><strong>{supplier.name}</strong><small>{supplier.grades.join(" · ") || "—"}</small></span>
          <span className="knowledge-top-supplier-count" aria-label={supplier.fixtures + ' fixtures'}><span className="knowledge-supplier-bar" aria-hidden="true"><i style={{ width: (supplier.fixtures / maximum * 100) + '%' }} /></span><strong>{supplier.fixtures}</strong></span>
          {onOpen && <ArrowUpRight size={14} aria-hidden="true" />}
        </>;
        return <li key={supplier.id} value={rank} data-rank={rank}>{onOpen
          ? <button type="button" onClick={() => onOpen(supplier.id)}>{content}</button>
          : <div>{content}</div>}
        </li>;
      })}
    </ol></> : <p className="knowledge-empty" role={loading ? 'status' : error ? 'alert' : undefined}>
      {loading ? "Loading fixture data…" : error ? "Fixture data unavailable" : "—"}
    </p>}
  </section>;
}
