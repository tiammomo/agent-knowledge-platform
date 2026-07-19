import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../../config.js";
import type { ContractRegistry } from "../../contracts/registry.js";
import { canonicalJson, sha256Digest } from "../../contracts/revision.js";
import type { GrowthStore } from "../growth/store.js";
import type { PublishedAsset } from "../growth/types.js";
import { evaluateAttestationGate } from "../evaluation/quality-gate.js";
import {
  canConsume,
  canResolveMetadata,
  hasSpaceAccess,
  matchesFilters,
  supportedProfiles,
  type SupportedProfile,
} from "../growth/validation.js";
import { authenticate, type Principal } from "../../platform/auth.js";
import { authorizeQuery } from "../../platform/authorization.js";
import {
  requireAKEPVersion,
  requireObligationSupport,
  requirePurpose,
} from "../../platform/headers.js";
import { ProblemError } from "../../platform/problem.js";
import type {
  ExposureReceipt,
  ExposureReceiptStore,
} from "./exposure-receipt-store.js";
import {
  decodeCursor,
  encodeCursor,
  InMemoryQuerySearchStore,
  knowledgeSnapshot,
  LEXICAL_RANKER_FINGERPRINT,
  lexicalCoverage,
  queryFingerprint,
  rankAssetPassages,
  truncatePassage,
} from "./search.js";
import type {
  ContextPackRequest,
  PassageCandidate,
  QuerySearchStore,
  RankedAssetResult,
} from "./types.js";

interface QueryDependencies {
  readonly config: AppConfig;
  readonly contracts: ContractRegistry;
  readonly growth: GrowthStore;
  readonly receipts: ExposureReceiptStore;
  readonly search?: QuerySearchStore;
}

interface DirectReadContext {
  readonly principal: Principal;
  readonly purpose: string;
  readonly supportedObligations: readonly unknown[];
}

