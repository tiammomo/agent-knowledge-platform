# AKEP TypeScript Core

该服务是 AKEP 状态、授权和事务的权威边界。当前开发基线实现 Reader、Contributor、Curator
与 Publisher 最小 Profile，包括候选隔离、独立审核、原子发布、检索/精确读取、Exposure、
Usage、Feedback 和紧急撤销失效。

核心进程不执行模型生成或不可信文档解析；这些任务通过带版本的内部契约交给 Python Worker。
PostgreSQL Store 与内存 Store 共享同一应用语义，后者仅用于快速测试。

生产 OIDC Remote JWKS 验证、issuer/audience/算法/`typ`/令牌寿命约束、签名 Tenant claim 与
RFC 9728 metadata 已经接入；`NODE_ENV=production` 会拒绝 development auth。OIDC Principal
的 Tenant 必须与部署 `AKEP_TENANT_ID` 一致。Query 将 Tenant/subject/Space/purpose/obligation/
policy epoch 编译为本地 AuthorizationPlan，授权 Space 会在 Published 元数据读取和 SQL 排序/
候选上限之前下推，继续游标也绑定同一授权上下文。

当前 17 张租户事实表已经启用 `ENABLE/FORCE RLS`，Core 连接池绑定部署
`AKEP_TENANT_ID`，production readiness 强制使用 owner 管理的单 Tenant runtime role，且该
角色必须非 owner、非 superuser、非 `BYPASSRLS`。控制面 Principal → Tenant 映射、事务级动态
Tenant、外部 PDP/完整策略谓词和生产管理面会话仍未完成，不得将 `dev-*` 令牌或当前 Web 开发
bundle 暴露到生产网络。

运行、端点和生产边界分别见[本地开发手册](../../docs/runbooks/local-development.md)、
[HTTP API 快速参考](../../docs/reference/http-api.md)与
[实现状态](../../docs/architecture/implementation-status.md)。
