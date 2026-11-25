alter table eco_private.fixture_bookings
  add column vessel_override text,
  add column imo_override text,
  add column draft_lines jsonb,
  add column deleted_at timestamptz,
  add column deleted_by uuid references eco_private.users(id),
  add constraint fixture_deleted_by check ((deleted_at is null) = (deleted_by is null));
alter table eco_private.fixture_supply_lines add column barging text;

-- Freeze the source rows. ECO edits are applied per field while that field's
-- reviewed SPC value still agrees with the source value seen by the editor.
create table eco_private.fixture_history_edits (
  id uuid primary key,
  revision integer not null default 1,
  changes jsonb not null default '{}',
  source_values jsonb not null default '{}',
  cancelled_at timestamptz,
  cancelled_by uuid references eco_private.users(id),
  cancellation_reason text,
  deleted_at timestamptz,
  deleted_by uuid references eco_private.users(id)
);
alter table eco_private.fixture_history_edits enable row level security;
revoke all on eco_private.fixture_history_edits from public, anon, authenticated, service_role;

create function eco_private.fixture_office_code(office text) returns text
language sql immutable set search_path='' as $$
  select case upper(trim(office))
    when 'SINGAPORE' then 'SG' when 'HONG KONG' then 'HK' when 'JAPAN' then 'JP'
    when 'GENOA' then 'IT' when 'ITALY' then 'IT' when 'GREECE' then 'GR' when 'MONACO' then 'MC'
    when 'DUBAI' then 'AE' when 'UAE' then 'AE' when 'USA' then 'US'
    when 'FRANCE' then 'FR' when 'KOREA' then 'KR' when 'VIETNAM' then 'VN'
    else upper(trim(coalesce(office,''))) end;
$$;

create function eco_private.fixture_import_fields(item jsonb) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object(
    'vessel',item->>'vessel','imo',coalesce(item->>'imo',''),
    'schedule',jsonb_build_object('date',item->'date','eta',item->'eta','etaEnd',item->'etaEnd',
      'etaKind',coalesce(item->>'etaKind',case when item->>'eta' is null then 'date' else 'earliest' end),
      'etaReviewed',coalesce((item->>'etaReviewed')::boolean,item->>'eta'<item->>'date',false)),
    'lines',coalesce((
      select jsonb_agg(jsonb_build_object('grade',g.grade,'quantity',r.value->>lower(g.grade),
        'supplierId',r.value->>'supplierId','accountId',coalesce(o.id,'@'||(r.value->>'account'),''),
        'price',coalesce(r.value->>'price',''),'barging',coalesce(r.value->>'barging',''),
        'cancelled',coalesce((r.value->>'cancelled')::boolean,false)) order by r.position,g.position)
      from jsonb_array_elements(coalesce(item->'supplyRows',jsonb_build_array(item))) with ordinality r(value,position)
      cross join unnest(array['HSFO','VLSFO','LSMGO']) with ordinality g(grade,position)
      left join lateral (
        select a.id from eco_private.offices a where a.id<>'CREDIT' and upper(a.name)=upper(r.value->>'account')
        order by a.id limit 1
      ) o on true
      where r.value->>lower(g.grade) is not null
    ),'[]'::jsonb));
$$;

create function eco_private.fixture_import_line_details(p_lines jsonb) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object(
    'hsfo',string_agg(r.value->>'quantity',' + ' order by r.position) filter(where r.value->>'grade'='HSFO'),
    'vlsfo',string_agg(r.value->>'quantity',' + ' order by r.position) filter(where r.value->>'grade'='VLSFO'),
    'lsmgo',string_agg(r.value->>'quantity',' + ' order by r.position) filter(where r.value->>'grade'='LSMGO'),
    'account',null,'price',null,'barging',null,'supplierId','','supplier','','supplierAvailable',false,
    'supplyRows',coalesce(jsonb_agg(jsonb_build_object(
      'hsfo',case when r.value->>'grade'='HSFO' then r.value->>'quantity' end,
      'vlsfo',case when r.value->>'grade'='VLSFO' then r.value->>'quantity' end,
      'lsmgo',case when r.value->>'grade'='LSMGO' then r.value->>'quantity' end,
      'supplierId',r.value->>'supplierId','supplier',coalesce(s.short_name,''),
      'supplierAvailable',s.id is not null and s.archived_at is null,
      'account',case when left(r.value->>'accountId',1)='@' then substr(r.value->>'accountId',2) else a.name end,
      'price',nullif(r.value->>'price',''),'barging',nullif(r.value->>'barging',''),
      'cancelled',r.value->'cancelled') order by r.position),'[]'::jsonb))
  from jsonb_array_elements(p_lines) with ordinality r(value,position)
  left join eco_private.suppliers s on s.id::text=r.value->>'supplierId'
  left join eco_private.offices a on a.id=r.value->>'accountId';
