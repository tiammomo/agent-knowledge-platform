import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import type { Database } from "../../platform/database.js";

interface HealthDependencies {
  readonly config: AppConfig;
  readonly database?: Database;
}

export async function registerHealthRoutes(
  app: FastifyInstance,
  dependencies: HealthDependencies,
): Promise<void> {
  const { config, database } = dependencies;

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => {
    if (database === undefined) {
      if (config.databaseRequired) {
        return reply.code(503).send({ database: "missing", status: "not-ready" });
      }
      return { database: "disabled", status: "ready" };
    }
    if (!(await database.ready())) {
      return reply.code(503).send({ database: "unavailable", status: "not-ready" });
    }
    return { database: "ready", status: "ready" };
  });
}
