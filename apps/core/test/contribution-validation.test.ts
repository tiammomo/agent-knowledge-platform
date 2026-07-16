import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { computeRevisionId, sha256Digest } from "../src/contracts/revision.js";
import {
  supportedProfiles,
  validateContribution,
  type SupportedProfile,
} from "../src/modules/growth/validation.js";
import type {
  AssetManifest,
  ContributionRequest,
  InlinePayload,
  PayloadDescriptor,
} from "../src/modules/growth/types.js";
import { ProblemError } from "../src/platform/problem.js";

const PROCEDURE_PROFILE = "https://agentknowledge.dev/profiles/procedure/1";
const SOURCE_PROFILE = "https://agentknowledge.dev/profiles/source-document/1";
const config = loadConfig(
  { AUTH_MODE: "development", NODE_ENV: "test" },
  import.meta.url,
);
const profiles = supportedProfiles(config);
const exampleManifest = JSON.parse(
  readFileSync(join(config.contractRoot, "examples", "asset-manifest.json"), "utf8"),
) as AssetManifest;

interface RequestOptions {
  readonly baseRevisionIds?: readonly string[];
  readonly bytes?: Uint8Array;
  readonly kind?: "create" | "revise";
  readonly language?: string | null;
  readonly manifest?: (manifest: AssetManifest) => AssetManifest;
  readonly mediaType?: string;
  readonly parents?: readonly string[];
  readonly profileId?: string;
}

function profile(profileId: string): SupportedProfile {
  const supported = profiles.get(profileId);
  expect(supported).toBeDefined();
  return supported!;
}

function contribution(options: RequestOptions = {}): ContributionRequest {
  const profileId = options.profileId ?? PROCEDURE_PROFILE;
  const supported = profile(profileId);
  const bytes = Buffer.from(options.bytes ?? Buffer.from("# 安全知识\n", "utf8"));
  const digest = sha256Digest(bytes);
  const language = options.language === undefined
    ? supported.document.primaryPayload.languages?.[0]
    : options.language;
  const descriptor: PayloadDescriptor = {
    digest,
    ...(language === null || language === undefined ? {} : { language }),
    mediaType: options.mediaType ?? supported.document.primaryPayload.mediaTypes[0]!,
    name: "primary",
    size: bytes.byteLength,
  };
  const baseManifest: AssetManifest = {
    ...structuredClone(exampleManifest),
    assetType: supported.assetType,
    parents: options.parents ?? [],
    payloads: [descriptor],
    profile: { digest: supported.digest, uri: profileId },
  };
  const manifest = options.manifest?.(baseManifest) ?? baseManifest;
  const inlinePayload: InlinePayload = {
    data: bytes.toString("base64"),
    digest,
    encoding: "base64",
    name: "primary",
  };
  const kind = options.kind ?? "create";
  return {
    akepVersion: "0.1",
    ...(options.baseRevisionIds === undefined
      ? {}
      : { baseRevisionIds: options.baseRevisionIds }),
    clientSubmissionId: "profile-validation-test",
    critical: [],
    evidenceRefs: [],
    inlinePayloads: [inlinePayload],
    kind,
    manifest,
    rationale: "Validate the executable Profile gates.",
    revisionId: computeRevisionId(manifest),
    spaceId: "https://knowledge.test/spaces/profile-validation",
  };
}

function captureProblem(operation: () => unknown): ProblemError {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ProblemError);
  return caught as ProblemError;
}

