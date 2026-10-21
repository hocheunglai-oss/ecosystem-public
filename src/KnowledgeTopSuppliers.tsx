import { useId } from "react";
import { ArrowUpRight } from "lucide-react";
import { getSupplierIntelligence } from "./lib/intelligence";
import { useIntelligence } from "./Intelligence";
import { matchesKnowledgeSearch } from "./lib/knowledgeSearch";

export function KnowledgeTopSuppliers({ portId, onOpen, search = "" }: {
  portId: string;
  onOpen?: (supplierId: string) => void;
  search?: string;
}) {
  const heading = useId();
  const { snapshot, loading } = useIntelligence();
  const { suppliers, supplierCount, rankingLabel, rankingAsOf } = getSupplierIntelligence(portId, snapshot);
  const title = supplierCount !== null && supplierCount > 10 ? "Top 10 Suppliers" : "Top Suppliers";
  const maximum = Math.max(1, ...suppliers.map(supplier => supplier.fixtureCount ?? 0));
  return <section className="knowledge-top-suppliers" aria-labelledby={heading}>
    <header>
      <h3 id={heading}>{title}</h3>
      {suppliers.length > 0 && <span title={`Snapshot through ${rankingAsOf}`}>Fixtures · {rankingLabel} · {rankingAsOf}</span>}
    </header>
    {suppliers.length ? <><div className="knowledge-supplier-columns" aria-hidden="true"><span>#</span><span>Supplier</span><span>Grades</span><span>Fixtures</span></div><ol>
      {suppliers.map(supplier => ({ supplier, rank: suppliers.findIndex(item => item.fixtureCount === supplier.fixtureCount) + 1 }))
        .filter(({ supplier }) => matchesKnowledgeSearch(search, title, supplier.name, ...supplier.grades)).map(({ supplier, rank }) => {
        const content = <>
          <span className="knowledge-top-supplier-rank" aria-label={`Rank ${rank}`}>{rank}</span>
          <span className="knowledge-top-supplier-name"><strong>{supplier.name}</strong><small>{supplier.grades.join(" · ") || "—"}</small></span>
          <span className="knowledge-top-supplier-count" aria-label={`${supplier.fixtureCount ?? "—"} fixtures`}><span className="knowledge-supplier-bar" aria-hidden="true"><i style={{ width: `${(supplier.fixtureCount ?? 0) / maximum * 100}%` }} /></span><strong>{supplier.fixtureCount ?? "—"}</strong></span>
          {onOpen && <ArrowUpRight size={14} aria-hidden="true" />}
        </>;
        return <li key={supplier.id} value={rank} data-rank={rank}>{onOpen
          ? <button type="button" onClick={() => onOpen(supplier.id)}>{content}</button>
          : <div>{content}</div>}
        </li>;
      })}
    </ol></> : <p className="knowledge-empty">{loading ? "Loading fixture data…" : supplierCount === null ? "Fixture data unavailable" : "—"}</p>}
  </section>;
}
