import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { authorizeQuery } from "../src/platform/authorization.js";
import type { Principal } from "../src/platform/auth.js";
import { ProblemError } from "../src/platform/problem.js";

const TENANT_ID = "https://knowledge.test/tenants/acme";
const SUPPORT = "https://knowledge.test/spaces/support";
const FINANCE = "https://knowledge.test/spaces/finance";

function config() {
  return loadConfig(
    {
      AKEP_TENANT_ID: TENANT_ID,
      AUTH_MODE: "development",
      NODE_ENV: "test",
    },
    import.meta.url,
  );
}

function principal(scopes: readonly string[], tenantId = TENANT_ID): Principal {
  return {
    scopes: new Set(scopes),
    subject: "urn:akep:test:reader",
    subjectDigest: `sha256:${"a".repeat(64)}`,
    supportedObligations: ["cite"],
    tenantId,
  };
}

describe("query authorization plans", () => {
  it("compiles exact Space scopes into a stable authorization binding", () => {
    const actor = principal([
      "akep:query",
      `akep:space:${encodeURIComponent(SUPPORT)}`,
      `akep:space:${encodeURIComponent(FINANCE)}`,
    ]);
    const first = authorizeQuery({
      config: config(),
      principal: actor,
      purpose: "customer-support",
    });
    const second = authorizeQuery({
      config: config(),
      principal: actor,
      purpose: "customer-support",
    });

    expect(first.spaceIds).toEqual([FINANCE, SUPPORT]);
    expect(first.bindingDigest).toBe(second.bindingDigest);
    expect(first.decisionId).not.toBe(second.decisionId);
  });

  it("keeps wildcard authorization explicit without inventing Space IDs", () => {
    const plan = authorizeQuery({
      config: config(),
      principal: principal(["akep:query", "akep:space:*"]),
      purpose: "customer-support",
    });

    expect(plan.spaceIds).toBeUndefined();
    expect(plan.tenantId).toBe(TENANT_ID);
  });

  it("rejects cross-Tenant and unauthorized explicit Space plans", () => {
    for (const action of [
      () => authorizeQuery({
        config: config(),
        principal: principal(["akep:query", "akep:space:*"],
          "https://knowledge.test/tenants/other"),
        purpose: "customer-support",
      }),
      () => authorizeQuery({
        config: config(),
        principal: principal([
          "akep:query",
          `akep:space:${encodeURIComponent(SUPPORT)}`,
        ]),
        purpose: "customer-support",
        requestedSpaceIds: [FINANCE],
      }),
    ]) {
      try {
        action();
        throw new Error("Expected query authorization to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(ProblemError);
        expect(error).toMatchObject({ code: "AKEP_POLICY_DENIED", statusCode: 403 });
      }
    }
  });
});
