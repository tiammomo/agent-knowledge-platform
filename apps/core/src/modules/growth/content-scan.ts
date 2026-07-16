import { sha256Digest } from "../../contracts/revision.js";
import { ProblemError } from "../../platform/problem.js";
import type {
  ContributionRequest,
  InlinePayload,
  PayloadDescriptor,
} from "./types.js";

export type ContentScanSeverity = "high" | "medium" | "low";
export type ContentScanVerdict = "clean" | "review" | "quarantined";

export interface ContentScanFinding {
  readonly code:
    | "secret.private_key"
    | "secret.credential"
    | "content.prompt_injection"
    | "pii.email";
  readonly end: number;
  readonly message: string;
  readonly payloadName: string;
  readonly severity: ContentScanSeverity;
  readonly start: number;
}

export interface ContributionContentScan {
  readonly findingCount: number;
  readonly findings: readonly ContentScanFinding[];
  readonly findingsTruncated: boolean;
  readonly offsetUnit: "utf8-byte";
  readonly scannerVersion: "akep-static-content-scan/1";
  readonly verdict: ContentScanVerdict;
}

interface ScanRule {
  readonly code: ContentScanFinding["code"];
  readonly message: string;
  readonly pattern: RegExp;
  readonly severity: ContentScanSeverity;
}

interface TextPayload {
  readonly name: string;
  readonly text: string;
}

const SCANNER_VERSION = "akep-static-content-scan/1" as const;
const MAX_REPORTED_FINDINGS = 1_000;
const CANONICAL_BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

