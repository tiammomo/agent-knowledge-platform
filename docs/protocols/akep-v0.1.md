# AKEP v0.1：Agent Knowledge Exchange Protocol

- 状态：Experimental Draft
- 最近核对：2026-07-16
- 规范标识：`https://agentknowledge.dev/spec/akep/0.1`
- 机器 Schema：[`specs/akep/v0.1`](../../specs/akep/v0.1/)

> [!IMPORTANT]
> 本文定义实验协议语义，不等于参考实现启用了所有操作。机器字段以
> [OpenAPI/JSON Schema](../../specs/akep/v0.1/README.md)为准；当前运行能力见
> [实现状态](../architecture/implementation-status.md)并以实例 Capability Discovery 为最终依据。

## 1. 摘要

AKEP 定义 Agent 与知识平台、知识平台之间交换“可持久、可验证、可演化知识”的最小协议。它解决：

- 不可变知识修订及内容寻址
- 来源、证据、适用范围和策略
- 查询、精确读取、候选贡献和效果反馈
- 冲突、废弃、撤销和删除请求
- 能力发现、版本协商、事件和受控联邦同步

AKEP 不定义 Agent 的推理过程、任务编排、工具调用、向量数据库 API 或全局真值。MCP、A2A、CloudEvents、OAuth、W3C PROV 和 OpenTelemetry 分别承担已有标准覆盖的职责。

本草案的首要安全规则是：**知识内容、检索片段、模型输出、Agent 反馈和能力描述一律是不可信数据；LLM 绝不能成为认证、授权、发布审批或动作批准边界。**

## 2. 规范语言

