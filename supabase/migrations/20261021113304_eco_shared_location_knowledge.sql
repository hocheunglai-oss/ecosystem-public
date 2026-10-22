-- Shared location state is committed only after the ECO server applies the domain action.
-- Browser roles can read through current_member(), but cannot submit arbitrary snapshots.
create table eco_private.location_knowledge_state (
 singleton boolean primary key default true check(singleton),
 revision integer not null default 0 check(revision>=0), snapshot jsonb,
 updated_at timestamptz,
 check(snapshot is not null and jsonb_typeof(snapshot)='object')
);
-- Geography-only reference seed; checked against initialLocationSnapshot() in tests.
insert into eco_private.location_knowledge_state(singleton,snapshot) values(true,$location_reference${"schemaVersion":1,"ports":[{"id":"port-singapore","name":"Singapore","country":"Singapore","code":"SGSIN","timezone":"Asia/Singapore","leadTime":"","summary":"","notes":[],"tags":[],"updatedAt":""},{"id":"port-hong-kong","name":"Hong Kong","country":"Hong Kong","code":"HKHKG","timezone":"Asia/Hong_Kong","leadTime":"","summary":"","notes":[],"tags":[],"updatedAt":""},{"id":"port-rotterdam","name":"Rotterdam","country":"Netherlands","code":"NLRTM","timezone":"Europe/Amsterdam","leadTime":"","summary":"","notes":[],"tags":[],"updatedAt":""},{"id":"port-fujairah","name":"Fujairah","country":"United Arab Emirates","code":"AEFJR","timezone":"Asia/Dubai","leadTime":"","summary":"","notes":[],"tags":[],"updatedAt":""},{"id":"port-busan","name":"Busan","country":"South Korea","code":"KRPUS","timezone":"Asia/Seoul","leadTime":"","summary":"","notes":[],"tags":[],"updatedAt":""},{"id":"port-tokyo","name":"Tokyo","country":"Japan","code":"JPTYO","timezone":"Asia/Tokyo","leadTime":"","summary":"","notes":[],"tags":[],"updatedAt":""},{"id":"port-chiba","name":"Chiba","country":"Japan","code":"","timezone":"Asia/Tokyo","leadTime":"","summary":"","notes":[],"tags":[],"updatedAt":""},{"id":"port-yokohama","name":"Yokohama","country":"Japan","code":"","timezone":"Asia/Tokyo","leadTime":"","summary":"","notes":[],"tags":[],"updatedAt":""},{"id":"port-osaka","name":"Osaka","country":"Japan","code":"","timezone":"Asia/Tokyo","leadTime":"","summary":"","notes":[],"tags":[],"updatedAt":""},{"id":"port-ho-chi-minh","name":"Ho Chi Minh City","country":"Vietnam","code":"VNSGN","timezone":"Asia/Ho_Chi_Minh","leadTime":"","summary":"","notes":[],"tags":[],"updatedAt":""},{"id":"port-gibraltar","name":"Gibraltar","country":"Gibraltar","code":"GIGIB","timezone":"Europe/Gibraltar","leadTime":"","summary":"","notes":[],"tags":[],"updatedAt":""}],"locationCountries":[{"id":"Singapore","name":"Singapore"},{"id":"Hong Kong","name":"Hong Kong"},{"id":"Netherlands","name":"Netherlands"},{"id":"United Arab Emirates","name":"United Arab Emirates"},{"id":"South Korea","name":"South Korea"},{"id":"Japan","name":"Japan"},{"id":"Vietnam","name":"Vietnam"},{"id":"Gibraltar","name":"Gibraltar"}],"knowledgeRecords":{},"knowledgeHistory":[],"contributions":[],"historicalContributionIds":[],"legacyLocationAreas":[],"legacyPortAreaIds":{}}$location_reference$::jsonb);
create table eco_private.location_knowledge_revisions (
 revision integer primary key, actor_id uuid not null, operation text not null check(operation in ('mutate','migrate')),
 history_count integer not null, contribution_count integer not null, created_at timestamptz not null default now()
);
create table eco_private.location_knowledge_requests (
 actor_id uuid not null, request_id uuid not null, operation text not null,
 fingerprint text not null, committed_revision integer not null, created_at timestamptz not null default now(),
 primary key(actor_id,request_id)
);
create table eco_private.location_knowledge_imports (
 digest text primary key check(digest ~ '^[0-9a-f]{64}$'), request_id uuid not null,
 imported_by uuid not null, imported_at timestamptz not null default now(), revision integer not null
);
-- Full audit documents are retained once, never copied into the current state or retry receipt.
create table eco_private.location_knowledge_history (
 sequence bigint generated always as identity primary key, target_kind text not null check(target_kind in ('country','port','area')),
 target_id text not null, version integer not null, record jsonb not null,
 imported_by uuid, imported_at timestamptz, unique(target_kind,target_id,version)
);
create index location_history_target_sequence on eco_private.location_knowledge_history(target_kind,target_id,sequence desc);
create table eco_private.location_knowledge_contributions (
 sequence bigint generated always as identity unique, id text primary key, record jsonb not null, publication jsonb not null,
 historical boolean not null, revision integer not null, normalized_body text not null
);
create index location_contribution_duplicate on eco_private.location_knowledge_contributions
 ((record->>'targetType'),(record->>'targetId'),(md5(normalized_body))) where record->>'status'='approved';
