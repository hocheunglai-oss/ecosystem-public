import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSupplierImport, normalizeSpcPhone, supplierId, runCli } from '../scripts/suppliers/build-import.mjs';

import { validateManifest, publishImport } from '../scripts/suppliers/publish-import.mjs';

const timestamp='2026-10-14T12:00:00.000Z';
function inputs(count=39): any {
  const records=Array.from({length:count},(_,index)=>{
    const key=`SUPPLIER${index+1}`;
    return {key,existingEcoId:`spc-${key.toLowerCase()}`,shortName:`SUPPLIER ${index+1}`,aliases:[`SUPPLIER ${index+1}`],
      info:{paymentTerms:'30',qualityClaimBar:'30',supplierTrader:'TRADER',availableGrade:'HSFO, VLSFO, LSMGO',foBdn:'ANOTHER ENTITY',goBdn:'ANOTHER ENTITY',rowNumber:index+2},
      contacts:Array.from({length:index<33?2:1},(_,child)=>({id:`${key}-CONTACT-${child+1}`,role:child?'ops':'sales',name:`PERSON ${child+1}`,mobile:'9181 5902',source:'sheet'})),
      barges:Array.from({length:index<2?3:2},(_,child)=>({id:`${key}-BARGE-${child+1}`,bargeName:`BARGE ${child+1}`,imo:'1234567',grade:'VLSFO',capacity:'1,000',source:'sheet'})),
    };
  });
  const mpa={source:{title:'MPA LICENSED SUPPLIERS',url:'https://www.mpa.gov.sg/example.pdf',as_of:'2026-09-04',retrieved_at:timestamp},suppliers:records.slice(0,24).map((r:any,index:number)=>({source_row:index+1,source_page:index<15?1:2,official_name:`Supplier ${index+1} Pte. Ltd.`,address:'SINGAPORE',fuel_supplied_raw:'MDO / MGO / MFO',contact_names:['PERSON ONE','PERSON TWO'],telephone_e164:['+6590000000'],emails:['first@example.com','second@example.com']}))};
  const decisions=records.map((r:any,index:number)=>index<24?{sourceKey:r.key,legalName:mpa.suppliers[index].official_name,nameStatus:'verified',source:{type:'mpa'},mpaRow:index+1}:{sourceKey:r.key,legalName:r.shortName,nameStatus:'needs-review'});
  const spc={generatedAt:timestamp,sourceUrl:'https://spc.fcuno.com/suppliers',records,counts:{suppliers:records.length,contactRows:records.reduce((n:number,r:any)=>n+r.contacts.length,0),bargeRows:records.reduce((n:number,r:any)=>n+r.barges.length,0)}};
  return {spc,mpa,decisions,builtAt:timestamp};
}
test('all 39 identities and all 72 contacts/80 barges survive the scoped offline import',()=>{
  const fixture=inputs(),manifest=buildSupplierImport(fixture);
  assert.equal(manifest.records.length,39);assert.equal(new Set(manifest.records.map((r:any)=>r.id)).size,39);
  assert.equal(manifest.counts.spcContacts,72);assert.equal(manifest.counts.barges,80);
  for(const original of fixture.spc.records){const actual=manifest.records.find((r:any)=>r.sourceKey===original.key)!;
    assert.equal(actual.shortName,original.shortName);assert.deepEqual(actual.legacyIds,[original.existingEcoId]);
    assert.deepEqual(actual.contacts.filter((c:any)=>c.sourceId==='spc').map((c:any)=>c.id),original.contacts.map((c:any)=>c.id));
    assert.deepEqual(actual.barges.map((b:any)=>b.id),original.barges.map((b:any)=>b.id));
  }
});
test('source UUID is standard namespace UUIDv5 and stable regardless of name changes or input order',()=>{
  assert.equal(supplierId('BPMARINE'),'1f64b3a0-3200-5938-bf01-7ffae232fa89');
  const first=inputs(),second=structuredClone(first);second.spc.records.reverse();second.decisions.reverse();
  assert.equal(buildSupplierImport(first).sourceHash,buildSupplierImport(second).sourceHash);
  second.spc.records.find((r:any)=>r.key==='SUPPLIER1').shortName='NEW SHORT NAME';
  assert.equal(buildSupplierImport(first).records[0].id,buildSupplierImport(second).records[0].id);
});
test('MPA names are exact, evidence is dated, and MPA categories never replace SPC grades',()=>{
  const fixture=inputs(),record=buildSupplierImport(fixture).records.find((r:any)=>r.sourceKey==='SUPPLIER1')!;
  assert.equal(record.legalName,'Supplier 1 Pte. Ltd.');assert.equal(record.shortName,'SUPPLIER 1');assert.equal(record.legalNameSourceId,'mpa');
  assert.equal(record.info.availableGrade,'HSFO, VLSFO, LSMGO');assert.equal('rowNumber' in record.info,false);
  assert.equal(record.sources.find((s:any)=>s.id==='mpa')?.documentDate,'2026-09-04');
  assert.equal(record.facts.some((f:any)=>f.sourceId==='mpa'),false);
  fixture.decisions[0].legalName='Supplier One Pte. Ltd.';assert.throws(()=>buildSupplierImport(fixture),/exact supplied row/);
});
test('MPA is used for legal name evidence only, with no imported address or contacts',()=>{
  const record=buildSupplierImport(inputs()).records.find((r:any)=>r.sourceKey==='SUPPLIER1')!;
  assert.equal(record.contacts.some((c:any)=>c.sourceId==='mpa'),false);
  assert.equal(record.facts.some((f:any)=>f.sourceId==='mpa'),false);
  assert.equal(record.contacts.filter((c:any)=>c.sourceId==='spc').length,2);
});
test('unknown and operationally labelled phones retain the original source text',()=>{
  assert.equal(normalizeSpcPhone('+65-91815902').phone,'+6591815902');
  assert.equal(normalizeSpcPhone('9181 5902').phone,'+6591815902');
  assert.equal(normalizeSpcPhone('6012 345 6789').phone,'+60123456789');
  assert.equal(normalizeSpcPhone('0065 9181 5902').phone,'+6591815902');
  assert.equal(normalizeSpcPhone('FO 9181 5902').label,'FO');
  assert.equal(normalizeSpcPhone('+6591815902 ext 3').phone,'');
  assert.equal(normalizeSpcPhone('91815902 / 91234567').phone,'');
  const fixture=inputs();fixture.spc.records[0].contacts[0].mobile='FO 9181 5902';fixture.spc.records[0].contacts[1].mobile='+6591815902 ext 3';
  const record=buildSupplierImport(fixture).records.find((r:any)=>r.sourceKey==='SUPPLIER1')!;
  const contacts=record.contacts.filter((c:any)=>c.sourceId==='spc');
  assert.equal(contacts[0].phone,'+6591815902');assert.equal(contacts[0].name,'PERSON 1 · FO');assert.equal(contacts[1].phone,'');
  assert.ok(record.facts.some((f:any)=>f.value==='FO 9181 5902'));assert.ok(record.facts.some((f:any)=>f.value==='+6591815902 ext 3'));
});
test('fixture/financial and raw source properties never enter the import record',()=>{
  const fixture=inputs(),before=buildSupplierImport(fixture).sourceHash;
  fixture.spc.records[0].fixtures=[{price:'PRIVATE-PRICE',barging:'PRIVATE-BARGING'}];
  fixture.spc.records[0].balance='PRIVATE-BALANCE';fixture.spc.records[0].contacts[0].credit='PRIVATE-CREDIT';fixture.spc.records[0].info.privateNote='PRIVATE-NOTE';
  fixture.mpa.suppliers[0].reportBody='PRIVATE-FULL-REPORT';
  const manifest=buildSupplierImport(fixture),serialized=JSON.stringify(manifest);
  assert.equal(manifest.sourceHash,before);assert.doesNotMatch(serialized,/PRIVATE-|fixtures|rowNumber|reportBody/);
});
test('unresolved names remain explicitly unverified SPC labels and BDN never determines identity',()=>{
  const fixture=inputs(),record=buildSupplierImport(fixture).records.find((r:any)=>r.sourceKey==='SUPPLIER39')!;
  assert.equal(record.legalName,'SUPPLIER 39');assert.equal(record.nameStatus,'needs-review');assert.equal(record.legalNameSourceId,null);
  fixture.decisions[38].legalName='ANOTHER ENTITY';assert.throws(()=>buildSupplierImport(fixture),/exact SPC short name/);
});
test('separate SPC records cannot silently be merged through reused MPA rows or legacy aliases',()=>{
  const fixture=inputs();fixture.decisions[1]={...fixture.decisions[0],sourceKey:'SUPPLIER2'};
  assert.throws(()=>buildSupplierImport(fixture),/silently merge/);
  const other=inputs();other.spc.records[0].existingEcoId='spc-historical-alias';assert.throws(()=>buildSupplierImport(other),/unexpected legacy ID/);
});
test('missing decisions, duplicate identities, duplicate children and wrong counts fail closed',()=>{
  const missing=inputs();missing.decisions.pop();assert.throws(()=>buildSupplierImport(missing),/exactly the SPC source keys/);
  const duplicate=inputs();duplicate.spc.records[1].key=duplicate.spc.records[0].key;assert.throws(()=>buildSupplierImport(duplicate),/duplicate SPC/);
  const child=inputs();child.spc.records[0].contacts[1].id=child.spc.records[0].contacts[0].id;assert.throws(()=>buildSupplierImport(child),/duplicate SPC contact/);
  const count=inputs();count.spc.counts.bargeRows=81;assert.throws(()=>buildSupplierImport(count),/snapshot counts/);
});
test('secondary verified names and report facts retain explicit distinct evidence',()=>{
  const fixture=inputs();const evidence={id:'infospectrum',type:'infospectrum',title:'SUPPLIER REPORT',url:'https://example.com/report/39',documentDate:'2026-09-01',retrievedAt:timestamp,page:'2',reference:'REPORT 39'};
  fixture.decisions[38]={sourceKey:'SUPPLIER39',legalName:'Official Supplier Thirty Nine Pte Ltd',nameStatus:'verified',source:evidence};
  fixture.infospectrum={records:[{sourceKey:'SUPPLIER39',source:evidence,facts:[{label:'REGISTERED BUSINESS',value:'BUNKER TRADING'}]}]};
  const record=buildSupplierImport(fixture).records.find((r:any)=>r.sourceKey==='SUPPLIER39')!;
  assert.equal(record.legalNameSourceId,'infospectrum');assert.equal(record.sources.length,2);
  assert.deepEqual(record.facts.find((f:any)=>f.label==='REGISTERED BUSINESS'),{label:'REGISTERED BUSINESS',value:'BUNKER TRADING',sourceId:'infospectrum'});
  fixture.infospectrum.records[0].source={...evidence,page:'3'};assert.throws(()=>buildSupplierImport(fixture),/conflicting source ID/);
});
test('dated MPA notice enrichment adds evidence without removing a supplier or changing its identity decision',()=>{
  const fixture=inputs(),baseline=buildSupplierImport(fixture);
  fixture.enrichment={records:[{sourceKey:'SUPPLIER39',source:{id:'mpa-historical-notice',type:'mpa',title:'MPA HISTORICAL NOTICE',url:'https://www.mpa.gov.sg/notice',documentDate:'2025-06-03',retrievedAt:timestamp,reference:'PARAGRAPHS 1–2'},facts:[{label:'MPA LICENCE NOTICE · 3 JUN 2025',value:'DATED NOTICE OF LICENCE NON-RENEWAL FROM 18 JUNE 2025.'}]}]};
  const manifest=buildSupplierImport(fixture),record=manifest.records.find((r:any)=>r.sourceKey==='SUPPLIER39')!;
  assert.equal(manifest.records.length,39);assert.equal(record.id,baseline.records.find((r:any)=>r.sourceKey==='SUPPLIER39')!.id);
  assert.equal(record.nameStatus,'needs-review');assert.equal(record.legalNameSourceId,null);assert.equal(record.legalName,'SUPPLIER 39');
  assert.ok(record.facts.some((f:any)=>f.sourceId==='mpa-historical-notice'));
  assert.notEqual(manifest.sourceHash,baseline.sourceHash);
  fixture.enrichment.records[0].sourceKey='UNKNOWN';assert.throws(()=>buildSupplierImport(fixture),/unknown enrichment source key/);
});
test('offline CLI writes a mode-600 private manifest with input hashes and no input overwrite',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'eco-supplier-import-test-'));
  try{const fixture=inputs(),paths:any={};for(const key of ['spc','mpa','decisions']){paths[key]=join(directory,`${key}.private.json`);await writeFile(paths[key],JSON.stringify(fixture[key]));}
    const args=['--spc',paths.spc,'--mpa',paths.mpa,'--decisions',paths.decisions];
    const output=join(directory,'manifest.private.json'),summary=await runCli([...args,'--out',output]);
    assert.equal(summary.counts.suppliers,39);assert.equal((await stat(output)).mode&0o777,0o600);
    const result=JSON.parse(await readFile(output,'utf8'));assert.match(result.inputHashes.spc,/^[a-f0-9]{64}$/);
    await assert.rejects(runCli([...args,'--out',paths.spc]),/must not replace an input/);
    await assert.rejects(runCli([...args,'--out',join(directory,'manifest.json')]),/private.json/);
    await assert.rejects(runCli([...args,'--out',new URL('../src/manifest.private.json',import.meta.url).pathname]),/ignored output/);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('operator publication validates integrity and rejects wholly empty contacts',()=>{
  const manifest=buildSupplierImport(inputs());assert.equal(validateManifest(manifest),manifest);
  const changed=structuredClone(manifest);changed.records[0].shortName='TAMPERED';
  assert.throws(()=>validateManifest(changed),/hash does not match/);
  const empty=structuredClone(manifest);Object.assign(empty.records[0].contacts[0],{name:' ',phone:'',email:''});
  empty.sourceHash=createHash('sha256').update(JSON.stringify(empty.records)).digest('hex');
  assert.throws(()=>validateManifest(empty),/Empty contact/);
});
test('operator publication defaults to offline validation without creating a request',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'eco-supplier-publish-test-'));
  try{const manifest=buildSupplierImport(inputs()),path=join(directory,'manifest.private.json'),request=join(directory,'request.private.json');
    await writeFile(path,JSON.stringify(manifest));
    const result=await publishImport(['--manifest',path,'--operator-email','operator@example.com','--request',request]);
    assert.deepEqual(result,{apply:false,suppliers:39,sourceHash:manifest.sourceHash});
    await assert.rejects(stat(request),{code:'ENOENT'});
  }finally{await rm(directory,{recursive:true,force:true});}
});
