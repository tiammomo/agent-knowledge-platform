# 数据维护、测试隔离与清理

AKEP 把知识内容、不可变修订、评测证据和使用回执分开管理。维护目标不是让表变空，而是保留
仍在授权 Space 中生效的知识和必要审计，同时避免自动化测试进入长期数据库。

## 数据分类

| 数据 | 正常处理方式 |
| --- | --- |
| `catalog.record/revision/content_blob` | 通过知识生命周期管理；Revision 不可变 |
| `governance.channel/lifecycle_event` | publish/revoke/erase 产生新状态，不回写历史 |
| `query.knowledge_projection/chunk_projection` | 可重建投影；必须受 Tenant/Space 和 Policy Epoch 约束 |
| `query.exposure_receipt/usage_receipt` | 消费审计；按明确保留策略归档 |
| `evaluation.*` | 不可变质量证据；生产中不做普通行删除 |
| `platform.outbox_event` | 发布/重试后按 relay 策略归档，不能在未投递时随意清空 |

## 测试隔离

`pnpm test:integration` 默认创建 `akep_test_<uuid>` 独立数据库，完成后自动 `dropdb --force`。
显式 `TEST_DATABASE_URL` 时脚本不会接管数据库生命周期。`AKEP_KEEP_TEST_DATABASE=true` 只用于
短期故障取证。

`pnpm smoke:web` 会向它连接的数据库写入示例知识，因此应使用一次性 smoke 环境。不要对共享
开发库、QuantPilot acceptance Space 或生产试点运行反复 smoke。

QuantPilot 的 50 题持久闭环验收是例外：`pnpm seed:quantpilot-acceptance-50 -- --output=<绝对路径>`
会把 50 条方法与风险边界发布到专用 Space
`https://knowledge.local/spaces/quantpilot-acceptance-50-v1`。record ID、标题和贡献幂等键均为确定值，
因此重复执行会复用既有发布，不会创建第二套知识。该批次随后还会产生 ContextPack Exposure、
Usage 与 Feedback；这些数据默认保留，供跨系统核对，不应混入默认 shared Space 或正式业务 Space。

运行前确认统一 Web Origin 已就绪，再生成交给 QuantPilot 的清单：

```bash
curl -fsS http://localhost:33005/health/ready
pnpm seed:quantpilot-acceptance-50 -- --output=/absolute/path/to/quantpilot-acceptance-50-v1-manifest.json
```

清单固定声明 dataset、Space、50 个 question、record ID 和发布状态。QuantPilot 必须以清单为输入，
不能重新按关键词猜测记录。需要删除这批本地验收数据时，先备份数据库，并同时核对该 Space 下的
Catalog/Revision/Projection、Attestation、Exposure、Usage 和 Feedback；不要只删检索投影或只删
Catalog 记录，留下失去归属的审计回执。

## 长期库维护

1. 确认 Tenant、Space、record、状态和引用回执，形成明确保留清单。
2. 对 PostgreSQL 做完整备份并校验；同时保存对象存储引用和 Capability/Policy Epoch。
3. 正式知识使用 revoke/erase contribution 与职责分离审批，不禁用不可变触发器。
4. 先处理 Usage/Feedback/Outbox 保留，再重建 query projection，最后校验引用和 RLS 隔离。
5. 运行 `pnpm test:integration`、`infra/postgres/verify.sql` 和目标消费者真实查询。

只有完全隔离的本机测试库可以在备份后做物理批量删除；测试维护不得形成生产 SQL Runbook，
也不得通过禁用 Revision/Evaluation 不可变触发器来清理正式数据。若测试数据已经进入共享库，
优先迁移仍需保留的 Space 到新库，再整体替换旧测试库，而不是在生产式账本中逐行猜测。

多租户边界见[多团队隔离设计](../architecture/multi-team-isolation.md)，发布治理见
[信任、评测与发布治理](../governance/trust-and-publication.md)。
