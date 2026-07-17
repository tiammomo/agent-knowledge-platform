# Security Policy

## 支持范围

当前仅维护 `main` 分支的最新版本。仓库仍处于受控试点阶段，不应把本地开发令牌、Compose
口令或浏览器开发身份映射用于生产环境。

## 报告安全问题

请通过 GitHub 仓库的 **Security → Report a vulnerability** 私下报告。不要在公开 Issue、
Discussion、日志或示例数据中披露漏洞细节、凭据、个人信息或真实知识内容。

报告尽量包含：

- 受影响的版本、提交或端点；
- 复现条件与最小化复现步骤；
- 对 Tenant、Space、身份、知识内容或供应链的潜在影响；
- 已知缓解方式；
- 报告者希望使用的署名方式。

维护者会尽快确认收到报告，在完成影响评估前限制细节传播，并通过私有修复分支协调修复、
回归验证和披露时间。若 GitHub 私有漏洞报告暂不可用，请联系仓库所有者建立私密沟通渠道，
不要退回到公开 Issue。

## 生产安全基线

- 禁止 development auth，使用短期、audience-bound 的 OIDC/OAuth token，并要求签名 Tenant
  claim 与部署 Tenant 一致；
- 不同强安全边界使用独立 Tenant/部署，所有请求继续执行 Space 与 purpose 检查；
- 数据库、对象存储、队列与遥测端点使用 TLS 和独立最小权限身份；
- 发布镜像必须通过依赖、Secret 与 High/Critical 镜像漏洞门禁；
- 定期执行备份恢复、撤销、擦除、密钥轮换和跨 Space 越权演练。
