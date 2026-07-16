import { createHash } from "node:crypto";
import { canonicalize } from "json-canonicalize";

export function canonicalJson(value: unknown): string {
  return canonicalize(value);
}

export function sha256Digest(bytes: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function computeRevisionId(manifest: unknown): string {
  const digest = sha256Digest(canonicalJson(manifest));
  return `urn:akep:${digest}`;
}
