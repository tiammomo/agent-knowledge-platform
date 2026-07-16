import type { ButtonHTMLAttributes, PropsWithChildren, ReactNode } from "react";
import { AlertTriangle, ArrowRight, LoaderCircle, RefreshCw } from "lucide-react";

export function PageHeader(props: {
  readonly actions?: ReactNode;
  readonly eyebrow?: string;
  readonly subtitle: string;
  readonly title: string;
}) {
  return (
    <header className="page-header">
      <div>
        {props.eyebrow === undefined ? null : <p className="eyebrow">{props.eyebrow}</p>}
        <h1>{props.title}</h1>
        <p className="page-subtitle">{props.subtitle}</p>
      </div>
      {props.actions === undefined ? null : <div className="page-actions">{props.actions}</div>}
    </header>
  );
}

export function Button({
  children,
  className = "",
  variant = "primary",
  ...props
}: PropsWithChildren<
  ButtonHTMLAttributes<HTMLButtonElement> & {
    readonly variant?: "primary" | "secondary" | "ghost" | "danger";
  }
>) {
  return (
    <button className={`button button-${variant} ${className}`} {...props}>
      {children}
    </button>
  );
}

export function Card({
  children,
  className = "",
}: PropsWithChildren<{ readonly className?: string }>) {
  return <section className={`card ${className}`}>{children}</section>;
}

export function StatCard(props: {
  readonly accent: "indigo" | "teal" | "amber" | "slate";
  readonly hint: string;
  readonly icon: ReactNode;
  readonly label: string;
  readonly value: number | string;
}) {
  return (
    <Card className={`stat-card stat-${props.accent}`}>
      <div className="stat-icon" aria-hidden="true">
        {props.icon}
      </div>
      <div>
        <p className="stat-label">{props.label}</p>
        <strong className="stat-value">{props.value}</strong>
        <p className="stat-hint">{props.hint}</p>
      </div>
    </Card>
  );
}

const STATUS_LABELS: Record<string, string> = {
  accepted: "已执行",
  candidate: "待审核",
  deprecated: "已废弃",
  erased: "已擦除",
  needs_evidence: "待补证",
  published: "已发布",
  quarantined: "已隔离",
  rejected: "已拒绝",
  revoked: "已撤销",
  superseded: "历史版本",
  validating: "校验中",
  verified: "待发布",
  withdrawn: "已撤回",
};

export function StatusBadge({ status }: { readonly status: string }) {
  return <span className={`status-badge status-${status}`}>{STATUS_LABELS[status] ?? status}</span>;
}

export function EmptyState(props: {
  readonly action?: ReactNode;
  readonly description: string;
  readonly icon: ReactNode;
  readonly title: string;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon" aria-hidden="true">
        {props.icon}
      </div>
      <h3>{props.title}</h3>
      <p>{props.description}</p>
      {props.action}
    </div>
  );
}

export function LoadingState({ label = "正在读取知识状态" }: { readonly label?: string }) {
  return (
    <div className="loading-state" role="status">
      <LoaderCircle className="spin" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState(props: { readonly error: Error; readonly retry: () => void }) {
  return (
    <div className="error-state" role="alert">
      <AlertTriangle aria-hidden="true" />
      <div>
        <strong>暂时无法读取数据</strong>
        <p>{props.error.message}</p>
      </div>
      <Button variant="secondary" onClick={props.retry}>
        <RefreshCw size={16} /> 重试
      </Button>
    </div>
  );
}

export function SectionHeader(props: {
  readonly action?: ReactNode;
  readonly description?: string;
  readonly title: string;
}) {
  return (
    <div className="section-header">
      <div>
        <h2>{props.title}</h2>
        {props.description === undefined ? null : <p>{props.description}</p>}
      </div>
      {props.action}
    </div>
  );
}

export function InlineLink({ children }: PropsWithChildren) {
  return (
    <span className="inline-link">
      {children} <ArrowRight size={14} aria-hidden="true" />
    </span>
  );
}

export function formatRelativeTime(value: string): string {
  const delta = Date.now() - Date.parse(value);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(value));
}

export function shortId(value: string, length = 18): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}
