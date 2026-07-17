import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAssets,
  getRevisionDetail,
  searchKnowledge,
} from "../api/client";
import type {
  ConsoleAsset,
  QueryResponse,
  QueryResultItem,
  RevisionDetail,
} from "../api/types";
import { KnowledgePage } from "./KnowledgePage";

vi.mock("../api/client", () => ({
  getAssets: vi.fn(),
  getRevisionDetail: vi.fn(),
  recordKnowledgeOutcome: vi.fn(),
  searchKnowledge: vi.fn(),
}));

const SPACE = "https://knowledge.test/spaces/support";

function asset(seed: string, title: string): ConsoleAsset {
  return {
    assetType: "procedure",
    indexedAt: "2026-07-15T00:00:00.000Z",
    labels: ["support"],
    obligations: ["cite"],
    profile: {
      digest: `sha256:${seed.repeat(64)}`,
      uri: "https://knowledge.test/profiles/procedure/1",
    },
    qualityAttestationRefs: [`https://knowledge.test/attestations/${seed}`],
    qualityDecision: "suitable",
    qualityReasons: ["Evaluation passed."],
    recordId: `https://knowledge.test/records/${seed}`,
    revisionId: `urn:akep:sha256:${seed.repeat(64)}`,
    spaceId: SPACE,
    status: "published",
    summary: `${title} summary`,
    title,
  };
}

function revision(assetValue: ConsoleAsset, content: string): RevisionDetail {
  return {
    content,
    resource: {
      manifest: {
        payloads: [],
        policy: {
          allowedPurposes: ["customer-support"],
          classification: "internal",
          export: "deny",
        },
        provenance: {
          generatedBy: { actor: "https://identity.test/teams/support" },
          primarySources: ["https://docs.test/refund"],
        },
        scope: {
          assumptions: ["仅适用于直营网店"],
          jurisdiction: "CN",
          locale: "zh-CN",
          reviewAfter: "2026-10-01T00:00:00.000Z",
        },
      },
      revisionId: assetValue.revisionId,
    },
  };
}

function result(assetValue: ConsoleAsset): QueryResultItem {
  return {
    assetType: assetValue.assetType,
    citations: [{
      citationId: `https://knowledge.test/citations/${assetValue.title}`,
      locator: { end: 8, start: 0, type: "text-offset" },
      payloadDigest: `sha256:${"c".repeat(64)}`,
      quote: assetValue.summary,
    }],
    obligations: assetValue.obligations,
    profile: assetValue.profile,
    provenance: {
      primarySources: ["https://docs.test/refund"],
    },
    qualityAttestationRefs: assetValue.qualityAttestationRefs,
    qualityDecision: assetValue.qualityDecision,
    qualityReasons: assetValue.qualityReasons,
    recordId: assetValue.recordId,
    revisionId: assetValue.revisionId,
    scores: [{ method: "lexical-passage", value: 0.8 }],
    spaceId: assetValue.spaceId,
    summary: assetValue.summary,
    title: assetValue.title,
  };
}

