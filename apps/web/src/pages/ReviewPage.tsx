import { useEffect, useMemo, useState } from "react";
import {
  AlertOctagon,
  BookOpenText,
  Check,
  ChevronRight,
  FileCheck2,
  FileQuestion,
  Link2,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  contributionEvidenceRefs,
  getContributions,
  getRevisionDetail,
  reviewContribution,
} from "../api/client";
import type { ContributionListItem } from "../api/types";
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  formatRelativeTime,
  LoadingState,
  PageHeader,
  shortId,
  StatusBadge,
} from "../components/ui";
import { useAsyncResource } from "../hooks/useAsyncResource";

const CHECKS = [
  "已阅读候选正文和所有变更",
  "已核对适用用途、地区、有效期和义务",
  "已检查来源、证据及其独立性",
  "已确认失败分支、禁止事项和潜在伤害",
] as const;

type ContentScanSeverity = "high" | "medium" | "low" | "unknown";
type ContentScanVerdict = "clean" | "review" | "quarantined" | "unknown";

export interface ContentScanFindingView {
  readonly code: string;
  readonly end?: number;
  readonly message: string;
  readonly payloadName: string;
  readonly severity: ContentScanSeverity;
  readonly start?: number;
}

export interface ContentScanView {
  readonly findingCount: number;
  readonly findings: readonly ContentScanFindingView[];
  readonly findingsTruncated: boolean;
  readonly offsetUnit: string;
  readonly scannerVersion: string;
  readonly verdict: ContentScanVerdict;
}

