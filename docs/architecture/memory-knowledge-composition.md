# Memory、Knowledge 与任务编排器的组合边界

- 状态：QuantPilot 参考集成已落地
- 最近核对：2026-07-19
- 适用范围：AKEP v0.1 与 Evolvable User Memory HTTP v1

共享知识平台与用户记忆平台应当相辅相成，但不应合并为一个领域模型：知识回答“组织发布了什么”，记忆回答“某个用户长期偏好怎样工作”，任务编排器回答“本次任务实际用了什么、结果怎样”。

## 决策

```text
Evolvable User Memory -- Projection / Usage Receipt ---> Consumer
Agent Knowledge Platform -- ContextPack / AKEP Receipt -> Consumer
Consumer -- explicit personal Outcome -----------------> Memory
Consumer -- Citation Usage / evaluator Feedback -------> AKEP
```

组合发生在消费者的 Port 和证据层，不发生在两个平台的数据库、发布流程或服务内部：

- 两个平台不直接调用对方，不复制对方正文，也不持有对方租户管理权限。
- Consumer 只保存不透明 receipt、revision/citation ID 和摘要组成的 Context Use Manifest。
- 同一个 task/request correlation ID 可以用于可观测性，但不能代替 Memory `usageId`、AKEP `usageId` 或任务验收 receipt。
- Memory 的偏好不能进入 AKEP 的 Published Channel；AKEP Revision 也不能自动提升为用户 Belief。

## 所有权

| 对象 | 权威所有者 | Consumer 允许保存 |
| --- | --- | --- |
| 用户 Evidence、Belief、RecallTrace、Memory Usage、Outcome | Evolvable User Memory | opaque ID、摘要、策略版本 |
| Candidate、Published Revision、Citation、Exposure/Usage/Feedback | Agent Knowledge Platform | opaque URI、摘要、Policy Epoch、obligation |
| RunPlan、工具调用、市场事实、Mission、验收 receipt | QuantPilot | 完整任务事实与本地审计 |

删除和保留也遵守所有权：Memory erasure 不触发 AKEP 删除，AKEP revoke/erase 不改变用户偏好。Consumer 的联合清单是引用投影；上游删除后可保留最小审计墓碑或按 Consumer 自身保留策略删除，但不得借此恢复正文。

## 结果证据

两个平台的学习语义不同，不能把一次 Mission 通过同时当作两个平台的正向奖励：

- 用户记忆只有在用户明确 helpful/rejected/corrected 时才接收 Outcome，且 revision 必须绑定真实 Memory Usage Receipt。
- AKEP 在 Mission 验收后接收 Citation Usage，但 Mission 通过本身不自动形成正向 Feedback。
- AKEP helped/neutral/harmed 应来自用户评价、独立评测或可复现业务指标，并携带固定 evaluator 版本、业务事件 ID 和 evidence reference。

## 禁止的捷径

- 共享 PostgreSQL schema、跨库外键或直接读取另一平台内部表；
- 把 Memory capsule 或 AKEP ContextPack 拼成长期“超级记忆”正文；
- 让模型选择 Tenant、Space、subject、purpose、token、保留或删除策略；
- 让不同消费应用复用 Tenant，或让互不信任的 workspace 复用项目私有 Space；
- 因为内容被召回/读取就增加效用；
- 用 Context Use Manifest 代替上游服务端 receipt；
- 自动把个人聊天、生成代码或量化结果发布为组织知识。

参考实现见 [QuantPilot 接入设计](quantpilot-integration.md)。AKEP 的公开契约仍只定义 Knowledge 侧对象；联合清单是消费者私有审计投影，不加入 AKEP Core 协议。
