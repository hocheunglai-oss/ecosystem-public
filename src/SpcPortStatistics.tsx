import type { ReactNode } from 'react';
import type { SpcStatistics } from '../shared/portFixtureReports';
import { usePortFixtureReport } from './lib/portFixtureReports';

const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const decimal = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });
const number = (value: number) => decimal.format(value);

function ReportCard({ title, detail, children }: { title: string; detail?: string; children: ReactNode }) {
  return <section className="port-report-card" aria-label={title}>
    <header><h3>{title}</h3>{detail && <span>{detail}</span>}</header>
    {children}
  </section>;
}

function VolumeChart({ monthly, year, estimated }: SpcStatistics) {
  const max = Math.max(1, ...monthly.flatMap(month => [month.previous, month.current]));
  return <ReportCard title="MONTHLY VOLUME" detail={estimated ? 'MT · INCLUDES ESTIMATES' : 'MT'}>
    <div className="port-volume-scroll" role="region" aria-label="Monthly volume chart" tabIndex={0}>
      <ol className="port-volume-chart">
        {monthly.map(({ month, previous, current }) => {
          const label = months[month - 1];
          return <li key={month} aria-label={label + ' ' + (year - 1) + ' ' + number(previous) + ' MT, ' + year + ' ' + number(current) + ' MT'}>
            <div className="port-volume-bars">
              {[previous, current].map((volume, index) => <span key={index} data-year={index ? 'current' : 'previous'}
                title={(year - 1 + index) + ' ' + label + ' · ' + number(volume) + ' MT'}
                style={{ height: (volume / max * 100) + '%' }} />)}
            </div>
            <b>{label}</b>
            <div className="port-volume-values" aria-hidden="true"><span>{number(previous)}</span><strong>{number(current)}</strong></div>
          </li>;
        })}
      </ol>
    </div>
    <div className="port-volume-legend"><span data-year="previous">{year - 1}</span><span data-year="current">{year}</span></div>
  </ReportCard>;
}

function Rankings({ title, detail, rows }: { title: string; detail: string; rows: SpcStatistics['volumeBySupplier'] }) {
  const max = Math.max(1, ...rows.map(row => row.value));
  return <ReportCard title={title} detail={detail}>
    {rows.length ? <ul className="port-stat-ranks">
      {rows.map(({ label, value }, index) => <li key={label + ':' + index}>
        <b>{label}</b><span className="knowledge-supplier-bar" aria-hidden="true"><i style={{ width: (value / max * 100) + '%' }} /></span>
        <span>{number(value)}</span>
      </li>)}
    </ul> : <p className="knowledge-empty">NO DATA.</p>}
  </ReportCard>;
}

function ReportTable({ title, detail, columns, rows }: { title: string; detail: string; columns: string[]; rows: ReactNode[][] }) {
  return <ReportCard title={title} detail={detail}>
    <div className="port-report-table table-wrap"><table>
      <thead><tr>{columns.map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
      <tbody>{rows.length ? rows.map((row, index) => <tr key={index}>
        {row.map((cell, position) => position === 0
          ? <th key={position} scope="row">{cell}</th>
          : <td key={position}>{cell}</td>)}
      </tr>) : <tr><td colSpan={columns.length}>NO DATA.</td></tr>}</tbody>
    </table></div>
  </ReportCard>;
}

const hitRateColumns = ['NAME', 'ENQUIRIES', 'FIXTURES', 'HIT RATE'];
const hitRateRows = (rows: SpcStatistics['byBuyerOffice']) => rows.map(row => [
  row.label, number(row.enquiries), number(row.fixtures), number(row.fixtures / row.enquiries * 100) + '%',
]);
const recent = 'LAST 90 DAYS';

export default function SpcPortStatistics() {
  const { data, loading, error, refresh } = usePortFixtureReport('statistics', 'port-singapore', true);
  return <section className="port-statistics" aria-label="SPC Statistics" aria-busy={loading}>
    <div className="port-report-toolbar">
      <div>{data && <><span>{recent} · {data.through}</span><span>CANCELLED FIXTURES · {number(data.cancelled)}</span></>}</div>
      <button type="button" className="button secondary" onClick={refresh} disabled={loading}>REFRESH</button>
    </div>
    {loading && <p className="knowledge-empty" role="status">LOADING STATISTICS…</p>}
    {error && <p className="knowledge-empty" role="alert">STATISTICS UNAVAILABLE.</p>}
    {data && <>
      <VolumeChart {...data} />
      <div className="port-stat-grid">
        <Rankings title="VOLUME BY SUPPLIER" detail={recent + ' · MT'} rows={data.volumeBySupplier} />
        <Rankings title="FIXTURES BY SUPPLIER" detail={recent} rows={data.fixturesBySupplier} />
        <Rankings title="VOLUME BY OFFICE" detail={recent + ' · MT'} rows={data.volumeByOffice} />
        <Rankings title="FIXTURES BY OFFICE" detail={recent} rows={data.fixturesByOffice} />
        <ReportTable title="SPC WORKLOAD" detail={recent} columns={['ENQUIRIES', 'DAYS', 'AVG / DAY']}
          rows={[[number(data.enquiries), '90', number(data.enquiries / 90)]]} />
        <ReportTable title="BUYER OFFICE HIT RATE" detail={recent} columns={hitRateColumns} rows={hitRateRows(data.byBuyerOffice)} />
        <ReportTable title="BUYER TRADER HIT RATE" detail={recent} columns={hitRateColumns} rows={hitRateRows(data.byBuyerTrader)} />
        <ReportTable title="FIXTURES BY SUPPLIER TRADER" detail={recent} columns={['SUPPLIER TRADER', 'FIXTURES']}
          rows={data.bySupplierTrader.map(row => [row.label, number(row.value)])} />
      </div>
    </>}
  </section>;
}
