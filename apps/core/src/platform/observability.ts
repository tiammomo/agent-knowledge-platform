import { randomBytes } from "node:crypto";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  context,
  isSpanContextValid,
  trace,
  type Span,
  type SpanContext,
} from "@opentelemetry/api";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";
import { authenticate } from "./auth.js";
import { requireAKEPVersion } from "./headers.js";

declare module "fastify" {
  interface FastifyRequest {
    /** The server span context used for response propagation and Problem Details. */
    akepTraceContext?: RequestTraceContext;
  }
}

export interface RequestTraceContext {
  readonly spanId: string;
  readonly traceFlags: TraceFlags;
  readonly traceId: string;
}

interface RouteMetric {
  clientErrors: number;
  requests: number;
  serverErrors: number;
  totalMilliseconds: number;
}

export interface ServiceMetricsSnapshot {
  readonly clientErrors: number;
  readonly errorRate: number;
  readonly eventLoopP95Milliseconds: number;
  readonly p50Milliseconds: number;
  readonly p95Milliseconds: number;
  readonly requestCount: number;
  readonly serverErrors: number;
}

const MAX_SAMPLES = 4096;
const HTTP_METHODS = new Set([
  "CONNECT",
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
  "TRACE",
]);

export function installObservability(app: FastifyInstance, config: AppConfig): void {
  const starts = new WeakMap<FastifyRequest, number>();
  const spans = new WeakMap<FastifyRequest, Span>();
  const durations: number[] = [];
  const routes = new Map<string, RouteMetric>();
  const eventLoop = monitorEventLoopDelay({ resolution: 20 });
  eventLoop.enable();
  app.decorateRequest("akepTraceContext", undefined);

  app.addHook("onRequest", (request, reply, done) => {
    starts.set(request, performance.now());
    const operation = requestOperationName(request);
    const remoteParent = parseTraceParent(request.headers.traceparent);
    const parentContext = remoteParent === undefined
      ? ROOT_CONTEXT
      : trace.setSpanContext(ROOT_CONTEXT, remoteParent);
    let span = trace.getTracer(config.serviceName).startSpan(
      operation,
      { kind: SpanKind.SERVER },
      parentContext,
    );
    let spanContext = span.spanContext();
    // buildApplication() is also used without starting the SDK (tests and
    // embedded use). Keep the request context standards-compliant in that
    // mode without claiming that the request-id is an OTel identifier.
    if (
      !isSpanContextValid(spanContext) ||
      (remoteParent !== undefined && spanContext.spanId === remoteParent.spanId)
    ) {
      spanContext = createLocalSpanContext(remoteParent);
      span = trace.wrapSpanContext(spanContext);
    }
    span.setAttribute("http.request.method", safeMethod(request.method));
    span.setAttribute("http.route", routeTemplate(request));
    spans.set(request, span);
    request.akepTraceContext = Object.freeze({
      spanId: spanContext.spanId,
      traceFlags: spanContext.traceFlags,
      traceId: spanContext.traceId,
    });
    reply
      .header("X-Request-Id", request.id)
      .header("Traceparent", formatTraceParent(spanContext));

    // Calling the next Fastify lifecycle callback inside the server-span
    // context makes any downstream OTel spans children of this request.
    context.with(trace.setSpan(parentContext, span), done);
  });

  app.addHook("onError", async (request, _reply, error) => {
    const span = spans.get(request);
    span?.recordException(error);
    span?.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  });

  app.addHook("onResponse", async (request, reply) => {
    const elapsed = Math.max(performance.now() - (starts.get(request) ?? performance.now()), 0);
    durations.push(elapsed);
    if (durations.length > MAX_SAMPLES) durations.shift();
    const key = requestOperationName(request);
    const metric = routes.get(key) ?? {
      clientErrors: 0,
      requests: 0,
      serverErrors: 0,
      totalMilliseconds: 0,
    };
    metric.requests += 1;
    metric.totalMilliseconds += elapsed;
    if (reply.statusCode >= 500) metric.serverErrors += 1;
    else if (reply.statusCode >= 400) metric.clientErrors += 1;
    routes.set(key, metric);
    const span = spans.get(request);
    span?.updateName(key);
    span?.setAttribute("http.route", routeTemplate(request));
    span?.setAttribute("http.response.status_code", reply.statusCode);
    span?.setAttribute("akep.policy_epoch", config.policyEpoch);
    span?.setStatus({
      code: reply.statusCode >= 500 ? SpanStatusCode.ERROR : SpanStatusCode.OK,
    });
    span?.end();
  });

  const snapshot = (): ServiceMetricsSnapshot => {
    const values = [...durations].sort((left, right) => left - right);
    const requestCount = [...routes.values()].reduce((sum, metric) => sum + metric.requests, 0);
    const serverErrors = [...routes.values()].reduce((sum, metric) => sum + metric.serverErrors, 0);
    const clientErrors = [...routes.values()].reduce((sum, metric) => sum + metric.clientErrors, 0);
    return {
      clientErrors,
      errorRate: requestCount === 0 ? 0 : serverErrors / requestCount,
      eventLoopP95Milliseconds: eventLoop.percentile(95) / 1_000_000,
      p50Milliseconds: percentile(values, 0.5),
      p95Milliseconds: percentile(values, 0.95),
      requestCount,
      serverErrors,
    };
  };

  app.get("/console/v1/service-health", async (request, reply) => {
    requireAKEPVersion(request);
    authenticate(request, "akep:console");
    const current = snapshot();
    return reply.header("Cache-Control", "private, no-store").send({
      generatedAt: new Date().toISOString(),
      objective: {
        errorRateMaximum: 0.01,
        p95Milliseconds: config.sloP95Milliseconds,
      },
      status:
        current.errorRate <= 0.01 && current.p95Milliseconds <= config.sloP95Milliseconds
          ? "meeting_objective"
          : "degraded",
      window: current,
    });
  });

  app.get("/metrics", async (request, reply) => {
    requireAKEPVersion(request);
    authenticate(request, "akep:observe");
    const current = snapshot();
    const lines = [
      "# HELP akep_http_requests_total HTTP requests observed by this process.",
      "# TYPE akep_http_requests_total counter",
      `akep_http_requests_total ${current.requestCount}`,
      "# HELP akep_http_server_errors_total HTTP 5xx responses observed by this process.",
      "# TYPE akep_http_server_errors_total counter",
      `akep_http_server_errors_total ${current.serverErrors}`,
      "# HELP akep_http_request_duration_p95_milliseconds Rolling request duration p95.",
      "# TYPE akep_http_request_duration_p95_milliseconds gauge",
      `akep_http_request_duration_p95_milliseconds ${current.p95Milliseconds}`,
      "# HELP akep_event_loop_delay_p95_milliseconds Event loop delay p95.",
      "# TYPE akep_event_loop_delay_p95_milliseconds gauge",
      `akep_event_loop_delay_p95_milliseconds ${current.eventLoopP95Milliseconds}`,
      ...[...routes.entries()].flatMap(([route, metric]) => {
        const escaped = route.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
        return [
          `akep_http_route_requests_total{route="${escaped}"} ${metric.requests}`,
          `akep_http_route_duration_milliseconds_sum{route="${escaped}"} ${metric.totalMilliseconds}`,
        ];
      }),
      "",
    ];
    return reply
      .header("Cache-Control", "no-store")
      .type("text/plain; version=0.0.4; charset=utf-8")
      .send(lines.join("\n"));
  });

  app.addHook("onClose", async () => {
    eventLoop.disable();
  });
}

