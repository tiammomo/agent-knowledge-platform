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
      manifest: { payloads: [] },
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
    ...(nextCursor === undefined ? {} : { nextCursor }),
    policyEpoch: "test-1",
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
});
