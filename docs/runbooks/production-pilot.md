# 隔离生产试点运行手册

- 状态：受控单租户试点基线，不是通用生产认证
- 最近核对：2026-07-17
- 前置阅读：[实现状态与生产门禁](../architecture/implementation-status.md)

当前仓库适合在单租户、受控网络、可回滚的试点环境中部署，不代表已经通过通用多租户或
互联网生产验收。本手册覆盖已经实现的 OIDC、PostgreSQL Tenant RLS、限流、OpenTelemetry
导出与 MCP 接入；动态 Principal Tenant、外部 PDP、对象存储和外部恶意文件扫描仍是扩大部署
范围前的门禁。

试点必须具备明确 Owner、受控网络边界、可停止写流量的入口、数据库备份和回滚窗口。若组织
要求多租户隔离、公开互联网暴露、监管级擦除或高可用 SLO，本手册不足以授权上线。

## 0. Go-No-Go 检查

| 检查 | Go 条件 |
| --- | --- |
| 范围 | 单租户、明确 Space、受控用户和数据分类，未启用有意关闭能力 |
| 身份 | 真实 IdP、短期 access token、最小 scope、职责分离、JWKS 轮换演练 |
| 数据 | 已批准的数据集；10 MiB inline Payload 限制可接受；没有把试点 erase 当监管证明 |
| 数据库 | 独立 migration/runtime 凭据、runtime 非 owner/superuser/`BYPASSRLS`、固定 Tenant、TLS/网络限制、备份恢复和 RLS 负向测试 |
| 入口 | TLS 终止、请求体上限、可信代理链、限流与禁止绕过 Core 直连 |
| 观测 | OTLP/Prometheus 外部落盘、告警接收人、日志脱敏和请求 ID 关联 |
| 回滚 | 已验证上一制品、向前修复迁移方案、停止写入和撤销路径 |
| 验收 | `pnpm check`、`pnpm build`、数据库 integration、权限矩阵和核心 smoke 通过 |

任一项没有明确证据时保持 No-Go，或缩小到本地/非敏感演示。

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
AKEP_TENANT_ID=https://knowledge.example.com/tenants/acme
MIGRATION_DATABASE_URL=postgres://akep_migrator:REDACTED@postgres.internal:5432/akep
DATABASE_URL=postgres://akep_runtime:REDACTED@postgres.internal:5432/akep
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

`MIGRATION_DATABASE_URL` 只供启动期迁移器使用，`DATABASE_URL` 只供 Core 请求路径使用。生产
不能把 table owner、superuser 或带 `BYPASSRLS` 的角色放入 `DATABASE_URL`；Core readiness 会
拒绝这三类角色。启动前先执行并审计迁移：

```bash
pnpm install --frozen-lockfile
pnpm db:migrate
# 首次部署先完成 1.1 的 runtime role 授权与 Tenant 绑定，再启动 Core。
pnpm check
pnpm build
pnpm start
```

就绪探针使用 `/health/ready`。Core 会把仓库内全部迁移名称和 SHA-256 与
`platform.schema_migration` 精确比对，并检查 Tenant session、17 张事实表的 `ENABLE/FORCE
RLS`、`tenant_isolation` 策略、运行角色、关键索引、触发器和扩展；生产必须让
`DATABASE_REQUIRED=true`，否则数据库不可用、迁移缺失或已应用文件被修改时不会通过启动门禁。

容器镜像的 `entrypoint` 会先在 PostgreSQL advisory lock 下运行迁移，再启动服务；多副本仍应
通过部署编排控制并发发布和就绪，不能用自动迁移替代备份、变更评审与兼容性验证。首次应用
`010`/`011` 时必须先用独立 release job 完成 Migration 和下面的角色绑定，再启动 Core；否则
runtime 会按设计拒绝就绪。

### 1.1 数据库角色与 RLS 验收

迁移 owner 创建表和策略；runtime 只获得业务 DML 与迁移清单只读权限。下面是最小基线，角色
密码、TLS、网络和 secret 分发由部署平台管理；`ALTER DEFAULT PRIVILEGES` 必须由实际 migration
owner 执行，并在新增 schema 后同步更新：

```sql
create role akep_runtime
  login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;

grant connect on database akep to akep_runtime;
grant usage on schema catalog, contribution, evaluation, governance, platform, query
  to akep_runtime;
grant select, insert, update, delete on all tables in schema
  catalog, contribution, evaluation, governance, query
  to akep_runtime;
grant select, insert, update, delete on platform.outbox_event to akep_runtime;
grant select on platform.schema_migration to akep_runtime;
grant execute on function platform.current_tenant_id() to akep_runtime;

insert into platform.tenant_runtime_role (database_role, tenant_id)
values ('akep_runtime', 'https://knowledge.example.com/tenants/acme');

alter default privileges for role akep_migrator in schema
  catalog, contribution, evaluation, governance, query
  grant select, insert, update, delete on tables to akep_runtime;
```

