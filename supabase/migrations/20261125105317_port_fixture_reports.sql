-- All port reports use the same effective, session-scoped fixture register.
-- Commercial source rows, drafts and incomplete bookings stay outside reports.
create function eco_private.port_fixture_lines(
  member eco_private.users, port jsonb, first_day date, last_day date
) returns table (
  booking_id uuid, fixture_date date, vessel text, buyer_office text, supplier_trader text,
  supplier_id uuid, supplier text, grade text, quantity_text text, quantity numeric,
  estimated boolean, price numeric, cancelled boolean, enquiry_id uuid, line_position bigint
)
language sql stable set search_path='' as $$
  with bookings as materialized (
    select r.id,r.fixture_date,r.item,b.enquiry_id,coalesce((r.item->>'cancelled')::boolean,false) as cancelled
    from eco_private.fixture_register_with_review(member) r
    left join eco_private.fixture_bookings b on b.id=r.id
    where r.include_in_statistics and (first_day is null or r.fixture_date>=first_day)
      and (last_day is null or r.fixture_date<=last_day)
  ), lines as (
    select b.*,s.id as supplier_id,s.short_name,supply.grade,supply.quantity::text as quantity_text,
      supply.buy_price::text as price,(supply.line_number*3)::bigint as line_position
    from bookings b join eco_private.commercial_enquiries e on e.id=b.enquiry_id and e.port->>'id'=port->>'id'
    join eco_private.fixture_supply_lines supply on supply.fixture_id=b.id
    join eco_private.suppliers s on s.id=supply.supplier_id
    union all
    select b.*,s.id,s.short_name,upper(fuel.grade),r.value->>fuel.grade,r.value->>'price',
      (r.ordinality-1)*3+fuel.ordinality
    from bookings b
    cross join lateral jsonb_array_elements(coalesce(b.item->'supplyRows',jsonb_build_array(b.item))) with ordinality r(value,ordinality)
    cross join unnest(array['hsfo','vlsfo','lsmgo']) with ordinality fuel(grade,ordinality)
    join eco_private.suppliers s on s.id::text=r.value->>'supplierId'
      and s.country_code=port->>'countryCode' and lower(trim(s.record->>'portName'))=lower(port->>'portName')
    where b.enquiry_id is null and r.value->>fuel.grade is not null
      and (b.cancelled or coalesce((b.item->>'sourceReinstated')::boolean,false)
        or (r.value->>'cancelled')::boolean is not true)
  )
  select l.id,l.fixture_date,l.item->>'vessel',coalesce(nullif(l.item->>'buyerOffice',''),'—'),
    l.item->>'supplierTrader',l.supplier_id,l.short_name,l.grade,l.quantity_text,
    (m.parts[1]::numeric+coalesce(m.parts[2],m.parts[1])::numeric)/2,
    m.parts[2] is not null,
    case when translate(l.price,',$ ','') ~ '^[0-9]{1,8}([.][0-9]{1,6})?$'
      then translate(l.price,',$ ','')::numeric end,
    l.cancelled,l.enquiry_id,l.line_position
  from lines l
  cross join lateral (select regexp_match(trim(replace(l.quantity_text,',','')),
    '^([0-9]{1,8}(?:[.][0-9]{1,6})?)(?:[[:space:]]*[-–—~][[:space:]]*([0-9]{1,8}(?:[.][0-9]{1,6})?))?$') as parts) m;
$$;

create function eco_private.spc_port_statistics(member eco_private.users, port jsonb, as_of date)
returns jsonb language sql stable set search_path='' as $$
  with bounds as (
    select extract(year from as_of)::integer as this_year, as_of-89 as recent_start,
      (as_of-89)::timestamp at time zone 'Asia/Singapore' as recent_from,
      (as_of+1)::timestamp at time zone 'Asia/Singapore' as recent_until
  ), lines as materialized (
    select l.* from bounds b
    cross join lateral eco_private.port_fixture_lines(member,port,make_date(b.this_year-1,1,1),as_of) l
  ), current_lines as materialized (
    select l.* from lines l,bounds b where l.fixture_date>=b.recent_start and not l.cancelled
  ), months as (
    select extract(month from fixture_date)::integer as month,
      sum(quantity) filter(where extract(year from fixture_date)=b.this_year) as current_volume,
      sum(quantity) filter(where extract(year from fixture_date)=b.this_year-1) as previous_volume
    from lines,bounds b where not cancelled group by 1
  ), supplier_totals as (
    select supplier_id,supplier as label,coalesce(sum(quantity),0) as volume,count(distinct booking_id) as fixtures
    from current_lines group by 1,2
  ), office_totals as (
    select buyer_office as label,coalesce(sum(quantity),0) as volume,count(distinct booking_id) as fixtures
    from current_lines group by 1
  ), trader_totals as (
    select supplier_trader as label,count(distinct booking_id) as fixtures from current_lines group by 1
  ), enquiries as (
    select e.id,coalesce(o.name,'—') as office,coalesce(u.display_name,e.owner_name) as trader,
      exists(select 1 from lines l where l.enquiry_id=e.id and not l.cancelled) as fixed
    from eco_private.commercial_enquiries e cross join bounds b
    left join eco_private.users u on u.id=e.owner_id left join eco_private.offices o on o.id=u.office_id
    where e.status='confirmed' and e.port->>'id'=port->>'id'
      and e.created_at>=b.recent_from and e.created_at<b.recent_until
  ), office_rates as (
    select office as label,count(*) as enquiries,count(*) filter(where fixed) as fixtures from enquiries group by 1
  ), trader_rates as (
    select trader as label,count(*) as enquiries,count(*) filter(where fixed) as fixtures from enquiries group by 1
  )
  select jsonb_build_object(
    'year',b.this_year,'through',as_of,
    'monthly',(select jsonb_agg(jsonb_build_object('month',m.n,'current',coalesce(v.current_volume,0),
      'previous',coalesce(v.previous_volume,0)) order by m.n)
      from generate_series(1,12) m(n) left join months v on v.month=m.n),
    'estimated',exists(select 1 from lines where estimated and quantity is not null and not cancelled),
    'cancelled',(select count(distinct booking_id) from lines where cancelled and fixture_date>=b.recent_start),
    'volumeBySupplier',coalesce((select jsonb_agg(jsonb_build_object('label',label,'value',volume) order by volume desc,label,supplier_id) from supplier_totals),'[]'::jsonb),
    'fixturesBySupplier',coalesce((select jsonb_agg(jsonb_build_object('label',label,'value',fixtures) order by fixtures desc,label,supplier_id) from supplier_totals),'[]'::jsonb),
    'volumeByOffice',coalesce((select jsonb_agg(jsonb_build_object('label',label,'value',volume) order by volume desc,label) from office_totals),'[]'::jsonb),
    'fixturesByOffice',coalesce((select jsonb_agg(jsonb_build_object('label',label,'value',fixtures) order by fixtures desc,label) from office_totals),'[]'::jsonb),
    'bySupplierTrader',coalesce((select jsonb_agg(jsonb_build_object('label',label,'value',fixtures) order by fixtures desc,label) from trader_totals),'[]'::jsonb),
    'enquiries',(select count(*) from enquiries),
    'byBuyerOffice',coalesce((select jsonb_agg(to_jsonb(t) order by t.enquiries desc,t.label) from office_rates t),'[]'::jsonb),
    'byBuyerTrader',coalesce((select jsonb_agg(to_jsonb(t) order by t.enquiries desc,t.label) from trader_rates t),'[]'::jsonb)
  ) from bounds b;
