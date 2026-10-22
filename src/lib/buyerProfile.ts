import { reportingDate } from './reportingDate.ts';
import type { Company, DemoState, Outcome } from './model.ts';

export type BuyerPeriod = '12m' | 'year' | 'all';
export const buyerGroupKey = (buyer: Company) => buyer.accountGroupId?.trim() || buyer.id;
const dayMs = 86_400_000;
const calendarDay = (value?: string) => {
  if (!value || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const day = value.slice(0, 10);
  const parsed = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === day ? parsed : null;
};
export function paymentDays(stem: Outcome, today: string) {
  const payment = stem.payment;
  const invoice = calendarDay(payment?.invoiceDate);
  const due = calendarDay(payment?.dueDate);
  const paid = calendarDay(payment?.paidDate);
  const now = calendarDay(today)!;
  // An absent payment record is unknown, not an unpaid invoice.
  if (!payment || due === null || (payment.paidDate && paid === null) || (payment.invoiceDate && invoice === null) || (invoice !== null && invoice > now) || (invoice !== null && due < invoice) || (paid !== null && (paid > now || (invoice !== null && paid < invoice)))) {
    return { known: false, delayed: false, days: null, delay: null, status: '—' };
  }
  const delay = paid === null ? null : Math.max(0, (paid - due) / dayMs);
  return {
    known: true, delayed: (paid ?? now) > due,
    days: paid !== null && invoice !== null ? (paid - invoice) / dayMs : null,
    delay,
    status: paid !== null ? (paid > due ? 'Paid late' : 'Paid') : now > due ? 'Overdue' : 'Outstanding',
  };
}

export function buyerPerformance(state: DemoState, buyerId: string, period: BuyerPeriod = '12m', now = new Date()) {
  const today = reportingDate.format(now);
  const end = calendarDay(today)!;
  const [year, month, day] = today.split('-').map(Number);
  const priorYearDay = Math.min(day, new Date(Date.UTC(year - 1, month, 0)).getUTCDate());
  const start = period === 'all' ? -Infinity : period === 'year' ? Date.UTC(year, 0, 1) : Date.UTC(year - 1, month - 1, priorYearDay) + dayMs;
  const recordDay = (value: string) => {
    if (!value.includes('T')) return calendarDay(value);
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? calendarDay(reportingDate.format(parsed)) : null;
  };
  const inPeriod = (value: string) => { const date = recordDay(value); return date !== null && date >= start && date <= end; };
  // One commercial STEM per enquiry, irrespective of product lines or duplicate imports.
  const stemMap = new Map<string, Outcome>();
  for (const stem of state.outcomes.filter(item => item.buyerId === buyerId && item.kind === 'fixture').sort((a,b) => a.bookedAt.localeCompare(b.bookedAt))) {
    if (!stemMap.has(stem.enquiryId)) stemMap.set(stem.enquiryId, stem);
  }
  const stems = [...stemMap.values()].filter(stem => inPeriod(stem.bookedAt)).sort((a,b) => b.bookedAt.localeCompare(a.bookedAt));
  const enquiries = state.enquiries.filter(item => item.buyerId === buyerId && (item.sentAt || ['sent','fixture','lost','postponed'].includes(item.status)) && inPeriod(item.sentAt || item.createdAt));
  const enquiryIds = new Set(enquiries.map(item => item.id));
  // Count conversion of the same enquiry cohort, even if it stems later in the period.
  const won = [...enquiryIds].filter(id => {
    const stem = stemMap.get(id);
    const booked = stem ? recordDay(stem.bookedAt) : null;
    return booked !== null && booked <= end;
  }).length;
  const payments = stems.map(stem => paymentDays(stem, today));
  const average = (values: number[]) => values.length ? values.reduce((sum,value) => sum + value, 0) / values.length : null;
  const known = payments.filter(item => item.known);
  return {
    stems, enquiryCount: enquiryIds.size, convertedEnquiries: won,
    hitRate: enquiryIds.size ? won / enquiryIds.size * 100 : null,
    paymentCoverage: known.length,
    stemDelayed: known.length ? known.filter(item => item.delayed).length : null,
    averagePaymentDays: average(payments.flatMap(item => item.days === null ? [] : [item.days])),
    averageDelay: average(payments.flatMap(item => item.delay === null ? [] : [item.delay])),
    today,
  };
}

/** Role-scoped demo view only. Production privacy requires authenticated server storage. */
export function buyerPrivateRemark(state: DemoState, buyerId: string, actorId: string): string {
  const note = state.buyerPrivateRemarks?.[JSON.stringify([actorId, buyerId])];
  return note?.owner === actorId && note.buyerId === buyerId ? note.text : '';
}

/** Exact volumes only; pending ranges and missing pricing never become invented totals. */
export function buyerTrends(stems: Outcome[], now = new Date()) {
  const today = reportingDate.format(now);
  const [year, month] = today.split('-').map(Number);
  const points = Array.from({length:6}, (_,index) => ({
    month: new Date(Date.UTC(year,month-6+index,1)).toISOString().slice(0,7), volume:0, pricedVolume:0, profit:0, margin:null as number|null,
  }));
  const seen = new Set<string>();
  for (const stem of [...stems].sort((a,b)=>a.bookedAt.localeCompare(b.bookedAt))) {
    if (stem.kind !== 'fixture' || seen.has(stem.enquiryId)) continue;
    seen.add(stem.enquiryId);
    const parsed = new Date(stem.bookedAt);
    if (!Number.isFinite(parsed.getTime())) continue;
    const day = stem.bookedAt.includes('T') ? reportingDate.format(parsed) : stem.bookedAt.slice(0,10);
    if (day > today) continue;
    const point = points.find(item=>item.month===day.slice(0,7));
    if (!point) continue;
    const products = stem.products?.length ? stem.products : [stem];
    const exact = stem.actualVolume?.quantity ?? (stem.commercialStatus === 'pending' ? null : products.reduce((sum,item)=>sum+item.quantity,0));
    if (exact === null || !Number.isFinite(exact) || exact <= 0) continue;
    point.volume += exact;
    if (stem.commercialStatus === 'pending' || products.some(item=>!Number.isFinite(item.quantity)||item.quantity<=0||!Number.isFinite(item.margin))) continue;
    point.pricedVolume += products.reduce((sum,item)=>sum+item.quantity,0);
    point.profit += products.reduce((sum,item)=>sum+item.quantity*item.margin,0);
  }
  return points.map(point=>({...point, margin:point.pricedVolume ? point.profit/point.pricedVolume : null}));
}
