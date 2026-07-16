select extname from pg_extension where extname in ('pgcrypto', 'vector') order by extname;

select schemaname, tablename
from pg_tables
where schemaname in ('catalog', 'contribution', 'evaluation', 'governance', 'platform', 'query')
order by schemaname, tablename;

with tenant_relation(schemaname, tablename) as (
  values
    ('catalog', 'content_blob'),
    ('catalog', 'record'),
    ('catalog', 'revision'),
    ('catalog', 'revision_blob'),
    ('contribution', 'mutation_idempotency'),
    ('contribution', 'workflow'),
    ('evaluation', 'attestation'),
    ('evaluation', 'evaluation_run'),
    ('evaluation', 'feedback_evidence'),
    ('governance', 'channel'),
    ('governance', 'lifecycle_event'),
    ('governance', 'revision_status'),
    ('platform', 'outbox_event'),
    ('query', 'chunk_projection'),
    ('query', 'exposure_receipt'),
    ('query', 'knowledge_projection'),
    ('query', 'usage_receipt')
)
select tenant_relation.schemaname,
       tenant_relation.tablename,
       column_name is not null as has_tenant_id,
       relation.relrowsecurity as rls_enabled,
       relation.relforcerowsecurity as rls_forced,
       policy.policyname = 'tenant_isolation' as tenant_policy
  from tenant_relation
  join pg_namespace namespace
    on namespace.nspname = tenant_relation.schemaname
  join pg_class relation
    on relation.relnamespace = namespace.oid
   and relation.relname = tenant_relation.tablename
  left join information_schema.columns column_definition
    on column_definition.table_schema = tenant_relation.schemaname
   and column_definition.table_name = tenant_relation.tablename
   and column_definition.column_name = 'tenant_id'
  left join pg_policies policy
    on policy.schemaname = tenant_relation.schemaname
   and policy.tablename = tenant_relation.tablename
   and policy.policyname = 'tenant_isolation'
 order by tenant_relation.schemaname, tenant_relation.tablename;

select current_user as database_role,
       current_setting('akep.tenant_id', true) as requested_tenant,
       platform.current_tenant_id() as effective_tenant,
       role.rolsuper as is_superuser,
       role.rolbypassrls as bypasses_rls
  from pg_roles role
 where role.rolname = current_user;
