-- Server-maintained official facts only. No contacts, addresses, private notes or user awards.
create table eco_private.official_table_snapshots (
 id bigint generated always as identity primary key,
 content_hash text not null unique check(content_hash ~ '^[a-f0-9]{64}$'),
 rows jsonb not null,
 created_at timestamptz not null default now()
);
create table eco_private.official_table_state (
 feed_id text primary key check(feed_id='mpa-singapore-alternative-fuels'),
 snapshot_id bigint references eco_private.official_table_snapshots(id),
 checked_at timestamptz,
 verified_at timestamptz,
 updated_at timestamptz,
 status text not null check(status in ('current','stale','unavailable')),
 failure_reason text check(failure_reason in ('source-unavailable','publication-gap'))
);
alter table eco_private.official_table_snapshots enable row level security;
alter table eco_private.official_table_state enable row level security;
revoke all on eco_private.official_table_snapshots,eco_private.official_table_state from public,anon,authenticated,service_role;
revoke all on sequence eco_private.official_table_snapshots_id_seq from public,anon,authenticated,service_role;

create function eco_private.present_official_table() returns jsonb
language plpgsql stable set search_path='' as $$
declare current_row eco_private.official_table_state; content jsonb; state text;
begin
 select * into current_row from eco_private.official_table_state where feed_id='mpa-singapore-alternative-fuels';
 state:=case when current_row.snapshot_id is null then 'unavailable' when current_row.status='stale' or current_row.verified_at<now()-interval '48 hours' then 'stale' else 'current' end;
 select jsonb_agg(r||jsonb_build_object('checkedAt',to_char(current_row.verified_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) order by ordinal)
 into content from eco_private.official_table_snapshots s cross join lateral jsonb_array_elements(s.rows) with ordinality as entries(r,ordinal) where s.id=current_row.snapshot_id;
 return jsonb_build_object('snapshot',jsonb_build_object('feedId','mpa-singapore-alternative-fuels','status',state,
 'checkedAt',case when current_row.checked_at is not null then to_char(current_row.checked_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
 'updatedAt',case when current_row.updated_at is not null then to_char(current_row.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
 'rows',coalesce(content,'[]'::jsonb))||case when state='current' then '{}'::jsonb else jsonb_build_object('message',case when current_row.failure_reason='publication-gap' then 'MPA releases need review after a gap in verification. Last verified information is shown.' when state='stale' then 'The latest official sources could not be verified. Last verified information is shown.' else 'Official information has not yet been verified.' end) end);
end;$$;
create function eco_private.official_table_snapshot() returns jsonb
language plpgsql security definer set search_path='' as $$
declare member eco_private.users;
begin
 member:=eco_private.current_member();
 if member.deleted_at is not null then raise exception 'Unauthorized' using errcode='28000';end if;
 return eco_private.present_official_table();
end;$$;
create function eco_private.official_table_refresh_context() returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if coalesce(current_setting('role',true),'')<>'service_role' then raise exception 'Service role required' using errcode='42501';end if;
 return eco_private.present_official_table();
end;$$;

create function eco_private.publish_official_table(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare prior eco_private.official_table_state; previous_rows jsonb; content jsonb; r jsonb; old jsonb; stamp timestamptz; day date; i integer:=0; field text; digest text; selected_id bigint; changed boolean;
begin
 if coalesce(current_setting('role',true),'')<>'service_role' then raise exception 'Service role required' using errcode='42501';end if;
 perform eco_private.admin_check_keys(p_input,array['checkedAt','rows','failureReason']);
 perform eco_private.intelligence_text(p_input->'checkedAt',40);
 if not (p_input?'rows') or p_input->>'checkedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' then raise exception 'Invalid official refresh' using errcode='22023';end if;
 stamp:=(p_input->>'checkedAt')::timestamptz;
 if stamp>now()+interval '5 minutes' then raise exception 'Invalid official timestamp' using errcode='22023';end if;
 if p_input?'failureReason' and (p_input->'rows' is distinct from 'null'::jsonb or jsonb_typeof(p_input->'failureReason') is distinct from 'string' or p_input->>'failureReason' not in ('source-unavailable','publication-gap')) then raise exception 'Invalid official failure reason' using errcode='22023';end if;
 perform pg_advisory_xact_lock(1857,211073);
 select * into prior from eco_private.official_table_state where feed_id='mpa-singapore-alternative-fuels';
 if prior.checked_at is not null and stamp<=prior.checked_at then return jsonb_build_object('status','superseded');end if;
 if p_input->'rows'='null'::jsonb then
  insert into eco_private.official_table_state(feed_id,checked_at,status,failure_reason) values('mpa-singapore-alternative-fuels',stamp,'unavailable',coalesce(p_input->>'failureReason','source-unavailable'))
  on conflict(feed_id) do update set checked_at=excluded.checked_at,status=case when eco_private.official_table_state.snapshot_id is null then 'unavailable' else 'stale' end,failure_reason=excluded.failure_reason;
  return jsonb_build_object('status',case when prior.snapshot_id is null then 'unavailable' else 'stale' end);
 end if;
 if jsonb_typeof(p_input->'rows') is distinct from 'array' or jsonb_array_length(p_input->'rows')<>4 or octet_length(p_input::text)>20000 then raise exception 'Invalid official rows' using errcode='22023';end if;
 select rows into previous_rows from eco_private.official_table_snapshots where id=prior.snapshot_id;
 for r in select value from jsonb_array_elements(p_input->'rows') loop
  i:=i+1;
  perform eco_private.admin_check_keys(r,array['id','fuel','position','sourceUrl','sourceTitle','publishedAt','checkedAt','evidenceHash']);
  if r->>'id' is distinct from (array['lng','methanol','ammonia','ethanol'])[i] or r->>'fuel' is distinct from (array['LNG','Methanol','Ammonia','Ethanol'])[i] then raise exception 'Invalid official fuel identity' using errcode='22023';end if;
  perform eco_private.intelligence_text(r->'position',1800);perform eco_private.intelligence_text(r->'sourceTitle',300);perform eco_private.intelligence_text(r->'sourceUrl',2048);
  if r->>'position' ~ '[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}' or r->>'position' ~* '(tel|fax|contact person|email address)[[:space:]]*:' then raise exception 'Official text requires review' using errcode='22023';end if;
  if (i=1 and r->>'sourceUrl' !~ '^https://www\.mpa\.gov\.sg/api/media/[a-f0-9-]+/[A-Za-z0-9%._-]+\.pdf$') or
   (i>1 and r->>'sourceUrl' !~ '^https://www\.mpa\.gov\.sg/media-centre/details/[A-Za-z0-9-]+$') then raise exception 'Unapproved official source' using errcode='22023';end if;
  day:=eco_private.intelligence_date(r->'publishedAt');
  if day>(stamp at time zone 'Asia/Singapore')::date or r->'checkedAt' is distinct from p_input->'checkedAt' or jsonb_typeof(r->'evidenceHash') is distinct from 'string' or r->>'evidenceHash' !~ '^[a-f0-9]{64}$' then raise exception 'Invalid official evidence' using errcode='22023';end if;
  select value into old from jsonb_array_elements(coalesce(previous_rows,'[]')) where value->>'id'=r->>'id';
  if old is not null and day<(old->>'publishedAt')::date then raise exception 'Official source date regressed' using errcode='22023';end if;
 end loop;
 select jsonb_agg(value-'checkedAt' order by ordinal) into content from jsonb_array_elements(p_input->'rows') with ordinality as entries(value,ordinal);
 digest:=encode(sha256(convert_to(content::text,'UTF8')),'hex');
 insert into eco_private.official_table_snapshots(content_hash,rows,created_at) values(digest,content,stamp) on conflict(content_hash) do nothing;
 select id into selected_id from eco_private.official_table_snapshots where content_hash=digest;
 changed:=prior.snapshot_id is distinct from selected_id;
 insert into eco_private.official_table_state(feed_id,snapshot_id,checked_at,verified_at,updated_at,status)
 values('mpa-singapore-alternative-fuels',selected_id,stamp,stamp,stamp,'current')
 on conflict(feed_id) do update set snapshot_id=excluded.snapshot_id,checked_at=excluded.checked_at,verified_at=excluded.verified_at,
 updated_at=case when changed then excluded.updated_at else eco_private.official_table_state.updated_at end,status='current',failure_reason=null;
 return jsonb_build_object('status',case when changed then 'updated' else 'unchanged' end);
end;$$;
create function public.eco_official_table_snapshot() returns jsonb language sql set search_path='' as $$select eco_private.official_table_snapshot();$$;
create function public.eco_official_table_refresh_context() returns jsonb language sql set search_path='' as $$select eco_private.official_table_refresh_context();$$;
create function public.eco_publish_official_table(p_input jsonb) returns jsonb language sql set search_path='' as $$select eco_private.publish_official_table(p_input);$$;
revoke all on function eco_private.present_official_table(),eco_private.official_table_snapshot(),eco_private.official_table_refresh_context(),eco_private.publish_official_table(jsonb),public.eco_official_table_snapshot(),public.eco_official_table_refresh_context(),public.eco_publish_official_table(jsonb) from public,anon,authenticated,service_role;
grant execute on function eco_private.official_table_snapshot(),public.eco_official_table_snapshot() to authenticated;
grant execute on function eco_private.official_table_refresh_context(),eco_private.publish_official_table(jsonb),public.eco_official_table_refresh_context(),public.eco_publish_official_table(jsonb) to service_role;
insert into eco_private.platform_versions(component,migration_head) values('official-tables','20261021073027');
