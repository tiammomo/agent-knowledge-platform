import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import {
  applyGovernanceAction,
  createContribution,
  getContributions,
  reviewContribution,
} from "../src/api/client";
import { buildKnowledgeContribution, type KnowledgeDraft } from "../src/api/knowledge";

const origin = process.env.AKEP_WEB_ORIGIN ?? "http://127.0.0.1:33005";
const spaceId = process.env.AKEP_ACCEPTANCE_50_SPACE
  ?? "https://knowledge.local/spaces/quantpilot-acceptance-50-v1";
const datasetId = "quantpilot-memory-knowledge-acceptance-50-v1";
const output = option("output");
const nativeFetch = globalThis.fetch;

globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const target = typeof input === "string" ? new URL(input, origin) : input;
  return nativeFetch(target, init);
}) as typeof fetch;

interface AcceptanceCase {
  readonly id: string;
  readonly question: string;
  readonly recordId: string;
  readonly title: string;
  readonly draft: Omit<KnowledgeDraft, "allowedPurposes" | "spaceId">;
}

const subjects = [
  "贵州茅台",
  "宁德时代",
  "比亚迪",
  "招商银行",
  "中国移动",
  "大位科技",
  "美的集团",
  "海康威视",
  "万科A",
  "隆基绿能",
] as const;

const focuses = [
  {
    slug: "trend",
    title: "趋势与量能",
    question: (subject: string) => `分析${subject}近60个交易日的趋势、量能和主要技术风险。`,
    rules: [
      "使用真实交易日行情，明确起止日期、复权口径和数据新鲜度。",
      "至少给出趋势、成交量、波动或回撤证据，不能用主观形容词代替数据。",
      "结论必须附风险边界，不把历史技术信号写成收益承诺。",
    ],
  },
  {
    slug: "fundamental",
    title: "财务质量",
    question: (subject: string) => `分析${subject}最近四个报告期的营收、利润、现金流和盈利质量。`,
    rules: [
      "区分报告期和公告日，按可获得信息时间避免前视偏差。",
      "同时检查收入、利润、现金流和利润率，不以单一同比指标代替质量判断。",
      "缺少字段时明确数据缺口，不能估造财务数值。",
    ],
  },
  {
    slug: "valuation",
    title: "估值框架",
    question: (subject: string) => `评估${subject}当前估值框架、关键假设和可能的估值陷阱。`,
    rules: [
      "估值指标必须带口径、基准日和可比范围。",
      "把事实数据、模型假设和主观判断分开呈现。",
      "展示敏感性和失效条件，不给单点目标价承诺。",
    ],
  },
  {
    slug: "events",
    title: "公告事件",
    question: (subject: string) => `梳理${subject}最近一个季度的重要公告、潜在影响和待验证事项。`,
    rules: [
      "公告事件必须绑定来源、事件日期和披露日期。",
      "区分已发生事实、公司表述和分析推断。",
      "潜在影响使用条件式表述，并列出后续需要验证的数据。",
    ],
  },
  {
    slug: "risk",
    title: "综合风险",
    question: (subject: string) => `为${subject}制作风险检查清单，覆盖波动、回撤、基本面和数据质量。`,
    rules: [
      "风险清单同时覆盖市场、基本面、事件和数据质量，不只列价格波动。",
      "每项风险给出可观察指标和触发条件。",
      "内部接口、表名和原始证据路径默认不占用看板正文。",
    ],
  },
] as const;

function option(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function cases(): AcceptanceCase[] {
  let sequence = 0;
  return subjects.flatMap((subject) => focuses.map((focus) => {
    sequence += 1;
    const id = `C${String(sequence).padStart(2, "0")}`;
    const question = focus.question(subject);
    const title = `${id} ${subject}${focus.title}验收规则`;
    const recordId = `https://knowledge.local/records/quantpilot/acceptance-50-v1/${id.toLowerCase()}`;
    const content = [
      `# ${title}`,
      "",
      `验收问题：${question}`,
      "",
      "执行规则：",
      ...focus.rules.map((rule, index) => `${index + 1}. ${rule}`),
      "4. 回答先给结论，再给关键证据、风险与数据质量；引用必须来自当前 ContextPack。",
      "5. 这是方法知识，不包含或替代实时行情、财务与公告事实。",
    ].join("\n");
    return {
      id,
      question,
      recordId,
      title,
      draft: {
        assetType: "procedure",
        content,
        evidenceRefs: [`https://quantpilot.local/evidence/acceptance-50-v1/${id.toLowerCase()}`],
        labels: ["quantpilot", "acceptance-50", subject, focus.slug],
        primarySources: [
          "https://quantpilot.local/docs/generated-workspace-contract",
          "https://quantpilot.local/docs/context-composition",
        ],
        rationale: `验证 ${subject} ${focus.title}场景下 Memory、AKEP 与 ModelPort 的完整上下文闭环。`,
        recordId,
        summary: `${question} 使用受治理数据、引用、风险边界和数据质量规则完成。`,
        title,
      },
    };
  }));
}

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
      budget: { maxCharacters: 8_000, maxPassages: 10 },
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

async function publish(entry: AcceptanceCase): Promise<"existing" | "published"> {
  if (await contextHasTitle(entry.title)) return "existing";
  const built = await buildKnowledgeContribution({
    ...entry.draft,
    allowedPurposes: ["quant-research"],
    spaceId,
  });
  const created = await createContribution(built);
  const createdEtag = created.response.headers.get("etag");
  assert(createdEtag, `Contribution ${entry.title} has no ETag.`);
  const reviewed = await reviewContribution({
    attestationRefs: [],
    contributionId: created.data.contributionId,
    decision: "verify",
    etag: createdEtag,
    rationale: "50 题隔离验收语料具备明确来源、用途、方法边界和禁止项。",
  });
  const publisherView = (await getContributions("publisher")).find(
    (item) => item.receipt.contributionId === created.data.contributionId,
  );
  const attestationRefs = Array.isArray(publisherView?.reviewDecision?.attestationRefs)
    ? publisherView.reviewDecision.attestationRefs.filter(
      (value): value is string => typeof value === "string",
    )
    : [];
  assert(attestationRefs.length > 0, `Contribution ${entry.title} has no review attestations.`);
  const reviewedEtag = reviewed.response.headers.get("etag");
  assert(reviewedEtag, `Reviewed contribution ${entry.title} has no ETag.`);
  await applyGovernanceAction({
    action: "publish",
    attestationRefs,
    contributionId: created.data.contributionId,
    etag: reviewedEtag,
    policyEpoch: reviewed.data.policyEpoch,
    rationale: "批准进入 QuantPilot 50 题隔离验收 Published Channel。",
  });
  assert(await contextHasTitle(entry.title), `Published knowledge ${entry.title} is not queryable.`);
  return "published";
}

const seeded = [];
for (const entry of cases()) {
  const status = await publish(entry);
  seeded.push({
    id: entry.id,
    question: entry.question,
    recordId: entry.recordId,
    title: entry.title,
    status,
  });
  process.stderr.write(`[acceptance-50] ${entry.id} ${status}\n`);
}

const manifest = {
  schemaVersion: 1,
  datasetId,
  generatedAt: new Date().toISOString(),
  origin,
  spaceId,
  cases: seeded,
};
if (output) {
  const target = path.resolve(output);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
process.stdout.write(`${JSON.stringify({ ...manifest, output }, null, 2)}\n`);
