-- Clean bootstrap for NEW databases only. Never run on an existing ECO database.
-- Original deployment migrations remain unchanged in the private source archive.
DO $$ BEGIN IF to_regnamespace('eco_private') IS NOT NULL THEN RAISE EXCEPTION 'Bootstrap requires an empty ECO schema'; END IF; END $$;

-- BOOTSTRAP SECTION 20261013112302_eco_access_foundation.sql
-- Reviewed initialization SQL for a NEW ECO project only. Not applied to a cloud database.
create schema if not exists eco_private;
revoke all on schema eco_private from public, anon, authenticated;
grant usage on schema eco_private to authenticated, service_role;
alter default privileges in schema eco_private revoke execute on functions from public;

create table eco_private.offices (
  id text primary key check (length(id) between 1 and 80),
  name text not null unique check (length(name) between 1 and 120)
);
create table eco_private.users (
  id uuid primary key references auth.users(id),
  email text not null unique,
  display_name text not null,
  office_id text references eco_private.offices(id),
  is_admin boolean not null default false,
  is_spc_trader boolean not null default false,
  is_manager boolean not null default false,
  is_active boolean not null default false,
  activated_at timestamptz,
  mfa_required boolean not null default false,
  revision integer not null default 1 check (revision > 0),
  source_spc_id uuid unique,
  updated_at timestamptz not null default now()
);
create index eco_users_office on eco_private.users(office_id);
create table eco_private.revoked_sessions (
  session_id uuid primary key,
  user_id uuid not null references eco_private.users(id),
  revoked_at timestamptz not null default now()
);
create index eco_revoked_user on eco_private.revoked_sessions(user_id);
create table eco_private.access_audit (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_id uuid,
  target_id uuid,
  action text not null,
  before_access jsonb,
  after_access jsonb
);
create table eco_private.login_attempts (
  bucket text primary key check (bucket ~ '^[a-f0-9]{64}$'),
  window_started_at timestamptz not null,
  attempts integer not null check (attempts > 0)
);
alter table eco_private.offices enable row level security;
alter table eco_private.users enable row level security;
alter table eco_private.revoked_sessions enable row level security;
alter table eco_private.access_audit enable row level security;
alter table eco_private.login_attempts enable row level security;
revoke all on all tables in schema eco_private from public, anon, authenticated;
revoke all on all sequences in schema eco_private from public, anon, authenticated;

-- New provider identities receive no application access or administrator authority.
create function eco_private.on_auth_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into eco_private.users(id,email,display_name)
  values(new.id,lower(new.email),lower(new.email));
  return new;
end;
$$;
revoke all on function eco_private.on_auth_user() from public, anon, authenticated;
create trigger eco_auth_user_created after insert on auth.users
for each row execute function eco_private.on_auth_user();

create function eco_private.current_member() returns eco_private.users
language plpgsql security definer set search_path = '' as $$
declare member eco_private.users;
begin
  select p.* into member from eco_private.users p
  where p.id = auth.uid() and p.is_active and p.activated_at is not null
    and exists(select 1 from auth.users u where u.id=p.id and u.email_confirmed_at is not null)
    and exists(select 1 from auth.sessions s where s.user_id=p.id
      and s.id::text=auth.jwt()->>'session_id' and (s.not_after is null or s.not_after > now()))
    and not exists(select 1 from eco_private.revoked_sessions r where r.session_id::text=auth.jwt()->>'session_id');
  if not found then raise exception 'Unauthorized' using errcode='28000'; end if;
  if member.mfa_required and coalesce(auth.jwt()->>'aal','') <> 'aal2' then
    raise exception 'Unauthorized' using errcode='28000';
  end if;
  return member;
end;
$$;
create function eco_private.require_admin() returns eco_private.users
language plpgsql security definer set search_path = '' as $$
declare member eco_private.users;
begin
  member := eco_private.current_member();
  if not member.is_admin then raise exception 'Forbidden' using errcode='42501'; end if;
  return member;
end;
$$;
create function eco_private.present_user(p eco_private.users) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id',p.id,'email',p.email,'displayName',p.display_name,
    'officeId',coalesce(p.office_id,''),'officeName',coalesce((select o.name from eco_private.offices o where o.id=p.office_id),''),
    'isAdmin',p.is_admin,'isSpcTrader',p.is_spc_trader,'isManager',p.is_manager,
    'isActive',p.is_active,'activated',p.activated_at is not null,'revision',p.revision);
$$;
create function eco_private.current_user_json() returns jsonb
language sql security definer set search_path = '' as $$
  select eco_private.present_user(eco_private.current_member());
$$;
create function public.eco_current_user() returns jsonb language sql set search_path='' as $$
  select eco_private.current_user_json();
$$;

create function eco_private.list_users() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform eco_private.require_admin();
  return jsonb_build_object(
    'users',coalesce((select jsonb_agg(eco_private.present_user(p) order by p.office_id,p.display_name,p.id) from eco_private.users p),'[]'::jsonb),
    'offices',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'name',o.name) order by o.name) from eco_private.offices o),'[]'::jsonb));
end;
$$;
create function public.eco_list_users() returns jsonb language sql set search_path='' as $$ select eco_private.list_users(); $$;