describe("executable contribution Profile gates", () => {
  it("loads the complete immutable Profile document", () => {
    const procedure = profile(PROCEDURE_PROFILE);

    expect(procedure.document.profileId).toBe(PROCEDURE_PROFILE);
    expect(procedure.document.primaryPayload).toEqual({
      languages: ["zh-CN"],
      mediaTypes: ["text/markdown; charset=utf-8"],
    });
    expect(procedure.document.requiredManifestFields).toContain("/scope");
    expect(procedure.document.allowedRelations).toContain("derived_from");
  });

  it("accepts a valid Profile-conformant UTF-8 contribution", () => {
    const request = contribution();

    const validated = validateContribution(request, profiles);

    expect(validated.subjectRevisionId).toBe(request.revisionId);
    expect(validated.payloads).toHaveLength(1);
    expect(validated.payloads[0]).toMatchObject({
      mediaType: "text/markdown; charset=utf-8",
      name: "primary",
    });
  });

  it.each([
    ["classification", "public", "Company Internal"],
    ["export", "allow", "policy.export=deny"],
    ["licenses", ["MIT"], "LicenseRef-Company-Internal"],
  ] as const)("enforces the fixed governance floor for policy.%s", (field, value, message) => {
    const problem = captureProblem(() =>
      validateContribution(
        contribution({
          manifest: (manifest) => ({
            ...manifest,
            policy: { ...manifest.policy, [field]: value },
          }),
        }),
        profiles,
      ),
    );

    expect(problem.code).toBe("AKEP_PROFILE_VIOLATION");
    expect(problem.message).toContain(message);
  });

  it("rejects knowledge outside the CN pilot jurisdiction", () => {
    const problem = captureProblem(() =>
      validateContribution(
        contribution({
          manifest: (manifest) => ({
            ...manifest,
            scope: {
              ...(manifest.scope as Record<string, unknown>),
              jurisdiction: "US",
            },
          }),
        }),
        profiles,
      ),
    );

    expect(problem.code).toBe("AKEP_PROFILE_VIOLATION");
    expect(problem.message).toContain("scope.jurisdiction");
  });

  it("rejects a primary media type outside the Profile allowlist", () => {
    const problem = captureProblem(() =>
      validateContribution(
        contribution({ mediaType: "text/plain; charset=utf-8" }),
        profiles,
      ),
    );

    expect(problem.code).toBe("AKEP_PROFILE_VIOLATION");
    expect(problem.message).toContain("Primary Payload media type");
  });

  it.each([
    ["missing", null],
    ["outside the allowlist", "en-US"],
  ] as const)("rejects a %s primary language", (_label, language) => {
    const problem = captureProblem(() =>
      validateContribution(contribution({ language }), profiles),
    );

    expect(problem.code).toBe("AKEP_PROFILE_VIOLATION");
    expect(problem.message).toContain("Primary Payload language");
  });

  it("enforces requiredManifestFields", () => {
    const problem = captureProblem(() =>
      validateContribution(
        contribution({
          manifest: (manifest) => {
            const { scope: _scope, ...withoutScope } = manifest;
            return withoutScope;
          },
        }),
        profiles,
      ),
    );

    expect(problem.code).toBe("AKEP_PROFILE_VIOLATION");
    expect(problem.message).toContain("/scope");
  });

  it("enforces nested scopeRequirements", () => {
    const problem = captureProblem(() =>
      validateContribution(
        contribution({
          manifest: (manifest) => {
            const scope = manifest.scope as Record<string, unknown>;
            const { reviewAfter: _reviewAfter, ...withoutReviewAfter } = scope;
            return { ...manifest, scope: withoutReviewAfter };
          },
        }),
        profiles,
      ),
    );

    expect(problem.code).toBe("AKEP_PROFILE_VIOLATION");
    expect(problem.message).toContain("/scope/reviewAfter");
  });

  it("rejects relation types outside allowedRelations", () => {
    const problem = captureProblem(() =>
      validateContribution(
        contribution({
          manifest: (manifest) => ({
            ...manifest,
            relations: [
              {
                target: "https://knowledge.test/assets/consumer",
                type: "used_in",
              },
            ],
          }),
        }),
        profiles,
      ),
    );

    expect(problem.code).toBe("AKEP_PROFILE_VIOLATION");
    expect(problem.message).toContain("used_in");
  });

  it("routes Profile-allowed PDF content to asynchronous ingestion", () => {
    const problem = captureProblem(() =>
      validateContribution(
        contribution({
          bytes: Buffer.from("%PDF-1.7\n", "ascii"),
          mediaType: "application/pdf",
          profileId: SOURCE_PROFILE,
        }),
        profiles,
      ),
    );

    expect(problem.statusCode).toBe(422);
    expect(problem.code).toBe("AKEP_INGESTION_REQUIRED");
  });

  it("rejects malformed UTF-8 on the synchronous text path", () => {
    const problem = captureProblem(() =>
      validateContribution(
        contribution({ bytes: Uint8Array.from([0xc3, 0x28]) }),
        profiles,
      ),
    );

    expect(problem.code).toBe("AKEP_PAYLOAD_UTF8_INVALID");
  });

  it("applies the Profile media allowlist to secondary inline Payloads", () => {
    const primaryBytes = Buffer.from("# Primary\n", "utf8");
    const secondaryBytes = Buffer.from("secondary", "utf8");
    const request = contribution({
      bytes: primaryBytes,
      manifest: (manifest) => ({
        ...manifest,
        payloads: [
          manifest.payloads[0]!,
          {
            digest: sha256Digest(secondaryBytes),
            mediaType: "text/plain; charset=utf-8",
            name: "secondary",
            size: secondaryBytes.byteLength,
          },
        ],
      }),
    });
    const withSecondary: ContributionRequest = {
      ...request,
      inlinePayloads: [
        request.inlinePayloads![0]!,
        {
          data: secondaryBytes.toString("base64"),
          digest: sha256Digest(secondaryBytes),
          encoding: "base64",
          name: "secondary",
        },
      ],
    };

    const problem = captureProblem(() => validateContribution(withSecondary, profiles));
    expect(problem.code).toBe("AKEP_PROFILE_VIOLATION");
    expect(problem.message).toContain("secondary");
  });

  it.each(["create", "revise"] as const)(
    "rejects multi-parent %s contributions while review is linear",
    (kind) => {
      const parents = [
        `urn:akep:sha256:${"c".repeat(64)}`,
        `urn:akep:sha256:${"d".repeat(64)}`,
      ];
      const problem = captureProblem(() =>
        validateContribution(
          contribution({
            ...(kind === "revise" ? { baseRevisionIds: parents } : {}),
            kind,
            parents,
          }),
          profiles,
        ),
      );

      expect(problem.code).toBe("AKEP_MERGE_UNSUPPORTED");
    },
  );
});