export async function registerQueryRoutes(
  app: FastifyInstance,
  dependencies: QueryDependencies,
): Promise<void> {
  const { config, contracts, growth, receipts } = dependencies;
  const search = dependencies.search ?? new InMemoryQuerySearchStore();
  const profiles = supportedProfiles(config);

  app.post<{ Body: unknown }>("/queries", async (request, reply) => {
    requireAKEPVersion(request);
    const principal = authenticate(request, "akep:query");
    contracts.assert("query.schema.json", request.body);
    requireNoCritical(request.body);
    const body = request.body as Record<string, unknown>;
    requireImplementedMode(body.mode);
    requireImplementedFilters(body.filters);
    if (body.minCheckpoint !== undefined) {
      throw new ProblemError(
        422,
        "AKEP_CHECKPOINT_UNSUPPORTED",
        "This node does not yet support minimum federation checkpoints.",
      );
    }
    const purpose = body.purpose as string;
    const authorization = authorizeQuery({
      config,
      principal,
      purpose,
      ...(body.spaces === undefined
        ? {}
        : { requestedSpaceIds: body.spaces as readonly string[] }),
    });
    const published = await growth.listPublished(authorization.spaceIds);
    const spaces = effectiveSpaceIds(
      authorization.spaceIds,
      published,
      config.defaultSpaceId,
    );
    const supportedObligations = body.supportedObligations as readonly unknown[];
    const limit = body.limit as number;
    const assets = await authorizedAssets(
      published,
      body,
      spaces,
      purpose,
      supportedObligations,
      principal,
      growth,
      profiles,
    );
    const snapshot = knowledgeSnapshot(
      assets,
      `${config.policyEpoch}:${search.projectionGeneration}`,
    );
    const fingerprint = queryFingerprint(body, authorization.bindingDigest);
    const offset = continuationOffset(body.cursor, fingerprint, snapshot);
    const query = body.query as {
      readonly locale?: string;
      readonly reference?: string;
      readonly text?: string;
    };
    const candidates = await search.search({
      assets,
      ...(query.locale === undefined ? {} : { locale: query.locale }),
      mode: body.mode as "exact" | "lexical",
      query,
    });
    const ranked = rankAssetPassages(candidates);
    if (offset > ranked.length) {
      throw new ProblemError(
        400,
        "AKEP_CURSOR_INVALID",
        "The continuation cursor points beyond the available result set.",
      );
    }
    const page = ranked.slice(offset, offset + limit);
    const citationsPerResult = Math.min(
      3,
      Math.max(1, Math.floor(1_000 / Math.max(1, page.length))),
    );
    const selected = page.map((result) => ({
      ...result,
      passages: result.passages.slice(0, citationsPerResult),
    }));
    const results = selected.map((result) =>
      queryResult(result, body, config, search),
    );
    const citations = selected.flatMap((result) =>
      result.passages.map((passage) => exposedPassageCitation(passage)),
    );
    const obligations = uniqueCanonical(
      selected.flatMap((result) => result.asset.manifest.policy.obligations ?? []),
    );
    const issuedAt = new Date();
    const receipt = createExposureReceipt({
      citations,
      config,
      kind: "query",
      obligations,
      principal,
      policyDecisionId: authorization.decisionId,
      purpose,
      spaces,
      issuedAt,
    });
    contracts.assert("exposure-receipt.schema.json", receipt);
    await receipts.put(receipt);

    const result = {
      critical: [],
      indexedThrough: indexedThrough(assets, issuedAt),
      ...(offset + selected.length < ranked.length
        ? {
            nextCursor: encodeCursor({
              offset: offset + selected.length,
              queryFingerprint: fingerprint,
              snapshot,
            }),
          }
        : {}),
      policyEpoch: config.policyEpoch,
      projectionGeneration: search.projectionGeneration,
      queryReceiptId: receipt.exposureReceiptId,
      results,
      snapshot,
    };
    contracts.assert("query-result.schema.json", result);
    applyPrivateHeaders(reply, config, "no-store");
    return reply.send(result);
  });

  app.post<{ Body: unknown }>("/context-packs", async (request, reply) => {
    requireAKEPVersion(request);
    const principal = authenticate(request, "akep:query");
    contracts.assert("context-pack-request.schema.json", request.body);
    const context = parseContextPackRequest(request.body, config);
    requireNoCritical(context);
    requireImplementedMode(context.mode);
    requireImplementedFilters(context.filters);
    const authorization = authorizeQuery({
      config,
      principal,
      purpose: context.purpose,
      ...(context.spaces === undefined
        ? {}
        : { requestedSpaceIds: context.spaces }),
    });
    const published = await growth.listPublished(authorization.spaceIds);
    const spaces = effectiveSpaceIds(
      authorization.spaceIds,
      published,
      config.defaultSpaceId,
    );
    const queryBody: Record<string, unknown> = {
      critical: context.critical,
      ...(context.filters === undefined ? {} : { filters: context.filters }),
      include: ["passages", "attestations"],
      limit: Math.min(1_000, context.budget.maxPassages),
      mode: context.mode,
      purpose: context.purpose,
      query: {
        ...(context.locale === undefined ? {} : { locale: context.locale }),
        text: context.task,
      },
      spaces,
      supportedObligations: context.supportedObligations,
    };
    contracts.assert("query.schema.json", queryBody);
    const assets = await authorizedAssets(
      published,
      queryBody,
      spaces,
      context.purpose,
      context.supportedObligations,
      principal,
      growth,
      profiles,
    );
    const candidates = await search.search({
      assets,
      ...(context.locale === undefined ? {} : { locale: context.locale }),
      mode: context.mode,
      query: { text: context.task },
    });
    const selection = selectContextPassages(candidates, context);
    const obligations = uniqueCanonical(
      selection.passages.flatMap(
        (passage) => passage.asset.manifest.policy.obligations ?? [],
      ),
    );
    const citations = selection.passages.map((passage) =>
      contextPackCitation(passage),
    );
    const exposed = selection.passages.map((passage) =>
      exposedPassageCitation(passage),
    );
    const issuedAt = new Date();
    const receipt = createExposureReceipt({
      citations: exposed,
      config,
      issuedAt,
      kind: "query",
      obligations,
      principal,
      policyDecisionId: authorization.decisionId,
      purpose: context.purpose,
      spaces,
    });
    contracts.assert("exposure-receipt.schema.json", receipt);
    await receipts.put(receipt);

    const warnings = contextWarnings(selection.passages, selection.truncated);
    const qualityReasons = uniqueStrings(
      selection.passages.flatMap((passage) => passage.asset.qualityReasons),
    );
    const qualityDecision =
      selection.passages.length === 0
        ? "insufficient"
        : selection.passages.some(
              (passage) =>
                passage.asset.qualityDecision === "suitable_with_warning" ||
                passage.asset.status === "deprecated",
            )
          ? "suitable_with_warning"
          : "suitable";
    const snapshot = knowledgeSnapshot(
      assets,
      `${config.policyEpoch}:${search.projectionGeneration}`,
    );
    const stableContext = {
      budget: context.budget,
      citations,
      obligations,
      policyEpoch: config.policyEpoch,
      projectionGeneration: search.projectionGeneration,
      purpose: context.purpose,
      snapshot,
      spaces,
      task: context.task,
    };
    const contextDigest = `sha256:${createHash("sha256")
      .update(canonicalJson(stableContext))
      .digest("hex")}`;
    const passages = selection.passages.map((passage, index) => ({
      citationId: passageCitationId(passage),
      chunkId: passage.chunkId,
      rank: index + 1,
      recordId: passage.asset.manifest.recordId,
      revisionId: passage.asset.revisionId,
      score: passage.score,
      spaceId: passage.asset.spaceId,
      text: passage.text,
      title: passage.asset.manifest.title,
    }));
    const response = {
      budget: {
        ...context.budget,
        estimatedTokens: selection.estimatedTokens,
        usedCharacters: selection.usedCharacters,
        usedPassages: passages.length,
      },
      citations,
      contextDigest,
      contextPackId: `urn:akep:context:${contextDigest}`,
      createdAt: issuedAt.toISOString(),
      exposureReceiptId: receipt.exposureReceiptId,
      obligations,
      passages,
      policyEpoch: config.policyEpoch,
      projectionGeneration: search.projectionGeneration,
      purpose: context.purpose,
      quality: {
        attestationRefs: uniqueStrings(
          selection.passages.flatMap(
            (passage) => passage.asset.qualityAttestationRefs,
          ),
        ),
        citationCoverage: passages.length === 0 ? 0 : 1,
        decision: qualityDecision,
        lexicalCoverage: lexicalCoverage(
          context.task,
          selection.passages.map((passage) => passage.text).join("\n"),
          context.locale,
        ),
        reasons:
          qualityReasons.length > 0
            ? qualityReasons
            : passages.length === 0
              ? ["No policy-compliant passage satisfied this task and budget."]
              : ["Published knowledge passed the current policy and quality gate."],
      },
      snapshot,
      task: context.task,
      warnings,
    };
    contracts.assert("context-pack.schema.json", response);
    applyPrivateHeaders(reply, config, "no-store");
    return reply.send(response);
  });

  app.get<{ Params: { exposureReceiptId: string } }>(
    "/exposure-receipts/:exposureReceiptId",
    async (request, reply) => {
      requireAKEPVersion(request);
      const principal = authenticate(request, "akep:read");
      const receipt = await receipts.get(request.params.exposureReceiptId);
      if (
        receipt === undefined ||
        receipt.subjectPseudonym !== principal.subjectDigest
      ) {
        throw notFound("The exposure receipt was not found.");
      }
      if (
        Date.parse(receipt.expiresAt) <= Date.now() ||
        receipt.policyEpoch !== config.policyEpoch ||
        !(await citationsAreCurrent(
          growth,
          receipt.citations,
          principal,
          receipt.purpose,
          receipt.obligations,
          profiles,
        ))
      ) {
        throw new ProblemError(
          410,
          "AKEP_RECEIPT_EXPIRED",
          "The exposure receipt is no longer valid.",
        );
      }
      contracts.assert("exposure-receipt.schema.json", receipt);
      applyPrivateHeaders(reply, config, "no-store");
      return reply.send(receipt);
    },
  );

  app.get<{ Params: { recordId: string; spaceId: string } }>(
    "/spaces/:spaceId/records/:recordId",
    async (request, reply) => {
      const context = verifyDirectReadHeaders(request, contracts);
      if (!hasSpaceAccess(context.principal, request.params.spaceId)) {
        throw notFound("The record was not found.");
      }
      const candidates = (await growth.listPublished([request.params.spaceId])).filter(
          (asset) =>
            asset.spaceId === request.params.spaceId &&
            asset.manifest.recordId === request.params.recordId &&
            canResolveMetadata(
              asset,
              context.purpose,
              context.supportedObligations,
              context.principal,
            ),
        );
      if (candidates.length === 0) throw notFound("The record was not found.");
      const current = candidates
        .filter((asset) => asset.status !== "superseded")
        .sort((left, right) => right.indexedAt.localeCompare(left.indexedAt))[0];
      if (current === undefined) throw notFound("The record was not found.");
      const channels = [
        {
          eventId: current.publicationEvent.eventId,
          name: "published",
          revisionId: current.revisionId,
          trustDomain: config.trustDomain,
          updatedAt: current.publicationEvent.occurredAt,
        },
      ];
      const statuses = candidates
        .filter((asset) => asset.statusEvent !== undefined)
        .map((asset) => ({
          assertedAt: asset.statusEvent!.occurredAt,
          eventId: asset.statusEvent!.eventId,
          name: asset.statusEvent!.status,
          reason: asset.statusEvent!.reason,
          revisionId: asset.revisionId,
          trustDomain: config.trustDomain,
        }));
      const resource = {
        channels,
        heads: [current.revisionId],
        policyEpoch: config.policyEpoch,
        recordId: current.manifest.recordId,
        resolvedAt: new Date().toISOString(),
        spaceId: current.spaceId,
        statuses,
      };
      contracts.assert("record-resource.schema.json", resource);
      applyPrivateHeaders(reply, config, "no-cache");
      reply.header("ETag", strongEtag(resource));
      return reply.send(resource);
    },
  );

  app.get<{ Params: { revisionId: string; spaceId: string } }>(
    "/spaces/:spaceId/revisions/:revisionId",
    async (request, reply) => {
      const context = verifyDirectReadHeaders(request, contracts);
      const asset = await authorizedAsset(
        growth,
        request.params.spaceId,
        request.params.revisionId,
        context,
        profiles,
      );
      const receipt = await directReceipt(
        receipts,
        contracts,
        config,
        asset,
        context,
        "revision_read",
      );
      const resource = { manifest: asset.manifest, revisionId: asset.revisionId };
      contracts.assert("revision-resource.schema.json", resource);
      applyReadHeaders(reply, config, asset, receipt, "no-cache");
      const etag = `"${asset.revisionId}"`;
      reply.header("ETag", etag);
      if (request.headers["if-none-match"] === etag) return reply.code(304).send();
      return reply.send(resource);
    },
  );

  app.get<{
    Params: { digest: string; revisionId: string; spaceId: string };
  }>(
    "/spaces/:spaceId/revisions/:revisionId/blobs/:digest",
    async (request, reply) => {
      const context = verifyDirectReadHeaders(request, contracts);
      const asset = await authorizedAsset(
        growth,
        request.params.spaceId,
        request.params.revisionId,
        context,
        profiles,
      );
      const payload = asset.payloads.find(
        (candidate) => candidate.digest === request.params.digest,
      );
      if (payload === undefined) throw notFound("The blob was not found.");
      const complete = Buffer.from(payload.data, "base64");
      if (`sha256:${createHash("sha256").update(complete).digest("hex")}` !== payload.digest) {
        throw new ProblemError(
          503,
          "AKEP_BLOB_INTEGRITY_FAILURE",
          "The stored blob failed integrity verification.",
        );
      }
      const range = parseRange(request.headers.range, complete.byteLength);
      const content = range === undefined ? complete : complete.subarray(range.start, range.end);
      const receipt = await directReceipt(
        receipts,
        contracts,
        config,
        asset,
        context,
        "blob_read",
        payload.digest,
        range,
      );
      applyReadHeaders(reply, config, asset, receipt, "no-store");
      reply
        .header("Content-Type", payload.mediaType)
        .header("Content-Length", String(content.byteLength))
        .header("Content-Digest", contentDigest(content))
        .header("ETag", `"${payload.digest}"`);
      if (range !== undefined) {
        reply
          .code(206)
          .header("Content-Range", `bytes ${range.start}-${range.end - 1}/${complete.byteLength}`)
          .header("Repr-Digest", contentDigest(complete));
      }
      return reply.send(content);
    },
  );
}