// High-severity rules run first across every Payload so output truncation can
// never hide a quarantine verdict behind a large volume of low-risk findings.
const SCAN_RULES: readonly ScanRule[] = [
  {
    code: "secret.private_key",
    message: "Private key material must never enter the knowledge index.",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/giu,
    severity: "high",
  },
  {
    code: "secret.credential",
    message: "A credential-shaped value requires quarantine and manual handling.",
    pattern:
      /\b(?:api[_-]?key|secret|password)\s*[:=]\s*['"]?[A-Za-z0-9_./+=-]{16,}/giu,
    severity: "high",
  },
  {
    code: "content.prompt_injection",
    message: "Instruction-like content must remain untrusted and requires reviewer attention.",
    pattern:
      /(?:ignore|disregard) (?:all )?(?:previous|system) instructions|忽略(?:以上|之前|系统)指令/giu,
    severity: "medium",
  },
  {
    code: "pii.email",
    message: "An email address may require redaction under the Space privacy policy.",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
    severity: "low",
  },
] as const;

/**
 * Revalidates and synchronously scans inline P0 text content.
 *
 * The function is deterministic and has no storage or route side effects. It
 * throws a ProblemError for malformed content so a Contribution route can call
 * it directly after contract validation and before persistence.
 */
export function scanContributionContent(
  request: ContributionRequest,
): ContributionContentScan {
  const inlinePayloads = request.inlinePayloads ?? [];
  const isContentContribution = request.kind === "create" || request.kind === "revise";
  if (!isContentContribution) {
    if (request.manifest !== undefined || inlinePayloads.length > 0) {
      throw invalidPayload(
        "Lifecycle contributions cannot carry a Manifest or inline Payload.",
      );
    }
    return emptyScan();
  }
  if (request.manifest === undefined) {
    throw invalidPayload("A content Contribution requires a Manifest.");
  }

  const descriptors = request.manifest.payloads;
  const descriptorByName = uniqueDescriptors(descriptors);
  const inlineByName = uniqueInlinePayloads(inlinePayloads);
  if (descriptors.length !== inlinePayloads.length) {
    throw invalidPayload(
      "Every inline Payload must have exactly one matching Manifest descriptor.",
    );
  }
  for (const name of inlineByName.keys()) {
    if (!descriptorByName.has(name)) {
      throw invalidPayload(`Inline Payload ${name} has no Manifest descriptor.`);
    }
  }

  const payloads = descriptors.map((descriptor) => {
    const inline = inlineByName.get(descriptor.name);
    if (inline === undefined) {
      throw new ProblemError(
        422,
        "AKEP_PAYLOAD_REQUIRED",
        `The synchronous text path requires inline Payload ${descriptor.name}.`,
      );
    }
    return decodeTextPayload(descriptor, inline);
  });

  const findings: ContentScanFinding[] = [];
  let findingCount = 0;
  let highRiskFound = false;
  for (const rule of SCAN_RULES) {
    for (const payload of payloads) {
      const byteOffsets = utf8ByteOffsets(payload.text);
      rule.pattern.lastIndex = 0;
      for (;;) {
        const match = rule.pattern.exec(payload.text);
        if (match === null) break;
        findingCount += 1;
        highRiskFound ||= rule.severity === "high";
        if (findings.length < MAX_REPORTED_FINDINGS) {
          const startIndex = match.index;
          const endIndex = startIndex + match[0].length;
          findings.push({
            code: rule.code,
            end: byteOffsets[endIndex]!,
            message: rule.message,
            payloadName: payload.name,
            severity: rule.severity,
            start: byteOffsets[startIndex]!,
          });
        }
        // All rules consume at least one code unit, but retain this guard if a
        // future rule is accidentally written with a zero-length alternative.
        if (match[0].length === 0) rule.pattern.lastIndex += 1;
      }
      rule.pattern.lastIndex = 0;
    }
  }

  return {
    findingCount,
    findings,
    findingsTruncated: findingCount > findings.length,
    offsetUnit: "utf8-byte",
    scannerVersion: SCANNER_VERSION,
    verdict: highRiskFound
      ? "quarantined"
      : findingCount > 0
        ? "review"
        : "clean",
  };
}

function emptyScan(): ContributionContentScan {
  return {
    findingCount: 0,
    findings: [],
    findingsTruncated: false,
    offsetUnit: "utf8-byte",
    scannerVersion: SCANNER_VERSION,
    verdict: "clean",
  };
}

function uniqueDescriptors(
  descriptors: readonly PayloadDescriptor[],
): ReadonlyMap<string, PayloadDescriptor> {
  const result = new Map<string, PayloadDescriptor>();
  for (const descriptor of descriptors) {
    if (result.has(descriptor.name)) {
      throw invalidPayload(`Manifest Payload name ${descriptor.name} is duplicated.`);
    }
    result.set(descriptor.name, descriptor);
  }
  return result;
}

function uniqueInlinePayloads(
  payloads: readonly InlinePayload[],
): ReadonlyMap<string, InlinePayload> {
  const result = new Map<string, InlinePayload>();
  for (const payload of payloads) {
    if (result.has(payload.name)) {
      throw invalidPayload(`Inline Payload name ${payload.name} is duplicated.`);
    }
    result.set(payload.name, payload);
  }
  return result;
}

function decodeTextPayload(
  descriptor: PayloadDescriptor,
  inline: InlinePayload,
): TextPayload {
  if (inline.encoding !== "base64" || !isCanonicalBase64(inline.data)) {
    throw invalidPayload(`Inline Payload ${descriptor.name} is not canonical base64.`);
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
      `Inline Payload ${descriptor.name} does not match its Manifest digest and size.`,
    );
  }
  let text: string;
  try {
    // Preserve a UTF-8 BOM as U+FEFF so every regex index can still be mapped
    // exactly to the original Payload byte sequence.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ProblemError(
      422,
      "AKEP_PAYLOAD_UTF8_INVALID",
      `Inline Payload ${descriptor.name} is not valid UTF-8 text.`,
    );
  }
  return { name: descriptor.name, text };
}

function isCanonicalBase64(value: string): boolean {
  return CANONICAL_BASE64.test(value) &&
    Buffer.from(value, "base64").toString("base64") === value;
}

function utf8ByteOffsets(value: string): Uint32Array {
  const offsets = new Uint32Array(value.length + 1);
  let byteOffset = 0;
  let codeUnitOffset = 0;
  while (codeUnitOffset < value.length) {
    const codePoint = value.codePointAt(codeUnitOffset)!;
    const codeUnits = codePoint > 0xffff ? 2 : 1;
    // A regex boundary cannot split the scalar values used by current rules,
    // but define the intermediate surrogate position defensively.
    if (codeUnits === 2) offsets[codeUnitOffset + 1] = byteOffset;
    byteOffset += codePoint <= 0x7f
      ? 1
      : codePoint <= 0x7ff
        ? 2
        : codePoint <= 0xffff
          ? 3
          : 4;
    codeUnitOffset += codeUnits;
    offsets[codeUnitOffset] = byteOffset;
  }
  return offsets;
}

function invalidPayload(detail: string): ProblemError {
  return new ProblemError(422, "AKEP_PAYLOAD_INVALID", detail);
}
