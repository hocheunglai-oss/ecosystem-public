alter table eco_private.fixture_bookings
  drop constraint eco_fixture_cancellation_details,
  add constraint eco_fixture_cancellation_details check (
    (cancelled_at is null and cancelled_by is null and cancellation_reason is null)
    or (cancelled_at is not null and cancelled_by is not null
      and (cancellation_reason is null or length(trim(cancellation_reason)) between 1 and 500))
  );

-- A reinstatement of an imported cancellation applies to the reviewed source
-- decision it was based on. A later source decision takes precedence.
alter table eco_private.fixture_history_edits add column reinstated_source text;

create function eco_private.fixture_source_cancellation(p_id uuid) returns text
language sql stable set search_path='' as $$
  select case when bool_and(review.cancelled is true) then md5(string_agg(
    concat_ws(':',f.id,f.source_digest,extract(epoch from review.source_modified_at)),',' order by f.id)) end
  from eco_private.fixture_history f
  left join eco_private.fixture_history_source_reviews review on review.fixture_id=f.id
  where f.booking_group_id=p_id or (f.booking_group_id is null and f.id=p_id);
$$;

create or replace function eco_private.fixture_import_fields(item jsonb) returns jsonb
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
        'cancelled',coalesce((r.value->>'sourceCancelled')::boolean,(r.value->>'cancelled')::boolean,false)) order by r.position,g.position)
      from jsonb_array_elements(coalesce(item->'supplyRows',jsonb_build_array(item))) with ordinality r(value,position)
      cross join unnest(array['HSFO','VLSFO','LSMGO']) with ordinality g(grade,position)
      left join lateral (
        select a.id from eco_private.offices a where a.id<>'CREDIT' and upper(a.name)=upper(r.value->>'account')
        order by a.id limit 1
      ) o on true
      where r.value->>lower(g.grade) is not null
    ),'[]'::jsonb));
$$;

create or replace function eco_private.fixture_register_rows(member eco_private.users,p_id uuid default null)
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
          'sourceCancelled',(h.item->>'cancelled')::boolean,'sourceReinstated',state.reinstated,
          'cancelled',a.cancelled_at is not null or ((h.item->>'cancelled')::boolean and not state.reinstated),
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
    cross join lateral (
      select case when a.reinstated_source is null then false
        else coalesce(a.reinstated_source=eco_private.fixture_source_cancellation(h.id),false) end as reinstated
    ) state
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

