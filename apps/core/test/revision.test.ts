import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { computeRevisionId } from "../src/contracts/revision.js";

describe("revision identity", () => {
  it("matches the RFC 8785 golden vector", () => {
    const config = loadConfig(
      { AUTH_MODE: "development", NODE_ENV: "test" },
      import.meta.url,
    );
    const manifest = JSON.parse(
      readFileSync(
        join(config.contractRoot, "examples", "asset-manifest.json"),
        "utf8",
      ),
    ) as unknown;
    const expected = readFileSync(
      join(config.contractRoot, "examples", "asset-manifest.revision-id.txt"),
      "utf8",
    ).trim();

    expect(computeRevisionId(manifest)).toBe(expected);
  });
});
