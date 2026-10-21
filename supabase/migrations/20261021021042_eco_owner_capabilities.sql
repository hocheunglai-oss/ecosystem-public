-- Provision the existing owner UUID privately after applying this migration.
-- No account, email pattern, JWT metadata or browser payload is an ownership grant.
create table eco_private.owner_capabilities (
 singleton boolean primary key default true check(singleton),
 owner_id uuid not null references eco_private.users(id) on delete cascade,
 appearance_preview boolean not null default false,
 test_workspace boolean not null default false
);
alter table eco_private.owner_capabilities enable row level security;
revoke all on eco_private.owner_capabilities from public,anon,authenticated,service_role;

-- Callers already verified the current member/session. Keep this helper private,
-- and hold a row share lock until the protected operation commits so an operator
-- revocation cannot race a running TEST write or AI completion.
create function eco_private.member_owner_capabilities(p_member eco_private.users) returns jsonb
language plpgsql set search_path='' as $$
declare c eco_private.owner_capabilities;
begin
 if p_member.id is null or not coalesce(p_member.is_active,false) or not coalesce(p_member.is_admin,false)
    or p_member.activated_at is null then
  return jsonb_build_object('appearancePreview',false,'testWorkspace',false);
 end if;
 select * into c from eco_private.owner_capabilities where singleton and owner_id=p_member.id for share;
 return jsonb_build_object('appearancePreview',coalesce(c.appearance_preview,false),'testWorkspace',coalesce(c.test_workspace,false));
end;$$;
revoke all on function eco_private.member_owner_capabilities(eco_private.users) from public,anon,authenticated,service_role;

-- Capabilities are intentionally omitted from general directory/audit profiles.
create or replace function eco_private.current_user_json() returns jsonb
language plpgsql security definer set search_path='' as $$
declare m eco_private.users;
begin
 m:=eco_private.current_member();
 return eco_private.present_user(m)||jsonb_build_object('capabilities',eco_private.member_owner_capabilities(m));
end;$$;

create or replace function eco_private.parser_scope(p_member eco_private.users,p_input jsonb) returns uuid
language plpgsql set search_path='' as $$
declare policy eco_private.test_workspace_policy;
begin
 if p_input->>'dataMode' not in ('live','test') or p_input->>'dataMode' is null then raise exception 'Invalid data mode' using errcode='22023'; end if;
 if p_input->>'dataMode'='live' then
  if p_input ? 'generation' and p_input->'generation'<>'null'::jsonb then raise exception 'Invalid generation' using errcode='22023'; end if;
  return null;
 end if;
 if not (eco_private.member_owner_capabilities(p_member)->>'testWorkspace')::boolean then raise exception 'Forbidden' using errcode='42501'; end if;
 select * into policy from eco_private.test_workspace_policy where singleton for share;
 if not coalesce(policy.enabled,false) or p_input->>'generation' is distinct from policy.generation::text then raise exception 'Test workspace expired' using errcode='42501'; end if;
 return policy.generation;
end;$$;
revoke all on function eco_private.parser_scope(eco_private.users,jsonb) from public,anon,authenticated,service_role;

create or replace function public.eco_test_workspace_policy() returns jsonb
language plpgsql security definer set search_path='' as $$
declare m eco_private.users; p eco_private.test_workspace_policy;
begin
 m:=eco_private.current_member();
 if not (eco_private.member_owner_capabilities(m)->>'testWorkspace')::boolean then
  return jsonb_build_object('enabled',false,'generation','');
 end if;
 select * into p from eco_private.test_workspace_policy where singleton;
 return jsonb_build_object('enabled',coalesce(p.enabled,false),'generation',coalesce(p.generation::text,''));
end;$$;
revoke all on function public.eco_test_workspace_policy() from public,anon,authenticated,service_role;
grant execute on function public.eco_test_workspace_policy() to authenticated;
insert into eco_private.platform_versions(component,migration_head) values('owner-capabilities','20261021021042');
