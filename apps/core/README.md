# AKEP TypeScript Core

该服务是 AKEP 状态、授权和事务的权威边界。当前开发基线实现 Reader、Contributor、Curator
与 Publisher 最小 Profile，包括候选隔离、独立审核、原子发布、检索/精确读取、Exposure、
Usage、Feedback 和紧急撤销失效。

核心进程不执行模型生成或不可信文档解析；这些任务通过带版本的内部契约交给 Python Worker。
PostgreSQL Store 与内存 Store 共享同一应用语义，后者仅用于快速测试。

生产 OIDC Remote JWKS 验证、issuer/audience/算法/`typ`/令牌寿命约束与 RFC 9728 metadata
已经接入；`NODE_ENV=production` 会拒绝 development auth。外部 PDP、租户 RLS 和生产管理面
会话仍未完成，不得将 `dev-*` 令牌或当前 Web 开发 bundle 暴露到生产网络。

运行、端点和生产边界分别见[本地开发手册](../../docs/runbooks/local-development.md)、
[HTTP API 快速参考](../../docs/reference/http-api.md)与
[实现状态](../../docs/architecture/implementation-status.md)。
