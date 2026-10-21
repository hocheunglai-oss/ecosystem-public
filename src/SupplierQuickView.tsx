import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import type { SupplierRecord, SupplierSummary } from '../shared/suppliers';
import type { SupplierTab } from './SharedSupplierProfile';
import { useAccess } from './auth';
import { useDemo } from './store';
import { Modal } from './ui';
import SupplierFixtures from './SupplierFixtures';
import { supplierApi } from './lib/supplierApi';
import { supplierContacts, supplierShortName } from './lib/supplierPresentation';
import { indexRecords } from './lib/recordQuery';
import './supplier-quick-view.css';

export type SupplierQuickViewType = 'bdn' | 'contacts' | 'barges' | 'fixtures';
const titles: Record<SupplierQuickViewType, string> = { bdn: 'BDN', contacts: 'CONTACT', barges: 'BARGE FLEET', fixtures: 'FIXTURES' };

type Props = {
  supplier: SupplierSummary;
  view: SupplierQuickViewType;
  onClose: () => void;
  onOpenProfile?: (tab: SupplierTab) => void;
};

/** Count the same actor-visible, exact-ID fixture records used by SupplierFixtures.
 * Snapshot totals and name-only matches do not identify accessible transactions. */
export function useSupplierFixtureCounts(items: readonly Pick<SupplierSummary, 'id'>[]): Map<string, number> {
  const { state, actor } = useDemo();
  const { realUser } = useAccess();
  return useMemo(() => {
    const counts = new Map(items.map(item => [item.id, 0]));
    if (!realUser?.isActive) return counts;
    for (const row of indexRecords(state, actor)) {
      if (row.outcome.kind !== 'fixture') continue;
      const suppliers = new Set(row.productLines.map(line => line.supplierId).filter((id): id is string => Boolean(id)));
      for (const id of suppliers) if (counts.has(id)) counts.set(id, counts.get(id)! + 1);
    }
    return counts;
  }, [items, state.outcomes, state.enquiries, state.companies, state.ports, actor, realUser?.id, realUser?.isActive]);
}

export default function SupplierQuickView(props: Props) {
  const { realUser, preview } = useAccess();
  if (!realUser?.isActive) return null;
  return <QuickViewContent key={`${realUser.id}:${Boolean(preview)}:${props.supplier.id}:${props.view}`} {...props} />;
}

function QuickViewContent({ supplier, view, onClose, onOpenProfile }: Props) {
  const [item, setItem] = useState<SupplierRecord | null>(null);
  const [loading, setLoading] = useState(view !== 'fixtures');
  const [error, setError] = useState('');
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (view === 'fixtures') return;
    const controller = new AbortController();
    setLoading(true); setError(''); setItem(null);
    void supplierApi.detail(supplier.id, controller.signal).then(result => {
      if (!controller.signal.aborted) { setItem(result.item); setLoading(false); }
    }).catch(failure => {
      if (!controller.signal.aborted) { setError((failure as Error).message); setLoading(false); }
    });
    return () => controller.abort();
  }, [supplier.id, view, generation]);

  const contacts = item ? supplierContacts(item) : [];
  const name = supplierShortName(supplier);
  return <Modal title={`${name} · ${titles[view]}`} onClose={onClose} wide={view === 'fixtures'}>
    <div className="supplier-quick-view" data-view={view}>
      {loading && <p className="supplier-quick-view__empty" role="status">LOADING…</p>}
      {error && <div className="supplier-quick-view__error" role="alert"><p>{error}</p><button type="button" className="button secondary" onClick={() => setGeneration(value => value + 1)}>RETRY</button></div>}
      {!loading && item && view === 'bdn' && <dl className="supplier-quick-view__bdn">
        <div><dt>FO BDN</dt><dd>{item.info.foBdn.trim() || '—'}</dd></div>
        <div><dt>GO BDN</dt><dd>{item.info.goBdn.trim() || '—'}</dd></div>
      </dl>}
      {!loading && item && view === 'contacts' && <div className="supplier-quick-view__contacts">
        {(['sales', 'ops', 'general'] as const).map(role => {
          const rows = contacts.filter(contact => contact.role === role);
          if (!rows.length) return null;
          return <section key={role}>
            <h3>{role === 'ops' ? 'OPERATION' : role === 'sales' ? 'SALES' : 'CONTACT'}</h3>
            <table className="supplier-quick-view__table" aria-label={`${role === 'ops' ? 'Operation' : role === 'sales' ? 'Sales' : 'General'} contacts`}>
              <thead><tr><th scope="col">NAME</th><th scope="col">PHONE</th></tr></thead>
              <tbody>{rows.map(contact => <tr key={contact.id}><td data-label="NAME">{contact.name || '—'}</td><td data-label="PHONE">{contact.phone || '—'}</td></tr>)}</tbody>
            </table>
          </section>;
        })}
        {!contacts.length && <p className="supplier-quick-view__empty">NO CONTACTS RECORDED.</p>}
      </div>}
      {!loading && item && view === 'barges' && (item.barges.length ? <table className="supplier-quick-view__table supplier-quick-view__barges" aria-label="Barge fleet">
        <thead><tr><th scope="col">NAME</th><th scope="col">IMO</th><th scope="col">GRADE</th><th scope="col">CAPACITY</th></tr></thead>
        <tbody>{item.barges.map(barge => <tr key={barge.id}><td data-label="NAME">{barge.name || '—'}</td><td data-label="IMO">{barge.imo || '—'}</td><td data-label="GRADE">{barge.grade || '—'}</td><td data-label="CAPACITY">{barge.capacity || '—'}</td></tr>)}</tbody>
      </table> : <p className="supplier-quick-view__empty">NO BARGES RECORDED.</p>)}
      {view === 'fixtures' && <SupplierFixtures supplierId={supplier.id} open={() => undefined} />}
      {onOpenProfile && <footer className="supplier-quick-view__footer"><button type="button" className="button secondary" aria-label="Open profile" onClick={() => onOpenProfile(view === 'fixtures' || view === 'bdn' ? 'information' : view)}>OPEN PROFILE<ArrowUpRight size={14} /></button></footer>}
    </div>
  </Modal>;
}
