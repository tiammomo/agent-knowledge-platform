import type { FastifyRequest } from "fastify";
import { canonicalJson } from "../contracts/revision.js";
import type { ContractRegistry } from "../contracts/registry.js";
import { ProblemError } from "./problem.js";

export function requireAKEPVersion(request: FastifyRequest): void {
  if (request.headers["akep-version"] !== "0.1") {
    throw new ProblemError(
      400,
      "AKEP_VERSION_UNSUPPORTED",
      "AKEP-Version: 0.1 is required.",
    );
  }
}

export function requireIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers["idempotency-key"];
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 255 ||
    !/^[A-Za-z0-9._~:/+-]+$/.test(value)
  ) {
    throw new ProblemError(
      400,
      "AKEP_SCHEMA_INVALID",
      "A valid Idempotency-Key header is required.",
    );
  }
  return value;
}

export function requireIfMatch(request: FastifyRequest): string {
  const value = request.headers["if-match"];
  if (typeof value !== "string" || !/^"akep-contribution-[1-9][0-9]*"$/.test(value)) {
    throw new ProblemError(
      412,
      "AKEP_WORKFLOW_PRECONDITION_FAILED",
      "A current contribution ETag is required in If-Match.",
    );
  }
  return value;
}

export function requirePurpose(request: FastifyRequest): string {
  const value = request.headers["akep-purpose"];
  if (
    typeof value !== "string" ||
    !/^[a-z][a-z0-9._:-]{0,127}$/.test(value)
  ) {
    throw new ProblemError(
      400,
      "AKEP_SCHEMA_INVALID",
      "A valid AKEP-Purpose header is required.",
    );
  }
  return value;
}

export function requireObligationSupport(
  request: FastifyRequest,
  contracts: ContractRegistry,
): readonly unknown[] {
  const encoded = request.headers["akep-obligation-support"];
  if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new ProblemError(
      400,
      "AKEP_SCHEMA_INVALID",
      "A valid AKEP-Obligation-Support header is required.",
    );
  }

  let decoded: string;
  let value: unknown;
  try {
    decoded = Buffer.from(encoded, "base64url").toString("utf8");
    value = JSON.parse(decoded) as unknown;
  } catch {
    throw new ProblemError(
      400,
      "AKEP_SCHEMA_INVALID",
      "AKEP-Obligation-Support is not valid base64url JCS JSON.",
    );
  }
  if (!Array.isArray(value) || canonicalJson(value) !== decoded) {
    throw new ProblemError(
      400,
      "AKEP_SCHEMA_INVALID",
      "AKEP-Obligation-Support must encode a canonical JSON array.",
    );
  }
  for (const obligation of value) {
    contracts.assert("common.schema.json#/$defs/obligation", obligation);
  }
  return value;
}
