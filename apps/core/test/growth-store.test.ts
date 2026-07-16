import { describe, expect, it } from "vitest";
import type { Principal } from "../src/platform/auth.js";
import { InMemoryGrowthStore } from "../src/modules/growth/store.js";
import type { FeedbackState, UsageState } from "../src/modules/growth/types.js";
import { hasSpaceAccess } from "../src/modules/growth/validation.js";

describe("growth evidence aggregation", () => {
  it("uses each citation outcome for its revision and only queues harmed revisions", async () => {
    const growth = new InMemoryGrowthStore();
    const usage: UsageState = {
      clientUsageId: "client-usage",
      idempotencyKey: "usage-key",
      receipt: {},
      request: {
        citations: [{ revisionId: "revision-a" }, { revisionId: "revision-b" }],
        taskCategory: "support/refund",
      },
      requestDigest: "usage-digest",
      subjectDigest: "subject-digest",
      usageId: "usage-id",
    };
    const feedback: FeedbackState = {
      feedbackId: "feedback-id",
      idempotencyKey: "feedback-key",
      receipt: {
        correlationClass: "same_organization",
        eligibleForAggregation: true,
      },
      request: {
        citations: [
          { outcome: "harmed", revisionId: "revision-a" },
          { revisionId: "revision-b" },
        ],
        outcome: "helped",
        taskCategory: "support/refund",
      },
      requestDigest: "feedback-digest",
      subjectDigest: "subject-digest",
      usageId: usage.usageId,
    };

    await growth.createUsage(usage);
    await growth.createFeedback(feedback);
    const summary = await growth.evidenceSummary();

    expect(summary.revisions).toEqual([
      { feedback: 1, harmed: 1, helped: 0, revisionId: "revision-a", usage: 1 },
      { feedback: 1, harmed: 0, helped: 1, revisionId: "revision-b", usage: 1 },
    ]);
    expect(summary.harmed).toHaveLength(1);
    expect(summary.harmed[0]?.revisionIds).toEqual(["revision-a"]);
  });
});

describe("Space authorization", () => {
  const principal = (scopes: readonly string[]): Principal => ({
    scopes: new Set(scopes),
    subject: "test-subject",
    subjectDigest: "test-subject-digest",
    supportedObligations: [],
  });

  it("does not let an operation scope grant access to another Space", () => {
    const support = "https://knowledge.example/spaces/support";
    const finance = "https://knowledge.example/spaces/finance";
    const scoped = principal(["akep:contribute", `akep:space:${encodeURIComponent(support)}`]);

    expect(hasSpaceAccess(scoped, support)).toBe(true);
    expect(hasSpaceAccess(scoped, finance)).toBe(false);
    expect(hasSpaceAccess(principal(["akep:contribute"]), support)).toBe(false);
    expect(hasSpaceAccess(principal(["akep:space:*"]), finance)).toBe(true);
  });
});
