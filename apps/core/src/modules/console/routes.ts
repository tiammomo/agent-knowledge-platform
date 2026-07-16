import type { FastifyInstance, FastifyReply } from "fastify";
import type { AppConfig } from "../../config.js";
import type { GrowthStore } from "../growth/store.js";
import { contributionEtag, type PublishedAsset } from "../growth/types.js";
import { hasSpaceAccess } from "../growth/validation.js";
import { authenticate, authenticateAny, type Principal } from "../../platform/auth.js";
import { ProblemError } from "../../platform/problem.js";
import { requireAKEPVersion } from "../../platform/headers.js";

interface ConsoleDependencies {
  readonly config: AppConfig;
  readonly growth: GrowthStore;
}

export async function registerConsoleRoutes(
  app: FastifyInstance,
  dependencies: ConsoleDependencies,
): Promise<void> {
  const { config, growth } = dependencies;

  app.get("/console/v1/overview", async (request, reply) => {
    requireAKEPVersion(request);
    requireGlobalConsole(authenticate(request, "akep:console"));
    const [assets, contributions, evidence] = await Promise.all([
      growth.listPublished(),
      growth.listContributions(),
      growth.evidenceCounts(),
    ]);
    const visibleAssets = assets.filter((asset) => asset.status !== "erased");
    const erasedRevisionIds = new Set(
      assets.filter((asset) => asset.status === "erased").map((asset) => asset.revisionId),
    );
    const visibleContributions = contributions.filter(
      (item) =>
        !erasedRevisionIds.has(item.receipt.subjectRevisionId) ||
        !["create", "revise"].includes(item.request.kind),
    );
    const spaces = [...new Set([
      config.defaultSpaceId,
      ...visibleAssets.map((asset) => asset.spaceId),
      ...visibleContributions.map((item) => item.request.spaceId),
    ])].sort();
    const workflow = Object.fromEntries(
      [
        "candidate",
        "validating",
        "needs_evidence",
        "verified",
        "accepted",
        "rejected",
        "quarantined",
        "withdrawn",
      ].map((status) => [
        status,
        visibleContributions.filter((item) => item.receipt.status === status).length,
      ]),
    );
    privateConsoleHeaders(reply, config);
    return reply.send({
      generatedAt: new Date().toISOString(),
      node: {
        id: config.nodeId,
        name: config.nodeName,
        policyEpoch: config.policyEpoch,
        trustDomain: config.trustDomain,
      },
      recentActivity: visibleContributions.slice(0, 8).map((item) => ({
        contributionId: item.receipt.contributionId,
        kind: item.receipt.kind,
        recordId: item.request.manifest?.recordId,
        spaceId: item.request.spaceId,
        status: item.receipt.status,
        title: item.request.manifest?.title ?? lifecycleTitle(item.request.kind),
        updatedAt: item.updatedAt,
      })),
      spaces: spaces.map((spaceId) => ({
        assetCount: visibleAssets.filter(
          (asset) => asset.spaceId === spaceId && readableStatus(asset),
        ).length,
        id: spaceId,
        pendingCount: visibleContributions.filter(
          (item) =>
            item.request.spaceId === spaceId &&
            ["candidate", "needs_evidence", "verified"].includes(item.receipt.status),
        ).length,
      })),
      totals: {
        feedback: evidence.feedback,
        knowledge: visibleAssets.filter(readableStatus).length,
        pendingReview: visibleContributions.filter((item) =>
          ["candidate", "needs_evidence"].includes(item.receipt.status),
        ).length,
        published: visibleAssets.filter((asset) => asset.status === "published").length,
        revoked: visibleAssets.filter((asset) => asset.status === "revoked").length,
        usage: evidence.usage,
      },
      workflow,
    });
  });

  app.get("/console/v1/assets", async (request, reply) => {
    requireAKEPVersion(request);
    requireGlobalConsole(authenticate(request, "akep:console"));
    const assets = await growth.listPublished();
    privateConsoleHeaders(reply, config);
    return reply.send({
      assets: assets.filter((asset) => asset.status !== "erased").map((asset) => ({
        assetType: asset.manifest.assetType,
        indexedAt: asset.indexedAt,
        labels: asset.manifest.labels ?? [],
        obligations: asset.manifest.policy.obligations ?? [],
        profile: asset.manifest.profile,
        qualityAttestationRefs: asset.qualityAttestationRefs,
        qualityDecision: asset.qualityDecision,
        qualityReasons: asset.qualityReasons,
        recordId: asset.manifest.recordId,
        revisionId: asset.revisionId,
        spaceId: asset.spaceId,
        status: asset.status,
        summary: asset.manifest.summary,
        title: asset.manifest.title,
      })),
      generatedAt: new Date().toISOString(),
    });
  });

  app.get("/console/v1/evidence-summary", async (request, reply) => {
    requireAKEPVersion(request);
    requireGlobalConsole(authenticate(request, "akep:console"));
    const summary = await growth.evidenceSummary();
    privateConsoleHeaders(reply, config);
    return reply.send(summary);
  });

  app.get("/console/v1/contributions", async (request, reply) => {
    requireAKEPVersion(request);
    const principal = authenticateAny(request, [
      "akep:contribute",
      "akep:review",
      "akep:publish",
      "akep:incident",
      "akep:erase",
    ]);
    const privileged = ["akep:review", "akep:publish", "akep:incident", "akep:erase"].some(
      (scope) => principal.scopes.has(scope),
    );
    const [allContributions, assets] = await Promise.all([
      growth.listContributions(),
      growth.listPublished(),
    ]);
    const erasedRevisionIds = new Set(
      assets.filter((asset) => asset.status === "erased").map((asset) => asset.revisionId),
    );
    const contributions = allContributions.filter(
      (item) =>
        hasSpaceAccess(principal, item.request.spaceId) &&
        (privileged || item.subjectDigest === principal.subjectDigest) &&
        (!erasedRevisionIds.has(item.receipt.subjectRevisionId) ||
          !["create", "revise"].includes(item.request.kind)),
    );
    privateConsoleHeaders(reply, config);
    return reply.send({
      contributions: contributions.map((item) => ({
        amendments: item.amendments,
        etag: contributionEtag(item),
        payloads: item.payloads,
        receipt: item.receipt,
        request: item.request,
        reviewDecision: item.reviewDecision,
        updatedAt: item.updatedAt,
      })),
      generatedAt: new Date().toISOString(),
    });
  });
}

function requireGlobalConsole(principal: Principal): void {
  if (
    !principal.scopes.has("akep:space:*") ||
    !principal.scopes.has("akep:classification:*") ||
    !principal.scopes.has("akep:policy:*")
  ) {
    throw new ProblemError(
      403,
      "AKEP_POLICY_DENIED",
      "Global console read models require explicit all-Space, all-classification and all-policy scopes.",
    );
  }
}

function privateConsoleHeaders(reply: FastifyReply, config: AppConfig): void {
  reply
    .header("AKEP-Version", "0.1")
    .header("AKEP-Policy-Epoch", config.policyEpoch)
    .header("Cache-Control", "private, no-store")
    .header("Vary", "Authorization");
}

function readableStatus(asset: PublishedAsset): boolean {
  return ["published", "deprecated"].includes(asset.status);
}

function lifecycleTitle(kind: string): string {
  const labels: Record<string, string> = {
    deprecate: "废弃知识版本",
    erase: "擦除知识版本",
    revoke: "紧急撤销知识版本",
  };
  return labels[kind] ?? "知识贡献";
}
