import { useState } from 'react';
import { useAccess } from './auth';
import { date, SearchBox } from './ui';
import { useCommercialEnquiries } from './useCommercialEnquiries';
import type { CommercialProduct } from '../shared/commercialEnquiries';
import type { OpenWorkspace } from './workspaceNavigation';

const grades: CommercialProduct['grade'][] = ['HSFO', 'VLSFO', 'LSMGO'];

export function LiveLostRecords({ onOpen }: { onOpen: OpenWorkspace }) {
  const { realUser, preview } = useAccess();
  const [search, setSearch] = useState('');
  const owner = realUser?.id ?? '';
  const list = useCommercialEnquiries(owner, Boolean(realUser?.isActive && realUser.activated && !preview), 'lost');
  const query = search.trim().toUpperCase();
  const rows = list.rows.filter(item => [item.vessel, item.imo, item.ownerName, item.port?.portName, item.lostReason]
    .join(' ').toUpperCase().includes(query));

  return <section className="record-sheet" aria-label="Lost records">
    <div className="record-sheet__toolbar">
      <SearchBox value={search} onChange={setSearch} placeholder="Search records" />
    </div>
    {list.error && <div role="alert">{list.error} <button type="button" className="ui-button ui-button--secondary" onClick={() => void list.reload()}>RETRY</button></div>}
    <div className="record-sheet__grid" role="region" aria-label="Record table" tabIndex={0} aria-busy={list.busy}>
      <table>
        <thead><tr>{['DATE', 'VESSEL', 'TRADER', 'PORT', 'ETA', 'IMO', ...grades, 'LOST REASON']
          .map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
        <tbody>
          {rows.map(item => <tr key={item.id} data-record-id={item.id}>
            <td>{date(item.updatedAt)}</td>
            <td className="record-sheet__vessel">{item.ownerId === owner
              ? <button className="text-button" onClick={() => onOpen('enquiry', { enquiryId: item.id })}>{item.vessel}</button>
              : item.vessel}</td>
            <td>{item.ownerName}</td><td>{item.port?.portName ?? '—'}</td><td>{item.eta}</td><td>{item.imo || '—'}</td>
            {grades.map(grade => <td className="record-sheet__number" key={grade}>
              {item.products.find(product => product.grade === grade)?.quantityText ?? '—'}</td>)}
            <td>{item.lostReason}</td>
          </tr>)}
          {!rows.length && !list.busy && <tr><td colSpan={10}>NO LOST RECORDS</td></tr>}
        </tbody>
      </table>
    </div>
    {list.cursor && <button type="button" className="ui-button ui-button--secondary" disabled={list.busy} onClick={() => void list.more()}>LOAD MORE</button>}
  </section>;
}
