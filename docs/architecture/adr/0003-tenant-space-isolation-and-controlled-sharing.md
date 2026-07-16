# ADR-0003：Tenant 硬隔离、Space 治理与受控共享

- 状态：Accepted for target multi-team architecture
- 日期：2026-07-17

## 背景

当前参考实现按进程配置固定单一 Tenant，数据模型的部分表已有 `tenant_id + space_id`，但
Principal、全部事实表、RLS、缓存、任务和管理面尚未形成完整租户边界。仅为每个团队创建一个
Space，或在 SQL 中添加可选 tenant 条件，不能抵御 IDOR、连接池上下文泄漏、全局检索/缓存、
Outbox/Worker 混淆和管理员越权。

团队同时需要共享已批准知识。如果直接开放彼此私有 Space，权限和生命周期会耦合；如果为每个
团队完全复制数据库，又会让治理、去重、迁移和撤销传播难以维护。

## 决策

1. Deployment 是最高物理边界；Tenant 是法律/身份/计费/密钥硬边界；Space 是 Tenant 内团队或
   领域的治理边界。开发/测试/生产必须是不同 Deployment。
2. Tenant 上下文只从已验证身份和控制面映射生成，不能由数据面请求指定。
3. 所有租户数据、索引、对象、缓存、任务、Outbox、DLQ、审计和回执都显式绑定 Tenant；
   Space 资源同时绑定 Space。
4. PostgreSQL 使用复合 PK/FK/Unique、非 owner runtime role、`ENABLE + FORCE RLS` 和事务级
   tenant context；RLS 是 PDP/PEP 之外的第二道防线。
5. Query/lexical/ANN 在排序和 LIMIT 前执行 tenant/Space AuthorizationPlan；不允许全局召回后过滤。
6. 团队间默认不可互读。共享通过 shared Space adoption、reference-only 或 controlled copy，
   每次共享都需要目标 Space 本地治理与策略交集。
7. R3/监管数据可提升到独立 Deployment/数据库/对象存储/KMS，逻辑身份和 AKEP 语义保持一致。
8. M1–M3 租户迁移和负向测试完成前，产品只声明单租户隔离试点。

## 结果

正面结果：

- 安全边界与组织/法律/计费边界一致，Space 不承担其无法保证的物理隔离。
- 数据库、检索、对象、缓存和异步链路使用同一租户上下文，减少“主 API 隔离、后台泄漏”。
- Shared Space 保留跨团队复用，同时让目标团队独立决定是否采信、何时升级或撤销。
- 高敏客户可独立部署而不分叉领域模型。

代价：

- 所有 Store、表、索引、任务、回执和测试都要迁移，不能只加 RLS migration。
- 共享需要额外 Contribution/Review/Publish，会增加时延和治理成本。
- 跨租户全局去重、全局 ANN 和公共缓存默认关闭，存储/计算成本更高。
- 平台管理与支持访问需要单独的限时、双人和审计机制。

## 被否决的方案

- **Space 即租户**：不能提供身份根、密钥、计费、备份和物理隔离，容易被 wildcard scope 绕过。
- **仅应用层 tenant 条件**：遗漏一个 Store/后台任务即可越权，连接池/缓存仍可能泄漏。
- **仅 PostgreSQL RLS**：table owner/superuser/`BYPASSRLS`、外部搜索、对象和队列不受其保护。
- **全局检索后过滤**：会泄漏计数/分数/延迟，也会损害授权域内召回率。
- **团队直接互授私有 Space 读取**：源团队策略变化会隐式影响目标团队，缺少本地采信和审计。
- **每团队独立数据库**：对普通同 Tenant 团队运维过重，共享/迁移困难；仅保留给高敏边界。

## 回退与演进

在多租户验收前继续保持单租户 Deployment。若某 Tenant 无法在共享基础设施满足密钥、驻留、
容量或监管要求，将其迁移到独立 Deployment，而不是放宽 RLS 或共享策略。

详细实现和验收见[多团队隔离设计](../multi-team-isolation.md)。
