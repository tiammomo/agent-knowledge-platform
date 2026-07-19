# 本地开发运行手册

- 状态：当前参考实现
- 最近核对：2026-07-16
- 适用范围：本地开发、演示与测试

## 环境

- Node.js 24、Corepack、pnpm 11。
- Python 3.13 或 3.14、uv。
- Docker Compose（用于 PostgreSQL 17 + pgvector 0.8.5）。

只运行容器化 Web/Core/PostgreSQL 时，宿主机只需要 Docker Compose。执行 `pnpm check` 或
在宿主机启动服务时才需要 Node.js、pnpm、Python 与 uv。

可选的环境核对：

```bash
node --version
corepack pnpm --version
python --version
uv --version
docker compose version
```

Node.js 必须是 24.x；包管理器版本由根 `package.json` 的 `packageManager` 固定。

## 启动

| 方式 | 适合场景 | Web 地址 | Core 地址 |
| --- | --- | --- | --- |
| 完整 Compose | 第一次体验、UI/API 烟雾测试 | `http://localhost:33005` | `http://localhost:38085` |
| PostgreSQL Compose + 宿主机进程 | 开发调试、热更新 | `http://localhost:33005` | `http://localhost:38085` |

完整容器化开发环境：

```bash
AKEP_HOST_PORT=38085 AKEP_WEB_PORT=33005 docker compose --profile app up --build
```

核心容器启动前会取得迁移锁、校验已执行迁移的 SHA-256，并应用新迁移。就绪检查：

```bash
curl http://localhost:33005/ui-health
curl http://localhost:33005/health/ready
curl http://localhost:33005/.well-known/akep
```

浏览器打开 `http://localhost:33005`。Nginx 在同一 Origin 下提供单页应用，并代理
`/.well-known`、`/akep`、`/console`、`/health` 和 `/schemas` 到 Core；因此浏览器不需要
CORS 放宽。直接 Core 端口 `38085` 仍保留给本地协议调试。

只在宿主机运行核心：

```bash
docker compose up -d postgres
cp .env.example .env
pnpm db:migrate
pnpm dev
```

另开一个终端启动前端开发服务器（默认 `33005`，自动代理 Core `38085`）：

```bash
pnpm dev:web
```

Node.js 会通过 `--env-file-if-exists` 读取仓库根目录 `.env`。

停止服务但保留数据库卷：

```bash
docker compose --profile app down
```

## SDK 与 MCP Adapter

TypeScript/Python SDK 和 MCP stdio Adapter 与主仓库一起验证：

```bash
pnpm --filter @akep/sdk build
PYTHONPATH=packages/sdk-python python -m unittest discover -s packages/sdk-python/tests
pnpm --filter @akep/mcp-server build
AKEP_BASE_URL=http://localhost:38085/akep/0.1 \
AKEP_TOKEN=dev-reader \
pnpm --filter @akep/mcp-server start
```

MCP 进程需要 stdio MCP 宿主管理；直接在终端启动时看不到交互 UI。可用 Resource 为
`knowledge://capabilities`，Tools 为 `knowledge_search`、`knowledge_context`、`knowledge_get`、
`knowledge_record_usage`、`knowledge_record_feedback`、`knowledge_submit_candidate`。只读测试请用
`dev-reader`；候选贡献使用 `dev-contributor`，不要为 Agent Adapter 配置治理令牌。

SDK 详细用法见 [TypeScript](../../packages/sdk-ts/README.md) 与
[Python](../../packages/sdk-python/README.md)，MCP 配置见
[Adapter README](../../apps/mcp-server/README.md)。

## 开发身份与职责分离

所有受保护请求都要发送 `AKEP-Version: 0.1`。开发令牌仅在非生产环境有效：

| Bearer 令牌 | Scope | 边界 |
| --- | --- | --- |
| `dev-reader` | read/query/feedback + 内部分类/全 Space/策略 + `cite`/`no-train` 义务能力 | 不能贡献、治理或读取全局控制台 |
| `dev-console` | console + 全分类/全 Space/策略 | 只读取全局控制台业务视图 |
| `dev-observer` | observe | 只读取 Prometheus 指标 |
| `dev-contributor` | contribute/read/query/feedback + `cite`/`no-train` 义务能力 | 不能审核或发布 |
| `dev-evaluator` | evaluate/read | 只能提交独立 EvaluationRun，不能审核或发布 |
| `dev-curator` | review/read | 不能发布 |
| `dev-publisher` | publish/read | 不能紧急撤销或擦除 |
| `dev-incident` | incident/read | 只执行已验证的撤销候选 |
| `dev-eraser` | erase/read | 只执行已验证的擦除候选 |

贡献、审核、发布的写请求还需要 `Idempotency-Key`。修改工作流必须携带上次响应的强
`ETag` 作为 `If-Match`；过期 ETag 返回 412。

精确读取还需要：

- `AKEP-Purpose`：例如 `customer-support`。
- `AKEP-Obligation-Support`：义务数组的 JCS JSON，再做 base64url；
  `['cite','no-train']` 对应 JSON 字节必须是 `["cite","no-train"]`。

请求里的义务列表只会与认证主体的可信义务能力取交集，不能自行增加能力。开发模式仅
`dev-reader`、`dev-contributor` 预置信任 `cite` 与 `no-train`；OIDC 模式必须由签名的
`akep_obligations` claim 发放。

