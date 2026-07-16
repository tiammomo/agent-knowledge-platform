import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";

export interface Database {
  readonly pool: Pool;
  close(): Promise<void>;
  ready(): Promise<boolean>;
}

export interface DatabaseSecurityOptions {
  readonly requireRestrictedRole: boolean;
  readonly tenantId: string;
}

const TENANT_RELATIONS = [
  ["catalog", "content_blob"],
  ["catalog", "record"],
  ["catalog", "revision"],
  ["catalog", "revision_blob"],
  ["contribution", "mutation_idempotency"],
  ["contribution", "workflow"],
  ["evaluation", "attestation"],
  ["evaluation", "evaluation_run"],
  ["evaluation", "feedback_evidence"],
  ["governance", "channel"],
  ["governance", "lifecycle_event"],
  ["governance", "revision_status"],
  ["platform", "outbox_event"],
  ["query", "chunk_projection"],
  ["query", "exposure_receipt"],
  ["query", "knowledge_projection"],
  ["query", "usage_receipt"],
] as const;

export function createDatabase(
  connectionString: string,
  migrationDirectory: string,
  security: DatabaseSecurityOptions,
): Database {
  const expectedMigrations = readdirSync(migrationDirectory)
    .filter((file) => /^[0-9]{3}_[a-z0-9_]+\.sql$/u.test(file))
    .sort()
    .map((name) => ({
      name,
      sha256: createHash("sha256")
        .update(readFileSync(join(migrationDirectory, name)))
        .digest("hex"),
    }));
  const pool = new Pool({
    application_name: "akep-core",
    connectionString,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
    max: 10,
    options: tenantSessionOptions(security.tenantId),
  });

  return {
    pool,
    async close(): Promise<void> {
      await pool.end();
    },
    async ready(): Promise<boolean> {
      try {
        const migrations = await pool.query<{
          readonly migration_name: string;
          readonly sha256: string;
        }>(
          `select migration_name, sha256
             from platform.schema_migration
            order by migration_name`,
        );
        if (
          migrations.rows.length !== expectedMigrations.length ||
          expectedMigrations.some((expected, index) => {
            const applied = migrations.rows[index];
            return applied?.migration_name !== expected.name ||
              applied.sha256 !== expected.sha256;
          })
        ) {
          return false;
        }
        const result = await pool.query<{ readonly ready: boolean }>(
          `select
             to_regclass('catalog.revision') is not null
             and to_regclass('contribution.workflow') is not null
             and to_regclass('platform.tenant_runtime_role') is not null
             and to_regclass('query.exposure_receipt') is not null
             and to_regclass('query.knowledge_projection') is not null
             and to_regclass('evaluation.feedback_evidence') is not null
             and to_regclass('evaluation.attestation') is not null
             and to_regclass('evaluation.evaluation_run') is not null
             and to_regclass('contribution.mutation_idempotency') is not null
             and to_regclass('query.knowledge_projection_one_published_record_idx') is not null
             and to_regclass('evaluation.feedback_evidence_one_per_usage') is not null
             and exists (select 1 from pg_extension where extname = 'pg_trgm')
             and exists (
               select 1 from information_schema.columns
                where table_schema = 'query' and table_name = 'chunk_projection'
                  and column_name = 'chunker_fingerprint'
             )
             and exists (
               select 1 from pg_trigger
                where tgname = 'usage_evidence_outbox' and not tgisinternal
             )
             and exists (
               select 1 from pg_trigger
                where tgname = 'feedback_evidence_outbox' and not tgisinternal
             )
             and current_setting('akep.tenant_id', true) = $1
             and (not $2::boolean or platform.current_tenant_id() = $1)
             and (
               select count(*) = $3
                 from pg_class relation
                 join pg_namespace namespace on namespace.oid = relation.relnamespace
                where (namespace.nspname, relation.relname) in (
                  select item->>0, item->>1
                    from jsonb_array_elements($4::jsonb) item
                )
                  and relation.relrowsecurity
                  and relation.relforcerowsecurity
             )
             and (
               select count(*) = $3
                 from pg_policies
                where (schemaname, tablename) in (
                  select item->>0, item->>1
                    from jsonb_array_elements($4::jsonb) item
                )
                  and policyname = 'tenant_isolation'
             )
             and (
               not $2::boolean
               or (
                 coalesce((
                   select not role.rolsuper and not role.rolbypassrls
                     from pg_roles role where role.rolname = current_user
                 ), false)
                 and not exists (
                   select 1
                     from pg_class relation
                     join pg_namespace namespace on namespace.oid = relation.relnamespace
                    where (namespace.nspname, relation.relname) in (
                      select item->>0, item->>1
                        from jsonb_array_elements($4::jsonb) item
                    )
                      and pg_get_userbyid(relation.relowner) = current_user
                 )
               )
             )
             as ready`,
          [
            security.tenantId,
            security.requireRestrictedRole,
            TENANT_RELATIONS.length,
            JSON.stringify(TENANT_RELATIONS),
          ],
        );
        return result.rows[0]?.ready === true;
      } catch {
        return false;
      }
    },
  };
}

export function tenantSessionOptions(tenantId: string): string {
  if (tenantId.length === 0 || /[\s\\]/u.test(tenantId)) {
    throw new Error("AKEP tenant ID cannot be encoded as a PostgreSQL session option");
  }
  return `-c akep.tenant_id=${tenantId}`;
}