create index location_publication_sequence on eco_private.location_knowledge_contributions(sequence)
 where not historical and publication#>>'{locationPublication,eligible}'='true';
create table eco_private.location_contribution_revisions (
 sequence bigint generated always as identity primary key, contribution_id text not null, revision integer not null,
 record jsonb not null, historical boolean not null, imported_by uuid, created_at timestamptz not null default now()
);
alter table eco_private.location_knowledge_state enable row level security;
alter table eco_private.location_knowledge_revisions enable row level security;
alter table eco_private.location_knowledge_requests enable row level security;
alter table eco_private.location_knowledge_imports enable row level security;
alter table eco_private.location_knowledge_history enable row level security;
alter table eco_private.location_knowledge_contributions enable row level security;
alter table eco_private.location_contribution_revisions enable row level security;
revoke all on eco_private.location_knowledge_state,eco_private.location_knowledge_revisions,eco_private.location_knowledge_requests,eco_private.location_knowledge_imports,eco_private.location_knowledge_history,eco_private.location_knowledge_contributions,eco_private.location_contribution_revisions from public,anon,authenticated,service_role;
-- Reusable by protected-file completion, with identity/AAL taken from an authenticated
-- reservation/context, never the browser's submitted actor fields.
create function eco_private.location_service_member(p_actor_id uuid,p_session_id uuid,p_aal text)
returns eco_private.users language plpgsql security definer set search_path='' as $$
declare m eco_private.users;
begin
 perform pg_catalog.pg_advisory_xact_lock(1857,2026);
 if p_aal is null or p_aal not in ('aal1','aal2') then raise exception 'Unauthorized' using errcode='28000';end if;
 select u.* into m from eco_private.users u where u.id=p_actor_id and u.is_active and u.activated_at is not null
  and u.access_hold_request is null and exists(select 1 from auth.users a where a.id=u.id and a.email_confirmed_at is not null);
 if not found or (m.mfa_required and p_aal<>'aal2') then raise exception 'Unauthorized' using errcode='28000';end if;
 perform eco_private.assert_preview_writable(m.id,p_session_id);
 return m;
end;$$;
create function eco_private.location_knowledge_envelope() returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('revision',s.revision,'snapshot',s.snapshot,'importedSources',
  coalesce((select jsonb_agg(jsonb_build_object('digest',i.digest,'requestId',i.request_id,'importedBy',i.imported_by,'importedAt',i.imported_at) order by i.imported_at,i.digest)
  from eco_private.location_knowledge_imports i),'[]'::jsonb)) from eco_private.location_knowledge_state s where singleton;
$$;
create function public.eco_location_knowledge_context(p_include_snapshot boolean default true) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m eco_private.users;
begin
 m:=eco_private.current_member();
 return jsonb_build_object('envelope',case when p_include_snapshot then eco_private.location_knowledge_envelope() else null end,
  'actorId',m.id,'sessionId',auth.jwt()->>'session_id','aal',case when auth.jwt()->>'aal'='aal2' then 'aal2' else 'aal1' end);
