import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { AppConfig } from "../../config.js";
import { canonicalJson } from "../../contracts/revision.js";
import type { PublishedAsset } from "../growth/types.js";
import type {
  PassageCandidate,
  PassageSearchRequest,
  QuerySearchStore,
  RankedAssetResult,
} from "./types.js";

const CHUNK_MAX_BYTES = 1_600;
const CHUNK_MIN_BOUNDARY_BYTES = 960;
const CHUNK_OVERLAP_BYTES = 160;
const MAX_DATABASE_CANDIDATES = 50_000;

export const CHUNKER_FINGERPRINT = "akep-utf8-passage-v1";
export const LEXICAL_RANKER_FINGERPRINT = "akep-lexical-v2";

interface StoredPassageRow {
  readonly chunk_id: string;
  readonly content: string;
  readonly end_offset: string | number;
  readonly ordinal: number;
  readonly payload_digest: string;
  readonly payload_name: string;
  readonly revision_id: string;
  readonly space_id: string;
  readonly start_offset: string | number;
}

export class InMemoryQuerySearchStore implements QuerySearchStore {
  public readonly backend = "memory";
  public readonly projectionGeneration =
    `${CHUNKER_FINGERPRINT}/${LEXICAL_RANKER_FINGERPRINT}`;

  public async search(
    request: PassageSearchRequest,
  ): Promise<readonly PassageCandidate[]> {
    return rankCandidates(
      request.assets.flatMap((asset) => passagesForAsset(asset)),
      request,
    );
  }
}

/**
 * PostgreSQL is the durable passage projection. The current governed publication
 * transaction stores complete immutable payloads; this adapter deterministically
 * materializes any missing passage rows before querying them. Moving that refresh
 * to the outbox worker later does not change the query contract or chunk ids.
 */
export class PostgresQuerySearchStore implements QuerySearchStore {
  public readonly backend = "postgres";
  public readonly projectionGeneration =
    `${CHUNKER_FINGERPRINT}/${LEXICAL_RANKER_FINGERPRINT}/postgres`;

  public constructor(
    private readonly pool: Pool,
    private readonly config: AppConfig,
  ) {}

  public async search(
    request: PassageSearchRequest,
  ): Promise<readonly PassageCandidate[]> {
    if (request.assets.length === 0) return [];
    await this.#synchronize(request.assets);

    const allowed = request.assets.map((asset) => ({
      revision_id: asset.revisionId,
      space_id: asset.spaceId,
    }));
    const queryText = request.query.text ?? "";
    const compactQuery = normalizeCompact(queryText);
    const terms = lexicalTerms(queryText, request.locale).map(normalizeCompact);
    const result = await this.pool.query<StoredPassageRow>(
      `with allowed as (
         select space_id, revision_id
           from jsonb_to_recordset($2::jsonb)
             as a(space_id text, revision_id text)
       )
       select c.space_id, c.revision_id, c.chunk_id, c.ordinal, c.content,
              c.payload_digest, c.payload_name, c.start_offset, c.end_offset
         from query.chunk_projection c
         join allowed a using (space_id, revision_id)
        where c.tenant_id = $1
          and c.chunker_fingerprint = $3
          and (
            ($4::text is not null and c.revision_id = $4)
            or
            ($4::text is null and $5 = 'exact'
              and strpos(c.search_normalized, $6) > 0)
            or
            ($4::text is null and $5 = 'lexical' and (
              strpos(c.search_normalized, $6) > 0
              or not exists (
                select 1 from unnest($7::text[]) as term
                 where strpos(c.search_normalized, term) = 0
              )
            ))
          )
        order by
          case when strpos(c.search_normalized, $6) > 0 then 1 else 0 end desc,
          similarity(c.search_normalized, $6) desc,
          octet_length(c.content),
          c.revision_id, c.payload_digest, c.start_offset
        limit $8`,
      [
        this.config.tenantId,
        JSON.stringify(allowed),
        CHUNKER_FINGERPRINT,
        request.query.reference ?? null,
        request.mode,
        compactQuery,
        terms,
        MAX_DATABASE_CANDIDATES,
      ],
    );
    const assets = new Map(
      request.assets.map((asset) => [assetKey(asset.spaceId, asset.revisionId), asset]),
    );
    const candidates = result.rows.flatMap((row): PassageCandidate[] => {
      const asset = assets.get(assetKey(row.space_id, row.revision_id));
      if (asset === undefined) return [];
      return [
        {
          asset,
          chunkId: row.chunk_id,
          end: Number(row.end_offset),
          ordinal: row.ordinal,
          payloadDigest: row.payload_digest,
          payloadName: row.payload_name,
          score: 0,
          start: Number(row.start_offset),
          text: row.content,
        },
      ];
    });
    return rankCandidates(candidates, request);
  }

