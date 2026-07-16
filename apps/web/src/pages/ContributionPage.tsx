import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  FileText,
  Fingerprint,
  History,
  Info,
  Link2,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Upload,
  XCircle,
} from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import {
  amendContribution,
  createContribution,
  getAssets,
  getContributions,
  getRevisionDetail,
  withdrawContribution,
} from "../api/client";
import { buildKnowledgeContribution, type KnowledgeDraft } from "../api/knowledge";
import type { ContributionListItem, ContributionReceipt } from "../api/types";
import { Button, Card, ErrorState, LoadingState, PageHeader, shortId, StatusBadge } from "../components/ui";
import { useAsyncResource, type AsyncResource } from "../hooks/useAsyncResource";

const DEFAULT_SPACE = "https://knowledge.local/spaces/default";

export function ContributionPage() {
  const [params] = useSearchParams();
  const contributions = useAsyncResource(() => getContributions("contributor"), []);
  const baseRevisionId = params.get("base") ?? undefined;
  const requestedSpaceId = params.get("space") ?? undefined;
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<KnowledgeDraft>({
    assetType: "procedure",
    content: "",
    evidenceRefs: [],
    labels: ["agent"],
    primarySources: [],
    rationale: "为团队提供经过独立审核、可稳定引用的任务知识。",
    spaceId: requestedSpaceId ?? DEFAULT_SPACE,
    summary: "",
    title: "",
  });
  const [labels, setLabels] = useState("agent");
  const [evidenceRefs, setEvidenceRefs] = useState("");
  const [primarySources, setPrimarySources] = useState("");
  const [baseLoading, setBaseLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [receipt, setReceipt] = useState<ContributionReceipt>();
  const steps = ["描述知识", "边界与依据", "确认提交"];

  useEffect(() => {
    if (baseRevisionId === undefined && requestedSpaceId !== undefined) {
      setDraft((current) => ({ ...current, spaceId: requestedSpaceId }));
    }
  }, [baseRevisionId, requestedSpaceId]);

  useEffect(() => {
    if (baseRevisionId === undefined) return;
    let active = true;
    setBaseLoading(true);
    void getAssets().then(async (allAssets) => {
      const asset = allAssets.find(
        (candidate) =>
          candidate.revisionId === baseRevisionId &&
          (requestedSpaceId === undefined || candidate.spaceId === requestedSpaceId),
      );
      if (asset === undefined) throw new Error("找不到要修订的已发布版本");
      const detail = await getRevisionDetail(asset.spaceId, asset.revisionId);
      if (!active) return;
      setDraft((current) => ({
        ...current,
        assetType: asset.assetType as KnowledgeDraft["assetType"],
        baseRevisionId: asset.revisionId,
        content: detail.content,
        labels: asset.labels,
        recordId: asset.recordId,
        spaceId: asset.spaceId,
        summary: asset.summary ?? "",
        title: asset.title,
      }));
      setLabels(asset.labels.join(", "));
    }).catch((caught: unknown) => {
      if (active) setError(caught instanceof Error ? caught.message : "读取基线版本失败");
    }).finally(() => {
      if (active) setBaseLoading(false);
    });
    return () => { active = false; };
  }, [baseRevisionId, requestedSpaceId]);
  const canContinue = useMemo(
    () =>
      step === 0
        ? draft.title.trim().length >= 2 && draft.summary.trim().length >= 4 && draft.content.trim().length >= 10
        : draft.spaceId.startsWith("http") && draft.rationale.trim().length >= 4,
    [draft, step],
  );

  const update = <K extends keyof KnowledgeDraft>(key: K, value: KnowledgeDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const submit = async () => {
    setSubmitting(true);
    setError(undefined);
    try {
      const normalized = {
        ...draft,
        evidenceRefs: parseReferences(evidenceRefs),
        labels: labels.split(",").map((value) => value.trim()).filter(Boolean),
        primarySources: parseReferences(primarySources),
      };
      const built = await buildKnowledgeContribution(normalized);
      const created = await createContribution(built);
      setReceipt(created.data);
      await contributions.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "提交失败");
    } finally {
      setSubmitting(false);
    }
  };

  if (receipt !== undefined) {
    return (
      <div className="success-page">
        <Card className="success-card">
          <span className="success-mark"><CheckCircle2 size={34} /></span>
          <p className="eyebrow">Contribution Receipt</p>
          <h1>{draft.baseRevisionId === undefined ? "知识候选已安全提交" : "修订候选已安全提交"}</h1>
          <p>内容尚未进入 Published Channel。独立 Curator 必须先核验来源、边界和策略。</p>
          <StatusBadge status={receipt.status} />
          <dl className="receipt-grid">
            <div><dt>Contribution</dt><dd title={receipt.contributionId}>{shortId(receipt.contributionId, 34)}</dd></div>
            <div><dt>Revision</dt><dd title={receipt.subjectRevisionId}>{shortId(receipt.subjectRevisionId, 34)}</dd></div>
            <div><dt>Policy Epoch</dt><dd>{receipt.policyEpoch}</dd></div>
            <div><dt>Space</dt><dd>{receipt.spaceId.split("/").at(-1)}</dd></div>
          </dl>
          <div className="success-actions">
            <Link className="button button-primary" to="/review">前往独立审核 <ArrowRight size={17} /></Link>
            <Button variant="secondary" onClick={() => { setReceipt(undefined); setStep(0); }}>继续贡献</Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <>
      {baseLoading ? <LoadingState label="正在读取修订基线" /> : null}
      <PageHeader
        eyebrow="Knowledge Contribution"
        title={draft.baseRevisionId === undefined ? "贡献一条可治理的知识" : "创建不可变修订版本"}
        subtitle={draft.baseRevisionId === undefined ? "支持粘贴或导入本地文本文件；来源、证据和策略边界会一同进入候选。" : `基于 ${shortId(draft.baseRevisionId, 34)} 创建新 Revision，原版本保持不可变。`}
      />
      <div className="wizard-layout">
        <Card className="wizard-main">
          <ol className="stepper" aria-label="贡献步骤">
            {steps.map((label, index) => (
              <li className={index === step ? "step-active" : index < step ? "step-done" : ""} key={label}>
                <span>{index < step ? <Check size={14} /> : index + 1}</span><b>{label}</b>
              </li>
            ))}
          </ol>

          {step === 0 ? (
            <div className="form-section">
              <div className="field-grid two-columns">
                <label className="field"><span>知识类型</span><select value={draft.assetType} onChange={(event) => update("assetType", event.target.value as KnowledgeDraft["assetType"])}><option value="procedure">Procedure · 操作流程</option><option value="source_document">Source Document · 来源文档</option></select><small>类型决定采用的互操作 Profile。</small></label>
                <label className="field"><span>标签</span><input onChange={(event) => setLabels(event.target.value)} placeholder="agent, support" value={labels} /><small>使用英文逗号分隔。</small></label>
              </div>
              <label className="field"><span>标题</span><input maxLength={180} onChange={(event) => update("title", event.target.value)} placeholder="清晰描述 Agent 可以完成的任务" value={draft.title} /></label>
              <label className="field"><span>摘要</span><textarea maxLength={600} onChange={(event) => update("summary", event.target.value)} placeholder="说明这条知识解决什么问题、适用于谁" rows={3} value={draft.summary} /><small>{draft.summary.length}/600</small></label>
              <label className="field"><span>Markdown 内容</span><textarea className="content-editor" onChange={(event) => update("content", event.target.value)} placeholder={"# 操作步骤\n\n1. 先确认…\n2. 然后执行…\n\n## 风险边界"} rows={13} value={draft.content} /></label>
              <label className="file-import"><Upload size={18} /><span><strong>从本地文件导入</strong><small>支持 UTF-8 Markdown 与纯文本；文件只在浏览器读取并进入摘要校验流程。</small></span><input accept=".md,.markdown,.txt,text/plain,text/markdown" onChange={(event) => { const file = event.target.files?.[0]; if (file !== undefined) void importFile(file, draft, update, setError); }} type="file" /></label>
            </div>
          ) : step === 1 ? (
            <div className="form-section">
              <div className="notice notice-info"><Info size={18} /><div><strong>边界会随 Manifest 一起签入 Revision</strong><p>更改标题、策略、内容或有效范围都会产生新的 Revision ID。</p></div></div>
              <label className="field"><span>知识空间</span><input onChange={(event) => update("spaceId", event.target.value)} value={draft.spaceId} /><small>Space 是权限、用途与治理策略的共同边界。</small></label>
              <label className="field"><span>贡献理由与证据说明</span><textarea onChange={(event) => update("rationale", event.target.value)} rows={5} value={draft.rationale} /><small>审核者会基于此说明判断知识是否适合进入 Published Channel。</small></label>
              <div className="field-grid two-columns">
                <label className="field"><span>原始来源 URL</span><textarea onChange={(event) => setPrimarySources(event.target.value)} placeholder={"每行一个绝对 URL\nhttps://docs.example/policy"} rows={4} value={primarySources} /><small>会写入 provenance.primarySources 和 derived_from 关系。</small></label>
                <label className="field"><span>补充证据 URL</span><textarea onChange={(event) => setEvidenceRefs(event.target.value)} placeholder={"每行一个绝对 URL\nhttps://evidence.example/review"} rows={4} value={evidenceRefs} /><small>审核者会在证据区逐条核验。</small></label>
              </div>
              <div className="policy-preview">
                <h3><ShieldCheck size={18} /> 默认使用策略</h3>
                <dl><div><dt>Classification</dt><dd>internal</dd></div><div><dt>Purpose</dt><dd>customer-support</dd></div><div><dt>Obligations</dt><dd>cite · no-train</dd></div><div><dt>Review after</dt><dd>90 天</dd></div></dl>
              </div>
            </div>
          ) : (
            <div className="form-section review-preview">
              <div className="review-icon"><FileText size={23} /></div>
              <div><p className="eyebrow">准备生成候选</p><h2>{draft.title}</h2><p>{draft.summary}</p></div>
              <dl className="review-list"><div><dt>动作</dt><dd>{draft.baseRevisionId === undefined ? "Create" : "Revise"}</dd></div><div><dt>Profile</dt><dd>{draft.assetType === "procedure" ? "Procedure / 1" : "Source Document / 1"}</dd></div><div><dt>Space</dt><dd>{draft.spaceId}</dd></div><div><dt>标签</dt><dd>{labels || "—"}</dd></div><div><dt>来源 / 证据</dt><dd>{parseReferences(primarySources).length} / {parseReferences(evidenceRefs).length}</dd></div><div><dt>策略</dt><dd>internal · cite · no-train</dd></div></dl>
              <div className="notice notice-neutral"><Fingerprint size={18} /><div><strong>浏览器将本地计算 SHA-256</strong><p>Payload 与规范化 Manifest 的摘要会在上传前生成，服务端将重新校验。</p></div></div>
              {error === undefined ? null : <div className="form-error" role="alert">{error}</div>}
            </div>
          )}

          <div className="wizard-actions">
            <Button disabled={step === 0 || submitting} onClick={() => setStep((value) => value - 1)} variant="ghost"><ArrowLeft size={17} /> 上一步</Button>
            {step < steps.length - 1 ? <Button disabled={!canContinue} onClick={() => setStep((value) => value + 1)}>下一步 <ArrowRight size={17} /></Button> : <Button disabled={submitting} onClick={() => void submit()}><Sparkles size={17} /> {submitting ? "计算并提交中…" : "生成并提交候选"}</Button>}
          </div>
        </Card>

        <aside className="wizard-aside">
          <Card><h3>发布前会发生什么？</h3><ol className="guardrail-list"><li><span>1</span><div><strong>结构校验</strong><p>验证 Profile、Manifest 和 Payload 摘要。</p></div></li><li><span>2</span><div><strong>独立审核</strong><p>Curator 检查证据、适用范围和风险。</p></div></li><li><span>3</span><div><strong>发布决策</strong><p>Publisher 使用当前 Policy Epoch 执行发布。</p></div></li></ol></Card>
          <Card className="tip-card"><Sparkles size={18} /><div><strong>写给 Agent 的知识</strong><p>把前置条件、失败分支和禁止事项写清楚，比单纯增加篇幅更有价值。</p></div></Card>
        </aside>
      </div>
      <ContributionWorkbench resource={contributions} />
    </>
  );
}

function ContributionWorkbench({ resource }: { readonly resource: AsyncResource<readonly ContributionListItem[]> }) {
  const [selectedId, setSelectedId] = useState<string>();
  const [evidence, setEvidence] = useState("");
  const [rationale, setRationale] = useState("补充审核所需的来源和验证材料。");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (resource.loading) return <LoadingState label="读取我的贡献" />;
  if (resource.error !== undefined) return <ErrorState error={resource.error} retry={resource.refresh} />;
  const items = resource.data ?? [];
  const selected = items.find((item) => item.receipt.contributionId === selectedId);

  const amend = async () => {
    if (selected === undefined || selected.receipt.status !== "needs_evidence") return;
    const refs = parseReferences(evidence);
    if (refs.length === 0) { setError("至少填写一个有效的证据 URL"); return; }
    setBusy(true); setError(undefined);
    try {
      await amendContribution({ contributionId: selected.receipt.contributionId, etag: selected.etag, evidenceRefs: refs, rationale });
      setSelectedId(undefined); setEvidence(""); await resource.refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "补证失败"); }
    finally { setBusy(false); }
  };

  const withdraw = async (item: ContributionListItem) => {
    setBusy(true); setError(undefined);
    try {
      await withdrawContribution({ contributionId: item.receipt.contributionId, etag: item.etag, reason: "贡献者主动撤回，等待修正后重新提交。" });
      setSelectedId(undefined); await resource.refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "撤回失败"); }
    finally { setBusy(false); }
  };

  return (
    <Card className="contribution-workbench">
      <div className="section-header">
        <div><p className="eyebrow">Contributor workspace</p><h2>我的贡献</h2><p>跟踪状态、审核意见和补证记录；终态历史不会被覆盖。</p></div>
        <Button onClick={() => void resource.refresh()} variant="ghost"><RefreshCw size={16} /> 刷新</Button>
      </div>
      {items.length === 0 ? <p className="muted-copy">还没有贡献记录。</p> : (
        <div className="contribution-table">
          <div className="table-head"><span>知识 / 动作</span><span>状态时间线</span><span>更新时间</span><span>操作</span></div>
          {items.map((item) => {
            const canAmend = item.receipt.status === "needs_evidence";
            const canWithdraw = !["accepted", "rejected", "withdrawn"].includes(item.receipt.status);
            return (
              <div className="table-row" key={item.receipt.contributionId}>
                <span><strong>{(item.request.manifest?.title as string | undefined) ?? item.receipt.kind}</strong><small>{shortId(item.receipt.subjectRevisionId, 30)}</small></span>
                <span className="contribution-timeline"><History size={15} /><StatusBadge status={item.receipt.status} /><small>{evidenceAmendmentCount(item.amendments)} 次补充</small></span>
                <span>{new Date(item.updatedAt).toLocaleString("zh-CN")}</span>
                <span className="table-actions">
                  {canAmend ? <Button onClick={() => setSelectedId(item.receipt.contributionId)} variant="secondary"><Link2 size={15} /> 补证</Button> : null}
                  {canWithdraw ? <Button disabled={busy} onClick={() => void withdraw(item)} variant="ghost"><XCircle size={15} /> 撤回</Button> : null}
                  {!canAmend && !canWithdraw ? <span className="muted-copy">已进入终态</span> : null}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {selected === undefined ? null : (
        <div className="amend-panel">
          <div><strong>为 {(selected.request.manifest?.title as string | undefined) ?? selected.receipt.kind} 补充证据</strong><p>补证会形成 Amendment，不会修改原始候选请求。</p></div>
          <label className="field"><span>证据 URL</span><textarea onChange={(event) => setEvidence(event.target.value)} rows={3} value={evidence} /></label>
          <label className="field"><span>说明</span><input onChange={(event) => setRationale(event.target.value)} value={rationale} /></label>
          <Button disabled={busy} onClick={() => void amend()}>{busy ? "提交中…" : "提交补证"}</Button>
        </div>
      )}
      {error === undefined ? null : <div className="form-error" role="alert">{error}</div>}
    </Card>
  );
}

function parseReferences(value: string): readonly string[] {
  return [...new Set(value.split(/[\n,]/u).map((item) => item.trim()).filter((item) => {
    if (item.length === 0) return false;
    try { new URL(item); return true; } catch { return false; }
  }))];
}

function evidenceAmendmentCount(amendments: readonly Record<string, unknown>[]): number {
  return amendments.filter((item) => Array.isArray(item.evidenceRefs)).length;
}

async function importFile(
  file: File,
  draft: KnowledgeDraft,
  update: <K extends keyof KnowledgeDraft>(key: K, value: KnowledgeDraft[K]) => void,
  setError: (value: string | undefined) => void,
): Promise<void> {
  if (file.size > 2 * 1024 * 1024) { setError("浏览器直传文件上限为 2 MiB；更大文件请使用接入 Worker。"); return; }
  try {
    const content = await file.text();
    update("content", content);
    if (draft.title.trim().length === 0) update("title", file.name.replace(/\.[^.]+$/u, ""));
    setError(undefined);
  } catch { setError("文件读取失败，请确认它是 UTF-8 文本。"); }
}
