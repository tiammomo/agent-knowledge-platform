import type { Pool, PoolClient } from "pg";
import type { AppConfig } from "../../config.js";
import type {
  AttestationState,
  EvaluationRunState,
} from "../evaluation/types.js";
import type {
  ContributionState,
  FeedbackState,
  LifecycleEvent,
  PublishedAsset,
  UsageState,
} from "./types.js";

export interface CreateResult<T> {
  readonly created: boolean;
  readonly value: T;
}

export interface WorkflowMutationKey {
  readonly idempotencyKey: string;
  readonly operation: string;
  readonly requestDigest: string;
  readonly subjectDigest: string;
}

export interface WorkflowMutationRecord extends WorkflowMutationKey {
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly response: {
    readonly body: Record<string, unknown>;
    readonly headers: Readonly<Record<string, string>>;
    readonly statusCode: number;
  };
}

export type WorkflowMutationLookup =
  | { readonly kind: "conflict" }
  | { readonly kind: "miss" }
  | { readonly kind: "replay"; readonly record: WorkflowMutationRecord };

export type WorkflowMutationResult =
  | { readonly kind: "applied"; readonly record: WorkflowMutationRecord }
  | { readonly kind: "conflict" }
  | { readonly kind: "precondition_failed" }
  | { readonly kind: "replayed"; readonly record: WorkflowMutationRecord };

export interface EvidenceSummary {
  readonly generatedAt: string;
  readonly harmed: readonly {
    readonly correlationClass: string;
    readonly eligibleForAggregation: boolean;
    readonly feedbackId: string;
    readonly observedAt?: string;
    readonly revisionIds: readonly string[];
    readonly taskCategory: string;
    readonly usageId: string;
  }[];
  readonly outcomes: Readonly<Record<"harmed" | "helped" | "neutral" | "unknown", number>>;
  readonly revisions: readonly {
    readonly feedback: number;
    readonly harmed: number;
    readonly helped: number;
    readonly revisionId: string;
    readonly usage: number;
  }[];
  readonly taskCategories: readonly {
    readonly feedback: number;
    readonly name: string;
    readonly usage: number;
  }[];
  readonly totals: {
    readonly eligibleFeedback: number;
    readonly feedback: number;
    readonly usage: number;
  };
}

export interface GrowthStore {
  applyLifecycleAction(
    contributionId: string,
    expectedVersion: number,
    next: ContributionState,
    targetRevisionId: string,
    event: LifecycleEvent,
    mutation: WorkflowMutationRecord,
  ): Promise<WorkflowMutationResult>;
  createContribution(state: ContributionState): Promise<CreateResult<ContributionState>>;
  createFeedback(state: FeedbackState): Promise<CreateResult<FeedbackState>>;
  createAttestation(
    state: AttestationState,
  ): Promise<CreateResult<AttestationState>>;
  createEvaluationRun(
    state: EvaluationRunState,
    attestation: AttestationState,
  ): Promise<CreateResult<EvaluationRunState>>;
  createUsage(state: UsageState): Promise<CreateResult<UsageState>>;
  getAttestation(
    spaceId: string,
    attestationId: string,
  ): Promise<AttestationState | undefined>;
  getContribution(contributionId: string): Promise<ContributionState | undefined>;
  getEvaluationRun(runId: string): Promise<EvaluationRunState | undefined>;
  getEvaluationRunByAttestation(
    attestationId: string,
  ): Promise<EvaluationRunState | undefined>;
  getPublishedRevision(
    spaceId: string,
    revisionId: string,
  ): Promise<PublishedAsset | undefined>;
  getUsage(usageId: string): Promise<UsageState | undefined>;
  getWorkflowMutation(
    key: WorkflowMutationKey,
  ): Promise<WorkflowMutationLookup>;
  listPublished(): Promise<readonly PublishedAsset[]>;
  listContributions(): Promise<readonly ContributionState[]>;
  evidenceCounts(): Promise<{ readonly feedback: number; readonly usage: number }>;
  evidenceSummary(): Promise<EvidenceSummary>;
  publishContribution(
    contributionId: string,
    expectedVersion: number,
    next: ContributionState,
    asset: PublishedAsset,
    mutation: WorkflowMutationRecord,
  ): Promise<WorkflowMutationResult>;
  updateContribution(
    contributionId: string,
    expectedVersion: number,
    next: ContributionState,
    mutation: WorkflowMutationRecord,
  ): Promise<WorkflowMutationResult>;
}

export class InMemoryGrowthStore implements GrowthStore {
  readonly #attestations = new Map<string, AttestationState>();
  readonly #attestationIds = new Map<string, string>();
  readonly #attestationIdempotency = new Map<string, string>();
  readonly #contributions = new Map<string, ContributionState>();
  readonly #contributionIdempotency = new Map<string, string>();
  readonly #contributionSubmissions = new Map<string, string>();
  readonly #feedback = new Map<string, FeedbackState>();
  readonly #feedbackIds = new Map<string, string>();
  readonly #feedbackIdempotency = new Map<string, string>();
  readonly #feedbackUsageIds = new Map<string, string>();
  readonly #evaluationRuns = new Map<string, EvaluationRunState>();
  readonly #evaluationAttestations = new Map<string, string>();
  readonly #evaluationClientIds = new Map<string, string>();
  readonly #evaluationIdempotency = new Map<string, string>();
  readonly #published = new Map<string, PublishedAsset>();
  readonly #usage = new Map<string, UsageState>();
  readonly #usageClientIds = new Map<string, string>();
  readonly #usageIdempotency = new Map<string, string>();
  readonly #workflowMutations = new Map<string, WorkflowMutationRecord>();

  public async createAttestation(
    state: AttestationState,
  ): Promise<CreateResult<AttestationState>> {
    const idempotencyKey = `${state.issuerSubjectDigest}\0${state.idempotencyKey}`;
    const idKey = attestationKey(
      state.spaceId,
      state.statement.attestationId,
    );
    const existingKey =
      this.#attestationIdempotency.get(idempotencyKey) ??
      this.#attestationIds.get(state.statement.attestationId);
    const existing =
      existingKey === undefined ? undefined : this.#attestations.get(existingKey);
    if (existing !== undefined) return { created: false, value: existing };
    this.#attestations.set(idKey, state);
    this.#attestationIds.set(state.statement.attestationId, idKey);
    this.#attestationIdempotency.set(idempotencyKey, idKey);
    return { created: true, value: state };
  }

  public async getAttestation(
    spaceId: string,
    attestationId: string,
  ): Promise<AttestationState | undefined> {
    return this.#attestations.get(attestationKey(spaceId, attestationId));
  }

