import { createHash, randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import { canonicalJson } from "../contracts/revision.js";
import { hasSpaceAccess } from "../modules/growth/validation.js";
import type { Principal } from "./auth.js";
import { ProblemError } from "./problem.js";

export interface QueryAuthorizationPlan {
  readonly bindingDigest: string;
  readonly decisionId: string;
  readonly policyEpoch: string;
  readonly purpose: string;
  readonly spaceIds?: readonly string[];
  readonly subjectDigest: string;
  readonly tenantId: string;
}

export function authorizeQuery(input: {
  readonly config: AppConfig;
  readonly principal: Principal;
  readonly purpose: string;
  readonly requestedSpaceIds?: readonly string[];
}): QueryAuthorizationPlan {
  if (input.principal.tenantId !== input.config.tenantId) throw policyDenied();

  const spaceIds = resolveSpaceIds(input.principal, input.requestedSpaceIds);
  const binding = {
    obligations: input.principal.supportedObligations
      .map((item) => canonicalJson(item))
      .sort(),
    policyEpoch: input.config.policyEpoch,
    purpose: input.purpose,
    scopes: [...input.principal.scopes].sort(),
    spaceIds: spaceIds ?? "*",
    subjectDigest: input.principal.subjectDigest,
    tenantId: input.principal.tenantId,
  };
  const bindingDigest = `sha256:${createHash("sha256")
    .update(canonicalJson(binding))
    .digest("hex")}`;
  return Object.freeze({
    bindingDigest,
    decisionId: `urn:uuid:${randomUUID()}`,
    policyEpoch: input.config.policyEpoch,
    purpose: input.purpose,
    ...(spaceIds === undefined ? {} : { spaceIds: Object.freeze(spaceIds) }),
    subjectDigest: input.principal.subjectDigest,
    tenantId: input.principal.tenantId,
  });
}

function resolveSpaceIds(
  principal: Principal,
  requestedSpaceIds: readonly string[] | undefined,
): readonly string[] | undefined {
  if (requestedSpaceIds !== undefined) {
    if (requestedSpaceIds.some((spaceId) => !hasSpaceAccess(principal, spaceId))) {
      throw policyDenied();
    }
    return [...new Set(requestedSpaceIds)].sort();
  }
  if (principal.scopes.has("akep:space:*")) return undefined;

  const spaceIds = [...principal.scopes]
    .filter((scope) => scope.startsWith("akep:space:") && scope !== "akep:space:*")
    .flatMap((scope) => {
      try {
        const spaceId = decodeURIComponent(scope.slice("akep:space:".length));
        new URL(spaceId);
        return hasSpaceAccess(principal, spaceId) ? [spaceId] : [];
      } catch {
        return [];
      }
    });
  const unique = [...new Set(spaceIds)].sort();
  if (unique.length === 0) throw policyDenied();
  if (unique.length > 100) {
    throw new ProblemError(
      422,
      "AKEP_QUERY_SCOPE_TOO_BROAD",
      "Select at most 100 authorized Spaces explicitly for this query.",
    );
  }
  return unique;
}

function policyDenied(): ProblemError {
  return new ProblemError(
    403,
    "AKEP_POLICY_DENIED",
    "The caller is not authorized for the requested Tenant and Space scope.",
  );
}