export function ReviewPage() {
  const resource = useAsyncResource(() => getContributions("curator"), []);
  const [selectedId, setSelectedId] = useState<string>();
  const [rationale, setRationale] = useState("已核验正文、来源、适用边界、失败分支和策略义务。");
  const [checks, setChecks] = useState<boolean[]>(CHECKS.map(() => false));
  const [scanAcknowledged, setScanAcknowledged] = useState(false);
  const [acting, setActing] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [targetContent, setTargetContent] = useState<string>();
  const [parentContent, setParentContent] = useState<string>();
  const [contentContributionId, setContentContributionId] = useState<string>();
  const [contentLoading, setContentLoading] = useState(false);
  const queue = useMemo(
    () => (resource.data ?? []).filter((item) => ["candidate", "needs_evidence", "quarantined"].includes(item.receipt.status)),
    [resource.data],
  );
  const selected = queue.find((item) => item.receipt.contributionId === selectedId) ?? queue[0];
  const evidenceRefs = selected === undefined ? [] : contributionEvidenceRefs(selected);
  const contentScan = readContentScan(selected);
  const contentRequiresScan = selected?.receipt.kind === "create" || selected?.receipt.kind === "revise";
  const isQuarantined = selected?.receipt.status === "quarantined" ||
    contentScan?.verdict === "quarantined";
  const scanRecordInvalid = contentScan?.verdict === "unknown" ||
    (contentRequiresScan && contentScan === undefined);
  const scanBlocksVerification = isQuarantined || scanRecordInvalid;
  const requiresScanAcknowledgement = contentScan?.verdict === "review";

  useEffect(() => {
    setChecks(CHECKS.map(() => false));
    setScanAcknowledged(false);
    setActionError(undefined);
    setTargetContent(undefined);
    setParentContent(undefined);
    setContentLoading(false);
    setContentContributionId(selected?.receipt.contributionId);
    if (selected === undefined) return;
    if (scanBlocksVerification) return;
    const inline = payloadText(selected);
    if (inline.length > 0) setTargetContent(inline);
    const parents = parentRevisions(selected);
    const needsTargetRead = inline.length === 0;
    if (!needsTargetRead && parents.length === 0) return;
    let active = true;
    setContentLoading(true);
    void Promise.all([
      needsTargetRead
        ? getRevisionDetail(selected.receipt.spaceId, selected.receipt.subjectRevisionId)
        : Promise.resolve(undefined),
      parents[0] === undefined
        ? Promise.resolve(undefined)
        : getRevisionDetail(selected.receipt.spaceId, parents[0]),
    ]).then(([target, parent]) => {
      if (!active) return;
      if (target !== undefined) setTargetContent(target.content);
      if (parent !== undefined) setParentContent(parent.content);
    }).catch((error: unknown) => {
      if (active) setActionError(error instanceof Error ? error.message : "无法读取版本正文");
    }).finally(() => {
      if (active) setContentLoading(false);
    });
    return () => { active = false; };
  }, [selected?.receipt.contributionId]);

  const allChecked = checks.every(Boolean) &&
    (!requiresScanAcknowledgement || scanAcknowledged) &&
    !scanBlocksVerification;
  const contentIsCurrent = selected !== undefined &&
    contentContributionId === selected.receipt.contributionId;
  const decide = async (decision: "verify" | "reject" | "request_evidence" | "quarantine") => {
    if (selected === undefined) return;
    if (scanBlocksVerification) {
      setActionError("该贡献已被内容安全门禁隔离，不能再执行审核决策。");
      return;
    }
    if (decision === "verify" && (!allChecked || rationale.trim().length < 8)) {
      setActionError(requiresScanAcknowledgement && !scanAcknowledged
        ? "请逐项阅读内容安全发现，并确认正文始终作为不可信内容处理。"
        : "完成全部核验项并填写具体审核理由后，才能核验通过。");
      return;
    }
    setActing(decision);
    setActionError(undefined);
    try {
      await reviewContribution({
        // The node derives Profile-required machine and human Attestations
        // from the checks it actually executed and this signed Curator
        // decision. The browser must not manufacture benchmark metrics.
        attestationRefs: [],
        contributionId: selected.receipt.contributionId,
        decision,
        etag: selected.etag,
        rationale,
      });
      setSelectedId(undefined);
      await resource.refresh();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "审核决策失败");
    } finally {
      setActing(undefined);
    }
  };

  if (resource.loading) return <LoadingState label="正在读取待审核贡献" />;
  if (resource.error !== undefined) return <ErrorState error={resource.error} retry={resource.refresh} />;
  return (
    <>
      <PageHeader
        eyebrow="Independent Review"
        title="审核中心"
        subtitle="先阅读正文、扫描发现、证据和版本差异；服务端只为实际完成的检查生成不可变证明。"
        actions={<Button onClick={() => void resource.refresh()} variant="secondary"><RefreshCw size={16} /> 刷新队列</Button>}
      />
      <div className="review-layout">
        <Card className="review-queue">
          <div className="queue-head"><div><strong>{queue.length}</strong><span> 个待审核或已隔离候选</span></div><span className="role-pill"><ShieldCheck size={14} /> Curator</span></div>
          {queue.length === 0 ? (
            <EmptyState icon={<Check />} title="审核队列已清空" description="新的知识候选出现后会在这里等待独立决策。" />
          ) : (
            <div className="queue-list">{queue.map((item) => (
              <button className={`queue-row ${selected?.receipt.contributionId === item.receipt.contributionId ? "queue-row-active" : ""}`} key={item.receipt.contributionId} onClick={() => setSelectedId(item.receipt.contributionId)}>
                <span className="queue-icon"><BookOpenText size={18} /></span><span><strong>{titleOf(item)}</strong><small>{item.receipt.kind} · {formatRelativeTime(item.updatedAt)}</small></span><StatusBadge status={item.receipt.status} /><ChevronRight size={16} />
              </button>
            ))}</div>
          )}
        </Card>

        <Card className="review-detail">
          {selected === undefined ? (
            <EmptyState icon={<FileQuestion />} title="没有待审核内容" description="平台不会自动发布未经审核的知识。" />
          ) : (
            <>
              <div className="review-detail-head"><div><span className="asset-type">{selected.receipt.kind}</span><StatusBadge status={selected.receipt.status} /></div><span title={selected.receipt.contributionId}>{shortId(selected.receipt.contributionId)}</span></div>
              <h2>{titleOf(selected)}</h2>
              <p className="review-summary">{summaryOf(selected)}</p>

              {scanBlocksVerification ? (
                <div className="scan-blocking-alert" role="alert">
                  <AlertOctagon aria-hidden="true" size={21} />
                  <div>
                    <strong>{isQuarantined ? "内容已隔离，审核通过通道已关闭" : "扫描记录缺失或无法识别，审核通道已关闭"}</strong>
                    <p>{isQuarantined ? "高风险原文不会进入共享审核和知识索引。此页仅展示不包含原始敏感值的扫描元数据，不能核验、请求补证或重新决策。" : "安全扫描不能被默认为已通过。请先修复完整、可验证的扫描记录；在此之前平台不读取正文，也不允许任何审核决策。"}</p>
                  </div>
                </div>
              ) : null}

              <ContentScanDetails scan={contentScan} />

              <section className="review-content-section">
                <div className="section-header"><div><h3>候选正文与变更</h3><p>正文按接收时已核验的 Payload 展示，修订则标出相对父版本的行级变化。</p></div></div>
                {scanBlocksVerification ? <p className="muted-copy">原文已由隔离门禁阻断，本工作台不会尝试读取或渲染。</p> : !contentIsCurrent || contentLoading ? <LoadingState label="读取版本正文" /> : targetContent === undefined ? <p className="muted-copy">目标正文不可用，不能核验通过。</p> : parentContent === undefined ? <pre className="content-preview">{targetContent}</pre> : <LineDiff before={parentContent} after={targetContent} />}
              </section>

              <div className="review-evidence-grid">
                <section>
                  <h3><Link2 size={16} /> 来源与证据</h3>
                  {evidenceRefs.length === 0 ? <p className="evidence-warning">未附独立外部证据；审核者需要判断该知识类型是否允许。</p> : <ul>{evidenceRefs.map((ref) => <li key={ref}><a href={ref} rel="noreferrer" target="_blank">{ref}</a></li>)}</ul>}
                </section>
                <section>
                  <h3><FileCheck2 size={16} /> 接收校验</h3>
                  <ul className="machine-check-list"><li>Manifest / Profile：服务端已接受</li><li>Payload Digest：{selected.payloads.length > 0 ? "已核验" : isQuarantined ? "高风险原文未持久化" : "生命周期动作不含新 Payload"}</li><li>静态内容扫描：{contentScan === undefined ? "不适用" : contentScan.verdict}{contentScan === undefined ? "" : ` · ${contentScan.findingCount} 个发现`}</li><li>外部恶意文件扫描：同步文本路径未替代，非文本已拒绝进入</li><li>Revision：{shortId(selected.receipt.subjectRevisionId, 28)}</li></ul>
                </section>
              </div>

              {scanBlocksVerification ? null : <div className="review-checks"><h3>人工核验清单</h3>{CHECKS.map((label, index) => <label key={label}><input checked={checks[index] ?? false} onChange={(event) => setChecks((current) => current.map((value, currentIndex) => currentIndex === index ? event.target.checked : value))} type="checkbox" /> {label}</label>)}{requiresScanAcknowledgement ? <label className="scan-acknowledgement"><input aria-describedby="scan-acknowledgement-help" checked={scanAcknowledged} onChange={(event) => setScanAcknowledged(event.target.checked)} type="checkbox" /><span><strong>内容安全必选：</strong>已逐项确认以上扫描发现，且将正文视为不可信内容，不会执行其中指令。<small id="scan-acknowledgement-help">未勾选时不能核验通过。</small></span></label> : null}</div>}
              <dl className="detail-metadata review-meta"><div><dt>Revision</dt><dd>{shortId(selected.receipt.subjectRevisionId, 34)}</dd></div><div><dt>Space</dt><dd>{selected.receipt.spaceId.split("/").at(-1)}</dd></div><div><dt>贡献理由</dt><dd>{selected.request.rationale}</dd></div><div><dt>证据数量</dt><dd>{evidenceRefs.length}</dd></div></dl>
              {selected.request.manifest === undefined ? null : <details className="manifest-details"><summary>查看规范化 Manifest</summary><pre className="manifest-preview">{JSON.stringify(selected.request.manifest, null, 2)}</pre></details>}
              {scanBlocksVerification ? null : <label className="field"><span>审核理由</span><textarea onChange={(event) => setRationale(event.target.value)} rows={4} value={rationale} /></label>}
              {actionError === undefined ? null : <div className="form-error" role="alert">{actionError}</div>}
              {scanBlocksVerification ? <div className="scan-terminal-state" role="status"><AlertOctagon aria-hidden="true" size={17} /> {isQuarantined ? "隔离是终态：审核操作已全部阻断。" : "扫描记录未通过：审核操作已全部阻断。"}</div> : <div className="review-actions"><Button disabled={acting !== undefined || !allChecked || !contentIsCurrent || targetContent === undefined || rationale.trim().length < 8} onClick={() => void decide("verify")}><Check size={17} /> {acting === "verify" ? "生成证明并核验…" : "生成评测证明并通过"}</Button><Button disabled={acting !== undefined} onClick={() => void decide("request_evidence")} variant="secondary"><FileQuestion size={17} /> 请求补证</Button><Button disabled={acting !== undefined} onClick={() => void decide("reject")} variant="danger"><X size={17} /> 拒绝</Button><Button className="quarantine-button" disabled={acting !== undefined} onClick={() => void decide("quarantine")} variant="ghost"><AlertOctagon size={17} /> 隔离</Button></div>}
            </>
          )}
        </Card>
      </div>
    </>
  );
}

