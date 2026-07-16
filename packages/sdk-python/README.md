# `akep-sdk` for Python

轻量、无第三方运行时依赖的 Python 3.11+ AKEP 客户端，适合 Worker、评测作业和 Agent
服务。当前提供 discovery、query、ContextPack、Revision 读取、Usage 和 Feedback。

开发安装：

```bash
python -m pip install -e packages/sdk-python
```

```python
import os

from akep_sdk import AKEPClient

client = AKEPClient(
    "https://knowledge.example/akep/0.1",
    token=lambda: os.environ["AKEP_TOKEN"],
    supported_obligations=("cite", "no-train"),
)

results = client.query(
    "退款超过 30 天如何处理？",
    "customer-support",
    mode="lexical",
)
context = client.create_context_pack(
    "为客服生成带引用的退款处理步骤",
    "customer-support",
    budget_characters=12_000,
)
```

当前 Core 只启用 `lexical` 和 `exact`。HTTP Problem Details 会转换为 `AKEPError`，其中
保留 `status`、`code` 和 `trace_id`。Usage/Feedback 输入必须引用服务端签发且仍有效的
Exposure/Usage Receipt，不能由客户端自造 Citation。
`get_revision()` 会返回 `revision`、`exposureReceiptId` 和完整 `exposureReceipt`，因此调用方
可以直接使用其中的 Citation 继续构造 Usage，而不需要猜测 whole-resource locator。

验证：

```bash
PYTHONPATH=packages/sdk-python python -m unittest discover -s packages/sdk-python/tests
```

该包已有构建元数据，但当前仓库没有执行公共 PyPI 发布流程。
