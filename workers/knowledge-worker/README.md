# Knowledge Worker

该进程是无状态、无数据库凭证的 Python 隔离 Worker。它负责校验 AKEP Manifest、计算
RFC 8785/JCS Revision ID，以及对已隔离的 UTF-8 Payload 做规范化、静态风险扫描和确定性
分块；它不拥有发布、索引或策略决策权限，结果中的 `externalMalwareScanRequired=true`
也不能替代外部恶意文件扫描。

输入与输出均为一行一个 JSON 对象（JSONL），分别遵循
`contracts/internal/worker-task.schema.json` 与
`contracts/internal/worker-result.schema.json`。

Chunk 与 scan finding 的 offset 统一为 UTF-8 字节，`basisDigest` 指向规范化内容摘要；只有
先持久化并验证该规范化表示后才能把 locator 暴露为 Citation，不能把它误用到原始 HTML/JSON
Payload 上。

```bash
uv run --project workers/knowledge-worker python -m akep_worker < task.jsonl
```
