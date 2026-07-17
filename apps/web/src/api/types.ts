export type ContributionStatus =
  | "candidate"
  | "validating"
  | "needs_evidence"
  | "verified"
  | "accepted"
  | "rejected"
  | "quarantined"
  | "withdrawn";

export interface Capability {
  readonly auth: { readonly protectedResourceMetadata: string };
  readonly baseUrl: string;
  readonly expiresAt: string;
  readonly limits: {
    readonly idempotencyWindowSeconds: number;
    readonly maxPageSize: number;
    readonly maxPayloadBytes: number;
  };
  readonly node: { readonly id: string; readonly name: string; readonly trustDomain?: string };
  readonly operations: readonly string[];
  readonly profiles: readonly string[];
  readonly protocol: string;
  readonly schemas: Readonly<Record<string, string>>;
  readonly supportedExtensions: readonly { readonly required: boolean; readonly uri: string }[];
  readonly versions: readonly string[];
}

export interface KnowledgeProvenance {
  readonly attributedTo?: readonly string[];
  readonly generatedBy?: {
    readonly actor?: string;
    readonly endedAt?: string;
    readonly type?: string;
  };
  readonly primarySources?: readonly string[];
}

export interface KnowledgeScope {
  readonly assumptions?: readonly string[];
  readonly jurisdiction?: string;
  readonly locale?: string;
  readonly reviewAfter?: string;
  readonly validFrom?: string;
  readonly validUntil?: string;
}

export interface KnowledgePolicy {
  readonly allowedPurposes?: readonly string[];
  readonly classification?: string;
  readonly export?: string;
  readonly obligations?: readonly unknown[];
  readonly owners?: readonly string[];
}

export interface Overview {
  readonly generatedAt: string;
  readonly node: {
    readonly id: string;
    readonly name: string;
    readonly policyEpoch: string;
    readonly trustDomain: string;
  };
  readonly recentActivity: readonly ActivityItem[];
  readonly spaces: readonly {
    readonly assetCount: number;
    readonly id: string;
    readonly pendingCount: number;
  }[];
  readonly totals: {
    readonly feedback: number;
    readonly knowledge: number;
    readonly pendingReview: number;
    readonly published: number;
    readonly revoked: number;
    readonly usage: number;
  };
  readonly workflow: Readonly<Record<ContributionStatus, number>>;
}

export interface ActivityItem {
  readonly contributionId: string;
  readonly kind: string;
  readonly recordId?: string;
  readonly spaceId: string;
  readonly status: ContributionStatus;
  readonly title: string;
  readonly updatedAt: string;
}

export interface ConsoleAsset {
  readonly assetType: string;
  readonly indexedAt: string;
  readonly labels: readonly string[];
  readonly obligations: readonly unknown[];
  readonly profile: { readonly digest: string; readonly uri: string };
  readonly qualityAttestationRefs: readonly string[];
  readonly qualityDecision: "suitable" | "suitable_with_warning";
  readonly qualityReasons: readonly string[];
  readonly recordId: string;
  readonly revisionId: string;
  readonly spaceId: string;
  readonly status: "published" | "superseded" | "deprecated" | "revoked" | "erased";
  readonly summary?: string;
  readonly title: string;
}

export interface ContributionReceipt {
  readonly contributionId: string;
  readonly createdAt: string;
  readonly decisionRefs?: readonly string[];
  readonly kind: "create" | "revise" | "deprecate" | "revoke" | "erase";
  readonly policyEpoch: string;
  readonly spaceId: string;
  readonly status: ContributionStatus;
  readonly statusUrl: string;
  readonly subjectRevisionId: string;
  readonly submittedRevisionId?: string;
  readonly updatedAt?: string;
}

export interface ContributionListItem {
  readonly amendments: readonly Record<string, unknown>[];
  readonly etag: string;
  readonly payloads: readonly {
    readonly data: string;
    readonly digest: string;
    readonly mediaType: string;
    readonly name: string;
    readonly size: number;
  }[];
  readonly receipt: ContributionReceipt;
  readonly request: {
    readonly evidenceRefs: readonly string[];
    readonly kind: ContributionReceipt["kind"];
    readonly manifest?: Record<string, any>;
    readonly rationale: string;
    readonly spaceId: string;
    readonly targetRevisionId?: string;
  };
  readonly reviewDecision?: Record<string, unknown>;
  readonly updatedAt: string;
}

export interface QueryResultItem {
  readonly assetType: string;
  readonly citations: readonly {
    readonly citationId: string;
    readonly locator: Record<string, unknown>;
    readonly payloadDigest: string;
    readonly quote?: string;
  }[];
  readonly effectiveDecision?: "allowed" | "allowed_with_obligations";
  readonly obligations: readonly unknown[];
  readonly profile?: { readonly digest: string; readonly uri: string };
  readonly provenance?: KnowledgeProvenance;
  readonly qualityAttestationRefs: readonly string[];
  readonly qualityDecision: string;
  readonly qualityReasons: readonly string[];
  readonly recordId: string;
  readonly relations?: readonly { readonly target: string; readonly type: string }[];
  readonly revisionId: string;
  readonly scores: readonly {
    readonly backend?: string;
    readonly method: string;
    readonly metric?: string;
    readonly profile?: string;
    readonly value: number;
  }[];
  readonly spaceId: string;
  readonly statuses?: readonly "deprecated"[];
  readonly summary?: string;
  readonly title: string;
}

export interface QueryResponse {
  readonly indexedThrough: string;
  readonly nextCursor?: string;
  readonly policyEpoch: string;
  readonly projectionGeneration: string;
  readonly queryReceiptId: string;
  readonly results: readonly QueryResultItem[];
  readonly snapshot: string;
}

export interface RevisionResource {
  readonly manifest: Record<string, any> & {
    readonly policy?: KnowledgePolicy;
    readonly profile?: { readonly digest: string; readonly uri: string };
    readonly provenance?: KnowledgeProvenance;
    readonly payloads: readonly {
      readonly digest: string;
      readonly mediaType: string;
      readonly name: string;
      readonly size: number;
    }[];
    readonly scope?: KnowledgeScope;
  };
  readonly revisionId: string;
}

export interface RevisionDetail {
  readonly content: string;
  readonly readReceiptId?: string;
  readonly resource: RevisionResource;
}

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

export interface EvaluationRun {
  readonly attestationId: string;
  readonly gate: {
    readonly outcome: "fail" | "pass" | "warning";
    readonly reasons: readonly string[];
  };
  readonly runId: string;
}

export interface ServiceHealth {
  readonly generatedAt: string;
  readonly objective: { readonly errorRateMaximum: number; readonly p95Milliseconds: number };
  readonly status: "degraded" | "meeting_objective";
  readonly window: {
    readonly errorRate: number;
    readonly eventLoopP95Milliseconds: number;
    readonly p50Milliseconds: number;
    readonly p95Milliseconds: number;
    readonly requestCount: number;
    readonly serverErrors: number;
  };
}

export interface BuiltContribution {
  readonly body: Record<string, unknown>;
  readonly manifest: Record<string, unknown>;
  readonly revisionId: string;
}
