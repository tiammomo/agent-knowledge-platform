import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../../config.js";
import type { ContractRegistry } from "../../contracts/registry.js";
import { canonicalJson, sha256Digest } from "../../contracts/revision.js";
import { authenticate, authenticateAny, type Principal } from "../../platform/auth.js";
import {
  requireAKEPVersion,
  requireIdempotencyKey,
  requireObligationSupport,
  requirePurpose,
} from "../../platform/headers.js";
import { ProblemError } from "../../platform/problem.js";
import type { GrowthStore } from "../growth/store.js";
import {
  canConsume,
  hasSpaceAccess,
  supportedProfiles,
  type SupportedProfile,
} from "../growth/validation.js";
import { evaluateAttestationGate } from "./quality-gate.js";
import type {
  AttestationState,
  AttestationStatement,
  EvaluationRun,
  EvaluationRunState,
} from "./types.js";
import {
  computeEvaluationGate,
  parseEvaluationRunRequest,
} from "./validation.js";

interface EvaluationDependencies {
  readonly config: AppConfig;
  readonly contracts: ContractRegistry;
  readonly growth: GrowthStore;
}

export async function registerEvaluationRoutes(
  app: FastifyInstance,
  dependencies: EvaluationDependencies,
): Promise<void> {
  const { config, contracts, growth } = dependencies;
  const profiles = supportedProfiles(config);

  app.post<{ Body: unknown; Params: { spaceId: string } }>(
    "/spaces/:spaceId/attestations",
    async (request, reply) => {
      requireAKEPVersion(request);
      const principal = authenticateAny(request, [
        "akep:evaluate",
        "akep:review",
        "akep:publish",
      ]);
      requireSpaceWrite(principal, request.params.spaceId);
      const idempotencyKey = requireIdempotencyKey(request);
      contracts.assert("attestation.schema.json", request.body);
      const statement = request.body as AttestationStatement;
      requireNoCritical(statement.critical);
      requireAttestationRole(principal, statement.type);
      if (statement.issuer !== principal.subject) {
        throw new ProblemError(
          403,
          "AKEP_ATTESTATION_ISSUER_MISMATCH",
          "An unsigned development Attestation can only be issued as the authenticated principal.",
        );
      }
      if (statement.type === "benchmark-result") {
        throw new ProblemError(
          422,
          "AKEP_EVALUATION_RUN_REQUIRED",
          "benchmark-result Attestations can only be created by a completed EvaluationRun.",
        );
      }
      if (statement.type === "schema-validation" || statement.type === "safety-scan") {
        throw new ProblemError(
          422,
          "AKEP_MACHINE_ATTESTATION_RESERVED",
          `${statement.type} Attestations are emitted only by the node after executing the corresponding validation.`,
        );
      }
      validateAttestationPeriod(statement);
      const target = await requireRevisionTarget(
        growth,
        request.params.spaceId,
        statement.subject.revisionId,
      );
      if (
        statement.subject.payloadDigest !== undefined &&
        !target.payloadDigests.has(statement.subject.payloadDigest)
      ) {
        throw new ProblemError(
          409,
          "AKEP_ATTESTATION_TARGET_MISMATCH",
          "The Attestation payloadDigest does not belong to the target Revision.",
        );
      }
      const state = attestationState(
        request.params.spaceId,
        statement,
        principal,
        idempotencyKey,
      );
      const result = await growth.createAttestation(state);
      if (!result.created && result.value.documentDigest !== state.documentDigest) {
        throw new ProblemError(
          409,
          "AKEP_IDEMPOTENCY_CONFLICT",
          "The Attestation identifier or Idempotency-Key is bound to different evidence.",
        );
      }
      return sendCreatedAttestation(reply, config, result.value);
    },
  );

  app.get<{ Params: { attestationId: string; spaceId: string } }>(
    "/spaces/:spaceId/attestations/:attestationId",
    async (request, reply) => {
      requireAKEPVersion(request);
      const principal = authenticateAny(request, [
        "akep:read",
        "akep:review",
        "akep:publish",
      ]);
      const purpose = requirePurpose(request);
      const supportedObligations = principal.scopes.has("akep:review") ||
        principal.scopes.has("akep:publish")
        ? []
        : requireObligationSupport(request, contracts);
      const state = await growth.getAttestation(
        request.params.spaceId,
        request.params.attestationId,
      );
      if (state === undefined) throw evidenceNotFound();
      await enforceEvidenceVisibility(
        growth,
        principal,
        purpose,
        state.spaceId,
        state.statement.subject.revisionId,
        supportedObligations,
        profiles,
        config.nodeId,
      );
      return sendEvidence(reply, config, state.documentDigest, state.statement);
    },
  );

  app.post<{ Body: unknown }>("/evaluation-runs", async (request, reply) => {
    requireAKEPVersion(request);
    const principal = authenticate(request, "akep:evaluate");
    const idempotencyKey = requireIdempotencyKey(request);
    const body = parseEvaluationRunRequest(request.body);
    requireSpaceWrite(principal, body.spaceId);
    await requireRevisionTarget(growth, body.spaceId, body.revisionId);
    const gate = computeEvaluationGate(body.metrics, body.thresholds);
    const now = new Date().toISOString();
    const runId = `urn:uuid:${randomUUID()}`;
    const attestationId = `urn:uuid:${randomUUID()}`;
    const run: EvaluationRun = {
      attestationId,
      clientRunId: body.clientRunId,
      completedAt: body.completedAt,
      critical: [],
      dataset: body.dataset,
      evaluationRunVersion: "0.1",
      evaluator: body.evaluator,
      evidenceRefs: body.evidenceRefs,
      gate,
      metrics: body.metrics,
      runId,
      spaceId: body.spaceId,
      startedAt: body.startedAt,
      status: "completed",
      subject: { revisionId: body.revisionId },
      thresholds: body.thresholds,
    };
    const runUrl = `${config.baseUrl}/evaluation-runs/${encodeURIComponent(runId)}`;
    const attestation: AttestationStatement = {
      attestationVersion: "0.1",
      attestationId,
      critical: [],
      evidenceRefs: [...new Set([...body.evidenceRefs, body.dataset.uri, runUrl])],
      expiresAt: body.expiresAt,
      issuedAt: now,
      issuer: principal.subject,
      method: body.evaluator,
      result: {
        findings: gate.checks
          .filter((check) => !check.passed)
          .map((check) => ({
            code: `evaluation.${check.metric}`.slice(0, 128),
            message: `${check.actual} did not satisfy ${check.operator} ${check.threshold}.`,
            severity: check.required ? "high" as const : "medium" as const,
          })),
        metrics: body.metrics,
        outcome: gate.outcome,
        summary: body.summary,
      },
      subject: { revisionId: body.revisionId },
      type: "benchmark-result",
    };
    contracts.assert("attestation.schema.json", attestation);
    const runState: EvaluationRunState = {
      createdAt: now,
      documentDigest: sha256Digest(canonicalJson(run)),
      idempotencyKey,
      issuerSubjectDigest: principal.subjectDigest,
      requestDigest: sha256Digest(canonicalJson(request.body)),
      run,
    };
    const evidenceState = attestationState(
      body.spaceId,
      attestation,
      principal,
      `evaluation:${idempotencyKey}`,
    );
    const result = await growth.createEvaluationRun(runState, evidenceState);
    if (!result.created && result.value.requestDigest !== runState.requestDigest) {
      throw new ProblemError(
        409,
        "AKEP_IDEMPOTENCY_CONFLICT",
        "The EvaluationRun client identifier or Idempotency-Key is bound to another request.",
      );
    }
    privateHeaders(reply, config);
    reply
      .code(201)
      .header(
        "Location",
        `${config.baseUrl}/evaluation-runs/${encodeURIComponent(result.value.run.runId)}`,
      )
      .header("ETag", evidenceEtag(result.value.documentDigest));
    return reply.send(result.value.run);
  });

  app.get<{ Params: { runId: string } }>(
    "/evaluation-runs/:runId",
    async (request, reply) => {
      requireAKEPVersion(request);
      const principal = authenticateAny(request, [
        "akep:read",
        "akep:review",
        "akep:publish",
      ]);
      const purpose = requirePurpose(request);
      const supportedObligations = principal.scopes.has("akep:review") ||
        principal.scopes.has("akep:publish")
        ? []
        : requireObligationSupport(request, contracts);
      const state = await growth.getEvaluationRun(request.params.runId);
      if (state === undefined) throw evidenceNotFound();
      await enforceEvidenceVisibility(
        growth,
        principal,
        purpose,
        state.run.spaceId,
        state.run.subject.revisionId,
        supportedObligations,
        profiles,
        config.nodeId,
      );
      return sendEvidence(reply, config, state.documentDigest, state.run);
    },
  );
}

