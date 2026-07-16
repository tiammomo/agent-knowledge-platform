import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { buildApplication } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { ContractRegistry } from "../src/contracts/registry.js";
import type { GrowthStore } from "../src/modules/growth/store.js";
import type { PublishedAsset } from "../src/modules/growth/types.js";
import { canConsume } from "../src/modules/growth/validation.js";
import type { Principal } from "../src/platform/auth.js";
import {
  CHUNKER_FINGERPRINT,
  PostgresQuerySearchStore,
} from "../src/modules/query/search.js";

const SPACE_ID = "https://knowledge.test/spaces/support";
const REQUIRED_TYPES = [
  "schema-validation",
  "provenance-validation",
  "human-review",
  "safety-scan",
  "license-review",
  "policy-approval",
] as const;

function config() {
  return loadConfig(
    {
      AKEP_DEFAULT_SPACE: SPACE_ID,
      AKEP_PUBLIC_ORIGIN: "https://knowledge.test",
      AUTH_MODE: "development",
      DATABASE_REQUIRED: "false",
      NODE_ENV: "test",
    },
    import.meta.url,
  );
}

function headers() {
  return {
    "akep-version": "0.1",
    authorization: "Bearer dev-reader",
  };
}

function asset(seed: string, content: string, warning = false): PublishedAsset {
  const bytes = Buffer.from(content, "utf8");
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const revisionId = `urn:akep:sha256:${seed.repeat(64)}`;
  const occurredAt = `2026-07-15T0${seed}:00:00.000Z`;
  return {
    indexedAt: occurredAt,
    manifest: {
      assetType: "procedure",
      critical: [],
      labels: ["refund"],
      payloads: [
        {
          digest,
          language: "zh-CN",
          mediaType: "text/markdown; charset=utf-8",
          name: "primary",
          size: bytes.byteLength,
        },
      ],
      policy: {
        allowedPurposes: ["customer-support"],
        classification: "internal",
        obligations: ["cite"],
      },
      profile: {
        digest: `sha256:${"a".repeat(64)}`,
        uri: "https://agentknowledge.dev/profiles/procedure/1",
      },
      provenance: {
        attributedTo: ["https://knowledge.test/actors/curator"],
        generatedBy: {
          activityId: `urn:uuid:00000000-0000-4000-8000-00000000000${seed}`,
          endedAt: occurredAt,
          type: "human-authored",
          used: [],
        },
      },
      recordId: `https://knowledge.test/records/refund-${seed}`,
      summary: `退款处理规则 ${seed}`,
      title: `退款流程 ${seed}`,
    },
    payloads: [
      {
        data: bytes.toString("base64"),
        digest,
        mediaType: "text/markdown; charset=utf-8",
        name: "primary",
        size: bytes.byteLength,
      },
    ],
    publicationEvent: {
      actor: "https://knowledge.test/actors/publisher",
      attestationRefs: [`https://knowledge.test/attestations/${seed}`],
      channel: "published",
      critical: [],
      eventId: `urn:uuid:10000000-0000-4000-8000-00000000000${seed}`,
      eventType: "channel.updated",
      eventVersion: "0.1",
      occurredAt,
      policyEpoch: "bootstrap-1",
      policyVersion: {
        digest: `sha256:${"b".repeat(64)}`,
        uri: "https://knowledge.test/policies/publication/1",
      },
      reason: "Published for test.",
      recordId: `https://knowledge.test/records/refund-${seed}`,
      revisionId,
      spaceId: SPACE_ID,
      trustDomain: "knowledge.test",
    },
    qualityAttestationRefs: REQUIRED_TYPES.map(
      (type) => `https://knowledge.test/attestations/${seed}/${type}`,
    ),
    qualityDecision: warning ? "suitable_with_warning" : "suitable",
    qualityReasons: [warning ? "Requires supervisor confirmation." : "Golden set passed."],
    revisionId,
    sourceContributionId: `urn:uuid:20000000-0000-4000-8000-00000000000${seed}`,
    spaceId: SPACE_ID,
    status: "published",
  };
}

