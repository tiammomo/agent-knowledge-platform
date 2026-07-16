import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";

export interface Database {
  readonly pool: Pool;
  close(): Promise<void>;
  ready(): Promise<boolean>;
}

export function createDatabase(
  connectionString: string,
  migrationDirectory: string,
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
             as ready`,
        );
        return result.rows[0]?.ready === true;
      } catch {
        return false;
      }
    },
  };
}
