import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { buildApplication } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import {
  canonicalJson,
  computeRevisionId,
  sha256Digest,
} from "../src/contracts/revision.js";

function config() {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  return loadConfig(
    {
      AKEP_PUBLIC_ORIGIN: "https://knowledge.test",
      AKEP_TENANT_ID: `https://knowledge.test/tenants/growth-loop-${randomUUID()}`,
      AUTH_MODE: "development",
      DATABASE_REQUIRED: databaseUrl === undefined ? "false" : "true",
      ...(databaseUrl === undefined ? {} : { DATABASE_URL: databaseUrl }),
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

describe("minimal governed knowledge growth loop", () => {
  it("contributes, reviews, publishes, reads, records usage and accepts feedback", async () => {
    const appConfig = config();
    const app = await buildApplication({ config: appConfig, logger: false });
    const evidenceBaselineResponse = await app.inject({
      headers: headers("dev-console"),
      method: "GET",
      url: "/console/v1/evidence-summary",
    });
    expect(evidenceBaselineResponse.statusCode).toBe(200);
    const evidenceBaseline = evidenceBaselineResponse.json();
    const manifest = JSON.parse(
      readFileSync(
        join(appConfig.contractRoot, "examples", "asset-manifest.json"),
        "utf8",
      ),
    ) as Record<string, any>;
    const bytes = Buffer.from("超过 30 天的退款申请需要主管复核。", "utf8");
    const digest = sha256Digest(bytes);
    const testLabel = `test-${randomUUID()}`;
    manifest.recordId = `urn:akep:asset:${randomUUID()}`;
    manifest.title = "退款超过 30 天如何处理";
    manifest.labels = [...manifest.labels, testLabel];
    manifest.payloads = [
      {
        ...manifest.payloads[0],
        digest,
        size: bytes.byteLength,
      },
    ];
    const revisionId = computeRevisionId(manifest);
    const spaceId = "https://knowledge.example/spaces/support";
    const contribution = {
      akepVersion: "0.1",
      clientSubmissionId: `test-${randomUUID()}`,
      critical: [],
      evidenceRefs: ["https://docs.example/refund-policy"],
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
      rationale: "Add a reviewed support procedure.",
      revisionId,
      spaceId,
    };
    const createIdempotencyKey = `create-${randomUUID()}`;
    const created = await app.inject({
      headers: headers("dev-contributor", {
        "idempotency-key": createIdempotencyKey,
      }),
      method: "POST",
      payload: contribution,
      url: "/akep/0.1/contributions",
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().status).toBe("candidate");

    const replayed = await app.inject({
      headers: headers("dev-contributor", {
        "idempotency-key": createIdempotencyKey,
      }),
      method: "POST",
      payload: contribution,
      url: "/akep/0.1/contributions",
    });
    expect(replayed.statusCode).toBe(201);
    expect(replayed.json().contributionId).toBe(created.json().contributionId);

    const idempotencyConflict = await app.inject({
      headers: headers("dev-contributor", {
        "idempotency-key": createIdempotencyKey,
      }),
      method: "POST",
      payload: { ...contribution, rationale: "A conflicting retry body." },
      url: "/akep/0.1/contributions",
    });
    expect(idempotencyConflict.statusCode).toBe(409);
    expect(idempotencyConflict.json().code).toBe("AKEP_IDEMPOTENCY_CONFLICT");

    const listedContribution = await app.inject({
      headers: headers("dev-contributor"),
      method: "GET",
      url: "/console/v1/contributions",
    });
    const listedState = listedContribution.json().contributions.find(
      (item: { receipt: { contributionId: string } }) =>
        item.receipt.contributionId === created.json().contributionId,
    );
    expect(listedState.amendments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "content-scan", verdict: "clean" }),
      ]),
    );

    const unsafeBytes = Buffer.from(
      "api_key = abcdefghijklmnopqrstuvwxyz012345",
      "utf8",
    );
    const unsafeManifest = structuredClone(manifest);
    unsafeManifest.recordId = `urn:akep:asset:${randomUUID()}`;
    unsafeManifest.payloads[0] = {
      ...unsafeManifest.payloads[0],
      digest: sha256Digest(unsafeBytes),
      size: unsafeBytes.byteLength,
    };
    const unsafeRevisionId = computeRevisionId(unsafeManifest);
    const quarantined = await app.inject({
      headers: headers("dev-contributor", {
        "idempotency-key": `unsafe-${randomUUID()}`,
      }),
      method: "POST",
      payload: {
        ...contribution,
        clientSubmissionId: `unsafe-${randomUUID()}`,
        inlinePayloads: [{
          data: unsafeBytes.toString("base64"),
          digest: sha256Digest(unsafeBytes),
          encoding: "base64",
          name: "primary",
        }],
        manifest: unsafeManifest,
        revisionId: unsafeRevisionId,
      },
      url: "/akep/0.1/contributions",
    });
    expect(quarantined.statusCode).toBe(201);
    expect(quarantined.json().status).toBe("quarantined");
    const quarantinedList = await app.inject({
      headers: headers("dev-contributor"),
      method: "GET",
      url: "/console/v1/contributions",
    });
    const quarantinedState = quarantinedList.json().contributions.find(
      (item: { receipt: { contributionId: string } }) =>
        item.receipt.contributionId === quarantined.json().contributionId,
    );
    expect(quarantinedState.payloads).toEqual([]);

    const workflowCandidate = await app.inject({
      headers: headers("dev-contributor", {
        "idempotency-key": `workflow-create-${randomUUID()}`,
      }),
      method: "POST",
      payload: {
        akepVersion: "0.1",
        clientSubmissionId: `workflow-${randomUUID()}`,
        critical: [],
        evidenceRefs: [],
        extensions: {},
        kind: "deprecate",
        rationale: "Exercise workflow mutation replay semantics.",
        spaceId,
        targetRevisionId: `urn:akep:sha256:${"f".repeat(64)}`,
      },
      url: "/akep/0.1/contributions",
    });
    expect(workflowCandidate.statusCode).toBe(201);
    const workflowDecision = {
      akepVersion: "0.1",
      attestationRefs: [],
      critical: [],
      decision: "request_evidence",
      decisionId: `urn:uuid:${randomUUID()}`,
      extensions: {},
      policyVersion: {
        digest: `sha256:${"9".repeat(64)}`,
        uri: "https://knowledge.test/policies/review/1",
      },
      rationale: "More evidence is required.",
    };
    const workflowReviewKey = `workflow-review-${randomUUID()}`;
    const workflowReviewed = await app.inject({
      headers: headers("dev-curator", {
        "idempotency-key": workflowReviewKey,
        "if-match": workflowCandidate.headers.etag!,
      }),
      method: "POST",
      payload: workflowDecision,
      url: `/akep/0.1/contributions/${encodeURIComponent(workflowCandidate.json().contributionId)}/decisions`,
    });
    expect(workflowReviewed.statusCode).toBe(200);
    const workflowReviewReplay = await app.inject({
      headers: headers("dev-curator", {
        "idempotency-key": workflowReviewKey,
        "if-match": workflowCandidate.headers.etag!,
      }),
      method: "POST",
      payload: workflowDecision,
      url: `/akep/0.1/contributions/${encodeURIComponent(workflowCandidate.json().contributionId)}/decisions`,
    });
    expect(workflowReviewReplay.statusCode).toBe(workflowReviewed.statusCode);
    expect(workflowReviewReplay.json()).toEqual(workflowReviewed.json());
    expect(workflowReviewReplay.headers.etag).toBe(workflowReviewed.headers.etag);
    const workflowReviewConflict = await app.inject({
      headers: headers("dev-curator", {
        "idempotency-key": workflowReviewKey,
        "if-match": workflowCandidate.headers.etag!,
      }),
      method: "POST",
      payload: { ...workflowDecision, rationale: "A different request." },
      url: `/akep/0.1/contributions/${encodeURIComponent(workflowCandidate.json().contributionId)}/decisions`,
    });
    expect(workflowReviewConflict.statusCode).toBe(409);
    expect(workflowReviewConflict.json().code).toBe("AKEP_IDEMPOTENCY_CONFLICT");

    const amendment = {
      akepVersion: "0.1",
      amendmentId: `urn:uuid:${randomUUID()}`,
      critical: [],
      evidenceRefs: ["https://knowledge.test/evidence/workflow"],
      extensions: {},
      rationale: "Provide the requested workflow evidence.",
    };
    const evidenceKey = `workflow-evidence-${randomUUID()}`;
    const amended = await app.inject({
      headers: headers("dev-contributor", {
        "idempotency-key": evidenceKey,
        "if-match": workflowReviewed.headers.etag!,
      }),
      method: "POST",
      payload: amendment,
      url: `/akep/0.1/contributions/${encodeURIComponent(workflowCandidate.json().contributionId)}/evidence`,
    });
    expect(amended.statusCode).toBe(200);
    const amendmentReplay = await app.inject({
      headers: headers("dev-contributor", {
        "idempotency-key": evidenceKey,
        "if-match": workflowReviewed.headers.etag!,
      }),
      method: "POST",
      payload: amendment,
      url: `/akep/0.1/contributions/${encodeURIComponent(workflowCandidate.json().contributionId)}/evidence`,
    });
    expect(amendmentReplay.statusCode).toBe(amended.statusCode);
    expect(amendmentReplay.json()).toEqual(amended.json());
    expect(amendmentReplay.headers.etag).toBe(amended.headers.etag);
    const amendmentConflict = await app.inject({
      headers: headers("dev-contributor", {
        "idempotency-key": evidenceKey,
        "if-match": workflowReviewed.headers.etag!,
      }),
      method: "POST",
      payload: { ...amendment, rationale: "A different amendment request." },
      url: `/akep/0.1/contributions/${encodeURIComponent(workflowCandidate.json().contributionId)}/evidence`,
    });
    expect(amendmentConflict.statusCode).toBe(409);
    expect(amendmentConflict.json().code).toBe("AKEP_IDEMPOTENCY_CONFLICT");

    const withdrawal = {
      akepVersion: "0.1",
      critical: [],
      extensions: {},
      reason: "The workflow mutation test is complete.",
      withdrawalId: `urn:uuid:${randomUUID()}`,
    };
    const withdrawalKey = `workflow-withdraw-${randomUUID()}`;
    const withdrawn = await app.inject({
      headers: headers("dev-contributor", {
        "idempotency-key": withdrawalKey,
        "if-match": amended.headers.etag!,
      }),
      method: "POST",
      payload: withdrawal,
      url: `/akep/0.1/contributions/${encodeURIComponent(workflowCandidate.json().contributionId)}/withdraw`,
    });
    expect(withdrawn.statusCode).toBe(200);
    const withdrawalReplay = await app.inject({
      headers: headers("dev-contributor", {
        "idempotency-key": withdrawalKey,
        "if-match": amended.headers.etag!,
      }),
      method: "POST",
      payload: withdrawal,
      url: `/akep/0.1/contributions/${encodeURIComponent(workflowCandidate.json().contributionId)}/withdraw`,
    });
    expect(withdrawalReplay.statusCode).toBe(withdrawn.statusCode);
    expect(withdrawalReplay.json()).toEqual(withdrawn.json());
    expect(withdrawalReplay.headers.etag).toBe(withdrawn.headers.etag);
    const withdrawalConflict = await app.inject({
      headers: headers("dev-contributor", {
        "idempotency-key": withdrawalKey,
        "if-match": amended.headers.etag!,
      }),
      method: "POST",
      payload: { ...withdrawal, reason: "A different withdrawal request." },
      url: `/akep/0.1/contributions/${encodeURIComponent(workflowCandidate.json().contributionId)}/withdraw`,
    });
    expect(withdrawalConflict.statusCode).toBe(409);
    expect(withdrawalConflict.json().code).toBe("AKEP_IDEMPOTENCY_CONFLICT");

    const completedAt = new Date();
    const evaluated = await app.inject({
      headers: headers("dev-evaluator", {
        "idempotency-key": `evaluation-${randomUUID()}`,
      }),
      method: "POST",
      payload: {
        akepVersion: "0.1",
        clientRunId: `https://knowledge.test/evaluation-runs/${randomUUID()}`,
        completedAt: completedAt.toISOString(),
        critical: [],
        dataset: {
          digest: `sha256:${"d".repeat(64)}`,
          uri: "https://knowledge.test/evaluation-datasets/support-v1",
        },
        evaluator: {
          digest: `sha256:${"e".repeat(64)}`,
          uri: "https://knowledge.test/evaluators/retrieval-v1",
        },
        evidenceRefs: ["https://knowledge.test/evaluation-evidence/golden-run"],
        expiresAt: new Date(
          completedAt.getTime() + 24 * 60 * 60_000,
        ).toISOString(),
        metrics: { recallAt5: 0.9 },
        revisionId,
        spaceId,
        startedAt: new Date(completedAt.getTime() - 1_000).toISOString(),
        summary: "The candidate passed the golden retrieval evaluation.",
        thresholds: {
          recallAt5: { operator: "gte", required: true, value: 0.85 },
        },
      },
      url: "/akep/0.1/evaluation-runs",
    });
    expect(evaluated.statusCode).toBe(201);
    expect(evaluated.json().gate.outcome).toBe("pass");

    const review = {
      akepVersion: "0.1",
      attestationRefs: [evaluated.json().attestationId],
      critical: [],
      decision: "verify",
      decisionId: `urn:uuid:${randomUUID()}`,
      extensions: {},
      policyVersion: {
        digest: `sha256:${"a".repeat(64)}`,
        uri: "https://knowledge.test/policies/review/1",
      },
      rationale: "Schema, provenance, safety, license and policy checks passed.",
    };
    const reviewKey = `review-${randomUUID()}`;
    const reviewed = await app.inject({
      headers: headers("dev-curator", {
        "idempotency-key": reviewKey,
        "if-match": created.headers.etag!,
      }),
      method: "POST",
      payload: review,
      url: `/akep/0.1/contributions/${encodeURIComponent(created.json().contributionId)}/decisions`,
    });
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.json().status).toBe("verified");
    const reviewedReplay = await app.inject({
      headers: headers("dev-curator", {
        "idempotency-key": reviewKey,
        "if-match": created.headers.etag!,
      }),
      method: "POST",
      payload: review,
      url: `/akep/0.1/contributions/${encodeURIComponent(created.json().contributionId)}/decisions`,
    });
    expect(reviewedReplay.statusCode).toBe(reviewed.statusCode);
    expect(reviewedReplay.json()).toEqual(reviewed.json());
    expect(reviewedReplay.headers.etag).toBe(reviewed.headers.etag);

    const publication = {
      akepVersion: "0.1",
      attestationRefs: [evaluated.json().attestationId],
      critical: [],
      decisionId: `urn:uuid:${randomUUID()}`,
      expectedPolicyEpoch: appConfig.policyEpoch,
      extensions: {},
      policyVersion: {
        digest: `sha256:${"b".repeat(64)}`,
        uri: "https://knowledge.test/policies/publication/1",
      },
      rationale: "Approved for the published support channel.",
    };
    const publishKey = `publish-${randomUUID()}`;
    const published = await app.inject({
      headers: headers("dev-publisher", {
        "idempotency-key": publishKey,
        "if-match": reviewed.headers.etag!,
      }),
      method: "POST",
      payload: publication,
      url: `/akep/0.1/contributions/${encodeURIComponent(created.json().contributionId)}/actions/publish`,
    });
    expect(published.statusCode).toBe(200);
    expect(published.json().status).toBe("accepted");
    const publishedReplay = await app.inject({
      headers: headers("dev-publisher", {
        "idempotency-key": publishKey,
        "if-match": reviewed.headers.etag!,
      }),
      method: "POST",
      payload: publication,
      url: `/akep/0.1/contributions/${encodeURIComponent(created.json().contributionId)}/actions/publish`,
    });
    expect(publishedReplay.statusCode).toBe(published.statusCode);
    expect(publishedReplay.json()).toEqual(published.json());
    expect(publishedReplay.headers.etag).toBe(published.headers.etag);

    const query = {
      critical: [],
      extensions: {},
      filters: { labels: [testLabel] },
      include: ["summary", "passages", "attestations"],
      limit: 10,
      mode: "lexical",
      purpose: "customer-support",
      query: { locale: "zh-CN", text: "退款超过 30 天" },
      spaces: [spaceId],
      supportedObligations: ["cite", "no-train"],
    };
    const queried = await app.inject({
      headers: headers("dev-reader"),
      method: "POST",
      payload: query,
      url: "/akep/0.1/queries",
    });
    expect(queried.statusCode).toBe(200);
    expect(queried.json().results).toHaveLength(1);
    const result = queried.json().results[0];
    expect(result.revisionId).toBe(revisionId);

    const unsupportedObligation = await app.inject({
      headers: headers("dev-reader"),
      method: "POST",
      payload: { ...query, supportedObligations: ["cite"] },
      url: "/akep/0.1/queries",
    });
    expect(unsupportedObligation.statusCode).toBe(200);
    expect(unsupportedObligation.json().results).toEqual([]);

    const obligationHeader = Buffer.from('["cite","no-train"]', "utf8").toString(
      "base64url",
    );
    const fetched = await app.inject({
      headers: headers("dev-reader", {
        "akep-obligation-support": obligationHeader,
        "akep-purpose": "customer-support",
      }),
      method: "GET",
      url: `/akep/0.1/spaces/${encodeURIComponent(spaceId)}/revisions/${encodeURIComponent(revisionId)}`,
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().manifest.title).toBe(manifest.title);
    expect(fetched.headers["akep-read-receipt"]).toMatch(/^urn:uuid:/);
    const revisionReceipt = await app.inject({
      headers: headers("dev-reader"),
      method: "GET",
      url: `/akep/0.1/exposure-receipts/${encodeURIComponent(String(fetched.headers["akep-read-receipt"]))}`,
    });
    expect(revisionReceipt.statusCode).toBe(200);
    expect(revisionReceipt.json().kind).toBe("revision_read");
    expect(revisionReceipt.json().citations[0].payloadDigest).toBe(
      sha256Digest(canonicalJson(manifest)),
    );

    const blob = await app.inject({
      headers: headers("dev-reader", {
        "akep-obligation-support": obligationHeader,
        "akep-purpose": "customer-support",
        range: "bytes=0-5",
      }),
      method: "GET",
      url: `/akep/0.1/spaces/${encodeURIComponent(spaceId)}/revisions/${encodeURIComponent(revisionId)}/blobs/${encodeURIComponent(digest)}`,
    });
    expect(blob.statusCode).toBe(206);
    expect(blob.rawPayload).toEqual(bytes.subarray(0, 6));
    const blobReceipt = await app.inject({
      headers: headers("dev-reader"),
      method: "GET",
      url: `/akep/0.1/exposure-receipts/${encodeURIComponent(String(blob.headers["akep-read-receipt"]))}`,
    });
    expect(blobReceipt.statusCode).toBe(200);
    expect(blobReceipt.json().kind).toBe("blob_read");
    expect(blobReceipt.json().citations[0].payloadDigest).toBe(digest);

    const usageCitation = {
      ...result.citations[0],
      influence: "primary",
      revisionId,
    };
    delete usageCitation.quote;
    delete usageCitation.chunkId;
    const usage = {
      akepVersion: "0.1",
      citations: [usageCitation],
      clientUsageId: `usage-${randomUUID()}`,
      critical: [],
      exposureReceiptId: queried.json().queryReceiptId,
      extensions: {},
      occurredAt: new Date().toISOString(),
      purpose: "customer-support",
      spaceId,
      taskCategory: "customer-support/refund",
    };
    const used = await app.inject({
      headers: headers("dev-reader", {
        "idempotency-key": `usage-${randomUUID()}`,
      }),
      method: "POST",
      payload: usage,
      url: "/akep/0.1/usages",
    });
    expect(used.statusCode).toBe(201);
    const usageLocation = new URL(used.headers.location!).pathname;
    const fetchedUsage = await app.inject({
      headers: headers("dev-reader"),
      method: "GET",
      url: usageLocation,
    });
    expect(fetchedUsage.statusCode).toBe(200);
    expect(fetchedUsage.json()).toEqual(used.json());
    const hiddenUsage = await app.inject({
      headers: headers("dev-contributor"),
      method: "GET",
      url: usageLocation,
    });
    expect(hiddenUsage.statusCode).toBe(404);

    const feedbackCitation = {
      citationId: usageCitation.citationId,
      locator: usageCitation.locator,
      outcome: "helped",
      payloadDigest: usageCitation.payloadDigest,
      revisionId,
    };
    const feedback = {
      akepVersion: "0.1",
      citations: [feedbackCitation],
      critical: [],
      evaluatorVersion: {
        digest: `sha256:${"c".repeat(64)}`,
        uri: "https://knowledge.test/evaluators/outcome/1",
      },
      evidenceRefs: [],
      extensions: {},
      feedbackId: `urn:uuid:${randomUUID()}`,
      observedAt: new Date().toISOString(),
      outcome: "helped",
      privacy: {
        aggregation: "pseudonymized",
        rawTaskStored: false,
      },
      taskCategory: "customer-support/refund",
      usageId: used.json().usageId,
    };
    const feedbackResponse = await app.inject({
      headers: headers("dev-reader", {
        "idempotency-key": `feedback-${randomUUID()}`,
      }),
      method: "POST",
      payload: feedback,
      url: "/akep/0.1/feedback",
    });
    expect(feedbackResponse.statusCode).toBe(202);
    expect(feedbackResponse.json().status).toBe("recorded");
    expect(feedbackResponse.json().correlationClass).toBe("same_organization");
    expect(feedbackResponse.json().eligibleForAggregation).toBe(true);

    const evidenceSummary = await app.inject({
      headers: headers("dev-console"),
      method: "GET",
      url: "/console/v1/evidence-summary",
    });
    expect(evidenceSummary.statusCode).toBe(200);
    expect(evidenceSummary.json().totals).toMatchObject({
      eligibleFeedback: evidenceBaseline.totals.eligibleFeedback + 1,
      feedback: evidenceBaseline.totals.feedback + 1,
      usage: evidenceBaseline.totals.usage + 1,
    });
    expect(evidenceSummary.json().outcomes.helped).toBe(
      evidenceBaseline.outcomes.helped + 1,
    );
    expect(evidenceSummary.json().revisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ helped: 1, revisionId, usage: 1 }),
      ]),
    );

    const revokeCandidate = await app.inject({
      headers: headers("dev-contributor", {
        "idempotency-key": `revoke-${randomUUID()}`,
      }),
      method: "POST",
      payload: {
        akepVersion: "0.1",
        clientSubmissionId: `revoke-${randomUUID()}`,
        critical: [],
        evidenceRefs: ["https://incidents.example/refund-policy-test"],
        extensions: {},
        kind: "revoke",
        rationale: "A safety incident invalidated this revision.",
        spaceId,
        targetRevisionId: revisionId,
      },
      url: "/akep/0.1/contributions",
    });
    expect(revokeCandidate.statusCode).toBe(201);
    const revokeReview = await app.inject({
      headers: headers("dev-curator", {
        "idempotency-key": `review-revoke-${randomUUID()}`,
        "if-match": revokeCandidate.headers.etag!,
      }),
      method: "POST",
      payload: {
        ...review,
        decisionId: `urn:uuid:${randomUUID()}`,
        rationale: "The incident evidence and target revision were verified.",
      },
      url: `/akep/0.1/contributions/${encodeURIComponent(revokeCandidate.json().contributionId)}/decisions`,
    });
    expect(revokeReview.statusCode).toBe(200);
    const revokeKey = `apply-revoke-${randomUUID()}`;
    const revokeDecision = {
      ...publication,
      decisionId: `urn:uuid:${randomUUID()}`,
      rationale: "Emergency revoke approved by the incident authority.",
    };
    const revoked = await app.inject({
      headers: headers("dev-incident", {
        "idempotency-key": revokeKey,
        "if-match": revokeReview.headers.etag!,
      }),
      method: "POST",
      payload: revokeDecision,
      url: `/akep/0.1/contributions/${encodeURIComponent(revokeCandidate.json().contributionId)}/actions/revoke`,
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().status).toBe("accepted");
    const revokedReplay = await app.inject({
      headers: headers("dev-incident", {
        "idempotency-key": revokeKey,
        "if-match": revokeReview.headers.etag!,
      }),
      method: "POST",
      payload: revokeDecision,
      url: `/akep/0.1/contributions/${encodeURIComponent(revokeCandidate.json().contributionId)}/actions/revoke`,
    });
    expect(revokedReplay.statusCode).toBe(revoked.statusCode);
    expect(revokedReplay.json()).toEqual(revoked.json());
    expect(revokedReplay.headers.etag).toBe(revoked.headers.etag);
    const revokeConflict = await app.inject({
      headers: headers("dev-incident", {
        "idempotency-key": revokeKey,
        "if-match": revokeReview.headers.etag!,
      }),
      method: "POST",
      payload: { ...revokeDecision, rationale: "A different lifecycle request." },
      url: `/akep/0.1/contributions/${encodeURIComponent(revokeCandidate.json().contributionId)}/actions/revoke`,
    });
    expect(revokeConflict.statusCode).toBe(409);
    expect(revokeConflict.json().code).toBe("AKEP_IDEMPOTENCY_CONFLICT");
    const revokedTombstone = await app.inject({
      headers: headers("dev-reader", {
        "akep-obligation-support": obligationHeader,
        "akep-purpose": "customer-support",
      }),
      method: "GET",
      url: `/akep/0.1/spaces/${encodeURIComponent(spaceId)}/records/${encodeURIComponent(manifest.recordId)}`,
    });
    expect(revokedTombstone.statusCode).toBe(200);
    expect(revokedTombstone.json().statuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "revoked", revisionId }),
      ]),
    );

    const eraseCandidate = await app.inject({
      headers: headers("dev-contributor", {
        "idempotency-key": `erase-after-revoke-${randomUUID()}`,
      }),
      method: "POST",
      payload: {
        akepVersion: "0.1",
        clientSubmissionId: `erase-after-revoke-${randomUUID()}`,
        critical: [],
        evidenceRefs: ["https://privacy.example/requests/refund-policy-test"],
        extensions: {},
        kind: "erase",
        rationale: "A verified privacy request requires physical content erasure.",
        spaceId,
        targetRevisionId: revisionId,
      },
      url: "/akep/0.1/contributions",
    });
    expect(eraseCandidate.statusCode).toBe(201);
    const eraseReview = await app.inject({
      headers: headers("dev-curator", {
        "idempotency-key": `review-erase-${randomUUID()}`,
        "if-match": eraseCandidate.headers.etag!,
      }),
      method: "POST",
      payload: {
        ...review,
        decisionId: `urn:uuid:${randomUUID()}`,
        rationale: "The privacy request and revoked target were verified for erasure.",
      },
      url: `/akep/0.1/contributions/${encodeURIComponent(eraseCandidate.json().contributionId)}/decisions`,
    });
    expect(eraseReview.statusCode).toBe(200);
    const failedErase = await app.inject({
      headers: headers("dev-eraser", {
        "idempotency-key": `apply-erase-stale-${randomUUID()}`,
        "if-match": '"stale-workflow"',
      }),
      method: "POST",
      payload: {
        ...publication,
        decisionId: `urn:uuid:${randomUUID()}`,
        rationale: "This stale erase must not purge any receipt.",
      },
      url: `/akep/0.1/contributions/${encodeURIComponent(eraseCandidate.json().contributionId)}/actions/erase`,
    });
    expect(failedErase.statusCode).toBe(412);
    const receiptAfterFailedErase = await app.inject({
      headers: headers("dev-reader"),
      method: "GET",
      url: `/akep/0.1/exposure-receipts/${encodeURIComponent(queried.json().queryReceiptId)}`,
    });
    // The prior revoke makes it unusable (410), but a failed erase must not
    // physically purge it (which would be 404).
    expect(receiptAfterFailedErase.statusCode).toBe(410);
    const erased = await app.inject({
      headers: headers("dev-eraser", {
        "idempotency-key": `apply-erase-${randomUUID()}`,
        "if-match": eraseReview.headers.etag!,
      }),
      method: "POST",
      payload: {
        ...publication,
        decisionId: `urn:uuid:${randomUUID()}`,
        rationale: "Erase approved by the independent privacy authority.",
      },
      url: `/akep/0.1/contributions/${encodeURIComponent(eraseCandidate.json().contributionId)}/actions/erase`,
    });
    expect(erased.statusCode).toBe(200);
    expect(erased.json().status).toBe("accepted");
    const erasedTombstone = await app.inject({
      headers: headers("dev-reader", {
        "akep-obligation-support": obligationHeader,
        "akep-purpose": "customer-support",
      }),
      method: "GET",
      url: `/akep/0.1/spaces/${encodeURIComponent(spaceId)}/records/${encodeURIComponent(manifest.recordId)}`,
    });
    expect(erasedTombstone.statusCode).toBe(200);
    expect(erasedTombstone.json().statuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "erased", revisionId }),
      ]),
    );
    expect(JSON.stringify(erasedTombstone.json())).not.toContain(manifest.title);
    const assetsAfterErase = await app.inject({
      headers: headers("dev-console"),
      method: "GET",
      url: "/console/v1/assets",
    });
    expect(assetsAfterErase.statusCode).toBe(200);
    expect(assetsAfterErase.json().assets).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ revisionId })]),
    );

    const staleReceipt = await app.inject({
      headers: headers("dev-reader"),
      method: "GET",
      url: `/akep/0.1/exposure-receipts/${encodeURIComponent(queried.json().queryReceiptId)}`,
    });
    expect(staleReceipt.statusCode).toBe(404);

    const afterErase = await app.inject({
      headers: headers("dev-reader"),
      method: "POST",
      payload: query,
      url: "/akep/0.1/queries",
    });
    expect(afterErase.statusCode).toBe(200);
    expect(afterErase.json().results).toEqual([]);

    if (process.env.TEST_DATABASE_URL !== undefined) {
      const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
      try {
        const projection = await pool.query<{ readonly status: string }>(
          `select status from query.knowledge_projection
            where space_id = $1 and revision_id = $2`,
          [spaceId, revisionId],
        );
        const outbox = await pool.query<{ readonly count: string }>(
          `select count(*)::text as count from platform.outbox_event
            where aggregate_id = $1`,
          [revisionId],
        );
        const evidence = await pool.query<{ readonly count: string }>(
          `select count(*)::text as count from evaluation.feedback_evidence
            where usage_id = $1`,
          [used.json().usageId],
        );
        const chunks = await pool.query<{ readonly count: string }>(
          `select count(*)::text as count from query.chunk_projection
            where space_id = $1 and revision_id = $2`,
          [spaceId, revisionId],
        );
        const revisionBlobs = await pool.query<{ readonly count: string }>(
          `select count(*)::text as count from catalog.revision_blob
            where space_id = $1 and revision_id = $2`,
          [spaceId, revisionId],
        );
        expect(projection.rows[0]?.status).toBe("erased");
        expect(Number(chunks.rows[0]?.count)).toBe(0);
        expect(Number(revisionBlobs.rows[0]?.count)).toBe(0);
        expect(Number(outbox.rows[0]?.count)).toBeGreaterThanOrEqual(2);
        expect(Number(evidence.rows[0]?.count)).toBe(0);
      } finally {
        await pool.end();
      }
    }
    await app.close();
  });
});
