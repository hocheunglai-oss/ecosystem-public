-- Preserve the original receipt and review history while making the working text editable.
alter table eco_private.commercial_enquiries
  add column working_text text check(octet_length(working_text) <= 20000),
  add column disposition text not null default 'open' check(disposition in ('open','postponed','cancelled','lost')),
  add column lost_reason text,
  add check ((disposition='lost') = (lost_reason is not null));
alter table eco_private.commercial_enquiry_history drop constraint commercial_enquiry_history_action_check,
  add check(action in ('save','confirm','amend','reoffer','postpone','cancel','lost'));

alter table eco_private.whatsapp_deliveries drop constraint whatsapp_deliveries_status_check,
  add check(status in ('queued','claimed','sending','sent','manual_review','withdrawn')),
  add column event text not null default 'created' check(event in ('created','amend','reoffer'));

create or replace function eco_private.commercial_immutable() returns trigger language plpgsql set search_path='' as $$
begin
  if old.id<>new.id or old.owner_id<>new.owner_id or old.owner_name<>new.owner_name
    or old.source<>new.source or old.inbox_id is distinct from new.inbox_id
    or old.created_at<>new.created_at or old.reference_number<>new.reference_number
    or old.status='confirmed' and (old.status<>new.status or old.confirmed_at is distinct from new.confirmed_at
      or new.revision<>old.revision+1)
    or old.disposition in ('lost','cancelled') then
    raise exception 'Enquiry source or closed record is immutable' using errcode='PT409';
  end if;
  return new;
end;
$$;

create function eco_private.require_open_enquiry_for_stem() returns trigger language plpgsql set search_path='' as $$
begin
  if new.enquiry_id is not null then
    perform 1 from eco_private.commercial_enquiries
      where id=new.enquiry_id and status='confirmed' and disposition='open' for update;
    if not found then raise exception 'Enquiry is no longer open' using errcode='PT409'; end if;
  end if;
  return new;
end;
$$;
revoke all on function eco_private.require_open_enquiry_for_stem() from public,anon,authenticated,service_role;
create trigger require_open_enquiry_for_stem before insert on eco_private.fixture_bookings
  for each row execute function eco_private.require_open_enquiry_for_stem();

