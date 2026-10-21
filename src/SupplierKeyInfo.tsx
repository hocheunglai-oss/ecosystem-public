import { CalendarDays, ClipboardCheck, FileText, Fuel, UserRound } from 'lucide-react';
import type { SupplierInfo } from '../shared/suppliers';
import { supplierGrades } from './lib/supplierPresentation';
import './supplier-key-info.css';

const fields = [
  ['paymentTerms', 'PAYMENT TERMS', CalendarDays],
  ['qualityClaimBar', 'QUALITY CLAIM BAR', ClipboardCheck],
  ['supplierTrader', 'SUPPLIER TRADER', UserRound],
  ['availableGrade', 'AVAILABLE GRADES', Fuel],
  ['foBdn', 'FO BDN', FileText],
  ['goBdn', 'GO BDN', FileText],
] as const;

export default function SupplierKeyInfo({ info }: { info: SupplierInfo }) {
  return <dl className="supplier-key-info">{fields.map(([key, label, Icon]) => <div key={key}>
    <dt><Icon size={15} aria-hidden="true" />{label}</dt>
    <dd className={key === 'paymentTerms' || key === 'qualityClaimBar' ? 'supplier-key-term' : ''}>
      {key === 'availableGrade' ? <span className="supplier-key-grades">{supplierGrades(info[key]).map(grade => <span key={grade} data-grade={grade}>{grade}</span>)}{!info[key].trim() && '—'}</span>
        : key === 'paymentTerms' || key === 'qualityClaimBar' ? (info[key].trim() || '—').split(/(\d+(?:\.\d+)?)/).map((part, index) => /^\d/.test(part) && Number(part) !== 30 ? <span className="supplier-key-exception" key={index}>{part}</span> : part)
          : info[key] || '—'}
    </dd>
  </div>)}</dl>;
}
