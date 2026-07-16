import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../../config.js";
import type { ContractRegistry } from "../../contracts/registry.js";
import { canonicalJson, sha256Digest } from "../../contracts/revision.js";
import type { ExposureReceiptStore } from "../query/exposure-receipt-store.js";
import { evaluateAttestationGate } from "../evaluation/quality-gate.js";
import type {
  AttestationState,
  AttestationStatement,
} from "../evaluation/types.js";
import { authenticate, authenticateAny, type Principal } from "../../platform/auth.js";
import {
  requireAKEPVersion,
  requireIdempotencyKey,
  requireIfMatch,
} from "../../platform/headers.js";
import { ProblemError } from "../../platform/problem.js";
import {
  scanContributionContent,
  type ContributionContentScan,
} from "./content-scan.js";
import type {
  GrowthStore,
  WorkflowMutationKey,
  WorkflowMutationRecord,
  WorkflowMutationResult,
} from "./store.js";
import {
  contributionEtag,
  type ContributionRequest,
  type ContributionState,
  type ContributionStatus,
  type FeedbackState,
  type LifecycleEvent,
  type PublishedAsset,
  type SchemaReference,
  type UsageState,
} from "./types.js";
import {
  canConsume,
  hasSpaceAccess,
  sanitizedContributionRequest,
  supportedProfiles,
  type ProfileDocument,
  validateContribution,
} from "./validation.js";

interface GrowthDependencies {
  readonly config: AppConfig;
  readonly contracts: ContractRegistry;
  readonly growth: GrowthStore;
  readonly receipts: ExposureReceiptStore;
}