export function ContentScanDetails({ scan }: { readonly scan?: ContentScanView }) {
  if (scan === undefined) {
    return (
      <section className="content-scan-details scan-unknown" aria-labelledby="content-scan-heading">
        <div className="content-scan-head">
          <div><h3 id="content-scan-heading">内容安全扫描</h3><p>此贡献没有可展示的同步扫描记录。</p></div>
          <span className="scan-verdict scan-verdict-unknown">unknown</span>
        </div>
      </section>
    );
  }
  const offsetLabel = scan.offsetUnit === "utf8-byte" ? "UTF-8 字节" : scan.offsetUnit;
  return (
    <section className={`content-scan-details scan-${scan.verdict}`} aria-labelledby="content-scan-heading">
      <div className="content-scan-head">
        <div>
          <h3 id="content-scan-heading">内容安全扫描</h3>
          <p>{scan.verdict === "clean" ? "同步静态扫描未发现命中项。" : scan.verdict === "review" ? "发现项需要人工逐条复核；候选正文始终是不可信数据。" : scan.verdict === "quarantined" ? "扫描命中高风险内容，原文已隔离且不可通过。" : "扫描记录格式无法识别，安全门禁将其按阻断处理。"}</p>
        </div>
        <span className={`scan-verdict scan-verdict-${scan.verdict}`}>{scan.verdict}</span>
      </div>
      <div className="content-scan-meta"><span>{scan.scannerVersion}</span><span>{scan.findingCount} 个发现</span><span>定位单位：{offsetLabel}</span></div>
      {scan.findings.length === 0 ? null : (
        <ol className="scan-finding-list">
          {scan.findings.map((finding, index) => (
            <li className="scan-finding" key={`${finding.payloadName}-${finding.code}-${finding.start ?? "unknown"}-${index}`}>
              <div className="scan-finding-main"><code>{finding.code}</code><span className={`scan-severity scan-severity-${finding.severity}`}>{finding.severity}</span></div>
              <div className="scan-finding-location"><span>Payload：<code>{finding.payloadName}</code></span><span>{offsetLabel}：[{finding.start ?? "?"}, {finding.end ?? "?"})</span></div>
              <p>{finding.message}</p>
            </li>
          ))}
        </ol>
      )}
      {scan.findingsTruncated || scan.findingCount > scan.findings.length ? <p className="scan-truncated" role="note">发现数超过页面携带的明细；当前展示 {scan.findings.length} / {scan.findingCount} 条，不得将未展示项视为已通过。</p> : null}
    </section>
  );
}

