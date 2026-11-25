# 思考型模型挂起修复实证（2026-11-26）

同一篇语料：`eval-work/ab-convergence-all/corpus/人物-现代作家-老舍.txt`（2178 字）。
网关 `https://discovery-api.intern-ai.org.cn/v1`，模型 `deepseek-v4.1-flash-1017`，`--api --no-deep --intensity 0.7 --force-low-risk --llm-timeout 120`。

| 配置 | 耗时 | 结果 |
|---|---|---|
| 修复前（无跳过分支、无 --no-think） | 14 分钟+ 无产出（挂起） | — |
| 修复后（跳过翻倍档） | 152.3s | 成功 2110 字（分块 3 块 + 保真修复 1 次） |
| 修复后 + --no-think | 21.6s | 保真否决回原文（丢数字/URL） |

## 底层探针（单请求，600 字输入）

| 请求参数 | 耗时 | content | reasoning |
|---|---|---|---|
| max_tokens 512 | 4.1s | 0 字节 | 786 字 |
| max_tokens 4096 | 29.9s | 0 字节 | 4096 tokens |
| `reasoning_effort:"low"` | 34.4s | 0 字节 | — |
| **`thinking:{type:"disabled"}`** | **3.6s** | **513 字** | — |
| `chat_template_kwargs:{thinking:false}` | 3.7s | 516 字 | — |

## 口径

- `--no-think` 不是纯改进：加开关那次更快但保真否决，不加那次慢 7 倍但交付成功。
- 保真门禁在两条路径上都保持生效，没有为了速度放行事实损坏。

## 复现

```bash
# 不加开关（跳过分倍档生效，152s 量级）
node dist-cli/humanize-cli.mjs <in> --out <out> --api --no-deep \
  --base-url https://discovery-api.intern-ai.org.cn/v1 --model deepseek-v4.1-flash-1017 \
  --api-key $KEY --intensity 0.7 --force-low-risk --llm-timeout 120
# 加开关（21s 量级）
node dist-cli/humanize-cli.mjs <in> --out <out> --api --no-deep --no-think \
  --base-url https://discovery-api.intern-ai.org.cn/v1 --model deepseek-v4.1-flash-1017 \
  --api-key $KEY --intensity 0.7 --force-low-risk --llm-timeout 120
```