迁移后用 runtime 凭据检查实际状态：

```bash
PGOPTIONS="-c akep.tenant_id=$AKEP_TENANT_ID" \
  psql "$DATABASE_URL" --set ON_ERROR_STOP=1 --file infra/postgres/verify.sql
pnpm test:integration
```

验收结果必须显示 17 张表均有 Tenant 列、RLS enabled/forced 和 `tenant_isolation` policy，
`requested_tenant` 与 `effective_tenant` 等于部署 Tenant，当前角色不是 superuser/`BYPASSRLS`。
集成测试还会创建临时受限角色，验证 Tenant A 不能读写 Tenant B、空或伪造上下文默认返回零行，
以及 production readiness 拒绝不安全角色或错误角色绑定。

`010_tenant_row_security.sql` 会优先从已有 Tenant 外键关系推导历史 workflow/lifecycle/receipt/
outbox 数据，其余旧单租户事实才回填为 `AKEP_TENANT_ID`。升级前必须备份；若历史引用指向多个
Tenant，Migration 会拒绝继续，不能用手工改摘要或临时关闭约束绕过。

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

## 5. 发布步骤

1. 固定 Git commit、镜像 digest、Node/pnpm lockfile、配置版本和迁移清单。
2. 备份数据库并完成可恢复性确认；记录当前 `platform.schema_migration`。
3. 在同版本预发布环境运行 `pnpm check`、`pnpm build`、integration 和权限负向测试。
4. 暂停不必要的治理写入，应用迁移；任何摘要不匹配都立即停止发布，不修改旧迁移。
5. 先发布 Core，等待 `/health/ready`，再发布 Web 或 Agent Adapter。
6. 读取 `/.well-known/akep`，核对 origin、profiles、operations、limits 和 Schema URL。
7. 使用各独立身份执行 read/query/contribute/evaluate/review/publish 的允许与拒绝矩阵。
8. 恢复试点流量，观察延迟、5xx、429、数据库连接、事件循环和业务审计事实。

`smoke:web` 会写入并发布随机示例，只能在允许写测试数据的试点环境执行。生产只读验收应使用
预先批准的固定测试资产和独立 Space。

## 6. 回滚与向前修复

- 应用制品可回滚的前提是新迁移与上一版本兼容；发布前必须验证这一点。
- 已应用迁移文件禁止编辑、重命名或删除。数据库变更失败时优先新增向前修复迁移。
- 出现授权、撤销或数据完整性风险时，先停止读/写流量或 fail closed，不以可用性为由恢复旧内容。
- 回滚后重新核对 `/health/ready`、Capability、迁移表、Published 唯一性、撤销状态和旧 Exposure Receipt。
- 若必须从备份恢复，要在隔离环境重放恢复点之后的安全事件/Outbox，并证明 Revoked/Erased
  资产不会复活，再允许服务流量。

数据库 schema 没有自动 down migration。不要在事故中手写反向 SQL；先保全审计证据并由
数据库 Owner 与安全 Owner 共同批准恢复方案。

## 7. 备份、恢复与事故响应

最低运行要求：

- 定期 PostgreSQL 备份、加密、保留和跨故障域副本，并做实际恢复演练。
- 将 bearer token、Payload、内联正文和敏感来源从应用/代理/trace 日志中排除。
- 告警至少覆盖 readiness、5xx、P95、事件循环、数据库连接、限流异常和撤销失败。
- 事故记录保存 commit/image digest、配置版本、Policy Epoch、Request/Trace ID、相关
  Contribution/Decision/LifecycleEvent 与时间线。
- 发现错误知识时由 Incident Responder 执行已验证 revoke；不要让 Publisher 凭据兼任事故凭据。
- 发现凭据泄露时先在 IdP 撤销/禁用主体并轮换相关 secret/JWKS，再评估暴露回执和审计范围。

## 8. 扩大部署前仍需完成

1. 在现有固定 Tenant + 全表 RLS 上完成可信 Principal Tenant、事务级动态上下文、外部 PDP、
   Space 授权下推及对象/缓存/队列/侧信道验收；单个配置 Tenant 不是通用多租户隔离。
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

运行端点与请求约定见[HTTP API 快速参考](../reference/http-api.md)；系统边界见
[系统概览](../architecture/system-overview.md)。
外部系统 onboarding 见[接入运行手册](external-system-onboarding.md)；多团队共享运行时在
[隔离设计](../architecture/multi-team-isolation.md)的迁移与验收完成前保持关闭。
