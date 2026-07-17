import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { ContractRegistry } from "../src/contracts/registry.js";
import {
  computeRevisionId,
  sha256Digest,
} from "../src/contracts/revision.js";
import { evaluateAttestationGate } from "../src/modules/evaluation/quality-gate.js";
import { registerEvaluationRoutes } from "../src/modules/evaluation/routes.js";
import { parseEvaluationRunRequest } from "../src/modules/evaluation/validation.js";
import type { AttestationState } from "../src/modules/evaluation/types.js";
import { registerGrowthRoutes } from "../src/modules/growth/routes.js";
import { InMemoryGrowthStore } from "../src/modules/growth/store.js";
import { InMemoryExposureReceiptStore } from "../src/modules/query/exposure-receipt-store.js";
import { installAuthentication } from "../src/platform/auth.js";
import { installErrorHandling } from "../src/platform/problem.js";

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

function config() {
  return loadConfig(
    {
      AKEP_PUBLIC_ORIGIN: "https://knowledge.test",
      AUTH_MODE: "development",
      DATABASE_REQUIRED: "false",
      NODE_ENV: "test",
    },
    import.meta.url,
  );
}

function headers(token: string, extra: Record<string, string> = {}) {
  return {
    "akep-version": "0.1",
    authorization: `Bearer ${token}`,
    ...extra,
  };
}

