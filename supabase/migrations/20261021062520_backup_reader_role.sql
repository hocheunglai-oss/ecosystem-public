-- Dedicated complete-source recovery principal, explicitly approved for the cloud runner.
-- Supabase's customer role cannot delegate managed Auth/Storage table permissions.
-- pg_read_all_data therefore grants the intended complete read scope, including
-- application authentication data and PostgreSQL authentication/catalog metadata.
-- It is NOT a narrow application-only credential. Protect it outside public source.
-- This migration stages NOLOGIN only: private activation supplies the password.
-- Read-only defaults are defence in depth; effective ACLs prohibit application writes.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'eco_backup_reader') then
    raise exception 'Backup reader already exists; inspect its provenance before migration';
  end if;
  create role eco_backup_reader nologin inherit nosuperuser nocreatedb nocreaterole
    noreplication bypassrls connection limit 4;
end $$;
grant pg_read_all_data to eco_backup_reader with admin false, inherit true, set false;
alter role eco_backup_reader set default_transaction_read_only = on;
alter role eco_backup_reader set statement_timeout = '120s';
alter role eco_backup_reader set idle_in_transaction_session_timeout = '25min';
alter role eco_backup_reader set search_path = pg_catalog;

do $$
declare
  source_oid oid;
begin
  select oid into strict source_oid from pg_roles where rolname='eco_backup_reader';
  if not exists (
    select 1 from pg_roles r where r.oid=source_oid and not r.rolcanlogin
      and not r.rolsuper and not r.rolcreatedb and not r.rolcreaterole
      and not r.rolreplication and r.rolinherit and r.rolbypassrls
  ) then
    raise exception 'Recovery role attributes are not isolated';
  end if;
  if (select count(*) from pg_auth_members where member=source_oid) <> 1
    or not exists (
      select 1 from pg_auth_members m join pg_roles r on r.oid=m.roleid
      where m.member=source_oid and r.rolname='pg_read_all_data'
        and not m.admin_option and m.inherit_option and not m.set_option
    ) then
    raise exception 'Recovery role membership is not the approved complete-read grant';
  end if;
  if has_database_privilege(source_oid,current_database(),'CREATE')
    or exists (select 1 from pg_namespace n where n.nspname not like 'pg_%'
      and n.nspname<>'information_schema' and has_schema_privilege(source_oid,n.oid,'CREATE'))
    -- pg_settings has PostgreSQL's default PUBLIC UPDATE for this session's
    -- configurable settings. It is not permission to update application/catalog rows.
    or exists (select 1 from pg_class c
      where c.oid<>'pg_catalog.pg_settings'::regclass
        and case when c.relkind in ('r','p','v','m','f')
          then has_table_privilege(source_oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') else false end)
    or exists (select 1 from pg_class c
      where case when c.relkind='S' then has_sequence_privilege(source_oid,c.oid,'USAGE,UPDATE') else false end) then
    raise exception 'Recovery role inherits persistent application write privileges';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname not like 'pg_%' and n.nspname<>'information_schema'
      and p.prosecdef and has_function_privilege(source_oid,p.oid,'EXECUTE')) then
    raise exception 'Recovery role can execute a non-system security-definer routine';
  end if;
  if exists (select 1 from pg_class where relowner=source_oid)
    or exists (select 1 from pg_namespace where nspowner=source_oid)
    or exists (select 1 from pg_proc where proowner=source_oid)
    or exists (select 1 from pg_type where typowner=source_oid)
    or exists (select 1 from pg_database where datdba=source_oid)
    or exists (select 1 from pg_extension where extowner=source_oid) then
    raise exception 'Recovery role must not own database objects';
  end if;
end $$;
comment on role eco_backup_reader is 'Approved complete-source read principal including authentication/catalog metadata; dormant NOLOGIN until private cloud-runner activation';
insert into eco_private.platform_versions(component,migration_head)
values('backup-reader','20261021062520');