async function authorizedAssets(
  published: readonly PublishedAsset[],
  body: Record<string, unknown>,
  spaces: readonly string[],
  purpose: string,
  supportedObligations: readonly unknown[],
  principal: Principal,
  growth: GrowthStore,
  profiles: ReadonlyMap<string, SupportedProfile>,
): Promise<readonly PublishedAsset[]> {
  const candidates = published
    .filter((asset) => spaces.includes(asset.spaceId))
    .filter((asset) => canConsume(asset, purpose, supportedObligations, principal))
    .filter((asset) => matchesFilters(asset, body))
    .sort(
      (left, right) =>
        left.revisionId.localeCompare(right.revisionId) ||
        left.spaceId.localeCompare(right.spaceId),
    );
  const current: PublishedAsset[] = [];
  for (const asset of candidates) {
    if (await qualityEvidenceIsCurrent(growth, asset, profiles)) current.push(asset);
  }
  return current;
}

function continuationOffset(
  value: unknown,
  fingerprint: string,
  snapshot: string,
): number {
  if (value === undefined) return 0;
  const cursor = typeof value === "string" ? decodeCursor(value) : undefined;
  if (cursor === undefined || cursor.queryFingerprint !== fingerprint) {
    throw new ProblemError(
      400,
      "AKEP_CURSOR_INVALID",
      "The continuation cursor is malformed or belongs to another query.",
    );
  }
  if (cursor.snapshot !== snapshot) {
    throw new ProblemError(
      409,
      "AKEP_CURSOR_STALE",
      "The knowledge projection changed after this cursor was issued; restart the query.",
    );
  }
  return cursor.offset;
}

