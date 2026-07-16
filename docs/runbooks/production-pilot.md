# 隔离生产试点运行手册

当前仓库适合在单租户、受控网络、可回滚的试点环境中部署，不代表已经通过通用多租户或
互联网生产验收。本手册只覆盖已经实现的 OIDC、PostgreSQL、限流、OpenTelemetry 导出与
MCP 接入；外部 PDP、租户 RLS、对象存储和外部恶意文件扫描仍是扩大部署范围前的门禁。

## 1. 启动门禁

生产进程至少配置：

```dotenv
NODE_ENV=production
AUTH_MODE=oidc
OIDC_ISSUER=https://identity.example.com
OIDC_AUDIENCE=https://knowledge.example.com/akep/0.1
OIDC_JWKS_URI=https://identity.example.com/.well-known/jwks.json
OIDC_ACCESS_TOKEN_TYPES=at+jwt
OIDC_MAX_TOKEN_LIFETIME_SECONDS=3600
AKEP_PUBLIC_ORIGIN=https://knowledge.example.com
DATABASE_URL=postgres://akep:REDACTED@postgres.internal:5432/akep
DATABASE_REQUIRED=true
TRUST_PROXY=true
RATE_LIMIT_MAX=300
RATE_LIMIT_WINDOW=1 minute
SLO_P95_MILLISECONDS=800
OTEL_EXPORTER_OTLP_ENDPOINT=https://otel-collector.internal:4318
OTEL_SERVICE_NAME=akep-core
```

Core 在 `NODE_ENV=production` 下拒绝 development auth；OIDC 模式缺少 issuer、audience 或
JWKS URI 也会拒绝启动。JWT 校验固定 issuer/audience，接受 `RS256`、`ES256` 或 `EdDSA`；
令牌必须同时含 `sub`、`iat`、`exp`，受保护头 `typ` 必须命中
`OIDC_ACCESS_TOKEN_TYPES`，且 `exp > iat`、令牌总寿命不超过
`OIDC_MAX_TOKEN_LIFETIME_SECONDS`。默认兼容 `at+jwt` 与 `JWT`，生产应把白名单缩到身份源实际
签发的单一 access-token 类型，避免把 ID Token 当作访问令牌。scope 从 `scope` 或 `scp` claim
读取。反向代理必须终止 HTTPS、限制请求体，并只在可信代理链路上设置 `TRUST_PROXY=true`。

启动前先执行并审计迁移：

```bash
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm check
pnpm build
pnpm start
```

就绪探针使用 `/health/ready`。Core 会把仓库内全部迁移名称和 SHA-256 与
`platform.schema_migration` 精确比对，并检查关键索引、触发器和扩展；生产必须让
`DATABASE_REQUIRED=true`，否则数据库不可用、迁移缺失或已应用文件被修改时不会通过启动门禁。

## 2. 身份与最小权限

Identity Provider 至少发放以下职责分离 scope：

| 职责 | Scope |
| --- | --- |
| Reader / Agent | `akep:read akep:query akep:feedback` + Space、分类与策略授权 |
| Contributor | `akep:contribute` + 目标 Space 授权 |
| Evaluator | `akep:evaluate` + 目标 Space 授权 |
| Curator | `akep:review` + 目标 Space 授权 |
| Publisher | `akep:publish` + 目标 Space 授权 |
| Incident responder | `akep:incident` + 目标 Space 授权 |
| Eraser | `akep:erase` + 目标 Space 授权 |
| Global Console operator | `akep:console akep:space:* akep:classification:* akep:policy:*` |
| Metrics collector | `akep:observe` |

Space 可用 `akep:space:*`，生产更推荐 `akep:space:<percent-encoded-space-uri>`；当前固定治理 floor
只接收 `classification=internal`、`jurisdiction=CN`、`LicenseRef-Company-Internal` 与
`export=deny`，Reader 还需 `akep:classification:internal`。Manifest 引用了访问或使用策略时，
调用方还需对应 `akep:policy:<sha256-digest>`；只有受控服务身份才使用 `akep:policy:*`。`restricted`
分类在 v0.1 试点中始终拒绝。OIDC `scope`/`scp` claim 示例：

```text
akep:read akep:query akep:feedback akep:space:https%3A%2F%2Fknowledge.example.com%2Fspaces%2Fsupport akep:classification:internal akep:policy:sha256:<digest>
```

