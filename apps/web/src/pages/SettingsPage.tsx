import { AlertTriangle, CheckCircle2, Database, Fingerprint, KeyRound, Server, ShieldCheck } from "lucide-react";
import { getCapability, getOverview } from "../api/client";
import { Card, ErrorState, LoadingState, PageHeader, SectionHeader, shortId } from "../components/ui";
import { useAsyncResource } from "../hooks/useAsyncResource";

export function SettingsPage() {
  const capability = useAsyncResource(getCapability, []);
  const overview = useAsyncResource(getOverview, []);
  if (capability.loading || overview.loading) return <LoadingState label="正在读取平台配置" />;
  if (capability.error !== undefined) return <ErrorState error={capability.error} retry={capability.refresh} />;
  if (overview.error !== undefined) return <ErrorState error={overview.error} retry={overview.refresh} />;
  const node = overview.data!.node;
  return (
    <>
      <PageHeader eyebrow="Platform Settings" title="平台设置" subtitle="这里显示服务端公开的运行状态；密钥、原始 token 与敏感策略不会下发到浏览器。" />
      <div className="settings-layout">
        <nav aria-label="设置页面目录" className="settings-nav"><a href="#node-identity"><Server /> 节点身份</a><a href="#runtime"><Database /> 运行环境</a><a href="#roles"><KeyRound /> 身份与角色</a></nav>
        <div className="settings-content">
          <div className="settings-section" id="node-identity"><Card><SectionHeader title="节点身份" description="联邦互操作时由稳定 Node ID 与 Trust Domain 标识知识来源。" /><dl className="settings-list"><div><dt>显示名称</dt><dd>{node.name}</dd></div><div><dt>Node ID</dt><dd><code>{shortId(node.id, 62)}</code></dd></div><div><dt>Trust Domain</dt><dd>{node.trustDomain}</dd></div><div><dt>Base URL</dt><dd><code>{capability.data!.baseUrl}</code></dd></div><div><dt>Policy Epoch</dt><dd><span className="epoch-pill"><Fingerprint size={14} /> {node.policyEpoch}</span></dd></div></dl></Card></div>
          <div className="settings-section" id="runtime"><Card><SectionHeader title="本地开发状态" /><div className="runtime-grid"><div><span className="runtime-icon"><Server /></span><div><strong>Core API</strong><p>AKEP 0.1 · connected</p></div><CheckCircle2 /></div><div><span className="runtime-icon"><Database /></span><div><strong>PostgreSQL + pgvector</strong><p>持久化工作流与检索索引</p></div><CheckCircle2 /></div><div><span className="runtime-icon"><ShieldCheck /></span><div><strong>开发身份映射</strong><p>六个固定角色 token</p></div><CheckCircle2 /></div></div><div className="notice notice-warning"><AlertTriangle /><div><strong>当前不是生产安全配置</strong><p>生产环境必须替换开发 token、启用可信 OIDC/JWKS、外部策略决策点、密钥管理、对象存储、审计导出与备份恢复演练。</p></div></div></Card></div>
          <div className="settings-section" id="roles"><Card><SectionHeader title="职责分离" description="同一个浏览器可以演示流程，但服务端仍按 scope 独立授权。" /><div className="role-grid"><span><b>Contributor</b><small>提交候选 / 补证</small></span><span><b>Curator</b><small>核验 / 拒绝 / 隔离</small></span><span><b>Publisher</b><small>发布 / 废弃</small></span><span><b>Incident</b><small>紧急撤销</small></span><span><b>Erasure</b><small>监管擦除</small></span><span><b>Reader</b><small>查询 / 消费</small></span></div></Card></div>
        </div>
      </div>
    </>
  );
}