$$;

create function eco_private.fixture_register_rows(member eco_private.users,p_id uuid default null)
returns table(id uuid,fixture_date date,pending boolean,search_text text,supplier_id uuid,buyer_id uuid,item jsonb,source_item jsonb)
language sql stable set search_path='' as $$
  with history_rows as materialized (
    select f.id,f.booking_group_id,f.source_tab,f.source_row,f.supplier_trader_id,f.buyer_trader_id,
      concat_ws(' ',coalesce(review.vessel,f.vessel),f.imo,st.display_name,bt.display_name,f.account,s.short_name,s.legal_name,
        f.source_labels->>'supplier',f.source_labels->>'supplierTrader',f.source_labels->>'buyerTrader') as search_text,
      jsonb_build_object('id',f.id,'date',f.fixture_date,'supplierTrader',st.display_name,'supplierOffice',f.source_labels->>'supplierOffice',
        'buyerTrader',bt.display_name,'buyerOffice',f.source_labels->>'buyerOffice','account',f.account,'eta',f.eta,
        'vessel',coalesce(review.vessel,f.vessel),'cancelled',coalesce(review.cancelled,false),
        'imo',f.imo,'hsfo',case when 'HSFO'=any(review.removed_grades) then null else coalesce(review.hsfo,f.hsfo) end,
        'vlsfo',case when 'VLSFO'=any(review.removed_grades) then null else coalesce(review.vlsfo,f.vlsfo) end,
        'lsmgo',case when 'LSMGO'=any(review.removed_grades) then null else coalesce(review.lsmgo,f.lsmgo) end,
        'supplierId',s.id,'supplier',s.short_name,'supplierAvailable',s.archived_at is null,
        'price',f.price,'barging',coalesce(review.barging,f.barging)) as item
    from eco_private.fixture_history f
    join eco_private.users st on st.id=f.supplier_trader_id join eco_private.users bt on bt.id=f.buyer_trader_id
    join eco_private.suppliers s on s.id=f.supplier_id
    left join eco_private.fixture_history_source_reviews review on review.fixture_id=f.id
    where (p_id is null or f.booking_group_id=p_id or (f.booking_group_id is null and f.id=p_id))
      and (member.is_admin or member.is_spc_trader or member.id in (f.buyer_trader_id,f.supplier_trader_id))
  ), grouped_history as (
    select booking_group_id,string_agg(search_text,' ') as search_text,
      bool_and((item->>'cancelled')::boolean) as cancelled,
      string_agg(item->>'hsfo',' + ' order by source_tab,source_row) as hsfo,
      string_agg(item->>'vlsfo',' + ' order by source_tab,source_row) as vlsfo,
      string_agg(item->>'lsmgo',' + ' order by source_tab,source_row) as lsmgo,
      jsonb_agg(item-'id'-'date'-'supplierTrader'-'supplierOffice'-'buyerTrader'-'buyerOffice'-'eta'-'vessel'-'imo'
        order by source_tab,source_row) as supply_rows
    from history_rows where booking_group_id is not null group by booking_group_id
  ), imports as (
    select distinct on (coalesce(h.booking_group_id,h.id)) coalesce(h.booking_group_id,h.id) as id,
      h.supplier_trader_id,h.buyer_trader_id,coalesce(g.search_text,h.search_text) as search_text,
      case when g.booking_group_id is null then h.item else h.item||jsonb_build_object(
        'id',g.booking_group_id,'hsfo',g.hsfo,'vlsfo',g.vlsfo,'lsmgo',g.lsmgo,'cancelled',g.cancelled,
        'account',null,'price',null,'barging',null,'supplierId','','supplier','','supplierAvailable',false,
        'supplyRows',g.supply_rows) end as item,
      member.is_admin or (member.id=h.supplier_trader_id and
        not exists(select 1 from eco_private.fixture_history siblings where siblings.booking_group_id=h.booking_group_id
          and siblings.supplier_trader_id<>member.id)) as can_edit
    from history_rows h left join grouped_history g using (booking_group_id)
    order by coalesce(h.booking_group_id,h.id),h.source_tab,h.source_row
  ), rows as (
    select h.id,false as pending,concat_ws(' ',edited.value->>'vessel',edited.value->>'imo',h.search_text,
        edited.details->>'supplyRows') as search_text,
      h.supplier_trader_id as supplier_id,h.buyer_trader_id as buyer_id,
      h.item || (edited.value-'lines'-'schedule') || coalesce(edited.value->'schedule','{}'::jsonb) || edited.details ||
        jsonb_build_object('canEdit',h.can_edit,'deleted',a.deleted_at is not null,
          'cancelled',a.cancelled_at is not null or (h.item->>'cancelled')::boolean,
          'cancellation',case when a.cancelled_at is not null then jsonb_build_object(
            'at',a.cancelled_at,'by',u.display_name,'reason',a.cancellation_reason) end) as item,
      h.item as source_item
    from imports h
    left join eco_private.fixture_history_edits a on a.id=h.id
    left join eco_private.users u on u.id=a.cancelled_by
    cross join lateral (
      select coalesce(jsonb_object_agg(k,v),'{}'::jsonb) as value
      from jsonb_each(a.changes) x(k,v)
      where eco_private.fixture_import_fields(h.item)->k=a.source_values->k
    ) patch
    cross join lateral (
      select patch.value,case when patch.value ? 'lines' then eco_private.fixture_import_line_details(patch.value->'lines')
        else '{}'::jsonb end as details
    ) edited
    where a.deleted_at is null or h.can_edit
    union all
    select b.id,b.confirmed_at is null and b.cancelled_at is null and b.deleted_at is null,
      concat_ws(' ',coalesce(b.vessel_override,e.reviewed->>'vessel'),coalesce(b.imo_override,e.reviewed->>'imo'),st.display_name,bt.display_name,lines.search_text),
      b.supplier_trader_id,b.buyer_trader_id,
      jsonb_build_object('id',b.id,'date',b.fixture_date,
        'status',case when b.confirmed_at is null then 'pending' else 'confirmed' end,'cancelled',b.cancelled_at is not null,
        'supplierTrader',st.display_name,'supplierOffice',b.supplier_office,
        'buyerTrader',bt.display_name,'buyerOffice',b.buyer_office,'eta',b.eta,'etaEnd',b.eta_end,'etaKind',b.eta_kind,
        'vessel',coalesce(b.vessel_override,e.reviewed->>'vessel'),'imo',nullif(coalesce(b.imo_override,e.reviewed->>'imo'),''),
        'hsfo',case when b.confirmed_at is null then requested.hsfo else lines.hsfo end,
        'vlsfo',case when b.confirmed_at is null then requested.vlsfo else lines.vlsfo end,
        'lsmgo',case when b.confirmed_at is null then requested.lsmgo else lines.lsmgo end,
        'account',null,'price',null,'barging',null,'supplierId','','supplier','','supplierAvailable',false,
        'canEdit',member.is_admin or member.id=b.supplier_trader_id,'deleted',b.deleted_at is not null),null
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
    where (p_id is null or b.id=p_id)
      and (member.is_admin or member.id=b.supplier_trader_id
        or (b.deleted_at is null and (member.id=b.buyer_trader_id or (b.confirmed_at is not null and member.is_spc_trader))))
  )
  select r.id,(r.item->>'date')::date,r.pending,r.search_text,r.supplier_id,r.buyer_id,
    r.item||jsonb_build_object('supplierOfficeCode',eco_private.fixture_office_code(r.item->>'supplierOffice'),
      'buyerOfficeCode',eco_private.fixture_office_code(r.item->>'buyerOffice')),r.source_item
  from rows r;