  public async createEvaluationRun(
    state: EvaluationRunState,
    attestation: AttestationState,
  ): Promise<CreateResult<EvaluationRunState>> {
    const idempotencyKey = `${state.issuerSubjectDigest}\0${state.idempotencyKey}`;
    const clientKey = `${state.issuerSubjectDigest}\0${state.run.clientRunId}`;
    const existingId =
      this.#evaluationIdempotency.get(idempotencyKey) ??
      this.#evaluationClientIds.get(clientKey);
    if (existingId !== undefined) {
      return { created: false, value: this.#evaluationRuns.get(existingId)! };
    }
    const runId = state.run.runId;
    const existing = this.#evaluationRuns.get(runId);
    if (existing !== undefined) return { created: false, value: existing };
    const attestationResult = await this.createAttestation(attestation);
    if (!attestationResult.created) {
      throw new Error("Evaluation attestation identifier already exists");
    }
    this.#evaluationRuns.set(runId, state);
    this.#evaluationAttestations.set(state.run.attestationId, runId);
    this.#evaluationIdempotency.set(idempotencyKey, runId);
    this.#evaluationClientIds.set(clientKey, runId);
    return { created: true, value: state };
  }

  public async getEvaluationRun(
    runId: string,
  ): Promise<EvaluationRunState | undefined> {
    return this.#evaluationRuns.get(runId);
  }

  public async getEvaluationRunByAttestation(
    attestationId: string,
  ): Promise<EvaluationRunState | undefined> {
    const runId = this.#evaluationAttestations.get(attestationId);
    return runId === undefined ? undefined : this.#evaluationRuns.get(runId);
  }

  public async createContribution(
    state: ContributionState,
  ): Promise<CreateResult<ContributionState>> {
    const key = `${state.subjectDigest}\0${state.idempotencyKey}`;
    const submissionKey = `${state.subjectDigest}\0${state.request.clientSubmissionId}`;
    const existingId =
      this.#contributionIdempotency.get(key) ??
      this.#contributionSubmissions.get(submissionKey);
    if (existingId !== undefined) {
      return { created: false, value: this.#contributions.get(existingId)! };
    }
    this.#contributions.set(state.receipt.contributionId, state);
    this.#contributionIdempotency.set(key, state.receipt.contributionId);
    this.#contributionSubmissions.set(submissionKey, state.receipt.contributionId);
    return { created: true, value: state };
  }

  public async getContribution(
    contributionId: string,
  ): Promise<ContributionState | undefined> {
    return this.#contributions.get(contributionId);
  }

  public async updateContribution(
    contributionId: string,
    expectedVersion: number,
    next: ContributionState,
    mutation: WorkflowMutationRecord,
  ): Promise<WorkflowMutationResult> {
    const existing = this.#lookupWorkflowMutation(mutation);
    if (existing.kind !== "miss") return mutationResult(existing);
    const current = this.#contributions.get(contributionId);
    if (current === undefined || current.workflowVersion !== expectedVersion) {
      return { kind: "precondition_failed" };
    }
    this.#contributions.set(contributionId, next);
    this.#workflowMutations.set(workflowMutationMapKey(mutation), mutation);
    return { kind: "applied", record: mutation };
  }

  public async publishContribution(
    contributionId: string,
    expectedVersion: number,
    next: ContributionState,
    asset: PublishedAsset,
    mutation: WorkflowMutationRecord,
  ): Promise<WorkflowMutationResult> {
    const existing = this.#lookupWorkflowMutation(mutation);
    if (existing.kind !== "miss") return mutationResult(existing);
    const current = this.#contributions.get(contributionId);
    if (current === undefined || current.workflowVersion !== expectedVersion) {
      return { kind: "precondition_failed" };
    }
    for (const [key, existing] of this.#published) {
      if (
        existing.spaceId === asset.spaceId &&
        existing.manifest.recordId === asset.manifest.recordId &&
        existing.status === "published"
      ) {
        this.#published.set(key, { ...existing, status: "superseded" });
      }
    }
    this.#published.set(assetKey(asset.spaceId, asset.revisionId), asset);
    this.#contributions.set(contributionId, next);
    this.#workflowMutations.set(workflowMutationMapKey(mutation), mutation);
    return { kind: "applied", record: mutation };
  }

  public async applyLifecycleAction(
    contributionId: string,
    expectedVersion: number,
    next: ContributionState,
    targetRevisionId: string,
    event: LifecycleEvent,
    mutation: WorkflowMutationRecord,
  ): Promise<WorkflowMutationResult> {
    const existing = this.#lookupWorkflowMutation(mutation);
    if (existing.kind !== "miss") return mutationResult(existing);
    const current = this.#contributions.get(contributionId);
    const key = assetKey(event.spaceId, targetRevisionId);
    const asset = this.#published.get(key);
    if (
      current === undefined ||
      current.workflowVersion !== expectedVersion ||
      asset === undefined
    ) {
      return { kind: "precondition_failed" };
    }
    const status = event.status;
    if (status === undefined || status === "quarantined") {
      return { kind: "precondition_failed" };
    }
    if (!lifecycleStatusCanAdvance(asset.status, status)) {
      return { kind: "precondition_failed" };
    }
    this.#published.set(key, {
      ...asset,
      payloads: status === "erased" ? [] : asset.payloads,
      status,
      statusEvent: event,
    });
    if (status === "erased") {
      const source = this.#contributions.get(asset.sourceContributionId);
      if (source !== undefined) {
        this.#contributions.set(asset.sourceContributionId, {
          ...source,
          payloads: [],
        });
      }
      const erasedUsageIds = new Set<string>();
      for (const [usageId, usage] of this.#usage) {
        const citations = usage.request.citations as readonly Record<string, unknown>[] | undefined;
        if (
          usage.request.spaceId === event.spaceId &&
          citations?.some((citation) => citation.revisionId === targetRevisionId)
        ) {
          erasedUsageIds.add(usageId);
          this.#usage.delete(usageId);
        }
      }
      for (const [feedbackId, feedback] of this.#feedback) {
        if (erasedUsageIds.has(feedback.usageId)) this.#feedback.delete(feedbackId);
      }
      removeMappedValues(this.#usageIdempotency, erasedUsageIds);
      removeMappedValues(this.#usageClientIds, erasedUsageIds);
      removeMappedValues(
        this.#feedbackIdempotency,
        new Set([...this.#feedbackIds.values()].filter((id) => !this.#feedback.has(id))),
      );
      for (const [key, feedbackId] of this.#feedbackIds) {
        if (!this.#feedback.has(feedbackId)) this.#feedbackIds.delete(key);
      }
      for (const [usageId, feedbackId] of this.#feedbackUsageIds) {
        if (erasedUsageIds.has(usageId) || !this.#feedback.has(feedbackId)) {
          this.#feedbackUsageIds.delete(usageId);
        }
      }
    }
    this.#contributions.set(contributionId, next);
    this.#workflowMutations.set(workflowMutationMapKey(mutation), mutation);
    return { kind: "applied", record: mutation };
  }

  public async getWorkflowMutation(
    key: WorkflowMutationKey,
  ): Promise<WorkflowMutationLookup> {
    return this.#lookupWorkflowMutation(key);
  }

  #lookupWorkflowMutation(key: WorkflowMutationKey): WorkflowMutationLookup {
    const mapKey = workflowMutationMapKey(key);
    const existing = this.#workflowMutations.get(mapKey);
    if (existing === undefined) return { kind: "miss" };
    if (Date.parse(existing.expiresAt) <= Date.now()) {
      this.#workflowMutations.delete(mapKey);
      return { kind: "miss" };
    }
    return existing.requestDigest === key.requestDigest
      ? { kind: "replay", record: existing }
      : { kind: "conflict" };
  }

  public async listPublished(): Promise<readonly PublishedAsset[]> {
    return [...this.#published.values()];
  }

  public async listContributions(): Promise<readonly ContributionState[]> {
    return [...this.#contributions.values()];
  }

  public async evidenceCounts(): Promise<{
    readonly feedback: number;
    readonly usage: number;
  }> {
    return { feedback: this.#feedback.size, usage: this.#usage.size };
  }

  public async evidenceSummary(): Promise<EvidenceSummary> {
    return summarizeEvidence([...this.#usage.values()], [...this.#feedback.values()]);
  }

  public async getPublishedRevision(
    spaceId: string,
    revisionId: string,
  ): Promise<PublishedAsset | undefined> {
    return this.#published.get(assetKey(spaceId, revisionId));
  }

  public async createUsage(state: UsageState): Promise<CreateResult<UsageState>> {
    const key = `${state.subjectDigest}\0${state.idempotencyKey}`;
    const clientKey = `${state.subjectDigest}\0${state.clientUsageId}`;
    const existingId =
      this.#usageIdempotency.get(key) ?? this.#usageClientIds.get(clientKey);
    if (existingId !== undefined) {
      return { created: false, value: this.#usage.get(existingId)! };
    }
    this.#usage.set(state.usageId, state);
    this.#usageIdempotency.set(key, state.usageId);
    this.#usageClientIds.set(clientKey, state.usageId);
    return { created: true, value: state };
  }

  public async getUsage(usageId: string): Promise<UsageState | undefined> {
    return this.#usage.get(usageId);
  }

  public async createFeedback(
    state: FeedbackState,
  ): Promise<CreateResult<FeedbackState>> {
    const key = `${state.subjectDigest}\0${state.idempotencyKey}`;
    const feedbackKey = `${state.subjectDigest}\0${state.feedbackId}`;
    const existingId =
      this.#feedbackIdempotency.get(key) ??
      this.#feedbackIds.get(feedbackKey) ??
      this.#feedbackUsageIds.get(state.usageId);
    if (existingId !== undefined) {
      return { created: false, value: this.#feedback.get(existingId)! };
    }
    this.#feedback.set(state.feedbackId, state);
    this.#feedbackIdempotency.set(key, state.feedbackId);
    this.#feedbackIds.set(feedbackKey, state.feedbackId);
    this.#feedbackUsageIds.set(state.usageId, state.feedbackId);
    return { created: true, value: state };
  }
}

export class PostgresGrowthStore implements GrowthStore {
  public constructor(
    private readonly pool: Pool,
    private readonly config: AppConfig,
  ) {}

  public async createAttestation(
    state: AttestationState,
  ): Promise<CreateResult<AttestationState>> {
    const result = await this.pool.query(
      `insert into evaluation.attestation
         (tenant_id, space_id, attestation_id, subject_revision_id,
          subject_payload_digest, issuer, issuer_subject_digest, idempotency_key,
          attestation_type, outcome, expires_at, method_digest,
          document, document_digest, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15)
       on conflict do nothing
       returning attestation_id`,
      attestationParameters(this.config.tenantId, state),
    );
    if (result.rowCount === 1) return { created: true, value: state };
    const existing = await this.pool.query(
      `select * from evaluation.attestation
        where tenant_id = $1
          and (attestation_id = $2
            or (issuer_subject_digest = $3 and idempotency_key = $4))
        order by (issuer_subject_digest = $3 and idempotency_key = $4) desc
        limit 1`,
      [
        this.config.tenantId,
        state.statement.attestationId,
        state.issuerSubjectDigest,
        state.idempotencyKey,
      ],
    );
    if (existing.rows[0] === undefined) {
      throw new Error("Attestation uniqueness conflict could not be resolved");
    }
    return { created: false, value: attestationFromRow(existing.rows[0]) };
  }

  public async getAttestation(
    spaceId: string,
    attestationId: string,
  ): Promise<AttestationState | undefined> {
    const result = await this.pool.query(
      `select * from evaluation.attestation
        where tenant_id = $1 and space_id = $2 and attestation_id = $3`,
      [this.config.tenantId, spaceId, attestationId],
    );
    return result.rows[0] === undefined
      ? undefined
      : attestationFromRow(result.rows[0]);
  }

  public async createEvaluationRun(
    state: EvaluationRunState,
    attestation: AttestationState,
  ): Promise<CreateResult<EvaluationRunState>> {
    return this.#transaction(async (client) => {
      const lockKeys = [
        `evaluation:idempotency:${state.issuerSubjectDigest}:${state.idempotencyKey}`,
        `evaluation:client:${state.issuerSubjectDigest}:${state.run.clientRunId}`,
      ].sort();
      for (const key of lockKeys) {
        await client.query(
          "select pg_advisory_xact_lock(hashtextextended($1, 0))",
          [key],
        );
      }
      const existing = await client.query(
        `select * from evaluation.evaluation_run
          where tenant_id = $1
            and (run_id = $2 or
                 (issuer_subject_digest = $3 and
                  (idempotency_key = $4 or client_run_id = $5)))
          order by (issuer_subject_digest = $3 and idempotency_key = $4) desc,
                   (issuer_subject_digest = $3 and client_run_id = $5) desc
          limit 1`,
        [
          this.config.tenantId,
          state.run.runId,
          state.issuerSubjectDigest,
          state.idempotencyKey,
          state.run.clientRunId,
        ],
      );
      if (existing.rows[0] !== undefined) {
        return {
          created: false,
          value: evaluationRunFromRow(existing.rows[0]),
        };
      }
      const attestationInsert = await client.query(
        `insert into evaluation.attestation
           (tenant_id, space_id, attestation_id, subject_revision_id,
            subject_payload_digest, issuer, issuer_subject_digest, idempotency_key,
            attestation_type, outcome, expires_at, method_digest,
            document, document_digest, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15)
         on conflict do nothing
         returning attestation_id`,
        attestationParameters(this.config.tenantId, attestation),
      );
      if (attestationInsert.rowCount !== 1) {
        throw new Error("Evaluation attestation identifier already exists");
      }
      await client.query(
        `insert into evaluation.evaluation_run
         (tenant_id, space_id, run_id, client_run_id, subject_revision_id,
            issuer_subject_digest, idempotency_key, request_digest, evaluator_digest,
            dataset_digest, started_at, completed_at, gate_outcome,
            attestation_id, document, document_digest, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17)`,
        evaluationRunParameters(this.config.tenantId, state),
      );
      return { created: true, value: state };
    });
  }

  public async getEvaluationRun(
    runId: string,
  ): Promise<EvaluationRunState | undefined> {
    const result = await this.pool.query(
      `select * from evaluation.evaluation_run
        where tenant_id = $1 and run_id = $2`,
      [this.config.tenantId, runId],
    );
    return result.rows[0] === undefined
      ? undefined
      : evaluationRunFromRow(result.rows[0]);
  }

  public async getEvaluationRunByAttestation(
    attestationId: string,
  ): Promise<EvaluationRunState | undefined> {
    const result = await this.pool.query(
      `select * from evaluation.evaluation_run
        where tenant_id = $1 and attestation_id = $2`,
      [this.config.tenantId, attestationId],
    );
    return result.rows[0] === undefined
      ? undefined
      : evaluationRunFromRow(result.rows[0]);
  }

  public async createContribution(
    state: ContributionState,
  ): Promise<CreateResult<ContributionState>> {
    const result = await this.pool.query(
      `insert into contribution.workflow
         (contribution_id, subject_digest, idempotency_key, request_digest,
          client_submission_id, space_id, kind, subject_revision_id, status,
          workflow_version, request_document, payloads, receipt_document,
          review_decision, amendments, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,
               $14::jsonb,$15::jsonb,$16,$17)
       on conflict do nothing
       returning contribution_id`,
      contributionParameters(state),
    );
    if (result.rowCount === 1) return { created: true, value: state };
    const existing = await this.pool.query(
      `select * from contribution.workflow
        where subject_digest = $1
          and (idempotency_key = $2 or client_submission_id = $3)
        order by (idempotency_key = $2) desc limit 1`,
      [state.subjectDigest, state.idempotencyKey, state.request.clientSubmissionId],
    );
    return { created: false, value: contributionFromRow(existing.rows[0]) };
  }

  public async getContribution(
    contributionId: string,
  ): Promise<ContributionState | undefined> {
    const result = await this.pool.query(
      "select * from contribution.workflow where contribution_id = $1",
      [contributionId],
    );
    return result.rows[0] === undefined
      ? undefined
      : contributionFromRow(result.rows[0]);
  }

  public async updateContribution(
    contributionId: string,
    expectedVersion: number,
    next: ContributionState,
    mutation: WorkflowMutationRecord,
  ): Promise<WorkflowMutationResult> {
    return this.#transaction(async (client) => {
      const existing = await beginWorkflowMutation(
        client,
        this.config.tenantId,
        mutation,
      );
      if (existing.kind !== "miss") return mutationResult(existing);
      const result = await client.query(
        `update contribution.workflow
            set status = $3, workflow_version = $4, receipt_document = $5::jsonb,
                review_decision = $6::jsonb, amendments = $7::jsonb,
                payloads = $8::jsonb, updated_at = $9
          where contribution_id = $1 and workflow_version = $2`,
        [
          contributionId,
          expectedVersion,
          next.receipt.status,
          next.workflowVersion,
          JSON.stringify(next.receipt),
          next.reviewDecision === undefined ? null : JSON.stringify(next.reviewDecision),
          JSON.stringify(next.amendments),
          JSON.stringify(next.payloads),
          next.updatedAt,
        ],
      );
      if (result.rowCount !== 1) return { kind: "precondition_failed" };
      await insertWorkflowMutation(client, this.config.tenantId, mutation);
      return { kind: "applied", record: mutation };
    });
  }

  public async publishContribution(
    contributionId: string,
    expectedVersion: number,
    next: ContributionState,
    asset: PublishedAsset,
    mutation: WorkflowMutationRecord,
  ): Promise<WorkflowMutationResult> {
    return this.#transaction(async (client) => {
      const existing = await beginWorkflowMutation(
        client,
        this.config.tenantId,
        mutation,
      );
      if (existing.kind !== "miss") return mutationResult(existing);
      if (!(await lockWorkflow(client, contributionId, expectedVersion))) {
        return { kind: "precondition_failed" };
      }
      const manifest = asset.manifest;
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        // Published Channel uniqueness is a Record-level invariant. Locking a
        // Revision allows two different candidates for the same Record to be
        // published concurrently, so serialize on the actual channel key.
        JSON.stringify([
          this.config.tenantId,
          asset.spaceId,
          manifest.recordId,
          this.config.trustDomain,
          "published",
        ]),
      ]);
      const duplicate = await client.query(
        `select 1 from query.knowledge_projection
          where tenant_id = $1 and space_id = $2 and revision_id = $3`,
        [this.config.tenantId, asset.spaceId, asset.revisionId],
      );
      if (duplicate.rowCount !== 0) return { kind: "precondition_failed" };
      await client.query(
        `insert into catalog.record (tenant_id, space_id, record_id)
         values ($1,$2,$3) on conflict do nothing`,
        [this.config.tenantId, asset.spaceId, manifest.recordId],
      );
      await client.query(
        `insert into catalog.revision
           (tenant_id, space_id, record_id, revision_id, manifest)
         values ($1,$2,$3,$4,$5::jsonb) on conflict do nothing`,
        [
          this.config.tenantId,
          asset.spaceId,
          manifest.recordId,
          asset.revisionId,
          JSON.stringify(manifest),
        ],
      );
      for (const payload of manifest.payloads) {
        await client.query(
          `insert into catalog.content_blob
             (tenant_id, digest, media_type, size_bytes, storage_key, verification_status)
           values ($1,$2,$3,$4,$5,'verified') on conflict do nothing`,
          [
            this.config.tenantId,
            payload.digest,
            payload.mediaType,
            payload.size,
            `projection://${encodeURIComponent(asset.revisionId)}/${payload.name}`,
          ],
        );
        await client.query(
          `insert into catalog.revision_blob
             (tenant_id, space_id, revision_id, name, digest)
           values ($1,$2,$3,$4,$5) on conflict do nothing`,
          [
            this.config.tenantId,
            asset.spaceId,
            asset.revisionId,
            payload.name,
            payload.digest,
          ],
        );
      }
      await client.query(
        `update query.knowledge_projection set status = 'superseded'
          where tenant_id = $1 and space_id = $2 and record_id = $3
            and status = 'published'`,
        [this.config.tenantId, asset.spaceId, manifest.recordId],
      );
      await insertLifecycleEvent(client, asset.publicationEvent);
      await client.query(
        `insert into governance.channel
           (tenant_id, space_id, record_id, trust_domain, channel_name,
            revision_id, event_id, updated_at)
         values ($1,$2,$3,$4,'published',$5,$6,$7)
         on conflict (tenant_id, space_id, record_id, trust_domain, channel_name)
         do update set revision_id = excluded.revision_id,
                       event_id = excluded.event_id,
                       updated_at = excluded.updated_at`,
        [
          this.config.tenantId,
          asset.spaceId,
          manifest.recordId,
          this.config.trustDomain,
          asset.revisionId,
          asset.publicationEvent.eventId,
          asset.indexedAt,
        ],
      );
      await client.query(
        `insert into query.knowledge_projection
           (tenant_id, space_id, record_id, revision_id, source_contribution_id,
            publication_event_id, manifest, payloads, search_content,
            quality_decision, quality_reasons, quality_attestation_refs,
            obligations, status, indexed_at)
         values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11::jsonb,
                 $12::jsonb,$13::jsonb,'published',$14)
        `,
        [
          this.config.tenantId,
          asset.spaceId,
          manifest.recordId,
          asset.revisionId,
          asset.sourceContributionId,
          asset.publicationEvent.eventId,
          JSON.stringify(manifest),
          JSON.stringify(asset.payloads),
          searchContent(asset),
          asset.qualityDecision,
          JSON.stringify(asset.qualityReasons),
          JSON.stringify(asset.qualityAttestationRefs),
          JSON.stringify(manifest.policy.obligations ?? []),
          asset.indexedAt,
        ],
      );
      await updateLockedWorkflow(client, contributionId, next);
      await insertOutbox(client, "governance", "akep.channel.updated", asset.publicationEvent);
      await insertWorkflowMutation(client, this.config.tenantId, mutation);
      return { kind: "applied", record: mutation };
    });
  }

  public async applyLifecycleAction(
    contributionId: string,
    expectedVersion: number,
    next: ContributionState,
    targetRevisionId: string,
    event: LifecycleEvent,
    mutation: WorkflowMutationRecord,
  ): Promise<WorkflowMutationResult> {
    return this.#transaction(async (client) => {
      const existing = await beginWorkflowMutation(
        client,
        this.config.tenantId,
        mutation,
      );
      if (existing.kind !== "miss") return mutationResult(existing);
      if (!(await lockWorkflow(client, contributionId, expectedVersion))) {
        return { kind: "precondition_failed" };
      }
      const status = event.status;
      if (status === undefined || status === "quarantined") {
        return { kind: "precondition_failed" };
      }
      const projection = await client.query<{
        readonly source_contribution_id: string;
        readonly status: PublishedAsset["status"];
      }>(
        `select source_contribution_id, status from query.knowledge_projection
          where tenant_id = $1 and space_id = $2 and revision_id = $3
          for update`,
        [this.config.tenantId, event.spaceId, targetRevisionId],
      );
      const sourceContributionId = projection.rows[0]?.source_contribution_id;
      const currentStatus = projection.rows[0]?.status;
      if (
        sourceContributionId === undefined ||
        currentStatus === undefined ||
        !lifecycleStatusCanAdvance(currentStatus, status)
      ) {
        return { kind: "precondition_failed" };
      }
      await insertLifecycleEvent(client, event);
      await client.query(
        `insert into governance.revision_status
           (tenant_id, space_id, revision_id, trust_domain, status_name,
            event_id, reason, asserted_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (tenant_id, space_id, revision_id, trust_domain, status_name)
         do update set event_id = excluded.event_id, reason = excluded.reason,
                       asserted_at = excluded.asserted_at`,
        [
          this.config.tenantId,
          event.spaceId,
          targetRevisionId,
          this.config.trustDomain,
          status,
          event.eventId,
          event.reason,
          event.occurredAt,
        ],
      );
      await client.query(
        `update query.knowledge_projection
            set status = $4,
                payloads = case when $4 = 'erased' then '[]'::jsonb else payloads end,
                search_content = case when $4 = 'erased' then '' else search_content end
          where tenant_id = $1 and space_id = $2 and revision_id = $3`,
        [this.config.tenantId, event.spaceId, targetRevisionId, status],
      );
      if (status === "erased") {
        const erasedUsage = await client.query<{ readonly usage_id: string }>(
          `select usage_id from query.usage_receipt
            where request_document->>'spaceId' = $1
              and exists (
                select 1
                  from jsonb_array_elements(request_document->'citations') citation
                 where citation->>'revisionId' = $2
              )
            for update`,
          [event.spaceId, targetRevisionId],
        );
        const erasedUsageIds = erasedUsage.rows.map((row) => row.usage_id);
        if (erasedUsageIds.length > 0) {
          await client.query(
            `delete from evaluation.feedback_evidence where usage_id = any($1::text[])`,
            [erasedUsageIds],
          );
          await client.query(
            `delete from query.usage_receipt where usage_id = any($1::text[])`,
            [erasedUsageIds],
          );
        }
        await client.query(
          `delete from query.chunk_projection
            where tenant_id = $1 and space_id = $2 and revision_id = $3`,
          [this.config.tenantId, event.spaceId, targetRevisionId],
        );
        await client.query(
          `delete from query.exposure_receipt
            where exists (
              select 1
                from jsonb_array_elements(document->'citations') citation
               where citation->>'spaceId' = $1 and citation->>'revisionId' = $2
            )`,
          [event.spaceId, targetRevisionId],
        );
        await client.query(
          `delete from catalog.revision_blob
            where tenant_id = $1 and space_id = $2 and revision_id = $3`,
          [this.config.tenantId, event.spaceId, targetRevisionId],
        );
        await client.query(
          `delete from catalog.content_blob blob
            where blob.tenant_id = $1
              and not exists (
                select 1 from catalog.revision_blob reference
                 where reference.tenant_id = blob.tenant_id
                   and reference.digest = blob.digest
              )`,
          [this.config.tenantId],
        );
        await client.query(
          `update contribution.workflow set payloads = '[]'::jsonb
            where contribution_id = $1`,
          [sourceContributionId],
        );
      }
      await updateLockedWorkflow(client, contributionId, next);
      await insertOutbox(client, "governance", `akep.status.${status}`, event);
      await insertWorkflowMutation(client, this.config.tenantId, mutation);
      return { kind: "applied", record: mutation };
    });
  }

  public async listPublished(): Promise<readonly PublishedAsset[]> {
    const result = await this.pool.query(
      `select p.*, e.document as publication_document,
              s.document as status_document
         from query.knowledge_projection p
         join governance.lifecycle_event e on e.event_id = p.publication_event_id
         left join lateral (
           select le.document
             from governance.revision_status rs
             join governance.lifecycle_event le on le.event_id = rs.event_id
            where rs.tenant_id = p.tenant_id and rs.space_id = p.space_id
              and rs.revision_id = p.revision_id
            order by rs.asserted_at desc limit 1
         ) s on true
        where p.tenant_id = $1`,
      [this.config.tenantId],
    );
    return result.rows.map(publishedFromRow);
  }

  public async listContributions(): Promise<readonly ContributionState[]> {
    const result = await this.pool.query(
      "select * from contribution.workflow order by updated_at desc",
    );
    return result.rows.map(contributionFromRow);
  }

  public async evidenceCounts(): Promise<{
    readonly feedback: number;
    readonly usage: number;
  }> {
    const result = await this.pool.query<{
      readonly feedback: number;
      readonly usage: number;
    }>(
      `select
         (select count(*)::integer from evaluation.feedback_evidence) as feedback,
         (select count(*)::integer from query.usage_receipt) as usage`,
    );
    return result.rows[0] ?? { feedback: 0, usage: 0 };
  }

  public async evidenceSummary(): Promise<EvidenceSummary> {
    const [usage, feedback] = await Promise.all([
      this.pool.query("select * from query.usage_receipt order by created_at desc"),
      this.pool.query("select * from evaluation.feedback_evidence order by received_at desc"),
    ]);
    return summarizeEvidence(
      usage.rows.map(usageFromRow),
      feedback.rows.map(feedbackFromRow),
    );
  }

  public async getPublishedRevision(
    spaceId: string,
    revisionId: string,
  ): Promise<PublishedAsset | undefined> {
    const result = await this.pool.query(
      `select p.*, e.document as publication_document,
              s.document as status_document
         from query.knowledge_projection p
         join governance.lifecycle_event e on e.event_id = p.publication_event_id
         left join lateral (
           select le.document
             from governance.revision_status rs
             join governance.lifecycle_event le on le.event_id = rs.event_id
            where rs.tenant_id = p.tenant_id and rs.space_id = p.space_id
              and rs.revision_id = p.revision_id
            order by rs.asserted_at desc limit 1
         ) s on true
        where p.tenant_id = $1 and p.space_id = $2 and p.revision_id = $3`,
      [this.config.tenantId, spaceId, revisionId],
    );
    return result.rows[0] === undefined ? undefined : publishedFromRow(result.rows[0]);
  }

  public async createUsage(state: UsageState): Promise<CreateResult<UsageState>> {
    const result = await this.pool.query(
      `insert into query.usage_receipt
         (usage_id, subject_digest, idempotency_key, request_digest,
          client_usage_id, exposure_receipt_id, feedback_until,
          request_document, receipt_document, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)
       on conflict do nothing
       returning usage_id`,
      usageParameters(state),
    );
    if (result.rowCount === 1) return { created: true, value: state };
    const existing = await this.pool.query(
      `select * from query.usage_receipt
        where subject_digest = $1
          and (idempotency_key = $2 or client_usage_id = $3)
        order by (idempotency_key = $2) desc limit 1`,
      [state.subjectDigest, state.idempotencyKey, state.clientUsageId],
    );
    return { created: false, value: usageFromRow(existing.rows[0]) };
  }

  public async getUsage(usageId: string): Promise<UsageState | undefined> {
    const result = await this.pool.query(
      "select * from query.usage_receipt where usage_id = $1",
      [usageId],
    );
    return result.rows[0] === undefined ? undefined : usageFromRow(result.rows[0]);
  }

  public async getWorkflowMutation(
    key: WorkflowMutationKey,
  ): Promise<WorkflowMutationLookup> {
    const result = await this.pool.query(
      `select * from contribution.mutation_idempotency
        where tenant_id = $1 and subject_digest = $2
          and operation = $3 and idempotency_key = $4`,
      [
        this.config.tenantId,
        key.subjectDigest,
        key.operation,
        key.idempotencyKey,
      ],
    );
    const row = result.rows[0];
    if (row === undefined || Date.parse(row.expires_at as string) <= Date.now()) {
      return { kind: "miss" };
    }
    const record = workflowMutationFromRow(row);
    return record.requestDigest === key.requestDigest
      ? { kind: "replay", record }
      : { kind: "conflict" };
  }

  public async createFeedback(
    state: FeedbackState,
  ): Promise<CreateResult<FeedbackState>> {
    const result = await this.pool.query(
      `insert into evaluation.feedback_evidence
         (feedback_id, subject_digest, idempotency_key, request_digest, usage_id,
          request_document, receipt_document, received_at)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)
       on conflict do nothing
       returning feedback_id`,
      [
        state.feedbackId,
        state.subjectDigest,
        state.idempotencyKey,
        state.requestDigest,
        state.usageId,
        JSON.stringify(state.request),
        JSON.stringify(state.receipt),
        state.receipt.receivedAt,
      ],
    );
    if (result.rowCount === 1) return { created: true, value: state };
    const existing = await this.pool.query(
      `select * from evaluation.feedback_evidence
        where subject_digest = $1
          and (idempotency_key = $2 or feedback_id = $3 or usage_id = $4)
        order by (idempotency_key = $2) desc,
                 (feedback_id = $3) desc,
                 (usage_id = $4) desc
        limit 1`,
      [state.subjectDigest, state.idempotencyKey, state.feedbackId, state.usageId],
    );
    return { created: false, value: feedbackFromRow(existing.rows[0]) };
  }

  async #transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const value = await operation(client);
      await client.query("commit");
      return value;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}

