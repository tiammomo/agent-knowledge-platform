# 实现状态与生产门禁

- 状态：可运行、可做单租户隔离试点的 P0 基线
- 日期：2026-07-15
- 协议：AKEP v0.1 实验草案

## 已实现

| 能力面 | 状态 | 说明 |
| --- | --- | --- |
| Reader | 可运行 | 能力发现、词法/精确 Passage 查询、游标快照、Record Resolve、Revision/Range Blob、Exposure Receipt |
| ContextPack 扩展 | 可运行 | 按字符/段落/估算 token 预算组装上下文，返回稳定 Citation、义务、质量警告与 Exposure Receipt |
| Contributor | 可运行 | create/revise/lifecycle 候选、幂等、证据补充、撤回、Usage、Feedback |
| Curator | 可运行 | 独立验证、拒绝、补证请求、隔离；不能修改 Published Channel |
| Publisher | 可运行 | 发布、废弃、紧急撤销、擦除使用分离 scope；PostgreSQL 原子事务与 Outbox |
| Revision 身份 | 已验证 | TypeScript/Python RFC 8785 + SHA-256 黄金向量一致 |
| 存储 | 可运行 | PostgreSQL 17、pgvector、不可变 Revision 触发器、检索投影、迁移摘要锁 |
| Evaluation / 质量门禁 | 可运行 | 发布精确执行 Profile `requiredAttestations`；Schema/静态安全扫描、Curator 审核和 Publisher 策略批准生成不可变证明；真实 EvaluationRun 可额外生成 benchmark 证明 |
| Worker | 可运行 | Python JSONL 任务信封，规范化、确定性切片、静态敏感内容扫描、隔离判定、Manifest/Revision 校验；无数据库权限 |
| SDK | 可运行 | TypeScript 与 Python 客户端覆盖 discovery、Query、ContextPack、固定 Revision、Usage/Feedback；TypeScript 另支持候选贡献 |
| MCP Adapter | 可运行 | 独立 stdio 进程，暴露 search/context/get/usage/feedback/candidate；不持有治理发布能力 |
| 生产认证基线 | 可运行 | OIDC Remote JWKS JWT 验证、issuer/audience/算法约束、RFC 9728 metadata；production 禁止开发令牌 |
| 可观测性基线 | 可运行 | Trace Context、可选 OTLP/HTTP trace、受保护 Prometheus 指标、p50/p95/error-rate/SLO 健康视图 |
| Web Console | 可运行 | React 19 + TypeScript + Vite；八个响应式产品页面，全部读取真实 API 状态 |
| 新手引导 | 可运行 | 五步可恢复向导，真实执行 discovery → candidate → review → publish → query |
| Console Read Model | 可运行 | 私有 no-store 总览、资产、贡献、效果证据和服务健康投影；Reviewer 可读取候选正文和证据 |

紧急撤销会立即从检索和精确读取中移除 Revision，并使尚未过期的旧 Exposure Receipt
失效。Feedback 永远先作为证据写入，当前不会直接改变内容、发布状态或排名。
擦除会净化在线 Payload、Chunk、Blob 引用、Exposure/Usage/Feedback，并只通过 Record Resolve
返回授权可见的最小状态墓碑；不可变 Catalog Manifest、LifecycleEvent、备份与外部缓存的监管级
擦除仍需要生产对象存储、密钥销毁和 erase proof，因此试点动作不能冒充完整法务擦除证明。

Web Console 是开发基线而非生产管理面：浏览器内置的 `dev-*` token 只用于本地角色演示。
生产身份验证与基础观测已经落地，但仍需完成下面的租户、策略、存储和运维门禁；不能将
开发镜像或浏览器内置的 `dev-*` token 直接暴露到公网。

## 有意关闭

| 能力 | 原因 / 启用门槛 |
| --- | --- |
| 外部 PDP 与租户 RLS | 必须完成策略编译、授权计划绑定、租户上下文和越权测试 |
| 对象存储与外部接入扫描 | Worker 已有规范化、确定性切片和静态隔离判定；仍须提供对象隔离区、独立恶意文件扫描、媒体解析沙箱和摘要提交协议 |
| 语义/混合检索 | 必须固定嵌入模型指纹、授权前过滤策略、召回评测和重建流程 |
| 自动晋级 | 必须有独立评测集、反作弊、相关性折扣、漂移与回滚门禁 |
| Federation | 必须完成 DSSE/Ed25519 密钥、Checkpoint、撤销优先同步和 Peer 信任策略 |
| A2A Adapter | 尚未实现；不得绕过本地 Contribution、Revision 和治理工作流 |
| 可执行能力包 | 尚未实现运行时沙箱、签名、依赖锁定、权限批准和执行回执，默认关闭 |
| 持久化策略水位 | 当前 `policyEpoch` 是单节点部署配置；外部 PDP、跨实例单调水位与安全日志接入前不支持联邦缓存安全 |
| 大规模检索 | 当前适合试点数据量；授权下推、批量质量门禁、分区索引与异步投影消费者完成前不承诺百万 Chunk / 高并发 SLO |
| 完整 MCP 生产认证 | stdio Adapter 当前读取进程 token；短期 token 自动刷新、精确工具 Schema 与副作用 hint 校准仍待完成 |

## 生产验收底线

1. 用真实 Identity Provider、短期 audience-bound token 和轮换演练替换全部 `dev-*` 身份，保留 Contributor、Curator、Publisher、Incident、Eraser 的职责分离。
2. 将内联 Payload 迁移到加密对象存储，接入扫描、配额、保留与擦除证明。
3. 为所有租户表启用并验证 RLS；策略必须在召回和 `LIMIT` 之前生效。
4. 将现有 OTLP/Prometheus 基线接入高可用 Collector、长期指标、审计安全日志、备份恢复、密钥轮换、告警和故障演练。
5. 用威胁样本、权限矩阵、撤销传播、迁移回滚和容量压测完成独立验收。

单租户隔离试点部署步骤见[隔离生产试点运行手册](../runbooks/production-pilot.md)。
