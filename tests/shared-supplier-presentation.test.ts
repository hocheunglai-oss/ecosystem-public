import test from 'node:test';
import assert from 'node:assert/strict';
import { supplierGrades, supplierName, supplierSourceUrl, supplierDate, supplierContacts, supplierBackground, supplierInfospectrumSummary } from '../src/lib/supplierPresentation';
import { globalSearchRecords, queryGlobalSearch } from '../src/lib/globalSearch';
import { createSeedState } from '../src/lib/seed';
import { actors } from '../src/lib/model';
import type { SupplierSummary, SupplierSource } from '../shared/suppliers';
const supplier: SupplierSummary = {
 id:'90000000-0000-4000-8000-000000000001',legacyIds:['spc-nunchi'],sourceKey:'NUNCHI',legalName:'NUNCHI MARINE PTE. LTD.',shortName:'NUNCHI',aliases:['Nunchi Marine'],countryCode:'SG',countryName:'Singapore',portName:'Singapore',nameStatus:'verified',legalNameSourceId:'mpa',info:{paymentTerms:'30',qualityClaimBar:'30',supplierTrader:'SAMPLE TRADER',availableGrade:'HSFO, VLSFO, LSMGO',foBdn:'ISO',goBdn:'ISO'},revision:1,updatedAt:'2026-10-14T00:00:00Z',contactCount:1,bargeCount:2,
};
test('shared supplier search uses both legal name and preserved SPC aliases, routes to canonical UUID',()=>{
 const records=globalSearchRecords(createSeedState(),actors[0],[],[supplier]);
 for(const query of ['NUNCHI','nunchi marine pte','Singapore VLSFO']) {
  const item=queryGlobalSearch(records,query).find(item=>item.category==='Supplier');
  assert.equal(item?.title,'NUNCHI MARINE PTE LTD'); assert.deepEqual(item?.context,{supplierId:supplier.id,fromSearch:true});
 }
 assert.equal(globalSearchRecords(createSeedState(),actors[0],[]).some(item=>item.category==='Supplier'),false,'No shared data must not expose fictional supplier fallback.');
});
test('supplier presentation normalizes company punctuation without changing source identities or grade meaning',()=>{
 assert.equal(supplierName(supplier),'NUNCHI MARINE PTE LTD');assert.equal(supplier.legalName,'NUNCHI MARINE PTE. LTD.');assert.equal(supplierName({...supplier,legalName:'EXAMPLE PTE.LTD.'}),'EXAMPLE PTE LTD');assert.equal(supplierName({...supplier,legalName:''}),'NUNCHI');
 assert.deepEqual(supplierGrades('HSFO, VLSFO / hsfo · LSMGO'),['HSFO','VLSFO','LSMGO']);
 assert.equal(supplierSourceUrl('https://mpa.gov.sg/source.pdf'),'https://mpa.gov.sg/source.pdf');
 for(const value of ['javascript:alert(1)','data:text/html,unsafe','https://user:pass@example.com','not a link'])assert.equal(supplierSourceUrl(value),undefined);
 assert.match(supplierDate('2026-09-04'),/04 Sept? 2026/);assert.equal(supplierDate(''),'—');
});


test('supplier profiles show only operational contacts and concise report background while retaining source data',()=>{
 const sources = ['spc','user','mpa','infospectrum'].map(type=>({id:type,type,title:type,url:'',documentDate:'',retrievedAt:''})) as import('../shared/suppliers').SupplierSource[];
 const contacts = sources.map(source=>({id:source.id,role:'sales' as const,name:source.id,phone:'+6591111111',email:'preserve@example.test',sourceId:source.id}));
 const facts = [
  {label:'Business focus · Report 11 Dec 2025',value:'Marine fuel trading.',sourceId:'infospectrum'},
  {label:'Registered address',value:'ADDRESS TO HIDE',sourceId:'infospectrum'},
  {label:'Contact phone',value:'PHONE TO HIDE',sourceId:'infospectrum'},
  {label:'Fuel categories',value:'FUEL CATEGORIES TO HIDE',sourceId:'infospectrum'},
  {label:'Company listing',value:'MPA LISTING TO HIDE',sourceId:'mpa'},
  {label:'SPC contact phone',value:'IMPORTED PHONE TO HIDE',sourceId:'spc'},
 ];
 const record = {sources,contacts,facts}, before = structuredClone(record);
 assert.deepEqual(supplierContacts(record).map(contact=>contact.id),['spc','user']);
 assert.deepEqual(supplierBackground(record),[facts[0]]);
 assert.deepEqual(record,before,'Presentation must not delete hidden provenance/contact data');
});

test('Infospectrum summary requires the exact sourced summary fact and never substitutes background or metadata',()=>{
 const source: SupplierSource={id:'report',type:'infospectrum',title:'Company report',url:'https://example.test/report.pdf',documentDate:'2026-09-01',retrievedAt:'2026-10-15T00:00:00Z'};
 const website: SupplierSource={...source,id:'website',type:'website'};
 const facts=[
  {label:'Business focus',value:'General background.',sourceId:source.id},
  {label:'Report summary metadata',value:'Report file indexed.',sourceId:source.id},
  {label:'INFOSPECTRUM SUMMARY',value:'Unverified copied text.',sourceId:website.id},
  {label:'INFOSPECTRUM SUMMARY',value:'Missing source.',sourceId:'missing'},
  {label:'INFOSPECTRUM SUMMARY',value:'   ',sourceId:source.id},
 ];
 const record={facts,sources:[source,website],background:'User edited company background.'};
 assert.equal(supplierInfospectrumSummary(record),undefined);
 const approved={label:'  infospectrum summary  ',value:'  Report-derived concise assessment.  ',sourceId:source.id};
 const complete={...record,facts:[...facts,approved]},before=structuredClone(complete);
 assert.deepEqual(supplierInfospectrumSummary(complete),{text:'Report-derived concise assessment.',source});
 assert.equal(supplierBackground(complete).includes(approved),false,'The summary must not repeat as company background');
 assert.deepEqual(complete,before,'Rendering must not alter stored facts or source attribution');
});

test('Infospectrum summary chooses the newest report date and uses retrieval date only to break ties',()=>{
 const source=(id:string,date:string,retrievedAt:string):SupplierSource=>({id,type:'infospectrum',title:id,url:'',documentDate:date,retrievedAt});
 const sources=[source('old','2025-12-11','2026-10-16T00:00:00Z'),source('new-first','2026-09-01','2026-09-02T00:00:00Z'),source('new-later','2026-09-01','2026-09-03T00:00:00Z')];
 const facts=sources.map(item=>({label:'INFOSPECTRUM SUMMARY',value:`Assessment ${item.id}`,sourceId:item.id}));
 assert.deepEqual(supplierInfospectrumSummary({facts,sources}),{text:'Assessment new-later',source:sources[2]});
 assert.deepEqual(supplierInfospectrumSummary({facts:[...facts].reverse(),sources:[...sources].reverse()}),{text:'Assessment new-later',source:sources[2]});
});