-- The delivery row is the current job. Transition history retains the prior delivery outcome.
create or replace function public.eco_mutate_commercial_enquiry(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  actor eco_private.users;
  row eco_private.commercial_enquiries;
  prior eco_private.commercial_enquiry_mutations;
  delivery eco_private.whatsapp_deliveries;
  eid uuid;
  rid uuid;
  expected integer;
  inbox uuid;
  action text;
  edits boolean;
  working text;
  v_port jsonb;
  previous_review jsonb;
  next_disposition text;
  result jsonb;
  details jsonb;
begin
  actor:=eco_private.admin_writable_member();
  perform eco_private.inbox_live(p_input);
  eid:=eco_private.inbox_uuid(p_input,'id');
  rid:=eco_private.inbox_uuid(p_input,'requestId');
  action:=p_input->>'action';
  if jsonb_typeof(p_input->'action') is distinct from 'string'
    or action not in ('save','confirm','amend','reoffer','postpone','cancel','lost')
    or jsonb_typeof(p_input->'expectedRevision') is distinct from 'number'
    or p_input->>'expectedRevision' !~ '^(0|[1-9][0-9]{0,9})$'
    or (p_input->>'expectedRevision')::numeric>2147483646
    or octet_length(p_input::text)>131072 then
    raise exception 'Invalid enquiry operation' using errcode='22023';
  end if;
  expected:=(p_input->>'expectedRevision')::integer;
  edits:=action in ('save','confirm','amend','reoffer');
  if edits then
    if p_input ? 'workingText' then working:=eco_private.commercial_text(p_input,'workingText',20000);end if;
    v_port:=eco_private.commercial_validate((p_input-'workingText')
      ||jsonb_build_object('action',case when action='save' then 'save' else 'confirm' end));
  elsif action='lost' then
    perform eco_private.commercial_keys(p_input,array['dataMode','id','requestId','expectedRevision','action','lostReason']);
    if eco_private.commercial_text(p_input,'lostReason',160,1) not in (
      'MINIMUM MARGIN','CREDIT OR PAYMENT TERMS','COVERAGE (SUPPLIER NOT COVERED)',
      'COVERAGE (LIMITED BY CUSTOMER)','NOT TIMELY OFFERED','DOUBLE TRADING','T&C','UNKNOWN') then
      raise exception 'Choose a buyer lost reason' using errcode='22023';
    end if;
  else
    perform eco_private.commercial_keys(p_input,array['dataMode','id','requestId','expectedRevision','action']);
  end if;
  select * into prior from eco_private.commercial_enquiry_mutations where actor_id=actor.id and request_id=rid;
  if found then
    if prior.input<>p_input then raise exception 'Request payload conflict' using errcode='PT409';end if;
    return prior.result;
  end if;

  select * into row from eco_private.commercial_enquiries where id=eid for update;
  if found then
    if row.owner_id<>actor.id then raise exception 'Record not found' using errcode='PT404';end if;
    if row.revision<>expected or row.disposition in ('lost','cancelled') then
      raise exception 'Enquiry revision conflict' using errcode='PT409';
    end if;
    if edits and row.source<>p_input->'source' then
      raise exception 'Original enquiry source cannot change' using errcode='PT409';
    end if;
    previous_review:=row.reviewed;
    next_disposition:=row.disposition;
    if action in ('save','confirm') then
      if row.status<>'draft' then raise exception 'Enquiry revision conflict' using errcode='PT409';end if;
    else
      if action<>'cancel' and (row.status<>'confirmed' or row.port->>'countryCode' is distinct from 'SG')
        or action in ('amend','lost','postpone') and row.disposition<>'open'
        or action='reoffer' and row.disposition<>'postponed'
        or exists(select 1 from eco_private.fixture_bookings where enquiry_id=row.id) then
        raise exception 'This enquiry action is no longer available' using errcode='PT409';
      end if;
      if action in ('amend','reoffer') and v_port->>'countryCode' is distinct from 'SG' then
        raise exception 'Choose Singapore for an SPC enquiry' using errcode='22023';
      end if;
      select * into delivery from eco_private.whatsapp_deliveries where enquiry_id=row.id for update;
      if delivery.status='sending' then
        raise exception 'Wait for the WhatsApp delivery to finish' using errcode='PT409';
      end if;
      if action in ('amend','reoffer') then
        if delivery.status='manual_review' then
          raise exception 'Review the previous WhatsApp delivery before sending again' using errcode='PT409';
        end if;
        if action='amend' and previous_review=p_input->'reviewed'
          and coalesce(working,row.working_text,row.source->>'rawText')=coalesce(row.working_text,row.source->>'rawText') then
          raise exception 'Change the enquiry before sending an amendment' using errcode='22023';
        end if;
        update eco_private.whatsapp_deliveries set
          event=case when status='sent' or event<>'created' then action else 'created' end,
          status='queued',attempts=0,claim_token=null,lease_until=null,updated_at=clock_timestamp()
          where enquiry_id=row.id;
        next_disposition:='open';
      else
        next_disposition:=case action when 'cancel' then 'cancelled' when 'postpone' then 'postponed' else 'lost' end;
        update eco_private.whatsapp_deliveries set status='withdrawn',claim_token=null,lease_until=null,updated_at=clock_timestamp()
          where enquiry_id=row.id and status in ('queued','claimed');
      end if;
    end if;

    update eco_private.commercial_enquiries set
      reviewed=case when edits then p_input->'reviewed' else reviewed end,
      port=case when edits then v_port else port end,
      working_text=coalesce(working,working_text), revision=revision+1,
      status=case when action='confirm' then 'confirmed' else status end,
      updated_at=clock_timestamp(), confirmed_at=case when action='confirm' then clock_timestamp() else confirmed_at end,
      disposition=next_disposition, lost_reason=case when action='lost' then p_input->>'lostReason' end
      where id=eid returning * into row;
  else
    if expected<>0 or action not in ('save','confirm') then
      raise exception 'Enquiry revision conflict' using errcode='PT409';
    end if;
    inbox:=(p_input#>>'{source,inboxId}')::uuid;
    if inbox is not null then
      if not exists(select 1 from eco_private.inbox_messages where id=inbox and owner_id=actor.id and status='accepted'
        and raw_text=p_input#>>'{source,rawText}') then
        raise exception 'Owned inbox source required' using errcode='42501';
      end if;
      if exists(select 1 from eco_private.commercial_enquiries where inbox_id=inbox) then
        raise exception 'Inbox enquiry already exists' using errcode='PT409';
      end if;
    end if;
    insert into eco_private.commercial_enquiries(id,owner_id,owner_name,revision,status,source,reviewed,inbox_id,port,working_text,confirmed_at)
      values(eid,actor.id,actor.display_name,1,case when action='confirm' then 'confirmed' else 'draft' end,
        p_input->'source',p_input->'reviewed',inbox,v_port,working,case when action='confirm' then clock_timestamp() end)
      returning * into row;
  end if;
  if action='confirm' and row.port->>'countryCode'='SG' then
    insert into eco_private.commercial_enquiry_queue(enquiry_id,centre,queued_by) values(row.id,'singapore',actor.id);
  end if;

  details:=jsonb_build_object('revision',row.revision,'status',row.status,'portId',row.port->'id',
    'queued',row.status='confirmed' and coalesce(row.port->>'countryCode'='SG',false))||
    case when action in ('save','confirm') then '{}'::jsonb else jsonb_strip_nulls(jsonb_build_object(
      'outcome',row.disposition,'lostReason',row.lost_reason,'previousDelivery',delivery.status,'previousEvent',delivery.event)) end;
  insert into eco_private.commercial_enquiry_history(enquiry_id,actor_id,session_id,revision,action,details)
    values(row.id,actor.id,(auth.jwt()->>'session_id')::uuid,row.revision,action,details||
      case when action in ('amend','reoffer') then jsonb_build_object('previousReview',previous_review) else '{}'::jsonb end);
  insert into eco_private.administration_events(actor_id,actor_name,target_id,action,details)
    values(actor.id,actor.display_name,row.id,case action when 'save' then 'commercial-enquiry-saved'
      when 'confirm' then 'commercial-enquiry-confirmed' else 'commercial-enquiry-'||action end,details-'lostReason');
  result:=jsonb_build_object('requestId',rid,'item',eco_private.commercial_detail(row));
  insert into eco_private.commercial_enquiry_mutations(actor_id,request_id,enquiry_id,input,result) values(actor.id,rid,row.id,p_input,result);
  return result;
end;
$$;

create or replace function public.eco_whatsapp_dispatch(p_token_hash text,p_action text,p_enquiry uuid default null,p_claim uuid default null)
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
    'rmk',j.reviewed->'rmk','viscosity',j.reviewed->'viscosity','event',job.event,
    'specialTerms',(select coalesce(jsonb_agg(option),'[]'::jsonb)
      from unnest(array['COQ REQUIRED','30D QUALITY TIME BAR','BIMCO TERMS']) as option
      where exists(select 1 from regexp_split_to_table(upper(j.reviewed->>'remarks'),'[/\n]') as remark
        where trim(remark)=option)))
    from eco_private.commercial_enquiries j where j.id=job.enquiry_id));
