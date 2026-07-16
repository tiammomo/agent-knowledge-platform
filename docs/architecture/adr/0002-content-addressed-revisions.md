# ADR-0002：内容寻址 Revision 与可变 Channel 分离

- 状态：Accepted for AKEP v0.1
- 日期：2026-07-15

## 背景

同一知识会被多个 Agent 和节点引用、修订、签名、评测、发布、废弃或撤销。如果版本 ID 只由单节点分配，跨节点去重和完整性验证困难；如果把发布状态、签名或下载 URL 放入版本内容，每次治理动作都会制造新的“知识版本”。

## 决策

1. `recordId` 表示稳定知识谱系。
2. Manifest 只包含知识内容描述、Payload digest、父 Revision、来源、适用范围和声明策略。
3. Manifest 按 RFC 8785 JCS 规范化，SHA-256 摘要形成 `revisionId`。
4. 签名、Attestation、下载位置、节点评分和 Channel 不进入 Manifest 摘要。
5. 每个 `Space + Trust Domain + Record` 通过追加式 LifecycleEvent 维护自己的 `candidate/verified/published` Channel 指针；`deprecated/revoked/quarantined/erased` 是针对固定 Revision 的独立、追加式安全状态。
6. 精确引用同时固定 `spaceId + revisionId + payloadDigest + locator`；Space 提供本地治理上下文，但不进入可移植 Manifest 的摘要。

## 结果

正面结果：

- 任意节点都能独立校验身份和去重。
- 新增签名、镜像或本地评价不会改变知识身份。
- 不同 Trust Domain 可对同一 Revision 作出不同发布决策。
- 分叉和合并形成显式 DAG，避免 last-write-wins。

代价与控制：

- Manifest 的任何字节差异都会产生新 ID；用测试向量约束 JCS 实现。
- 内容摘要可能泄漏低熵秘密；v0.1 Core 只在授权后提供明文 Manifest 身份，不能安全披露的 Manifest 不参与联邦。密文 Manifest、keyed digest 或作用域标识必须由后续独立 Profile 定义。
- “当前发布版本”需要一次 Resolve；客户端必须区分动态 Record 与固定 Revision。

规范算法、黄金向量和 Citation 结构见
[AKEP v0.1](../../protocols/akep-v0.1.md#5-一致性与身份模型)与
[机器可读契约](../../../specs/akep/v0.1/README.md)。
