#!/usr/bin/env node
/** Offline only. Inputs stay private and are never copied into application source.
 * Decisions: [{sourceKey,legalName,nameStatus,source?,mpaRow?,facts?:[{label,value}]}].
 * Optional reports: [{sourceKey,source:SupplierSource,facts:[{label,value}]}].
 * Run: node scripts/suppliers/build-import.mjs --spc snapshot.json --mpa mpa.json
 *   --decisions decisions.json [--infospectrum reports.json] [--enrichment facts.json]
 *   --out import.private.json
 */
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, rename, chmod, unlink } from 'node:fs/promises';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const INFO_KEYS = ['paymentTerms','qualityClaimBar','supplierTrader','availableGrade','foBdn','goBdn'];
const SOURCE_TYPES = ['mpa','spc','infospectrum','website','user'];
// This namespace and key derivation are immutable once the first import is published.
export const SUPPLIER_ID_NAMESPACE = 'c4ca530d-3b32-4eb1-97a6-f3c85a23e671';
const hash = value => createHash('sha256').update(value).digest('hex');
const reject = message => { throw new Error(`Supplier import: ${message}`); };
function string(value, label, max = 4000, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) reject(`invalid ${label}`);
  return value;
}
function list(value, label, max = 200) {
  if (!Array.isArray(value) || value.length > max) reject(`invalid ${label}`);
  return value;
}
function unique(items, label) {
  if (new Set(items).size !== items.length) reject(`duplicate ${label}`);
}
function date(value, label, empty = false) {
  string(value, label, 40, empty);
  if (value && !Number.isFinite(Date.parse(value))) reject(`invalid ${label}`);
  return value;
}
function source(value, forcedId) {
  if (!value || !SOURCE_TYPES.includes(value.type)) reject('invalid source type');
  const url = string(value.url ?? '', 'source URL', 2000, true);
  if (url && (!/^https?:\/\//.test(url) || !URL.canParse(url))) reject('invalid source URL');
  return {
    id:string(forcedId ?? value.id,'source ID',160), type:value.type,
    title:string(value.title,'source title',300), url,
    documentDate:date(value.documentDate ?? '', 'document date', true),
    retrievedAt:date(value.retrievedAt,'retrieval date'),
    ...(value.page !== undefined ? {page:string(String(value.page),'source page',80,true)} : {}),
    ...(value.reference !== undefined ? {reference:string(value.reference,'source reference',300,true)} : {}),
  };
}
export function supplierId(sourceKey) {
  if (!/^[A-Z0-9]{1,160}$/.test(sourceKey)) reject('source key must be the preserved SPC canonical key');
  const bytes = createHash('sha1').update(Buffer.from(SUPPLIER_ID_NAMESPACE.replaceAll('-',''),'hex')).update(`spc:${sourceKey}`).digest().subarray(0,16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const text=bytes.toString('hex');
  return `${text.slice(0,8)}-${text.slice(8,12)}-${text.slice(12,16)}-${text.slice(16,20)}-${text.slice(20)}`;
}

/** Uncertain numbers are retained as labelled source facts, never repaired by deleting letters. */
export function normalizeSpcPhone(value) {
  const raw=string(value ?? '', 'SPC phone',500,true);
  const operational=raw.trim().match(/^(FO|GO)\s+(.+)$/i);
  const label=operational?.[1].toUpperCase() ?? '';
  const candidate=(operational?.[2] ?? raw).trim();
  if (!candidate) return {phone:'',label,raw};
  if (!/^[+\d\s().-]+$/.test(candidate)) return {phone:'',label,raw};
  let compact=candidate.replace(/[\s().-]/g,'');
  if (/^00\d+$/.test(compact)) compact=`+${compact.slice(2)}`;
  if (/^[1-9]\d{7}$/.test(compact)) compact=`+65${compact}`;
  else if (/^(?:65\d{8}|60\d{8,10})$/.test(compact)) compact=`+${compact}`;
  const phone=/^\+[1-9]\d{7,14}$/.test(compact) ? compact : '';
  return {phone,label,raw};
}

function mpaEvidence(mpa,row) {
  return source({id:'mpa',type:'mpa',title:mpa.source.title,url:mpa.source.url,
    documentDate:mpa.source.as_of,retrievedAt:mpa.source.retrieved_at,page:String(row.source_page),reference:`MPA ROW ${row.source_row}`});
}

/** Returns only the explicit shared SupplierImportRecord fields; unknown input fields are discarded. */
export function buildSupplierImport({spc,mpa,decisions,infospectrum=[],enrichment=[],builtAt=new Date().toISOString(),inputHashes={}}) {
  const records=list(spc?.records,'SPC records');
  if (!records.length) reject('empty SPC snapshot');
  const chosen=list(Array.isArray(decisions)?decisions:decisions?.decisions,'name decisions');
  const reports=list(Array.isArray(infospectrum)?infospectrum:infospectrum?.records,'Infospectrum records');
  const additional=list(Array.isArray(enrichment)?enrichment:enrichment?.records,'enrichment records');
  const mpaRows=list(mpa?.suppliers,'MPA records');
  unique(records.map(r=>r.key),'SPC source key'); unique(chosen.map(r=>r.sourceKey),'decision source key');
  unique(mpaRows.map(r=>r.source_row),'MPA row');
  const keys=new Set(records.map(r=>r.key));
  if (chosen.length!==records.length || chosen.some(r=>!keys.has(r.sourceKey))) reject('decisions must cover exactly the SPC source keys');
  if (reports.some(r=>!keys.has(r.sourceKey))) reject('unknown Infospectrum source key');
  if (additional.some(r=>!keys.has(r.sourceKey))) reject('unknown enrichment source key');
  const decisionsByKey=new Map(chosen.map(r=>[r.sourceKey,r]));
  const usedMpa=new Set();
  const out=records.map(original=>{
    const key=string(original.key,'SPC source key',160),shortName=string(original.shortName,'SPC short name',160);
    const decision=decisionsByKey.get(key);
    if (!['verified','needs-review'].includes(decision.nameStatus)) reject(`invalid name status for ${key}`);
    const legalName=string(decision.legalName,'legal name',300);
    if (decision.nameStatus==='needs-review' && legalName!==shortName) reject(`unresolved legal name must retain the exact SPC short name for ${key}`);
    const sources=[source({id:'spc',type:'spc',title:'SPC SUPPLIER DATABASE',url:original.sourceUrl??spc.sourceUrl,
      documentDate:'',retrievedAt:spc.generatedAt,reference:key})];
    const facts=[],contacts=[],barges=[];
    function addSource(item) {
      const normalized=source(item),existing=sources.find(s=>s.id===normalized.id);
      if(existing && JSON.stringify(existing)!==JSON.stringify(normalized)) reject(`conflicting source ID ${normalized.id} for ${key}`);
      if(!existing)sources.push(normalized);
      return normalized.id;
    }
    function fact(label,value,sourceId) {
      if (value===undefined || value===null || value==='') return;
      const result={label:string(label,'fact label',160),value:string(String(value),'fact value',4000),sourceId};
      if(!facts.some(f=>f.label===result.label&&f.value===result.value&&f.sourceId===sourceId))facts.push(result);
    }
    const info=Object.fromEntries(INFO_KEYS.map(field=>[field,string(original.info?.[field]??'',field,2000,true)]));
    let legalNameSourceId=null;
    if(decision.nameStatus==='verified') {
      if(!decision.source)reject(`verified name requires evidence for ${key}`);
      if(decision.source.type==='mpa') {
        const exact=mpaRows.filter(row=>row.official_name===legalName);
        if(exact.length!==1 || (decision.mpaRow!==undefined && exact[0].source_row!==decision.mpaRow))reject(`MPA name must match one exact supplied row for ${key}`);
        const row=exact[0];
        if(usedMpa.has(row.source_row))reject('an MPA legal entity cannot silently merge separate SPC source records');
        usedMpa.add(row.source_row);
        legalNameSourceId=addSource(mpaEvidence(mpa,row));
        // MPA establishes the legal name only; operational information comes from SPC.

      } else {
        if(decision.source.type==='spc')reject(`SPC short-name evidence alone cannot verify a legal name for ${key}`);
        legalNameSourceId=addSource(decision.source);
      }
    }
    // Include optional evidence even if it does not establish the legal name.
    if(decision.nameStatus==='needs-review' && decision.source && decision.source.type!=='mpa')addSource(decision.source);
    const decisionSource=decision.nameStatus==='verified'?legalNameSourceId:decision.source?.id;
    if(decision.facts?.length && (!decisionSource || !sources.some(s=>s.id===decisionSource)))reject(`decision facts require evidence for ${key}`);
    for(const f of list(decision.facts??[],'decision facts'))fact(f.label,f.value,decisionSource);
    for(const report of reports.filter(r=>r.sourceKey===key)) {
      if(report.source?.type!=='infospectrum')reject('report source must be Infospectrum');
      const sourceId=addSource(report.source);
      for(const f of list(report.facts??[],'report facts')) {
        if (/address|contact|phone|telephone|e.?mail|fax/i.test(f.label)) continue;
        fact(f.label,f.value,sourceId);
      }
    }
    for(const item of additional.filter(r=>r.sourceKey===key)) {
      const sourceId=addSource(item.source);
      for(const f of list(item.facts??[],'enrichment facts'))fact(f.label,f.value,sourceId);
    }
    const spcContacts=list(original.contacts??[],'SPC contacts',100);
    unique(spcContacts.map(c=>c.id),'SPC contact ID');
    spcContacts.forEach(c=>{
      if(!['sales','ops'].includes(c.role))reject(`invalid SPC contact role for ${key}`);
      const id=string(c.id,'SPC contact ID',100),normalized=normalizeSpcPhone(c.mobile??'');
      const originalName=string(c.name??'','SPC contact name',300,true);
      const name=normalized.label ? `${originalName}${originalName?' · ':''}${normalized.label}`:originalName;
      contacts.push({id,role:c.role,name:string(name,'contact name',300,true),phone:normalized.phone,email:'',sourceId:'spc'});
      if(normalized.raw!==normalized.phone)fact(`SPC CONTACT PHONE · ${id}`,normalized.raw,'spc');
    });
    for(const b of list(original.barges??[],'SPC barges',200))barges.push({id:string(b.id,'barge ID',100),name:string(b.bargeName,'barge name',300),imo:string(b.imo??'','barge IMO',100,true),grade:string(b.grade??'','barge grade',300,true),capacity:string(b.capacity??'','barge capacity',300,true),sourceId:'spc'});
    unique(contacts.map(c=>c.id),'contact ID');unique(barges.map(b=>b.id),'barge ID');
    list(contacts,'combined contacts',100);list(facts,'combined facts',200);
    const aliases=[...new Set(list(original.aliases??[],'aliases').map(a=>string(a,'alias',160)))];
    const expectedLegacy=`spc-${key.toLowerCase()}`;
    if(original.existingEcoId!==undefined && original.existingEcoId!==expectedLegacy)reject(`unexpected legacy ID for ${key}`);
    return {id:supplierId(key),legacyIds:[expectedLegacy],sourceKey:key,legalName,shortName,aliases,
      countryCode:'SG',countryName:'Singapore',portName:'Singapore',nameStatus:decision.nameStatus,legalNameSourceId,
      info,contacts,barges,facts,sources};
  }).sort((a,b)=>a.sourceKey.localeCompare(b.sourceKey,'en'));
  unique(out.map(r=>r.id),'supplier UUID');
  const actual={suppliers:records.length,contactRows:records.reduce((n,r)=>n+(r.contacts??[]).length,0),bargeRows:records.reduce((n,r)=>n+(r.barges??[]).length,0)};
  if(spc.counts && Object.keys(actual).some(k=>actual[k]!==spc.counts[k]))reject('snapshot counts do not match records');
  const preservedContacts=out.reduce((n,r)=>n+r.contacts.filter(c=>c.sourceId==='spc').length,0);
  const preservedBarges=out.reduce((n,r)=>n+r.barges.length,0);
  if(preservedContacts!==actual.contactRows || preservedBarges!==actual.bargeRows)reject('source operational records were lost');
  return {schemaVersion:1,builtAt:date(builtAt,'build date'),sourceHash:hash(JSON.stringify(out)),inputHashes,
    counts:{suppliers:out.length,spcContacts:preservedContacts,mpaContacts:out.reduce((n,r)=>n+r.contacts.filter(c=>c.sourceId==='mpa').length,0),barges:preservedBarges,verifiedNames:out.filter(r=>r.nameStatus==='verified').length,needsReview:out.filter(r=>r.nameStatus==='needs-review').length},records:out};
}

export async function runCli(args) {
  const paths={};
  for(let i=0;i<args.length;i+=2){const key=args[i]?.replace(/^--/,'');if(!['spc','mpa','decisions','infospectrum','enrichment','out'].includes(key)||!args[i+1]||paths[key])reject('expected --spc --mpa --decisions [--infospectrum] [--enrichment] --out');paths[key]=resolve(args[i+1]);}
  if(!paths.spc||!paths.mpa||!paths.decisions||!paths.out)reject('missing required input or output path');
  if(!paths.out.endsWith('.private.json'))reject('output must end in .private.json');
  if(Object.entries(paths).some(([k,v])=>k!=='out'&&v===paths.out))reject('output must not replace an input');
  const repository=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
  const local=relative(repository,paths.out);
  if(local!==`output${sep}`&&!local.startsWith(`output${sep}`)&&local!== '..'&&!local.startsWith(`..${sep}`))reject('private output inside the repository must be under ignored output/');
  const inputs={},inputHashes={};
  for(const key of ['spc','mpa','decisions','infospectrum','enrichment'])if(paths[key]){const raw=await readFile(paths[key]);inputHashes[key]=hash(raw);inputs[key]=JSON.parse(raw.toString('utf8'));}
  const manifest=buildSupplierImport({...inputs,inputHashes});
  await mkdir(dirname(paths.out),{recursive:true,mode:0o700});
  const temporary=`${paths.out}.${process.pid}.tmp`;
  try{await writeFile(temporary,JSON.stringify(manifest,null,2)+'\n',{mode:0o600,flag:'wx'});await rename(temporary,paths.out);await chmod(paths.out,0o600);}finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
  return {output:paths.out,sourceHash:manifest.sourceHash,counts:manifest.counts};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  runCli(process.argv.slice(2)).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