export function readContentScan(item?: ContributionListItem): ContentScanView | undefined {
  const record = item?.amendments.find((amendment) => amendment.kind === "content-scan");
  if (record === undefined) return undefined;
  const rawFindings = Array.isArray(record.findings) ? record.findings : [];
  const findings = rawFindings.map((value, index): ContentScanFindingView => {
    const finding = isRecord(value) ? value : {};
    return {
      code: typeof finding.code === "string" ? finding.code : `unknown.${index + 1}`,
      ...(typeof finding.end === "number" && Number.isFinite(finding.end) ? { end: finding.end } : {}),
      message: typeof finding.message === "string" ? finding.message : "扫描器未提供可读说明。",
      payloadName: typeof finding.payloadName === "string" ? finding.payloadName : "未标识",
      severity: scanSeverity(finding.severity),
      ...(typeof finding.start === "number" && Number.isFinite(finding.start) ? { start: finding.start } : {}),
    };
  });
  const reportedCount = typeof record.findingCount === "number" &&
      Number.isSafeInteger(record.findingCount) && record.findingCount >= 0
    ? record.findingCount
    : findings.length;
  return {
    findingCount: Math.max(reportedCount, findings.length),
    findings,
    findingsTruncated: record.findingsTruncated === true,
    offsetUnit: typeof record.offsetUnit === "string" ? record.offsetUnit : "unknown",
    scannerVersion: typeof record.scannerVersion === "string" ? record.scannerVersion : "未标识扫描器",
    verdict: scanVerdict(record.verdict),
  };
}