function requireImplementedMode(mode: unknown): asserts mode is "exact" | "lexical" {
  if (mode === "exact" || mode === "lexical") return;
  throw new ProblemError(
    422,
    "AKEP_QUERY_MODE_UNSUPPORTED",
    `Query mode ${String(mode)} is not enabled; this node currently supports lexical and exact.`,
  );
}

function requireImplementedFilters(value: unknown): void {
  if (!isObject(value)) return;
  if (value.validAt !== undefined) {
    throw new ProblemError(
      422,
      "AKEP_QUERY_FILTER_UNSUPPORTED",
      "Historical validAt queries are not enabled on this node.",
    );
  }
  if (
    value.channels !== undefined &&
    (!Array.isArray(value.channels) ||
      value.channels.length !== 1 ||
      value.channels[0] !== "published")
  ) {
    throw new ProblemError(
      422,
      "AKEP_QUERY_FILTER_UNSUPPORTED",
      "This node only serves the published channel.",
    );
  }
}

function parseContextPackRequest(
  input: unknown,
  config: AppConfig,
): ContextPackRequest {
  if (!isObject(input)) throw contextInvalid("The request body must be an object.");
  assertOnlyKeys(input, [
    "akepVersion",
    "budget",
    "critical",
    "extensions",
    "filters",
    "locale",
    "mode",
    "purpose",
    "spaces",
    "supportedObligations",
    "task",
  ]);
  if (input.akepVersion !== undefined && input.akepVersion !== "0.1") {
    throw contextInvalid("akepVersion must be 0.1 when supplied.");
  }
  let task: string;
  let taskLocale: string | undefined;
  if (typeof input.task === "string") {
    task = input.task;
  } else if (isObject(input.task)) {
    assertOnlyKeys(input.task, ["locale", "text"]);
    if (typeof input.task.text !== "string") {
      throw contextInvalid("task.text must be a string.");
    }
    task = input.task.text;
    if (input.task.locale !== undefined) {
      if (typeof input.task.locale !== "string") {
        throw contextInvalid("task.locale must be a string.");
      }
      taskLocale = input.task.locale;
    }
  } else {
    throw contextInvalid("task must be a string or an object containing text.");
  }
  if (task.trim().length === 0 || task.length > 32_000) {
    throw contextInvalid("task must contain between 1 and 32000 characters.");
  }
  if (input.locale !== undefined && typeof input.locale !== "string") {
    throw contextInvalid("locale must be a string.");
  }
  if (taskLocale !== undefined && input.locale !== undefined && taskLocale !== input.locale) {
    throw contextInvalid("task.locale and locale cannot disagree.");
  }
  if (typeof input.purpose !== "string") {
    throw contextInvalid("purpose is required.");
  }
  if (!Array.isArray(input.supportedObligations)) {
    throw contextInvalid("supportedObligations must be an array.");
  }
  if (input.spaces !== undefined && !isStringArray(input.spaces)) {
    throw contextInvalid("spaces must be an array of URIs.");
  }
  if (input.filters !== undefined && !isObject(input.filters)) {
    throw contextInvalid("filters must be an object.");
  }
  if (input.critical !== undefined && !isStringArray(input.critical)) {
    throw contextInvalid("critical must be an array.");
  }
  if (input.mode !== undefined && typeof input.mode !== "string") {
    throw contextInvalid("mode must be a string.");
  }

  const rawBudget = input.budget ?? {};
  if (!isObject(rawBudget)) throw contextInvalid("budget must be an object.");
  assertOnlyKeys(rawBudget, ["maxCharacters", "maxPassages", "maxTokens"]);
  const maxCharacters = optionalInteger(
    rawBudget.maxCharacters,
    "budget.maxCharacters",
    1,
    128_000,
  ) ?? 12_000;
  const maxPassages = optionalInteger(
    rawBudget.maxPassages,
    "budget.maxPassages",
    1,
    100,
  ) ?? 12;
  const maxTokens = optionalInteger(
    rawBudget.maxTokens,
    "budget.maxTokens",
    1,
    64_000,
  );
  const locale = (input.locale as string | undefined) ?? taskLocale;
  return {
    budget: {
      maxCharacters,
      maxPassages,
      ...(maxTokens === undefined ? {} : { maxTokens }),
    },
    critical: (input.critical as readonly string[] | undefined) ?? [],
    ...(input.filters === undefined
      ? {}
      : { filters: input.filters as Record<string, unknown> }),
    ...(locale === undefined ? {} : { locale }),
    mode: (input.mode as ContextPackRequest["mode"] | undefined) ?? "lexical",
    purpose: input.purpose,
    ...(input.spaces === undefined
      ? {}
      : { spaces: input.spaces as readonly string[] }),
    supportedObligations: input.supportedObligations,
    task,
  };
}