export async function registerGrowthRoutes(
  app: FastifyInstance,
  dependencies: GrowthDependencies,
): Promise<void> {
  const { config, contracts, growth, receipts } = dependencies;
  const profiles = supportedProfiles(config);

  app.post<{ Body: unknown }>("/contributions", async (request, reply) => {
    requireAKEPVersion(request);
    const principal = authenticate(request, "akep:contribute");
    const idempotencyKey = requireIdempotencyKey(request);
    contracts.assert("contribution.schema.json", request.body);
    requireNoCritical(request.body);
    const body = request.body as ContributionRequest;
    enforceSpaceAccess(principal, body.spaceId);
    const validated = validateContribution(body, profiles);
    const contentScan = scanContributionContent(body);
    const now = new Date().toISOString();
    const contributionId = `urn:uuid:${randomUUID()}`;
    const receipt = {
      contributionId,
      createdAt: now,
      kind: body.kind,
      policyEpoch: config.policyEpoch,
      spaceId: body.spaceId,
      status: contentScan.verdict === "quarantined"
        ? "quarantined" as const
        : "candidate" as const,
      statusUrl: `${config.baseUrl}/contributions/${encodeURIComponent(contributionId)}`,
      subjectRevisionId: validated.subjectRevisionId,
      ...(["create", "revise"].includes(body.kind)
        ? { submittedRevisionId: validated.subjectRevisionId }
        : {}),
    };
    const state: ContributionState = {
      amendments: body.kind === "create" || body.kind === "revise"
        ? [{
            kind: "content-scan",
            recordedAt: now,
            ...contentScan,
          }]
        : [],
      createdAt: now,
      idempotencyKey,
      // High-risk bytes never enter the shared workflow store or console API.
      // The immutable Manifest digest and non-secret finding metadata remain as
      // an audit trail while a dedicated encrypted quarantine store is closed.
      payloads: contentScan.verdict === "quarantined" ? [] : validated.payloads,
      receipt,
      request: sanitizedContributionRequest(body),
      requestDigest: sha256Digest(canonicalJson(body)),
      subjectDigest: principal.subjectDigest,
      updatedAt: now,
      workflowVersion: 1,
    };
    contracts.assert("contribution-receipt.schema.json", receipt);
    const result = await growth.createContribution(state);
    if (!result.created && result.value.requestDigest !== state.requestDigest) {
      throw new ProblemError(
        409,
        "AKEP_IDEMPOTENCY_CONFLICT",
        "The Idempotency-Key was already used for a different contribution.",
      );
    }
    return sendContribution(reply, contracts, result.value, 201);
  });

  app.get<{ Params: { contributionId: string } }>(
    "/contributions/:contributionId",
    async (request, reply) => {
      requireAKEPVersion(request);
      const principal = authenticateAny(request, [
        "akep:contribute",
        "akep:review",
        "akep:publish",
        "akep:incident",
        "akep:erase",
      ]);
      const state = await requireContribution(growth, request.params.contributionId);
      enforceSpaceAccess(principal, state.request.spaceId);
      enforceContributionVisibility(principal, state);
      return sendContribution(reply, contracts, state, 200);
    },
  );

  app.post<{ Body: unknown; Params: { contributionId: string } }>(
    "/contributions/:contributionId/evidence",
    async (request, reply) => {
      requireAKEPVersion(request);
      const principal = authenticate(request, "akep:contribute");
      const idempotencyKey = requireIdempotencyKey(request);
      const ifMatch = requireIfMatch(request);
      contracts.assert("contribution-amendment.schema.json", request.body);
      requireNoCritical(request.body);
      const current = await requireContribution(growth, request.params.contributionId);
      enforceSpaceAccess(principal, current.request.spaceId);
      enforceOwner(principal, current);
      const mutationKey = workflowMutationKey(
        principal,
        workflowOperation(request.params.contributionId, "evidence"),
        idempotencyKey,
        request.body,
      );
      const replay = await workflowReplay(growth, mutationKey);
      if (replay !== undefined) {
        return sendWorkflowMutation(reply, contracts, replay);
      }
      requireMatchingEtag(current, ifMatch);
      if (current.receipt.status !== "needs_evidence") {
        throw workflowConflict("Only a needs_evidence contribution can be amended.");
      }
      const body = request.body as Record<string, unknown>;
      const amendmentId = body.amendmentId as string;
      const existing = current.amendments.find((item) => item.amendmentId === amendmentId);
      if (existing !== undefined) {
        if (canonicalJson(existing) !== canonicalJson(body)) {
          throw workflowConflict("The amendmentId was already used with different evidence.");
        }
        const result = await growth.updateContribution(
          current.receipt.contributionId,
          current.workflowVersion,
          current,
          workflowMutationRecord(mutationKey, current),
        );
        return sendWorkflowMutation(
          reply,
          contracts,
          requireWorkflowMutationResult(result),
        );
      }
      const next = transition(current, "candidate", {
        amendments: [...current.amendments, body],
      });
      const record = await requireWorkflowUpdate(
        growth,
        current,
        next,
        workflowMutationRecord(mutationKey, next),
      );
      return sendWorkflowMutation(reply, contracts, record);
    },
  );

  app.post<{ Body: unknown; Params: { contributionId: string } }>(
    "/contributions/:contributionId/withdraw",
    async (request, reply) => {
      requireAKEPVersion(request);
      const principal = authenticate(request, "akep:contribute");
      const idempotencyKey = requireIdempotencyKey(request);
      const ifMatch = requireIfMatch(request);
      contracts.assert("contribution-withdrawal.schema.json", request.body);
      requireNoCritical(request.body);
      const current = await requireContribution(growth, request.params.contributionId);
      enforceSpaceAccess(principal, current.request.spaceId);
      enforceOwner(principal, current);
      const mutationKey = workflowMutationKey(
        principal,
        workflowOperation(request.params.contributionId, "withdraw"),
        idempotencyKey,
        request.body,
      );
      const replay = await workflowReplay(growth, mutationKey);
      if (replay !== undefined) {
        return sendWorkflowMutation(reply, contracts, replay);
      }
      requireMatchingEtag(current, ifMatch);
      if (["accepted", "rejected", "withdrawn"].includes(current.receipt.status)) {
        throw workflowConflict("A terminal contribution cannot be withdrawn.");
      }
      const next = transition(current, "withdrawn", {
        amendments: [
          ...current.amendments,
          { kind: "withdrawal", ...(request.body as Record<string, unknown>) },
        ],
      });
      const record = await requireWorkflowUpdate(
        growth,
        current,
        next,
        workflowMutationRecord(mutationKey, next),
      );
      return sendWorkflowMutation(reply, contracts, record);
    },
  );

  app.post<{ Body: unknown; Params: { contributionId: string } }>(
    "/contributions/:contributionId/decisions",
    async (request, reply) => {
      requireAKEPVersion(request);
      const principal = authenticate(request, "akep:review");
      const idempotencyKey = requireIdempotencyKey(request);
      const ifMatch = requireIfMatch(request);
      contracts.assert("decision.schema.json", request.body);
      requireNoCritical(request.body);
      const current = await requireContribution(growth, request.params.contributionId);
      enforceSpaceAccess(principal, current.request.spaceId);
      if (principal.subjectDigest === current.subjectDigest) {
        throw new ProblemError(
          403,
          "AKEP_REVIEWER_CONFLICT",
          "A contributor cannot independently review their own Contribution.",
        );
      }
      const mutationKey = workflowMutationKey(
        principal,
        workflowOperation(request.params.contributionId, "review"),
        idempotencyKey,
        request.body,
      );
      const replay = await workflowReplay(growth, mutationKey);
      if (replay !== undefined) {
        return sendWorkflowMutation(reply, contracts, replay);
      }
      requireMatchingEtag(current, ifMatch);
      if (!['candidate', 'needs_evidence'].includes(current.receipt.status)) {
        throw workflowConflict("This contribution is not awaiting a review decision.");
      }
      let decision = request.body as Record<string, unknown>;
      if (
        decision.decision === "verify" &&
        ["deprecate", "revoke", "erase"].includes(current.request.kind)
      ) {
        const target = await growth.getPublishedRevision(
          current.request.spaceId,
          current.receipt.subjectRevisionId,
        );
        if (
          target === undefined ||
          target.status === "erased" ||
          (target.status === "revoked" && current.request.kind !== "erase")
        ) {
          throw workflowConflict("The lifecycle target is not an actionable published revision.");
        }
      }
      if (decision.decision === "verify") {
        const target = ["create", "revise"].includes(current.request.kind)
          ? current.request.manifest
          : (await growth.getPublishedRevision(
              current.request.spaceId,
              current.receipt.subjectRevisionId,
            ))?.manifest;
        if (target === undefined) {
          throw workflowConflict("The Attestation target Revision is not available.");
        }
        const profile = profiles.get(target.profile.uri)?.document;
        const generatedRefs = ["create", "revise"].includes(current.request.kind)
          ? await createRequiredReviewAttestations(
              growth,
              contracts,
              config,
              current,
              decision,
              principal,
              profile,
            )
          : [];
        const attestationRefs = [
          ...new Set([
            ...(decision.attestationRefs as readonly string[]),
            ...generatedRefs,
          ]),
        ];
        decision = { ...decision, attestationRefs };
        await evaluateAttestationGate(
          growth,
          current.request.spaceId,
          current.receipt.subjectRevisionId,
          attestationRefs,
          {
            expectedPayloadDigests: new Set(
              target.payloads.map((payload) => payload.digest),
            ),
            requireBenchmark: false,
            requiredTypes: profile === undefined || !["create", "revise"].includes(current.request.kind)
              ? []
              : profile.requiredAttestations.filter((type) => type !== "policy-approval"),
            trustedMachineIssuer: config.nodeId,
          },
        );
      }
      const status = reviewStatus(decision.decision as string);
      const next = transition(current, status, {
        reviewDecision: decision,
        decisionRefs: [
          ...(current.receipt.decisionRefs ?? []),
          decision.decisionId as string,
        ],
      });
      const record = await requireWorkflowUpdate(
        growth,
        current,
        next,
        workflowMutationRecord(mutationKey, next),
      );
      return sendWorkflowMutation(reply, contracts, record);
    },
  );

  app.post<{ Body: unknown; Params: { contributionId: string } }>(
    "/contributions/:contributionId/actions/publish",
    async (request, reply) => {
      requireAKEPVersion(request);
      const principal = authenticate(request, "akep:publish");
      const idempotencyKey = requireIdempotencyKey(request);
      const ifMatch = requireIfMatch(request);
      contracts.assert("publication-decision.schema.json", request.body);
      requireNoCritical(request.body);
      const current = await requireContribution(growth, request.params.contributionId);
      enforceSpaceAccess(principal, current.request.spaceId);
      const mutationKey = workflowMutationKey(
        principal,
        workflowOperation(request.params.contributionId, "publish"),
        idempotencyKey,
        request.body,
      );
      const replay = await workflowReplay(growth, mutationKey);
      if (replay !== undefined) {
        return sendWorkflowMutation(reply, contracts, replay);
      }
      requireMatchingEtag(current, ifMatch);
      requirePublishable(current, ["create", "revise"]);
      const decision = request.body as Record<string, unknown>;
      requirePolicyEpoch(config, decision);
      const manifest = current.request.manifest!;
      if (current.request.kind === "revise") {
        for (const base of current.request.baseRevisionIds ?? []) {
          const parent = await growth.getPublishedRevision(current.request.spaceId, base);
          if (parent === undefined || parent.manifest.recordId !== manifest.recordId) {
            throw workflowConflict("Every base revision must be a published revision of this record.");
          }
        }
      }
      const review = current.reviewDecision!;
      await requireIndependentAttester(
        growth,
        current.request.spaceId,
        review.attestationRefs as readonly string[],
        principal,
      );
      const profile = profiles.get(manifest.profile.uri)?.document;
      if (profile === undefined) {
        throw workflowConflict("The immutable Profile is no longer enabled on this node.");
      }
      const policyRefs = await createRequiredPolicyAttestations(
        growth,
        contracts,
        config,
        current,
        decision,
        principal,
        profile,
      );
      const qualityRefs = [
        ...new Set([
          ...(review.attestationRefs as readonly string[]),
          ...(decision.attestationRefs as readonly string[]),
          ...policyRefs,
        ]),
      ];
      const quality = await evaluateAttestationGate(
        growth,
        current.request.spaceId,
        current.receipt.subjectRevisionId,
        qualityRefs,
        {
          expectedPayloadDigests: new Set(
            manifest.payloads.map((payload) => payload.digest),
          ),
          requireBenchmark: false,
          requiredTypes: profile.requiredAttestations,
          trustedMachineIssuer: config.nodeId,
        },
      );
      const effectiveDecision = { ...decision, attestationRefs: qualityRefs };
      const next = transition(current, "accepted", {
        decisionRefs: [
          ...(current.receipt.decisionRefs ?? []),
          decision.decisionId as string,
        ],
      });
      const event = publicationEvent(
        config,
        principal,
        current,
        effectiveDecision,
        manifest.recordId,
      );
      const asset: PublishedAsset = {
        indexedAt: event.occurredAt,
        manifest,
        payloads: current.payloads,
        publicationEvent: event,
        qualityAttestationRefs: quality.attestationRefs,
        qualityDecision: quality.decision,
        qualityReasons: quality.reasons,
        revisionId: current.receipt.subjectRevisionId,
        sourceContributionId: current.receipt.contributionId,
        spaceId: current.request.spaceId,
        status: "published",
      };
      contracts.assert("lifecycle-event.schema.json", event);
      const existingRevision = await growth.getPublishedRevision(
        current.request.spaceId,
        current.receipt.subjectRevisionId,
      );
      if (existingRevision !== undefined) {
        throw workflowConflict("This revision has already been published.");
      }
      const updated = await growth.publishContribution(
        current.receipt.contributionId,
        current.workflowVersion,
        next,
        asset,
        workflowMutationRecord(mutationKey, next),
      );
      return sendWorkflowMutation(
        reply,
        contracts,
        requireWorkflowMutationResult(updated),
      );
    },
  );

  for (const action of ["deprecate", "revoke", "erase"] as const) {
    app.post<{ Body: unknown; Params: { contributionId: string } }>(
      `/contributions/:contributionId/actions/${action}`,
      async (request, reply) => {
        requireAKEPVersion(request);
        const scope =
          action === "revoke"
            ? "akep:incident"
            : action === "erase"
              ? "akep:erase"
              : "akep:publish";
        const principal = authenticate(request, scope);
        const idempotencyKey = requireIdempotencyKey(request);
        const ifMatch = requireIfMatch(request);
        contracts.assert("publication-decision.schema.json", request.body);
        requireNoCritical(request.body);
        const current = await requireContribution(growth, request.params.contributionId);
        enforceSpaceAccess(principal, current.request.spaceId);
        const mutationKey = workflowMutationKey(
          principal,
          workflowOperation(request.params.contributionId, action),
          idempotencyKey,
          request.body,
        );
        const replay = await workflowReplay(growth, mutationKey);
        if (replay !== undefined) {
          return sendWorkflowMutation(reply, contracts, replay);
        }
        requireMatchingEtag(current, ifMatch);
        requirePublishable(current, [action]);
        const decision = request.body as Record<string, unknown>;
        requirePolicyEpoch(config, decision);
        const target = await growth.getPublishedRevision(
          current.request.spaceId,
          current.receipt.subjectRevisionId,
        );
        if (
          target === undefined ||
          target.status === "erased" ||
          (target.status === "revoked" && action !== "erase")
        ) {
          throw workflowConflict("The target revision is not actionable.");
        }
        const reviewRefs = current.reviewDecision?.attestationRefs as
          | readonly string[]
          | undefined;
        if (reviewRefs === undefined) {
          throw workflowConflict("The lifecycle action has no review evidence.");
        }
        await requireIndependentAttester(
          growth,
          current.request.spaceId,
          reviewRefs,
          principal,
        );
        await evaluateAttestationGate(
          growth,
          current.request.spaceId,
          target.revisionId,
          [
            ...new Set([
              ...reviewRefs,
              ...(decision.attestationRefs as readonly string[]),
            ]),
          ],
          {
            expectedPayloadDigests: new Set(
              target.manifest.payloads.map((payload) => payload.digest),
            ),
            requireBenchmark: false,
          },
        );
        const next = transition(current, "accepted", {
          decisionRefs: [
            ...(current.receipt.decisionRefs ?? []),
            decision.decisionId as string,
          ],
        });
        const event = statusEvent(config, principal, current, decision, target, action);
        contracts.assert("lifecycle-event.schema.json", event);
        const updated = await growth.applyLifecycleAction(
          current.receipt.contributionId,
          current.workflowVersion,
          next,
          target.revisionId,
          event,
          workflowMutationRecord(mutationKey, next),
        );
        const mutation = requireWorkflowMutationResult(updated);
        // PostgreSQL purges receipts inside the same lifecycle transaction.
        // This post-commit call supplies the equivalent behavior for the
        // in-memory store and is intentionally never run before the status
        // transition succeeds.
        if (action === "erase" && !receipts.eraseIntegratedWithLifecycle) {
          await receipts.eraseRevision(current.request.spaceId, target.revisionId);
        }
        return sendWorkflowMutation(
          reply,
          contracts,
          mutation,
        );
      },
    );
  }

  app.post<{ Body: unknown }>("/usages", async (request, reply) => {
    requireAKEPVersion(request);
    const principal = authenticate(request, "akep:feedback");
    const idempotencyKey = requireIdempotencyKey(request);
    contracts.assert("usage.schema.json", request.body);
    requireNoCritical(request.body);
    const body = request.body as Record<string, unknown>;
    enforceSpaceAccess(principal, body.spaceId as string);
    const exposure = await receipts.get(body.exposureReceiptId as string);
    if (
      exposure === undefined ||
      exposure.subjectPseudonym !== principal.subjectDigest ||
      exposure.policyEpoch !== config.policyEpoch ||
      Date.parse(exposure.expiresAt) <= Date.now() ||
      !(await citationsAreCurrent(
        growth,
        exposure.citations,
        principal,
        exposure.purpose,
        exposure.obligations,
      ))
    ) {
      throw new ProblemError(403, "AKEP_EXPOSURE_INVALID", "The exposure receipt is not usable.");
    }
    if (body.purpose !== exposure.purpose || !exposure.spaceIds.includes(body.spaceId as string)) {
      throw new ProblemError(403, "AKEP_EXPOSURE_MISMATCH", "Usage does not match the exposure context.");
    }
    const citations = body.citations as readonly Record<string, unknown>[];
    if (
      !citations.every((citation) =>
        exposedCitationExists(exposure.citations, citation, body.spaceId as string),
      )
    ) {
      throw new ProblemError(
        403,
        "AKEP_CITATION_NOT_EXPOSED",
        "Every used citation must be present in the exposure receipt.",
      );
    }
    const createdAt = new Date().toISOString();
    const feedbackUntil = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString();
    const usageId = `urn:uuid:${randomUUID()}`;
    const receipt = {
      citations,
      createdAt,
      exposureReceiptId: body.exposureReceiptId,
      feedbackUntil,
      policyDecisionId: exposure.policyDecisionId,
      policyEpoch: config.policyEpoch,
      spaceId: body.spaceId,
      usageId,
    };
    contracts.assert("usage-receipt.schema.json", receipt);
    const state: UsageState = {
      clientUsageId: body.clientUsageId as string,
      idempotencyKey,
      receipt,
      request: body,
      requestDigest: sha256Digest(canonicalJson(body)),
      subjectDigest: principal.subjectDigest,
      usageId,
    };
    const result = await growth.createUsage(state);
    if (!result.created && result.value.requestDigest !== state.requestDigest) {
      throw new ProblemError(409, "AKEP_IDEMPOTENCY_CONFLICT", "Idempotency-Key reuse conflict.");
    }
    privateHeaders(reply, config);
    reply.code(201).header(
      "Location",
      `${config.baseUrl}/usages/${encodeURIComponent(result.value.usageId)}`,
    );
    return reply.send(result.value.receipt);
  });

  app.get<{ Params: { usageId: string } }>(
    "/usages/:usageId",
    async (request, reply) => {
      requireAKEPVersion(request);
      const principal = authenticate(request, "akep:feedback");
      const usage = await growth.getUsage(request.params.usageId);
      if (usage === undefined || usage.subjectDigest !== principal.subjectDigest) {
        throw new ProblemError(404, "AKEP_NOT_FOUND", "The Usage receipt was not found.");
      }
      enforceSpaceAccess(principal, usage.receipt.spaceId as string);
      contracts.assert("usage-receipt.schema.json", usage.receipt);
      privateHeaders(reply, config);
      return reply.send(usage.receipt);
    },
  );

  app.post<{ Body: unknown }>("/feedback", async (request, reply) => {
    requireAKEPVersion(request);
    const principal = authenticate(request, "akep:feedback");
    const idempotencyKey = requireIdempotencyKey(request);
    contracts.assert("feedback.schema.json", request.body);
    requireNoCritical(request.body);
    const body = request.body as Record<string, unknown>;
    const usage = await growth.getUsage(body.usageId as string);
    if (
      usage === undefined ||
      usage.subjectDigest !== principal.subjectDigest ||
      Date.parse(usage.receipt.feedbackUntil as string) <= Date.now()
    ) {
      throw new ProblemError(403, "AKEP_USAGE_INVALID", "The usage receipt is not usable.");
    }
    enforceSpaceAccess(principal, usage.receipt.spaceId as string);
    if (body.taskCategory !== usage.request.taskCategory) {
      throw new ProblemError(
        403,
        "AKEP_USAGE_MISMATCH",
        "Feedback taskCategory must match the referenced Usage.",
      );
    }
    if (
      body.contextDigest !== undefined &&
      body.contextDigest !== usage.request.contextDigest
    ) {
      throw new ProblemError(
        403,
        "AKEP_USAGE_MISMATCH",
        "Feedback contextDigest must match the referenced Usage.",
      );
    }
    const observedAt = Date.parse(body.observedAt as string);
    const usageCreatedAt = Date.parse(usage.receipt.createdAt as string);
    if (
      observedAt < usageCreatedAt - 5 * 60_000 ||
      observedAt > Date.now() + 5 * 60_000
    ) {
      throw new ProblemError(
        422,
        "AKEP_FEEDBACK_TIME_INVALID",
        "Feedback observedAt is outside the referenced Usage time window.",
      );
    }
    const citations = body.citations as readonly Record<string, unknown>[];
    const used = usage.receipt.citations as readonly Record<string, unknown>[];
    if (!citations.every((citation) => usedCitationExists(used, citation))) {
      throw new ProblemError(
        403,
        "AKEP_CITATION_NOT_USED",
        "Feedback citations must be bound to the referenced usage receipt.",
      );
    }
    const correlationClass = await feedbackCorrelation(
      growth,
      usage,
      principal,
    );
    const privacy = body.privacy as
      | { readonly aggregation?: string }
      | undefined;
    const eligibleForAggregation =
      correlationClass === "same_organization" &&
      privacy?.aggregation !== undefined &&
      privacy.aggregation !== "none";
    const receivedAt = new Date().toISOString();
    const receipt = {
      correlationClass,
      critical: [],
      eligibleForAggregation,
      evaluatorVersion: body.evaluatorVersion,
      evidenceId: `urn:uuid:${randomUUID()}`,
      feedbackId: body.feedbackId,
      policyEpoch: config.policyEpoch,
      receivedAt,
      status: "recorded" as const,
      subjectPseudonym: principal.subjectDigest,
      usageId: body.usageId,
    };
    contracts.assert("feedback-receipt.schema.json", receipt);
    const state: FeedbackState = {
      feedbackId: body.feedbackId as string,
      idempotencyKey,
      receipt,
      request: body,
      requestDigest: sha256Digest(canonicalJson(body)),
      subjectDigest: principal.subjectDigest,
      usageId: body.usageId as string,
    };
    const result = await growth.createFeedback(state);
    if (!result.created && result.value.requestDigest !== state.requestDigest) {
      throw new ProblemError(409, "AKEP_IDEMPOTENCY_CONFLICT", "Idempotency-Key reuse conflict.");
    }
    privateHeaders(reply, config);
    reply.code(202);
    return reply.send(result.value.receipt);
  });
}

