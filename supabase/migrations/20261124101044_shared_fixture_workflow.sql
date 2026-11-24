create table eco_private.fixture_bookings (
  id uuid primary key default gen_random_uuid(),
  enquiry_id uuid not null unique references eco_private.commercial_enquiries(id),
  buyer_trader_id uuid not null references eco_private.users(id),
  supplier_trader_id uuid not null references eco_private.users(id),
  buyer_office text not null,
  supplier_office text not null,
  fixture_date date not null,
  eta date not null,
  eta_end date,
  eta_kind text not null check (eta_kind in ('date','range','earliest')),
  eta_reviewed boolean not null,
  revision integer not null default 1 check (revision > 0),
  confirmed_at timestamptz,
  confirmed_by uuid references eco_private.users(id),
  check ((eta_kind='range' and eta_end > eta and eta_end is not null)
      or (eta_kind in ('date','earliest') and eta_end is null)),
  check (eta >= fixture_date or eta_reviewed),
  check ((confirmed_at is null and confirmed_by is null)
      or (confirmed_at is not null and confirmed_by is not null and confirmed_by=supplier_trader_id))
);
create index eco_fixture_booking_date on eco_private.fixture_bookings(fixture_date desc, id desc);
create index eco_fixture_booking_buyer on eco_private.fixture_bookings(buyer_trader_id, fixture_date desc, id desc);
create index eco_fixture_booking_supplier on eco_private.fixture_bookings(supplier_trader_id, fixture_date desc, id desc);

create table eco_private.fixture_supply_lines (
  fixture_id uuid not null references eco_private.fixture_bookings(id),
  line_number integer not null check (line_number between 1 and 30),
  grade text not null check (grade in ('HSFO','VLSFO','LSMGO')),
  supplier_id uuid not null references eco_private.suppliers(id),
  account_id text not null references eco_private.offices(id) check (account_id<>'CREDIT'),
  account_name text not null,
  quantity numeric not null check (quantity > 0 and quantity <= 1000000),
  buy_price numeric not null check (buy_price > 0 and buy_price <= 1000000),
  primary key (fixture_id, line_number)
);
create index eco_fixture_supply_supplier on eco_private.fixture_supply_lines(supplier_id);
alter table eco_private.fixture_bookings enable row level security;
alter table eco_private.fixture_supply_lines enable row level security;
revoke all on eco_private.fixture_bookings, eco_private.fixture_supply_lines
  from public, anon, authenticated, service_role;

-- Values outside this review band may be legitimate and require explicit confirmation.
create function eco_private.fixture_quantity_review() returns jsonb
language sql immutable set search_path='' as $$
  select '{"HSFO":{"min":75,"max":6000},"VLSFO":{"min":70,"max":3500},"LSMGO":{"min":15,"max":1000}}'::jsonb;
$$;

create function eco_private.fixture_assignment(p eco_private.fixture_bookings) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('id',p.id,'revision',p.revision,
    'status',case when p.confirmed_at is null then 'pending' else 'confirmed' end,
    'supplierTraderId',p.supplier_trader_id,'supplierTrader',u.display_name,
    'date',p.fixture_date,'eta',p.eta,'etaEnd',p.eta_end,'etaKind',p.eta_kind,'etaReviewed',p.eta_reviewed)
  from eco_private.users u where u.id=p.supplier_trader_id;
$$;

create function eco_private.fixture_details(p eco_private.fixture_bookings, p_actor eco_private.users) returns jsonb
language sql stable set search_path='' as $$
  select eco_private.fixture_assignment(p)||jsonb_build_object(
    'vessel',e.reviewed->>'vessel','imo',e.reviewed->>'imo','buyerTrader',b.display_name,
    'reference','ECO-'||lpad(e.reference_number::text,greatest(8,length(e.reference_number::text)),'0'),
    'confirmedAt',p.confirmed_at,
    'canConfirm',p.confirmed_at is null and p_actor.id=p.supplier_trader_id and p_actor.is_spc_trader,
    'requested',e.reviewed->'products',
    'lines',coalesce((
      select jsonb_agg(jsonb_build_object('grade',l.grade,'quantity',l.quantity,'supplierId',l.supplier_id,
        'supplier',s.short_name,'supplierAvailable',s.archived_at is null,'accountId',l.account_id,'account',l.account_name,'buyPrice',l.buy_price) order by l.line_number)
      from eco_private.fixture_supply_lines l join eco_private.suppliers s on s.id=l.supplier_id where l.fixture_id=p.id
    ),'[]'::jsonb))
  from eco_private.commercial_enquiries e join eco_private.users b on b.id=p.buyer_trader_id where e.id=p.enquiry_id;
