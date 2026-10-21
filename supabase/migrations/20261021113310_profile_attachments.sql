-- Shared profile files retain immutable objects and stable browser metadata IDs.
-- Pending objects are recoverable but never listed/downloaded as published files.
create table eco_private.profile_attachment_limits (id boolean primary key default true check(id), max_total_bytes bigint not null default 268435456 check(max_total_bytes between 52428800 and 268435456));
insert into eco_private.profile_attachment_limits(id) values(true);
alter table eco_private.profile_attachment_limits enable row level security;
revoke all on eco_private.profile_attachment_limits from public,anon,authenticated,service_role;
create table eco_private.profile_attachment_items (
 id text primary key check(length(id) between 1 and 300), record jsonb not null,
 revision integer not null default 1 check(revision>0), upload_id uuid, archived_at timestamptz
);
create table eco_private.profile_attachment_folders (
 id text primary key check(length(id) between 1 and 300), record jsonb not null,
 revision integer not null default 1 check(revision>0)
);
create table eco_private.profile_attachment_uploads (
 id uuid primary key default gen_random_uuid(), item_id text not null unique,
 object_path text not null unique, proposed_record jsonb not null, actor_id uuid not null references eco_private.users(id),
 expected_sha256 text not null check(expected_sha256 ~ '^[a-f0-9]{64}$'), expected_size bigint not null check(expected_size between 0 and 52428800),
 expected_mime text not null, state text not null default 'pending' check(state in ('pending','active')),
 created_at timestamptz not null default now(), verified_at timestamptz, sha256 text, size_bytes bigint, storage_object_id uuid, storage_version text,
 check((state='pending' and sha256 is null and size_bytes is null) or (state='active' and sha256=expected_sha256 and size_bytes=expected_size and verified_at is not null and storage_object_id is not null))
);
alter table eco_private.profile_attachment_items add foreign key(upload_id) references eco_private.profile_attachment_uploads(id);
create table eco_private.profile_attachment_history (
 id bigint generated always as identity primary key, actor_id uuid not null references eco_private.users(id),
 item_id text not null, action text not null, recorded_at timestamptz not null default now(), before_record jsonb, after_record jsonb
);
alter table eco_private.profile_attachment_items enable row level security;
alter table eco_private.profile_attachment_folders enable row level security;
alter table eco_private.profile_attachment_uploads enable row level security;
alter table eco_private.profile_attachment_history enable row level security;
revoke all on eco_private.profile_attachment_items,eco_private.profile_attachment_folders,eco_private.profile_attachment_uploads,eco_private.profile_attachment_history from public,anon,authenticated,service_role;

insert into storage.buckets(id,name,public,file_size_limit) values('eco-profile-attachments','eco-profile-attachments',false,52428800);
-- No browser Storage policies: exact, non-overwriting signed upload/download capabilities only.

create function eco_private.attachment_scope(p_scope jsonb,p_actor eco_private.users,p_write boolean) returns void
language plpgsql security definer set search_path='' as $$
declare t jsonb; country text;
begin
 perform eco_private.admin_check_keys(p_scope,array['target','section']);
 t:=p_scope->'target';perform eco_private.admin_check_keys(t,array['kind','id']);perform eco_private.admin_check_text(t,'id',1,300);
 if t->>'kind'='supplier' then
  select country_code into country from eco_private.suppliers where id=eco_private.supplier_uuid(t->'id') and archived_at is null;
  if not found then raise exception 'Target not found' using errcode='PT404';end if;
  if p_write and country='SG' and not(p_actor.is_admin or p_actor.is_spc_trader) then raise exception 'Access denied' using errcode='42501';end if;
 elsif t->>'kind' in ('country','port') then
  if not eco_private.eco_location_target_exists(t->>'kind',t->>'id') then raise exception 'Target not found' using errcode='PT404';end if;
 else raise exception 'Target not found' using errcode='PT404';end if;
 if p_scope ? 'section' then perform eco_private.admin_check_keys(p_scope->'section',array['id','name']);perform eco_private.admin_check_text(p_scope->'section','id',1,300);perform eco_private.admin_check_text(p_scope->'section','name',1,240);end if;
