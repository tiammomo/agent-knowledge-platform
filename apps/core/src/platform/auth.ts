import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { AppConfig, AuthMode } from "../config.js";
import { ProblemError } from "./problem.js";

declare module "fastify" {
  interface FastifyRequest {
    akepAuthFailed?: boolean;
    akepAuthMode?: AuthMode;
    akepPrincipal?: Principal;
  }
}

export interface Principal {
  readonly scopes: ReadonlySet<string>;
  readonly subject: string;
  readonly subjectDigest: string;
  readonly supportedObligations: readonly unknown[];
}

const DEVELOPMENT_TOKENS = new Map<string, Principal>([
  [
    "dev-reader",
    createPrincipal(
      "urn:akep:development:reader",
      [
        "akep:classification:internal",
        "akep:feedback",
        "akep:policy:*",
        "akep:query",
        "akep:read",
        "akep:space:*",
      ],
      ["cite", "no-train"],
    ),
  ],
  [
    "dev-observer",
    createPrincipal("urn:akep:development:observer", ["akep:observe"]),
  ],
  [
    "dev-contributor",
    createPrincipal(
      "urn:akep:development:contributor",
      [
        "akep:classification:internal",
        "akep:contribute",
        "akep:feedback",
        "akep:policy:*",
        "akep:query",
        "akep:read",
        "akep:space:*",
      ],
      ["cite", "no-train"],
    ),
  ],
  [
    "dev-console",
    createPrincipal("urn:akep:development:console", [
      "akep:classification:*",
      "akep:console",
      "akep:policy:*",
      "akep:space:*",
    ]),
  ],
  [
    "dev-curator",
    createPrincipal("urn:akep:development:curator", [
      "akep:classification:internal",
      "akep:policy:*",
      "akep:read",
      "akep:review",
      "akep:space:*",
    ]),
  ],
  [
    "dev-evaluator",
    createPrincipal("urn:akep:development:evaluator", [
      "akep:classification:internal",
      "akep:evaluate",
      "akep:policy:*",
      "akep:read",
      "akep:space:*",
    ]),
  ],
  [
    "dev-publisher",
    createPrincipal("urn:akep:development:publisher", [
      "akep:classification:internal",
      "akep:policy:*",
      "akep:publish",
      "akep:read",
      "akep:space:*",
    ]),
  ],
  [
    "dev-incident",
    createPrincipal("urn:akep:development:incident", [
      "akep:classification:internal",
      "akep:incident",
      "akep:policy:*",
      "akep:read",
      "akep:space:*",
    ]),
  ],
  [
    "dev-eraser",
    createPrincipal("urn:akep:development:eraser", [
      "akep:classification:internal",
      "akep:erase",
      "akep:policy:*",
      "akep:read",
      "akep:space:*",
    ]),
  ],
]);

function createPrincipal(
  subject: string,
  scopes: readonly string[],
  supportedObligations: readonly unknown[] = [],
): Principal {
  return {
    scopes: new Set(scopes),
    subject,
    subjectDigest: `sha256:${createHash("sha256").update(subject).digest("hex")}`,
    supportedObligations: Object.freeze([...supportedObligations]),
  };
}

export function installAuthentication(app: FastifyInstance, config: AppConfig): void {
  app.decorateRequest("akepAuthFailed", undefined);
  app.decorateRequest("akepAuthMode", undefined);
  app.decorateRequest("akepPrincipal", undefined);
  if (config.authMode === "development") {
    app.addHook("onRequest", async (request) => {
      request.akepAuthMode = "development";
    });
    return;
  }

  const oidc = config.oidc;
  if (oidc === undefined) throw new Error("OIDC configuration is missing");
  const keySet = createRemoteJWKSet(new URL(oidc.jwksUri), {
    cooldownDuration: 30_000,
    timeoutDuration: 5_000,
  });
  app.addHook("onRequest", async (request) => {
    request.akepAuthMode = "oidc";
    const authorization = request.headers.authorization;
    if (authorization === undefined || !authorization.startsWith("Bearer ")) return;
    try {
      const verified = await jwtVerify(authorization.slice("Bearer ".length), keySet, {
        algorithms: ["RS256", "ES256", "EdDSA"],
        audience: oidc.audience,
        clockTolerance: 5,
        issuer: oidc.issuer,
        requiredClaims: ["sub", "iat", "exp"],
      });
      const tokenType = verified.protectedHeader.typ;
      if (
        typeof tokenType !== "string" ||
        !oidc.accessTokenTypes.includes(tokenType)
      ) {
        throw new Error("JWT typ is not an allowed access-token type");
      }
      const subject = verified.payload.sub;
      if (subject === undefined || subject.length === 0) throw new Error("JWT subject is missing");
      const issuedAt = verified.payload.iat;
      const expiresAt = verified.payload.exp;
      if (
        typeof issuedAt !== "number" ||
        typeof expiresAt !== "number" ||
        !Number.isSafeInteger(issuedAt) ||
        !Number.isSafeInteger(expiresAt) ||
        expiresAt <= issuedAt ||
        expiresAt - issuedAt > oidc.maxTokenLifetimeSeconds
      ) {
        throw new Error("JWT lifetime is invalid");
      }
      const scopeClaim = verified.payload.scope;
      const scpClaim = verified.payload.scp;
      const scopes = new Set<string>();
      if (typeof scopeClaim === "string") {
        for (const scope of scopeClaim.split(/\s+/u)) if (scope.length > 0) scopes.add(scope);
      }
      if (typeof scpClaim === "string") {
        for (const scope of scpClaim.split(/\s+/u)) if (scope.length > 0) scopes.add(scope);
      } else if (Array.isArray(scpClaim)) {
        for (const scope of scpClaim) if (typeof scope === "string") scopes.add(scope);
      }
      const identity = `${oidc.issuer}\0${subject}`;
      const identityDigest = createHash("sha256").update(identity).digest("hex");
      const supportedObligations = parseTrustedObligations(
        verified.payload.akep_obligations,
      );
      request.akepPrincipal = createPrincipal(
        `urn:akep:principal:sha256:${identityDigest}`,
        [...scopes],
        supportedObligations,
      );
    } catch {
      request.akepAuthFailed = true;
    }
  });
}

