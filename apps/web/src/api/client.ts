import type {
  BuiltContribution,
  Capability,
  ConsoleAsset,
  ContributionListItem,
  ContributionReceipt,
  EvidenceSummary,
  Overview,
  QueryResponse,
  QueryResultItem,
  RevisionDetail,
  RevisionResource,
  ServiceHealth,
} from "./types";

export const DEVELOPMENT_TOKENS = {
  contributor: "dev-contributor",
  console: "dev-console",
  curator: "dev-curator",
  evaluator: "dev-evaluator",
  eraser: "dev-eraser",
  incident: "dev-incident",
  publisher: "dev-publisher",
  reader: "dev-reader",
} as const;

export interface ApiResult<T> {
  readonly data: T;
  readonly response: Response;
}

export async function createLifecycleContribution(input: {
  readonly action: "deprecate" | "revoke" | "erase";
  readonly rationale: string;
  readonly revisionId: string;
  readonly spaceId: string;
}): Promise<ApiResult<ContributionReceipt>> {
  return request<ContributionReceipt>("/akep/0.1/contributions", {
    body: JSON.stringify({
      akepVersion: "0.1",
      clientSubmissionId: `web-lifecycle-${crypto.randomUUID()}`,
      critical: [],
      evidenceRefs: [],
      extensions: {},
      kind: input.action,
      rationale: input.rationale,
      spaceId: input.spaceId,
      targetRevisionId: input.revisionId,
    }),
    headers: { "Idempotency-Key": `web-lifecycle-${crypto.randomUUID()}` },
    method: "POST",
    token: DEVELOPMENT_TOKENS.contributor,
  });
}

export class ApiProblem extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiProblem";
  }
}

async function request<T>(
  path: string,
  options: RequestInit & { readonly token?: string } = {},
): Promise<ApiResult<T>> {
  const response = await requestResponse(path, options);
  return { data: (await response.json()) as T, response };
}

async function requestResponse(
  path: string,
  options: RequestInit & { readonly token?: string } = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set("AKEP-Version", "0.1");
  if (options.token !== undefined) headers.set("Authorization", `Bearer ${options.token}`);
  if (options.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    const problem = (await response.json().catch(() => ({}))) as {
      readonly code?: string;
      readonly detail?: string;
      readonly title?: string;
    };
    throw new ApiProblem(
      response.status,
      problem.code ?? "HTTP_ERROR",
      problem.detail ?? problem.title ?? `请求失败（${response.status}）`,
    );
  }
  return response;
}

export async function getCapability(): Promise<Capability> {
  return (await request<Capability>("/.well-known/akep")).data;
}

export async function getOverview(): Promise<Overview> {
  return (
    await request<Overview>("/console/v1/overview", {
      token: DEVELOPMENT_TOKENS.console,
    })
  ).data;
}

export async function getEvidenceSummary(): Promise<EvidenceSummary> {
  return (
    await request<EvidenceSummary>("/console/v1/evidence-summary", {
      token: DEVELOPMENT_TOKENS.console,
    })
  ).data;
}

export async function getServiceHealth(): Promise<ServiceHealth> {
  return (
    await request<ServiceHealth>("/console/v1/service-health", {
      token: DEVELOPMENT_TOKENS.console,
    })
  ).data;
}

export async function getAssets(): Promise<readonly ConsoleAsset[]> {
  return (
    await request<{ readonly assets: readonly ConsoleAsset[] }>("/console/v1/assets", {
      token: DEVELOPMENT_TOKENS.console,
    })
  ).data.assets;
}

export async function getContributions(
  role: "contributor" | "curator" | "publisher" | "incident" | "eraser",
): Promise<readonly ContributionListItem[]> {
  return (
    await request<{ readonly contributions: readonly ContributionListItem[] }>(
      "/console/v1/contributions",
      { token: DEVELOPMENT_TOKENS[role] },
    )
  ).data.contributions;
}

export async function searchKnowledge(input: {
  readonly assetTypes?: readonly string[];
  readonly cursor?: string;
  readonly labels?: readonly string[];
  readonly limit?: number;
  readonly query: string;
  readonly spaceId?: string;
}): Promise<QueryResponse> {
  return (
    await request<QueryResponse>("/akep/0.1/queries", {
      body: JSON.stringify({
        critical: [],
        extensions: {},
        include: ["summary", "passages", "relations", "attestations", "provenance"],
        limit: input.limit ?? 30,
        mode: "lexical",
        purpose: "customer-support",
        query: { locale: "zh-CN", text: input.query },
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.assetTypes === undefined && input.labels === undefined
          ? {}
          : {
              filters: {
                ...(input.assetTypes === undefined ? {} : { assetTypes: input.assetTypes }),
                ...(input.labels === undefined ? {} : { labels: input.labels }),
              },
            }),
        ...(input.spaceId === undefined ? {} : { spaces: [input.spaceId] }),
        supportedObligations: ["cite", "no-train"],
      }),
      method: "POST",
      token: DEVELOPMENT_TOKENS.reader,
    })
  ).data;
}