function requireNoCritical(body: unknown): void {
  const critical = (body as { readonly critical?: readonly unknown[] }).critical;
  if (critical !== undefined && critical.length > 0) {
    throw new ProblemError(
      422,
      "AKEP_CRITICAL_EXTENSION_UNSUPPORTED",
      "This node does not support any critical extensions.",
    );
  }
}

function privateHeaders(
  reply: FastifyReply,
  config: Pick<AppConfig, "policyEpoch">,
): void {
  reply
    .header("AKEP-Version", "0.1")
    .header("AKEP-Policy-Epoch", config.policyEpoch)
    .header("Cache-Control", "private, no-store")
    .header("Vary", "Authorization");
}

function sendContribution(
  reply: FastifyReply,
  contracts: ContractRegistry,
  state: ContributionState,
  statusCode: number,
): FastifyReply {
  contracts.assert("contribution-receipt.schema.json", state.receipt);
  privateHeaders(reply, { policyEpoch: state.receipt.policyEpoch });
  return reply
    .code(statusCode)
    .header("ETag", contributionEtag(state))
    .header("Location", state.receipt.statusUrl)
    .send(state.receipt);
}

function workflowOperation(contributionId: string, action: string): string {
  return `POST:/contributions/${encodeURIComponent(contributionId)}/${action}`;
}

