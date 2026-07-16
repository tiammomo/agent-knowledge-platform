import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../../config.js";
import { canonicalJson, computeRevisionId, sha256Digest } from "../../contracts/revision.js";
import { ProblemError } from "../../platform/problem.js";
import type { Principal } from "../../platform/auth.js";
import type {
  AssetManifest,
  ContributionRequest,
  InlinePayload,
  PayloadDocument,
  PublishedAsset,
} from "./types.js";

export interface ProfileDocument {
  readonly allowedRelations: readonly string[];
  readonly assetType: string;
  readonly primaryPayload: {
    readonly languages?: readonly string[];
    readonly mediaTypes: readonly string[];
  };
  readonly profileId: string;
  readonly requiredAttestations: readonly string[];
  readonly requiredManifestFields: readonly string[];
  readonly scopeRequirements: readonly string[];
  readonly [key: string]: unknown;
}

export interface SupportedProfile {
  readonly assetType: string;
  readonly digest: string;
  readonly document: ProfileDocument;
}

export function supportedProfiles(config: AppConfig): ReadonlyMap<string, SupportedProfile> {
  const profiles = new Map<string, SupportedProfile>();
  for (const file of ["mvp-source-document-v1.json", "mvp-procedure-v1.json"]) {
    const document = JSON.parse(
      readFileSync(join(config.contractRoot, "profiles", file), "utf8"),
    ) as ProfileDocument;
    profiles.set(document.profileId, {
      assetType: document.assetType,
      digest: sha256Digest(canonicalJson(document)),
      document,
    });
  }
  return profiles;
}

export function validateContribution(
  request: ContributionRequest,
  profiles: ReadonlyMap<string, SupportedProfile>,
): { readonly payloads: readonly PayloadDocument[]; readonly subjectRevisionId: string } {
  if (request.kind !== "create" && request.kind !== "revise") {
    return { payloads: [], subjectRevisionId: request.targetRevisionId! };
  }
  const manifest = request.manifest!;
  const revisionId = computeRevisionId(manifest);
  if (request.revisionId !== revisionId) {
    throw new ProblemError(
      422,
      "AKEP_REVISION_ID_MISMATCH",
      "revisionId does not match the RFC 8785 canonical Manifest digest.",
    );
  }
  const supported = profiles.get(manifest.profile.uri);
  if (
    supported === undefined ||
    supported.digest !== manifest.profile.digest ||
    supported.assetType !== manifest.assetType
  ) {
    throw new ProblemError(
      422,
      "AKEP_PROFILE_UNSUPPORTED",
      "The Manifest must use an enabled Profile with its exact digest and asset type.",
    );
  }
  validateProfileManifest(manifest, supported.document);
  validateGovernanceFloor(manifest);
  validateLinearParents(request, manifest);
  if (request.kind === "revise") {
    const parents = new Set((manifest.parents as readonly string[] | undefined) ?? []);
    const bases = new Set(request.baseRevisionIds ?? []);
    if (
      parents.size !== bases.size ||
      [...parents].some((revision) => !bases.has(revision))
    ) {
      throw new ProblemError(
        422,
        "AKEP_BASE_REVISION_MISMATCH",
        "baseRevisionIds must exactly match the new Manifest parents.",
      );
    }
  }
  return {
    payloads: validatePayloads(
      manifest,
      request.inlinePayloads ?? [],
      supported.document,
    ),
    subjectRevisionId: revisionId,
  };
}

