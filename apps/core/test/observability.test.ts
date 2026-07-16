import { describe, expect, it } from "vitest";
import { buildApplication } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const INBOUND_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const INBOUND_PARENT_ID = "00f067aa0ba902b7";

function testConfig() {
  return loadConfig(
    {
      AKEP_PUBLIC_ORIGIN: "https://knowledge.test",
      AUTH_MODE: "development",
      DATABASE_REQUIRED: "false",
      NODE_ENV: "test",
    },
    import.meta.url,
  );
}

describe("request observability", () => {
  it("continues a valid inbound trace and binds Problem Details to the server trace", async () => {
    const app = await buildApplication({ config: testConfig(), logger: false });
    const response = await app.inject({
      headers: {
        traceparent: `00-${INBOUND_TRACE_ID}-${INBOUND_PARENT_ID}-01`,
      },
      method: "GET",
      url: "/not-registered?secret=must-not-leak",
    });

    expect(response.statusCode).toBe(404);
    const propagated = response.headers.traceparent;
    expect(propagated).toMatch(
      new RegExp(`^00-${INBOUND_TRACE_ID}-[a-f0-9]{16}-01$`, "u"),
    );
    expect(propagated).not.toContain(INBOUND_PARENT_ID);
    expect(response.json().traceId).toBe(INBOUND_TRACE_ID);
    await app.close();
  });

  it("ignores an invalid inbound traceparent and creates a valid server context", async () => {
    const app = await buildApplication({ config: testConfig(), logger: false });
    const response = await app.inject({
      headers: {
        traceparent:
          "00-00000000000000000000000000000000-0000000000000000-01",
      },
      method: "GET",
      url: "/still-not-registered",
    });

    const traceparent = response.headers.traceparent;
    expect(typeof traceparent).toBe("string");
    expect(traceparent).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/u);
    expect(traceparent).not.toContain("00000000000000000000000000000000");
    expect(response.json().traceId).toBe(String(traceparent).split("-")[1]);
    await app.close();
  });

  it("uses route templates and a fixed UNMATCHED bucket for metric cardinality", async () => {
    const app = await buildApplication({ config: testConfig(), logger: false });
    await app.inject({ method: "GET", url: "/attack/one?secret=first-secret" });
    await app.inject({ method: "GET", url: "/attack/two?secret=second-secret" });
    await app.inject({ method: "GET", url: "/.well-known/akep?secret=third-secret" });
    const metrics = await app.inject({
      headers: {
        "akep-version": "0.1",
        authorization: "Bearer dev-observer",
      },
      method: "GET",
      url: "/metrics",
    });

    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain(
      'akep_http_route_requests_total{route="GET UNMATCHED"} 2',
    );
    expect(metrics.body).toContain(
      'akep_http_route_requests_total{route="GET /.well-known/akep"} 1',
    );
    expect(metrics.body).not.toContain("/attack/one");
    expect(metrics.body).not.toContain("/attack/two");
    expect(metrics.body).not.toContain("first-secret");
    expect(metrics.body).not.toContain("second-secret");
    expect(metrics.body).not.toContain("third-secret");
    await app.close();
  });
});