$$;

create function public.eco_list_fixture_register(p_query jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  actor eco_private.users; terms text[]; result jsonb; yr integer; mon integer; page_number integer;
  supplier uuid; buyer uuid; supplier_office text; buyer_office text; show_deleted boolean;
begin
  actor:=eco_private.current_member();
  if exists(select 1 from eco_private.role_previews where user_id=actor.id and session_id::text=auth.jwt()->>'session_id') then
    raise exception 'Shared fixtures are unavailable in preview' using errcode='42501';
  end if;
  perform eco_private.admin_check_keys(p_query,array['year','month','search','page','supplierOffice','supplierTrader','buyerOffice','buyerTrader','deleted']);
  if exists(select 1 from unnest(array['year','month','page']) k
    where jsonb_typeof(p_query->k) is distinct from 'number' or (p_query->>k) !~ '^[0-9]{1,4}$') then
    raise exception 'Invalid fixture filters' using errcode='22023';
  end if;
  perform eco_private.admin_check_text(p_query,'search',0,120);
  yr:=(p_query->>'year')::integer; mon:=(p_query->>'month')::integer; page_number:=(p_query->>'page')::integer;
  if (yr<>0 and yr not between 2025 and 2099) or mon not between 0 and 12 or page_number not between 0 and 200
      or (p_query ? 'deleted' and jsonb_typeof(p_query->'deleted') is distinct from 'boolean') then
    raise exception 'Invalid fixture filters' using errcode='22023';
  end if;
  if p_query ? 'supplierTrader' then supplier:=eco_private.inbox_uuid(p_query,'supplierTrader'); end if;
  if p_query ? 'buyerTrader' then buyer:=eco_private.inbox_uuid(p_query,'buyerTrader'); end if;
  if p_query ? 'supplierOffice' then perform eco_private.admin_check_text(p_query,'supplierOffice',1,80); end if;
  if p_query ? 'buyerOffice' then perform eco_private.admin_check_text(p_query,'buyerOffice',1,80); end if;
  supplier_office:=p_query->>'supplierOffice'; buyer_office:=p_query->>'buyerOffice';
  show_deleted:=coalesce((p_query->>'deleted')::boolean,false);
  terms:=regexp_split_to_array(lower(trim(p_query->>'search')), '[[:space:]]+');
  with visible as materialized (
    select * from eco_private.fixture_register_rows(actor)
  ), rows as materialized (
    select * from visible where (item->>'deleted')::boolean=show_deleted
  ), options as (
    select distinct 'supplier' as role,supplier_id as id,item->>'supplierTrader' as name,
      item->>'supplierOffice' as office,item->>'supplierOfficeCode' as code from rows
    union
    select distinct 'buyer',buyer_id,item->>'buyerTrader',item->>'buyerOffice',item->>'buyerOfficeCode' from rows
  ), matches as materialized (
    select r.id,r.fixture_date,r.pending,r.item from rows r
    where (yr=0 or extract(year from r.fixture_date)=yr) and (mon=0 or extract(month from r.fixture_date)=mon)
      and (supplier is null or r.supplier_id=supplier) and (buyer is null or r.buyer_id=buyer)
      and (supplier_office is null or r.item->>'supplierOfficeCode'=supplier_office)
      and (buyer_office is null or r.item->>'buyerOfficeCode'=buyer_office)
      and not exists(select 1 from unnest(terms) q(word) where strpos(lower(r.search_text),q.word)=0)
  ), page_rows as (
    select * from matches order by pending desc,fixture_date desc,id desc limit 50 offset page_number*50
  )
  select jsonb_build_object(
    'total',(select count(*) from matches),'items',coalesce(jsonb_agg(item order by pending desc,fixture_date desc,id desc),'[]'::jsonb),
    'filters',jsonb_build_object(
      'canSeeDeleted',exists(select 1 from visible where item->>'deleted'='true'),
      'supplier',coalesce((select jsonb_agg(to_jsonb(o)-'role' order by o.name,o.office,o.id) from options o where role='supplier'),'[]'::jsonb),
      'buyer',coalesce((select jsonb_agg(to_jsonb(o)-'role' order by o.name,o.office,o.id) from options o where role='buyer'),'[]'::jsonb)))
  into result from page_rows;
  return result;
end;
$$;

create or replace function public.eco_list_fixture_history(p_year integer,p_month integer,p_search text,p_page integer) returns jsonb
language sql stable security definer set search_path='' as $$
  select public.eco_list_fixture_register(jsonb_build_object('year',p_year,'month',p_month,'search',p_search,'page',p_page))-'filters';
$$;

create or replace function eco_private.fixture_assignment(p eco_private.fixture_bookings) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('id',p.id,'revision',p.revision,'deleted',p.deleted_at is not null,
    'status',case when p.confirmed_at is null then 'pending' else 'confirmed' end,'cancelled',p.cancelled_at is not null,
    'supplierTraderId',p.supplier_trader_id,'supplierTrader',u.display_name,
    'date',p.fixture_date,'eta',p.eta,'etaEnd',p.eta_end,'etaKind',p.eta_kind,'etaReviewed',p.eta_reviewed)
  from eco_private.users u where u.id=p.supplier_trader_id;
$$;

create or replace function eco_private.fixture_details(p eco_private.fixture_bookings,p_actor eco_private.users) returns jsonb
language sql stable set search_path='' as $$
  select eco_private.fixture_assignment(p)||jsonb_build_object(
    'vessel',coalesce(p.vessel_override,e.reviewed->>'vessel'),'imo',coalesce(p.imo_override,e.reviewed->>'imo',''),
    'buyerTrader',b.display_name,
    'reference','ECO-'||lpad(e.reference_number::text,greatest(8,length(e.reference_number::text)),'0'),
    'confirmedAt',p.confirmed_at,
    'canConfirm',p.deleted_at is null and p.cancelled_at is null and p.confirmed_at is null
      and p_actor.id=p.supplier_trader_id and p_actor.is_spc_trader,
    'canCancel',p.deleted_at is null and p.cancelled_at is null and eco_private.fixture_can_cancel(p,p_actor),
    'cancellation',case when p.cancelled_at is not null then jsonb_build_object('at',p.cancelled_at,
      'by',(select u.display_name from eco_private.users u where u.id=p.cancelled_by),'reason',p.cancellation_reason) end,
    'requested',e.reviewed->'products',
    'lines',coalesce((
      select jsonb_agg(jsonb_build_object('grade',l.grade,'quantity',l.quantity,'supplierId',l.supplier_id,
        'supplier',s.short_name,'supplierAvailable',s.archived_at is null,'accountId',l.account_id,'account',l.account_name,
        'buyPrice',l.buy_price,'barging',l.barging) order by l.line_number)
      from eco_private.fixture_supply_lines l join eco_private.suppliers s on s.id=l.supplier_id where l.fixture_id=p.id
    ),'[]'::jsonb))
  from eco_private.commercial_enquiries e join eco_private.users b on b.id=p.buyer_trader_id where e.id=p.enquiry_id;
$$;

-- Existing assignment, confirmation and cancellation callers also respect deletion.
create function eco_private.fixture_live_booking() returns trigger
language plpgsql set search_path='' as $$
begin
  if old.deleted_at is not null and new.deleted_at is not null then
    raise exception 'Restore the fixture before editing it' using errcode='PT409';
  end if;
  if old.supplier_trader_id<>new.supplier_trader_id then new.draft_lines:=null; end if;
  return new;
end;
$$;
create trigger fixture_live_booking before update on eco_private.fixture_bookings
  for each row execute function eco_private.fixture_live_booking();

create or replace function public.eco_get_fixtures(p_query jsonb) returns jsonb
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
  select * into booking from eco_private.fixture_bookings where id=eco_private.inbox_uuid(p_query,'id') and deleted_at is null;
  if not found or not (actor.is_admin or actor.id in (booking.buyer_trader_id,booking.supplier_trader_id)
      or (booking.confirmed_at is not null and actor.is_spc_trader)) then
    raise exception 'Fixture not found' using errcode='PT404';
  end if;
  return eco_private.fixture_details(booking,actor);
end;
$$;

create function eco_private.fixture_editor(p_actor eco_private.users,p_id uuid) returns jsonb
language plpgsql stable set search_path='' as $$
declare row_data record; b eco_private.fixture_bookings; detail jsonb; fields jsonb; lines jsonb; rev integer;
begin
  select * into row_data from eco_private.fixture_register_rows(p_actor,p_id) r where r.item->>'canEdit'='true';
  if not found then raise exception 'Fixture editing is unavailable' using errcode='42501'; end if;
  if row_data.source_item is null then
    select * into strict b from eco_private.fixture_bookings where id=p_id;
    detail:=eco_private.fixture_details(b,p_actor);
    rev:=b.revision;
    lines:=case when b.confirmed_at is not null then (select jsonb_agg(jsonb_build_object(
        'grade',l->'grade','quantity',trim_scale((l->>'quantity')::numeric)::text,'supplierId',l->'supplierId','accountId',l->'accountId',
        'price',trim_scale((l->>'buyPrice')::numeric)::text,'barging',coalesce(l->>'barging',''),'cancelled',false) order by pos)
        from jsonb_array_elements(detail->'lines') with ordinality q(l,pos))
      else coalesce(b.draft_lines,(select jsonb_agg(jsonb_build_object(
        'grade',l->'grade','quantity',coalesce(l->>'quantityText',''),'supplierId','','accountId','','price','','barging','','cancelled',false) order by pos)
        from jsonb_array_elements(detail->'requested') with ordinality q(l,pos))) end;
    fields:=jsonb_build_object('vessel',detail->>'vessel','imo',detail->>'imo','date',b.fixture_date,'eta',b.eta,
      'etaEnd',b.eta_end,'etaKind',b.eta_kind,'etaReviewed',b.eta_reviewed,'lines',coalesce(lines,'[]'::jsonb));
  else
    select revision into rev from eco_private.fixture_history_edits where id=p_id;
    fields:=eco_private.fixture_import_fields(row_data.item);
    fields:=(fields-'schedule')||(fields->'schedule');
  end if;
  return jsonb_build_object(
    'version',md5(jsonb_build_array(coalesce(rev,0),row_data.source_item,fields)::text),
    'item',row_data.item||case when detail is not null then jsonb_build_object('cancellation',detail->'cancellation') else '{}'::jsonb end,
    'fields',fields,'reference',detail->'reference','canConfirm',coalesce((detail->>'canConfirm')::boolean,false),
    'canCancel',case when detail is null then row_data.item->>'cancelled'='false' and row_data.item->>'deleted'='false'
      else (detail->>'canCancel')::boolean end);
end;
$$;

create function public.eco_get_fixture_editor(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor eco_private.users; editor jsonb;
begin
  actor:=eco_private.current_member();
  perform eco_private.assert_preview_writable(actor.id,(auth.jwt()->>'session_id')::uuid);
  editor:=eco_private.fixture_editor(actor,p_id);
  return editor||jsonb_build_object(
    'quantityReview',eco_private.fixture_quantity_review(),
    'accounts',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name) order by name),'[]'::jsonb)
      from eco_private.offices where id<>'CREDIT'),
    'suppliers',(select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'name',s.legal_name) order by s.legal_name,s.id),'[]'::jsonb)
      from eco_private.suppliers s where (s.country_code='SG' and s.archived_at is null and s.closed_at is null)
        or exists(select 1 from jsonb_array_elements(editor->'fields'->'lines') x where x->>'supplierId'=s.id::text)));
