import { useMemo, useState } from "react";
import { AlertTriangle, Archive, CheckCircle2, Clock3, Flame, Gavel, Plus, RefreshCw, ShieldAlert, Trash2 } from "lucide-react";
import { applyGovernanceAction, createLifecycleContribution, getAssets, getContributions } from "../api/client";
import type { ConsoleAsset, ContributionListItem } from "../api/types";
import { Button, Card, EmptyState, ErrorState, formatRelativeTime, LoadingState, PageHeader, shortId, StatusBadge } from "../components/ui";
import { useAsyncResource } from "../hooks/useAsyncResource";

type LifecycleAction = "deprecate" | "revoke" | "erase";

export function GovernancePage() {
  const contributions = useAsyncResource(() => getContributions("publisher"), []);
  const assets = useAsyncResource(getAssets, []);
  const [acting, setActing] = useState<string>();
  const [error, setError] = useState<string>();
  const [showLifecycle, setShowLifecycle] = useState(false);
  const ready = useMemo(() => (contributions.data ?? []).filter((item) => item.receipt.status === "verified"), [contributions.data]);
  const history = useMemo(() => (contributions.data ?? []).filter((item) => ["accepted", "rejected", "quarantined", "withdrawn"].includes(item.receipt.status)).slice(0, 12), [contributions.data]);

  const execute = async (item: ContributionListItem) => {
    const action = ["deprecate", "revoke", "erase"].includes(item.receipt.kind) ? item.receipt.kind as LifecycleAction : "publish";
    setActing(item.receipt.contributionId);
    setError(undefined);
    try {
      const attestationRefs = Array.isArray(item.reviewDecision?.attestationRefs)
        ? item.reviewDecision.attestationRefs.filter((value): value is string => typeof value === "string")
        : [];
      await applyGovernanceAction({ action, attestationRefs, contributionId: item.receipt.contributionId, etag: item.etag, policyEpoch: item.receipt.policyEpoch, rationale: action === "publish" ? "批准进入 Published Channel，并绑定当前策略纪元。" : `批准执行 ${action} 生命周期动作。` });
      await Promise.all([contributions.refresh(), assets.refresh()]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "治理动作执行失败");
    } finally {
      setActing(undefined);
    }
  };

  if (contributions.loading || assets.loading) return <LoadingState label="正在读取治理状态" />;
  if (contributions.error !== undefined) return <ErrorState error={contributions.error} retry={contributions.refresh} />;
  if (assets.error !== undefined) return <ErrorState error={assets.error} retry={assets.refresh} />;
  return (
    <>
      <PageHeader eyebrow="Publication & Lifecycle" title="发布治理" subtitle="只有完成独立审核的候选才能执行。撤销与擦除使用更高权限，并立即影响后续检索。" actions={<><Button onClick={() => setShowLifecycle((value) => !value)} variant="secondary"><Plus size={16} /> 生命周期动作</Button><Button onClick={() => void Promise.all([contributions.refresh(), assets.refresh()])} variant="ghost"><RefreshCw size={16} /> 刷新</Button></>} />
      {showLifecycle ? <LifecycleForm assets={assets.data ?? []} onCreated={async () => { setShowLifecycle(false); await contributions.refresh(); }} /> : null}
      {error === undefined ? null : <div className="form-error" role="alert">{error}</div>}
      <section className="governance-stats"><Card><Clock3 /><div><span>待发布决策</span><strong>{ready.length}</strong></div></Card><Card><CheckCircle2 /><div><span>Published</span><strong>{(assets.data ?? []).filter((asset) => asset.status === "published").length}</strong></div></Card><Card><Archive /><div><span>已废弃</span><strong>{(assets.data ?? []).filter((asset) => asset.status === "deprecated").length}</strong></div></Card><Card><ShieldAlert /><div><span>撤销 / 擦除</span><strong>{(assets.data ?? []).filter((asset) => ["revoked", "erased"].includes(asset.status)).length}</strong></div></Card></section>
      <div className="governance-layout">
        <Card className="decision-card"><div className="section-header"><div><h2>等待执行的决策</h2><p>Publisher、Incident Responder 与 Erasure Officer 分权执行。</p></div></div>{ready.length === 0 ? <EmptyState icon={<Gavel />} title="没有待执行决策" description="审核通过的候选会出现在这里；平台不会自动跨越发布边界。" /> : <div className="decision-list">{ready.map((item) => { const kind = item.receipt.kind; const action = ["deprecate", "revoke", "erase"].includes(kind) ? kind : "publish"; return <div className="decision-row" key={item.receipt.contributionId}><span className={`decision-icon action-${action}`}>{action === "revoke" ? <Flame /> : action === "erase" ? <Trash2 /> : action === "deprecate" ? <Archive /> : <Gavel />}</span><div><strong>{titleOf(item)}</strong><span>{actionLabel(action)} · {item.receipt.spaceId.split("/").at(-1)}</span><small>{shortId(item.receipt.subjectRevisionId, 38)}</small></div><StatusBadge status={item.receipt.status} /><Button disabled={acting !== undefined} onClick={() => void execute(item)} variant={action === "revoke" || action === "erase" ? "danger" : "primary"}>{acting === item.receipt.contributionId ? "执行中…" : actionLabel(action)}</Button></div>;})}</div>}</Card>
        <Card className="policy-card"><span className="policy-shield"><Gavel size={23} /></span><p className="eyebrow">Current Policy Epoch</p><h2>{contributions.data?.[0]?.receipt.policyEpoch ?? "本地策略纪元"}</h2><p>执行时服务端会比较候选记录的 Policy Epoch。策略变化后，旧决策不能静默沿用。</p><div className="policy-rule"><AlertTriangle size={17} /><span>高风险错误使用 <strong>revoke</strong>，监管擦除使用 <strong>erase</strong>，不要用普通下架替代。</span></div></Card>
      </div>
      <Card className="history-card"><div className="section-header"><div><h2>最近治理轨迹</h2><p>终态贡献仍保留 Receipt 与决策引用，不覆盖历史。</p></div></div>{history.length === 0 ? <p className="muted-copy">还没有已完成的治理动作。</p> : <div className="history-table"><div className="table-head"><span>知识 / 动作</span><span>状态</span><span>更新时间</span><span>Contribution</span></div>{history.map((item) => <div className="table-row" key={item.receipt.contributionId}><span><strong>{titleOf(item)}</strong><small>{item.receipt.kind}</small></span><StatusBadge status={item.receipt.status} /><span>{formatRelativeTime(item.updatedAt)}</span><code>{shortId(item.receipt.contributionId, 22)}</code></div>)}</div>}</Card>
    </>
  );
}

