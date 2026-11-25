-- Retain explicitly denominated historical prices without assuming a conversion to USD/MT.
-- The existing authenticated API grant is preserved by CREATE OR REPLACE.
create or replace function public.eco_read_port_fixtures(p_mode text,p_port_id text,p_search text,p_page integer)
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
      select l.*,u.recorded_price from eco_private.port_fixture_lines(member,port,null,null) l
      left join lateral (
        select raw.price as recorded_price
        from eco_private.fixture_register_rows(member,l.booking_id) r
        cross join lateral (
          select coalesce(r.item->'supplyRows'->((l.line_position-1)/3)::integer,r.item)->>'price' as price
        ) raw
        where l.price is null and l.enquiry_id is null
          and trim(raw.price) ~* '^[$]?[0-9,]+([.][0-9]{1,6})?[[:space:]]*/[[:space:]]*(mt|l|liter|litre)$'
      ) u on true
      where not l.cancelled and (l.price>0 or u.recorded_price is not null)
        and not exists (
          select 1 from regexp_split_to_table(lower(trim(p_search)),'[[:space:]]+') q(word)
          where strpos(lower(concat_ws(' ',l.vessel,l.supplier,l.grade,l.quantity_text,l.price,u.recorded_price,l.fixture_date,
            to_char(l.fixture_date,'FMDD Mon YYYY'))),q.word)=0
        )
    ), page as (
      select * from matching order by fixture_date desc,booking_id desc,line_position limit 50 offset p_page*50
    )
    select jsonb_build_object('total',(select count(*) from matching),'pageSize',50,'items',
      coalesce(jsonb_agg(jsonb_build_object('id',booking_id::text||':'||line_position,'date',fixture_date,'supplier',supplier,
        'vessel',vessel,'grade',grade,'quantity',quantity_text,'price',price,'recordedPrice',recorded_price)
        order by fixture_date desc,booking_id desc,line_position),'[]'::jsonb)) from page
  );
end;
$$;
insert into eco_private.platform_versions(component,migration_head) values('port-fixture-price-units','20261125113147');