function validateProfileManifest(
  manifest: AssetManifest,
  profile: ProfileDocument,
): void {
  const requiredPointers = new Set([
    ...profile.requiredManifestFields,
    ...profile.scopeRequirements,
  ]);
  for (const pointer of requiredPointers) {
    if (!hasJsonPointer(manifest, pointer)) {
      throw profileViolation(
        `Profile ${profile.profileId} requires Manifest field ${pointer}.`,
      );
    }
  }

  const primary = manifest.payloads.find((payload) => payload.name === "primary");
  if (primary === undefined) {
    throw profileViolation("The Profile requires exactly one primary Payload descriptor.");
  }
  if (!isAllowedMediaType(primary.mediaType, profile.primaryPayload.mediaTypes)) {
    throw profileViolation(
      `Primary Payload media type ${primary.mediaType} is not allowed by Profile ${profile.profileId}.`,
    );
  }
  const allowedLanguages = profile.primaryPayload.languages;
  if (
    allowedLanguages !== undefined &&
    allowedLanguages.length > 0 &&
    (primary.language === undefined ||
      !allowedLanguages.some((language) =>
        language.localeCompare(primary.language!, undefined, { sensitivity: "accent" }) === 0
      ))
  ) {
    throw profileViolation(
      `Primary Payload language ${primary.language ?? "(missing)"} is not allowed by Profile ${profile.profileId}.`,
    );
  }

  const allowedRelations = new Set(profile.allowedRelations);
  for (const relation of manifest.relations ?? []) {
    const relationType = relation.type;
    if (typeof relationType !== "string" || !allowedRelations.has(relationType)) {
      throw profileViolation(
        `Relation type ${typeof relationType === "string" ? relationType : "(missing)"} is not allowed by Profile ${profile.profileId}.`,
      );
    }
  }

  const scope = manifest.scope as { readonly reviewAfter?: unknown } | undefined;
  if (scope?.reviewAfter !== undefined) {
    const reviewAfter = typeof scope.reviewAfter === "string"
      ? Date.parse(scope.reviewAfter)
      : Number.NaN;
    if (!Number.isFinite(reviewAfter) || reviewAfter <= Date.now()) {
      throw profileViolation(
        "scope.reviewAfter must be a future timestamp when the candidate is submitted.",
      );
    }
  }
}

function validateLinearParents(
  request: ContributionRequest,
  manifest: AssetManifest,
): void {
  const parents = (manifest.parents as readonly string[] | undefined) ?? [];
  const bases = request.baseRevisionIds ?? [];
  if (parents.length > 1 || bases.length > 1) {
    throw new ProblemError(
      422,
      "AKEP_MERGE_UNSUPPORTED",
      "The current review workflow accepts at most one parent revision.",
    );
  }
}

function validateGovernanceFloor(manifest: AssetManifest): void {
  const policy = manifest.policy;
  const scope = manifest.scope as { readonly jurisdiction?: unknown } | undefined;
  const licenses = policy.licenses;
  if (policy.classification !== "internal") {
    throw profileViolation(
      "The Phase 1 governance floor accepts only Company Internal knowledge.",
    );
  }
  if (scope?.jurisdiction !== "CN") {
    throw profileViolation(
      "The Phase 1 governance floor requires scope.jurisdiction to be CN.",
    );
  }
  if (
    !Array.isArray(licenses) ||
    licenses.length !== 1 ||
    licenses[0] !== "LicenseRef-Company-Internal"
  ) {
    throw profileViolation(
      "The Phase 1 governance floor accepts only LicenseRef-Company-Internal.",
    );
  }
  if (policy.export !== "deny") {
    throw profileViolation(
      "The Phase 1 governance floor requires policy.export=deny.",
    );
  }
}

