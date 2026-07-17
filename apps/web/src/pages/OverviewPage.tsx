import {
  Activity,
  ArrowUpRight,
  BookOpenText,
  Bot,
  Check,
  ChevronRight,
  CircleDot,
  FileCheck2,
  MessageSquareText,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Link } from "react-router-dom";
import { getOverview } from "../api/client";
import type { Overview } from "../api/types";
import { useOnboarding } from "../contexts/OnboardingContext";
import { useAsyncResource } from "../hooks/useAsyncResource";
import {
  Button,
  Card,
  ErrorState,
  formatRelativeTime,
  LoadingState,
  PageHeader,
  SectionHeader,
  StatCard,
  StatusBadge,
} from "../components/ui";

export interface ResponsibilityAction {
  readonly callToAction: string;
  readonly description: string;
  readonly id: string;
  readonly role: string;
  readonly title: string;
  readonly to: string;
  readonly tone: "amber" | "indigo" | "slate" | "teal";
}

export function buildResponsibilityActions(
  overview: Overview,
): readonly ResponsibilityAction[] {
  const actions: ResponsibilityAction[] = [];
  const add = (action: ResponsibilityAction) => actions.push(action);
  const candidates = overview.workflow.candidate + overview.workflow.validating;

  if (candidates > 0) {
    add({
      callToAction: "进入审核中心",
      description: `${candidates} 条候选正在等待内容、来源与安全证据核验。`,
      id: "review",
      role: "Curator",
      title: "完成独立审核",
      to: "/review",
      tone: "amber",
    });
  }
  if (overview.workflow.needs_evidence > 0) {
    add({
      callToAction: "补充证据",
      description: `${overview.workflow.needs_evidence} 条贡献缺少发布所需的来源或验证材料。`,
      id: "evidence",
      role: "Contributor",
      title: "处理待补证贡献",
      to: "/contribute",
      tone: "indigo",
    });
  }
  if (overview.workflow.verified > 0) {
    add({
      callToAction: "进入发布治理",
      description: `${overview.workflow.verified} 条已验证候选等待 Publisher 绑定当前策略水位。`,
      id: "publish",
      role: "Publisher",
      title: "执行发布决定",
      to: "/governance",
      tone: "teal",
    });
  }
  if (overview.totals.knowledge === 0) {
    add({
      callToAction: "贡献第一条知识",
      description: "从一条有明确来源、用途和 Owner 的高价值知识开始试点。",
      id: "first-knowledge",
      role: "Contributor",
      title: "建立首个真实知识闭环",
      to: "/contribute",
      tone: "indigo",
    });
  } else if (overview.totals.usage === 0) {
    add({
      callToAction: "运行引用检索",
      description: `${overview.totals.knowledge} 个可读版本尚未形成真实 Usage 证据。`,
      id: "first-usage",
      role: "Reader",
      title: "验证知识能否解决任务",
      to: "/knowledge",
      tone: "slate",
    });
  } else if (overview.totals.feedback < overview.totals.usage) {
    add({
      callToAction: "查询并记录结果",
      description: "继续通过带引用查询形成 helped、neutral 或 harmed 效果证据。",
      id: "feedback",
      role: "Reader",
      title: "补齐知识使用效果",
      to: "/knowledge",
      tone: "slate",
    });
  }
  if (overview.totals.published > 0) {
    add({
      callToAction: "检查 Agent 接入",
      description: "验证 Discovery、就绪状态、OAuth metadata 与 ContextPack 契约。",
      id: "agent",
      role: "Integrator",
      title: "让 Agent 安全消费知识",
      to: "/agents",
      tone: "teal",
    });
  }
  if (actions.length === 0) {
    add({
      callToAction: "浏览效果证据",
      description: "当前没有待处理治理任务，检查 Usage、Feedback 与服务目标。",
      id: "observe",
      role: "Knowledge Owner",
      title: "复盘知识运营效果",
      to: "/evaluation",
      tone: "slate",
    });
  }
  return actions.slice(0, 4);
}

function activityDestination(status: string): string {
  if (status === "candidate" || status === "validating") return "/review";
  if (status === "needs_evidence") return "/contribute";
  if (status === "verified") return "/governance";
  if (status === "accepted") return "/knowledge";
  return "/contribute";
}