end;$$;
create function eco_private.attachment_component(p_text text) returns text language plpgsql immutable set search_path='' as $$
declare b bytea:=convert_to(p_text,'UTF8');result text:='';n integer;i integer;
begin
 for i in 0..length(b)-1 loop n:=get_byte(b,i);if (n between 65 and 90) or (n between 97 and 122) or (n between 48 and 57) or n in (45,95,46,33,126,42,39,40,41) then result:=result||chr(n);else result:=result||'%'||upper(lpad(to_hex(n),2,'0'));end if;end loop;return result;
end;$$;
create function eco_private.attachment_destination(p_id text,p_scope jsonb) returns void language plpgsql set search_path='' as $$
declare root text;folder jsonb;
begin
 root:=(p_scope#>>'{target,kind}')||':'||eco_private.attachment_component(p_scope#>>'{target,id}');
 if p_scope ? 'section' then root:=root||':section:'||eco_private.attachment_component(p_scope#>>'{section,id}');end if;
 if p_id=root then return;end if;
 select record into folder from eco_private.profile_attachment_folders where id=p_id;
 if not found or folder->'scope' is distinct from p_scope then raise exception 'Invalid destination' using errcode='22023';end if;
end;$$;
create function eco_private.attachment_record_check(p_record jsonb,p_folder boolean) returns void language plpgsql set search_path='' as $$
begin
 perform eco_private.admin_check_text(p_record,'id',1,300);perform eco_private.admin_check_text(p_record,'name',1,240);
 if p_record->>'name' in ('.','..') or p_record->>'name' ~ '[[:cntrl:]/\\]' then raise exception 'Invalid name' using errcode='22023';end if;
 if p_folder then perform eco_private.admin_check_text(p_record,'parentId',1,300);else perform eco_private.admin_check_text(p_record,'folderId',1,300);end if;
end;$$;
create function public.eco_list_profile_attachments() returns jsonb language plpgsql security definer set search_path='' as $$
declare actor eco_private.users;items jsonb:='[]';folders jsonb:='[]';targets jsonb;r record;
begin
 actor:=eco_private.current_member();
 if (select count(*) from eco_private.profile_attachment_items where archived_at is null)>10000 or (select count(*) from eco_private.profile_attachment_folders)>10000 then raise exception 'Catalog limit' using errcode='PT422';end if;
 for r in select * from eco_private.profile_attachment_items where archived_at is null order by id loop
  begin perform eco_private.attachment_scope(r.record->'scope',actor,false);items:=items||jsonb_build_array(r.record||jsonb_build_object('revision',r.revision));exception when sqlstate 'PT404' then null;end;
 end loop;
 for r in select * from eco_private.profile_attachment_folders order by id loop
  begin perform eco_private.attachment_scope(r.record->'scope',actor,false);folders:=folders||jsonb_build_array(r.record||jsonb_build_object('revision',r.revision));exception when sqlstate 'PT404' then null;end;
 end loop;
 select coalesce(jsonb_agg(key order by key),'[]'::jsonb) into targets from (
  select 'country:'||(c->>'id') as key from eco_private.location_knowledge_state s,jsonb_array_elements(s.snapshot->'locationCountries') c
  union select 'port:'||(p->>'id') from eco_private.location_knowledge_state s,jsonb_array_elements(s.snapshot->'ports') p
  union select 'supplier:'||id::text from eco_private.suppliers where archived_at is null) target_keys;
 return jsonb_build_object('items',items,'folders',folders,'targetKeys',targets,'retainedIds',coalesce((select jsonb_agg(id order by id) from eco_private.profile_attachment_items where archived_at is not null),'[]'::jsonb));
end;$$;
create function public.eco_prepare_profile_attachment(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor eco_private.users;prior jsonb;r jsonb;u eco_private.profile_attachment_uploads;uid uuid:=gen_random_uuid();result jsonb;
begin
 actor:=eco_private.admin_writable_member();perform eco_private.admin_check_keys(p_input,array['requestId','item']);r:=p_input->'item';
 perform eco_private.admin_check_keys(r,array['id','folderId','scope','name','mime','size','sha256','legacy']);perform eco_private.attachment_record_check(r,false);
 perform eco_private.attachment_scope(r->'scope',actor,true);perform eco_private.attachment_destination(r->>'folderId',r->'scope');
 if jsonb_typeof(r->'size') is distinct from 'number' or (r->>'size') !~ '^[0-9]+$' or (r->>'size')::numeric>52428800 or r->>'sha256' !~ '^[a-f0-9]{64}$' or jsonb_typeof(r->'sha256') is distinct from 'string' or jsonb_typeof(r->'mime') is distinct from 'string' or length(r->>'mime')>150 or r->>'mime' !~ '^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$' then raise exception 'Invalid file' using errcode='22023';end if;
 if r ? 'legacy' then
  perform eco_private.admin_check_keys(r->'legacy',array['createdBy','createdAt']);
  if r#>>'{legacy,createdBy}' is distinct from actor.id::text or length(r#>>'{legacy,createdAt}')>40 or (r#>>'{legacy,createdAt}')::timestamptz is null then raise exception 'Ownership required' using errcode='42501';end if;
 end if;
 prior:=eco_private.admin_request(actor.id,p_input,'attachment-prepare');if prior is not null then return prior;end if;
 if exists(select 1 from eco_private.profile_attachment_items where id=r->>'id') or exists(select 1 from eco_private.profile_attachment_uploads where item_id=r->>'id') then raise exception 'Record conflict' using errcode='PT409';end if;
 -- Bound accumulated pending reservations and total retained bytes; never discard originals.
 if (select count(*) from eco_private.profile_attachment_uploads where actor_id=actor.id and state='pending')>=100 then raise exception 'Pending upload limit' using errcode='PT429';end if;
 if (select coalesce(sum(case when state='pending' then 52428800 else size_bytes end),0) from eco_private.profile_attachment_uploads)+52428800>(select max_total_bytes from eco_private.profile_attachment_limits where id) then raise exception 'Storage capacity review required' using errcode='PT422';end if;
 insert into eco_private.profile_attachment_uploads(id,item_id,object_path,proposed_record,actor_id,expected_sha256,expected_size,expected_mime)
 values(uid,r->>'id',uid::text||'/'||gen_random_uuid()::text||'.bin',r,actor.id,r->>'sha256',(r->>'size')::bigint,r->>'mime') returning * into u;
 result:=jsonb_build_object('uploadId',u.id,'objectPath',u.object_path,'id',u.item_id);
 return eco_private.admin_finish(actor.id,p_input,result);
end;$$;
create function public.eco_access_profile_attachment(p_id text,p_upload boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor eco_private.users;u eco_private.profile_attachment_uploads;r eco_private.profile_attachment_items;rec jsonb;
begin
 if p_upload then actor:=eco_private.admin_writable_member();else actor:=eco_private.current_member();end if;
 if p_upload then select * into u from eco_private.profile_attachment_uploads where item_id=p_id and actor_id=actor.id;rec:=u.proposed_record;
 else select * into r from eco_private.profile_attachment_items where id=p_id and archived_at is null and upload_id is not null;select * into u from eco_private.profile_attachment_uploads where id=r.upload_id and state='active';rec:=r.record;end if;
 if u.id is null then raise exception 'Attachment not found' using errcode='PT404';end if;
 perform eco_private.attachment_scope(rec->'scope',actor,p_upload);
 return jsonb_build_object('actorId',actor.id,'sessionId',auth.jwt()->>'session_id','aal',auth.jwt()->>'aal','uploadId',u.id,'objectPath',u.object_path,'item',rec||jsonb_build_object('size',u.expected_size,'mime',u.expected_mime,'revision',coalesce(r.revision,0)),'expectedSha256',u.expected_sha256,'state',u.state);
end;$$;
create function public.eco_complete_profile_attachment(p_actor_id uuid,p_session_id uuid,p_aal text,p_upload_id uuid,p_verified jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor eco_private.users;u eco_private.profile_attachment_uploads;r jsonb;obj storage.objects;
begin
 if auth.jwt()->>'role' is distinct from 'service_role' then raise exception 'Access denied' using errcode='42501';end if;
 actor:=eco_private.location_service_member(p_actor_id,p_session_id,p_aal);
 select * into u from eco_private.profile_attachment_uploads where id=p_upload_id and actor_id=actor.id for update;
 if not found then raise exception 'Attachment not found' using errcode='PT404';end if;
 perform eco_private.attachment_scope(u.proposed_record->'scope',actor,true);
 if u.state='active' then select record||jsonb_build_object('revision',revision) into r from eco_private.profile_attachment_items where upload_id=u.id;return r;end if;
 perform eco_private.attachment_destination(u.proposed_record->>'folderId',u.proposed_record->'scope');
 perform eco_private.admin_check_keys(p_verified,array['sha256','size','objectId','version','mime']);
 if p_verified->>'sha256' is distinct from u.expected_sha256 or (p_verified->>'size')::bigint is distinct from u.expected_size or p_verified->>'mime' is distinct from u.expected_mime then raise exception 'Verification mismatch' using errcode='PT409';end if;
 select * into obj from storage.objects where bucket_id='eco-profile-attachments' and name=u.object_path for share;
 if not found or obj.id::text is distinct from p_verified->>'objectId' or obj.version is distinct from p_verified->>'version' or (obj.metadata->>'size')::bigint is distinct from u.expected_size or obj.metadata->>'mimetype' is distinct from u.expected_mime then raise exception 'Object changed' using errcode='PT409';end if;
 r:=(u.proposed_record-'sha256'-'legacy')||jsonb_build_object('type','file','createdBy',actor.id,'createdAt',now(),'sha256',u.expected_sha256);
 insert into eco_private.profile_attachment_items(id,record,upload_id) values(u.item_id,r,u.id);
 update eco_private.profile_attachment_uploads set state='active',verified_at=now(),sha256=u.expected_sha256,size_bytes=u.expected_size,storage_object_id=obj.id,storage_version=obj.version where id=u.id;
 insert into eco_private.profile_attachment_history(actor_id,item_id,action,after_record) values(actor.id,u.item_id,'upload',jsonb_build_object('record',r,'legacy',u.proposed_record->'legacy'));
 return r||jsonb_build_object('revision',1);
end;$$;
create function public.eco_mutate_profile_attachment(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor eco_private.users;prior jsonb;r jsonb;old eco_private.profile_attachment_items;folder eco_private.profile_attachment_folders;next_record jsonb;result jsonb;action text;expected integer;cursor_id text;seen text[]:='{}';
begin
 actor:=eco_private.admin_writable_member();perform eco_private.admin_check_keys(p_input,array['requestId','action','revision','record']);
 action:=p_input->>'action';r:=p_input->'record';
 if action not in ('folder','link','update','archive') or jsonb_typeof(p_input->'revision') is distinct from 'number' or (p_input->>'revision') !~ '^[0-9]+$' then raise exception 'Invalid mutation' using errcode='22023';end if;
 expected:=(p_input->>'revision')::integer;perform eco_private.admin_check_text(r,'id',1,300);
 prior:=eco_private.admin_request(actor.id,p_input,'attachment-'||action);if prior is not null then return prior;end if;
 if action='folder' then
  perform eco_private.admin_check_keys(r,array['id','parentId','name','scope']);perform eco_private.attachment_record_check(r,true);
  if r->>'id' ~ '^(country|port|supplier):' or r->>'id' in ('home','locations','suppliers','buyers','credit') then raise exception 'Reserved folder ID' using errcode='22023';end if;perform eco_private.attachment_scope(r->'scope',actor,true);perform eco_private.attachment_destination(r->>'parentId',r->'scope');
  select * into folder from eco_private.profile_attachment_folders where id=r->>'id' for update;
  if coalesce(folder.revision,0)<>expected then raise exception 'Revision conflict' using errcode='PT409';end if;
  if folder.id is not null then perform eco_private.attachment_scope(folder.record->'scope',actor,true);if folder.record->'scope' is distinct from r->'scope' then raise exception 'Folder scope is immutable' using errcode='22023';end if;end if;
  cursor_id:=r->>'parentId';while cursor_id is not null loop
   if cursor_id=r->>'id' or cursor_id=any(seen) then raise exception 'Folder cycle' using errcode='22023';end if;seen:=seen||cursor_id;select record->>'parentId' into cursor_id from eco_private.profile_attachment_folders where id=cursor_id;
  end loop;
  next_record:=r||jsonb_build_object('custom',true);insert into eco_private.profile_attachment_folders(id,record,revision) values(r->>'id',next_record,expected+1) on conflict(id) do update set record=excluded.record,revision=excluded.revision;
  result:=next_record||jsonb_build_object('revision',expected+1);
  insert into eco_private.profile_attachment_history(actor_id,item_id,action,before_record,after_record) values(actor.id,r->>'id','folder',folder.record,result);
 else
  select * into old from eco_private.profile_attachment_items where id=r->>'id' for update;
  if coalesce(old.revision,0)<>expected or old.archived_at is not null then raise exception 'Revision conflict' using errcode='PT409';end if;
  if old.id is not null then perform eco_private.attachment_scope(old.record->'scope',actor,true);end if;
  if action='archive' then
   perform eco_private.admin_check_keys(r,array['id']);if old.id is null then raise exception 'Attachment not found' using errcode='PT404';end if;
   update eco_private.profile_attachment_items set archived_at=now(),revision=revision+1 where id=old.id;result:=jsonb_build_object('id',old.id,'archived',true,'revision',expected+1);
  else
   perform eco_private.attachment_record_check(r,false);perform eco_private.attachment_scope(r->'scope',actor,true);perform eco_private.attachment_destination(r->>'folderId',r->'scope');
   if action='link' then
    perform eco_private.admin_check_keys(r,array['id','folderId','scope','name','url','legacy']);if old.id is not null or exists(select 1 from eco_private.profile_attachment_uploads where item_id=r->>'id') or jsonb_typeof(r->'url') is distinct from 'string' or length(r->>'url')>4096 or r->>'url' !~ '^https?://[^/@[:space:]]+([/:?#]|$)' then raise exception 'Invalid link' using errcode='22023';end if;
    if r ? 'legacy' then perform eco_private.admin_check_keys(r->'legacy',array['createdBy','createdAt']);if r#>>'{legacy,createdBy}' is distinct from actor.id::text or (r#>>'{legacy,createdAt}')::timestamptz is null then raise exception 'Ownership required' using errcode='42501';end if;end if;
    next_record:=(r-'legacy')||jsonb_build_object('type','link','mime','text/uri-list','size',0,'createdBy',actor.id,'createdAt',now());insert into eco_private.profile_attachment_items(id,record) values(r->>'id',next_record);
   else
    perform eco_private.admin_check_keys(r,array['id','folderId','scope','name']);if old.id is null then raise exception 'Attachment not found' using errcode='PT404';end if;
    next_record:=old.record||r;update eco_private.profile_attachment_items set record=next_record,revision=revision+1 where id=old.id;
   end if;result:=next_record||jsonb_build_object('revision',expected+1);
  end if;
  insert into eco_private.profile_attachment_history(actor_id,item_id,action,before_record,after_record) values(actor.id,r->>'id',action,old.record,jsonb_build_object('result',result,'legacy',r->'legacy'));
 end if;
 return eco_private.admin_finish(actor.id,p_input,result);
end;$$;
revoke all on function eco_private.attachment_scope(jsonb,eco_private.users,boolean),eco_private.attachment_component(text),eco_private.attachment_destination(text,jsonb),eco_private.attachment_record_check(jsonb,boolean) from public,anon,authenticated,service_role;
revoke all on function public.eco_list_profile_attachments(),public.eco_prepare_profile_attachment(jsonb),public.eco_access_profile_attachment(text,boolean),public.eco_mutate_profile_attachment(jsonb),public.eco_complete_profile_attachment(uuid,uuid,text,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.eco_list_profile_attachments(),public.eco_prepare_profile_attachment(jsonb),public.eco_access_profile_attachment(text,boolean),public.eco_mutate_profile_attachment(jsonb) to authenticated;
grant execute on function public.eco_complete_profile_attachment(uuid,uuid,text,uuid,jsonb) to service_role;
-- Backup access is read-only and covers new tables through pg_read_all_data membership.
insert into eco_private.platform_versions(component,migration_head) values('profile-attachments','20261021113310');

-- Machine backup receives only records in this protected managed bucket.
create function public.eco_profile_attachment_backup(p_path text) returns jsonb language plpgsql security definer set search_path='' as $$
declare u eco_private.profile_attachment_uploads;
begin
 if auth.jwt()->>'role' is distinct from 'service_role' then raise exception 'Access denied' using errcode='42501';end if;
 select * into u from eco_private.profile_attachment_uploads where object_path=p_path;
 if not found then raise exception 'Unknown storage object' using errcode='PT404';end if;
 return jsonb_build_object('state',u.state,'sha256',u.sha256,'size',u.size_bytes,'objectId',u.storage_object_id,'version',u.storage_version,'mime',u.expected_mime);
end;$$;
revoke all on function public.eco_profile_attachment_backup(text) from public,anon,authenticated,service_role;
grant execute on function public.eco_profile_attachment_backup(text) to service_role;