function workflowMutationKey(
  principal: Principal,
  operation: string,
  idempotencyKey: string,
  body: unknown,
): WorkflowMutationKey {
  return {
    idempotencyKey,
    operation,
    requestDigest: sha256Digest(canonicalJson(body)),
    subjectDigest: principal.subjectDigest,
  };
}

function workflowMutationRecord(
  key: WorkflowMutationKey,
  state: ContributionState,
): WorkflowMutationRecord {
  const createdAt = new Date();
  return {
    ...key,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + 24 * 60 * 60_000).toISOString(),
    response: {
      body: state.receipt as unknown as Record<string, unknown>,
      headers: {
        "AKEP-Policy-Epoch": state.receipt.policyEpoch,
        "AKEP-Version": "0.1",
        "Cache-Control": "private, no-store",
        ETag: contributionEtag(state),
        Location: state.receipt.statusUrl,
        Vary: "Authorization",
      },
      statusCode: 200,
    },
  };
}

async function workflowReplay(
  growth: GrowthStore,
  key: WorkflowMutationKey,
): Promise<WorkflowMutationRecord | undefined> {
  const result = await growth.getWorkflowMutation(key);
  if (result.kind === "conflict") throw idempotencyConflict();
  return result.kind === "replay" ? result.record : undefined;
}