$$;

create function public.eco_get_fixtures(p_query jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor eco_private.users; booking eco_private.fixture_bookings;
begin
  actor:=eco_private.current_member();
  perform eco_private.inbox_live(p_query);
  perform eco_private.assert_preview_writable(actor.id,(auth.jwt()->>'session_id')::uuid);
  perform eco_private.admin_check_keys(p_query,array['dataMode','options','id']);
  if p_query->'options'='true'::jsonb and not (p_query ? 'id') then
    return jsonb_build_object(
      'traders',coalesce((select jsonb_agg(jsonb_build_object('id',u.id,'name',u.display_name,'office',o.name) order by u.display_name,u.id)
        from eco_private.users u join eco_private.offices o on o.id=u.office_id
        where u.is_spc_trader and u.is_active and u.activated_at is not null and u.deleted_at is null and u.access_hold_request is null),'[]'::jsonb),
      'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'name',o.name) order by o.name)
        from eco_private.offices o where o.id<>'CREDIT'),'[]'::jsonb),
      'quantityReview',eco_private.fixture_quantity_review());
  end if;
  if p_query ? 'options' then raise exception 'Invalid fixture query' using errcode='22023'; end if;
  select * into booking from eco_private.fixture_bookings where id=eco_private.inbox_uuid(p_query,'id');
  if not found or not (actor.is_admin or actor.id in (booking.buyer_trader_id,booking.supplier_trader_id)
      or (booking.confirmed_at is not null and actor.is_spc_trader)) then
    raise exception 'Fixture not found' using errcode='PT404';
  end if;
  return eco_private.fixture_details(booking,actor);
end;
$$;

