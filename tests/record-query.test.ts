import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createSeedState } from '../src/lib/seed';
import { actors } from '../src/lib/model';
import { indexRecords, queryRecords, recordPeriod, recordsCsv, type RecordQuery } from '../src/lib/recordQuery';
const query:RecordQuery={kind:'fixture',search:'',from:'',to:'',portId:'',status:'all',sort:'date',direction:'desc',page:0,pageSize:50};

test('record pages filter before paging, have stable ties and enforce actor scope',()=>{
 const state=createSeedState();const base=state.outcomes.find(o=>o.kind==='fixture')!;
 state.outcomes=Array.from({length:151},(_,i)=>({...base,id:`record-${i}`,bookedAt:'2026-10-01T12:00:00Z',vessel:`VESSEL ${i}`,owner:i===150?'luca':'otto'}));
 const rows=indexRecords(state,actors[0]);assert.equal(rows.length,150);
 const first=queryRecords(rows,query);const second=queryRecords(rows,{...query,page:1});
 assert.equal(first.rows.length,50);assert.equal(first.total,150);
 assert.equal(new Set([...first.rows,...second.rows].map(r=>r.outcome.id)).size,100);
 assert.equal(queryRecords(rows,{...query,search:'VESSEL 12'}).total,12);
 assert.equal(queryRecords(rows,{...query,search:'VESSEL 12',page:50}).page,0);
 assert.equal(queryRecords(rows,{...query,from:'2026-10-02',to:'2026-10-01'}).invalidRange,true);
 assert.equal(queryRecords(rows,{...query,portId:'nonexistent'}).total,0);
 assert.equal(queryRecords(rows,{...query,pageSize:100000}).rows.length,50);
 assert.equal(indexRecords(state,actors[2]).length,151);
});

test('dates use Hong Kong reporting boundaries and chronological sort with offsets',()=>{
 const state=createSeedState();const base=state.outcomes.find(o=>o.kind==='fixture')!;
 state.outcomes=[{...base,id:'earlier',owner:'otto',bookedAt:'2026-10-02T00:00:00+08:00'},{...base,id:'later',owner:'otto',bookedAt:'2026-10-01T17:00:00Z'},{...base,id:'invalid',owner:'otto',bookedAt:'invalid'}];
 const result=queryRecords(indexRecords(state,actors[0]),{...query,from:'2026-10-02',to:'2026-10-02'});
 assert.deepEqual(result.rows.map(r=>r.outcome.id),['later','earlier']);
 assert.deepEqual(recordPeriod('12m',new Date('2026-10-02T04:00:00Z')),{from:'2025-10-03',to:'2026-10-02'});
 assert.deepEqual(recordPeriod('all'),{from:'',to:''});
});

test('ranges are preserved; pending and delivered filters are distinct; CSV omits private data and neutralizes formulas',()=>{
 const state=createSeedState();const base=state.outcomes.find(o=>o.kind==='fixture')!;
 state.outcomes=[{...base,id:'pending',owner:'otto',vessel:'=HYPERLINK("bad")',commercialStatus:'pending',stemProducts:[{grade:'VLSFO',quantityText:'350–400',buyPrice:500}]},{...base,id:'delivered',owner:'otto',commercialStatus:'pending',actualVolume:{quantity:380,recordedAt:'2026-10-01',recordedBy:'otto'}}];
 state.privateNotes={pending:{owner:'otto',text:'PRIVATE MUST NOT EXPORT',updatedAt:'2026-10-01'}};
 const rows=indexRecords(state,actors[0]);
 assert.equal(queryRecords(rows,{...query,status:'pending'}).rows[0].outcome.id,'pending');
 assert.equal(queryRecords(rows,{...query,status:'delivered'}).rows[0].outcome.id,'delivered');
 const csv=recordsCsv(rows,'fixture');assert.ok(csv.includes('350–400'));assert.ok(csv.includes("'="));assert.ok(!csv.includes('PRIVATE MUST NOT EXPORT'));
});

