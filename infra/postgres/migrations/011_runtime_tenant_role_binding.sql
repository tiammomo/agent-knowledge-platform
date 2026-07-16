begin;

create table platform.tenant_runtime_role (
  database_role name primary key,
  tenant_id text not null check (length(tenant_id) > 0),
  bound_at timestamptz not null default clock_timestamp()
);

revoke all on platform.tenant_runtime_role from public;

create or replace function platform.current_tenant_id()
returns text
language sql
stable
security definer
parallel safe
set search_path = pg_catalog, platform
as $$
  select binding.tenant_id
    from platform.tenant_runtime_role binding
   where binding.database_role = session_user
     and binding.tenant_id = nullif(current_setting('akep.tenant_id', true), '')
$$;

revoke all on function platform.current_tenant_id() from public;

comment on table platform.tenant_runtime_role is
  'Owner-managed binding that prevents a runtime database login from selecting another tenant.';
comment on function platform.current_tenant_id() is
  'Returns the tenant only when the session setting matches the owner-managed login-role binding.';

commit;