如需在本地验证 OIDC 启动配置，将 `AUTH_MODE=oidc` 并设置 `OIDC_ISSUER`、
`OIDC_AUDIENCE`、`OIDC_JWKS_URI`、`AKEP_TENANT_ID`；token 必须在签名 `akep_tenant`
claim（可由 `OIDC_TENANT_CLAIM` 改名）中携带相同的绝对 URI。此时所有 `dev-*` token 都会
失效。完整的隔离试点配置与观测端点见[生产试点运行手册](production-pilot.md)。

## 验证

```bash
pnpm check
pnpm test:integration
AKEP_WEB_ORIGIN=http://localhost:33005 pnpm smoke:web
docker compose exec -T postgres psql -U akep -d akep \
  -f /dev/stdin < infra/postgres/verify.sql
```

`pnpm check` 覆盖 TypeScript 类型、内存态 API、全部公开 Schema 与示例、2 个 Profile、
JCS 黄金向量、TypeScript/Python SDK、MCP 类型、Python Worker Ruff 和 Pytest。
`pnpm test:integration` 复用相同成长闭环验证真实
PostgreSQL 事务、不可变触发器、Outbox、撤销和反馈证据。

默认脚本会在 Compose PostgreSQL 中创建一次性的 `akep_test_<uuid>` 数据库，迁移和测试完成后
强制断开连接并删除该库，因此测试租户、不可变修订与评测证据不会进入本地 `akep` 开发库。
显式传入 `TEST_DATABASE_URL` 时，数据库生命周期由调用方负责；仅在故障取证时设置
`AKEP_KEEP_TEST_DATABASE=true`，并在排查后删除脚本打印的临时数据库。

`smoke:web` 通过 Web Origin 真实创建示例候选，以 Curator 核验、Publisher 发布，再执行
查询并断言 Revision 与 Citation 可见；它会向目标数据库写入带随机身份的示例知识，不应对共享或
长期保留的数据库运行。需要长期反复执行时，为 Web/Core 配置独立的 smoke 数据库。

推荐按改动范围选择：

| 改动 | 最小验证 |
| --- | --- |
| README/docs | `pnpm docs:check`、`pnpm contracts:check`（协议引用变化时） |
| TypeScript Core/Web/SDK/MCP | `pnpm check` |
| Docker/构建配置 | `pnpm build`、`docker compose --profile app build` |
| 数据库迁移/事务/检索 | `pnpm test:integration`、`infra/postgres/verify.sql` |
| 端到端产品闭环 | Compose + `pnpm smoke:web` |

## 数据重置

以下命令会删除本项目的本地 PostgreSQL 卷及其中所有数据：

```bash
docker compose --profile app down -v
```

该命令不可恢复。只想重启服务时使用不带 `-v` 的 `docker compose --profile app down`。

## 常见问题

### 端口已经被占用

```bash
AKEP_HOST_PORT=38086 AKEP_WEB_PORT=33006 docker compose --profile app up --build
```

此时 Web 为 `http://localhost:33006`，Core 为 `http://localhost:38086`。

### `/health/live` 正常但 `/health/ready` 失败

`live` 只说明进程存活，`ready` 还会检查数据库、迁移和必要扩展。先查看：

```bash
docker compose ps
docker compose logs postgres core
pnpm db:migrate
```

不要修改已经应用的迁移文件；迁移摘要变化会被视为完整性错误。修复应新增下一个编号的迁移。

### `pnpm check` 在 Worker 步骤失败

确认 Python 3.13/3.14 与 uv 可用。Worker 依赖由
`workers/knowledge-worker/uv.lock` 固定，不要用根 Node.js 依赖替代。

### MCP 启动后终端没有交互界面

这是预期行为。Adapter 使用 stdio MCP transport，需要由 MCP Host 启动和通信；直接运行只会
等待协议输入。先用 SDK 或 HTTP cURL 验证 Core，再配置 MCP Host。

### 查询返回空结果

Query 只检索已授权的 Published Channel。首次启动数据库为空时，先完成 Web 新手引导或运行
`smoke:web` 创建并发布随机示例；Candidate、Revoked 和无权内容不会出现在结果中。

## 当前开发限制

- `create/revise` 同步路径要求全部 Manifest Payload 以内联 canonical base64 提交，总请求不超过
  10 MiB；生产版应改为隔离上传区和对象存储。
- Query 与 ContextPack 实现词法/精确 Passage 召回；pgvector 表已就位，但尚未生成生产语义嵌入。
- Feedback 只有绑定同组织、任务/上下文/时间一致的 Usage 后才可聚合；自作者和未知相关性信号仍保留为原始证据，不进入质量结论。
- MCP Adapter 已实现为可选独立 stdio 进程，不在默认 Compose 中自动启动；Federation、
  Ingestion Connector 和 A2A Adapter 仍未在默认运行时启用。
- Web Console 将八个访问/治理开发身份映射打包在前端（Prometheus observer 不进入前端），仅适合本地演示；生产必须改为服务端会话或
  OIDC Authorization Code + PKCE，并避免向浏览器暴露高权限长期凭据。

项目文档地图见[文档入口](../README.md)，端点与请求头见
[HTTP API 快速参考](../reference/http-api.md)。