end;
$$;

create or replace function eco_private.commercial_summary(r eco_private.commercial_enquiries) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('id',r.id,'reference','ECO-'||lpad(r.reference_number::text,greatest(8,length(r.reference_number::text)),'0'),
    'ownerId',r.owner_id,'ownerName',r.owner_name,'revision',r.revision,'status',r.status,
    'vessel',r.reviewed->'vessel','imo',r.reviewed->'imo','eta',r.reviewed->'eta','products',r.reviewed->'products','port',r.port,
    'queue',(select jsonb_build_object('status',q.status,'queuedAt',q.queued_at)
       ||case when d.enquiry_id is null or d.status='withdrawn' then '{}'::jsonb else jsonb_build_object('delivery',d.status) end
       from eco_private.commercial_enquiry_queue q left join eco_private.whatsapp_deliveries d using(enquiry_id) where q.enquiry_id=r.id),
    'createdAt',r.created_at,'updatedAt',r.updated_at,'confirmedAt',r.confirmed_at)
    ||coalesce((select jsonb_build_object('fixture',eco_private.fixture_assignment(f))
      from eco_private.fixture_bookings f where f.enquiry_id=r.id and r.owner_id=auth.uid()),'{}'::jsonb)
    ||case when r.disposition='open' then '{}'::jsonb else jsonb_strip_nulls(jsonb_build_object('outcome',r.disposition,'lostReason',r.lost_reason)) end;
$$;

create or replace function eco_private.commercial_detail(r eco_private.commercial_enquiries) returns jsonb language sql stable set search_path='' as $$
 select eco_private.commercial_summary(r)||jsonb_build_object('source',r.source,'reviewed',r.reviewed)||jsonb_strip_nulls(jsonb_build_object('workingText',r.working_text));
$$;

