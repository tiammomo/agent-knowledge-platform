# Contributing

## 开发基线

需要 Node.js 24 LTS、pnpm 11、Python 3.13、uv 和 Docker Compose。首次检出后运行：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test:integration
```

`pnpm test:integration` 在没有显式 `TEST_DATABASE_URL` 时会启动仓库 Compose PostgreSQL、执行
Migration、运行测试，并在结束后恢复容器状态。设置 `AKEP_KEEP_TEST_DATABASE=true` 可保留它
用于调试；CI 或外部数据库应显式传入 `TEST_DATABASE_URL`。

## 变更约束

- 已发布 Revision、生命周期事件和已应用 Migration 均不可原地修改；新增行为使用新 Revision、
  新事件或新 Migration。
- 新的 Tenant/Space 数据访问必须同时提供正向与越权负向测试。
- 写接口必须保留 `Idempotency-Key` 语义；状态变更继续使用强 ETag/`If-Match`。
- Core 不解析不可信二进制文档；此类工作必须进入隔离 Worker。
- 协议 Schema、OpenAPI、SDK、实现和文档必须保持一致。
- 不提交 token、真实知识内容、生产 URI、私钥、数据库快照或遥测导出。

## Pull Request

保持变更聚焦，说明安全边界、兼容性、Migration 与回滚方式。合并前必须通过 CI、数据库集成
测试和安全门禁；涉及协议、数据库、授权、发布或擦除路径的变更需要 CODEOWNERS 审核。
