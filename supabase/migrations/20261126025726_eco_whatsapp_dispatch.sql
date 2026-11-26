-- ECO-only delivery. Import assignments through a separate private operator step.
create table eco_private.whatsapp_routes (
  centre text not null,
  owner_id uuid not null references eco_private.users(id),
  group_name text not null check (length(group_name) between 1 and 256 and group_name=trim(group_name)),
  source_route_id uuid,
  may_connect boolean not null default false,
  enabled_at timestamptz,
  primary key (centre, owner_id)
);

create table eco_private.whatsapp_dispatchers (
  centre text primary key,
  owner_id uuid not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz not null,
  last_seen_at timestamptz,
  foreign key (centre, owner_id) references eco_private.whatsapp_routes(centre, owner_id)
);

create table eco_private.whatsapp_deliveries (
  enquiry_id uuid primary key references eco_private.commercial_enquiry_queue(enquiry_id) on delete cascade,
  centre text not null,
  owner_id uuid not null,
  group_name text not null,
  route_enabled_at timestamptz not null,
  status text not null default 'queued' check (status in ('queued','claimed','sending','sent','manual_review')),
  attempts integer not null default 0 check (attempts between 0 and 4),
  claim_token uuid,
  lease_until timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (centre, owner_id) references eco_private.whatsapp_routes(centre, owner_id)
);
create index whatsapp_deliveries_queue on eco_private.whatsapp_deliveries(centre, updated_at, enquiry_id) where status='queued';
create unique index whatsapp_deliveries_in_flight on eco_private.whatsapp_deliveries(centre) where status in ('claimed','sending');

alter table eco_private.whatsapp_routes enable row level security;
alter table eco_private.whatsapp_dispatchers enable row level security;
alter table eco_private.whatsapp_deliveries enable row level security;
revoke all on eco_private.whatsapp_routes,eco_private.whatsapp_dispatchers,eco_private.whatsapp_deliveries
  from public,anon,authenticated,service_role;

create function eco_private.enqueue_whatsapp_delivery() returns trigger language plpgsql set search_path='' as $$
begin
  insert into eco_private.whatsapp_deliveries(enquiry_id,centre,owner_id,group_name,route_enabled_at)
  select new.enquiry_id,r.centre,r.owner_id,r.group_name,r.enabled_at
  from eco_private.whatsapp_routes r
  where r.centre=new.centre and r.owner_id=new.queued_by and r.enabled_at<=new.queued_at;
  return new;
end;
$$;
create trigger commercial_enqueue_whatsapp after insert on eco_private.commercial_enquiry_queue
  for each row execute function eco_private.enqueue_whatsapp_delivery();

create function public.eco_whatsapp_route() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare member eco_private.users:=eco_private.current_member();
begin
  if exists(select 1 from eco_private.role_previews where user_id=member.id and session_id::text=auth.jwt()->>'session_id') then
    raise exception 'Preview is read only' using errcode='42501';
  end if;
  return jsonb_build_object('routes',coalesce((
    select jsonb_agg(jsonb_build_object('centre',r.centre,'groupName',r.group_name,'enabled',r.enabled_at is not null,
      'canConnect',r.may_connect and member.is_admin,
      'connected',coalesce(d.last_seen_at>=statement_timestamp()-interval '2 minutes',false)) order by r.centre)
    from eco_private.whatsapp_routes r left join eco_private.whatsapp_dispatchers d on d.centre=r.centre and d.owner_id=r.owner_id
    where r.owner_id=member.id
  ),'[]'::jsonb));
end;
$$;

create function public.eco_connect_whatsapp_dispatcher(p_token_hash text) returns void
language plpgsql security definer set search_path='' as $$
declare
  member eco_private.users:=eco_private.admin_writable_member();
  stamp timestamptz:=clock_timestamp();
