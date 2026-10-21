import { uppercaseText } from "./lib/uppercase";
import { useDeferredValue, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Download, Search } from 'lucide-react';
import { useDemo } from './store';
import { getOutcomePrivateNote, isPendingOutcome } from './lib/model';
import { indexRecords, queryRecords, recordPeriod, recordsCsv, recordStatus, type RecordQuery, type RecordSort } from './lib/recordQuery';
import { date, money } from './ui';
import type { OpenModal } from './types';

export default function RecordsPage({open,kind='fixture'}:{open:OpenModal;kind?:'fixture'|'lost'}) {
  const {state,actor}=useDemo();
  const [search,setSearch]=useState('');
  const deferredSearch=useDeferredValue(search);
  const [query,setQuery]=useState<RecordQuery>(()=>({kind,search:'',...recordPeriod('12m'),portId:'',status:'all',sort:'date',direction:'desc',page:0,pageSize:50}));
  const [period,setPeriod]=useState('12m');
  const change=(next:Partial<RecordQuery>)=>setQuery(current=>({...current,...next,page:0}));
  const indexed=useMemo(()=>indexRecords(state,actor),[state.outcomes,state.enquiries,state.companies,state.ports,actor]);
  const result=useMemo(()=>queryRecords(indexed,{...query,kind,search:deferredSearch}),[indexed,query,kind,deferredSearch]);
  const sort=(key:RecordSort)=>change({sort:key,direction:query.sort===key&&query.direction==='asc'?'desc':'asc'});
  const heading=(label:string,key:RecordSort,className?:string)=><th scope="col" className={className} aria-sort={query.sort===key?(query.direction==='asc'?'ascending':'descending'):'none'}><button onClick={()=>sort(key)}>{label}{query.sort===key&&(query.direction==='asc'?<ArrowUp size={12}/>:<ArrowDown size={12}/>)}</button></th>;
  const exportPage=()=>{
    const url=URL.createObjectURL(new Blob([recordsCsv(result.rows,kind)],{type:'text/csv;charset=utf-8'}));
    const a=document.createElement('a');a.href=url;a.download=`${kind==='fixture'?'fixtures':'lost-records'}-page-${result.page+1}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  const busy=search!==deferredSearch;
  return <section className="record-sheet" aria-label={kind==='fixture'?'Fixtures':'Lost Records'}>
    <div className="record-sheet__toolbar">
      <label className="record-sheet__search"><Search size={15} aria-hidden="true"/><input aria-label="Search records" placeholder="Search records" value={search} onChange={event=>{setSearch(event.target.value);change({});}} /></label>
      <label>Period<select aria-label="Record period" value={period} onChange={event=>{const value=event.target.value;setPeriod(value);if(value!=='custom')change(recordPeriod(value as 'month'|'12m'|'all'));}}><option value="12m">Last 12 months</option><option value="month">This month</option><option value="all">All records</option><option value="custom">Custom dates</option></select></label>
      {period==='custom'&&<><label>From<input type="date" aria-label="From date" value={query.from} onChange={event=>change({from:event.target.value})}/></label><label>To<input type="date" aria-label="To date" value={query.to} onChange={event=>change({to:event.target.value})}/></label></>}
      <label>Port<select aria-label="Record port" value={query.portId} onChange={event=>change({portId:event.target.value})}><option value="">All ports</option>{state.ports.map(port=><option key={port.id} value={port.id}>{port.name}</option>)}</select></label>
      {kind==='fixture'&&<label>Status<select aria-label="Record status" value={query.status} onChange={event=>change({status:event.target.value as RecordQuery['status']})}><option value="all">All statuses</option><option value="pending">Pending actual volume</option><option value="delivered">Delivered</option></select></label>}
      <button className="button secondary record-sheet__export" onClick={exportPage} disabled={!result.rows.length||busy}><Download size={14}/>Export page</button>
    </div>
    {result.invalidRange&&<p className="record-sheet__error" role="alert">From date must be on or before To date.</p>}
    <div className="record-sheet__grid" role="region" aria-label="Record table" tabIndex={0} aria-busy={busy}>
      <table>
        <thead><tr>{heading('Date','date','record-sheet__date')}{heading('Vessel','vessel','record-sheet__vessel')}{heading('Buyer','buyer')}<th scope="col">Trader</th>{heading('Port','port')}<th scope="col">ETA</th><th scope="col">IMO</th>
          {kind==='fixture'?<><th scope="col">Grade</th><th scope="col" className="record-sheet__number">Quantity <small>MT</small></th>{heading('Supplier','supplier')}<th scope="col" className="record-sheet__number">Buy price <small>USD / MT</small></th><th scope="col">Status</th></>:<>{['HSFO','VLSFO','LSMGO'].map(grade=><th scope="col" className="record-sheet__number" key={grade}>{grade} <small>MT</small></th>)}<th scope="col">Lost reason</th><th scope="col">Group note</th></>}<th scope="col">Private note</th>{kind==='fixture'&&<th scope="col" aria-label="Actions"/>}
        </tr></thead>
        {kind==='fixture'?result.rows.map(row=>{
          const {outcome,productLines}=row;
          const privateNote=getOutcomePrivateNote(state,outcome.id,actor.id);
          const rowSpan=productLines.length;
          return <tbody key={outcome.id} data-record-id={outcome.id} className="record-sheet__fixture">
            {productLines.map((product,index)=><tr key={`${product.grade}-${index}`} data-grade={product.grade}>
              {index===0&&<>
                <td rowSpan={rowSpan} className="record-sheet__date">{date(outcome.bookedAt)}</td>
                <td rowSpan={rowSpan} className="record-sheet__vessel"><button className="text-button" title={uppercaseText(outcome.vessel)} onClick={()=>open({type:'enquiry-detail',id:outcome.enquiryId})}>{outcome.vessel||'—'}</button></td>
                <td rowSpan={rowSpan} title={uppercaseText(row.buyer)}>{row.buyer}</td><td rowSpan={rowSpan}>{row.trader}</td><td rowSpan={rowSpan}>{row.port}</td><td rowSpan={rowSpan}>{row.eta||'—'}</td><td rowSpan={rowSpan}>{row.imo||'—'}</td>
              </>}
              <td>{product.grade||'—'}</td><td className="record-sheet__number">{product.quantityText||'—'}</td><td title={uppercaseText(product.supplierName)}>{product.supplierName}</td><td className="record-sheet__number">{product.buyPrice===undefined?'—':money(product.buyPrice)}</td>
              {index===0&&<>
                <td rowSpan={rowSpan}>{recordStatus(outcome)}</td>
                <td rowSpan={rowSpan}>{privateNote?<details><summary>Private note</summary><p>{privateNote}</p></details>:'—'}</td>
                <td rowSpan={rowSpan}>{isPendingOutcome(outcome)&&outcome.owner===actor.id&&!outcome.actualVolume&&<button className="text-button" onClick={()=>open({type:'actual-volume',id:outcome.id})}>Actual volume</button>}</td>
              </>}
            </tr>)}
          </tbody>;
        }):<tbody>{result.rows.map(row=>{
          const {outcome}=row;
          const privateNote=getOutcomePrivateNote(state,outcome.id,actor.id);
          return <tr key={outcome.id} data-record-id={outcome.id}>
            <td className="record-sheet__date">{date(outcome.bookedAt)}</td>
            <td className="record-sheet__vessel"><button className="text-button" title={uppercaseText(outcome.vessel)} onClick={()=>open({type:'enquiry-detail',id:outcome.enquiryId})}>{outcome.vessel||'—'}</button></td>
            <td title={uppercaseText(row.buyer)}>{row.buyer}</td><td>{row.trader}</td><td>{row.port}</td><td>{row.eta||'—'}</td><td>{row.imo||'—'}</td>
            {['HSFO','VLSFO','LSMGO'].map(grade=><td className="record-sheet__number" key={grade}>{row.quantities[grade]||'—'}</td>)}
            <td title={uppercaseText(outcome.reason)}>{outcome.reason||'—'}</td><td>{outcome.groupNote?<details><summary>Group note</summary><p>{outcome.groupNote}</p></details>:'—'}</td>
            <td>{privateNote?<details><summary>Private note</summary><p>{privateNote}</p></details>:'—'}</td>
          </tr>;
        })}</tbody>}
      </table>
      {!result.rows.length&&<p className="record-sheet__empty">No records match these filters.</p>}
    </div>
    <footer className="record-sheet__pagination">
      <span role="status">{result.total?`${result.page*result.pageSize+1}–${Math.min((result.page+1)*result.pageSize,result.total)} of ${result.total.toLocaleString('en-US')}`:'0 records'}</span>
      <label>{kind==='fixture'?'Fixtures':'Rows'}<select aria-label={kind==='fixture'?'Fixtures per page':'Rows per page'} value={query.pageSize} onChange={event=>change({pageSize:Number(event.target.value)})}>{[25,50,100].map(size=><option key={size} value={size}>{size}</option>)}</select></label>
      <div><button className="button secondary" aria-label="Previous page" disabled={result.page===0||busy} onClick={()=>setQuery(current=>({...current,page:result.page-1}))}><ChevronLeft size={15}/></button><span>Page {result.page+1} of {result.pages}</span><button className="button secondary" aria-label="Next page" disabled={result.page+1>=result.pages||busy} onClick={()=>setQuery(current=>({...current,page:result.page+1}))}><ChevronRight size={15}/></button></div>
    </footer>
  </section>;
}
