import { loadConfig } from "./config.js";
import { startTelemetry } from "./platform/telemetry.js";

const config = loadConfig();
const telemetry = startTelemetry(config);
const { buildApplication } = await import("./app.js");
const app = await buildApplication({ config });

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await telemetry.shutdown();
  process.exitCode = 0;
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.fatal({ err: error }, "server startup failed");
  process.exitCode = 1;
}