function effectiveSpaceIds(
  authorizedSpaceIds: readonly string[] | undefined,
  published: readonly PublishedAsset[],
  defaultSpaceId: string,
): readonly string[] {
  if (authorizedSpaceIds !== undefined) return authorizedSpaceIds;
  const visible = uniqueStrings(published.map((asset) => asset.spaceId));
  if (visible.length > 100) {
    throw new ProblemError(
      422,
      "AKEP_QUERY_SCOPE_TOO_BROAD",
      "Select at most 100 authorized Spaces explicitly for this query.",
    );
  }
  return visible.length === 0 ? [defaultSpaceId] : visible;
}

function selectContextPassages(
  candidates: readonly PassageCandidate[],
  context: ContextPackRequest,
): {
  readonly estimatedTokens: number;
  readonly passages: readonly PassageCandidate[];
  readonly truncated: boolean;
  readonly usedCharacters: number;
} {
  const passages: PassageCandidate[] = [];
  let estimatedTokens = 0;
  let usedCharacters = 0;
  let truncated = false;
  for (const candidate of candidates) {
    if (passages.length >= context.budget.maxPassages) {
      truncated = true;
      break;
    }
    const remainingCharacters = context.budget.maxCharacters - usedCharacters;
    const remainingTokens =
      context.budget.maxTokens === undefined
        ? Number.POSITIVE_INFINITY
        : context.budget.maxTokens - estimatedTokens;
    const available = Math.min(remainingCharacters, remainingTokens);
    if (available <= 0) {
      truncated = true;
      break;
    }
    const characters = [...candidate.text].length;
    const selected =
      characters <= available
        ? candidate
        : truncatePassage(candidate, Math.floor(available));
    if (selected.text.length === 0) {
      truncated = true;
      break;
    }
    passages.push(selected);
    const selectedCharacters = [...selected.text].length;
    usedCharacters += selectedCharacters;
    estimatedTokens += estimateTokens(selected.text);
    if (selected !== candidate) {
      truncated = true;
      break;
    }
  }
  return { estimatedTokens, passages, truncated, usedCharacters };
}

