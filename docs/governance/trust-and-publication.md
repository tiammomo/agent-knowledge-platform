# 信任、评测与发布治理 v0.1

- 状态：Draft policy baseline
- 最近核对：2026-07-17

本文给出风险与治理基线，不替代组织的法律、隐私、安全或行业审批。参考实现当前固定启用
`source_document` 与 `procedure` Profile；风险分级表描述扩大资产类型后的最低治理要求。

## 1. 根规则

1. 可验证来源只证明“谁提交了哪些字节以及是否被篡改”，不证明内容正确。
2. 可信度是本地、按任务和时间计算的判断，不存在可直接继承的全局 trust score。
3. 作者、生成者、评价者和发布批准者应尽可能分离；高风险资产禁止作者自批。
4. Agent 可以自由提交候选，但不能自由改变 Published Channel、权限、评测规则或可执行能力；`akep:review` 与 `akep:publish` 是不同授权，review-only 身份不能发布。
5. 正向证据缓慢晋级，安全/违法等负向证据可以快速隔离和撤销。

## 2. 质量信号

每项信号以独立 Attestation 保存，至少带评价者、方法/版本、时间、输入 Revision、结果和有效期：

| 维度 | 示例信号 | 不应做的推断 |
| --- | --- | --- |
| 身份与完整性 | 签名、工作负载身份、摘要校验 | 签名有效 ≠ 内容正确 |
| 来源 | 原始来源、派生链、共同祖先、许可证 | 多次转载 ≠ 多个独立来源 |
| 结构 | JSON Schema、SHACL、链接完整性 | 结构合法 ≠ 语义真实 |
| 正确性 | 事实核验、测试、人工复核、反证 | 一次通过 ≠ 永久有效 |
| 时效 | valid time、reviewAfter、来源更新 | 新内容 ≠ 更可信 |
| 安全 | 恶意内容、DLP、注入、能力扫描 | 检测未命中 ≠ 无风险 |
| 效果 | 离线对照、线上帮助/伤害、样本量 | 使用次数 ≠ 因果提升 |
| 适用性 | 地域、语言、前提、任务类别 | 在 A 场景有效 ≠ 可迁移到 B |

质量/适用性策略输出 `suitable / suitable_with_warning / insufficient_evidence / unsuitable`；访问策略独立输出 `allowed / allowed_with_obligations / denied`。两类决策都要给出原因，不能合并成一个“信任分”。数值只用于同一策略版本内排序，不能跨 Space 或 Node 比较。

## 3. 风险分级

| 等级 | 典型资产 | 最低门禁 | 自动发布 |
| --- | --- | --- | --- |
| R0 | 低影响术语、公开目录元数据 | Schema、来源、许可证、安全扫描 | 可在白名单来源和限定 Space 内启用 |
| R1 | 一般文档、示例、失败经验 | R0 + 领域校验 + 一名独立 Reviewer | 默认关闭；可按成熟规则逐类开放 |
| R2 | 业务政策、操作流程、Prompt | R1 + 回归评测 + Owner 批准 + 冲突检查 | 禁止 |
| R3 | 法律/财务/医疗/安全规则、权限配置、可执行能力 | R2 + 双人批准 + 安全专审 + Canary/Kill switch | 禁止 |

风险由资产类型、内容、影响范围和预期用途共同决定，不能由贡献者自行降低。来自远端 Federation 的资产至少按本地规则重新分级。

## 4. 发布门禁

Published 决策 MUST 同时满足：

- Manifest 与 Profile Schema 有效，Revision/Payload 摘要匹配。
- 来源、生成活动、作者/Agent 身份和证据链完整。
- Access/Usage Policy、许可证、地域、保留期和派生策略相容。
- 无阻断级恶意内容、敏感信息或供应链问题。
- 适用时间和复审时间合理，已知冲突被显式关联并告知调用方。
- 对应风险等级的离线正确性、安全和无答案评测通过，关键指标无显著退化。
- 满足独立 Reviewer 数量、职责分离和 Owner 批准要求。
- 发布决定固定策略版本、评测版本、目标 Revision 和批准者，写入追加审计流。

任一强制 Attestation 过期、撤销或输入 Revision 被撤销时，平台重新计算决策并触发复审或级联隔离。

### 4.1 职责与权限边界

