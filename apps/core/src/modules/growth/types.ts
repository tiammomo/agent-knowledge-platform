export interface SchemaReference {
  readonly digest: string;
  readonly uri: string;
}

export interface PayloadDescriptor {
  readonly digest: string;
  readonly mediaType: string;
  readonly name: string;
  readonly size: number;
  readonly language?: string;
}

export interface AssetManifest {
  readonly assetType: string;
  readonly critical: readonly string[];
  readonly payloads: readonly PayloadDescriptor[];
  readonly policy: {
    readonly allowedPurposes?: readonly string[];
    readonly obligations?: readonly unknown[];
    readonly [key: string]: unknown;
  };
  readonly profile: SchemaReference;
  readonly provenance: Record<string, unknown>;
  readonly recordId: string;
  readonly relations?: readonly Record<string, unknown>[];
  readonly summary?: string;
  readonly title: string;
  readonly [key: string]: unknown;
}

export interface InlinePayload {
  readonly data: string;
  readonly digest: string;
  readonly encoding: "base64";
  readonly name: string;
}

export interface ContributionRequest {
  readonly akepVersion: "0.1";
  readonly baseRevisionIds?: readonly string[];
  readonly clientSubmissionId: string;
  readonly critical: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly inlinePayloads?: readonly InlinePayload[];
  readonly kind: "create" | "revise" | "deprecate" | "revoke" | "erase";
  readonly manifest?: AssetManifest;
  readonly rationale: string;
  readonly revisionId?: string;
  readonly spaceId: string;
  readonly targetRevisionId?: string;
  readonly [key: string]: unknown;
}

export interface PayloadDocument {
  readonly data: string;
  readonly digest: string;
  readonly mediaType: string;
  readonly name: string;
  readonly size: number;
}

export type ContributionStatus =
  | "candidate"
  | "validating"
  | "needs_evidence"
  | "verified"
  | "accepted"
  | "rejected"
  | "quarantined"
  | "withdrawn";

export interface ContributionReceipt {
  readonly contributionId: string;
  readonly createdAt: string;
  readonly decisionRefs?: readonly string[];
  readonly kind: ContributionRequest["kind"];
  readonly policyEpoch: string;
  readonly spaceId: string;
  readonly status: ContributionStatus;
  readonly statusUrl: string;
  readonly subjectRevisionId: string;
  readonly submittedRevisionId?: string;
  readonly updatedAt?: string;
}

export interface ContributionState {
  readonly amendments: readonly Record<string, unknown>[];
  readonly createdAt: string;
  readonly idempotencyKey: string;
  readonly payloads: readonly PayloadDocument[];
  readonly receipt: ContributionReceipt;
  readonly request: ContributionRequest;
  readonly requestDigest: string;
  readonly reviewDecision?: Record<string, unknown>;
  readonly subjectDigest: string;
  readonly updatedAt: string;
  readonly workflowVersion: number;
}

export interface LifecycleEvent {
  readonly actor: string;
  readonly attestationRefs: readonly string[];
  readonly channel?: "candidate" | "verified" | "published";
  readonly critical: readonly string[];
  readonly eventId: string;
  readonly eventType: "channel.updated" | "status.asserted" | "status.cleared";
  readonly eventVersion: "0.1";
  readonly occurredAt: string;
  readonly policyEpoch: string;
  readonly policyVersion: SchemaReference;
  readonly reason: string;
  readonly recordId: string;
  readonly revisionId: string;
  readonly spaceId: string;
  readonly status?: "deprecated" | "revoked" | "quarantined" | "erased";
  readonly trustDomain: string;
}

export interface PublishedAsset {
  readonly indexedAt: string;
  readonly manifest: AssetManifest;
  readonly payloads: readonly PayloadDocument[];
  readonly publicationEvent: LifecycleEvent;
  readonly qualityAttestationRefs: readonly string[];
  readonly qualityDecision: "suitable" | "suitable_with_warning";
  readonly qualityReasons: readonly string[];
  readonly revisionId: string;
  readonly sourceContributionId: string;
  readonly spaceId: string;
  readonly statusEvent?: LifecycleEvent;
  readonly status: "published" | "superseded" | "deprecated" | "revoked" | "erased";
}

export interface UsageState {
  readonly clientUsageId: string;
  readonly idempotencyKey: string;
  readonly receipt: Record<string, unknown>;
  readonly request: Record<string, unknown>;
  readonly requestDigest: string;
  readonly subjectDigest: string;
  readonly usageId: string;
}

export interface FeedbackState {
  readonly feedbackId: string;
  readonly idempotencyKey: string;
  readonly receipt: Record<string, unknown>;
  readonly request: Record<string, unknown>;
  readonly requestDigest: string;
  readonly subjectDigest: string;
  readonly usageId: string;
}

export function contributionEtag(state: ContributionState): string {
  return `"akep-contribution-${state.workflowVersion}"`;
}
