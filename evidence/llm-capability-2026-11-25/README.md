# LLM 能力边界探测（作废探索）· 2026-11-24

## 状态：作废，不可引用为能力结论

本轮 28 样本、11 个 key，实际拿到的有效输出只有 2 条：
`glm-5.3` 1/1 成功、`sensenova-6.8-flash` 1/10 成功（9 次 API 失败）。
网关 / key 池失败率约 90%，`avgLocalDelta` 全为 0，无法评估任何「改写能力」。

保留本目录只为**失败记录与复现入口**。不进入 SCORECARD、README 或任何对外口径；
后续引用须以有效样本量足够、网关稳定的新轮次重跑结果为准。

## 方法

| 项 | 值 |
|---|---|
| 脚本 | `scripts/llm-capability-eval.ts` |
| 样本 | 28（22 zh / 6 en；ai 15 / human 4 / edge 6 / structure 1 / semantic 2） |
| 清单 | `scripts/fixtures/llm-capability/manifest.json`（来源、许可、选择规则、caveats） |
| 默认模型 / 提示词 | `glm-5.3` / `concise`，强度 0.9，风格 plain |
| Key 数 | 11 |
| 生成时间 | 2026-11-24T20:48:31Z |

## 结果

| 模型 | runs | API 成功 | API 失败 | 硬失败 |
|---|---:|---:|---:|---:|
| glm-5.3 | 1 | 1 | 0 | 0 |
| sensenova-6.8-flash | 10 | 1 | 9 | 1（100%，分母为唯一成功行） |

按语言 / 体裁：zh 11 runs（2 成功 / 9 失败）、ai 11 runs（2 成功 / 9 失败）。
唯一硬失败：`zh-ai/email/short` 的 `collapse`——「经仓库验收」是原文「经仓库验收发现」
被截断后的残留，谓语已丢失。这是一条截断 bug 线索，样本量 1 不足以定位模型能力。

## 复现

```bash
# Key 走 SENSENOVA_KEYS 或 scripts/.sensenova-keys（均不入库）
npx tsx scripts/llm-capability-eval.ts --model glm-5.3 --prompt-mode concise --intensity 0.9
```