文中的 `MUST`、`MUST NOT`、`REQUIRED`、`SHOULD`、`SHOULD NOT` 和 `MAY` 按 [BCP 14](https://www.rfc-editor.org/info/bcp14) 解释。

v0.1 是实验协议，兼容性承诺如下：

- 实现必须显式协商 `0.1`，不得把草案当作未来 `1.0`。
- v0.1 patch 不能增加顶层 Core 字段；兼容扩展只能放入 `extensions`。Core 字段或语义变化必须发布新的协议/Manifest minor 版本。
- 未识别的普通扩展可忽略；`critical` 必须是当前对象 `extensions` 键的子集，其中任一扩展不受支持时必须拒绝整个对象。

## 3. 协议边界

| 需求 | 采用方案 |
| --- | --- |
| Agent 访问工具/资源 | MCP 稳定版 `2025-11-25` |
| Agent 间任务与 Artifact | A2A `1.0` |
| AKEP HTTP API | HTTP + JSON，OpenAPI/JSON Schema |
| 事件信封 | CloudEvents `1.0` |
| 来源语义 | W3C PROV-O |
| 可选语义投影 | JSON-LD 1.1 / RDF 1.1 / SHACL 1.0 |
| 身份和传输授权 | OAuth/OIDC、mTLS 或工作负载身份 |
| 错误 | RFC 9457 Problem Details |
| 追踪 | W3C Trace Context / OpenTelemetry |
| 可执行制品 | OCI Artifact + 签名/SBOM/in-toto Attestation |

AKEP 自定义的部分仅包括 Manifest、Revision、关系、状态声明、Contribution、Feedback、查询响应、同步 cursor 和联邦安全语义。

## 4. 术语

- **Node**：提供 AKEP Endpoint 的平台实例。
- **Trust Domain**：具有共同身份根、策略和治理的边界。
- **Space**：Node 内的知识治理命名空间。
- **Asset / Record**：同一知识谱系的稳定逻辑身份。
- **Manifest**：描述一份不可变 Revision 的规范 JSON 对象。
- **Revision**：Manifest 及其所引用 Payload 的不可变知识版本。
- **Payload**：文档、结构化 Claim、数据或其他按摘要寻址的内容。
- **Channel**：Trust Domain 对某 Asset 当前采用 Revision 的可变指针，如 `candidate` 或 `published`。
- **Attestation**：主体针对 Revision 作出的签名验证、评测、审核或安全证明。
- **Contribution**：请求创建 Revision 或改变 Channel/Status 的候选提案，不等于发布。
- **Citation**：指向固定 Revision、Payload 摘要和内容范围的可复现引用。
- **Projection**：Chunk、Embedding、全文和图索引等可重建表示，不属于规范 Revision。

## 5. 一致性与身份模型

AKEP 将三个身份分开：

1. `recordId`：稳定的知识谱系 URI。
2. `revisionId`：Manifest 规范字节的内容摘要 URI。
3. `eventId`：一次状态变化或投递事件的唯一 ID。

不能用事件 ID 代替知识版本，也不能用可变 Record URI 作为精确引用。

Space 是本地治理上下文，不进入可移植 Manifest。同一 Revision 可以被多个 Space 采用，但每个 Space 有独立 Channel、Status、PolicyBinding 和风险决策；因此 Resolve/Fetch/Blob/Contribution/Usage 都必须显式绑定 `spaceId`，Query 结果也逐项返回 Space。跨节点同步只把远端 Space 当来源元数据，接收方必须映射到本地 Space 后再治理。

### 5.1 规范 Manifest

Manifest 不包含 `revisionId`、Channel、签名、Attestation、下载位置、投递时间或本地评分。Manifest 必须满足 RFC 8785 所要求的 I-JSON 子集；接收方必须在解析阶段拒绝重复键、非法 Unicode、NaN/Infinity 和不能被 IEEE 754 双精度无损表达的 JSON 数值，精确大整数/小数应使用带类型字符串。其 JSON 按 [RFC 8785 JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785) 生成 UTF-8 字节，然后计算摘要：

```text
revisionId = "urn:akep:sha256:" + lowercase_hex(SHA-256(JCS(manifest)))
```

v0.1 Core 只接受小写 `sha256:` + 64 位小写十六进制，以及对应的 `urn:akep:sha256:` Revision ID；算法标签为未来密码迁移保留，但其他算法必须通过新协议/Profile 协商，不能静默混用。接收方 MUST 自行计算并核对 `revisionId`，不能信任传入字符串。

低熵或私密内容的公开摘要可能泄漏“内容是否存在”。v0.1 Core 只定义授权后可读取的明文 Manifest + JCS 身份，不定义加密 Manifest、keyed digest 或 scoped Revision ID。私密 Payload 可以先加密再将密文字节写入 descriptor，但 Manifest 元数据本身仍可能敏感；不能安全披露时就不得联邦共享该 Manifest，也不得跨租户提供全局去重探测。加密 Manifest/作用域身份必须由后续独立 Profile 规定，不能自称 Core 互操作。

### 5.2 Manifest 示例

```json
{
  "manifestVersion": "0.1",
  "recordId": "https://knowledge.example/assets/refund-policy",
  "profile": {
    "uri": "https://agentknowledge.dev/profiles/procedure/1",
    "digest": "sha256:aae83aa5cd8d97cba553b453544d89e97609c6d91a57109b3ed5ee4897e648b4"
  },
  "parents": [],
  "assetType": "procedure",
  "title": "退款处理流程",
  "summary": "直营网店超过 30 天退款申请的复核流程。",
  "payloads": [
    {
      "name": "primary",
      "mediaType": "text/markdown; charset=utf-8",
      "digest": "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      "size": 1842,
      "language": "zh-CN"
    }
  ],
  "scope": {
    "locale": "zh-CN",
    "jurisdiction": "CN",
    "validFrom": "2026-07-01T00:00:00Z",
    "reviewAfter": "2026-10-01T00:00:00Z",
    "assumptions": ["仅适用于直营网店"]
  },
  "provenance": {
    "attributedTo": ["https://identity.example/teams/support"],
    "generatedBy": {
      "activityId": "urn:uuid:0198a1d2-82d5-7b43-8d2d-6af93e78c001",
      "type": "human-authored",
      "actor": "https://identity.example/teams/support",
      "startedAt": "2026-07-15T01:00:00Z",
      "endedAt": "2026-07-15T01:02:03Z",
      "used": ["https://docs.example/policies/refund-2026-07"],
      "software": [
        {
          "name": "knowledge-editor",
          "version": "1.0.0"
        }
      ],
      "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
    },
    "primarySources": ["https://docs.example/policies/refund-2026-07"]
  },
  "policy": {
    "classification": "internal",
    "owners": ["https://identity.example/teams/support"],
    "accessPolicyRefs": [
      {
        "uri": "https://policy.example/access/support-v2",
        "digest": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
      }
    ],
    "usagePolicyRefs": [
      {
        "uri": "https://policy.example/usage/internal-knowledge-v1",
        "digest": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
      }
    ],
    "licenses": ["LicenseRef-Company-Internal"],
    "allowedPurposes": ["customer-support"],
    "export": "deny",
    "obligations": ["cite", "no-train"]
  },
  "relations": [
    {
      "type": "derived_from",
      "target": "https://docs.example/policies/refund-2026-07"
    }
  ],
  "labels": ["refund", "support"],
  "extensions": {},
  "critical": []
}
```

### 5.3 Payload

- Payload descriptor MUST 包含 `name`、`mediaType`、`digest` 和字节数 `size`。
- 同一 Manifest 内 Payload `name` 必须唯一，`size` 不得超过 I-JSON 安全整数；接收时必须按原始字节重算 digest 和 size。
- `primary` Payload 每个 Manifest 恰好一个；翻译、结构化抽取或附件使用其他名称。
- 下载位置不进入 Manifest 或不可变 Revision Resource。客户端必须通过带 `Space + Revision + digest + purpose` 授权上下文的 Blob 端点读取；服务端若在后续 Profile 提供临时位置，必须放入 `private, no-store` 的独立读取信封，且不能改变 Revision ETag。
- Blob handler 必须先授权并解析路径中的 Revision，再证明路径 digest 恰好属于该 Manifest 的某个 Payload descriptor；即使同一 digest 在节点其他 Revision 中存在，也不能据此读取，缺失时按防存在性泄漏的统一 404/403 处理。
- 服务端 SHOULD 支持 HTTP Range、ETag 和条件请求。
- 完整响应 SHOULD 使用 RFC 9530 `Content-Digest`；AKEP Manifest 的十六进制 Payload digest 仍是跨传输的规范身份，两者编码不同，客户端不能直接按字符串比较。
- JSON Payload SHOULD 使用版本化 JSON Schema。语义 Profile MAY 同时提供 JSON-LD Context 与 SHACL Shape。
- 远程 JSON-LD Context MUST 使用不可变 URI 和摘要固定；验证器不得在解析不可信对象时任意联网获取 Context。

### 5.4 版本 DAG

- `parents` 包含零个或多个 Revision ID。
- 每个 parent 必须可解析且具有相同 `recordId`；跨 Record 的来源/合并使用 `derived_from` 等 Relation，而不是污染版本 DAG。
- 修订产生新 Manifest；既有 Revision 永不覆盖。
- 并发修订形成多个 Head，必须全部保留，禁止默认 last-write-wins。
- 合并 Revision 必须列出所有被合并父版本。
- 自然语言、Claim 和 Procedure 不得无审计自动 CRDT 合并。
- 时间戳只用于展示与索引，不能裁决哪个结论为真。

## 6. 上层 Profile

v0.1 定义稳定的 `assetType` 上层词表：

`source_document`、`assertion`、`observation`、`procedure`、`policy`、`example`、`failure_case`、`hypothesis`、`dataset`、`prompt`、`capability_manifest`。

领域可通过不可变 Profile URI 定义更细 Schema。Manifest 同时固定 Profile 文档的 digest，避免同一 URI 内容漂移。Profile MUST 说明：

Profile JSON 必须通过 [`profile-document.schema.json`](../../specs/akep/v0.1/schemas/profile-document.schema.json)；其 `digest` 与 Manifest 一样对 RFC 8785 JCS UTF-8 字节计算 SHA-256，不是对文件排版后的原始字节计算。Phase 1 只允许仓库固定的 [`source_document`](../../specs/akep/v0.1/profiles/mvp-source-document-v1.json) 与 [`procedure`](../../specs/akep/v0.1/profiles/mvp-procedure-v1.json) Profile 的精确 URI + digest。

- 结构化 Payload 的 Schema/version；非结构化 Payload 则固定验证规则及 rule version
- 必填证据和适用范围
- 允许的关系
- 验证规则
- 是否允许机器自动发布
- 风险等级与复审规则

可执行内容不能作为普通 `procedure` 直接运行。`capability_manifest` 是保留给后续独立 Profile 的类型；没有发布其 Payload Schema、执行回执和沙箱合规声明的 Node 不得接受或索引它。它未来只描述制品摘要、输入输出、权限和运行约束，执行包必须走独立供应链。

## 7. 来源、证据与关系

### 7.1 PROV 映射

- Revision/Payload → `prov:Entity`
- 采集、解析、生成、审核、评测 → `prov:Activity`
- 人、Agent、组织、服务 → `prov:Agent`
- `derived_from` → `prov:wasDerivedFrom`
- `generatedBy` → `prov:wasGeneratedBy`
- `attributedTo` → `prov:wasAttributedTo`

PROV 证明生成链路，不证明内容正确。

### 7.2 关系词表

Core 支持：

- `supports`
- `contradicts`
- `supersedes`
- `refines`
- `derived_from`
- `equivalent_to`
- `applies_under`
- `invalidates`
- `evaluates`
- `used_in`

关系的 `target` MUST 是 URI，SHOULD 固定到 Revision；仅指向 Record 时表示动态关系，不能用于精确引用。语义矛盾的双方都保留，由接收方根据有效时间、地域、假设和证据生成本地 Assessment。

### 7.3 生成来源

AI 生成或转换的 Revision，其 `generatedBy` SHOULD 记录：

- Agent/服务身份
- 输入 Revision ID
- 模型提供方和精确模型/快照标识
- Prompt 模板摘要或获授权的版本引用
- Tool/Capability 的不可变摘要
- 关键参数、运行环境和人工介入
- 开始/结束时间和 trace ID

MUST NOT 要求或交换模型私有思维链。敏感 Prompt、查询和 Tool 结果应分离加密并设置短保留期。

## 8. 策略、信任与状态

### 8.1 四类约束

- **Access Policy**：Node 是否向当前主体放行。
- **Usage Policy**：接收后允许的用途和义务。
- **License**：法律许可，推荐 SPDX 标识或稳定 URI。
- **Classification**：安全分级。

Manifest 中的策略是发布者声明的不可变最低约束，所有 Policy URI 必须同时固定 digest。本地动态授权通过追加式 `EffectivePolicyBinding` 表达，不写回 Manifest；其机器结构见 [`policy-binding.schema.json`](../../specs/akep/v0.1/schemas/policy-binding.schema.json)。本地策略可以收紧但不能静默放宽。多源派生的有效策略是所有输入约束与本地规则的交集；交集为空则拒绝派生或共享。

v0.1 Core 的可移植策略代数限定为：

- `allowedPurposes`、地域/受众允许集取集合交集。
- `classification` 先按双方显式映射再取最严格级别；没有映射时 fail closed。
- `export` 按 `deny > metadata_only > reference_only > allow` 取最严格值。
- `obligations` 取并集；出现互斥义务时拒绝。
- 保留期取最短允许期限，删除/法定保留冲突交给治理策略并拒绝自动共享。
- 许可证不做字符串交集，必须由版本化兼容矩阵判定；未知许可证 fail closed。
- 任意自定义 Access/Usage Policy 只有双方理解同一固定 Profile 时才能自动求交，否则仅可 `metadata_only` 或拒绝。

### 8.2 信任不等于一个分数

Attestation 独立于 Manifest，可表达：

- authorship
- schema-validation
- provenance-validation
- human-review
- benchmark-result
- safety-scan
- license-review
- policy-approval
- signature-verification

互操作 Attestation 的最小字段、目标 Revision、方法版本、有效期、结果和证据由 [`attestation.schema.json`](../../specs/akep/v0.1/schemas/attestation.schema.json) 定义；签名/VC/in-toto 包装通过 `envelopeRef` 或 Federation DSSE 承载，不把签名字节写入 Revision Manifest。

签名只证明“某身份确认了某些字节”，不证明内容真实。AKEP 不定义全局 `trustScore`。接收方按用途独立评估来源、证据、时效、冲突、安全和任务效果；共享评分时应作为带评价者和上下文的 Assessment。

### 8.3 Channel、Status 与 Contribution workflow

三套状态不得混用：

- **Contribution workflow**：`candidate / validating / needs_evidence / verified / accepted / rejected / quarantined / withdrawn`，表示一次提案的处理进度。
- **Channel pointer**：每个 `Space + Trust Domain` 维护 `candidate / verified / published` 三个命名指针，指向 Record 的某个 Revision。
- **Revision Status overlay**：`deprecated / revoked / quarantined / erased` 是针对固定 Revision 的追加声明，不是 Channel。

Manifest 不含以上可变状态。Channel 更新和 Status 声明都使用带 Space、Trust Domain、Actor、时间、理由、策略版本/epoch 和目标 Revision 的追加式 LifecycleEvent；结构见 [`lifecycle-event.schema.json`](../../specs/akep/v0.1/schemas/lifecycle-event.schema.json)。本域 `published` 不代表其他域必须采信；远端导入默认创建接收方 Contribution 并进入本地 Candidate 流程。

Resolve 表示中每个 `Space + Trust Domain + Record + channelName` 最多一个当前指针，`channels` 的 `(trustDomain,name)` 键必须唯一；`statuses` 的 `(trustDomain,revisionId,name)` 键也必须唯一。Status 的当前值由不可变事件序列归约，资源数组不得用重复条目表达优先级。JSON Schema 的 `uniqueItems` 只能排除整对象完全相同，不能证明这些复合键唯一；Producer 必须生成唯一键，客户端遇到冲突键必须拒绝整个 Resolve 结果，不能自行挑选时间较新者。

`revoked` 和 `erased` 对同一 Revision 具有单调安全优先级：旧的 publish/update 事件不得使其复活，`status.cleared` 也不得清除它们。恢复必须使用新 Revision，并保留历史撤销。

### 8.4 撤销与删除

- `revoke`：立即停止使用和传播，但可为审计保留最小必要内容。
- `erase`：请求删除正文、Chunk、Embedding、缓存和其他派生副本，只保留最小墓碑。
- Hash 也可能泄漏低熵内容，墓碑不应无条件公开 digest。
- 跨组织协议只能获得删除请求和 ACK，不能单独证明对方完成物理擦除；仍需合同、审计和合规控制。

## 9. Conformance Profile

| Profile | 必须实现 |
| --- | --- |
| `reader` | discovery、text query、按 Space resolve/fetch、稳定 Citation、读取回执 |
| `contributor` | reader + Manifest Contribution + Evidence Amendment/Withdrawal + Usage + Feedback + 幂等；原始 Ingestion 可选 |
| `curator` | contributor + 验证/审核决定；不能改变 Published Channel 或单调安全状态 |
| `publisher` | curator + 独立 publication/safety decision；默认只供受信治理系统 |
| `federation` | reader + snapshot/changes/ACK + 签名事件链 + 撤销/删除 ACK |

Profile 是累积能力，discovery 的 `profiles` 数组必须显式列出继承链：contributor 包含 reader，curator 包含 contributor，publisher 包含 curator，federation 包含 reader；机器 Schema 同时验证相应 operation 集。一个 Node MUST 在 discovery 中声明已实现的 Profile。MVP 推荐只对 Agent 开放 `reader` 和 `contributor`；Agent 默认不能获得 Curator 或 Publisher 权限。

## 10. HTTP Binding

### 10.1 基本要求

- 生产 Endpoint MUST 使用 HTTPS。
- 结构化控制面请求/响应使用 `application/json`；例外是 Ingestion 的 `multipart/form-data`、Blob 的 `application/octet-stream`、Snapshot 的 `application/x-ndjson` 和 RFC 9457 的 `application/problem+json`。注册正式媒体类型前，专用类型仅作实验提示。
- 除尚未发现版本的 `GET /.well-known/akep` 外，发往 `baseUrl` 的请求 MUST 发送 `AKEP-Version: 0.1`；所有符合本协议的响应（包括 discovery）MUST 回显选定版本。
- Wire 协商使用 `major.minor`（此处 `0.1`）；OpenAPI 文档自身使用 SemVer（此处 `0.1.0`），Manifest 则使用独立 `manifestVersion`，三者不得混用。
- 服务端 MUST 限制请求体、Payload、分页、查询复杂度和执行时间，并在 discovery 中公布上限。
- 所有日期使用带时区 RFC 3339；服务端生成时间使用 UTC。
- 写操作 MUST 支持 `Idempotency-Key`，键至少在 discovery 声明的窗口内有效。
- 条件更新使用 ETag/`If-Match`；并发冲突返回 409 或 412，不得静默覆盖。
- Resolve、Revision 和 Blob 读取必须带 `AKEP-Purpose` 与 `AKEP-Obligation-Support`，并与 token/委托共同授权。后者是 `base64url-no-pad(JCS(supportedObligations))`；例如 `["cite","no-train"]` 编码为 `WyJjaXRlIiwibm8tdHJhaW4iXQ`。服务端必须将该请求声明与受信 OAuth 客户端元数据/工作负载注册取交集，不能据此扩大能力；未知或无法强制的义务在返回正文前 fail closed。Revision 只返回不可变 Manifest；可变 Channel/Status 由 Resolve 返回，Payload 通过带 Space/Revision 上下文的 Blob 路径读取。
- 读取响应应使用 `Cache-Control: private` 和正确的 `Vary`；撤销敏感资源不得依赖长期共享缓存。PolicyBinding/Channel、revoked/quarantined/erased、强制 Attestation 失效/过期以及访问相关身份/Group 变化都必须在安全事务中先写 deny/tombstone 并递增 `policyEpoch`，使 Query snapshot、读取回执和授权缓存立即 fail closed；异步清理不能延长分发权限。
- 异步操作可返回 202 和 Operation URI。
- `traceparent` SHOULD 跨 HTTP、Worker、MCP、A2A 与事件传播。

### 10.2 发现

```http
GET /.well-known/akep
```

示例：

```json
{
  "protocol": "akep",
  "versions": ["0.1"],
  "node": {
    "id": "https://knowledge.example",
    "name": "Example Knowledge Node"
  },
  "baseUrl": "https://knowledge.example/akep/0.1",
  "profiles": ["reader", "contributor", "curator", "publisher"],
  "operations": ["query", "resolve", "fetch", "receipt", "contribute", "amend", "withdraw", "usage", "feedback", "decide", "publish", "deprecate", "revoke", "erase"],
  "auth": {
    "protectedResourceMetadata": "https://knowledge.example/.well-known/oauth-protected-resource"
  },
  "limits": {
    "maxPageSize": 100,
    "maxPayloadBytes": 10485760,
    "idempotencyWindowSeconds": 86400
  },
  "schemas": {
    "manifest": "https://knowledge.example/schemas/akep/0.1/asset-manifest.schema.json",
    "context-pack-request": "https://knowledge.example/schemas/akep/0.1/context-pack-request.schema.json",
    "context-pack": "https://knowledge.example/schemas/akep/0.1/context-pack.schema.json",
    "evaluation-run-request": "https://knowledge.example/schemas/akep/0.1/evaluation-run-request.schema.json",
    "evaluation-run": "https://knowledge.example/schemas/akep/0.1/evaluation-run.schema.json",
    "attestation": "https://knowledge.example/schemas/akep/0.1/attestation.schema.json"
  },
  "supportedExtensions": [
    {
      "uri": "https://knowledge.example/extensions/akep/context-pack/0.1",
      "required": false
    },
    {
      "uri": "https://knowledge.example/extensions/mcp-adapter/0.1",
      "required": false
    }
  ],
  "extensions": {},
  "critical": [],
  "expiresAt": "2026-07-16T00:00:00Z"
}
```

公开标准化前，`/.well-known/akep` 仍是实验名；对外发布时应完成 IANA well-known 注册或通过标准 Link 关系发现。Capability 文档应短期缓存。通过非原站目录分发时必须验证签名。
`supportedExtensions` 中的 URI 是能力标识，不等于额外 REST Endpoint；具体 wire shape 必须从
`schemas` 获取。`required:false` 表示它不是 Core 互操作前提，客户端可以不调用。当前参考实现
把 ContextPack 作为可选 REST 扩展，把 MCP 声明映射到单独部署的 stdio Adapter。

### 10.3 操作

以下路径相对于 `baseUrl`：

| 操作 | HTTP | Profile | 语义 |
| --- | --- | --- | --- |
| Query | `POST /queries` | reader | 授权后的检索；参考实现当前启用 lexical/exact |
| ContextPack（扩展） | `POST /context-packs` | reader | 按预算组装 Citation-ready 上下文并签发 Exposure Receipt |
| Resolve | `GET /spaces/{spaceId}/records/{recordId}` | reader | 返回该 Space 可见的 Channel/Head/Status |
| Fetch Revision | `GET /spaces/{spaceId}/revisions/{revisionId}` | reader | 返回授权后的不可变 Manifest 和读取回执 |
| Fetch Blob | `GET /spaces/{spaceId}/revisions/{revisionId}/blobs/{digest}` | reader | 在明确策略上下文中读取并校验 Payload |
| Fetch Attestation | `GET /spaces/{spaceId}/attestations/{id}` | reader | 读取验证、评测或审核声明及其签名引用 |
| Create Attestation | `POST /spaces/{spaceId}/attestations` | curator | 写入不可变非 benchmark 验证/审核声明 |
| Create EvaluationRun | `POST /evaluation-runs` | evaluator | 固定评测输入、指标和门槛，原子生成 benchmark Attestation |
| Fetch EvaluationRun | `GET /evaluation-runs/{id}` | reader | 按同一 Revision 授权上下文读取不可变评测结果 |
| Fetch LifecycleEvent | `GET /spaces/{spaceId}/lifecycle-events/{id}` | reader | 读取不可变 Channel/Status 事件 |
| Fetch Exposure Receipt | `GET /exposure-receipts/{id}` | reader | 取得服务端铸造的 Citation 集，用于 Usage 闭环 |
| Ingest | `POST /ingestions` | contributor | 上传原始文件到隔离区，由服务端解析并形成候选 |
| Ingestion Status | `GET /ingestions/{id}` | contributor | 查询扫描、解析和候选创建进度 |
| Contribute | `POST /contributions` | contributor | 提交创建/修订/状态候选 |
| Contribution Status | `GET /contributions/{id}` | contributor | 查询候选处理状态 |
| Amend Evidence | `POST /contributions/{id}/evidence` | contributor | 在 needs_evidence 状态补充证据，不改变冻结 Revision |
| Withdraw | `POST /contributions/{id}/withdraw` | contributor | 撤回未接受候选但保留审计历史 |
| Usage | `POST /usages` | contributor | 将实际采用的 Citation 绑定到服务端曝光回执 |
| Feedback | `POST /feedback` | contributor | 提交使用结果证据 |
| Review Decide | `POST /contributions/{id}/decisions` | curator | 只能验证、拒绝、请求证据或隔离，不能发布 |
| Publish | `POST /contributions/{id}/actions/publish` | publisher | `akep:publish` 独立发布决定 |
| Deprecate | `POST /contributions/{id}/actions/deprecate` | publisher | `akep:publish` 废弃决定 |
| Revoke | `POST /contributions/{id}/actions/revoke` | publisher | 独立 `akep:incident` 紧急撤销决定 |
| Erase | `POST /contributions/{id}/actions/erase` | publisher | 独立 `akep:erase` 隐私/法务删除决定 |
| Changes | `GET /changes?cursor=...` | federation | 增量事件流 |
| Create Snapshot | `POST /snapshots` | federation | 创建初始或 cursor 失效后的策略范围快照 |
| Snapshot Status | `GET /snapshots/{id}` | federation | 获得签名快照、checkpoint 和首个 cursor |
| Snapshot Content | `GET /snapshots/{id}/content` | federation | 拉取摘要保护的 NDJSON 快照内容 |
| Ack | `POST /deliveries/{id}/ack` | federation | 持久化和策略应用后的收据 |

URI 放入 path 时必须进行百分号编码。实现 MAY 提供本地短 ID，但响应必须始终给出规范 URI/digest 身份。

## 11. Query 与 Citation

### 11.1 请求

Reader Core 必须支持 `text` Query；`reference` 是可选便捷模式。v0.1 没有定义 raw vector 的 wire shape 或可发现 Extension，Core Schema 因此必须拒绝它；未来若标准化，需单独发布不可变 URI、Schema、Profile/digest、维度与分数语义。

```json
{
  "query": {
    "text": "退款超过 30 天如何处理？",
    "locale": "zh-CN"
  },
  "mode": "hybrid",
  "spaces": ["https://knowledge.example/spaces/support"],
  "filters": {
    "assetTypes": ["procedure"],
    "validAt": "2026-07-15T02:00:00Z"
  },
  "purpose": "customer-support",
  "supportedObligations": ["cite", "no-train"],
  "limit": 10,
  "include": ["summary", "passages", "attestations"],
  "extensions": {},
  "critical": []
}
```

- `purpose` 是调用者请求的用途，不是授权事实；服务端必须把它与 token/委托及资源策略共同验证。
- `supportedObligations` 是客户端在本次调用中能确定性履行的义务。v0.1 Core 只固定 `cite`（输出/派生结果传播完整 Citation）和 `no-train`（不得把正文、摘要或派生表示用于训练/微调）；自定义义务必须使用 `{uri,digest}` 固定 Profile。服务器必须在返回正文前验证客户端精确支持全部有效义务，未知、参数不兼容或无法强制时 fail closed。
- `spaces` 和过滤器只能缩小授权范围，不能扩大范围。省略 `spaces` 表示在 token/委托允许的全部 Space 内查询；显式数组必须非空，`[]` 是 Schema 错误而不是“全部”或“无结果”。
- Manifest 的固定最低约束与本地 `EffectivePolicyBinding` 先取交集。PDP 将主体、委托、Space、Group/Role、classification、purpose、地域、时间和 `policyEpoch` 编译成不可由调用者伪造的 `AuthorizationPlan`，其中只包含允许的 `visibilityPartition`、服务端 opaque predicate handle 与摘要；Plan 不携带 SQL/任意 DSL，检索适配器必须在 dereference 时复核全部绑定字段。
- 检索引擎必须在 `ORDER BY / ANN / LIMIT` 之前应用 AuthorizationPlan、Published Channel 和 Chunk 级过滤；RLS/独立高敏分区是第二道防线，返回前再做 TOCTOU 复核。禁止先跨权限搜索再过滤。
- v0.1 MVP 的可编译授权范围限定为 `tenant + Space + Group/Role + classification + purpose`。任意图关系 ReBAC 只有能安全编译为允许 ID 集/分区时才可启用，否则 fail closed，不承诺通用 ReBAC。
- `mode` 的实现和排序算法是服务端能力，AKEP 不规定数据库或融合公式。

### 11.2 响应

```json
{
  "queryReceiptId": "urn:uuid:0198a1d2-82d5-7b43-8d2d-6af93e78c010",
  "policyEpoch": "support-policy-42",
  "snapshot": "opaque:ZXhhbXBsZS1zbmFwc2hvdA",
  "indexedThrough": "2026-07-15T01:59:58Z",
  "projectionGeneration": "embed-multilingual-v4/chunker-3",
  "results": [
    {
      "recordId": "https://knowledge.example/assets/refund-policy",
      "spaceId": "https://knowledge.example/spaces/support",
      "revisionId": "urn:akep:sha256:645b377464b2d9886f2567066e7d932156b2435df8fcc8d0790e5720129e430d",
      "profile": {
        "uri": "https://agentknowledge.dev/profiles/procedure/1",
        "digest": "sha256:aae83aa5cd8d97cba553b453544d89e97609c6d91a57109b3ed5ee4897e648b4"
      },
      "assetType": "procedure",
      "title": "退款处理流程",
      "scores": [
        {
          "method": "hybrid-rerank",
          "profile": "https://knowledge.example/rankers/support-v3",
          "value": 0.81
        }
      ],
      "citations": [
        {
          "citationId": "urn:uuid:0198a1d2-82d5-7b43-8d2d-6af93e78c002",
          "payloadDigest": "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
          "locator": {
            "type": "text-offset",
            "start": 120,
            "end": 248
          },
          "quote": "超过 30 天的申请需由值班主管复核。"
        }
      ],
      "relations": [
        {
          "type": "supersedes",
          "target": "urn:akep:sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
        }
      ],
      "qualityDecision": "suitable_with_warning",
      "qualityReasons": [
        "Procedure is approved for support use but requires supervisor review after 30 days."
      ],
      "qualityAttestationRefs": [
        "https://knowledge.example/attestations/review-0198"
      ],
      "effectiveDecision": "allowed_with_obligations",
      "obligations": ["cite", "no-train"]
    }
  ],
  "extensions": {},
  "critical": []
}
```

- `queryReceiptId` 是服务端签发的曝光回执。`snapshot` 使分页观察同一逻辑视图；两者都绑定主体、Space、purpose 与 `policyEpoch`，使用完整性保护的不透明短时 token/服务端记录。任何影响访问或强制信任门禁的 epoch 变化都会使其立即失效。零命中 Query 仍返回合法 Receipt，其 `citations` 为空；Revision/Blob 直读 Receipt 则必须至少有一个 Citation。
- Reader 结果只返回 `suitable` 或 `suitable_with_warning`，并必须带 `qualityReasons` 与 `qualityAttestationRefs`；`insufficient_evidence / unsuitable` 留在候选治理面，不能作为普通 Query 命中返回。访问决策仍由独立的 `effectiveDecision` 表达：`allowed` 必须没有义务，`allowed_with_obligations` 必须至少有一项义务；`denied` 项不得出现在结果中。
- `score.value` 仅在同一 Node、查询和 `profile` 内有排序意义，不得称为全局相似度或可信度。
- Citation MUST 固定到 Revision 和 Payload digest。`text-offset` 是精确 Payload UTF-8 字节序列中从 0 开始、start-inclusive/end-exclusive 的偏移；`byte-range` 同样使用 end-exclusive；`whole-resource` 固定完整 Manifest/Payload；`page` 从 1 开始，bbox 是左上原点、取值 0–1 的 `[x0,y0,x1,y1]`；`json-pointer` 遵循 RFC 6901。
- 若正文不能返回，服务端可仅返回引用和授权后的摘要；不可见资产不得影响对外结果、数量或分数。错误采用统一语义，高敏域再用物理隔离和统计测试降低时延侧信道，不承诺从理论上消除所有时延差异。
- 客户端必须执行返回的义务，例如引用、禁止留存、禁止训练；跨组织 Usage Policy 仍需合同和审计，不能被误称为技术 DRM。
- 直接读取的 `AKEP-Obligation-Support` 只是每次请求的收窄声明；有效能力仍来自受信 OAuth 客户端元数据或工作负载注册。读取响应的 `Vary` 必须包含 Authorization、purpose 和义务声明；若无法证明支持，服务器只可返回无正文拒绝或策略允许的 metadata-only 表示。
- Revision/Blob 直读只分发 `suitable / suitable_with_warning`。响应必须回显 `AKEP-Quality-Decision` 和一个主要 `AKEP-Quality-Attestation`；调用者在使用正文前必须读取 `AKEP-Read-Receipt` 指向的 Exposure Receipt，以取得每条 Citation 的完整原因和 Attestation 集。质量头不参与不可变 Manifest 的 ETag；`insufficient_evidence / unsuitable` 必须拒绝正文，warning 不得静默丢弃。

### 11.3 ContextPack 扩展

Node 只有在 discovery 的 `supportedExtensions` 声明 ContextPack URI 并发布 request/response
Schema 时，客户端才能调用 `POST /context-packs`。它是 Query 的有预算组装视图，复用同一
Published、Space、purpose、义务、策略 epoch、Revision 和 Citation；不能扩大 Query 权限。

```json
{
  "akepVersion": "0.1",
  "task": {
    "text": "为客服生成带引用的退款处理步骤",
    "locale": "zh-CN"
  },
  "mode": "lexical",
  "spaces": ["https://knowledge.example/spaces/support"],
  "purpose": "customer-support",
  "supportedObligations": ["cite", "no-train"],
  "budget": {
    "maxCharacters": 12000,
    "maxPassages": 12,
    "maxTokens": 8000
  },
  "extensions": {},
  "critical": []
}
```

响应由 [`context-pack.schema.json`](../../specs/akep/v0.1/schemas/context-pack.schema.json) 固定：
`contextDigest/contextPackId` 绑定任务、预算、Citation、义务、策略 epoch 和投影快照；
`passages` 是模型可直接组装的文本，`citations` 是可追溯身份，二者通过 `citationId` 对齐；
`quality` 公开门禁决定与 Attestation，`warnings` 明示预算截断、证据不足、质量警告或已废弃
知识。`exposureReceiptId` 必须进入后续 Usage，ContextPack ID 本身不能替代 Usage Receipt。

## 12. Contribution

贡献类型：

- `create`
- `revise`
- `deprecate`
- `revoke`
- `erase`

每个 Contribution 必须指定本地 `spaceId`。创建/修订请求包含 Manifest、计算后的 Revision ID、可选小型 inline Payload、父版本、理由和证据。状态类请求只包含目标 Revision、理由和证据。

Reviewer 返回 `needs_evidence` 后，原贡献者或显式代理只能通过 Evidence Amendment 追加理由/证据并用当前 ETag 把 workflow 送回 candidate；Manifest/Revision 不得原地变化，需要改正文时必须提交新的 revise Contribution。未进入终态的提案可用 Withdrawal 进入 `withdrawn`，历史 Decision 和证据不删除。

不能构造 Manifest 的人类 UI/连接器使用 `POST /ingestions` 上传一个受大小限制的 multipart 原始文件。平台先把字节写入租户隔离的临时对象区，再扫描、解析、计算 digest、构造 Manifest 并创建普通 Candidate Contribution。MVP 不接受服务端任意抓取调用者 URL；大文件分片/受控连接器导入是后续 Extension。

Ingestion polling 的 `candidate` 终态必须同时返回 `revisionId` 与 `contributionId`，`failed` 必须返回可授权读取的 `problemRef`；非终态不得提前暴露这三个终态字段。

服务端处理顺序：

1. 验证身份、委托、scope、幂等键和配额。
2. 重新计算 Manifest/Payload digest，验证 Schema、`critical` 扩展和基础版本。`revisionId` 必须等于 Manifest JCS hash；revise 的 `baseRevisionIds` 集合必须等于 `manifest.parents`，所有父 Revision 必须属于同一 Record；inline Payload 的 name/digest/解码后 size 必须逐项匹配 descriptor。
3. 隔离并扫描不可信内容；检查来源、策略、许可证和敏感信息。
4. 创建只在 Candidate 域可见的 Contribution receipt。
5. 运行评测/审核，生成独立 Attestation；`verify` Decision 必须引用至少一个已持久化 Attestation，空引用不能进入 verified。
6. `akep:review` 只能把候选标记为 verified、拒绝、请求证据或隔离；它不能改变 Channel、Status 或 `policyEpoch`。治理动作必须引用已经持久化的 verified Contribution，并通过 action-specific endpoint 授权。
7. Action 必须与 Contribution kind 精确匹配：`create/revise → publish`，`deprecate/revoke/erase →` 同名 action；不匹配请求必须拒绝。普通发布权不能撤销或擦除：revoke 需要短时高审计 `akep:incident`，erase 需要独立 `akep:erase` 以及 Privacy/Legal 策略批准。
8. Decision、Contribution ID/ETag、Actor、策略版本、旧/新 `policyEpoch`、LifecycleEvent、Channel/Status、权威审计事实和 Outbox 必须在一个数据库事务中绑定并提交。

响应 `201` 或 `202`：

```json
{
  "contributionId": "urn:uuid:0198a1d2-82d5-7b43-8d2d-6af93e78c020",
  "spaceId": "https://knowledge.example/spaces/support",
  "kind": "create",
  "subjectRevisionId": "urn:akep:sha256:645b377464b2d9886f2567066e7d932156b2435df8fcc8d0790e5720129e430d",
  "status": "candidate",
  "submittedRevisionId": "urn:akep:sha256:645b377464b2d9886f2567066e7d932156b2435df8fcc8d0790e5720129e430d",
  "policyEpoch": "support-policy-42",
  "statusUrl": "https://knowledge.example/akep/0.1/contributions/0198a1d2-82d5-7b43-8d2d-6af93e78c020",
  "createdAt": "2026-07-15T02:03:00Z"
}
```

Receipt 的 `spaceId / kind / subjectRevisionId` 是不可变动作上下文：创建/修订时 subject 等于 `submittedRevisionId`，状态类提案时等于请求的 `targetRevisionId`。响应体 `policyEpoch` 与 `AKEP-Policy-Epoch` 必须相同，表示该 Contribution 所属 Space 的当前治理快照；Publisher 将它作为 `expectedPolicyEpoch` 提交，竞态时必须重新 GET 而不能猜测。

基础版本已分叉时返回 409，并给出调用者有权看到的 Head；当前线性审核实现只接受一个父版本，
多父合并返回 `AKEP_MERGE_UNSUPPORTED`，不得用 last-write-wins 冒充合并。

### 12.1 EvaluationRun 与 Attestation

`POST /evaluation-runs` 接受固定 Revision、Dataset/Evaluator 的不可变 URI+digest、实际指标、
required/advisory 阈值、时间范围和证据引用。服务端计算每项 gate check，持久化不可变
EvaluationRun，并在同一事务中生成 `type=benchmark-result` 的 Attestation。普通
`POST /spaces/{spaceId}/attestations` 不得自行铸造 benchmark-result。

```json
{
  "akepVersion": "0.1",
  "clientRunId": "urn:uuid:0198a1d2-82d5-7b43-8d2d-6af93e78c030",
  "spaceId": "https://knowledge.example/spaces/support",
  "revisionId": "urn:akep:sha256:645b377464b2d9886f2567066e7d932156b2435df8fcc8d0790e5720129e430d",
  "startedAt": "2026-07-15T02:00:00Z",
  "completedAt": "2026-07-15T02:01:00Z",
  "expiresAt": "2026-10-01T02:01:00Z",
  "dataset": {
    "uri": "https://knowledge.example/evaluations/support-golden/1",
    "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "evaluator": {
    "uri": "https://knowledge.example/evaluators/retrieval-gate/1",
    "digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  },
  "metrics": {
    "recallAt5": 0.94,
    "harmRate": 0.0
  },
  "thresholds": {
    "recallAt5": { "operator": "gte", "value": 0.9, "required": true },
    "harmRate": { "operator": "lte", "value": 0.01, "required": true }
  },
  "summary": "Golden support evaluation completed.",
  "evidenceRefs": ["https://knowledge.example/evaluation-evidence/run-030"],
  "critical": []
}
```

任一 required check 失败产生 `fail`，advisory check 单独失败产生 `warning`，否则为 `pass`。
Review/Publish 只能引用已持久化、未过期、目标 Revision/Payload 匹配且 outcome 可接受的
Attestation；服务端必须逐项满足不可变 Profile 的 `requiredAttestations`。`schema-validation` 与
`safety-scan` 只能由节点在真实执行后生成；来源/许可/人工审核绑定 Curator 决定，策略批准绑定
Publisher 决定。当前两个 Profile 不强制 benchmark；一旦 Profile 明确要求 benchmark，则只能
接受可回查到 completed EvaluationRun 的证明。`warning` 发布为 `suitable_with_warning`，不能在
Reader 响应中静默提升为 suitable。所有 Attestation/Evaluation 证明的有效期最多 90 天，
Procedure 的 `scope.reviewAfter` 到期后正文消费 fail closed，必须提交并审核新 Revision。

## 13. Usage、Feedback 与成长闭环

Query 返回 `queryReceiptId`，直接 Revision/Blob 读取返回 `AKEP-Read-Receipt`；两者都是可用于 `GET /exposure-receipts/{id}` 的规范 URI。服务端按 [`exposure-receipt.schema.json`](../../specs/akep/v0.1/schemas/exposure-receipt.schema.json) 返回短时 Exposure Receipt，绑定主体假名、Space、purpose、义务、Citation 集、每条 Citation 的质量决定/原因/Attestation、策略 decision ID、`policyEpoch` 和有效期。客户端不得自行铸造 Citation ID。

直接 Revision 读取的 Receipt 至少铸造一个 `whole-resource` Citation，其 `payloadDigest` 等于 Manifest JCS 的 `sha256:<hex>`；完整 Blob 读取使用 descriptor digest 与 `whole-resource`，Range 读取使用完整 Payload digest 与本次返回区间的 `byte-range`。这样 direct read 和 Query 都能构造同一个 Usage Schema。

Agent 在真正把哪些 Citation 放入上下文或用于决策后，调用 `POST /usages`，提交 Exposure Receipt 与精确 Revision/Payload/locator。服务端必须验证：

- Receipt 由本节点签发、未过期且 `policyEpoch` 仍有效。
- 调用主体与原曝光主体相同或有明确委托。
- 每个 Citation 确实存在于 Receipt，可报告的 influence 为 `primary / supporting / seen`。
- 一次 Usage 的全部 Citation 都必须在 Exposure Receipt 中属于请求根字段 `spaceId`；跨 Space Query 的实际使用必须按 Space 拆成多个 Usage。
- 幂等重试只生成一个 `usageId`。

服务端返回的 Usage Receipt 固定 Citation、主体、Space、purpose 和 policy decision；Feedback 只能引用调用者有权评价、仍在反馈窗口内的真实 `usageId`。伪造、跨主体或 Citation 不匹配必须拒绝。

Feedback 是证据，不是事实或奖励指令。最小字段：

- 唯一 `feedbackId` 和 `usageId`
- 精确 Citation/Revision/Payload/locator，并可为每条 Citation 单独给 outcome
- `taskCategory`，默认不上传原始用户请求
- `outcome`：`helped / neutral / harmed / unknown`
- 类型化指标和可选 Evidence 引用
- 观察时间、评价者身份、固定评测器版本；机器评测与人工评测都必须引用不可变 Evaluator Profile URI + digest
- 隐私处理和上下文摘要

服务端返回 [`feedback-receipt.schema.json`](../../specs/akep/v0.1/schemas/feedback-receipt.schema.json)，把认证主体的假名化摘要、Usage、固定 Evaluator Profile、接收时 `policyEpoch`、来源相关性类别和是否可进入聚合铸成不可由客户端自报替代的 Evidence receipt。Receipt 必须回显固定的 `evaluatorVersion`；`quarantined` 必须令 `eligibleForAggregation=false`。只有该服务端 receipt 可进入聚合评测；`recorded` 不代表可信或独立。

平台必须：

- 对反馈做身份绑定、去重、来源相关性、Sybil/互刷和曝光偏差处理。
- 标记贡献者对自己资产的评价，不能算独立证据。
- 不因调用次数或点赞直接提高发布状态。
- 正向晋级经过独立离线评测和对应风险级别审核；安全负证据可以快速降级或撤销。
- MVP 禁止用生产 Feedback 自动微调或自动发布。

推荐闭环：

```text
Usage → Feedback → Candidate Evidence → Independent Evaluation
      → Contribution → Review/Canary → New Revision → Promote/Rollback
```

## 14. 事件

AKEP 使用 CloudEvents `specversion: "1.0"`，不自定义通用事件信封。事件类型：

- `org.akep.revision.accepted.v1`
- `org.akep.channel.updated.v1`
- `org.akep.attestation.issued.v1`
- `org.akep.feedback.recorded.v1`
- `org.akep.revision.revoked.v1`
- `org.akep.revision.erase-requested.v1`
- `org.akep.subscription.reset.v1`

其中 v0.1 Federation 只允许 [`federation-event.schema.json`](../../specs/akep/v0.1/schemas/federation-event.schema.json) 中固定的 accepted/channel/attestation/revoked/erase-requested 子集；`feedback.recorded` 是本地证据事件，`subscription.reset` 是本地控制事件，二者不得未经独立 Extension 与对端策略协商自动导出。

要求：

- `source + id` 作为投递去重键。
- `subject` 使用 Record URI；`data.revisionId` 固定具体 Revision。
- `dataschema` 使用不可变 Schema URI。
- 事件只带小型清单和引用，大 Payload 通过带 Space/Revision 上下文的 AKEP Blob Resource 拉取并验摘要。
- CloudEvents 不提供 exactly-once、全局顺序或事务保证；实现按至少一次、可乱序设计。
- 审计日志是独立的权威追加流，OpenTelemetry 或消息 broker 留存不能代替审计。

## 15. 联邦 Profile

联邦是零信任导入，不是数据库复制。实现若不能满足签名、防重放、撤销优先和本地候选隔离，MUST NOT 声明 `federation`。

### 15.1 同步

- 初次同步先 `POST /snapshots`，服务端回显实际接受的 filter；Snapshot ready 后提供同源、需 `akep:federate` 授权且 `private, no-store` 的 `/snapshots/{id}/content`、`snapshotDigest`、签名 checkpoint、`deliveryId` 和首个 changes cursor。持续同步使用 `changes` cursor，每批持久化并应用本地策略后才发送 ACK。
- Snapshot 内容是 `application/x-ndjson`：首行是 [`snapshot-stream-header.schema.json`](../../specs/akep/v0.1/schemas/snapshot-stream-header.schema.json)，后续每行是一个 [`dsse-event-envelope.schema.json`](../../specs/akep/v0.1/schemas/dsse-event-envelope.schema.json)。每行都用 JCS JSON 的 UTF-8 字节并以 LF 结尾，包括末行；`snapshotDigest` 是完整字节流的 AKEP SHA-256。端点不得跨源重定向或把 bearer credential 放入 URL，可用 Range 断点续传，组装完整后必须重算摘要。
- cursor 是不透明、Peer/身份/策略范围绑定且有过期时间的 token。
- cursor 失效返回 HTTP 410 与 RFC 9457 Problem Details，并提供新 Snapshot 链接。
- Snapshot polling 的 `ready` 必须带完整下载/摘要/checkpoint/delivery 字段，`failed` 必须带 `problemRef`；过期状态不放进 200 Receipt，而统一使用 410 Problem + replacement Location。
- 默认至少一次投递；接收方按 CloudEvents `source + id` 和 Revision ID 幂等。
- 只保证单发布流内顺序，不定义全局顺序。
- 大规模实现可协商 Merkle 分区摘要做反熵，但不是 v0.1 Core 要求。
- 服务端必须回显实际接受的过滤器，避免调用者误认为某过滤条件已生效。

### 15.2 签名事件流

每个 Federation 事件至少包含：

```text
streamId, epoch, sequence, previousEventHash,
originTrustDomain, issuer, audience,
issuedAt, expiresAt, eventId,
recordId, revisionId, eventType
```

- 同一 `streamId + epoch` 中 sequence 单调递增，事件携带前序摘要。
- `previousEventHash` 是前一 FederationEvent 的 JCS 字节 SHA-256；序号 0 不带该字段，后续事件必须携带。当前事件不能在自身 payload 内声明自摘要；接收方验签后自行计算并保存它。
- 结构化 CloudEvent 必须通过 [`federation-event.schema.json`](../../specs/akep/v0.1/schemas/federation-event.schema.json) 校验，再以 JCS 字节作为 DSSE payload。v0.1 Federation 的共同必选套件是 `DSSE + JCS + Ed25519`（discovery 名称 `dsse-jcs-ed25519`）；实现可以额外协商其他套件，但不能移除这一基线。
- discovery 的 Federation 能力必须给出 HTTPS `keySetUri`，其内容为 RFC 7517 JWK Set；`keyid` 必须匹配 JWK `kid`，Ed25519 基线使用 `kty=OKP, crv=Ed25519`。Peer 必须固定 Trust Domain 与信任根，按事件签发时间验证 key 状态、轮换和撤销，不能仅凭任意 `keyid` 在线取钥。
- 验签与 Schema 通过后还必须验证语义全等：CloudEvents `subject == data.recordId`；Manifest/LifecycleEvent/Attestation 的 Record、Revision、Space 与 Trust Domain 必须和外层一致；accepted 事件必须满足 `hash(manifest) == data.revisionId` 且 Manifest record 相同；channel.updated 只能携带 `channel.updated`；revoked/erase-requested 分别只能携带 `status.asserted/revoked` 与 `status.asserted/erased`；Attestation subject 必须是同一 Revision。任一不一致都拒绝且不 ACK。
- Checkpoint payload 必须通过 [`checkpoint.schema.json`](../../specs/akep/v0.1/schemas/checkpoint.schema.json)，固定 issuer、audience、接受过滤器 JCS digest、每个 stream 的 epoch/sequence/lastEventHash 和有效期，再用 `dsse-jcs-ed25519` 包装为 [`signed-checkpoint.schema.json`](../../specs/akep/v0.1/schemas/signed-checkpoint.schema.json)。接收方只在验证签名和全部事件链后推进高水位。
- Checkpoint `positions` 的 `streamId` 必须唯一；`uniqueItems` 同样不足以表达 keyed uniqueness，接收方遇到重复 streamId 必须拒绝整个 Checkpoint，而不能选择其中一个位置。
- `eventSetDigest = sha256(JCS(sort([source + "\u0000" + id, ...])))`，ChangePage、Snapshot header/receipt 与 ACK 必须一致；空 delivery 使用 `sha256(JCS([]))`，ACK 可省略 `eventIds`。这样安静流/空 Space 与大 Snapshot 都可表达，无需在 ACK 中重复所有 ID。统一以 CloudEvents `source + id` 去重，并拒绝错误 audience、过期、降级、重复和未知 critical 扩展。
- 序列缺口应暂停普通 publish/update；签名有效的 revoke/erase 可先立即生效，再对账缺失历史。
- `revoked/erased` 状态不得被旧事件、快照回滚或备份恢复后的重放复活。
- A 信任 B 不代表 A 信任 B 所信任的 C；默认禁止传递信任。
- 每个 ChangePage/Snapshot delivery 都包含 `deliveryId`。ACK body 的 deliveryId、checkpoint 和 `eventSetDigest` 必须精确匹配该 delivery；可选 event ID 列表若存在也必须全等，认证 Peer 必须与投递受众相同。只有事件、内容、有效策略、墓碑和本地 `policyEpoch` 已持久化并应用后才能发送 `status=applied`。

### 15.3 策略交集

- 远端发布进入本地 `candidate`，不能直接进入本地 `published`。
- 远端策略、本地策略和共享合同取交集；角色名不能跨 Trust Domain 直接等价映射。
- 支持 `metadata_only`、`reference_only`、`copy` 三种共享模式。
- 缓存、Chunk、Embedding、图边和摘要都继承原策略。
- 高敏能力的离线授权必须有短租约；超过最大撤销陈旧时间时 fail closed。

## 16. 认证与授权

- OAuth 部署必须遵循 [RFC 9700](https://www.rfc-editor.org/info/rfc9700/)；Node SHOULD 发布 [RFC 9728](https://www.rfc-editor.org/info/rfc9728/) Protected Resource Metadata。
- 人类身份使用 OIDC；Agent/服务使用 client credentials、mTLS、DPoP 或工作负载身份。
- 高风险联邦 SHOULD 使用 sender-constrained token 和双向身份验证。
- 粗粒度 scope：`akep:discover`、`akep:read`、`akep:query`、`akep:contribute`、`akep:feedback`、`akep:review`、`akep:publish`、`akep:incident`、`akep:erase`、`akep:federate`、`akep:admin`。其中 publish、incident 与 erase 互不包含。
- 细粒度决策由本地 PDP 完成，至少考虑主体、委托、租户、Space、Revision/Chunk、用途、地域、时间、风险和义务。
- Agent 默认不能持有 `publish/admin`；LLM 输出不能创建或扩大授权。
- 生成或动作前若授权快照/租约已失效，必须重新判定。

有效动作授权始终是：

```text
UserDelegation ∩ AgentPolicy ∩ CapabilityManifest
∩ ResourcePolicy ∩ RuntimePolicy
```

知识内容不能扩大任一集合。

## 17. 错误

错误响应使用 `application/problem+json`，遵循 RFC 9457：

```json
{
  "type": "https://agentknowledge.dev/problems/revision-conflict",
  "title": "Revision conflict",
  "status": 409,
  "detail": "The submitted base revision is no longer the only head.",
  "instance": "urn:uuid:0198a1d2-82d5-7b43-8d2d-6af93e78c099",
  "code": "AKEP_REVISION_CONFLICT",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

稳定错误码至少包括：

- `AKEP_VERSION_UNSUPPORTED` — 400/426
- `AKEP_SCHEMA_INVALID` — 422
- `AKEP_DIGEST_MISMATCH` — 422
- `AKEP_CRITICAL_EXTENSION_UNSUPPORTED` — 422
- `AKEP_POLICY_DENIED` — 403
- `AKEP_NOT_FOUND` — 404；在防存在性泄漏时 403/404 语义应一致
- `AKEP_REVISION_CONFLICT` — 409
- `AKEP_IDEMPOTENCY_CONFLICT` — 409
- `AKEP_PRECONDITION_FAILED` — 412
- `AKEP_CURSOR_EXPIRED` — 410
- `AKEP_RECEIPT_EXPIRED` — 410
- `AKEP_RATE_LIMITED` — 429
- `AKEP_FEDERATION_GAP` — 409
- `AKEP_SIGNATURE_INVALID` — 422

错误正文不得泄漏不可见资产、策略细节、主体列表或敏感来源。

## 18. MCP Adapter

MCP 只做 Agent 到 Node 的访问适配：

- Resource URI：`knowledge://capabilities`（实时 Capability 文档）
- 只读 Tools：`knowledge_search`、`knowledge_context`、`knowledge_get`
- 证据/贡献 Tools：`knowledge_record_usage`、`knowledge_record_feedback`、`knowledge_submit_candidate`

要求：

- 工具参数和结果直接复用 AKEP Schema，避免形成第二套领域模型；`knowledge_record_usage` 把 Query/Read Exposure Receipt 与实际采用的 Citation 铸成 Feedback 所需的 Usage Receipt。
- `knowledge_get` 固定 Revision；读取 Record Head 需显式 Resolve。
- 写工具使用幂等键，并返回 Contribution receipt。
- `knowledge_submit_candidate` 不得映射为直接发布。
- Adapter 是独立 stdio 进程，使用 `AKEP_BASE_URL` 与最小权限 `AKEP_TOKEN` 调用 Core；
  discovery 声明不表示 Core 内嵌 MCP transport。
- MCP Tool annotations 只是客户端提示，不是授权边界。
- 当前稳定 MCP 的实验性 Tasks 不作为平台长期工作流基础。

## 19. A2A Adapter

A2A 负责 Agent 发现、任务、Message 与 Artifact：

- AgentCard 将 AKEP Endpoint 声明为一个知识能力。
- 长期知识产物作为 Artifact 返回，DataPart 携带 Revision Resource 或 URI；不要只塞进临时 Message。
- 大 Payload 只传 AKEP Blob Resource URI、摘要和短期读取回执；不要把可复用 bearer 下载地址写入长期 Artifact。
- A2A Task ID 可记录进 AKEP provenance/usage，但不能代替 Revision ID。
- A2A 的远端 Agent 发布状态不能绕过本地 Contribution 与治理流程。

## 20. 未来可执行能力安全下限（非 v0.1 Core）

本节只为后续独立 Profile 预留安全下限，不定义 v0.1 可声明能力、Schema、Endpoint 或执行语义。按第 6 节，v0.1 Node 不得接受或索引 `capability_manifest`。未来 Profile 至少声明：

- 制品 ID、版本和不可变 digest
- 发布者和构建来源
- 输入/输出 Schema
- 依赖与 SBOM
- 文件、网络、秘密、工具、CPU、内存和时间权限
- 支持的运行时及沙箱要求
- 安全扫描、评测和撤销状态

执行时：

- 禁止可变 tag；必须固定 digest。
- 安装检查不能执行脚本或反序列化任意代码。
- 默认只读文件系统、临时工作区、无宿主 socket、无网络。
- 秘密按单次调用注入，能力不得长期持有。
- 外部 Action Broker 重新验证 Schema、策略、目标和参数；LLM 不能直接批准副作用。
- 必须支持 kill switch、依赖影响分析和撤销。

## 21. 安全与隐私注意事项

### 21.1 间接提示注入

知识正文必须以带来源和 `untrusted_content` 标记的数据进入上下文，不得拼接到 system/developer/tool schema。PDF 隐藏层、OCR、注释、Unicode 双向字符和工具描述同样不可信。任何模型生成的 Tool 参数均由确定性代理重新验证。

### 21.2 解析器与位置 URI

上传和解析在无网络、低权限、资源受限沙箱中执行，防止宏、路径穿越、压缩炸弹和解析器漏洞。接收方不能盲目抓取 Manifest/事件给出的 URI；必须做 scheme、域名、DNS/IP、重定向、大小和媒体类型限制以防 SSRF。

### 21.3 向量与缓存泄漏

Embedding 不是匿名化内容。索引、缓存键、摘要和模型输出继承源策略；高敏内容使用独立分区/密钥。普通调用者不得获得 raw embedding、跨租户统计或可用于成员推断的全局分数。

### 21.4 投毒和相关来源

转载、翻译和 Agent 互相复制不构成独立证据。评估器必须利用 provenance 识别共同祖先，对单来源/贡献者的影响设上限，并把评测集和发布阈值隔离在控制面。

### 21.5 反馈操纵

反馈需速率限制、身份与组织相关性分析、曝光校正和异常检测。正向反馈不能自动发布；负面安全证据可以触发临时隔离，但最终决定仍需可审计策略。

### 21.6 日志与回执

Telemetry 默认不记录 Query、正文、Prompt、Tool 参数、token 或 PII。权威 Generation/Context/Policy Decision receipt 独立加密存储，只保留必要 ID、摘要和策略版本；不保存私有思维链。

## 22. 版本与扩展

必须分别版本化：

1. AKEP 协议
2. Manifest 格式
3. Profile/Schema
4. 词表/JSON-LD Context
5. Asset Revision DAG
6. 策略与评测规则

Schema、Profile、Context 发布后不可原地改写，必须使用不可变 URI 和 digest。扩展使用 URI 作为键，实验字段放入 `extensions`；`critical` 只能列出本对象 `extensions` 中的键，未知 critical 扩展必须失败。持久引用禁止使用 `latest`。

## 23. v0.1 互操作验收

声称兼容的实现至少通过：

1. 对 Golden Manifest 做 JCS + SHA-256，得到相同 Revision ID。
2. 拒绝摘要不匹配和未知 critical 扩展。
3. 同一幂等键重试返回同一 receipt，不产生重复候选。
4. 多父分叉不被 last-write-wins 覆盖。
5. Query Citation 固定到 Revision、Payload 和范围。
6. 未授权资产不出现在结果、数量或分数中；403/404 采用统一外部语义。实现必须按声明的威胁模型做统计侧信道测试，高敏域使用物理隔离，不宣称消除所有时延侧信道。
7. Candidate 不进入默认生产 Query。
8. 撤销后缓存、全文、向量和图投影失效。
9. Feedback 不能直接发布、改正文或触发在线训练。
10. 合法签名但错误内容不会显示为“事实已验证”。
11. Federation 重复、乱序、旧快照和旧 publish 不能复活 revoked Revision。
12. MCP/A2A Adapter 返回同一 AKEP Revision 身份，不生成平行版本体系。

## 24. 后续但不进入 v0.1 Core

- 公共 P2P 网络和全局节点目录
- 全局信誉、全局本体或全局真值
- 自动语义合并和复杂 CRDT
- 强制 DID、区块链或透明日志
- 自定义全文/图/向量查询语言
- Raw vector Query Extension 及跨 embedding Profile 协商
- 强制 SPARQL/RDF 内部存储
- 隐私计算、同态加密和跨域安全聚合
- Merkle 反熵、公开透明日志和 fork detection

这些能力应以独立 Profile/扩展孵化，经过参考实现、测试向量和安全评审后再进入稳定规范。
