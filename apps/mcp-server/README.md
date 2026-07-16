# AKEP MCP Adapter

独立的 MCP stdio 适配进程。它通过 `@akep/sdk` 调用 AKEP Core，知识事实、Revision、
Citation、权限和治理状态仍全部由 Core 决定；MCP 不建立第二事实源。

## 启动

```bash
pnpm --filter @akep/sdk build
pnpm --filter @akep/mcp-server build
AKEP_BASE_URL=https://knowledge.example/akep/0.1 \
AKEP_TOKEN="$AKEP_TOKEN" \
pnpm --filter @akep/mcp-server start
```

`AKEP_BASE_URL` 和 `AKEP_TOKEN` 均为必填。生产中应由 MCP 宿主通过 secret 注入短期、
受 audience 约束的 token；不要把 token 写入配置仓库或模型上下文。当前适配器接收静态
环境变量 token，尚未实现自身的 OAuth token acquisition/refresh。

## 暴露能力

- Resource `knowledge://capabilities`：实时读取配置节点的 Capability 文档。
- `knowledge_search`：受治理检索，read-only。
- `knowledge_context`：生成带引用且有预算上限的 ContextPack，read-only。
- `knowledge_get`：按 Space 读取固定 Revision，并返回可绑定 Usage 的 `exposureReceiptId`，read-only。
- `knowledge_record_usage`：记录实际采用的 Citation。
- `knowledge_record_feedback`：为真实 Usage 写入 helped/neutral/harmed/unknown 证据。
- `knowledge_submit_candidate`：提交候选 Contribution，永远不会直接发布。

Tool annotations 只是 MCP 客户端提示，授权边界始终是 AKEP bearer credential、scope、
Space、purpose、policy 与 obligation 检查。若宿主只需要检索，应给 Adapter 只读 token；
需要贡献或反馈时再按最小权限增加相应 scope。适配器当前不暴露审核、发布、撤销、擦除或
EvaluationRun 工具。