$$;

create function public.eco_read_port_fixtures(p_mode text,p_port_id text,p_search text,p_page integer)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  member eco_private.users;
  port jsonb;
  as_of date := (statement_timestamp() at time zone 'Asia/Singapore')::date;
begin
  member:=eco_private.current_member();
  if exists(select 1 from eco_private.role_previews where user_id=member.id and session_id::text=auth.jwt()->>'session_id') then
    raise exception 'Shared fixture reports are unavailable in preview' using errcode='42501';
  end if;
  port:=eco_private.supplier_port(p_port_id);
  if port is null or p_mode is null or p_mode not in ('prices','ranking','statistics')
    or p_search is null or length(p_search)>160 or p_page is null or p_page not between 0 and 9999
    or (p_mode<>'prices' and (p_search<>'' or p_page<>0))
    or (p_mode='statistics' and p_port_id<>'port-singapore') then
    raise exception 'Invalid port fixture report' using errcode='22023';
  end if;
  if p_mode='statistics' then
    if not (member.is_admin or member.is_spc_trader) then raise exception 'Access denied' using errcode='42501'; end if;
    return eco_private.spc_port_statistics(member,port,as_of);
  end if;
  if p_mode='ranking' then
    return (
      with directory as (
        select s.id,s.short_name from eco_private.suppliers s
        where s.country_code=port->>'countryCode' and lower(trim(s.record->>'portName'))=lower(port->>'portName')
          and s.archived_at is null and s.closed_at is null
      ), ranked as (
        select d.id,d.short_name as name,array_agg(distinct l.grade order by l.grade) as grades,
          count(distinct l.booking_id) as fixtures
        from eco_private.port_fixture_lines(member,port,(as_of-interval '12 months')::date+1,as_of) l
        join directory d on d.id=l.supplier_id where not l.cancelled group by 1,2
        order by fixtures desc,name,d.id limit 10
      )
      select jsonb_build_object(
        'items',coalesce((select jsonb_agg(to_jsonb(r) order by r.fixtures desc,r.name,r.id) from ranked r),'[]'::jsonb),
        'supplierCount',(select count(*) from directory),'through',as_of,
        'personal',not (member.is_admin or member.is_spc_trader))
    );
  end if;
  return (
    with matching as materialized (
      select l.* from eco_private.port_fixture_lines(member,port,null,null) l
      where not l.cancelled and l.price>0
        and not exists (
          select 1 from regexp_split_to_table(lower(trim(p_search)),'[[:space:]]+') q(word)
          where strpos(lower(concat_ws(' ',l.vessel,l.supplier,l.grade,l.quantity_text,l.price,l.fixture_date,
            to_char(l.fixture_date,'FMDD Mon YYYY'))),q.word)=0
        )
    ), page as (
      select * from matching order by fixture_date desc,booking_id desc,line_position limit 50 offset p_page*50
    )
    select jsonb_build_object('total',(select count(*) from matching),'pageSize',50,'items',
      coalesce(jsonb_agg(jsonb_build_object('id',booking_id::text||':'||line_position,'date',fixture_date,'supplier',supplier,
        'vessel',vessel,'grade',grade,'quantity',quantity_text,'price',price)
        order by fixture_date desc,booking_id desc,line_position),'[]'::jsonb)) from page
  );
end;
$$;
revoke all on function eco_private.port_fixture_lines(eco_private.users,jsonb,date,date),
  eco_private.spc_port_statistics(eco_private.users,jsonb,date),
  public.eco_read_port_fixtures(text,text,text,integer) from public,anon,authenticated,service_role;
grant execute on function public.eco_read_port_fixtures(text,text,text,integer) to authenticated;
