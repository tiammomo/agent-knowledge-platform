# Web Console 与新手引导

- 状态：可运行开发基线
- 最近核对：2026-07-18
- 前端：React 19、TypeScript 7、Vite 8、原生 CSS 设计系统

## 产品目标

Console 的任务不是把数据库表包装成管理后台，而是让用户看懂并执行“知识如何成长”的完整
闭环。界面始终区分候选知识、审核决策、发布版本和使用证据，避免把上传成功误解成知识已经
可信。

## 信息架构

| 页面 | 用户任务 | 数据来源 / 写动作 |
| --- | --- | --- |
| 总览 | 看知识、待推进、Usage、Feedback、最近活动，并按真实状态选择职责化下一步 | `GET /console/v1/overview` |
| 知识库 | 浏览 Published/Deprecated 版本，执行带引用查询，解释授权/排序证据，查看来源、Manifest 和适用边界 | assets、queries、revision API |
| 贡献知识 | 编写内容和边界，在浏览器计算摘要并提交候选 | `POST /contributions` |
| 审核中心 | 查看候选正文/差异，核验证据、范围和义务，先运行评测再给出独立决策 | contributions、evaluation-runs、decisions API |
| 发布治理 | 发布已验证候选，发起/执行废弃、撤销、擦除 | lifecycle contributions/actions |
| 效果证据 | 解释工作流漏斗、Usage/Feedback 归因、伤害队列和服务 SLO | evidence summary、service health |
| Agent 接入 | 能力发现、无凭证公开预检、TypeScript/Python SDK、ContextPack、MCP 和 cURL 接入 | health、`/.well-known/akep`、OAuth metadata、Schema、SDK/MCP |
| 平台设置 | 查看节点、信任域、Policy Epoch 和职责分离 | capability、overview read model |

### 目标运营控制面（尚未实现）

外部接入、持续维护和多团队部署需要新增三个控制面，不能塞进现有“设置”页：

| 页面 | 核心任务 | 安全边界 |
| --- | --- | --- |
| Integrations | Owner、workload client、Space/purpose/scope、quota、credential expiry、canary、suspend/retire | 不能发治理权限；secret 只存引用 |
| Maintenance | due/conflict/incident queue、来源 diff、SLA、Owner 接管、waiver、批次评测 | 自动化只能创建任务/Candidate/证据 |
| Spaces & Sharing | Tenant/Space Owner、PolicyBinding、成员映射、Shared Space adoption/reference/copy 请求 | Tenant admin 不自动读正文或发布 |

这三个页面的写 API 属于私有控制面，不进入 AKEP Core 协议。当前实现完成
[外部接入](../architecture/external-integration.md)、
[持续维护](../governance/knowledge-maintenance.md)和
[多团队隔离](../architecture/multi-team-isolation.md)的后端门禁之前，不提供“仅前端”的伪管理能力。

### 用户职责

| 用户 | 主要页面 | 关键边界 |
| --- | --- | --- |
| Reader / Agent 集成人员 | 知识库、Agent 接入 | 只能消费已授权 Published 知识 |
| Contributor | 贡献知识、自己的候选 | 上传成功不等于发布成功 |
| Evaluator | 审核中心的评测动作 | 只提交真实 EvaluationRun |
| Curator | 审核中心 | 能验证/拒绝/补证/隔离，不能发布 |
| Publisher | 发布治理 | 能发布/废弃，不能紧急撤销或擦除 |
| Incident / Eraser | 发布治理的窄动作 | 分别执行已验证的撤销/擦除候选 |
| Console Operator | 总览、效果证据、设置 | 读取全局投影，不获得写权限 |

## 当前职责工作台与可信检索体验

总览的“现在最值得处理”由 `GET /console/v1/overview` 的实际数量和工作流状态生成，最多展示四个
当前可执行方向。例如 candidate/validating 指向 Curator 审核，needs_evidence 指向 Contributor
补证，verified 指向 Publisher，已发布但尚无使用证据时指向 Reader 查询或 Agent 接入。最近活动
也按状态进入审核、补证、发布治理或知识库，不再把所有记录都导向贡献页；五步引导完成后，快速
上手卡片会退出主工作区。

这个视图是开发环境中“按职责归类”的运营工作台，不是根据生产登录主体、组织成员或值班轮次
生成的个人任务队列。浏览器仍使用多个 `dev-*` 身份演示职责分离；目标 Integrations、
Maintenance 和 Spaces & Sharing 控制面仍未实现。

知识检索把相关性、治理质量和适用范围分开表达：

- 结果顶部展示授权 Space、`customer-support` purpose、Policy Epoch、投影代次和索引水位。
- 每条结果展示 Published/Deprecated 状态、资产类型、Space、质量结论、来源数、Passage Citation
  与义务；“本次排序分”只表示本次查询相关性，不称为信任分。
- 详情解释召回方法、质量结论、稳定引用、策略水位和 Exposure Receipt，并展示主要来源、生成主体、
  locale/jurisdiction、复审时间、有效期、允许用途、分类/导出限制和适用假设（Manifest 已声明时）。
- 查询结果可直接以返回的固定 Revision 打开，不依赖 Console 资产列表恰好已经投影出同一版本。
- 零结果明确限定为“当前授权范围内没有足够证据”，可浏览可访问知识、清除筛选重搜、修改关键词
  或贡献候选；界面不会把零结果解释成答案绝对不存在。

