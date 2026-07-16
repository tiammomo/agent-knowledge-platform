import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { ContractRegistry } from "../contracts/registry.js";
import { computeRevisionId, sha256Digest, canonicalJson } from "../contracts/revision.js";

const config = loadConfig({ ...process.env, NODE_ENV: "test" });
const contracts = new ContractRegistry(config.contractRoot);
const examples = join(config.contractRoot, "examples");
const mappings = new Map<string, string>([
  ["asset-manifest.json", "asset-manifest.schema.json"],
  ["capability.json", "capability.schema.json"],
  ["contribution.json", "contribution.schema.json"],
  ["exposure-receipt.json", "exposure-receipt.schema.json"],
  ["feedback.json", "feedback.schema.json"],
  ["query-result.json", "query-result.schema.json"],
  ["query.json", "query.schema.json"],
  ["usage.json", "usage.schema.json"],
]);

for (const [file, schemaId] of mappings) {
  contracts.assert(
    schemaId,
    JSON.parse(readFileSync(join(examples, file), "utf8")) as unknown,
  );
}

const profiles = join(config.contractRoot, "profiles");
for (const file of readdirSync(profiles).filter((entry) => entry.endsWith(".json"))) {
  contracts.assert(
    "profile-document.schema.json",
    JSON.parse(readFileSync(join(profiles, file), "utf8")) as unknown,
  );
}

const manifest = JSON.parse(
  readFileSync(join(examples, "asset-manifest.json"), "utf8"),
) as { readonly profile: { readonly digest: string } };
const expectedRevision = readFileSync(
  join(examples, "asset-manifest.revision-id.txt"),
  "utf8",
).trim();
const actualRevision = computeRevisionId(manifest);
if (actualRevision !== expectedRevision) {
  throw new Error(`${actualRevision} != ${expectedRevision}`);
}

const procedureProfile = JSON.parse(
  readFileSync(join(profiles, "mvp-procedure-v1.json"), "utf8"),
) as unknown;
if (sha256Digest(canonicalJson(procedureProfile)) !== manifest.profile.digest) {
  throw new Error("Procedure Profile digest does not match the golden Manifest");
}

const workspaceRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../",
);
const protocol = readFileSync(
  join(workspaceRoot, "docs", "protocols", "akep-v0.1.md"),
  "utf8",
);
let jsonBlockCount = 0;
for (const match of protocol.matchAll(/```json\s*\n([\s\S]*?)\n```/g)) {
  JSON.parse(match[1] ?? "");
  jsonBlockCount += 1;
}

process.stdout.write(
  `contracts ok: ${contracts.schemaCount} schemas, ${mappings.size} examples, ` +
    `${readdirSync(profiles).filter((entry) => entry.endsWith(".json")).length} profiles, ` +
    `${jsonBlockCount} protocol JSON blocks\n`,
);
