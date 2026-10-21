import { actors, canTrade, isPendingOutcome, type Actor, type DemoState, type Outcome } from './model';
import { fixtureProductLines, outcomeSupplierNames } from './fixtureSuppliers';
import { uppercaseText } from './uppercase';

export type RecordSort = 'date' | 'vessel' | 'buyer' | 'port' | 'supplier';
export interface RecordRow {
  outcome: Outcome;
  day: string;
  timestamp: number;
  buyer: string;
  port: string;
  trader: string;
  eta: string;
  imo: string;
  quantities: Record<string, string>;
  productLines: ReturnType<typeof fixtureProductLines>;
  suppliers: string[];
  search: string;
}
export interface RecordQuery {
  kind: 'fixture' | 'lost';
  search: string;
  from: string;
  to: string;
  portId: string;
  status: 'all' | 'pending' | 'delivered';
  sort: RecordSort;
  direction: 'asc' | 'desc';
  page: number;
  pageSize: number;
}
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const reportingDate = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'});
export function recordDay(value: string) {
  const parsed=new Date(value);
  return Number.isFinite(parsed.getTime()) ? reportingDate.format(parsed) : '';
}
export function recordPeriod(period: 'month' | '12m' | 'all', now = new Date()) {
  const to=reportingDate.format(now);
  if(period==='all')return {from:'',to:''};
  if(period==='month')return {from:to.slice(0,7)+'-01',to};
  const [year,month,day]=to.split('-').map(Number);
  const clamped=Math.min(day,new Date(Date.UTC(year-1,month,0)).getUTCDate());
  return {from:new Date(Date.UTC(year-1,month-1,clamped+1)).toISOString().slice(0,10),to};
}

/** Demo adapter: builds lookups once per data revision, before querying bounded pages.
 * A live adapter must apply the same authorization and filters on the server. */
export function indexRecords(state: Pick<DemoState,'companies'|'ports'|'enquiries'|'outcomes'>, actor: Actor): RecordRow[] {
  const companies=new Map(state.companies.map(row=>[row.id,row.name.toUpperCase()]));
  const ports=new Map(state.ports.map(row=>[row.id,row.name]));
  const enquiries=new Map(state.enquiries.map(row=>[row.id,row]));
  const traders=new Map(actors.map(row=>[row.id,row.name]));
  return state.outcomes.filter(row=>!canTrade(actor)||row.owner===actor.id).map(outcome=>{
    const enquiry=enquiries.get(outcome.enquiryId);
    const buyer=companies.get(outcome.buyerId)||'—';
    const port=ports.get(outcome.portId)||'—';
    const trader=traders.get(outcome.owner)||'—';
    const eta=enquiry?.eta||'';
    const imo=outcome.imo||enquiry?.imo||'';
    const productLines=fixtureProductLines(outcome);
    const suppliers=outcome.kind==='fixture'?outcomeSupplierNames(outcome):[outcome.supplierName||''].filter(Boolean);
    const quantities:Record<string,string>={};
    const products=outcome.stemProducts?.length ? outcome.stemProducts : outcome.products?.length ? outcome.products.map(p=>({grade:p.grade,quantityText:p.quantity.toLocaleString('en-US')})) : outcome.requestedProducts?.length ? outcome.requestedProducts : [{grade:outcome.grade,quantityText:outcome.quantity.toLocaleString('en-US')}];
    for(const product of products) quantities[product.grade]=product.quantityText;
    return {outcome,day:recordDay(outcome.bookedAt),timestamp:Date.parse(outcome.bookedAt),buyer,port,trader,eta,imo,quantities,productLines,suppliers,search:[outcome.vessel,buyer,port,trader,imo,...suppliers,outcome.reason,outcome.groupNote].join(' ').toLocaleLowerCase('en')};
  });
}
export const recordStatus = (outcome: Outcome) => outcome.kind==='lost' ? 'Lost' : outcome.actualVolume ? 'Delivered' : isPendingOutcome(outcome) ? 'Pending actual volume' : 'Booked';
export function queryRecords(rows: RecordRow[], query: RecordQuery) {
  const words=query.search.trim().toLocaleLowerCase('en').split(/\s+/).filter(Boolean);
  const invalidRange=!!query.from && !!query.to && query.from>query.to;
  const filtered=invalidRange ? [] : rows.filter(row=>{
    const o=row.outcome;
    if(o.kind!==query.kind || (query.portId && o.portId!==query.portId))return false;
    const day=row.day;
    if(!day)return false;
    if((query.from&&day<query.from)||(query.to&&day>query.to))return false;
    if(query.status==='pending' && (!isPendingOutcome(o)||o.actualVolume))return false;
    if(query.status==='delivered' && !o.actualVolume)return false;
    return words.every(word=>row.search.includes(word));
  });
  const multiplier=query.direction==='asc'?1:-1;
  filtered.sort((a,b)=>{
    if(query.sort==='date')return multiplier*((a.timestamp-b.timestamp)||collator.compare(a.outcome.id,b.outcome.id));
    const av=query.sort==='vessel'?a.outcome.vessel:query.sort==='supplier'?a.suppliers.join(' / '):a[query.sort];
    const bv=query.sort==='vessel'?b.outcome.vessel:query.sort==='supplier'?b.suppliers.join(' / '):b[query.sort];
    return multiplier*(collator.compare(av,bv)||collator.compare(a.outcome.id,b.outcome.id));
  });
  const pageSize=[25,50,100].includes(query.pageSize)?query.pageSize:50;
  const pages=Math.max(1,Math.ceil(filtered.length/pageSize));
  const page=Math.max(0,Math.min(Number.isFinite(query.page)?Math.floor(query.page):0,pages-1));
  return {rows:filtered.slice(page*pageSize,(page+1)*pageSize),total:filtered.length,page,pages,pageSize,invalidRange};
}
const csvCell=(input:string)=>{
  const text=uppercaseText(input);
  // Formula-like user text must not execute when opened in Excel.
  const safe=/^[\s]*[=+\-@]/.test(text)?`'${text}`:text;
  return `"${safe.replaceAll('"','""')}"`;
};
/** Export the visible page only; never includes private notes or hidden record fields. */
export function recordsCsv(rows:RecordRow[],kind:'fixture'|'lost') {
  const headers=['Date','Vessel','Buyer','Trader','Port','ETA','IMO',...(kind==='fixture'?['Grade','Quantity (MT)','Supplier','Buy price (USD/MT)','Status']:['HSFO (MT)','VLSFO (MT)','LSMGO (MT)','Lost reason','Group note'])];
  const lines=rows.flatMap(row=>{
    const shared=[recordDay(row.outcome.bookedAt),row.outcome.vessel,row.buyer,row.trader,row.port,row.eta,row.imo];
    return kind==='fixture'
      ?row.productLines.map(product=>[...shared,product.grade,product.quantityText,product.supplierName==='—'?'':product.supplierName,product.buyPrice===undefined?'':String(product.buyPrice),recordStatus(row.outcome)])
      :[[...shared,...['HSFO','VLSFO','LSMGO'].map(grade=>row.quantities[grade]||''),row.outcome.reason,row.outcome.groupNote||'']];
  });
  return '\uFEFF'+[headers,...lines].map(row=>row.map(csvCell).join(',')).join('\r\n');
}
