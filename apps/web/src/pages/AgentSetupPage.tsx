import { useState } from "react";
import type { ReactNode } from "react";
import {
  Bot,
  Check,
  Clipboard,
  Code2,
  ExternalLink,
  KeyRound,
  Network,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import { getCapability } from "../api/client";
import { useOnboarding } from "../contexts/OnboardingContext";
import { useAsyncResource } from "../hooks/useAsyncResource";
import { Button, Card, ErrorState, LoadingState, PageHeader, SectionHeader, shortId } from "../components/ui";

type Snippet = "typescript" | "python" | "curl" | "mcp";

export function AgentSetupPage() {
  const resource = useAsyncResource(getCapability, []);
  const onboarding = useOnboarding();
  const [tab, setTab] = useState<Snippet>("typescript");
  const [copied, setCopied] = useState(false);
  if (resource.loading) return <LoadingState label="正在发现 AKEP 节点能力" />;
  if (resource.error !== undefined) return <ErrorState error={resource.error} retry={resource.refresh} />;
  const capability = resource.data!;
  const baseUrl = capability.baseUrl.replace(/\/$/u, "");
  const snippets: Record<Snippet, string> = {
    typescript: `import { AKEPClient } from "@akep/sdk";

const knowledge = new AKEPClient({
  baseUrl: "${baseUrl}",
  token: () => obtainAudienceBoundToken(),
  supportedObligations: ["cite", "no-train"]
});
const context = await knowledge.createContextPack({
  task: "如何贡献 Agent 知识？",
  purpose: "customer-support",
  budgetCharacters: 12000
});
if (context.passages.length === 0) throw new Error("证据不足，拒绝回答");
// 回答必须保留 context.citations，并在任务结束后 recordUsage。`,
    python: `from akep_sdk import AKEPClient

knowledge = AKEPClient(
    "${baseUrl}",
    token=obtain_audience_bound_token,
    supported_obligations=("cite", "no-train"),
)
context = knowledge.create_context_pack(
    "如何贡献 Agent 知识？",
    "customer-support",
    budget_characters=12000,
)
if not context["passages"]:
    raise RuntimeError("证据不足，拒绝回答")`,
    curl: `curl --fail-with-body -sS '${baseUrl}/context-packs' \
  -H 'Authorization: Bearer <reader-token>' \
  -H 'AKEP-Version: 0.1' \
  -H 'Content-Type: application/json' \
  --data '{"akepVersion":"0.1","task":"如何贡献 Agent 知识？","mode":"lexical","purpose":"customer-support","budget":{"maxCharacters":12000,"maxPassages":12},"spaces":["https://knowledge.local/spaces/default"],"supportedObligations":["cite","no-train"],"critical":[],"extensions":{}}'`,
    mcp: `{
  "mcpServers": {
    "governed-knowledge": {
      "command": "pnpm",
      "args": ["--filter", "@akep/mcp-server", "start"],
      "env": {
        "AKEP_BASE_URL": "${baseUrl}",
        "AKEP_TOKEN": "<short-lived-reader-token>"
      }
    }
  }
}`,
  };
  const copy = async () => {
    await navigator.clipboard.writeText(snippets[tab]);
    setCopied(true);
    onboarding.completeStep(4);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return (
    <>
      <PageHeader eyebrow="Agent Integration" title="让 Agent 消费同一份可信知识" subtitle="优先请求 ContextPack；Agent 必须执行义务、保留 Passage Citation，并在任务结束后上报 Usage 与 Outcome。" actions={<span className="connected-pill"><i /> 节点已连接</span>} />
      <div className="agent-hero"><div><span className="agent-orbit"><Bot size={34} /></span><div><p className="eyebrow">AKEP / 0.1</p><h2>{capability.node.name}</h2><p>{capability.node.trustDomain ?? "本地信任域"} · {shortId(capability.node.id, 42)}</p></div></div><dl><div><dt>协议版本</dt><dd>{capability.versions.join(", ")}</dd></div><div><dt>Profiles</dt><dd>{capability.profiles.length}</dd></div><div><dt>Operations</dt><dd>{capability.operations.length}</dd></div></dl></div>
      <div className="agent-layout">
        <Card className="code-card">
          <SectionHeader title="ContextPack 与 MCP 接入" description="SDK 自动处理版本、义务、错误和幂等；生产 token 必须绑定 audience 与最小 scopes。" action={<Button onClick={() => void copy()} variant="secondary">{copied ? <Check size={16} /> : <Clipboard size={16} />}{copied ? "已复制" : "复制"}</Button>} />
          <div className="code-tabs"><SnippetTab active={tab === "typescript"} label="TypeScript" icon={<Code2 size={15} />} onClick={() => setTab("typescript")} /><SnippetTab active={tab === "python"} label="Python" icon={<Code2 size={15} />} onClick={() => setTab("python")} /><SnippetTab active={tab === "curl"} label="cURL" icon={<TerminalSquare size={15} />} onClick={() => setTab("curl")} /><SnippetTab active={tab === "mcp"} label="MCP" icon={<Network size={15} />} onClick={() => setTab("mcp")} /></div>
          <pre className="code-block"><code>{snippets[tab]}</code></pre>
        </Card>
        <aside className="agent-checklist"><Card><h3>接入检查</h3><ol><li><span><Network /></span><div><strong>能力发现</strong><p>读取 /.well-known/akep，不猜测节点能力。</p></div></li><li><span><KeyRound /></span><div><strong>最小权限</strong><p>为 Agent 分配用途限定、audience-bound 的短期 token。</p></div></li><li><span><ShieldCheck /></span><div><strong>执行义务</strong><p>不支持 critical obligation 时必须拒绝结果。</p></div></li><li><span><ExternalLink /></span><div><strong>稳定引用与反馈</strong><p>回答绑定 Revision、Payload、locator，再上报 Usage/Feedback。</p></div></li></ol></Card></aside>
      </div>
      <Card><SectionHeader title="节点支持能力" /><div className="capability-grid"><div><strong>Operations</strong><div>{capability.operations.map((item) => <code key={item}>{item}</code>)}</div></div><div><strong>Profiles</strong><div>{capability.profiles.map((item) => <code key={item}>{shortId(item, 52)}</code>)}</div></div></div></Card>
    </>
  );
}

function SnippetTab({ active, icon, label, onClick }: { readonly active: boolean; readonly icon: ReactNode; readonly label: string; readonly onClick: () => void }) {
  return <button className={active ? "active" : ""} onClick={onClick}>{icon} {label}</button>;
}
