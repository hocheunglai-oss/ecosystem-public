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
test('port supplier SQL against isolated native PostgreSQL',async t=>{
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

 await t.test('canonical port list is exact across same-country ports and rejects unknown IDs',async()=>{
  await seed();const a=record({countryCode:'JP',countryName:'Japan',portName:'Tokyo'}),b=record({countryCode:'JP',countryName:'Japan',portName:'Chiba'}),c=record({countryCode:'SG',portName:'Tokyo'}),d=record({countryCode:'JP',countryName:'Japan',portName:'Tokyo Bay'});
  await service('eco_import_suppliers',batch([a,b,c,d]));
  assert.deepEqual((await call(2,'eco_list_suppliers',page({portId:'port-tokyo'}))).items.map(x=>x.id),[a.id]);
  assert.deepEqual((await call(2,'eco_list_suppliers',page({portId:'port-chiba'}))).items.map(x=>x.id),[b.id]);
  assert.equal((await call(2,'eco_list_suppliers',page({portId:'port-tokyo',country:'SG'}))).total,0);
  assert.equal((await call(2,'eco_list_suppliers',page({portId:'port-singapore'}))).total,0);
  await assert.rejects(call(2,'eco_list_suppliers',page({portId:'Tokyo'})),/Unknown supplier port/);
  await assert.rejects(as(2,"select eco_private.supplier_port('port-tokyo')"),/permission denied/);
 });
 await t.test('ordinary member registers and contributes only under validated non-Singapore port',async()=>{
  await seed();await query(`update eco_private.users set is_spc_trader=false where id=${lit(ids[2])}`);
  const input={requestId:randomUUID(),portId:'port-tokyo',legalName:'Tokyo Port Supplier',shortName:'TOKYO SUPPLIER',countryCode:'JP',countryName:'Japan',portName:'Tokyo',background:'',info:{...info,supplierTrader:''},contacts:[],barges:[]};
  const created=await call(2,'eco_create_supplier',input);assert.equal(created.portName,'Tokyo');assert.deepEqual(await call(2,'eco_create_supplier',input),created);
  assert.equal((await call(2,'eco_list_suppliers',page({portId:'port-tokyo'}))).items[0].id,created.id);assert.equal((await call(2,'eco_list_suppliers',page({portId:'port-chiba'}))).total,0);
  for(const forged of [{portId:'port-singapore'},{portId:'port-tokyo',countryCode:'SG',countryName:'Singapore',portName:'Singapore'},{portId:'unknown'},{portId:'port-chiba'},{portId:null}])await assert.rejects(call(2,'eco_create_supplier',{...input,requestId:randomUUID(),...forged}),/Invalid supplier port|Invalid input/);
  const singapore={...input,requestId:randomUUID(),portId:'port-singapore',countryCode:'SG',countryName:'Singapore',portName:'Singapore',legalName:'SG Supplier',shortName:'SG SUPPLIER'};
  await assert.rejects(call(2,'eco_create_supplier',singapore),/authority/);
  const sg=await call(0,'eco_create_supplier',singapore);await assert.rejects(call(2,'eco_update_supplier',update(sg)),/authority/);await assert.rejects(call(2,'eco_archive_supplier',{requestId:randomUUID(),id:sg.id,revision:sg.revision}),/authority/);
  const change=update(created),edited=await call(2,'eco_update_supplier',change);assert.equal(edited.revision,2);assert.deepEqual(await call(2,'eco_update_supplier',change),edited);
  await assert.rejects(call(2,'eco_update_supplier',{...change,requestId:randomUUID()}),/Revision conflict/);
  assert.equal(await query(`select count(*) from eco_private.supplier_contributions where supplier_id=${lit(created.id)}::uuid`),'1');
  const shared={requestId:randomUUID(),target:{kind:'supplier',id:created.id},visibility:'shared',revision:0,tabs:[{id:randomUUID(),title:'OPERATIONS',visibility:'shared',content:'Tokyo only'}]};
  assert.equal((await call(2,'eco_save_profile_tabs',shared)).shared.revision,1);
  await assert.rejects(call(2,'eco_save_profile_tabs',{...shared,requestId:randomUUID(),target:{kind:'supplier',id:sg.id}}),/authority/);
  const privateTab={...shared,requestId:randomUUID(),visibility:'private',tabs:[{id:randomUUID(),title:'PRIVATE',visibility:'private',content:'PRIVATE TOKYO'}]};await call(2,'eco_save_profile_tabs',privateTab);
  assert.doesNotMatch(JSON.stringify(await call(0,'eco_list_profile_tabs',shared.target)),/PRIVATE TOKYO/);
  const archive={requestId:randomUUID(),id:created.id,revision:2};const removed=await call(2,'eco_archive_supplier',archive);assert.deepEqual(await call(2,'eco_archive_supplier',archive),removed);assert.equal((await call(2,'eco_list_suppliers',page({portId:'port-tokyo'}))).total,0);
  await as(0,"select public.eco_set_preview('trader','hk')");await assert.rejects(call(0,'eco_create_supplier',{...input,requestId:randomUUID()}),/read.only/);
  await query(`update eco_private.users set is_active=false where id=${lit(ids[2])}`);await assert.rejects(call(2,'eco_create_supplier',{...input,requestId:randomUUID()}),/Unauthorized/);
 });
 }finally{if(started)await exec(join(bin,'pg_ctl'),['-D',data,'-m','immediate','-w','stop'],{env});await rm(root,{recursive:true,force:true});}
});
