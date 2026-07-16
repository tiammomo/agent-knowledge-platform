## 变更说明

- 解决的问题：
- 主要设计决策：
- 不在本次范围内的内容：

## 风险检查

- [ ] Tenant、Space、purpose 和 scope 边界没有被放宽
- [ ] 写操作继续满足幂等、并发控制和审计要求
- [ ] Revision、事件和已应用 Migration 没有被原地修改
- [ ] 新日志、指标和错误响应不包含 token、原始内容或敏感策略
- [ ] 协议、接口或运行方式变化已经同步文档

## 验证

- [ ] `pnpm check`
- [ ] `pnpm build`
- [ ] `pnpm test:integration`
- [ ] 相关安全或恢复测试