function requireWorkflowMutationResult(
  result: WorkflowMutationResult,
): WorkflowMutationRecord {
  if (result.kind === "conflict") throw idempotencyConflict();
  if (result.kind === "precondition_failed") throw workflowPrecondition();
  return result.record;
}

function sendWorkflowMutation(
  reply: FastifyReply,
  contracts: ContractRegistry,
  record: WorkflowMutationRecord,
): FastifyReply {
  contracts.assert("contribution-receipt.schema.json", record.response.body);
  for (const [name, value] of Object.entries(record.response.headers)) {
    reply.header(name, value);
  }
  return reply.code(record.response.statusCode).send(record.response.body);
}

function idempotencyConflict(): ProblemError {
  return new ProblemError(
    409,
    "AKEP_IDEMPOTENCY_CONFLICT",
    "The Idempotency-Key was already used for a different request payload.",
  );
}

async function requireContribution(
  growth: GrowthStore,
  contributionId: string,
): Promise<ContributionState> {
  const state = await growth.getContribution(contributionId);
  if (state === undefined) {
    throw new ProblemError(404, "AKEP_NOT_FOUND", "The contribution was not found.");
  }
  return state;
}

function enforceContributionVisibility(principal: Principal, state: ContributionState): void {
  const privileged = ["akep:review", "akep:publish", "akep:incident", "akep:erase"].some(
    (scope) => principal.scopes.has(scope),
  );
  if (!privileged && principal.subjectDigest !== state.subjectDigest) {
    throw new ProblemError(404, "AKEP_NOT_FOUND", "The contribution was not found.");
  }
}

