import { ProblemError } from "../../platform/problem.js";
import type {
  EvaluationGateCheck,
  EvaluationRunRequest,
  EvaluationThreshold,
} from "./types.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REVISION_ID = /^urn:akep:sha256:[a-f0-9]{64}$/;
const METRIC_NAME = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const MAX_EVIDENCE_TTL_MS = 90 * 24 * 60 * 60_000;

const RUN_FIELDS = new Set([
  "akepVersion",
  "clientRunId",
  "completedAt",
  "critical",
  "dataset",
  "evaluator",
  "evidenceRefs",
  "expiresAt",
  "metrics",
  "revisionId",
  "spaceId",
  "startedAt",
  "summary",
  "thresholds",
]);

export function parseEvaluationRunRequest(value: unknown): EvaluationRunRequest {
  const body = requireObject(value, "EvaluationRun request");
  for (const key of Object.keys(body)) {
    if (!RUN_FIELDS.has(key)) invalid(`Unknown EvaluationRun field: ${key}.`);
  }
  if (body.akepVersion !== "0.1") invalid("akepVersion must be 0.1.");
  const clientRunId = requireUri(body.clientRunId, "clientRunId");
  const spaceId = requireUri(body.spaceId, "spaceId");
  const revisionId = requireString(body.revisionId, "revisionId");
  if (!REVISION_ID.test(revisionId)) invalid("revisionId is not an AKEP SHA-256 revision ID.");
  const startedAt = requireTimestamp(body.startedAt, "startedAt");
  const completedAt = requireTimestamp(body.completedAt, "completedAt");
  const expiresAt = requireTimestamp(body.expiresAt, "expiresAt");
  if (Date.parse(completedAt) < Date.parse(startedAt)) {
    invalid("completedAt must not precede startedAt.");
  }
  if (Date.parse(completedAt) > Date.now() + 5 * 60_000) {
    invalid("completedAt cannot be materially in the future.");
  }
  if (Date.parse(expiresAt) <= Math.max(Date.parse(completedAt), Date.now())) {
    invalid("expiresAt must be later than the completion time and current time.");
  }
  if (Date.parse(expiresAt) - Date.parse(completedAt) > MAX_EVIDENCE_TTL_MS) {
    invalid("Evaluation evidence cannot remain valid for more than 90 days.");
  }
  const critical = requireStringArray(body.critical, "critical", 100);
  if (critical.length !== 0) {
    invalid("Critical EvaluationRun extensions are not supported.");
  }
  const evidenceRefs = requireUriArray(body.evidenceRefs, "evidenceRefs", 1_000);
  const metrics = requireMetrics(body.metrics);
  const thresholds = requireThresholds(body.thresholds, metrics);
  const summary = requireString(body.summary, "summary");
  if (summary.length > 5_000) invalid("summary exceeds 5000 characters.");
  return {
    akepVersion: "0.1",
    clientRunId,
    completedAt,
    critical,
    dataset: requireSchemaReference(body.dataset, "dataset"),
    evaluator: requireSchemaReference(body.evaluator, "evaluator"),
    evidenceRefs,
    expiresAt,
    metrics,
    revisionId,
    spaceId,
    startedAt,
    summary,
    thresholds,
  };
}

export function computeEvaluationGate(
  metrics: Readonly<Record<string, number>>,
  thresholds: Readonly<Record<string, EvaluationThreshold>>,
): {
  readonly checks: readonly EvaluationGateCheck[];
  readonly outcome: "pass" | "warning" | "fail";
  readonly reasons: readonly string[];
} {
  const checks = Object.entries(thresholds)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([metric, threshold]) => {
      const actual = metrics[metric]!;
      const required = threshold.required ?? true;
      const passed =
        threshold.operator === "gte"
          ? actual >= threshold.value
          : actual <= threshold.value;
      return {
        actual,
        metric,
        operator: threshold.operator,
        passed,
        required,
        threshold: threshold.value,
      } satisfies EvaluationGateCheck;
    });
  const requiredFailure = checks.some((check) => check.required && !check.passed);
  const advisoryFailure = checks.some((check) => !check.required && !check.passed);
  const outcome = requiredFailure ? "fail" : advisoryFailure ? "warning" : "pass";
  const reasons = checks.map(
    (check) =>
      `${check.metric}: ${check.actual} ${check.operator} ${check.threshold} ` +
      `(${check.required ? "required" : "advisory"}) ${check.passed ? "passed" : "failed"}`,
  );
  return { checks, outcome, reasons };
}