export async function createContribution(
  contribution: BuiltContribution,
): Promise<ApiResult<ContributionReceipt>> {
  return request<ContributionReceipt>("/akep/0.1/contributions", {
    body: JSON.stringify(contribution.body),
    headers: { "Idempotency-Key": `web-contribution-${crypto.randomUUID()}` },
    method: "POST",
    token: DEVELOPMENT_TOKENS.contributor,
  });
}

export async function reviewContribution(input: {
  readonly attestationRefs: readonly string[];
  readonly contributionId: string;
  readonly decision: "verify" | "reject" | "request_evidence" | "quarantine";
  readonly etag: string;
  readonly rationale: string;
}): Promise<ApiResult<ContributionReceipt>> {
  return request<ContributionReceipt>(
    `/akep/0.1/contributions/${encodeURIComponent(input.contributionId)}/decisions`,
    {
      body: JSON.stringify({
        akepVersion: "0.1",
        attestationRefs: input.decision === "verify" ? input.attestationRefs : [],
        critical: [],
        decision: input.decision,
        decisionId: `urn:uuid:${crypto.randomUUID()}`,
        extensions: {},
        policyVersion: {
          digest: `sha256:${"a".repeat(64)}`,
          uri: "https://knowledge.local/policies/review/1",
        },
        rationale: input.rationale,
      }),
      headers: {
        "Idempotency-Key": `web-review-${crypto.randomUUID()}`,
        "If-Match": input.etag,
      },
      method: "POST",
      token: DEVELOPMENT_TOKENS.curator,
    },
  );
}

export async function applyGovernanceAction(input: {
  readonly action: "publish" | "deprecate" | "revoke" | "erase";
  readonly attestationRefs: readonly string[];
  readonly contributionId: string;
  readonly etag: string;
  readonly policyEpoch: string;
  readonly rationale: string;
}): Promise<ApiResult<ContributionReceipt>> {
  const role =
    input.action === "revoke"
      ? "incident"
      : input.action === "erase"
        ? "eraser"
        : "publisher";
  return request<ContributionReceipt>(
    `/akep/0.1/contributions/${encodeURIComponent(input.contributionId)}/actions/${input.action}`,
    {
      body: JSON.stringify({
        akepVersion: "0.1",
        attestationRefs: input.attestationRefs,
        critical: [],
        decisionId: `urn:uuid:${crypto.randomUUID()}`,
        expectedPolicyEpoch: input.policyEpoch,
        extensions: {},
        policyVersion: {
          digest: `sha256:${"b".repeat(64)}`,
          uri: "https://knowledge.local/policies/publication/1",
        },
        rationale: input.rationale,
      }),
      headers: {
        "Idempotency-Key": `web-${input.action}-${crypto.randomUUID()}`,
        "If-Match": input.etag,
      },
      method: "POST",
      token: DEVELOPMENT_TOKENS[role],
    },
  );
}

export async function getRevision(spaceId: string, revisionId: string): Promise<RevisionResource> {
  return (
    await request<RevisionResource>(
      `/akep/0.1/spaces/${encodeURIComponent(spaceId)}/revisions/${encodeURIComponent(revisionId)}`,
      {
        headers: directReadHeaders(),
        token: DEVELOPMENT_TOKENS.reader,
      },
    )
  ).data;
}

export async function getRevisionDetail(
  spaceId: string,
  revisionId: string,
): Promise<RevisionDetail> {
  const revision = await request<RevisionResource>(
    `/akep/0.1/spaces/${encodeURIComponent(spaceId)}/revisions/${encodeURIComponent(revisionId)}`,
    { headers: directReadHeaders(), token: DEVELOPMENT_TOKENS.reader },
  );
  const primary = revision.data.manifest.payloads.find((payload) => payload.name === "primary");
  if (primary === undefined || !primary.mediaType.startsWith("text/")) {
    return {
      content: "该版本没有可直接预览的文本主内容。",
      ...(revision.response.headers.get("akep-read-receipt") === null
        ? {}
        : { readReceiptId: revision.response.headers.get("akep-read-receipt")! }),
      resource: revision.data,
    };
  }
  const blob = await requestResponse(
    `/akep/0.1/spaces/${encodeURIComponent(spaceId)}/revisions/${encodeURIComponent(revisionId)}/blobs/${encodeURIComponent(primary.digest)}`,
    { headers: directReadHeaders(), token: DEVELOPMENT_TOKENS.reader },
  );
  return {
    content: await blob.text(),
    ...(blob.headers.get("akep-read-receipt") === null
      ? {}
      : { readReceiptId: blob.headers.get("akep-read-receipt")! }),
    resource: revision.data,
  };
}