function validatePayloads(
  manifest: AssetManifest,
  inlinePayloads: readonly InlinePayload[],
  profile: ProfileDocument,
): readonly PayloadDocument[] {
  if (manifest.payloads.length > 20) {
    throw new ProblemError(
      422,
      "AKEP_MVP_PAYLOAD_LIMIT",
      "The initial synchronous contribution path supports at most 20 payloads.",
    );
  }
  const inlineByName = new Map(inlinePayloads.map((payload) => [payload.name, payload]));
  if (inlineByName.size !== inlinePayloads.length) {
    throw new ProblemError(422, "AKEP_PAYLOAD_INVALID", "Inline payload names must be unique.");
  }
  const documents: PayloadDocument[] = [];
  for (const descriptor of manifest.payloads) {
    validateSynchronousMediaType(descriptor.name, descriptor.mediaType, profile);
    const inline = inlineByName.get(descriptor.name);
    if (inline === undefined) {
      throw new ProblemError(
        422,
        "AKEP_PAYLOAD_REQUIRED",
        `The Phase 1 synchronous path requires inline payload ${descriptor.name}.`,
      );
    }
    if (!isCanonicalBase64(inline.data)) {
      throw new ProblemError(
        422,
        "AKEP_PAYLOAD_INVALID",
        `Inline payload ${descriptor.name} is not canonical base64.`,
      );
    }
    const bytes = Buffer.from(inline.data, "base64");
    const digest = sha256Digest(bytes);
    if (
      inline.digest !== descriptor.digest ||
      digest !== descriptor.digest ||
      bytes.byteLength !== descriptor.size
    ) {
      throw new ProblemError(
        422,
        "AKEP_PAYLOAD_DIGEST_MISMATCH",
        `Inline payload ${descriptor.name} does not match its Manifest descriptor.`,
      );
    }
    assertUtf8(descriptor.name, bytes);
    documents.push({
      data: inline.data,
      digest,
      mediaType: descriptor.mediaType,
      name: descriptor.name,
      size: descriptor.size,
    });
  }
  if (documents.length !== inlinePayloads.length) {
    throw new ProblemError(
      422,
      "AKEP_PAYLOAD_INVALID",
      "Every inline payload must have a matching Manifest descriptor.",
    );
  }
  return documents;
}

function validateSynchronousMediaType(
  payloadName: string,
  mediaType: string,
  profile: ProfileDocument,
): void {
  const parsed = parseMediaType(mediaType);
  if (parsed.essence === "application/pdf") {
    throw new ProblemError(
      422,
      "AKEP_INGESTION_REQUIRED",
      `Payload ${payloadName} is a PDF and must use the asynchronous ingestion pipeline.`,
    );
  }
  if (!isAllowedMediaType(mediaType, profile.primaryPayload.mediaTypes)) {
    throw profileViolation(
      `Payload ${payloadName} media type ${mediaType} is not allowed by Profile ${profile.profileId}.`,
    );
  }
  if (!parsed.essence.startsWith("text/") || parsed.charset !== "utf-8") {
    throw new ProblemError(
      422,
      "AKEP_INGESTION_REQUIRED",
      `Payload ${payloadName} must be allowlisted text/* with an explicit UTF-8 charset on the synchronous path.`,
    );
  }
}

function assertUtf8(payloadName: string, bytes: Uint8Array): void {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProblemError(
      422,
      "AKEP_PAYLOAD_UTF8_INVALID",
      `Inline payload ${payloadName} is not valid UTF-8 text.`,
    );
  }
}

function isAllowedMediaType(
  mediaType: string,
  allowedMediaTypes: readonly string[],
): boolean {
  const normalized = normalizeMediaType(mediaType);
  return allowedMediaTypes.some((allowed) => normalizeMediaType(allowed) === normalized);
}

function normalizeMediaType(value: string): string {
  const [rawEssence = "", ...rawParameters] = value.split(";");
  const parameters = rawParameters
    .map((parameter) => {
      const separator = parameter.indexOf("=");
      if (separator < 0) return parameter.trim().toLocaleLowerCase("en-US");
      const name = parameter.slice(0, separator).trim().toLocaleLowerCase("en-US");
      const rawValue = parameter.slice(separator + 1).trim();
      const normalizedValue = name === "charset"
        ? rawValue.toLocaleLowerCase("en-US")
        : rawValue;
      return `${name}=${normalizedValue}`;
    })
    .filter(Boolean)
    .sort();
  return [rawEssence.trim().toLocaleLowerCase("en-US"), ...parameters].join(";");
}