create function eco_private.update_user(p_update jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor eco_private.users; before_row eco_private.users; after_row eco_private.users;
begin
  -- One stable lock serializes admin continuity AND authorization changes.
  perform pg_catalog.pg_advisory_xact_lock(1857,2026);
  actor := eco_private.require_admin();
  if jsonb_typeof(p_update->'expectedRevision') is distinct from 'number'
    or (p_update->>'expectedRevision') !~ '^[1-9][0-9]*$'
    or jsonb_typeof(p_update->'id') is distinct from 'string'
    or jsonb_typeof(p_update->'displayName') is distinct from 'string'
    or jsonb_typeof(p_update->'officeId') is distinct from 'string'
  then raise exception 'Invalid update' using errcode='22023'; end if;
  select * into before_row from eco_private.users where id=(p_update->>'id')::uuid for update;
  if not found then raise exception 'Unknown user' using errcode='22023'; end if;
  if before_row.revision <> (p_update->>'expectedRevision')::integer then
    raise exception 'Conflict' using errcode='40001';
  end if;
  if jsonb_typeof(p_update->'displayName') <> 'string' or length(trim(p_update->>'displayName')) not between 1 and 120
    or not exists(select 1 from eco_private.offices where id=p_update->>'officeId')
    or jsonb_typeof(p_update->'isAdmin') is distinct from 'boolean'
    or jsonb_typeof(p_update->'isSpcTrader') is distinct from 'boolean'
    or jsonb_typeof(p_update->'isManager') is distinct from 'boolean'
    or jsonb_typeof(p_update->'isActive') is distinct from 'boolean'
  then raise exception 'Invalid update' using errcode='22023'; end if;
  if before_row.id=actor.id and (not (p_update->>'isActive')::boolean or not (p_update->>'isAdmin')::boolean) then
    raise exception 'Cannot remove own administrator access' using errcode='23514';
  end if;
  if before_row.is_admin and before_row.is_active and before_row.activated_at is not null
    and (not (p_update->>'isAdmin')::boolean or not (p_update->>'isActive')::boolean)
    and not exists(select 1 from eco_private.users p where p.id<>before_row.id and p.is_admin and p.is_active and p.activated_at is not null)
  then raise exception 'Final administrator' using errcode='23514'; end if;
  update eco_private.users set display_name=trim(p_update->>'displayName'), office_id=p_update->>'officeId',
    is_admin=(p_update->>'isAdmin')::boolean, is_spc_trader=(p_update->>'isSpcTrader')::boolean,
    is_manager=(p_update->>'isManager')::boolean,is_active=(p_update->>'isActive')::boolean,
    revision=revision+1,updated_at=now() where id=before_row.id returning * into after_row;
  if row(before_row.office_id,before_row.is_admin,before_row.is_spc_trader,before_row.is_manager,before_row.is_active)
    is distinct from row(after_row.office_id,after_row.is_admin,after_row.is_spc_trader,after_row.is_manager,after_row.is_active)
  then
    insert into eco_private.revoked_sessions(session_id,user_id)
      select s.id,s.user_id from auth.sessions s where s.user_id=after_row.id on conflict do nothing;
  end if;
  insert into eco_private.access_audit(actor_id,target_id,action,before_access,after_access)
    values(actor.id,after_row.id,'update-user',eco_private.present_user(before_row),eco_private.present_user(after_row));
  return eco_private.present_user(after_row);
end;
$$;
create function public.eco_update_user(p_update jsonb) returns jsonb language sql set search_path='' as $$ select eco_private.update_user(p_update); $$;

create function eco_private.finish_activation() returns void
language plpgsql security definer set search_path = '' as $$
declare member eco_private.users;
begin
  perform pg_catalog.pg_advisory_xact_lock(1857,2026);
  select p.* into member from eco_private.users p where p.id=auth.uid() and p.is_active
    and exists(select 1 from auth.users u where u.id=p.id and u.email_confirmed_at is not null and coalesce(u.encrypted_password,'')<>'')
    and exists(select 1 from auth.sessions s where s.user_id=p.id and s.id::text=auth.jwt()->>'session_id'
      and (s.not_after is null or s.not_after>now()))
    and not exists(select 1 from eco_private.revoked_sessions r where r.session_id::text=auth.jwt()->>'session_id') for update;
  if not found then raise exception 'Unauthorized' using errcode='28000'; end if;
  update eco_private.users set activated_at=coalesce(activated_at,now()), revision=revision+1, updated_at=now() where id=member.id;
  insert into eco_private.revoked_sessions(session_id,user_id)
    select s.id,s.user_id from auth.sessions s where s.user_id=member.id and s.id::text<>auth.jwt()->>'session_id' on conflict do nothing;
  insert into eco_private.access_audit(actor_id,target_id,action) values(member.id,member.id,'activate-or-recover');
end;
$$;
create function public.eco_finish_activation() returns void language sql set search_path='' as $$ select eco_private.finish_activation(); $$;

create function eco_private.consume_login_attempt(p_bucket text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare used integer;
begin
  if p_bucket !~ '^[a-f0-9]{64}$' then return false; end if;
  insert into eco_private.login_attempts(bucket,window_started_at,attempts) values(p_bucket,now(),1)
  on conflict(bucket) do update set
    attempts=case when eco_private.login_attempts.window_started_at < now()-interval '15 minutes' then 1 else least(eco_private.login_attempts.attempts+1,11) end,
    window_started_at=case when eco_private.login_attempts.window_started_at < now()-interval '15 minutes' then now() else eco_private.login_attempts.window_started_at end
  returning attempts into used;
  return used<=10;
end;
$$;
create function public.eco_consume_login_attempt(p_bucket text) returns boolean language sql set search_path='' as $$ select eco_private.consume_login_attempt(p_bucket); $$;

-- Only a deliberately authorized server-side roster import may provision access.
create function eco_private.provision_user(p_user_id uuid,p_profile jsonb) returns void
language plpgsql security definer set search_path='' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(1857,2026);
  if not exists(select 1 from eco_private.offices where id=p_profile->>'officeId') then raise exception 'Unknown office'; end if;
  update eco_private.users set display_name=p_profile->>'displayName', office_id=p_profile->>'officeId',
    is_admin=coalesce((p_profile->>'isAdmin')::boolean,false),is_spc_trader=coalesce((p_profile->>'isSpcTrader')::boolean,false),
    is_manager=false,is_active=coalesce((p_profile->>'isActive')::boolean,false),source_spc_id=(p_profile->>'sourceSpcId')::uuid
    where id=p_user_id and activated_at is null;
  if not found then raise exception 'Unknown or already activated user'; end if;
  insert into eco_private.access_audit(target_id,action,after_access)
    select id,'provision-user',eco_private.present_user(p) from eco_private.users p where id=p_user_id;
end;
$$;

revoke execute on all functions in schema eco_private from public,anon,authenticated;
grant execute on function eco_private.current_user_json(),eco_private.list_users(),eco_private.update_user(jsonb),eco_private.finish_activation() to authenticated;
grant execute on function eco_private.consume_login_attempt(text),eco_private.provision_user(uuid,jsonb) to service_role;
revoke execute on function public.eco_current_user(),public.eco_list_users(),public.eco_update_user(jsonb),public.eco_finish_activation(),public.eco_consume_login_attempt(text) from public,anon,authenticated;
grant execute on function public.eco_current_user(),public.eco_list_users(),public.eco_update_user(jsonb),public.eco_finish_activation() to authenticated;
grant execute on function public.eco_consume_login_attempt(text) to service_role;


-- BOOTSTRAP SECTION 20261013113144_eco_access_conflict_response.sql
-- Business conflicts must not trigger PostgREST transaction retries.
create or replace function eco_private.update_user(p_update jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor eco_private.users; before_row eco_private.users; after_row eco_private.users;
begin
  -- One stable lock serializes admin continuity AND authorization changes.
  perform pg_catalog.pg_advisory_xact_lock(1857,2026);
  actor := eco_private.require_admin();
  if jsonb_typeof(p_update->'expectedRevision') is distinct from 'number'
    or (p_update->>'expectedRevision') !~ '^[1-9][0-9]*$'
    or jsonb_typeof(p_update->'id') is distinct from 'string'
    or jsonb_typeof(p_update->'displayName') is distinct from 'string'
    or jsonb_typeof(p_update->'officeId') is distinct from 'string'
  then raise exception 'Invalid update' using errcode='22023'; end if;
  select * into before_row from eco_private.users where id=(p_update->>'id')::uuid for update;
  if not found then raise exception 'Unknown user' using errcode='22023'; end if;
  if before_row.revision <> (p_update->>'expectedRevision')::integer then
    raise exception 'Conflict' using errcode='PT409';
  end if;
  if jsonb_typeof(p_update->'displayName') <> 'string' or length(trim(p_update->>'displayName')) not between 1 and 120
    or not exists(select 1 from eco_private.offices where id=p_update->>'officeId')
    or jsonb_typeof(p_update->'isAdmin') is distinct from 'boolean'
    or jsonb_typeof(p_update->'isSpcTrader') is distinct from 'boolean'
    or jsonb_typeof(p_update->'isManager') is distinct from 'boolean'
    or jsonb_typeof(p_update->'isActive') is distinct from 'boolean'
  then raise exception 'Invalid update' using errcode='22023'; end if;
  if before_row.id=actor.id and (not (p_update->>'isActive')::boolean or not (p_update->>'isAdmin')::boolean) then
    raise exception 'Cannot remove own administrator access' using errcode='23514';
  end if;
  if before_row.is_admin and before_row.is_active and before_row.activated_at is not null
    and (not (p_update->>'isAdmin')::boolean or not (p_update->>'isActive')::boolean)
    and not exists(select 1 from eco_private.users p where p.id<>before_row.id and p.is_admin and p.is_active and p.activated_at is not null)
  then raise exception 'Final administrator' using errcode='23514'; end if;
  update eco_private.users set display_name=trim(p_update->>'displayName'), office_id=p_update->>'officeId',
    is_admin=(p_update->>'isAdmin')::boolean, is_spc_trader=(p_update->>'isSpcTrader')::boolean,
    is_manager=(p_update->>'isManager')::boolean,is_active=(p_update->>'isActive')::boolean,
    revision=revision+1,updated_at=now() where id=before_row.id returning * into after_row;
  if row(before_row.office_id,before_row.is_admin,before_row.is_spc_trader,before_row.is_manager,before_row.is_active)
    is distinct from row(after_row.office_id,after_row.is_admin,after_row.is_spc_trader,after_row.is_manager,after_row.is_active)
  then
    insert into eco_private.revoked_sessions(session_id,user_id)
      select s.id,s.user_id from auth.sessions s where s.user_id=after_row.id on conflict do nothing;
  end if;
  insert into eco_private.access_audit(actor_id,target_id,action,before_access,after_access)
    values(actor.id,after_row.id,'update-user',eco_private.present_user(before_row),eco_private.present_user(after_row));
  return eco_private.present_user(after_row);
end;
$$;


-- BOOTSTRAP SECTION 20261014023550_eco_optional_password_change.sql
-- Optional onboarding advice has no bearing on authentication or authorization.
alter table eco_private.users add column password_prompt_dismissed_at timestamptz;

create or replace function eco_private.present_user(p eco_private.users) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id',p.id,'email',p.email,'displayName',p.display_name,
    'officeId',coalesce(p.office_id,''),'officeName',coalesce((select o.name from eco_private.offices o where o.id=p.office_id),''),
    'isAdmin',p.is_admin,'isSpcTrader',p.is_spc_trader,'isManager',p.is_manager,
    'isActive',p.is_active,'activated',p.activated_at is not null,'revision',p.revision,
    'passwordChangeSuggested',p.activated_at is not null and p.password_prompt_dismissed_at is null);
$$;

create function eco_private.dismiss_password_prompt() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare member eco_private.users;
begin
  perform pg_catalog.pg_advisory_xact_lock(1857,2026);
  member := eco_private.current_member();
  if member.password_prompt_dismissed_at is null then
    update eco_private.users set password_prompt_dismissed_at=now(),revision=revision+1,updated_at=now()
      where id=member.id returning * into member;
    insert into eco_private.access_audit(actor_id,target_id,action) values(member.id,member.id,'dismiss-password-prompt');
  end if;
  return eco_private.present_user(member);
end;
$$;
create function public.eco_dismiss_password_prompt() returns jsonb language sql set search_path='' as $$
  select eco_private.dismiss_password_prompt();
$$;
revoke execute on function eco_private.dismiss_password_prompt(),public.eco_dismiss_password_prompt() from public,anon,authenticated;
grant execute on function eco_private.dismiss_password_prompt(),public.eco_dismiss_password_prompt() to authenticated;

-- Revoke prior app sessions before touching provider credentials. This commits separately,
-- so a later provider or completion failure cannot leave the old sessions usable in ECO.
create function eco_private.begin_password_change(p_user_id uuid,p_session_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare member eco_private.users;
begin
  perform pg_catalog.pg_advisory_xact_lock(1857,2026);
  select p.* into member from eco_private.users p where p.id=p_user_id and p.is_active and p.activated_at is not null
    and exists(select 1 from auth.users u where u.id=p.id and u.email_confirmed_at is not null and coalesce(u.encrypted_password,'')<>'')
    and exists(select 1 from auth.sessions s where s.id=p_session_id and s.user_id=p.id and (s.not_after is null or s.not_after>now()))
    and not exists(select 1 from eco_private.revoked_sessions r where r.session_id=p_session_id) for update;
  if not found then raise exception 'Unauthorized' using errcode='28000'; end if;
  insert into eco_private.revoked_sessions(session_id,user_id)
    select s.id,s.user_id from auth.sessions s where s.user_id=member.id and s.id<>p_session_id on conflict do nothing;
  insert into eco_private.access_audit(actor_id,target_id,action) values(member.id,member.id,'begin-password-change');
end;
$$;
create function public.eco_begin_password_change(p_user_id uuid,p_session_id uuid) returns void language sql set search_path='' as $$
  select eco_private.begin_password_change(p_user_id,p_session_id);
$$;
revoke execute on function eco_private.begin_password_change(uuid,uuid),public.eco_begin_password_change(uuid,uuid) from public,anon,authenticated;
grant execute on function eco_private.begin_password_change(uuid,uuid),public.eco_begin_password_change(uuid,uuid) to service_role;

-- Only the server may certify that Supabase accepted a new password.
-- It obtains the session ID from the successful provider reauthentication response.
create function eco_private.complete_password_change(p_user_id uuid,p_session_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare member eco_private.users;
begin
  perform pg_catalog.pg_advisory_xact_lock(1857,2026);
  select p.* into member from eco_private.users p where p.id=p_user_id and p.is_active and p.activated_at is not null
    and exists(select 1 from auth.users u where u.id=p.id and u.email_confirmed_at is not null and coalesce(u.encrypted_password,'')<>'')
    and exists(select 1 from auth.sessions s where s.id=p_session_id and s.user_id=p.id and (s.not_after is null or s.not_after>now()))
    and not exists(select 1 from eco_private.revoked_sessions r where r.session_id=p_session_id) for update;
  if not found then raise exception 'Unauthorized' using errcode='28000'; end if;
  update eco_private.users set password_prompt_dismissed_at=now(),revision=revision+1,updated_at=now()
    where id=member.id returning * into member;
  insert into eco_private.revoked_sessions(session_id,user_id)
    select s.id,s.user_id from auth.sessions s where s.user_id=member.id and s.id<>p_session_id on conflict do nothing;
  insert into eco_private.access_audit(actor_id,target_id,action) values(member.id,member.id,'change-password');
  return eco_private.present_user(member);
end;
$$;
create function public.eco_complete_password_change(p_user_id uuid,p_session_id uuid) returns jsonb language sql set search_path='' as $$
  select eco_private.complete_password_change(p_user_id,p_session_id);
$$;
revoke execute on function eco_private.complete_password_change(uuid,uuid),public.eco_complete_password_change(uuid,uuid) from public,anon,authenticated;
grant execute on function eco_private.complete_password_change(uuid,uuid),public.eco_complete_password_change(uuid,uuid) to service_role;

-- Invite activation/recovery already sets a personal password; do not suggest it again.
create or replace function eco_private.finish_activation() returns void
language plpgsql security definer set search_path = '' as $$
declare member eco_private.users;
begin
  perform pg_catalog.pg_advisory_xact_lock(1857,2026);
  select p.* into member from eco_private.users p where p.id=auth.uid() and p.is_active
    and exists(select 1 from auth.users u where u.id=p.id and u.email_confirmed_at is not null and coalesce(u.encrypted_password,'')<>'')
    and exists(select 1 from auth.sessions s where s.user_id=p.id and s.id::text=auth.jwt()->>'session_id'
      and (s.not_after is null or s.not_after>now()))
    and not exists(select 1 from eco_private.revoked_sessions r where r.session_id::text=auth.jwt()->>'session_id') for update;
  if not found then raise exception 'Unauthorized' using errcode='28000'; end if;
  update eco_private.users set activated_at=coalesce(activated_at,now()),password_prompt_dismissed_at=now(),revision=revision+1,updated_at=now() where id=member.id;
  insert into eco_private.revoked_sessions(session_id,user_id)
    select s.id,s.user_id from auth.sessions s where s.user_id=member.id and s.id::text<>auth.jwt()->>'session_id' on conflict do nothing;
  insert into eco_private.access_audit(actor_id,target_id,action) values(member.id,member.id,'activate-or-recover');
end;
$$;


-- BOOTSTRAP SECTION 20261014035938_eco_admin_user_management.sql
-- ECO-only administrator provisioning and password reset. No provider credentials are copied.
-- Provider calls cannot share a PostgreSQL transaction: the private operation ledger
-- gives them one durable attempt and reconciles the server-written provider marker.
alter table eco_private.users add column phone text not null default ''
  check (phone = '' or phone ~ '^\+[1-9][0-9]{6,14}$');
alter table eco_private.users add column access_hold_request uuid;
create table eco_private.admin_operations (
  request_id uuid primary key,
  actor_id uuid not null references eco_private.users(id),
  target_id uuid not null,
  kind text not null check (kind in ('create-user','reset-password','change-password')),
  input jsonb not null,
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  state text not null check (state in ('pending','complete','failed')),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create unique index eco_admin_operation_pending_target on eco_private.admin_operations(target_id) where state='pending';
create unique index eco_admin_operation_pending_email on eco_private.admin_operations((input->>'email')) where state='pending' and kind='create-user';
alter table eco_private.admin_operations enable row level security;
revoke all on eco_private.admin_operations from public,anon,authenticated;

create or replace function eco_private.present_user(p eco_private.users) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id',p.id,'email',p.email,'displayName',p.display_name,'phone',p.phone,
    'officeId',coalesce(p.office_id,''),'officeName',coalesce((select o.name from eco_private.offices o where o.id=p.office_id),''),
    'isAdmin',p.is_admin,'isSpcTrader',p.is_spc_trader,'isManager',p.is_manager,
    'isActive',p.is_active,'activated',p.activated_at is not null,'revision',p.revision,
    'passwordChangeSuggested',p.activated_at is not null and p.password_prompt_dismissed_at is null);
$$;

create or replace function eco_private.current_member() returns eco_private.users
language plpgsql security definer set search_path = '' as $$
declare member eco_private.users;
begin
  select p.* into member from eco_private.users p
  where p.id = auth.uid() and p.access_hold_request is null and p.is_active and p.activated_at is not null
    and exists(select 1 from auth.users u where u.id=p.id and u.email_confirmed_at is not null)
    and exists(select 1 from auth.sessions s where s.user_id=p.id
      and s.id::text=auth.jwt()->>'session_id' and (s.not_after is null or s.not_after > now()))
    and not exists(select 1 from eco_private.revoked_sessions r where r.session_id::text=auth.jwt()->>'session_id');
  if not found then raise exception 'Unauthorized' using errcode='28000'; end if;
  if member.mfa_required and coalesce(auth.jwt()->>'aal','') <> 'aal2' then
    raise exception 'Unauthorized' using errcode='28000';
  end if;
  return member;
end;
$$;

-- Business conflicts must not trigger PostgREST transaction retries.
create or replace function eco_private.update_user(p_update jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor eco_private.users; before_row eco_private.users; after_row eco_private.users;
begin
  -- One stable lock serializes admin continuity AND authorization changes.
  perform pg_catalog.pg_advisory_xact_lock(1857,2026);
  actor := eco_private.require_admin();
  if jsonb_typeof(p_update->'expectedRevision') is distinct from 'number'
    or (p_update->>'expectedRevision') !~ '^[1-9][0-9]*$'
    or jsonb_typeof(p_update->'id') is distinct from 'string'
    or jsonb_typeof(p_update->'displayName') is distinct from 'string'
    or jsonb_typeof(p_update->'officeId') is distinct from 'string'
  then raise exception 'Invalid update' using errcode='22023'; end if;
  select * into before_row from eco_private.users where id=(p_update->>'id')::uuid for update;
  if not found then raise exception 'Unknown user' using errcode='22023'; end if;
  if before_row.access_hold_request is not null then raise exception 'Account operation pending' using errcode='PT409'; end if;
  if before_row.revision <> (p_update->>'expectedRevision')::integer then
    raise exception 'Conflict' using errcode='PT409';
  end if;
  if jsonb_typeof(p_update->'displayName') <> 'string' or length(trim(p_update->>'displayName')) not between 1 and 120
    or not exists(select 1 from eco_private.offices where id=p_update->>'officeId')
    or jsonb_typeof(p_update->'isAdmin') is distinct from 'boolean'
    or jsonb_typeof(p_update->'isSpcTrader') is distinct from 'boolean'
    or jsonb_typeof(p_update->'isManager') is distinct from 'boolean'
    or jsonb_typeof(p_update->'isActive') is distinct from 'boolean'
  then raise exception 'Invalid update' using errcode='22023'; end if;
  if p_update ? 'phone' and (jsonb_typeof(p_update->'phone') is distinct from 'string' or (p_update->>'phone' <> '' and p_update->>'phone' !~ '^\+[1-9][0-9]{6,14}$')) then raise exception 'Invalid phone' using errcode='22023'; end if;
  if before_row.id=actor.id and (not (p_update->>'isActive')::boolean or not (p_update->>'isAdmin')::boolean) then
    raise exception 'Cannot remove own administrator access' using errcode='23514';
  end if;
  if before_row.is_admin and before_row.is_active and before_row.activated_at is not null
    and (not (p_update->>'isAdmin')::boolean or not (p_update->>'isActive')::boolean)
    and not exists(select 1 from eco_private.users p where p.id<>before_row.id and p.is_admin and p.is_active and p.activated_at is not null)
  then raise exception 'Final administrator' using errcode='23514'; end if;
  update eco_private.users set phone=case when p_update ? 'phone' then p_update->>'phone' else phone end, display_name=trim(p_update->>'displayName'), office_id=p_update->>'officeId',
    is_admin=(p_update->>'isAdmin')::boolean, is_spc_trader=(p_update->>'isSpcTrader')::boolean,
    is_manager=(p_update->>'isManager')::boolean,is_active=(p_update->>'isActive')::boolean,
    revision=revision+1,updated_at=now() where id=before_row.id returning * into after_row;
  if row(before_row.office_id,before_row.is_admin,before_row.is_spc_trader,before_row.is_manager,before_row.is_active)
    is distinct from row(after_row.office_id,after_row.is_admin,after_row.is_spc_trader,after_row.is_manager,after_row.is_active)
  then
    insert into eco_private.revoked_sessions(session_id,user_id)
      select s.id,s.user_id from auth.sessions s where s.user_id=after_row.id on conflict do nothing;
  end if;
  insert into eco_private.access_audit(actor_id,target_id,action,before_access,after_access)
    values(actor.id,after_row.id,'update-user',eco_private.present_user(before_row),eco_private.present_user(after_row));
  return eco_private.present_user(after_row);
end;
$$;


-- Legacy two-argument operations stay available until the old gateway is retired.
create or replace function eco_private.begin_password_change(p_user_id uuid,p_session_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare member eco_private.users;
begin
  perform pg_catalog.pg_advisory_xact_lock(1857,2026);
  select p.* into member from eco_private.users p where p.id=p_user_id and p.access_hold_request is null and p.is_active and p.activated_at is not null
    and exists(select 1 from auth.users u where u.id=p.id and u.email_confirmed_at is not null and coalesce(u.encrypted_password,'')<>'')
    and exists(select 1 from auth.sessions s where s.id=p_session_id and s.user_id=p.id and (s.not_after is null or s.not_after>now()))
    and not exists(select 1 from eco_private.revoked_sessions r where r.session_id=p_session_id) for update;
  if not found then raise exception 'Unauthorized' using errcode='28000'; end if;
  insert into eco_private.revoked_sessions(session_id,user_id)
    select s.id,s.user_id from auth.sessions s where s.user_id=member.id and s.id<>p_session_id on conflict do nothing;
  insert into eco_private.access_audit(actor_id,target_id,action) values(member.id,member.id,'begin-password-change');
end;
$$;

create or replace function eco_private.complete_password_change(p_user_id uuid,p_session_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare member eco_private.users;
begin
  perform pg_catalog.pg_advisory_xact_lock(1857,2026);
  select p.* into member from eco_private.users p where p.id=p_user_id and p.access_hold_request is null and p.is_active and p.activated_at is not null
    and exists(select 1 from auth.users u where u.id=p.id and u.email_confirmed_at is not null and coalesce(u.encrypted_password,'')<>'')
    and exists(select 1 from auth.sessions s where s.id=p_session_id and s.user_id=p.id and (s.not_after is null or s.not_after>now()))
    and not exists(select 1 from eco_private.revoked_sessions r where r.session_id=p_session_id) for update;
  if not found then raise exception 'Unauthorized' using errcode='28000'; end if;
  update eco_private.users set password_prompt_dismissed_at=now(),revision=revision+1,updated_at=now()
    where id=member.id returning * into member;
  insert into eco_private.revoked_sessions(session_id,user_id)
    select s.id,s.user_id from auth.sessions s where s.user_id=member.id and s.id<>p_session_id on conflict do nothing;
  insert into eco_private.access_audit(actor_id,target_id,action) values(member.id,member.id,'change-password');
  return eco_private.present_user(member);
end;
$$;

-- One durable fence spans each self-service provider mutation. The same user row
-- is locked by administrator operations, so neither path can overtake the other.
create function eco_private.start_password_change(p_user_id uuid,p_session_id uuid,p_activation boolean) returns void
language plpgsql security definer set search_path='' as $$
declare member eco_private.users;
begin
  perform pg_catalog.pg_advisory_xact_lock(1857,2026);
  select p.* into member from eco_private.users p where p.id=p_user_id and p.access_hold_request is null and p.is_active
    and (p.activated_at is not null or p_activation)
    and exists(select 1 from auth.users u where u.id=p.id and u.email_confirmed_at is not null and (coalesce(u.encrypted_password,'')<>'' or p_activation))
    and exists(select 1 from auth.sessions s where s.id=p_session_id and s.user_id=p.id and (s.not_after is null or s.not_after>now()))
    and not exists(select 1 from eco_private.revoked_sessions r where r.session_id=p_session_id) for update;
  if not found then raise exception 'Unauthorized or credential operation pending' using errcode='28000'; end if;
  insert into eco_private.admin_operations(request_id,actor_id,target_id,kind,input,fingerprint,state)
    values(p_session_id,p_user_id,p_user_id,'change-password',jsonb_build_object('activation',p_activation),repeat('0',64),'pending');
  update eco_private.users set access_hold_request=p_session_id where id=p_user_id;
  insert into eco_private.revoked_sessions(session_id,user_id)
    select s.id,s.user_id from auth.sessions s where s.user_id=member.id and s.id<>p_session_id on conflict do nothing;
  insert into eco_private.access_audit(actor_id,target_id,action,after_access)
    values(member.id,member.id,'begin-password-change',jsonb_build_object('requestId',p_session_id,'activation',p_activation));
end;
$$;
revoke execute on function eco_private.start_password_change(uuid,uuid,boolean) from public,anon,authenticated;

create function eco_private.begin_password_change_v2(p_user_id uuid,p_session_id uuid) returns void
language sql security definer set search_path='' as $$ select eco_private.start_password_change(p_user_id,p_session_id,false); $$;
create function public.eco_begin_password_change_v2(p_user_id uuid,p_session_id uuid) returns void
language sql set search_path='' as $$ select eco_private.begin_password_change_v2(p_user_id,p_session_id); $$;
revoke execute on function eco_private.begin_password_change_v2(uuid,uuid),public.eco_begin_password_change_v2(uuid,uuid) from public,anon,authenticated;
grant execute on function eco_private.begin_password_change_v2(uuid,uuid),public.eco_begin_password_change_v2(uuid,uuid) to service_role;

create function eco_private.begin_password_activation(p_user_id uuid,p_session_id uuid) returns void
language sql security definer set search_path='' as $$ select eco_private.start_password_change(p_user_id,p_session_id,true); $$;
create function public.eco_begin_password_activation(p_user_id uuid,p_session_id uuid) returns void
language sql set search_path='' as $$ select eco_private.begin_password_activation(p_user_id,p_session_id); $$;
revoke execute on function eco_private.begin_password_activation(uuid,uuid),public.eco_begin_password_activation(uuid,uuid) from public,anon,authenticated;
grant execute on function eco_private.begin_password_activation(uuid,uuid),public.eco_begin_password_activation(uuid,uuid) to service_role;

create function eco_private.finish_password_change(p_user_id uuid,p_request_id uuid,p_session_id uuid,p_require_marker boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare member eco_private.users; op eco_private.admin_operations;
begin
  perform pg_catalog.pg_advisory_xact_lock(1857,2026);
  select * into op from eco_private.admin_operations where request_id=p_request_id and actor_id=p_user_id and target_id=p_user_id and kind='change-password' for update;
  if not found or op.state='failed' then raise exception 'Unauthorized password operation' using errcode='28000'; end if;
  select p.* into member from eco_private.users p where p.id=p_user_id and p.is_active
    and (p.access_hold_request=p_request_id or (op.state='complete' and p.access_hold_request is null))
    and (p.activated_at is not null or (op.input->>'activation')::boolean)
    and exists(select 1 from auth.users u where u.id=p.id and u.email_confirmed_at is not null and coalesce(u.encrypted_password,'')<>'')
    and exists(select 1 from auth.sessions s where s.id=p_session_id and s.user_id=p.id and (s.not_after is null or s.not_after>now()))
    and not exists(select 1 from eco_private.revoked_sessions r where r.session_id=p_session_id) for update;
  if not found then raise exception 'Unauthorized' using errcode='28000'; end if;
  if p_require_marker and not exists(select 1 from auth.users u where u.id=p_user_id and u.raw_app_meta_data->>'eco_access_change_request'=p_request_id::text) then raise exception 'Provider success not confirmed' using errcode='PT409'; end if;
  if op.state='complete' then return eco_private.present_user(member); end if;
  -- Only the server calls this after a confirmed successful provider response.
  -- Retain the old two-argument RPC contract for an additive deployment.
  update eco_private.users set access_hold_request=null,activated_at=coalesce(activated_at,now()),
    password_prompt_dismissed_at=now(),revision=revision+1,updated_at=now()
    where id=member.id returning * into member;
  insert into eco_private.revoked_sessions(session_id,user_id)
    select s.id,s.user_id from auth.sessions s where s.user_id=member.id and s.id<>p_session_id on conflict do nothing;
  insert into eco_private.access_audit(actor_id,target_id,action)
    values(member.id,member.id,case when (op.input->>'activation')::boolean then 'activate-or-recover' else 'change-password' end);
  update eco_private.admin_operations set state='complete',completed_at=now() where request_id=p_request_id;
  return eco_private.present_user(member);
end;
$$;

revoke execute on function eco_private.finish_password_change(uuid,uuid,uuid,boolean) from public,anon,authenticated;
create function eco_private.complete_password_change_v2(p_user_id uuid,p_request_id uuid,p_session_id uuid) returns jsonb
language sql security definer set search_path='' as $$ select eco_private.finish_password_change(p_user_id,p_request_id,p_session_id,true); $$;
create function public.eco_complete_password_change_v2(p_user_id uuid,p_request_id uuid,p_session_id uuid) returns jsonb
language sql set search_path='' as $$ select eco_private.complete_password_change_v2(p_user_id,p_request_id,p_session_id); $$;
revoke execute on function eco_private.complete_password_change_v2(uuid,uuid,uuid),public.eco_complete_password_change_v2(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function eco_private.complete_password_change_v2(uuid,uuid,uuid),public.eco_complete_password_change_v2(uuid,uuid,uuid) to service_role;

create function eco_private.fail_password_change(p_user_id uuid,p_session_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare op eco_private.admin_operations;
begin
  perform pg_catalog.pg_advisory_xact_lock(1857,2026);
  select * into op from eco_private.admin_operations where request_id=p_session_id and actor_id=p_user_id and target_id=p_user_id and kind='change-password' and state='pending' for update;
  if not found then raise exception 'Request conflict' using errcode='PT409'; end if;
  if not exists(select 1 from auth.sessions s where s.id=p_session_id and s.user_id=p_user_id and (s.not_after is null or s.not_after>now()))
    or exists(select 1 from eco_private.revoked_sessions r where r.session_id=p_session_id)
    then raise exception 'Unauthorized' using errcode='28000'; end if;
  if exists(select 1 from auth.users u where u.id=p_user_id and u.raw_app_meta_data->>'eco_access_change_request'=p_session_id::text)
    then raise exception 'Provider operation already succeeded' using errcode='PT409'; end if;
  update eco_private.users set access_hold_request=null where id=p_user_id and access_hold_request=p_session_id;
  update eco_private.admin_operations set state='failed',completed_at=now() where request_id=p_session_id;
  insert into eco_private.access_audit(actor_id,target_id,action,after_access)
    values(p_user_id,p_user_id,'failed-change-password',jsonb_build_object('requestId',p_session_id));
end;
$$;
create function public.eco_fail_password_change(p_user_id uuid,p_session_id uuid) returns void
language sql set search_path='' as $$ select eco_private.fail_password_change(p_user_id,p_session_id); $$;
revoke execute on function eco_private.fail_password_change(uuid,uuid),public.eco_fail_password_change(uuid,uuid) from public,anon,authenticated;
grant execute on function eco_private.fail_password_change(uuid,uuid),public.eco_fail_password_change(uuid,uuid) to service_role;


create or replace function eco_private.finish_activation() returns void
language plpgsql security definer set search_path = '' as $$
declare member eco_private.users;
begin
  perform pg_catalog.pg_advisory_xact_lock(1857,2026);
  select p.* into member from eco_private.users p where p.id=auth.uid() and p.access_hold_request is null and p.is_active
    and exists(select 1 from auth.users u where u.id=p.id and u.email_confirmed_at is not null and coalesce(u.encrypted_password,'')<>'')
    and exists(select 1 from auth.sessions s where s.user_id=p.id and s.id::text=auth.jwt()->>'session_id'
      and (s.not_after is null or s.not_after>now()))
    and not exists(select 1 from eco_private.revoked_sessions r where r.session_id::text=auth.jwt()->>'session_id') for update;
  if not found then raise exception 'Unauthorized' using errcode='28000'; end if;
  update eco_private.users set activated_at=coalesce(activated_at,now()),password_prompt_dismissed_at=now(),revision=revision+1,updated_at=now() where id=member.id;
  insert into eco_private.revoked_sessions(session_id,user_id)
    select s.id,s.user_id from auth.sessions s where s.user_id=member.id and s.id::text<>auth.jwt()->>'session_id' on conflict do nothing;
  insert into eco_private.access_audit(actor_id,target_id,action) values(member.id,member.id,'activate-or-recover');
end;
$$;

-- Called only by service_role with the session ID from fresh provider reauthentication.
create function eco_private.require_admin_session(p_actor_id uuid,p_session_id uuid) returns eco_private.users
language plpgsql security definer set search_path='' as $$
declare actor eco_private.users;
begin
  select p.* into actor from eco_private.users p where p.id=p_actor_id and p.is_active and p.is_admin
    and p.activated_at is not null and p.access_hold_request is null and not p.mfa_required
    and exists(select 1 from auth.users u where u.id=p.id and u.email_confirmed_at is not null)
    and exists(select 1 from auth.sessions s where s.id=p_session_id and s.user_id=p.id and (s.not_after is null or s.not_after>now()))
    and not exists(select 1 from eco_private.revoked_sessions r where r.session_id=p_session_id);
  if not found then raise exception 'Unauthorized administrator' using errcode='42501'; end if;
  return actor;
end;
$$;

create function eco_private.begin_admin_operation(p_actor_id uuid,p_session_id uuid,p_request_id uuid,p_kind text,p_input jsonb,p_fingerprint text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare op eco_private.admin_operations; target eco_private.users; target_id uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(1857,2026);
  perform eco_private.require_admin_session(p_actor_id,p_session_id);
  if p_request_id is null or p_kind not in ('create-user','reset-password') or p_kind is null
    or p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$' or jsonb_typeof(p_input) is distinct from 'object'
  then raise exception 'Invalid operation' using errcode='22023'; end if;
  select * into op from eco_private.admin_operations where request_id=p_request_id for update;
  if found then
    if op.actor_id<>p_actor_id or op.kind<>p_kind or op.input is distinct from p_input or op.fingerprint<>p_fingerprint
      then raise exception 'Request conflict' using errcode='PT409'; end if;
    return jsonb_build_object('state',op.state,'targetId',op.target_id,'runProvider',false,
      'user',case when op.state='complete' then (select eco_private.present_user(u) from eco_private.users u where u.id=op.target_id) else null end);
  end if;
  if p_kind='create-user' then
    if jsonb_typeof(p_input->'email') is distinct from 'string' or length(p_input->>'email') not between 3 and 254
      or p_input->>'email' !~ '^[^[:space:]<>@]+@[^[:space:]<>@]+\.[^[:space:]<>@]+$'
      or p_input->>'email' <> lower(p_input->>'email')
      or jsonb_typeof(p_input->'displayName') is distinct from 'string' or length(trim(p_input->>'displayName')) not between 1 and 120
      or p_input->>'displayName' ~ '[[:cntrl:]]'
      or jsonb_typeof(p_input->'phone') is distinct from 'string'
      or (p_input->>'phone' <> '' and p_input->>'phone' !~ '^\+[1-9][0-9]{6,14}$')
      or not exists(select 1 from eco_private.offices where id=p_input->>'officeId')
      or jsonb_typeof(p_input->'isAdmin') is distinct from 'boolean'
      or jsonb_typeof(p_input->'isManager') is distinct from 'boolean'
      or jsonb_typeof(p_input->'isSpcTrader') is distinct from 'boolean'
      or jsonb_typeof(p_input->'isActive') is distinct from 'boolean'
    then raise exception 'Invalid user information' using errcode='22023'; end if;
    if exists(select 1 from auth.users where lower(email)=p_input->>'email')
      or exists(select 1 from eco_private.admin_operations where kind='create-user' and state='pending' and input->>'email'=p_input->>'email')
    then raise exception 'Duplicate user email' using errcode='23505'; end if;
    target_id:=gen_random_uuid();
  else
    if jsonb_typeof(p_input->'id') is distinct from 'string' or p_input->>'id' !~ '^[0-9a-f-]{36}$'
      or jsonb_typeof(p_input->'expectedRevision') is distinct from 'number' or p_input->>'expectedRevision' !~ '^[1-9][0-9]*$'
    then raise exception 'Invalid reset' using errcode='22023'; end if;
    target_id:=(p_input->>'id')::uuid;
    if target_id=p_actor_id then raise exception 'Use own password change' using errcode='22023'; end if;
    select * into target from eco_private.users where id=target_id for update;
    if not found then raise exception 'Unknown user' using errcode='22023'; end if;
    if target.access_hold_request is not null or target.revision<>(p_input->>'expectedRevision')::integer
    then raise exception 'User conflict' using errcode='PT409'; end if;
    -- Hold admission so old-password login cannot create a fresh usable session while
    -- the provider request is in flight or its outcome remains unknown.
    update eco_private.users set access_hold_request=p_request_id where id=target_id;
    insert into eco_private.revoked_sessions(session_id,user_id)
      select s.id,s.user_id from auth.sessions s where s.user_id=target_id on conflict do nothing;
  end if;
  insert into eco_private.admin_operations(request_id,actor_id,target_id,kind,input,fingerprint,state)
    values(p_request_id,p_actor_id,target_id,p_kind,p_input,p_fingerprint,'pending');
  insert into eco_private.access_audit(actor_id,target_id,action,after_access)
    values(p_actor_id,target_id,'begin-'||p_kind,jsonb_build_object('requestId',p_request_id));
  return jsonb_build_object('state','pending','targetId',target_id,'runProvider',true);
end;
$$;

create function eco_private.complete_admin_operation(p_actor_id uuid,p_session_id uuid,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare op eco_private.admin_operations; target eco_private.users; before_row eco_private.users; marker text;
begin
  perform pg_catalog.pg_advisory_xact_lock(1857,2026);
  perform eco_private.require_admin_session(p_actor_id,p_session_id);
  select * into op from eco_private.admin_operations where request_id=p_request_id and actor_id=p_actor_id for update;
  if not found or op.state='failed' then raise exception 'Request conflict' using errcode='PT409'; end if;
  select * into before_row from eco_private.users where id=op.target_id for update;
  if not found then raise exception 'Provider outcome pending' using errcode='PT409'; end if;
  if op.state='complete' then return eco_private.present_user(before_row); end if;
  marker:=case op.kind when 'create-user' then 'eco_access_create_request' when 'change-password' then 'eco_access_change_request' else 'eco_access_reset_request' end;
  if not exists(select 1 from auth.users u where u.id=op.target_id and u.raw_app_meta_data->>marker=p_request_id::text
    and u.email_confirmed_at is not null and coalesce(u.encrypted_password,'')<>'')
  then raise exception 'Provider outcome pending' using errcode='PT409'; end if;
  if op.kind='create-user' then
    if before_row.email<>op.input->>'email' or before_row.activated_at is not null or before_row.is_active or before_row.is_admin
      or before_row.revision<>1 then raise exception 'User conflict' using errcode='PT409'; end if;
    update eco_private.users set display_name=op.input->>'displayName',phone=op.input->>'phone',office_id=op.input->>'officeId',
      is_admin=(op.input->>'isAdmin')::boolean,is_manager=(op.input->>'isManager')::boolean,
      is_spc_trader=(op.input->>'isSpcTrader')::boolean,is_active=(op.input->>'isActive')::boolean,
      activated_at=now(),password_prompt_dismissed_at=null,revision=revision+1,updated_at=now()
      where id=op.target_id returning * into target;
  else
    if before_row.access_hold_request is distinct from p_request_id or before_row.revision<>(op.input->>'expectedRevision')::integer
      then raise exception 'User conflict' using errcode='PT409'; end if;
    -- Keep active/office/role flags unchanged, including for a suspended account.
    update eco_private.users set access_hold_request=null,activated_at=coalesce(activated_at,now()),
      password_prompt_dismissed_at=null,revision=revision+1,updated_at=now()
      where id=op.target_id returning * into target;
  end if;
  insert into eco_private.revoked_sessions(session_id,user_id)
    select s.id,s.user_id from auth.sessions s where s.user_id=op.target_id on conflict do nothing;
  insert into eco_private.access_audit(actor_id,target_id,action,before_access,after_access)
    values(p_actor_id,op.target_id,op.kind,eco_private.present_user(before_row),eco_private.present_user(target));
  update eco_private.admin_operations set state='complete',completed_at=now() where request_id=p_request_id;
  return eco_private.present_user(target);
end;
$$;

-- Used only after a definite 4xx rejection, never a timeout or server failure.
create function eco_private.fail_admin_operation(p_actor_id uuid,p_session_id uuid,p_request_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare op eco_private.admin_operations; marker text;
begin
  perform pg_catalog.pg_advisory_xact_lock(1857,2026);
  perform eco_private.require_admin_session(p_actor_id,p_session_id);
  select * into op from eco_private.admin_operations where request_id=p_request_id and actor_id=p_actor_id for update;
  if not found or op.state<>'pending' then raise exception 'Request conflict' using errcode='PT409'; end if;
  marker:=case op.kind when 'create-user' then 'eco_access_create_request' when 'change-password' then 'eco_access_change_request' else 'eco_access_reset_request' end;
  if exists(select 1 from auth.users u where u.id=op.target_id and u.raw_app_meta_data->>marker=p_request_id::text)
    then raise exception 'Provider operation already succeeded' using errcode='PT409'; end if;
  update eco_private.users set access_hold_request=null where id=op.target_id and access_hold_request=p_request_id;
  update eco_private.admin_operations set state='failed',completed_at=now() where request_id=p_request_id;
  insert into eco_private.access_audit(actor_id,target_id,action,after_access)
    values(p_actor_id,op.target_id,'failed-'||op.kind,jsonb_build_object('requestId',p_request_id));
end;
$$;

create function public.eco_begin_admin_operation(p_actor_id uuid,p_session_id uuid,p_request_id uuid,p_kind text,p_input jsonb,p_fingerprint text) returns jsonb language sql set search_path='' as $$ select eco_private.begin_admin_operation(p_actor_id,p_session_id,p_request_id,p_kind,p_input,p_fingerprint); $$;
revoke execute on function eco_private.begin_admin_operation(uuid,uuid,uuid,text,jsonb,text),public.eco_begin_admin_operation(uuid,uuid,uuid,text,jsonb,text) from public,anon,authenticated;
grant execute on function eco_private.begin_admin_operation(uuid,uuid,uuid,text,jsonb,text),public.eco_begin_admin_operation(uuid,uuid,uuid,text,jsonb,text) to service_role;

create function public.eco_complete_admin_operation(p_actor_id uuid,p_session_id uuid,p_request_id uuid) returns jsonb language sql set search_path='' as $$ select eco_private.complete_admin_operation(p_actor_id,p_session_id,p_request_id); $$;
revoke execute on function eco_private.complete_admin_operation(uuid,uuid,uuid),public.eco_complete_admin_operation(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function eco_private.complete_admin_operation(uuid,uuid,uuid),public.eco_complete_admin_operation(uuid,uuid,uuid) to service_role;

create function public.eco_fail_admin_operation(p_actor_id uuid,p_session_id uuid,p_request_id uuid) returns void language sql set search_path='' as $$ select eco_private.fail_admin_operation(p_actor_id,p_session_id,p_request_id); $$;
revoke execute on function eco_private.fail_admin_operation(uuid,uuid,uuid),public.eco_fail_admin_operation(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function eco_private.fail_admin_operation(uuid,uuid,uuid),public.eco_fail_admin_operation(uuid,uuid,uuid) to service_role;

revoke execute on function eco_private.require_admin_session(uuid,uuid) from public,anon,authenticated;

-- Exceptional operator recovery only. There is deliberately no browser/API route.
-- Before calling, an operator must reconcile the provider request, confirm it is no
-- longer running, and include an incident/reconciliation reference in p_reason.
-- The ten-minute minimum is an additional guard, not proof that a remote call ended.
create function eco_private.abandon_admin_operation(p_request_id uuid,p_reason text) returns void
language plpgsql security definer set search_path='' as $$
declare op eco_private.admin_operations; marker text;
begin
  perform pg_catalog.pg_advisory_xact_lock(1857,2026);
  if p_reason is null or length(trim(p_reason)) not between 20 and 500 then raise exception 'Reconciliation reason required' using errcode='22023'; end if;
  select * into op from eco_private.admin_operations where request_id=p_request_id for update;
  if not found or op.state<>'pending' or op.created_at>now()-interval '10 minutes'
    then raise exception 'Operation not recoverable yet' using errcode='PT409'; end if;
  marker:=case op.kind when 'create-user' then 'eco_access_create_request' when 'change-password' then 'eco_access_change_request' else 'eco_access_reset_request' end;
  if exists(select 1 from auth.users u where u.id=op.target_id and
      (u.raw_app_meta_data->>marker=p_request_id::text or op.kind='create-user'))
    then raise exception 'Provider identity exists; reconcile completion instead' using errcode='PT409'; end if;
  insert into eco_private.revoked_sessions(session_id,user_id)
    select s.id,s.user_id from auth.sessions s where s.user_id=op.target_id on conflict do nothing;
  update eco_private.users set access_hold_request=null where id=op.target_id and access_hold_request=p_request_id;
  update eco_private.admin_operations set state='failed',completed_at=now() where request_id=p_request_id;
  insert into eco_private.access_audit(target_id,action,after_access)
    values(op.target_id,'operator-abandon-'||op.kind,jsonb_build_object('requestId',p_request_id,'reason',trim(p_reason)));
end;
$$;
create function public.eco_abandon_admin_operation(p_request_id uuid,p_reason text) returns void language sql set search_path='' as $$
  select eco_private.abandon_admin_operation(p_request_id,p_reason);
$$;
revoke execute on function eco_private.abandon_admin_operation(uuid,text),public.eco_abandon_admin_operation(uuid,text) from public,anon,authenticated;
grant execute on function eco_private.abandon_admin_operation(uuid,text),public.eco_abandon_admin_operation(uuid,text) to service_role;

-- Exceptional resolution after a verified provider success when the original
-- approver/session can no longer finalize (for example demotion or suspension).
-- Service-only: an operator must confirm the request ended, inspect the current
-- user state, and record their identity plus an approval/incident reference in
-- p_reason. No provider write is retried. This function never replays stale role
-- grants: pending creates resolve INACTIVE with zero privileges; password changes
-- preserve the target's current roles, office and active flag.
create function eco_private.reconcile_admin_operation(p_request_id uuid,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare op eco_private.admin_operations; before_row eco_private.users; target eco_private.users; marker text;
begin
  perform pg_catalog.pg_advisory_xact_lock(1857,2026);
  if p_reason is null or length(trim(p_reason)) not between 20 and 500 then raise exception 'Reconciliation approval required' using errcode='22023'; end if;
  select * into op from eco_private.admin_operations where request_id=p_request_id for update;
  if not found or op.state<>'pending' or op.created_at>now()-interval '10 minutes'
    then raise exception 'Operation not recoverable yet' using errcode='PT409'; end if;
  marker:=case op.kind when 'create-user' then 'eco_access_create_request' when 'change-password' then 'eco_access_change_request' else 'eco_access_reset_request' end;
  if not exists(select 1 from auth.users u where u.id=op.target_id and u.raw_app_meta_data->>marker=p_request_id::text
    and u.email_confirmed_at is not null and coalesce(u.encrypted_password,'')<>'')
    then raise exception 'Provider success not confirmed' using errcode='PT409'; end if;
  select * into before_row from eco_private.users where id=op.target_id for update;
  if not found then raise exception 'Unknown target' using errcode='22023'; end if;
  if op.kind='create-user' then
    if before_row.activated_at is not null or before_row.email<>op.input->>'email' then raise exception 'User conflict' using errcode='PT409'; end if;
    update eco_private.users set display_name=op.input->>'displayName',phone=op.input->>'phone',office_id=op.input->>'officeId',
      activated_at=now(),password_prompt_dismissed_at=null,is_active=false,is_admin=false,is_manager=false,is_spc_trader=false,
      access_hold_request=null,revision=revision+1,updated_at=now() where id=op.target_id returning * into target;
    update eco_private.admin_operations set state='failed',completed_at=now() where request_id=p_request_id;
  else
    if before_row.access_hold_request is distinct from p_request_id then raise exception 'User conflict' using errcode='PT409'; end if;
    update eco_private.users set access_hold_request=null,activated_at=coalesce(activated_at,now()),
      password_prompt_dismissed_at=case when op.kind='change-password' then now() else null end,
      revision=revision+1,updated_at=now() where id=op.target_id returning * into target;
    update eco_private.admin_operations set state='complete',completed_at=now() where request_id=p_request_id;
  end if;
  insert into eco_private.revoked_sessions(session_id,user_id)
    select s.id,s.user_id from auth.sessions s where s.user_id=op.target_id on conflict do nothing;
  insert into eco_private.access_audit(target_id,action,before_access,after_access)
    values(op.target_id,'operator-reconcile-'||op.kind,eco_private.present_user(before_row),
      jsonb_build_object('requestId',p_request_id,'reason',trim(p_reason),'user',eco_private.present_user(target)));
  return eco_private.present_user(target);
end;
$$;
create function public.eco_reconcile_admin_operation(p_request_id uuid,p_reason text) returns jsonb language sql set search_path='' as $$
  select eco_private.reconcile_admin_operation(p_request_id,p_reason);
$$;
revoke execute on function eco_private.reconcile_admin_operation(uuid,text),public.eco_reconcile_admin_operation(uuid,text) from public,anon,authenticated;
grant execute on function eco_private.reconcile_admin_operation(uuid,text),public.eco_reconcile_admin_operation(uuid,text) to service_role;


-- BOOTSTRAP SECTION 20261014044623_eco_credit_office.sql
-- CREDIT is an office grouping, not an additional permission or role.
-- Members retain the ordinary trader interface unless separately assigned flags.
insert into eco_private.offices(id, name)
values ('CREDIT', 'CREDIT')
on conflict (id) do nothing;


-- BOOTSTRAP SECTION 20261014050402_eco_role_preview.sql
-- VIEW AS changes only this authenticated session's presentation. Account authority
-- remains unchanged. No browser role can read or write this private state directly.
create table eco_private.role_previews (
  session_id uuid primary key references auth.sessions(id) on delete cascade,
  user_id uuid not null references eco_private.users(id) on delete cascade,
  role text not null check(role in ('admin','trader','spc-trader','manager','credit')),
  office_id text not null references eco_private.offices(id),
  updated_at timestamptz not null default now(),
  check(role <> 'credit' or office_id='CREDIT')
);
alter table eco_private.role_previews enable row level security;
revoke all on eco_private.role_previews from public,anon,authenticated;
create index eco_role_previews_user on eco_private.role_previews(user_id);

create function eco_private.preview_json(p_session_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('role',p.role,'officeId',p.office_id,'officeName',o.name,'readOnly',true)
  from eco_private.role_previews p join eco_private.offices o on o.id=p.office_id where p.session_id=p_session_id;
$$;

create function eco_private.preview_state() returns jsonb
language plpgsql security definer set search_path='' as $$
declare member eco_private.users; sid uuid := (auth.jwt()->>'session_id')::uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(1857,2026);
  member := eco_private.current_member();
  -- A later demotion never inherits the former administrator's projection.
  if not member.is_admin then delete from eco_private.role_previews where session_id=sid; end if;
  return jsonb_build_object('preview',eco_private.preview_json(sid),'sessionId',sid);
end; $$;
create function public.eco_preview_state() returns jsonb language sql set search_path='' as $$ select eco_private.preview_state(); $$;

create function eco_private.preview_options() returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform eco_private.require_admin();
  return jsonb_build_object('offices',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name) order by name) from eco_private.offices),'[]'::jsonb));
end; $$;
create function public.eco_preview_options() returns jsonb language sql set search_path='' as $$ select eco_private.preview_options(); $$;

create function eco_private.set_preview(p_role text,p_office_id text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare member eco_private.users; sid uuid := (auth.jwt()->>'session_id')::uuid; previous jsonb; result jsonb;
begin
  perform pg_catalog.pg_advisory_xact_lock(1857,2026);
  member := eco_private.current_member();
  previous := eco_private.preview_json(sid);
  if p_role is null then
    delete from eco_private.role_previews where session_id=sid and user_id=member.id;
    if previous is not null then
      insert into eco_private.access_audit(actor_id,target_id,action,before_access) values(member.id,member.id,'end-role-preview',previous);
    end if;
    return null;
  end if;
  if not member.is_admin then raise exception 'Forbidden' using errcode='42501'; end if;
  if exists(select 1 from eco_private.admin_operations where state='pending' and (actor_id=member.id or target_id=member.id)) then
    raise exception 'Account operation pending' using errcode='PT409';
  end if;
  if p_role not in ('admin','trader','spc-trader','manager','credit') or p_office_id is null
    or not exists(select 1 from eco_private.offices where id=p_office_id)
    or (p_role='credit' and p_office_id<>'CREDIT') then raise exception 'Invalid preview' using errcode='22023'; end if;
  insert into eco_private.role_previews(session_id,user_id,role,office_id) values(sid,member.id,p_role,p_office_id)
    on conflict(session_id) do update set role=excluded.role,office_id=excluded.office_id,updated_at=now();
  result := eco_private.preview_json(sid);
  insert into eco_private.access_audit(actor_id,target_id,action,before_access,after_access)
    values(member.id,member.id,'set-role-preview',previous,result);
  return result;
end; $$;
create function public.eco_set_preview(p_role text,p_office_id text) returns jsonb language sql set search_path='' as $$ select eco_private.set_preview(p_role,p_office_id); $$;

-- Caller holds the common access lock across this guard AND its business mutation.
-- Validate the original browser session, not a new password reauthentication session.
create function eco_private.assert_preview_writable(p_user_id uuid,p_session_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  if p_session_id is null or not exists(select 1 from auth.sessions where id=p_session_id and user_id=p_user_id and (not_after is null or not_after>now()))
    or exists(select 1 from eco_private.revoked_sessions where session_id=p_session_id) then raise exception 'Unauthorized' using errcode='28000'; end if;
  if exists(select 1 from eco_private.role_previews where session_id=p_session_id and user_id=p_user_id) then
    raise exception 'Preview is read only' using errcode='42501';
  end if;
end; $$;

-- Retain the existing logic behind owner-only helpers; direct authenticated RPCs
-- execute the read-only guard even if called without the application API.
alter function eco_private.update_user(jsonb) rename to update_user_before_preview;
revoke all on function eco_private.update_user_before_preview(jsonb) from public,anon,authenticated,service_role;
create function eco_private.update_user(p_update jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(1857,2026);
  perform eco_private.assert_preview_writable(auth.uid(),(auth.jwt()->>'session_id')::uuid);
  return eco_private.update_user_before_preview(p_update);
end; $$;
alter function eco_private.dismiss_password_prompt() rename to dismiss_password_prompt_before_preview;
revoke all on function eco_private.dismiss_password_prompt_before_preview() from public,anon,authenticated,service_role;
create function eco_private.dismiss_password_prompt() returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(1857,2026);
  perform eco_private.assert_preview_writable(auth.uid(),(auth.jwt()->>'session_id')::uuid);
  return eco_private.dismiss_password_prompt_before_preview();
end; $$;
alter function eco_private.finish_activation() rename to finish_activation_before_preview;
revoke all on function eco_private.finish_activation_before_preview() from public,anon,authenticated,service_role;
create function eco_private.finish_activation() returns void language plpgsql security definer set search_path='' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(1857,2026);
  perform eco_private.assert_preview_writable(auth.uid(),(auth.jwt()->>'session_id')::uuid);
  perform eco_private.finish_activation_before_preview();
end; $$;
alter function eco_private.list_users() rename to list_users_before_preview;
revoke all on function eco_private.list_users_before_preview() from public,anon,authenticated,service_role;
create function eco_private.list_users() returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(1857,2026);
  perform eco_private.require_admin();
  if exists(select 1 from eco_private.role_previews where session_id::text=auth.jwt()->>'session_id' and role<>'admin') then
    raise exception 'Forbidden' using errcode='42501';
  end if;
  return eco_private.list_users_before_preview();
end; $$;

-- Additive server entry points bind credential approval to its incoming browser
-- session. Credential fences prevent preview entry until provider work is resolved.
create function eco_private.begin_admin_operation_v2(p_actor_id uuid,p_session_id uuid,p_request_id uuid,p_kind text,p_input jsonb,p_fingerprint text,p_origin_session_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(1857,2026);
  perform eco_private.assert_preview_writable(p_actor_id,p_origin_session_id);
  perform eco_private.assert_preview_writable(p_actor_id,p_session_id);
  return eco_private.begin_admin_operation(p_actor_id,p_session_id,p_request_id,p_kind,p_input,p_fingerprint);
end; $$;
create function public.eco_begin_admin_operation_v2(p_actor_id uuid,p_session_id uuid,p_request_id uuid,p_kind text,p_input jsonb,p_fingerprint text,p_origin_session_id uuid) returns jsonb language sql set search_path='' as $$
  select eco_private.begin_admin_operation_v2(p_actor_id,p_session_id,p_request_id,p_kind,p_input,p_fingerprint,p_origin_session_id);
$$;
create function eco_private.begin_password_change_v3(p_user_id uuid,p_session_id uuid,p_origin_session_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(1857,2026);
  perform eco_private.assert_preview_writable(p_user_id,p_origin_session_id);
  perform eco_private.assert_preview_writable(p_user_id,p_session_id);
  perform eco_private.begin_password_change_v2(p_user_id,p_session_id);
end; $$;
create function public.eco_begin_password_change_v3(p_user_id uuid,p_session_id uuid,p_origin_session_id uuid) returns void language sql set search_path='' as $$
  select eco_private.begin_password_change_v3(p_user_id,p_session_id,p_origin_session_id);
$$;

revoke all on function eco_private.preview_json(uuid),eco_private.preview_state(),eco_private.preview_options(),eco_private.set_preview(text,text),eco_private.assert_preview_writable(uuid,uuid),
  eco_private.update_user(jsonb),eco_private.dismiss_password_prompt(),eco_private.finish_activation(),eco_private.list_users(),
  eco_private.begin_admin_operation_v2(uuid,uuid,uuid,text,jsonb,text,uuid),eco_private.begin_password_change_v3(uuid,uuid,uuid),
  public.eco_preview_state(),public.eco_preview_options(),public.eco_set_preview(text,text),public.eco_begin_admin_operation_v2(uuid,uuid,uuid,text,jsonb,text,uuid),public.eco_begin_password_change_v3(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function eco_private.preview_state(),eco_private.preview_options(),eco_private.set_preview(text,text),public.eco_preview_state(),public.eco_preview_options(),public.eco_set_preview(text,text),
  eco_private.update_user(jsonb),eco_private.dismiss_password_prompt(),eco_private.finish_activation(),eco_private.list_users() to authenticated;
grant execute on function eco_private.begin_admin_operation_v2(uuid,uuid,uuid,text,jsonb,text,uuid),eco_private.begin_password_change_v3(uuid,uuid,uuid),
  public.eco_begin_admin_operation_v2(uuid,uuid,uuid,text,jsonb,text,uuid),public.eco_begin_password_change_v3(uuid,uuid,uuid) to service_role;


-- BOOTSTRAP SECTION 20261014074732_eco_user_deletion.sql
-- Delete removes the account from ECO while retaining identity references and
-- immutable audit history. Provider credentials are never copied or exposed.
alter table eco_private.users add column deleted_at timestamptz;
alter table eco_private.users add constraint eco_deleted_user_has_no_access
  check (deleted_at is null or (not is_active and not is_admin and not is_manager and not is_spc_trader));
alter table eco_private.admin_operations drop constraint admin_operations_kind_check;
alter table eco_private.admin_operations add constraint admin_operations_kind_check
  check (kind in ('create-user','reset-password','change-password','delete-user'));

-- A tombstone cannot be reactivated or erased through an older application build.
create function eco_private.preserve_user_deletion() returns trigger
language plpgsql set search_path='' as $$
begin
  if old.deleted_at is not null and new.deleted_at is distinct from old.deleted_at then
    raise exception 'Deleted account cannot be restored' using errcode='23514';
  end if;
  return new;
end; $$;
revoke all on function eco_private.preserve_user_deletion() from public,anon,authenticated,service_role;
create trigger eco_preserve_user_deletion before update on eco_private.users
  for each row execute function eco_private.preserve_user_deletion();

create or replace function eco_private.list_users_before_preview() returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform eco_private.require_admin();
  return jsonb_build_object(
    'users',coalesce((select jsonb_agg(eco_private.present_user(p) order by p.office_id,p.display_name,p.id)
      from eco_private.users p where p.deleted_at is null),'[]'::jsonb),
    'offices',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'name',o.name) order by o.name)
      from eco_private.offices o),'[]'::jsonb));
end; $$;

create or replace function eco_private.update_user(p_update jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(1857,2026);
  perform eco_private.assert_preview_writable(auth.uid(),(auth.jwt()->>'session_id')::uuid);
  perform eco_private.require_admin();
  if exists(select 1 from eco_private.users where id::text=p_update->>'id' and deleted_at is not null) then
    raise exception 'Unknown user' using errcode='22023';
  end if;
  return eco_private.update_user_before_preview(p_update);
end; $$;

-- Existing signatures remain compatible but no path can reset a deleted account.
alter function eco_private.begin_admin_operation(uuid,uuid,uuid,text,jsonb,text) rename to begin_admin_operation_before_deletion;
revoke all on function eco_private.begin_admin_operation_before_deletion(uuid,uuid,uuid,text,jsonb,text) from public,anon,authenticated,service_role;
create function eco_private.begin_admin_operation(p_actor_id uuid,p_session_id uuid,p_request_id uuid,p_kind text,p_input jsonb,p_fingerprint text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(1857,2026);
  perform eco_private.require_admin_session(p_actor_id,p_session_id);
  if p_kind='reset-password' and exists(select 1 from eco_private.users where id::text=p_input->>'id' and deleted_at is not null) then
    raise exception 'Unknown user' using errcode='22023';
  end if;
  return eco_private.begin_admin_operation_before_deletion(p_actor_id,p_session_id,p_request_id,p_kind,p_input,p_fingerprint);
end; $$;
revoke all on function eco_private.begin_admin_operation(uuid,uuid,uuid,text,jsonb,text) from public,anon,authenticated;
grant execute on function eco_private.begin_admin_operation(uuid,uuid,uuid,text,jsonb,text) to service_role;

create function eco_private.delete_user(p_actor_id uuid,p_session_id uuid,p_origin_session_id uuid,
  p_request_id uuid,p_target_id uuid,p_expected_revision integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare before_row eco_private.users; after_row eco_private.users; op eco_private.admin_operations;
  input jsonb := jsonb_build_object('id',p_target_id,'expectedRevision',p_expected_revision);
begin
  perform pg_catalog.pg_advisory_xact_lock(1857,2026);
  perform eco_private.assert_preview_writable(p_actor_id,p_origin_session_id);
  perform eco_private.assert_preview_writable(p_actor_id,p_session_id);
  perform eco_private.require_admin_session(p_actor_id,p_session_id);
  if p_request_id is null or p_target_id is null or p_expected_revision is null or p_expected_revision<1 then
    raise exception 'Invalid deletion' using errcode='22023';
  end if;
  if p_actor_id=p_target_id then raise exception 'Cannot delete own account' using errcode='23514'; end if;
  select * into op from eco_private.admin_operations where request_id=p_request_id for update;
  if found then
    if op.actor_id<>p_actor_id or op.target_id<>p_target_id or op.kind<>'delete-user' or op.input is distinct from input or op.state<>'complete' then
      raise exception 'Request conflict' using errcode='PT409';
    end if;
    return jsonb_build_object('deletedUserId',p_target_id);
  end if;
  select * into before_row from eco_private.users where id=p_target_id and deleted_at is null for update;
  if not found then raise exception 'Unknown user' using errcode='22023'; end if;
  if before_row.revision<>p_expected_revision or before_row.access_hold_request is not null
    or exists(select 1 from eco_private.admin_operations where state='pending' and (target_id=p_target_id or actor_id=p_target_id)) then
    raise exception 'User conflict' using errcode='PT409';
  end if;
  if before_row.is_admin and before_row.is_active and before_row.activated_at is not null
    and not exists(select 1 from eco_private.users p where p.id<>p_target_id and p.deleted_at is null
      and p.is_admin and p.is_active and p.activated_at is not null and p.access_hold_request is null) then
    raise exception 'Final administrator' using errcode='23514';
  end if;
  update eco_private.users set deleted_at=now(),is_active=false,is_admin=false,is_manager=false,is_spc_trader=false,
    revision=revision+1,updated_at=now() where id=p_target_id returning * into after_row;
  insert into eco_private.revoked_sessions(session_id,user_id)
    select s.id,s.user_id from auth.sessions s where s.user_id=p_target_id on conflict do nothing;
  delete from eco_private.role_previews where user_id=p_target_id;
  insert into eco_private.admin_operations(request_id,actor_id,target_id,kind,input,fingerprint,state,completed_at)
    values(p_request_id,p_actor_id,p_target_id,'delete-user',input,repeat('0',64),'complete',now());
  insert into eco_private.access_audit(actor_id,target_id,action,before_access,after_access)
    values(p_actor_id,p_target_id,'delete-user',eco_private.present_user(before_row),
      eco_private.present_user(after_row)||jsonb_build_object('deletedAt',after_row.deleted_at,'requestId',p_request_id));
  return jsonb_build_object('deletedUserId',p_target_id);
end; $$;
create function public.eco_delete_user(p_actor_id uuid,p_session_id uuid,p_origin_session_id uuid,
  p_request_id uuid,p_target_id uuid,p_expected_revision integer) returns jsonb
language sql set search_path='' as $$
  select eco_private.delete_user(p_actor_id,p_session_id,p_origin_session_id,p_request_id,p_target_id,p_expected_revision);
$$;
revoke all on function eco_private.delete_user(uuid,uuid,uuid,uuid,uuid,integer),
  public.eco_delete_user(uuid,uuid,uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function eco_private.delete_user(uuid,uuid,uuid,uuid,uuid,integer),
  public.eco_delete_user(uuid,uuid,uuid,uuid,uuid,integer) to service_role;


-- BOOTSTRAP SECTION 20261014082825_eco_phone_change_requests.sql
-- Contact changes remain pending until an administrator confirms them. These are
-- ECO contact numbers only; provider identity, sign-in and routing are unchanged.
create table eco_private.phone_change_requests (
  id uuid primary key,
  user_id uuid not null references eco_private.users(id) on delete cascade,
  current_phone text not null,
  requested_phone text not null check (requested_phone ~ '^\+[1-9][0-9]{6,14}$'),
  status text not null default 'pending' check (status in ('pending','approved','declined','superseded')),
  requested_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid,
  check (current_phone <> requested_phone),
  check ((status='pending' and reviewed_at is null and reviewed_by is null) or
    (status<>'pending' and reviewed_at is not null)),
  check (status not in ('approved','declined') or reviewed_by is not null)
);
alter table eco_private.phone_change_requests enable row level security;
revoke all on eco_private.phone_change_requests from public,anon,authenticated;
create unique index eco_phone_request_pending_user on eco_private.phone_change_requests(user_id) where status='pending';
create index eco_phone_request_user_history on eco_private.phone_change_requests(user_id,requested_at desc,id);
create index eco_phone_request_pending_queue on eco_private.phone_change_requests(requested_at,id) where status='pending';

create function eco_private.present_phone_request(p eco_private.phone_change_requests) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('id',p.id,'userId',p.user_id,'displayName',u.display_name,'email',u.email,
    'officeName',coalesce(o.name,''),'currentPhone',p.current_phone,'requestedPhone',p.requested_phone,
    'status',p.status,'requestedAt',p.requested_at,'reviewedAt',p.reviewed_at,'reviewedBy',p.reviewed_by)
  from eco_private.users u left join eco_private.offices o on o.id=u.office_id where u.id=p.user_id;
$$;

create function eco_private.list_phone_requests() returns jsonb
language plpgsql security definer set search_path='' as $$
declare member eco_private.users; show_queue boolean;
begin
  member := eco_private.current_member();
  show_queue := member.is_admin and eco_private.preview_json((auth.jwt()->>'session_id')::uuid) is null;
  return jsonb_build_object('requests',coalesce((
    select jsonb_agg(eco_private.present_phone_request(p) order by (p.status='pending') desc,p.requested_at desc,p.id)
    from eco_private.phone_change_requests p
    where (show_queue and p.status='pending') or p.id in (
      select own.id from eco_private.phone_change_requests own where own.user_id=member.id order by own.requested_at desc,own.id limit 20
    )
  ),'[]'::jsonb));
end; $$;

create function eco_private.request_phone_change(p_request_id uuid,p_phone text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare member eco_private.users; requested eco_private.phone_change_requests;
begin
  perform pg_catalog.pg_advisory_xact_lock(1857,2026);
  member := eco_private.current_member();
  perform eco_private.assert_preview_writable(member.id,(auth.jwt()->>'session_id')::uuid);
  if p_request_id is null or p_phone is null or p_phone !~ '^\+[1-9][0-9]{6,14}$' then
    raise exception 'Invalid phone request' using errcode='22023';
  end if;
  select * into requested from eco_private.phone_change_requests where id=p_request_id;
  if found then
    if requested.user_id<>member.id or requested.requested_phone<>p_phone then raise exception 'Request conflict' using errcode='PT409'; end if;
    return eco_private.present_phone_request(requested);
  end if;
  if member.phone=p_phone then raise exception 'Phone is unchanged' using errcode='22023'; end if;
  if exists(select 1 from eco_private.phone_change_requests where user_id=member.id and status='pending') then
    raise exception 'Phone request pending' using errcode='PT409';
  end if;
  insert into eco_private.phone_change_requests(id,user_id,current_phone,requested_phone)
    values(p_request_id,member.id,member.phone,p_phone) returning * into requested;
  insert into eco_private.access_audit(actor_id,target_id,action,after_access)
    values(member.id,member.id,'request-phone-change',eco_private.present_phone_request(requested));
  return eco_private.present_phone_request(requested);
end; $$;

-- A direct administrator edit, suspension or deletion invalidates old requests.
-- This trigger also protects requests from an older application deployment.
create function eco_private.supersede_phone_requests() returns trigger
language plpgsql security definer set search_path='' as $$
declare requested eco_private.phone_change_requests;
begin
  if old.phone is distinct from new.phone or not new.is_active or new.deleted_at is not null then
    for requested in update eco_private.phone_change_requests set status='superseded',reviewed_at=now(),reviewed_by=auth.uid()
      where user_id=new.id and status='pending' returning *
    loop
      insert into eco_private.access_audit(actor_id,target_id,action,after_access)
        values(auth.uid(),new.id,'supersede-phone-change',eco_private.present_phone_request(requested));
    end loop;
  end if;
  return new;
end; $$;
create trigger eco_supersede_phone_requests after update of phone,is_active,deleted_at on eco_private.users
  for each row execute function eco_private.supersede_phone_requests();

create function eco_private.review_phone_change(p_request_id uuid,p_decision text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor eco_private.users; requested eco_private.phone_change_requests; member eco_private.users; wanted_status text;
begin
  perform pg_catalog.pg_advisory_xact_lock(1857,2026);
  actor := eco_private.require_admin();
  perform eco_private.assert_preview_writable(actor.id,(auth.jwt()->>'session_id')::uuid);
  if p_request_id is null or p_decision is null or p_decision not in ('approve','decline') then
    raise exception 'Invalid review' using errcode='22023';
  end if;
  select * into requested from eco_private.phone_change_requests where id=p_request_id for update;
  if not found then raise exception 'Request conflict' using errcode='PT409'; end if;
  wanted_status := case p_decision when 'approve' then 'approved' else 'declined' end;
  if requested.status<>'pending' then
    if requested.status<>wanted_status and requested.status<>'superseded' then raise exception 'Request conflict' using errcode='PT409'; end if;
    return eco_private.present_phone_request(requested);
  end if;
  select * into member from eco_private.users where id=requested.user_id for update;
  if member.access_hold_request is not null then raise exception 'Account operation pending' using errcode='PT409'; end if;
  if member.phone<>requested.current_phone or not member.is_active or member.deleted_at is not null or member.activated_at is null then
    wanted_status := 'superseded';
  end if;
  update eco_private.phone_change_requests set status=wanted_status,reviewed_at=now(),reviewed_by=actor.id
    where id=requested.id returning * into requested;
  -- Mark approved before changing the contact, so its own trigger cannot supersede it.
  if wanted_status='approved' then
    update eco_private.users set phone=requested.requested_phone,revision=revision+1,updated_at=now() where id=member.id;
  end if;
  insert into eco_private.access_audit(actor_id,target_id,action,before_access,after_access)
    values(actor.id,member.id,'review-phone-change',jsonb_build_object('phone',member.phone),eco_private.present_phone_request(requested));
  return eco_private.present_phone_request(requested);
end; $$;

-- Invoker wrappers expose only guarded operations; no browser role can select the
-- queue table or provide the requesting identity / reviewer identity itself.
create function public.eco_list_phone_requests() returns jsonb language sql set search_path='' as $$ select eco_private.list_phone_requests(); $$;
create function public.eco_request_phone_change(p_request_id uuid,p_phone text) returns jsonb language sql set search_path='' as $$ select eco_private.request_phone_change(p_request_id,p_phone); $$;
create function public.eco_review_phone_change(p_request_id uuid,p_decision text) returns jsonb language sql set search_path='' as $$ select eco_private.review_phone_change(p_request_id,p_decision); $$;
revoke all on function eco_private.present_phone_request(eco_private.phone_change_requests),eco_private.supersede_phone_requests(),
  eco_private.list_phone_requests(),eco_private.request_phone_change(uuid,text),eco_private.review_phone_change(uuid,text),
  public.eco_list_phone_requests(),public.eco_request_phone_change(uuid,text),public.eco_review_phone_change(uuid,text)
  from public,anon,authenticated,service_role;
grant execute on function eco_private.list_phone_requests(),eco_private.request_phone_change(uuid,text),eco_private.review_phone_change(uuid,text),
  public.eco_list_phone_requests(),public.eco_request_phone_change(uuid,text),public.eco_review_phone_change(uuid,text) to authenticated;


-- BOOTSTRAP SECTION 20261014095316_eco_administration.sql
-- ECO-only shared administration. Append-only event receipts are separate from browser-local demo data.
create table eco_private.feedback (
 id uuid primary key default gen_random_uuid(), submitter_id uuid not null, submitter_name text not null, office_name text not null,
 title text not null check(length(title) between 1 and 160), description text not null check(length(description) between 1 and 6000),
 category text not null check(category in ('issue','idea','data')), page_path text not null default '',
 status text not null default 'new' check(status in ('new','in-progress','resolved','closed')),
 priority text not null default 'normal' check(priority in ('low','normal','high')), assignee_id uuid,
 resolution text not null default '' check(length(resolution)<=2000), revision integer not null default 1 check(revision>0),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index eco_feedback_created on eco_private.feedback(created_at desc,id desc);
create index eco_feedback_owner_created on eco_private.feedback(submitter_id,created_at desc,id desc);
create index eco_feedback_status_created on eco_private.feedback(status,created_at desc,id desc);
create table eco_private.import_jobs (
 id uuid primary key default gen_random_uuid(), submitter_id uuid not null, submitter_name text not null,
 kind text not null check(kind in ('document','enquiry','text','link')), source_name text not null check(length(source_name) between 1 and 180),
 source_type text not null check(length(source_type) between 1 and 80), provenance text not null default 'client-reported' check(provenance='client-reported'),
 status text not null default 'processing' check(status in ('processing','awaiting-review','failed','cancelled','awaiting-retry')),
 warning_count integer not null default 0 check(warning_count between 0 and 10000), error_code text,
 summary text not null default '' check(length(summary)<=500), attempt integer not null default 1 check(attempt>0), revision integer not null default 1 check(revision>0),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index eco_imports_created on eco_private.import_jobs(created_at desc,id desc);
create index eco_imports_owner_created on eco_private.import_jobs(submitter_id,created_at desc,id desc);
create index eco_imports_status on eco_private.import_jobs(status,updated_at);
create table eco_private.administration_events (
 id bigint generated always as identity primary key, occurred_at timestamptz not null default now(),
 actor_id uuid not null, actor_name text not null, target_id uuid, action text not null,
 details jsonb not null default '{}'::jsonb check(jsonb_typeof(details)='object')
);
create index eco_administration_events_time on eco_private.administration_events(occurred_at desc,id desc);
create index eco_access_audit_time on eco_private.access_audit(occurred_at desc,id desc);
create table eco_private.administration_requests (
 actor_id uuid not null, request_id uuid not null, operation text not null, fingerprint text not null,
 result jsonb, created_at timestamptz not null default now(), primary key(actor_id,request_id)
);
create table eco_private.feedback_contributions (
 id uuid primary key default gen_random_uuid(), user_id uuid not null, feedback_id uuid not null unique references eco_private.feedback(id),
 content_fingerprint text not null check(content_fingerprint ~ '^[0-9a-f]{64}$'),
 created_at timestamptz not null default now(), unique(user_id,content_fingerprint)
);
create index eco_feedback_contributions_user_time on eco_private.feedback_contributions(user_id,created_at desc);
create table eco_private.platform_versions (component text primary key, migration_head text not null, installed_at timestamptz not null default now());
insert into eco_private.platform_versions(component,migration_head) values('administration','20261014095316');

alter table eco_private.feedback enable row level security;
alter table eco_private.import_jobs enable row level security;
alter table eco_private.administration_events enable row level security;
alter table eco_private.administration_requests enable row level security;
alter table eco_private.feedback_contributions enable row level security;
alter table eco_private.platform_versions enable row level security;
revoke all on eco_private.feedback,eco_private.import_jobs,eco_private.administration_events,eco_private.administration_requests,eco_private.feedback_contributions,eco_private.platform_versions from public,anon,authenticated;
revoke all on sequence eco_private.administration_events_id_seq from public,anon,authenticated;

create function eco_private.admin_read_member() returns eco_private.users
language plpgsql security definer set search_path='' as $$
declare member eco_private.users;
begin
 member:=eco_private.require_admin();
 if exists(select 1 from eco_private.role_previews where session_id::text=auth.jwt()->>'session_id' and role<>'admin') then raise exception 'Forbidden' using errcode='42501'; end if;
 return member;
end;$$;
create function eco_private.admin_can_read_all(member eco_private.users) returns boolean
language sql stable set search_path='' as $$
 select member.is_admin and not exists(select 1 from eco_private.role_previews where session_id::text=auth.jwt()->>'session_id' and role<>'admin');
$$;
create function eco_private.admin_writable_member() returns eco_private.users
language plpgsql security definer set search_path='' as $$
declare member eco_private.users;
begin
 -- Coordinate account privilege changes and user deletion with operation authorization.
 perform pg_advisory_xact_lock(1857,2026);
 member:=eco_private.current_member();
 perform eco_private.assert_preview_writable(member.id,(auth.jwt()->>'session_id')::uuid);
 return member;
end;$$;
create function eco_private.admin_check_keys(p_input jsonb,p_keys text[]) returns void
language plpgsql set search_path='' as $$
begin
 if jsonb_typeof(p_input) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_input) k where not(k=any(p_keys))) then raise exception 'Invalid input' using errcode='22023'; end if;
end;$$;
create function eco_private.admin_check_text(p_input jsonb,p_key text,p_min integer,p_max integer) returns void
language plpgsql set search_path='' as $$
begin
 if jsonb_typeof(p_input->p_key) is distinct from 'string' or length(trim(p_input->>p_key)) not between p_min and p_max then raise exception 'Invalid input' using errcode='22023'; end if;
end;$$;
create function eco_private.admin_request(p_actor uuid,p_input jsonb,p_operation text) returns jsonb
language plpgsql set search_path='' as $$
declare prior eco_private.administration_requests; rid uuid;
begin
 if jsonb_typeof(p_input->'requestId') is distinct from 'string' or (p_input->>'requestId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Invalid input' using errcode='22023'; end if;
 rid:=(p_input->>'requestId')::uuid;
 select * into prior from eco_private.administration_requests where actor_id=p_actor and request_id=rid for update;
 if found then
   if prior.operation<>p_operation or prior.fingerprint<>encode(sha256(convert_to(p_input::text,'UTF8')),'hex') then raise exception 'Request conflict' using errcode='PT409'; end if;
   return prior.result;
 end if;
 insert into eco_private.administration_requests(actor_id,request_id,operation,fingerprint) values(p_actor,rid,p_operation,encode(sha256(convert_to(p_input::text,'UTF8')),'hex'));
 return null;
end;$$;
create function eco_private.admin_finish(p_actor uuid,p_input jsonb,p_result jsonb) returns jsonb
language plpgsql set search_path='' as $$
begin
 update eco_private.administration_requests set result=p_result where actor_id=p_actor and request_id=(p_input->>'requestId')::uuid;
 return p_result;
end;$$;
create function eco_private.present_feedback(p eco_private.feedback) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('id',p.id,'submitterId',p.submitter_id,'submitterName',p.submitter_name,'officeName',p.office_name,
 'title',p.title,'description',p.description,'category',p.category,'pagePath',p.page_path,'status',p.status,'priority',p.priority,
 'assigneeId',p.assignee_id,'assigneeName',(select display_name from eco_private.users where id=p.assignee_id),
 'resolution',p.resolution,'createdAt',p.created_at,'updatedAt',p.updated_at,'revision',p.revision);
$$;
create function eco_private.present_import(p eco_private.import_jobs) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('id',p.id,'submitterId',p.submitter_id,'submitterName',p.submitter_name,'kind',p.kind,'sourceName',p.source_name,'sourceType',p.source_type,
 'status',p.status,'provenance',p.provenance,'warningCount',p.warning_count,'errorCode',p.error_code,'summary',p.summary,
 'attempt',p.attempt,'revision',p.revision,'createdAt',p.created_at,'updatedAt',p.updated_at);
$$;
create function eco_private.create_feedback(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor eco_private.users; prior jsonb; item eco_private.feedback; result jsonb;
begin
 actor:=eco_private.admin_writable_member();
 perform eco_private.admin_check_keys(p_input,array['requestId','title','description','category','pagePath']);
 perform eco_private.admin_check_text(p_input,'title',1,160); perform eco_private.admin_check_text(p_input,'description',1,6000);
 if p_input->>'category' is null or p_input->>'category' not in ('issue','idea','data') then raise exception 'Invalid input' using errcode='22023'; end if;
 if p_input ? 'pagePath' then
   perform eco_private.admin_check_text(p_input,'pagePath',0,200);
   if p_input->>'pagePath'<>'' and ((p_input->>'pagePath') !~ '^/($|[^/])' or (p_input->>'pagePath') ~ '[?#[:space:]\\]') then raise exception 'Invalid page path' using errcode='22023'; end if;
 end if;
 prior:=eco_private.admin_request(actor.id,p_input,'feedback-create'); if prior is not null then return prior; end if;
 if (select count(*) from eco_private.feedback where submitter_id=actor.id and created_at>now()-interval '1 minute')>=10 then raise exception 'Rate limit' using errcode='PT429'; end if;
 insert into eco_private.feedback(submitter_id,submitter_name,office_name,title,description,category,page_path)
 values(actor.id,actor.display_name,coalesce((select name from eco_private.offices where id=actor.office_id),''),trim(p_input->>'title'),trim(p_input->>'description'),p_input->>'category',coalesce(p_input->>'pagePath','')) returning * into item;
 -- Reopening the same normalized suggestion can create an issue, but never another contribution credit.
 insert into eco_private.feedback_contributions(user_id,feedback_id,content_fingerprint)
 values(actor.id,item.id,encode(sha256(convert_to(jsonb_build_array(
   lower(regexp_replace(trim(normalize(item.title,NFKC)),'[[:space:]]+',' ','g')),
   lower(regexp_replace(trim(normalize(item.description,NFKC)),'[[:space:]]+',' ','g'))
 )::text,'UTF8')),'hex')) on conflict(user_id,content_fingerprint) do nothing;
 insert into eco_private.administration_events(actor_id,actor_name,target_id,action,details) values(actor.id,actor.display_name,item.id,'feedback-created',jsonb_build_object('category',item.category));
 result:=eco_private.present_feedback(item); return eco_private.admin_finish(actor.id,p_input,result);
end;$$;
create function eco_private.triage_feedback(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor eco_private.users; prior jsonb; item eco_private.feedback; previous_status text;
begin
 actor:=eco_private.admin_writable_member(); if not actor.is_admin then raise exception 'Forbidden' using errcode='42501'; end if;
 perform eco_private.admin_check_keys(p_input,array['requestId','id','expectedRevision','status','priority','assigneeId','resolution']);
 if jsonb_typeof(p_input->'expectedRevision') is distinct from 'number' or (p_input->>'expectedRevision') !~ '^[1-9][0-9]*$'
 or p_input->>'status' is null or p_input->>'status' not in ('new','in-progress','resolved','closed')
 or p_input->>'priority' is null or p_input->>'priority' not in ('low','normal','high') then raise exception 'Invalid input' using errcode='22023'; end if;
 perform eco_private.admin_check_text(p_input,'resolution',0,2000);
 if p_input->>'status' in ('resolved','closed') and length(trim(p_input->>'resolution'))=0 then raise exception 'Resolution required' using errcode='22023'; end if;
 if jsonb_typeof(p_input->'assigneeId') not in ('null','string') or not(p_input ? 'assigneeId') then raise exception 'Invalid assignee' using errcode='22023'; end if;
 if p_input->>'assigneeId' is not null and not exists(select 1 from eco_private.users where id=(p_input->>'assigneeId')::uuid and is_admin and is_active and activated_at is not null and deleted_at is null) then raise exception 'Invalid assignee' using errcode='22023'; end if;
 prior:=eco_private.admin_request(actor.id,p_input,'feedback-triage'); if prior is not null then return prior; end if;
 select * into item from eco_private.feedback where id=(p_input->>'id')::uuid for update; if not found then raise exception 'Unknown feedback' using errcode='22023'; end if;
 if item.revision<>(p_input->>'expectedRevision')::integer then raise exception 'Revision conflict' using errcode='PT409'; end if;
 previous_status:=item.status;
 update eco_private.feedback set status=p_input->>'status',priority=p_input->>'priority',assignee_id=(p_input->>'assigneeId')::uuid,resolution=trim(p_input->>'resolution'),revision=revision+1,updated_at=now() where id=item.id returning * into item;
 insert into eco_private.administration_events(actor_id,actor_name,target_id,action,details) values(actor.id,actor.display_name,item.id,'feedback-triaged',jsonb_build_object('previousStatus',previous_status,'status',item.status,'priority',item.priority,'assigneeId',item.assignee_id));
 return eco_private.admin_finish(actor.id,p_input,eco_private.present_feedback(item));
end;$$;
create function eco_private.begin_import(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor eco_private.users; prior jsonb; item eco_private.import_jobs;
begin
 actor:=eco_private.admin_writable_member();
 perform eco_private.admin_check_keys(p_input,array['requestId','kind','sourceName','sourceType','retryOf','expectedRevision']);
 perform eco_private.admin_check_text(p_input,'sourceName',1,180); perform eco_private.admin_check_text(p_input,'sourceType',1,80);
 if p_input->>'kind' is null or p_input->>'kind' not in ('document','enquiry','text','link') or (p_input->>'sourceName') ~ '[/\\]' or (p_input->>'sourceName') ~* '(https?:|token=|password=)' or (p_input->>'sourceType') !~ '^[a-zA-Z0-9_.+/-]+$' then raise exception 'Invalid input' using errcode='22023'; end if;
 if (p_input ? 'retryOf')<>(p_input ? 'expectedRevision') then raise exception 'Invalid retry' using errcode='22023'; end if;
 prior:=eco_private.admin_request(actor.id,p_input,'import-begin'); if prior is not null then return prior; end if;
 if p_input ? 'retryOf' then
   select * into item from eco_private.import_jobs where id=(p_input->>'retryOf')::uuid and submitter_id=actor.id for update;
   if not found then raise exception 'Forbidden' using errcode='42501'; end if;
   if jsonb_typeof(p_input->'expectedRevision') is distinct from 'number' or (p_input->>'expectedRevision') !~ '^[1-9][0-9]*$' then raise exception 'Invalid revision' using errcode='22023'; end if;
   if item.status<>'awaiting-retry' or item.revision<>(p_input->>'expectedRevision')::integer then raise exception 'Retry conflict' using errcode='PT409'; end if;
   if item.kind<>p_input->>'kind' or item.source_name<>p_input->>'sourceName' or item.source_type<>p_input->>'sourceType' then raise exception 'Retry source changed' using errcode='PT409'; end if;
   update eco_private.import_jobs set status='processing',warning_count=0,error_code=null,summary='',attempt=attempt+1,revision=revision+1,updated_at=now() where id=item.id returning * into item;
 else
   if (select count(*) from eco_private.import_jobs where submitter_id=actor.id and created_at>now()-interval '1 minute')>=30 then raise exception 'Rate limit' using errcode='PT429'; end if;
   insert into eco_private.import_jobs(submitter_id,submitter_name,kind,source_name,source_type) values(actor.id,actor.display_name,p_input->>'kind',p_input->>'sourceName',p_input->>'sourceType') returning * into item;
 end if;
 insert into eco_private.administration_events(actor_id,actor_name,target_id,action,details) values(actor.id,actor.display_name,item.id,'import-started',jsonb_build_object('kind',item.kind,'attempt',item.attempt,'provenance','client-reported'));
 return eco_private.admin_finish(actor.id,p_input,eco_private.present_import(item));
end;$$;
create function eco_private.transition_import(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor eco_private.users; prior jsonb; item eco_private.import_jobs;
begin
 actor:=eco_private.admin_writable_member();
 perform eco_private.admin_check_keys(p_input,array['requestId','id','expectedRevision','status','warningCount','errorCode','summary']);
 if jsonb_typeof(p_input->'expectedRevision') is distinct from 'number' or (p_input->>'expectedRevision') !~ '^[1-9][0-9]*$'
 or p_input->>'status' is null or p_input->>'status' not in ('awaiting-review','failed','cancelled')
 or jsonb_typeof(p_input->'warningCount') is distinct from 'number' or (p_input->>'warningCount') !~ '^[0-9]+$' or (p_input->>'warningCount')::numeric>10000 then raise exception 'Invalid input' using errcode='22023'; end if;
 if p_input ? 'errorCode' then perform eco_private.admin_check_text(p_input,'errorCode',0,80); if p_input->>'errorCode'<>'' and (p_input->>'errorCode') !~ '^[A-Z0-9_-]+$' then raise exception 'Invalid error code' using errcode='22023'; end if; end if;
 if p_input ? 'summary' then perform eco_private.admin_check_text(p_input,'summary',0,500); end if;
 prior:=eco_private.admin_request(actor.id,p_input,'import-transition'); if prior is not null then return prior; end if;
 select * into item from eco_private.import_jobs where id=(p_input->>'id')::uuid and submitter_id=actor.id for update; if not found then raise exception 'Forbidden' using errcode='42501'; end if;
 if item.status<>'processing' or item.revision<>(p_input->>'expectedRevision')::integer then raise exception 'Import conflict' using errcode='PT409'; end if;
 update eco_private.import_jobs set status=p_input->>'status',warning_count=(p_input->>'warningCount')::integer,error_code=nullif(p_input->>'errorCode',''),summary=coalesce(p_input->>'summary',''),revision=revision+1,updated_at=now() where id=item.id returning * into item;
 insert into eco_private.administration_events(actor_id,actor_name,target_id,action,details) values(actor.id,actor.display_name,item.id,'import-outcome-reported',jsonb_build_object('status',item.status,'warningCount',item.warning_count,'errorCode',item.error_code,'provenance','client-reported'));
 return eco_private.admin_finish(actor.id,p_input,eco_private.present_import(item));
end;$$;
create function eco_private.retry_import(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor eco_private.users; prior jsonb; item eco_private.import_jobs;
begin
 actor:=eco_private.admin_writable_member();
 perform eco_private.admin_check_keys(p_input,array['requestId','id','expectedRevision']);
 if jsonb_typeof(p_input->'expectedRevision') is distinct from 'number' or (p_input->>'expectedRevision') !~ '^[1-9][0-9]*$' then raise exception 'Invalid input' using errcode='22023'; end if;
 prior:=eco_private.admin_request(actor.id,p_input,'import-retry'); if prior is not null then return prior; end if;
 select * into item from eco_private.import_jobs where id=(p_input->>'id')::uuid for update;
 if not found or (item.submitter_id<>actor.id and not actor.is_admin) then raise exception 'Forbidden' using errcode='42501'; end if;
 -- A stale browser processing attempt can be explicitly returned to its owner after fifteen minutes.
 if item.revision<>(p_input->>'expectedRevision')::integer or (item.status not in ('failed','cancelled') and not(item.status='processing' and item.updated_at<now()-interval '15 minutes')) then raise exception 'Retry conflict' using errcode='PT409'; end if;
 update eco_private.import_jobs set status='awaiting-retry',revision=revision+1,updated_at=now() where id=item.id returning * into item;
 insert into eco_private.administration_events(actor_id,actor_name,target_id,action,details) values(actor.id,actor.display_name,item.id,'import-retry-requested',jsonb_build_object('status',item.status,'provenance','client-reported'));
 return eco_private.admin_finish(actor.id,p_input,eco_private.present_import(item));
end;$$;
create function eco_private.admin_validate_query(p_query jsonb,p_statuses text[]) returns void
language plpgsql set search_path='' as $$
begin
 perform eco_private.admin_check_keys(p_query,array['search','status','cursor','limit','scope']);
 perform eco_private.admin_check_text(p_query,'search',0,120); perform eco_private.admin_check_text(p_query,'status',0,30); perform eco_private.admin_check_text(p_query,'cursor',0,200);
 if p_query->>'status'<>'' and not((p_query->>'status')=any(p_statuses)) then raise exception 'Invalid status' using errcode='22023'; end if;
 if jsonb_typeof(p_query->'limit') is distinct from 'number' or (p_query->>'limit') !~ '^[0-9]+$' or (p_query->>'limit')::numeric not between 1 and 50 then raise exception 'Invalid limit' using errcode='22023'; end if;
 if p_query ? 'scope' and (p_query->>'scope' is null or p_query->>'scope' not in ('mine','all')) then raise exception 'Invalid scope' using errcode='22023'; end if;
 if p_query->>'cursor'<>'' and (p_query->>'cursor') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9:.+Z-]+[|]([0-9a-f-]{36}|(access|administration):[0-9]+)$' then raise exception 'Invalid cursor' using errcode='22023'; end if;
end;$$;
create function eco_private.admin_page(p_rows jsonb,p_limit integer) returns jsonb
language sql immutable set search_path='' as $$
 select jsonb_build_object('items',coalesce((select jsonb_agg(v->'data' order by n) from jsonb_array_elements(p_rows) with ordinality a(v,n) where n<=p_limit),'[]'::jsonb),
 'nextCursor',case when jsonb_array_length(p_rows)>p_limit then p_rows->(p_limit-1)->'cursor' else 'null'::jsonb end);
$$;
create function eco_private.list_feedback(p_query jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor eco_private.users; show_all boolean; records jsonb; n integer; cursor_time timestamptz; cursor_id uuid;
begin
 actor:=eco_private.current_member(); show_all:=eco_private.admin_can_read_all(actor) and coalesce(p_query->>'scope','all')<>'mine';
 perform eco_private.admin_validate_query(p_query,array['new','in-progress','resolved','closed']); n:=(p_query->>'limit')::integer;
 if p_query->>'cursor'<>'' then cursor_time:=split_part(p_query->>'cursor','|',1)::timestamptz; cursor_id:=split_part(p_query->>'cursor','|',2)::uuid; end if;
 select coalesce(jsonb_agg(jsonb_build_object('data',eco_private.present_feedback(f),'cursor',f.created_at::text||'|'||f.id::text) order by f.created_at desc,f.id desc),'[]'::jsonb) into records
 from (select * from eco_private.feedback where (show_all or submitter_id=actor.id)
 and (p_query->>'status'='' or status=p_query->>'status')
 and (p_query->>'search'='' or title ilike '%'||(p_query->>'search')||'%' or description ilike '%'||(p_query->>'search')||'%' or submitter_name ilike '%'||(p_query->>'search')||'%')
 and (cursor_time is null or (created_at,id)<(cursor_time,cursor_id)) order by created_at desc,id desc limit n+1) f;
 return eco_private.admin_page(records,n);
end;$$;
create function eco_private.list_imports(p_query jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor eco_private.users; show_all boolean; records jsonb; n integer; cursor_time timestamptz; cursor_id uuid;
begin
 actor:=eco_private.current_member(); show_all:=eco_private.admin_can_read_all(actor) and coalesce(p_query->>'scope','all')<>'mine';
 perform eco_private.admin_validate_query(p_query,array['processing','awaiting-review','failed','cancelled','awaiting-retry']); n:=(p_query->>'limit')::integer;
 if p_query->>'cursor'<>'' then cursor_time:=split_part(p_query->>'cursor','|',1)::timestamptz; cursor_id:=split_part(p_query->>'cursor','|',2)::uuid; end if;
 select coalesce(jsonb_agg(jsonb_build_object('data',eco_private.present_import(f),'cursor',f.created_at::text||'|'||f.id::text) order by f.created_at desc,f.id desc),'[]'::jsonb) into records
 from (select * from eco_private.import_jobs where (show_all or submitter_id=actor.id)
 and (p_query->>'status'='' or status=p_query->>'status')
 and (p_query->>'search'='' or source_name ilike '%'||(p_query->>'search')||'%' or submitter_name ilike '%'||(p_query->>'search')||'%' or kind ilike '%'||(p_query->>'search')||'%')
 and (cursor_time is null or (created_at,id)<(cursor_time,cursor_id)) order by created_at desc,id desc limit n+1) f;
 return eco_private.admin_page(records,n);
end;$$;
create function eco_private.audit_access_details(p_before jsonb,p_after jsonb) returns jsonb
language sql immutable set search_path='' as $$
 select jsonb_strip_nulls(jsonb_build_object(
 'before',jsonb_build_object('officeId',p_before->'officeId','isAdmin',p_before->'isAdmin','isManager',p_before->'isManager','isSpcTrader',p_before->'isSpcTrader','isActive',p_before->'isActive','role',p_before->'role'),
 'after',jsonb_build_object('officeId',p_after->'officeId','isAdmin',p_after->'isAdmin','isManager',p_after->'isManager','isSpcTrader',p_after->'isSpcTrader','isActive',p_after->'isActive','role',p_after->'role')));
$$;
create function eco_private.list_audit(p_query jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare records jsonb; n integer; cursor_time timestamptz; cursor_id text;
begin
 perform eco_private.admin_read_member(); perform eco_private.admin_validate_query(p_query,array[]::text[]); n:=(p_query->>'limit')::integer;
 if p_query->>'cursor'<>'' then cursor_time:=split_part(p_query->>'cursor','|',1)::timestamptz; cursor_id:=split_part(p_query->>'cursor','|',2); if cursor_id !~ '^(access|administration):[0-9]+$' then raise exception 'Invalid cursor' using errcode='22023'; end if; end if;
 with events as (
 select 'access:'||a.id as id,a.occurred_at,a.actor_id,coalesce(u.display_name,'SYSTEM') as actor_name,a.target_id,a.action,'access'::text as source,eco_private.audit_access_details(a.before_access,a.after_access) as details from eco_private.access_audit a left join eco_private.users u on u.id=a.actor_id
 union all
 select 'administration:'||a.id,a.occurred_at,a.actor_id,a.actor_name,a.target_id,a.action,'administration',a.details from eco_private.administration_events a
 ), selected as (
 select * from events where (cursor_time is null or (occurred_at,id)<(cursor_time,cursor_id))
 and (p_query->>'search'='' or action ilike '%'||(p_query->>'search')||'%' or actor_name ilike '%'||(p_query->>'search')||'%' or coalesce(target_id::text,'') ilike '%'||(p_query->>'search')||'%')
 order by occurred_at desc,id desc limit n+1
 )
 select coalesce(jsonb_agg(jsonb_build_object('data',jsonb_build_object('id',id,'occurredAt',occurred_at,'actorId',actor_id,'actorName',actor_name,'targetId',target_id,'action',action,'source',source,'details',details),'cursor',occurred_at::text||'|'||id) order by occurred_at desc,id desc),'[]'::jsonb) into records from selected;
 return eco_private.admin_page(records,n);
end;$$;
create function eco_private.feedback_contribution_summary(p_period text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor eco_private.users; start_at timestamptz; end_at timestamptz; previous_start timestamptz; previous_end timestamptz; today_start timestamptz; total bigint; previous_total bigint; recent jsonb;
begin
 actor:=eco_private.current_member();
 if p_period is null or p_period not in ('7d','28d','month','all') then raise exception 'Invalid period' using errcode='22023'; end if;
 end_at:=now()+interval '1 millisecond';
 today_start:=((now() at time zone 'Asia/Hong_Kong')::date::timestamp at time zone 'Asia/Hong_Kong');
 if p_period='7d' then start_at:=today_start-interval '6 days'; previous_start:=start_at-interval '7 days'; previous_end:=end_at-interval '7 days';
 elsif p_period='28d' then start_at:=today_start-interval '27 days'; previous_start:=start_at-interval '28 days';previous_end:=end_at-interval '28 days';
 elsif p_period='month' then start_at:=date_trunc('month',now() at time zone 'Asia/Hong_Kong') at time zone 'Asia/Hong_Kong';previous_start:=(date_trunc('month',now() at time zone 'Asia/Hong_Kong')-interval '1 month') at time zone 'Asia/Hong_Kong';previous_end:=least(start_at,previous_start+(end_at-start_at));
 else start_at:='1970-01-01T00:00:00Z'::timestamptz;previous_start:=start_at;previous_end:=start_at;end if;
 select count(*) into previous_total from eco_private.feedback_contributions where user_id=actor.id and created_at>=previous_start and created_at<previous_end;
 select count(*) into total from eco_private.feedback_contributions where user_id=actor.id and created_at>=start_at and created_at<end_at;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'userId',user_id,'feedbackId',feedback_id,'createdAt',created_at,'kind','feedback') order by created_at desc),'[]'::jsonb) into recent
 from (select * from eco_private.feedback_contributions where user_id=actor.id and created_at>=start_at and created_at<end_at order by created_at desc limit 50) f;
 return jsonb_build_object('count',total,'previousCount',previous_total,'periodStart',start_at,'periodEnd',end_at,'timeZone','Asia/Hong_Kong','source','shared-feedback','items',recent);
end;$$;
create function eco_private.admin_health() returns jsonb
language plpgsql security definer set search_path='' as $$
declare applied_head text;
begin
 perform eco_private.admin_read_member();
 -- Supabase's actual append-only migration history keeps this current for every later release.
 -- The private marker is used only by isolated SQL fixtures without the provider migration schema.
 if to_regclass('supabase_migrations.schema_migrations') is not null then
   execute 'select max(version) from supabase_migrations.schema_migrations' into applied_head;
 else select max(migration_head) into applied_head from eco_private.platform_versions; end if;
 return jsonb_build_object('observedAt',now(),'migrationHead',applied_head,
 'pendingImports',(select count(*) from eco_private.import_jobs where status='processing'),
 'failedImports',(select count(*) from eco_private.import_jobs where status='failed'),
 'oldestPendingImportAt',(select min(updated_at) from eco_private.import_jobs where status='processing'));
end;$$;

-- Private rows are never exposed directly; these invoker wrappers call guarded private operations.
create function public.eco_create_feedback(p_input jsonb) returns jsonb language sql set search_path='' as $$select eco_private.create_feedback(p_input);$$;
create function public.eco_triage_feedback(p_input jsonb) returns jsonb language sql set search_path='' as $$select eco_private.triage_feedback(p_input);$$;
create function public.eco_list_feedback(p_query jsonb) returns jsonb language sql set search_path='' as $$select eco_private.list_feedback(p_query);$$;
create function public.eco_begin_import(p_input jsonb) returns jsonb language sql set search_path='' as $$select eco_private.begin_import(p_input);$$;
create function public.eco_transition_import(p_input jsonb) returns jsonb language sql set search_path='' as $$select eco_private.transition_import(p_input);$$;
create function public.eco_retry_import(p_input jsonb) returns jsonb language sql set search_path='' as $$select eco_private.retry_import(p_input);$$;
create function public.eco_list_imports(p_query jsonb) returns jsonb language sql set search_path='' as $$select eco_private.list_imports(p_query);$$;
create function public.eco_list_audit(p_query jsonb) returns jsonb language sql set search_path='' as $$select eco_private.list_audit(p_query);$$;
create function public.eco_feedback_contributions(p_period text default '7d') returns jsonb language sql set search_path='' as $$select eco_private.feedback_contribution_summary(p_period);$$;
create function public.eco_admin_health() returns jsonb language sql set search_path='' as $$select eco_private.admin_health();$$;
revoke all on function eco_private.admin_read_member(),eco_private.admin_can_read_all(eco_private.users),eco_private.admin_writable_member(),eco_private.admin_check_keys(jsonb,text[]),eco_private.admin_check_text(jsonb,text,integer,integer),eco_private.admin_request(uuid,jsonb,text),eco_private.admin_finish(uuid,jsonb,jsonb),eco_private.present_feedback(eco_private.feedback),eco_private.present_import(eco_private.import_jobs),eco_private.admin_validate_query(jsonb,text[]),eco_private.admin_page(jsonb,integer),eco_private.audit_access_details(jsonb,jsonb) from public,anon,authenticated,service_role;
revoke all on function eco_private.create_feedback(jsonb),eco_private.triage_feedback(jsonb),eco_private.list_feedback(jsonb),eco_private.begin_import(jsonb),eco_private.transition_import(jsonb),eco_private.retry_import(jsonb),eco_private.list_imports(jsonb),eco_private.list_audit(jsonb),eco_private.feedback_contribution_summary(text),eco_private.admin_health(),public.eco_create_feedback(jsonb),public.eco_triage_feedback(jsonb),public.eco_list_feedback(jsonb),public.eco_begin_import(jsonb),public.eco_transition_import(jsonb),public.eco_retry_import(jsonb),public.eco_list_imports(jsonb),public.eco_list_audit(jsonb),public.eco_feedback_contributions(text),public.eco_admin_health() from public,anon,authenticated;
grant execute on function eco_private.create_feedback(jsonb),eco_private.triage_feedback(jsonb),eco_private.list_feedback(jsonb),eco_private.begin_import(jsonb),eco_private.transition_import(jsonb),eco_private.retry_import(jsonb),eco_private.list_imports(jsonb),eco_private.list_audit(jsonb),eco_private.feedback_contribution_summary(text),eco_private.admin_health(),public.eco_create_feedback(jsonb),public.eco_triage_feedback(jsonb),public.eco_list_feedback(jsonb),public.eco_begin_import(jsonb),public.eco_transition_import(jsonb),public.eco_retry_import(jsonb),public.eco_list_imports(jsonb),public.eco_list_audit(jsonb),public.eco_feedback_contributions(text),public.eco_admin_health() to authenticated;

-- External scheduler evidence is a separate trusted ingestion path, never a client-reported green check.
create table eco_private.operational_evidence (
 check_run text primary key check(check_run ~ '^[0-9]{1,30}$'), observed_at timestamptz not null,
 status text not null check(status in ('healthy','degraded','unavailable')), latency_ms integer not null check(latency_ms between 0 and 60000),
 source text not null check(source='github-actions'), kind text not null check(kind='external-availability'), received_at timestamptz not null default now()
);
alter table eco_private.operational_evidence enable row level security;
revoke all on eco_private.operational_evidence from public,anon,authenticated;
create index eco_operational_evidence_time on eco_private.operational_evidence(observed_at desc);
create function eco_private.record_monitor_evidence(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare prior eco_private.operational_evidence; stamp timestamptz;
begin
 perform pg_advisory_xact_lock(1857,2027);
 perform eco_private.admin_check_keys(p_input,array['checkRun','observedAt','status','latencyMs','source','kind']);
 if p_input->>'checkRun' is null or (p_input->>'checkRun') !~ '^[0-9]{1,30}$' or p_input->>'status' is null or p_input->>'status' not in ('healthy','degraded','unavailable')
 or p_input->>'source' is distinct from 'github-actions' or p_input->>'kind' is distinct from 'external-availability'
 or jsonb_typeof(p_input->'latencyMs') is distinct from 'number' or (p_input->>'latencyMs') !~ '^[0-9]+$' or (p_input->>'latencyMs')::numeric>60000
 or jsonb_typeof(p_input->'observedAt') is distinct from 'string' then raise exception 'Invalid evidence' using errcode='22023'; end if;
 stamp:=(p_input->>'observedAt')::timestamptz;
 select * into prior from eco_private.operational_evidence where check_run=p_input->>'checkRun';
 if found then
  if prior.observed_at<>stamp or prior.status<>p_input->>'status' or prior.latency_ms<>(p_input->>'latencyMs')::integer then raise exception 'Evidence conflict' using errcode='PT409'; end if;
  return jsonb_build_object('recorded',true);
 end if;
 if stamp<now()-interval '10 minutes' or stamp>now()+interval '2 minutes' then raise exception 'Stale evidence' using errcode='22023'; end if;
 if(select count(*) from eco_private.operational_evidence where received_at>now()-interval '1 minute')>=6 then raise exception 'Rate limit' using errcode='PT429'; end if;
 insert into eco_private.operational_evidence(check_run,observed_at,status,latency_ms,source,kind) values(p_input->>'checkRun',stamp,p_input->>'status',(p_input->>'latencyMs')::integer,'github-actions','external-availability');
 return jsonb_build_object('recorded',true);
end;$$;
create function eco_private.admin_evidence() returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 perform eco_private.admin_read_member();
 return jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('checkRun',check_run,'observedAt',observed_at,'status',status,'latencyMs',latency_ms,'source',source,'kind',kind) order by observed_at desc) from (select * from eco_private.operational_evidence order by observed_at desc limit 20) e),'[]'::jsonb));
end;$$;
create function public.eco_record_monitor_evidence(p_input jsonb) returns jsonb language sql set search_path='' as $$select eco_private.record_monitor_evidence(p_input);$$;
create function public.eco_admin_evidence() returns jsonb language sql set search_path='' as $$select eco_private.admin_evidence();$$;
revoke all on function eco_private.record_monitor_evidence(jsonb),public.eco_record_monitor_evidence(jsonb) from public,anon,authenticated;
grant execute on function eco_private.record_monitor_evidence(jsonb),public.eco_record_monitor_evidence(jsonb) to service_role;
revoke all on function eco_private.admin_evidence(),public.eco_admin_evidence() from public,anon,authenticated;
grant execute on function eco_private.admin_evidence(),public.eco_admin_evidence() to authenticated;


-- BOOTSTRAP SECTION 20261014113610_eco_supplier_foundation.sql
-- Shared supplier master. Source imports are private, reproducible and never overwrite an existing record.
create table eco_private.suppliers (
 id uuid primary key, source_key text not null unique, record jsonb not null check(jsonb_typeof(record)='object'),
 country_code text generated always as (record->>'countryCode') stored,
 legal_name text generated always as (record->>'legalName') stored,
 short_name text generated always as (record->>'shortName') stored,
 revision integer not null default 1 check(revision>0), updated_at timestamptz not null default now()
);
create index eco_suppliers_country_name on eco_private.suppliers(country_code,legal_name,id);
create table eco_private.supplier_legacy_ids (legacy_id text primary key, supplier_id uuid not null references eco_private.suppliers(id));
create index eco_supplier_legacy_supplier on eco_private.supplier_legacy_ids(supplier_id);
create table eco_private.supplier_revisions (
 supplier_id uuid not null references eco_private.suppliers(id), revision integer not null, actor_id uuid not null,
 reason text not null check(reason in ('import','update','enrichment')), snapshot jsonb not null, created_at timestamptz not null default now(),
 primary key(supplier_id,revision)
);
create table eco_private.supplier_import_batches (
 id uuid primary key, operator_id uuid not null, source_hash text not null check(source_hash ~ '^[a-f0-9]{64}$'),
 fingerprint text not null, source_records jsonb not null, before_records jsonb not null, result jsonb,
 created_at timestamptz not null default now()
);
alter table eco_private.suppliers enable row level security;
alter table eco_private.supplier_legacy_ids enable row level security;
alter table eco_private.supplier_revisions enable row level security;
alter table eco_private.supplier_import_batches enable row level security;
revoke all on eco_private.suppliers,eco_private.supplier_legacy_ids,eco_private.supplier_revisions,eco_private.supplier_import_batches from public,anon,authenticated;

create function eco_private.supplier_uuid(p_value jsonb) returns uuid language plpgsql set search_path='' as $$
begin
 if jsonb_typeof(p_value) is distinct from 'string' or (p_value#>>'{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Invalid identifier' using errcode='22023'; end if;
 return (p_value#>>'{}')::uuid;
end;$$;
create function eco_private.supplier_info_check(p_info jsonb) returns void language plpgsql set search_path='' as $$
declare k text;
begin
 perform eco_private.admin_check_keys(p_info,array['paymentTerms','qualityClaimBar','supplierTrader','availableGrade','foBdn','goBdn']);
 foreach k in array array['paymentTerms','qualityClaimBar','supplierTrader','availableGrade','foBdn','goBdn'] loop perform eco_private.admin_check_text(p_info,k,0,2000);end loop;
end;$$;
create function eco_private.supplier_rows_check(p_rows jsonb,p_kind text) returns void language plpgsql set search_path='' as $$
declare item jsonb; k text; keys text[]; max_rows integer;
begin
 if p_kind='contacts' then keys:=array['id','role','name','phone','email','sourceId'];max_rows:=100;
 elsif p_kind='barges' then keys:=array['id','name','imo','grade','capacity','sourceId'];max_rows:=200;
 else raise exception 'Invalid row kind' using errcode='22023';end if;
 if jsonb_typeof(p_rows) is distinct from 'array' then raise exception 'Invalid rows' using errcode='22023';end if;
 if jsonb_array_length(p_rows)>max_rows then raise exception 'Too many rows' using errcode='22023';end if;
 for item in select value from jsonb_array_elements(p_rows) loop
  perform eco_private.admin_check_keys(item,keys);foreach k in array keys loop perform eco_private.admin_check_text(item,k,0,500);end loop;
  perform eco_private.admin_check_text(item,'id',1,100);perform eco_private.admin_check_text(item,'sourceId',0,160);perform eco_private.admin_check_text(item,'name',case when p_kind='barges' then 1 else 0 end,300);
  if p_kind='contacts' and item->>'role' not in ('sales','ops','general') then raise exception 'Invalid contact role' using errcode='22023';end if;
  if p_kind='contacts' and trim(item->>'name')='' and trim(item->>'phone')='' and trim(item->>'email')='' then raise exception 'Contact details required' using errcode='22023';end if;
  if p_kind='barges' then perform eco_private.admin_check_text(item,'imo',0,100);perform eco_private.admin_check_text(item,'grade',0,300);perform eco_private.admin_check_text(item,'capacity',0,300);end if;
 end loop;
 if (select count(distinct value->>'id') from jsonb_array_elements(p_rows))<>jsonb_array_length(p_rows) then raise exception 'Duplicate row identifier' using errcode='22023';end if;
end;$$;
create function eco_private.supplier_record_check(p_record jsonb) returns void language plpgsql set search_path='' as $$
declare item jsonb; k text; source_ids text[];
begin
 perform eco_private.admin_check_keys(p_record,array['id','legacyIds','sourceKey','legalName','shortName','aliases','countryCode','countryName','portName','nameStatus','legalNameSourceId','info','contacts','barges','facts','sources']);
 perform eco_private.supplier_uuid(p_record->'id');
 foreach k in array array['sourceKey','legalName','shortName','countryCode','countryName','portName','nameStatus'] loop perform eco_private.admin_check_text(p_record,k,1,300);end loop;
 if p_record->>'countryCode' !~ '^[A-Z]{2}$' or p_record->>'nameStatus' not in ('verified','needs-review') or length(p_record->>'sourceKey')>160 then raise exception 'Invalid identity' using errcode='22023';end if;
 foreach k in array array['legacyIds','aliases','facts','sources'] loop
  if jsonb_typeof(p_record->k) is distinct from 'array' then raise exception 'Invalid array' using errcode='22023';end if;
  if jsonb_array_length(p_record->k)>(case when k='sources' then 1000 else 200 end) then raise exception 'Too many records' using errcode='22023';end if;
 end loop;
 foreach k in array array['legacyIds','aliases'] loop
  for item in select value from jsonb_array_elements(p_record->k) loop
   if jsonb_typeof(item) is distinct from 'string' or length(trim(item#>>'{}')) not between 1 and 160 then raise exception 'Invalid alias' using errcode='22023';end if;
  end loop;
  if (select count(distinct value) from jsonb_array_elements(p_record->k))<>jsonb_array_length(p_record->k) then raise exception 'Duplicate alias' using errcode='22023';end if;
 end loop;
 for item in select value from jsonb_array_elements(p_record->'sources') loop
  perform eco_private.admin_check_keys(item,array['id','type','title','url','documentDate','retrievedAt','page','reference']);
  perform eco_private.admin_check_text(item,'id',1,160);perform eco_private.admin_check_text(item,'type',1,20);perform eco_private.admin_check_text(item,'title',1,300);
  perform eco_private.admin_check_text(item,'url',0,2000);perform eco_private.admin_check_text(item,'documentDate',0,40);perform eco_private.admin_check_text(item,'retrievedAt',1,40);
  if item ? 'page' then perform eco_private.admin_check_text(item,'page',0,80);end if;
  if item ? 'reference' then perform eco_private.admin_check_text(item,'reference',0,300);end if;
  if item->>'type' not in ('mpa','spc','infospectrum','website','user') or ((item->>'url')<>'' and (item->>'url') !~ '^https?://') then raise exception 'Invalid source' using errcode='22023';end if;
 end loop;
 select coalesce(array_agg(value->>'id'),'{}'::text[]) into source_ids from jsonb_array_elements(p_record->'sources');
 if cardinality(source_ids)<>(select count(distinct x) from unnest(source_ids) x) then raise exception 'Duplicate source' using errcode='22023';end if;
 if not(p_record ? 'legalNameSourceId') or jsonb_typeof(p_record->'legalNameSourceId') not in ('string','null') then raise exception 'Missing name provenance' using errcode='22023';end if;
 if p_record->>'legalNameSourceId' is not null and not((p_record->>'legalNameSourceId')=any(source_ids)) then raise exception 'Unknown name source' using errcode='22023';end if;
 if p_record->>'nameStatus'='verified' and p_record->>'legalNameSourceId' is null then raise exception 'Verified name requires a source' using errcode='22023';end if;
 for item in select value from jsonb_array_elements(p_record->'facts') loop
  perform eco_private.admin_check_keys(item,array['label','value','sourceId']);perform eco_private.admin_check_text(item,'label',1,160);perform eco_private.admin_check_text(item,'value',1,4000);perform eco_private.admin_check_text(item,'sourceId',1,160);
  if not((item->>'sourceId')=any(source_ids)) then raise exception 'Unknown fact source' using errcode='22023';end if;
 end loop;
 perform eco_private.supplier_info_check(p_record->'info');perform eco_private.supplier_rows_check(p_record->'contacts','contacts');perform eco_private.supplier_rows_check(p_record->'barges','barges');
 for item in select value from jsonb_array_elements((p_record->'contacts')||(p_record->'barges')) loop
  if not((item->>'sourceId')=any(source_ids)) then raise exception 'Unknown operational source' using errcode='22023';end if;
 end loop;
 if octet_length(p_record::text)>524288 then raise exception 'Record too large' using errcode='22023';end if;
end;$$;
create function eco_private.present_supplier(p eco_private.suppliers,p_summary boolean default false) returns jsonb language sql stable set search_path='' as $$
 select (case when p_summary then (p.record-'contacts'-'barges'-'facts'-'sources')||jsonb_build_object('contactCount',jsonb_array_length(p.record->'contacts'),'bargeCount',jsonb_array_length(p.record->'barges')) else p.record end)||jsonb_build_object('id',p.id,'revision',p.revision,'updatedAt',p.updated_at);
$$;
create function eco_private.list_suppliers(p_query jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare q text; country text; grade text; trader text; page integer; lim integer; result jsonb; total bigint;
begin
 perform eco_private.current_member();perform eco_private.admin_check_keys(p_query,array['search','country','grade','trader','page','limit']);
 perform eco_private.admin_check_text(p_query,'search',0,160);perform eco_private.admin_check_text(p_query,'country',0,2);perform eco_private.admin_check_text(p_query,'grade',0,100);perform eco_private.admin_check_text(p_query,'trader',0,160);
 if jsonb_typeof(p_query->'page') is distinct from 'number' or (p_query->>'page') !~ '^[1-9][0-9]*$' or (p_query->>'page')::numeric>100000 or jsonb_typeof(p_query->'limit') is distinct from 'number' or (p_query->>'limit') !~ '^[1-9][0-9]*$' or (p_query->>'limit')::numeric>100 then raise exception 'Invalid pagination' using errcode='22023';end if;
 q:=lower(trim(p_query->>'search'));country:=upper(trim(p_query->>'country'));grade:=lower(trim(p_query->>'grade'));trader:=lower(trim(p_query->>'trader'));page:=(p_query->>'page')::integer;lim:=(p_query->>'limit')::integer;
 with matched as materialized (select s.* from eco_private.suppliers s where (country='' or s.country_code=country)
 and (q='' or position(q in lower(s.legal_name||' '||s.short_name||' '||(s.record->'aliases')::text))>0)
 and (grade='' or position(grade in lower(s.record#>>'{info,availableGrade}'))>0)
 and (trader='' or position(trader in lower(s.record#>>'{info,supplierTrader}'))>0)),
 paged as (select * from matched order by legal_name,id limit lim offset (page-1)*lim)
 select (select count(*) from matched),coalesce(jsonb_agg(eco_private.present_supplier(p,true) order by p.legal_name,p.id),'[]'::jsonb) into total,result from paged p;
 return jsonb_build_object('items',result,'page',page,'pageSize',lim,'total',total);
end;$$;
create function eco_private.supplier_detail(p_id text) returns jsonb language plpgsql security definer set search_path='' as $$
declare item eco_private.suppliers;
begin
 perform eco_private.current_member();if p_id is null or length(p_id) not between 1 and 160 then raise exception 'Invalid identifier' using errcode='22023';end if;
 select s.* into item from eco_private.suppliers s where s.id::text=lower(p_id) or exists(select 1 from eco_private.supplier_legacy_ids l where l.supplier_id=s.id and l.legacy_id=p_id);
 if not found then return null;end if;return eco_private.present_supplier(item);
end;$$;
create function eco_private.update_supplier(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor eco_private.users; prior jsonb; item eco_private.suppliers; sid uuid; next_record jsonb; row_value jsonb; old_row jsonb; rows jsonb; kind text; source_id text; source jsonb;
begin
 actor:=eco_private.admin_writable_member();perform eco_private.admin_check_keys(p_input,array['requestId','id','revision','info','contacts','barges']);sid:=eco_private.supplier_uuid(p_input->'id');
 if jsonb_typeof(p_input->'revision') is distinct from 'number' or (p_input->>'revision') !~ '^[1-9][0-9]*$' or (p_input->>'revision')::numeric>2147483647 then raise exception 'Invalid revision' using errcode='22023';end if;
 perform eco_private.supplier_info_check(p_input->'info');perform eco_private.supplier_rows_check(p_input->'contacts','contacts');perform eco_private.supplier_rows_check(p_input->'barges','barges');
 prior:=eco_private.admin_request(actor.id,p_input,'supplier-update');if prior is not null then return prior;end if;
 select * into item from eco_private.suppliers where id=sid for update;if not found then raise exception 'Unknown supplier' using errcode='22023';end if;
 if item.revision<>(p_input->>'revision')::integer then raise exception 'Revision conflict' using errcode='PT409';end if;
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
 if next_record=item.record then raise exception 'No changes' using errcode='22023';end if;
 source:=jsonb_build_object('id',source_id,'type','user','title',actor.display_name,'url','','documentDate',to_char(now() at time zone 'Asia/Hong_Kong','YYYY-MM-DD'),'retrievedAt',now());
 -- Retain cited operational sources and all imported evidence. Superseded uncited user sources
 -- remain in immutable revision snapshots rather than growing the current profile indefinitely.
 next_record:=jsonb_set(next_record,'{sources}',coalesce((select jsonb_agg(value) from jsonb_array_elements(next_record->'sources') old_source
  where value->>'type'<>'user' or value->>'id'=next_record->>'legalNameSourceId'
   or exists(select 1 from jsonb_array_elements((next_record->'contacts')||(next_record->'barges')||(next_record->'facts')) cited where cited->>'sourceId'=old_source.value->>'id')),'[]'::jsonb)||jsonb_build_array(source));
 perform eco_private.supplier_record_check(next_record);
 update eco_private.suppliers set record=next_record,revision=revision+1,updated_at=now() where id=sid returning * into item;
 insert into eco_private.supplier_revisions(supplier_id,revision,actor_id,reason,snapshot) values(sid,item.revision,actor.id,'update',eco_private.present_supplier(item));
 insert into eco_private.administration_events(actor_id,actor_name,target_id,action,details) values(actor.id,actor.display_name,sid,'supplier-updated',jsonb_build_object('revision',item.revision,'shortName',item.short_name));
 return eco_private.admin_finish(actor.id,p_input,eco_private.present_supplier(item));
end;$$;
create function eco_private.import_suppliers(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor eco_private.users; batch eco_private.supplier_import_batches; source_record jsonb; item eco_private.suppliers; result jsonb; outcomes jsonb:='[]'::jsonb; before_records jsonb:='[]'::jsonb; rid uuid; actor_id uuid; fingerprint text; inserted integer:=0; preserved integer:=0; legacy text;
begin
 if auth.jwt()->>'role' is distinct from 'service_role' then raise exception 'Operator access required' using errcode='42501';end if;
 perform pg_advisory_xact_lock(1857,2026);perform eco_private.admin_check_keys(p_input,array['requestId','operatorId','sourceHash','records']);
 rid:=eco_private.supplier_uuid(p_input->'requestId');actor_id:=eco_private.supplier_uuid(p_input->'operatorId');
 select * into actor from eco_private.users where id=actor_id and is_admin and is_active and activated_at is not null and deleted_at is null;
 if not found then raise exception 'Active operator administrator required' using errcode='42501';end if;
 perform eco_private.admin_check_text(p_input,'sourceHash',64,64);if p_input->>'sourceHash' !~ '^[a-f0-9]{64}$' then raise exception 'Invalid source hash' using errcode='22023';end if;
 if jsonb_typeof(p_input->'records') is distinct from 'array' then raise exception 'Invalid records' using errcode='22023';end if;
 if jsonb_array_length(p_input->'records') not between 1 and 200 or octet_length(p_input::text)>20971520 then raise exception 'Invalid batch size' using errcode='22023';end if;
 fingerprint:=encode(sha256(convert_to(p_input::text,'UTF8')),'hex');select * into batch from eco_private.supplier_import_batches where id=rid;
 if found then if batch.fingerprint<>fingerprint then raise exception 'Import request conflict' using errcode='PT409';end if;return batch.result;end if;
 if (select count(distinct value->>'sourceKey') from jsonb_array_elements(p_input->'records'))<>jsonb_array_length(p_input->'records') or (select count(distinct value->>'id') from jsonb_array_elements(p_input->'records'))<>jsonb_array_length(p_input->'records') then raise exception 'Duplicate batch identity' using errcode='22023';end if;
 for source_record in select value from jsonb_array_elements(p_input->'records') loop
  perform eco_private.supplier_record_check(source_record);select * into item from eco_private.suppliers where source_key=source_record->>'sourceKey';
  if found then
   if item.id<>(source_record->>'id')::uuid or (item.record->'legacyIds')<>(source_record->'legacyIds') then raise exception 'Source identity conflict' using errcode='PT409';end if;
   before_records:=before_records||jsonb_build_array(eco_private.present_supplier(item));preserved:=preserved+1;outcomes:=outcomes||jsonb_build_array(jsonb_build_object('id',item.id,'sourceKey',item.source_key,'status','preserved'));
  else
   insert into eco_private.suppliers(id,source_key,record) values((source_record->>'id')::uuid,source_record->>'sourceKey',source_record) returning * into item;
   for legacy in select value from jsonb_array_elements_text(source_record->'legacyIds') loop
    if exists(select 1 from eco_private.suppliers where id::text=legacy and id<>item.id) then raise exception 'Legacy identity conflict' using errcode='PT409';end if;
    insert into eco_private.supplier_legacy_ids(legacy_id,supplier_id) values(legacy,item.id);
   end loop;
   if exists(select 1 from eco_private.supplier_legacy_ids where legacy_id=item.id::text and supplier_id<>item.id) then raise exception 'Canonical identity conflict' using errcode='PT409';end if;
   insert into eco_private.supplier_revisions(supplier_id,revision,actor_id,reason,snapshot) values(item.id,1,actor.id,'import',eco_private.present_supplier(item));
   inserted:=inserted+1;outcomes:=outcomes||jsonb_build_array(jsonb_build_object('id',item.id,'sourceKey',item.source_key,'status','inserted'));
  end if;
 end loop;
 result:=jsonb_build_object('batchId',rid,'inserted',inserted,'preserved',preserved,'items',outcomes);
 insert into eco_private.supplier_import_batches(id,operator_id,source_hash,fingerprint,source_records,before_records,result) values(rid,actor.id,p_input->>'sourceHash',fingerprint,p_input->'records',before_records,result);
 insert into eco_private.administration_events(actor_id,actor_name,target_id,action,details) values(actor.id,actor.display_name,rid,'suppliers-imported',jsonb_build_object('inserted',inserted,'preserved',preserved,'sourceHash',p_input->>'sourceHash','provenance','server-published'));
 return result;
end;$$;
-- Targeted evidence enrichment is revision-checked and cannot modify operational fields.
create function eco_private.enrich_supplier(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor eco_private.users; item eco_private.suppliers; prior jsonb; next_record jsonb; source jsonb; old_source jsonb; sources jsonb; k text;
begin
 if auth.jwt()->>'role' is distinct from 'service_role' then raise exception 'Operator access required' using errcode='42501';end if;
 perform pg_advisory_xact_lock(1857,2026);
 perform eco_private.admin_check_keys(p_input,array['requestId','operatorId','id','revision','legalName','nameStatus','legalNameSourceId','facts','sources']);
 select * into actor from eco_private.users where id=eco_private.supplier_uuid(p_input->'operatorId') and is_admin and is_active and activated_at is not null and deleted_at is null;
 if not found then raise exception 'Active operator administrator required' using errcode='42501';end if;
 if jsonb_typeof(p_input->'revision') is distinct from 'number' or (p_input->>'revision') !~ '^[1-9][0-9]*$' or (p_input->>'revision')::numeric>2147483647 or jsonb_typeof(p_input->'sources') is distinct from 'array' then raise exception 'Invalid enrichment' using errcode='22023';end if;
 prior:=eco_private.admin_request(actor.id,p_input,'supplier-enrich');if prior is not null then return prior;end if;
 select * into item from eco_private.suppliers where id=eco_private.supplier_uuid(p_input->'id') for update;
 if not found then raise exception 'Unknown supplier' using errcode='22023';end if;
 if item.revision<>(p_input->>'revision')::integer then raise exception 'Revision conflict' using errcode='PT409';end if;
 next_record:=item.record;sources:=item.record->'sources';
 for source in select value from jsonb_array_elements(p_input->'sources') loop
  select value into old_source from jsonb_array_elements(sources) where value->>'id'=source->>'id';
  if old_source is not null then if old_source<>source then raise exception 'Source is immutable; use a new source identifier' using errcode='PT409';end if;
  else sources:=sources||jsonb_build_array(source);end if;
 end loop;
 foreach k in array array['legalName','nameStatus','legalNameSourceId','facts'] loop
  if not(p_input ? k) then raise exception 'Missing enrichment' using errcode='22023';end if;
  next_record:=jsonb_set(next_record,array[k],p_input->k);
 end loop;
 next_record:=jsonb_set(next_record,'{sources}',sources);perform eco_private.supplier_record_check(next_record);
 if next_record=item.record then raise exception 'No changes' using errcode='22023';end if;
 update eco_private.suppliers set record=next_record,revision=revision+1,updated_at=now() where id=item.id returning * into item;
 insert into eco_private.supplier_revisions(supplier_id,revision,actor_id,reason,snapshot) values(item.id,item.revision,actor.id,'enrichment',eco_private.present_supplier(item));
 insert into eco_private.administration_events(actor_id,actor_name,target_id,action,details) values(actor.id,actor.display_name,item.id,'supplier-enriched',jsonb_build_object('revision',item.revision,'shortName',item.short_name,'nameStatus',item.record->>'nameStatus'));
 return eco_private.admin_finish(actor.id,p_input,eco_private.present_supplier(item));
end;$$;
create function public.eco_enrich_supplier(p_input jsonb) returns jsonb language sql set search_path='' as $$select eco_private.enrich_supplier(p_input);$$;
revoke all on function eco_private.enrich_supplier(jsonb),public.eco_enrich_supplier(jsonb) from public,anon,authenticated;
grant execute on function eco_private.enrich_supplier(jsonb),public.eco_enrich_supplier(jsonb) to service_role;
create function public.eco_list_suppliers(p_query jsonb) returns jsonb language sql set search_path='' as $$select eco_private.list_suppliers(p_query);$$;
create function public.eco_supplier_detail(p_id text) returns jsonb language sql set search_path='' as $$select eco_private.supplier_detail(p_id);$$;
create function public.eco_update_supplier(p_input jsonb) returns jsonb language sql set search_path='' as $$select eco_private.update_supplier(p_input);$$;
create function public.eco_import_suppliers(p_input jsonb) returns jsonb language sql set search_path='' as $$select eco_private.import_suppliers(p_input);$$;
revoke all on function eco_private.supplier_uuid(jsonb),eco_private.supplier_info_check(jsonb),eco_private.supplier_rows_check(jsonb,text),eco_private.supplier_record_check(jsonb),eco_private.present_supplier(eco_private.suppliers,boolean),eco_private.list_suppliers(jsonb),eco_private.supplier_detail(text),eco_private.update_supplier(jsonb),eco_private.import_suppliers(jsonb),public.eco_list_suppliers(jsonb),public.eco_supplier_detail(text),public.eco_update_supplier(jsonb),public.eco_import_suppliers(jsonb) from public,anon,authenticated;
grant execute on function eco_private.list_suppliers(jsonb),eco_private.supplier_detail(text),eco_private.update_supplier(jsonb),public.eco_list_suppliers(jsonb),public.eco_supplier_detail(text),public.eco_update_supplier(jsonb) to authenticated;
grant execute on function eco_private.import_suppliers(jsonb),public.eco_import_suppliers(jsonb) to service_role;
insert into eco_private.platform_versions(component,migration_head) values('suppliers','20261014113610');


-- BOOTSTRAP SECTION 20261014114056_eco_supplier_import_activity.sql
-- Supplier batches are actual committed publications. Browser parsing remains separately attributed.
create or replace function eco_private.list_imports(p_query jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor eco_private.users; can_admin boolean; show_all boolean; records jsonb; n integer; cursor_time timestamptz; cursor_id uuid;
begin
 actor:=eco_private.current_member(); can_admin:=eco_private.admin_can_read_all(actor); show_all:=can_admin and coalesce(p_query->>'scope','all')<>'mine';
 perform eco_private.admin_validate_query(p_query,array['processing','awaiting-review','failed','cancelled','awaiting-retry','published']); n:=(p_query->>'limit')::integer;
 if p_query->>'cursor'<>'' then cursor_time:=split_part(p_query->>'cursor','|',1)::timestamptz; cursor_id:=split_part(p_query->>'cursor','|',2)::uuid; end if;
 with entries as (
  select f.id,f.created_at,f.status,f.source_name,f.submitter_name,f.kind,eco_private.present_import(f) as data
  from eco_private.import_jobs f where (show_all or f.submitter_id=actor.id)
  union all
  select b.id,b.created_at,'published','SPC SUPPLIERS',coalesce(u.display_name,'OPERATOR'),'supplier',
   jsonb_build_object('id',b.id,'kind','supplier','sourceName','SPC SUPPLIERS','sourceType','application/json',
    'status','published','provenance','server-published','submitterId',b.operator_id,'submitterName',coalesce(u.display_name,'OPERATOR'),
    'createdAt',b.created_at,'updatedAt',b.created_at,'attempt',1,'revision',1,
    'warningCount',(select count(*) from jsonb_array_elements(b.source_records) r where r->>'nameStatus'='needs-review'),
    'errorCode',null,'summary',coalesce(b.result->>'inserted','0')||' SUPPLIERS IMPORTED; '||coalesce(b.result->>'preserved','0')||' EXISTING RECORDS PRESERVED.')
  from eco_private.supplier_import_batches b left join eco_private.users u on u.id=b.operator_id
  where can_admin and (show_all or b.operator_id=actor.id) and b.result is not null
 ), filtered as (
  select * from entries where (p_query->>'status'='' or status=p_query->>'status')
   and (p_query->>'search'='' or source_name ilike '%'||(p_query->>'search')||'%' or submitter_name ilike '%'||(p_query->>'search')||'%' or kind ilike '%'||(p_query->>'search')||'%')
   and (cursor_time is null or (created_at,id)<(cursor_time,cursor_id))
  order by created_at desc,id desc limit n+1
 ) select coalesce(jsonb_agg(jsonb_build_object('data',data,'cursor',created_at::text||'|'||id::text) order by created_at desc,id desc),'[]'::jsonb) into records from filtered;
 return eco_private.admin_page(records,n);
end;$$;
insert into eco_private.platform_versions(component,migration_head) values('supplier-import-activity','20261014114056');


-- BOOTSTRAP SECTION 20261015035025_eco_supplier_profile_permissions.sql
-- Supplier changes require live purchasing authority. Removal preserves the master and revision history.
alter table eco_private.suppliers add column background text not null default '' check(length(background)<=8000), add column archived_at timestamptz, add column archived_by uuid;
alter table eco_private.supplier_revisions drop constraint supplier_revisions_reason_check;
alter table eco_private.supplier_revisions add constraint supplier_revisions_reason_check check(reason in ('import','update','enrichment','create','archive','restore'));
create index eco_suppliers_active_country_name on eco_private.suppliers(country_code,legal_name,id) where archived_at is null;
create function eco_private.supplier_writable_member() returns eco_private.users language plpgsql security definer set search_path='' as $$
declare actor eco_private.users;begin
 actor:=eco_private.admin_writable_member();
 if not(actor.is_admin or actor.is_spc_trader) then raise exception 'Supplier authority required' using errcode='42501';end if;
 return actor;end;$$;
create or replace function eco_private.present_supplier(p eco_private.suppliers,p_summary boolean default false) returns jsonb language sql stable set search_path='' as $$
 select (case when p_summary then (p.record-'contacts'-'barges'-'facts'-'sources')||jsonb_build_object('contactCount',(select count(*) from jsonb_array_elements(p.record->'contacts') c where exists(select 1 from jsonb_array_elements(p.record->'sources') s where s->>'id'=c->>'sourceId' and s->>'type' in ('spc','user'))),'bargeCount',jsonb_array_length(p.record->'barges')) else p.record end)||jsonb_build_object('id',p.id,'revision',p.revision,'updatedAt',p.updated_at,'background',p.background);
$$;
create or replace function eco_private.list_suppliers(p_query jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare q text; country text; grade text; trader text; page integer; lim integer; result jsonb; total bigint;
begin
 perform eco_private.current_member();perform eco_private.admin_check_keys(p_query,array['search','country','grade','trader','page','limit']);
 perform eco_private.admin_check_text(p_query,'search',0,160);perform eco_private.admin_check_text(p_query,'country',0,2);perform eco_private.admin_check_text(p_query,'grade',0,100);perform eco_private.admin_check_text(p_query,'trader',0,160);
 if jsonb_typeof(p_query->'page') is distinct from 'number' or (p_query->>'page') !~ '^[1-9][0-9]*$' or (p_query->>'page')::numeric>100000 or jsonb_typeof(p_query->'limit') is distinct from 'number' or (p_query->>'limit') !~ '^[1-9][0-9]*$' or (p_query->>'limit')::numeric>100 then raise exception 'Invalid pagination' using errcode='22023';end if;
 q:=lower(trim(p_query->>'search'));country:=upper(trim(p_query->>'country'));grade:=lower(trim(p_query->>'grade'));trader:=lower(trim(p_query->>'trader'));page:=(p_query->>'page')::integer;lim:=(p_query->>'limit')::integer;
 with matched as materialized (select s.* from eco_private.suppliers s where s.archived_at is null and (country='' or s.country_code=country)
 and (q='' or position(q in lower(s.legal_name||' '||s.short_name||' '||(s.record->'aliases')::text))>0)
 and (grade='' or position(grade in lower(s.record#>>'{info,availableGrade}'))>0)
 and (trader='' or position(trader in lower(s.record#>>'{info,supplierTrader}'))>0)),
 paged as (select * from matched order by legal_name,id limit lim offset (page-1)*lim)
 select (select count(*) from matched),coalesce(jsonb_agg(eco_private.present_supplier(p,true) order by p.legal_name,p.id),'[]'::jsonb) into total,result from paged p;
 return jsonb_build_object('items',result,'page',page,'pageSize',lim,'total',total);
end;$$;
create or replace function eco_private.supplier_detail(p_id text) returns jsonb language plpgsql security definer set search_path='' as $$
declare item eco_private.suppliers;
begin
 perform eco_private.current_member();if p_id is null or length(p_id) not between 1 and 160 then raise exception 'Invalid identifier' using errcode='22023';end if;
 select s.* into item from eco_private.suppliers s where s.archived_at is null and (s.id::text=lower(p_id) or exists(select 1 from eco_private.supplier_legacy_ids l where l.supplier_id=s.id and l.legacy_id=p_id));
 if not found then return null;end if;return eco_private.present_supplier(item);
end;$$;
create or replace function eco_private.update_supplier(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor eco_private.users; prior jsonb; item eco_private.suppliers; sid uuid; next_record jsonb; row_value jsonb; old_row jsonb; rows jsonb; kind text; source_id text; source jsonb;
begin
 actor:=eco_private.supplier_writable_member();if octet_length(p_input::text)>262144 then raise exception 'Request too large' using errcode='22023';end if;perform eco_private.admin_check_keys(p_input,array['requestId','id','revision','info','contacts','barges','legalName','shortName','background']);sid:=eco_private.supplier_uuid(p_input->'id');
 if jsonb_typeof(p_input->'revision') is distinct from 'number' or (p_input->>'revision') !~ '^[1-9][0-9]*$' or (p_input->>'revision')::numeric>2147483647 then raise exception 'Invalid revision' using errcode='22023';end if;
 perform eco_private.supplier_info_check(p_input->'info');perform eco_private.supplier_rows_check(p_input->'contacts','contacts');perform eco_private.supplier_rows_check(p_input->'barges','barges');
 prior:=eco_private.admin_request(actor.id,p_input,'supplier-update');if prior is not null then return prior;end if;
 select * into item from eco_private.suppliers where id=sid and archived_at is null for update;if not found then raise exception 'Unknown supplier' using errcode='22023';end if;
 if item.revision<>(p_input->>'revision')::integer then raise exception 'Revision conflict' using errcode='PT409';end if;
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
 if next_record=item.record and coalesce(p_input->>'background',item.background)=item.background then raise exception 'No changes' using errcode='22023';end if;
 source:=jsonb_build_object('id',source_id,'type','user','title',actor.display_name,'url','','documentDate',to_char(now() at time zone 'Asia/Hong_Kong','YYYY-MM-DD'),'retrievedAt',now());
 -- Retain cited operational sources and all imported evidence. Superseded uncited user sources
 -- remain in immutable revision snapshots rather than growing the current profile indefinitely.
 next_record:=jsonb_set(next_record,'{sources}',coalesce((select jsonb_agg(value) from jsonb_array_elements(next_record->'sources') old_source
  where value->>'type'<>'user' or value->>'id'=next_record->>'legalNameSourceId'
   or exists(select 1 from jsonb_array_elements((next_record->'contacts')||(next_record->'barges')||(next_record->'facts')) cited where cited->>'sourceId'=old_source.value->>'id')),'[]'::jsonb)||jsonb_build_array(source));
 perform eco_private.supplier_record_check(next_record);
 update eco_private.suppliers set record=next_record,background=coalesce(p_input->>'background',background),revision=revision+1,updated_at=now() where id=sid returning * into item;
 insert into eco_private.supplier_revisions(supplier_id,revision,actor_id,reason,snapshot) values(sid,item.revision,actor.id,'update',eco_private.present_supplier(item));
 insert into eco_private.administration_events(actor_id,actor_name,target_id,action,details) values(actor.id,actor.display_name,sid,'supplier-updated',jsonb_build_object('revision',item.revision,'shortName',item.short_name));
 return eco_private.admin_finish(actor.id,p_input,eco_private.present_supplier(item));
end;$$;

create function eco_private.create_supplier(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor eco_private.users;prior jsonb;rid uuid;sid uuid;item eco_private.suppliers;rec jsonb;source_id text;source jsonb;kind text;rows jsonb;
begin
 actor:=eco_private.supplier_writable_member();
 if octet_length(p_input::text)>262144 then raise exception 'Request too large' using errcode='22023';end if;
 perform eco_private.admin_check_keys(p_input,array['requestId','legalName','shortName','countryCode','countryName','portName','background','info','contacts','barges']);
 rid:=eco_private.supplier_uuid(p_input->'requestId');perform eco_private.admin_check_text(p_input,'legalName',1,300);perform eco_private.admin_check_text(p_input,'shortName',1,160);perform eco_private.admin_check_text(p_input,'background',0,8000);
 if p_input->>'countryCode' is distinct from 'SG' or p_input->>'countryName' is distinct from 'Singapore' or p_input->>'portName' is distinct from 'Singapore' then raise exception 'Singapore supplier required' using errcode='22023';end if;
 perform eco_private.supplier_info_check(p_input->'info');perform eco_private.supplier_rows_check(p_input->'contacts','contacts');perform eco_private.supplier_rows_check(p_input->'barges','barges');
 prior:=eco_private.admin_request(actor.id,p_input,'supplier-create');if prior is not null then return prior;end if;
 if exists(select 1 from eco_private.suppliers where archived_at is null and country_code='SG' and (lower(trim(legal_name))=lower(trim(p_input->>'legalName')) or lower(trim(short_name))=lower(trim(p_input->>'shortName')))) then raise exception 'Duplicate supplier name' using errcode='PT409';end if;
 sid:=gen_random_uuid();source_id:='eco-create:'||rid::text;
 source:=jsonb_build_object('id',source_id,'type','user','title',actor.display_name,'url','','documentDate',to_char(now() at time zone 'Asia/Hong_Kong','YYYY-MM-DD'),'retrievedAt',now());
 rec:=jsonb_build_object('id',sid,'legacyIds','[]'::jsonb,'sourceKey','eco:'||rid::text,'legalName',trim(p_input->>'legalName'),'shortName',trim(p_input->>'shortName'),'aliases','[]'::jsonb,'countryCode','SG','countryName','Singapore','portName','Singapore','nameStatus','needs-review','legalNameSourceId',source_id,'info',p_input->'info','facts','[]'::jsonb,'sources',jsonb_build_array(source));
 foreach kind in array array['contacts','barges'] loop
  select coalesce(jsonb_agg(jsonb_set(value,'{sourceId}',to_jsonb(source_id))),'[]'::jsonb) into rows from jsonb_array_elements(p_input->kind);
  rec:=jsonb_set(rec,array[kind],rows);
 end loop;
 perform eco_private.supplier_record_check(rec);
 insert into eco_private.suppliers(id,source_key,record,background) values(sid,rec->>'sourceKey',rec,trim(p_input->>'background')) returning * into item;
 insert into eco_private.supplier_revisions(supplier_id,revision,actor_id,reason,snapshot) values(sid,1,actor.id,'create',eco_private.present_supplier(item));
 insert into eco_private.administration_events(actor_id,actor_name,target_id,action,details) values(actor.id,actor.display_name,sid,'supplier-created',jsonb_build_object('revision',1,'shortName',item.short_name));
 return eco_private.admin_finish(actor.id,p_input,eco_private.present_supplier(item));
end;$$;
create function eco_private.archive_supplier(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor eco_private.users;prior jsonb;item eco_private.suppliers;result jsonb;
begin
 actor:=eco_private.supplier_writable_member();if octet_length(p_input::text)>262144 then raise exception 'Request too large' using errcode='22023';end if;perform eco_private.admin_check_keys(p_input,array['requestId','id','revision']);perform eco_private.supplier_uuid(p_input->'id');
 if jsonb_typeof(p_input->'revision') is distinct from 'number' or (p_input->>'revision') !~ '^[1-9][0-9]*$' or (p_input->>'revision')::numeric>2147483647 then raise exception 'Invalid revision' using errcode='22023';end if;
 prior:=eco_private.admin_request(actor.id,p_input,'supplier-archive');if prior is not null then return prior;end if;
 select * into item from eco_private.suppliers where id=(p_input->>'id')::uuid and archived_at is null for update;
 if not found then raise exception 'Unknown supplier' using errcode='22023';end if;
 if item.revision<>(p_input->>'revision')::integer then raise exception 'Revision conflict' using errcode='PT409';end if;
 update eco_private.suppliers set archived_at=now(),archived_by=actor.id,revision=revision+1,updated_at=now() where id=item.id returning * into item;
 result:=jsonb_build_object('id',item.id,'revision',item.revision,'archivedAt',item.archived_at);
 insert into eco_private.supplier_revisions(supplier_id,revision,actor_id,reason,snapshot) values(item.id,item.revision,actor.id,'archive',eco_private.present_supplier(item)||result);
 insert into eco_private.administration_events(actor_id,actor_name,target_id,action,details) values(actor.id,actor.display_name,item.id,'supplier-archived',jsonb_build_object('revision',item.revision));
 return eco_private.admin_finish(actor.id,p_input,result);
end;$$;
-- Recovery is an explicit revision-checked operator action; it never runs automatically.
create function eco_private.restore_supplier(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor eco_private.users;item eco_private.suppliers;prior jsonb;
begin
 if auth.jwt()->>'role' is distinct from 'service_role' then raise exception 'Operator access required' using errcode='42501';end if;
 perform pg_advisory_xact_lock(1857,2026);perform eco_private.admin_check_keys(p_input,array['requestId','operatorId','id','revision']);
 select * into actor from eco_private.users where id=eco_private.supplier_uuid(p_input->'operatorId') and is_admin and is_active and activated_at is not null and deleted_at is null;
 if not found then raise exception 'Active operator administrator required' using errcode='42501';end if;
 if jsonb_typeof(p_input->'revision') is distinct from 'number' or (p_input->>'revision') !~ '^[1-9][0-9]*$' or (p_input->>'revision')::numeric>2147483647 then raise exception 'Invalid revision' using errcode='22023';end if;
 prior:=eco_private.admin_request(actor.id,p_input,'supplier-restore');if prior is not null then return prior;end if;
 select * into item from eco_private.suppliers where id=eco_private.supplier_uuid(p_input->'id') and archived_at is not null for update;
 if not found then raise exception 'Unknown archived supplier' using errcode='22023';end if;
 if item.revision<>(p_input->>'revision')::integer then raise exception 'Revision conflict' using errcode='PT409';end if;
 if exists(select 1 from eco_private.suppliers other where other.id<>item.id and other.archived_at is null and other.country_code=item.country_code and (lower(trim(other.legal_name))=lower(trim(item.legal_name)) or lower(trim(other.short_name))=lower(trim(item.short_name)))) then raise exception 'Duplicate supplier name' using errcode='PT409';end if;
 update eco_private.suppliers set archived_at=null,archived_by=null,revision=revision+1,updated_at=now() where id=item.id returning * into item;
 insert into eco_private.supplier_revisions(supplier_id,revision,actor_id,reason,snapshot) values(item.id,item.revision,actor.id,'restore',eco_private.present_supplier(item));
 insert into eco_private.administration_events(actor_id,actor_name,target_id,action,details) values(actor.id,actor.display_name,item.id,'supplier-restored',jsonb_build_object('revision',item.revision));
 return eco_private.admin_finish(actor.id,p_input,eco_private.present_supplier(item));
end;$$;
create function public.eco_create_supplier(p_input jsonb) returns jsonb language sql set search_path='' as $$select eco_private.create_supplier(p_input);$$;
create function public.eco_archive_supplier(p_input jsonb) returns jsonb language sql set search_path='' as $$select eco_private.archive_supplier(p_input);$$;
create function public.eco_restore_supplier(p_input jsonb) returns jsonb language sql set search_path='' as $$select eco_private.restore_supplier(p_input);$$;
revoke all on function eco_private.supplier_writable_member(),eco_private.create_supplier(jsonb),eco_private.archive_supplier(jsonb),eco_private.restore_supplier(jsonb),public.eco_create_supplier(jsonb),public.eco_archive_supplier(jsonb),public.eco_restore_supplier(jsonb) from public,anon,authenticated,service_role;
grant execute on function eco_private.create_supplier(jsonb),eco_private.archive_supplier(jsonb),public.eco_create_supplier(jsonb),public.eco_archive_supplier(jsonb) to authenticated;
grant execute on function eco_private.restore_supplier(jsonb),public.eco_restore_supplier(jsonb) to service_role;
update eco_private.platform_versions set migration_head='20261015035025' where component='suppliers';


-- BOOTSTRAP SECTION 20261015035027_eco_profile_tabs.sql
-- Collections are separate for shared tabs and each real owner. Application admins
-- have no special private-tab access. Private text never appears in audit metadata.
create table eco_private.profile_tab_collections (
 target_kind text not null check(target_kind in ('supplier','buyer','country','port')),
 target_id text not null check(length(target_id) between 1 and 160),
 owner_id uuid not null, -- zero UUID is the shared namespace; all others are real owners
 revision integer not null check(revision>0), tabs jsonb not null check(jsonb_typeof(tabs)='array'),
 updated_at timestamptz not null default now(), primary key(target_kind,target_id,owner_id)
);
-- Keep ID ownership after deletion to prevent turning a private tab into a shared tab.
create table eco_private.profile_tab_identities (
 target_kind text not null, target_id text not null, tab_id text not null, owner_id uuid not null,
 builtin text, created_at timestamptz not null default now(), primary key(target_kind,target_id,tab_id)
);
create unique index eco_profile_tab_custom_identity on eco_private.profile_tab_identities(tab_id) where builtin is null;
create table eco_private.profile_tab_revisions (
 target_kind text not null,target_id text not null,owner_id uuid not null,revision integer not null,
 actor_id uuid not null,tabs jsonb not null,created_at timestamptz not null default now(),
 primary key(target_kind,target_id,owner_id,revision)
);
alter table eco_private.profile_tab_collections enable row level security;
alter table eco_private.profile_tab_identities enable row level security;
alter table eco_private.profile_tab_revisions enable row level security;
revoke all on eco_private.profile_tab_collections,eco_private.profile_tab_identities,eco_private.profile_tab_revisions from public,anon,authenticated;

create function eco_private.profile_target_check(p_target jsonb) returns void language plpgsql set search_path='' as $$
begin
 perform eco_private.admin_check_keys(p_target,array['kind','id']);perform eco_private.admin_check_text(p_target,'id',1,160);
 if p_target->>'kind' is null or p_target->>'kind' not in ('supplier','buyer','country','port') or (p_target->>'kind'<>'country' and p_target->>'id' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$') or p_target->>'id' ~ '[\x01-\x1F\x7F]' then raise exception 'Invalid profile target' using errcode='22023';end if;
 if p_target->>'kind'='supplier' then
  perform eco_private.supplier_uuid(p_target->'id');
  if not exists(select 1 from eco_private.suppliers where id=(p_target->>'id')::uuid and archived_at is null) then raise exception 'Unknown supplier' using errcode='22023';end if;
 end if;
 -- Buyer/country/port IDs are stable application references. Their master records
 -- are not server-persisted yet; syntax is checked, existence is not asserted.
end;$$;
create function eco_private.profile_tabs_result(p_target jsonb,p_actor uuid,p_preview boolean) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('target',p_target,
 'shared',coalesce((select jsonb_build_object('revision',revision,'tabs',tabs) from eco_private.profile_tab_collections where target_kind=p_target->>'kind' and target_id=p_target->>'id' and owner_id='00000000-0000-0000-0000-000000000000'),jsonb_build_object('revision',0,'tabs','[]'::jsonb)),
 'private',case when p_preview then jsonb_build_object('revision',0,'tabs','[]'::jsonb) else coalesce((select jsonb_build_object('revision',revision,'tabs',tabs) from eco_private.profile_tab_collections where target_kind=p_target->>'kind' and target_id=p_target->>'id' and owner_id=p_actor),jsonb_build_object('revision',0,'tabs','[]'::jsonb)) end);
$$;
create function eco_private.list_profile_tabs(p_target jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor eco_private.users;target jsonb;preview boolean;
begin
 actor:=eco_private.current_member();perform eco_private.profile_target_check(p_target);
 target:=case when p_target->>'kind'='supplier' then jsonb_set(p_target,'{id}',to_jsonb(lower(p_target->>'id'))) else p_target end;
 preview:=exists(select 1 from eco_private.role_previews where session_id::text=auth.jwt()->>'session_id' and user_id=actor.id);
 return eco_private.profile_tabs_result(target,actor.id,preview);
end;$$;
create function eco_private.profile_tabs_validate(p_tabs jsonb,p_target jsonb,p_visibility text,p_owner uuid) returns void language plpgsql set search_path='' as $$
declare tab jsonb;identity eco_private.profile_tab_identities;tid text;builtin text;
begin
 if jsonb_typeof(p_tabs) is distinct from 'array' then raise exception 'Invalid tabs' using errcode='22023';end if;
 if jsonb_array_length(p_tabs)>30 or octet_length(p_tabs::text)>240000 then raise exception 'Too many tabs' using errcode='22023';end if;
 for tab in select value from jsonb_array_elements(p_tabs) loop
  perform eco_private.admin_check_keys(tab,array['id','title','visibility','builtin','content']);
  if length(tab->>'title')>80 or length(coalesce(tab->>'content',''))>20000 or (coalesce(tab->>'title','')||coalesce(tab->>'content','')) ~ '[\x01-\x08\x0B\x0C\x0E-\x1F]' then raise exception 'Invalid tab text' using errcode='22023';end if;perform eco_private.admin_check_text(tab,'id',1,80);perform eco_private.admin_check_text(tab,'title',1,80);
  if tab->>'visibility' is distinct from p_visibility then raise exception 'Invalid tab visibility' using errcode='22023';end if;
  tid:=tab->>'id';builtin:=tab->>'builtin';
  if tab ? 'builtin' then
   if p_visibility<>'shared' or p_target->>'kind'<>'supplier' or builtin is null or builtin not in ('information','contacts','barges','sources') or tid<>'builtin:'||builtin or tab ? 'content' then raise exception 'Invalid builtin tab' using errcode='22023';end if;
  else
   perform eco_private.supplier_uuid(tab->'id');
   if tid<>lower(tid) then raise exception 'Invalid tab identifier' using errcode='22023';end if;
   if tab ? 'content' then perform eco_private.admin_check_text(tab,'content',0,20000);end if;
  end if;
  select * into identity from eco_private.profile_tab_identities identities where tab_id=tid and (identities.builtin is null or (target_kind=p_target->>'kind' and target_id=p_target->>'id'));
  if found and (identity.owner_id<>p_owner or identity.target_kind<>p_target->>'kind' or identity.target_id<>p_target->>'id' or identity.builtin is distinct from builtin) then raise exception 'Invalid tab identity' using errcode='22023';end if;
 end loop;
 if (select count(distinct value->>'id') from jsonb_array_elements(p_tabs))<>jsonb_array_length(p_tabs) then raise exception 'Duplicate tab' using errcode='22023';end if;
end;$$;
create function eco_private.mutate_profile_tabs(p_input jsonb,p_action text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor eco_private.users;target jsonb;scope_owner uuid;visibility text;previous eco_private.profile_tab_collections;next_tabs jsonb;prior jsonb;expected integer;next_revision integer;tab jsonb;result jsonb;
begin
 actor:=eco_private.admin_writable_member();
 if octet_length(p_input::text)>262144 then raise exception 'Request too large' using errcode='22023';end if;
 if p_action='save' then perform eco_private.admin_check_keys(p_input,array['requestId','target','visibility','revision','tabs']);
 elsif p_action='delete' then perform eco_private.admin_check_keys(p_input,array['requestId','target','visibility','revision','id']);
 elsif p_action='reorder' then perform eco_private.admin_check_keys(p_input,array['requestId','target','visibility','revision','ids']);
 else raise exception 'Invalid tab operation' using errcode='22023';end if;
 perform eco_private.profile_target_check(p_input->'target');target:=p_input->'target';
 if target->>'kind'='supplier' then target:=jsonb_set(target,'{id}',to_jsonb(lower(target->>'id')));end if;
 visibility:=p_input->>'visibility';
 if visibility is null or visibility not in ('shared','private') then raise exception 'Invalid visibility' using errcode='22023';end if;
 if visibility='shared' and target->>'kind'='supplier' and not(actor.is_admin or actor.is_spc_trader) then raise exception 'Supplier authority required' using errcode='42501';end if;
 scope_owner:=case when visibility='shared' then '00000000-0000-0000-0000-000000000000'::uuid else actor.id end;
 if jsonb_typeof(p_input->'revision') is distinct from 'number' or p_input->>'revision' !~ '^(0|[1-9][0-9]*)$' or (p_input->>'revision')::numeric>=2147483647 then raise exception 'Invalid revision' using errcode='22023';end if;
 expected:=(p_input->>'revision')::integer;
 -- Only the exact real actor can retrieve a retry receipt, and preview was checked above.
 prior:=eco_private.admin_request(actor.id,p_input,'profile-tabs-'||p_action);if prior is not null then return prior;end if;
 select * into previous from eco_private.profile_tab_collections where target_kind=target->>'kind' and target_id=target->>'id' and owner_id=scope_owner for update;
 if coalesce(previous.revision,0)<>expected then raise exception 'Revision conflict' using errcode='PT409';end if;
 if p_action='save' then next_tabs:=p_input->'tabs';
 elsif p_action='delete' then
  perform eco_private.admin_check_text(p_input,'id',1,80);
  if not exists(select 1 from jsonb_array_elements(coalesce(previous.tabs,'[]')) where value->>'id'=p_input->>'id') then raise exception 'Unknown tab' using errcode='22023';end if;
  select coalesce(jsonb_agg(value order by ord),'[]') into next_tabs from jsonb_array_elements(previous.tabs) with ordinality v(value,ord) where value->>'id'<>p_input->>'id';
 else
  if jsonb_typeof(p_input->'ids') is distinct from 'array' then raise exception 'Invalid order' using errcode='22023';end if;
  if jsonb_array_length(p_input->'ids')<>jsonb_array_length(coalesce(previous.tabs,'[]')) or (select count(distinct value) from jsonb_array_elements(p_input->'ids'))<>jsonb_array_length(p_input->'ids') then raise exception 'Invalid order' using errcode='22023';end if;
  if exists(select 1 from jsonb_array_elements(p_input->'ids') v where jsonb_typeof(v) is distinct from 'string' or not exists(select 1 from jsonb_array_elements(previous.tabs) t where t->>'id'=v#>>'{}')) then raise exception 'Invalid order' using errcode='22023';end if;
  select coalesce(jsonb_agg(t order by n),'[]') into next_tabs from jsonb_array_elements_text(p_input->'ids') with ordinality v(id,n) join lateral jsonb_array_elements(previous.tabs) t on t->>'id'=id;
 end if;
 perform eco_private.profile_tabs_validate(next_tabs,target,visibility,scope_owner);
 if previous.revision is not null and next_tabs=previous.tabs then raise exception 'No changes' using errcode='22023';end if;
 next_revision:=coalesce(previous.revision,0)+1;
 insert into eco_private.profile_tab_collections(target_kind,target_id,owner_id,revision,tabs) values(target->>'kind',target->>'id',scope_owner,next_revision,next_tabs)
 on conflict(target_kind,target_id,owner_id) do update set revision=excluded.revision,tabs=excluded.tabs,updated_at=now();
 for tab in select value from jsonb_array_elements(next_tabs) loop
  insert into eco_private.profile_tab_identities(target_kind,target_id,tab_id,owner_id,builtin) values(target->>'kind',target->>'id',tab->>'id',scope_owner,tab->>'builtin') on conflict do nothing;
 end loop;
 insert into eco_private.profile_tab_revisions(target_kind,target_id,owner_id,revision,actor_id,tabs) values(target->>'kind',target->>'id',scope_owner,next_revision,actor.id,next_tabs);
 insert into eco_private.administration_events(actor_id,actor_name,target_id,action,details) values(actor.id,actor.display_name,(p_input->>'requestId')::uuid,'profile-tabs-'||p_action,jsonb_build_object('targetKind',target->>'kind','targetId',target->>'id','visibility',visibility,'revision',next_revision,'tabCount',jsonb_array_length(next_tabs)));
 result:=eco_private.profile_tabs_result(target,actor.id,false);
 return eco_private.admin_finish(actor.id,p_input,result);
end;$$;
create function public.eco_list_profile_tabs(p_target jsonb) returns jsonb language sql set search_path='' as $$select eco_private.list_profile_tabs(p_target);$$;
create function public.eco_save_profile_tabs(p_input jsonb) returns jsonb language sql set search_path='' as $$select eco_private.mutate_profile_tabs(p_input,'save');$$;
create function public.eco_delete_profile_tab(p_input jsonb) returns jsonb language sql set search_path='' as $$select eco_private.mutate_profile_tabs(p_input,'delete');$$;
create function public.eco_reorder_profile_tabs(p_input jsonb) returns jsonb language sql set search_path='' as $$select eco_private.mutate_profile_tabs(p_input,'reorder');$$;
revoke all on function eco_private.profile_target_check(jsonb),eco_private.profile_tabs_result(jsonb,uuid,boolean),eco_private.list_profile_tabs(jsonb),eco_private.profile_tabs_validate(jsonb,jsonb,text,uuid),eco_private.mutate_profile_tabs(jsonb,text),public.eco_list_profile_tabs(jsonb),public.eco_save_profile_tabs(jsonb),public.eco_delete_profile_tab(jsonb),public.eco_reorder_profile_tabs(jsonb) from public,anon,authenticated,service_role;
grant execute on function eco_private.list_profile_tabs(jsonb),eco_private.mutate_profile_tabs(jsonb,text),public.eco_list_profile_tabs(jsonb),public.eco_save_profile_tabs(jsonb),public.eco_delete_profile_tab(jsonb),public.eco_reorder_profile_tabs(jsonb) to authenticated;
insert into eco_private.platform_versions(component,migration_head) values('profile-tabs','20261015035027');


-- BOOTSTRAP SECTION 20261015035158_eco_supplier_report_storage.sql
-- Private immutable PDF evidence. Storage objects have no browser-role policies;
-- the server issues a one-minute download only after the live membership RPC.
create table eco_private.supplier_reports (
 id uuid primary key,
 supplier_id uuid not null references eco_private.suppliers(id),
 source_id text not null check(length(source_id) between 1 and 160),
 file_name text not null check(length(file_name) between 5 and 200 and file_name ~* '\.pdf$' and file_name !~ '[/\\\x00-\x1f]'),
 object_path text not null unique,
 sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
 size_bytes bigint not null check(size_bytes between 5 and 20971520),
 document_date date not null,
 uploaded_by uuid not null references eco_private.users(id),
 uploaded_at timestamptz not null default now(),
 unique(supplier_id,source_id,sha256),
 check(object_path=supplier_id::text||'/'||id::text||'/'||sha256||'.pdf')
);
create index eco_supplier_reports_supplier_date on eco_private.supplier_reports(supplier_id,document_date desc,id);
alter table eco_private.supplier_reports enable row level security;
revoke all on eco_private.supplier_reports from public,anon,authenticated;
create function eco_private.present_supplier_report(p eco_private.supplier_reports) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',p.id,'supplierId',p.supplier_id,'sourceId',p.source_id,'fileName',p.file_name,'size',p.size_bytes,'sha256',p.sha256,'documentDate',p.document_date,'uploadedAt',p.uploaded_at);
$$;
create function eco_private.list_supplier_reports(p_supplier_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform eco_private.current_member();
 return coalesce((select jsonb_agg(eco_private.present_supplier_report(r) order by r.document_date desc,r.id) from eco_private.supplier_reports r join eco_private.suppliers s on s.id=r.supplier_id where r.supplier_id=p_supplier_id and s.archived_at is null),'[]'::jsonb);
end;$$;
create function eco_private.supplier_report_access(p_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare r eco_private.supplier_reports;
begin
 perform eco_private.current_member();
 select d.* into r from eco_private.supplier_reports d join eco_private.suppliers s on s.id=d.supplier_id where d.id=p_id and s.archived_at is null;
 if not found then return null;end if;
 return eco_private.present_supplier_report(r)||jsonb_build_object('objectPath',r.object_path);
end;$$;
create function eco_private.register_supplier_report(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor eco_private.users; s eco_private.suppliers; old eco_private.supplier_reports; r eco_private.supplier_reports; rid uuid; sid uuid; src jsonb; d date;
begin
 if current_setting('request.jwt.claims',true)::jsonb->>'role' is distinct from 'service_role' then raise exception 'Forbidden' using errcode='42501';end if;
 perform pg_advisory_xact_lock(1857,2026);
 perform eco_private.admin_check_keys(p_input,array['id','operatorId','supplierId','sourceId','fileName','objectPath','sha256','size','documentDate']);
 rid:=eco_private.supplier_uuid(p_input->'id');sid:=eco_private.supplier_uuid(p_input->'supplierId');
 select * into actor from eco_private.users where id=eco_private.supplier_uuid(p_input->'operatorId') and deleted_at is null and is_active and activated_at is not null and access_hold_request is null and (is_admin or is_spc_trader);
 if not found then raise exception 'Supplier editor required' using errcode='42501';end if;
 select * into s from eco_private.suppliers where id=sid and archived_at is null for update;
 if not found then raise exception 'Supplier not found' using errcode='22023';end if;
 perform eco_private.admin_check_text(p_input,'sourceId',1,160);perform eco_private.admin_check_text(p_input,'fileName',5,200);perform eco_private.admin_check_text(p_input,'objectPath',1,300);perform eco_private.admin_check_text(p_input,'sha256',64,64);perform eco_private.admin_check_text(p_input,'documentDate',10,10);
 if jsonb_typeof(p_input->'size') is distinct from 'number' or p_input->>'size' !~ '^[0-9]+$' then raise exception 'Invalid size' using errcode='22023';end if;
 if p_input->>'documentDate' !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Invalid date' using errcode='22023';end if;d:=(p_input->>'documentDate')::date;
 select value into src from jsonb_array_elements(s.record->'sources') where value->>'id'=p_input->>'sourceId' and value->>'type'='infospectrum';
 if src is null or src->>'documentDate' is distinct from p_input->>'documentDate' then raise exception 'Report source mismatch' using errcode='22023';end if;
 select * into old from eco_private.supplier_reports where id=rid;
 if found then
  if old.supplier_id<>sid or old.source_id<>p_input->>'sourceId' or old.file_name<>p_input->>'fileName' or old.object_path<>p_input->>'objectPath' or old.sha256<>p_input->>'sha256' or old.size_bytes<>(p_input->>'size')::bigint or old.document_date<>d then raise exception 'Report request conflict' using errcode='PT409';end if;
  return eco_private.present_supplier_report(old);
 end if;
 insert into eco_private.supplier_reports(id,supplier_id,source_id,file_name,object_path,sha256,size_bytes,document_date,uploaded_by) values(rid,sid,p_input->>'sourceId',p_input->>'fileName',p_input->>'objectPath',p_input->>'sha256',(p_input->>'size')::bigint,d,actor.id) returning * into r;
 insert into eco_private.administration_events(actor_id,actor_name,target_id,action,details) values(actor.id,actor.display_name,sid,'supplier-report-stored',jsonb_build_object('reportId',rid,'sourceId',r.source_id,'sha256',r.sha256,'size',r.size_bytes));
 return eco_private.present_supplier_report(r);
end;$$;
create function public.eco_list_supplier_reports(p_supplier_id uuid) returns jsonb language sql security invoker set search_path='' as $$ select eco_private.list_supplier_reports(p_supplier_id); $$;
create function public.eco_supplier_report_access(p_id uuid) returns jsonb language sql security invoker set search_path='' as $$ select eco_private.supplier_report_access(p_id); $$;
create function public.eco_register_supplier_report(p_input jsonb) returns jsonb language sql security invoker set search_path='' as $$ select eco_private.register_supplier_report(p_input); $$;
revoke all on function eco_private.present_supplier_report(eco_private.supplier_reports),eco_private.list_supplier_reports(uuid),eco_private.supplier_report_access(uuid),eco_private.register_supplier_report(jsonb),public.eco_list_supplier_reports(uuid),public.eco_supplier_report_access(uuid),public.eco_register_supplier_report(jsonb) from public,anon,authenticated;
grant execute on function eco_private.list_supplier_reports(uuid),eco_private.supplier_report_access(uuid),public.eco_list_supplier_reports(uuid),public.eco_supplier_report_access(uuid) to authenticated;
grant execute on function eco_private.register_supplier_report(jsonb),public.eco_register_supplier_report(jsonb) to service_role;
insert into eco_private.platform_versions(component,migration_head) values('supplier-reports','20261015035158');


-- BOOTSTRAP SECTION 20261015075801_eco_v1_buyer_release_gate.sql
-- ECO 1.0 release availability applies to direct RPC calls as well as the UI.
-- Preserve all existing collections, owner isolation, grants and preview write guards.
create or replace function eco_private.profile_target_check(p_target jsonb) returns void language plpgsql set search_path='' as $$
begin
 perform eco_private.admin_check_keys(p_target,array['kind','id']);perform eco_private.admin_check_text(p_target,'id',1,160);
 if p_target->>'kind' is null or p_target->>'kind' not in ('supplier','buyer','country','port') or (p_target->>'kind'<>'country' and p_target->>'id' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$') or p_target->>'id' ~ '[\x01-\x1F\x7F]' then raise exception 'Invalid profile target' using errcode='22023';end if;
 if p_target->>'kind'='buyer' then
  perform eco_private.require_admin();
  if exists(select 1 from eco_private.role_previews where session_id::text=auth.jwt()->>'session_id' and user_id=auth.uid() and role<>'admin') then
   raise exception 'UNDER CONSTRUCTION: TO BE RELEASED WITH ECO 2.0' using errcode='42501';
  end if;
 end if;
 if p_target->>'kind'='supplier' then
  perform eco_private.supplier_uuid(p_target->'id');
  if not exists(select 1 from eco_private.suppliers where id=(p_target->>'id')::uuid and archived_at is null) then raise exception 'Unknown supplier' using errcode='22023';end if;
 end if;
 -- Buyer/country/port IDs are stable application references. Their master records
 -- are not server-persisted yet; syntax is checked, existence is not asserted.
end;$$;

insert into eco_private.platform_versions(component,migration_head) values('release-gates','20261015075801');


-- BOOTSTRAP SECTION 20261015093248_eco_parser_test_workspace_release.sql
-- ECO-only parser receipts and an explicitly isolated, revocable owner test namespace.
create table eco_private.test_workspace_policy (
 singleton boolean primary key default true check(singleton), enabled boolean not null default true,
 generation uuid not null default gen_random_uuid(), updated_at timestamptz not null default now()
);
insert into eco_private.test_workspace_policy(singleton) values(true);
create table eco_private.parser_ai_requests (
 id uuid not null, owner_id uuid not null, session_id uuid not null,
 origin_aal text not null default 'aal1' check(origin_aal in ('aal1','aal2')),
 data_mode text not null check(data_mode in ('live','test')), generation uuid,
 input jsonb not null check(jsonb_typeof(input)='object'),
 state text not null default 'pending' check(state in ('pending','complete','failed')),
 result jsonb, error_code text, created_at timestamptz not null default now(), completed_at timestamptz,
 primary key(owner_id,id), check((data_mode='test')=(generation is not null))
);
create index eco_parser_ai_owner_time on eco_private.parser_ai_requests(owner_id,created_at desc);
create table eco_private.parser_reports (
 id uuid primary key default gen_random_uuid(), request_id uuid not null, owner_id uuid not null, owner_name text not null,
 data_mode text not null check(data_mode in ('live','test')), generation uuid,
 input jsonb not null check(jsonb_typeof(input)='object'), created_at timestamptz not null default now(),
 unique(owner_id,request_id), check((data_mode='test')=(generation is not null))
);
create index eco_parser_reports_mode_time on eco_private.parser_reports(data_mode,created_at desc,id desc);
alter table eco_private.test_workspace_policy enable row level security;
alter table eco_private.parser_ai_requests enable row level security;
alter table eco_private.parser_reports enable row level security;
revoke all on eco_private.test_workspace_policy,eco_private.parser_ai_requests,eco_private.parser_reports from public,anon,authenticated,service_role;

create function eco_private.parser_scope(p_member eco_private.users,p_input jsonb) returns uuid
language plpgsql set search_path='' as $$
declare g uuid; policy eco_private.test_workspace_policy;
begin
 if p_input->>'dataMode' not in ('live','test') or p_input->>'dataMode' is null then raise exception 'Invalid data mode' using errcode='22023'; end if;
 if p_input->>'dataMode'='live' then
  if p_input ? 'generation' and p_input->'generation'<>'null'::jsonb then raise exception 'Invalid generation' using errcode='22023'; end if;
  return null;
 end if;
 if not p_member.is_admin or true /* Owner capability is provisioned separately. */ then raise exception 'Forbidden' using errcode='42501'; end if;
 select * into policy from eco_private.test_workspace_policy where singleton for share;
 if not policy.enabled or p_input->>'generation' is distinct from policy.generation::text then raise exception 'Test workspace expired' using errcode='42501'; end if;
 return policy.generation;
end;$$;
revoke all on function eco_private.parser_scope(eco_private.users,jsonb) from public,anon,authenticated,service_role;

create function public.eco_test_workspace_policy() returns jsonb
language plpgsql security definer set search_path='' as $$
declare m eco_private.users; p eco_private.test_workspace_policy;
begin
 m:=eco_private.current_member();
 if not m.is_admin or true /* Owner capability is provisioned separately. */ then return jsonb_build_object('enabled',false,'generation',''); end if;
 select * into p from eco_private.test_workspace_policy where singleton;
 return jsonb_build_object('enabled',coalesce(p.enabled,false),'generation',coalesce(p.generation::text,''));
end;$$;

create function public.eco_begin_parser_ai(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m eco_private.users; g uuid; rid uuid; prior eco_private.parser_ai_requests;
begin
 m:=eco_private.admin_writable_member();
 perform eco_private.admin_check_keys(p_input,array['requestId','sourceHash','rawText','sourceRevision','dataMode','generation','current','parserVersion']);
 perform eco_private.admin_check_text(p_input,'requestId',36,36);
 if (p_input->>'requestId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Invalid request ID' using errcode='22023'; end if;
 perform eco_private.admin_check_text(p_input,'rawText',1,20000);
 if octet_length(p_input->>'rawText')>20000 or octet_length(p_input::text)>65536 then raise exception 'Input too large' using errcode='22023'; end if;
 perform eco_private.admin_check_text(p_input,'sourceRevision',1,128);
 perform eco_private.admin_check_text(p_input,'parserVersion',1,100);
 if p_input->>'sourceHash' is distinct from encode(sha256(convert_to(p_input->>'rawText','UTF8')),'hex') or jsonb_typeof(p_input->'current') is distinct from 'object' then raise exception 'Invalid source' using errcode='22023'; end if;
 g:=eco_private.parser_scope(m,p_input); rid:=(p_input->>'requestId')::uuid;
 -- The common access lock serializes the quota/idempotency decision with access changes.
 select * into prior from eco_private.parser_ai_requests where owner_id=m.id and id=rid for update;
 if found then
  if prior.input<>p_input then raise exception 'Request conflict' using errcode='PT409'; end if;
  if prior.state='pending' and prior.created_at<now()-interval '2 minutes' then
   update eco_private.parser_ai_requests set state='failed',error_code='REQUEST_EXPIRED',completed_at=now() where owner_id=m.id and id=rid returning * into prior;
  end if;
  return jsonb_build_object('id',rid,'state',prior.state,'runProvider',false,'result',prior.result,'errorCode',prior.error_code);
 end if;
 if (select count(*) from eco_private.parser_ai_requests where owner_id=m.id and created_at>now()-interval '1 minute')>=10 then raise exception 'AI rate limit' using errcode='PT429'; end if;
 if (select count(*) from eco_private.parser_ai_requests where owner_id=m.id and created_at>now()-interval '24 hours')>=200 then raise exception 'AI daily limit' using errcode='PT429'; end if;
 insert into eco_private.parser_ai_requests(id,owner_id,session_id,origin_aal,data_mode,generation,input)
 values(rid,m.id,(auth.jwt()->>'session_id')::uuid,case when auth.jwt()->>'aal'='aal2' then 'aal2' else 'aal1' end,p_input->>'dataMode',g,p_input);
 return jsonb_build_object('id',rid,'state','pending','runProvider',true);
end;$$;

create function public.eco_finish_parser_ai(p_actor_id uuid,p_request_id uuid,p_result jsonb,p_error_code text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r eco_private.parser_ai_requests; m eco_private.users;
begin
 perform pg_advisory_xact_lock(1857,2026);
 select * into r from eco_private.parser_ai_requests where owner_id=p_actor_id and id=p_request_id for update;
 if not found then raise exception 'Unknown request' using errcode='22023'; end if;
 select u.* into m from eco_private.users u where u.id=p_actor_id and u.is_active and u.activated_at is not null
  and u.access_hold_request is null
  and exists(select 1 from auth.users a where a.id=u.id and a.email_confirmed_at is not null);
 if not found then raise exception 'Unauthorized' using errcode='28000'; end if;
 if m.mfa_required and r.origin_aal<>'aal2' then raise exception 'Unauthorized' using errcode='28000'; end if;
 perform eco_private.assert_preview_writable(m.id,r.session_id);
 perform eco_private.parser_scope(m,r.input);
 if r.state<>'pending' then return jsonb_build_object('id',r.id,'state',r.state,'runProvider',false,'result',r.result,'errorCode',r.error_code); end if;
 if r.created_at<now()-interval '2 minutes' then p_result:=null; p_error_code:='REQUEST_EXPIRED'; end if;
 if p_error_code is not null and p_error_code !~ '^[A-Z_]{1,60}$' then raise exception 'Invalid error code' using errcode='22023'; end if;
 if p_error_code is null and (jsonb_typeof(p_result) is distinct from 'object' or octet_length(p_result::text)>65536) then raise exception 'Invalid result' using errcode='22023'; end if;
 update eco_private.parser_ai_requests set state=case when p_error_code is null then 'complete' else 'failed' end,
 result=case when p_error_code is null then p_result else null end,error_code=p_error_code,completed_at=now()
 where owner_id=p_actor_id and id=p_request_id returning * into r;
 return jsonb_build_object('id',r.id,'state',r.state,'runProvider',false,'result',r.result,'errorCode',r.error_code);
end;$$;

create function public.eco_create_parser_report(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m eco_private.users; g uuid; r eco_private.parser_reports; rid uuid;
begin
 m:=eco_private.admin_writable_member();
 perform eco_private.admin_check_keys(p_input,array['requestId','rawText','sourceRevision','parserVersion','parsed','corrected','aiRequestId','notes','dataMode','generation']);
 perform eco_private.admin_check_text(p_input,'requestId',36,36);
 if (p_input->>'requestId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Invalid request ID' using errcode='22023'; end if;
 perform eco_private.admin_check_text(p_input,'rawText',1,20000); perform eco_private.admin_check_text(p_input,'sourceRevision',1,128);
 perform eco_private.admin_check_text(p_input,'parserVersion',1,100); perform eco_private.admin_check_text(p_input,'notes',0,2000);
 if octet_length(p_input->>'rawText')>20000 or octet_length(p_input::text)>65536 or jsonb_typeof(p_input->'parsed') is distinct from 'object' or jsonb_typeof(p_input->'corrected') is distinct from 'object' then raise exception 'Invalid report' using errcode='22023'; end if;
 g:=eco_private.parser_scope(m,p_input);rid:=(p_input->>'requestId')::uuid;
 if p_input->>'aiRequestId' is not null and not exists(select 1 from eco_private.parser_ai_requests a where a.owner_id=m.id and a.id::text=p_input->>'aiRequestId' and a.data_mode=p_input->>'dataMode' and a.generation is not distinct from g and a.input->>'rawText'=p_input->>'rawText') then raise exception 'Invalid AI reference' using errcode='22023'; end if;
 select * into r from eco_private.parser_reports where owner_id=m.id and request_id=rid for update;
 if found then
  if r.input<>p_input then raise exception 'Request conflict' using errcode='PT409'; end if;
 else
  insert into eco_private.parser_reports(request_id,owner_id,owner_name,data_mode,generation,input)
  values(rid,m.id,m.display_name,p_input->>'dataMode',g,p_input) returning * into r;
 end if;
 -- Test reports stay entirely in their own namespace; no shared contribution/audit payload.
 return jsonb_build_object('id',r.id,'createdAt',r.created_at);
end;$$;

create function public.eco_list_parser_reports(p_query jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m eco_private.users; g uuid; lim integer; at_time timestamptz; at_id uuid; page jsonb; total integer; next_cursor text;
begin
 m:=eco_private.require_admin();
 if exists(select 1 from eco_private.role_previews where session_id::text=auth.jwt()->>'session_id') then raise exception 'Forbidden' using errcode='42501'; end if;
 perform eco_private.admin_check_keys(p_query,array['dataMode','generation','limit','cursor']);g:=eco_private.parser_scope(m,p_query);
 if coalesce(p_query->>'limit','25') !~ '^[0-9]{1,2}$' then raise exception 'Invalid limit' using errcode='22023'; end if;
 lim:=coalesce(p_query->>'limit','25')::integer;if lim not between 1 and 50 then raise exception 'Invalid limit' using errcode='22023'; end if;
 if coalesce(p_query->>'cursor','')<>'' then
  if length(p_query->>'cursor')>100 or array_length(string_to_array(p_query->>'cursor','|'),1)<>2 then raise exception 'Invalid cursor' using errcode='22023'; end if;
  begin at_time:=split_part(p_query->>'cursor','|',1)::timestamptz;at_id:=split_part(p_query->>'cursor','|',2)::uuid;
  exception when others then raise exception 'Invalid cursor' using errcode='22023';end;
 end if;
 with candidates as (select r.* from eco_private.parser_reports r where r.data_mode=p_query->>'dataMode' and r.generation is not distinct from g
  and (r.data_mode='live' or r.owner_id=m.id) and (at_time is null or (r.created_at,r.id)<(at_time,at_id)) order by r.created_at desc,r.id desc limit lim+1),
 numbered as (select *,row_number() over(order by created_at desc,id desc) as n from candidates)
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'createdAt',created_at,'createdBy',owner_name,'rawText',input->'rawText','parsed',input->'parsed','corrected',input->'corrected','notes',input->'notes','parserVersion',input->'parserVersion','sourceRevision',input->'sourceRevision','aiRequestId',input->'aiRequestId','dataMode',data_mode) order by created_at desc,id desc) filter(where n<=lim),'[]'::jsonb),count(*),max(case when n=lim then created_at::text||'|'||id::text end) into page,total,next_cursor from numbered;
 return jsonb_build_object('items',page,'nextCursor',case when total>lim then next_cursor else null end);
end;$$;

-- Operator-only cleanup, invoked only on a later explicit owner request. Rotating
-- generation also makes retained browser copies inaccessible and purges them on reconnect.
create function public.eco_purge_test_workspace(p_expected_generation uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p eco_private.test_workspace_policy; report_count integer; ai_count integer;
begin
 perform pg_advisory_xact_lock(1857,2026);
 select * into p from eco_private.test_workspace_policy where singleton for update;
 if p.generation is distinct from p_expected_generation then raise exception 'Generation conflict' using errcode='PT409'; end if;
 delete from eco_private.parser_reports where data_mode='test';get diagnostics report_count=row_count;
 delete from eco_private.parser_ai_requests where data_mode='test';get diagnostics ai_count=row_count;
 update eco_private.test_workspace_policy set enabled=false,generation=gen_random_uuid(),updated_at=now() where singleton returning * into p;
 return jsonb_build_object('enabled',p.enabled,'generation',p.generation,'reportsRemoved',report_count,'aiRequestsRemoved',ai_count);
end;$$;

revoke all on function public.eco_test_workspace_policy(),public.eco_begin_parser_ai(jsonb),public.eco_finish_parser_ai(uuid,uuid,jsonb,text),public.eco_create_parser_report(jsonb),public.eco_list_parser_reports(jsonb),public.eco_purge_test_workspace(uuid) from public,anon,authenticated,service_role;
grant execute on function public.eco_test_workspace_policy(),public.eco_begin_parser_ai(jsonb),public.eco_create_parser_report(jsonb),public.eco_list_parser_reports(jsonb) to authenticated;
grant execute on function public.eco_finish_parser_ai(uuid,uuid,jsonb,text),public.eco_purge_test_workspace(uuid) to service_role;
insert into eco_private.platform_versions(component,migration_head) values('parser-test-workspace','20261015093248');


-- BOOTSTRAP SECTION 20261015100000_eco_supplier_contributions.sql
-- One committed supplier edit earns one shared contribution. The revision row is
-- inserted by the guarded supplier RPC in the same transaction as the edit.
create table eco_private.supplier_contributions (
  supplier_id uuid not null references eco_private.suppliers(id),
  revision integer not null,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (supplier_id, revision),
  foreign key (supplier_id, revision) references eco_private.supplier_revisions(supplier_id, revision)
);
create index eco_supplier_contributions_user_time on eco_private.supplier_contributions(user_id, created_at desc);
alter table eco_private.supplier_contributions enable row level security;
revoke all on eco_private.supplier_contributions from public, anon, authenticated;

create function eco_private.record_supplier_contribution() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.reason = 'update' then
    insert into eco_private.supplier_contributions(supplier_id, revision, user_id, created_at)
    values(new.supplier_id, new.revision, new.actor_id, new.created_at);
  end if;
  return new;
end;$$;
insert into eco_private.platform_versions(component,migration_head)
values('supplier-contributions','20261015100000');
revoke all on function eco_private.record_supplier_contribution() from public, anon, authenticated;
create trigger eco_supplier_revision_contribution
after insert on eco_private.supplier_revisions
for each row execute function eco_private.record_supplier_contribution();

create table eco_private.profile_tab_contributions (
  target_kind text not null, target_id text not null, owner_id uuid not null,
  revision integer not null, user_id uuid not null, created_at timestamptz not null default now(),
  primary key (target_kind, target_id, owner_id, revision),
  foreign key (target_kind, target_id, owner_id, revision)
    references eco_private.profile_tab_revisions(target_kind, target_id, owner_id, revision)
);
create index eco_profile_tab_contributions_user_time on eco_private.profile_tab_contributions(user_id, created_at desc);
alter table eco_private.profile_tab_contributions enable row level security;
revoke all on eco_private.profile_tab_contributions from public, anon, authenticated;
create function eco_private.record_profile_tab_contribution() returns trigger
language plpgsql security definer set search_path='' as $$
declare earlier jsonb;
begin
  if new.owner_id <> '00000000-0000-0000-0000-000000000000'::uuid then return new; end if;
  select tabs into earlier from eco_private.profile_tab_revisions
    where target_kind=new.target_kind and target_id=new.target_id and owner_id=new.owner_id
      and revision<new.revision order by revision desc limit 1;
  if exists (
    select 1 from jsonb_array_elements(new.tabs) tab
    where coalesce(tab->>'content','') is distinct from coalesce((select old_tab->>'content' from jsonb_array_elements(coalesce(earlier,'[]'::jsonb)) old_tab where old_tab->>'id'=tab->>'id'), '')
  ) then
    insert into eco_private.profile_tab_contributions(target_kind,target_id,owner_id,revision,user_id,created_at)
    values(new.target_kind,new.target_id,new.owner_id,new.revision,new.actor_id,new.created_at);
  end if;
  return new;
end;$$;
revoke all on function eco_private.record_profile_tab_contribution() from public, anon, authenticated;
create trigger eco_profile_tab_revision_contribution
after insert on eco_private.profile_tab_revisions
for each row execute function eco_private.record_profile_tab_contribution();

create or replace function eco_private.feedback_contribution_summary(p_period text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor eco_private.users; start_at timestamptz; end_at timestamptz; previous_start timestamptz; previous_end timestamptz; today_start timestamptz; total bigint; previous_total bigint; recent jsonb;
begin
  actor:=eco_private.current_member();
  if p_period is null or p_period not in ('7d','28d','month','all') then raise exception 'Invalid period' using errcode='22023'; end if;
  end_at:=now()+interval '1 millisecond';
  today_start:=((now() at time zone 'Asia/Hong_Kong')::date::timestamp at time zone 'Asia/Hong_Kong');
  if p_period='7d' then start_at:=today_start-interval '6 days'; previous_start:=start_at-interval '7 days'; previous_end:=end_at-interval '7 days';
  elsif p_period='28d' then start_at:=today_start-interval '27 days'; previous_start:=start_at-interval '28 days';previous_end:=end_at-interval '28 days';
  elsif p_period='month' then start_at:=date_trunc('month',now() at time zone 'Asia/Hong_Kong') at time zone 'Asia/Hong_Kong';previous_start:=(date_trunc('month',now() at time zone 'Asia/Hong_Kong')-interval '1 month') at time zone 'Asia/Hong_Kong';previous_end:=least(start_at,previous_start+(end_at-start_at));
  else start_at:='1970-01-01T00:00:00Z'::timestamptz;previous_start:=start_at;previous_end:=start_at;end if;
  select (select count(*) from eco_private.feedback_contributions where user_id=actor.id and created_at>=previous_start and created_at<previous_end)
       + (select count(*) from eco_private.supplier_contributions where user_id=actor.id and created_at>=previous_start and created_at<previous_end)
       + (select count(*) from eco_private.profile_tab_contributions where user_id=actor.id and created_at>=previous_start and created_at<previous_end) into previous_total;
  select (select count(*) from eco_private.feedback_contributions where user_id=actor.id and created_at>=start_at and created_at<end_at)
       + (select count(*) from eco_private.supplier_contributions where user_id=actor.id and created_at>=start_at and created_at<end_at)
       + (select count(*) from eco_private.profile_tab_contributions where user_id=actor.id and created_at>=start_at and created_at<end_at) into total;
  select coalesce(jsonb_agg(entry order by entry->>'createdAt' desc),'[]'::jsonb) into recent from (
    select jsonb_build_object('id',id,'userId',user_id,'feedbackId',feedback_id,'createdAt',created_at,'kind','feedback') entry, created_at from eco_private.feedback_contributions where user_id=actor.id and created_at>=start_at and created_at<end_at
    union all
    select jsonb_build_object('id',supplier_id::text||':'||revision,'userId',user_id,'supplierId',supplier_id,'createdAt',created_at,'kind','supplier') entry, created_at from eco_private.supplier_contributions where user_id=actor.id and created_at>=start_at and created_at<end_at
    union all
    select jsonb_build_object('id',target_kind||':'||target_id||':'||revision,'userId',user_id,'targetKind',target_kind,'targetId',target_id,'createdAt',created_at,'kind','profile-tab') entry, created_at from eco_private.profile_tab_contributions where user_id=actor.id and created_at>=start_at and created_at<end_at
    order by created_at desc limit 50
  ) events;
  return jsonb_build_object('count',total,'previousCount',previous_total,'periodStart',start_at,'periodEnd',end_at,'timeZone','Asia/Hong_Kong','source','shared-contributions','items',recent);
end;$$;


-- BOOTSTRAP SECTION 20261015110000_eco_supplier_pic_options.sql
-- Names only for supplier selection: user administration remains administrator-only.
create function eco_private.supplier_pic_options() returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 perform eco_private.current_member();
 with names as (
  select trim(u.display_name) as name
  from eco_private.users u
  where u.deleted_at is null and u.is_active and u.activated_at is not null
   and u.access_hold_request is null and upper(coalesce(u.office_id,''))<>'CREDIT'
   and exists(select 1 from auth.users a where a.id=u.id and a.email_confirmed_at is not null)
  union all
  select trim(s.record#>>'{info,supplierTrader}') as name
  from eco_private.suppliers s where s.archived_at is null and s.country_code='SG'
 ), unique_names as (
  select min(name) as name from names where name is not null and name<>'' group by lower(name)
 )
 select coalesce(jsonb_agg(name order by lower(name),name),'[]'::jsonb) into result from unique_names;
 return jsonb_build_object('options',result);
end;$$;
create function public.eco_supplier_pic_options() returns jsonb
language sql set search_path='' as $$select eco_private.supplier_pic_options();$$;
revoke all on function eco_private.supplier_pic_options(),public.eco_supplier_pic_options() from public,anon,authenticated,service_role;
grant execute on function eco_private.supplier_pic_options(),public.eco_supplier_pic_options() to authenticated;
insert into eco_private.platform_versions(component,migration_head)
values('supplier-pic-options','20261015110000')
on conflict(component) do update set migration_head=excluded.migration_head;


-- BOOTSTRAP SECTION 20261015112405_eco_shared_enquiry_inbox.sql
-- Owner-only LIVE intake. No source/binding is provisioned by this migration.
-- Shared commercial enquiry persistence and outbound dispatch remain separate.
create table eco_private.inbox_sources (
 id uuid primary key default gen_random_uuid(), provider text not null check(length(provider) between 1 and 100),
 account_id text not null check(length(account_id) between 1 and 320), destination_id text not null check(length(destination_id) between 1 and 320),
 channel text not null check(channel in ('email','whatsapp')), identity_namespace text not null check(length(identity_namespace) between 1 and 100),
 enabled boolean not null default false, provisioned_at timestamptz, scopes_verified_at timestamptz, cutover_at timestamptz,
 cursor text check(length(cursor)<=8000), lease_token uuid, lease_request_id uuid, lease_expires_at timestamptz,
 last_error_code text, retry_after timestamptz, last_checkpoint_at timestamptz, updated_at timestamptz not null default now(),
 unique(provider,account_id,destination_id),
 check(not enabled or (provisioned_at is not null and scopes_verified_at is not null and cutover_at is not null and isfinite(cutover_at))),
 check((lease_token is null)=(lease_expires_at is null)), check((lease_token is null)=(lease_request_id is null))
);
create table eco_private.inbox_sender_bindings (
 id uuid primary key default gen_random_uuid(), source_id uuid not null references eco_private.inbox_sources(id),
 sender_identity text not null check(length(sender_identity) between 1 and 320), sender_display text not null check(length(sender_display) between 1 and 320),
 owner_id uuid not null references eco_private.users(id) on delete cascade,
 enabled boolean not null default false, verified_at timestamptz,
 unique(source_id,sender_identity,owner_id), check(not enabled or verified_at is not null)
);
create index eco_inbox_bindings_owner on eco_private.inbox_sender_bindings(owner_id);
create table eco_private.inbox_messages (
 id uuid primary key default gen_random_uuid(), source_id uuid not null references eco_private.inbox_sources(id),
 provider text not null, account_id text not null, destination_id text not null, provider_message_id text not null,
 fingerprint text not null check(fingerprint ~ '^[0-9a-f]{64}$'), content_hash text check(content_hash ~ '^[0-9a-f]{64}$'),
 channel text not null check(channel in ('email','whatsapp')), sender_identity text not null, sender_display text,
 owner_id uuid, status text not null check(status in ('accepted','quarantined')), reason text,
 raw_text text, subject text, received_at timestamptz not null, ingested_at timestamptz not null default clock_timestamp(),
 read_at timestamptz, dismissed_at timestamptz,
 unique(provider,account_id,destination_id,provider_message_id),
 check((status='accepted' and owner_id is not null and raw_text is not null and sender_display is not null and reason is null)
    or (status='quarantined' and owner_id is null and raw_text is null and subject is null and reason is not null)),
 check(octet_length(raw_text)<=20000)
);
create index eco_inbox_source on eco_private.inbox_messages(source_id);
create index eco_inbox_quarantine_channel on eco_private.inbox_messages(channel) where status='quarantined';
create index eco_inbox_owner_page on eco_private.inbox_messages(owner_id,ingested_at desc,id desc) where status='accepted';
create index eco_inbox_owner_unread on eco_private.inbox_messages(owner_id) where status='accepted' and read_at is null and dismissed_at is null;
create table eco_private.inbox_mutations (
 owner_id uuid not null, request_id uuid not null, input jsonb not null, result jsonb not null,
 created_at timestamptz not null default now(), primary key(owner_id,request_id)
);
alter table eco_private.inbox_sources enable row level security;
alter table eco_private.inbox_sender_bindings enable row level security;
alter table eco_private.inbox_messages enable row level security;
alter table eco_private.inbox_mutations enable row level security;
revoke all on eco_private.inbox_sources,eco_private.inbox_sender_bindings,eco_private.inbox_messages,eco_private.inbox_mutations from public,anon,authenticated,service_role;

create function eco_private.inbox_text(p_input jsonb,p_key text,p_min integer,p_max integer) returns text
language plpgsql immutable set search_path='' as $$
declare value text:=p_input->>p_key;
begin
 if jsonb_typeof(p_input->p_key) is distinct from 'string' or length(value) not between p_min and p_max or value ~ '[[:cntrl:]]' or (p_min>0 and length(trim(value))=0) then raise exception 'Invalid inbox input' using errcode='22023'; end if;
 return value;
end;$$;
create function eco_private.inbox_uuid(p_input jsonb,p_key text) returns uuid
language plpgsql immutable set search_path='' as $$
declare value text:=eco_private.inbox_text(p_input,p_key,36,36);
begin
 if value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Invalid inbox ID' using errcode='22023'; end if;
 return value::uuid;
end;$$;
create function eco_private.inbox_live(p_input jsonb) returns void
language plpgsql immutable set search_path='' as $$
begin
 if jsonb_typeof(p_input->'dataMode') is distinct from 'string' or p_input->>'dataMode'<>'live' then raise exception 'Switch to LIVE to use the shared inbox' using errcode='42501'; end if;
end;$$;
create function eco_private.inbox_item(p_row eco_private.inbox_messages) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_strip_nulls(jsonb_build_object('id',p_row.id,'providerMessageId',p_row.provider_message_id,'channel',p_row.channel,'sender',p_row.sender_display,'owner',p_row.owner_id,'rawText',p_row.raw_text,'subject',p_row.subject,'receivedAt',p_row.received_at,'read',p_row.read_at is not null,'dismissed',p_row.dismissed_at is not null));
$$;
create function eco_private.inbox_unread(p_owner uuid) returns bigint
language sql stable set search_path='' as $$
 select count(*) from eco_private.inbox_messages where owner_id=p_owner and status='accepted' and read_at is null and dismissed_at is null;
$$;

create function public.eco_list_enquiry_inbox(p_query jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare m eco_private.users; n integer:=25; ct timestamptz; cid uuid; c text; result jsonb; next_cursor text;
begin
 m:=eco_private.current_member();
 perform eco_private.admin_check_keys(p_query,array['dataMode','limit','cursor']); perform eco_private.inbox_live(p_query);
 if p_query ? 'limit' then
  if jsonb_typeof(p_query->'limit') is distinct from 'number' or p_query->>'limit' !~ '^[1-9][0-9]?$' then raise exception 'Invalid inbox limit' using errcode='22023'; end if;
  n:=(p_query->>'limit')::integer; if n>50 then raise exception 'Invalid inbox limit' using errcode='22023'; end if;
 end if;
 if p_query ? 'cursor' then
  c:=eco_private.inbox_text(p_query,'cursor',1,100);
  if c !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9:.+Z-]+\|[0-9a-f-]{36}$' then raise exception 'Invalid inbox cursor' using errcode='22023'; end if;
  begin ct:=split_part(c,'|',1)::timestamptz; cid:=split_part(c,'|',2)::uuid;
  exception when invalid_datetime_format or datetime_field_overflow or invalid_text_representation then raise exception 'Invalid inbox cursor' using errcode='22023'; end;
  if not isfinite(ct) then raise exception 'Invalid inbox cursor' using errcode='22023'; end if;
 end if;
 if exists(select 1 from eco_private.role_previews where user_id=m.id and session_id::text=auth.jwt()->>'session_id') then return jsonb_build_object('items','[]'::jsonb,'nextCursor',null,'unreadCount',0); end if;
 select coalesce(jsonb_agg(eco_private.inbox_item(q) order by q.ingested_at desc,q.id desc),'[]'::jsonb) into result
 from (select * from eco_private.inbox_messages where owner_id=m.id and status='accepted' and (ct is null or (ingested_at,id)<(ct,cid)) order by ingested_at desc,id desc limit n) q;
 if exists(select 1 from eco_private.inbox_messages where owner_id=m.id and status='accepted' and (ct is null or (ingested_at,id)<(ct,cid)) offset n limit 1) then
  select ingested_at::text||'|'||id::text into next_cursor from eco_private.inbox_messages where owner_id=m.id and status='accepted' and (ct is null or (ingested_at,id)<(ct,cid)) order by ingested_at desc,id desc offset n-1 limit 1;
 end if;
 return jsonb_build_object('items',result,'nextCursor',next_cursor,'unreadCount',eco_private.inbox_unread(m.id));
end;$$;

create function public.eco_mutate_enquiry_inbox(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m eco_private.users; rid uuid; mid uuid; action text; prior eco_private.inbox_mutations; row eco_private.inbox_messages; changed integer:=0; result jsonb; normalized jsonb;
begin
 m:=eco_private.admin_writable_member();
 perform eco_private.admin_check_keys(p_input,array['dataMode','requestId','action','id']); perform eco_private.inbox_live(p_input);
 rid:=eco_private.inbox_uuid(p_input,'requestId'); action:=eco_private.inbox_text(p_input,'action',1,20);
 if action not in ('read','dismiss','dismiss-all') or (action='dismiss-all' and p_input ? 'id') then raise exception 'Invalid inbox action' using errcode='22023'; end if;
 if action<>'dismiss-all' then mid:=eco_private.inbox_uuid(p_input,'id'); end if;
 normalized:=jsonb_build_object('action',action,'id',mid);
 select * into prior from eco_private.inbox_mutations where owner_id=m.id and request_id=rid;
 if found then if prior.input<>normalized then raise exception 'Request conflict' using errcode='PT409'; end if; return prior.result; end if;
 if action='dismiss-all' then
  update eco_private.inbox_messages set dismissed_at=now() where owner_id=m.id and status='accepted' and dismissed_at is null;
  get diagnostics changed=row_count;
 else
  select * into row from eco_private.inbox_messages where id=mid and owner_id=m.id and status='accepted' for update;
  if not found then raise exception 'Inbox item not found' using errcode='PT404'; end if;
  if (action='read' and row.read_at is null) or (action='dismiss' and row.dismissed_at is null) then
   update eco_private.inbox_messages set read_at=case when action='read' then now() else read_at end,dismissed_at=case when action='dismiss' then now() else dismissed_at end where id=row.id returning * into row; changed:=1;
  end if;
 end if;
 result:=jsonb_build_object('requestId',rid,'action',action,'item',case when action='dismiss-all' then null else eco_private.inbox_item(row) end,'changedCount',changed,'unreadCount',eco_private.inbox_unread(m.id));
 insert into eco_private.inbox_mutations(owner_id,request_id,input,result) values(m.id,rid,normalized,result);
 return result;
end;$$;

-- Service credentials grant only these narrow operations, not private table access.
create function eco_private.inbox_service() returns void
language plpgsql stable set search_path='' as $$
begin
 if current_setting('role',true) is distinct from 'service_role' then raise exception 'Forbidden' using errcode='42501'; end if;
end;$$;
create function eco_private.inbox_source(p_id uuid) returns eco_private.inbox_sources
language plpgsql set search_path='' as $$
declare s eco_private.inbox_sources;
begin
 select * into s from eco_private.inbox_sources where id=p_id for update;
 if not found or not s.enabled or s.provisioned_at is null or s.scopes_verified_at is null or s.cutover_at is null then raise exception 'Inbox source unavailable' using errcode='42501'; end if;
 return s;
end;$$;
create function eco_private.inbox_fence(p_source eco_private.inbox_sources,p_input jsonb) returns void
language plpgsql set search_path='' as $$
begin
 if p_source.lease_token is null or p_source.lease_token is distinct from eco_private.inbox_uuid(p_input,'leaseToken') or p_source.lease_expires_at<=clock_timestamp() then raise exception 'Inbox lease expired' using errcode='PT409'; end if;
end;$$;
create function public.eco_get_inbox_receipt(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s eco_private.inbox_sources; mid text; result jsonb;
begin
 perform eco_private.inbox_service(); perform eco_private.admin_check_keys(p_input,array['sourceId','leaseToken','messageId']);
 s:=eco_private.inbox_source(eco_private.inbox_uuid(p_input,'sourceId')); perform eco_private.inbox_fence(s,p_input);
 if s.channel<>'email' then raise exception 'Invalid inbox source' using errcode='22023'; end if;
 mid:=eco_private.inbox_text(p_input,'messageId',1,1024);
 select jsonb_build_object('id',id,'status',status) into result from eco_private.inbox_messages where source_id=s.id and provider=s.provider and account_id=s.account_id and destination_id=s.destination_id and provider_message_id=mid;
 return result;
end;$$;
create function public.eco_resolve_inbox_sender(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s eco_private.inbox_sources; sender text; binding_count integer; approved boolean:=false;
begin
 perform eco_private.inbox_service(); perform eco_private.admin_check_keys(p_input,array['sourceId','leaseToken','senderIdentity','identityNamespace']);
 s:=eco_private.inbox_source(eco_private.inbox_uuid(p_input,'sourceId')); perform eco_private.inbox_fence(s,p_input);
 if s.channel<>'email' or eco_private.inbox_text(p_input,'identityNamespace',1,100)<>s.identity_namespace then raise exception 'Inbox source mismatch' using errcode='42501'; end if;
 sender:=eco_private.inbox_text(p_input,'senderIdentity',1,320);
 select count(*) into binding_count from eco_private.inbox_sender_bindings where source_id=s.id and sender_identity=sender and enabled and verified_at is not null;
 if binding_count=1 then
  select exists(select 1 from eco_private.inbox_sender_bindings b join eco_private.users u on u.id=b.owner_id where b.source_id=s.id and b.sender_identity=sender and b.enabled and b.verified_at is not null and u.is_active and u.activated_at is not null and u.access_hold_request is null and exists(select 1 from auth.users a where a.id=u.id and a.email_confirmed_at is not null)) into approved;
 end if;
 return jsonb_build_object('approved',approved);
end;$$;
create function public.eco_claim_inbox_source(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s eco_private.inbox_sources; rid uuid;
begin
 perform eco_private.inbox_service(); perform eco_private.admin_check_keys(p_input,array['sourceId','requestId']); rid:=eco_private.inbox_uuid(p_input,'requestId'); s:=eco_private.inbox_source(eco_private.inbox_uuid(p_input,'sourceId'));
 if s.channel<>'email' then raise exception 'Invalid inbox source' using errcode='22023'; end if;
 if s.retry_after>clock_timestamp() then raise exception 'Inbox source deferred' using errcode='PT429'; end if;
 if s.lease_expires_at>clock_timestamp() then
  if s.lease_request_id<>rid then raise exception 'Inbox source busy' using errcode='PT409'; end if;
 else
  update eco_private.inbox_sources set lease_token=gen_random_uuid(),lease_request_id=rid,lease_expires_at=clock_timestamp()+interval '120 seconds',updated_at=now() where id=s.id returning * into s;
 end if;
 return jsonb_build_object('sourceId',s.id,'leaseToken',s.lease_token,'cursor',s.cursor,'cutoverAt',s.cutover_at,'leaseExpiresAt',s.lease_expires_at,'provider',s.provider,'accountId',s.account_id,'destinationId',s.destination_id,'identityNamespace',s.identity_namespace);
end;$$;
create function public.eco_checkpoint_inbox_source(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s eco_private.inbox_sources; c text; rid jsonb;
begin
 perform eco_private.inbox_service(); perform eco_private.admin_check_keys(p_input,array['sourceId','leaseToken','expectedCursor','cursor','receiptIds']); s:=eco_private.inbox_source(eco_private.inbox_uuid(p_input,'sourceId')); perform eco_private.inbox_fence(s,p_input);
 if not(p_input ? 'expectedCursor') or jsonb_typeof(p_input->'expectedCursor') not in ('string','null') or s.cursor is distinct from p_input->>'expectedCursor' then raise exception 'Inbox cursor conflict' using errcode='PT409'; end if;
 c:=eco_private.inbox_text(p_input,'cursor',1,8000);
 if jsonb_typeof(p_input->'receiptIds') is distinct from 'array' or jsonb_array_length(p_input->'receiptIds')>100 then raise exception 'Invalid inbox receipts' using errcode='22023'; end if;
 for rid in select value from jsonb_array_elements(p_input->'receiptIds') loop
  if not exists(select 1 from eco_private.inbox_messages where id=eco_private.inbox_uuid(jsonb_build_object('id',rid),'id') and source_id=s.id) then raise exception 'Inbox receipt not found' using errcode='22023'; end if;
 end loop;
 update eco_private.inbox_sources set cursor=c,lease_expires_at=clock_timestamp()+interval '120 seconds',last_error_code=null,retry_after=null,last_checkpoint_at=clock_timestamp(),updated_at=now() where id=s.id returning * into s;
 return jsonb_build_object('cursor',s.cursor,'leaseExpiresAt',s.lease_expires_at);
end;$$;
create function public.eco_release_inbox_source(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s eco_private.inbox_sources; code text; delay integer;
begin
 perform eco_private.inbox_service(); perform eco_private.admin_check_keys(p_input,array['sourceId','leaseToken','errorCode','retryAfterSeconds']); s:=eco_private.inbox_source(eco_private.inbox_uuid(p_input,'sourceId')); perform eco_private.inbox_fence(s,p_input);
 if p_input ? 'errorCode' then code:=eco_private.inbox_text(p_input,'errorCode',1,50); if code not in ('provider_error','identity_unavailable','configuration_error') then raise exception 'Invalid inbox error code' using errcode='22023'; end if; end if;
 if p_input ? 'retryAfterSeconds' then
  if code is null or jsonb_typeof(p_input->'retryAfterSeconds') is distinct from 'number' or p_input->>'retryAfterSeconds' !~ '^[1-9][0-9]{0,4}$' then raise exception 'Invalid inbox retry delay' using errcode='22023'; end if;
  delay:=(p_input->>'retryAfterSeconds')::integer; if delay>86400 then raise exception 'Invalid inbox retry delay' using errcode='22023'; end if;
 elsif code is not null then delay:=60; end if;
 update eco_private.inbox_sources set lease_token=null,lease_request_id=null,lease_expires_at=null,last_error_code=code,retry_after=case when delay is not null then clock_timestamp()+make_interval(secs=>delay) end,updated_at=now() where id=s.id;
 return jsonb_build_object('released',true);
end;$$;

create function public.eco_ingest_enquiry(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s eco_private.inbox_sources; msg eco_private.inbox_messages; bound eco_private.inbox_sender_bindings; recipient eco_private.users; binding_count integer;
 fingerprint text; canonical jsonb; v_provider text; account text; destination text; message_id text; sender text; raw text; subject text; stamp text; received timestamptz; verified boolean; reason text; supplied_hash text; body_hash text;
begin
 perform eco_private.inbox_service();
 perform eco_private.admin_check_keys(p_input,array['sourceId','provider','accountId','destinationId','messageId','senderIdentity','identityNamespace','identityVerified','rawText','receivedAt','subject','leaseToken','quarantineReason','contentHash']);
 -- Serialize routing with account permission changes; source row lock also fences workers.
 perform pg_advisory_xact_lock(1857,2026);
 s:=eco_private.inbox_source(eco_private.inbox_uuid(p_input,'sourceId'));
 if s.channel='email' then perform eco_private.inbox_fence(s,p_input); elsif p_input ? 'leaseToken' then raise exception 'Invalid inbox lease' using errcode='22023'; end if;
 v_provider:=eco_private.inbox_text(p_input,'provider',1,100); account:=eco_private.inbox_text(p_input,'accountId',1,320); destination:=eco_private.inbox_text(p_input,'destinationId',1,320); message_id:=eco_private.inbox_text(p_input,'messageId',1,1024);
 if (v_provider,account,destination) is distinct from (s.provider,s.account_id,s.destination_id) or eco_private.inbox_text(p_input,'identityNamespace',1,100)<>s.identity_namespace then raise exception 'Inbox source mismatch' using errcode='42501'; end if;
 if jsonb_typeof(p_input->'identityVerified') is distinct from 'boolean' then raise exception 'Invalid inbox identity' using errcode='22023'; end if;
 verified:=(p_input->>'identityVerified')::boolean; sender:=eco_private.inbox_text(p_input,'senderIdentity',case when verified then 1 else 0 end,320);
 if jsonb_typeof(p_input->'rawText') is distinct from 'string' or octet_length(p_input->>'rawText')>20000 then raise exception 'Invalid inbox text' using errcode='22023'; end if;
 raw:=p_input->>'rawText';
 if regexp_replace(raw,E'[\n\r\t]','','g') ~ '[[:cntrl:]]' then raise exception 'Invalid inbox text' using errcode='22023'; end if;
 if p_input ? 'subject' then subject:=eco_private.inbox_text(p_input,'subject',0,1000); end if;
 if p_input ? 'quarantineReason' then
  reason:=eco_private.inbox_text(p_input,'quarantineReason',1,50);
  if reason not in ('unsupported_attachment','unsupported_body','oversized','malformed_message','message_unavailable') or raw<>'' or subject is not null then raise exception 'Invalid inbox quarantine' using errcode='22023'; end if;
 end if;
 if p_input ? 'contentHash' then supplied_hash:=eco_private.inbox_text(p_input,'contentHash',64,64); if supplied_hash !~ '^[0-9a-f]{64}$' then raise exception 'Invalid inbox content hash' using errcode='22023'; end if; end if;
 body_hash:=case when raw<>'' then encode(sha256(convert_to(raw,'UTF8')),'hex') else supplied_hash end;
 if raw<>'' and supplied_hash is not null and supplied_hash<>body_hash then raise exception 'Inbox content hash mismatch' using errcode='22023'; end if;
 stamp:=eco_private.inbox_text(p_input,'receivedAt',20,40);
 if stamp !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,7})?(Z|[+-][0-9]{2}:[0-9]{2})$' then raise exception 'Invalid inbox timestamp' using errcode='22023'; end if;
 begin received:=stamp::timestamptz; exception when invalid_datetime_format or datetime_field_overflow then raise exception 'Invalid inbox timestamp' using errcode='22023'; end;
 if not isfinite(received) then raise exception 'Invalid inbox timestamp' using errcode='22023'; end if;
 -- Stable original provider timestamp, never retry wall-clock time. Lease is deliberately excluded.
 canonical:=jsonb_build_object('source',s.id,'provider',v_provider,'account',account,'destination',destination,'messageId',message_id,'sender',sender,'namespace',s.identity_namespace,'verified',verified,'rawHash',body_hash,'subject',subject,'received',to_char(received at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'quarantineReason',reason);
 fingerprint:=encode(sha256(convert_to(canonical::text,'UTF8')),'hex');
 select * into msg from eco_private.inbox_messages where inbox_messages.provider=v_provider and account_id=account and destination_id=destination and provider_message_id=message_id;
 if found then
  if msg.fingerprint<>fingerprint then raise exception 'Inbox delivery conflict' using errcode='PT409'; end if;
  return jsonb_strip_nulls(jsonb_build_object('id',msg.id,'status',msg.status,'duplicate',true,'reason',msg.reason));
 end if;
 if reason is null then
  if received<s.cutover_at then reason:='before_cutover';
  elsif not verified then reason:='unverified_identity';
  else
   select count(*) into binding_count from eco_private.inbox_sender_bindings where source_id=s.id and sender_identity=sender and enabled and verified_at is not null;
   if binding_count=0 then reason:='unknown_sender'; elsif binding_count>1 then reason:='ambiguous_sender';
   else
    select * into bound from eco_private.inbox_sender_bindings where source_id=s.id and sender_identity=sender and enabled and verified_at is not null;
    select u.* into recipient from eco_private.users u where u.id=bound.owner_id and u.is_active and u.activated_at is not null and u.access_hold_request is null and exists(select 1 from auth.users a where a.id=u.id and a.email_confirmed_at is not null);
    if not found then reason:='inactive_owner'; elsif trim(raw)='' then reason:='empty_message'; end if;
   end if;
  end if;
 end if;
 insert into eco_private.inbox_messages(source_id,provider,account_id,destination_id,provider_message_id,fingerprint,content_hash,channel,sender_identity,sender_display,owner_id,status,reason,raw_text,subject,received_at)
 values(s.id,v_provider,account,destination,message_id,fingerprint,body_hash,s.channel,sender,case when reason is null then bound.sender_display end,case when reason is null then recipient.id end,case when reason is null then 'accepted' else 'quarantined' end,reason,case when reason is null then raw end,case when reason is null then subject end,received) returning * into msg;
 return jsonb_strip_nulls(jsonb_build_object('id',msg.id,'status',msg.status,'duplicate',false,'reason',msg.reason));
end;$$;

-- Aggregate operational evidence only. Missing/disabled sources are never evidence of health.
create function public.eco_inbox_health() returns jsonb
language plpgsql security definer set search_path='' as $$
declare m eco_private.users;
begin
 if current_setting('role',true) is distinct from 'service_role' then
  m:=eco_private.require_admin();
  if exists(select 1 from eco_private.role_previews where user_id=m.id and session_id::text=auth.jwt()->>'session_id') then raise exception 'Forbidden' using errcode='42501'; end if;
 end if;
 return jsonb_build_object('observedAt',clock_timestamp(),
  'configuredSources',(select count(*) from eco_private.inbox_sources),
  'enabledSources',(select count(*) from eco_private.inbox_sources where enabled),
  'enabledEmailSources',(select count(*) from eco_private.inbox_sources where enabled and channel='email'),
  'lastSuccessfulCheckpoint',(select max(last_checkpoint_at) from eco_private.inbox_sources where enabled and channel='email'),
  'uncheckpointedEmailSources',(select count(*) from eco_private.inbox_sources where enabled and channel='email' and last_checkpoint_at is null),
  'staleEmailSources',(select count(*) from eco_private.inbox_sources where enabled and channel='email' and last_checkpoint_at<clock_timestamp()-interval '10 minutes'),
  'staleLeaseCount',(select count(*) from eco_private.inbox_sources where enabled and channel='email' and lease_expires_at<=clock_timestamp()),
  'backedOffSources',(select count(*) from eco_private.inbox_sources where enabled and channel='email' and retry_after>clock_timestamp()),
  'failedSources',(select count(*) from eco_private.inbox_sources where enabled and channel='email' and last_error_code is not null),
  'quarantinedCount',(select count(*) from eco_private.inbox_messages where channel='email' and status='quarantined'));
end;$$;
revoke all on function public.eco_inbox_health() from public,anon,authenticated,service_role;
grant execute on function public.eco_inbox_health() to authenticated,service_role;

revoke all on function eco_private.inbox_text(jsonb,text,integer,integer),eco_private.inbox_uuid(jsonb,text),eco_private.inbox_live(jsonb),eco_private.inbox_item(eco_private.inbox_messages),eco_private.inbox_unread(uuid),eco_private.inbox_service(),eco_private.inbox_source(uuid),eco_private.inbox_fence(eco_private.inbox_sources,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.eco_list_enquiry_inbox(jsonb),public.eco_mutate_enquiry_inbox(jsonb),public.eco_ingest_enquiry(jsonb),public.eco_resolve_inbox_sender(jsonb),public.eco_get_inbox_receipt(jsonb),public.eco_claim_inbox_source(jsonb),public.eco_checkpoint_inbox_source(jsonb),public.eco_release_inbox_source(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.eco_list_enquiry_inbox(jsonb),public.eco_mutate_enquiry_inbox(jsonb) to authenticated;
grant execute on function public.eco_ingest_enquiry(jsonb),public.eco_resolve_inbox_sender(jsonb),public.eco_get_inbox_receipt(jsonb),public.eco_claim_inbox_source(jsonb),public.eco_checkpoint_inbox_source(jsonb),public.eco_release_inbox_source(jsonb) to service_role;
insert into eco_private.platform_versions(component,migration_head) values('enquiry-inbox','20261015112405');


-- BOOTSTRAP SECTION 20261016023333_eco_supplier_active_spc_pic.sql
-- Only active SPC traders are selectable PICs. Existing assignments are not rewritten.
create or replace function eco_private.supplier_pic_options() returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 perform eco_private.current_member();
 with names as (
  select trim(u.display_name) as name from eco_private.users u
  where u.deleted_at is null and u.is_active and u.is_spc_trader and u.activated_at is not null
   and u.access_hold_request is null
   and exists(select 1 from auth.users a where a.id=u.id and a.email_confirmed_at is not null)
 ), unique_names as (
  select min(name) as name from names where name<>'' group by lower(name)
 )
 select coalesce(jsonb_agg(name order by lower(name),name),'[]'::jsonb) into result from unique_names;
 return jsonb_build_object('options',result);
end;$$;

-- The existing create/update RPCs remain authoritative for actor permissions,
-- revisions and idempotent receipts. Validate only an actual new assignment so
-- editing another field never rejects an unchanged imported/retired PIC.
create function eco_private.guard_supplier_pic_assignment() returns trigger
language plpgsql security definer set search_path='' as $$
declare selected_name text; selected_user uuid;
begin
 -- Operator-only imports/enrichment retain source history. Browser roles cannot
 -- invoke those RPCs or write the private supplier table directly.
 if auth.jwt()->>'role'='service_role' or new.record->>'countryCode'<>'SG' then return new;end if;
 selected_name:=trim(coalesce(new.record#>>'{info,supplierTrader}',''));
 if selected_name='' then return new;end if;
 if tg_op='UPDATE' and selected_name=trim(coalesce(old.record#>>'{info,supplierTrader}','')) then return new;end if;
 perform eco_private.supplier_writable_member();
 select u.id into selected_user from eco_private.users u
 where u.deleted_at is null and u.is_active and u.is_spc_trader and u.activated_at is not null
  and u.access_hold_request is null and lower(trim(u.display_name))=lower(selected_name)
  and exists(select 1 from auth.users a where a.id=u.id and a.email_confirmed_at is not null)
 order by u.id limit 1 for share of u;
 if not found then raise exception 'Select an active SPC trader' using errcode='PT422';end if;
 return new;
end;$$;
revoke all on function eco_private.guard_supplier_pic_assignment() from public,anon,authenticated,service_role;
create trigger eco_supplier_pic_assignment
before insert or update of record on eco_private.suppliers
for each row execute function eco_private.guard_supplier_pic_assignment();
update eco_private.platform_versions set migration_head='20261016023333' where component='supplier-pic-options';


-- BOOTSTRAP SECTION 20261016024020_eco_supplier_port_profiles.sql
-- Exact country/port scopes for the existing ECO reference locations. No name guessing.
create function eco_private.supplier_port(p_id text) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('id',id,'countryCode',country_code,'countryName',country_name,'portName',port_name)
 from (values ('port-singapore','SG','Singapore','Singapore'),
 ('port-hong-kong','HK','Hong Kong','Hong Kong'),
 ('port-rotterdam','NL','Netherlands','Rotterdam'),
 ('port-fujairah','AE','United Arab Emirates','Fujairah'),
 ('port-busan','KR','South Korea','Busan'),
 ('port-tokyo','JP','Japan','Tokyo'),
 ('port-chiba','JP','Japan','Chiba'),
 ('port-yokohama','JP','Japan','Yokohama'),
 ('port-osaka','JP','Japan','Osaka'),
 ('port-ho-chi-minh','VN','Vietnam','Ho Chi Minh City'),
 ('port-gibraltar','GI','Gibraltar','Gibraltar')) p(id,country_code,country_name,port_name) where id=p_id;
$$;
revoke all on function eco_private.supplier_port(text) from public,anon,authenticated,service_role;

-- Use the stored immutable supplier country for writes, including idempotent archive retries.
create function eco_private.supplier_record_writable_member(p_id uuid) returns eco_private.users language plpgsql security definer set search_path='' as $$
declare actor eco_private.users;country text;
begin
 actor:=eco_private.admin_writable_member();
 select country_code into country from eco_private.suppliers where id=p_id;
 if not found then raise exception 'Unknown supplier' using errcode='22023';end if;
 if country='SG' and not(actor.is_admin or actor.is_spc_trader) then raise exception 'Supplier authority required' using errcode='42501';end if;
 return actor;
end;$$;
revoke all on function eco_private.supplier_record_writable_member(uuid) from public,anon,authenticated,service_role;


create or replace function eco_private.list_suppliers(p_query jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare q text; country text; grade text; trader text; page integer; lim integer; result jsonb; total bigint;port jsonb;
begin
 perform eco_private.current_member();perform eco_private.admin_check_keys(p_query,array['search','country','grade','trader','page','limit','portId']);
 perform eco_private.admin_check_text(p_query,'search',0,160);perform eco_private.admin_check_text(p_query,'country',0,2);perform eco_private.admin_check_text(p_query,'grade',0,100);perform eco_private.admin_check_text(p_query,'trader',0,160);
 if jsonb_typeof(p_query->'page') is distinct from 'number' or (p_query->>'page') !~ '^[1-9][0-9]*$' or (p_query->>'page')::numeric>100000 or jsonb_typeof(p_query->'limit') is distinct from 'number' or (p_query->>'limit') !~ '^[1-9][0-9]*$' or (p_query->>'limit')::numeric>100 then raise exception 'Invalid pagination' using errcode='22023';end if;
 if p_query ? 'portId' then
  perform eco_private.admin_check_text(p_query,'portId',1,100);port:=eco_private.supplier_port(p_query->>'portId');
  if port is null then raise exception 'Unknown supplier port' using errcode='22023';end if;
 end if;
 q:=lower(trim(p_query->>'search'));country:=upper(trim(p_query->>'country'));grade:=lower(trim(p_query->>'grade'));trader:=lower(trim(p_query->>'trader'));page:=(p_query->>'page')::integer;lim:=(p_query->>'limit')::integer;
 with matched as materialized (select s.* from eco_private.suppliers s where s.archived_at is null and (country='' or s.country_code=country)
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
 perform eco_private.admin_check_keys(p_input,array['requestId','legalName','shortName','countryCode','countryName','portName','background','info','contacts','barges','portId']);
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
 insert into eco_private.suppliers(id,source_key,record,background) values(sid,rec->>'sourceKey',rec,trim(p_input->>'background')) returning * into item;
 insert into eco_private.supplier_revisions(supplier_id,revision,actor_id,reason,snapshot) values(sid,1,actor.id,'create',eco_private.present_supplier(item));
 insert into eco_private.administration_events(actor_id,actor_name,target_id,action,details) values(actor.id,actor.display_name,sid,'supplier-created',jsonb_build_object('revision',1,'shortName',item.short_name));
 return eco_private.admin_finish(actor.id,p_input,eco_private.present_supplier(item));
end;$$;

create or replace function eco_private.update_supplier(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor eco_private.users; prior jsonb; item eco_private.suppliers; sid uuid; next_record jsonb; row_value jsonb; old_row jsonb; rows jsonb; kind text; source_id text; source jsonb;
begin
 actor:=eco_private.supplier_record_writable_member(eco_private.supplier_uuid(p_input->'id'));if octet_length(p_input::text)>262144 then raise exception 'Request too large' using errcode='22023';end if;perform eco_private.admin_check_keys(p_input,array['requestId','id','revision','info','contacts','barges','legalName','shortName','background']);sid:=eco_private.supplier_uuid(p_input->'id');
 if jsonb_typeof(p_input->'revision') is distinct from 'number' or (p_input->>'revision') !~ '^[1-9][0-9]*$' or (p_input->>'revision')::numeric>2147483647 then raise exception 'Invalid revision' using errcode='22023';end if;
 perform eco_private.supplier_info_check(p_input->'info');perform eco_private.supplier_rows_check(p_input->'contacts','contacts');perform eco_private.supplier_rows_check(p_input->'barges','barges');
 prior:=eco_private.admin_request(actor.id,p_input,'supplier-update');if prior is not null then return prior;end if;
 select * into item from eco_private.suppliers where id=sid and archived_at is null for update;if not found then raise exception 'Unknown supplier' using errcode='22023';end if;
 if item.revision<>(p_input->>'revision')::integer then raise exception 'Revision conflict' using errcode='PT409';end if;
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
 if next_record=item.record and coalesce(p_input->>'background',item.background)=item.background then raise exception 'No changes' using errcode='22023';end if;
 source:=jsonb_build_object('id',source_id,'type','user','title',actor.display_name,'url','','documentDate',to_char(now() at time zone 'Asia/Hong_Kong','YYYY-MM-DD'),'retrievedAt',now());
 -- Retain cited operational sources and all imported evidence. Superseded uncited user sources
 -- remain in immutable revision snapshots rather than growing the current profile indefinitely.
 next_record:=jsonb_set(next_record,'{sources}',coalesce((select jsonb_agg(value) from jsonb_array_elements(next_record->'sources') old_source
  where value->>'type'<>'user' or value->>'id'=next_record->>'legalNameSourceId'
   or exists(select 1 from jsonb_array_elements((next_record->'contacts')||(next_record->'barges')||(next_record->'facts')) cited where cited->>'sourceId'=old_source.value->>'id')),'[]'::jsonb)||jsonb_build_array(source));
 perform eco_private.supplier_record_check(next_record);
 update eco_private.suppliers set record=next_record,background=coalesce(p_input->>'background',background),revision=revision+1,updated_at=now() where id=sid returning * into item;
 insert into eco_private.supplier_revisions(supplier_id,revision,actor_id,reason,snapshot) values(sid,item.revision,actor.id,'update',eco_private.present_supplier(item));
 insert into eco_private.administration_events(actor_id,actor_name,target_id,action,details) values(actor.id,actor.display_name,sid,'supplier-updated',jsonb_build_object('revision',item.revision,'shortName',item.short_name));
 return eco_private.admin_finish(actor.id,p_input,eco_private.present_supplier(item));
end;$$;

create or replace function eco_private.archive_supplier(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor eco_private.users;prior jsonb;item eco_private.suppliers;result jsonb;
begin
 actor:=eco_private.supplier_record_writable_member(eco_private.supplier_uuid(p_input->'id'));if octet_length(p_input::text)>262144 then raise exception 'Request too large' using errcode='22023';end if;perform eco_private.admin_check_keys(p_input,array['requestId','id','revision']);perform eco_private.supplier_uuid(p_input->'id');
 if jsonb_typeof(p_input->'revision') is distinct from 'number' or (p_input->>'revision') !~ '^[1-9][0-9]*$' or (p_input->>'revision')::numeric>2147483647 then raise exception 'Invalid revision' using errcode='22023';end if;
 prior:=eco_private.admin_request(actor.id,p_input,'supplier-archive');if prior is not null then return prior;end if;
 select * into item from eco_private.suppliers where id=(p_input->>'id')::uuid and archived_at is null for update;
 if not found then raise exception 'Unknown supplier' using errcode='22023';end if;
 if item.revision<>(p_input->>'revision')::integer then raise exception 'Revision conflict' using errcode='PT409';end if;
 update eco_private.suppliers set archived_at=now(),archived_by=actor.id,revision=revision+1,updated_at=now() where id=item.id returning * into item;
 result:=jsonb_build_object('id',item.id,'revision',item.revision,'archivedAt',item.archived_at);
 insert into eco_private.supplier_revisions(supplier_id,revision,actor_id,reason,snapshot) values(item.id,item.revision,actor.id,'archive',eco_private.present_supplier(item)||result);
 insert into eco_private.administration_events(actor_id,actor_name,target_id,action,details) values(actor.id,actor.display_name,item.id,'supplier-archived',jsonb_build_object('revision',item.revision));
 return eco_private.admin_finish(actor.id,p_input,result);
end;$$;

create or replace function eco_private.mutate_profile_tabs(p_input jsonb,p_action text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor eco_private.users;target jsonb;scope_owner uuid;visibility text;previous eco_private.profile_tab_collections;next_tabs jsonb;prior jsonb;expected integer;next_revision integer;tab jsonb;result jsonb;
begin
 actor:=eco_private.admin_writable_member();
 if octet_length(p_input::text)>262144 then raise exception 'Request too large' using errcode='22023';end if;
 if p_action='save' then perform eco_private.admin_check_keys(p_input,array['requestId','target','visibility','revision','tabs']);
 elsif p_action='delete' then perform eco_private.admin_check_keys(p_input,array['requestId','target','visibility','revision','id']);
 elsif p_action='reorder' then perform eco_private.admin_check_keys(p_input,array['requestId','target','visibility','revision','ids']);
 else raise exception 'Invalid tab operation' using errcode='22023';end if;
 perform eco_private.profile_target_check(p_input->'target');target:=p_input->'target';
 if target->>'kind'='supplier' then target:=jsonb_set(target,'{id}',to_jsonb(lower(target->>'id')));end if;
 visibility:=p_input->>'visibility';
 if visibility is null or visibility not in ('shared','private') then raise exception 'Invalid visibility' using errcode='22023';end if;
 if visibility='shared' and target->>'kind'='supplier' then perform eco_private.supplier_record_writable_member((target->>'id')::uuid);end if;
 scope_owner:=case when visibility='shared' then '00000000-0000-0000-0000-000000000000'::uuid else actor.id end;
 if jsonb_typeof(p_input->'revision') is distinct from 'number' or p_input->>'revision' !~ '^(0|[1-9][0-9]*)$' or (p_input->>'revision')::numeric>=2147483647 then raise exception 'Invalid revision' using errcode='22023';end if;
 expected:=(p_input->>'revision')::integer;
 -- Only the exact real actor can retrieve a retry receipt, and preview was checked above.
 prior:=eco_private.admin_request(actor.id,p_input,'profile-tabs-'||p_action);if prior is not null then return prior;end if;
 select * into previous from eco_private.profile_tab_collections where target_kind=target->>'kind' and target_id=target->>'id' and owner_id=scope_owner for update;
 if coalesce(previous.revision,0)<>expected then raise exception 'Revision conflict' using errcode='PT409';end if;
 if p_action='save' then next_tabs:=p_input->'tabs';
 elsif p_action='delete' then
  perform eco_private.admin_check_text(p_input,'id',1,80);
  if not exists(select 1 from jsonb_array_elements(coalesce(previous.tabs,'[]')) where value->>'id'=p_input->>'id') then raise exception 'Unknown tab' using errcode='22023';end if;
  select coalesce(jsonb_agg(value order by ord),'[]') into next_tabs from jsonb_array_elements(previous.tabs) with ordinality v(value,ord) where value->>'id'<>p_input->>'id';
 else
  if jsonb_typeof(p_input->'ids') is distinct from 'array' then raise exception 'Invalid order' using errcode='22023';end if;
  if jsonb_array_length(p_input->'ids')<>jsonb_array_length(coalesce(previous.tabs,'[]')) or (select count(distinct value) from jsonb_array_elements(p_input->'ids'))<>jsonb_array_length(p_input->'ids') then raise exception 'Invalid order' using errcode='22023';end if;
  if exists(select 1 from jsonb_array_elements(p_input->'ids') v where jsonb_typeof(v) is distinct from 'string' or not exists(select 1 from jsonb_array_elements(previous.tabs) t where t->>'id'=v#>>'{}')) then raise exception 'Invalid order' using errcode='22023';end if;
  select coalesce(jsonb_agg(t order by n),'[]') into next_tabs from jsonb_array_elements_text(p_input->'ids') with ordinality v(id,n) join lateral jsonb_array_elements(previous.tabs) t on t->>'id'=id;
 end if;
 perform eco_private.profile_tabs_validate(next_tabs,target,visibility,scope_owner);
 if previous.revision is not null and next_tabs=previous.tabs then raise exception 'No changes' using errcode='22023';end if;
 next_revision:=coalesce(previous.revision,0)+1;
 insert into eco_private.profile_tab_collections(target_kind,target_id,owner_id,revision,tabs) values(target->>'kind',target->>'id',scope_owner,next_revision,next_tabs)
 on conflict(target_kind,target_id,owner_id) do update set revision=excluded.revision,tabs=excluded.tabs,updated_at=now();
 for tab in select value from jsonb_array_elements(next_tabs) loop
  insert into eco_private.profile_tab_identities(target_kind,target_id,tab_id,owner_id,builtin) values(target->>'kind',target->>'id',tab->>'id',scope_owner,tab->>'builtin') on conflict do nothing;
 end loop;
 insert into eco_private.profile_tab_revisions(target_kind,target_id,owner_id,revision,actor_id,tabs) values(target->>'kind',target->>'id',scope_owner,next_revision,actor.id,next_tabs);
 insert into eco_private.administration_events(actor_id,actor_name,target_id,action,details) values(actor.id,actor.display_name,(p_input->>'requestId')::uuid,'profile-tabs-'||p_action,jsonb_build_object('targetKind',target->>'kind','targetId',target->>'id','visibility',visibility,'revision',next_revision,'tabCount',jsonb_array_length(next_tabs)));
 result:=eco_private.profile_tabs_result(target,actor.id,false);
 return eco_private.admin_finish(actor.id,p_input,result);
end;$$;

insert into eco_private.platform_versions(component,migration_head) values('supplier-port-profiles','20261016024020') on conflict(component) do update set migration_head=excluded.migration_head;


-- BOOTSTRAP SECTION 20261016093312_eco_parser_review_workflow.sql
-- Additive review state. Original report input and original AI receipts remain immutable.
alter table eco_private.parser_reports add column review_revision integer not null default 0,
 add column review_stage text not null default 'pending_user' check(review_stage in ('pending_user','pending_ai','reviewed')),
 add column review_expected jsonb, add column review_notes text not null default '',
 add column review_ai jsonb, add column review_replay jsonb, add column accepted_build_fingerprint text;
create index eco_parser_reports_review_queue on eco_private.parser_reports(data_mode,review_stage,created_at desc,id desc);
create table eco_private.parser_review_history (
 id uuid primary key default gen_random_uuid(), report_id uuid not null references eco_private.parser_reports(id) on delete cascade,
 revision integer not null, actor_name text not null, action text not null, data jsonb not null, created_at timestamptz not null default now()
);
create index eco_parser_review_history_report on eco_private.parser_review_history(report_id,created_at,id);
create table eco_private.parser_review_actions (
 actor_id uuid not null, request_id uuid not null, report_id uuid not null references eco_private.parser_reports(id) on delete cascade,
 input jsonb not null, result jsonb not null, created_at timestamptz not null default now(), primary key(actor_id,request_id)
);
create table eco_private.parser_review_requests (
 actor_id uuid not null, request_id uuid not null, report_id uuid not null references eco_private.parser_reports(id) on delete cascade,
 session_id uuid not null, origin_aal text not null, kind text not null check(kind in ('ai','replay')),
 input jsonb not null, evidence jsonb not null, state text not null default 'pending' check(state in ('pending','complete','failed')),
 result jsonb, error_code text, created_at timestamptz not null default now(), completed_at timestamptz, primary key(actor_id,request_id)
);
create index eco_parser_review_requests_actor_time on eco_private.parser_review_requests(actor_id,created_at desc);
alter table eco_private.parser_review_history enable row level security;
alter table eco_private.parser_review_actions enable row level security;
alter table eco_private.parser_review_requests enable row level security;
revoke all on eco_private.parser_review_history,eco_private.parser_review_actions,eco_private.parser_review_requests from public,anon,authenticated,service_role;

create function eco_private.parser_check_snapshot(p jsonb) returns void language plpgsql set search_path='' as $$
declare k text; item jsonb;
begin
 perform eco_private.admin_check_keys(p,array['fields','standardText','warnings','rmk','viscosity']);
 perform eco_private.admin_check_keys(p->'fields',array['vessel','imo','buyerText','portText','eta','hsfo','vlsfo','lsmgo','remarks']);
 foreach k in array array['vessel','imo','buyerText','portText','eta','hsfo','vlsfo','lsmgo','remarks'] loop
  perform eco_private.admin_check_text(p->'fields',k,0,case when k='remarks' then 3000 else 500 end);
 end loop;
 perform eco_private.admin_check_text(p,'standardText',0,20000);
 if jsonb_typeof(p->'rmk') is distinct from 'boolean' or jsonb_typeof(p->'warnings') is distinct from 'array' or jsonb_typeof(p->'viscosity') is distinct from 'array' then raise exception 'Invalid snapshot' using errcode='22023';end if;
 if jsonb_array_length(p->'warnings')>100 or jsonb_array_length(p->'viscosity')>4 or octet_length(p::text)>50000 then raise exception 'Invalid snapshot' using errcode='22023';end if;
 for item in select value from jsonb_array_elements(p->'warnings') loop
  if jsonb_typeof(item)<>'string' or length(item#>>'{}')>2000 then raise exception 'Invalid warning' using errcode='22023';end if;
 end loop;
 for item in select value from jsonb_array_elements(p->'viscosity') loop
  if jsonb_typeof(item)<>'string' or item#>>'{}' not in ('80cst min','80cst max','120cst max','180cst max') then raise exception 'Invalid viscosity' using errcode='22023';end if;
 end loop;
end;$$;

create function eco_private.parser_review_member() returns eco_private.users language plpgsql set search_path='' as $$
declare m eco_private.users;
begin m:=eco_private.require_admin();if exists(select 1 from eco_private.role_previews where session_id::text=auth.jwt()->>'session_id') then raise exception 'Forbidden' using errcode='42501';end if;m:=eco_private.admin_writable_member();return m;end;$$;

create function eco_private.parser_report_json(r eco_private.parser_reports) returns jsonb language sql stable set search_path='' as $$
 select r.input || jsonb_build_object('id',r.id,'createdAt',r.created_at,'createdBy',r.owner_name,'dataMode',r.data_mode,
 'sourceHash',encode(sha256(convert_to(r.input->>'rawText','UTF8')),'hex'),'buildFingerprint',r.accepted_build_fingerprint,
 'workflow',jsonb_build_object('revision',r.review_revision,'stage',r.review_stage,'expected',r.review_expected,'notes',r.review_notes,'aiReview',r.review_ai,'replay',r.review_replay),
 'originalAi',(select jsonb_build_object('requestId',a.id,'state',a.state,'input',a.input,'result',a.result,'errorCode',a.error_code)
 from eco_private.parser_ai_requests a where a.owner_id=r.owner_id and a.id::text=r.input->>'aiRequestId' and a.data_mode=r.data_mode and a.generation is not distinct from r.generation and a.input->>'rawText'=r.input->>'rawText'),
 'history',coalesce((select jsonb_agg(jsonb_build_object('id',h.id,'revision',h.revision,'action',h.action,'actor',h.actor_name,'createdAt',h.created_at,'data',h.data) order by h.created_at,h.id) from eco_private.parser_review_history h where h.report_id=r.id),'[]'::jsonb))
$$;

create function eco_private.parser_review_target(m eco_private.users,p jsonb) returns eco_private.parser_reports language plpgsql set search_path='' as $$
declare r eco_private.parser_reports;g uuid;
begin
 g:=eco_private.parser_scope(m,p);
 select * into r from eco_private.parser_reports where id=(p->>'reportId')::uuid and data_mode=p->>'dataMode' and generation is not distinct from g and (data_mode='live' or owner_id=m.id) for update;
 if not found then raise exception 'Report unavailable' using errcode='PT404';end if;return r;
end;$$;

create or replace function public.eco_list_parser_reports(p_query jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare m eco_private.users;g uuid;lim integer;at_time timestamptz;at_id uuid;page jsonb;total integer;next_cursor text;detail_report eco_private.parser_reports;st text;
begin
 m:=eco_private.parser_review_member();
 perform eco_private.admin_check_keys(p_query,array['dataMode','generation','limit','cursor','stage','id','summary']);g:=eco_private.parser_scope(m,p_query);
 if p_query ? 'id' then
  if p_query ?| array['limit','cursor','stage','summary'] then raise exception 'Invalid query' using errcode='22023';end if;
  detail_report:=eco_private.parser_review_target(m,(p_query-'id')||jsonb_build_object('reportId',p_query->'id'));return eco_private.parser_report_json(detail_report);
 end if;
 if p_query ? 'summary' and p_query->'summary'<>'true'::jsonb then raise exception 'Invalid summary flag' using errcode='22023';end if;
 st:=coalesce(p_query->>'stage','all');if st not in ('all','pending_user','pending_ai','reviewed') then raise exception 'Invalid stage' using errcode='22023';end if;
 if coalesce(p_query->>'limit','25') !~ '^[0-9]{1,2}$' then raise exception 'Invalid limit' using errcode='22023';end if;
 lim:=coalesce(p_query->>'limit','25')::integer;if lim not between 1 and 50 then raise exception 'Invalid limit' using errcode='22023';end if;
 if coalesce(p_query->>'cursor','')<>'' then
  if length(p_query->>'cursor')>100 or array_length(string_to_array(p_query->>'cursor','|'),1)<>2 then raise exception 'Invalid cursor' using errcode='22023';end if;
  begin at_time:=split_part(p_query->>'cursor','|',1)::timestamptz;at_id:=split_part(p_query->>'cursor','|',2)::uuid;exception when others then raise exception 'Invalid cursor' using errcode='22023';end;
 end if;
 with candidates as (select r as report from eco_private.parser_reports r where r.data_mode=p_query->>'dataMode' and r.generation is not distinct from g and (r.data_mode='live' or r.owner_id=m.id) and (st='all' or r.review_stage=st) and (at_time is null or (r.created_at,r.id)<(at_time,at_id)) order by r.created_at desc,r.id desc limit lim+1),
 numbered as (select report,row_number() over(order by (report).created_at desc,(report).id desc) as n from candidates)
 select coalesce(jsonb_agg(case when p_query->'summary'='true'::jsonb then jsonb_build_object('id',(report).id,'createdAt',(report).created_at,'createdBy',(report).owner_name,'dataMode',(report).data_mode,'parsed',(report).input->'parsed','corrected',(report).input->'corrected','workflow',jsonb_build_object('revision',(report).review_revision,'stage',(report).review_stage)) else eco_private.parser_report_json(report) end order by (report).created_at desc,(report).id desc) filter(where n<=lim),'[]'::jsonb),count(*),max(case when n=lim then (report).created_at::text||'|'||(report).id::text end) into page,total,next_cursor from numbered;
 return jsonb_build_object('items',page,'nextCursor',case when total>lim then next_cursor else null end);
end;$$;

create function public.eco_review_parser_report(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare m eco_private.users;r eco_private.parser_reports;prior eco_private.parser_review_actions;receipt eco_private.parser_review_requests;rid uuid;result jsonb;
begin
 m:=eco_private.parser_review_member();
 perform eco_private.admin_check_keys(p_input,array['requestId','reportId','expectedRevision','dataMode','generation','action','expected','notes','aiRequestId']);
 rid:=(p_input->>'requestId')::uuid;r:=eco_private.parser_review_target(m,p_input);
 select * into prior from eco_private.parser_review_actions where actor_id=m.id and request_id=rid;
 if found then if prior.input<>p_input then raise exception 'Request conflict' using errcode='PT409';end if;return prior.result;end if;
 if p_input->>'expectedRevision' is distinct from r.review_revision::text then raise exception 'Report changed. Reload before reviewing.' using errcode='PT409';end if;
 if p_input->>'action'='approve' then
  if r.review_stage<>'pending_user' or p_input ? 'aiRequestId' then raise exception 'Invalid review stage' using errcode='PT409';end if;
  perform eco_private.parser_check_snapshot(p_input->'expected');perform eco_private.admin_check_text(p_input,'notes',0,2000);
  update eco_private.parser_reports set review_stage='pending_ai',review_revision=review_revision+1,review_expected=p_input->'expected',review_notes=p_input->>'notes',review_ai=null,review_replay=null where id=r.id returning * into r;
 elsif p_input->>'action'='reopen' then
  if r.review_stage='pending_user' or p_input ?| array['expected','notes','aiRequestId'] then raise exception 'Invalid review stage' using errcode='PT409';end if;
  update eco_private.parser_reports set review_stage='pending_user',review_revision=review_revision+1,review_ai=null,review_replay=null where id=r.id returning * into r;
 elsif p_input->>'action'='complete' then
  if r.review_stage<>'pending_ai' or p_input ?| array['expected','notes'] then raise exception 'Invalid review stage' using errcode='PT409';end if;
  select * into receipt from eco_private.parser_review_requests where report_id=r.id and request_id=(p_input->>'aiRequestId')::uuid and kind='ai' and state='complete' and input->>'expectedRevision'=r.review_revision::text;
  if not found then raise exception 'A successful AI review is required.' using errcode='PT409';end if;
  update eco_private.parser_reports set review_stage='reviewed',review_revision=review_revision+1,review_ai=receipt.result where id=r.id returning * into r;
 else raise exception 'Invalid action' using errcode='22023';end if;
 insert into eco_private.parser_review_history(report_id,revision,actor_name,action,data) values(r.id,r.review_revision,m.display_name,p_input->>'action',p_input-'generation'-'dataMode');
 result:=eco_private.parser_report_json(r);
 insert into eco_private.parser_review_actions(actor_id,request_id,report_id,input,result) values(m.id,rid,r.id,p_input,result);
 return result;
end;$$;

create function public.eco_begin_parser_review(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare m eco_private.users;r eco_private.parser_reports;prior eco_private.parser_review_requests;rid uuid;kind text;evidence jsonb;
begin
 m:=eco_private.parser_review_member();perform eco_private.admin_check_keys(p_input,array['requestId','reportId','expectedRevision','dataMode','generation','kind']);
 rid:=(p_input->>'requestId')::uuid;kind:=p_input->>'kind';if kind not in ('ai','replay') or kind is null then raise exception 'Invalid kind' using errcode='22023';end if;
 r:=eco_private.parser_review_target(m,p_input);
 select * into prior from eco_private.parser_review_requests where actor_id=m.id and request_id=rid for update;
 if found then
  if prior.input<>p_input then raise exception 'Request conflict' using errcode='PT409';end if;
  if prior.state='pending' and prior.created_at<now()-interval '2 minutes' then update eco_private.parser_review_requests set state='failed',error_code='REQUEST_EXPIRED',completed_at=now() where actor_id=m.id and request_id=rid returning * into prior;end if;
  return jsonb_build_object('id',rid,'state',prior.state,'runProvider',false,'result',prior.result,'errorCode',prior.error_code);
 end if;
 if p_input->>'expectedRevision' is distinct from r.review_revision::text then raise exception 'Report changed. Reload before reviewing.' using errcode='PT409';end if;
 if (kind='ai' and r.review_stage<>'pending_ai') or (kind='replay' and r.review_stage<>'reviewed') then raise exception 'Invalid review stage' using errcode='PT409';end if;
 if (select count(*) from eco_private.parser_review_requests where actor_id=m.id and created_at>now()-interval '1 minute')>=10 or (select count(*) from eco_private.parser_review_requests where actor_id=m.id and created_at>now()-interval '24 hours')>=200 then raise exception 'Review rate limit' using errcode='PT429';end if;
 evidence:=eco_private.parser_report_json(r)-'history';
 insert into eco_private.parser_review_requests(actor_id,request_id,report_id,session_id,origin_aal,kind,input,evidence) values(m.id,rid,r.id,(auth.jwt()->>'session_id')::uuid,case when auth.jwt()->>'aal'='aal2' then 'aal2' else 'aal1' end,kind,p_input,evidence);
 return jsonb_build_object('id',rid,'state','pending','runProvider',true,'evidence',evidence);
end;$$;

create function public.eco_finish_parser_review(p_actor_id uuid,p_request_id uuid,p_result jsonb,p_error_code text) returns jsonb language plpgsql security definer set search_path='' as $$
declare q eco_private.parser_review_requests;m eco_private.users;r eco_private.parser_reports;output_result jsonb;
begin
 perform pg_advisory_xact_lock(1857,2026);
 select * into q from eco_private.parser_review_requests where actor_id=p_actor_id and request_id=p_request_id for update;
 if not found then raise exception 'Unknown review' using errcode='22023';end if;
 select u.* into m from eco_private.users u where u.id=p_actor_id and u.is_admin and u.is_active and u.activated_at is not null and u.access_hold_request is null and exists(select 1 from auth.users a where a.id=u.id and a.email_confirmed_at is not null);
 if not found or (m.mfa_required and q.origin_aal<>'aal2') then raise exception 'Unauthorized' using errcode='28000';end if;
 perform eco_private.assert_preview_writable(m.id,q.session_id);r:=eco_private.parser_review_target(m,q.input);
 if q.state<>'pending' then return jsonb_build_object('id',q.request_id,'state',q.state,'runProvider',false,'result',q.result,'errorCode',q.error_code);end if;
 if q.created_at<now()-interval '2 minutes' then p_error_code:='REQUEST_EXPIRED';end if;
 if q.input->>'expectedRevision' is distinct from r.review_revision::text or (q.kind='ai' and r.review_stage<>'pending_ai') or (q.kind='replay' and r.review_stage<>'reviewed') then p_error_code:='REVIEW_CONFLICT';end if;
 if p_error_code is not null and p_error_code !~ '^[A-Z_]{1,60}$' then raise exception 'Invalid error code' using errcode='22023';end if;
 if p_error_code is null then
  if jsonb_typeof(p_result) is distinct from 'object' or octet_length(p_result::text)>65536 then raise exception 'Invalid result' using errcode='22023';end if;
  if q.kind='ai' then
   if p_result->>'requestId' is distinct from q.request_id::text or p_result->>'reportId' is distinct from r.id::text or p_result->>'revision' is distinct from r.review_revision::text then raise exception 'Invalid analysis identity' using errcode='22023';end if;
   update eco_private.parser_reports set review_ai=p_result where id=r.id returning * into r;output_result:=p_result;
  else
   if p_result->>'status' not in ('matched','different','legacy-unverified') or p_result#>>'{provenance,reportId}' is distinct from r.id::text or p_result#>>'{provenance,reportRevision}' is distinct from r.review_revision::text or p_result#>>'{executedWith,buildFingerprint}' !~ '^[0-9a-f]{64}$' then raise exception 'Invalid replay' using errcode='22023';end if;
   if not (r.input ? 'capture') and p_result->>'status'<>'legacy-unverified' then raise exception 'Legacy capture is unverified' using errcode='22023';end if;
   update eco_private.parser_reports set review_replay=p_result,review_revision=review_revision+1 where id=r.id returning * into r;
  end if;
  insert into eco_private.parser_review_history(report_id,revision,actor_name,action,data) values(r.id,r.review_revision,m.display_name,case when q.kind='ai' then 'ai_review' else 'replay' end,p_result);
  if q.kind='replay' then output_result:=eco_private.parser_report_json(r);end if;
 end if;
 update eco_private.parser_review_requests set state=case when p_error_code is null then 'complete' else 'failed' end,result=case when p_error_code is null then output_result else null end,error_code=p_error_code,completed_at=now() where actor_id=p_actor_id and request_id=p_request_id returning * into q;
 return jsonb_build_object('id',q.request_id,'state',q.state,'runProvider',false,'result',q.result,'errorCode',q.error_code);
end;$$;

-- This stamp describes the server accepting the report, never the client's historical parse build.
create function public.eco_stamp_parser_report(p_actor_id uuid,p_report_id uuid,p_fingerprint text) returns void language plpgsql security definer set search_path='' as $$
begin
 if p_fingerprint !~ '^[0-9a-f]{64}$' then raise exception 'Invalid fingerprint' using errcode='22023';end if;
 update eco_private.parser_reports set accepted_build_fingerprint=p_fingerprint where id=p_report_id and owner_id=p_actor_id and accepted_build_fingerprint is null;
end;$$;

revoke all on function eco_private.parser_check_snapshot(jsonb),eco_private.parser_review_member(),eco_private.parser_report_json(eco_private.parser_reports),eco_private.parser_review_target(eco_private.users,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.eco_review_parser_report(jsonb),public.eco_begin_parser_review(jsonb),public.eco_finish_parser_review(uuid,uuid,jsonb,text),public.eco_stamp_parser_report(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.eco_review_parser_report(jsonb),public.eco_begin_parser_review(jsonb) to authenticated;
grant execute on function public.eco_finish_parser_review(uuid,uuid,jsonb,text),public.eco_stamp_parser_report(uuid,uuid,text) to service_role;
-- Existing service-only test purge deletes parser_reports; all new private descendants cascade.
insert into eco_private.platform_versions(component,migration_head) values('parser-review','20261016093312');

create or replace function public.eco_create_parser_report(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m eco_private.users; g uuid; r eco_private.parser_reports; rid uuid;
begin
 m:=eco_private.admin_writable_member();
 perform eco_private.admin_check_keys(p_input,array['requestId','rawText','sourceRevision','parserVersion','parsed','corrected','aiRequestId','notes','dataMode','generation','capture']);
 perform eco_private.admin_check_text(p_input,'requestId',36,36);
 if (p_input->>'requestId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Invalid request ID' using errcode='22023'; end if;
 perform eco_private.admin_check_text(p_input,'rawText',1,20000); perform eco_private.admin_check_text(p_input,'sourceRevision',1,128);
 perform eco_private.admin_check_text(p_input,'parserVersion',1,100); perform eco_private.admin_check_text(p_input,'notes',0,2000);
 if octet_length(p_input->>'rawText')>20000 or octet_length(p_input::text)>196608 or jsonb_typeof(p_input->'parsed') is distinct from 'object' or jsonb_typeof(p_input->'corrected') is distinct from 'object' then raise exception 'Invalid report' using errcode='22023'; end if;
 if p_input ? 'capture' then
  perform eco_private.admin_check_keys(p_input->'capture',array['original','submitted','originalRevision','parseOrigin','clientBuildFingerprint']);
  perform eco_private.parser_check_snapshot(p_input#>'{capture,original}');perform eco_private.parser_check_snapshot(p_input#>'{capture,submitted}');
  perform eco_private.admin_check_text(p_input->'capture','originalRevision',1,128);
  if p_input#>>'{capture,parseOrigin}' not in ('initial','reparsed') or p_input#>>'{capture,parseOrigin}' is null then raise exception 'Invalid parse origin' using errcode='22023'; end if;
  if p_input#>'{capture,original,fields}' is distinct from p_input->'parsed' or p_input#>'{capture,submitted,fields}' is distinct from p_input->'corrected' then raise exception 'Capture fields differ' using errcode='22023';end if;
 end if;
 g:=eco_private.parser_scope(m,p_input);rid:=(p_input->>'requestId')::uuid;
 if p_input->>'aiRequestId' is not null and not exists(select 1 from eco_private.parser_ai_requests a where a.owner_id=m.id and a.id::text=p_input->>'aiRequestId' and a.data_mode=p_input->>'dataMode' and a.generation is not distinct from g and a.input->>'rawText'=p_input->>'rawText') then raise exception 'Invalid AI reference' using errcode='22023'; end if;
 select * into r from eco_private.parser_reports where owner_id=m.id and request_id=rid for update;
 if found then
  if r.input<>p_input then raise exception 'Request conflict' using errcode='PT409'; end if;
 else
  insert into eco_private.parser_reports(request_id,owner_id,owner_name,data_mode,generation,input)
  values(rid,m.id,m.display_name,p_input->>'dataMode',g,p_input) returning * into r;
 end if;
 -- Test reports stay entirely in their own namespace; no shared contribution/audit payload.
 return jsonb_build_object('id',r.id,'createdAt',r.created_at);
end;$$;


-- BOOTSTRAP SECTION 20261020021735_eco_whatsapp_intake.sql
-- A signed Meta adapter writes only through this LIVE, service-only boundary.
-- No source, binding, provider credential, email lease or application grant is provisioned here.
create function public.eco_ingest_whatsapp_enquiry(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 s eco_private.inbox_sources; msg eco_private.inbox_messages; bound eco_private.inbox_sender_bindings;
 recipient eco_private.users; binding_count integer; reason text;
 v_provider text; account text; destination text; namespace text; message_id text; sender text;
 raw text; stamp text; received timestamptz; canonical jsonb; envelope_fingerprint text; body_hash text;
begin
 perform eco_private.inbox_service();
 perform eco_private.admin_check_keys(p_input,array['sourceId','provider','accountId','destinationId','messageId','senderIdentity','identityNamespace','rawText','receivedAt','quarantineReason']);
 if octet_length(p_input::text)>262144 then raise exception 'Invalid WhatsApp envelope' using errcode='22023'; end if;
 -- The existing permission-change lock also serializes delivery and its routing decision.
 perform pg_advisory_xact_lock(1857,2026);
 -- Lock bindings before its referenced source row, matching foreign-key insertion
 -- order. This also fences direct operator binding changes and ambiguous inserts.
 lock table eco_private.inbox_sender_bindings in share mode;
 s:=eco_private.inbox_source(eco_private.inbox_uuid(p_input,'sourceId'));
 v_provider:=eco_private.inbox_text(p_input,'provider',1,100);
 account:=eco_private.inbox_text(p_input,'accountId',1,320);
 destination:=eco_private.inbox_text(p_input,'destinationId',1,320);
 namespace:=eco_private.inbox_text(p_input,'identityNamespace',1,100);
 if s.channel<>'whatsapp' or v_provider<>'meta-whatsapp-cloud' or namespace<>'meta-whatsapp-signed-v1'
    or (v_provider,account,destination,namespace) is distinct from (s.provider,s.account_id,s.destination_id,s.identity_namespace)
 then raise exception 'WhatsApp source mismatch' using errcode='42501'; end if;
 message_id:=eco_private.inbox_text(p_input,'messageId',1,1024);
 sender:=eco_private.inbox_text(p_input,'senderIdentity',0,320);
 if sender<>'' and sender !~ '^[1-9][0-9]{6,14}$' then raise exception 'Invalid WhatsApp sender' using errcode='22023'; end if;
 if jsonb_typeof(p_input->'rawText') is distinct from 'string' then raise exception 'Invalid WhatsApp text' using errcode='22023'; end if;
 raw:=p_input->>'rawText';
 if p_input ? 'quarantineReason' then
  reason:=eco_private.inbox_text(p_input,'quarantineReason',1,50);
  if reason not in ('unsupported_attachment','unsupported_body','oversized','malformed_message') or raw<>''
  then raise exception 'Invalid WhatsApp quarantine' using errcode='22023'; end if;
 end if;
 if sender='' and reason is distinct from 'malformed_message' then raise exception 'Invalid WhatsApp sender' using errcode='22023'; end if;
 stamp:=eco_private.inbox_text(p_input,'receivedAt',20,40);
 if stamp !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,7})?(Z|[+-][0-9]{2}:[0-9]{2})$'
 then raise exception 'Invalid WhatsApp timestamp' using errcode='22023'; end if;
 begin received:=stamp::timestamptz;
 exception when invalid_datetime_format or datetime_field_overflow then raise exception 'Invalid WhatsApp timestamp' using errcode='22023'; end;
 if not isfinite(received) then raise exception 'Invalid WhatsApp timestamp' using errcode='22023'; end if;
 -- Quarantined receipts fingerprint identity/timestamp metadata only. Neither
 -- message content nor a digest of that content survives a rejected delivery.
 canonical:=jsonb_build_object('source',s.id,'provider',v_provider,'account',account,'destination',destination,
   'messageId',message_id,'sender',sender,'namespace',namespace,
   'received',to_char(received at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
 envelope_fingerprint:=encode(sha256(convert_to(canonical::text,'UTF8')),'hex');
 select * into msg from eco_private.inbox_messages
 where provider=v_provider and account_id=account and destination_id=destination and provider_message_id=message_id;
 if found then
  if msg.source_id<>s.id or msg.fingerprint<>envelope_fingerprint then raise exception 'Inbox delivery conflict' using errcode='PT409'; end if;
  if msg.status='accepted' and (reason is not null or msg.content_hash is distinct from encode(sha256(convert_to(raw,'UTF8')),'hex'))
  then raise exception 'Inbox delivery conflict' using errcode='PT409'; end if;
  -- Existing quarantined messages are never resurrected by a later binding or
  -- adapter change. Content changes cannot be compared because none was retained.
  return jsonb_strip_nulls(jsonb_build_object('id',msg.id,'status',msg.status,'duplicate',true,'reason',msg.reason));
 end if;
 if reason is null then
  if octet_length(raw)>20000 then reason:='oversized';
  elsif regexp_replace(raw,E'[\n\r\t]','','g') ~ '[[:cntrl:]]' then reason:='malformed_message';
  elsif received<s.cutover_at then reason:='before_cutover';
  else
   select count(*) into binding_count from eco_private.inbox_sender_bindings
   where source_id=s.id and sender_identity=sender and enabled and verified_at is not null;
   if binding_count=0 then reason:='unknown_sender'; elsif binding_count>1 then reason:='ambiguous_sender';
   else
    select * into bound from eco_private.inbox_sender_bindings
    where source_id=s.id and sender_identity=sender and enabled and verified_at is not null;
    select u.* into recipient from eco_private.users u
    where u.id=bound.owner_id and u.is_active and u.activated_at is not null and u.access_hold_request is null
      and exists(select 1 from auth.users a where a.id=u.id and a.email_confirmed_at is not null)
    for share;
    if not found then reason:='inactive_owner'; elsif btrim(raw,E' \n\r\t')='' then reason:='empty_message'; end if;
   end if;
  end if;
 end if;
 if reason is null then body_hash:=encode(sha256(convert_to(raw,'UTF8')),'hex'); end if;
 insert into eco_private.inbox_messages(source_id,provider,account_id,destination_id,provider_message_id,fingerprint,content_hash,
   channel,sender_identity,sender_display,owner_id,status,reason,raw_text,subject,received_at)
 values(s.id,v_provider,account,destination,message_id,envelope_fingerprint,body_hash,'whatsapp',sender,
   case when reason is null then bound.sender_display end,case when reason is null then recipient.id end,
   case when reason is null then 'accepted' else 'quarantined' end,reason,case when reason is null then raw end,null,received)
 returning * into msg;
 return jsonb_strip_nulls(jsonb_build_object('id',msg.id,'status',msg.status,'duplicate',false,'reason',msg.reason));
end;$$;
revoke all on function public.eco_ingest_whatsapp_enquiry(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.eco_ingest_whatsapp_enquiry(jsonb) to service_role;
insert into eco_private.platform_versions(component,migration_head) values('whatsapp-intake','20261020021735');


-- BOOTSTRAP SECTION 20261020033852_eco_directory_intake_routing.sql
-- Users & Access is the sender authority for configured production intake.
-- Approved/current directory fields only; pending contact requests are not routes.
-- Manual sources remain explicit isolated operator/test fixtures, never a fallback.
alter table eco_private.inbox_sources add column sender_authority text not null default 'manual'
 check(sender_authority in ('directory','manual'));
with changed as (
 update eco_private.inbox_sources set sender_authority='directory',updated_at=now()
 where (channel,provider,identity_namespace) in (
  ('email','microsoft-graph','exchange-authenticated-internal-v1'),
  ('whatsapp','meta-whatsapp-cloud','meta-whatsapp-signed-v1'))
 returning id
)
insert into eco_private.access_audit(actor_id,target_id,action,before_access,after_access)
 select null,id,'intake-sender-authority',jsonb_build_object('senderAuthority','manual'),
 jsonb_build_object('senderAuthority','directory','migration','20261020033852') from changed;
alter table eco_private.inbox_sources alter column sender_authority set default 'directory';
alter table eco_private.inbox_sources add constraint eco_inbox_directory_protocol check (
 sender_authority='manual' or (channel,provider,identity_namespace) in (
  ('email','microsoft-graph','exchange-authenticated-internal-v1'),
  ('whatsapp','meta-whatsapp-cloud','meta-whatsapp-signed-v1')));

-- Callers hold the permission-change advisory lock before the source row lock.
-- Every supported Users & Access/approved-phone mutation uses that same lock.
-- Resolve all matching current rows before eligibility: duplicate phones fail
-- closed even when one duplicate is inactive. Deleted rows are not current.
create function eco_private.inbox_sender_resolution(s eco_private.inbox_sources,p_sender text)
 returns table(owner_id uuid,sender_display text,reason text)
language plpgsql set search_path='' as $$
declare candidates integer; candidate uuid; display text; recipient eco_private.users;
begin
 if s.sender_authority='directory' then
  select count(*),min(u.id::text)::uuid into candidates,candidate
  from eco_private.users u where u.deleted_at is null and (
   (s.channel='email' and lower(u.email)=lower(p_sender)) or
   (s.channel='whatsapp' and p_sender ~ '^[1-9][0-9]{6,14}$' and u.phone='+'||p_sender));
 else
  select count(*),min(b.owner_id::text)::uuid,min(b.sender_display) into candidates,candidate,display
  from eco_private.inbox_sender_bindings b
  where b.source_id=s.id and b.sender_identity=p_sender and b.enabled and b.verified_at is not null;
 end if;
 if candidates=0 then return query select null::uuid,null::text,'unknown_sender'::text; return;
 elsif candidates<>1 then return query select null::uuid,null::text,'ambiguous_sender'::text; return; end if;
 select u.* into recipient from eco_private.users u
 where u.id=candidate and u.deleted_at is null and u.is_active and u.activated_at is not null
 and u.access_hold_request is null and exists(select 1 from auth.users a where a.id=u.id and a.email_confirmed_at is not null)
 for share;
 if not found then return query select null::uuid,null::text,'inactive_owner'::text; return; end if;
 return query select recipient.id,case when s.sender_authority='directory' then recipient.display_name else display end,null::text;
end;$$;
revoke all on function eco_private.inbox_sender_resolution(eco_private.inbox_sources,text) from public,anon,authenticated,service_role;

create or replace function public.eco_resolve_inbox_sender(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s eco_private.inbox_sources; sender text; route record;
begin
 perform eco_private.inbox_service(); perform eco_private.admin_check_keys(p_input,array['sourceId','leaseToken','senderIdentity','identityNamespace']);
 perform pg_advisory_xact_lock(1857,2026);
 -- The email adapter verifies same-tenant Internal provenance before this call;
 -- the existing lease is still required before even deciding to fetch a body.
 s:=eco_private.inbox_source(eco_private.inbox_uuid(p_input,'sourceId')); perform eco_private.inbox_fence(s,p_input);
 if s.channel<>'email' or eco_private.inbox_text(p_input,'identityNamespace',1,100)<>s.identity_namespace then raise exception 'Inbox source mismatch' using errcode='42501'; end if;
 sender:=eco_private.inbox_text(p_input,'senderIdentity',1,320);
 select * into route from eco_private.inbox_sender_resolution(s,sender);
 return jsonb_build_object('approved',route.reason is null);
end;$$;

create or replace function public.eco_ingest_enquiry(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s eco_private.inbox_sources; msg eco_private.inbox_messages; route record;
 fingerprint text; canonical jsonb; v_provider text; account text; destination text; message_id text; sender text; raw text; subject text; stamp text; received timestamptz; verified boolean; reason text; supplied_hash text; body_hash text;
begin
 perform eco_private.inbox_service();
 perform eco_private.admin_check_keys(p_input,array['sourceId','provider','accountId','destinationId','messageId','senderIdentity','identityNamespace','identityVerified','rawText','receivedAt','subject','leaseToken','quarantineReason','contentHash']);
 -- Serialize routing with account permission changes; source row lock also fences workers.
 perform pg_advisory_xact_lock(1857,2026);
 select null::uuid as owner_id,null::text as sender_display,null::text as reason into route;
 s:=eco_private.inbox_source(eco_private.inbox_uuid(p_input,'sourceId'));
 if s.channel='email' then perform eco_private.inbox_fence(s,p_input); elsif p_input ? 'leaseToken' then raise exception 'Invalid inbox lease' using errcode='22023'; end if;
 v_provider:=eco_private.inbox_text(p_input,'provider',1,100); account:=eco_private.inbox_text(p_input,'accountId',1,320); destination:=eco_private.inbox_text(p_input,'destinationId',1,320); message_id:=eco_private.inbox_text(p_input,'messageId',1,1024);
 if (v_provider,account,destination) is distinct from (s.provider,s.account_id,s.destination_id) or eco_private.inbox_text(p_input,'identityNamespace',1,100)<>s.identity_namespace then raise exception 'Inbox source mismatch' using errcode='42501'; end if;
 if jsonb_typeof(p_input->'identityVerified') is distinct from 'boolean' then raise exception 'Invalid inbox identity' using errcode='22023'; end if;
 verified:=(p_input->>'identityVerified')::boolean; sender:=eco_private.inbox_text(p_input,'senderIdentity',case when verified then 1 else 0 end,320);
 if jsonb_typeof(p_input->'rawText') is distinct from 'string' or octet_length(p_input->>'rawText')>20000 then raise exception 'Invalid inbox text' using errcode='22023'; end if;
 raw:=p_input->>'rawText';
 if regexp_replace(raw,E'[\n\r\t]','','g') ~ '[[:cntrl:]]' then raise exception 'Invalid inbox text' using errcode='22023'; end if;
 if p_input ? 'subject' then subject:=eco_private.inbox_text(p_input,'subject',0,1000); end if;
 if p_input ? 'quarantineReason' then
  reason:=eco_private.inbox_text(p_input,'quarantineReason',1,50);
  if reason not in ('unsupported_attachment','unsupported_body','oversized','malformed_message','message_unavailable') or raw<>'' or subject is not null then raise exception 'Invalid inbox quarantine' using errcode='22023'; end if;
 end if;
 if p_input ? 'contentHash' then supplied_hash:=eco_private.inbox_text(p_input,'contentHash',64,64); if supplied_hash !~ '^[0-9a-f]{64}$' then raise exception 'Invalid inbox content hash' using errcode='22023'; end if; end if;
 body_hash:=case when raw<>'' then encode(sha256(convert_to(raw,'UTF8')),'hex') else supplied_hash end;
 if raw<>'' and supplied_hash is not null and supplied_hash<>body_hash then raise exception 'Inbox content hash mismatch' using errcode='22023'; end if;
 stamp:=eco_private.inbox_text(p_input,'receivedAt',20,40);
 if stamp !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,7})?(Z|[+-][0-9]{2}:[0-9]{2})$' then raise exception 'Invalid inbox timestamp' using errcode='22023'; end if;
 begin received:=stamp::timestamptz; exception when invalid_datetime_format or datetime_field_overflow then raise exception 'Invalid inbox timestamp' using errcode='22023'; end;
 if not isfinite(received) then raise exception 'Invalid inbox timestamp' using errcode='22023'; end if;
 -- Stable original provider timestamp, never retry wall-clock time. Lease is deliberately excluded.
 canonical:=jsonb_build_object('source',s.id,'provider',v_provider,'account',account,'destination',destination,'messageId',message_id,'sender',sender,'namespace',s.identity_namespace,'verified',verified,'rawHash',body_hash,'subject',subject,'received',to_char(received at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'quarantineReason',reason);
 fingerprint:=encode(sha256(convert_to(canonical::text,'UTF8')),'hex');
 select * into msg from eco_private.inbox_messages where inbox_messages.provider=v_provider and account_id=account and destination_id=destination and provider_message_id=message_id;
 if found then
  if msg.fingerprint<>fingerprint then raise exception 'Inbox delivery conflict' using errcode='PT409'; end if;
  return jsonb_strip_nulls(jsonb_build_object('id',msg.id,'status',msg.status,'duplicate',true,'reason',msg.reason));
 end if;
 if reason is null then
  if received<s.cutover_at then reason:='before_cutover';
  elsif not verified then reason:='unverified_identity';
  else
   select * into route from eco_private.inbox_sender_resolution(s,sender);
   reason:=route.reason;
   if reason is null and trim(raw)='' then reason:='empty_message'; end if;
  end if;
 end if;
 insert into eco_private.inbox_messages(source_id,provider,account_id,destination_id,provider_message_id,fingerprint,content_hash,channel,sender_identity,sender_display,owner_id,status,reason,raw_text,subject,received_at)
 values(s.id,v_provider,account,destination,message_id,fingerprint,body_hash,s.channel,sender,case when reason is null then route.sender_display end,case when reason is null then route.owner_id end,case when reason is null then 'accepted' else 'quarantined' end,reason,case when reason is null then raw end,case when reason is null then subject end,received) returning * into msg;
 return jsonb_strip_nulls(jsonb_build_object('id',msg.id,'status',msg.status,'duplicate',false,'reason',msg.reason));
end;$$;

create or replace function public.eco_ingest_whatsapp_enquiry(p_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 s eco_private.inbox_sources; msg eco_private.inbox_messages; route record; reason text;
 v_provider text; account text; destination text; namespace text; message_id text; sender text;
 raw text; stamp text; received timestamptz; canonical jsonb; envelope_fingerprint text; body_hash text;
begin
 perform eco_private.inbox_service();
 perform eco_private.admin_check_keys(p_input,array['sourceId','provider','accountId','destinationId','messageId','senderIdentity','identityNamespace','rawText','receivedAt','quarantineReason']);
 if octet_length(p_input::text)>262144 then raise exception 'Invalid WhatsApp envelope' using errcode='22023'; end if;
 -- The existing permission-change lock also serializes delivery and its routing decision.
 perform pg_advisory_xact_lock(1857,2026);
 select null::uuid as owner_id,null::text as sender_display,null::text as reason into route;
 -- Lock bindings before its referenced source row, matching foreign-key insertion
 -- order. This also fences direct operator binding changes and ambiguous inserts.
 lock table eco_private.inbox_sender_bindings in share mode;
 s:=eco_private.inbox_source(eco_private.inbox_uuid(p_input,'sourceId'));
 v_provider:=eco_private.inbox_text(p_input,'provider',1,100);
 account:=eco_private.inbox_text(p_input,'accountId',1,320);
 destination:=eco_private.inbox_text(p_input,'destinationId',1,320);
 namespace:=eco_private.inbox_text(p_input,'identityNamespace',1,100);
 if s.channel<>'whatsapp' or v_provider<>'meta-whatsapp-cloud' or namespace<>'meta-whatsapp-signed-v1'
    or (v_provider,account,destination,namespace) is distinct from (s.provider,s.account_id,s.destination_id,s.identity_namespace)
 then raise exception 'WhatsApp source mismatch' using errcode='42501'; end if;
 message_id:=eco_private.inbox_text(p_input,'messageId',1,1024);
 sender:=eco_private.inbox_text(p_input,'senderIdentity',0,320);
 if sender<>'' and sender !~ '^[1-9][0-9]{6,14}$' then raise exception 'Invalid WhatsApp sender' using errcode='22023'; end if;
 if jsonb_typeof(p_input->'rawText') is distinct from 'string' then raise exception 'Invalid WhatsApp text' using errcode='22023'; end if;
 raw:=p_input->>'rawText';
 if p_input ? 'quarantineReason' then
  reason:=eco_private.inbox_text(p_input,'quarantineReason',1,50);
  if reason not in ('unsupported_attachment','unsupported_body','oversized','malformed_message') or raw<>''
  then raise exception 'Invalid WhatsApp quarantine' using errcode='22023'; end if;
 end if;
 if sender='' and reason is distinct from 'malformed_message' then raise exception 'Invalid WhatsApp sender' using errcode='22023'; end if;
 stamp:=eco_private.inbox_text(p_input,'receivedAt',20,40);
 if stamp !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,7})?(Z|[+-][0-9]{2}:[0-9]{2})$'
 then raise exception 'Invalid WhatsApp timestamp' using errcode='22023'; end if;
 begin received:=stamp::timestamptz;
 exception when invalid_datetime_format or datetime_field_overflow then raise exception 'Invalid WhatsApp timestamp' using errcode='22023'; end;
 if not isfinite(received) then raise exception 'Invalid WhatsApp timestamp' using errcode='22023'; end if;
 -- Quarantined receipts fingerprint identity/timestamp metadata only. Neither
 -- message content nor a digest of that content survives a rejected delivery.
 canonical:=jsonb_build_object('source',s.id,'provider',v_provider,'account',account,'destination',destination,
   'messageId',message_id,'sender',sender,'namespace',namespace,
   'received',to_char(received at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
 envelope_fingerprint:=encode(sha256(convert_to(canonical::text,'UTF8')),'hex');
 select * into msg from eco_private.inbox_messages
 where provider=v_provider and account_id=account and destination_id=destination and provider_message_id=message_id;
 if found then
  if msg.source_id<>s.id or msg.fingerprint<>envelope_fingerprint then raise exception 'Inbox delivery conflict' using errcode='PT409'; end if;
  if msg.status='accepted' and (reason is not null or msg.content_hash is distinct from encode(sha256(convert_to(raw,'UTF8')),'hex'))
  then raise exception 'Inbox delivery conflict' using errcode='PT409'; end if;
  -- Existing quarantined messages are never resurrected by a later binding or
  -- adapter change. Content changes cannot be compared because none was retained.
  return jsonb_strip_nulls(jsonb_build_object('id',msg.id,'status',msg.status,'duplicate',true,'reason',msg.reason));
 end if;
 if reason is null then
  if octet_length(raw)>20000 then reason:='oversized';
  elsif regexp_replace(raw,E'[\n\r\t]','','g') ~ '[[:cntrl:]]' then reason:='malformed_message';
  elsif received<s.cutover_at then reason:='before_cutover';
  else
   select * into route from eco_private.inbox_sender_resolution(s,sender);
   reason:=route.reason;
   if reason is null and btrim(raw,E' \n\r\t')='' then reason:='empty_message'; end if;
  end if;
 end if;
 if reason is null then body_hash:=encode(sha256(convert_to(raw,'UTF8')),'hex'); end if;
 insert into eco_private.inbox_messages(source_id,provider,account_id,destination_id,provider_message_id,fingerprint,content_hash,
   channel,sender_identity,sender_display,owner_id,status,reason,raw_text,subject,received_at)
 values(s.id,v_provider,account,destination,message_id,envelope_fingerprint,body_hash,'whatsapp',sender,
   case when reason is null then route.sender_display end,case when reason is null then route.owner_id end,
   case when reason is null then 'accepted' else 'quarantined' end,reason,case when reason is null then raw end,null,received)
 returning * into msg;
 return jsonb_strip_nulls(jsonb_build_object('id',msg.id,'status',msg.status,'duplicate',false,'reason',msg.reason));
end;$$;

-- Preserve browser-denied service-only boundaries and every existing email lease.
revoke all on function public.eco_resolve_inbox_sender(jsonb),public.eco_ingest_enquiry(jsonb),public.eco_ingest_whatsapp_enquiry(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.eco_resolve_inbox_sender(jsonb),public.eco_ingest_enquiry(jsonb),public.eco_ingest_whatsapp_enquiry(jsonb) to service_role;
insert into eco_private.platform_versions(component,migration_head) values('intake-directory-routing','20261020033852');


-- BOOTSTRAP SECTION 20261020075427_eco_commercial_enquiries.sql
-- ECO-owned commercial records. Queue intent is durable; no outbound dispatcher exists.
create table eco_private.commercial_enquiries (
 id uuid primary key, reference_number bigint generated always as identity unique,
 owner_id uuid not null, owner_name text not null, revision integer not null check(revision>0),
 status text not null check(status in ('draft','confirmed')), source jsonb not null, reviewed jsonb not null,
 inbox_id uuid unique, port jsonb, created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(), confirmed_at timestamptz,
 check((status='confirmed')=(confirmed_at is not null))
);
create index eco_commercial_owner_page on eco_private.commercial_enquiries(owner_id,created_at desc,id desc);
create table eco_private.commercial_enquiry_queue (
 enquiry_id uuid primary key references eco_private.commercial_enquiries(id) on delete cascade,
 centre text not null check(centre='singapore'), status text not null default 'awaiting_connection' check(status='awaiting_connection'),
 queued_by uuid not null, queued_at timestamptz not null default clock_timestamp()
);
create index eco_commercial_queue_page on eco_private.commercial_enquiry_queue(queued_at desc,enquiry_id desc);
create table eco_private.commercial_enquiry_mutations (
 actor_id uuid not null, request_id uuid not null, enquiry_id uuid not null references eco_private.commercial_enquiries(id) on delete cascade,
 input jsonb not null, result jsonb not null, created_at timestamptz not null default clock_timestamp(), primary key(actor_id,request_id)
);
create table eco_private.commercial_enquiry_history (
 id bigint generated always as identity primary key, enquiry_id uuid not null references eco_private.commercial_enquiries(id) on delete cascade,
 actor_id uuid not null, session_id uuid not null, revision integer not null, action text not null check(action in ('save','confirm')),
 details jsonb not null, occurred_at timestamptz not null default clock_timestamp(), unique(enquiry_id,revision)
);
alter table eco_private.commercial_enquiries enable row level security;
alter table eco_private.commercial_enquiry_queue enable row level security;
alter table eco_private.commercial_enquiry_mutations enable row level security;
alter table eco_private.commercial_enquiry_history enable row level security;
revoke all on eco_private.commercial_enquiries,eco_private.commercial_enquiry_queue,eco_private.commercial_enquiry_mutations,eco_private.commercial_enquiry_history from public,anon,authenticated,service_role;
revoke all on sequence eco_private.commercial_enquiries_reference_number_seq,eco_private.commercial_enquiry_history_id_seq from public,anon,authenticated,service_role;

create function eco_private.commercial_keys(p jsonb,keys text[]) returns void language plpgsql set search_path='' as $$
begin
 perform eco_private.admin_check_keys(p,keys);
 if not(p ?& keys) then raise exception 'Invalid enquiry fields' using errcode='22023';end if;
end;$$;
create function eco_private.commercial_text(p jsonb,k text,maximum integer,minimum integer default 0) returns text language plpgsql set search_path='' as $$
declare v text:=p->>k;
begin
 if jsonb_typeof(p->k) is distinct from 'string' or length(trim(v))<minimum or octet_length(v)>maximum or v ~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]' then raise exception 'Invalid enquiry text' using errcode='22023';end if;
 return v;
end;$$;
create function eco_private.commercial_validate(p jsonb) returns jsonb language plpgsql set search_path='' as $$
declare s jsonb:=p->'source';r jsonb:=p->'reviewed';item jsonb;port jsonb;k text;q text;parts text[];low numeric;high numeric;
begin
 perform eco_private.commercial_keys(p,array['dataMode','requestId','id','expectedRevision','action','source','reviewed']);
 perform eco_private.inbox_live(p);perform eco_private.inbox_uuid(p,'id');perform eco_private.inbox_uuid(p,'requestId');
 if octet_length(p::text)>131072 or jsonb_typeof(p->'expectedRevision') is distinct from 'number' or p->>'expectedRevision' !~ '^(0|[1-9][0-9]{0,9})$' or (p->>'expectedRevision')::numeric>2147483646 or jsonb_typeof(p->'action') is distinct from 'string' or p->>'action' not in ('save','confirm') then raise exception 'Invalid enquiry operation' using errcode='22023';end if;
 perform eco_private.commercial_keys(s,array['rawText','parsed','parserVersion','inboxId']);
 perform eco_private.commercial_text(s,'rawText',20000);
 if s->'inboxId'<>'null'::jsonb then perform eco_private.inbox_uuid(s,'inboxId');end if;
 if s->'parserVersion'<>'null'::jsonb then perform eco_private.commercial_text(s,'parserVersion',128,1);end if;
 if s->'parsed'<>'null'::jsonb then
  perform eco_private.parser_check_snapshot(s->'parsed');
  perform eco_private.commercial_text(s->'parsed','standardText',20000);
  foreach k in array array['vessel','imo','buyerText','portText','eta','hsfo','vlsfo','lsmgo','remarks'] loop
   perform eco_private.commercial_text(s#>'{parsed,fields}',k,case when k='remarks' then 3000 else 500 end);
  end loop;
  for item in select value from jsonb_array_elements(s#>'{parsed,warnings}') loop perform eco_private.commercial_text(jsonb_build_object('text',item),'text',2000);end loop;
 end if;
 perform eco_private.commercial_keys(r,array['vessel','imo','eta','portId','buyerText','buyerId','products','remarks','rmk','viscosity','formattedText','warnings']);
 perform eco_private.commercial_text(r,'vessel',500);perform eco_private.commercial_text(r,'imo',50);perform eco_private.commercial_text(r,'eta',500);
 perform eco_private.commercial_text(r,'remarks',3000);perform eco_private.commercial_text(r,'formattedText',20000);
 if r->'buyerId'<>'null'::jsonb then raise exception 'Buyer master is not connected' using errcode='22023';end if;
 if r->'buyerText'<>'null'::jsonb then perform eco_private.commercial_text(r,'buyerText',500);end if;
 if r->'portId'<>'null'::jsonb then
  port:=eco_private.supplier_port(eco_private.commercial_text(r,'portId',100,1));
  if port is null then raise exception 'Unknown canonical port' using errcode='22023';end if;
 end if;
 if jsonb_typeof(r->'rmk') is distinct from 'boolean' or jsonb_typeof(r->'viscosity') is distinct from 'array' or jsonb_typeof(r->'products') is distinct from 'array' or jsonb_typeof(r->'warnings') is distinct from 'array' then raise exception 'Invalid enquiry fields' using errcode='22023';end if;
 if jsonb_array_length(r->'viscosity')>4 or jsonb_array_length(r->'warnings')>100 or jsonb_array_length(r->'products')>3 then raise exception 'Invalid enquiry arrays' using errcode='22023';end if;
 for item in select value from jsonb_array_elements(r->'viscosity') loop
  if jsonb_typeof(item)<>'string' or item#>>'{}' not in ('80cst min','80cst max','120cst max','180cst max') then raise exception 'Invalid viscosity' using errcode='22023';end if;
 end loop;
 if (select count(*)<>count(distinct value) from jsonb_array_elements(r->'viscosity')) then raise exception 'Duplicate viscosity' using errcode='22023';end if;
 for item in select value from jsonb_array_elements(r->'warnings') loop perform eco_private.commercial_text(jsonb_build_object('text',item),'text',2000);end loop;
 for item in select value from jsonb_array_elements(r->'products') loop
  perform eco_private.commercial_keys(item,array['grade','quantityText']);
  if eco_private.commercial_text(item,'grade',10,1) not in ('HSFO','VLSFO','LSMGO') then raise exception 'Invalid grade' using errcode='22023';end if;
  -- Match JavaScript trim/\s for validation; retain the exact submitted quantity text.
  q:=trim(translate(eco_private.commercial_text(item,'quantityText',100),U&'\0009\000A\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF',repeat(' ',23)));
  if p->>'action'='confirm' then
   parts:=regexp_match(translate(q,'–—−','---'),'^((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]+)?)(?:[[:space:]]*(?:-|~|to|/)[[:space:]]*((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]+)?))?[[:space:]]*(?:MT|MTS|metric[[:space:]]+tonnes?)?$','i');
   if parts is null then raise exception 'Invalid quantity' using errcode='22023';end if;
   low:=replace(parts[1],',','')::numeric;high:=coalesce(replace(parts[2],',','')::numeric,low);
   if low<=0 or high<low or high>1000000 then raise exception 'Invalid quantity' using errcode='22023';end if;
  end if;
 end loop;
 if (select count(*)<>count(distinct value->>'grade') from jsonb_array_elements(r->'products')) then raise exception 'Duplicate grade' using errcode='22023';end if;
 if p->>'action'='confirm' then
  if port is null or length(trim(r->>'vessel'))=0 or length(trim(r->>'eta'))=0 or length(trim(r->>'formattedText'))=0 or jsonb_array_length(r->'products')=0 or (r->>'imo'<>'' and r->>'imo' !~ '^[0-9]{7}$') then raise exception 'Complete the enquiry before confirmation' using errcode='22023';end if;
 end if;
 return port;
end;$$;

create function eco_private.commercial_immutable() returns trigger language plpgsql set search_path='' as $$
begin
 if old.id<>new.id or old.owner_id<>new.owner_id or old.owner_name<>new.owner_name or old.source<>new.source or old.inbox_id is distinct from new.inbox_id or old.created_at<>new.created_at or old.reference_number<>new.reference_number or old.status='confirmed' then raise exception 'Enquiry source or confirmed record is immutable' using errcode='PT409';end if;
 return new;
end;$$;
create trigger commercial_source_immutable before update on eco_private.commercial_enquiries for each row execute function eco_private.commercial_immutable();
create function eco_private.commercial_summary(r eco_private.commercial_enquiries) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',r.id,'reference','ECO-'||lpad(r.reference_number::text,greatest(8,length(r.reference_number::text)),'0'),'ownerId',r.owner_id,'ownerName',r.owner_name,'revision',r.revision,'status',r.status,
  'vessel',r.reviewed->'vessel','imo',r.reviewed->'imo','eta',r.reviewed->'eta','products',r.reviewed->'products','port',r.port,
  'queue',(select jsonb_build_object('status',q.status,'queuedAt',q.queued_at) from eco_private.commercial_enquiry_queue q where q.enquiry_id=r.id),
  'createdAt',r.created_at,'updatedAt',r.updated_at,'confirmedAt',r.confirmed_at);
$$;
create function eco_private.commercial_detail(r eco_private.commercial_enquiries) returns jsonb language sql stable set search_path='' as $$
 select eco_private.commercial_summary(r)||jsonb_build_object('source',r.source,'reviewed',r.reviewed);
$$;
create function public.eco_mutate_commercial_enquiry(p_input jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor eco_private.users;eid uuid;rid uuid;expected integer;row eco_private.commercial_enquiries;prior eco_private.commercial_enquiry_mutations;v_port jsonb;inbox uuid;result jsonb;details jsonb;
begin
 -- Existing account/preview lock serializes retries and privilege changes as one short transaction.
 actor:=eco_private.admin_writable_member();v_port:=eco_private.commercial_validate(p_input);
 eid:=(p_input->>'id')::uuid;rid:=(p_input->>'requestId')::uuid;expected:=(p_input->>'expectedRevision')::integer;
 select * into prior from eco_private.commercial_enquiry_mutations where actor_id=actor.id and request_id=rid;
 if found then if prior.input<>p_input then raise exception 'Request payload conflict' using errcode='PT409';end if;return prior.result;end if;
 select * into row from eco_private.commercial_enquiries where id=eid for update;
 if found then
  if row.owner_id<>actor.id then raise exception 'Record not found' using errcode='PT404';end if;
  if row.revision<>expected or row.status<>'draft' then raise exception 'Enquiry revision conflict' using errcode='PT409';end if;
  if row.source<>p_input->'source' then raise exception 'Original enquiry source cannot change' using errcode='PT409';end if;
  update eco_private.commercial_enquiries set reviewed=p_input->'reviewed',port=v_port,revision=revision+1,status=case when p_input->>'action'='confirm' then 'confirmed' else 'draft' end,
   updated_at=clock_timestamp(),confirmed_at=case when p_input->>'action'='confirm' then clock_timestamp() end where id=eid returning * into row;
 else
  if expected<>0 then raise exception 'Enquiry revision conflict' using errcode='PT409';end if;
  inbox:=(p_input#>>'{source,inboxId}')::uuid;
  if inbox is not null then
   if not exists(select 1 from eco_private.inbox_messages where id=inbox and owner_id=actor.id and status='accepted' and raw_text=p_input#>>'{source,rawText}') then raise exception 'Owned inbox source required' using errcode='42501';end if;
   if exists(select 1 from eco_private.commercial_enquiries where inbox_id=inbox) then raise exception 'Inbox enquiry already exists' using errcode='PT409';end if;
  end if;
  insert into eco_private.commercial_enquiries(id,owner_id,owner_name,revision,status,source,reviewed,inbox_id,port,confirmed_at)
  values(eid,actor.id,actor.display_name,1,case when p_input->>'action'='confirm' then 'confirmed' else 'draft' end,p_input->'source',p_input->'reviewed',inbox,v_port,case when p_input->>'action'='confirm' then clock_timestamp() end) returning * into row;
 end if;
 if row.status='confirmed' and row.port->>'countryCode'='SG' then
  insert into eco_private.commercial_enquiry_queue(enquiry_id,centre,queued_by) values(row.id,'singapore',actor.id);
 end if;
 details:=jsonb_build_object('revision',row.revision,'status',row.status,'portId',row.port->'id','queued',row.status='confirmed' and coalesce(row.port->>'countryCode'='SG',false));
 insert into eco_private.commercial_enquiry_history(enquiry_id,actor_id,session_id,revision,action,details) values(row.id,actor.id,(auth.jwt()->>'session_id')::uuid,row.revision,p_input->>'action',details);
 insert into eco_private.administration_events(actor_id,actor_name,target_id,action,details) values(actor.id,actor.display_name,row.id,case when p_input->>'action'='confirm' then 'commercial-enquiry-confirmed' else 'commercial-enquiry-saved' end,details);
 result:=jsonb_build_object('requestId',rid,'item',eco_private.commercial_detail(row));
 insert into eco_private.commercial_enquiry_mutations(actor_id,request_id,enquiry_id,input,result) values(actor.id,rid,row.id,p_input,result);
 return result;
end;$$;

create function public.eco_get_commercial_enquiries(p_query jsonb) returns jsonb language plpgsql stable security definer set search_path='' as $$
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
 if scope not in ('mine','singapore') then raise exception 'Invalid scope' using errcode='22023';end if;
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
   ((scope='mine' and r.owner_id=actor.id) or (scope='singapore' and r.status='confirmed' and exists(select 1 from eco_private.commercial_enquiry_queue q where q.enquiry_id=r.id)))
   and (ct is null or (r.created_at,r.id)<(ct,cid)) order by r.created_at desc,r.id desc limit n+1
 ), page as (select * from candidates order by created_at desc,id desc limit n)
 select (select coalesce(jsonb_agg(eco_private.commercial_summary(p) order by p.created_at desc,p.id desc),'[]'::jsonb) from page p),
  case when (select count(*) from candidates)>n then (select created_at::text||'|'||id::text from page order by created_at,id limit 1) end into items,next_cursor;
 return jsonb_build_object('items',items,'nextCursor',next_cursor);
end;$$;
revoke all on function eco_private.commercial_keys(jsonb,text[]),eco_private.commercial_text(jsonb,text,integer,integer),eco_private.commercial_validate(jsonb),eco_private.commercial_immutable(),eco_private.commercial_summary(eco_private.commercial_enquiries),eco_private.commercial_detail(eco_private.commercial_enquiries) from public,anon,authenticated,service_role;
revoke all on function public.eco_get_commercial_enquiries(jsonb),public.eco_mutate_commercial_enquiry(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.eco_get_commercial_enquiries(jsonb),public.eco_mutate_commercial_enquiry(jsonb) to authenticated;
insert into eco_private.platform_versions(component,migration_head) values('commercial-enquiries','20261020075427');
