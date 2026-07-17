import { describe, expect, it, vi } from "vitest";
import type { Capability } from "./types";
import { runIntegrationPreflight } from "./integration-preflight";

const ORIGIN = "https://knowledge.test";

function capability(overrides: Partial<Capability> = {}): Capability {
  return {
    auth: { protectedResourceMetadata: `${ORIGIN}/.well-known/oauth-protected-resource` },
    baseUrl: `${ORIGIN}/akep/0.1`,
    expiresAt: "2026-07-19T00:00:00.000Z",
    limits: {
      idempotencyWindowSeconds: 86_400,
      maxPageSize: 100,
      maxPayloadBytes: 10_485_760,
    },
    node: { id: ORIGIN, name: "Test node", trustDomain: "knowledge.test" },
    operations: ["query", "resolve", "fetch", "receipt"],
    profiles: ["reader"],
    protocol: "akep",
    schemas: {
      "context-pack": `${ORIGIN}/schemas/context-pack.json`,
      "context-pack-request": `${ORIGIN}/schemas/context-pack-request.json`,
      query: `${ORIGIN}/schemas/query.json`,
    },
    supportedExtensions: [{ required: false, uri: `${ORIGIN}/extensions/context-pack/0.1` }],
    versions: ["0.1"],
    ...overrides,
  };
}

function json(body: unknown, status = 200, etag = '"test"'): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      ...(etag === "" ? {} : { etag }),
    },
    status,
  });
}

function fetcher(input: {
  readonly authorizationServers?: readonly string[];
  readonly capability?: Capability;
  readonly readyStatus?: number;
} = {}) {
  return vi.fn(async (request: string | URL | Request) => {
    const url = String(request);
    if (url.endsWith("/health/live")) return json({ status: "ok" });
    if (url.endsWith("/health/ready")) {
      return json({ database: "ready", status: "ready" }, input.readyStatus ?? 200);
    }
    if (url.endsWith("/.well-known/akep")) return json(input.capability ?? capability());
    if (url.endsWith("/.well-known/oauth-protected-resource")) {
      return json({
        ...(input.authorizationServers === undefined
          ? {}
          : { authorization_servers: input.authorizationServers }),
        bearer_methods_supported: ["header"],
        resource: `${ORIGIN}/akep/0.1`,
        scopes_supported: ["akep:query", "akep:read"],
      });
    }
    if (url.includes("/schemas/")) return json({ $schema: "https://json-schema.org/draft/2020-12/schema" });
    return json({ detail: "not found" }, 404);
  }) as unknown as typeof fetch;
}

describe("Agent integration preflight", () => {
  it("passes every public contract check without sending credentials", async () => {
    const mockedFetch = fetcher({ authorizationServers: [`${ORIGIN}/oauth`] });
    const report = await runIntegrationPreflight({
      fetcher: mockedFetch,
      now: () => new Date("2026-07-18T00:00:00.000Z"),
      publicOrigin: ORIGIN,
    });

    expect(report.overall).toBe("passed");
    expect(report.checks).toHaveLength(5);
    for (const [, init] of vi.mocked(mockedFetch).mock.calls) {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(init?.credentials).toBe("omit");
      expect(init?.redirect).toBe("error");
    }
  });

  it("reports a warning when development metadata has no authorization server", async () => {
    const report = await runIntegrationPreflight({
      fetcher: fetcher(),
      now: () => new Date("2026-07-18T00:00:00.000Z"),
      publicOrigin: ORIGIN,
    });

    expect(report.overall).toBe("warning");
    expect(report.checks.find((item) => item.id === "oauth")).toMatchObject({
      state: "warning",
    });
  });

  it("fails closed on an expired or cross-origin Capability", async () => {
    const report = await runIntegrationPreflight({
      fetcher: fetcher({
        capability: capability({
          baseUrl: "https://other.test/akep/0.1",
          expiresAt: "2026-07-17T00:00:00.000Z",
        }),
      }),
      now: () => new Date("2026-07-18T00:00:00.000Z"),
      publicOrigin: ORIGIN,
    });

    expect(report.overall).toBe("failed");
    expect(report.checks.find((item) => item.id === "capability")?.state).toBe("failed");
    expect(report.checks.find((item) => item.id === "oauth")?.detail).toContain("Capability");
  });

  it("does not follow a cross-origin protected resource metadata endpoint", async () => {
    const mockedFetch = fetcher({
      capability: capability({
        auth: { protectedResourceMetadata: "https://other.test/.well-known/oauth-protected-resource" },
      }),
    });
    const report = await runIntegrationPreflight({
      fetcher: mockedFetch,
      now: () => new Date("2026-07-18T00:00:00.000Z"),
      publicOrigin: ORIGIN,
    });

    expect(report.overall).toBe("failed");
    expect(report.checks.find((item) => item.id === "oauth")?.detail).toContain("同源");
    expect(vi.mocked(mockedFetch).mock.calls.some(([request]) => String(request).startsWith("https://other.test"))).toBe(false);
  });

  it("returns a structured failure for malformed public capability data", async () => {
    const report = await runIntegrationPreflight({
      fetcher: fetcher({ capability: { ...capability(), auth: undefined } as unknown as Capability }),
      now: () => new Date("2026-07-18T00:00:00.000Z"),
      publicOrigin: ORIGIN,
    });

    expect(report.overall).toBe("failed");
    expect(report.checks.find((item) => item.id === "capability")?.detail).toContain("OAuth");
    expect(report.checks.find((item) => item.id === "oauth")?.detail).toContain("Capability");
  });

  it("surfaces readiness failure without treating Discovery as readiness", async () => {
    const report = await runIntegrationPreflight({
      fetcher: fetcher({ authorizationServers: [`${ORIGIN}/oauth`], readyStatus: 503 }),
      now: () => new Date("2026-07-18T00:00:00.000Z"),
      publicOrigin: ORIGIN,
    });

    expect(report.overall).toBe("failed");
    expect(report.checks.find((item) => item.id === "ready")).toMatchObject({
      state: "failed",
    });
  });
});