function lifecycleStatusCanAdvance(
  current: PublishedAsset["status"],
  next: Exclude<LifecycleEvent["status"], undefined | "quarantined">,
): boolean {
  if (current === "erased") return false;
  if (current === "revoked") return next === "erased";
  if (current === "deprecated") return next === "revoked" || next === "erased";
  return next === "deprecated" || next === "revoked" || next === "erased";
}

function removeMappedValues(
  map: Map<string, string>,
  removed: ReadonlySet<string>,
): void {
  for (const [key, value] of map) {
    if (removed.has(value)) map.delete(key);
  }
}

function assetKey(spaceId: string, revisionId: string): string {
  return `${spaceId}\0${revisionId}`;
}

function attestationKey(spaceId: string, attestationId: string): string {
  return `${spaceId}\0${attestationId}`;
}

function workflowMutationMapKey(key: WorkflowMutationKey): string {
  return `${key.subjectDigest}\0${key.operation}\0${key.idempotencyKey}`;
}

function mutationResult(
  lookup: Exclude<WorkflowMutationLookup, { readonly kind: "miss" }>,
): WorkflowMutationResult {
  return lookup.kind === "conflict"
    ? { kind: "conflict" }
    : { kind: "replayed", record: lookup.record };
}

async function beginWorkflowMutation(
  client: PoolClient,
  tenantId: string,
  mutation: WorkflowMutationKey,
): Promise<WorkflowMutationLookup> {
  const lockKey = JSON.stringify([
    tenantId,
    mutation.subjectDigest,
    mutation.operation,
    mutation.idempotencyKey,
  ]);
  await client.query(
    "select pg_advisory_xact_lock(hashtextextended($1, 0))",
    [lockKey],
  );
  const result = await client.query(
    `select * from contribution.mutation_idempotency
      where tenant_id = $1 and subject_digest = $2
        and operation = $3 and idempotency_key = $4
      for update`,
    [
      tenantId,
      mutation.subjectDigest,
      mutation.operation,
      mutation.idempotencyKey,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) return { kind: "miss" };
  const existing = workflowMutationFromRow(row);
  if (Date.parse(existing.expiresAt) <= Date.now()) {
    await client.query(
      `delete from contribution.mutation_idempotency
        where tenant_id = $1 and subject_digest = $2
          and operation = $3 and idempotency_key = $4`,
      [
        tenantId,
        mutation.subjectDigest,
        mutation.operation,
        mutation.idempotencyKey,
      ],
    );
    return { kind: "miss" };
  }
  return existing.requestDigest === mutation.requestDigest
    ? { kind: "replay", record: existing }
    : { kind: "conflict" };
}

async function insertWorkflowMutation(
  client: PoolClient,
  tenantId: string,
  mutation: WorkflowMutationRecord,
): Promise<void> {
  await client.query(
    `insert into contribution.mutation_idempotency
       (tenant_id, subject_digest, operation, idempotency_key, request_digest,
        response_status, response_document, response_headers, created_at, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)`,
    [
      tenantId,
      mutation.subjectDigest,
      mutation.operation,
      mutation.idempotencyKey,
      mutation.requestDigest,
      mutation.response.statusCode,
      JSON.stringify(mutation.response.body),
      JSON.stringify(mutation.response.headers),
      mutation.createdAt,
      mutation.expiresAt,
    ],
  );
}

function workflowMutationFromRow(row: Record<string, unknown>): WorkflowMutationRecord {
  return {
    createdAt: new Date(row.created_at as string).toISOString(),
    expiresAt: new Date(row.expires_at as string).toISOString(),
    idempotencyKey: row.idempotency_key as string,
    operation: row.operation as string,
    requestDigest: row.request_digest as string,
    response: {
      body: row.response_document as Record<string, unknown>,
      headers: row.response_headers as Record<string, string>,
      statusCode: row.response_status as number,
    },
    subjectDigest: row.subject_digest as string,
  };
}

function attestationParameters(
  tenantId: string,
  state: AttestationState,
): unknown[] {
  const statement = state.statement;
  return [
    tenantId,
    state.spaceId,
    statement.attestationId,
    statement.subject.revisionId,
    statement.subject.payloadDigest ?? null,
    statement.issuer,
    state.issuerSubjectDigest,
    state.idempotencyKey,
    statement.type,
    statement.result.outcome,
    statement.expiresAt,
    statement.method.digest,
    JSON.stringify(statement),
    state.documentDigest,
    state.createdAt,
  ];
}

function attestationFromRow(row: Record<string, unknown>): AttestationState {
  return {
    createdAt: new Date(row.created_at as string).toISOString(),
    documentDigest: row.document_digest as string,
    idempotencyKey: row.idempotency_key as string,
    issuerSubjectDigest: row.issuer_subject_digest as string,
    spaceId: row.space_id as string,
    statement: row.document as AttestationState["statement"],
  };
}

function evaluationRunParameters(
  tenantId: string,
  state: EvaluationRunState,
): unknown[] {
  const run = state.run;
  return [
    tenantId,
    run.spaceId,
    run.runId,
    run.clientRunId,
    run.subject.revisionId,
    state.issuerSubjectDigest,
    state.idempotencyKey,
    state.requestDigest,
    run.evaluator.digest,
    run.dataset.digest,
    run.startedAt,
    run.completedAt,
    run.gate.outcome,
    run.attestationId,
    JSON.stringify(run),
    state.documentDigest,
    state.createdAt,
  ];
}

function evaluationRunFromRow(row: Record<string, unknown>): EvaluationRunState {
  return {
    createdAt: new Date(row.created_at as string).toISOString(),
    documentDigest: row.document_digest as string,
    idempotencyKey: row.idempotency_key as string,
    issuerSubjectDigest: row.issuer_subject_digest as string,
    requestDigest: row.request_digest as string,
    run: row.document as EvaluationRunState["run"],
  };
}

function searchContent(asset: PublishedAsset): string {
  const payloadText = asset.payloads
    .filter((payload) => payload.mediaType.startsWith("text/"))
    .map((payload) => Buffer.from(payload.data, "base64").toString("utf8"))
    .join("\n");
  return [asset.manifest.title, asset.manifest.summary ?? "", payloadText]
    .filter(Boolean)
    .join("\n");
}

function contributionParameters(state: ContributionState): unknown[] {
  return [
    state.receipt.contributionId,
    state.subjectDigest,
    state.idempotencyKey,
    state.requestDigest,
    state.request.clientSubmissionId,
    state.request.spaceId,
    state.request.kind,
    state.receipt.subjectRevisionId,
    state.receipt.status,
    state.workflowVersion,
    JSON.stringify(state.request),
    JSON.stringify(state.payloads),
    JSON.stringify(state.receipt),
    state.reviewDecision === undefined ? null : JSON.stringify(state.reviewDecision),
    JSON.stringify(state.amendments),
    state.createdAt,
    state.updatedAt,
  ];
}

function contributionFromRow(row: Record<string, unknown>): ContributionState {
  return {
    amendments: row.amendments as readonly Record<string, unknown>[],
    createdAt: new Date(row.created_at as string).toISOString(),
    idempotencyKey: row.idempotency_key as string,
    payloads: row.payloads as ContributionState["payloads"],
    receipt: row.receipt_document as ContributionState["receipt"],
    request: row.request_document as ContributionState["request"],
    requestDigest: row.request_digest as string,
    ...(row.review_decision === null
      ? {}
      : { reviewDecision: row.review_decision as Record<string, unknown> }),
    subjectDigest: row.subject_digest as string,
    updatedAt: new Date(row.updated_at as string).toISOString(),
    workflowVersion: row.workflow_version as number,
  };
}

function publishedFromRow(row: Record<string, unknown>): PublishedAsset {
  return {
    indexedAt: new Date(row.indexed_at as string).toISOString(),
    manifest: row.manifest as PublishedAsset["manifest"],
    payloads: row.payloads as PublishedAsset["payloads"],
    publicationEvent: row.publication_document as LifecycleEvent,
    qualityAttestationRefs: row.quality_attestation_refs as readonly string[],
    qualityDecision: row.quality_decision as PublishedAsset["qualityDecision"],
    qualityReasons: row.quality_reasons as readonly string[],
    revisionId: row.revision_id as string,
    sourceContributionId: row.source_contribution_id as string,
    spaceId: row.space_id as string,
    ...(row.status_document === null || row.status_document === undefined
      ? {}
      : { statusEvent: row.status_document as LifecycleEvent }),
    status: row.status as PublishedAsset["status"],
  };
}

function usageParameters(state: UsageState): unknown[] {
  return [
    state.usageId,
    state.subjectDigest,
    state.idempotencyKey,
    state.requestDigest,
    state.clientUsageId,
    state.receipt.exposureReceiptId,
    state.receipt.feedbackUntil,
    JSON.stringify(state.request),
    JSON.stringify(state.receipt),
    state.receipt.createdAt,
  ];
}

function usageFromRow(row: Record<string, unknown>): UsageState {
  return {
    clientUsageId: row.client_usage_id as string,
    idempotencyKey: row.idempotency_key as string,
    receipt: row.receipt_document as Record<string, unknown>,
    request: row.request_document as Record<string, unknown>,
    requestDigest: row.request_digest as string,
    subjectDigest: row.subject_digest as string,
    usageId: row.usage_id as string,
  };
}

function feedbackFromRow(row: Record<string, unknown>): FeedbackState {
  return {
    feedbackId: row.feedback_id as string,
    idempotencyKey: row.idempotency_key as string,
    receipt: row.receipt_document as Record<string, unknown>,
    request: row.request_document as Record<string, unknown>,
    requestDigest: row.request_digest as string,
    subjectDigest: row.subject_digest as string,
    usageId: row.usage_id as string,
  };
}

function summarizeEvidence(
  usages: readonly UsageState[],
  feedbackItems: readonly FeedbackState[],
): EvidenceSummary {
  const revisionUsage = new Map<string, Set<string>>();
  const revisionFeedback = new Map<string, { feedback: number; harmed: number; helped: number }>();
  const taskCategories = new Map<string, { feedback: number; usage: number }>();
  const outcomes = { harmed: 0, helped: 0, neutral: 0, unknown: 0 };
  const harmed: EvidenceSummary["harmed"][number][] = [];
  let eligibleFeedback = 0;

  for (const usage of usages) {
    const category = stringValue(usage.request.taskCategory, "uncategorized");
    const categoryState = taskCategories.get(category) ?? { feedback: 0, usage: 0 };
    categoryState.usage += 1;
    taskCategories.set(category, categoryState);
    for (const revisionId of revisionIds(usage.request.citations)) {
      const ids = revisionUsage.get(revisionId) ?? new Set<string>();
      ids.add(usage.usageId);
      revisionUsage.set(revisionId, ids);
    }
  }

  for (const feedback of feedbackItems) {
    const outcome = feedback.request.outcome;
    const normalizedOutcome =
      outcome === "helped" || outcome === "neutral" || outcome === "harmed"
        ? outcome
        : "unknown";
    const eligible = feedback.receipt.eligibleForAggregation === true;
    const correlationClass = stringValue(
      feedback.receipt.correlationClass,
      "unknown",
    );
    if (eligible) {
      outcomes[normalizedOutcome] += 1;
      eligibleFeedback += 1;
    }
    const category = stringValue(feedback.request.taskCategory, "uncategorized");
    const categoryState = taskCategories.get(category) ?? { feedback: 0, usage: 0 };
    if (eligible) categoryState.feedback += 1;
    taskCategories.set(category, categoryState);
    const outcomesByRevision = citationOutcomes(
      feedback.request.citations,
      normalizedOutcome,
    );
    const ids = [...outcomesByRevision.keys()];
    if (eligible) {
      for (const [revisionId, revisionOutcome] of outcomesByRevision) {
        const state = revisionFeedback.get(revisionId) ?? { feedback: 0, harmed: 0, helped: 0 };
        state.feedback += 1;
        if (revisionOutcome === "harmed") state.harmed += 1;
        if (revisionOutcome === "helped") state.helped += 1;
        revisionFeedback.set(revisionId, state);
      }
    }
    const harmedRevisionIds = ids.filter(
      (revisionId) => outcomesByRevision.get(revisionId) === "harmed",
    );
    if (harmedRevisionIds.length > 0) {
      const observedAt = feedback.request.observedAt;
      harmed.push({
        correlationClass,
        eligibleForAggregation: eligible,
        feedbackId: feedback.feedbackId,
        ...(typeof observedAt === "string" ? { observedAt } : {}),
        revisionIds: harmedRevisionIds,
        taskCategory: category,
        usageId: feedback.usageId,
      });
    }
  }

  const allRevisionIds = new Set([...revisionUsage.keys(), ...revisionFeedback.keys()]);
  return {
    generatedAt: new Date().toISOString(),
    harmed,
    outcomes,
    revisions: [...allRevisionIds]
      .sort()
      .map((revisionId) => ({
        feedback: revisionFeedback.get(revisionId)?.feedback ?? 0,
        harmed: revisionFeedback.get(revisionId)?.harmed ?? 0,
        helped: revisionFeedback.get(revisionId)?.helped ?? 0,
        revisionId,
        usage: revisionUsage.get(revisionId)?.size ?? 0,
      })),
    taskCategories: [...taskCategories.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => ({ name, ...value })),
    totals: {
      eligibleFeedback,
      feedback: feedbackItems.length,
      usage: usages.length,
    },
  };
}

type FeedbackOutcome = "harmed" | "helped" | "neutral" | "unknown";

function citationOutcomes(
  value: unknown,
  fallback: FeedbackOutcome,
): ReadonlyMap<string, FeedbackOutcome> {
  const outcomes = new Map<string, FeedbackOutcome>();
  if (!Array.isArray(value)) return outcomes;
  for (const valueCitation of value) {
    if (typeof valueCitation !== "object" || valueCitation === null) continue;
    const citation = valueCitation as Record<string, unknown>;
    if (typeof citation.revisionId !== "string") continue;
    const explicit = citation.outcome;
    const outcome: FeedbackOutcome =
      explicit === "helped" || explicit === "neutral" || explicit === "harmed"
        ? explicit
        : fallback;
    const previous = outcomes.get(citation.revisionId);
    if (previous === undefined || outcomePriority(outcome) > outcomePriority(previous)) {
      outcomes.set(citation.revisionId, outcome);
    }
  }
  return outcomes;
}

function outcomePriority(outcome: FeedbackOutcome): number {
  switch (outcome) {
    case "harmed":
      return 4;
    case "helped":
      return 3;
    case "neutral":
      return 2;
    case "unknown":
      return 1;
  }
}

function revisionIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((citation) => {
    if (typeof citation !== "object" || citation === null) return [];
    const revisionId = (citation as Record<string, unknown>).revisionId;
    return typeof revisionId === "string" ? [revisionId] : [];
  }))];
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

