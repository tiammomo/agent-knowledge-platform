# HTTP API 快速参考

- 状态：当前参考实现
- 最近核对：2026-07-17
- 协议版本：AKEP v0.1

本页面向需要调用参考实现的开发者，提供运行时端点、请求头、权限和最小示例。完整字段语义以
[AKEP v0.1 协议](../protocols/akep-v0.1.md)和
[OpenAPI / JSON Schema](../../specs/akep/v0.1/README.md)为准。

## 1. 入口

| 入口 | 本地默认地址 | 说明 |
| --- | --- | --- |
| Web 统一入口 | `http://localhost:33005` | SPA，并代理 discovery、AKEP、Console、health 和 schemas |
| Core 直连 | `http://localhost:38085` | 本地协议调试 |
| Capability Discovery | `GET /.well-known/akep` | 无需预知版本，实例能力的首要入口 |
| AKEP Base URL | `/akep/0.1` | Query、读取、贡献、评测与治理 API |
| Console Read Model | `/console/v1` | 私有管理视图，不属于 AKEP Core 协议 |

先检查实例是否就绪并读取能力：

```bash
curl --fail http://localhost:38085/health/ready
curl --fail http://localhost:38085/.well-known/akep
```

客户端不得仅凭仓库 OpenAPI 推断实例已启用某项能力；应读取 discovery 的 `profiles`、
`operations`、`supportedExtensions` 和 `limits`。

## 2. 通用请求约定

| 项目 | 何时需要 | 示例 / 语义 |
| --- | --- | --- |
| `Authorization: Bearer …` | 受保护端点 | 本地使用 `dev-*`；试点使用 audience-bound OIDC access token |
| `AKEP-Version: 0.1` | 除首次 discovery 外的 AKEP 请求 | 不发送或版本不支持会失败 |
| `Content-Type: application/json` | JSON 请求 | 错误返回 RFC 9457 `application/problem+json` |
| `Idempotency-Key` | 写操作 | 同一键重放必须保持相同请求语义 |
| `If-Match` | 修改 Contribution workflow | 使用上次响应的强 ETag，过期返回 412 |
| `AKEP-Purpose` | Resolve / Revision / Blob 精确读取 | 例如 `customer-support` |
| `AKEP-Obligation-Support` | 精确读取 | `base64url-no-pad(JCS(array))` |
| `traceparent` | 可选 | 服务会继续传播 W3C Trace Context |

`["cite","no-train"]` 的 `AKEP-Obligation-Support` 值为：

```text
WyJjaXRlIiwibm8tdHJhaW4iXQ
```

该头只是调用方对本次请求的能力声明，服务端还会与 token 中可信的 `akep_obligations` claim
取交集，不能通过请求头扩权。

OIDC 试点 token 还必须包含签名 Tenant claim，默认名称为 `akep_tenant`，可通过
`OIDC_TENANT_CLAIM` 配置。其值必须是与部署 `AKEP_TENANT_ID` 一致的绝对 URI；Tenant 不接受
请求 header、path、query 或 body 指定。

## 3. 最小查询示例

先完成 Web 首次引导以创建并发布一条示例知识；否则合法查询可能返回空结果。

```bash
curl --fail-with-body http://localhost:38085/akep/0.1/queries \
  -H 'Authorization: Bearer dev-reader' \
  -H 'AKEP-Version: 0.1' \
  -H 'Content-Type: application/json' \
  --data '{
    "query": {
      "text": "退款超过 30 天如何处理？",
      "locale": "zh-CN"
    },
    "mode": "lexical",
    "spaces": ["https://knowledge.local/spaces/default"],
    "filters": {
      "channels": ["published"]
    },
    "purpose": "customer-support",
    "supportedObligations": ["cite", "no-train"],
    "limit": 10,
    "include": ["summary", "passages", "attestations"],
    "extensions": {},
    "critical": []
  }'
```

当前 Core 只启用 `lexical` 和 `exact`。基础协议 Schema 中保留的 `semantic`、`hybrid` 在当前
实例会返回 `AKEP_QUERY_MODE_UNSUPPORTED`，直到 discovery 明确声明支持。

请求中的 `spaces` 只能缩小 token 的 Space scope；显式未授权 Space 返回 403。省略时使用
Principal 的精确 Space 集合或 wildcard。Core 会在 Published 元数据读取和 PostgreSQL Passage
排序/候选上限之前应用该集合；continuation cursor 同时绑定主体、Tenant、Space、purpose、
obligation、scope 与 `policyEpoch`，不能跨身份或授权变化复用。

Query/ContextPack/固定 Revision 读取会返回服务端签发的 Exposure Receipt。只有实际使用其中
Citation 后才应提交 Usage，再用 Usage Receipt 提交 Feedback；客户端不能自造这条证据链。

## 4. 当前运行端点

以下路径除特别标注外均相对于 `/akep/0.1`。

### Reader 与证据链