describe("evaluation evidence and publication quality gate", () => {
  it("rejects Evaluation evidence with an excessive validity period", () => {
    const request = evaluationRequest(
      "https://knowledge.test/spaces/evaluation",
      `urn:akep:sha256:${"7".repeat(64)}`,
      {
        clientRunId: `https://knowledge.test/evaluation-runs/${randomUUID()}`,
        metric: 1,
        required: true,
        threshold: 1,
      },
    );
    request.expiresAt = new Date(
      Date.parse(request.completedAt) + 91 * 24 * 60 * 60_000,
    ).toISOString();

    expect(() => parseEvaluationRunRequest(request)).toThrowError(
      expect.objectContaining({ code: "AKEP_SCHEMA_INVALID" }),
    );
  });

  it("persists EvaluationRuns and only publishes against qualifying evidence", async () => {
    const appConfig = config();
    const contracts = new ContractRegistry(appConfig.contractRoot);
    const growth = new InMemoryGrowthStore();
    const receipts = new InMemoryExposureReceiptStore();
    const app = Fastify({ logger: false });
    apps.push(app);
    installErrorHandling(app);
    installAuthentication(app, appConfig);
    await app.register(
      async (api) => {
        await registerEvaluationRoutes(api, { config: appConfig, contracts, growth });
        await registerGrowthRoutes(api, {
          config: appConfig,
          contracts,
          growth,
          receipts,
        });
      },
      { prefix: "/akep/0.1" },
    );
    await app.ready();

    const manifest = JSON.parse(
      readFileSync(
        join(appConfig.contractRoot, "examples", "asset-manifest.json"),
        "utf8",
      ),
    ) as Record<string, any>;
    const bytes = Buffer.from("评测通过后才可发布。", "utf8");
    const digest = sha256Digest(bytes);
    manifest.recordId = `urn:akep:asset:${randomUUID()}`;
    manifest.payloads = [{ ...manifest.payloads[0], digest, size: bytes.byteLength }];
    const revisionId = computeRevisionId(manifest);
    const spaceId = "https://knowledge.test/spaces/evaluation";
    const created = await app.inject({
      headers: headers("dev-contributor", { "idempotency-key": `create-${randomUUID()}` }),
      method: "POST",
      payload: {
        akepVersion: "0.1",
        clientSubmissionId: `submission-${randomUUID()}`,
        critical: [],
        evidenceRefs: ["https://knowledge.test/evidence/source"],
        extensions: {},
        inlinePayloads: [
          {
            data: bytes.toString("base64"),
            digest,
            encoding: "base64",
            name: "primary",
          },
        ],
        kind: "create",
        manifest,
        rationale: "Evaluate this candidate.",
        revisionId,
        spaceId,
      },
      url: "/akep/0.1/contributions",
    });
    expect(created.statusCode).toBe(201);

    const missingEvidenceReview = await review(
      app,
      created.json().contributionId,
      created.headers.etag!,
      `urn:uuid:${randomUUID()}`,
    );
    expect(missingEvidenceReview.statusCode).toBe(409);
    expect(missingEvidenceReview.json().code).toBe("AKEP_ATTESTATION_NOT_FOUND");

    const failedRun = await createEvaluationRun(app, spaceId, revisionId, {
      clientRunId: `https://knowledge.test/evaluation-runs/${randomUUID()}`,
      metric: 0.4,
      required: true,
      threshold: 0.85,
    });
    expect(failedRun.statusCode).toBe(201);
    expect(failedRun.json().gate.outcome).toBe("fail");
    const failedReview = await review(
      app,
      created.json().contributionId,
      created.headers.etag!,
      failedRun.json().attestationId,
    );
    expect(failedReview.statusCode).toBe(409);
    expect(failedReview.json().code).toBe("AKEP_ATTESTATION_FAILED");

    const idempotencyKey = `evaluation-${randomUUID()}`;
    const clientRunId = `https://knowledge.test/evaluation-runs/${randomUUID()}`;
    const warningRequest = evaluationRequest(spaceId, revisionId, {
      clientRunId,
      metric: 0.8,
      required: false,
      threshold: 0.9,
    });
    contracts.assert("evaluation-run-request.schema.json", warningRequest);
    const warningRun = await app.inject({
      headers: headers("dev-evaluator", { "idempotency-key": idempotencyKey }),
      method: "POST",
      payload: warningRequest,
      url: "/akep/0.1/evaluation-runs",
    });
    expect(warningRun.statusCode).toBe(201);
    contracts.assert("evaluation-run.schema.json", warningRun.json());
    expect(warningRun.json().gate.outcome).toBe("warning");

    const replay = await app.inject({
      headers: headers("dev-evaluator", { "idempotency-key": idempotencyKey }),
      method: "POST",
      payload: warningRequest,
      url: "/akep/0.1/evaluation-runs",
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().runId).toBe(warningRun.json().runId);

    const conflict = await app.inject({
      headers: headers("dev-evaluator", { "idempotency-key": idempotencyKey }),
      method: "POST",
      payload: { ...warningRequest, summary: "A conflicting retry." },
      url: "/akep/0.1/evaluation-runs",
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe("AKEP_IDEMPOTENCY_CONFLICT");

    const fetchedAttestation = await app.inject({
      headers: headers("dev-curator", { "akep-purpose": "customer-support" }),
      method: "GET",
      url:
        `/akep/0.1/spaces/${encodeURIComponent(spaceId)}/attestations/` +
        encodeURIComponent(warningRun.json().attestationId),
    });
    expect(fetchedAttestation.statusCode).toBe(200);
    contracts.assert("attestation.schema.json", fetchedAttestation.json());
    expect(fetchedAttestation.json().subject.revisionId).toBe(revisionId);
    expect(fetchedAttestation.json().result.outcome).toBe("warning");

    const reviewed = await review(
      app,
      created.json().contributionId,
      created.headers.etag!,
      warningRun.json().attestationId,
    );
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.json().status).toBe("verified");

    const published = await app.inject({
      headers: headers("dev-publisher", {
        "idempotency-key": `publish-${randomUUID()}`,
        "if-match": reviewed.headers.etag!,
      }),
      method: "POST",
      payload: {
        akepVersion: "0.1",
        attestationRefs: [warningRun.json().attestationId],
        critical: [],
        decisionId: `urn:uuid:${randomUUID()}`,
        expectedPolicyEpoch: appConfig.policyEpoch,
        extensions: {},
        policyVersion: {
          digest: `sha256:${"b".repeat(64)}`,
          uri: "https://knowledge.test/policies/publication/1",
        },
        rationale: "Publish with a recorded advisory warning.",
      },
      url:
        `/akep/0.1/contributions/${encodeURIComponent(created.json().contributionId)}` +
        "/actions/publish",
    });
    expect(published.statusCode).toBe(200);
    const asset = await growth.getPublishedRevision(spaceId, revisionId);
    expect(asset?.qualityDecision).toBe("suitable_with_warning");
    expect(asset?.qualityAttestationRefs).toContain(warningRun.json().attestationId);
    expect(asset?.qualityAttestationRefs).toHaveLength(7);
    expect(asset?.qualityReasons.some((reason) => reason.includes("recallAt5"))).toBe(true);

    const fetchedRun = await app.inject({
      headers: headers("dev-reader", {
        "akep-obligation-support": Buffer.from('["cite","no-train"]').toString("base64url"),
        "akep-purpose": "customer-support",
      }),
      method: "GET",
      url: `/akep/0.1/evaluation-runs/${encodeURIComponent(warningRun.json().runId)}`,
    });
    expect(fetchedRun.statusCode).toBe(200);
    expect(fetchedRun.json().attestationId).toBe(warningRun.json().attestationId);
  });

  it("rejects expired and cross-Revision Attestations at decision time", async () => {
    const growth = new InMemoryGrowthStore();
    const revisionId = `urn:akep:sha256:${"a".repeat(64)}`;
    const reference = `urn:uuid:${randomUUID()}`;
    const state: AttestationState = {
      createdAt: new Date(Date.now() - 20_000).toISOString(),
      documentDigest: `sha256:${"b".repeat(64)}`,
      idempotencyKey: `expired-${randomUUID()}`,
      issuerSubjectDigest: `sha256:${"c".repeat(64)}`,
      spaceId: "https://knowledge.test/spaces/evaluation",
      statement: {
        attestationId: reference,
        attestationVersion: "0.1",
        critical: [],
        evidenceRefs: [],
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
        issuedAt: new Date(Date.now() - 10_000).toISOString(),
        issuer: "https://knowledge.test/evaluators/test",
        method: {
          digest: `sha256:${"d".repeat(64)}`,
          uri: "https://knowledge.test/evaluators/test/1",
        },
        result: { outcome: "pass" },
        subject: { revisionId },
        type: "human-review",
      },
    };
    await growth.createAttestation(state);
    await expect(
      evaluateAttestationGate(
        growth,
        state.spaceId,
        revisionId,
        [reference],
        { requireBenchmark: false },
      ),
    ).rejects.toMatchObject({ code: "AKEP_ATTESTATION_EXPIRED" });
    await expect(
      evaluateAttestationGate(
        growth,
        state.spaceId,
        `urn:akep:sha256:${"e".repeat(64)}`,
        [reference],
        { requireBenchmark: false },
      ),
    ).rejects.toMatchObject({ code: "AKEP_ATTESTATION_TARGET_MISMATCH" });

    const currentReference = `urn:uuid:${randomUUID()}`;
    const currentState: AttestationState = {
      ...state,
      documentDigest: `sha256:${"9".repeat(64)}`,
      idempotencyKey: `current-${randomUUID()}`,
      statement: {
        ...state.statement,
        attestationId: currentReference,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        issuedAt: new Date(Date.now() - 1_000).toISOString(),
      },
    };
    await growth.createAttestation(currentState);
    await expect(
      evaluateAttestationGate(
        growth,
        currentState.spaceId,
        revisionId,
        [currentReference],
        {
          requireBenchmark: false,
          requiredTypes: ["human-review", "safety-scan"],
        },
      ),
    ).rejects.toMatchObject({ code: "AKEP_ATTESTATION_REQUIRED" });
  });
});

async function review(
  app: ReturnType<typeof Fastify>,
  contributionId: string,
  etag: string,
  attestationId: string,
) {
  return app.inject({
    headers: headers("dev-curator", {
      "idempotency-key": `review-${randomUUID()}`,
      "if-match": etag,
    }),
    method: "POST",
    payload: {
      akepVersion: "0.1",
      attestationRefs: [attestationId],
      critical: [],
      decision: "verify",
      decisionId: `urn:uuid:${randomUUID()}`,
      extensions: {},
      policyVersion: {
        digest: `sha256:${"a".repeat(64)}`,
        uri: "https://knowledge.test/policies/review/1",
      },
      rationale: "Use persisted and current evidence.",
    },
    url: `/akep/0.1/contributions/${encodeURIComponent(contributionId)}/decisions`,
  });
}

async function createEvaluationRun(
  app: ReturnType<typeof Fastify>,
  spaceId: string,
  revisionId: string,
  values: {
    readonly clientRunId: string;
    readonly metric: number;
    readonly required: boolean;
    readonly threshold: number;
  },
) {
  return app.inject({
    headers: headers("dev-evaluator", {
      "idempotency-key": `evaluation-${randomUUID()}`,
    }),
    method: "POST",
    payload: evaluationRequest(spaceId, revisionId, values),
    url: "/akep/0.1/evaluation-runs",
  });
}

function evaluationRequest(
  spaceId: string,
  revisionId: string,
  values: {
    readonly clientRunId: string;
    readonly metric: number;
    readonly required: boolean;
    readonly threshold: number;
  },
) {
  const completedAt = new Date();
  return {
    akepVersion: "0.1",
    clientRunId: values.clientRunId,
    completedAt: completedAt.toISOString(),
    critical: [],
    dataset: {
      digest: `sha256:${"1".repeat(64)}`,
      uri: "https://knowledge.test/evaluation-datasets/support-v1",
    },
    evaluator: {
      digest: `sha256:${"2".repeat(64)}`,
      uri: "https://knowledge.test/evaluators/retrieval-v1",
    },
    evidenceRefs: ["https://knowledge.test/evaluation-evidence/run-log"],
    expiresAt: new Date(completedAt.getTime() + 24 * 60 * 60_000).toISOString(),
    metrics: { recallAt5: values.metric },
    revisionId,
    spaceId,
    startedAt: new Date(completedAt.getTime() - 1_000).toISOString(),
    summary: "Golden retrieval task evaluation completed.",
    thresholds: {
      recallAt5: {
        operator: "gte",
        required: values.required,
        value: values.threshold,
      },
    },
  };
}
