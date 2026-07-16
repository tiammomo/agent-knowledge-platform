import {
  applyGovernanceAction,
  createContribution,
  getContributions,
  reviewContribution,
} from "./client";
import { buildKnowledgeContribution } from "./knowledge";

export interface DemoKnowledge {
  readonly contributionId: string;
  readonly etag: string;
  readonly policyEpoch: string;
  readonly published: boolean;
  readonly recordId: string;
  readonly revisionId: string;
  readonly spaceId: string;
}

export async function createDemoKnowledgeCandidate(
  spaceId = "https://knowledge.local/spaces/demo-onboarding",
): Promise<DemoKnowledge> {
  const built = await buildKnowledgeContribution({
    assetType: "procedure",
    content: [
      "# Agent 知识贡献检查清单",
      "",
      "1. 明确知识适用的任务、地区和有效期。",
      "2. 绑定原始来源，不把模型输出自动当作事实。",
      "3. 由独立 Curator 检查证据、策略与风险。",
      "4. 发布后通过引用、Usage 与 Feedback 观察实际效果。",
      "5. 发现高风险错误时立即提交 revoke 候选。",
    ].join("\n"),
    evidenceRefs: ["https://knowledge.local/evidence/onboarding-checklist"],
    labels: ["onboarding", "agent", "governance"],
    primarySources: ["https://knowledge.local/docs/onboarding-governance"],
    rationale: "用于首次体验 KnowledgeOS 的受治理知识成长闭环。",
    spaceId,
    summary: "一份帮助团队安全贡献、审核和持续改进 Agent 知识的五步清单。",
    title: "Agent 知识贡献检查清单",
  });
  const created = await createContribution(built);
  return {
    contributionId: created.data.contributionId,
    etag: requireEtag(created.response),
    policyEpoch: created.data.policyEpoch,
    published: false,
    recordId: built.manifest.recordId as string,
    revisionId: built.revisionId,
    spaceId,
  };
}

export async function publishDemoKnowledge(candidate: DemoKnowledge): Promise<DemoKnowledge> {
  if (candidate.published) return candidate;
  const contribution = (await getContributions("curator")).find(
    (item) => item.receipt.contributionId === candidate.contributionId,
  );
  if (contribution === undefined) throw new Error("找不到示例知识候选");
  if (contribution.receipt.status === "accepted") {
    return { ...candidate, etag: contribution.etag, published: true };
  }
  if (["rejected", "quarantined", "withdrawn"].includes(contribution.receipt.status)) {
    throw new Error(`示例候选已经进入 ${contribution.receipt.status}，请重置引导后重新创建`);
  }
  const reviewed = contribution.receipt.status === "verified"
    ? { data: contribution.receipt, response: new Response(null, { headers: { etag: contribution.etag } }) }
    : await reviewContribution({
        attestationRefs: [],
        contributionId: candidate.contributionId,
        decision: "verify",
        etag: contribution.etag,
        rationale: "示例知识的结构、来源声明、用途和安全边界完整，可用于新手演示。",
      });
  const reviewedContribution = (await getContributions("publisher")).find(
    (item) => item.receipt.contributionId === candidate.contributionId,
  );
  const reviewedAttestations = Array.isArray(reviewedContribution?.reviewDecision?.attestationRefs)
    ? reviewedContribution.reviewDecision.attestationRefs.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  if (reviewedAttestations.length === 0) {
    throw new Error("服务端未生成 Profile 所需的审核证明");
  }
  const published = await applyGovernanceAction({
    action: "publish",
    attestationRefs: reviewedAttestations,
    contributionId: candidate.contributionId,
    etag: requireEtag(reviewed.response),
    policyEpoch: reviewed.data.policyEpoch,
    rationale: "批准进入本地演示 Published Channel。",
  });
  return { ...candidate, etag: requireEtag(published.response), published: true };
}

export async function importDemoKnowledge(
  spaceId = "https://knowledge.local/spaces/demo-onboarding",
): Promise<DemoKnowledge> {
  return publishDemoKnowledge(await createDemoKnowledgeCandidate(spaceId));
}

function requireEtag(response: Response): string {
  const etag = response.headers.get("etag");
  if (etag === null) throw new Error("服务端未返回候选版本标识");
  return etag;
}