export function OverviewPage() {
  const resource = useAsyncResource(getOverview, []);
  const onboarding = useOnboarding();
  if (resource.loading) return <LoadingState label="正在汇总知识与治理状态" />;
  if (resource.error !== undefined) return <ErrorState error={resource.error} retry={resource.refresh} />;
  const overview = resource.data!;
  const responsibilityActions = buildResponsibilityActions(overview);
  const checklist = [
    { label: "连接知识节点", icon: CircleDot },
    { label: "导入第一条示例知识", icon: BookOpenText },
    { label: "完成独立审核与发布", icon: FileCheck2 },
    { label: "执行一次带引用检索", icon: Search },
    { label: "查看 Agent 接入方式", icon: Bot },
  ];

  return (
    <>
      <PageHeader
        eyebrow="今日知识态势"
        title="早上好，开始让知识可靠地成长"
        subtitle="从候选、审核、发布到实际使用证据，每一步都有来源、有边界、可回溯。"
        actions={
          <>
            <Link className="button button-secondary" to="/knowledge"><Search size={17} /> 搜索知识</Link>
            <Link className="button button-primary" to="/contribute"><Plus size={17} /> 贡献知识</Link>
          </>
        }
      />

      <section className="stat-grid" aria-label="平台关键指标">
        <StatCard accent="indigo" icon={<BookOpenText />} label="可用知识" value={overview.totals.knowledge} hint="Published Channel" />
        <StatCard accent="amber" icon={<FileCheck2 />} label="待推进" value={overview.totals.pendingReview} hint="待审核或待补证" />
        <StatCard accent="teal" icon={<Activity />} label="使用记录" value={overview.totals.usage} hint="已绑定真实引用" />
        <StatCard accent="slate" icon={<MessageSquareText />} label="反馈证据" value={overview.totals.feedback} hint="尚不直接影响排名" />
      </section>

      <Card className="responsibility-card">
        <SectionHeader
          title="现在最值得处理"
          description="按职责和真实工作流状态生成；只展示当前可以执行的下一步。"
          action={<span className="live-state"><i /> {overview.generatedAt === "" ? "实时状态" : `更新于 ${formatRelativeTime(overview.generatedAt)}`}</span>}
        />
        <div className="responsibility-grid">
          {responsibilityActions.map((action) => (
            <Link className={`responsibility-action action-${action.tone}`} key={action.id} to={action.to}>
              <span className="responsibility-role">{action.role}</span>
              <strong>{action.title}</strong>
              <p>{action.description}</p>
              <span className="responsibility-link">{action.callToAction} <ChevronRight size={15} /></span>
            </Link>
          ))}
        </div>
      </Card>

      <div className={`overview-grid ${onboarding.completed.length === 5 ? "overview-grid-single" : ""}`}>
        <Card className="activity-card">
          <SectionHeader
            title="最近知识活动"
            description="所有贡献与治理动作都保留不可覆盖的工作流轨迹。"
            action={<Link className="text-link" to="/governance">查看治理记录 <ArrowUpRight size={14} /></Link>}
          />
          {overview.recentActivity.length === 0 ? (
            <div className="compact-empty">
              <Sparkles size={22} />
              <div><strong>还没有知识活动</strong><p>运行新手任务，发布第一条受治理知识。</p></div>
              <Button variant="secondary" onClick={onboarding.open}>开始引导</Button>
            </div>
          ) : (
            <div className="activity-list">
              {overview.recentActivity.map((item) => (
                <Link className="activity-row" key={item.contributionId} to={activityDestination(item.status)}>
                  <span className={`activity-symbol activity-${item.kind}`}>
                    {item.kind === "create" || item.kind === "revise" ? <BookOpenText size={17} /> : <ShieldCheck size={17} />}
                  </span>
                  <div className="activity-copy">
                    <strong>{item.title}</strong>
                    <span>{item.kind === "create" ? "创建知识候选" : item.kind === "revise" ? "提交修订" : "执行治理动作"} · {formatRelativeTime(item.updatedAt)}</span>
                  </div>
                  <StatusBadge status={item.status} />
                  <ChevronRight className="row-chevron" size={17} />
                </Link>
              ))}
            </div>
          )}
        </Card>

        {onboarding.completed.length === 5 ? null : <Card className="onboarding-card">
          <div className="onboarding-card-head">
            <span className="spark-icon"><Sparkles size={18} /></span>
            <div><p className="eyebrow">快速上手</p><h2>建立第一个知识闭环</h2></div>
            <span className="completion-ring">{onboarding.completed.length}/5</span>
          </div>
          <p className="muted-copy">用五个真实动作了解知识如何被贡献、审核、消费和持续改进。</p>
          <div className="checklist">
            {checklist.map((item, index) => {
              const done = onboarding.completed.includes(index);
              return (
                <button className={`checklist-item ${done ? "checklist-done" : ""}`} key={item.label} onClick={onboarding.open}>
                  <span className="check-circle">{done ? <Check size={14} /> : index + 1}</span>
                  <item.icon size={17} />
                  <span>{item.label}</span>
                  <ChevronRight size={16} />
                </button>
              );
            })}
          </div>
          <Button className="full-width" onClick={onboarding.open}>继续新手任务 <ChevronRight size={17} /></Button>
        </Card>}
      </div>

      <Card className="space-card">
        <SectionHeader title="知识空间" description="Space 是权限、用途和治理策略共同作用的知识边界。" action={<Link className="text-link" to="/settings">管理空间 <ArrowUpRight size={14} /></Link>} />
        <div className="space-grid">
          {overview.spaces.map((space, index) => (
            <Link className="space-tile" key={space.id} to={`/knowledge?space=${encodeURIComponent(space.id)}`}>
              <span className={`space-monogram space-color-${index % 4}`}>{space.id.split("/").at(-1)?.slice(0, 2).toUpperCase() ?? "SP"}</span>
              <div><strong>{space.id.split("/").at(-1) ?? space.id}</strong><span title={space.id}>{space.id}</span></div>
              <dl><div><dt>知识</dt><dd>{space.assetCount}</dd></div><div><dt>待处理</dt><dd>{space.pendingCount}</dd></div></dl>
              <ChevronRight size={17} />
            </Link>
          ))}
        </div>
      </Card>
    </>
  );
}