test('fixture search and supplier sorting include every grade supplier without stale header names',()=>{
 const state=createSeedState();const base=state.outcomes.find(o=>o.kind==='fixture')!;
 state.outcomes=[
  {...base,id:'a',owner:'otto',supplierName:'OLD HEADER',stemProducts:[
   {grade:'HSFO',quantityText:'350–400',buyPrice:421,supplierName:'ALPHA'},
   {grade:'VLSFO',quantityText:'500',buyPrice:550,supplierName:'CEDAR'},
   {grade:'LSMGO',quantityText:'60',buyPrice:720,supplierName:'BIRCH'},
  ]},
  {...base,id:'z',owner:'otto',supplierName:'OLD HEADER',stemProducts:[
   {grade:'HSFO',quantityText:'400',buyPrice:420,supplierName:'ALPHA'},
   {grade:'VLSFO',quantityText:'500',buyPrice:550,supplierName:'BIRCH'},
  ]},
 ];
 const rows=indexRecords(state,actors[0]);
 assert.deepEqual(queryRecords(rows,{...query,search:'CEDAR BIRCH'}).rows.map(row=>row.outcome.id),['a']);
 assert.equal(queryRecords(rows,{...query,search:'BIRCH'}).total,2);
 assert.equal(queryRecords(rows,{...query,search:'OLD HEADER'}).total,0);
 assert.deepEqual(queryRecords(rows,{...query,sort:'supplier',direction:'asc'}).rows.map(row=>row.outcome.id),['z','a']);
 assert.deepEqual(queryRecords(rows,{...query,sort:'supplier',direction:'desc'}).rows.map(row=>row.outcome.id),['a','z']);
 assert.deepEqual(rows[0].productLines.map(({grade,quantityText,supplierName,buyPrice})=>({grade,quantityText,supplierName,buyPrice})),[
  {grade:'HSFO',quantityText:'350–400',supplierName:'ALPHA',buyPrice:421},
  {grade:'VLSFO',quantityText:'500',supplierName:'CEDAR',buyPrice:550},
  {grade:'LSMGO',quantityText:'60',supplierName:'BIRCH',buyPrice:720},
 ]);
});

test('fixture CSV keeps each grade with its quantity, supplier and buy price; pages count stems',()=>{
 const state=createSeedState();const base=state.outcomes.find(o=>o.kind==='fixture')!;
 state.outcomes=Array.from({length:26},(_,index)=>({...base,id:`fixture-${index}`,owner:'otto',vessel:`VESSEL ${index}`,stemProducts:[
  {grade:'HSFO',quantityText:'350–400',buyPrice:421,supplierName:'ALPHA'},
  {grade:'VLSFO',quantityText:'500',buyPrice:550,supplierName:'BIRCH'},
  {grade:'LSMGO',quantityText:'60',buyPrice:720,supplierName:'CEDAR'},
 ]}));
 const indexed=indexRecords(state,actors[0]);
 const first=queryRecords(indexed,{...query,pageSize:25});
 const last=queryRecords(indexed,{...query,pageSize:25,page:1});
 assert.equal(first.total,26);assert.equal(first.pages,2);assert.equal(first.rows.length,25);assert.equal(last.rows.length,1);
 const csv=recordsCsv(first.rows,'fixture');const lines=csv.split('\r\n');
 assert.equal(lines.length,76);
 assert.ok(lines[0].includes('"GRADE","QUANTITY (MT)","SUPPLIER","BUY PRICE (USD/MT)"'));
 assert.ok(lines[1].includes('"HSFO","350–400","ALPHA","421"'));
 assert.ok(lines[2].includes('"VLSFO","500","BIRCH","550"'));
 assert.ok(lines[3].includes('"LSMGO","60","CEDAR","720"'));
 for(const line of lines.slice(1,4))assert.ok(line.includes(`"${first.rows[0].outcome.vessel}"`));
 assert.equal(recordsCsv(last.rows,'fixture').split('\r\n').length,4);
});