/**
 * Returns a bounded operation name. Route templates are application-owned;
 * neither query strings nor attacker-controlled unmatched paths are admitted.
 */
export function requestOperationName(
  request: Pick<FastifyRequest, "is404" | "method" | "routeOptions">,
): string {
  return `${safeMethod(request.method)} ${routeTemplate(request)}`;
}

function routeTemplate(
  request: Pick<FastifyRequest, "is404" | "routeOptions">,
): string {
  if (request.is404) return "UNMATCHED";
  const template = request.routeOptions.url;
  return typeof template === "string" && template.length > 0
    ? template
    : "UNMATCHED";
}

function safeMethod(method: string): string {
  const normalized = method.toUpperCase();
  return HTTP_METHODS.has(normalized) ? normalized : "OTHER";
}

function parseTraceParent(value: string | string[] | undefined): SpanContext | undefined {
  if (typeof value !== "string" || value.length > 512) return undefined;
  const parts = value.split("-");
  if (parts.length < 4) return undefined;
  const [version, traceId, spanId, flags, ...futureFields] = parts;
  if (
    version === undefined ||
    traceId === undefined ||
    spanId === undefined ||
    flags === undefined ||
    !/^[0-9a-f]{2}$/u.test(version) ||
    version === "ff" ||
    !/^[0-9a-f]{32}$/u.test(traceId) ||
    traceId === "00000000000000000000000000000000" ||
    !/^[0-9a-f]{16}$/u.test(spanId) ||
    spanId === "0000000000000000" ||
    !/^[0-9a-f]{2}$/u.test(flags) ||
    (version === "00" && futureFields.length > 0) ||
    futureFields.some((field) => !/^[0-9a-f]+$/u.test(field))
  ) {
    return undefined;
  }
  return {
    isRemote: true,
    spanId,
    traceFlags: Number.parseInt(flags, 16) & TraceFlags.SAMPLED,
    traceId,
  };
}

function createLocalSpanContext(remoteParent: SpanContext | undefined): SpanContext {
  return {
    isRemote: false,
    spanId: randomNonZeroHex(8),
    traceFlags: remoteParent?.traceFlags ?? TraceFlags.SAMPLED,
    traceId: remoteParent?.traceId ?? randomNonZeroHex(16),
  };
}

function randomNonZeroHex(bytes: number): string {
  let value = randomBytes(bytes).toString("hex");
  while (/^0+$/u.test(value)) value = randomBytes(bytes).toString("hex");
  return value;
}

function formatTraceParent(spanContext: SpanContext): string {
  const flags = (spanContext.traceFlags & 0xff).toString(16).padStart(2, "0");
  return `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`;
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(Math.ceil(sorted.length * fraction) - 1, sorted.length - 1);
  return Number((sorted[Math.max(index, 0)] ?? 0).toFixed(3));
}
