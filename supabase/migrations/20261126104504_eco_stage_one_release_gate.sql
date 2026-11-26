-- Synthetic data and Stage 2 buyer profiles are enabled only by the isolated
-- staging bootstrap. Keep existing records and namespace generations intact.
alter table eco_private.test_workspace_policy alter column enabled set default false;
update eco_private.test_workspace_policy set enabled=false,updated_at=now() where enabled;

create or replace function eco_private.profile_target_check(p_target jsonb) returns void
language plpgsql set search_path='' as $$
declare
 member eco_private.users;
begin
 perform eco_private.admin_check_keys(p_target,array['kind','id']);
 perform eco_private.admin_check_text(p_target,'id',1,160);
 if p_target->>'kind' is null or p_target->>'kind' not in ('supplier','buyer','country','port')
   or (p_target->>'kind'<>'country' and p_target->>'id' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$')
   or p_target->>'id' ~ '[\x01-\x1F\x7F]' then
   raise exception 'Invalid profile target' using errcode='22023';
 end if;
 if p_target->>'kind'='buyer' then
   member:=eco_private.require_admin();
   if not (eco_private.member_owner_capabilities(member)->>'testWorkspace')::boolean
     or exists(select 1 from eco_private.role_previews where session_id::text=auth.jwt()->>'session_id' and user_id=auth.uid())
     or not exists(select 1 from eco_private.test_workspace_policy where singleton and enabled for share) then
     raise exception 'UNDER CONSTRUCTION: TO BE RELEASED WITH ECO 2.0' using errcode='42501';
   end if;
 end if;
 if p_target->>'kind'='supplier' then
   perform eco_private.supplier_uuid(p_target->'id');
   if not exists(select 1 from eco_private.suppliers where id=(p_target->>'id')::uuid and archived_at is null) then
     raise exception 'Unknown supplier' using errcode='22023';
   end if;
 end if;
end;$$;

update eco_private.platform_versions set migration_head='20261126104504'
where component in ('release-gates','parser-test-workspace');
