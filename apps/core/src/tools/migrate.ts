import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { loadConfig } from "../config.js";

const config = loadConfig();
if (config.databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required to run migrations");
}

const pool = new Pool({
  application_name: "akep-migrator",
  connectionString: config.databaseUrl,
  max: 1,
});
const client = await pool.connect();

try {
  await client.query("select pg_advisory_lock(hashtext('akep-schema-migrations'))");
  await client.query("create schema if not exists platform");
  await client.query(
    `create table if not exists platform.schema_migration (
       migration_name text primary key,
       sha256 text not null,
       applied_at timestamptz not null default clock_timestamp(),
       check (sha256 ~ '^[a-f0-9]{64}$')
     )`,
  );

  const directory = join(config.contractRoot, "../../../infra/postgres/migrations");
  const files = readdirSync(directory)
    .filter((file) => /^[0-9]{3}_[a-z0-9_]+\.sql$/.test(file))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(directory, file), "utf8");
    const digest = createHash("sha256").update(sql).digest("hex");
    const existing = await client.query<{ readonly sha256: string }>(
      "select sha256 from platform.schema_migration where migration_name = $1",
      [file],
    );
    if (existing.rows[0] !== undefined) {
      if (existing.rows[0].sha256 !== digest) {
        throw new Error(`Applied migration ${file} has been modified`);
      }
      continue;
    }
    await client.query(sql);
    await client.query(
      `insert into platform.schema_migration (migration_name, sha256)
       values ($1, $2)`,
      [file, digest],
    );
    process.stdout.write(`applied ${file}\n`);
  }
} finally {
  try {
    await client.query("select pg_advisory_unlock(hashtext('akep-schema-migrations'))");
  } finally {
    client.release();
    await pool.end();
  }
}