export async function recordKnowledgeOutcome(input: {
  readonly item: QueryResultItem;
  readonly outcome: "harmed" | "helped" | "neutral";
  readonly queryReceiptId: string;
  readonly taskCategory?: string;
}): Promise<void> {
  const citations = input.item.citations.map((citation, index) => ({
    citationId: citation.citationId,
    influence: index === 0 ? "primary" : "supporting",
    locator: citation.locator,
    payloadDigest: citation.payloadDigest,
    revisionId: input.item.revisionId,
  }));
  if (citations.length === 0) throw new Error("该结果没有可绑定的引用，不能记录使用证据");
  const taskCategory = input.taskCategory ?? "customer-support/general";
  const usage = await request<Record<string, any>>("/akep/0.1/usages", {
    body: JSON.stringify({
      akepVersion: "0.1",
      citations,
      clientUsageId: `web-usage-${crypto.randomUUID()}`,
      critical: [],
      exposureReceiptId: input.queryReceiptId,
      extensions: {},
      occurredAt: new Date().toISOString(),
      purpose: "customer-support",
      spaceId: input.item.spaceId,
      taskCategory,
    }),
    headers: { "Idempotency-Key": `web-usage-${crypto.randomUUID()}` },
    method: "POST",
    token: DEVELOPMENT_TOKENS.reader,
  });
  const feedbackCitations = citations.map(({ influence: _influence, ...citation }) => ({
    ...citation,
    outcome: input.outcome,
  }));
  await request<Record<string, unknown>>("/akep/0.1/feedback", {
    body: JSON.stringify({
      akepVersion: "0.1",
      citations: feedbackCitations,
      critical: [],
      evaluatorVersion: {
        digest: `sha256:${"c".repeat(64)}`,
        uri: "https://knowledge.local/evaluators/human-outcome/1",
      },
      evidenceRefs: [],
      extensions: {},
      feedbackId: `urn:uuid:${crypto.randomUUID()}`,
      metrics: [{ name: "resolution.success", unit: "boolean", value: input.outcome === "helped" ? 1 : 0 }],
      observedAt: new Date().toISOString(),
      outcome: input.outcome,
      privacy: { aggregation: "pseudonymized", rawTaskStored: false },
      taskCategory,
      usageId: usage.data.usageId,
    }),
    headers: { "Idempotency-Key": `web-feedback-${crypto.randomUUID()}` },
    method: "POST",
    token: DEVELOPMENT_TOKENS.reader,
  });
}

export async function amendContribution(input: {
  readonly contributionId: string;
  readonly etag: string;
  readonly evidenceRefs: readonly string[];
  readonly rationale: string;
}): Promise<ApiResult<ContributionReceipt>> {
  return request<ContributionReceipt>(
    `/akep/0.1/contributions/${encodeURIComponent(input.contributionId)}/evidence`,
    {
      body: JSON.stringify({
        akepVersion: "0.1",
        amendmentId: `urn:uuid:${crypto.randomUUID()}`,
        critical: [],
        evidenceRefs: input.evidenceRefs,
        extensions: {},
        rationale: input.rationale,
      }),
      headers: {
        "Idempotency-Key": `web-amend-${crypto.randomUUID()}`,
        "If-Match": input.etag,
      },
      method: "POST",
      token: DEVELOPMENT_TOKENS.contributor,
    },
  );
}

export function contributionEvidenceRefs(
  contribution: ContributionListItem,
): readonly string[] {
  const amended = contribution.amendments.flatMap((amendment) => {
    const references = amendment.evidenceRefs;
    return Array.isArray(references)
      ? references.filter((value): value is string => typeof value === "string")
      : [];
  });
  return [...new Set([...contribution.request.evidenceRefs, ...amended])];
}

export async function withdrawContribution(input: {
  readonly contributionId: string;
  readonly etag: string;
  readonly reason: string;
}): Promise<ApiResult<ContributionReceipt>> {
  return request<ContributionReceipt>(
    `/akep/0.1/contributions/${encodeURIComponent(input.contributionId)}/withdraw`,
    {
      body: JSON.stringify({
        akepVersion: "0.1",
        critical: [],
        extensions: {},
        reason: input.reason,
        withdrawalId: `urn:uuid:${crypto.randomUUID()}`,
      }),
      headers: {
        "Idempotency-Key": `web-withdraw-${crypto.randomUUID()}`,
        "If-Match": input.etag,
      },
      method: "POST",
      token: DEVELOPMENT_TOKENS.contributor,
    },
  );
}

function directReadHeaders(): Record<string, string> {
  const obligationSupport = btoa('["cite","no-train"]')
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  return {
    "AKEP-Obligation-Support": obligationSupport,
    "AKEP-Purpose": "customer-support",
  };
}
