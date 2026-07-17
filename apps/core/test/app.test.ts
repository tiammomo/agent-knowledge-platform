import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApplication } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { ContractRegistry } from "../src/contracts/registry.js";

function testConfig() {
  return loadConfig(
    {
      AKEP_PUBLIC_ORIGIN: "https://knowledge.test",
      AUTH_MODE: "development",
      DATABASE_REQUIRED: "false",
      NODE_ENV: "test",
    },
    import.meta.url,
  );
}

describe("AKEP bootstrap reader", () => {
  it("publishes a schema-valid reader capability", async () => {
    const config = testConfig();
    const app = await buildApplication({ config, logger: false });
    const response = await app.inject({ method: "GET", url: "/.well-known/akep" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["akep-version"]).toBe("0.1");
    const body = response.json();
    new ContractRegistry(config.contractRoot).assert("capability.schema.json", body);
    expect(body.profiles).toEqual([
      "reader",
      "contributor",
      "curator",
      "publisher",
    ]);
    expect(body.operations).toContain("query");
    expect(body.operations).toContain("contribute");
    expect(body.operations).toContain("decide");
    expect(body.operations).toContain("publish");
    expect(body.schemas).toMatchObject({
      attestation:
        "https://knowledge.test/schemas/akep/0.1/attestation.schema.json",
      "context-pack":
        "https://knowledge.test/schemas/akep/0.1/context-pack.schema.json",
      "evaluation-run":
        "https://knowledge.test/schemas/akep/0.1/evaluation-run.schema.json",
    });
    expect(body.supportedExtensions).toEqual([
      {
        required: false,
        uri: "https://knowledge.test/extensions/akep/context-pack/0.1",
      },
      {
        required: false,
        uri: "https://knowledge.test/extensions/mcp-adapter/0.1",
      },
    ]);
    for (const schemaUrl of Object.values(body.schemas as Record<string, string>)) {
      const schemaResponse = await app.inject({
        method: "GET",
        url: new URL(schemaUrl).pathname,
      });
      expect(schemaResponse.statusCode, schemaUrl).toBe(200);
      expect(schemaResponse.headers.etag).toMatch(/^"sha256:[a-f0-9]{64}"$/);
    }
    await app.close();
  });

  it("rejects an unauthenticated query", async () => {
    const config = testConfig();
    const app = await buildApplication({ config, logger: false });
    const query = JSON.parse(
      readFileSync(join(config.contractRoot, "examples", "query.json"), "utf8"),
    ) as Record<string, unknown>;
    query.mode = "lexical";
    delete (query.filters as Record<string, unknown>).validAt;
    const response = await app.inject({
      headers: { "akep-version": "0.1" },
      method: "POST",
      payload: query,
      url: "/akep/0.1/queries",
    });

    expect(response.statusCode).toBe(401);
    const problem = response.json();
    new ContractRegistry(config.contractRoot).assert(
      "problem.schema.json",
      problem,
    );
    expect(problem.code).toBe("AKEP_AUTHENTICATION_REQUIRED");
    expect(problem.traceId).toMatch(/^[a-f0-9]{32}$/);
    await app.close();
  });

  it("maps malformed JSON to a client problem", async () => {
    const app = await buildApplication({ config: testConfig(), logger: false });
    const response = await app.inject({
      headers: {
        "akep-version": "0.1",
        authorization: "Bearer dev-reader",
        "content-type": "application/json",
      },
      method: "POST",
      payload: "{",
      url: "/akep/0.1/queries",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("AKEP_BAD_REQUEST");
    await app.close();
  });

  it("returns an empty result and a subject-bound exposure receipt", async () => {
    const config = testConfig();
    const contracts = new ContractRegistry(config.contractRoot);
    const app = await buildApplication({ config, logger: false });
    const query = JSON.parse(
      readFileSync(join(config.contractRoot, "examples", "query.json"), "utf8"),
    ) as Record<string, unknown>;
    query.mode = "lexical";
    delete (query.filters as Record<string, unknown>).validAt;
    const response = await app.inject({
      headers: {
        "akep-version": "0.1",
        authorization: "Bearer dev-reader",
      },
      method: "POST",
      payload: query,
      url: "/akep/0.1/queries",
    });

    expect(response.statusCode).toBe(200);
    const result = response.json();
    contracts.assert("query-result.schema.json", result);
    expect(result.results).toEqual([]);

    const receiptResponse = await app.inject({
      headers: {
        "akep-version": "0.1",
        authorization: "Bearer dev-reader",
      },
      method: "GET",
      url: `/akep/0.1/exposure-receipts/${encodeURIComponent(result.queryReceiptId)}`,
    });
    expect(receiptResponse.statusCode).toBe(200);
    const receipt = receiptResponse.json();
    contracts.assert("exposure-receipt.schema.json", receipt);
    expect(receipt.citations).toEqual([]);
    expect(receipt.purpose).toBe("customer-support");
    await app.close();
  });

  it("fails closed when direct reads omit obligation support", async () => {
    const app = await buildApplication({ config: testConfig(), logger: false });
    const response = await app.inject({
      headers: {
        "akep-purpose": "customer-support",
        "akep-version": "0.1",
        authorization: "Bearer dev-reader",
      },
      method: "GET",
      url: "/akep/0.1/spaces/urn%3Aspace%3Adefault/records/urn%3Arecord%3Amissing",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("AKEP_SCHEMA_INVALID");
    await app.close();
  });

  it("exposes a private console read model only to a global console operator", async () => {
    const app = await buildApplication({ config: testConfig(), logger: false });
    const denied = await app.inject({
      headers: { "akep-version": "0.1" },
      method: "GET",
      url: "/console/v1/overview",
    });
    expect(denied.statusCode).toBe(401);

    const response = await app.inject({
      headers: {
        "akep-version": "0.1",
        authorization: "Bearer dev-console",
      },
      method: "GET",
      url: "/console/v1/overview",
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json()).toMatchObject({
      totals: {
        feedback: 0,
        knowledge: 0,
        pendingReview: 0,
        published: 0,
        revoked: 0,
        usage: 0,
      },
    });
    await app.close();
  });

  it("does not allow development authentication in production", () => {
    expect(() =>
      loadConfig(
        {
          AUTH_MODE: "development",
          NODE_ENV: "production",
        },
        import.meta.url,
      ),
    ).toThrow("Development authentication is forbidden in production");
  });

  it("requires complete OIDC configuration", () => {
    expect(() =>
      loadConfig(
        {
          AKEP_PUBLIC_ORIGIN: "https://knowledge.test",
          AUTH_MODE: "oidc",
          DATABASE_URL: "postgres://akep:secret@database.test:5432/akep",
          NODE_ENV: "production",
          OIDC_AUDIENCE: "https://knowledge.test/akep/0.1",
        },
        import.meta.url,
      ),
    ).toThrow("OIDC_AUDIENCE, OIDC_ISSUER and OIDC_JWKS_URI are required");
  });

  it("publishes the configured OIDC authorization server", async () => {
    const config = loadConfig(
      {
        AKEP_PUBLIC_ORIGIN: "https://knowledge.test",
        AUTH_MODE: "oidc",
        DATABASE_REQUIRED: "false",
        NODE_ENV: "test",
        OIDC_AUDIENCE: "https://knowledge.test/akep/0.1",
        OIDC_ISSUER: "https://identity.test",
        OIDC_JWKS_URI: "https://identity.test/jwks.json",
      },
      import.meta.url,
    );
    const app = await buildApplication({ config, logger: false });
    const metadata = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-protected-resource",
    });

    expect(metadata.statusCode).toBe(200);
    expect(metadata.json().authorization_servers).toEqual(["https://identity.test"]);
    await app.close();
  });

  it("preserves an OIDC issuer trailing slash for exact JWT matching", () => {
    const config = loadConfig(
      {
        AUTH_MODE: "oidc",
        NODE_ENV: "test",
        OIDC_AUDIENCE: "https://knowledge.test/akep/0.1",
        OIDC_ISSUER: "https://identity.test/tenant/",
        OIDC_JWKS_URI: "https://identity.test/tenant/jwks.json",
      },
      import.meta.url,
    );

    expect(config.oidc?.issuer).toBe("https://identity.test/tenant/");
  });

  it("defaults to bounded access-token types and lifetime", () => {
    const config = loadConfig(
      {
        AUTH_MODE: "oidc",
        NODE_ENV: "test",
        OIDC_AUDIENCE: "https://knowledge.test/akep/0.1",
        OIDC_ISSUER: "https://identity.test/",
        OIDC_JWKS_URI: "https://identity.test/jwks.json",
      },
      import.meta.url,
    );

    expect(config.oidc?.accessTokenTypes).toEqual(["at+jwt", "JWT"]);
    expect(config.oidc?.maxTokenLifetimeSeconds).toBe(3_600);
    expect(config.oidc?.tenantClaim).toBe("akep_tenant");
  });

  it("validates the OIDC token-type allowlist and maximum lifetime", () => {
    const base = {
      AUTH_MODE: "oidc",
      NODE_ENV: "test",
      OIDC_AUDIENCE: "https://knowledge.test/akep/0.1",
      OIDC_ISSUER: "https://identity.test/",
      OIDC_JWKS_URI: "https://identity.test/jwks.json",
    };
    expect(() => loadConfig(
      { ...base, OIDC_ACCESS_TOKEN_TYPES: " " },
      import.meta.url,
    )).toThrow("OIDC_ACCESS_TOKEN_TYPES");
    expect(() => loadConfig(
      { ...base, OIDC_MAX_TOKEN_LIFETIME_SECONDS: "3600seconds" },
      import.meta.url,
    )).toThrow("OIDC_MAX_TOKEN_LIFETIME_SECONDS must be a positive integer");
    expect(() => loadConfig(
      { ...base, OIDC_TENANT_CLAIM: "invalid claim" },
      import.meta.url,
    )).toThrow("OIDC_TENANT_CLAIM");

    const config = loadConfig(
      {
        ...base,
        OIDC_ACCESS_TOKEN_TYPES: "at+jwt,custom+jwt,at+jwt",
        OIDC_MAX_TOKEN_LIFETIME_SECONDS: "900",
        OIDC_TENANT_CLAIM: "https://claims.test/tenant",
      },
      import.meta.url,
    );
    expect(config.oidc?.accessTokenTypes).toEqual(["at+jwt", "custom+jwt"]);
    expect(config.oidc?.maxTokenLifetimeSeconds).toBe(900);
    expect(config.oidc?.tenantClaim).toBe("https://claims.test/tenant");
  });

  it("requires HTTPS origins and identity metadata in production", () => {
    expect(() => loadConfig(
      {
        AKEP_PUBLIC_ORIGIN: "http://knowledge.test",
        AUTH_MODE: "oidc",
        DATABASE_URL: "postgres://akep:secret@database.test:5432/akep",
        NODE_ENV: "production",
        OIDC_AUDIENCE: "https://knowledge.test/akep/0.1",
        OIDC_ISSUER: "https://identity.test/",
        OIDC_JWKS_URI: "https://identity.test/jwks.json",
      },
      import.meta.url,
    )).toThrow("AKEP_PUBLIC_ORIGIN must use HTTPS in production");
  });

  it("does not allow production to fall back to volatile in-memory stores", () => {
    expect(() => loadConfig(
      {
        AKEP_PUBLIC_ORIGIN: "https://knowledge.test",
        AUTH_MODE: "oidc",
        DATABASE_REQUIRED: "false",
        NODE_ENV: "production",
        OIDC_AUDIENCE: "https://knowledge.test/akep/0.1",
        OIDC_ISSUER: "https://identity.test/",
        OIDC_JWKS_URI: "https://identity.test/jwks.json",
      },
      import.meta.url,
    )).toThrow("DATABASE_REQUIRED cannot be disabled in production");
  });
});
