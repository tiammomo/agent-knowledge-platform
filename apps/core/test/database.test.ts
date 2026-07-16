import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { buildApplication } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import {
  PostgresGrowthStore,
  type WorkflowMutationRecord,
} from "../src/modules/growth/store.js";
import type {
  ContributionState,
  PublishedAsset,
} from "../src/modules/growth/types.js";
import { createDatabase, type Database } from "../src/platform/database.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(databaseUrl === undefined);

function requireDatabaseUrl(): string {
  if (databaseUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required for database integration tests");
  }
  return databaseUrl;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function publicationFixture(
  config: ReturnType<typeof loadConfig>,
  spaceId: string,
  recordId: string,
  ordinal: number,
): {
  readonly asset: PublishedAsset;
  readonly contribution: ContributionState;
  readonly mutation: WorkflowMutationRecord;
  readonly next: ContributionState;
} {
  const nonce = randomUUID();
  const now = new Date().toISOString();
  const contributionId = `urn:uuid:${randomUUID()}`;
  const revisionId = `urn:akep:${digest(`revision-${ordinal}-${nonce}`)}`;
  const subjectDigest = digest(`subject-${ordinal}-${nonce}`);
  const manifest: PublishedAsset["manifest"] = {
    assetType: "document",
    critical: [],
    payloads: [],
    policy: {},
    profile: {
      digest: digest("database-test-profile"),
      uri: "https://knowledge.test/profiles/database-test/1",
    },
    provenance: { sources: [] },
    recordId,
    title: `Concurrent publication ${ordinal}`,
  };
  const contribution: ContributionState = {
    amendments: [],
    createdAt: now,
    idempotencyKey: `create-${nonce}`,
    payloads: [],
    receipt: {
      contributionId,
      createdAt: now,
      kind: "create",
      policyEpoch: config.policyEpoch,
      spaceId,
      status: "verified",
      statusUrl: `${config.baseUrl}/contributions/${encodeURIComponent(contributionId)}`,
      subjectRevisionId: revisionId,
      submittedRevisionId: revisionId,
    },
    request: {
      akepVersion: "0.1",
      clientSubmissionId: `submission-${nonce}`,
      critical: [],
      evidenceRefs: [],
      extensions: {},
      kind: "create",
      manifest,
      rationale: "Exercise the PostgreSQL publication concurrency invariant.",
      revisionId,
      spaceId,
    },
    requestDigest: digest(`request-${ordinal}-${nonce}`),
    subjectDigest,
    updatedAt: now,
    workflowVersion: 1,
  };
  const next: ContributionState = {
    ...contribution,
    receipt: {
      ...contribution.receipt,
      status: "accepted",
      updatedAt: now,
    },
    updatedAt: now,
    workflowVersion: 2,
  };
  const publicationEvent: PublishedAsset["publicationEvent"] = {
    actor: "urn:akep:principal:database-test-publisher",
    attestationRefs: [],
    channel: "published",
    critical: [],
    eventId: `urn:uuid:${randomUUID()}`,
    eventType: "channel.updated",
    eventVersion: "0.1",
    occurredAt: now,
    policyEpoch: config.policyEpoch,
    policyVersion: {
      digest: digest("database-test-policy"),
      uri: "https://knowledge.test/policies/database-test/1",
    },
    reason: "Publish a candidate during a concurrency test.",
    recordId,
    revisionId,
    spaceId,
    trustDomain: config.trustDomain,
  };
  const asset: PublishedAsset = {
    indexedAt: now,
    manifest,
    payloads: [],
    publicationEvent,
    qualityAttestationRefs: [],
    qualityDecision: "suitable",
    qualityReasons: ["Database concurrency invariant test."],
    revisionId,
    sourceContributionId: contributionId,
    spaceId,
    status: "published",
  };
  const mutation: WorkflowMutationRecord = {
    createdAt: now,
    expiresAt: new Date(Date.parse(now) + 86_400_000).toISOString(),
    idempotencyKey: `publish-${nonce}`,
    operation: `contribution:${contributionId}:publish`,
    requestDigest: digest(`publish-${ordinal}-${nonce}`),
    response: {
      body: { contributionId, status: "accepted" },
      headers: {},
      statusCode: 200,
    },
    subjectDigest,
  };
  return { asset, contribution, mutation, next };
}

integration("PostgreSQL integration", () => {
  it("keeps one published head when two revisions publish concurrently", async () => {
    const config = loadConfig(
      {
        AKEP_PUBLIC_ORIGIN: "https://knowledge.test",
        AKEP_TENANT_ID: `https://knowledge.test/tenants/concurrency-${randomUUID()}`,
        AKEP_TRUST_DOMAIN: "knowledge.test",
        AUTH_MODE: "development",
        DATABASE_REQUIRED: "true",
        DATABASE_URL: requireDatabaseUrl(),
        NODE_ENV: "test",
      },
      import.meta.url,
    );
    const pool = new Pool({ connectionString: requireDatabaseUrl(), max: 4 });
    const store = new PostgresGrowthStore(pool, config);
    const spaceId = "https://knowledge.test/spaces/concurrency";
    const recordId = `urn:akep:asset:${randomUUID()}`;
    const candidates = [
      publicationFixture(config, spaceId, recordId, 1),
      publicationFixture(config, spaceId, recordId, 2),
    ];

    try {
      const created = await Promise.all(
        candidates.map(({ contribution }) => store.createContribution(contribution)),
      );
      expect(created.every((result) => result.created)).toBe(true);

      const results = await Promise.all(
        candidates.map(({ asset, contribution, mutation, next }) =>
          store.publishContribution(
            contribution.receipt.contributionId,
            contribution.workflowVersion,
            next,
            asset,
            mutation,
          ),
        ),
      );
      expect(results.map((result) => result.kind).sort()).toEqual([
        "applied",
        "applied",
      ]);

      const persisted = await pool.query<{
        readonly revision_id: string;
        readonly status: string;
      }>(
        `select revision_id, status
           from query.knowledge_projection
          where tenant_id = $1 and space_id = $2 and record_id = $3
          order by revision_id`,
        [config.tenantId, spaceId, recordId],
      );
      expect(persisted.rows).toHaveLength(2);
      expect(persisted.rows.map(({ status }) => status).sort()).toEqual([
        "published",
        "superseded",
      ]);
      expect(
        persisted.rows.filter(({ status }) => status === "published"),
      ).toHaveLength(1);
    } finally {
      await pool.end();
    }
  });

  it("replays workflow mutations after a new application instance starts", async () => {
    const config = loadConfig(
      {
        AKEP_PUBLIC_ORIGIN: "https://knowledge.test",
        AUTH_MODE: "development",
        DATABASE_REQUIRED: "true",
        DATABASE_URL: requireDatabaseUrl(),
        NODE_ENV: "test",
      },
      import.meta.url,
    );
    const contributionIdempotencyKey = `cross-instance-create-${randomUUID()}`;
    const mutationIdempotencyKey = `cross-instance-withdraw-${randomUUID()}`;
    const contribution = {
      akepVersion: "0.1",
      clientSubmissionId: `cross-instance-${randomUUID()}`,
      critical: [],
      evidenceRefs: [],
      extensions: {},
      kind: "deprecate",
      rationale: "Create a workflow for cross-instance replay testing.",
      spaceId: "https://knowledge.test/spaces/integration",
      targetRevisionId: `urn:akep:sha256:${"e".repeat(64)}`,
    };
    const withdrawal = {
      akepVersion: "0.1",
      critical: [],
      extensions: {},
      reason: "Verify durable workflow mutation replay.",
      withdrawalId: `urn:uuid:${randomUUID()}`,
    };
    const appOne = await buildApplication({ config, logger: false });
    const created = await appOne.inject({
      headers: {
        "akep-version": "0.1",
        authorization: "Bearer dev-contributor",
        "idempotency-key": contributionIdempotencyKey,
      },
      method: "POST",
      payload: contribution,
      url: "/akep/0.1/contributions",
    });
    expect(created.statusCode).toBe(201);
    const mutationUrl = `/akep/0.1/contributions/${encodeURIComponent(created.json().contributionId)}/withdraw`;
    const first = await appOne.inject({
      headers: {
        "akep-version": "0.1",
        authorization: "Bearer dev-contributor",
        "idempotency-key": mutationIdempotencyKey,
        "if-match": created.headers.etag!,
      },
      method: "POST",
      payload: withdrawal,
      url: mutationUrl,
    });
    expect(first.statusCode).toBe(200);
    await appOne.close();

    const appTwo = await buildApplication({ config, logger: false });
    try {
      const replay = await appTwo.inject({
        headers: {
          "akep-version": "0.1",
          authorization: "Bearer dev-contributor",
          "idempotency-key": mutationIdempotencyKey,
          "if-match": created.headers.etag!,
        },
        method: "POST",
        payload: withdrawal,
        url: mutationUrl,
      });
      expect(replay.statusCode).toBe(first.statusCode);
      expect(replay.json()).toEqual(first.json());
      expect(replay.headers.etag).toBe(first.headers.etag);
      expect(replay.headers.location).toBe(first.headers.location);

      const pool = new Pool({ connectionString: requireDatabaseUrl() });
      try {
        const persisted = await pool.query<{ readonly count: string }>(
          `select count(*)::text as count
             from contribution.mutation_idempotency
            where tenant_id = $1 and idempotency_key = $2`,
          [config.tenantId, mutationIdempotencyKey],
        );
        expect(persisted.rows[0]?.count).toBe("1");
      } finally {
        await pool.end();
      }
    } finally {
      await appTwo.close();
    }
  });

  it("persists an exposure receipt through the HTTP application", async () => {
    const config = loadConfig(
      {
        AKEP_PUBLIC_ORIGIN: "https://knowledge.test",
        AUTH_MODE: "development",
        DATABASE_REQUIRED: "true",
        DATABASE_URL: requireDatabaseUrl(),
        NODE_ENV: "test",
      },
      import.meta.url,
    );
    const app = await buildApplication({ config, logger: false });
    const query = JSON.parse(
      readFileSync(join(config.contractRoot, "examples", "query.json"), "utf8"),
    ) as Record<string, unknown>;
    query.mode = "lexical";
    delete (query.filters as Record<string, unknown>).validAt;
    const response = await app.inject({
      headers: {
        "akep-version": "0.1",
        authorization: "Bearer dev-reader",
      },
      method: "POST",
      payload: query,
      url: "/akep/0.1/queries",
    });
    const result = response.json();

    const receiptResponse = await app.inject({
      headers: {
        "akep-version": "0.1",
        authorization: "Bearer dev-reader",
      },
      method: "GET",
      url: `/akep/0.1/exposure-receipts/${encodeURIComponent(result.queryReceiptId)}`,
    });

    expect(response.statusCode).toBe(200);
    expect(receiptResponse.statusCode).toBe(200);
    expect(receiptResponse.json().exposureReceiptId).toBe(result.queryReceiptId);
    await app.close();
  });

  it("rejects in-place revision mutation", async () => {
    const config = loadConfig({ AUTH_MODE: "development", NODE_ENV: "test" }, import.meta.url);
    const manifest = JSON.parse(
      readFileSync(join(config.contractRoot, "examples", "asset-manifest.json"), "utf8"),
    ) as { readonly recordId: string };
    const revisionId = readFileSync(
      join(config.contractRoot, "examples", "asset-manifest.revision-id.txt"),
      "utf8",
    ).trim();
    const tenantId = `test-${randomUUID()}`;
    const spaceId = "https://knowledge.test/spaces/integration";
    const pool = new Pool({ connectionString: requireDatabaseUrl() });

    try {
      await pool.query(
        `insert into catalog.record (tenant_id, space_id, record_id)
         values ($1, $2, $3)`,
        [tenantId, spaceId, manifest.recordId],
      );
      await pool.query(
        `insert into catalog.revision
           (tenant_id, space_id, record_id, revision_id, manifest)
         values ($1, $2, $3, $4, $5::jsonb)`,
        [tenantId, spaceId, manifest.recordId, revisionId, JSON.stringify(manifest)],
      );

      await expect(
        pool.query(
          `update catalog.revision
              set manifest = manifest
            where tenant_id = $1 and revision_id = $2`,
          [tenantId, revisionId],
        ),
      ).rejects.toThrow("AKEP revisions are immutable");
    } finally {
      await pool.end();
    }
  });

  it("enforces tenant RLS and requires a restricted production role", async () => {
    const config = loadConfig({ AUTH_MODE: "development", NODE_ENV: "test" }, import.meta.url);
    const admin = new Pool({ connectionString: requireDatabaseUrl() });
    const nonce = randomUUID().replaceAll("-", "");
    const role = `akep_runtime_${nonce}`;
    const password = `akep_${nonce}`;
    const roleIdentifier = `"${role}"`;
    const tenantA = `https://knowledge.test/tenants/rls-a-${nonce}`;
    const tenantB = `https://knowledge.test/tenants/rls-b-${nonce}`;
    const spaceId = "https://knowledge.test/spaces/rls";
    const recordA = `urn:akep:asset:rls-a-${nonce}`;
    const recordB = `urn:akep:asset:rls-b-${nonce}`;
    const rejectedRecord = `urn:akep:asset:rls-rejected-${nonce}`;
    const restrictedUrl = new URL(requireDatabaseUrl());
    restrictedUrl.username = role;
    restrictedUrl.password = password;
    const migrationDirectory = join(
      config.contractRoot,
      "../../../infra/postgres/migrations",
    );
    let restrictedDatabase: Database | undefined;
    let wrongTenantDatabase: Database | undefined;
    let noContextPool: Pool | undefined;

    try {
      await admin.query(
        `create role ${roleIdentifier}
           login nosuperuser nocreatedb nocreaterole noinherit nobypassrls
           password '${password}'`,
      );
      await admin.query(
        `grant usage on schema catalog, contribution, evaluation, governance, platform, query
             to ${roleIdentifier}`,
      );
      await admin.query(
        `grant select, insert, update, delete on all tables in schema
             catalog, contribution, evaluation, governance, query
             to ${roleIdentifier}`,
      );
      await admin.query(
        `grant select, insert, update, delete on platform.outbox_event
             to ${roleIdentifier}`,
      );
      await admin.query(
        `grant select on platform.schema_migration to ${roleIdentifier}`,
      );
      await admin.query(
        `grant execute on function platform.current_tenant_id() to ${roleIdentifier}`,
      );
      await admin.query(
        `insert into platform.tenant_runtime_role (database_role, tenant_id)
         values ($1, $2)`,
        [role, tenantA],
      );
      await admin.query(
        `insert into catalog.record (tenant_id, space_id, record_id)
         values ($1, $3, $4), ($2, $3, $5)`,
        [tenantA, tenantB, spaceId, recordA, recordB],
      );

      const unsafeDatabase = createDatabase(
        requireDatabaseUrl(),
        migrationDirectory,
        { requireRestrictedRole: true, tenantId: tenantA },
      );
      try {
        expect(await unsafeDatabase.ready()).toBe(false);
      } finally {
        await unsafeDatabase.close();
      }

      restrictedDatabase = createDatabase(
        restrictedUrl.toString(),
        migrationDirectory,
        { requireRestrictedRole: true, tenantId: tenantA },
      );
      expect(await restrictedDatabase.ready()).toBe(true);

      const visible = await restrictedDatabase.pool.query<{ readonly record_id: string }>(
        `select record_id from catalog.record
          where record_id = any($1::text[])
          order by record_id`,
        [[recordA, recordB]],
      );
      expect(visible.rows).toEqual([{ record_id: recordA }]);
      await expect(
        restrictedDatabase.pool.query(
          `insert into catalog.record (tenant_id, space_id, record_id)
           values ($1, $2, $3)`,
          [tenantB, spaceId, rejectedRecord],
        ),
      ).rejects.toMatchObject({ code: "42501" });

      noContextPool = new Pool({ connectionString: restrictedUrl.toString() });
      const hidden = await noContextPool.query<{ readonly count: string }>(
        `select count(*)::text as count from catalog.record
          where record_id = any($1::text[])`,
        [[recordA, recordB]],
      );
      expect(hidden.rows[0]?.count).toBe("0");

      wrongTenantDatabase = createDatabase(
        restrictedUrl.toString(),
        migrationDirectory,
        { requireRestrictedRole: true, tenantId: tenantB },
      );
      expect(await wrongTenantDatabase.ready()).toBe(false);
      const forged = await wrongTenantDatabase.pool.query<{ readonly count: string }>(
        `select count(*)::text as count from catalog.record
          where record_id = any($1::text[])`,
        [[recordA, recordB]],
      );
      expect(forged.rows[0]?.count).toBe("0");
    } finally {
      if (noContextPool !== undefined) await noContextPool.end();
      if (wrongTenantDatabase !== undefined) await wrongTenantDatabase.close();
      if (restrictedDatabase !== undefined) await restrictedDatabase.close();
      await admin.query(
        `delete from catalog.record
          where tenant_id = any($1::text[]) and record_id = any($2::text[])`,
        [[tenantA, tenantB], [recordA, recordB, rejectedRecord]],
      );
      await admin.query(
        "delete from platform.tenant_runtime_role where database_role = $1",
        [role],
      );
      await admin.query(`drop owned by ${roleIdentifier}`);
      await admin.query(`drop role ${roleIdentifier}`);
      await admin.end();
    }
  });
});
