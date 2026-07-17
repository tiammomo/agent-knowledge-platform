import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCapability } from "../api/client";
import { runIntegrationPreflight } from "../api/integration-preflight";
import type { Capability } from "../api/types";
import { OnboardingProvider } from "../contexts/OnboardingContext";
import { AgentSetupPage } from "./AgentSetupPage";

vi.mock("../api/client", () => ({ getCapability: vi.fn() }));
vi.mock("../api/integration-preflight", () => ({ runIntegrationPreflight: vi.fn() }));

function capability(): Capability {
  return {
    auth: { protectedResourceMetadata: "https://knowledge.test/.well-known/oauth-protected-resource" },
    baseUrl: "https://knowledge.test/akep/0.1",
    expiresAt: "2026-07-19T00:00:00.000Z",
    limits: {
      idempotencyWindowSeconds: 86_400,
      maxPageSize: 100,
      maxPayloadBytes: 10_485_760,
    },
    node: {
      id: "https://knowledge.test",
      name: "Test knowledge node",
      trustDomain: "knowledge.test",
    },
    operations: ["query", "resolve", "fetch", "receipt"],
    profiles: ["reader"],
    protocol: "akep",
    schemas: {
      "context-pack": "https://knowledge.test/schemas/context-pack.json",
      "context-pack-request": "https://knowledge.test/schemas/context-pack-request.json",
      query: "https://knowledge.test/schemas/query.json",
    },
    supportedExtensions: [{
      required: false,
      uri: "https://knowledge.test/extensions/context-pack/0.1",
    }],
    versions: ["0.1"],
  };
}

describe("Agent integration setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(getCapability).mockResolvedValue(capability());
  });

  it("does not claim full connectivity before the public preflight runs", async () => {
    render(<OnboardingProvider><AgentSetupPage /></OnboardingProvider>);

    expect(await screen.findByText("Test knowledge node")).toBeTruthy();
    expect(screen.getByText("Discovery 已读取")).toBeTruthy();
    expect(screen.queryByText("公开预检通过")).toBeNull();
    expect(screen.getByText(/不等于完整接入已经可用/u)).toBeTruthy();
  });

  it("renders warnings and their remediation after a real preflight", async () => {
    vi.mocked(runIntegrationPreflight).mockResolvedValue({
      checkedAt: "2026-07-18T00:00:00.000Z",
      checks: [{
        detail: "资源与 Reader scopes 正确，但未声明 authorization_servers。",
        endpoint: "https://knowledge.test/.well-known/oauth-protected-resource",
        id: "oauth",
        label: "OAuth 资源边界",
        remediation: "生产接入前需发布授权服务器。",
        state: "warning",
      }],
      overall: "warning",
    });
    const user = userEvent.setup();
    render(<OnboardingProvider><AgentSetupPage /></OnboardingProvider>);

    await user.click(await screen.findByRole("button", { name: "运行接入检查" }));

    expect(await screen.findByText("预检有提醒")).toBeTruthy();
    expect(screen.getByText("OAuth 资源边界")).toBeTruthy();
    expect(screen.getByText("生产接入前需发布授权服务器。")).toBeTruthy();
    expect(runIntegrationPreflight).toHaveBeenCalledWith({
      publicOrigin: window.location.origin,
    });
  });
});
