import {applySchemaMigrations} from './fixtures/migrations.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
const exec=promisify(execFile),lit=v=>`'${String(v).replaceAll("'","''")}'`,json=v=>`${lit(JSON.stringify(v))}::jsonb`;
const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'],sessions=['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
const scope={target:{kind:'port',id:'port-singapore'}},digest='a'.repeat(64);
const item=(id,extra={})=>({id,folderId:'port:port-singapore',scope,name:'Original.txt',mime:'text/plain',size:20,sha256:digest,...extra});
test('protected attachments on isolated native PostgreSQL',async t=>{
 const bin=process.env.ECO_NATIVE_PG_BIN;assert.ok(bin&&isAbsolute(bin),'Set ECO_NATIVE_PG_BIN; no network fallback.');
 const root=await mkdtemp(join(tmpdir(),'eco-attachments-pg-')),socket=join(root,'s'),data=join(root,'d');await mkdir(socket,{mode:0o700});
 const env={PATH:process.env.PATH,LANG:'C',LC_ALL:'C',PGPASSFILE:join(root,'none')};let started=false;
 const query=async sql=>(await exec(join(bin,'psql'),['-X','-q','-A','-t','--no-password','-h',socket,'-p','55486','-U','eco_fixture','-d','postgres','-v','ON_ERROR_STOP=1','-c',sql],{env,maxBuffer:8*1024*1024})).stdout.trim();
 const as=(i,sql)=>query(`begin;set local role authenticated;do $$begin perform set_config('request.jwt.claims',${lit(JSON.stringify({sub:ids[i],session_id:sessions[i],aal:'aal1'}))},true);end$$;${sql};commit;`);
 const call=async(i,name,input)=>JSON.parse(await as(i,`select public.${name}(${input===undefined?'':json(input)})`));
 const prepare=(i,record,requestId=randomUUID())=>call(i,'eco_prepare_profile_attachment',{requestId,item:record});
 const mutate=(i,action,record,revision=0,requestId=randomUUID())=>call(i,'eco_mutate_profile_attachment',{requestId,action,record,revision});
 const complete=(i,reserved,verified)=>query(`begin;set local role service_role;do $$begin perform set_config('request.jwt.claims','{"role":"service_role"}',true);end$$;select public.eco_complete_profile_attachment(${lit(ids[i])},${lit(sessions[i])},'aal1',${lit(reserved.uploadId)},${json(verified)});commit;`).then(JSON.parse);
 try{
  await exec(join(bin,'initdb'),['-D',data,'-U','eco_fixture','-A','trust','--no-locale','--encoding=UTF8'],{env});
  await exec(join(bin,'pg_ctl'),['-D',data,'-l',join(root,'log'),'-o',`-k ${socket} -p 55486 -c listen_addresses=''`,'-w','start'],{env});started=true;
  await query(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
   create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,encrypted_password text,raw_app_meta_data jsonb not null default '{}');
   create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),not_after timestamptz);
   create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
   create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
   grant usage on schema auth to authenticated,service_role;grant execute on function auth.uid(),auth.jwt() to authenticated,service_role;`);
  await applySchemaMigrations(query);
  await query(`insert into eco_private.offices values('hk','Hong Kong');insert into auth.users(id,email,email_confirmed_at,encrypted_password) values ${ids.map((id,i)=>`(${lit(id)},'attachment${i}@example.test',now(),'synthetic')`).join(',')};update eco_private.users set display_name='Fixture',office_id='hk',is_active=true,activated_at=now(),is_admin=id=${lit(ids[0])};insert into auth.sessions(id,user_id) values${ids.map((id,i)=>`(${lit(sessions[i])},${lit(id)})`).join(',')};`);
  let reserved;
  await t.test('pending files are hidden; immutable reservation is idempotent; no browser can publish or read tables',async()=>{
   const requestId=randomUUID(),input=item('original-stable-id');reserved=await prepare(0,input,requestId);assert.deepEqual(await prepare(0,input,requestId),reserved);
   await assert.rejects(prepare(0,{...input,name:'Changed.txt'},requestId),/Request conflict/);await assert.rejects(prepare(0,input),/Record conflict/);
   assert.equal((await call(1,'eco_list_profile_attachments')).items.length,0);
   await assert.rejects(as(1,'select * from eco_private.profile_attachment_uploads'),/permission denied/);
   await assert.rejects(as(0,`select public.eco_complete_profile_attachment(${lit(ids[0])},${lit(sessions[0])},'aal1',${lit(reserved.uploadId)},'{}')`),/permission denied/);
  });
  await t.test('verification and second authorization are required; active content keeps original metadata ID and becomes shared',async()=>{
   const objectId=randomUUID();await query(`insert into storage.objects(id,bucket_id,name,metadata,version) values(${lit(objectId)},'eco-profile-attachments',${lit(reserved.objectPath)},'{"size":20,"mimetype":"text/plain"}','v1')`);
   const verified={sha256:digest,size:20,mime:'text/plain',objectId,version:'v1'};
   await assert.rejects(complete(0,reserved,{...verified,sha256:'b'.repeat(64)}),/Verification mismatch/);
   await assert.rejects(complete(0,reserved,{...verified,version:'v2'}),/Object changed/);
   await assert.rejects(complete(1,reserved,verified),/not found/);
   await as(0,"select public.eco_set_preview('trader','hk')");await assert.rejects(complete(0,reserved,verified),/read.only/);await as(0,"select public.eco_set_preview(null,null)");
   const saved=await complete(0,reserved,verified);assert.equal(saved.id,'original-stable-id');assert.equal(saved.createdBy,ids[0]);assert.equal(saved.sha256,digest);assert.deepEqual(await complete(0,reserved,verified),saved);
   assert.equal((await call(1,'eco_list_profile_attachments')).items[0].id,saved.id);
   const access=JSON.parse(await as(1,`select public.eco_access_profile_attachment('original-stable-id',false)`));assert.equal(access.objectPath,reserved.objectPath);
  });
  await t.test('metadata CAS preserves concurrent changes, retries are exact, archive keeps object and history',async()=>{
   const requestId=randomUUID(),record={id:'original-stable-id',folderId:'port:port-singapore',scope,name:'Renamed.txt'};
   const changed=await mutate(1,'update',record,1,requestId);assert.equal(changed.revision,2);assert.deepEqual(await mutate(1,'update',record,1,requestId),changed);
   await assert.rejects(mutate(0,'update',{...record,name:'Overwrite.txt'},1),/Revision conflict/);
   await mutate(0,'archive',{id:record.id},2);const list=await call(1,'eco_list_profile_attachments');assert.equal(list.items.length,0);assert.ok(list.retainedIds.includes(record.id));
   assert.equal(await query('select count(*) from storage.objects'),'1');assert.equal(await query("select count(*) from eco_private.profile_attachment_history where item_id='original-stable-id'"),'3');
  });
  await t.test('unknown masters, forged ownership, folder cycles and Singapore supplier privilege bypass are rejected',async()=>{
   for(const kind of ['buyer','credit','company','area'])await assert.rejects(prepare(1,item('bad-'+kind,{scope:{target:{kind,id:'unknown'}}})),/not found/);
   await assert.rejects(prepare(1,item('bad-port',{scope:{target:{kind:'port',id:'unknown'}}})),/not found/);
   await assert.rejects(prepare(1,item('forged-owner',{legacy:{createdBy:ids[0],createdAt:'2026-01-01T00:00:00Z'}})),/Ownership required/);
   await mutate(1,'folder',{id:'folder-parent',parentId:'port:port-singapore',scope,name:'Parent'});
   await mutate(1,'folder',{id:'folder-child',parentId:'folder-parent',scope,name:'Child'});
   await assert.rejects(mutate(1,'folder',{id:'folder-parent',parentId:'folder-child',scope,name:'Parent'},1),/Folder cycle/);
   const supplier=await call(0,'eco_create_supplier',{requestId:randomUUID(),portId:'port-singapore',legalName:'Synthetic Source',shortName:'SYNTHETIC',countryCode:'SG',countryName:'Singapore',portName:'Singapore',background:'',info:{paymentTerms:'',qualityClaimBar:'',supplierTrader:'',availableGrade:'',foBdn:'',goBdn:''},contacts:[],barges:[]});
   const scoped=item('sg-file',{folderId:`supplier:${supplier.id}`,scope:{target:{kind:'supplier',id:supplier.id}}});await assert.rejects(prepare(1,scoped),/Access denied/);assert.ok((await prepare(0,scoped)).uploadId);
  });
  await t.test('capacity accounts for full pending signed-upload allowance and never deletes originals',async()=>{
   await query('truncate eco_private.profile_attachment_items,eco_private.profile_attachment_uploads cascade');
   for(let i=0;i<5;i++)await prepare(0,item('pending-zero-'+i,{size:0}));
   await assert.rejects(prepare(0,item('pending-zero-excess',{size:0})),/capacity review/);
   assert.equal(await query('select count(*) from eco_private.profile_attachment_uploads'),'5');assert.equal(await query('select count(*) from storage.objects'),'1');
  });
 }finally{if(started)await exec(join(bin,'pg_ctl'),['-D',data,'-m','immediate','-w','stop'],{env});await rm(root,{recursive:true,force:true});}
});