function growth(
  assets: readonly PublishedAsset[],
  expiredAttestations: ReadonlySet<string> = new Set(),
): GrowthStore {
  return {
    async evidenceCounts() {
      return { feedback: 0, usage: 0 };
    },
    async getPublishedRevision(spaceId: string, revisionId: string) {
      return assets.find(
        (candidate) =>
          candidate.spaceId === spaceId && candidate.revisionId === revisionId,
      );
    },
    async getAttestation(spaceId: string, attestationId: string) {
      const published = assets.find(
        (candidate) =>
          candidate.spaceId === spaceId &&
          candidate.qualityAttestationRefs.includes(attestationId),
      );
      if (published === undefined) return undefined;
      const warning = published.qualityDecision === "suitable_with_warning";
      const type = REQUIRED_TYPES.find((candidate) => attestationId.endsWith(`/${candidate}`));
      if (type === undefined) return undefined;
      const issuedAt = new Date(Date.now() - 60_000).toISOString();
      const expiresAt = new Date(
        Date.now() + (expiredAttestations.has(attestationId) ? -1_000 : 86_400_000),
      ).toISOString();
      return {
        createdAt: issuedAt,
        documentDigest: `sha256:${"c".repeat(64)}`,
        idempotencyKey: `query-fixture-${published.revisionId}`,
        issuerSubjectDigest: `sha256:${"d".repeat(64)}`,
        spaceId,
        statement: {
          attestationId,
          attestationVersion: "0.1",
          critical: [],
          evidenceRefs: [],
          expiresAt,
          issuedAt,
          issuer: "urn:akep:test:evaluator",
          method: {
            digest: `sha256:${"e".repeat(64)}`,
            uri: "https://knowledge.test/evaluators/query-fixture/1",
          },
          result: {
            outcome: warning && type === "human-review" ? "warning" : "pass",
            summary: published.qualityReasons[0],
          },
          subject: { revisionId: published.revisionId },
          type,
        },
      };
    },
    async getEvaluationRunByAttestation(attestationId: string) {
      const published = assets.find((candidate) =>
        candidate.qualityAttestationRefs.includes(attestationId),
      );
      if (published === undefined) return undefined;
      const warning = published.qualityDecision === "suitable_with_warning";
      return {
        createdAt: published.indexedAt,
        documentDigest: `sha256:${"f".repeat(64)}`,
        idempotencyKey: `query-run-${published.revisionId}`,
        issuerSubjectDigest: `sha256:${"d".repeat(64)}`,
        requestDigest: `sha256:${"1".repeat(64)}`,
        run: {
          attestationId,
          clientRunId: `https://knowledge.test/evaluation-runs/client-${published.revisionId.slice(-1)}`,
          completedAt: published.indexedAt,
          critical: [],
          dataset: {
            digest: `sha256:${"2".repeat(64)}`,
            uri: "https://knowledge.test/evaluation-datasets/query-fixture/1",
          },
          evaluationRunVersion: "0.1",
          evaluator: {
            digest: `sha256:${"e".repeat(64)}`,
            uri: "https://knowledge.test/evaluators/query-fixture/1",
          },
          evidenceRefs: [],
          gate: {
            checks: [],
            outcome: warning ? "warning" : "pass",
            reasons: published.qualityReasons,
          },
          metrics: {},
          runId: `https://knowledge.test/evaluation-runs/${published.revisionId.slice(-1)}`,
          spaceId: published.spaceId,
          startedAt: published.indexedAt,
          status: "completed",
          subject: { revisionId: published.revisionId },
          thresholds: {},
        },
      };
    },
    async listContributions() {
      return [];
    },
    async listPublished() {
      return assets;
    },
  } as unknown as GrowthStore;
}

function query(overrides: Record<string, unknown> = {}) {
  return {
    critical: [],
    include: ["passages", "summary"],
    limit: 10,
    mode: "lexical",
    purpose: "customer-support",
    query: { locale: "zh-CN", text: "退款超过 30 天" },
    spaces: [SPACE_ID],
    supportedObligations: ["cite"],
    ...overrides,
  };
}

