import { money } from './ui';
import './credit-usage.css';

export function CreditUsage({ limit, used, available, known = true, label = 'Credit used', enquiry = false }: { limit: number; used: number; available: number; known?: boolean; label?: string; enquiry?: boolean }) {
  const percent = limit > 0 ? Math.max(0, Math.min(100, used / limit * 100)) : used > 0 ? 100 : 0;
  const part = (name: string) => `credit-usage__${name}${enquiry ? ` center-credit-${name}` : ''}`;
  return <div className="credit-usage" data-no-limit={!known || limit <= 0} data-over-limit={available < 0}>
    <div className={part("limit")}><span>Credit limit</span><strong>{known ? money(limit) : '—'}</strong></div>
    <div className={part("numbers")}><div><span>Used</span><strong>{known ? money(used) : '—'}</strong></div><div className={available < 0 ? 'is-negative' : ''}><span>Available</span><strong>{known ? money(available) : '—'}</strong></div></div>
    <div className={part("track")} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={known ? `${money(used)} used; ${money(available)} available of ${money(limit)}` : 'No buyer selected'}><span style={{ width: `${percent}%` }} /></div>
    <div className={part("legend")}><span><i />{known && limit > 0 ? `${Math.round(percent)}% used` : 'Used'}</span><span><i />{known && limit > 0 ? `${100 - Math.round(percent)}% available` : 'Available'}</span></div>
  </div>;
}