function enforceOwner(principal: Principal, state: ContributionState): void {
  if (principal.subjectDigest !== state.subjectDigest) {
    throw new ProblemError(403, "AKEP_POLICY_DENIED", "Only the contributor may change this workflow.");
  }
}

function enforceSpaceAccess(principal: Principal, spaceId: string): void {
  if (!hasSpaceAccess(principal, spaceId)) {
    throw new ProblemError(
      403,
      "AKEP_POLICY_DENIED",
      "The caller is not authorized for this Space.",
    );
  }
}

function requireMatchingEtag(state: ContributionState, ifMatch: string): void {
  if (contributionEtag(state) !== ifMatch) throw workflowPrecondition();
}

function workflowPrecondition(): ProblemError {
  return new ProblemError(
    412,
    "AKEP_WORKFLOW_PRECONDITION_FAILED",
    "The contribution workflow changed; fetch its current ETag and retry.",
  );
}

function workflowConflict(detail: string): ProblemError {
  return new ProblemError(409, "AKEP_WORKFLOW_CONFLICT", detail);
}

function transition(
  current: ContributionState,
  status: ContributionStatus,
  changes: {
    readonly amendments?: readonly Record<string, unknown>[];
    readonly decisionRefs?: readonly string[];
    readonly reviewDecision?: Record<string, unknown>;
  } = {},
): ContributionState {
  const now = new Date().toISOString();
  return {
    ...current,
    ...(changes.amendments === undefined ? {} : { amendments: changes.amendments }),
    receipt: {
      ...current.receipt,
      ...(changes.decisionRefs === undefined
        ? {}
        : { decisionRefs: changes.decisionRefs }),
      status,
      updatedAt: now,
    },
    ...(changes.reviewDecision === undefined
      ? {}
      : { reviewDecision: changes.reviewDecision }),
    updatedAt: now,
    workflowVersion: current.workflowVersion + 1,
  };
}

async function requireWorkflowUpdate(
  growth: GrowthStore,
  current: ContributionState,
  next: ContributionState,
  mutation: WorkflowMutationRecord,
): Promise<WorkflowMutationRecord> {
  const result = await growth.updateContribution(
    current.receipt.contributionId,
    current.workflowVersion,
    next,
    mutation,
  );
  return requireWorkflowMutationResult(result);
}

function reviewStatus(decision: string): ContributionStatus {
  switch (decision) {
    case "verify":
      return "verified";
    case "reject":
      return "rejected";
    case "request_evidence":
      return "needs_evidence";
    case "quarantine":
      return "quarantined";
    default:
      throw new ProblemError(422, "AKEP_SCHEMA_INVALID", "Unknown review decision.");
  }
}

function requirePublishable(
  state: ContributionState,
  kinds: readonly ContributionRequest["kind"][],
): void {
  if (state.receipt.status !== "verified" || !kinds.includes(state.request.kind)) {
    throw workflowConflict("The verified contribution kind does not match this action.");
  }
  if (state.reviewDecision === undefined) {
    throw workflowConflict("A verified review decision is required.");
  }
}

function requirePolicyEpoch(config: AppConfig, decision: Record<string, unknown>): void {
  if (decision.expectedPolicyEpoch !== config.policyEpoch) {
    throw workflowPrecondition();
  }
}

function publicationEvent(
  config: AppConfig,
  principal: Principal,
  state: ContributionState,
  decision: Record<string, unknown>,
  recordId: string,
): LifecycleEvent {
  const event: LifecycleEvent = {
    actor: principal.subject,
    attestationRefs: decision.attestationRefs as readonly string[],
    channel: "published",
    critical: [],
    eventId: `urn:uuid:${randomUUID()}`,
    eventType: "channel.updated",
    eventVersion: "0.1",
    occurredAt: new Date().toISOString(),
    policyEpoch: config.policyEpoch,
    policyVersion: decision.policyVersion as SchemaReference,
    reason: decision.rationale as string,
    recordId,
    revisionId: state.receipt.subjectRevisionId,
    spaceId: state.request.spaceId,
    trustDomain: config.trustDomain,
  };
  return event;
}