async function lockWorkflow(
  client: PoolClient,
  contributionId: string,
  expectedVersion: number,
): Promise<boolean> {
  const result = await client.query<{ readonly workflow_version: number }>(
    `select workflow_version from contribution.workflow
      where contribution_id = $1 for update`,
    [contributionId],
  );
  return result.rows[0]?.workflow_version === expectedVersion;
}

async function updateLockedWorkflow(
  client: PoolClient,
  contributionId: string,
  next: ContributionState,
): Promise<void> {
  await client.query(
    `update contribution.workflow
        set status = $2, workflow_version = $3, receipt_document = $4::jsonb,
            review_decision = $5::jsonb, amendments = $6::jsonb,
            payloads = $7::jsonb, updated_at = $8
      where contribution_id = $1`,
    [
      contributionId,
      next.receipt.status,
      next.workflowVersion,
      JSON.stringify(next.receipt),
      next.reviewDecision === undefined ? null : JSON.stringify(next.reviewDecision),
      JSON.stringify(next.amendments),
      JSON.stringify(next.payloads),
      next.updatedAt,
    ],
  );
}

async function insertLifecycleEvent(
  client: PoolClient,
  event: LifecycleEvent,
): Promise<void> {
  await client.query(
    `insert into governance.lifecycle_event
       (event_id, event_type, space_id, record_id, revision_id,
        policy_epoch, document, occurred_at)
     values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
    [
      event.eventId,
      event.eventType,
      event.spaceId,
      event.recordId,
      event.revisionId,
      event.policyEpoch,
      JSON.stringify(event),
      event.occurredAt,
    ],
  );
}

async function insertOutbox(
  client: PoolClient,
  owner: string,
  eventType: string,
  event: LifecycleEvent,
): Promise<void> {
  await client.query(
    `insert into platform.outbox_event
       (owner_module, event_type, aggregate_id, payload)
     values ($1,$2,$3,$4::jsonb)`,
    [owner, eventType, event.revisionId, JSON.stringify(event)],
  );
}