begin
  if not member.is_admin or not exists(select 1 from eco_private.whatsapp_routes
    where centre='singapore' and owner_id=member.id and may_connect) then
    raise exception 'Access denied' using errcode='42501';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'Invalid credential' using errcode='22023'; end if;
  -- Pairing serializes with device operations. An interrupted submission stays held.
  insert into eco_private.whatsapp_dispatchers(centre,owner_id,token_hash,issued_at)
    values('singapore',member.id,p_token_hash,stamp)
    on conflict(centre) do update set owner_id=excluded.owner_id,token_hash=excluded.token_hash,issued_at=excluded.issued_at,last_seen_at=null;
  update eco_private.whatsapp_deliveries set
    status=case when status='sending' or attempts>=4 then 'manual_review' else 'queued' end,
    claim_token=null,lease_until=null,updated_at=stamp
    where centre='singapore' and status in ('claimed','sending');
  insert into eco_private.administration_events(actor_id,actor_name,action,details)
    values(member.id,member.display_name,'whatsapp-dispatcher-connected',jsonb_build_object('centre','singapore'));
end;
$$;

-- Only the ECO server can use the worker RPC. Each operation independently
-- verifies the active hashed credential and serializes on its own centre.
create function public.eco_whatsapp_dispatch(p_token_hash text,p_action text,p_enquiry uuid default null,p_claim uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  device eco_private.whatsapp_dispatchers;
  job eco_private.whatsapp_deliveries;
  stamp timestamptz;
begin
  if p_action is null or p_action not in ('heartbeat','claim','reserve','sent','review') then
    raise exception 'Invalid dispatcher operation' using errcode='22023';
  end if;
  select d.* into device from eco_private.whatsapp_dispatchers d
  join eco_private.users u on u.id=d.owner_id
  join eco_private.whatsapp_routes r on r.centre=d.centre and r.owner_id=d.owner_id
  where d.token_hash=p_token_hash and d.issued_at>statement_timestamp()-interval '90 days'
    and r.may_connect and u.is_admin and u.is_active and u.activated_at is not null
    and u.deleted_at is null and u.access_hold_request is null
  for update of d;
  if not found then raise exception 'Dispatcher is not connected' using errcode='28000'; end if;
  stamp:=clock_timestamp();
  if p_action in ('heartbeat','claim') then
    if device.last_seen_at is null or device.last_seen_at<stamp-interval '1 minute' then
      update eco_private.whatsapp_dispatchers set last_seen_at=stamp where centre=device.centre;
    end if;
    if p_action='heartbeat' then
      update eco_private.whatsapp_routes set enabled_at=stamp
        where centre=device.centre and owner_id=device.owner_id and may_connect and enabled_at is null;
      return jsonb_build_object('centre',device.centre);
    end if;
    update eco_private.whatsapp_deliveries set
      status=case when status='sending' or attempts>=4 then 'manual_review' else 'queued' end,
      claim_token=null,lease_until=null,updated_at=stamp
      where centre=device.centre and status in ('claimed','sending') and lease_until<=stamp;
    if exists(select 1 from eco_private.whatsapp_deliveries where centre=device.centre and status in ('claimed','sending')) then
      return '{"job":null}'::jsonb;
    end if;
    select j.* into job from eco_private.whatsapp_deliveries j
      where j.centre=device.centre and j.status='queued'
      order by j.updated_at,j.enquiry_id limit 1 for update;
    if not found then return '{"job":null}'::jsonb; end if;
  else
    select * into job from eco_private.whatsapp_deliveries
      where centre=device.centre and enquiry_id=p_enquiry and claim_token=p_claim for update;
    if not found then return '{"accepted":false}'::jsonb; end if;
    if p_action='sent' and job.status='sent' or p_action='review' and job.status='manual_review' then
      return '{"accepted":true}'::jsonb;
    end if;
    if job.status not in ('claimed','sending') or job.lease_until<=stamp then
      return '{"accepted":false}'::jsonb;
    end if;
    if p_action='sent' and job.status='sending' or p_action='review' then
      update eco_private.whatsapp_deliveries set status=case when p_action='sent' then 'sent' else 'manual_review' end,
        lease_until=null,updated_at=stamp where enquiry_id=job.enquiry_id;
      return '{"accepted":true}'::jsonb;
    end if;
    if p_action<>'reserve' or job.status<>'claimed' then return '{"accepted":false}'::jsonb; end if;
  end if;

  perform 1 from eco_private.whatsapp_routes r join eco_private.users u on u.id=r.owner_id
  where r.centre=job.centre and r.owner_id=job.owner_id and r.group_name=job.group_name and r.enabled_at=job.route_enabled_at
    and u.is_active and u.deleted_at is null and u.access_hold_request is null for share of r;
  if not found then
    update eco_private.whatsapp_deliveries set status='manual_review',lease_until=null,updated_at=stamp where enquiry_id=job.enquiry_id;
    if p_action='claim' then return '{"job":null}'::jsonb; end if;
    return '{"accepted":false}'::jsonb;
  end if;
  if p_action='reserve' then
    update eco_private.whatsapp_deliveries set status='sending',lease_until=stamp+interval '45 seconds',updated_at=stamp
      where enquiry_id=job.enquiry_id;
    return jsonb_build_object('accepted',true,'sendWindowMs',10000);
  end if;
  update eco_private.whatsapp_deliveries set status='claimed',attempts=attempts+1,claim_token=gen_random_uuid(),lease_until=stamp+interval '90 seconds',updated_at=stamp
    where enquiry_id=job.enquiry_id returning * into job;
  -- Only facts the buyer reviewed for delivery go to the device.
  return jsonb_build_object('job',(select jsonb_build_object(
    'id',j.id,'claimToken',job.claim_token,'groupName',job.group_name,
    'reference','ECO-'||lpad(j.reference_number::text,greatest(8,length(j.reference_number::text)),'0'),
    'vessel',j.reviewed->'vessel','imo',j.reviewed->'imo','eta',j.reviewed->'eta','products',j.reviewed->'products',
    'rmk',j.reviewed->'rmk','viscosity',j.reviewed->'viscosity')
    from eco_private.commercial_enquiries j where j.id=job.enquiry_id));
end;
$$;

create or replace function eco_private.commercial_summary(r eco_private.commercial_enquiries) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('id',r.id,'reference','ECO-'||lpad(r.reference_number::text,greatest(8,length(r.reference_number::text)),'0'),
    'ownerId',r.owner_id,'ownerName',r.owner_name,'revision',r.revision,'status',r.status,
    'vessel',r.reviewed->'vessel','imo',r.reviewed->'imo','eta',r.reviewed->'eta','products',r.reviewed->'products','port',r.port,
    'queue',(select jsonb_build_object('status',q.status,'queuedAt',q.queued_at)
       ||case when d.enquiry_id is null then '{}'::jsonb else jsonb_build_object('delivery',d.status) end
       from eco_private.commercial_enquiry_queue q left join eco_private.whatsapp_deliveries d using(enquiry_id) where q.enquiry_id=r.id),
    'createdAt',r.created_at,'updatedAt',r.updated_at,'confirmedAt',r.confirmed_at)
    ||coalesce((select jsonb_build_object('fixture',eco_private.fixture_assignment(f))
      from eco_private.fixture_bookings f where f.enquiry_id=r.id and r.owner_id=auth.uid()),'{}'::jsonb);
$$;

revoke all on function eco_private.enqueue_whatsapp_delivery(),public.eco_whatsapp_route(),
  public.eco_connect_whatsapp_dispatcher(text),public.eco_whatsapp_dispatch(text,text,uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.eco_whatsapp_route(),public.eco_connect_whatsapp_dispatcher(text) to authenticated;
grant execute on function public.eco_whatsapp_dispatch(text,text,uuid,uuid) to service_role;
insert into eco_private.platform_versions(component,migration_head) values('whatsapp-dispatch','20261126025726');
