#!/usr/bin/env node
import { AKEPClient, AKEPError } from "@akep/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const baseUrl = process.env.AKEP_BASE_URL?.trim();
const token = process.env.AKEP_TOKEN?.trim();
if (baseUrl === undefined || baseUrl.length === 0 || token === undefined || token.length === 0) {
  process.stderr.write("AKEP_BASE_URL and AKEP_TOKEN are required\n");
  process.exitCode = 1;
} else {
  await start(baseUrl, token);
}

async function start(baseUrl: string, token: string): Promise<void> {
  const client = new AKEPClient({ baseUrl, token });
  const server = new McpServer({ name: "akep-knowledge", version: "0.1.0" });

  server.registerResource(
    "akep-capabilities",
    "knowledge://capabilities",
    {
      description: "Live capability document for the configured AKEP node.",
      mimeType: "application/json",
      title: "AKEP node capabilities",
    },
    async (uri) => ({
      contents: [{ mimeType: "application/json", text: json(await client.discover()), uri: uri.href }],
    }),
  );

  server.registerTool(
    "knowledge_search",
    {
      annotations: { idempotentHint: true, openWorldHint: false, readOnlyHint: true },
      description: "Search governed published knowledge and return stable passage citations.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(10),
        purpose: z.string().min(1).max(128),
        query: z.string().min(1).max(4000),
        spaces: z.array(z.string().url()).max(50).optional(),
      }),
      title: "Search governed knowledge",
    },
    async ({ limit, purpose, query, spaces }) => tool(async () =>
      client.query({
        limit,
        purpose,
        text: query,
        ...(spaces === undefined ? {} : { spaces }),
      })),
  );

  server.registerTool(
    "knowledge_context",
    {
      annotations: { idempotentHint: true, openWorldHint: false, readOnlyHint: true },
      description: "Build a token-budgeted, citation-ready ContextPack for an Agent task.",
      inputSchema: z.object({
        budgetCharacters: z.number().int().min(256).max(100_000).default(12_000),
        purpose: z.string().min(1).max(128),
        spaces: z.array(z.string().url()).max(50).optional(),
        task: z.string().min(1).max(4000),
      }),
      title: "Build governed context",
    },
    async ({ budgetCharacters, purpose, spaces, task }) => tool(async () =>
      client.createContextPack({
        budgetCharacters,
        purpose,
        task,
        ...(spaces === undefined ? {} : { spaces }),
      })),
  );

  server.registerTool(
    "knowledge_get",
    {
      annotations: { idempotentHint: true, openWorldHint: false, readOnlyHint: true },
      description: "Resolve an immutable knowledge Revision under current policy.",
      inputSchema: z.object({
        purpose: z.string().min(1).max(128),
        revisionId: z.string().startsWith("urn:akep:sha256:"),
        spaceId: z.string().url(),
      }),
      title: "Read immutable knowledge revision",
    },
    async (input) => tool(async () => client.getRevision(input)),
  );

  server.registerTool(
    "knowledge_record_usage",
    {
      annotations: { idempotentHint: false, openWorldHint: false, readOnlyHint: false },
      description: "Record which exposed citations influenced a completed Agent task.",
      inputSchema: z.object({ usage: z.record(z.string(), z.unknown()) }),
      title: "Record governed knowledge usage",
    },
    async ({ usage }) => tool(async () => client.recordUsage(usage)),
  );

  server.registerTool(
    "knowledge_record_feedback",
    {
      annotations: { idempotentHint: false, openWorldHint: false, readOnlyHint: false },
      description: "Attach helped, neutral, harmed or unknown evidence to a real Usage receipt.",
      inputSchema: z.object({ feedback: z.record(z.string(), z.unknown()) }),
      title: "Record outcome evidence",
    },
    async ({ feedback }) => tool(async () => client.recordFeedback(feedback)),
  );

  server.registerTool(
    "knowledge_submit_candidate",
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description: "Submit a candidate Contribution. This never publishes knowledge automatically.",
      inputSchema: z.object({ contribution: z.record(z.string(), z.unknown()) }),
      title: "Submit knowledge candidate",
    },
    async ({ contribution }) => tool(async () => client.contribute(contribution)),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function tool(operation: () => Promise<unknown>) {
  try {
    const result = await operation();
    return { content: [{ type: "text" as const, text: json(result) }] };
  } catch (error) {
    const message = error instanceof AKEPError
      ? `${error.code}: ${error.message} (HTTP ${error.status})`
      : error instanceof Error ? error.message : "Unknown AKEP error";
    return { content: [{ type: "text" as const, text: message }], isError: true };
  }
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