function parseMediaType(value: string): {
  readonly charset?: string;
  readonly essence: string;
} {
  const [rawEssence = "", ...rawParameters] = value.split(";");
  let charset: string | undefined;
  for (const parameter of rawParameters) {
    const separator = parameter.indexOf("=");
    if (separator < 0) continue;
    const name = parameter.slice(0, separator).trim().toLocaleLowerCase("en-US");
    if (name === "charset") {
      charset = parameter
        .slice(separator + 1)
        .trim()
        .replace(/^"|"$/gu, "")
        .toLocaleLowerCase("en-US");
    }
  }
  return {
    ...(charset === undefined ? {} : { charset }),
    essence: rawEssence.trim().toLocaleLowerCase("en-US"),
  };
}

function hasJsonPointer(document: unknown, pointer: string): boolean {
  if (!pointer.startsWith("/")) return false;
  let current: unknown = document;
  for (const rawSegment of pointer.slice(1).split("/")) {
    if (typeof current !== "object" || current === null) return false;
    const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!Object.hasOwn(current, segment)) return false;
    current = (current as Record<string, unknown>)[segment];
  }
  return current !== undefined;
}

function profileViolation(detail: string): ProblemError {
  return new ProblemError(422, "AKEP_PROFILE_VIOLATION", detail);
}

function isCanonicalBase64(value: string): boolean {
  if (value === "") return true;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}

export function sanitizedContributionRequest(
  request: ContributionRequest,
): ContributionRequest {
  const { inlinePayloads: _inlinePayloads, ...safe } = request;
  return safe;
}

export function canConsume(
  asset: PublishedAsset,
  purpose: string,
  supportedObligations: readonly unknown[],
  principal: Principal,
  now = Date.now(),
): boolean {
  if (["revoked", "erased"].includes(asset.status)) return false;
  if (!hasSpaceAccess(principal, asset.spaceId)) return false;
  const classification = asset.manifest.policy.classification;
  if (typeof classification !== "string" || !hasClassification(principal, classification)) {
    return false;
  }
  const scope = asset.manifest.scope as
    | {
        readonly reviewAfter?: unknown;
        readonly validFrom?: unknown;
        readonly validUntil?: unknown;
      }
    | undefined;
  if (
    (typeof scope?.validFrom === "string" && Date.parse(scope.validFrom) > now) ||
    (typeof scope?.validUntil === "string" && Date.parse(scope.validUntil) <= now) ||
    // reviewAfter is a fail-closed revalidation deadline, not descriptive
    // metadata. Once reached, body/query consumption stops until a new
    // Revision has been independently reviewed and published.
    (typeof scope?.reviewAfter === "string" && Date.parse(scope.reviewAfter) <= now)
  ) {
    return false;
  }
  const retentionUntil = asset.manifest.policy.retentionUntil;
  if (typeof retentionUntil === "string" && Date.parse(retentionUntil) <= now) {
    return false;
  }
  if (!policiesAreAuthorized(principal, asset.manifest.policy.accessPolicyRefs)) {
    return false;
  }
  if (!policiesAreAuthorized(principal, asset.manifest.policy.usagePolicyRefs)) {
    return false;
  }
  const allowedPurposes = asset.manifest.policy.allowedPurposes;
  if (allowedPurposes !== undefined && !allowedPurposes.includes(purpose)) return false;
  // Request bodies/headers describe what this invocation is prepared to do;
  // they cannot grant capabilities. Only obligations signed into the
  // authenticated Principal are trusted, so the effective support set is the
  // intersection of both inputs.
  const trusted = new Set(
    principal.supportedObligations.map((item) => canonicalJson(item)),
  );
  const supported = new Set(
    supportedObligations
      .map((item) => canonicalJson(item))
      .filter((item) => trusted.has(item)),
  );
  return (asset.manifest.policy.obligations ?? []).every((item) =>
    supported.has(canonicalJson(item)),
  );
}

/**
 * Authorizes a Record/status lookup without authorizing Manifest or Payload
 * disclosure. This keeps revoked/erased tombstones visible to an otherwise
 * authorized caller while body consumption remains fail-closed.
 */
