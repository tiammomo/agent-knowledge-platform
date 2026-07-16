import { ProblemError } from "../../platform/problem.js";
import type { GrowthStore } from "../growth/store.js";
import type { QualityGateDecision } from "./types.js";

interface AttestationGateOptions {
  readonly expectedPayloadDigests?: ReadonlySet<string>;
  readonly requireBenchmark: boolean;
  readonly requiredTypes?: readonly string[];
  readonly trustedMachineIssuer?: string;
}

export async function evaluateAttestationGate(
  store: GrowthStore,
  spaceId: string,
  revisionId: string,
  attestationRefs: readonly string[],
  options: AttestationGateOptions,
  now: Date = new Date(),
): Promise<QualityGateDecision> {
  const refs = [...new Set(attestationRefs)];
  if (refs.length === 0 || refs.length !== attestationRefs.length) {
    throw gateFailure(
      "AKEP_ATTESTATION_INVALID",
      "Quality evidence must contain at least one unique Attestation reference.",
    );
  }

  let benchmarkFound = false;
  let warningFound = false;
  const foundTypes = new Set<string>();
  const reasons: string[] = [];
  for (const reference of refs) {
    const state = await store.getAttestation(spaceId, reference);
    if (state === undefined) {
      throw gateFailure(
        "AKEP_ATTESTATION_NOT_FOUND",
        `Attestation ${reference} is not persisted in this Space.`,
      );
    }
    const statement = state.statement;
    if (
      (statement.type === "schema-validation" || statement.type === "safety-scan") &&
      options.trustedMachineIssuer !== undefined &&
      statement.issuer !== options.trustedMachineIssuer
    ) {
      throw gateFailure(
        "AKEP_ATTESTATION_ISSUER_UNTRUSTED",
        `Machine Attestation ${reference} was not issued by this trusted node.`,
      );
    }
    if (statement.subject.revisionId !== revisionId) {
      throw gateFailure(
        "AKEP_ATTESTATION_TARGET_MISMATCH",
        `Attestation ${reference} targets a different Revision.`,
      );
    }
    if (
      statement.subject.payloadDigest !== undefined &&
      (options.expectedPayloadDigests === undefined ||
        !options.expectedPayloadDigests.has(statement.subject.payloadDigest))
    ) {
      throw gateFailure(
        "AKEP_ATTESTATION_TARGET_MISMATCH",
        `Attestation ${reference} targets an unknown Payload.`,
      );
    }
    const issuedAt = Date.parse(statement.issuedAt);
    const expiresAt = Date.parse(statement.expiresAt);
    if (
      !Number.isFinite(issuedAt) ||
      !Number.isFinite(expiresAt) ||
      issuedAt > now.getTime() + 5 * 60_000 ||
      expiresAt <= now.getTime() ||
      expiresAt <= issuedAt
    ) {
      throw gateFailure(
        "AKEP_ATTESTATION_EXPIRED",
        `Attestation ${reference} is expired or has an invalid validity period.`,
      );
    }
    const outcome = statement.result.outcome;
    if (outcome !== "pass" && outcome !== "warning") {
      throw gateFailure(
        "AKEP_ATTESTATION_FAILED",
        `Attestation ${reference} has non-qualifying outcome ${outcome}.`,
      );
    }
    warningFound ||= outcome === "warning";
    foundTypes.add(statement.type);

    if (statement.type === "benchmark-result") {
      const run = await store.getEvaluationRunByAttestation(reference);
      if (
        run === undefined ||
        run.run.status !== "completed" ||
        run.run.spaceId !== spaceId ||
        run.run.subject.revisionId !== revisionId ||
        run.run.attestationId !== reference ||
        run.run.gate.outcome !== outcome
      ) {
        throw gateFailure(
          "AKEP_EVALUATION_RUN_INVALID",
          `Benchmark Attestation ${reference} is not backed by a matching completed EvaluationRun.`,
        );
      }
      benchmarkFound = true;
      warningFound ||= run.run.gate.outcome === "warning";
      reasons.push(...run.run.gate.reasons);
    }
    reasons.push(
      statement.result.summary?.trim() ||
        `${statement.type} issued by ${statement.issuer}: ${outcome}`,
    );
  }

  if (options.requireBenchmark && !benchmarkFound) {
    throw gateFailure(
      "AKEP_EVALUATION_REQUIRED",
      "Publication requires a completed EvaluationRun benchmark Attestation.",
    );
  }
  const missingTypes = [...new Set(options.requiredTypes ?? [])]
    .filter((type) => !foundTypes.has(type));
  if (missingTypes.length > 0) {
    throw gateFailure(
      "AKEP_ATTESTATION_REQUIRED",
      `Profile-required Attestations are missing: ${missingTypes.join(", ")}.`,
    );
  }
  return {
    attestationRefs: refs,
    decision: warningFound ? "suitable_with_warning" : "suitable",
    reasons: [...new Set(reasons)],
  };
}

function gateFailure(code: string, detail: string): ProblemError {
  return new ProblemError(409, code, detail);
}
