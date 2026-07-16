# Agent Knowledge Platform 文档

- 状态：维护中的项目文档入口
- 最近核对：2026-07-16
- 适用版本：AKEP v0.1 实验实现

这里是项目文档的统一入口。第一次接触项目，建议先读[系统概览](architecture/system-overview.md)；
需要立即运行项目，请直接进入[本地开发手册](runbooks/local-development.md)。

> [!IMPORTANT]
> AKEP v0.1 是实验协议，不是公共标准。当前实现适合本地开发与受控的单租户隔离试点，
> 不代表已经完成多租户或互联网生产验收。

## 按目标阅读

| 目标 | 建议入口 | 读完可以得到 |
| --- | --- | --- |
| 了解项目解决什么问题 | [系统概览](architecture/system-overview.md) | 当前组件、数据边界、核心流程与有意关闭的能力 |
| 在本地运行和调试 | [本地开发手册](runbooks/local-development.md) | 容器/宿主机启动、开发身份、验证与排障方法 |
| 通过 HTTP 接入 | [HTTP API 快速参考](reference/http-api.md) | Base URL、请求头、权限、端点分组和可运行示例 |
| 通过 SDK 或 MCP 接入 | [TypeScript SDK](../packages/sdk-ts/README.md)、[Python SDK](../packages/sdk-python/README.md)、[MCP Adapter](../apps/mcp-server/README.md) | Agent 侧查询、读取、Usage/Feedback 与候选贡献 |
| 理解当前完成度 | [实现状态与生产门禁](architecture/implementation-status.md) | 已实现能力、明确关闭项和扩大部署前的门禁 |
| 理解架构决策 | [技术方案 v0.1](architecture/technical-design-v0.1.md)、[ADR](#架构决策记录) | 架构不变量、目标形态和关键取舍 |
| 实现或评审协议 | [AKEP v0.1 协议](protocols/akep-v0.1.md)、[机器可读契约](../specs/akep/v0.1/README.md) | 规范语义、OpenAPI、JSON Schema、Profile 和测试向量 |
| 审核与发布知识 | [信任、评测与发布治理](governance/trust-and-publication.md) | 风险分级、证据要求、职责分离和紧急控制 |
| 评审 Web Console | [Web Console 与新手引导](product/web-console-and-onboarding.md) | 页面任务、真实数据链路、安全和交互验收 |
| 准备隔离试点 | [生产试点运行手册](runbooks/production-pilot.md) | OIDC、数据库、观测、部署/回滚与剩余风险 |

## 文档地图

```text
docs/
├── README.md
├── architecture/
│   ├── system-overview.md
│   ├── implementation-status.md
│   ├── technical-design-v0.1.md
│   └── adr/
├── governance/
│   └── trust-and-publication.md
├── product/
│   └── web-console-and-onboarding.md
├── protocols/
│   └── akep-v0.1.md
├── reference/
│   └── http-api.md
└── runbooks/
    ├── local-development.md
    └── production-pilot.md
```

## 信息权威与适用范围

不同问题使用不同事实源，不能用目标设计覆盖运行行为，也不能用某个参考实现限制协议本身：

| 要回答的问题 | 首要事实源 | 说明 |
| --- | --- | --- |
| AKEP 对象和 HTTP wire shape 是什么 | `specs/akep/v0.1` 的 OpenAPI、JSON Schema、Profile 和测试向量 | 决定机器可读字段、约束和黄金向量 |
| AKEP 字段和状态语义是什么 | `docs/protocols/akep-v0.1.md` | 解释规范语义、安全要求和互操作边界 |
| 某个实例现在声明什么能力 | `GET /.well-known/akep` | 客户端集成时的最终依据，Capability 有有效期 |
| 参考实现实际如何运行 | 代码、迁移和自动化测试 | 与摘要文档冲突时应修正文档或实现，并补回归测试 |
| 仓库当前完成了什么 | `docs/architecture/implementation-status.md` | 面向人类的已启用/有意关闭摘要 |
| 后续希望演进到什么形态 | `docs/architecture/technical-design-v0.1.md` 与 ADR | 包含未启用组件，不能单独作为上线证明 |

协议契约与参考实现并不等价。例如 OpenAPI 定义 Federation 和 Ingestion 操作，是为了固定
协议边界；当前默认运行时没有启用 Federation、外部 Ingestion Connector、语义/混合检索或
可执行能力包。调用方必须以 Capability Discovery 为准。

## 架构决策记录

| ADR | 状态 | 决策 |
| --- | --- | --- |
| [ADR-0001](architecture/adr/0001-protocol-first-modular-monolith.md) | Accepted | 协议优先，以模块化单体验证最小闭环 |
| [ADR-0002](architecture/adr/0002-content-addressed-revisions.md) | Accepted | 内容寻址 Revision 与可变 Channel 分离 |

新增 ADR 应使用递增编号，并至少包含背景、决策、结果、被否决方案与替代/回退条件。

## 文档维护约定

- 面向当前运行行为的文档要标明“最近核对”日期，并在实现变化时同步更新。
- 目标设计必须明确标注为“目标形态”或“未启用”，避免把路线图写成现状。
- HTTP 示例优先引用机器可读 Schema；不要在多个文档复制完整请求对象。
- 新增文档后要从本页或其上级索引链接，避免形成不可发现的孤立文档。
- 合并前至少执行 `pnpm docs:check`、`pnpm contracts:check` 和与改动风险相称的测试。