function attestationState(
  spaceId: string,
  statement: AttestationStatement,
  principal: Principal,
  idempotencyKey: string,
): AttestationState {
  return {
    createdAt: new Date().toISOString(),
    documentDigest: sha256Digest(canonicalJson(statement)),
    idempotencyKey,
    issuerSubjectDigest: principal.subjectDigest,
    spaceId,
    statement,
  };
}

function validateAttestationPeriod(statement: AttestationStatement): void {
  const issuedAt = Date.parse(statement.issuedAt);
  const expiresAt = Date.parse(statement.expiresAt);
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    issuedAt > Date.now() + 5 * 60_000 ||
    expiresAt <= Date.now() ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > 90 * 24 * 60 * 60_000
  ) {
    throw new ProblemError(
      422,
      "AKEP_ATTESTATION_PERIOD_INVALID",
      "The Attestation must already be issued, remain unexpired, and have a validity period of at most 90 days.",
    );
  }
}

async function requireRevisionTarget(
  growth: GrowthStore,
  spaceId: string,
  revisionId: string,
): Promise<{ readonly payloadDigests: ReadonlySet<string> }> {
  const contributions = await growth.listContributions();
  const contribution = contributions.find(
    (item) =>
      item.request.spaceId === spaceId &&
      item.receipt.subjectRevisionId === revisionId &&
      (item.request.kind === "create" || item.request.kind === "revise"),
  );
  const published = await growth.getPublishedRevision(spaceId, revisionId);
  if (contribution === undefined && published === undefined) {
    throw new ProblemError(
      404,
      "AKEP_REVISION_NOT_FOUND",
      "The target Revision does not exist in this Space.",
    );
  }
  const descriptors =
    contribution?.request.manifest?.payloads ?? published?.manifest.payloads ?? [];
  return { payloadDigests: new Set(descriptors.map((payload) => payload.digest)) };
}

