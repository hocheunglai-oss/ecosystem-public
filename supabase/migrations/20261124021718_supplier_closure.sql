-- Closure is recorded on the supplier identity used by profiles and fixture history.
-- The timestamp is when ECO records the closure.
alter table eco_private.suppliers add column closed_at timestamptz;

create or replace function eco_private.present_supplier(p eco_private.suppliers,p_summary boolean default false) returns jsonb language sql stable set search_path='' as $$
 select (case when p_summary then (p.record-'contacts'-'barges'-'facts'-'sources')||jsonb_build_object('contactCount',(select count(*) from jsonb_array_elements(p.record->'contacts') c where exists(select 1 from jsonb_array_elements(p.record->'sources') s where s->>'id'=c->>'sourceId' and s->>'type' in ('spc','user'))),'bargeCount',jsonb_array_length(p.record->'barges')) else p.record end)||jsonb_build_object('id',p.id,'revision',p.revision,'updatedAt',p.updated_at,'background',p.background,'isClosed',p.closed_at is not null);
$$;

create or replace function eco_private.list_suppliers(p_query jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare q text; country text; grade text; trader text; page integer; lim integer; result jsonb; total bigint;port jsonb;
begin
 perform eco_private.current_member();perform eco_private.admin_check_keys(p_query,array['search','country','grade','trader','page','limit','portId','excludeClosed']);
 if p_query ? 'excludeClosed' and jsonb_typeof(p_query->'excludeClosed') is distinct from 'boolean' then raise exception 'Invalid supplier filter' using errcode='22023';end if;
 perform eco_private.admin_check_text(p_query,'search',0,160);perform eco_private.admin_check_text(p_query,'country',0,2);perform eco_private.admin_check_text(p_query,'grade',0,100);perform eco_private.admin_check_text(p_query,'trader',0,160);
 if jsonb_typeof(p_query->'page') is distinct from 'number' or (p_query->>'page') !~ '^[1-9][0-9]*$' or (p_query->>'page')::numeric>100000 or jsonb_typeof(p_query->'limit') is distinct from 'number' or (p_query->>'limit') !~ '^[1-9][0-9]*$' or (p_query->>'limit')::numeric>100 then raise exception 'Invalid pagination' using errcode='22023';end if;
 if p_query ? 'portId' then
  perform eco_private.admin_check_text(p_query,'portId',1,100);port:=eco_private.supplier_port(p_query->>'portId');
  if port is null then raise exception 'Unknown supplier port' using errcode='22023';end if;
 end if;
 q:=lower(trim(p_query->>'search'));country:=upper(trim(p_query->>'country'));grade:=lower(trim(p_query->>'grade'));trader:=lower(trim(p_query->>'trader'));page:=(p_query->>'page')::integer;lim:=(p_query->>'limit')::integer;
 with matched as materialized (select s.* from eco_private.suppliers s where s.archived_at is null and (country='' or s.country_code=country)
 and (not coalesce((p_query->>'excludeClosed')::boolean,false) or s.closed_at is null)
 and (port is null or (s.country_code=port->>'countryCode' and lower(trim(s.record->>'portName'))=lower(port->>'portName')))
 and (q='' or position(q in lower(s.legal_name||' '||s.short_name||' '||(s.record->'aliases')::text))>0)
 and (grade='' or position(grade in lower(s.record#>>'{info,availableGrade}'))>0)
 and (trader='' or position(trader in lower(s.record#>>'{info,supplierTrader}'))>0)),
 paged as (select * from matched order by legal_name,id limit lim offset (page-1)*lim)
 select (select count(*) from matched),coalesce(jsonb_agg(eco_private.present_supplier(p,true) order by p.legal_name,p.id),'[]'::jsonb) into total,result from paged p;
 return jsonb_build_object('items',result,'page',page,'pageSize',lim,'total',total);
end;$$;

create or replace function eco_private.create_supplier(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor eco_private.users;prior jsonb;rid uuid;sid uuid;item eco_private.suppliers;rec jsonb;source_id text;source jsonb;kind text;rows jsonb;port jsonb;
begin
 actor:=eco_private.admin_writable_member();
 if octet_length(p_input::text)>262144 then raise exception 'Request too large' using errcode='22023';end if;
 perform eco_private.admin_check_keys(p_input,array['requestId','legalName','shortName','countryCode','countryName','portName','background','info','contacts','barges','portId','isClosed']);
 if p_input ? 'isClosed' and jsonb_typeof(p_input->'isClosed') is distinct from 'boolean' then raise exception 'Invalid supplier status' using errcode='22023';end if;
 rid:=eco_private.supplier_uuid(p_input->'requestId');perform eco_private.admin_check_text(p_input,'legalName',1,300);perform eco_private.admin_check_text(p_input,'shortName',1,160);perform eco_private.admin_check_text(p_input,'background',0,8000);
 if p_input ? 'portId' then perform eco_private.admin_check_text(p_input,'portId',1,100);end if;
 port:=eco_private.supplier_port(coalesce(p_input->>'portId','port-singapore'));
 if port is null or p_input->>'countryCode' is distinct from port->>'countryCode' or p_input->>'countryName' is distinct from port->>'countryName' or p_input->>'portName' is distinct from port->>'portName' then raise exception 'Invalid supplier port' using errcode='22023';end if;
 if port->>'countryCode'='SG' and not(actor.is_admin or actor.is_spc_trader) then raise exception 'Supplier authority required' using errcode='42501';end if;
 perform eco_private.supplier_info_check(p_input->'info');perform eco_private.supplier_rows_check(p_input->'contacts','contacts');perform eco_private.supplier_rows_check(p_input->'barges','barges');
 prior:=eco_private.admin_request(actor.id,p_input,'supplier-create');if prior is not null then return prior;end if;
 if exists(select 1 from eco_private.suppliers where archived_at is null and country_code=port->>'countryCode' and (lower(trim(legal_name))=lower(trim(p_input->>'legalName')) or lower(trim(short_name))=lower(trim(p_input->>'shortName')))) then raise exception 'Duplicate supplier name' using errcode='PT409';end if;
 sid:=gen_random_uuid();source_id:='eco-create:'||rid::text;
 source:=jsonb_build_object('id',source_id,'type','user','title',actor.display_name,'url','','documentDate',to_char(now() at time zone 'Asia/Hong_Kong','YYYY-MM-DD'),'retrievedAt',now());
 rec:=jsonb_build_object('id',sid,'legacyIds','[]'::jsonb,'sourceKey','eco:'||rid::text,'legalName',trim(p_input->>'legalName'),'shortName',trim(p_input->>'shortName'),'aliases','[]'::jsonb,'countryCode',port->>'countryCode','countryName',port->>'countryName','portName',port->>'portName','nameStatus','needs-review','legalNameSourceId',source_id,'info',p_input->'info','facts','[]'::jsonb,'sources',jsonb_build_array(source));
 foreach kind in array array['contacts','barges'] loop
  select coalesce(jsonb_agg(jsonb_set(value,'{sourceId}',to_jsonb(source_id))),'[]'::jsonb) into rows from jsonb_array_elements(p_input->kind);
  rec:=jsonb_set(rec,array[kind],rows);
 end loop;
 perform eco_private.supplier_record_check(rec);
 insert into eco_private.suppliers(id,source_key,record,background,closed_at)
 values(sid,rec->>'sourceKey',rec,trim(p_input->>'background'),case when (p_input->>'isClosed')::boolean then now() end) returning * into item;
 insert into eco_private.supplier_revisions(supplier_id,revision,actor_id,reason,snapshot) values(sid,1,actor.id,'create',eco_private.present_supplier(item));
 insert into eco_private.administration_events(actor_id,actor_name,target_id,action,details) values(actor.id,actor.display_name,sid,'supplier-created',jsonb_build_object('revision',1,'shortName',item.short_name,'isClosed',item.closed_at is not null));
 return eco_private.admin_finish(actor.id,p_input,eco_private.present_supplier(item));
end;$$;

create or replace function eco_private.update_supplier(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor eco_private.users; prior jsonb; item eco_private.suppliers; sid uuid; next_record jsonb; row_value jsonb; old_row jsonb; rows jsonb; kind text; source_id text; source jsonb; next_closed_at timestamptz;
begin
 actor:=eco_private.supplier_record_writable_member(eco_private.supplier_uuid(p_input->'id'));if octet_length(p_input::text)>262144 then raise exception 'Request too large' using errcode='22023';end if;perform eco_private.admin_check_keys(p_input,array['requestId','id','revision','info','contacts','barges','legalName','shortName','background','isClosed']);sid:=eco_private.supplier_uuid(p_input->'id');
 if p_input ? 'isClosed' and jsonb_typeof(p_input->'isClosed') is distinct from 'boolean' then raise exception 'Invalid supplier status' using errcode='22023';end if;
 if jsonb_typeof(p_input->'revision') is distinct from 'number' or (p_input->>'revision') !~ '^[1-9][0-9]*$' or (p_input->>'revision')::numeric>2147483647 then raise exception 'Invalid revision' using errcode='22023';end if;
 perform eco_private.supplier_info_check(p_input->'info');perform eco_private.supplier_rows_check(p_input->'contacts','contacts');perform eco_private.supplier_rows_check(p_input->'barges','barges');
 prior:=eco_private.admin_request(actor.id,p_input,'supplier-update');if prior is not null then return prior;end if;
 select * into item from eco_private.suppliers where id=sid and archived_at is null for update;if not found then raise exception 'Unknown supplier' using errcode='22023';end if;
 if item.revision<>(p_input->>'revision')::integer then raise exception 'Revision conflict' using errcode='PT409';end if;
 next_closed_at:=case (p_input->>'isClosed')::boolean
  when true then coalesce(item.closed_at,now())
  when false then null
  else item.closed_at
 end;
 next_record:=jsonb_set(item.record,'{info}',p_input->'info');source_id:='eco-update:'||(p_input->>'requestId');
 foreach kind in array array['contacts','barges'] loop
  rows:='[]'::jsonb;
  for row_value in select value from jsonb_array_elements(p_input->kind) loop
   select value into old_row from jsonb_array_elements(item.record->kind) where value->>'id'=row_value->>'id';
   row_value:=jsonb_set(row_value,'{sourceId}',to_jsonb(case when old_row is not null and (old_row-'sourceId')=(row_value-'sourceId') then old_row->>'sourceId' else source_id end));
   rows:=rows||jsonb_build_array(row_value);
  end loop;
  next_record:=jsonb_set(next_record,array[kind],rows);
 end loop;
 foreach kind in array array['legalName','shortName'] loop
  if p_input ? kind then perform eco_private.admin_check_text(p_input,kind,1,case when kind='shortName' then 160 else 300 end);next_record:=jsonb_set(next_record,array[kind],to_jsonb(trim(p_input->>kind)));end if;
 end loop;
 if next_record->>'legalName'<>item.record->>'legalName' then
  next_record:=next_record||jsonb_build_object('nameStatus','needs-review','legalNameSourceId',source_id);
 end if;
 if p_input ? 'background' then perform eco_private.admin_check_text(p_input,'background',0,8000);end if;
 if exists(select 1 from eco_private.suppliers other where other.id<>sid and other.archived_at is null and other.country_code=item.country_code and (lower(trim(other.legal_name))=lower(next_record->>'legalName') or lower(trim(other.short_name))=lower(next_record->>'shortName'))) then raise exception 'Duplicate supplier name' using errcode='PT409';end if;
 if next_record=item.record and coalesce(p_input->>'background',item.background)=item.background
  and next_closed_at is not distinct from item.closed_at then raise exception 'No changes' using errcode='22023';end if;
 source:=jsonb_build_object('id',source_id,'type','user','title',actor.display_name,'url','','documentDate',to_char(now() at time zone 'Asia/Hong_Kong','YYYY-MM-DD'),'retrievedAt',now());
 -- Retain cited operational sources and all imported evidence. Superseded uncited user sources
 -- remain in immutable revision snapshots rather than growing the current profile indefinitely.
 next_record:=jsonb_set(next_record,'{sources}',coalesce((select jsonb_agg(value) from jsonb_array_elements(next_record->'sources') old_source
  where value->>'type'<>'user' or value->>'id'=next_record->>'legalNameSourceId'
   or exists(select 1 from jsonb_array_elements((next_record->'contacts')||(next_record->'barges')||(next_record->'facts')) cited where cited->>'sourceId'=old_source.value->>'id')),'[]'::jsonb)||jsonb_build_array(source));
 perform eco_private.supplier_record_check(next_record);
 update eco_private.suppliers set record=next_record,background=coalesce(p_input->>'background',background),closed_at=next_closed_at,revision=revision+1,updated_at=now() where id=sid returning * into item;
 insert into eco_private.supplier_revisions(supplier_id,revision,actor_id,reason,snapshot) values(sid,item.revision,actor.id,'update',eco_private.present_supplier(item));
 insert into eco_private.administration_events(actor_id,actor_name,target_id,action,details) values(actor.id,actor.display_name,sid,'supplier-updated',jsonb_build_object('revision',item.revision,'shortName',item.short_name,'isClosed',item.closed_at is not null));
 return eco_private.admin_finish(actor.id,p_input,eco_private.present_supplier(item));
end;$$;

insert into eco_private.platform_versions(component, migration_head) values ('supplier-closure', '20261124021718');
