import type { Capability } from "./types";

export type PreflightState = "failed" | "passed" | "warning";
export type PreflightOverallState = "failed" | "passed" | "warning";

export interface PreflightCheck {
  readonly detail: string;
  readonly endpoint: string;
  readonly id: "capability" | "live" | "oauth" | "ready" | "schemas";
  readonly label: string;
  readonly latencyMs?: number;
  readonly remediation?: string;
  readonly state: PreflightState;
}

export interface IntegrationPreflightReport {
  readonly checkedAt: string;
  readonly checks: readonly PreflightCheck[];
  readonly overall: PreflightOverallState;
}

interface JsonResponse<T> {
  readonly data: T;
  readonly latencyMs: number;
  readonly response: Response;
}

interface CheckResult {
  readonly detail: string;
  readonly latencyMs?: number;
  readonly remediation?: string;
  readonly warning?: boolean;
}

export async function runIntegrationPreflight(input: {
  readonly fetcher?: typeof fetch;
  readonly now?: () => Date;
  readonly publicOrigin: string;
  readonly timeoutMs?: number;
}): Promise<IntegrationPreflightReport> {
  const fetcher = input.fetcher ?? fetch;
  const now = input.now ?? (() => new Date());
  const timeoutMs = input.timeoutMs ?? 8_000;
  const publicOrigin = normalizeOrigin(input.publicOrigin);
  const checks: PreflightCheck[] = [];

  checks.push(await check("live", "Core 可达", new URL("/health/live", publicOrigin).toString(), async () => {
    const result = await publicJson<{ readonly status?: string }>(
      new URL("/health/live", publicOrigin).toString(), fetcher, timeoutMs,
    );
    if (!["alive", "ok"].includes(result.data.status ?? "")) {
      throw new Error("存活响应缺少 status=ok");
    }
    return { detail: "Core 进程可从当前浏览器访问。", latencyMs: result.latencyMs };
  }));

  checks.push(await check("ready", "服务就绪", new URL("/health/ready", publicOrigin).toString(), async () => {
    const result = await publicJson<{
      readonly database?: string;
      readonly status?: string;
    }>(new URL("/health/ready", publicOrigin).toString(), fetcher, timeoutMs);
    if (result.data.status !== "ready" || result.data.database !== "ready") {
      throw new Error("Core 或数据库尚未就绪");
    }
    return { detail: "Core 与数据库 readiness 均通过。", latencyMs: result.latencyMs };
  }));

  let capability: Capability | undefined;
  const capabilityEndpoint = new URL("/.well-known/akep", publicOrigin).toString();
  checks.push(await check("capability", "AKEP 能力契约", capabilityEndpoint, async () => {
    const result = await publicJson<Capability>(capabilityEndpoint, fetcher, timeoutMs);
    validateCapability(result.data, publicOrigin, now());
    capability = result.data;
    return {
      detail: `AKEP 0.1、Reader 操作与 ContextPack 已声明；Capability 有效至 ${formatTimestamp(result.data.expiresAt)}。`,
      latencyMs: result.latencyMs,
    };
  }));

  if (capability === undefined) {
    checks.push(dependencyFailure("oauth", "OAuth 资源边界", capabilityEndpoint));
    checks.push(dependencyFailure("schemas", "关键 Schema", capabilityEndpoint));
  } else {
    const trustedCapability = capability;
    checks.push(await check("oauth", "OAuth 资源边界", trustedCapability.auth.protectedResourceMetadata, async () => {
      if (normalizeOrigin(trustedCapability.auth.protectedResourceMetadata) !== normalizeOrigin(trustedCapability.baseUrl)) {
        throw new Error("Protected Resource metadata 必须与 AKEP Base URL 同源");
      }
      const result = await publicJson<{
        readonly authorization_servers?: readonly string[];
        readonly bearer_methods_supported?: readonly string[];
        readonly resource?: string;
        readonly scopes_supported?: readonly string[];
      }>(trustedCapability.auth.protectedResourceMetadata, fetcher, timeoutMs);
      if (normalizeUrl(result.data.resource) !== normalizeUrl(trustedCapability.baseUrl)) {
        throw new Error("Protected Resource metadata 的 resource 与 AKEP Base URL 不一致");
      }
      if (!result.data.bearer_methods_supported?.includes("header")) {
        throw new Error("Protected Resource metadata 未声明 header bearer token");
      }
      const missingScopes = ["akep:query", "akep:read"].filter(
        (scope) => !result.data.scopes_supported?.includes(scope),
      );
      if (missingScopes.length > 0) {
        throw new Error(`Protected Resource metadata 缺少 ${missingScopes.join(", ")}`);
      }
      const hasAuthorizationServer = (result.data.authorization_servers?.length ?? 0) > 0;
      return {
        detail: hasAuthorizationServer
          ? "Resource、bearer method、Reader scopes 与授权服务器声明一致。"
          : "资源与 Reader scopes 正确，但未声明 authorization_servers。",
        latencyMs: result.latencyMs,
        ...(hasAuthorizationServer
          ? {}
          : {
              remediation: "当前适合本地开发或人工配置 token；生产接入前需发布授权服务器。",
              warning: true,
            }),
      };
    }));

    checks.push(await check("schemas", "关键 Schema", "Capability.schemas", async () => {
      const schemaNames = ["query", "context-pack-request", "context-pack"] as const;
      const startedAt = performance.now();
      let missingEtag = false;
      for (const name of schemaNames) {
        const endpoint = trustedCapability.schemas[name];
        if (endpoint === undefined) throw new Error(`Capability 缺少 ${name} Schema`);
        if (normalizeOrigin(endpoint) !== normalizeOrigin(trustedCapability.baseUrl)) {
          throw new Error(`${name} Schema 不在节点公开 Origin`);
        }
        const result = await publicJson<Record<string, unknown>>(endpoint, fetcher, timeoutMs);
        if (typeof result.data !== "object" || result.data === null) {
          throw new Error(`${name} Schema 不是 JSON object`);
        }
        if (result.response.headers.get("etag") === null) missingEtag = true;
      }
      return {
        detail: missingEtag
          ? "Query 与 ContextPack Schema 可读取，但至少一份缺少 ETag。"
          : "Query 与 ContextPack 三份 Schema 均可读取并带 ETag。",
        latencyMs: Math.round(performance.now() - startedAt),
        ...(missingEtag
          ? { remediation: "为 Schema 增加稳定 ETag，便于客户端安全缓存。", warning: true }
          : {}),
      };
    }));
  }

  const overall: PreflightOverallState = checks.some((item) => item.state === "failed")
    ? "failed"
    : checks.some((item) => item.state === "warning")
      ? "warning"
      : "passed";
  return { checkedAt: now().toISOString(), checks, overall };
}