function scanSeverity(value: unknown): ContentScanSeverity {
  return value === "high" || value === "medium" || value === "low" ? value : "unknown";
}

function scanVerdict(value: unknown): ContentScanVerdict {
  return value === "clean" || value === "review" || value === "quarantined" ? value : "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function LineDiff({ before, after }: { readonly before: string; readonly after: string }) {
  const analysis = useMemo(() => analyzeLineDiff(before, after), [after, before]);
  const large = isLargeDiff(before, after, analysis);
  const lines = useMemo(
    () => large ? [] : diffLinesFromAnalysis(analysis),
    [analysis, large],
  );
  if (large) {
    const beforeChanged = analysis.beforeLines.length
      - analysis.commonPrefixLines
      - analysis.commonSuffixLines;
    const afterChanged = analysis.afterLines.length
      - analysis.commonPrefixLines
      - analysis.commonSuffixLines;
    return (
      <div className="large-diff">
        <div className="large-diff-notice" role="note">
          <strong>超大正文已切换为完整双版本视图</strong>
          <span>
            为保持审核页流畅，使用线性前后缀定位变化，不执行二次方行匹配；父版本
            {analysis.beforeLines.length} 行、候选版本 {analysis.afterLines.length} 行，
            中间变化分别为 {beforeChanged} / {afterChanged} 行。下方正文完整显示、没有截断。
          </span>
        </div>
        <div className="large-diff-versions">
          <section>
            <header><strong>父版本 · 完整正文</strong><span>{before.length.toLocaleString("zh-CN")} 字符</span></header>
            <pre className="content-preview large-diff-content">{before}</pre>
          </section>
          <section>
            <header><strong>候选版本 · 完整正文</strong><span>{after.length.toLocaleString("zh-CN")} 字符</span></header>
            <pre className="content-preview large-diff-content">{after}</pre>
          </section>
        </div>
      </div>
    );
  }
  return <pre className="line-diff">{lines.map((line, index) => <span className={`diff-${line.kind}`} key={`${index}-${line.kind}`}><i>{line.kind === "same" ? " " : line.kind === "add" ? "+" : "−"}</i>{line.text || " "}</span>)}</pre>;
}