describe("passage query and context packs", () => {
  it("does not let request-declared obligations expand the signed Principal", () => {
    const candidate = asset("9", "退款知识");
    const principal = (supportedObligations: readonly unknown[]): Principal => ({
      scopes: new Set([
        "akep:classification:internal",
        "akep:policy:*",
        "akep:space:*",
      ]),
      subject: "urn:akep:test:reader",
      subjectDigest: `sha256:${"f".repeat(64)}`,
      supportedObligations,
    });

    expect(canConsume(
      candidate,
      "customer-support",
      ["cite"],
      principal([]),
    )).toBe(false);
    expect(canConsume(
      candidate,
      "customer-support",
      ["cite", "no-train"],
      principal(["no-train"]),
    )).toBe(false);
    expect(canConsume(
      candidate,
      "customer-support",
      ["cite"],
      principal(["cite"]),
    )).toBe(true);

    const reviewExpired: PublishedAsset = {
      ...candidate,
      manifest: {
        ...candidate.manifest,
        scope: { reviewAfter: new Date(Date.now() - 1_000).toISOString() },
      },
    };
    expect(canConsume(
      reviewExpired,
      "customer-support",
      ["cite"],
      principal(["cite"]),
    )).toBe(false);
  });

  it("ranks passages with real scores and emits relocatable UTF-8 citations", async () => {
    const first = asset(
      "1",
      "📌 退款超过 30 天时，需要主管复核。退款材料必须完整。",
    );
    const second = asset(
      "2",
      "退款申请先登记。超过服务期限后，由主管检查。期限为 30 天。",
    );
    const app = await buildApplication({
      config: config(),
      growth: growth([second, first]),
      logger: false,
    });

    const response = await app.inject({
      headers: headers(),
      method: "POST",
      payload: query(),
      url: "/akep/0.1/queries",
    });

    expect(response.statusCode).toBe(200);
    const results = response.json().results;
    expect(results).toHaveLength(2);
    expect(results[0].revisionId).toBe(first.revisionId);
    expect(results[0].scores[0].value).toBeGreaterThan(results[1].scores[0].value);
    expect(results[0].scores[0].value).not.toBe(1);
    const citation = results[0].citations[0];
    expect(citation.locator.type).toBe("text-offset");
    const payload = Buffer.from(first.payloads[0]!.data, "base64");
    expect(
      payload
        .subarray(citation.locator.start, citation.locator.end)
        .toString("utf8"),
    ).toBe(citation.quote);
    expect(citation.chunkId).toMatch(/^chunk:sha256:[a-f0-9]{64}$/);
    await app.close();
  });

  it("paginates with a snapshot-bound cursor and rejects cursor reuse", async () => {
    const assets = [
      asset("1", "退款超过 30 天时，需要主管复核。"),
      asset("2", "超过 30 天的退款，主管需要复核退款材料。"),
    ];
    const app = await buildApplication({
      config: config(),
      growth: growth(assets),
      logger: false,
    });
    const first = await app.inject({
      headers: headers(),
      method: "POST",
      payload: query({ limit: 1 }),
      url: "/akep/0.1/queries",
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().results).toHaveLength(1);
    expect(first.json().nextCursor).toEqual(expect.any(String));

    const second = await app.inject({
      headers: headers(),
      method: "POST",
      payload: query({ cursor: first.json().nextCursor, limit: 1 }),
      url: "/akep/0.1/queries",
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().results).toHaveLength(1);
    expect(second.json().results[0].revisionId).not.toBe(
      first.json().results[0].revisionId,
    );
    expect(second.json().nextCursor).toBeUndefined();

    const reused = await app.inject({
      headers: headers(),
      method: "POST",
      payload: query({
        cursor: first.json().nextCursor,
        query: { locale: "zh-CN", text: "完全不同的任务" },
      }),
      url: "/akep/0.1/queries",
    });
    expect(reused.statusCode).toBe(400);
    expect(reused.json().code).toBe("AKEP_CURSOR_INVALID");
    await app.close();
  });

  it("searches every token-authorized Space when spaces is omitted", async () => {
    const support = asset("1", "退款超过 30 天时，需要主管复核。");
    const otherSpaceId = "https://knowledge.test/spaces/operations";
    const base = asset("2", "退款超过 30 天，需要运营主管复核。");
    const operations: PublishedAsset = {
      ...base,
      publicationEvent: { ...base.publicationEvent, spaceId: otherSpaceId },
      spaceId: otherSpaceId,
    };
    const app = await buildApplication({
      config: config(),
      growth: growth([support, operations]),
      logger: false,
    });
    const body = query();
    delete (body as { spaces?: readonly string[] }).spaces;
    const response = await app.inject({
      headers: headers(),
      method: "POST",
      payload: body,
      url: "/akep/0.1/queries",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().results.map((item: { spaceId: string }) => item.spaceId)).toEqual(
      expect.arrayContaining([SPACE_ID, otherSpaceId]),
    );
    await app.close();
  });

  it("rejects advertised but unavailable retrieval modes explicitly", async () => {
    const app = await buildApplication({ config: config(), logger: false });
    const response = await app.inject({
      headers: headers(),
      method: "POST",
      payload: query({ mode: "hybrid" }),
      url: "/akep/0.1/queries",
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("AKEP_QUERY_MODE_UNSUPPORTED");
    await app.close();
  });

  it("fails closed when published quality evidence has expired", async () => {
    const published = asset("1", "退款超过 30 天时，需要主管复核。");
    const app = await buildApplication({
      config: config(),
      growth: growth([published], new Set(published.qualityAttestationRefs)),
      logger: false,
    });
    const response = await app.inject({
      headers: headers(),
      method: "POST",
      payload: query(),
      url: "/akep/0.1/queries",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().results).toEqual([]);
    await app.close();
  });

  it("rejects unsupported historical and verified-channel filters", async () => {
    const app = await buildApplication({ config: config(), logger: false });
    for (const filters of [
      { validAt: new Date().toISOString() },
      { channels: ["verified"] },
    ]) {
      const response = await app.inject({
        headers: headers(),
        method: "POST",
        payload: query({ filters }),
        url: "/akep/0.1/queries",
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("AKEP_QUERY_FILTER_UNSUPPORTED");
    }
    await app.close();
  });

  it("builds a model-independent, budgeted and quality-aware ContextPack", async () => {
    const published = asset(
      "1",
      "📌 退款超过 30 天时，需要主管复核并核验完整退款材料。",
      true,
    );
    const app = await buildApplication({
      config: config(),
      growth: growth([published]),
      logger: false,
    });
    const response = await app.inject({
      headers: headers(),
      method: "POST",
      payload: {
        budget: { maxCharacters: 18, maxPassages: 2, maxTokens: 18 },
        critical: [],
        mode: "lexical",
        purpose: "customer-support",
        spaces: [SPACE_ID],
        supportedObligations: ["cite"],
        task: { locale: "zh-CN", text: "退款超过 30 天" },
      },
      url: "/akep/0.1/context-packs",
    });

    expect(response.statusCode).toBe(200);
    const pack = response.json();
    new ContractRegistry(config().contractRoot).assert("context-pack.schema.json", pack);
    expect(pack.contextDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(pack.contextPackId).toBe(`urn:akep:context:${pack.contextDigest}`);
    expect(pack.passages).toHaveLength(1);
    expect(pack.budget.usedCharacters).toBeLessThanOrEqual(18);
    expect(pack.budget.estimatedTokens).toBeLessThanOrEqual(18);
    expect(pack.obligations).toEqual(["cite"]);
    expect(pack.quality).toMatchObject({
      citationCoverage: 1,
      decision: "suitable_with_warning",
    });
    expect(pack.warnings.map((warning: { code: string }) => warning.code)).toEqual(
      expect.arrayContaining([
        "AKEP_CONTEXT_BUDGET_TRUNCATED",
        "AKEP_CONTEXT_QUALITY_WARNING",
      ]),
    );
    const citation = pack.citations[0];
    const payload = Buffer.from(published.payloads[0]!.data, "base64");
    expect(
      payload
        .subarray(citation.locator.start, citation.locator.end)
        .toString("utf8"),
    ).toBe(citation.quote);
    await app.close();
  });
});

const integration = describe.skipIf(process.env.TEST_DATABASE_URL === undefined);

integration("PostgreSQL passage projection", () => {
  it("materializes and searches the same deterministic UTF-8 passage", async () => {
    const tenantId = `https://knowledge.test/tenants/query-${randomUUID()}`;
    const databaseConfig = loadConfig(
      {
        AKEP_PUBLIC_ORIGIN: "https://knowledge.test",
        AKEP_TENANT_ID: tenantId,
        AUTH_MODE: "development",
        DATABASE_REQUIRED: "false",
        NODE_ENV: "test",
      },
      import.meta.url,
    );
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const published = asset("3", "中文退款超过 30 天时，需要主管复核。📌");
    try {
      const store = new PostgresQuerySearchStore(pool, databaseConfig);
      const passages = await store.search({
        assets: [published],
        locale: "zh-CN",
        mode: "lexical",
        query: { text: "退款超过 30 天" },
      });
      expect(passages).toHaveLength(1);
      expect(passages[0]!.score).toBeGreaterThan(0);
      const bytes = Buffer.from(published.payloads[0]!.data, "base64");
      expect(
        bytes.subarray(passages[0]!.start, passages[0]!.end).toString("utf8"),
      ).toBe(passages[0]!.text);
      const projection = await pool.query<{ readonly count: number }>(
        `select count(*)::integer as count from query.chunk_projection
          where tenant_id = $1 and chunker_fingerprint = $2`,
        [tenantId, CHUNKER_FINGERPRINT],
      );
      expect(projection.rows[0]?.count).toBe(1);
    } finally {
      await pool.query("delete from query.chunk_projection where tenant_id = $1", [
        tenantId,
      ]);
      await pool.end();
    }
  });
});
