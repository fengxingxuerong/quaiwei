# Bailu-2.8 能力探测与评委对照（方向性探索）· 2026-11-25

## 状态：方向性证据，不进 SCORECARD / README / 对外口径

本目录记录用 `https://bailucode.com/openapi/v1`（2 key，仅内存使用、未落盘）
对 `bailu-2.8` 做的两轮探测。与 `evidence/llm-capability-2026-11-25/`（作废探索）
是**不同轮次**，不可混用、不可合并统计。

## 内容

| 文件 | 内容 | 口径 |
| --- | --- | --- |
| `writes.jsonl` / `summary.json` | 28 样本 × 多条件改写运行，含 `concise` 28 次 + `full` 6 次 bailu-2.8 | 自动硬标记多（13/28、5/6）；`avgLocalDelta` -3.54 / -11.83。本地代理分只做同篇前后参考 |
| `analysis.json` | 早期 sensenova 15 条件探测：13 次 429，有效输出仅 2 条 | 作废性质，仅留失败记录 |
| `judges.jsonl` / `judge-summary-bailu-2.8.json` | bailu-2.8 作评委对 30 组原稿/改写打分：fidelity 8.52 / language 9.21 / format 8.99 / deai 7.64 / natural 8.36；改写被选 23、原文 7 | **同源评委**，不可当独立第三方结论 |
| `local-baseline.json` | 28 样本原文与本地引擎基线 | 供复现 |

## 不可推出的结论

- 同源评委（bailu 写、bailu 评）倾向改写不能证明「更像人」，只说明该模型偏好改写。
- `avgLocalDelta` 是本地 aiScore 代理分，不是官方检测器真值，不可跨文比较。
- 单一网关、单一模型谱系、样本 28；无统计独立性保证。
- 网关 key 只在内存使用，本目录不含任何 key 或端点凭据。

## 复现入口

- 改写：`scripts/llm-capability-eval.ts`（`--fixtures` / `--out` / `--base-url` / `--replay-from` / `--repair-from` 参数化）。
- 评委：`scripts/llm-capability-judge.ts`（需自行提供 key，输出同目录）。
- 配对 A/B：`scripts/ab-pair-judge.mjs`（`STRICT=1` 默认，只认严格格式；非严格记无效票，不猜字）。