  async #synchronize(assets: readonly PublishedAsset[]): Promise<void> {
    const rows = assets.flatMap((asset) =>
      passagesForAsset(asset).map((passage) => ({
        chunk_id: passage.chunkId,
        content: passage.text,
        end_offset: passage.end,
        indexed_at: asset.indexedAt,
        ordinal: passage.ordinal,
        payload_digest: passage.payloadDigest,
        payload_name: passage.payloadName,
        policy_epoch: this.config.policyEpoch,
        revision_id: asset.revisionId,
        space_id: asset.spaceId,
        start_offset: passage.start,
      })),
    );
    if (rows.length === 0) return;
    await this.pool.query(
      `insert into query.chunk_projection as existing
         (tenant_id, space_id, revision_id, chunk_id, ordinal, content,
          payload_digest, payload_name, start_offset, end_offset,
          chunker_fingerprint, projection_schema_version, policy_epoch, indexed_at)
       select $1, r.space_id, r.revision_id, r.chunk_id, r.ordinal, r.content,
              r.payload_digest, r.payload_name, r.start_offset, r.end_offset,
              $2, '2', r.policy_epoch, r.indexed_at
         from jsonb_to_recordset($3::jsonb) as r(
           space_id text, revision_id text, chunk_id text, ordinal integer,
           content text, payload_digest text, payload_name text,
           start_offset bigint, end_offset bigint, policy_epoch text,
           indexed_at timestamptz
         )
       on conflict (tenant_id, space_id, revision_id, chunk_id)
       do update set content = excluded.content,
                     ordinal = excluded.ordinal,
                     payload_digest = excluded.payload_digest,
                     payload_name = excluded.payload_name,
                     start_offset = excluded.start_offset,
                     end_offset = excluded.end_offset,
                     chunker_fingerprint = excluded.chunker_fingerprint,
                     projection_schema_version = excluded.projection_schema_version,
                     policy_epoch = excluded.policy_epoch,
                     indexed_at = excluded.indexed_at
       where existing.content is distinct from excluded.content
          or existing.ordinal is distinct from excluded.ordinal
          or existing.payload_digest is distinct from excluded.payload_digest
          or existing.payload_name is distinct from excluded.payload_name
          or existing.start_offset is distinct from excluded.start_offset
          or existing.end_offset is distinct from excluded.end_offset
          or existing.chunker_fingerprint is distinct from excluded.chunker_fingerprint
          or existing.projection_schema_version is distinct from excluded.projection_schema_version
          or existing.policy_epoch is distinct from excluded.policy_epoch
          or existing.indexed_at is distinct from excluded.indexed_at`,
      [this.config.tenantId, CHUNKER_FINGERPRINT, JSON.stringify(rows)],
    );
  }
}

export function passagesForAsset(asset: PublishedAsset): readonly PassageCandidate[] {
  let ordinal = 0;
  return asset.payloads.flatMap((payload): PassageCandidate[] => {
    if (!payload.mediaType.startsWith("text/")) return [];
    const bytes = Buffer.from(payload.data, "base64");
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) return [];
    return chunkUtf8(bytes).map((chunk) => ({
      asset,
      chunkId: passageId(asset.revisionId, payload.digest, chunk.start, chunk.end),
      end: chunk.end,
      ordinal: ordinal++,
      payloadDigest: payload.digest,
      payloadName: payload.name,
      score: 0,
      start: chunk.start,
      text: chunk.text,
    }));
  });
}

export function rankAssetPassages(
  candidates: readonly PassageCandidate[],
  maxPassagesPerAsset = 3,
): readonly RankedAssetResult[] {
  const grouped = new Map<string, PassageCandidate[]>();
  for (const candidate of candidates) {
    const key = assetKey(candidate.asset.spaceId, candidate.asset.revisionId);
    const current = grouped.get(key) ?? [];
    current.push(candidate);
    grouped.set(key, current);
  }
  return [...grouped.values()]
    .map((passages): RankedAssetResult => {
      const ordered = [...passages].sort(comparePassages);
      return {
        asset: ordered[0]!.asset,
        passages: ordered.slice(0, maxPassagesPerAsset),
        score: ordered[0]!.score,
      };
    })
    .sort((left, right) =>
      right.score - left.score ||
      left.asset.revisionId.localeCompare(right.asset.revisionId) ||
      left.asset.spaceId.localeCompare(right.asset.spaceId),
    );
}