| HTTP | 路径 | 最小 Scope | 说明 |
| --- | --- | --- | --- |
| POST | `/queries` | `akep:query` | 授权后的 lexical/exact 查询 |
| POST | `/context-packs` | `akep:query` | 按字符/段落/估算 token 预算组装上下文 |
| GET | `/spaces/{spaceId}/records/{recordId}` | `akep:read` | Resolve 当前可见 Head/Channel/Status |
| GET | `/spaces/{spaceId}/revisions/{revisionId}` | `akep:read` | 读取固定 Revision Manifest |
| GET | `/spaces/{spaceId}/revisions/{revisionId}/blobs/{digest}` | `akep:read` | 完整或 Range 读取固定 Payload |
| GET | `/exposure-receipts/{id}` | `akep:read` | 读取仍有效的曝光回执 |
| POST | `/usages` | `akep:feedback` | 将实际采用的 Citation 绑定到曝光 |
| GET | `/usages/{id}` | `akep:feedback` | 读取 Usage Receipt |
| POST | `/feedback` | `akep:feedback` | 写入 helped/neutral/harmed/unknown 证据 |

### Contribution、Evaluation 与 Governance

| HTTP | 路径 | 最小 Scope | 说明 |
| --- | --- | --- | --- |
| POST | `/contributions` | `akep:contribute` | create/revise/deprecate/revoke/erase 候选 |
| GET | `/contributions/{id}` | 所有者或治理 Scope | 返回状态与强 ETag |
| POST | `/contributions/{id}/evidence` | `akep:contribute` | needs_evidence 状态补证 |
| POST | `/contributions/{id}/withdraw` | `akep:contribute` | 撤回未接受候选 |
| POST | `/evaluation-runs` | `akep:evaluate` | 写入固定评测输入并生成 benchmark Attestation |
| GET | `/evaluation-runs/{id}` | `akep:read` | 读取不可变 EvaluationRun |
| POST | `/spaces/{spaceId}/attestations` | `akep:review` | 写入允许类型的非 benchmark Attestation |
| GET | `/spaces/{spaceId}/attestations/{id}` | `akep:read` | 读取 Attestation |
| POST | `/contributions/{id}/decisions` | `akep:review` | verify/reject/needs_evidence/quarantine |
| POST | `/contributions/{id}/actions/publish` | `akep:publish` | 发布已满足门禁的候选 |
| POST | `/contributions/{id}/actions/deprecate` | `akep:publish` | 废弃候选动作 |
| POST | `/contributions/{id}/actions/revoke` | `akep:incident` | 执行已验证撤销候选 |
| POST | `/contributions/{id}/actions/erase` | `akep:erase` | 执行已验证擦除候选 |

所有写操作都应发送 `Idempotency-Key`；工作流动作还应发送最新 `If-Match`。具体 body 不在本页
复制，以对应 JSON Schema 和 Web Console 的真实请求为准。

### 平台与 Console 端点

| HTTP | 绝对路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/.well-known/akep` | 公共 | Capability Discovery |
| GET | `/.well-known/oauth-protected-resource` | 公共 | RFC 9728 Protected Resource Metadata |
| GET | `/schemas/akep/0.1/{schema}` | 公共 | 当前协议 Schema |
| GET | `/health/live` | 公共 | 进程存活 |
| GET | `/health/ready` | 公共 | 配置/数据库/迁移就绪 |
| GET | `/console/v1/overview` | `akep:console` | 全局 Console 概览 |
| GET | `/console/v1/assets` | `akep:console` | Published 资产投影 |
| GET | `/console/v1/contributions` | 治理/贡献 Scope | 候选工作台投影 |
| GET | `/console/v1/evidence-summary` | `akep:console` | Usage/Feedback 汇总 |
| GET | `/console/v1/service-health` | `akep:console` | 进程内延迟、错误率与 SLO |
| GET | `/metrics` | `akep:observe` | Prometheus 文本指标 |

Console API 是参考实现私有 Read Model，不属于 AKEP 互操作契约，客户端不应把它当作稳定公共 API。

## 5. 本地开发身份

`dev-reader`、`dev-contributor`、`dev-evaluator`、`dev-curator`、`dev-publisher`、
`dev-incident`、`dev-eraser`、`dev-console` 和 `dev-observer` 只在
`AUTH_MODE=development` 且非生产环境可用。完整 Scope 与边界见
[本地开发手册](../runbooks/local-development.md#开发身份与职责分离)。

## 6. 错误与重试

AKEP 错误使用 RFC 9457 Problem Details，并包含稳定 `code`。调用方应：

- 对 400/403/404/412/422 修正请求或重新取得授权/ETag，不做盲目重试。
- 对 409 检查幂等键或 Revision/工作流冲突。
- 对 410 重新查询，取得新 cursor 或 Exposure Receipt。
- 对 429/5xx 使用有上限、带 jitter 的退避；写操作必须复用原 Idempotency-Key。
- 记录 `X-Request-Id`、`traceparent` 和 Problem `traceId`，但不要记录 Payload 或 bearer token。

错误码完整列表见协议的[错误章节](../protocols/akep-v0.1.md#17-错误)。

## 7. 协议契约与当前实现的差异

机器 OpenAPI 同时定义 Ingestion、Snapshot、Changes、Delivery ACK 等协议操作；当前默认 Core
没有注册外部 Ingestion Connector 或 Federation 路由。它们是协议边界，不是已上线声明。
同理，Schema 接受 `semantic/hybrid` 枚举不表示当前检索已实现相应投影。

任何集成都应遵循“Discovery → 选择已声明操作 → 固定版本头 → 按 Schema 调用”的顺序。

生产外部系统的注册、contract test、canary、监控、轮换和停用见
[外部系统接入运行手册](../runbooks/external-system-onboarding.md)。
