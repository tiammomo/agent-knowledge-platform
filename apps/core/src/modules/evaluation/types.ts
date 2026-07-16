import type { SchemaReference } from "../growth/types.js";

export type AttestationOutcome =
  | "pass"
  | "fail"
  | "warning"
  | "informational";

export interface AttestationFinding {
  readonly code: string;
  readonly severity: "info" | "low" | "medium" | "high" | "critical";
  readonly message?: string;
}

export interface AttestationStatement {
  readonly attestationVersion: "0.1";
  readonly attestationId: string;
  readonly type: string;
  readonly subject: {
    readonly revisionId: string;
    readonly payloadDigest?: string;
  };
  readonly issuer: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly method: SchemaReference;
  readonly result: {
    readonly outcome: AttestationOutcome;
    readonly summary?: string;
    readonly findings?: readonly AttestationFinding[];
    readonly metrics?: Readonly<Record<string, number>>;
  };
  readonly evidenceRefs: readonly string[];
  readonly envelopeRef?: string;
  readonly extensions?: Readonly<Record<string, unknown>>;
  readonly critical: readonly string[];
}

export interface AttestationState {
  readonly createdAt: string;
  readonly documentDigest: string;
  readonly idempotencyKey: string;
  readonly issuerSubjectDigest: string;
  readonly spaceId: string;
  readonly statement: AttestationStatement;
}

export interface EvaluationThreshold {
  readonly operator: "gte" | "lte";
  readonly required?: boolean;
  readonly value: number;
}

export interface EvaluationGateCheck {
  readonly actual: number;
  readonly metric: string;
  readonly operator: EvaluationThreshold["operator"];
  readonly passed: boolean;
  readonly required: boolean;
  readonly threshold: number;
}

export interface EvaluationRunRequest {
  readonly akepVersion: "0.1";
  readonly clientRunId: string;
  readonly completedAt: string;
  readonly critical: readonly string[];
  readonly dataset: SchemaReference;
  readonly evaluator: SchemaReference;
  readonly evidenceRefs: readonly string[];
  readonly expiresAt: string;
  readonly metrics: Readonly<Record<string, number>>;
  readonly revisionId: string;
  readonly spaceId: string;
  readonly startedAt: string;
  readonly summary: string;
  readonly thresholds: Readonly<Record<string, EvaluationThreshold>>;
}

export interface EvaluationRun {
  readonly attestationId: string;
  readonly clientRunId: string;
  readonly completedAt: string;
  readonly critical: readonly string[];
  readonly dataset: SchemaReference;
  readonly evaluationRunVersion: "0.1";
  readonly evaluator: SchemaReference;
  readonly evidenceRefs: readonly string[];
  readonly gate: {
    readonly checks: readonly EvaluationGateCheck[];
    readonly outcome: "pass" | "warning" | "fail";
    readonly reasons: readonly string[];
  };
  readonly metrics: Readonly<Record<string, number>>;
  readonly runId: string;
  readonly spaceId: string;
  readonly startedAt: string;
  readonly status: "completed";
  readonly subject: { readonly revisionId: string };
  readonly thresholds: Readonly<Record<string, EvaluationThreshold>>;
}

export interface EvaluationRunState {
  readonly createdAt: string;
  readonly documentDigest: string;
  readonly idempotencyKey: string;
  readonly issuerSubjectDigest: string;
  readonly requestDigest: string;
  readonly run: EvaluationRun;
}

export interface QualityGateDecision {
  readonly attestationRefs: readonly string[];
  readonly decision: "suitable" | "suitable_with_warning";
  readonly reasons: readonly string[];
}