function contextWarnings(
  passages: readonly PassageCandidate[],
  truncated: boolean,
): readonly Record<string, unknown>[] {
  const warnings: Record<string, unknown>[] = [];
  if (passages.length === 0) {
    warnings.push({
      code: "AKEP_CONTEXT_INSUFFICIENT",
      message: "No policy-compliant passage matched the task.",
    });
  }
  if (truncated) {
    warnings.push({
      code: "AKEP_CONTEXT_BUDGET_TRUNCATED",
      message: "Matching context was truncated to the declared deterministic budget.",
    });
  }
  const warned = uniqueStrings(
    passages
      .filter((passage) => passage.asset.qualityDecision === "suitable_with_warning")
      .map((passage) => passage.asset.revisionId),
  );
  if (warned.length > 0) {
    warnings.push({
      code: "AKEP_CONTEXT_QUALITY_WARNING",
      message: "One or more passages carry a governed quality warning.",
      revisionIds: warned,
    });
  }
  const deprecated = uniqueStrings(
    passages
      .filter((passage) => passage.asset.status === "deprecated")
      .map((passage) => passage.asset.revisionId),
  );
  if (deprecated.length > 0) {
    warnings.push({
      code: "AKEP_CONTEXT_DEPRECATED",
      message: "Deprecated knowledge was included because the request explicitly allowed it.",
      revisionIds: deprecated,
    });
  }
  return warnings;
}

function indexedThrough(assets: readonly PublishedAsset[], fallback: Date): string {
  return assets.reduce(
    (latest, asset) => (asset.indexedAt > latest ? asset.indexedAt : latest),
    assets.length === 0 ? fallback.toISOString() : assets[0]!.indexedAt,
  );
}