function statusEvent(
  config: AppConfig,
  principal: Principal,
  state: ContributionState,
  decision: Record<string, unknown>,
  asset: PublishedAsset,
  status: "deprecate" | "revoke" | "erase",
): LifecycleEvent {
  const mapped = status === "deprecate" ? "deprecated" : status === "revoke" ? "revoked" : "erased";
  return {
    actor: principal.subject,
    attestationRefs: decision.attestationRefs as readonly string[],
    critical: [],
    eventId: `urn:uuid:${randomUUID()}`,
    eventType: "status.asserted",
    eventVersion: "0.1",
    occurredAt: new Date().toISOString(),
    policyEpoch: config.policyEpoch,
    policyVersion: decision.policyVersion as SchemaReference,
    reason: decision.rationale as string,
    recordId: asset.manifest.recordId,
    revisionId: asset.revisionId,
    spaceId: state.request.spaceId,
    status: mapped,
    trustDomain: config.trustDomain,
  };
}

function exposedCitationExists(
  exposed: readonly unknown[],
  used: Record<string, unknown>,
  usageSpaceId: string,
): boolean {
  const candidate = {
    citationId: used.citationId,
    locator: used.locator,
    payloadDigest: used.payloadDigest,
    revisionId: used.revisionId,
  };
  return exposed.some((item) => {
    const citation = item as Record<string, unknown>;
    if (citation.spaceId !== usageSpaceId) return false;
    return canonicalJson({
      citationId: citation.citationId,
      locator: citation.locator,
      payloadDigest: citation.payloadDigest,
      revisionId: citation.revisionId,
    }) === canonicalJson(candidate);
  });
}

function usedCitationExists(
  used: readonly Record<string, unknown>[],
  feedback: Record<string, unknown>,
): boolean {
  const candidate = {
    citationId: feedback.citationId,
    locator: feedback.locator,
    payloadDigest: feedback.payloadDigest,
    revisionId: feedback.revisionId,
  };
  return used.some((citation) =>
    canonicalJson({
      citationId: citation.citationId,
      locator: citation.locator,
      payloadDigest: citation.payloadDigest,
      revisionId: citation.revisionId,
    }) === canonicalJson(candidate),
  );
}

async function citationsAreCurrent(
  growth: GrowthStore,
  citations: readonly unknown[],
  principal: Principal,
  purpose: string,
  supportedObligations: readonly unknown[],
): Promise<boolean> {
  for (const item of citations) {
    const citation = item as { readonly revisionId?: string; readonly spaceId?: string };
    if (citation.revisionId === undefined || citation.spaceId === undefined) return false;
    const asset = await growth.getPublishedRevision(citation.spaceId, citation.revisionId);
    if (
      asset === undefined ||
      !canConsume(asset, purpose, supportedObligations, principal)
    ) {
      return false;
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
        },
      );
    } catch (error) {
      if (error instanceof ProblemError) return false;
      throw error;
    }
  }
  return true;
}

async function createRequiredReviewAttestations(
  growth: GrowthStore,
  contracts: ContractRegistry,
  config: AppConfig,
  contribution: ContributionState,
  decision: Record<string, unknown>,
  reviewer: Principal,
  profile: ProfileDocument | undefined,
): Promise<readonly string[]> {
  if (profile === undefined || contribution.request.manifest === undefined) {
    throw workflowConflict("The immutable Profile is not available for review.");
  }
  const scan = contribution.amendments.find((item) => item.kind === "content-scan") as
    | (ContributionContentScan & { readonly kind: "content-scan" })
    | undefined;
  if (scan === undefined) {
    throw workflowConflict("A verified server-side content scan is required before review.");
  }
  if (scan.verdict === "quarantined") {
    throw workflowConflict("Quarantined content cannot receive qualifying Attestations.");
  }

  const references: string[] = [];
  for (const type of profile.requiredAttestations) {
    if (type === "policy-approval") continue;
    const isMachine = type === "schema-validation" || type === "safety-scan";
    const issuer = isMachine ? config.nodeId : reviewer.subject;
    const issuerSubjectDigest = isMachine
      ? sha256Digest(config.nodeId)
      : reviewer.subjectDigest;
    let result: AttestationStatement["result"];
    let method: SchemaReference;
    switch (type) {
      case "schema-validation":
        method = contribution.request.manifest.profile;
        result = {
          outcome: "pass",
          summary: "The node executed the enabled immutable Profile and schema validation rules.",
        };
        break;
      case "safety-scan":
        method = methodReference(
          "https://agentknowledge.dev/methods/static-content-scan/1",
          scan.scannerVersion,
        );
        result = {
          findings: scan.findings.map((finding) => ({
            code: finding.code,
            message: `${finding.message} Payload ${finding.payloadName}, UTF-8 bytes ${finding.start}-${finding.end}.`,
            severity: finding.severity,
          })),
          outcome: scan.verdict === "clean" ? "pass" : "warning",
          summary: scan.verdict === "clean"
            ? "The synchronous content scan found no configured indicators."
            : "The scan found non-quarantine indicators that the Curator explicitly reviewed as untrusted content.",
        };
        break;
      case "provenance-validation":
        method = decision.policyVersion as SchemaReference;
        result = {
          outcome: "pass",
          summary: "The independent Curator verified the declared provenance and source references.",
        };
        break;
      case "human-review":
        method = decision.policyVersion as SchemaReference;
        result = {
          outcome: "pass",
          summary: decision.rationale as string,
        };
        break;
      case "license-review":
        method = decision.policyVersion as SchemaReference;
        result = {
          outcome: "pass",
          summary: "The independent Curator reviewed the declared rights and usage-policy compatibility.",
        };
        break;
      default:
        // Unknown future requirements remain missing and are rejected by the
        // Profile gate; the node never manufactures an Attestation it did not
        // actually execute.
        continue;
    }
    references.push(await persistGeneratedAttestation(
      growth,
      contracts,
      contribution,
      decision.decisionId as string,
      type,
      issuer,
      issuerSubjectDigest,
      method,
      result,
    ));
  }
  return references;
}

