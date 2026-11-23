-- Imported fixture history is independent of live enquiry drafts and outcomes.
-- Each row can be traced to its source and links to the ECO directory by ID.
create table eco_private.fixture_history (
  id uuid primary key default gen_random_uuid(),
  fixture_date date not null check (fixture_date >= date '2025-01-01' and fixture_date < date '2027-01-01'),
  supplier_trader_id uuid not null references eco_private.users(id),
  buyer_trader_id uuid not null references eco_private.users(id),
  supplier_id uuid not null references eco_private.suppliers(id),
  account text check (length(account) between 1 and 80),
  eta date,
  vessel text not null check (length(trim(vessel)) between 1 and 240),
  imo text check (imo ~ '^[0-9]{7}$'),
  hsfo text check (length(trim(hsfo)) between 1 and 80),
  vlsfo text check (length(trim(vlsfo)) between 1 and 80),
  lsmgo text check (length(trim(lsmgo)) between 1 and 80),
  price text check (length(trim(price)) between 1 and 120),
  barging text check (length(trim(barging)) between 1 and 120),
  source_workbook text not null check (source_workbook ~ '^[a-zA-Z0-9_-]{10,100}$'),
  source_tab bigint not null check (source_tab >= 0),
  source_row integer not null check (source_row >= 2),
  source_digest text not null check (source_digest ~ '^[0-9a-f]{64}$'),
  source_labels jsonb not null check (jsonb_typeof(source_labels) = 'object' and octet_length(source_labels::text) <= 2048),
  imported_at timestamptz not null default statement_timestamp(),
  check (coalesce(hsfo, vlsfo, lsmgo) is not null),
  unique (source_workbook, source_tab, source_row),
  unique (source_workbook, source_digest)
);
create index eco_fixture_history_recent on eco_private.fixture_history(fixture_date desc, id desc);
create index eco_fixture_history_buyer on eco_private.fixture_history(buyer_trader_id, fixture_date desc, id desc);
create index eco_fixture_history_seller on eco_private.fixture_history(supplier_trader_id, fixture_date desc, id desc);
create index eco_fixture_history_supplier on eco_private.fixture_history(supplier_id, fixture_date desc, id desc);
alter table eco_private.fixture_history enable row level security;
revoke all on eco_private.fixture_history from public, anon, authenticated, service_role;

-- Match the commercial workflow's access boundary. The actual SPC purchasing
-- team and admins read the ledger, and ordinary traders see their own trades.
-- A preview does not gain commercial access from the selected role.
create function public.eco_list_fixture_history(
  p_year integer, p_month integer, p_search text, p_page integer
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  member eco_private.users;
  terms text[];
  result jsonb;
begin
  member := eco_private.current_member();
  if exists (
    select 1 from eco_private.role_previews
    where user_id = member.id and session_id::text = auth.jwt()->>'session_id'
  ) then
    raise exception 'Shared fixtures are unavailable in preview' using errcode = '42501';
  end if;
  if p_year is null or p_year not in (0, 2025, 2026)
     or p_month is null or p_month not between 0 and 12
     or p_search is null or length(p_search) > 120
     or p_page is null or p_page not between 0 and 200 then
    raise exception 'Invalid fixture filters' using errcode = '22023';
  end if;
  terms := regexp_split_to_array(lower(trim(p_search)), '[[:space:]]+');

  with matches as materialized (
    select f.id, f.fixture_date, st.display_name as supplier_trader, bt.display_name as buyer_trader,
      f.source_labels->>'supplierOffice' as supplier_office, f.source_labels->>'buyerOffice' as buyer_office,
      f.account, f.eta, f.vessel, f.imo, f.hsfo, f.vlsfo, f.lsmgo,
      f.supplier_id, s.short_name as supplier, s.archived_at is null as supplier_available,
      f.price, f.barging
    from eco_private.fixture_history f
    join eco_private.users st on st.id = f.supplier_trader_id
    join eco_private.users bt on bt.id = f.buyer_trader_id
    join eco_private.suppliers s on s.id = f.supplier_id
    where (member.is_admin or member.is_spc_trader or member.id in (f.buyer_trader_id, f.supplier_trader_id))
      and (p_year = 0 or extract(year from f.fixture_date) = p_year)
      and (p_month = 0 or extract(month from f.fixture_date) = p_month)
      and not exists (
        select 1 from unnest(terms) as query_term(value)
        where strpos(lower(concat_ws(' ', f.vessel, f.imo, st.display_name, bt.display_name,
          f.account, s.short_name, s.legal_name, f.source_labels->>'supplier',
          f.source_labels->>'supplierTrader', f.source_labels->>'buyerTrader')), query_term.value) = 0
      )
  ), page_rows as (
    select * from matches order by fixture_date desc, id desc limit 50 offset p_page * 50
  )
  select jsonb_build_object(
    'total', (select count(*) from matches),
    'items', coalesce(jsonb_agg(jsonb_build_object(
      'id', id, 'date', fixture_date, 'supplierTrader', supplier_trader, 'supplierOffice', supplier_office,
      'buyerTrader', buyer_trader, 'buyerOffice', buyer_office,
      'account', account, 'eta', eta, 'vessel', vessel, 'imo', imo, 'hsfo', hsfo, 'vlsfo', vlsfo,
      'lsmgo', lsmgo, 'supplierId', supplier_id, 'supplier', supplier, 'supplierAvailable', supplier_available,
      'price', price, 'barging', barging
    ) order by fixture_date desc, id desc), '[]'::jsonb)
  ) into result from page_rows;
  return result;
end;
$$;
revoke all on function public.eco_list_fixture_history(integer, integer, text, integer) from public, anon, authenticated, service_role;
grant execute on function public.eco_list_fixture_history(integer, integer, text, integer) to authenticated;
insert into eco_private.platform_versions(component, migration_head) values ('fixture-history', '20261123044620');