| 职责 | 可以 | 不可以 |
| --- | --- | --- |
| Contributor | 创建/修订候选、补证、撤回 | 审核、发布或降低风险 |
| Evaluator | 对固定 Revision 提交可复现 EvaluationRun | 修改候选、审核或发布 |
| Curator | 阅读正文/差异/证据，验证、拒绝、补证或隔离 | 改变 Published Channel |
| Publisher | 在全部门禁满足后发布或废弃 | 代替 Curator 审核、紧急撤销或擦除 |
| Incident Responder | 执行已验证的紧急撤销候选 | 发布新版本或擦除历史 |
| Eraser | 执行经批准的隐私/法律擦除候选 | 把试点回执声明为完整监管证明 |

同一自然人可以拥有多个短期角色，但同一高风险决策链仍应由不同主体执行并留下独立身份。
开发 `dev-*` token 只是验证职责边界的本地工具，不是生产审批机制。

## 5. 自动发布的严格边界

只有同时满足以下条件的 R0 类型可考虑自动发布：

- Space Owner 显式启用且列出允许的 Profile 和来源。
- 来源为固定身份和固定连接器，不接受自由文本 Agent 贡献。
- 转换是确定性或可复现的，Schema/摘要/许可证均机器可验证。
- 有独立回归集、速率上限、影响范围上限和一键撤销。
- 自动化身份不能修改自己的评测集、阈值、白名单或发布策略。

一旦出现新冲突、安全事件、异常提交或伤害反馈，自动发布立即降级为人工审核。

## 6. Feedback 处理

1. Feedback 绑定身份、Usage、精确 Citation、任务类别、评价器版本和时间。
2. 聚合前按同一主体、组织、来源谱系、时间窗和 Revision 去重并封顶。
3. 区分作者自评、相关组织评价和独立评价；复制同源内容不增加独立性。
4. 校正曝光偏差；默认靠前而获得更多使用不能形成无条件正反馈。
5. 原始任务文本默认不保存，先做最小化、假名化和保留期控制。
6. Feedback 只产生 Evidence/Assessment；修改正文必须经过新的 Contribution 和 Revision。

## 7. 冲突与过期

- 字节相同 Revision 去重。
- 同 Record 并发 Revision 保留多 Head，人工或规则可生成多父合并版本。
- 语义矛盾通过 `contradicts`、有效时间、地域和假设表达，不删除任一方。
- `reviewAfter` 到期不自动判错，但默认降权并进入复审队列。
- 有明确继任版本时旧版进入 Deprecated；历史任务仍可按固定 Citation 复现。

## 8. 紧急控制

具备 `akep:publish` 不自动具备紧急撤销权。应建立短时、高审计的 Incident Responder 权限：

1. 通过 verified revoke Contribution 对目标 Revision 追加不可清除的 Revoke 事件；`akep:incident` 不由 publish 权限继承。
2. 立即失效正文分发、上下文缓存、全文/向量/图投影和能力执行租约。
3. 通过反向来源图标记受影响 Revision、答案、任务和联邦 Peer。
4. 优先发送撤销事件并收集 ACK；未确认高敏撤销的 Peer 暂停后续共享。
5. 调查后只能以新 Revision 恢复或保持撤销，不能清除旧 Revision 的撤销或删除事故历史。

Erase 使用独立 `akep:erase`、Privacy/Legal 批准与保留冲突检查；Incident Responder 或 Publisher 不能单独触发物理删除。

## 9. MVP 验收红线

- Candidate 在所有默认生产查询中不可见。
- 作者无法批准自己的 R2/R3 贡献。
- 合法签名的错误内容仍显示为“来源已验证、正确性未验证”。
- 多 Agent 改写转载同一毒化内容不会被算作独立佐证。
- 大量互刷 Feedback 不能使资产自动晋级。
- 撤销后旧事件、旧快照、缓存和索引均不能复活资产。
- 任何 Published 结果都能定位到精确 Revision、Payload 范围、来源和发布决策。

运行时角色与请求约定见[HTTP API 快速参考](../reference/http-api.md)，当前已实现门禁见
[实现状态](../architecture/implementation-status.md)。
Owner、`reviewAfter`、来源变化、维护任务和退出运营见
[知识持续维护设计](knowledge-maintenance.md)。
