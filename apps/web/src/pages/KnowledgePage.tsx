import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BookOpenText,
  Check,
  ChevronRight,
  CircleSlash,
  Copy,
  GitBranch,
  Quote,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  X,
} from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import {
  getAssets,
  getRevisionDetail,
  recordKnowledgeOutcome,
  searchKnowledge,
} from "../api/client";
import type { ConsoleAsset, QueryResultItem, RevisionDetail } from "../api/types";
import { useAsyncResource } from "../hooks/useAsyncResource";
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

interface DisplayedResult {
  readonly indexedThrough: string;
  readonly item: QueryResultItem;
  readonly policyEpoch: string;
  readonly projectionGeneration: string;
  readonly queryReceiptId: string;
  readonly snapshot: string;
}

export interface KnowledgeSearchCriteria {
  readonly assetTypes: readonly string[];
  readonly labels: readonly string[];
  readonly query: string;
  readonly spaceId?: string;
}

interface SearchSession {
  readonly criteria: KnowledgeSearchCriteria;
  readonly indexedThrough: string;
  readonly key: string;
  readonly nextCursor?: string;
  readonly policyEpoch: string;
  readonly projectionGeneration: string;
  readonly snapshot: string;
}

export function KnowledgePage() {
  const [params, setParams] = useSearchParams();
  const searchInput = useRef<HTMLInputElement>(null);
  const detailPanel = useRef<HTMLElement>(null);
  const assets = useAsyncResource(getAssets, []);
  const initialQuery = params.get("q") ?? "";
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<readonly DisplayedResult[]>();
  const [searchSession, setSearchSession] = useState<SearchSession>();
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<Error>();
  const [assetType, setAssetType] = useState("");
  const [label, setLabel] = useState("");
  const [sort, setSort] = useState<"relevance" | "title">("relevance");
  const [selected, setSelected] = useState<ConsoleAsset>();
  const [selectedEvidence, setSelectedEvidence] = useState<DisplayedResult>();
  const [revision, setRevision] = useState<RevisionDetail>();
  const [detailError, setDetailError] = useState<Error>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [outcomeState, setOutcomeState] = useState<"harmed" | "helped" | "neutral" | "saving" | "saved">();
  const [copied, setCopied] = useState(false);
  const searchRequestId = useRef(0);
  const detailRequestId = useRef(0);
  const space = params.get("space") ?? undefined;

  const draftCriteria = useMemo(
    () => buildSearchCriteria(query, assetType, label, space),
    [assetType, label, query, space],
  );
  const draftCriteriaKey = searchCriteriaKey(draftCriteria);
  const sessionMatchesDraft = searchSession?.key === draftCriteriaKey;

  const clearDetail = () => {
    detailRequestId.current += 1;
    setSelected(undefined);
    setSelectedEvidence(undefined);
    setRevision(undefined);
    setDetailError(undefined);
    setDetailLoading(false);
    setOutcomeState(undefined);
  };

  const clearSearch = () => {
    searchRequestId.current += 1;
    setQuery("");
    setResults(undefined);
    setSearchSession(undefined);
    setSearching(false);
    setSearchError(undefined);
    clearDetail();
    const next = new URLSearchParams(params);
    next.delete("q");
    setParams(next, { replace: true });
  };

  const executeSearch = async (
    criteria: KnowledgeSearchCriteria,
    cursor?: string,
  ) => {
    if (criteria.query.length === 0) {
      clearSearch();
      return;
    }
    const append = cursor !== undefined;
    const requestId = searchRequestId.current + 1;
    searchRequestId.current = requestId;
    setSearching(true);
    setSearchError(undefined);
    if (!append) {
      setSearchSession(undefined);
      setSelectedEvidence(undefined);
      setOutcomeState(undefined);
    }
    try {
      const response = await searchKnowledge({
        ...(criteria.assetTypes.length === 0 ? {} : { assetTypes: criteria.assetTypes }),
        ...(cursor === undefined ? {} : { cursor }),
        ...(criteria.labels.length === 0 ? {} : { labels: criteria.labels }),
        query: criteria.query,
        spaceId: criteria.spaceId,
      });
      if (requestId !== searchRequestId.current) return;
      const page = response.results.map((item) => ({
        indexedThrough: response.indexedThrough,
        item,
        policyEpoch: response.policyEpoch,
        projectionGeneration: response.projectionGeneration,
        queryReceiptId: response.queryReceiptId,
        snapshot: response.snapshot,
      }));
      setResults((current) => append ? [...(current ?? []), ...page] : page);
      setSearchSession({
        criteria,
        indexedThrough: response.indexedThrough,
        key: searchCriteriaKey(criteria),
        ...(response.nextCursor === undefined ? {} : { nextCursor: response.nextCursor }),
        policyEpoch: response.policyEpoch,
        projectionGeneration: response.projectionGeneration,
        snapshot: response.snapshot,
      });
      const next = new URLSearchParams();
      next.set("q", criteria.query);
      if (criteria.spaceId !== undefined) next.set("space", criteria.spaceId);
      setParams(next, { replace: true });
    } catch (caught) {
      if (requestId === searchRequestId.current) {
        setSearchError(caught instanceof Error ? caught : new Error("搜索失败"));
      }
    } finally {
      if (requestId === searchRequestId.current) setSearching(false);
    }
  };

  const runSearch = async (value = query) => {
    await executeSearch(buildSearchCriteria(value, assetType, label, space));
  };

  const loadMore = async () => {
    if (
      searchSession?.nextCursor === undefined ||
      searchSession.key !== draftCriteriaKey
    ) return;
    await executeSearch(searchSession.criteria, searchSession.nextCursor);
  };

  useEffect(() => {
    if (initialQuery.length > 0) void runSearch(initialQuery);
    // URL state is consumed only on initial mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        searchInput.current?.focus();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  useEffect(() => {
    if (selected === undefined || window.innerWidth > 1080) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const previousOverflow = document.body.style.overflow;
    const dismissDetail = (event: KeyboardEvent) => {
      if (event.key === "Escape") clearDetail();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", dismissDetail);
    detailPanel.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", dismissDetail);
      previousFocus?.focus();
    };
  }, [selected]);

  const visibleAssets = useMemo(
    () => (assets.data ?? []).filter((asset) =>
      ["published", "deprecated"].includes(asset.status) &&
      (space === undefined || asset.spaceId === space) &&
      (assetType === "" || asset.assetType === assetType) &&
      (label.trim() === "" || asset.labels.includes(label.trim()))),
    [assetType, assets.data, label, space],
  );
  const displayedResults = useMemo(() => {
    if (results === undefined || sort === "relevance") return results;
    return [...results].sort((left, right) => left.item.title.localeCompare(right.item.title, "zh-CN"));
  }, [results, sort]);

  const loadRevision = async (asset: ConsoleAsset) => {
    const requestId = detailRequestId.current + 1;
    detailRequestId.current = requestId;
    setRevision(undefined);
    setDetailError(undefined);
    if (["revoked", "erased"].includes(asset.status)) {
      setDetailLoading(false);
      setDetailError(new Error(`该版本已${asset.status === "revoked" ? "撤销" : "擦除"}，正文不可读取。`));
      return;
    }
    setDetailLoading(true);
    try {
      const detail = await getRevisionDetail(asset.spaceId, asset.revisionId);
      if (requestId === detailRequestId.current) setRevision(detail);
    } catch (caught) {
      if (requestId === detailRequestId.current) {
        setDetailError(caught instanceof Error ? caught : new Error("无法读取版本正文"));
      }
    } finally {
      if (requestId === detailRequestId.current) setDetailLoading(false);
    }
  };

  const openAsset = (asset: ConsoleAsset, evidence?: DisplayedResult) => {
    setSelected(asset);
    setSelectedEvidence(evidence);
    setOutcomeState(undefined);
    void loadRevision(asset);
  };

  const openQueryResult = (evidence: DisplayedResult) => {
    const item = evidence.item;
    const asset = (assets.data ?? []).find((candidate) =>
      candidate.spaceId === item.spaceId && candidate.revisionId === item.revisionId,
    ) ?? assetFromQueryResult(evidence);
    openAsset(asset, evidence);
  };

  const recordOutcome = async (outcome: "harmed" | "helped" | "neutral") => {
    if (selectedEvidence === undefined) return;
    setOutcomeState("saving");
    try {
      await recordKnowledgeOutcome({
        item: selectedEvidence.item,
        outcome,
        queryReceiptId: selectedEvidence.queryReceiptId,
      });
      setOutcomeState("saved");
    } catch (error) {
      setOutcomeState(undefined);
      setSearchError(error instanceof Error ? error : new Error("反馈记录失败"));
    }
  };

  const copyCitation = async () => {
    const item = selectedEvidence?.item;
    if (item === undefined) return;
    await navigator.clipboard.writeText(JSON.stringify({
      citations: item.citations,
      obligations: item.obligations,
      policyEpoch: selectedEvidence?.policyEpoch,
      qualityAttestationRefs: item.qualityAttestationRefs,
      qualityDecision: item.qualityDecision,
      queryReceiptId: selectedEvidence?.queryReceiptId,
      revisionId: item.revisionId,
      spaceId: item.spaceId,
    }, null, 2));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  if (assets.loading && initialQuery.length === 0 && results === undefined) {
    return <LoadingState />;
  }
  if (assets.error !== undefined && initialQuery.length === 0 && results === undefined) {
    return <ErrorState error={assets.error} retry={assets.refresh} />;
  }

  const count = results === undefined ? visibleAssets.length : displayedResults?.length ?? 0;
  const hasNarrowingFilters = assetType !== "" || label.trim() !== "" || space !== undefined;
  const broadenSearch = async () => {
    const criteria = buildSearchCriteria(query, "", "", undefined);
    setAssetType("");
    setLabel("");
    await executeSearch(criteria);
  };
  const browseKnowledge = () => {
    searchRequestId.current += 1;
    setAssetType("");
    setLabel("");
    setQuery("");
    setResults(undefined);
    setSearchSession(undefined);
    setSearchError(undefined);
    setSearching(false);
    clearDetail();
    setParams(new URLSearchParams(), { replace: true });
  };
  return (
    <>
      <PageHeader eyebrow="Knowledge Explorer" title="查找可信、可引用的知识" subtitle="检索返回 Passage 级引用、真实相关性、质量证明和使用义务；证据不足时返回空结果。" />

      <Card className="search-panel">
        <form className="knowledge-search" onSubmit={(event) => { event.preventDefault(); void runSearch(); }}>
          <Search size={21} />
          <input ref={searchInput} autoFocus aria-label="搜索知识" onChange={(event) => setQuery(event.target.value)} placeholder="例如：如何安全地让 Agent 贡献新知识？" value={query} />
          {query.length > 0 ? <button aria-label="清空搜索" className="clear-search" onClick={clearSearch} type="button"><X size={17} /></button> : null}
          <kbd>⌘ K</kbd>
          <Button disabled={searching} type="submit">{searching ? "检索中…" : "搜索知识"}</Button>
        </form>
        <div className="filter-bar real-filters">
          <label><span>知识类型</span><select aria-label="按知识类型筛选" onChange={(event) => setAssetType(event.target.value)} value={assetType}><option value="">全部类型</option><option value="procedure">Procedure</option><option value="source_document">Source Document</option></select></label>
          <label><span>标签</span><input aria-label="按标签筛选" onChange={(event) => setLabel(event.target.value)} placeholder="精确标签" value={label} /></label>
          <span className="filter-static"><BookOpenText size={14} /> Published / Deprecated</span>
          <span className="filter-static"><ShieldCheck size={14} /> customer-support</span>
          {space === undefined ? null : <button className="active-filter" onClick={() => { const next = new URLSearchParams(params); next.delete("space"); setParams(next, { replace: true }); if (results !== undefined && query.trim().length > 0) void executeSearch(buildSearchCriteria(query, assetType, label, undefined)); }} title="清除 Space 筛选">{space.split("/").at(-1)} <X size={13} /></button>}
          {results === undefined || query.trim() === "" ? null : <Button onClick={() => void runSearch()} variant="ghost">应用筛选</Button>}
        </div>
      </Card>

      {searchError === undefined ? null : <ErrorState error={searchError} retry={() => void runSearch()} />}

      <div className={`knowledge-layout ${selected === undefined ? "knowledge-layout-unselected" : ""}`}>
        <section className="knowledge-results" aria-label="知识结果">
          <div className="result-summary"><div><strong>{count}</strong><span>{results === undefined ? " 个知识版本" : ` 条与“${searchSession?.criteria.query ?? params.get("q") ?? ""}”相关的结果`}</span></div><label>排序<select aria-label="结果排序" onChange={(event) => setSort(event.target.value as typeof sort)} value={sort}><option value="relevance">相关性</option><option value="title">标题</option></select></label></div>
          {searchSession === undefined ? null : <SearchEvidenceStrip session={searchSession} />}
          {(results === undefined ? visibleAssets : displayedResults ?? []).length === 0 ? (
            <Card><EmptyState
              icon={<CircleSlash />}
              title={results === undefined ? "当前还没有可浏览的知识" : "当前授权范围内没有足够证据"}
              description={results === undefined
                ? "Published Channel 为空；贡献会先进入 Candidate，不会绕过审核直接可见。"
                : "当前可访问 Space、customer-support 用途和 Published/Deprecated 版本中没有可引用结果；这不代表系统确认答案不存在。"}
              action={<div className="empty-actions">
                {results === undefined ? null : <Button onClick={browseKnowledge} variant="secondary">浏览可访问知识</Button>}
                {results !== undefined && hasNarrowingFilters ? <Button onClick={() => void broadenSearch()} variant="secondary">清除筛选并重搜</Button> : null}
                <Button onClick={() => searchInput.current?.focus()} variant="ghost">修改关键词</Button>
                <Link className="button button-primary" to="/contribute">贡献候选知识</Link>
              </div>}
            /></Card>
          ) : results === undefined ? (
            visibleAssets.map((asset) => <AssetRow asset={asset} key={`${asset.spaceId}-${asset.revisionId}`} onOpen={() => openAsset(asset)} selected={selected?.spaceId === asset.spaceId && selected.revisionId === asset.revisionId} />)
          ) : (
            (displayedResults ?? []).map((entry) => <QueryRow item={entry.item} key={`${entry.item.spaceId}-${entry.item.revisionId}`} onOpen={() => openQueryResult(entry)} selected={selected?.spaceId === entry.item.spaceId && selected.revisionId === entry.item.revisionId} />)
          )}
          {searchSession?.nextCursor === undefined ? null : sessionMatchesDraft ? <Button className="load-more" disabled={searching} onClick={() => void loadMore()} variant="secondary">加载更多结果</Button> : <p className="pagination-stale" role="status">搜索词或筛选条件已更改，请先应用后再继续分页，旧 Cursor 不会用于新条件。</p>}
        </section>

        {selected === undefined ? null : <button aria-label="关闭知识详情" className="detail-backdrop" onClick={clearDetail} />}
        <aside aria-label="知识详情" className={`knowledge-detail ${selected === undefined ? "detail-placeholder" : ""}`} ref={detailPanel} tabIndex={selected === undefined ? undefined : -1}>
          {selected === undefined ? (
            <div><span className="detail-orbit"><BookOpenText size={25} /></span><h3>选择一个知识版本</h3><p>查看正文、来源、质量证明、义务和 Passage 引用。</p></div>
          ) : (
            <>
              <div className="detail-head"><div><span className="asset-type">{selected.assetType}</span><StatusBadge status={selected.status} /></div><button className="icon-button" aria-label="关闭详情" onClick={clearDetail}><X size={18} /></button></div>
              <h2>{selected.title}</h2><p>{selected.summary ?? "此知识版本没有摘要。"}</p>
              <dl className="detail-metadata"><div><dt>Record</dt><dd title={selected.recordId}>{shortId(selected.recordId, 30)}</dd></div><div><dt>Revision</dt><dd title={selected.revisionId}>{shortId(selected.revisionId, 30)}</dd></div><div><dt>Space</dt><dd title={selected.spaceId}>{selected.spaceId.split("/").at(-1)}</dd></div><div><dt>质量决策</dt><dd><ShieldCheck size={15} /> {selected.qualityDecision}</dd></div></dl>
              {selectedEvidence === undefined ? null : <QueryExplanation evidence={selectedEvidence} />}
              <section className="detail-section"><h3><BookOpenText size={16} /> 正文</h3>{detailLoading ? <LoadingState label="读取已校验 Payload" /> : detailError !== undefined ? <div className="detail-read-error" role="alert"><AlertTriangle size={18} /><div><strong>正文读取失败</strong><p>{detailError.message}</p></div>{["revoked", "erased"].includes(selected.status) ? null : <Button onClick={() => void loadRevision(selected)} variant="secondary"><RefreshCw size={15} /> 重试</Button>}</div> : revision === undefined ? <p className="muted-copy">正文尚未载入。</p> : <pre className="content-preview detail-content">{revision.content}</pre>}</section>
              <KnowledgeBoundary revision={revision} fallbackProvenance={selectedEvidence?.item.provenance} />
              <section className="detail-section"><h3><Quote size={16} /> 引用与义务</h3>{selectedEvidence === undefined ? <p className="muted-copy">通过检索打开此版本后可复制 Passage 引用并记录任务结果。</p> : <><div className="citation-detail"><strong>{selectedEvidence.item.citations.length} 个 Passage 引用</strong><span>{selectedEvidence.item.obligations.map((item) => String(item)).join(" · ") || "无额外义务"}</span><Button onClick={() => void copyCitation()} variant="secondary">{copied ? <Check size={15} /> : <Copy size={15} />} {copied ? "已复制" : "复制引用"}</Button></div>{selectedEvidence.item.citations.map((citation) => <blockquote key={citation.citationId}>{citation.quote ?? "该引用没有内联摘录。"}<small>{JSON.stringify(citation.locator)}</small></blockquote>)}</>}</section>
              <section className="detail-section"><h3><ShieldCheck size={16} /> 质量依据</h3>{selected.qualityReasons.map((reason) => <p className="reason-box" key={reason}>{reason}</p>)}<small className="attestation-line">Attestation：{selected.qualityAttestationRefs.map((ref) => shortId(ref, 24)).join(" · ")}</small></section>
              <section className="detail-section"><h3><GitBranch size={16} /> 后续动作</h3><div className="detail-actions"><Link className="button button-secondary" to={`/contribute?base=${encodeURIComponent(selected.revisionId)}&space=${encodeURIComponent(selected.spaceId)}`}>发起修订</Link>{selectedEvidence === undefined ? null : outcomeState === "saved" ? <span className="feedback-saved"><Check size={15} /> 任务结果已形成治理证据</span> : <><Button disabled={outcomeState === "saving"} onClick={() => void recordOutcome("helped")} variant="ghost"><ThumbsUp size={15} /> 有帮助</Button><Button disabled={outcomeState === "saving"} onClick={() => void recordOutcome("neutral")} variant="ghost">一般</Button><Button disabled={outcomeState === "saving"} onClick={() => void recordOutcome("harmed")} variant="danger"><ThumbsDown size={15} /> 有伤害</Button></>}</div></section>
            </>
          )}
        </aside>
      </div>
    </>
  );
}

export function buildSearchCriteria(
  value: string,
  assetType: string,
  label: string,
  spaceId?: string,
): KnowledgeSearchCriteria {
  const normalizedAssetType = assetType.trim();
  const normalizedLabel = label.trim();
  return {
    assetTypes: normalizedAssetType.length === 0 ? [] : [normalizedAssetType],
    labels: normalizedLabel.length === 0 ? [] : [normalizedLabel],
    query: value.trim(),
    ...(spaceId === undefined ? {} : { spaceId }),
  };
}

export function searchCriteriaKey(criteria: KnowledgeSearchCriteria): string {
  return JSON.stringify([
    criteria.query,
    criteria.spaceId ?? null,
    [...criteria.assetTypes],
    [...criteria.labels],
  ]);
}

function AssetRow({ asset, onOpen, selected }: { readonly asset: ConsoleAsset; readonly onOpen: () => void; readonly selected: boolean }) {
  return <button aria-pressed={selected} className={`knowledge-row ${selected ? "knowledge-row-selected" : ""}`} onClick={onOpen}><span className="knowledge-icon"><BookOpenText size={20} /></span><span className="knowledge-main"><span><strong>{asset.title}</strong><StatusBadge status={asset.status} /></span><small>{asset.summary ?? "暂无摘要"}</small><span className="knowledge-tags">{asset.labels.map((item) => <i key={item}>{item}</i>)}</span></span><span className="knowledge-meta"><b>{asset.assetType}</b><small>{asset.spaceId.split("/").at(-1)}</small></span><ChevronRight size={18} /></button>;
}

function QueryRow({ item, onOpen, selected }: { readonly item: QueryResultItem; readonly onOpen: () => void; readonly selected: boolean }) {
  const sourceCount = item.provenance?.primarySources?.length ?? 0;
  const status = item.statuses?.includes("deprecated") === true ? "deprecated" : "published";
  return <button aria-pressed={selected} className={`knowledge-row query-row ${selected ? "knowledge-row-selected" : ""}`} onClick={onOpen}><span className="knowledge-icon knowledge-icon-ai"><Sparkles size={20} /></span><span className="knowledge-main"><span><strong>{item.title}</strong><StatusBadge status={status} /><span className="score-pill">本次排序分 {(item.scores[0]?.value ?? 0).toFixed(2)}</span></span><small>{item.summary ?? item.citations[0]?.quote ?? "暂无摘要"}</small><span className="result-facts"><i>{item.assetType}</i><i>{item.spaceId.split("/").at(-1)}</i><i>{qualityDecisionLabel(item.qualityDecision)}</i>{sourceCount > 0 ? <i>{sourceCount} 个来源</i> : null}</span><span className="citation-line"><Quote size={13} /> {item.citations.length} 个 Passage 引用 · {item.obligations.length} 项义务</span></span><ChevronRight size={18} /></button>;
}

function SearchEvidenceStrip({ session }: { readonly session: SearchSession }) {
  return <div className="search-evidence-strip" role="status">
    <span><ShieldCheck size={14} /><b>授权后检索</b></span>
    <span>Space：{session.criteria.spaceId?.split("/").at(-1) ?? "Principal 允许范围"}</span>
    <span>用途：customer-support</span>
    <span>策略：{shortId(session.policyEpoch, 24)}</span>
    <span>投影：{shortId(session.projectionGeneration, 28)}</span>
    <span>索引截至：<time dateTime={session.indexedThrough}>{formatRelativeTime(session.indexedThrough)}</time></span>
  </div>;
}

function QueryExplanation({ evidence }: { readonly evidence: DisplayedResult }) {
  const item = evidence.item;
  const score = item.scores[0];
  return <section className="detail-section trust-explanation">
    <h3><Sparkles size={16} /> 为什么返回这条知识</h3>
    <p>它在当前授权 Space 和 purpose 内通过治理门禁，并由 Passage 检索进入本次排序；排序分只表示本次查询相关性，不代表知识可信度。</p>
    <dl className="trust-grid">
      <div><dt>召回方法</dt><dd>{score?.method ?? "未声明"}</dd></div>
      <div><dt>本次排序分</dt><dd>{(score?.value ?? 0).toFixed(2)}</dd></div>
      <div><dt>质量结论</dt><dd>{qualityDecisionLabel(item.qualityDecision)}</dd></div>
      <div><dt>稳定引用</dt><dd>{item.citations.length} 个 Passage</dd></div>
      <div><dt>策略水位</dt><dd>{shortId(evidence.policyEpoch, 24)}</dd></div>
      <div><dt>曝光回执</dt><dd title={evidence.queryReceiptId}>{shortId(evidence.queryReceiptId, 24)}</dd></div>
    </dl>
  </section>;
}

function KnowledgeBoundary({
  fallbackProvenance,
  revision,
}: {
  readonly fallbackProvenance?: QueryResultItem["provenance"];
  readonly revision?: RevisionDetail;
}) {
  const manifest = revision?.resource.manifest;
  const provenance = manifest?.provenance ?? fallbackProvenance;
  const sources = provenance?.primarySources ?? [];
  const scope = manifest?.scope;
  const policy = manifest?.policy;
  if (revision === undefined && provenance === undefined) return null;
  return <section className="detail-section knowledge-boundary">
    <h3><GitBranch size={16} /> 来源与适用边界</h3>
    <div className="boundary-grid">
      <div>
        <strong>主要来源</strong>
        {sources.length === 0 ? <p className="muted-copy">未声明主要来源。</p> : <ul className="source-list">{sources.map((source) => <li key={source}>{safeHttpUrl(source) ? <a href={source} rel="noreferrer" target="_blank">{source}</a> : <span>{source}</span>}</li>)}</ul>}
        {provenance?.generatedBy?.actor === undefined ? null : <p className="boundary-note">生成主体：{provenance.generatedBy.actor}</p>}
      </div>
      <dl className="scope-grid">
        <div><dt>语言 / 地域</dt><dd>{[scope?.locale, scope?.jurisdiction].filter(Boolean).join(" · ") || "未限定"}</dd></div>
        <div><dt>复审时间</dt><dd>{formatDate(scope?.reviewAfter)}</dd></div>
        <div><dt>有效期</dt><dd>{formatValidity(scope?.validFrom, scope?.validUntil)}</dd></div>
        <div><dt>允许用途</dt><dd>{policy?.allowedPurposes?.join(" · ") || "由本地策略决定"}</dd></div>
        <div><dt>分类 / 导出</dt><dd>{[policy?.classification, policy?.export].filter(Boolean).join(" · ") || "未声明"}</dd></div>
      </dl>
    </div>
    {scope?.assumptions === undefined || scope.assumptions.length === 0 ? null : <div className="assumption-list"><strong>适用假设</strong><ul>{scope.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul></div>}
  </section>;
}

function assetFromQueryResult(evidence: DisplayedResult): ConsoleAsset {
  const item = evidence.item;
  return {
    assetType: item.assetType,
    indexedAt: evidence.indexedThrough,
    labels: [],
    obligations: item.obligations,
    profile: item.profile ?? { digest: "", uri: "" },
    qualityAttestationRefs: item.qualityAttestationRefs,
    qualityDecision: item.qualityDecision === "suitable_with_warning"
      ? "suitable_with_warning"
      : "suitable",
    qualityReasons: item.qualityReasons,
    recordId: item.recordId,
    revisionId: item.revisionId,
    spaceId: item.spaceId,
    status: item.statuses?.includes("deprecated") === true ? "deprecated" : "published",
    ...(item.summary === undefined ? {} : { summary: item.summary }),
    title: item.title,
  };
}

function qualityDecisionLabel(value: string): string {
  return value === "suitable_with_warning" ? "质量通过（有警告）" : "质量通过";
}

function safeHttpUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function formatDate(value: string | undefined): string {
  if (value === undefined) return "未设置";
  const parsed = Date.parse(value);
  return Number.isNaN(parsed)
    ? value
    : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(new Date(parsed));
}

function formatValidity(from: string | undefined, until: string | undefined): string {
  if (from === undefined && until === undefined) return "未限定";
  return `${formatDate(from)} — ${formatDate(until)}`;
}
