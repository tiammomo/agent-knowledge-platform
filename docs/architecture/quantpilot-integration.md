# QuantPilot 接入设计与运行边界

- 状态：本地一期已接通
- 消费方：`/home/tiammomo/projects/dev/QuantPilot`
- 协议：AKEP v0.1 HTTP
- 关联设计：[外部系统接入](external-integration.md)

QuantPilot 通过公开 AKEP 协议消费已发布、带引用的共享知识。两个项目保持独立仓库、独立部署、独立数据库和独立发布周期；唯一运行依赖是版本化 HTTP 契约。

## 职责分工

```text
AKEP Core -- ContextPack/Citation/Receipt --> QuantPilot KnowledgePort --> MoAgent
AKEP Core <-- Usage + evaluator evidence ------ QuantPilot Mission Graph
Memory Core <-> Projection / Usage / Outcome --- QuantPilot MemoryPort
ModelPort -- Qwen/DeepSeek model API ----------> QuantPilot Provider Adapter
```

- 本平台负责 Candidate、审核、发布、Revision、Citation、Space/purpose 授权和 Exposure → Usage → Feedback 证据链。
- QuantPilot 负责用户与项目授权、RunPlan、Mission、工作空间、Agent 上下文、验证和交付。
- ModelPort 负责 Qwen/DeepSeek 等模型协议、路由、凭据、配额和用量；本平台不调用模型。
- 行情、财务、因子与回测事实仍由 QuantPilot market-data/TimescaleDB 管理。
- 用户个性化仍由独立 Memory 服务管理；AKEP 不保存个人偏好。
- 可执行 Skills 仍由 QuantPilot 的制品和沙箱边界管理；AKEP Payload 永远不会被当作代码执行。

## 当前调用链

1. QuantPilot 的可信 planner 先形成可执行 RunPlan。
2. QuantPilot 从 `/.well-known/akep` 发现实例，并核对版本、operation、ContextPack extension、过期时间和同源 Base URL。
3. QuantPilot 使用部署配置固定的 shared Spaces，加上由可信 `Project.id` 派生的 project Space、`quant-research` purpose、`cite/no-train` obligation 支持和字符预算创建 ContextPack；模型不能选择 URL、token、Tenant、Space 或 purpose。
4. ContextPack 作为不可信、只读、带 Citation 的数据进入 MoAgent。它不能覆盖系统提示、金融事实、权限、工具合同、验证或风险控制。
5. QuantPilot 在工作空间保存 Citation、Revision、Payload digest、Policy Epoch 和 Exposure Receipt，不复制建立第二知识库。
6. Agent 调用前，QuantPilot 将 AKEP Exposure、Memory Usage 和内容摘要写入消费者私有的 `evidence/context-uses/<requestId>.json`。该文件不包含个人记忆正文、知识正文或 Citation quote。
7. 只有 QuantPilot Mission 取得 accepted Evidence Receipt 后，才为实际进入 Agent 上下文的 Citation 写 Usage。拒绝、澄清、取消或失败任务不写 Usage。
8. QuantPilot 在自己的服务端数据库保存 Usage、Citation 绑定与 accepted receipt 的不透明归因记录；Agent 可写的工作空间文件不能作为 Feedback 授权依据。
9. Mission 验收不抢占每个 Usage 唯一的最终 Feedback。用户明确选择 helped/neutral/harmed 后，QuantPilot 才引用固定 evaluator 版本、业务事件 ID 和幂等键提交 AKEP Feedback。

Feedback 会进入效果聚合与 harmed 复审队列，但不会直接改排名或 Published Channel。反复成功的经验可以由独立 contributor workload 生成 Candidate，ModelPort/Qwen 只可辅助候选草拟；Candidate 仍需独立 Evaluation、Curator Review 和 Publisher 决策后成为新 Revision。这样下一轮 ContextPack 可以使用更好的已发布知识，同时避免业务 Agent 自评、自审和自发布。

一期不向 MoAgent 注册动态 AKEP 工具，也不授予 contribute/review/publish 权限。后续需要反向沉淀经验时，使用独立 workload 和显式用户/后台动作创建 Candidate，仍由不同身份评测、审核和发布。

三方组合的对象所有权、结果语义和禁止捷径见 [Memory、Knowledge 与任务编排器的组合边界](memory-knowledge-composition.md)。AKEP 不添加 Memory 字段，也不把 QuantPilot 的联合清单变成协议对象。

## 本地运行

QuantPilot 使用 `3000`；AKEP 使用相同尾号 `5` 的独立端口对：Web `33005`、Core `38085`：

```bash
AKEP_HOST_PORT=38085 AKEP_WEB_PORT=33005 docker compose --profile app up -d --build
```

QuantPilot `.env.local`：

```dotenv
QUANTPILOT_KNOWLEDGE_ENABLED=1
QUANTPILOT_KNOWLEDGE_REQUIRED=0
QUANTPILOT_KNOWLEDGE_API_URL=http://localhost:33005
QUANTPILOT_KNOWLEDGE_PURPOSE=quant-research
QUANTPILOT_KNOWLEDGE_SPACES=https://knowledge.local/spaces/default
QUANTPILOT_KNOWLEDGE_PROJECT_SPACES_ENABLED=1
QUANTPILOT_KNOWLEDGE_PROJECT_SPACE_BASE_URL=https://knowledge.local/spaces/quantpilot/projects
QUANTPILOT_KNOWLEDGE_BEARER_TOKEN=dev-reader
```

`QUANTPILOT_KNOWLEDGE_SPACES` 只放跨工作区共享的已发布知识。每个 QuantPilot workspace 另查询 `<PROJECT_SPACE_BASE_URL>/<url-encoded Project.id>`。AKEP 在授权后把精确 Space 集合下推到 Published read model，cursor、Exposure Receipt 和 authorization binding digest 都绑定该集合；不得把项目私有内容放入 shared Space。

验证：

```bash
curl --fail http://localhost:33005/health/ready
curl --fail http://localhost:33005/.well-known/akep
curl --fail http://localhost:3000/api/ready
```

`/api/ready` 的 `knowledge` 组件应为 `ok`。合法空 ContextPack 返回 `empty`，不表示平台确认知识不存在，只表示当前授权 Space、purpose、词法召回与预算下没有匹配条目。

## 生产身份

本地 `dev-reader` 同时具有 query/read/feedback，只用于 development auth。生产使用 OAuth client credentials 或 workload identity 获取 audience/resource-bound 短期 token，至少限制：

- 固定 AKEP resource/audience；
- 与部署 `AKEP_TENANT_ID` 一致的签名 Tenant claim；
- 明确的 QuantPilot Space 与 `quant-research` purpose；
- `akep:query`、`akep:read`、`akep:feedback` 最小 scope；
- 调用方确实能够履行的 `cite`、`no-train` obligation；
- 不授予 review、publish、incident、erase 或 Console scope。

当前 Core 仍是固定单 Tenant 进程模型。动态 Tenant 控制面完成前，不得让互不信任的 QuantPilot Tenant 共享同一个 AKEP 运行实例。

## 故障与停用

- QuantPilot optional 模式：AKEP 超时、拒绝、契约不兼容或空结果显式降级，量化任务继续但不得伪造知识。
- QuantPilot required 模式：知识准备失败时在 Mission 创建前失败关闭。
- 停用时先撤销 QuantPilot workload/token，再设置 `QUANTPILOT_KNOWLEDGE_ENABLED=0`；已发布知识与历史 Usage 不自动删除。
- 不通过共享数据库、复制 Payload、长期查询缓存或私有 Console API 绕过协议边界。
