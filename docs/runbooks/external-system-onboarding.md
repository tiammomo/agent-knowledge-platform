# 外部系统接入运行手册

- 状态：当前人工接入路径 + 目标自动化清单
- 最近核对：2026-07-17
- 架构前置：[外部系统接入设计](../architecture/external-integration.md)

本手册用于把一个外部业务系统或 Agent Host 安全接入知识平台。当前参考实现没有自助 Integration
Registry，OIDC client、Space scope、配额和审批仍需平台管理员在 IdP/部署配置中完成；Tenant
使用签名 claim 与单个部署 Tenant 做严格一致性绑定。

> [!WARNING]
> 当前 Core 的 Tenant 由整个进程的 `AKEP_TENANT_ID` 固定，不支持按 client 映射多个 Tenant。
> OIDC token 必须携带与它一致的签名 Tenant claim，数据库全表 Tenant RLS 作为第二道防线；但
> 一个试点实例仍只能承载一个受控 Tenant。控制面多租户映射、动态事务上下文和全链路隔离验收
> 完成前，不得把互不信任 Tenant 接到同一实例。下文的跨 Tenant/统计侧信道测试仍属于目标门禁。

## 1. 接入申请

申请必须回答：

| 项目 | 示例 |
| --- | --- |
| 业务 Owner / 技术 Owner / 安全联系人 | Support / Platform / Security On-call |
| 调用主体 | backend service、batch job、MCP Host |
| 目标 Tenant / Space | local tenant / support Space |
| 操作 | read/query/feedback；是否确需 contribute |
| purpose | `customer-support` |
| obligations | `cite`、`no-train`，以及客户端如何履行 |
| 数据分类/地域/许可证 | internal、CN、内部许可证 |
| 流量 | QPS、并发、最大结果、Blob 字节、批任务 |
| 数据写入 | 无、规范 Contribution、未来 Connector/Ingestion |
| 保留/日志 | 是否保存 Payload、Citation、Usage；保留多久 |
| 停用条件 | Owner 离职、应用下线、事件、凭据过期 |

默认批准模板是：单 Tenant、单 Space、单 purpose、read/query、小配额、无治理权限。

## 2. 管理员准备

1. 在 IdP 注册 workload client，使用短期 access token；生产优先 private_key_jwt/mTLS。
2. 固定 audience/resource 为 AKEP Base URL。
3. 当前确认该 client 只访问本实例固定 Tenant；在签名 `akep_tenant`（或部署配置的
   `OIDC_TENANT_CLAIM`）中发放与 `AKEP_TENANT_ID` 完全一致的绝对 URI。目标态再由控制面把
   issuer + client 映射到唯一 Tenant 和 Integration Owner。
4. 只发所需 scope、Space、classification、policy 和可信 `akep_obligations`；不得接受客户端
   header、path、query 或 body 自报 Tenant。
5. 设置 token 最大寿命、密钥轮换、速率/并发/字节配额和停用日期。
6. 记录审批、配置版本、测试 Space 和事故联系人。

普通 Integration 不得获得 `akep:review`、`akep:publish`、`akep:incident`、`akep:erase`、
`akep:console` 或 `akep:observe`。

## 3. 客户端契约测试

### 3.1 Discovery

```bash
curl --fail https://knowledge.example.com/.well-known/akep
curl --fail https://knowledge.example.com/.well-known/oauth-protected-resource
```

核对 `baseUrl`、`versions`、`profiles`、`operations`、`schemas`、`limits` 和
`expiresAt`。客户端缓存到 expiresAt 之前，并能在 Capability 变化后重新发现。

### 3.2 认证负向测试

必须验证：

- 无 token、错误 issuer/audience/`typ`/算法、过期或寿命过长 token 拒绝。
- 缺失、格式错误或不匹配的签名 Tenant claim，错误 Space、缺 scope、错误 purpose、不能履行
  obligation 均拒绝。
- Integration 被停用/Group 移除后旧 token/Receipt/cache fail closed。
- 已知其他 Space 的 Record/Revision/Blob/Receipt ID 不可读取。

不要只测 200 happy path。

### 3.3 最小查询

