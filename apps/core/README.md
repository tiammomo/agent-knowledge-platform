# AKEP TypeScript Core

该服务是 AKEP 状态、授权和事务的权威边界。当前开发基线实现 Reader、Contributor、Curator
与 Publisher 最小 Profile，包括候选隔离、独立审核、原子发布、检索/精确读取、Exposure、
Usage、Feedback 和紧急撤销失效。

核心进程不执行模型生成或不可信文档解析；这些任务通过带版本的内部契约交给 Python Worker。
PostgreSQL Store 与内存 Store 共享同一应用语义，后者仅用于快速测试。

生产 OAuth/OIDC 和策略决策点尚未接入。`NODE_ENV=production` 会拒绝开发认证启动；不得将
`dev-*` 令牌暴露到生产网络。
