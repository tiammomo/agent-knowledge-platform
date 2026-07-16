import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK, type NodeSDKConfiguration } from "@opentelemetry/sdk-node";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import type { AppConfig } from "../config.js";

export interface TelemetryLifecycle {
  shutdown(): Promise<void>;
}

type SpanProcessor = NonNullable<NodeSDKConfiguration["spanProcessors"]>[number];

const discardSpanProcessor: SpanProcessor = {
  async forceFlush() {},
  onEnd() {},
  onStart() {},
  async shutdown() {},
};

export function startTelemetry(config: AppConfig): TelemetryLifecycle {
  const exporter = config.otelTracesEndpoint === undefined
    ? undefined
    : new OTLPTraceExporter({
        url: `${config.otelTracesEndpoint}/v1/traces`,
      });
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.serviceName,
      [ATTR_SERVICE_VERSION]: "0.1.0",
      "akep.node.id": config.nodeId,
      "akep.trust_domain": config.trustDomain,
    }),
    ...(exporter === undefined
      ? { spanProcessors: [discardSpanProcessor] }
      : { traceExporter: exporter }),
  });
  sdk.start();
  return { async shutdown() { await sdk.shutdown(); } };
}