function requireMetrics(value: unknown): Readonly<Record<string, number>> {
  const metrics = requireObject(value, "metrics");
  const entries = Object.entries(metrics);
  if (entries.length < 1 || entries.length > 100) {
    invalid("metrics must contain between 1 and 100 values.");
  }
  const result: Record<string, number> = {};
  for (const [name, metric] of entries) {
    if (!METRIC_NAME.test(name) || typeof metric !== "number" || !Number.isFinite(metric)) {
      invalid(`Metric ${name} must have a valid name and a finite numeric value.`);
    }
    result[name] = metric;
  }
  return result;
}

function requireThresholds(
  value: unknown,
  metrics: Readonly<Record<string, number>>,
): Readonly<Record<string, EvaluationThreshold>> {
  const thresholds = requireObject(value, "thresholds");
  const entries = Object.entries(thresholds);
  if (entries.length < 1 || entries.length > 100) {
    invalid("thresholds must contain between 1 and 100 checks.");
  }
  const result: Record<string, EvaluationThreshold> = {};
  for (const [name, raw] of entries) {
    if (!Object.hasOwn(metrics, name)) invalid(`Threshold ${name} has no matching metric.`);
    const threshold = requireObject(raw, `thresholds.${name}`);
    for (const key of Object.keys(threshold)) {
      if (!["operator", "required", "value"].includes(key)) {
        invalid(`Unknown thresholds.${name} field: ${key}.`);
      }
    }
    if (!['gte', 'lte'].includes(threshold.operator as string)) {
      invalid(`thresholds.${name}.operator must be gte or lte.`);
    }
    if (typeof threshold.value !== "number" || !Number.isFinite(threshold.value)) {
      invalid(`thresholds.${name}.value must be finite.`);
    }
    if (threshold.required !== undefined && typeof threshold.required !== "boolean") {
      invalid(`thresholds.${name}.required must be boolean.`);
    }
    result[name] = {
      operator: threshold.operator as EvaluationThreshold["operator"],
      ...(threshold.required === undefined
        ? {}
        : { required: threshold.required as boolean }),
      value: threshold.value,
    };
  }
  return result;
}

function requireSchemaReference(value: unknown, name: string) {
  const reference = requireObject(value, name);
  for (const key of Object.keys(reference)) {
    if (!["digest", "uri"].includes(key)) invalid(`Unknown ${name} field: ${key}.`);
  }
  const digest = requireString(reference.digest, `${name}.digest`);
  if (!DIGEST.test(digest)) invalid(`${name}.digest must be a SHA-256 digest.`);
  return { digest, uri: requireUri(reference.uri, `${name}.uri`) };
}

function requireUriArray(value: unknown, name: string, max: number): readonly string[] {
  const items = requireStringArray(value, name, max).map((item) => requireUri(item, name));
  if (new Set(items).size !== items.length) invalid(`${name} must contain unique values.`);
  return items;
}

function requireStringArray(value: unknown, name: string, max: number): readonly string[] {
  if (!Array.isArray(value) || value.length > max) invalid(`${name} must be an array.`);
  return value.map((item) => requireString(item, name));
}

function requireTimestamp(value: unknown, name: string): string {
  const timestamp = requireString(value, name);
  if (!Number.isFinite(Date.parse(timestamp)) || !/[zZ]|[+-]\d\d:\d\d$/.test(timestamp)) {
    invalid(`${name} must be an RFC 3339 timestamp with an offset.`);
  }
  return new Date(timestamp).toISOString();
}

function requireUri(value: unknown, name: string): string {
  const uri = requireString(value, name);
  if (uri.length > 2_048) invalid(`${name} exceeds 2048 characters.`);
  try {
    return new URL(uri).toString();
  } catch {
    invalid(`${name} must be an absolute URI.`);
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 10_000) {
    invalid(`${name} must be a non-empty string.`);
  }
  return value;
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function invalid(detail: string): never {
  throw new ProblemError(422, "AKEP_SCHEMA_INVALID", detail);
}
