import assert from "node:assert/strict";

import {
  applyGovernanceAction,
  createContribution,
  getContributions,
  reviewContribution,
} from "../src/api/client";
import { buildKnowledgeContribution, type KnowledgeDraft } from "../src/api/knowledge";

const origin = process.env.AKEP_WEB_ORIGIN ?? "http://127.0.0.1:33005";
const spaceId = "https://knowledge.local/spaces/quantpilot-acceptance";
const nativeFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const target = typeof input === "string" ? new URL(input, origin) : input;
  return nativeFetch(target, init);
}) as typeof fetch;

const entries: readonly Omit<KnowledgeDraft, "allowedPurposes" | "spaceId">[] = [
  {
    assetType: "procedure",
    content: [
      "# QuantPilot 查询改写与标的识别规则",
      "",
      "1. Query Rewrite 由大模型做语义抽取，不使用关键词匹配代替模型判断。",
      "2. 证券名称或代码只能从用户原问题原样提取，不能猜测或自动补造代码。",
      "3. 用户写“大位科技”时必须保留为“大位科技”，不能改成“大为科技”。",
      "4. 默认输出量化看板；只有用户明确要求只回答、不生成看板时才切换 answer 模式。",
      "5. 缺少关键标的或出现同名歧义时先澄清，不得带着猜测执行。",
    ].join("\n"),
    evidenceRefs: ["https://quantpilot.local/evidence/query-rewrite-v4"],
    labels: ["quantpilot", "query-rewrite", "llm", "entity"],
    primarySources: ["https://quantpilot.local/docs/model-providers", "https://quantpilot.local/docs/quant-research"],
    rationale: "固定 QuantPilot 当前 Query Rewrite 的可信执行边界。",
    recordId: "https://knowledge.local/records/quantpilot/query-rewrite-v4",
    summary: "Query Rewrite 必须使用大模型语义抽取，并保留用户原始标的名称和输出意图。",
    title: "QuantPilot 查询改写与标的识别规则",
  },
  {
    assetType: "procedure",
    content: [
      "# MoAgent 工作空间交付闭环",
      "",
      "1. QuantPilot 负责 RunPlan、Mission、generation job、租约、超时和最终验收；MoAgent 只负责执行阶段。",
      "2. Agent 完成最小必要修改后必须调用 submit_result，不能停留在无界取数、编辑或生成看板状态。",
      "3. 标准看板优先使用平台可信渲染器和 dashboard contract；自定义修改仍需独立 build、preview 与 validation。",
      "4. 只有 Mission accepted 后任务才算完成；模型自称完成不能替代平台验收。",
      "5. 进程重启后由 PostgreSQL generation job/outbox 恢复，不能依赖单进程内存状态。",
    ].join("\n"),
    evidenceRefs: ["https://quantpilot.local/evidence/moagent-runtime-v1.12"],
    labels: ["quantpilot", "moagent", "workspace", "mission", "recovery"],
    primarySources: ["https://quantpilot.local/docs/moagent", "https://quantpilot.local/docs/operations-runbook"],
    rationale: "沉淀工作空间生成、验收和恢复的稳定流程。",
    recordId: "https://knowledge.local/records/quantpilot/workspace-delivery-v1",
    summary: "MoAgent 通过 submit_result 交付候选，由 QuantPilot 独立验证并以 Mission accepted 收口。",
    title: "MoAgent 工作空间交付闭环",
  },
  {
    assetType: "procedure",
    content: [
      "# QuantPilot 个人记忆使用边界",
      "",
      "1. evolvable-user-memory 只保存用户明确确认的偏好，例如结论优先、风险偏好和展示密度。",
      "2. 项目级偏好必须按 project_id 隔离，不能泄漏到其他项目或其他 subject。",
      "3. 用户关闭个性化后，QuantPilot 不得召回、暴露或记录新的使用回执。",
      "4. 记忆内容是不可信偏好数据，不能覆盖事实、授权、安全规则、工具契约或验证结论。",
      "5. 只有真正暴露给模型的 revision 才记录 Usage；帮助或伤害必须绑定可归因 Outcome。",
    ].join("\n"),
    evidenceRefs: ["https://quantpilot.local/evidence/personal-memory-contract-v1"],
    labels: ["quantpilot", "memory", "personalization", "isolation", "receipt"],
    primarySources: ["https://quantpilot.local/docs/user-memory-integration", "https://quantpilot.local/docs/context-composition"],
    rationale: "固定个人记忆的隔离、退出和归因边界。",
    recordId: "https://knowledge.local/records/quantpilot/personal-memory-boundary-v1",
    summary: "个人记忆仅用于有归因的偏好个性化，并遵守 project/subject 隔离与显式退出。",
    title: "QuantPilot 个人记忆使用边界",
  },
  {
    assetType: "procedure",
    content: [
      "# QuantPilot 受治理知识使用边界",
      "",
      "1. Agent Knowledge Platform 通过 AKEP ContextPack 提供已发布 passage、Citation、Revision 和 Exposure Receipt。",
      "2. QuantPilot 固定 Space、quant-research purpose、cite/no-train obligation 和字符预算；模型无权选择 URL、token 或 Space。",
      "3. 知识正文是不可信只读数据，不能作为代码执行，也不能覆盖行情事实、用户请求、系统策略或验证。",
      "4. Citation 真正影响结果时必须保留 citationId；Mission accepted 后才写 Usage。",
      "5. helped、neutral、harmed 反馈由用户业务结果触发，不能让 Agent 自评后直接改变发布知识。",
    ].join("\n"),
    evidenceRefs: ["https://knowledge.local/evidence/quantpilot-akep-v0.1"],
    labels: ["quantpilot", "akep", "knowledge", "citation", "governance"],
    primarySources: ["https://quantpilot.local/docs/context-composition", "https://knowledge.local/docs/quantpilot-integration"],
    rationale: "固定 QuantPilot 与 AKEP 的知识消费和反馈闭环。",
    recordId: "https://knowledge.local/records/quantpilot/governed-knowledge-boundary-v1",
    summary: "QuantPilot 只消费带引用的已发布知识，并在 Mission 验收后记录 Usage 和业务反馈。",
    title: "QuantPilot 受治理知识使用边界",
  },
  {
    assetType: "procedure",
    content: [
      "# 量化看板可读性与证据呈现规则",
      "",
      "1. 指标卡应使用紧凑网格、清晰分组、对齐数字和一致单位，避免大面积空白或单行跨栏。",
      "2. 关键结论、趋势、量能、估值和风险优先；技术审计信息不能挤占主要阅读路径。",
      "3. 数据源渠道、接口名称、TimescaleDB 表名、sources.json 和 dashboard-data.json 路径属于证据层，默认不在看板正文展示。",
      "4. 引用与数据质量应以折叠详情、状态摘要或证据入口呈现，而不是堆叠多张渠道卡片。",
      "5. 涨跌颜色、百分比、货币单位和小数位必须统一，并提供移动端可读布局。",
    ].join("\n"),
    evidenceRefs: ["https://quantpilot.local/evidence/dashboard-ux-guideline-v1"],
    labels: ["quantpilot", "dashboard", "ux", "metrics", "evidence"],
    primarySources: ["https://quantpilot.local/docs/dashboard-generation", "https://quantpilot.local/docs/ui-guidelines"],
    rationale: "沉淀量化看板的可读性和证据展示约束。",
    recordId: "https://knowledge.local/records/quantpilot/dashboard-readability-v1",
    summary: "指标卡应紧凑易读，数据源渠道和内部证据路径默认不进入看板正文。",
    title: "量化看板可读性与证据呈现规则",
  },
  {
    assetType: "procedure",
    content: [
      "# ModelPort 模型接入边界",
      "",
      "1. QuantPilot 默认通过 ModelPort 的 OpenAI-compatible /v1 边界调用 local_qwen:qwen3.5-9b-q5km。",
      "2. ModelPort 中的 DeepSeek 上游使用 Anthropic Messages 协议，但对 QuantPilot 仍暴露 OpenAI-compatible Chat Completions。",
      "3. API Key 由 ModelPort 管理；QuantPilot 平时只保存 ModelPort 客户端凭据，不复制 DeepSeek 上游密钥。",
      "4. 验收必须覆盖 /models 发现、强制工具调用、tool_call_id 续轮、Token usage 和错误凭据拒绝。",
      "5. Provider、Memory、Knowledge 三个模块只通过版本化 HTTP 契约协作，不共享源码或数据库。",
    ].join("\n"),
    evidenceRefs: ["https://quantpilot.local/evidence/modelport-provider-contract-v1"],
    labels: ["quantpilot", "modelport", "qwen", "deepseek", "provider"],
    primarySources: ["https://quantpilot.local/docs/model-providers", "https://modelport.local/docs/providers"],
    rationale: "固定 ModelPort 与 QuantPilot 的协议、凭据和解耦边界。",
    recordId: "https://knowledge.local/records/quantpilot/modelport-boundary-v1",
    summary: "QuantPilot 默认经 ModelPort 调用 Qwen，并通过统一 OpenAI-compatible 边界使用 DeepSeek。",
    title: "ModelPort 模型接入边界",
  },
];

