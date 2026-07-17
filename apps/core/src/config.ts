import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type AuthMode = "development" | "oidc";

export interface OidcConfig {
  readonly accessTokenTypes: readonly string[];
  readonly audience: string;
  readonly issuer: string;
  readonly jwksUri: string;
  readonly maxTokenLifetimeSeconds: number;
  readonly tenantClaim: string;
}

export interface AppConfig {
  readonly authMode: AuthMode;
  readonly baseUrl: string;
  readonly contractRoot: string;
  readonly databaseRequired: boolean;
  readonly databaseUrl?: string;
  readonly defaultSpaceId: string;
  readonly host: string;
  readonly logLevel: string;
  readonly nodeEnv: "development" | "test" | "production";
  readonly nodeId: string;
  readonly nodeName: string;
  readonly oidc?: OidcConfig;
  readonly otelTracesEndpoint?: string;
  readonly policyEpoch: string;
  readonly port: number;
  readonly protectedResourceMetadata: string;
  readonly publicOrigin: string;
  readonly rateLimitMax: number;
  readonly rateLimitWindow: string;
  readonly serviceName: string;
  readonly sloP95Milliseconds: number;
  readonly trustProxy: boolean;
  readonly trustDomain: string;
  readonly tenantId: string;
}

function requireUri(name: string, value: string): string {
  try {
    return new URL(value).toString().replace(/\/$/, "");
  } catch {
    throw new Error(`${name} must be an absolute URI`);
  }
}

