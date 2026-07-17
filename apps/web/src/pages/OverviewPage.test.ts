import { describe, expect, it } from "vitest";
import type { Overview } from "../api/types";
import { buildResponsibilityActions } from "./OverviewPage";

function overview(input: Partial<Overview["totals"]> = {}): Overview {
  return {
    generatedAt: "2026-07-18T00:00:00.000Z",
    node: {
      id: "https://knowledge.test",
      name: "Test node",
      policyEpoch: "test-1",
      trustDomain: "knowledge.test",
    },
    recentActivity: [],
    spaces: [],
    totals: {
      feedback: 0,
      knowledge: 0,
      pendingReview: 0,
      published: 0,
      revoked: 0,
      usage: 0,
      ...input,
    },
    workflow: {
      accepted: 0,
      candidate: 0,
      needs_evidence: 0,
      quarantined: 0,
      rejected: 0,
      validating: 0,
      verified: 0,
      withdrawn: 0,
    },
  };
}

describe("overview responsibility actions", () => {
  it("prioritizes review, evidence and publication queues", () => {
    const state = overview({ knowledge: 4, published: 3 });
    const workflow = state.workflow as Record<keyof typeof state.workflow, number>;
    workflow.candidate = 2;
    workflow.needs_evidence = 1;
    workflow.verified = 3;

    expect(buildResponsibilityActions(state).map((action) => action.id)).toEqual([
      "review",
      "evidence",
      "publish",
      "first-usage",
    ]);
  });

  it("starts an empty node with a real contribution", () => {
    expect(buildResponsibilityActions(overview())[0]).toMatchObject({
      id: "first-knowledge",
      role: "Contributor",
      to: "/contribute",
    });
  });

  it("routes a published knowledge base toward evidence and Agent integration", () => {
    const actions = buildResponsibilityActions(overview({
      feedback: 1,
      knowledge: 8,
      published: 7,
      usage: 5,
    }));
    expect(actions.map((action) => action.id)).toEqual(["feedback", "agent"]);
  });
});