function estimateTokens(text: string): number {
  return Math.max([...text].length, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
}

function optionalInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw contextInvalid(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value as number;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const accepted = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !accepted.has(key));
  if (unexpected !== undefined) {
    throw contextInvalid(`Unsupported property: ${unexpected}.`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function contextInvalid(detail: string): ProblemError {
  return new ProblemError(422, "AKEP_CONTEXT_PACK_INVALID", detail);
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function queryResult(
  result: RankedAssetResult,
  request: Record<string, unknown>,
  config: AppConfig,
  search: QuerySearchStore,
): Record<string, unknown> {
  const asset = result.asset;
  const obligations = asset.manifest.policy.obligations ?? [];
  const include = new Set((request.include as readonly string[] | undefined) ?? []);
  return {
    assetType: asset.manifest.assetType,
    citations: result.passages.map((passage) =>
      resultPassageCitation(passage, include.has("passages")),
    ),
    effectiveDecision:
      obligations.length === 0 ? "allowed" : "allowed_with_obligations",
    obligations,
    profile: asset.manifest.profile,
    qualityAttestationRefs: asset.qualityAttestationRefs,
    qualityDecision: asset.qualityDecision,
    qualityReasons: asset.qualityReasons,
    recordId: asset.manifest.recordId,
    revisionId: asset.revisionId,
    scores: [
      {
        backend: search.backend,
        method:
          request.mode === "exact" ? "exact-passage" : "lexical-passage",
        metric: "normalized-relevance",
        profile: `${config.publicOrigin}/rankers/${LEXICAL_RANKER_FINGERPRINT}`,
        value: result.score,
      },
    ],
    spaceId: asset.spaceId,
    ...(asset.status === "deprecated" ? { statuses: ["deprecated"] } : {}),
    title: asset.manifest.title,
    ...(include.has("summary") && asset.manifest.summary !== undefined
      ? { summary: asset.manifest.summary }
      : {}),
    ...(include.has("relations") && asset.manifest.relations !== undefined
      ? { relations: asset.manifest.relations }
      : {}),
    ...(include.has("attestations")
      ? { attestations: asset.qualityAttestationRefs }
      : {}),
    ...(include.has("provenance") ? { provenance: asset.manifest.provenance } : {}),
  };
}

function resultPassageCitation(
  passage: PassageCandidate,
  includeQuote: boolean,
): Record<string, unknown> {
  return {
    citationId: passageCitationId(passage),
    chunkId: passage.chunkId,
    locator: { end: passage.end, start: passage.start, type: "text-offset" },
    payloadDigest: passage.payloadDigest,
    ...(includeQuote ? { quote: passage.text } : {}),
  };
}

function exposedPassageCitation(passage: PassageCandidate): Record<string, unknown> {
  return {
    citationId: passageCitationId(passage),
    locator: { end: passage.end, start: passage.start, type: "text-offset" },
    payloadDigest: passage.payloadDigest,
    qualityAttestationRefs: passage.asset.qualityAttestationRefs,
    qualityDecision: passage.asset.qualityDecision,
    qualityReasons: passage.asset.qualityReasons,
    revisionId: passage.asset.revisionId,
    spaceId: passage.asset.spaceId,
  };
}

function exposedWholeCitation(asset: PublishedAsset): Record<string, unknown> {
  const primary = asset.manifest.payloads.find((payload) => payload.name === "primary")!;
  return {
    citationId: citationId(asset.revisionId, primary.digest, "whole-resource"),
    locator: { type: "whole-resource" },
    payloadDigest: primary.digest,
    qualityAttestationRefs: asset.qualityAttestationRefs,
    qualityDecision: asset.qualityDecision,
    qualityReasons: asset.qualityReasons,
    revisionId: asset.revisionId,
    spaceId: asset.spaceId,
  };
}

function contextPackCitation(passage: PassageCandidate): Record<string, unknown> {
  return {
    citationId: passageCitationId(passage),
    chunkId: passage.chunkId,
    locator: { end: passage.end, start: passage.start, type: "text-offset" },
    payloadDigest: passage.payloadDigest,
    quote: passage.text,
    recordId: passage.asset.manifest.recordId,
    revisionId: passage.asset.revisionId,
    spaceId: passage.asset.spaceId,
  };
}

function passageCitationId(passage: PassageCandidate): string {
  return citationId(
    passage.asset.revisionId,
    passage.payloadDigest,
    `text-offset:${passage.start}:${passage.end}`,
  );
}

function citationId(revisionId: string, digest: string, locator: string): string {
  const value = createHash("sha256")
    .update(`${revisionId}\0${digest}\0${locator}`)
    .digest("hex");
  return `urn:akep:citation:sha256:${value}`;
}

function verifyDirectReadHeaders(
  request: FastifyRequest,
  contracts: ContractRegistry,
): DirectReadContext {
  requireAKEPVersion(request);
  const principal = authenticate(request, "akep:read");
  const purpose = requirePurpose(request);
  const supportedObligations = requireObligationSupport(request, contracts);
  return { principal, purpose, supportedObligations };
}

async function authorizedAsset(
  growth: GrowthStore,
  spaceId: string,
  revisionId: string,
  context: DirectReadContext,
  profiles: ReadonlyMap<string, SupportedProfile>,
): Promise<PublishedAsset> {
  if (!hasSpaceAccess(context.principal, spaceId)) {
    throw notFound("The revision was not found.");
  }
  const asset = await growth.getPublishedRevision(spaceId, revisionId);
  if (
    asset === undefined ||
    !canConsume(
      asset,
      context.purpose,
      context.supportedObligations,
      context.principal,
    ) ||
    !(await qualityEvidenceIsCurrent(growth, asset, profiles))
  ) {
    throw notFound("The revision was not found.");
  }
  return asset;
}

async function directReceipt(
  receipts: ExposureReceiptStore,
  contracts: ContractRegistry,
  config: AppConfig,
  asset: PublishedAsset,
  context: DirectReadContext,
  kind: "revision_read" | "blob_read",
  digest?: string,
  range?: { readonly end: number; readonly start: number },
): Promise<ExposureReceipt> {
  const primary = asset.manifest.payloads.find((payload) => payload.name === "primary")!;
  // A Revision read exposes the canonical Manifest, while a Blob read exposes
  // bytes from a payload. The Citation digest must describe what was actually
  // disclosed, rather than always pointing at the primary payload.
  const exposedDigest = kind === "revision_read"
    ? sha256Digest(canonicalJson(asset.manifest))
    : (digest ?? primary.digest);
  const citation = exposedWholeCitation(asset);
  const selected = {
    ...citation,
    locator:
      range === undefined
        ? { type: "whole-resource" }
        : { end: range.end, start: range.start, type: "byte-range" },
    payloadDigest: exposedDigest,
    citationId: citationId(
      asset.revisionId,
      exposedDigest,
      range === undefined
        ? "whole-resource"
        : `byte-range:${range.start}:${range.end}`,
    ),
  };
  const receipt = createExposureReceipt({
    citations: [selected],
    config,
    issuedAt: new Date(),
    kind,
    obligations: asset.manifest.policy.obligations ?? [],
    principal: context.principal,
    purpose: context.purpose,
    spaces: [asset.spaceId],
  });
  contracts.assert("exposure-receipt.schema.json", receipt);
  await receipts.put(receipt);
  return receipt;
}

function createExposureReceipt(input: {
  readonly citations: readonly unknown[];
  readonly config: AppConfig;
  readonly issuedAt: Date;
  readonly kind: ExposureReceipt["kind"];
  readonly obligations: readonly unknown[];
  readonly policyDecisionId?: string;
  readonly principal: Principal;
  readonly purpose: string;
  readonly spaces: readonly string[];
}): ExposureReceipt {
  return {
    citations: input.citations,
    critical: [],
    expiresAt: new Date(input.issuedAt.getTime() + 5 * 60_000).toISOString(),
    exposureReceiptId: `urn:uuid:${randomUUID()}`,
    issuedAt: input.issuedAt.toISOString(),
    kind: input.kind,
    obligations: input.obligations,
    policyDecisionId: input.policyDecisionId ?? `urn:uuid:${randomUUID()}`,
    policyEpoch: input.config.policyEpoch,
    purpose: input.purpose,
    spaceIds: input.spaces,
    subjectPseudonym: input.principal.subjectDigest,
  };
}

function applyPrivateHeaders(
  reply: FastifyReply,
  config: AppConfig,
  cache: "no-cache" | "no-store",
): void {
  reply
    .header("AKEP-Version", "0.1")
    .header("AKEP-Policy-Epoch", config.policyEpoch)
    .header("Cache-Control", `private, ${cache}`)
    .header("Vary", "Authorization, AKEP-Purpose, AKEP-Obligation-Support");
}

function applyReadHeaders(
  reply: FastifyReply,
  config: AppConfig,
  asset: PublishedAsset,
  receipt: ExposureReceipt,
  cache: "no-cache" | "no-store",
): void {
  applyPrivateHeaders(reply, config, cache);
  reply
    .header("AKEP-Read-Receipt", receipt.exposureReceiptId)
    .header("AKEP-Quality-Decision", asset.qualityDecision)
    .header("AKEP-Quality-Attestation", asset.qualityAttestationRefs[0]!);
}

function parseRange(
  header: string | undefined,
  length: number,
): { readonly end: number; readonly start: number } | undefined {
  if (header === undefined) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (match === null || (match[1] === "" && match[2] === "")) throw rangeError();
  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw rangeError();
    start = Math.max(0, length - suffix);
    end = length;
  } else {
    start = Number(match[1]);
    const inclusiveEnd = match[2] === "" ? length - 1 : Number(match[2]);
    end = Math.min(length, inclusiveEnd + 1);
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= length ||
    end <= start
  ) {
    throw rangeError();
  }
  return { end, start };
}

function rangeError(): ProblemError {
  return new ProblemError(416, "AKEP_RANGE_INVALID", "The requested byte range is invalid.");
}

function contentDigest(bytes: Uint8Array): string {
  return `sha-256=:${createHash("sha256").update(bytes).digest("base64")}:`;
}

function strongEtag(value: unknown): string {
  return `"sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}"`;
}

function uniqueCanonical(values: readonly unknown[]): readonly unknown[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = canonicalJson(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function requireNoCritical(body: unknown): void {
  const critical = (body as { readonly critical?: readonly unknown[] }).critical;
  if (critical !== undefined && critical.length > 0) {
    throw new ProblemError(
      422,
      "AKEP_CRITICAL_EXTENSION_UNSUPPORTED",
      "This node does not support any critical extensions.",
    );
  }
}

function notFound(detail: string): ProblemError {
  return new ProblemError(404, "AKEP_NOT_FOUND", detail);
}

async function citationsAreCurrent(
  growth: GrowthStore,
  citations: readonly unknown[],
  principal: Principal,
  purpose: string,
  supportedObligations: readonly unknown[],
  profiles: ReadonlyMap<string, SupportedProfile>,
): Promise<boolean> {
  for (const item of citations) {
    const citation = item as { readonly revisionId?: string; readonly spaceId?: string };
    if (citation.revisionId === undefined || citation.spaceId === undefined) return false;
    if (!hasSpaceAccess(principal, citation.spaceId)) return false;
    const asset = await growth.getPublishedRevision(citation.spaceId, citation.revisionId);
    if (
      asset === undefined ||
      !canConsume(asset, purpose, supportedObligations, principal) ||
      !(await qualityEvidenceIsCurrent(growth, asset, profiles))
    ) {
      return false;
    }
  }
  return true;
}

async function qualityEvidenceIsCurrent(
  growth: GrowthStore,
  asset: PublishedAsset,
  profiles: ReadonlyMap<string, SupportedProfile>,
): Promise<boolean> {
  try {
    await evaluateAttestationGate(
      growth,
      asset.spaceId,
      asset.revisionId,
      asset.qualityAttestationRefs,
      {
        expectedPayloadDigests: new Set(
          asset.manifest.payloads.map((payload) => payload.digest),
        ),
        requireBenchmark: false,
        requiredTypes: profiles.get(asset.manifest.profile.uri)?.document.requiredAttestations ?? [],
      },
    );
    return true;
  } catch {
    return false;
  }
}
