import assert from "node:assert/strict";
import { getOverview, searchKnowledge } from "../src/api/client";
import { importDemoKnowledge } from "../src/api/demo";

const origin = process.env.AKEP_WEB_ORIGIN ?? "http://127.0.0.1:33005";
const nativeFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const target = typeof input === "string" ? new URL(input, origin) : input;
  return nativeFetch(target, init);
}) as typeof fetch;

const demo = await importDemoKnowledge();
assert.equal(demo.published, true);

const query = await searchKnowledge({ query: "Agent 知识贡献检查清单" });
assert.ok(query.results.some((result) => result.revisionId === demo.revisionId));
assert.ok(query.results.every((result) => result.citations.length > 0));

const overview = await getOverview();
assert.ok(overview.totals.published > 0);
assert.ok(overview.totals.knowledge > 0);

process.stdout.write(
  `${JSON.stringify({
    contributionId: demo.contributionId,
    published: overview.totals.published,
    queryResults: query.results.length,
    revisionId: demo.revisionId,
  })}\n`,
);