export function knowledgeSnapshot(
  assets: readonly PublishedAsset[],
  policyEpoch: string,
): string {
  const projection = {
    assets: assets
      .map((asset) => ({
        indexedAt: asset.indexedAt,
        revisionId: asset.revisionId,
        spaceId: asset.spaceId,
        status: asset.status,
      }))
      .sort((left, right) =>
        left.revisionId.localeCompare(right.revisionId) ||
        left.spaceId.localeCompare(right.spaceId),
      ),
    policyEpoch,
  };
  return `opaque:sha256:${hash(canonicalJson(projection))}`;
}

export function queryFingerprint(body: Record<string, unknown>): string {
  const { cursor: _cursor, limit: _limit, ...stable } = body;
  return `sha256:${hash(canonicalJson(stable))}`;
}

export function encodeCursor(input: {
  readonly offset: number;
  readonly queryFingerprint: string;
  readonly snapshot: string;
}): string {
  const payload = {
    offset: input.offset,
    queryFingerprint: input.queryFingerprint,
    snapshot: input.snapshot,
    version: 1,
  };
  const envelope = { checksum: hash(canonicalJson(payload)), payload };
  return Buffer.from(canonicalJson(envelope), "utf8").toString("base64url");
}

export function decodeCursor(value: string): {
  readonly offset: number;
  readonly queryFingerprint: string;
  readonly snapshot: string;
} | undefined {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== value) return undefined;
    const envelope = JSON.parse(decoded) as {
      readonly checksum?: unknown;
      readonly payload?: Record<string, unknown>;
    };
    if (
      typeof envelope.checksum !== "string" ||
      envelope.payload === undefined ||
      envelope.payload.version !== 1 ||
      !Number.isSafeInteger(envelope.payload.offset) ||
      (envelope.payload.offset as number) < 0 ||
      typeof envelope.payload.queryFingerprint !== "string" ||
      typeof envelope.payload.snapshot !== "string" ||
      hash(canonicalJson(envelope.payload)) !== envelope.checksum
    ) {
      return undefined;
    }
    return {
      offset: envelope.payload.offset as number,
      queryFingerprint: envelope.payload.queryFingerprint,
      snapshot: envelope.payload.snapshot,
    };
  } catch {
    return undefined;
  }
}

export function truncatePassage(
  passage: PassageCandidate,
  maxCharacters: number,
): PassageCandidate {
  const selected = [...passage.text].slice(0, maxCharacters).join("");
  if (selected === passage.text) return passage;
  const byteLength = Buffer.byteLength(selected, "utf8");
  return {
    ...passage,
    end: passage.start + byteLength,
    text: selected,
  };
}

export function lexicalCoverage(query: string, corpus: string, locale?: string): number {
  const terms = lexicalTerms(query, locale);
  if (terms.length === 0) return 0;
  const normalized = normalizeSearch(corpus);
  const matched = terms.filter((term) => normalized.includes(normalizeSearch(term))).length;
  return matched / terms.length;
}

function rankCandidates(
  candidates: readonly PassageCandidate[],
  request: PassageSearchRequest,
): readonly PassageCandidate[] {
  return candidates
    .flatMap((candidate): PassageCandidate[] => {
      if (request.query.reference !== undefined) {
        return candidate.asset.revisionId === request.query.reference
          ? [{ ...candidate, score: 1 / (candidate.ordinal + 1) }]
          : [];
      }
      const score = lexicalScore(
        candidate.text,
        request.query.text ?? "",
        request.mode,
        request.locale,
      );
      return score === undefined ? [] : [{ ...candidate, score }];
    })
    .sort(comparePassages);
}

function lexicalScore(
  content: string,
  query: string,
  mode: "exact" | "lexical",
  locale?: string,
): number | undefined {
  const normalizedContent = normalizeSearch(content);
  const normalizedQuery = normalizeSearch(query);
  const compactContent = normalizeCompact(content);
  const compactQuery = normalizeCompact(query);
  if (compactQuery.length === 0) return undefined;
  const phraseMatched =
    normalizedContent.includes(normalizedQuery) || compactContent.includes(compactQuery);
  if (mode === "exact") {
    if (!phraseMatched) return undefined;
    return roundScore(1 + Math.min(1, compactQuery.length / Math.max(1, compactContent.length)));
  }
  const terms = lexicalTerms(query, locale);
  if (terms.length === 0) return undefined;
  const frequencies = terms.map((term) =>
    occurrences(normalizedContent, normalizeSearch(term)),
  );
  if (!phraseMatched && frequencies.some((frequency) => frequency === 0)) {
    return undefined;
  }
  const coverage = frequencies.filter((frequency) => frequency > 0).length / terms.length;
  const termFrequency =
    frequencies.reduce((total, frequency) => total + Math.log1p(frequency), 0) /
    terms.length;
  const lengthNormalization = 1 / Math.sqrt(Math.max(1, [...content].length / 240));
  return roundScore(
    coverage * 0.55 +
      Math.min(1, termFrequency) * 0.25 +
      (phraseMatched ? 0.35 : 0) +
      Math.min(0.15, lengthNormalization * 0.15),
  );
}