function LifecycleForm({ assets, onCreated }: { readonly assets: readonly ConsoleAsset[]; readonly onCreated: () => Promise<void> }) {
  const actionable = assets.filter((asset) => !["revoked", "erased"].includes(asset.status));
  const [revisionId, setRevisionId] = useState(actionable[0]?.revisionId ?? "");
  const [action, setAction] = useState<LifecycleAction>("deprecate");
  const [rationale, setRationale] = useState("该知识已不再适用，需要通过受治理流程变更生命周期状态。");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const selected = actionable.find((asset) => asset.revisionId === revisionId);
  const submit = async () => { if (selected === undefined) return; setSubmitting(true); setError(undefined); try { await createLifecycleContribution({ action, rationale, revisionId: selected.revisionId, spaceId: selected.spaceId }); await onCreated(); } catch (caught) { setError(caught instanceof Error ? caught.message : "创建失败"); } finally { setSubmitting(false); } };
  return <Card className="lifecycle-form"><div><p className="eyebrow">New lifecycle candidate</p><h2>发起知识生命周期动作</h2><p>该动作先生成候选，仍需 Curator 审核后由对应高权限角色执行。</p></div><label className="field"><span>目标知识</span><select onChange={(event) => setRevisionId(event.target.value)} value={revisionId}>{actionable.map((asset) => <option key={asset.revisionId} value={asset.revisionId}>{asset.title} · {asset.status}</option>)}</select></label><label className="field"><span>动作</span><select onChange={(event) => setAction(event.target.value as LifecycleAction)} value={action}><option value="deprecate">Deprecate · 仍可审计但不再推荐</option><option value="revoke">Revoke · 立即停止后续消费</option><option value="erase">Erase · 执行监管擦除</option></select></label><label className="field lifecycle-reason"><span>理由</span><input onChange={(event) => setRationale(event.target.value)} value={rationale} /></label><Button disabled={selected === undefined || submitting || rationale.trim().length < 4} onClick={() => void submit()}>{submitting ? "创建中…" : "创建候选"}</Button>{error === undefined ? null : <div className="form-error">{error}</div>}</Card>;
}

function titleOf(item: ContributionListItem) { return (item.request.manifest?.title as string | undefined) ?? `${item.receipt.kind} · ${shortId(item.receipt.subjectRevisionId)}`; }
function actionLabel(action: string) { return action === "publish" ? "批准发布" : action === "deprecate" ? "执行废弃" : action === "revoke" ? "紧急撤销" : "监管擦除"; }