## Agent 公开接入预检

Agent 接入页可从当前浏览器运行无凭证公开预检，检查：

1. `/health/live` 和 `/health/ready`，包括数据库 readiness。
2. `/.well-known/akep` 的 AKEP 0.1、有效期、公开 Origin、Reader 操作和 ContextPack extension。
3. RFC 9728 Protected Resource metadata 的 resource、header bearer method、Reader scopes；缺少
   `authorization_servers` 会给出提醒，而不是把本地人工 token 配置误判为生产就绪。
4. Query request、ContextPack request/response 三份 Capability Schema 的同源可读性与 ETag。

预检请求使用 `credentials: omit`，不发送 cookie 或 `Authorization`，也不把 Discovery 可见写成
“节点已连接”。结果只证明当前浏览器网络能访问这些公开契约，不能证明生产 token 有效，不能覆盖
Agent 实际部署网络，也不能验证其 Tenant/Space/purpose/obligation 授权。上线前仍须从真实 Agent
环境运行认证负向测试和完整契约闭环；Agent 自身必须执行返回义务并保留稳定 Citation。

## 首次访问流程

引导进度保存在浏览器 `localStorage`，可以关闭后继续，也可以从左侧“新手任务”再次打开。

1. **连接节点**：读取 `/.well-known/akep`，展示节点、协议版本和能力。
2. **导入知识**：构造 Procedure Manifest，计算 Payload SHA-256 与 JCS Revision ID，以
   Contributor 身份创建 candidate。
3. **审核发布**：服务端先为实际执行的 Profile/内容扫描生成机器证明，Curator 阅读正文、差异、
   来源与每条扫描发现后提交独立决定，再由 Publisher 绑定当前 Policy Epoch 生成策略批准并发布。
   浏览器不会用占位数据伪造 EvaluationRun；真实 benchmark 只能由独立评测输入产生。
4. **引用检索**：执行真实 Query，只有找到已发布示例且结果含稳定 Citation 才完成步骤。
5. **Agent 接入**：说明用途、obligations 和稳定引用的消费方式，并引导到完整接入页。

引导失败会留在当前步骤并展示服务端 Problem Detail，不会伪造完成状态。步骤一和二产生的候选
具有随机 Record、Revision 和 Idempotency Key，重复运行不会覆盖已有知识。

## 视觉与交互基线

- 深海军蓝导航承载稳定的产品结构，靛蓝用于主动作，青绿色只表示可信/已验证状态，琥珀和红色
  分别表示待处理与高风险治理动作。
- 统一字号和克制的 8/12 px 圆角；主工作区优先使用分隔线、表格和连续内容流，只在需要独立
  边界的搜索、详情和危险操作使用卡片，不做大面积营销式留白。
- 桌面使用固定侧栏和双栏详情；小于 880 px 切换抽屉导航和单栏；小于 640 px 重排表单、表格与
  新手引导。
- 所有关键加载、空状态、错误、禁用、成功 Receipt 都有明确反馈。危险动作使用独立颜色和文案。
- 支持键盘焦点样式、语义化表单标签、dialog 属性、状态文本，以及
  `prefers-reduced-motion`。生产验收还需要独立完成 WCAG 2.2 AA 自动化与人工测试。

## 安全边界

Console API 返回私有展示投影：资产列表不返回 Payload 字节；贡献工作台会向具有
contribute/review/publish scope 的开发身份返回候选 inline Payload，以支持正文预览与差异审核。
所有响应使用 `private, no-store`，并执行贡献所有权、Space 与职责 scope 授权；数据库 Tenant
RLS 已作为第二道防线；固定部署 OIDC Principal 也必须携带匹配的签名 Tenant，Query Space 已在
元数据读取和检索排序/上限前过滤。多租户生产前还必须完成控制面动态 Tenant、外部 PDP、
分类/策略字段级脱敏，不能把当前开发投影直接开放给普通 Contributor。Nginx 统一 Origin，设置
CSP、禁止 frame 嵌入并关闭相机、麦克风和定位权限。

当前浏览器 bundle 中的多个 `dev-*` token 是明确的本地开发机制。上线前必须替换为 OIDC/OAuth
登录和短期会话，并在现有签名 Tenant Principal 与固定 Tenant RLS 上完成控制面动态 Tenant、
外部 PDP/完整策略下推、CSRF/会话防护、审计导出及高权限二次确认。

Agent 公开预检只读取公开健康端点、Discovery、OAuth Protected Resource metadata 和 Schema，
显式省略浏览器凭据。它不是 token 检查器、越权探测器或生产接入证明；真实 token、Agent 网络、
Space、purpose、义务与撤销传播必须在目标运行环境单独验证。

## 验收方式

```bash
pnpm check
pnpm test:integration
docker compose --profile app up -d --build
AKEP_WEB_ORIGIN=http://localhost:33005 pnpm smoke:web
```

最后一条命令从 Web Origin 执行 candidate → Profile Attestations → verify → publish →
query，并验证 Overview 中可见 Published 知识。SPA 深链接（例如 `/agents`）必须返回
`index.html`，API 与健康检查必须由相同 Origin 正确代理。