async function check(
  id: PreflightCheck["id"],
  label: string,
  endpoint: string,
  execute: () => Promise<CheckResult>,
): Promise<PreflightCheck> {
  try {
    const result = await execute();
    return {
      detail: result.detail,
      endpoint,
      id,
      label,
      ...(result.latencyMs === undefined ? {} : { latencyMs: result.latencyMs }),
      ...(result.remediation === undefined ? {} : { remediation: result.remediation }),
      state: result.warning === true ? "warning" : "passed",
    };
  } catch (caught) {
    return {
      detail: caught instanceof Error ? caught.message : "未知检查错误",
      endpoint,
      id,
      label,
      remediation: "修复该公开端点或契约后重新运行检查。",
      state: "failed",
    };
  }
}

async function publicJson<T>(
  url: string,
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<JsonResponse<T>> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  try {
    const response = await fetcher(url, {
      cache: "no-store",
      credentials: "omit",
      headers: { Accept: "application/json" },
      method: "GET",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${new URL(url).pathname} 返回 HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLocaleLowerCase().includes("json")) {
      throw new Error(`${new URL(url).pathname} 未返回 JSON`);
    }
    return {
      data: await response.json() as T,
      latencyMs: Math.round(performance.now() - startedAt),
      response,
    };
  } finally {
    window.clearTimeout(timeout);
  }
}

function validateCapability(
  capability: Capability,
  publicOrigin: string,
  now: Date,
): void {
  if (capability.protocol !== "akep" || !Array.isArray(capability.versions) || !capability.versions.includes("0.1")) {
    throw new Error("节点未声明 AKEP 0.1");
  }
  if (typeof capability.baseUrl !== "string" || typeof capability.expiresAt !== "string") {
    throw new Error("Capability 缺少 Base URL 或有效期");
  }
  const expiresAt = Date.parse(capability.expiresAt);
  if (Number.isNaN(expiresAt) || expiresAt <= now.getTime()) {
    throw new Error("Capability 已过期，请刷新节点能力");
  }
  if (normalizeOrigin(capability.baseUrl) !== publicOrigin) {
    throw new Error("Capability Base URL 与当前浏览器公开 Origin 不一致");
  }
  if (!Array.isArray(capability.operations)) {
    throw new Error("Capability 未声明 Reader 操作");
  }
  const missingOperations = ["query", "resolve", "fetch", "receipt"].filter(
    (operation) => !capability.operations.includes(operation),
  );
  if (missingOperations.length > 0) {
    throw new Error(`Reader 缺少 ${missingOperations.join(", ")} 操作`);
  }
  if (!Array.isArray(capability.supportedExtensions)
    || !capability.supportedExtensions.some((item) => typeof item?.uri === "string" && item.uri.includes("/context-pack/"))) {
    throw new Error("节点未声明 ContextPack extension");
  }
  if (typeof capability.auth?.protectedResourceMetadata !== "string") {
    throw new Error("Capability 未声明 OAuth Protected Resource metadata");
  }
}

function dependencyFailure(
  id: PreflightCheck["id"],
  label: string,
  endpoint: string,
): PreflightCheck {
  return {
    detail: "Capability 检查失败，无法安全解析后续端点。",
    endpoint,
    id,
    label,
    remediation: "先修复 Capability Discovery。",
    state: "failed",
  };
}

function normalizeOrigin(value: string): string {
  return new URL(value).origin;
}

function normalizeUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return new URL(value).toString().replace(/\/$/u, "");
}

function formatTimestamp(value: string): string {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed)
    ? value
    : new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(parsed));
}