export interface LineDiffAnalysis {
  readonly afterLines: readonly string[];
  readonly beforeLines: readonly string[];
  readonly commonPrefixLines: number;
  readonly commonSuffixLines: number;
}

export interface DiffLine {
  readonly kind: "add" | "remove" | "same";
  readonly text: string;
}

const LARGE_DIFF_CHARACTER_THRESHOLD = 200_000;
const LARGE_DIFF_LINE_THRESHOLD = 4_000;

export function analyzeLineDiff(before: string, after: string): LineDiffAnalysis {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const sharedLength = Math.min(beforeLines.length, afterLines.length);
  let commonPrefixLines = 0;
  while (
    commonPrefixLines < sharedLength &&
    beforeLines[commonPrefixLines] === afterLines[commonPrefixLines]
  ) {
    commonPrefixLines += 1;
  }
  let commonSuffixLines = 0;
  while (
    commonSuffixLines < sharedLength - commonPrefixLines &&
    beforeLines[beforeLines.length - commonSuffixLines - 1] ===
      afterLines[afterLines.length - commonSuffixLines - 1]
  ) {
    commonSuffixLines += 1;
  }
  return { afterLines, beforeLines, commonPrefixLines, commonSuffixLines };
}

export function diffLines(before: string, after: string): readonly DiffLine[] {
  return diffLinesFromAnalysis(analyzeLineDiff(before, after));
}

function diffLinesFromAnalysis(analysis: LineDiffAnalysis): readonly DiffLine[] {
  const { afterLines, beforeLines, commonPrefixLines, commonSuffixLines } = analysis;
  const result: { kind: "add" | "remove" | "same"; text: string }[] = [];
  for (let index = 0; index < commonPrefixLines; index += 1) {
    result.push({ kind: "same", text: beforeLines[index]! });
  }
  const beforeMiddleEnd = beforeLines.length - commonSuffixLines;
  for (let index = commonPrefixLines; index < beforeMiddleEnd; index += 1) {
    result.push({ kind: "remove", text: beforeLines[index]! });
  }
  const afterMiddleEnd = afterLines.length - commonSuffixLines;
  for (let index = commonPrefixLines; index < afterMiddleEnd; index += 1) {
    result.push({ kind: "add", text: afterLines[index]! });
  }
  for (let index = beforeMiddleEnd; index < beforeLines.length; index += 1) {
    result.push({ kind: "same", text: beforeLines[index]! });
  }
  return result;
}

function isLargeDiff(
  before: string,
  after: string,
  analysis: LineDiffAnalysis,
): boolean {
  return before.length + after.length > LARGE_DIFF_CHARACTER_THRESHOLD ||
    analysis.beforeLines.length + analysis.afterLines.length > LARGE_DIFF_LINE_THRESHOLD;
}

function payloadText(item: ContributionListItem): string {
  const payload = item.payloads.find((candidate) => candidate.name === "primary" && candidate.mediaType.startsWith("text/"));
  if (payload === undefined) return "";
  try {
    const bytes = Uint8Array.from(atob(payload.data), (value) => value.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

function parentRevisions(item: ContributionListItem): readonly string[] {
  const parents = item.request.manifest?.parents;
  return Array.isArray(parents) ? parents.filter((value): value is string => typeof value === "string") : [];
}

function titleOf(item: ContributionListItem): string {
  return (item.request.manifest?.title as string | undefined) ?? `${item.receipt.kind} · ${shortId(item.receipt.subjectRevisionId)}`;
}

function summaryOf(item: ContributionListItem): string {
  return (item.request.manifest?.summary as string | undefined) ?? `对目标 Revision 执行 ${item.receipt.kind} 治理动作。`;
}