async function enforceEvidenceVisibility(
  growth: GrowthStore,
  principal: Principal,
  purpose: string,
  spaceId: string,
  revisionId: string,
  supportedObligations: readonly unknown[],
  profiles: ReadonlyMap<string, SupportedProfile>,
  trustedMachineIssuer: string,
): Promise<void> {
  if (!hasSpaceAccess(principal, spaceId)) throw evidenceNotFound();
  if (principal.scopes.has("akep:review") || principal.scopes.has("akep:publish")) {
    return;
  }
  const asset = await growth.getPublishedRevision(spaceId, revisionId);
  if (
    asset === undefined ||
    !["published", "superseded", "deprecated"].includes(asset.status) ||
    !canConsume(asset, purpose, supportedObligations, principal)
  ) {
    throw evidenceNotFound();
  }
  try {
    await evaluateAttestationGate(
      growth,
      asset.spaceId,
      asset.revisionId,
      asset.qualityAttestationRefs,
      {
        expectedPayloadDigests: new Set(
          asset.manifest.payloads.map((payload) => payload.digest),
        ),
        requireBenchmark: false,
        requiredTypes: profiles.get(asset.manifest.profile.uri)?.document.requiredAttestations ?? [],
        trustedMachineIssuer,
      },
    );
  } catch {
    throw evidenceNotFound();
  }
}

function requireSpaceWrite(principal: Principal, spaceId: string): void {
  if (!hasSpaceAccess(principal, spaceId)) {
    throw new ProblemError(
      403,
      "AKEP_POLICY_DENIED",
      "The caller is not authorized for the target Space.",
    );
  }
}

function requireAttestationRole(principal: Principal, type: string): void {
  const requiredScope = ["human-review", "provenance-validation", "license-review"].includes(type)
    ? "akep:review"
    : type === "policy-approval"
      ? "akep:publish"
      : "akep:evaluate";
  if (!principal.scopes.has(requiredScope)) {
    throw new ProblemError(
      403,
      "AKEP_DUTY_SEPARATION_REQUIRED",
      `Attestation type ${type} requires ${requiredScope}.`,
    );
  }
}

function sendCreatedAttestation(
  reply: FastifyReply,
  config: AppConfig,
  state: AttestationState,
): FastifyReply {
  privateHeaders(reply, config);
  reply
    .code(201)
    .header(
      "Location",
      `${config.baseUrl}/spaces/${encodeURIComponent(state.spaceId)}/attestations/${encodeURIComponent(state.statement.attestationId)}`,
    )
    .header("ETag", evidenceEtag(state.documentDigest));
  return reply.send(state.statement);
}

function sendEvidence(
  reply: FastifyReply,
  config: AppConfig,
  digest: string,
  document: unknown,
): FastifyReply {
  reply
    .code(200)
    .header("AKEP-Version", "0.1")
    .header("AKEP-Policy-Epoch", config.policyEpoch)
    .header("Cache-Control", "private, no-cache")
    .header("Vary", "Authorization, AKEP-Purpose, AKEP-Obligation-Support")
    .header("ETag", evidenceEtag(digest));
  return reply.send(document);
}

function privateHeaders(reply: FastifyReply, config: AppConfig): void {
  reply
    .header("AKEP-Version", "0.1")
    .header("AKEP-Policy-Epoch", config.policyEpoch)
    .header("Cache-Control", "private, no-store");
}

function evidenceEtag(digest: string): string {
  return `"akep-evidence-${digest.slice("sha256:".length)}"`;
}

function requireNoCritical(critical: readonly string[]): void {
  if (critical.length !== 0) {
    throw new ProblemError(
      422,
      "AKEP_UNSUPPORTED_CRITICAL_EXTENSION",
      "Critical extensions are not supported by this node.",
    );
  }
}

function evidenceNotFound(): ProblemError {
  return new ProblemError(404, "AKEP_EVIDENCE_NOT_FOUND", "The evidence was not found.");
}