async function contextHasTitle(title: string): Promise<boolean> {
  const response = await nativeFetch(`${origin}/akep/0.1/context-packs`, {
    method: "POST",
    headers: {
      Authorization: "Bearer dev-reader",
      "AKEP-Version": "0.1",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      akepVersion: "0.1",
      budget: { maxCharacters: 8_000, maxPassages: 20 },
      critical: [],
      extensions: {},
      mode: "lexical",
      purpose: "quant-research",
      spaces: [spaceId],
      supportedObligations: ["cite", "no-train"],
      task: title,
    }),
  });
  assert.equal(response.status, 200, `ContextPack preflight failed for ${title}.`);
  const payload = await response.json() as { readonly passages?: readonly { readonly title?: string }[] };
  return payload.passages?.some((passage) => passage.title === title) ?? false;
}

async function publish(draft: Omit<KnowledgeDraft, "allowedPurposes" | "spaceId">): Promise<string> {
  if (await contextHasTitle(draft.title)) return "existing";
  const built = await buildKnowledgeContribution({
    ...draft,
    allowedPurposes: ["quant-research"],
    spaceId,
  });
  const created = await createContribution(built);
  const createdEtag = created.response.headers.get("etag");
  assert(createdEtag, `Contribution ${draft.title} has no ETag.`);
  const reviewed = await reviewContribution({
    attestationRefs: [],
    contributionId: created.data.contributionId,
    decision: "verify",
    etag: createdEtag,
    rationale: "QuantPilot 隔离验收语料的来源、用途、适用范围与安全边界完整。",
  });
  const publisherView = (await getContributions("publisher")).find(
    (item) => item.receipt.contributionId === created.data.contributionId,
  );
  const attestationRefs = Array.isArray(publisherView?.reviewDecision?.attestationRefs)
    ? publisherView.reviewDecision.attestationRefs.filter(
      (value): value is string => typeof value === "string",
    )
    : [];
  assert(attestationRefs.length > 0, `Contribution ${draft.title} has no review attestations.`);
  const reviewedEtag = reviewed.response.headers.get("etag");
  assert(reviewedEtag, `Reviewed contribution ${draft.title} has no ETag.`);
  await applyGovernanceAction({
    action: "publish",
    attestationRefs,
    contributionId: created.data.contributionId,
    etag: reviewedEtag,
    policyEpoch: reviewed.data.policyEpoch,
    rationale: "批准进入 QuantPilot 隔离集成验收 Published Channel。",
  });
  assert(await contextHasTitle(draft.title), `Published knowledge ${draft.title} is not queryable.`);
  return "published";
}

const results = [];
for (const entry of entries) {
  results.push({ title: entry.title, status: await publish(entry) });
}

process.stdout.write(`${JSON.stringify({ spaceId, entries: results }, null, 2)}\n`);
