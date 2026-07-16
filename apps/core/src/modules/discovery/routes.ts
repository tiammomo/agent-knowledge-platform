import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import type { ContractRegistry } from "../../contracts/registry.js";

interface DiscoveryDependencies {
  readonly config: AppConfig;
  readonly contracts: ContractRegistry;
}

export async function registerDiscoveryRoutes(
  app: FastifyInstance,
  dependencies: DiscoveryDependencies,
): Promise<void> {
  const { config, contracts } = dependencies;

  app.get("/.well-known/akep", async (_request, reply) => {
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const capability = {
      auth: {
        protectedResourceMetadata: config.protectedResourceMetadata,
      },
      baseUrl: config.baseUrl,
      critical: [],
      expiresAt,
      extensions: {},
      limits: {
        idempotencyWindowSeconds: 86_400,
        maxPageSize: 100,
        maxPayloadBytes: 10_485_760,
      },
      node: {
        id: config.nodeId,
        name: config.nodeName,
        trustDomain: config.trustDomain,
      },
      operations: [
        "query",
        "resolve",
        "fetch",
        "receipt",
        "contribute",
        "amend",
        "withdraw",
        "usage",
        "feedback",
        "decide",
        "publish",
        "deprecate",
        "revoke",
        "erase",
      ],
      profiles: ["reader", "contributor", "curator", "publisher"],
      protocol: "akep",
      schemas: {
        attestation: `${config.publicOrigin}/schemas/akep/0.1/attestation.schema.json`,
        "context-pack": `${config.publicOrigin}/schemas/akep/0.1/context-pack.schema.json`,
        "context-pack-request": `${config.publicOrigin}/schemas/akep/0.1/context-pack-request.schema.json`,
        manifest: `${config.publicOrigin}/schemas/akep/0.1/asset-manifest.schema.json`,
        contribution: `${config.publicOrigin}/schemas/akep/0.1/contribution.schema.json`,
        "evaluation-run": `${config.publicOrigin}/schemas/akep/0.1/evaluation-run.schema.json`,
        "evaluation-run-request": `${config.publicOrigin}/schemas/akep/0.1/evaluation-run-request.schema.json`,
        feedback: `${config.publicOrigin}/schemas/akep/0.1/feedback.schema.json`,
        query: `${config.publicOrigin}/schemas/akep/0.1/query.schema.json`,
        usage: `${config.publicOrigin}/schemas/akep/0.1/usage.schema.json`,
      },
      supportedExtensions: [
        {
          required: false,
          uri: `${config.publicOrigin}/extensions/akep/context-pack/0.1`,
        },
        {
          required: false,
          uri: `${config.publicOrigin}/extensions/mcp-adapter/0.1`,
        },
      ],
      versions: ["0.1"],
    };
    contracts.assert("capability.schema.json", capability);
    return reply
      .header("AKEP-Version", "0.1")
      .header("Cache-Control", "public, max-age=300")
      .send(capability);
  });

  app.get<{ Params: { schemaName: string } }>(
    "/schemas/akep/0.1/:schemaName",
    async (request, reply) => {
      const schemaName = request.params.schemaName;
      if (!/^[a-z][a-z0-9-]*\.schema\.json$/.test(schemaName)) {
        return reply.callNotFound();
      }
      let schema: unknown;
      try {
        schema = contracts.schema(schemaName);
      } catch {
        return reply.callNotFound();
      }
      const canonical = JSON.stringify(schema);
      const etag = createHash("sha256").update(canonical).digest("hex");
      return reply
        .header("AKEP-Version", "0.1")
        .header("Cache-Control", "public, max-age=3600")
        .header("ETag", `\"sha256:${etag}\"`)
        .send(schema);
    },
  );

  app.get("/.well-known/oauth-protected-resource", async (_request, reply) => {
    return reply.header("Cache-Control", "public, max-age=300").send({
      ...(config.oidc === undefined
        ? {}
        : { authorization_servers: [config.oidc.issuer] }),
      bearer_methods_supported: ["header"],
      resource: config.baseUrl,
      resource_documentation: `${config.publicOrigin}/docs/protocols/akep-v0.1`,
      scopes_supported: [
        "akep:classification:internal",
        "akep:console",
        "akep:contribute",
        "akep:erase",
        "akep:evaluate",
        "akep:feedback",
        "akep:incident",
        "akep:observe",
        "akep:policy:{sha256-digest}",
        "akep:publish",
        "akep:query",
        "akep:read",
        "akep:review",
        "akep:space:{percent-encoded-space-uri}",
      ],
    });
  });
}