create or replace function public.eco_list_fixture_register(p_query jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  actor eco_private.users; terms text[]; result jsonb; yr integer; mon integer; page_number integer;
  supplier uuid; buyer uuid; supplier_office text; buyer_office text; show_deleted boolean; compact boolean; page_size integer;
begin
  actor:=eco_private.current_member();
  if exists(select 1 from eco_private.role_previews where user_id=actor.id and session_id::text=auth.jwt()->>'session_id') then
    raise exception 'Shared fixtures are unavailable in preview' using errcode='42501';
  end if;
  perform eco_private.admin_check_keys(p_query,array['year','month','search','page','supplierOffice','supplierTrader','buyerOffice','buyerTrader','deleted','view']);
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
  terms:=regexp_split_to_array(lower(trim(p_query->>'search')), '[[:space:]]+');
  with ledger as materialized (
    select * from eco_private.fixture_register_rows(actor)
  ), office_by_trader as materialized (
    select x.id,coalesce(o.name,'') as name,eco_private.fixture_office_code(o.name) as code
    from (select supplier_id as id from ledger where compact
      union select buyer_id from ledger where compact) x
    join eco_private.users u on u.id=x.id
    left join eco_private.offices o on o.id=u.office_id
  ), visible as materialized (
    select r.*,
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
    select r.id,r.fixture_date,r.pending,r.item,r.supplier_id,r.buyer_id from rows r
    where (yr=0 or extract(year from r.fixture_date)=yr) and (mon=0 or extract(month from r.fixture_date)=mon)
      and (supplier is null or r.supplier_id=supplier) and (buyer is null or r.buyer_id=buyer)
      and (supplier_office is null or r.supplier_code=supplier_office)
      and (buyer_office is null or r.buyer_code=buyer_office)
      and not exists(select 1 from unnest(terms) q(word) where strpos(lower(r.search_text),q.word)=0)
  ), page_rows as (
    select id,fixture_date,pending,case when compact then jsonb_strip_nulls(jsonb_build_object(
      'id',id,'date',fixture_date,'vessel',item->'vessel','imo',item->'imo','eta',item->'eta','etaEnd',item->'etaEnd',
      'supplierTraderId',supplier_id,'buyerTraderId',buyer_id,'hsfo',item->'hsfo','vlsfo',item->'vlsfo','lsmgo',item->'lsmgo',
      'status',item->'status','cancelled',nullif(item->'cancelled','false'::jsonb),
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

create or replace function public.eco_get_fixtures(p_query jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor eco_private.users; booking eco_private.fixture_bookings; detail jsonb;
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
  detail:=eco_private.fixture_details(booking,actor);
  if detail->'cancellation'->'reason'='null'::jsonb then
    detail:=jsonb_set(detail,'{cancellation,reason}','""'::jsonb);
  end if;
  return detail;
end;
$$;

create or replace function eco_private.fixture_editor(p_actor eco_private.users,p_id uuid) returns jsonb
language plpgsql stable set search_path='' as $$
declare row_data record; b eco_private.fixture_bookings; detail jsonb; fields jsonb; lines jsonb; rev integer; offices jsonb;
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
  select jsonb_build_object('supplierOffice',coalesce(so.name,''),'supplierOfficeCode',eco_private.fixture_office_code(so.name),
    'buyerOffice',coalesce(bo.name,''),'buyerOfficeCode',eco_private.fixture_office_code(bo.name)) into offices
  from eco_private.users st left join eco_private.offices so on so.id=st.office_id
  cross join eco_private.users bt left join eco_private.offices bo on bo.id=bt.office_id
  where st.id=row_data.supplier_id and bt.id=row_data.buyer_id;
  return jsonb_build_object(
    'version',md5(jsonb_build_array(coalesce(rev,0),row_data.source_item,fields,row_data.item->'cancelled')::text),
    'item',row_data.item||offices||case when detail is not null then jsonb_build_object('cancellation',detail->'cancellation') else '{}'::jsonb end,
    'fields',fields,'reference',detail->'reference','canConfirm',coalesce((detail->>'canConfirm')::boolean,false),
    'canReinstate',row_data.item->>'cancelled'='true' and row_data.item->>'deleted'='false'
      and (detail is null or eco_private.fixture_can_cancel(b,p_actor)),
    'canCancel',case when detail is null then row_data.item->>'cancelled'='false' and row_data.item->>'deleted'='false'
      else (detail->>'canCancel')::boolean end);
end;
$$;

create function public.eco_change_fixture_cancellation(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  actor eco_private.users; booking eco_private.fixture_bookings; fixture_id uuid;
  imported boolean; cancelled boolean; cancel_it boolean; from_editor boolean; operation text;
  editor jsonb; saved jsonb; previous_cancellation jsonb; source_decision text;
begin
  actor:=eco_private.admin_writable_member();
  perform eco_private.inbox_live(p_input);
  from_editor:=p_input ? 'version';
  perform eco_private.admin_check_keys(p_input,array['action','dataMode','id','requestId',
    case when from_editor then 'version' else 'expectedRevision' end]);
  operation:=p_input->>'action';
  if operation is null or operation not in ('cancel','reinstate') or
    (from_editor and (jsonb_typeof(p_input->'version') is distinct from 'string'
      or (p_input->>'version') !~ '^[a-f0-9]{32}$')) or (not from_editor and
      (jsonb_typeof(p_input->'expectedRevision') is distinct from 'number'
      or (p_input->>'expectedRevision') !~ '^[1-9][0-9]{0,9}$'
      or (p_input->>'expectedRevision')::numeric>2147483646)) then
    raise exception 'Invalid fixture cancellation' using errcode='22023';
  end if;
  cancel_it:=operation='cancel';
  fixture_id:=eco_private.inbox_uuid(p_input,'id');
  select * into booking from eco_private.fixture_bookings b where b.id=fixture_id for update;
  imported:=not found;
  if imported then
    if not from_editor then raise exception 'Fixture cancellation is unavailable' using errcode='42501'; end if;
    perform f.id from eco_private.fixture_history f where f.booking_group_id=fixture_id
      or (f.booking_group_id is null and f.id=fixture_id) order by f.id for no key update;
  elsif not eco_private.fixture_can_cancel(booking,actor) or (not from_editor and
    (booking.confirmed_at is not null or booking.buyer_trader_id<>actor.id)) then
    raise exception 'Fixture cancellation is unavailable' using errcode='42501';
  end if;

  if from_editor then
    editor:=eco_private.fixture_editor(actor,fixture_id);
    cancelled:=(editor->'item'->>'cancelled')::boolean;
    previous_cancellation:=editor->'item'->'cancellation';
  else
    cancelled:=booking.cancelled_at is not null;
    previous_cancellation:=case when cancelled then jsonb_build_object(
      'at',booking.cancelled_at,'by',booking.cancelled_by,'reason',booking.cancellation_reason) end;
  end if;
  saved:=eco_private.admin_request(actor.id,p_input,'fixture-register-'||operation);
  if saved is not null then return saved; end if;

  if cancelled=cancel_it or booking.deleted_at is not null or editor->'item'->>'deleted'='true'
    or (from_editor and p_input->>'version' is distinct from editor->>'version')
    or (not from_editor and booking.revision<>(p_input->>'expectedRevision')::integer) then
    raise exception 'Fixture changed. Reopen it and try again.' using errcode='PT409';
  end if;
  if imported then
    if not cancel_it then source_decision:=eco_private.fixture_source_cancellation(fixture_id); end if;
    insert into eco_private.fixture_history_edits(id) values(fixture_id) on conflict do nothing;
    update eco_private.fixture_history_edits a set revision=a.revision+1,
      cancelled_at=case when cancel_it then clock_timestamp() end,
      cancelled_by=case when cancel_it then actor.id end,cancellation_reason=null,
      reinstated_source=case when cancel_it then a.reinstated_source else source_decision end
    where a.id=fixture_id;
  else
    update eco_private.fixture_bookings b set revision=b.revision+1,
      cancelled_at=case when cancel_it then clock_timestamp() end,
      cancelled_by=case when cancel_it then actor.id end,cancellation_reason=null
    where b.id=fixture_id returning * into booking;
  end if;
  insert into eco_private.administration_events(actor_id,actor_name,target_id,action,details)
    values(actor.id,actor.display_name,fixture_id,'fixture-register-'||operation,
      jsonb_build_object('imported',imported,'previousCancellation',previous_cancellation,'sourceDecision',source_decision));
  return eco_private.admin_finish(actor.id,p_input,jsonb_build_object('id',fixture_id,
    'assignment',case when not imported then eco_private.fixture_assignment(booking) end));
end;
$$;

revoke all on function eco_private.fixture_source_cancellation(uuid) from public,anon,authenticated,service_role;
revoke all on function public.eco_change_fixture_cancellation(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.eco_change_fixture_cancellation(jsonb) to authenticated;
insert into eco_private.platform_versions(component,migration_head) values('fixture-register-refinements','20261125042910');
