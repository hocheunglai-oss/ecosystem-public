-- A reviewed source line can be found without publishing an incomplete fixture.
create table eco_private.fixture_import_holds (
  id uuid primary key default gen_random_uuid(),
  source_workbook text not null check (source_workbook ~ '^[a-zA-Z0-9_-]{10,100}$'),
  source_tab bigint not null check (source_tab>=0 and source_tab<=2147483647),
  source_row integer not null check (source_row>=2),
  fixture_date date not null check (fixture_date>=date '2025-01-01' and fixture_date<date '2100-01-01'),
  vessel text not null check (length(trim(vessel)) between 1 and 240),
  eta date check (eta is null or isfinite(eta)),
  missing_field text not null check (missing_field in ('supplier','buyer_trader','quantity')),
  grade text check (grade is null or (grade in ('HSFO','VLSFO','LSMGO') and missing_field='quantity')),
  related_fixture_id uuid references eco_private.fixture_history(id) on delete set null,
  source_evidence jsonb not null check (jsonb_typeof(source_evidence)='object' and octet_length(source_evidence::text)<=8192),
  reviewed_at timestamptz not null default statement_timestamp(),
  unique (source_workbook,source_tab,source_row)
);
alter table eco_private.fixture_import_holds enable row level security;
revoke all on eco_private.fixture_import_holds from public, anon, authenticated, service_role;

create view eco_private.open_fixture_import_holds as
select h.* from eco_private.fixture_import_holds h
where not exists(select 1 from eco_private.fixture_history f
  where f.source_workbook=h.source_workbook and f.source_tab=h.source_tab and f.source_row=h.source_row
    and f.fixture_date=h.fixture_date and upper(trim(f.vessel))=upper(trim(h.vessel)));
revoke all on eco_private.open_fixture_import_holds from public, anon, authenticated, service_role;

-- Reports over the shared fixture ledger must use include_in_statistics.
-- A reviewed price gap or a held supply line excludes the whole booking.
create function eco_private.fixture_register_with_review(p_actor eco_private.users)
returns table(id uuid,fixture_date date,pending boolean,search_text text,supplier_id uuid,buyer_id uuid,
  item jsonb,missing_buy_price boolean,include_in_statistics boolean)
language sql stable set search_path='' as $$
  with price_reviews as materialized (
    select distinct coalesce(f.booking_group_id,f.id) as id
    from eco_private.fixture_history f
    where f.price is null and f.source_labels #>> '{ownerReview,price,status}' = 'missing'
  ), incomplete_bookings as materialized (
    select distinct coalesce(f.booking_group_id,f.id) as id
    from eco_private.open_fixture_import_holds h join eco_private.fixture_history f on f.id=h.related_fixture_id
  )
  select r.id,r.fixture_date,r.pending,r.search_text,r.supplier_id,r.buyer_id,r.item,review.missing_price,
    not review.missing_price and b.id is null and r.item->>'deleted'='false'
      and coalesce(r.item->>'status','confirmed')='confirmed'
  from eco_private.fixture_register_rows(p_actor) r
  left join price_reviews p on p.id=r.id
  left join incomplete_bookings b on b.id=r.id
  cross join lateral (
    select case when p.id is not null then exists(
      select 1 from jsonb_array_elements(coalesce(r.item->'supplyRows',jsonb_build_array(r.item))) line
      where nullif(trim(line->>'price'),'') is null
    ) else false end as missing_price
  ) review;
$$;
revoke all on function eco_private.fixture_register_with_review(eco_private.users)
  from public, anon, authenticated, service_role;

