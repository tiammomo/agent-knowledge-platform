import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { loadConfig, type AppConfig } from "./config.js";
import { ContractRegistry } from "./contracts/registry.js";
import { registerDiscoveryRoutes } from "./modules/discovery/routes.js";
import { registerHealthRoutes } from "./modules/health/routes.js";
import { registerConsoleRoutes } from "./modules/console/routes.js";
import { registerGrowthRoutes } from "./modules/growth/routes.js";
import { registerEvaluationRoutes } from "./modules/evaluation/routes.js";
import {
  InMemoryGrowthStore,
  PostgresGrowthStore,
  type GrowthStore,
} from "./modules/growth/store.js";
import {
  InMemoryExposureReceiptStore,
  PostgresExposureReceiptStore,
  type ExposureReceiptStore,
} from "./modules/query/exposure-receipt-store.js";
import { registerQueryRoutes } from "./modules/query/routes.js";
import {
  InMemoryQuerySearchStore,
  PostgresQuerySearchStore,
} from "./modules/query/search.js";
import type { QuerySearchStore } from "./modules/query/types.js";
import { createDatabase, type Database } from "./platform/database.js";
import { installAuthentication } from "./platform/auth.js";
import { installObservability } from "./platform/observability.js";
import { installErrorHandling } from "./platform/problem.js";

export interface BuildApplicationOptions {
  readonly config?: AppConfig;
  readonly database?: Database;
  readonly growth?: GrowthStore;
  readonly logger?: boolean;
  readonly receipts?: ExposureReceiptStore;
  readonly search?: QuerySearchStore;
}

export async function buildApplication(
  options: BuildApplicationOptions = {},
): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const app = Fastify({
    bodyLimit: 10_485_760,
    genReqId: () => randomBytes(16).toString("hex"),
    logController: new LogController({
      disableRequestLogging: config.nodeEnv === "test",
    }),
    logger:
      options.logger === false || config.nodeEnv === "test"
        ? false
        : { level: config.logLevel },
    requestIdHeader: false,
    trustProxy: config.trustProxy,
  });
  installErrorHandling(app);
  installAuthentication(app, config);
  installObservability(app, config);
  await app.register(rateLimit, {
    global: true,
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindow,
  });
  app.addHook("onSend", async (_request, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
      .header("Cross-Origin-Resource-Policy", "same-site");
  });

  const contracts = new ContractRegistry(config.contractRoot);
  const ownsDatabase = options.database === undefined && config.databaseUrl !== undefined;
  const database =
    options.database ??
    (config.databaseUrl === undefined
      ? undefined
      : createDatabase(
        config.databaseUrl,
        resolve(config.contractRoot, "../../../infra/postgres/migrations"),
        {
          requireRestrictedRole: config.nodeEnv === "production",
          tenantId: config.tenantId,
        },
      ));
  const receipts =
    options.receipts ??
    (database === undefined
      ? new InMemoryExposureReceiptStore()
      : new PostgresExposureReceiptStore(database.pool, config.tenantId));
  const growth =
    options.growth ??
    (database === undefined
      ? new InMemoryGrowthStore()
      : new PostgresGrowthStore(database.pool, config));
  const search =
    options.search ??
    (database === undefined
      ? new InMemoryQuerySearchStore()
      : new PostgresQuerySearchStore(database.pool, config));

  if (
    config.databaseRequired &&
    (database === undefined || !(await database.ready()))
  ) {
    if (ownsDatabase && database !== undefined) await database.close();
    throw new Error("Required database is unavailable or has pending migrations");
  }

  await registerDiscoveryRoutes(app, { config, contracts });
  await registerHealthRoutes(app, {
    config,
    ...(database === undefined ? {} : { database }),
  });
  await registerConsoleRoutes(app, { config, growth });
  await app.register(
    async (api) => {
      await registerQueryRoutes(api, { config, contracts, growth, receipts, search });
      await registerEvaluationRoutes(api, { config, contracts, growth });
      await registerGrowthRoutes(api, { config, contracts, growth, receipts });
    },
    { prefix: "/akep/0.1" },
  );

  if (ownsDatabase && database !== undefined) {
    app.addHook("onClose", async () => database.close());
  }
  await app.ready();
  return app;
}
