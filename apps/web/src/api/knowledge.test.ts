import { describe, expect, it } from "vitest";
import { buildKnowledgeContribution } from "./knowledge";

describe("browser contribution builder", () => {
  it("binds the payload and canonical manifest to SHA-256 identities", async () => {
    const built = await buildKnowledgeContribution({
      assetType: "procedure",
      content: "# 安全检查\n\n1. 先检查来源。",
      evidenceRefs: [],
      labels: ["safety", "agent"],
      primarySources: [],
      rationale: "验证浏览器侧贡献构建器。",
      spaceId: "https://knowledge.local/spaces/default",
      summary: "供 Agent 使用的安全检查步骤。",
      title: "安全检查",
    });

    expect(built.revisionId).toMatch(/^urn:akep:sha256:[a-f0-9]{64}$/u);
    expect(built.manifest).toMatchObject({
      assetType: "procedure",
      labels: ["safety", "agent"],
      manifestVersion: "0.1",
      title: "安全检查",
    });
    const body = built.body as {
      readonly inlinePayloads: readonly { readonly data: string; readonly digest: string }[];
      readonly revisionId: string;
    };
    expect(body.revisionId).toBe(built.revisionId);
    const binary = atob(body.inlinePayloads[0]!.data);
    const decoded = new TextDecoder().decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
    expect(decoded).toBe("# 安全检查\n\n1. 先检查来源。");
    expect(body.inlinePayloads[0]!.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("binds an explicitly selected consumer purpose into policy", async () => {
    const built = await buildKnowledgeContribution({
      allowedPurposes: ["quant-research"],
      assetType: "procedure",
      content: "# QuantPilot 验收\n\n只允许量化研究用途。",
      evidenceRefs: [],
      labels: ["quantpilot", "acceptance"],
      primarySources: [],
      rationale: "验证外部 Agent 可选择受治理用途。",
      spaceId: "https://knowledge.local/spaces/quantpilot-acceptance",
      summary: "QuantPilot 接入验收知识。",
      title: "QuantPilot 验收",
    });

    expect(built.manifest).toMatchObject({
      policy: { allowedPurposes: ["quant-research"] },
    });
  });
});