function response(
  assetValue: ConsoleAsset,
  receipt: string,
  nextCursor?: string,
): QueryResponse {
  return {
    indexedThrough: "2026-07-18T00:00:00.000Z",
    ...(nextCursor === undefined ? {} : { nextCursor }),
    policyEpoch: "test-1",
    projectionGeneration: "akep-lexical-v2/postgres",
    queryReceiptId: `https://knowledge.test/exposures/${receipt}`,
    results: [result(assetValue)],
    snapshot: "snapshot-1",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function LocationProbe() {
  return <output data-testid="location-search">{useLocation().search}</output>;
}

function renderPage(entry = "/knowledge") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <KnowledgePage />
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe("knowledge explorer request identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ignores a late detail response after another asset was selected", async () => {
    const firstAsset = asset("a", "Asset A");
    const secondAsset = asset("b", "Asset B");
    const first = deferred<RevisionDetail>();
    const second = deferred<RevisionDetail>();
    vi.mocked(getAssets).mockResolvedValue([firstAsset, secondAsset]);
    vi.mocked(getRevisionDetail).mockImplementation((_spaceId, revisionId) =>
      revisionId === firstAsset.revisionId ? first.promise : second.promise,
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: /Asset A/u }));
    await user.click(screen.getByRole("button", { name: /Asset B/u }));
    await act(async () => second.resolve(revision(secondAsset, "Second asset content")));
    expect(await screen.findByText("Second asset content")).toBeTruthy();

    await act(async () => first.resolve(revision(firstAsset, "Late first asset content")));
    expect(screen.queryByText("Late first asset content")).toBeNull();
    expect(screen.getByText("Second asset content")).toBeTruthy();
  });

  it("shows the actual detail failure and offers a retry", async () => {
    const selected = asset("a", "Readable asset");
    vi.mocked(getAssets).mockResolvedValue([selected]);
    vi.mocked(getRevisionDetail).mockRejectedValue(new Error("Policy epoch changed; restart the read."));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: /Readable asset/u }));
    expect(await screen.findByText("Policy epoch changed; restart the read.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /重试/u })).toBeTruthy();
  });

  it("binds pagination to its original criteria and clears state together with the URL", async () => {
    const selected = asset("a", "Refund procedure");
    vi.mocked(getAssets).mockResolvedValue([selected]);
    vi.mocked(searchKnowledge)
      .mockResolvedValueOnce(response(selected, "first", "cursor-1"))
      .mockResolvedValueOnce(response(selected, "second"));
    const user = userEvent.setup();
    renderPage(`/knowledge?q=refund&space=${encodeURIComponent(SPACE)}`);

    expect(await screen.findByText(/条与“refund”相关的结果/u)).toBeTruthy();
    const input = screen.getByRole("textbox", { name: "搜索知识" });
    await user.clear(input);
    await user.type(input, "changed");
    expect(screen.getByText(/旧 Cursor 不会用于新条件/u)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "加载更多结果" })).toBeNull();

    await user.clear(input);
    await user.type(input, "refund");
    await user.click(screen.getByRole("button", { name: "加载更多结果" }));
    await waitFor(() => expect(searchKnowledge).toHaveBeenCalledTimes(2));
    expect(vi.mocked(searchKnowledge).mock.calls[1]?.[0]).toMatchObject({
      cursor: "cursor-1",
      query: "refund",
      spaceId: SPACE,
    });

    await user.click(screen.getByRole("button", { name: "清空搜索" }));
    expect((input as HTMLInputElement).value).toBe("");
    expect(screen.queryByText(/旧 Cursor 不会用于新条件/u)).toBeNull();
    expect(screen.queryByRole("button", { name: "加载更多结果" })).toBeNull();
    const location = new URLSearchParams(
      screen.getByTestId("location-search").textContent ?? "",
    );
    expect(location.get("q")).toBeNull();
    expect(location.get("space")).toBe(SPACE);
  });

  it("opens a Query result even when the Console projection does not contain it", async () => {
    const selected = asset("a", "Refund procedure");
    vi.mocked(getAssets).mockResolvedValue([]);
    vi.mocked(searchKnowledge).mockResolvedValue(response(selected, "query-only"));
    vi.mocked(getRevisionDetail).mockResolvedValue(revision(selected, "Governed refund content"));
    const user = userEvent.setup();
    renderPage("/knowledge?q=refund");

    await user.click(await screen.findByRole("button", { name: /Refund procedure/u }));

    expect(getRevisionDetail).toHaveBeenCalledWith(SPACE, selected.revisionId);
    expect(await screen.findByText("Governed refund content")).toBeTruthy();
    expect(screen.queryByText(/投影尚未就绪/u)).toBeNull();
  });

  it("explains ranking, policy, source and applicability without calling the score trust", async () => {
    const selected = asset("a", "Refund procedure");
    vi.mocked(getAssets).mockResolvedValue([selected]);
    vi.mocked(searchKnowledge).mockResolvedValue(response(selected, "explained"));
    vi.mocked(getRevisionDetail).mockResolvedValue(revision(selected, "Refund content"));
    const user = userEvent.setup();
    renderPage("/knowledge?q=refund");

    expect(await screen.findByText(/索引截至/u)).toBeTruthy();
    expect(screen.getByText(/投影：akep-lexical/u)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Refund procedure/u }));

    expect(await screen.findByText("为什么返回这条知识")).toBeTruthy();
    expect(screen.getAllByText("https://docs.test/refund").length).toBeGreaterThan(0);
    expect(screen.getByText("仅适用于直营网店")).toBeTruthy();
    expect(screen.getAllByText("customer-support").length).toBeGreaterThan(0);
    expect(screen.getByText(/本次查询相关性，不代表知识可信度/u)).toBeTruthy();
    expect(screen.queryByText(/可信度 0\.80/u)).toBeNull();
  });

  it("shows only current browsable states outside Query results", async () => {
    const published = asset("a", "Published asset");
    const deprecated = { ...asset("b", "Deprecated asset"), status: "deprecated" as const };
    const superseded = { ...asset("c", "Superseded asset"), status: "superseded" as const };
    const revoked = { ...asset("d", "Revoked asset"), status: "revoked" as const };
    const erased = { ...asset("e", "Erased asset"), status: "erased" as const };
    vi.mocked(getAssets).mockResolvedValue([
      published,
      deprecated,
      superseded,
      revoked,
      erased,
    ]);
    renderPage();

    expect(await screen.findByText("Published asset")).toBeTruthy();
    expect(screen.getByText("Deprecated asset")).toBeTruthy();
    expect(screen.queryByText("Superseded asset")).toBeNull();
    expect(screen.queryByText("Revoked asset")).toBeNull();
    expect(screen.queryByText("Erased asset")).toBeNull();
  });

  it("explains zero results and can broaden a Space-filtered search", async () => {
    const empty: QueryResponse = {
      indexedThrough: "2026-07-18T00:00:00.000Z",
      policyEpoch: "test-1",
      projectionGeneration: "akep-lexical-v2/postgres",
      queryReceiptId: "https://knowledge.test/exposures/empty",
      results: [],
      snapshot: "snapshot-empty",
    };
    const selected = asset("a", "Broader result");
    vi.mocked(getAssets).mockResolvedValue([selected]);
    vi.mocked(searchKnowledge)
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(response(selected, "broadened"));
    const user = userEvent.setup();
    renderPage(`/knowledge?q=refund&space=${encodeURIComponent(SPACE)}`);

    expect(await screen.findByText("当前授权范围内没有足够证据")).toBeTruthy();
    expect(screen.getByText(/不代表系统确认答案不存在/u)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "清除筛选并重搜" }));

    await waitFor(() => expect(searchKnowledge).toHaveBeenCalledTimes(2));
    expect(vi.mocked(searchKnowledge).mock.calls[1]?.[0]).toEqual({ query: "refund" });
    expect(await screen.findByText("Broader result")).toBeTruthy();
  });
});