function lexicalTerms(query: string, locale?: string): readonly string[] {
  const unique = new Set<string>();
  try {
    const segmenter = new Intl.Segmenter(locale, { granularity: "word" });
    for (const segment of segmenter.segment(query)) {
      if (segment.isWordLike === true) unique.add(normalizeSearch(segment.segment));
    }
  } catch {
    for (const term of query.split(/[\p{P}\p{S}\s]+/u)) {
      if (term.length > 0) unique.add(normalizeSearch(term));
    }
  }
  if (unique.size === 0) {
    const normalized = normalizeSearch(query);
    if (normalized.length > 0) unique.add(normalized);
  }
  return [...unique];
}

function passagesAtByteOffsets(bytes: Buffer, start: number, end: number): string {
  return bytes.subarray(start, end).toString("utf8");
}

function chunkUtf8(bytes: Buffer): readonly {
  readonly end: number;
  readonly start: number;
  readonly text: string;
}[] {
  if (bytes.byteLength === 0) return [];
  const chunks: Array<{ readonly end: number; readonly start: number; readonly text: string }> = [];
  let start = 0;
  while (start < bytes.byteLength) {
    let end = Math.min(bytes.byteLength, start + CHUNK_MAX_BYTES);
    end = utf8BoundaryBefore(bytes, end);
    if (end < bytes.byteLength) {
      const window = passagesAtByteOffsets(bytes, start, end);
      const boundary = lastTextBoundary(window);
      if (boundary !== undefined) {
        const boundaryBytes = Buffer.byteLength(window.slice(0, boundary), "utf8");
        if (boundaryBytes >= CHUNK_MIN_BOUNDARY_BYTES) end = start + boundaryBytes;
      }
    }
    if (end <= start) end = utf8BoundaryAfter(bytes, Math.min(bytes.byteLength, start + 1));
    const raw = passagesAtByteOffsets(bytes, start, end);
    const leading = raw.match(/^\s+/u)?.[0] ?? "";
    const trailing = raw.match(/\s+$/u)?.[0] ?? "";
    const contentStart = start + Buffer.byteLength(leading, "utf8");
    const contentEnd = end - Buffer.byteLength(trailing, "utf8");
    if (contentEnd > contentStart) {
      chunks.push({
        end: contentEnd,
        start: contentStart,
        text: passagesAtByteOffsets(bytes, contentStart, contentEnd),
      });
    }
    if (end >= bytes.byteLength) break;
    const overlapTarget = Math.max(start + 1, end - CHUNK_OVERLAP_BYTES);
    start = utf8BoundaryAfter(bytes, overlapTarget);
  }
  return chunks;
}

function lastTextBoundary(value: string): number | undefined {
  const minimum = Math.floor(value.length * 0.6);
  for (let index = value.length - 1; index >= minimum; index--) {
    if (/[\n.!?。！？;；]/u.test(value[index]!)) return index + 1;
  }
  return undefined;
}

function utf8BoundaryBefore(bytes: Buffer, requested: number): number {
  let offset = requested;
  while (offset > 0 && offset < bytes.byteLength && (bytes[offset]! & 0xc0) === 0x80) {
    offset--;
  }
  return offset;
}

function utf8BoundaryAfter(bytes: Buffer, requested: number): number {
  let offset = requested;
  while (offset < bytes.byteLength && (bytes[offset]! & 0xc0) === 0x80) offset++;
  return offset;
}

function comparePassages(left: PassageCandidate, right: PassageCandidate): number {
  return (
    right.score - left.score ||
    left.asset.revisionId.localeCompare(right.asset.revisionId) ||
    left.payloadDigest.localeCompare(right.payloadDigest) ||
    left.start - right.start
  );
}

function passageId(
  revisionId: string,
  payloadDigest: string,
  start: number,
  end: number,
): string {
  return `chunk:sha256:${hash(
    `${CHUNKER_FINGERPRINT}\0${revisionId}\0${payloadDigest}\0${start}\0${end}`,
  )}`;
}

function assetKey(spaceId: string, revisionId: string): string {
  return `${spaceId}\0${revisionId}`;
}

function normalizeSearch(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

function normalizeCompact(value: string): string {
  return normalizeSearch(value).replace(/\s+/gu, "");
}

function occurrences(content: string, term: string): number {
  if (term.length === 0) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = content.indexOf(term, offset)) !== -1) {
    count++;
    offset += term.length;
  }
  return count;
}

function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