end;
$$;

create function public.eco_mutate_fixture_register(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  actor eco_private.users; b eco_private.fixture_bookings; fixture_id uuid; operation text; editor jsonb;
  prior jsonb; fields jsonb; source_fields jsonb; edited_fields jsonb; line jsonb; saved jsonb;
  legacy boolean; final_lines boolean; is_deleted boolean; reason text; at_time timestamptz:=clock_timestamp();
  expected text; booked date; eta_start date; eta_finish date; eta_mode text;
  n integer:=0; grade text; supplier uuid; office_id text; account_name text; band jsonb; reviewed boolean;
  quantity_parts text[]; quantity numeric; high numeric; price numeric;
begin
  actor:=eco_private.admin_writable_member();
  perform eco_private.inbox_live(p_input);
  operation:=p_input->>'action';
  if operation is null or operation not in ('update','complete','void','delete','restore')
      or octet_length(p_input::text)>65536 then raise exception 'Invalid fixture request' using errcode='22023'; end if;
  perform eco_private.admin_check_keys(p_input,array['dataMode','id','requestId','version','action']||case
    when operation in ('update','complete') then array['fields','quantityReviewed']
    when operation='void' then array['reason'] else array[]::text[] end);
  fixture_id:=eco_private.inbox_uuid(p_input,'id');
  expected:=p_input->>'version';
  if jsonb_typeof(p_input->'version') is distinct from 'string' or expected !~ '^[0-9a-f]{32}$' then
    raise exception 'Invalid fixture version' using errcode='22023';
  end if;
  select * into b from eco_private.fixture_bookings where id=fixture_id for update;
  legacy:=not found;
  if legacy then
    -- Serialize all edits of an imported booking on its original rows, including the first edit.
    perform f.id from eco_private.fixture_history f where f.booking_group_id=fixture_id
      or (f.booking_group_id is null and f.id=fixture_id) order by f.id for no key update;
  end if;
  editor:=eco_private.fixture_editor(actor,fixture_id);
  saved:=eco_private.admin_request(actor.id,p_input,'fixture-register-'||operation);
  if saved is not null then return saved; end if;
  is_deleted:=(editor->'item'->>'deleted')::boolean;
  if expected<>editor->>'version' or is_deleted<>(operation='restore') then
    raise exception 'Fixture changed. Reopen it and try again.' using errcode='PT409';
  end if;
  prior:=editor->'fields';

  if operation='void' then
    if editor->>'canCancel'<>'true' then raise exception 'Fixture cancellation is unavailable' using errcode='42501'; end if;
    perform eco_private.admin_check_text(p_input,'reason',1,500);
    reason:=regexp_replace(p_input->>'reason','^[[:space:]]+|[[:space:]]+$','','g');
    if reason='' then raise exception 'Cancellation reason is required' using errcode='22023'; end if;
  elsif operation in ('update','complete') then
    if operation='complete' and editor->>'canConfirm'<>'true' then
      raise exception 'Assigned SPC supplier trader required' using errcode='42501';
    end if;
    fields:=p_input->'fields';
    perform eco_private.admin_check_keys(fields,array['vessel','imo','date','eta','etaEnd','etaKind','etaReviewed','lines']);
    perform eco_private.admin_check_text(fields,'vessel',1,240);
    perform eco_private.admin_check_text(fields,'imo',0,7);
    if length(fields->>'vessel')>240 or (fields->>'imo'<>'' and fields->>'imo' !~ '^[0-9]{7}$')
      or jsonb_typeof(fields->'etaReviewed') is distinct from 'boolean'
      or jsonb_typeof(p_input->'quantityReviewed') is distinct from 'boolean'
      or jsonb_typeof(fields->'lines') is distinct from 'array' then
      raise exception 'Invalid fixture details' using errcode='22023';
    end if;
    if exists(select 1 from unnest(array['date','eta','etaEnd']) k where
      ((k='date' or (k='eta' and not legacy)) or fields->k is distinct from 'null'::jsonb)
      and (jsonb_typeof(fields->k) is distinct from 'string' or (fields->>k) !~ '^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$')) then
      raise exception 'Invalid fixture date or ETA' using errcode='22023';
    end if;
    booked:=(fields->>'date')::date; eta_start:=(fields->>'eta')::date; eta_finish:=(fields->>'etaEnd')::date;
    eta_mode:=fields->>'etaKind';
    reviewed:=(fields->>'etaReviewed')::boolean;
    if eta_mode is null or eta_mode not in ('date','range','earliest')
      or (eta_mode='range' and (eta_start is null or eta_finish is null or eta_finish<=eta_start))
      or (eta_mode<>'range' and eta_finish is not null) then raise exception 'Invalid ETA range' using errcode='22023'; end if;
    if eta_start<booked and not reviewed then raise exception 'Review the ETA before the fixture date' using errcode='PT422'; end if;

    final_lines:=not legacy and (b.confirmed_at is not null or operation='complete');
    if jsonb_array_length(fields->'lines')>30 or (jsonb_array_length(fields->'lines')=0 and
      (final_lines or (legacy and jsonb_array_length(prior->'lines')>0))) then
      raise exception 'Invalid fixture supply lines' using errcode='22023';
    end if;
    if final_lines then delete from eco_private.fixture_supply_lines l where l.fixture_id=b.id; end if;
    for line in select value from jsonb_array_elements(fields->'lines') loop
      perform eco_private.admin_check_keys(line,array['grade','quantity','supplierId','accountId','price','barging','cancelled']);
      perform eco_private.admin_check_text(line,'quantity',0,80);
      perform eco_private.admin_check_text(line,'supplierId',0,36);
      perform eco_private.admin_check_text(line,'accountId',0,81);
      perform eco_private.admin_check_text(line,'price',0,120);
      perform eco_private.admin_check_text(line,'barging',0,120);
      if length(line->>'quantity')>80 or length(line->>'price')>120 or length(line->>'barging')>120 then
        raise exception 'Invalid supply line' using errcode='22023';
      end if;
      grade:=line->>'grade'; office_id:=line->>'accountId'; account_name:=null;
      supplier:=case when line->>'supplierId'<>'' then eco_private.inbox_uuid(line,'supplierId') end;
      if grade is null or grade not in ('HSFO','VLSFO','LSMGO')
        or jsonb_typeof(line->'cancelled') is distinct from 'boolean'
        or (not legacy and (line->>'cancelled')::boolean) then raise exception 'Invalid supply line' using errcode='22023'; end if;

      if legacy and supplier is null then raise exception 'Select a supplier profile' using errcode='PT422'; end if;
      if supplier is not null then
        perform s.id from eco_private.suppliers s where s.id=supplier and (
          (s.country_code='SG' and s.closed_at is null and s.archived_at is null)
          or (operation<>'complete' and (legacy or b.confirmed_at is not null) and
            exists(select 1 from jsonb_array_elements(prior->'lines') x where x->>'supplierId'=supplier::text))) for share;
        if not found then raise exception 'Select an active Singapore supplier' using errcode='PT422'; end if;
      end if;
      if office_id<>'' then
        select o.name into account_name from eco_private.offices o where o.id=office_id and o.id<>'CREDIT' for share;
        if not found and not (legacy and left(office_id,1)='@' and
          exists(select 1 from jsonb_array_elements(prior->'lines') x where x->>'accountId'=office_id)) then
          raise exception 'Select an office account' using errcode='PT422';
        end if;
      end if;

      quantity_parts:=regexp_match(translate(trim(line->>'quantity'),'–—−','---'),
        '^((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]+)?)(?:[[:space:]]*(?:-|~|to|/)[[:space:]]*((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]+)?))?[[:space:]]*(?:MT|MTS|metric[[:space:]]+tonnes?)?$','i');
      quantity:=replace(quantity_parts[1],',','')::numeric; high:=coalesce(replace(quantity_parts[2],',','')::numeric,quantity);
      if ((legacy or trim(line->>'quantity')<>'') and (quantity is null or quantity<=0 or high<quantity or high>1000000)
        and not exists(select 1 from jsonb_array_elements(prior->'lines') x where x->>'quantity'=line->>'quantity')) then
        raise exception 'Enter a valid quantity or range' using errcode='PT422';
      end if;
      if final_lines then
        if trim(line->>'price') !~ '^(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]+)?$' then
          raise exception 'Enter the agreed buy price' using errcode='PT422';
        end if;
        price:=replace(trim(line->>'price'),',','')::numeric;
        if quantity is null or quantity<=0 or quantity<>high or quantity>1000000 or price<=0 or price>1000000
          or supplier is null or account_name is null then
          raise exception 'Enter the agreed quantity, supplier, account and buy price' using errcode='PT422';
        end if;
        band:=eco_private.fixture_quantity_review()->grade;
        if (quantity<(band->>'min')::numeric or quantity>(band->>'max')::numeric)
          and (p_input->>'quantityReviewed')::boolean is not true then
          raise exception 'Review unusually high or low quantities' using errcode='PT422';
        end if;
        n:=n+1;
        insert into eco_private.fixture_supply_lines(fixture_id,line_number,grade,supplier_id,account_id,account_name,quantity,buy_price,barging)
          values(b.id,n,grade,supplier,office_id,account_name,quantity,price,nullif(trim(line->>'barging'),''));
      end if;
    end loop;
    if final_lines and exists(select 1 from eco_private.fixture_supply_lines l where l.fixture_id=b.id
      group by l.grade,l.supplier_id,l.account_id,l.quantity,l.buy_price,l.barging having count(*)>1) then
      raise exception 'Review duplicate supply lines' using errcode='PT422';
    end if;
    if legacy then
      select eco_private.fixture_import_fields(r.source_item) into source_fields from eco_private.fixture_register_rows(actor,fixture_id) r;
      fields:=jsonb_build_object('vessel',trim(fields->>'vessel'),'imo',fields->>'imo','lines',fields->'lines',
        'schedule',fields-'vessel'-'imo'-'lines');
      select coalesce(jsonb_object_agg(k,v),'{}'::jsonb) into edited_fields from jsonb_each(fields) x(k,v)
        where source_fields->k is distinct from v;
    end if;
  end if;

  if legacy then
    insert into eco_private.fixture_history_edits(id) values(fixture_id) on conflict do nothing;
    update eco_private.fixture_history_edits a set
      revision=a.revision+1,changes=coalesce(edited_fields,a.changes),source_values=coalesce(source_fields,a.source_values),
      deleted_at=case operation when 'delete' then at_time when 'restore' then null else a.deleted_at end,
      deleted_by=case operation when 'delete' then actor.id when 'restore' then null else a.deleted_by end,
      cancelled_at=case when operation='void' then at_time else a.cancelled_at end,
      cancelled_by=case when operation='void' then actor.id else a.cancelled_by end,
      cancellation_reason=coalesce(reason,a.cancellation_reason)
    where a.id=fixture_id;
  else
    update eco_private.fixture_bookings w set
      revision=w.revision+1,vessel_override=coalesce(trim(fields->>'vessel'),w.vessel_override),
      imo_override=coalesce(fields->>'imo',w.imo_override),fixture_date=coalesce(booked,w.fixture_date),
      eta=coalesce(eta_start,w.eta),eta_end=case when fields is not null then eta_finish else w.eta_end end,
      eta_kind=coalesce(eta_mode,w.eta_kind),eta_reviewed=coalesce(reviewed,w.eta_reviewed),
      draft_lines=case when operation='complete' then null
        when operation='update' and w.confirmed_at is null then fields->'lines' else w.draft_lines end,
      confirmed_at=case when operation='complete' then at_time else w.confirmed_at end,
      confirmed_by=case when operation='complete' then actor.id else w.confirmed_by end,
      cancelled_at=case when operation='void' then at_time else w.cancelled_at end,
      cancelled_by=case when operation='void' then actor.id else w.cancelled_by end,
      cancellation_reason=coalesce(reason,w.cancellation_reason),
      deleted_at=case operation when 'delete' then at_time when 'restore' then null else w.deleted_at end,
      deleted_by=case operation when 'delete' then actor.id when 'restore' then null else w.deleted_by end
    where w.id=fixture_id;
  end if;
  insert into eco_private.administration_events(actor_id,actor_name,target_id,action,details)
    values(actor.id,actor.display_name,fixture_id,'fixture-register-'||operation,jsonb_build_object(
      'imported',legacy,'previousVersion',expected,'reason',reason,'previous',case when fields is not null then prior end,
      'updated',fields,'quantityReviewed',p_input->'quantityReviewed'));
  return eco_private.admin_finish(actor.id,p_input,jsonb_build_object('id',fixture_id));
end;
$$;

revoke all on function eco_private.fixture_office_code(text),eco_private.fixture_import_fields(jsonb),
  eco_private.fixture_import_line_details(jsonb),eco_private.fixture_register_rows(eco_private.users,uuid),
  eco_private.fixture_live_booking(),eco_private.fixture_editor(eco_private.users,uuid)
  from public,anon,authenticated,service_role;
revoke all on function public.eco_list_fixture_register(jsonb),public.eco_get_fixture_editor(uuid),
  public.eco_mutate_fixture_register(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.eco_list_fixture_register(jsonb),public.eco_get_fixture_editor(uuid),
  public.eco_mutate_fixture_register(jsonb) to authenticated;
insert into eco_private.platform_versions(component,migration_head) values('fixture-register-editor','20261125023623');