async function createRequiredPolicyAttestations(
  growth: GrowthStore,
  contracts: ContractRegistry,
  _config: AppConfig,
  contribution: ContributionState,
  decision: Record<string, unknown>,
  publisher: Principal,
  profile: ProfileDocument,
): Promise<readonly string[]> {
  if (!profile.requiredAttestations.includes("policy-approval")) return [];
  return [await persistGeneratedAttestation(
    growth,
    contracts,
    contribution,
    decision.decisionId as string,
    "policy-approval",
    publisher.subject,
    publisher.subjectDigest,
    decision.policyVersion as SchemaReference,
    {
      outcome: "pass",
      summary: `The Publisher approved policy epoch ${String(decision.expectedPolicyEpoch)} for this Publication.`,
    },
  )];
}

async function persistGeneratedAttestation(
  growth: GrowthStore,
  contracts: ContractRegistry,
  contribution: ContributionState,
  basisId: string,
  type: string,
  issuer: string,
  issuerSubjectDigest: string,
  method: SchemaReference,
  result: AttestationStatement["result"],
): Promise<string> {
  const issued = new Date();
  const expiresAt = evidenceExpiry(contribution, issued);
  const identity = sha256Digest(canonicalJson({
    basisId,
    issuer,
    revisionId: contribution.receipt.subjectRevisionId,
    type,
  })).slice("sha256:".length);
  const attestationId = `urn:akep:attestation:sha256:${identity}`;
  const statement: AttestationStatement = {
    attestationId,
    attestationVersion: "0.1",
    critical: [],
    evidenceRefs: [
      ...new Set([
        basisId,
        ...contribution.request.evidenceRefs,
      ]),
    ],
    expiresAt,
    issuedAt: issued.toISOString(),
    issuer,
    method,
    result,
    subject: { revisionId: contribution.receipt.subjectRevisionId },
    type,
  };
  contracts.assert("attestation.schema.json", statement);
  const state: AttestationState = {
    createdAt: statement.issuedAt,
    documentDigest: sha256Digest(canonicalJson(statement)),
    idempotencyKey: `generated:${identity}`,
    issuerSubjectDigest,
    spaceId: contribution.request.spaceId,
    statement,
  };
  const stored = await growth.createAttestation(state);
  if (!stored.created && stored.value.documentDigest !== state.documentDigest) {
    const existing = stored.value.statement;
    const sameExecutedEvidence = canonicalJson({
      critical: existing.critical,
      evidenceRefs: existing.evidenceRefs,
      issuer: existing.issuer,
      method: existing.method,
      result: existing.result,
      subject: existing.subject,
      type: existing.type,
    }) === canonicalJson({
      critical: statement.critical,
      evidenceRefs: statement.evidenceRefs,
      issuer: statement.issuer,
      method: statement.method,
      result: statement.result,
      subject: statement.subject,
      type: statement.type,
    });
    if (!sameExecutedEvidence) {
      throw new ProblemError(
        409,
        "AKEP_ATTESTATION_CONFLICT",
        "The decision identifier is already bound to different generated evidence.",
      );
    }
  }
  return stored.value.statement.attestationId;
}

function evidenceExpiry(contribution: ContributionState, issued: Date): string {
  const maximum = issued.getTime() + 30 * 24 * 60 * 60_000;
  const scope = contribution.request.manifest?.scope as
    | { readonly reviewAfter?: unknown }
    | undefined;
  const reviewAfter = typeof scope?.reviewAfter === "string"
    ? Date.parse(scope.reviewAfter)
    : Number.POSITIVE_INFINITY;
  const expiry = Math.min(maximum, reviewAfter);
  if (!Number.isFinite(expiry) || expiry <= issued.getTime()) {
    if (expiry === Number.POSITIVE_INFINITY) return new Date(maximum).toISOString();
    throw workflowConflict("The Profile review deadline has passed; submit a new Revision.");
  }
  return new Date(expiry).toISOString();
}

function methodReference(uri: string, version: string): SchemaReference {
  return { digest: sha256Digest(`${uri}\n${version}`), uri };
}

async function requireIndependentAttester(
  growth: GrowthStore,
  spaceId: string,
  references: readonly string[],
  actor: Principal,
): Promise<void> {
  for (const reference of references) {
    const attestation = await growth.getAttestation(spaceId, reference);
    if (
      attestation !== undefined &&
      attestation.issuerSubjectDigest !== actor.subjectDigest
    ) {
      return;
    }
  }
  throw new ProblemError(
    403,
    "AKEP_DUTY_SEPARATION_REQUIRED",
    "The executing actor must be independent from at least one review Attestation issuer.",
  );
}

async function feedbackCorrelation(
  growth: GrowthStore,
  usage: UsageState,
  principal: Principal,
): Promise<"same_organization" | "self_author" | "unknown"> {
  const citations = usage.request.citations as readonly Record<string, unknown>[];
  let resolved = false;
  for (const citation of citations) {
    if (typeof citation.revisionId !== "string") continue;
    const asset = await growth.getPublishedRevision(
      usage.request.spaceId as string,
      citation.revisionId,
    );
    if (asset === undefined) continue;
    resolved = true;
    const contribution = await growth.getContribution(asset.sourceContributionId);
    if (contribution?.subjectDigest === principal.subjectDigest) {
      return "self_author";
    }
  }
  return resolved ? "same_organization" : "unknown";
}