从[HTTP API 快速参考](../reference/http-api.md#3-最小查询示例)的 lexical Query 开始。测试资产
使用独立测试 Space；生产数据不可复制到开发环境。

验证响应：

- 只包含授权 Space 的 Published Revision。
- 使用另一主体重放 continuation cursor 会失败；未授权 Space 不影响授权结果集和排名。
- Citation 固定 `revisionId + payloadDigest + locator`。
- Exposure Receipt 存在、未过期并绑定同一 purpose/subject/Space。
- 零结果是正常响应，不改用更高权限 token 猜测内容存在性。

### 3.4 Usage / Feedback

只有实际采用 Citation 时写 Usage；Feedback 引用同一 Usage Receipt。重试复用
`Idempotency-Key`，但新的业务使用生成新的 `clientUsageId`。不要把搜索曝光自动当作“使用成功”。

## 4. 写入能力

若外部系统确需贡献：

1. 先在测试 Space 用固定样例验证 Manifest、JCS Revision ID、Payload digest 和幂等。
2. 固定 source object → recordId 映射，不因每次同步创建新 Record。
3. 提交结果只能是 Candidate；读取它需要贡献/治理工作台权限，普通 Query 不可见。
4. 用不同身份完成 Evaluate、Curator、Publisher 的允许与拒绝矩阵。
5. 批量上线先 dry-run diff，限定每日 Candidate 和 Payload 字节。

当前原始 PDF 等不走同步 Contribution；异步 Ingestion/Connector runtime 未实现，不得把文件解析
放在 Core 进程或让平台抓取任意 URL。

## 5. Canary 与放量

| 阶段 | 流量 | 写能力 | 成功条件 |
| --- | --- | --- | --- |
| Contract | 固定测试 | 无 | discovery/auth/Schema/负向测试通过 |
| Shadow | 镜像请求，不向用户返回 | 无 | 结果与权限符合预期，日志无敏感数据 |
| Read canary | 1–5% | 无 | 延迟、错误、零结果、Citation 和配额稳定 |
| Read active | 分批到 100% | 无 | SLO/成本/事故路径稳定 |
| Contribute canary | 小批固定来源 | Candidate only | 幂等、diff、扫描、治理 SLA 稳定 |

每阶段有 Owner 签字、观察窗口和回退阈值。增加 Space、purpose 或 operation 视为新的授权变更，
不能借原接入审批自动扩权。

## 6. 运行监控

客户端监控：

- 请求数、P50/P95、401/403/404/410/412/429/5xx。
- Capability refresh、token 获取/轮换、Query 零结果、Receipt/Usage/Feedback 成功率。
- 每 operation/Space 的配额、字节、重试和熔断。
- Contribution 到 candidate、needs_evidence、verified/published 的业务 SLA（如启用）。

平台监控：

- integration/tenant 配额和 noisy neighbor。
- IdP/JWKS、PDP、数据库、Worker、Outbox/DLQ 和 Connector lag。
- 权限拒绝异常、跨 Space 探测、Idempotency 冲突、harmed/security 事件。

日志只保存请求/trace ID、operation、opaque integration/tenant ID、状态码和耗时；不保存 token、
Query 正文、Payload、source secret 或低基数敏感 Space 名。

## 7. 故障处理

| 故障 | 客户端动作 | 平台动作 |
| --- | --- | --- |
| 401 | 刷新一次 token，仍失败则停止 | 检查 issuer/audience/JWKS/client 状态 |
| 403/404 | 不提升权限重试，记录请求 ID | 检查映射/策略，不披露隐藏资源 |
| 410 | 重新 Query/取得 cursor/Receipt | 检查 epoch/revoke/expiry |
| 412 | 重新 GET ETag，重新判断动作 | 保持并发控制，不接受强制覆盖 |
| 429 | 带 jitter 退避，尊重 Retry-After | 隔离配额和 noisy neighbor |
| 5xx/超时 | 有上限重试；写操作复用幂等键 | 追踪 DB/Worker/依赖，避免重复副作用 |
| 安全/越权 | 立即停止调用和上报 | suspend Integration、撤销凭据、fail closed |

## 8. 变更和轮换

- 每 30–90 天或组织策略要求轮换 client key；同时保留短暂双钥窗口并验证旧钥失效。
- Scope、Space、purpose、obligation、quota、Owner 或 Connector mapping 变化都经过审批和 canary。
- Capability/Schema minor 变化先兼容测试；AKEP 版本变化不静默升级。
- Owner/团队变更先完成接管，不能让无人负责的 Integration 保持 active。
- 定期重跑负向授权、撤销传播、配额和停用演练。

## 9. 停用

1. 平台将 Integration 设为 suspended/revoked，拒绝新请求。
2. IdP 撤销 client/credential，Secret Manager 删除或禁用 secret。
3. 停止 Connector、订阅和 webhook；处理/隔离在途任务与 DLQ。
4. 对已贡献知识逐项决定保留、转 Owner、deprecate、revoke 或 erase。
5. 清理临时对象和非必要遥测；保留依法/策略需要的审计。
6. 使用旧 token、旧 Receipt、旧 webhook 和旧 Connector cursor 做拒绝验证。

停用 Integration 不自动删除知识；知识退出走独立治理流程。

## 10. 上线验收清单

- [ ] Owner、安全联系人、Tenant/Space、purpose、义务和配额已批准。
- [ ] audience-bound 短期 token 和密钥轮换可用。
- [ ] Discovery/RFC 9728 metadata 与 Schema 可访问。
- [ ] 401/403/404/410/412/429 和跨 Space 负向测试通过。
- [ ] Query/Citation/Exposure → Usage → Feedback 闭环通过。
- [ ] 客户端无治理 scope；Contribution（如有）只能创建 Candidate。
- [ ] 日志/trace 不含 token、Query/Payload/source secret。
- [ ] Canary、回退、事故 suspend 和停用演练通过。
- [ ] Owner 接受运行 SLO、成本和持续复审责任。