test('legacy fixture suppliers apply to every grade and selling prices never become buy prices',()=>{
 const state=createSeedState();const base=state.outcomes.find(o=>o.kind==='fixture')!;
 state.outcomes=[
  {...base,id:'legacy-stem',owner:'otto',supplierName:'LEGACY SUPPLIER',stemProducts:[{grade:'VLSFO',quantityText:'500–600',buyPrice:510},{grade:'LSMGO',quantityText:'60',buyPrice:710}]},
  {...base,id:'legacy-booked',owner:'otto',supplierName:'LEGACY BOOKED',stemProducts:undefined,products:[{grade:'VLSFO',quantity:500,price:612,margin:21},{grade:'LSMGO',quantity:60,price:799,margin:31}]},
 ];
 const rows=indexRecords(state,actors[0]);
 assert.deepEqual(rows[0].productLines.map(product=>product.supplierName),['LEGACY SUPPLIER','LEGACY SUPPLIER']);
 assert.equal(queryRecords(rows,{...query,search:'LEGACY SUPPLIER'}).total,1);
 const stemCsv=recordsCsv([rows[0]],'fixture');
 assert.ok(stemCsv.includes('"VLSFO","500–600","LEGACY SUPPLIER","510"'));
 assert.ok(stemCsv.includes('"LSMGO","60","LEGACY SUPPLIER","710"'));
 assert.ok(rows[1].productLines.every(product=>product.buyPrice===undefined));
 const bookedCsv=recordsCsv([rows[1]],'fixture');
 assert.ok(bookedCsv.includes('"VLSFO","500","LEGACY BOOKED",""'));
 assert.ok(bookedCsv.includes('"LSMGO","60","LEGACY BOOKED",""'));
 assert.ok(!bookedCsv.includes('"612"'));assert.ok(!bookedCsv.includes('"799"'));
});

test('lost CSV retains one record with grade columns and group notes',()=>{
 const state=createSeedState();const base=state.outcomes.find(o=>o.kind==='lost')!;
 state.outcomes=[{...base,owner:'otto',stemProducts:undefined,products:undefined,requestedProducts:[{grade:'HSFO',quantityText:'350–400'},{grade:'LSMGO',quantityText:'60'}],reason:'No availability',groupNote:'Supplier confirmed no availability.'}];
 const csv=recordsCsv(indexRecords(state,actors[0]),'lost');const lines=csv.split('\r\n');
 assert.equal(lines.length,2);
 assert.ok(lines[0].endsWith('"HSFO (MT)","VLSFO (MT)","LSMGO (MT)","LOST REASON","GROUP NOTE"'));
 assert.ok(lines[1].endsWith('"350–400","","60","NO AVAILABILITY","SUPPLIER CONFIRMED NO AVAILABILITY."'));
});

test('CSV matches uppercase presentation without changing email addresses, source URLs or stored data',()=>{
 const state=createSeedState();const base=state.outcomes.find(o=>o.kind==='lost')!;
 const groupNote='Contact Buyer.Name@example.com and see https://example.com/Port/AbC?ref=xYz';
 state.outcomes=[{...base,owner:'otto',vessel:'Meridian Dawn',reason:'No availability',groupNote}];
 const csv=recordsCsv(indexRecords(state,actors[0]),'lost');
 assert.ok(csv.includes('"MERIDIAN DAWN"'));
 assert.ok(csv.includes('"NO AVAILABILITY"'));
 assert.ok(csv.includes('CONTACT Buyer.Name@example.com AND SEE https://example.com/Port/AbC?ref=xYz'));
 assert.equal(state.outcomes[0].groupNote,groupNote);
 assert.equal(state.outcomes[0].vessel,'Meridian Dawn');
});

test('20,000 record search and pagination keep the result bounded',()=>{
 const state=createSeedState();const base=state.outcomes.find(o=>o.kind==='fixture')!;
 state.outcomes=Array.from({length:20000},(_,i)=>({...base,id:`record-${i}`,vessel:`VESSEL ${i}`,owner:'otto'}));
 const start=performance.now();const rows=indexRecords(state,actors[0]);const indexed=performance.now();
 const result=queryRecords(rows,{...query,search:'VESSEL 19',page:2});const end=performance.now();
 assert.equal(result.total,1578);assert.equal(result.rows.length,50);
 assert.ok(end-indexed<1000,`Query unexpectedly slow: ${end-indexed}ms`);
 console.log(`20k records: index ${(indexed-start).toFixed(1)}ms, query ${(end-indexed).toFixed(1)}ms, rendered page ${result.rows.length}`);
});