end;$$;
create function eco_private.location_knowledge_input(p_input jsonb,p_operation text) returns void
language plpgsql set search_path='' as $$
begin
 if p_operation='mutate' then perform eco_private.admin_check_keys(p_input,array['requestId','revision','dataMode','action']);
 elsif p_operation='migrate' then perform eco_private.admin_check_keys(p_input,array['requestId','revision','dataMode','snapshot']);
 else raise exception 'Invalid operation' using errcode='22023';end if;
 if octet_length(p_input::text)>4194304 or p_input->>'dataMode' is distinct from 'live'
  or jsonb_typeof(p_input->'requestId') is distinct from 'string' or p_input->>'requestId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  or jsonb_typeof(p_input->'revision') is distinct from 'number' or p_input->>'revision' !~ '^(0|[1-9][0-9]*)$'
  or (p_input->>'revision')::numeric>=2147483647
  or (p_operation='mutate' and jsonb_typeof(p_input->'action') is distinct from 'object')
  or (p_operation='migrate' and jsonb_typeof(p_input->'snapshot') is distinct from 'object')
 then raise exception 'Invalid request' using errcode='22023';end if;
end;$$;
create function eco_private.location_knowledge_prior(p_actor_id uuid,p_input jsonb,p_operation text) returns jsonb
language plpgsql set search_path='' as $$
declare prior eco_private.location_knowledge_requests;
begin
 select * into prior from eco_private.location_knowledge_requests where actor_id=p_actor_id and request_id=(p_input->>'requestId')::uuid;
 if not found then return null;end if;
 if prior.operation<>p_operation or prior.fingerprint<>encode(sha256(convert_to(p_input::text,'UTF8')),'hex')
 then raise exception 'Request conflict' using errcode='PT409';end if;
 return eco_private.location_knowledge_envelope()||jsonb_build_object('ack',jsonb_build_object('requestId',prior.request_id,'committedRevision',prior.committed_revision));