function parseTrustedObligations(value: unknown): readonly unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error("akep_obligations must be an array");
  }
  for (const obligation of value) {
    if (obligation === "cite" || obligation === "no-train") continue;
    if (
      typeof obligation !== "object" ||
      obligation === null ||
      Array.isArray(obligation)
    ) {
      throw new Error("akep_obligations contains an unsupported value");
    }
    const entries = Object.entries(obligation);
    const digest = (obligation as Record<string, unknown>).digest;
    const uri = (obligation as Record<string, unknown>).uri;
    if (
      entries.length !== 2 ||
      !entries.every(([key]) => key === "digest" || key === "uri") ||
      typeof digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(digest) ||
      typeof uri !== "string" ||
      uri.length > 2_048 ||
      !isAbsoluteUri(uri)
    ) {
      throw new Error("akep_obligations contains an invalid schema reference");
    }
  }
  return value;
}

function isAbsoluteUri(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function constantTimeTokenMatch(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function authenticate(
  request: FastifyRequest,
  requiredScope: string,
): Principal {
  if (request.akepAuthMode === "oidc") {
    return requireOidcPrincipal(request, [requiredScope]);
  }
  const authorization = request.headers.authorization;
  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    throw new ProblemError(
      401,
      "AKEP_AUTHENTICATION_REQUIRED",
      "A bearer credential is required.",
    );
  }
  const provided = authorization.slice("Bearer ".length);
  let principal: Principal | undefined;
  for (const [token, candidate] of DEVELOPMENT_TOKENS) {
    if (constantTimeTokenMatch(provided, token)) {
      principal = candidate;
      break;
    }
  }
  if (principal === undefined) {
    throw new ProblemError(
      401,
      "AKEP_AUTHENTICATION_REQUIRED",
      "The bearer credential is invalid.",
    );
  }
  if (!principal.scopes.has(requiredScope)) {
    throw new ProblemError(
      403,
      "AKEP_POLICY_DENIED",
      "The caller does not have the required scope.",
    );
  }
  return principal;
}

export function authenticateAny(
  request: FastifyRequest,
  requiredScopes: readonly string[],
): Principal {
  if (request.akepAuthMode === "oidc") {
    return requireOidcPrincipal(request, requiredScopes);
  }
  const authorization = request.headers.authorization;
  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    throw new ProblemError(
      401,
      "AKEP_AUTHENTICATION_REQUIRED",
      "A bearer credential is required.",
    );
  }
  const provided = authorization.slice("Bearer ".length);
  let principal: Principal | undefined;
  for (const [token, candidate] of DEVELOPMENT_TOKENS) {
    if (constantTimeTokenMatch(provided, token)) {
      principal = candidate;
      break;
    }
  }
  if (principal === undefined) {
    throw new ProblemError(
      401,
      "AKEP_AUTHENTICATION_REQUIRED",
      "The bearer credential is invalid.",
    );
  }
  if (!requiredScopes.some((scope) => principal.scopes.has(scope))) {
    throw new ProblemError(
      403,
      "AKEP_POLICY_DENIED",
      "The caller does not have any accepted scope for this operation.",
    );
  }
  return principal;
}

function requireOidcPrincipal(
  request: FastifyRequest,
  requiredScopes: readonly string[],
): Principal {
  const principal = request.akepPrincipal;
  if (request.akepAuthFailed === true || principal === undefined) {
    throw new ProblemError(
      401,
      "AKEP_AUTHENTICATION_REQUIRED",
      "A valid audience-bound bearer credential is required.",
    );
  }
  if (!requiredScopes.some((scope) => principal.scopes.has(scope))) {
    throw new ProblemError(
      403,
      "AKEP_POLICY_DENIED",
      "The caller does not have any accepted scope for this operation.",
    );
  }
  return principal;
}
