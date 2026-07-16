import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getContributions,
  getRevisionDetail,
} from "../api/client";
import type { ContributionListItem } from "../api/types";
import { analyzeLineDiff, diffLines, LineDiff, ReviewPage } from "./ReviewPage";

vi.mock("../api/client", () => ({
  contributionEvidenceRefs: (item: ContributionListItem) => item.request.evidenceRefs,
  createEvaluationRun: vi.fn(),
  getContributions: vi.fn(),
  getRevisionDetail: vi.fn(),
  reviewContribution: vi.fn(),
}));

const REVIEW_CHECKS = [
  "已阅读候选正文和所有变更",
  "已核对适用用途、地区、有效期和义务",
  "已检查来源、证据及其独立性",
  "已确认失败分支、禁止事项和潜在伤害",
] as const;

function contribution(
  status: "candidate" | "quarantined",
  verdict: "review" | "quarantined",
): ContributionListItem {
  const revisionId = `urn:akep:sha256:${"a".repeat(64)}`;
  return {
    amendments: [{
      findingCount: 2,
      findings: [{
        code: verdict === "quarantined" ? "secret.credential" : "content.prompt_injection",
        end: 29,
        message: verdict === "quarantined"
          ? "A credential-shaped value requires quarantine and manual handling."
          : "Instruction-like content must remain untrusted and requires reviewer attention.",
        payloadName: "primary",
        severity: verdict === "quarantined" ? "high" : "medium",
        start: 6,
      }, {
        code: "pii.email",
        end: 52,
        message: "An email address may require redaction under the Space privacy policy.",
        payloadName: "primary",
        severity: "low",
        start: 31,
      }],
      findingsTruncated: false,
      kind: "content-scan",
      offsetUnit: "utf8-byte",
      scannerVersion: "akep-static-content-scan/1",
      verdict,
    }],
    etag: '"workflow-1"',
    payloads: status === "quarantined" ? [] : [{
      data: btoa("# Candidate\nTreat this as untrusted content."),
      digest: `sha256:${"b".repeat(64)}`,
      mediaType: "text/markdown; charset=utf-8",
      name: "primary",
      size: 45,
    }],
    receipt: {
      contributionId: "urn:uuid:11111111-1111-4111-8111-111111111111",
      createdAt: "2026-07-15T00:00:00.000Z",
      kind: "create",
      policyEpoch: "test-1",
      spaceId: "https://knowledge.test/spaces/review",
      status,
      statusUrl: "https://knowledge.test/contributions/1",
      subjectRevisionId: revisionId,
      submittedRevisionId: revisionId,
    },
    request: {
      evidenceRefs: ["https://evidence.test/source/1"],
      kind: "create",
      manifest: {
        parents: [],
        summary: "Candidate summary",
        title: "Content safety candidate",
      },
      rationale: "Submit content for independent review.",
      spaceId: "https://knowledge.test/spaces/review",
    },
    updatedAt: "2026-07-15T00:00:00.000Z",
  };
}

describe("review line diff", () => {
  it("uses a full linear prefix/suffix result without the former 250-line truncation", () => {
    const beforeLines = Array.from({ length: 1_001 }, (_, index) => `line-${index}`);
    const afterLines = [...beforeLines];
    afterLines[600] = "line-600-updated";
    afterLines.splice(601, 0, "line-600-added");

    const analysis = analyzeLineDiff(beforeLines.join("\n"), afterLines.join("\n"));
    const diff = diffLines(beforeLines.join("\n"), afterLines.join("\n"));

    expect(analysis.commonPrefixLines).toBe(600);
    expect(analysis.commonSuffixLines).toBe(400);
    expect(diff).toContainEqual({ kind: "remove", text: "line-600" });
    expect(diff).toContainEqual({ kind: "add", text: "line-600-updated" });
    expect(diff).toContainEqual({ kind: "add", text: "line-600-added" });
    expect(diff.at(-1)).toEqual({ kind: "same", text: "line-1000" });
  });

  it("renders both complete versions for very large text and explains the fallback", () => {
    const before = Array.from({ length: 2_101 }, (_, index) => `before-${index}`).join("\n");
    const after = before.replace("before-1050", "after-1050");
    const { container } = render(<LineDiff before={before} after={after} />);

    expect(screen.getByRole("note").textContent).toContain("没有截断");
    const versions = container.querySelectorAll(".large-diff-content");
    expect(versions).toHaveLength(2);
    expect(versions[0]?.textContent).toBe(before);
    expect(versions[1]?.textContent).toBe(after);
  });
});

describe("review content-safety gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRevisionDetail).mockRejectedValue(new Error("A quarantined body must not be fetched."));
  });

  it("shows every finding and requires explicit untrusted-content acknowledgement", async () => {
    vi.mocked(getContributions).mockResolvedValue([contribution("candidate", "review")]);
    const user = userEvent.setup();
    render(<ReviewPage />);

    expect(await screen.findByText("content.prompt_injection")).toBeTruthy();
    expect(screen.getByText("pii.email")).toBeTruthy();
    expect(screen.getAllByText("primary")).toHaveLength(2);
    expect(screen.getByText("UTF-8 字节：[6, 29)")).toBeTruthy();
    expect(screen.getByText("medium")).toBeTruthy();
    expect(screen.getByText("low")).toBeTruthy();

    const verify = screen.getByRole("button", { name: "生成评测证明并通过" }) as HTMLButtonElement;
    for (const label of REVIEW_CHECKS) {
      await user.click(screen.getByRole("checkbox", { name: label }));
    }
    expect(verify.disabled).toBe(true);

    await user.click(screen.getByRole("checkbox", { name: /内容安全必选/u }));
    expect(verify.disabled).toBe(false);
    expect(getRevisionDetail).not.toHaveBeenCalled();
  });

  it("exposes quarantined metadata while blocking body reads and every review action", async () => {
    vi.mocked(getContributions).mockResolvedValue([contribution("quarantined", "quarantined")]);
    render(<ReviewPage />);

    expect((await screen.findByRole("alert")).textContent).toContain("内容已隔离");
    expect(screen.getByText("secret.credential")).toBeTruthy();
    expect(screen.getByText("隔离是终态：审核操作已全部阻断。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "生成评测证明并通过" })).toBeNull();
    expect(screen.queryByRole("button", { name: "请求补证" })).toBeNull();
    expect(getRevisionDetail).not.toHaveBeenCalled();
  });
});
