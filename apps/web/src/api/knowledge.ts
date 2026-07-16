import { canonicalize } from "json-canonicalize";
import type { BuiltContribution } from "./types";

const PROFILE = {
  procedure: {
    digest: "sha256:aae83aa5cd8d97cba553b453544d89e97609c6d91a57109b3ed5ee4897e648b4",
    uri: "https://agentknowledge.dev/profiles/procedure/1",
  },
  source_document: {
    digest: "sha256:53b79a56d342196cc610b2f22f573d2b50a14a923485ade0bcd4ddbbe317b5c4",
    uri: "https://agentknowledge.dev/profiles/source-document/1",
  },
} as const;

export interface KnowledgeDraft {
  readonly assetType: "procedure" | "source_document";
  readonly baseRevisionId?: string;
  readonly content: string;
  readonly evidenceRefs: readonly string[];
  readonly labels: readonly string[];
  readonly primarySources: readonly string[];
  readonly rationale: string;
  readonly recordId?: string;
  readonly spaceId: string;
  readonly summary: string;
  readonly title: string;
}

export async function buildKnowledgeContribution(
  draft: KnowledgeDraft,
): Promise<BuiltContribution> {
  const bytes = new TextEncoder().encode(draft.content);
  const payloadDigest = `sha256:${await sha256(bytes)}`;
  const now = new Date();
  const reviewAfter = new Date(now.getTime() + 90 * 24 * 60 * 60_000);
  const profile = PROFILE[draft.assetType];
  const manifest = {
    assetType: draft.assetType,
    critical: [],
    extensions: {},
    labels: draft.labels,
    manifestVersion: "0.1",
    parents: draft.baseRevisionId === undefined ? [] : [draft.baseRevisionId],
    payloads: [
      {
        digest: payloadDigest,
        language: "zh-CN",
        mediaType: "text/markdown; charset=utf-8",
        name: "primary",
        size: bytes.byteLength,
      },
    ],
    policy: {
      accessPolicyRefs: [],
      allowedPurposes: ["customer-support"],
      classification: "internal",
      export: "deny",
      licenses: ["LicenseRef-Company-Internal"],
      obligations: ["cite", "no-train"],
      owners: ["urn:akep:development:contributor"],
      usagePolicyRefs: [],
    },
    profile,
    provenance: {
      attributedTo: ["urn:akep:development:contributor"],
      generatedBy: {
        activityId: `urn:uuid:${crypto.randomUUID()}`,
        actor: "urn:akep:development:contributor",
        endedAt: now.toISOString(),
        type: "human-authored",
        used: draft.primarySources,
      },
      primarySources: draft.primarySources,
    },
    recordId: draft.recordId ?? `urn:akep:asset:${crypto.randomUUID()}`,
    relations: draft.primarySources.map((source) => ({ type: "derived_from", target: source })),
    scope: {
      assumptions: ["由本地演示工作流创建，发布前必须独立审核"],
      jurisdiction: "CN",
      locale: "zh-CN",
      reviewAfter: reviewAfter.toISOString(),
      validFrom: now.toISOString(),
    },
    summary: draft.summary,
    title: draft.title,
  };
  const revisionId = `urn:akep:sha256:${await sha256(
    new TextEncoder().encode(canonicalize(manifest)),
  )}`;
  return {
    body: {
      akepVersion: "0.1",
      clientSubmissionId: `web-${crypto.randomUUID()}`,
      critical: [],
      ...(draft.baseRevisionId === undefined ? {} : { baseRevisionIds: [draft.baseRevisionId] }),
      evidenceRefs: draft.evidenceRefs,
      extensions: {},
      inlinePayloads: [
        {
          data: bytesToBase64(bytes),
          digest: payloadDigest,
          encoding: "base64",
          name: "primary",
        },
      ],
      kind: draft.baseRevisionId === undefined ? "create" : "revise",
      manifest,
      rationale: draft.rationale,
      revisionId,
      spaceId: draft.spaceId,
    },
    manifest,
    revisionId,
  };
}

async function sha256(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