create or replace function public.eco_list_fixture_register(p_query jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  actor eco_private.users; terms text[]; result jsonb; yr integer; mon integer; page_number integer;
  supplier uuid; buyer uuid; supplier_office text; buyer_office text;
  show_deleted boolean; missing_only boolean; compact boolean; page_size integer;
begin
  actor:=eco_private.current_member();
  if exists(select 1 from eco_private.role_previews where user_id=actor.id and session_id::text=auth.jwt()->>'session_id') then
    raise exception 'Shared fixtures are unavailable in preview' using errcode='42501';
  end if;
  perform eco_private.admin_check_keys(p_query,array['year','month','search','page','supplierOffice','supplierTrader','buyerOffice','buyerTrader','deleted','view','missing']);
  if p_query ? 'view' and p_query->>'view' is distinct from 'register' then
    raise exception 'Invalid fixture view' using errcode='22023';
  end if;
  compact:=coalesce(p_query->>'view'='register',false);
  page_size:=case when compact then 100 else 50 end;
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
  if p_query ? 'missing' and (p_query->'missing' is distinct from 'true'::jsonb or not compact or show_deleted) then
    raise exception 'Invalid fixture filters' using errcode='22023';
  end if;
  missing_only:=p_query ? 'missing';
  if missing_only and not actor.is_admin then
    raise exception 'Access denied' using errcode='42501';
  end if;
  terms:=regexp_split_to_array(lower(trim(p_query->>'search')), '[[:space:]]+');
  with ledger as materialized (
    select * from eco_private.fixture_register_with_review(actor)
  ), office_by_trader as materialized (
    select x.id,coalesce(o.name,'') as name,eco_private.fixture_office_code(o.name) as code
    from (select supplier_id as id from ledger where compact
      union select buyer_id from ledger where compact) x
    join eco_private.users u on u.id=x.id
    left join eco_private.offices o on o.id=u.office_id
  ), visible as materialized (
    select r.id,r.fixture_date,r.pending,r.search_text,r.supplier_id,r.buyer_id,r.item,
      compact and actor.is_admin and r.missing_buy_price as missing_buy_price,
      case when compact then so.name else r.item->>'supplierOffice' end as supplier_name,
      case when compact then bo.name else r.item->>'buyerOffice' end as buyer_name,
      case when compact then so.code else r.item->>'supplierOfficeCode' end as supplier_code,
      case when compact then bo.code else r.item->>'buyerOfficeCode' end as buyer_code
    from ledger r
    left join office_by_trader so on so.id=r.supplier_id
    left join office_by_trader bo on bo.id=r.buyer_id
  ), rows as materialized (
    select * from visible where (item->>'deleted')::boolean=show_deleted
  ), options as (
    select distinct 'supplier' as role,supplier_id as id,item->>'supplierTrader' as name,
      supplier_name as office,supplier_code as code from rows
    union
    select distinct 'buyer',buyer_id,item->>'buyerTrader',buyer_name,buyer_code from rows
  ), matches as materialized (
    select r.id,r.fixture_date,r.pending,
      case when r.missing_buy_price then r.item||'{"missingBuyPrice":true}'::jsonb else r.item end as item,
      r.supplier_id,r.buyer_id
    from rows r
    where (yr=0 or extract(year from r.fixture_date)=yr) and (mon=0 or extract(month from r.fixture_date)=mon)
      and (supplier is null or r.supplier_id=supplier) and (buyer is null or r.buyer_id=buyer)
      and (supplier_office is null or r.supplier_code=supplier_office)
      and (buyer_office is null or r.buyer_code=buyer_office)
      and (not missing_only or r.missing_buy_price)
      and not exists(select 1 from unnest(terms) q(word)
        where strpos(lower(case when r.missing_buy_price then r.search_text||' missing record buy price' else r.search_text end),q.word)=0)
    union all
    select h.id,h.fixture_date,false,jsonb_strip_nulls(jsonb_build_object(
      'id',h.id,'date',h.fixture_date,'vessel',h.vessel,'eta',h.eta,
      'reviewHold',jsonb_build_object('field',h.missing_field,'grade',h.grade,
        'workbook',h.source_workbook,'tab',h.source_tab,'row',h.source_row))),null::uuid,null::uuid
    from eco_private.open_fixture_import_holds h
    where compact and actor.is_admin and not show_deleted and (missing_only or p_query->>'search' ~ '[^[:space:]]')
      and supplier is null and buyer is null and supplier_office is null and buyer_office is null
      and (yr=0 or extract(year from h.fixture_date)=yr) and (mon=0 or extract(month from h.fixture_date)=mon)
      and not exists(select 1 from unnest(terms) q(word)
        where strpos(lower(concat_ws(' ','missing record',h.vessel,replace(h.missing_field,'_',' '),h.grade)),q.word)=0)
  ), page_rows as (
    select id,fixture_date,pending,case when compact and not (item ? 'reviewHold') then jsonb_strip_nulls(jsonb_build_object(
      'id',id,'date',fixture_date,'vessel',item->'vessel','imo',item->'imo','eta',item->'eta','etaEnd',item->'etaEnd',
      'supplierTraderId',supplier_id,'buyerTraderId',buyer_id,'hsfo',item->'hsfo','vlsfo',item->'vlsfo','lsmgo',item->'lsmgo',
      'status',item->'status','missingBuyPrice',item->'missingBuyPrice','cancelled',nullif(item->'cancelled','false'::jsonb),
      'deleted',nullif(item->'deleted','false'::jsonb),'canEdit',nullif(item->'canEdit','false'::jsonb)))
      else item end as item
    from matches order by pending desc,fixture_date desc,id desc limit page_size offset page_number*page_size
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

insert into eco_private.platform_versions(component,migration_head) values('fixture-import-hold-search','20261125090000');