消费义务是另一条独立授权边界。Identity Provider 必须按受控 client/workload registration 在
已签名的 `akep_obligations` claim 中发放 Agent 确实能履行的义务，例如：

```json
{"akep_obligations":["cite","no-train"]}
```

该 claim 只接受协议中的 `cite`、`no-train` 或合法 schema reference。Query body 的
`supportedObligations` 与精确读取的 `AKEP-Obligation-Support` 只是本次调用声明，最终能力取它与
签名 claim 的交集；请求头或请求体不能自声明扩权。未配置 claim 等价于不支持任何义务。
因此身份源映射、client 注册和 token exchange 都必须保留这一 claim，并以最小集合签发。

不要给同一长期凭据同时授予贡献、审核和发布。RFC 9728 protected-resource metadata 由
`/.well-known/oauth-protected-resource` 发布；Client 应先读取它与 `/.well-known/akep`，
不要硬编码授权服务器或推测未声明的扩展。

## 3. 观测与 SLO

设置 `OTEL_EXPORTER_OTLP_ENDPOINT` 后，Core 通过 OTLP/HTTP `${endpoint}/v1/traces` 导出
trace，并为响应返回 `X-Request-Id` 与 `Traceparent`。未设置时服务仍能运行，但不导出 trace。

- `GET /console/v1/service-health`：滚动请求 p50/p95、5xx error rate、事件循环 p95 与 SLO 状态。
- `GET /metrics`：Prometheus text exposition，包含全局与 route 请求指标。

服务健康端点要求 `akep:console`，Prometheus 端点要求 `akep:observe`；监控系统应使用单独
工作负载身份。进程内滚动指标会随重启清零，生产长期 SLO、告警与容量趋势必须落到外部
时序系统。业务审计仍以数据库事实/Outbox 为准，不能用 trace 替代。

## 4. MCP 试点

MCP Adapter 是独立 stdio 进程，不随 Core 容器自动启动。构建并将它配置到 Agent 宿主：

```bash
pnpm --filter @akep/sdk build
pnpm --filter @akep/mcp-server build
AKEP_BASE_URL=https://knowledge.example.com/akep/0.1 \
AKEP_TOKEN="$SHORT_LIVED_AKEP_TOKEN" \
pnpm --filter @akep/mcp-server start
```

只读 Agent 使用 `akep:query akep:read` 并同时配置最小 Space、分类、策略授权；需要
Usage/Feedback 或候选贡献时分别增加 `akep:feedback`、`akep:contribute`。Adapter 不应持有
evaluate、review、publish、incident 或 erase。其短期 access token 还必须携带与 Agent 实际
执行能力一致的 `akep_obligations`；SDK/MCP 请求中的 obligation 列表只能进一步收窄它。

## 5. 扩大部署前仍需完成

1. 外部 PDP、租户上下文与 PostgreSQL RLS 越权测试；当前配置中的单个 tenant 不是通用多租户隔离。
2. 把内联 Payload 迁移到加密对象存储隔离区，并接入独立恶意文件扫描、解析沙箱与擦除证明。
3. 用真实身份源验证 token 撤销、JWKS 轮换、时钟偏差、代理头和 rate-limit 分区策略。
4. 建立 OTLP Collector 高可用、Prometheus 长期存储、告警、备份恢复、WORM 审计和故障演练。
5. 完成权限矩阵、提示注入/投毒样本、撤销传播、容量、迁移回滚与灾难恢复验收。
6. 将部署配置型 `policyEpoch` 替换为持久化单调策略/安全水位，并接入独立安全日志；当前只支持单节点试点缓存语义。
7. 为 MCP 增加短期 token 自动刷新与精确领域 Schema；当前 stdio 进程的固定 token 到期后需要重启。

试点 `erase` 会同步停止正文分发并净化在线 Payload/Chunk/Blob 引用、Exposure、Usage 和 Feedback；
不可变 Catalog Manifest、LifecycleEvent、备份及外部缓存仍需生产级密钥销毁、保留策略和 erase proof
协调，不能把当前接口回执当作完整监管擦除证明。

在这些门禁完成前，不启用 Federation、自动晋级、语义/混合检索或可执行能力包。
