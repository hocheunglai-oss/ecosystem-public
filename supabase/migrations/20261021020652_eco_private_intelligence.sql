-- Private, operator-provisioned reference snapshots. No business rows belong in source.
create table eco_private.intelligence_snapshots (
 id uuid primary key,
 operator_id uuid not null references eco_private.users(id),
 source_hash text not null check(source_hash ~ '^[0-9a-f]{64}$'),
 request jsonb not null,
 document jsonb not null,
 receipt jsonb not null,
 imported_at timestamptz not null default now()
);
create table eco_private.intelligence_active_snapshot (
 singleton boolean primary key default true check(singleton),
 snapshot_id uuid not null references eco_private.intelligence_snapshots(id)
);
alter table eco_private.intelligence_snapshots enable row level security;
alter table eco_private.intelligence_active_snapshot enable row level security;
revoke all on eco_private.intelligence_snapshots,eco_private.intelligence_active_snapshot from public,anon,authenticated,service_role;

create function eco_private.intelligence_identifier(p_value jsonb) returns text
language plpgsql immutable set search_path='' as $$
begin
 if jsonb_typeof(p_value) is distinct from 'string' or (p_value#>>'{}') !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$' then raise exception 'Invalid intelligence identifier' using errcode='22023';end if;
 return p_value#>>'{}';
end;$$;
create function eco_private.intelligence_text(p_value jsonb,p_max integer,p_allow_empty boolean default false) returns void
language plpgsql immutable set search_path='' as $$
begin
 if jsonb_typeof(p_value) is distinct from 'string' or length(p_value#>>'{}')>p_max or (not p_allow_empty and length(trim(p_value#>>'{}'))=0) or (p_value#>>'{}') ~ '[[:cntrl:]]' then raise exception 'Invalid intelligence text' using errcode='22023';end if;
end;$$;
create function eco_private.intelligence_date(p_value jsonb) returns date
language plpgsql immutable set search_path='' as $$
declare value text;
begin
 value:=p_value#>>'{}';
 if jsonb_typeof(p_value) is distinct from 'string' or value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or to_char(value::date,'YYYY-MM-DD')<>value then raise exception 'Invalid intelligence date' using errcode='22023';end if;
 return value::date;
end;$$;
create function eco_private.intelligence_snapshot_check(p_snapshot jsonb) returns void
language plpgsql set search_path='' as $$
declare item jsonb; field text; part jsonb; start_date date; end_date date; port text; stamp timestamptz;
begin
 perform eco_private.admin_check_keys(p_snapshot,array['schemaVersion','portId','recordedAt','supplierRecordedAt','periodStart','periodEnd','sourceUrl','supplierSourceUrl','suppliers','counts']);
 if p_snapshot->'schemaVersion' is distinct from '1'::jsonb or octet_length(p_snapshot::text)>2097152 then raise exception 'Invalid intelligence snapshot' using errcode='22023';end if;
 port:=eco_private.intelligence_identifier(p_snapshot->'portId');
 start_date:=eco_private.intelligence_date(p_snapshot->'periodStart');end_date:=eco_private.intelligence_date(p_snapshot->'periodEnd');
 if end_date<start_date or end_date>current_date or end_date-start_date>3660 then raise exception 'Invalid intelligence period' using errcode='22023';end if;
 foreach field in array array['recordedAt','supplierRecordedAt'] loop
  perform eco_private.intelligence_text(p_snapshot->field,40);
  if p_snapshot->>field !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$' then raise exception 'Invalid intelligence timestamp' using errcode='22023';end if;
  stamp:=(p_snapshot->>field)::timestamptz;
  if stamp>now()+interval '5 minutes' then raise exception 'Invalid intelligence timestamp' using errcode='22023';end if;
 end loop;
 if (p_snapshot->>'recordedAt')::timestamptz<end_date::timestamptz then raise exception 'Invalid intelligence timestamp' using errcode='22023';end if;
 foreach field in array array['sourceUrl','supplierSourceUrl'] loop
  perform eco_private.intelligence_text(p_snapshot->field,2048);
  if p_snapshot->>field !~ '^https://[^/@[:space:]]+(/[^[:space:]]*)?$' then raise exception 'Invalid intelligence source' using errcode='22023';end if;
 end loop;
 if jsonb_typeof(p_snapshot->'suppliers') is distinct from 'array' or jsonb_array_length(p_snapshot->'suppliers') not between 1 and 500 or jsonb_typeof(p_snapshot->'counts') is distinct from 'array' or jsonb_array_length(p_snapshot->'counts')>20000 then raise exception 'Invalid intelligence rows' using errcode='22023';end if;
 if (select count(distinct value->>'id') from jsonb_array_elements(p_snapshot->'suppliers'))<>jsonb_array_length(p_snapshot->'suppliers') then raise exception 'Duplicate intelligence supplier' using errcode='22023';end if;
 for item in select value from jsonb_array_elements(p_snapshot->'suppliers') loop
  perform eco_private.admin_check_keys(item,array['id','name','companyId','portIds','grades','paymentTerms','qualityClaimBar','supplierTrader','foBdn','goBdn','bargeCount','sourceUrl']);
  perform eco_private.intelligence_identifier(item->'id');perform eco_private.intelligence_text(item->'name',300);
  if item?'companyId' then perform eco_private.intelligence_identifier(item->'companyId');end if;
  if jsonb_typeof(item->'portIds') is distinct from 'array' or jsonb_array_length(item->'portIds') not between 1 and 50 or not (item->'portIds' ? port) or jsonb_typeof(item->'grades') is distinct from 'array' or jsonb_array_length(item->'grades')>30 then raise exception 'Invalid intelligence coverage' using errcode='22023';end if;
  for part in select value from jsonb_array_elements(item->'portIds') loop perform eco_private.intelligence_identifier(part);end loop;
  for part in select value from jsonb_array_elements(item->'grades') loop perform eco_private.intelligence_text(part,80);end loop;
  foreach field in array array['portIds','grades'] loop
   if (select count(distinct value) from jsonb_array_elements(item->field))<>jsonb_array_length(item->field) then raise exception 'Duplicate intelligence coverage' using errcode='22023';end if;
  end loop;
  foreach field in array array['paymentTerms','qualityClaimBar','supplierTrader','foBdn','goBdn'] loop
   if item?field then perform eco_private.intelligence_text(item->field,500,true);end if;
  end loop;
  if item?'sourceUrl' then
   perform eco_private.intelligence_text(item->'sourceUrl',2048);
   if item->>'sourceUrl' !~ '^https://[^/@[:space:]]+(/[^[:space:]]*)?$' then raise exception 'Invalid intelligence source' using errcode='22023';end if;
  end if;
  if item?'bargeCount' and (jsonb_typeof(item->'bargeCount') is distinct from 'number' or (item->>'bargeCount') !~ '^(0|[1-9][0-9]*)$' or (item->>'bargeCount')::numeric>100000) then raise exception 'Invalid intelligence count' using errcode='22023';end if;
 end loop;
 if (select count(distinct (value->>'supplierId',value->>'date')) from jsonb_array_elements(p_snapshot->'counts'))<>jsonb_array_length(p_snapshot->'counts') then raise exception 'Duplicate intelligence count' using errcode='22023';end if;
 for item in select value from jsonb_array_elements(p_snapshot->'counts') loop
  perform eco_private.admin_check_keys(item,array['supplierId','date','count']);perform eco_private.intelligence_identifier(item->'supplierId');
  if eco_private.intelligence_date(item->'date') not between start_date and end_date or not exists(select 1 from jsonb_array_elements(p_snapshot->'suppliers') s where s->>'id'=item->>'supplierId') then raise exception 'Unknown intelligence count reference' using errcode='22023';end if;
  if jsonb_typeof(item->'count') is distinct from 'number' or (item->>'count') !~ '^(0|[1-9][0-9]*)$' or (item->>'count')::numeric>1000000 then raise exception 'Invalid intelligence count' using errcode='22023';end if;
 end loop;
end;$$;

create function eco_private.intelligence_snapshot() returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; member eco_private.users;
begin
 member:=eco_private.current_member();
 if member.deleted_at is not null then raise exception 'Unauthorized' using errcode='28000';end if;
 select s.document into result from eco_private.intelligence_active_snapshot a join eco_private.intelligence_snapshots s on s.id=a.snapshot_id where a.singleton;
 if result is null then return jsonb_build_object('available',false,'snapshot',null);end if;
 return jsonb_build_object('available',true,'snapshot',result);
end;$$;
create function eco_private.import_intelligence_snapshot(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor eco_private.users; prior eco_private.intelligence_snapshots; active_id uuid; rid uuid; expected_id uuid; doc jsonb; receipt jsonb;
begin
 if coalesce(current_setting('role',true),'')<>'service_role' then raise exception 'Service role required' using errcode='42501';end if;
 perform eco_private.admin_check_keys(p_input,array['requestId','operatorId','expectedActiveId','sourceHash','snapshot']);
 rid:=eco_private.supplier_uuid(p_input->'requestId');
 perform pg_advisory_xact_lock(1857,2026);
 select * into actor from eco_private.users where id=eco_private.supplier_uuid(p_input->'operatorId') and is_admin and is_active and activated_at is not null and deleted_at is null and access_hold_request is null;
 if not found or not exists(select 1 from auth.users a where a.id=actor.id and a.email_confirmed_at is not null) then raise exception 'Active administrator required' using errcode='42501';end if;
 if not(p_input?'expectedActiveId') then raise exception 'Expected snapshot required' using errcode='22023';end if;
 if p_input->'expectedActiveId'<>'null'::jsonb then expected_id:=eco_private.supplier_uuid(p_input->'expectedActiveId');end if;
 if jsonb_typeof(p_input->'sourceHash') is distinct from 'string' or p_input->>'sourceHash' !~ '^[0-9a-f]{64}$' then raise exception 'Invalid source hash' using errcode='22023';end if;
 perform eco_private.intelligence_snapshot_check(p_input->'snapshot');
 perform pg_advisory_xact_lock(1857,211021);
 select * into prior from eco_private.intelligence_snapshots where id=rid;
 if found then
  if prior.request<>p_input then raise exception 'Intelligence import request conflict' using errcode='PT409';end if;
  -- An old retry is a receipt replay; it never reactivates an obsolete snapshot.
  return prior.receipt;
 end if;
 select snapshot_id into active_id from eco_private.intelligence_active_snapshot where singleton;
 if active_id is distinct from expected_id then raise exception 'Intelligence snapshot changed' using errcode='PT409';end if;
 doc:=(p_input->'snapshot')||jsonb_build_object('id',rid,'suppliers',(
  select jsonb_agg(s||jsonb_build_object('fixtureCount',coalesce((select sum((c->>'count')::bigint) from jsonb_array_elements(p_input#>'{snapshot,counts}') c where c->>'supplierId'=s->>'id'),0),'fixturePeriod',case when (p_input#>>'{snapshot,periodEnd}')::date=((p_input#>>'{snapshot,periodStart}')::date+interval '1 year'-interval '1 day')::date then 'Last 12 months' else (p_input#>>'{snapshot,periodStart}')||' – '||(p_input#>>'{snapshot,periodEnd}') end,'recordedAt',p_input#>>'{snapshot,recordedAt}') order by ordinal)
  from jsonb_array_elements(p_input#>'{snapshot,suppliers}') with ordinality as suppliers(s,ordinal)));
 receipt:=jsonb_build_object('snapshotId',rid,'previousSnapshotId',active_id,'sourceHash',p_input->>'sourceHash','suppliers',jsonb_array_length(doc->'suppliers'),'counts',jsonb_array_length(doc->'counts'));
 insert into eco_private.intelligence_snapshots(id,operator_id,source_hash,request,document,receipt) values(rid,actor.id,p_input->>'sourceHash',p_input,doc,receipt);
 insert into eco_private.intelligence_active_snapshot(singleton,snapshot_id) values(true,rid) on conflict(singleton) do update set snapshot_id=excluded.snapshot_id;
 insert into eco_private.administration_events(actor_id,actor_name,target_id,action,details) values(actor.id,actor.display_name,rid,'intelligence-import',jsonb_build_object('sourceHash',p_input->>'sourceHash','supplierCount',jsonb_array_length(doc->'suppliers'),'countRows',jsonb_array_length(doc->'counts'),'previousSnapshotId',active_id));
 return receipt;
end;$$;
create function public.eco_intelligence_snapshot() returns jsonb language sql set search_path='' as $$select eco_private.intelligence_snapshot();$$;
create function public.eco_import_intelligence_snapshot(p_input jsonb) returns jsonb language sql set search_path='' as $$select eco_private.import_intelligence_snapshot(p_input);$$;
revoke all on function eco_private.intelligence_identifier(jsonb),eco_private.intelligence_text(jsonb,integer,boolean),eco_private.intelligence_date(jsonb),eco_private.intelligence_snapshot_check(jsonb),eco_private.intelligence_snapshot(),eco_private.import_intelligence_snapshot(jsonb),public.eco_intelligence_snapshot(),public.eco_import_intelligence_snapshot(jsonb) from public,anon,authenticated,service_role;
grant execute on function eco_private.intelligence_snapshot(),public.eco_intelligence_snapshot() to authenticated;
grant execute on function eco_private.import_intelligence_snapshot(jsonb),public.eco_import_intelligence_snapshot(jsonb) to service_role;
insert into eco_private.platform_versions(component,migration_head) values('intelligence','20261021020652');