create or replace function public.eco_get_commercial_enquiries(p_query jsonb) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor eco_private.users;row eco_private.commercial_enquiries;eid uuid;inbox uuid;n integer:=25;scope text;ct timestamptz;cid uuid;c text;items jsonb;next_cursor text;
begin
 actor:=eco_private.current_member();perform eco_private.inbox_live(p_query);
 if exists(select 1 from eco_private.role_previews where user_id=actor.id and session_id::text=auth.jwt()->>'session_id') then raise exception 'Preview is read only' using errcode='42501';end if;
 perform eco_private.admin_check_keys(p_query,array['dataMode','id','inboxId','scope','limit','cursor']);
 if p_query ? 'id' or p_query ? 'inboxId' then
  if (select count(*) from jsonb_object_keys(p_query))<>2 then raise exception 'Invalid enquiry query' using errcode='22023';end if;
  if p_query ? 'id' then
   eid:=eco_private.inbox_uuid(p_query,'id');select * into row from eco_private.commercial_enquiries where id=eid and owner_id=actor.id;
   if not found then raise exception 'Record not found' using errcode='PT404';end if;
  else
   inbox:=eco_private.inbox_uuid(p_query,'inboxId');
   if not exists(select 1 from eco_private.inbox_messages where id=inbox and owner_id=actor.id and status='accepted') then raise exception 'Record not found' using errcode='PT404';end if;
   select * into row from eco_private.commercial_enquiries where inbox_id=inbox and owner_id=actor.id;
   if not found then return jsonb_build_object('item',null);end if;
  end if;
  return jsonb_build_object('item',eco_private.commercial_detail(row));
 end if;
 scope:=coalesce(p_query->>'scope','mine');
 if scope not in ('mine','singapore','workbench','lost') then raise exception 'Invalid scope' using errcode='22023';end if;
 if scope='singapore' and not(actor.is_admin or actor.is_spc_trader) then raise exception 'Forbidden' using errcode='42501';end if;
 if p_query ? 'limit' then
  if jsonb_typeof(p_query->'limit') is distinct from 'number' or p_query->>'limit' !~ '^[1-9][0-9]?$' then raise exception 'Invalid limit' using errcode='22023';end if;
  n:=(p_query->>'limit')::integer;if n>50 then raise exception 'Invalid limit' using errcode='22023';end if;
 end if;
 if p_query ? 'cursor' then
  c:=eco_private.inbox_text(p_query,'cursor',1,100);
  if c !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9:.+Z-]+\|[0-9a-f-]{36}$' then raise exception 'Invalid cursor' using errcode='22023';end if;
  begin ct:=split_part(c,'|',1)::timestamptz;cid:=split_part(c,'|',2)::uuid;exception when invalid_datetime_format or datetime_field_overflow or invalid_text_representation then raise exception 'Invalid cursor' using errcode='22023';end;
  if not isfinite(ct) then raise exception 'Invalid cursor' using errcode='22023';end if;
 end if;
 with candidates as materialized (
  select r.* from eco_private.commercial_enquiries r where
   ((scope in ('mine','workbench') and r.owner_id=actor.id and r.disposition in ('open','postponed'))
     or (scope in ('singapore','workbench') and (actor.is_admin or actor.is_spc_trader)
       and r.disposition in ('open','postponed') and exists(select 1 from eco_private.commercial_enquiry_queue q where q.enquiry_id=r.id))
     or (scope='lost' and r.disposition='lost' and (r.owner_id=actor.id
       or (actor.is_admin or actor.is_spc_trader) and r.port->>'countryCode'='SG')))
   and (ct is null or (r.created_at,r.id)<(ct,cid)) order by r.created_at desc,r.id desc limit n+1
 ), page as (select * from candidates order by created_at desc,id desc limit n)
 select (select coalesce(jsonb_agg(eco_private.commercial_summary(p) order by p.created_at desc,p.id desc),'[]'::jsonb) from page p),
  case when (select count(*) from candidates)>n then (select created_at::text||'|'||id::text from page order by created_at,id limit 1) end into items,next_cursor;
 return jsonb_build_object('items',items,'nextCursor',next_cursor);
end;$$;

create or replace function eco_private.inbox_item(p_row eco_private.inbox_messages) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_strip_nulls(jsonb_build_object('id',p_row.id,'providerMessageId',p_row.provider_message_id,'channel',p_row.channel,'sender',p_row.sender_display,'owner',p_row.owner_id,'rawText',p_row.raw_text,'subject',p_row.subject,'receivedAt',p_row.received_at,'read',p_row.read_at is not null,'dismissed',p_row.dismissed_at is not null,
   'enquiryId',(select r.id from eco_private.commercial_enquiries r where r.inbox_id=p_row.id and r.owner_id=p_row.owner_id)));
$$;

update eco_private.platform_versions set migration_head='20261126084045' where component in ('commercial-enquiries','whatsapp-dispatch');
