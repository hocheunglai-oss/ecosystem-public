import { applySchemaMigrations } from './fixtures/migrations.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const exec=promisify(execFile),lit=v=>`'${String(v).replaceAll("'","''")}'`,json=v=>`${lit(JSON.stringify(v))}::jsonb`;
const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333'];
const sessions=['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','cccccccc-cccc-4ccc-8ccc-cccccccccccc'];
const info={paymentTerms:'30 days',qualityClaimBar:'30 days',supplierTrader:'Otto',availableGrade:'VLSFO',foBdn:'FO',goBdn:'GO'};
const record=extra=>({id:randomUUID(),legacyIds:['legacy-'+randomUUID()],sourceKey:'spc:'+randomUUID(),legalName:'Fixture Maritime Pte Ltd',shortName:'FIXTURE',aliases:['Fixture'],countryCode:'SG',countryName:'Singapore',portName:'Singapore',nameStatus:'verified',legalNameSourceId:'mpa',info,contacts:[{id:'contact',role:'sales',name:'Fixture contact',phone:'+6590000000',email:'sales@example.test',sourceId:'spc'}],barges:[{id:'barge',name:'Fixture Barge',imo:'1234567',grade:'VLSFO',capacity:'5000',sourceId:'spc'}],facts:[{label:'Licence',value:'Listed',sourceId:'mpa'}],sources:[{id:'mpa',type:'mpa',title:'Synthetic authority source',url:'https://example.test/list.pdf',documentDate:'2026-09-04',retrievedAt:'2026-10-14T00:00:00Z',page:'1'},{id:'spc',type:'spc',title:'Synthetic operational source',url:'https://example.test/suppliers',documentDate:'',retrievedAt:'2026-10-14T00:00:00Z'}],...extra});
const batch=records=>({requestId:randomUUID(),operatorId:ids[0],sourceHash:'a'.repeat(64),records});
const page=extra=>({search:'',country:'',grade:'',trader:'',page:1,limit:50,...extra});
const update=r=>({requestId:randomUUID(),id:r.id,revision:r.revision??1,info:{...r.info,paymentTerms:'45 days'},contacts:r.contacts,barges:r.barges});
test('suppliers SQL against isolated native PostgreSQL',async t=>{
 const bin=process.env.ECO_NATIVE_PG_BIN;assert.ok(bin&&isAbsolute(bin),'Set ECO_NATIVE_PG_BIN; no remote fallback.');
 const root=await mkdtemp(join(tmpdir(),'eco-supplier-pg-')),socket=join(root,'socket'),data=join(root,'data');await mkdir(socket,{mode:0o700});
 const env={PATH:process.env.PATH,LANG:'C',LC_ALL:'C',PGPASSFILE:join(root,'none')};let started=false;
 const query=async sql=>(await exec(join(bin,'psql'),['-X','-q','-A','-t','--no-password','-h',socket,'-p','55493','-U','eco_fixture','-d','postgres','-v','ON_ERROR_STOP=1','-c',sql],{env})).stdout.trim();
 const as=(i,sql)=>query(`begin;set local role authenticated;do $$begin perform set_config('request.jwt.claims',${lit(JSON.stringify({sub:ids[i],session_id:sessions[i],aal:'aal1'}))},true);end$$;${sql};commit;`);
 const call=async(i,name,payload)=>JSON.parse(await as(i,`select public.${name}(${payload===undefined?'':json(payload)})`));
 const seed=async()=>{await query(`truncate eco_private.profile_tab_contributions,eco_private.profile_tab_collections,eco_private.profile_tab_identities,eco_private.profile_tab_revisions;truncate eco_private.supplier_contributions,eco_private.supplier_legacy_ids,eco_private.supplier_revisions,eco_private.supplier_import_batches,eco_private.suppliers cascade;truncate eco_private.feedback_contributions,eco_private.feedback,eco_private.import_jobs,eco_private.administration_events,eco_private.administration_requests,eco_private.operational_evidence;truncate auth.users cascade;truncate eco_private.access_audit,eco_private.login_attempts;
 insert into auth.users(id,email,email_confirmed_at,encrypted_password) values ${ids.map((id,i)=>`(${lit(id)},'person${i}@example.test',now(),'synthetic')`).join(',')};
 update eco_private.users set office_id='hk',display_name=case when id=${lit(ids[1])} then 'Otto' else 'Person' end,is_active=true,activated_at=now(),is_admin=id=${lit(ids[0])},is_spc_trader=id<>${lit(ids[0])};
 insert into auth.sessions(id,user_id) values ${ids.map((id,i)=>`(${lit(sessions[i])},${lit(id)})`).join(',')};`);};
 try {
 await exec(join(bin,'initdb'),['-D',data,'-U','eco_fixture','-A','trust','--no-locale','--encoding=UTF8'],{env});
 await exec(join(bin,'pg_ctl'),['-D',data,'-l',join(root,'server.log'),'-o',`-k ${socket} -p 55493 -c listen_addresses=''`,'-w','start'],{env});started=true;
 await query(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,encrypted_password text,raw_app_meta_data jsonb not null default '{}');
 create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),not_after timestamptz);
 create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
 create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
 grant usage on schema auth to authenticated,service_role;grant execute on function auth.uid(),auth.jwt() to authenticated,service_role;`);
    await applySchemaMigrations(query);
 await query("insert into eco_private.offices values('hk','Hong Kong'),('sg','Singapore')");

 const service=async(name,input)=>JSON.parse(await query(`begin;set local role service_role;select set_config('request.jwt.claims','{"role":"service_role"}',true) is not null where false;do $$begin perform set_config('request.jwt.claims','{"role":"service_role"}',true);end$$;select public.${name}(${json(input)});commit;`));
 await t.test('private supplier records and helpers reject browser roles and anonymous RPC',async()=>{
  await seed();for(const table of ['suppliers','supplier_legacy_ids','supplier_revisions','supplier_import_batches']){await assert.rejects(as(1,`select * from eco_private.${table}`),/permission denied/);assert.equal(await query(`select relrowsecurity::text from pg_class where oid='eco_private.${table}'::regclass`),'true');}
  await assert.rejects(query(`set role anon;select public.eco_list_suppliers(${json(page())})`),/permission denied/);
  await assert.rejects(call(0,'eco_import_suppliers',batch([record()])),/permission denied/);
  await assert.rejects(call(0,'eco_enrich_supplier',{}),/permission denied/);
  await assert.rejects(as(0,"select eco_private.supplier_record_check('{}')"),/permission denied/);
 });
 await t.test('operator import is atomic, idempotent, source-traceable, and rejects altered retries',async()=>{
  await seed();const a=record(),b=record({legalName:'Second Supplier'}),input=batch([a,b]);const results=await Promise.all([service('eco_import_suppliers',input),service('eco_import_suppliers',input)]);assert.deepEqual(results[0],results[1]);assert.equal(results[0].inserted,2);
  for(const [table,count] of [['suppliers',2],['supplier_revisions',2],['supplier_import_batches',1],['administration_events',1]])assert.equal(await query(`select count(*) from eco_private.${table}`),String(count));
  assert.equal(await query("select source_records->0->>'legalName' from eco_private.supplier_import_batches"),a.legalName);
  await assert.rejects(service('eco_import_suppliers',{...input,sourceHash:'b'.repeat(64)}),/Import request conflict/);
  await assert.rejects(service('eco_import_suppliers',{...batch([record()]),operatorId:ids[1]}),/administrator required/);
 });
 await t.test('PIC options expose only active SPC trader names, never account details or legacy assignments',async()=>{
  await seed();
  await query(`update eco_private.users set display_name=case id when ${lit(ids[0])} then 'Active Admin' when ${lit(ids[1])} then 'Active SPC' else 'Reader' end,is_spc_trader=id=${lit(ids[1])}`);
  const supplier=record({info:{...info,supplierTrader:'Historical PIC'}}),other=record({legalName:'Other Supplier',countryCode:'KR',info:{...info,supplierTrader:'Outside Singapore'}});
  await service('eco_import_suppliers',batch([supplier,other]));
  const result=await call(2,'eco_supplier_pic_options');assert.deepEqual(result,{options:['Active SPC']});
  assert.doesNotMatch(JSON.stringify(result),/@|office|isAdmin|isSpcTrader|phone|11111111|22222222/);
  await as(0,"select public.eco_set_preview('trader','hk')");assert.deepEqual(await call(0,'eco_supplier_pic_options'),result);
  await assert.rejects(query('set role anon;select public.eco_supplier_pic_options()'),/permission denied/);
  await assert.rejects(query('set role authenticated;select public.eco_supplier_pic_options()'),/Unauthorized/);
  await query(`update eco_private.users set office_id='CREDIT' where id=${lit(ids[1])}`);
  assert.deepEqual(await call(2,'eco_supplier_pic_options'),result,'SPC authority is explicit and independent of office');
  for(const [disable,restore] of [["is_spc_trader=false","is_spc_trader=true"],["is_active=false","is_active=true"],["activated_at=null","activated_at=now()"],[`access_hold_request=${lit(randomUUID())}`,"access_hold_request=null"]]){
   await query(`update eco_private.users set ${disable} where id=${lit(ids[1])}`);
   assert.deepEqual((await call(2,'eco_supplier_pic_options')).options,[]);
   await query(`update eco_private.users set ${restore} where id=${lit(ids[1])}`);
  }
  await query(`update auth.users set email_confirmed_at=null where id=${lit(ids[1])}`);
  assert.deepEqual((await call(2,'eco_supplier_pic_options')).options,[]);
  await query(`update auth.users set email_confirmed_at=now() where id=${lit(ids[1])}`);
  await query(`update eco_private.users set deleted_at=now(),is_active=false,is_admin=false,is_manager=false,is_spc_trader=false where id=${lit(ids[1])}`);
  assert.deepEqual((await call(2,'eco_supplier_pic_options')).options,[]);
  await query(`update eco_private.users set is_active=false where id=${lit(ids[2])}`);
  await assert.rejects(call(2,'eco_supplier_pic_options'),/Unauthorized/);
 });
 await t.test('new Singapore PIC assignments require active SPC authority; unchanged legacy values and saved replay survive roster changes',async()=>{
  await seed();
  await query(`update eco_private.users set display_name=case id when ${lit(ids[0])} then 'Admin Only' when ${lit(ids[1])} then 'Active SPC' else 'Ordinary' end,is_spc_trader=id=${lit(ids[1])}`);
  const supplier=record({info:{...info,supplierTrader:'Retired PIC'}});await service('eco_import_suppliers',batch([supplier]));
  const count=async()=>Number(await query(`select count(*) from eco_private.supplier_contributions where supplier_id=${lit(supplier.id)}::uuid`));
  const unchanged=await call(0,'eco_update_supplier',update(supplier));assert.equal(unchanged.info.supplierTrader,'Retired PIC');assert.equal(await count(),1);
  for(const name of ['Admin Only','Ordinary','Unknown Person','Retired PIC 2']){
   await assert.rejects(call(0,'eco_update_supplier',{...update(unchanged),info:{...unchanged.info,supplierTrader:name}}),/active SPC trader/);
   assert.equal(await count(),1);assert.equal(await query(`select revision from eco_private.suppliers where id=${lit(supplier.id)}::uuid`),'2');
  }
  const create={requestId:randomUUID(),legalName:'Created PIC Supplier',shortName:'CREATED PIC',countryCode:'SG',countryName:'Singapore',portName:'Singapore',background:'',info:{...info,supplierTrader:'Admin Only'},contacts:[],barges:[]};
  await assert.rejects(call(0,'eco_create_supplier',create),/active SPC trader/);
  const change={...update(unchanged),info:{...unchanged.info,supplierTrader:'Active SPC'}};
  const saved=await call(0,'eco_update_supplier',change);assert.equal(saved.revision,3);assert.equal(await count(),2);
  await query(`update eco_private.users set is_spc_trader=false where id=${lit(ids[1])}`);
  assert.deepEqual(await call(0,'eco_update_supplier',change),saved,'An exact committed receipt must replay after PIC eligibility changes');assert.equal(await count(),2);
  const edited=await call(0,'eco_update_supplier',{...update(saved),info:{...saved.info,qualityClaimBar:'14'}});assert.equal(edited.info.supplierTrader,'Active SPC');assert.equal(await count(),3);
  await assert.rejects(call(0,'eco_create_supplier',{...create,info:{...info,supplierTrader:'Active SPC'}}),/active SPC trader/);
  const cleared=await call(0,'eco_update_supplier',{...update(edited),info:{...edited.info,supplierTrader:''}});assert.equal(cleared.info.supplierTrader,'');assert.equal(await count(),4);
  await assert.rejects(call(0,'eco_update_supplier',{...update(cleared),info:cleared.info}),/No changes/);assert.equal(await count(),4);
  const blank=await call(0,'eco_create_supplier',{...create,info:{...info,supplierTrader:''}});assert.equal(blank.info.supplierTrader,'');
  await assert.rejects(as(0,'select eco_private.guard_supplier_pic_assignment()'),/permission denied/);
 });
 await t.test('committed import activity is visible only to real administrators and exposes summary metadata',async()=>{
  await seed();const a=record({nameStatus:'needs-review',legalNameSourceId:null}),input=batch([a]);await service('eco_import_suppliers',input);
  const query={search:'',status:'published',cursor:'',limit:25,scope:'all'};
  const out=await call(0,'eco_list_imports',query);assert.equal(out.items.length,1);assert.equal(out.items[0].id,input.requestId);assert.equal(out.items[0].provenance,'server-published');assert.equal(out.items[0].kind,'supplier');assert.equal(out.items[0].warningCount,1);
  assert.doesNotMatch(JSON.stringify(out),/sales@example|Fixture contact|source_records|sourceHash|password|token/i);
  assert.equal((await call(1,'eco_list_imports',query)).items.length,0);
  await as(0,"select public.eco_set_preview('trader','hk')");assert.equal((await call(0,'eco_list_imports',query)).items.length,0);
 });
 await t.test('invalid provenance or duplicate legacy identity rolls back the complete batch',async()=>{
  await seed();const a=record(),b=record({legacyIds:a.legacyIds});await assert.rejects(service('eco_import_suppliers',batch([a,b])),/duplicate key/);
  for(const table of ['suppliers','supplier_revisions','supplier_import_batches','administration_events'])assert.equal(await query(`select count(*) from eco_private.${table}`),'0');
  await assert.rejects(service('eco_import_suppliers',batch([record({legalNameSourceId:null})])),/source/);
  await assert.rejects(service('eco_import_suppliers',batch([record({facts:[{label:'Unsafe',value:'X',sourceId:'missing'}]})])),/Unknown fact source/);
  await assert.rejects(service('eco_import_suppliers',batch([record({sources:[{id:'mpa',type:'mpa',title:'Source',url:'javascript:alert(1)',documentDate:'',retrievedAt:'2026'}]})])),/Invalid source/);
 });
 await t.test('list searches legal/short/aliases and filters with stable bounded pagination; legacy resolves same UUID',async()=>{
  await seed();const a=record({legalName:'Alpha Name',shortName:'ALPHA',aliases:['Old Alpha'],contacts:[{id:'unnamed',role:'general',name:'',phone:'+6590000000',email:'',sourceId:'spc'}]}),b=record({legalName:'Beta Name',shortName:'BETA',countryCode:'KR',countryName:'Korea',portName:'Busan',info:{...info,availableGrade:'LSMGO',supplierTrader:'Lee'}});await service('eco_import_suppliers',batch([a,b]));
  assert.equal((await call(1,'eco_list_suppliers',page())).total,2);const first=await call(1,'eco_list_suppliers',page({limit:1}));const second=await call(1,'eco_list_suppliers',page({limit:1,page:2}));assert.equal(first.items[0].id,a.id);assert.equal(second.items[0].id,b.id);assert.equal(first.items[0].contacts,undefined);assert.equal(first.items[0].contactCount,1);
  for(const filter of [{search:'Old Alpha'},{country:'SG'},{grade:'VLSFO'},{trader:'Otto'}])assert.deepEqual((await call(1,'eco_list_suppliers',page(filter))).items.map(x=>x.id),[a.id]);
  assert.equal((await call(1,'eco_list_suppliers',page({search:'%'}))).total,0);
  const detail=JSON.parse(await as(1,`select public.eco_supplier_detail(${lit(a.legacyIds[0])})`));assert.equal(detail.id,a.id);assert.equal(detail.contacts.length,1);
  assert.equal(await as(1,"select public.eco_supplier_detail('missing') is null"),'t');await assert.rejects(call(1,'eco_list_suppliers',page({limit:101})),/Invalid pagination/);
 });
 await t.test('authorized operational edit is audited, optimistic and idempotent; provenance remains protected',async()=>{
  await seed();const a=record();await service('eco_import_suppliers',batch([a]));const input=update(a);const results=await Promise.all([call(1,'eco_update_supplier',input),call(1,'eco_update_supplier',input)]);assert.deepEqual(results[0],results[1]);assert.equal(results[0].revision,2);assert.equal(results[0].legalName,a.legalName);assert.equal(results[0].contacts[0].sourceId,'spc');assert.equal(results[0].sources.at(-1).type,'user');
  assert.equal(await query("select count(*) from eco_private.administration_events where action='supplier-updated'"),'1');assert.equal(await query('select count(*) from eco_private.supplier_revisions'),'2');
  await assert.rejects(call(1,'eco_update_supplier',{...input,requestId:randomUUID()}),/Revision conflict/);
  await assert.rejects(call(1,'eco_update_supplier',{...input,facts:[]}),/Invalid input/);
  await assert.rejects(call(1,'eco_update_supplier',{...update(results[0]),contacts:[{id:'blank',role:'sales',name:'',phone:'',email:'',sourceId:''}]}),/Contact details required/);
  const changed={...update(results[0]),contacts:[{...a.contacts[0],name:'Corrected',sourceId:'mpa'}],info:results[0].info};const out=await call(1,'eco_update_supplier',changed);assert.equal(out.contacts[0].sourceId,'eco-update:'+changed.requestId);assert.equal(out.barges[0].sourceId,'spc');
 });
 await t.test('concurrent independent edits accept exactly one and rollback when auditing fails',async()=>{
  await seed();const a=record();await service('eco_import_suppliers',batch([a]));const input=update(a);const race=await Promise.allSettled([call(1,'eco_update_supplier',input),call(2,'eco_update_supplier',{...input,requestId:randomUUID()})]);assert.equal(race.filter(x=>x.status==='fulfilled').length,1);
  await query(`create function eco_private.fixture_reject_supplier_event() returns trigger language plpgsql as $$begin raise exception 'fixture audit failure';end$$;create trigger fixture_reject_supplier_event before insert on eco_private.administration_events for each row execute function eco_private.fixture_reject_supplier_event()`);
  try{await assert.rejects(call(1,'eco_update_supplier',{...input,requestId:randomUUID(),revision:2,info:{...info,paymentTerms:'60 days'}}),/fixture audit failure/);assert.equal(await query('select revision from eco_private.suppliers'),'2');assert.equal(await query('select count(*) from eco_private.supplier_revisions'),'2');}finally{await query('drop trigger fixture_reject_supplier_event on eco_private.administration_events;drop function eco_private.fixture_reject_supplier_event()');}
 });
 await t.test('preview, inactive, revoked and deleted members cannot write shared suppliers',async()=>{
  await seed();const a=record();await service('eco_import_suppliers',batch([a]));await as(0,"select public.eco_set_preview('trader','hk')");await assert.rejects(call(0,'eco_update_supplier',update(a)),/read.only|Forbidden/i);
  await query(`update eco_private.users set is_active=false where id=${lit(ids[1])}`);await assert.rejects(call(1,'eco_list_suppliers',page()),/Unauthorized/);
  await query(`insert into eco_private.revoked_sessions(session_id,user_id) values(${lit(sessions[2])},${lit(ids[2])})`);await assert.rejects(call(2,'eco_update_supplier',update(a)),/Unauthorized/);
 });
 await t.test('reimport preserves later operational edits and records recoverable before-state',async()=>{
  await seed();const a=record();await service('eco_import_suppliers',batch([a]));await call(1,'eco_update_supplier',update(a));const rerun=await service('eco_import_suppliers',batch([a]));assert.equal(rerun.inserted,0);assert.equal(rerun.preserved,1);assert.equal(await query("select record#>>'{info,paymentTerms}' from eco_private.suppliers"),'45 days');assert.equal(await query("select before_records->0->>'revision' from eco_private.supplier_import_batches where jsonb_array_length(before_records)>0"),'2');
  await assert.rejects(service('eco_import_suppliers',batch([{...a,id:randomUUID()}])),/Source identity conflict/);
 });
 await t.test('operator enrichment resolves evidence with revision guard while retaining operations and snapshots',async()=>{
  await seed();const a=record({legalName:'UNRESOLVED',nameStatus:'needs-review',legalNameSourceId:null});await service('eco_import_suppliers',batch([a]));await call(1,'eco_update_supplier',update(a));
  const input={requestId:randomUUID(),operatorId:ids[0],id:a.id,revision:2,legalName:'Resolved Legal Name Pte Ltd',nameStatus:'verified',legalNameSourceId:'mpa',facts:a.facts,sources:[]};const out=await service('eco_enrich_supplier',input);assert.equal(out.revision,3);assert.equal(out.info.paymentTerms,'45 days');assert.equal(out.contacts[0].sourceId,'spc');assert.equal(out.legalName,input.legalName);assert.deepEqual(await service('eco_enrich_supplier',input),out);
  await assert.rejects(service('eco_enrich_supplier',{...input,requestId:randomUUID()}),/Revision conflict/);await assert.rejects(service('eco_enrich_supplier',{...input,requestId:randomUUID(),revision:3,info}),/Invalid input/);
  await assert.rejects(service('eco_enrich_supplier',{...input,requestId:randomUUID(),revision:3,sources:[{...a.sources[0],title:'Rewritten evidence'}]}),/Source is immutable/);
  assert.equal(await query('select count(*) from eco_private.supplier_revisions'),'3');
 });

 await t.test('ordinary traders cannot create/edit/archive suppliers; SPC and admin changes are recoverable',async()=>{
  await seed();await query(`update eco_private.users set is_spc_trader=false where id=${lit(ids[2])}`);
  const create={requestId:randomUUID(),legalName:'New Supplier Pte Ltd',shortName:'NEW',countryCode:'SG',countryName:'Singapore',portName:'Singapore',background:'Reviewed summary',info,contacts:[],barges:[]};
  await assert.rejects(call(2,'eco_create_supplier',create),/authority/);
  const created=await call(1,'eco_create_supplier',create);assert.equal(created.background,'Reviewed summary');assert.equal(created.nameStatus,'needs-review');assert.deepEqual(await call(1,'eco_create_supplier',create),created);
  await assert.rejects(call(2,'eco_update_supplier',update(created)),/authority/);await assert.rejects(call(2,'eco_archive_supplier',{requestId:randomUUID(),id:created.id,revision:1}),/authority/);
  const changed=await call(0,'eco_update_supplier',{...update(created),legalName:'New Official Name',shortName:'RENAMED',background:'Updated summary'});assert.equal(changed.legalName,'New Official Name');assert.equal(changed.nameStatus,'needs-review');assert.equal(changed.background,'Updated summary');
  const archive={requestId:randomUUID(),id:changed.id,revision:2};const result=await call(1,'eco_archive_supplier',archive);assert.equal(result.revision,3);assert.deepEqual(await call(1,'eco_archive_supplier',archive),result);assert.equal((await call(2,'eco_list_suppliers',page())).total,0);assert.equal(await as(2,`select public.eco_supplier_detail(${lit(changed.id)}) is null`),'t');
  await assert.rejects(call(0,'eco_update_supplier',{...update(changed),revision:3}),/Unknown supplier/);
  await assert.rejects(call(0,'eco_restore_supplier',{...archive,operatorId:ids[0],revision:3}),/permission denied/);
  const restored=await service('eco_restore_supplier',{...archive,requestId:randomUUID(),operatorId:ids[0],revision:3});assert.equal(restored.revision,4);assert.equal(restored.background,'Updated summary');assert.equal((await call(2,'eco_list_suppliers',page())).total,1);
  assert.equal(await query('select count(*) from eco_private.supplier_revisions'),'4');
  await as(0,"select public.eco_set_preview('admin','hk')");await assert.rejects(call(0,'eco_create_supplier',{...create,requestId:randomUUID()}),/read.only/);
 });
 await t.test('private tabs remain owner-only even to other admins; preview hides private reads and blocks writes',async()=>{
  await seed();const a=record();await service('eco_import_suppliers',batch([a]));const target={kind:'supplier',id:a.id};
  const privateTab={id:randomUUID(),title:'PRIVATE SECRET TITLE',visibility:'private',content:'PRIVATE SECRET CONTENT'};
  const input={requestId:randomUUID(),target,visibility:'private',revision:0,tabs:[privateTab]};
  await query(`update eco_private.users set is_spc_trader=false where id=${lit(ids[1])}`);
  const saved=await call(1,'eco_save_profile_tabs',input);assert.equal(saved.private.revision,1);assert.equal(saved.private.tabs[0].content,privateTab.content);assert.deepEqual(await call(1,'eco_save_profile_tabs',input),saved);
  for(const i of [0,2]){const other=await call(i,'eco_list_profile_tabs',target);assert.deepEqual(other.private,{revision:0,tabs:[]});assert.doesNotMatch(JSON.stringify(other),/PRIVATE SECRET/);}
  for(const table of ['profile_tab_collections','profile_tab_identities','profile_tab_revisions']){await assert.rejects(as(0,`select * from eco_private.${table}`),/permission denied/);assert.equal(await query(`select relrowsecurity from pg_class where oid='eco_private.${table}'::regclass`),'t');}
  assert.doesNotMatch(await query("select coalesce(jsonb_agg(details),'[]') from eco_private.administration_events"),/PRIVATE SECRET/);
  await assert.rejects(call(1,'eco_save_profile_tabs',{...input,requestId:randomUUID(),visibility:'shared',revision:0,tabs:[{...privateTab,visibility:'shared'}]}),/authority/);
  await assert.rejects(call(0,'eco_save_profile_tabs',{...input,requestId:randomUUID(),visibility:'shared',revision:0,tabs:[{...privateTab,visibility:'shared'}]}),/Invalid tab identity/);
  await assert.rejects(call(0,'eco_save_profile_tabs',{...input,requestId:randomUUID(),target:{kind:'country',id:'SG'},visibility:'shared',revision:0,tabs:[{...privateTab,visibility:'shared'}]}),/Invalid tab identity/);
  await query(`update eco_private.users set is_admin=true where id=${lit(ids[1])}`);await as(1,"select public.eco_set_preview('admin','hk')");assert.deepEqual((await call(1,'eco_list_profile_tabs',target)).private,{revision:0,tabs:[]});await assert.rejects(call(1,'eco_save_profile_tabs',{...input,requestId:randomUUID(),revision:1,tabs:[]}),/read.only/);
 });
 await t.test('tab collections have independent revisions, strict scope identities, atomic ordering and audited retries',async()=>{
  await seed();const a=record();await service('eco_import_suppliers',batch([a]));const target={kind:'supplier',id:a.id},one={id:randomUUID(),title:'FIRST',visibility:'shared',content:'First content'},two={id:randomUUID(),title:'SECOND',visibility:'shared',content:'Second content'},builtin={id:'builtin:information',title:'SUPPLIER INFORMATION',visibility:'shared',builtin:'information'};
  const first={requestId:randomUUID(),target,visibility:'shared',revision:0,tabs:[builtin,one,two]};await call(1,'eco_save_profile_tabs',first);
  const race=await Promise.allSettled([call(0,'eco_save_profile_tabs',{...first,requestId:randomUUID(),revision:1,tabs:[builtin,{...one,title:'CHANGED'},two]}),call(1,'eco_save_profile_tabs',{...first,requestId:randomUUID(),revision:1,tabs:[builtin,one,{...two,title:'CHANGED'}]})]);assert.equal(race.filter(x=>x.status==='fulfilled').length,1);
  await call(1,'eco_save_profile_tabs',{requestId:randomUUID(),target,visibility:'private',revision:0,tabs:[{id:randomUUID(),title:'MINE',visibility:'private',content:'Mine'}]});
  const reorder={requestId:randomUUID(),target,visibility:'shared',revision:2,ids:[two.id,builtin.id,one.id]};const ordered=await call(1,'eco_reorder_profile_tabs',reorder);assert.deepEqual(ordered.shared.tabs.map(x=>x.id),reorder.ids);assert.equal(ordered.private.revision,1);assert.deepEqual(await call(1,'eco_reorder_profile_tabs',reorder),ordered);
  await assert.rejects(call(1,'eco_reorder_profile_tabs',{...reorder,requestId:randomUUID(),revision:3,ids:[one.id,one.id,builtin.id]}),/Invalid order/);
  const deleted=await call(1,'eco_delete_profile_tab',{requestId:randomUUID(),target,visibility:'shared',revision:3,id:two.id});assert.equal(deleted.shared.revision,4);assert.equal(deleted.shared.tabs.length,2);
  await assert.rejects(call(1,'eco_save_profile_tabs',{...first,requestId:randomUUID(),revision:4,tabs:[{...two,visibility:'private'}]}),/visibility/);
  await assert.rejects(call(1,'eco_save_profile_tabs',{...first,requestId:randomUUID(),revision:4,tabs:[{...one,ownerId:ids[0]}]}),/Invalid input/);
  await assert.rejects(call(1,'eco_list_profile_tabs',{kind:'area',id:'asia'}),/Invalid profile target/);
  await assert.rejects(call(1,'eco_save_profile_tabs',{...first,requestId:randomUUID(),revision:4,tabs:[{...one,title:' '.repeat(100)+'X'}]}),/Invalid tab text/);
  const before=await query('select count(*) from eco_private.profile_tab_revisions');
  await query(`create function eco_private.fixture_reject_tab_event() returns trigger language plpgsql as $$begin if new.action like 'profile-tabs-%' then raise exception 'fixture tab audit failure';end if;return new;end$$;create trigger fixture_reject_tab_event before insert on eco_private.administration_events for each row execute function eco_private.fixture_reject_tab_event()`);
  try {await assert.rejects(call(1,'eco_save_profile_tabs',{...first,requestId:randomUUID(),revision:4,tabs:[one]}),/fixture tab audit failure/);assert.equal((await call(1,'eco_list_profile_tabs',target)).shared.revision,4);assert.equal(await query('select count(*) from eco_private.profile_tab_revisions'),before);}finally{await query('drop trigger fixture_reject_tab_event on eco_private.administration_events;drop function eco_private.fixture_reject_tab_event()');}
  const emptyTarget={kind:'port',id:'empty-default-layout'};assert.equal((await call(1,'eco_save_profile_tabs',{requestId:randomUUID(),target:emptyTarget,visibility:'shared',revision:0,tabs:[]})).shared.revision,1);
  for(const kind of ['country','port']){const local={kind,id:kind+'-existing-id'};const saved=await call(2,'eco_save_profile_tabs',{requestId:randomUUID(),target:local,visibility:'private',revision:0,tabs:[{id:randomUUID(),title:'PRIVATE',visibility:'private',content:'LOCAL'}]});assert.equal(saved.private.tabs.length,1);assert.equal((await call(0,'eco_list_profile_tabs',local)).private.tabs.length,0);}
  await assert.rejects(query(`set role anon;select public.eco_list_profile_tabs(${json(target)})`),/permission denied/);
  await query(`update eco_private.users set is_active=false where id=${lit(ids[1])}`);await assert.rejects(call(1,'eco_list_profile_tabs',target),/Unauthorized/);
 });

 await t.test('ECO 1.0 buyer tabs are admin-only even through direct RPC and non-admin preview',async()=>{
  await seed();assert.equal(await query("select migration_head from eco_private.platform_versions where component='release-gates'"),'20261015075801');const target={kind:'buyer',id:'buyer-existing-id'},tab={id:randomUUID(),title:'PRIVATE',visibility:'private',content:'OWNER ONLY'};
  const input={requestId:randomUUID(),target,visibility:'private',revision:0,tabs:[tab]};
  assert.equal((await call(0,'eco_save_profile_tabs',input)).private.tabs[0].content,tab.content);
  for(const i of [1,2]){
   await assert.rejects(call(i,'eco_list_profile_tabs',target),/Forbidden/);
   for(const [rpc,value] of [['eco_save_profile_tabs',{...input,requestId:randomUUID()}],['eco_delete_profile_tab',{requestId:randomUUID(),target,visibility:'private',revision:1,id:tab.id}],['eco_reorder_profile_tabs',{requestId:randomUUID(),target,visibility:'private',revision:1,ids:[tab.id]}]])await assert.rejects(call(i,rpc,value),/Forbidden/);
  }
  await query(`update eco_private.users set is_admin=true where id=${lit(ids[1])}`);assert.deepEqual((await call(1,'eco_list_profile_tabs',target)).private,{revision:0,tabs:[]});
  for(const role of ['trader','spc-trader','manager','credit']){
   await as(0,`select public.eco_set_preview(${lit(role)},${lit(role==='credit'?'CREDIT':'hk')})`);
   await assert.rejects(call(0,'eco_list_profile_tabs',target),/UNDER CONSTRUCTION/);
   await assert.rejects(call(0,'eco_save_profile_tabs',{...input,requestId:randomUUID(),revision:1}),/read.only/);
  }
  await as(0,"select public.eco_set_preview('admin','hk')");assert.deepEqual((await call(0,'eco_list_profile_tabs',target)).private,{revision:0,tabs:[]});
  await as(0,"select public.eco_set_preview(null,null)");assert.equal((await call(0,'eco_list_profile_tabs',target)).private.tabs[0].content,tab.content);
 });

 await t.test('private report metadata is immutable, source-bound, active-member-readable and archived-supplier-hidden',async()=>{
  await seed();const reportSource={id:'report-fixture',type:'infospectrum',title:'Synthetic report',url:'https://example.test/report',documentDate:'2026-10-15',retrievedAt:'2026-10-15T00:00:00Z'},a=record();a.sources.push(reportSource);await service('eco_import_suppliers',batch([a]));
  const reportId=randomUUID(),hash='b'.repeat(64),input={id:reportId,operatorId:ids[1],supplierId:a.id,sourceId:reportSource.id,fileName:'Synthetic report.pdf',objectPath:a.id+'/'+reportId+'/'+hash+'.pdf',sha256:hash,size:500,documentDate:'2026-10-15'};
  await query(`update eco_private.users set is_spc_trader=false where id=${lit(ids[2])}`);
  await assert.rejects(service('eco_register_supplier_report',{...input,operatorId:ids[2]}),/Supplier editor required/);
  await assert.rejects(call(0,'eco_register_supplier_report',input),/permission denied/);
  const published=await service('eco_register_supplier_report',input);assert.equal(published.id,reportId);assert.equal(published.objectPath,undefined);assert.deepEqual(await service('eco_register_supplier_report',input),published);
  await assert.rejects(service('eco_register_supplier_report',{...input,fileName:'Changed report.pdf'}),/Report request conflict/);
  await assert.rejects(service('eco_register_supplier_report',{...input,id:randomUUID(),sourceId:'spc'}),/Report source mismatch/);
  await assert.rejects(service('eco_register_supplier_report',{...input,id:randomUUID(),objectPath:'../../other.pdf'}),/check constraint/);
  const list=JSON.parse(await as(2,`select public.eco_list_supplier_reports(${lit(a.id)}::uuid)`));assert.equal(list.length,1);assert.equal(list[0].fileName,input.fileName);assert.equal(list[0].objectPath,undefined);
  const access=JSON.parse(await as(2,`select public.eco_supplier_report_access(${lit(reportId)}::uuid)`));assert.equal(access.objectPath,input.objectPath);
  await assert.rejects(as(0,'select * from eco_private.supplier_reports'),/permission denied/);await assert.rejects(query(`set role anon;select public.eco_supplier_report_access(${lit(reportId)}::uuid)`),/permission denied/);
  assert.equal(await query("select relrowsecurity from pg_class where oid='eco_private.supplier_reports'::regclass"),'t');assert.equal(await query("select count(*) from eco_private.administration_events where action='supplier-report-stored'"),'1');
  await call(1,'eco_archive_supplier',{requestId:randomUUID(),id:a.id,revision:1});assert.equal(await as(2,`select public.eco_list_supplier_reports(${lit(a.id)}::uuid)`),'[]');assert.equal(await as(2,`select public.eco_supplier_report_access(${lit(reportId)}::uuid) is null`),'t');
  await query(`update eco_private.users set is_active=false where id=${lit(ids[2])}`);await assert.rejects(as(2,`select public.eco_list_supplier_reports(${lit(a.id)}::uuid)`),/Unauthorized/);
 });
 await t.test('supplier and shared-content edits credit the real contributor exactly once',async()=>{
  await seed();const supplier=record();await service('eco_import_suppliers',batch([supplier]));
  const summary=async i=>JSON.parse(await as(i,"select public.eco_feedback_contributions('7d')"));
  assert.equal((await summary(1)).count,0);
  const change=update(supplier);const edited=await call(1,'eco_update_supplier',change);
  assert.equal((await summary(1)).count,1);
  assert.equal((await summary(1)).items[0].kind,'supplier');
  await call(1,'eco_update_supplier',change);assert.equal((await summary(1)).count,1);
  assert.equal((await summary(0)).count,0);
  const target={kind:'supplier',id:edited.id};const tab={id:randomUUID(),title:'OPERATIONS',visibility:'shared',content:'Current supplier instructions'};
  const first=await call(1,'eco_save_profile_tabs',{requestId:randomUUID(),target,visibility:'shared',revision:0,tabs:[tab]});
  assert.equal(first.shared.revision,1);assert.equal((await summary(1)).count,2);
  await call(1,'eco_save_profile_tabs',{requestId:randomUUID(),target,visibility:'shared',revision:1,tabs:[{...tab,title:'OPERATIONS TODAY'}]});
  assert.equal((await summary(1)).count,2);
  await call(1,'eco_save_profile_tabs',{requestId:randomUUID(),target,visibility:'shared',revision:2,tabs:[{...tab,title:'OPERATIONS TODAY',content:'Updated instructions'}]});
  assert.equal((await summary(1)).count,3);
  await call(1,'eco_save_profile_tabs',{requestId:randomUUID(),target,visibility:'private',revision:0,tabs:[{id:randomUUID(),title:'PRIVATE',visibility:'private',content:'Personal note'}]});
  assert.equal((await summary(1)).count,3);
  for(const table of ['supplier_contributions','profile_tab_contributions']){
   assert.equal(await query(`select relrowsecurity from pg_class where oid='eco_private.${table}'::regclass`),'t');
   await assert.rejects(as(1,`select * from eco_private.${table}`),/permission denied/);
  }
  await query(`update eco_private.users set is_spc_trader=false where id=${lit(ids[1])}`);
  await assert.rejects(call(1,'eco_update_supplier',{...update(edited),requestId:randomUUID()}),/authority/);
  assert.equal((await summary(1)).count,3);
 });
 }finally{if(started)await exec(join(bin,'pg_ctl'),['-D',data,'-m','immediate','-w','stop'],{env});await rm(root,{recursive:true,force:true});}
});
