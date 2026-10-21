import { useState } from "react";
import { useDemo } from "./store";
import { portBuyPriceRows } from "./lib/knowledgeSearch";
import { date, money, SearchBox } from "./ui";

export function PortBuyPrices({ portId, title = "Buy prices", search }: { portId: string; title?: string; search?: string }) {
  const { state } = useDemo();
  const [query, setQuery] = useState("");
  const rows = portBuyPriceRows(state, portId, search ?? query);
  return (
    <section className="port-buy-prices" aria-label={title}>
      <div className="card-heading knowledge-data-heading">
        <h3>{title}</h3>
      </div>
      {search === undefined && <SearchBox
        value={query}
        onChange={setQuery}
        placeholder={`Search ${title.toLowerCase()}`}
      />}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Supplier</th>
              <th>Vessel</th>
              <th>Grade</th>
              <th>Quantity (MT)</th>
              <th>Buy price (USD / MT)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{date(row.date)}</td>
                <td>{row.supplier.toUpperCase()}</td>
                <td>{row.vessel}</td>
                <td>{row.grade}</td>
                <td>{row.quantityText}</td>
                <td>{money(row.buyPrice)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default PortBuyPrices;