export function canResolveMetadata(
  asset: PublishedAsset,
  purpose: string,
  supportedObligations: readonly unknown[],
  principal: Principal,
): boolean {
  if (!hasSpaceAccess(principal, asset.spaceId)) return false;
  const policy = asset.manifest.policy;
  const classification = policy.classification;
  if (typeof classification !== "string" || !hasClassification(principal, classification)) {
    return false;
  }
  if (!policiesAreAuthorized(principal, policy.accessPolicyRefs)) return false;
  if (!policiesAreAuthorized(principal, policy.usagePolicyRefs)) return false;
  if (policy.allowedPurposes !== undefined && !policy.allowedPurposes.includes(purpose)) {
    return false;
  }
  const trusted = new Set(
    principal.supportedObligations.map((item) => canonicalJson(item)),
  );
  const declared = new Set(
    supportedObligations.map((item) => canonicalJson(item)),
  );
  return (policy.obligations ?? []).every((item) => {
    const canonical = canonicalJson(item);
    return trusted.has(canonical) && declared.has(canonical);
  });
}

export function hasSpaceAccess(principal: Principal, spaceId: string): boolean {
  return principal.scopes.has("akep:space:*") ||
    principal.scopes.has(`akep:space:${encodeURIComponent(spaceId)}`);
}

function hasClassification(principal: Principal, classification: string): boolean {
  if (classification === "public") return true;
  // Restricted data stays outside the v0.1 pilot boundary, even when an
  // identity provider accidentally grants a future-looking clearance scope.
  if (classification === "restricted") return false;
  if (principal.scopes.has("akep:classification:*")) return true;
  const levels = ["public", "internal", "confidential"];
  const required = levels.indexOf(classification);
  if (required < 0) return false;
  return levels.slice(required).some((level) =>
    principal.scopes.has(`akep:classification:${level}`),
  );
}

function policiesAreAuthorized(principal: Principal, value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  if (principal.scopes.has("akep:policy:*")) return true;
  return value.every((item) => {
    if (typeof item !== "object" || item === null) return false;
    const digest = (item as Record<string, unknown>).digest;
    return typeof digest === "string" && principal.scopes.has(`akep:policy:${digest}`);
  });
}

export function payloadText(asset: PublishedAsset): string {
  return asset.payloads
    .filter((payload) => payload.mediaType.startsWith("text/"))
    .map((payload) => Buffer.from(payload.data, "base64").toString("utf8"))
    .join("\n");
}

export function matchesQuery(asset: PublishedAsset, request: Record<string, unknown>): boolean {
  const query = request.query as { readonly reference?: string; readonly text?: string };
  if (query.reference !== undefined) return query.reference === asset.revisionId;
  const text = query.text?.trim().toLocaleLowerCase() ?? "";
  const corpus = [asset.manifest.title, asset.manifest.summary ?? "", payloadText(asset)]
    .join("\n")
    .toLocaleLowerCase();
  const terms = text.split(/\s+/u).filter(Boolean);
  return corpus.includes(text) || terms.every((term) => corpus.includes(term));
}

export function matchesFilters(asset: PublishedAsset, request: Record<string, unknown>): boolean {
  const filters = request.filters as
    | {
        readonly assetTypes?: readonly string[];
        readonly includeDeprecated?: boolean;
        readonly labels?: readonly string[];
        readonly profiles?: readonly string[];
      }
    | undefined;
  if (asset.status === "deprecated" && filters?.includeDeprecated !== true) return false;
  if (asset.status !== "published" && asset.status !== "deprecated") return false;
  if (filters?.assetTypes !== undefined && !filters.assetTypes.includes(asset.manifest.assetType)) {
    return false;
  }
  if (filters?.profiles !== undefined && !filters.profiles.includes(asset.manifest.profile.uri)) {
    return false;
  }
  const labels = (asset.manifest.labels as readonly string[] | undefined) ?? [];
  if (filters?.labels !== undefined && !filters.labels.every((label) => labels.includes(label))) {
    return false;
  }
  return true;
}
