import { Activity, AlertTriangle, Gauge, MessageSquareText, Quote, ShieldCheck } from "lucide-react";
import { getEvidenceSummary, getOverview, getServiceHealth } from "../api/client";
import { Card, ErrorState, LoadingState, PageHeader, SectionHeader, shortId, StatCard } from "../components/ui";
import { useAsyncResource } from "../hooks/useAsyncResource";

export function EvaluationPage() {
  const resource = useAsyncResource(async () => {
    const [overview, evidence, health] = await Promise.all([
      getOverview(),
      getEvidenceSummary(),
      getServiceHealth(),
    ]);
    return { evidence, health, overview };
  }, []);
  if (resource.loading) return <LoadingState label="正在聚合效果证据" />;
  if (resource.error !== undefined) return <ErrorState error={resource.error} retry={resource.refresh} />;
  const { evidence, health, overview } = resource.data!;
  const feedbackTotal = Math.max(evidence.totals.eligibleFeedback, 1);
  const helpedRate = evidence.outcomes.helped / feedbackTotal;
  return (
    <>
      <PageHeader eyebrow="Evidence, not vanity metrics" title="效果证据" subtitle="真实展示 Query → Exposure → Usage → Feedback，并把 harmed 信号送入复审队列；反馈不会直接改排名或发布。" />
      <section className="stat-grid"><StatCard accent="indigo" icon={<Quote />} label="发布版本" value={overview.totals.published} hint="具备 Profile 要求的不可变证明链" /><StatCard accent="teal" icon={<Activity />} label="可验证使用" value={evidence.totals.usage} hint="绑定 Exposure 与 Passage Citation" /><StatCard accent="amber" icon={<MessageSquareText />} label="反馈证据" value={evidence.totals.feedback} hint={`${evidence.totals.eligibleFeedback} 条具备聚合资格 · 帮助率 ${(helpedRate * 100).toFixed(1)}%`} /><StatCard accent={health.status === "meeting_objective" ? "slate" : "amber"} icon={<Gauge />} label="服务 P95" value={`${health.window.p95Milliseconds.toFixed(0)} ms`} hint={`目标 ≤ ${health.objective.p95Milliseconds} ms`} /></section>

      <div className="evidence-service-strip"><span className={health.status === "meeting_objective" ? "service-ok" : "service-degraded"}><i /> {health.status === "meeting_objective" ? "当前满足服务目标" : "当前服务指标需要关注"}</span><span>{health.window.requestCount} 个请求样本</span><span>5xx {(health.window.errorRate * 100).toFixed(2)}%</span><span>事件循环 P95 {health.window.eventLoopP95Milliseconds.toFixed(1)} ms</span></div>

      <div className="evaluation-layout">
        <Card className="flow-chart"><SectionHeader title="任务证据漏斗" description="原始反馈与可聚合反馈严格分开，避免把未通过相关性和隐私门禁的信号算成质量结论。" /><div className="evidence-funnel"><div><span>Published</span><strong>{overview.totals.published}</strong></div><i>→</i><div><span>Usage</span><strong>{evidence.totals.usage}</strong></div><i>→</i><div><span>Raw Feedback</span><strong>{evidence.totals.feedback}</strong></div><i>→</i><div><span>Eligible</span><strong>{evidence.totals.eligibleFeedback}</strong></div><i>→</i><div><span>Helped / Harmed</span><strong>{evidence.outcomes.helped} / {evidence.outcomes.harmed}</strong></div></div></Card>
        <Card className="evidence-model"><span className="evidence-icon"><ShieldCheck size={23} /></span><p className="eyebrow">Qualified task success</p><h2>正确、可引用、未越权、满足 SLO</h2><p>当前帮助率只覆盖主动反馈样本，不能冒充总体任务成功率。真实黄金任务集接入后，EvaluationRun 才会加入 Recall@5、无答案准确率、引用重定位和伤害评测。</p><div className="evidence-chain"><span>Required Attestations</span><i>→</i><span>Gate</span><i>→</i><span>Usage</span><i>→</i><span>Feedback</span></div></Card>
      </div>

      <Card className="evidence-table-card"><SectionHeader title="按 Revision 的使用与合格结果" description="Usage 显示全部可验证使用；Helped/Harmed 只统计服务端判定可聚合的反馈。" />{evidence.revisions.length === 0 ? <p className="muted-copy">还没有可归因的任务证据。请从知识检索结果记录“有帮助 / 一般 / 有伤害”。</p> : <div className="history-table"><div className="table-head"><span>Revision</span><span>Usage</span><span>Helped</span><span>Harmed</span></div>{evidence.revisions.map((item) => <div className="table-row" key={item.revisionId}><code title={item.revisionId}>{shortId(item.revisionId, 34)}</code><strong>{item.usage}</strong><span>{item.helped}</span><span className={item.harmed > 0 ? "harm-count" : ""}>{item.harmed}</span></div>)}</div>}</Card>

      <Card className="harm-queue"><SectionHeader title="伤害与复审队列" description="所有 harmed 信号都进入人工调查；只有合格信号进入统计，任何信号都不会自动删知识或改排名。" />{evidence.harmed.length === 0 ? <p className="muted-copy">当前没有 harmed 证据。</p> : <div className="harm-list">{evidence.harmed.map((item) => <div key={item.feedbackId}><AlertTriangle /><span><strong>{item.taskCategory}</strong><small>{item.revisionIds.map((revision) => shortId(revision, 24)).join(" · ")}</small></span><em className={item.eligibleForAggregation ? "evidence-qualified" : "evidence-unqualified"}>{item.eligibleForAggregation ? "可聚合" : `待核验 · ${item.correlationClass}`}</em><time>{item.observedAt === undefined ? "待处理" : new Date(item.observedAt).toLocaleString("zh-CN")}</time></div>)}</div>}</Card>
    </>
  );
}