function requireExactUri(name: string, value: string): string {
  try {
    new URL(value);
    return value;
  } catch {
    throw new Error(`${name} must be an absolute URI`);
  }
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Expected boolean but received ${value}`);
}

function parsePositiveInteger(name: string, value: string | undefined, fallback: number): number {
  const source = value ?? String(fallback);
  const parsed = Number(source);
  if (!/^[1-9][0-9]*$/u.test(source) || !Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseTokenTypes(value: string | undefined): readonly string[] {
  const types = (value ?? "at+jwt,JWT")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (
    types.length === 0 ||
    types.some((item) => !/^[A-Za-z0-9._+-]{1,64}$/u.test(item))
  ) {
    throw new Error(
      "OIDC_ACCESS_TOKEN_TYPES must be a comma-separated list of valid JWT typ values",
    );
  }
  return [...new Set(types)];
}

function parseClaimName(value: string | undefined): string {
  const claim = value?.trim() || "akep_tenant";
  if (claim.length > 256 || /[\s\u0000-\u001f"\\]/u.test(claim)) {
    throw new Error("OIDC_TENANT_CLAIM must be a valid JWT claim name");
  }
  return claim;
}

function findWorkspaceRoot(start: string): string {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, "specs", "akep", "v0.1", "schemas"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error("Could not find the repository contract root");
    }
    current = parent;
  }
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  moduleUrl: string = import.meta.url,
): AppConfig {
  const nodeEnv = env.NODE_ENV ?? "development";
  if (!["development", "test", "production"].includes(nodeEnv)) {
    throw new Error(`Unsupported NODE_ENV: ${nodeEnv}`);
  }

  const authMode = env.AUTH_MODE ?? "development";
  if (!["development", "oidc"].includes(authMode)) {
    throw new Error(`Unsupported AUTH_MODE: ${authMode}`);
  }
  if (nodeEnv === "production" && authMode === "development") {
    throw new Error("Development authentication is forbidden in production");
  }

  const port = Number.parseInt(env.PORT ?? "3000", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  const publicOrigin = requireUri(
    "AKEP_PUBLIC_ORIGIN",
    env.AKEP_PUBLIC_ORIGIN ?? "http://localhost:3000",
  );
  if (nodeEnv === "production" && new URL(publicOrigin).protocol !== "https:") {
    throw new Error("AKEP_PUBLIC_ORIGIN must use HTTPS in production");
  }
  const workspaceRoot = findWorkspaceRoot(
    dirname(fileURLToPath(moduleUrl)),
  );
  const databaseUrl = env.DATABASE_URL?.trim();
  const databaseRequired = parseBoolean(
    env.DATABASE_REQUIRED,
    nodeEnv === "production",
  );
  const otelTracesEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const oidc = authMode === "oidc"
    ? {
        accessTokenTypes: parseTokenTypes(env.OIDC_ACCESS_TOKEN_TYPES),
        audience: env.OIDC_AUDIENCE?.trim() ?? "",
        issuer: env.OIDC_ISSUER?.trim() ?? "",
        jwksUri: env.OIDC_JWKS_URI?.trim() ?? "",
        maxTokenLifetimeSeconds: parsePositiveInteger(
          "OIDC_MAX_TOKEN_LIFETIME_SECONDS",
          env.OIDC_MAX_TOKEN_LIFETIME_SECONDS,
          3_600,
        ),
        tenantClaim: parseClaimName(env.OIDC_TENANT_CLAIM),
      }
    : undefined;
  if (
    oidc !== undefined &&
    (oidc.audience.length === 0 || oidc.issuer.length === 0 || oidc.jwksUri.length === 0)
  ) {
    throw new Error("OIDC_AUDIENCE, OIDC_ISSUER and OIDC_JWKS_URI are required for OIDC auth");
  }
  if (
    nodeEnv === "production" &&
    oidc !== undefined &&
    (new URL(oidc.issuer).protocol !== "https:" || new URL(oidc.jwksUri).protocol !== "https:")
  ) {
    throw new Error("OIDC_ISSUER and OIDC_JWKS_URI must use HTTPS in production");
  }
  if (nodeEnv === "production" && !databaseRequired) {
    throw new Error("DATABASE_REQUIRED cannot be disabled in production");
  }
  if (
    nodeEnv === "production" &&
    (databaseUrl === undefined || databaseUrl.length === 0)
  ) {
    throw new Error("DATABASE_URL is required in production");
  }

  return {
    authMode: authMode as AuthMode,
    baseUrl: `${publicOrigin}/akep/0.1`,
    contractRoot:
      env.AKEP_CONTRACT_ROOT ?? join(workspaceRoot, "specs", "akep", "v0.1"),
    databaseRequired,
    ...(databaseUrl === undefined || databaseUrl.length === 0
      ? {}
      : { databaseUrl }),
    defaultSpaceId: requireUri(
      "AKEP_DEFAULT_SPACE",
      env.AKEP_DEFAULT_SPACE ?? "https://knowledge.local/spaces/default",
    ),
    host: env.HOST ?? "0.0.0.0",
    logLevel: env.LOG_LEVEL ?? "info",
    nodeEnv: nodeEnv as AppConfig["nodeEnv"],
    nodeId: requireUri(
      "AKEP_NODE_ID",
      env.AKEP_NODE_ID ?? "https://knowledge.local",
    ),
    nodeName: env.AKEP_NODE_NAME ?? "Local Agent Knowledge Node",
    ...(oidc === undefined
      ? {}
      : {
          oidc: {
            accessTokenTypes: oidc.accessTokenTypes,
            audience: oidc.audience,
            // JWT issuer matching is byte-for-byte. In particular, several
            // providers publish an issuer that deliberately ends in `/`.
            issuer: requireExactUri("OIDC_ISSUER", oidc.issuer),
            jwksUri: requireExactUri("OIDC_JWKS_URI", oidc.jwksUri),
            maxTokenLifetimeSeconds: oidc.maxTokenLifetimeSeconds,
            tenantClaim: oidc.tenantClaim,
          },
        }),
    ...(otelTracesEndpoint === undefined || otelTracesEndpoint.length === 0
      ? {}
      : { otelTracesEndpoint: requireUri("OTEL_EXPORTER_OTLP_ENDPOINT", otelTracesEndpoint) }),
    policyEpoch: env.AKEP_POLICY_EPOCH ?? "bootstrap-1",
    port,
    protectedResourceMetadata:
      env.AKEP_PROTECTED_RESOURCE_METADATA ??
      `${publicOrigin}/.well-known/oauth-protected-resource`,
    publicOrigin,
    rateLimitMax: parsePositiveInteger("RATE_LIMIT_MAX", env.RATE_LIMIT_MAX, 300),
    rateLimitWindow: env.RATE_LIMIT_WINDOW ?? "1 minute",
    serviceName: env.OTEL_SERVICE_NAME ?? "akep-core",
    sloP95Milliseconds: parsePositiveInteger("SLO_P95_MILLISECONDS", env.SLO_P95_MILLISECONDS, 800),
    trustProxy: parseBoolean(env.TRUST_PROXY, false),
    trustDomain: env.AKEP_TRUST_DOMAIN ?? "knowledge.local",
    tenantId: requireUri(
      "AKEP_TENANT_ID",
      env.AKEP_TENANT_ID ?? "https://knowledge.local/tenants/local",
    ),
  };
}