create function public.eco_mutate_fixture(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  actor eco_private.users; enquiry eco_private.commercial_enquiries; booking eco_private.fixture_bookings;
  trader eco_private.users; eta_mode text; booked date; eta_start date; eta_finish date;
  operation text; expected integer; previous jsonb; line jsonb; supplier_id uuid;
  n integer:=0; quantity numeric; price numeric; grade text; office_account text; review_band jsonb; answer jsonb;
begin
  actor:=eco_private.admin_writable_member();
  perform eco_private.inbox_live(p_input);
  if octet_length(p_input::text)>65536 then raise exception 'Invalid fixture request' using errcode='22023'; end if;
  operation:=p_input->>'action';
  if operation is null or operation not in ('assign','confirm')
      or jsonb_typeof(p_input->'expectedRevision') is distinct from 'number'
      or (p_input->>'expectedRevision') !~ '^[0-9]{1,10}$'
      or (p_input->>'expectedRevision')::numeric>2147483646 then
    raise exception 'Invalid fixture request' using errcode='22023';
  end if;
  expected:=(p_input->>'expectedRevision')::integer;
  if operation='assign' then
    perform eco_private.admin_check_keys(p_input,array['action','dataMode','requestId','expectedRevision','enquiryId',
      'supplierTraderId','date','eta','etaEnd','etaKind','etaReviewed']);
    select * into enquiry from eco_private.commercial_enquiries where id=eco_private.inbox_uuid(p_input,'enquiryId') for update;
    if not found or enquiry.owner_id<>actor.id then raise exception 'Enquiry not found' using errcode='PT404'; end if;
    if enquiry.status<>'confirmed' or enquiry.port->>'countryCode' is distinct from 'SG' then
      raise exception 'Confirm the Singapore enquiry first' using errcode='PT409';
    end if;
    previous:=eco_private.admin_request(actor.id,p_input,'fixture-assign');
    if previous is not null then return previous; end if;
    select * into booking from eco_private.fixture_bookings where enquiry_id=enquiry.id for update;
    if coalesce(booking.revision,0)<>expected or booking.confirmed_at is not null then
      raise exception 'Fixture revision conflict' using errcode='PT409';
    end if;
    select * into trader from eco_private.users where id=eco_private.inbox_uuid(p_input,'supplierTraderId')
      and office_id is not null and is_active and is_spc_trader and activated_at is not null and deleted_at is null and access_hold_request is null;
    if not found then raise exception 'Select an active SPC supplier trader' using errcode='PT422'; end if;
    perform eco_private.admin_check_text(p_input,'date',10,10);
    perform eco_private.admin_check_text(p_input,'eta',10,10);
    eta_mode:=p_input->>'etaKind';
    if p_input->>'date' !~ '^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$' or p_input->>'eta' !~ '^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$'
      or eta_mode is null or eta_mode not in ('date','range','earliest')
      or jsonb_typeof(p_input->'etaReviewed') is distinct from 'boolean' then
      raise exception 'Invalid fixture date or ETA' using errcode='22023';
    end if;
    booked:=(p_input->>'date')::date; eta_start:=(p_input->>'eta')::date;
    if eta_mode='range' then
      perform eco_private.admin_check_text(p_input,'etaEnd',10,10);
      if p_input->>'etaEnd' !~ '^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$' then raise exception 'Invalid ETA end' using errcode='22023'; end if;
      eta_finish:=(p_input->>'etaEnd')::date;
      if eta_finish<=eta_start then raise exception 'Invalid ETA range' using errcode='22023'; end if;
    elsif p_input->'etaEnd' is distinct from 'null'::jsonb then
      raise exception 'Invalid ETA end' using errcode='22023';
    end if;
    if eta_start<booked and (p_input->>'etaReviewed')::boolean is not true then
      raise exception 'Review the ETA before the fixture date' using errcode='PT422';
    end if;
    if booking.id is null then
      insert into eco_private.fixture_bookings(enquiry_id,buyer_trader_id,supplier_trader_id,buyer_office,supplier_office,
        fixture_date,eta,eta_end,eta_kind,eta_reviewed)
      values(enquiry.id,actor.id,trader.id,coalesce((select o.name from eco_private.offices o where o.id=actor.office_id),''),
        (select o.name from eco_private.offices o where o.id=trader.office_id),booked,eta_start,eta_finish,eta_mode,(p_input->>'etaReviewed')::boolean)
      returning * into booking;
    else
      update eco_private.fixture_bookings b set supplier_trader_id=trader.id,
        supplier_office=case when b.supplier_trader_id=trader.id then b.supplier_office else (select o.name from eco_private.offices o where o.id=trader.office_id) end,
        fixture_date=booked,eta=eta_start,eta_end=eta_finish,eta_kind=eta_mode,eta_reviewed=(p_input->>'etaReviewed')::boolean,
        revision=b.revision+1 where b.id=booking.id returning * into booking;
    end if;
  else
    perform eco_private.admin_check_keys(p_input,array['action','dataMode','requestId','expectedRevision','id','lines','quantityReviewed']);
    select * into booking from eco_private.fixture_bookings where id=eco_private.inbox_uuid(p_input,'id') for update;
    if not found or booking.supplier_trader_id<>actor.id or not actor.is_spc_trader then
      raise exception 'Assigned SPC supplier trader required' using errcode='42501';
    end if;
    previous:=eco_private.admin_request(actor.id,p_input,'fixture-confirm');
    if previous is not null then return previous; end if;
    if booking.revision<>expected or booking.confirmed_at is not null then raise exception 'Fixture revision conflict' using errcode='PT409'; end if;
    if jsonb_typeof(p_input->'lines') is distinct from 'array' or jsonb_typeof(p_input->'quantityReviewed') is distinct from 'boolean' then
      raise exception 'Invalid fixture supply lines' using errcode='22023';
    end if;
    if jsonb_array_length(p_input->'lines') not between 1 and 30 then raise exception 'Invalid fixture supply lines' using errcode='22023'; end if;
    if exists(select 1 from jsonb_array_elements(p_input->'lines') x group by x having count(*)>1) then
      raise exception 'Review duplicate supply lines' using errcode='PT422';
    end if;
    for line in select value from jsonb_array_elements(p_input->'lines') loop
      perform eco_private.admin_check_keys(line,array['grade','quantity','supplierId','accountId','buyPrice']);
      grade:=line->>'grade';
      supplier_id:=eco_private.inbox_uuid(line,'supplierId');
      if grade is null or grade not in ('HSFO','VLSFO','LSMGO')
          or jsonb_typeof(line->'quantity') is distinct from 'number' or jsonb_typeof(line->'buyPrice') is distinct from 'number' then
        raise exception 'Enter the agreed quantity and buy price' using errcode='PT422';
      end if;
      quantity:=(line->>'quantity')::numeric; price:=(line->>'buyPrice')::numeric;
      if quantity<=0 or quantity>1000000 or price<=0 or price>1000000 then
        raise exception 'Enter the agreed quantity and buy price' using errcode='PT422';
      end if;
      review_band:=eco_private.fixture_quantity_review()->grade;
      if (quantity<(review_band->>'min')::numeric or quantity>(review_band->>'max')::numeric)
          and (p_input->>'quantityReviewed')::boolean is not true then
        raise exception 'Review unusually high or low quantities' using errcode='PT422';
      end if;
      perform s.id from eco_private.suppliers s where s.id=supplier_id and s.country_code='SG'
        and s.archived_at is null and s.closed_at is null for share;
      if not found then raise exception 'Select an active Singapore supplier' using errcode='PT422'; end if;
      select o.name into office_account from eco_private.offices o where o.id=line->>'accountId' and o.id<>'CREDIT' for share;
      if not found then raise exception 'Select an office account' using errcode='PT422'; end if;
      n:=n+1;
      insert into eco_private.fixture_supply_lines(fixture_id,line_number,grade,supplier_id,account_id,account_name,quantity,buy_price)
        values(booking.id,n,grade,supplier_id,line->>'accountId',office_account,quantity,price);
    end loop;
    update eco_private.fixture_bookings set confirmed_at=clock_timestamp(),confirmed_by=actor.id,revision=revision+1
      where id=booking.id returning * into booking;
  end if;
  insert into eco_private.administration_events(actor_id,actor_name,target_id,action,details)
    values(actor.id,actor.display_name,booking.id,'fixture-'||operation,jsonb_build_object(
      'revision',booking.revision,'supplierTraderId',booking.supplier_trader_id,'enquiryId',booking.enquiry_id,
      'quantityReviewed',p_input->'quantityReviewed','etaReviewed',booking.eta_reviewed));
  answer:=case when operation='assign' then eco_private.fixture_assignment(booking) else eco_private.fixture_details(booking,actor) end;
  return eco_private.admin_finish(actor.id,p_input,answer);
end;
$$;

create or replace function eco_private.commercial_summary(r eco_private.commercial_enquiries) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('id',r.id,'reference','ECO-'||lpad(r.reference_number::text,greatest(8,length(r.reference_number::text)),'0'),'ownerId',r.owner_id,'ownerName',r.owner_name,'revision',r.revision,'status',r.status,
    'vessel',r.reviewed->'vessel','imo',r.reviewed->'imo','eta',r.reviewed->'eta','products',r.reviewed->'products','port',r.port,
    'queue',(select jsonb_build_object('status',q.status,'queuedAt',q.queued_at) from eco_private.commercial_enquiry_queue q where q.enquiry_id=r.id),
    'createdAt',r.created_at,'updatedAt',r.updated_at,'confirmedAt',r.confirmed_at)
    ||coalesce((select jsonb_build_object('fixture',eco_private.fixture_assignment(f))
      from eco_private.fixture_bookings f where f.enquiry_id=r.id and r.owner_id=auth.uid()),'{}'::jsonb);
$$;

revoke all on function eco_private.fixture_quantity_review(), eco_private.fixture_assignment(eco_private.fixture_bookings),
  eco_private.fixture_details(eco_private.fixture_bookings,eco_private.users) from public, anon, authenticated, service_role;
revoke all on function public.eco_get_fixtures(jsonb), public.eco_mutate_fixture(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.eco_get_fixtures(jsonb), public.eco_mutate_fixture(jsonb) to authenticated;

create or replace function public.eco_list_fixture_history(
  p_year integer, p_month integer, p_search text, p_page integer
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare member eco_private.users; terms text[]; result jsonb;
begin
  member:=eco_private.current_member();
  if exists (select 1 from eco_private.role_previews where user_id=member.id and session_id::text=auth.jwt()->>'session_id') then
    raise exception 'Shared fixtures are unavailable in preview' using errcode='42501';
  end if;
  if p_year is null or (p_year<>0 and p_year not between 2025 and 2099)
      or p_month is null or p_month not between 0 and 12
      or p_search is null or length(p_search)>120 or p_page is null or p_page not between 0 and 200 then
    raise exception 'Invalid fixture filters' using errcode='22023';
  end if;
  terms:=regexp_split_to_array(lower(trim(p_search)), '[[:space:]]+');
  with rows as (
    select f.id, f.fixture_date, false as pending,
      concat_ws(' ',f.vessel,f.imo,st.display_name,bt.display_name,f.account,s.short_name,s.legal_name,
        f.source_labels->>'supplier',f.source_labels->>'supplierTrader',f.source_labels->>'buyerTrader') as search_text,
      jsonb_build_object('id',f.id,'date',f.fixture_date,'supplierTrader',st.display_name,'supplierOffice',f.source_labels->>'supplierOffice',
        'buyerTrader',bt.display_name,'buyerOffice',f.source_labels->>'buyerOffice','account',f.account,'eta',f.eta,'vessel',f.vessel,
        'imo',f.imo,'hsfo',f.hsfo,'vlsfo',f.vlsfo,'lsmgo',f.lsmgo,'supplierId',s.id,'supplier',s.short_name,
        'supplierAvailable',s.archived_at is null,'price',f.price,'barging',f.barging) as item
    from eco_private.fixture_history f
    join eco_private.users st on st.id=f.supplier_trader_id join eco_private.users bt on bt.id=f.buyer_trader_id
    join eco_private.suppliers s on s.id=f.supplier_id
    where member.is_admin or member.is_spc_trader or member.id in (f.buyer_trader_id,f.supplier_trader_id)
    union all
    select b.id, b.fixture_date, b.confirmed_at is null as pending,
      concat_ws(' ',e.reviewed->>'vessel',e.reviewed->>'imo',st.display_name,bt.display_name,lines.search_text) as search_text,
      jsonb_build_object('id',b.id,'date',b.fixture_date,
        'status',case when b.confirmed_at is null then 'pending' else 'confirmed' end,
        'supplierTrader',st.display_name,'supplierOffice',b.supplier_office,
        'buyerTrader',bt.display_name,'buyerOffice',b.buyer_office,'eta',b.eta,'etaEnd',b.eta_end,'etaKind',b.eta_kind,
        'vessel',e.reviewed->>'vessel','imo',nullif(e.reviewed->>'imo',''),
        'hsfo',case when b.confirmed_at is null then requested.hsfo else lines.hsfo end,
        'vlsfo',case when b.confirmed_at is null then requested.vlsfo else lines.vlsfo end,
        'lsmgo',case when b.confirmed_at is null then requested.lsmgo else lines.lsmgo end,
        'account',null,'price',null,'barging',null,'supplierId','','supplier','','supplierAvailable',false)
    from eco_private.fixture_bookings b join eco_private.commercial_enquiries e on e.id=b.enquiry_id
    join eco_private.users st on st.id=b.supplier_trader_id join eco_private.users bt on bt.id=b.buyer_trader_id
    left join lateral (
      select trim_scale(sum(l.quantity) filter(where l.grade='HSFO'))::text as hsfo,
        trim_scale(sum(l.quantity) filter(where l.grade='VLSFO'))::text as vlsfo,
        trim_scale(sum(l.quantity) filter(where l.grade='LSMGO'))::text as lsmgo,
        string_agg(concat_ws(' ',s.short_name,s.legal_name,l.account_name),' ') as search_text
      from eco_private.fixture_supply_lines l join eco_private.suppliers s on s.id=l.supplier_id where l.fixture_id=b.id
    ) lines on b.confirmed_at is not null
    left join lateral (
      select max(x->>'quantityText') filter(where x->>'grade'='HSFO') as hsfo,
        max(x->>'quantityText') filter(where x->>'grade'='VLSFO') as vlsfo,
        max(x->>'quantityText') filter(where x->>'grade'='LSMGO') as lsmgo
      from jsonb_array_elements(e.reviewed->'products') x
    ) requested on b.confirmed_at is null
    where member.is_admin or member.id in (b.buyer_trader_id,b.supplier_trader_id)
      or (b.confirmed_at is not null and member.is_spc_trader)
  ), matches as materialized (
    select id,fixture_date,pending,item from rows r
    where (p_year=0 or extract(year from r.fixture_date)=p_year)
      and (p_month=0 or extract(month from r.fixture_date)=p_month)
      and not exists(select 1 from unnest(terms) q(word) where strpos(lower(r.search_text),q.word)=0)
  ), page_rows as (
    select * from matches order by pending desc,fixture_date desc,id desc limit 50 offset p_page*50
  )
  select jsonb_build_object('total',(select count(*) from matches),
    'items',coalesce(jsonb_agg(item order by pending desc,fixture_date desc,id desc),'[]'::jsonb)) into result
  from page_rows;
  return result;
end;
$$;

insert into eco_private.platform_versions(component,migration_head) values('fixture-workflow','20261124101044');
