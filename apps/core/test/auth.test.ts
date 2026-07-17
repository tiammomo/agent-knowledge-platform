import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
} from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { authenticate, installAuthentication } from "../src/platform/auth.js";

const AUDIENCE = "https://knowledge.test/akep/0.1";
const TENANT_ID = "https://knowledge.test/tenants/acme";

interface TokenOptions {
  readonly claims?: Record<string, unknown>;
  readonly expiresAt?: number | null;
  readonly issuedAt?: number | null;
  readonly subject?: string | null;
  readonly tenant?: string | null;
  readonly type?: string | null;
}

describe("OIDC access-token trust boundary", () => {
  let app: FastifyInstance;
  let issuer: string;
  let privateKey: CryptoKey;
  let server: Server;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    const exported = await exportJWK(pair.publicKey);
    const publicKey: JWK = {
      ...exported,
      alg: "RS256",
      kid: "akep-test-key",
      use: "sig",
    };
    server = createServer((request, response) => {
      if (request.url !== "/jwks.json") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ keys: [publicKey] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    issuer = `${origin}/issuer`;

    const config = loadConfig(
      {
        AKEP_TENANT_ID: TENANT_ID,
        AUTH_MODE: "oidc",
        DATABASE_REQUIRED: "false",
        NODE_ENV: "test",
        OIDC_ACCESS_TOKEN_TYPES: "at+jwt",
        OIDC_AUDIENCE: AUDIENCE,
        OIDC_ISSUER: issuer,
        OIDC_JWKS_URI: `${origin}/jwks.json`,
        OIDC_MAX_TOKEN_LIFETIME_SECONDS: "300",
        OIDC_TENANT_CLAIM: "akep_tenant",
      },
      import.meta.url,
    );
    app = Fastify({ logger: false });
    installAuthentication(app, config);
    app.get("/protected", async (request, reply) => {
      try {
        const principal = authenticate(request, "akep:read");
        return reply.send({
          subject: principal.subject,
          supportedObligations: principal.supportedObligations,
          tenantId: principal.tenantId,
        });
      } catch {
        return reply.code(401).send({ code: "denied" });
      }
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error === undefined ? resolve() : reject(error)),
    );
  });

  async function sign(options: TokenOptions = {}): Promise<string> {
    const now = Math.floor(Date.now() / 1_000);
    const token = new SignJWT({
      scope: "akep:read",
      ...(options.tenant === null
        ? {}
        : { akep_tenant: options.tenant ?? TENANT_ID }),
      ...(options.claims ?? {}),
    })
      .setProtectedHeader({
        alg: "RS256",
        kid: "akep-test-key",
        ...(options.type === null ? {} : { typ: options.type ?? "at+jwt" }),
      })
      .setIssuer(issuer)
      .setAudience(AUDIENCE);
    if (options.subject !== null) token.setSubject(options.subject ?? "reader-1");
    if (options.issuedAt !== null) token.setIssuedAt(options.issuedAt ?? now);
    if (options.expiresAt !== null) token.setExpirationTime(options.expiresAt ?? now + 300);
    return token.sign(privateKey);
  }

  async function request(token: string) {
    return app.inject({
      headers: { authorization: `Bearer ${token}` },
      method: "GET",
      url: "/protected",
    });
  }

  it("accepts a bounded access token and derives obligations from its signed claim", async () => {
    const response = await request(await sign({
      claims: { akep_obligations: ["cite", "no-train"] },
    }));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      supportedObligations: ["cite", "no-train"],
      tenantId: TENANT_ID,
    });
  });

  it("requires a signed Tenant claim matching the deployment", async () => {
    expect((await request(await sign({ tenant: null }))).statusCode).toBe(401);
    expect((await request(await sign({
      tenant: "https://knowledge.test/tenants/other",
    }))).statusCode).toBe(401);
    expect((await request(await sign({ tenant: "not-a-uri" }))).statusCode).toBe(401);
  });

  it("requires sub, iat and exp", async () => {
    for (const options of [
      { subject: null },
      { issuedAt: null },
      { expiresAt: null },
    ] satisfies readonly TokenOptions[]) {
      const response = await request(await sign(options));
      expect(response.statusCode).toBe(401);
    }
  });

  it("rejects missing or non-allowlisted access-token typ", async () => {
    expect((await request(await sign({ type: null }))).statusCode).toBe(401);
    expect((await request(await sign({ type: "id+jwt" }))).statusCode).toBe(401);
  });

  it("rejects non-forward and overlong token lifetimes", async () => {
    const now = Math.floor(Date.now() / 1_000);
    expect((await request(await sign({
      expiresAt: now + 60,
      issuedAt: now + 120,
    }))).statusCode).toBe(401);
    expect((await request(await sign({
      expiresAt: now + 301,
      issuedAt: now,
    }))).statusCode).toBe(401);
  });

  it("rejects malformed signed obligation claims", async () => {
    expect((await request(await sign({
      claims: { akep_obligations: "cite" },
    }))).statusCode).toBe(401);
    expect((await request(await sign({
      claims: { akep_obligations: ["execute"] },
    }))).statusCode).toBe(401);
  });
});
