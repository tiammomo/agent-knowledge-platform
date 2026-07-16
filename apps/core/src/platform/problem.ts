import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ContractValidationError } from "../contracts/registry.js";

export class ProblemError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    detail: string,
    public readonly type: string = `https://agentknowledge.dev/problems/${code.toLowerCase().replaceAll("_", "-")}`,
  ) {
    super(detail);
    this.name = "ProblemError";
  }
}

function problemTitle(statusCode: number): string {
  switch (statusCode) {
    case 400:
      return "Bad request";
    case 401:
      return "Authentication required";
    case 403:
      return "Access denied";
    case 404:
      return "Resource not found";
    case 409:
      return "Conflict";
    case 410:
      return "Resource expired";
    case 412:
      return "Precondition failed";
    case 413:
      return "Payload too large";
    case 415:
      return "Unsupported media type";
    case 416:
      return "Range not satisfiable";
    case 422:
      return "Contract validation failed";
    case 429:
      return "Too many requests";
    case 503:
      return "Service unavailable";
    default:
      return "Internal server error";
  }
}

function sendProblem(
  reply: FastifyReply,
  request: FastifyRequest,
  problem: ProblemError,
): void {
  // Observability establishes this context before parsing, authentication and
  // route handlers run, so the Problem Details body and Traceparent response
  // always refer to the same server trace.
  const traceId = request.akepTraceContext?.traceId ?? request.id;
  reply
    .code(problem.statusCode)
    .header("AKEP-Version", "0.1")
    .header("Cache-Control", "private, no-store")
    .type("application/problem+json")
    .send({
      code: problem.code,
      detail: problem.message,
      instance: `urn:uuid:${randomUUID()}`,
      status: problem.statusCode,
      title: problemTitle(problem.statusCode),
      traceId,
      type: problem.type,
    });
}

function clientStatusCode(error: unknown): number | undefined {
  if (
    typeof error !== "object" ||
    error === null ||
    !("statusCode" in error) ||
    typeof error.statusCode !== "number"
  ) {
    return undefined;
  }
  return error.statusCode >= 400 && error.statusCode < 500
    ? error.statusCode
    : undefined;
}

export function installErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ProblemError) {
      sendProblem(reply, request, error);
      return;
    }
    if (error instanceof ContractValidationError) {
      const detail = error.errors
        .slice(0, 5)
        .map((entry) => `${entry.instancePath || "/"} ${entry.message ?? "invalid"}`)
        .join("; ");
      sendProblem(
        reply,
        request,
        new ProblemError(422, "AKEP_SCHEMA_INVALID", detail),
      );
      return;
    }
    const statusCode = clientStatusCode(error);
    if (statusCode !== undefined) {
      const code =
        statusCode === 413 ? "AKEP_PAYLOAD_TOO_LARGE" : "AKEP_BAD_REQUEST";
      sendProblem(
        reply,
        request,
        new ProblemError(
          statusCode,
          code,
          "The request could not be parsed or accepted.",
        ),
      );
      return;
    }
    request.log.error({ err: error }, "unhandled request failure");
    sendProblem(
      reply,
      request,
      new ProblemError(
        500,
        "AKEP_INTERNAL_ERROR",
        "The server could not complete the request.",
      ),
    );
  });

  app.setNotFoundHandler((request, reply) => {
    sendProblem(
      reply,
      request,
      new ProblemError(404, "AKEP_NOT_FOUND", "The resource was not found."),
    );
  });
}