end;$$;
create function public.eco_prepare_location_knowledge(p_actor_id uuid,p_session_id uuid,p_aal text,p_operation text,p_input jsonb,p_matching_body text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m eco_private.users;prior jsonb;details jsonb:='[]';
begin
 m:=eco_private.location_service_member(p_actor_id,p_session_id,p_aal);
 perform eco_private.location_knowledge_input(p_input,p_operation);
 if p_operation='migrate' and not m.is_admin then raise exception 'Forbidden' using errcode='42501';end if;
 prior:=eco_private.location_knowledge_prior(m.id,p_input,p_operation);
 if prior is not null then return jsonb_build_object('result',prior);end if;
 if p_operation='mutate' and p_input#>>'{action,type}'='review-contribution' then
  select coalesce(jsonb_agg(record),'[]') into details from eco_private.location_knowledge_contributions where id=p_input#>>'{action,id}';
 elsif p_operation='mutate' and p_input#>>'{action,type}'='submit-contribution' and p_input#>'{action,proposedKeyInfo}' is null then
  select coalesce(jsonb_agg(record),'[]') into details from (select record from eco_private.location_knowledge_contributions
   where record->>'targetType'=p_input#>>'{action,targetType}' and record->>'targetId'=p_input#>>'{action,targetId}'
    and record->>'status'='approved' and record->'proposedKeyInfo' is null
    and md5(normalized_body)=md5(p_matching_body) and normalized_body=p_matching_body limit 1) matched;
 end if;
 return jsonb_build_object('result',null,'envelope',eco_private.location_knowledge_envelope(),'contributions',details,'actor',jsonb_build_object(
  'id',m.id,'email',m.email,'displayName',m.display_name,'officeId',m.office_id,
  'officeName',coalesce((select name from eco_private.offices where id=m.office_id),''),
  'isAdmin',m.is_admin,'isManager',m.is_manager,'isSpcTrader',m.is_spc_trader,'isActive',true,'activated',true,
  'passwordChangeSuggested',false,'revision',m.revision));
end;$$;
create function public.eco_commit_location_knowledge(p_actor_id uuid,p_session_id uuid,p_aal text,p_actor_revision integer,
 p_operation text,p_input jsonb,p_snapshot jsonb,p_source_digest text default null,
 p_history jsonb default '[]',p_contributions jsonb default '[]',p_publications jsonb default '[]',p_normalized_bodies jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare m eco_private.users;prior jsonb;s eco_private.location_knowledge_state;v_revision integer;item jsonb;old jsonb;pub jsonb;changed integer:=0;hchanged integer:=0;
begin
 m:=eco_private.location_service_member(p_actor_id,p_session_id,p_aal);
 perform eco_private.location_knowledge_input(p_input,p_operation);
 if p_operation='migrate' and not m.is_admin then raise exception 'Forbidden' using errcode='42501';end if;
 prior:=eco_private.location_knowledge_prior(m.id,p_input,p_operation);if prior is not null then return prior;end if;
 if m.revision is distinct from p_actor_revision then raise exception 'Account changed' using errcode='PT409';end if;
 select * into s from eco_private.location_knowledge_state where singleton for update;
 if s.revision<>(p_input->>'revision')::integer then raise exception 'Revision conflict' using errcode='PT409';end if;
 perform eco_private.admin_check_keys(p_snapshot,array['schemaVersion','ports','locationCountries','knowledgeRecords','knowledgeHistory','contributions','legacyLocationAreas','legacyPortAreaIds','historicalContributionIds']);
 if p_snapshot->'schemaVersion' is distinct from '1'::jsonb or octet_length(p_snapshot::text)>3670016
  or jsonb_typeof(p_snapshot->'ports') is distinct from 'array' or jsonb_typeof(p_snapshot->'locationCountries') is distinct from 'array'
  or jsonb_typeof(p_snapshot->'knowledgeRecords') is distinct from 'object' or p_snapshot->'knowledgeHistory' is distinct from '[]'::jsonb
  or p_snapshot->'contributions' is distinct from '[]'::jsonb or jsonb_typeof(p_snapshot->'legacyLocationAreas') is distinct from 'array'
  or jsonb_typeof(p_snapshot->'legacyPortAreaIds') is distinct from 'object' or p_snapshot->'historicalContributionIds' is distinct from '[]'::jsonb
  or jsonb_typeof(p_history) is distinct from 'array' or jsonb_typeof(p_contributions) is distinct from 'array' or jsonb_typeof(p_publications) is distinct from 'array'
  or jsonb_array_length(p_contributions)<>jsonb_array_length(p_publications)
 then raise exception 'Invalid snapshot' using errcode='22023';end if;
 if p_operation='mutate' and p_source_digest is not null then raise exception 'Invalid source' using errcode='22023';end if;
 if p_operation='migrate' and (p_source_digest is null or p_source_digest !~ '^[0-9a-f]{64}$') then raise exception 'Invalid source' using errcode='22023';end if;
 if p_operation='migrate' and exists(select 1 from eco_private.location_knowledge_imports where digest=p_source_digest)
 then raise exception 'Source already imported' using errcode='PT409';end if;
 v_revision:=s.revision+1;
 for item in select value from jsonb_array_elements(p_history) loop
  if item#>>'{target,kind}' not in ('country','port','area') or coalesce(length(item#>>'{target,id}'),0) not between 1 and 160
   or coalesce(item->>'version','') !~ '^[1-9][0-9]*$' or octet_length(item::text)>3100000
   or (p_operation='mutate' and item->>'by' is distinct from m.id::text)
  then raise exception 'Invalid history' using errcode='22023';end if;
  select record into old from eco_private.location_knowledge_history where target_kind=item#>>'{target,kind}' and target_id=item#>>'{target,id}' and version=(item->>'version')::integer;
  if found then if old<>item then raise exception 'History conflict' using errcode='PT409';end if;
  else
   insert into eco_private.location_knowledge_history(target_kind,target_id,version,record,imported_by,imported_at)
   values(item#>>'{target,kind}',item#>>'{target,id}',(item->>'version')::integer,item,case when p_operation='migrate' then m.id end,case when p_operation='migrate' then now() end);hchanged:=hchanged+1;
  end if;
 end loop;
 for item in select value from jsonb_array_elements(p_contributions) loop
  select value into pub from jsonb_array_elements(p_publications) where value->>'id'=item->>'id';
  if coalesce(length(item->>'id'),0) not between 1 and 160 or item->>'targetType' not in ('country','port','area')
   or coalesce(length(item->>'targetId'),0) not between 1 and 160 or item->>'status' not in ('pending','approved','declined')
   or octet_length(item::text)>3100000 or pub is null or octet_length(pub::text)>550000
   or jsonb_typeof(p_normalized_bodies->(item->>'id')) is distinct from 'string' or length(p_normalized_bodies->>(item->>'id'))>30000
   or pub->>'body' is distinct from '' or pub->>'author' is distinct from item->>'author' or pub->>'status' is distinct from item->>'status'
   or (p_operation='migrate' and (item->'historicalImport' is distinct from 'true'::jsonb or pub->'historicalImport' is distinct from 'true'::jsonb))
  then raise exception 'Invalid contribution' using errcode='22023';end if;
  select record into old from eco_private.location_knowledge_contributions where id=item->>'id';
  if found and old=item then continue;end if;
  if found then
   if p_operation='migrate' or old->>'status'<>'pending' or p_input#>>'{action,type}'<>'review-contribution'
    or p_input#>>'{action,id}'<>item->>'id' or not m.is_admin or old->>'author'=m.id::text
    or item->>'author' is distinct from old->>'author' or item->>'reviewer' is distinct from m.id::text
   then raise exception 'Contribution conflict' using errcode='PT409';end if;
  elsif p_operation='mutate' and (item->>'author' is distinct from m.id::text or item->'historicalImport' is not null) then
   raise exception 'Invalid author' using errcode='22023';
  end if;
  insert into eco_private.location_knowledge_contributions(id,record,publication,historical,revision,normalized_body)
   values(item->>'id',item,pub,coalesce(item->'historicalImport'='true'::jsonb,false),v_revision,p_normalized_bodies->>(item->>'id'))
   on conflict(id) do update set record=excluded.record,publication=excluded.publication,revision=excluded.revision,normalized_body=excluded.normalized_body;
  insert into eco_private.location_contribution_revisions(contribution_id,revision,record,historical,imported_by)
   values(item->>'id',v_revision,item,coalesce(item->'historicalImport'='true'::jsonb,false),case when p_operation='migrate' then m.id end);changed:=changed+1;
 end loop;
 if p_operation='mutate' and p_snapshot=s.snapshot and changed=0 and hchanged=0 then raise exception 'No changes' using errcode='22023';end if;
 update eco_private.location_knowledge_state set revision=v_revision,snapshot=p_snapshot,updated_at=now() where singleton;
 insert into eco_private.location_knowledge_revisions(revision,actor_id,operation,history_count,contribution_count) values(v_revision,m.id,p_operation,hchanged,changed);
 if p_operation='migrate' then insert into eco_private.location_knowledge_imports(digest,request_id,imported_by,revision)
  values(p_source_digest,(p_input->>'requestId')::uuid,m.id,v_revision);end if;
 insert into eco_private.administration_events(actor_id,actor_name,target_id,action,details)
 values(m.id,m.display_name,(p_input->>'requestId')::uuid,'location-knowledge-'||p_operation,
  jsonb_build_object('revision',v_revision,'sourceDigest',p_source_digest));
 insert into eco_private.location_knowledge_requests(actor_id,request_id,operation,fingerprint,committed_revision)
 values(m.id,(p_input->>'requestId')::uuid,p_operation,encode(sha256(convert_to(p_input::text,'UTF8')),'hex'),v_revision);
 return eco_private.location_knowledge_prior(m.id,p_input,p_operation);
end;$$;
-- Archived reads require the same active authenticated member as the shared current record.
create function public.eco_location_knowledge_history(p_targets jsonb,p_cursor bigint default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare target jsonb;r record;items jsonb:='[]';last_sequence bigint;total bigint;bytes integer:=0;more boolean:=false;
begin
 perform eco_private.current_member();
 if jsonb_typeof(p_targets) is distinct from 'array' or jsonb_array_length(p_targets) not between 1 and 2 or p_cursor<=0 then raise exception 'Invalid targets' using errcode='22023';end if;
 for target in select value from jsonb_array_elements(p_targets) loop
  perform eco_private.admin_check_keys(target,array['kind','id']);
  if target->>'kind' not in ('country','port','area') or coalesce(length(target->>'id'),0) not between 1 and 160 then raise exception 'Invalid target' using errcode='22023';end if;
 end loop;
 select count(*) into total from eco_private.location_knowledge_history h where exists(select 1 from jsonb_array_elements(p_targets) t where t->>'kind'=h.target_kind and t->>'id'=h.target_id);
 for r in select h.* from eco_private.location_knowledge_history h where (p_cursor is null or h.sequence<p_cursor)
  and exists(select 1 from jsonb_array_elements(p_targets) t where t->>'kind'=h.target_kind and t->>'id'=h.target_id) order by sequence desc limit 21 loop
  if jsonb_array_length(items)>=20 or bytes+octet_length(r.record::text)>3200000 then more:=true;exit;end if;
  items:=items||jsonb_build_array(r.record);bytes:=bytes+octet_length(r.record::text);last_sequence:=r.sequence;
 end loop;
 return jsonb_build_object('items',items,'nextCursor',case when more then last_sequence::text else null end,'total',total);
end;$$;
create function public.eco_location_knowledge_contribution(p_id text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare item jsonb;
begin perform eco_private.current_member();if coalesce(length(p_id),0) not between 1 and 160 then raise exception 'Invalid id' using errcode='22023';end if;
 select record into item from eco_private.location_knowledge_contributions where id=p_id;
 if not found then raise exception 'Not found' using errcode='PT404';end if;return jsonb_build_object('item',item);end;$$;
create function public.eco_location_knowledge_pending(p_cursor text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r record;items jsonb:='[]';last_id text;total bigint;bytes integer:=0;more boolean:=false;
begin perform eco_private.current_member();if p_cursor is not null and length(p_cursor) not between 1 and 160 then raise exception 'Invalid cursor' using errcode='22023';end if;
 select count(*) into total from eco_private.location_knowledge_contributions where record->>'status'='pending';
 for r in select id,record from eco_private.location_knowledge_contributions where record->>'status'='pending' and (p_cursor is null or id>p_cursor) order by id limit 26 loop
  if jsonb_array_length(items)>=25 or bytes+octet_length(r.record::text)>3200000 then more:=true;exit;end if;
  items:=items||jsonb_build_array(r.record);bytes:=bytes+octet_length(r.record::text);last_id:=r.id;
 end loop;return jsonb_build_object('items',items,'nextCursor',case when more then last_id else null end,'total',total);end;$$;
-- Only compact facts are scanned for activity. Revision binding prevents a mixed-time summary.
create function public.eco_location_knowledge_publications(p_after bigint default 0,p_revision integer default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare rev integer;r record;items jsonb:='[]';last_sequence bigint;bytes integer:=0;more boolean:=false;
begin perform eco_private.current_member();perform pg_catalog.pg_advisory_xact_lock_shared(1857,2026);if p_after<0 then raise exception 'Invalid cursor' using errcode='22023';end if;
 select revision into rev from eco_private.location_knowledge_state where singleton;
 if p_revision is not null and p_revision<>rev then raise exception 'Activity changed' using errcode='PT409';end if;
 for r in select sequence,publication from eco_private.location_knowledge_contributions where sequence>p_after and not historical and publication#>>'{locationPublication,eligible}'='true' order by sequence limit 501 loop
  if jsonb_array_length(items)>=500 or bytes+octet_length(r.publication::text)>1000000 then more:=true;exit;end if;
  items:=items||jsonb_build_array(r.publication);bytes:=bytes+octet_length(r.publication::text);last_sequence:=r.sequence;
 end loop;
 return jsonb_build_object('revision',rev,'items',items,'nextCursor',case when more then last_sequence::text else null end,
 'directoryIds',case when p_after=0 then coalesce((select jsonb_agg(id::text) from eco_private.users),'[]') else '[]'::jsonb end);end;$$;
create function eco_private.eco_location_target_exists(p_kind text,p_id text) returns boolean
language sql stable security definer set search_path='' as $$
 select coalesce((select case p_kind
  when 'port' then exists(select 1 from jsonb_array_elements(s.snapshot->'ports') v where v->>'id'=p_id)
  when 'country' then exists(select 1 from jsonb_array_elements(s.snapshot->'locationCountries') v where v->>'id'=p_id)
  else false end from eco_private.location_knowledge_state s where singleton),false);
$$;
revoke all on function eco_private.location_service_member(uuid,uuid,text),eco_private.location_knowledge_envelope(),eco_private.location_knowledge_input(jsonb,text),eco_private.location_knowledge_prior(uuid,jsonb,text),eco_private.eco_location_target_exists(text,text),public.eco_location_knowledge_context(boolean),public.eco_location_knowledge_history(jsonb,bigint),public.eco_location_knowledge_contribution(text),public.eco_location_knowledge_pending(text),public.eco_location_knowledge_publications(bigint,integer),public.eco_prepare_location_knowledge(uuid,uuid,text,text,jsonb,text),public.eco_commit_location_knowledge(uuid,uuid,text,integer,text,jsonb,jsonb,text,jsonb,jsonb,jsonb,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.eco_location_knowledge_context(boolean),public.eco_location_knowledge_history(jsonb,bigint),public.eco_location_knowledge_contribution(text),public.eco_location_knowledge_pending(text),public.eco_location_knowledge_publications(bigint,integer) to authenticated;
grant execute on function public.eco_prepare_location_knowledge(uuid,uuid,text,text,jsonb,text),public.eco_commit_location_knowledge(uuid,uuid,text,integer,text,jsonb,jsonb,text,jsonb,jsonb,jsonb,jsonb) to service_role;
insert into eco_private.platform_versions(component,migration_head) values('location-knowledge','20261021113304')
on conflict(component) do update set migration_head=excluded.migration_head;
