# 外部 LLM 保真对照（开源许可样本）· 2026-11-24

## 结论先行

**方向性证据，不是模型能力定论。** 同一批 15 个许可明确样本上，`sensenova-6.8-flash-lite`
的 12 条有效输出里有 6 条硬保真失败（50%），本地引擎同批 15/15 全过。
另有 3 条最终正文为空（多档 token 预算遇 429），不能用来评价模型质量。

## 方法

| 项 | 值 |
|---|---|
| 脚本 | `scripts/open-source-llm-eval.ts` |
| 模型 / 网关 | `sensenova-6.8-flash-lite` @ `https://token.sensenova.cn/v1` |
| Key 数 | 3 |
| 样本 | 15（`scripts/fixtures/open-source-llm/`，MIT：unslop 10 / stop-slop 5；no-ai-slop 规则作检查维度） |
| 提示词 | `full`（`buildSystemPrompt`）/ `concise`（相同保真约束短提示）；均无深度闭环、无 LLM 评委 |
| 硬失败判据 | `scripts/open-source-humanizer-checks.ts` 的 `hardFidelityIssues` |
| 生成时间 | 2026-11-24T19:45:03Z |

## 结果

| 指标 | 外部 LLM | 本地引擎 |
|---|---:|---:|
| 样本 | 15 | 15 |
| API 成功 / 失败 | 12 / 3（空正文，429） | — |
| 硬失败行 | 6 / 12（50%） | **0 / 15** |
| 完全通过 | 6 / 12 | 15 / 15 |
| aiIsms 均值（in → out） | ai 8.2 → 0.6；human 7.5 → 0 | — |
| 平均改写比例 | 约 0.53 | — |

问题分布：`markdown-headings` 5、`language-drift:en-to-zh` 4、`missing-numbers` 2、
`lost-url` 1、`lost-quote` 1、`markdown-linkTargets` 1、`api-failure` 3。

## 口径与局限

1. 只说明**本轮配置**（模型 + 提示词 + 512 maxTokens + 该网关）下保真弱于本地引擎；
   换模型、预算或提示词须重跑，不可外推。
2. 3 条空正文是 429 预算问题，不计入模型质量。
3. `language-drift:en-to-zh` 与 `markdown-headings` 是提示词约束执行问题，
   不是「更像人 / 不像人」的证据。
4. `aiScore` 是项目自评分，仅作同篇相对方向，不代表官方检测器或过检率。

## 复现

```bash
# Key 走 SENSENOVA_KEYS 或 scripts/.sensenova-keys（均不入库）
npx tsx scripts/open-source-llm-eval.ts \
  --model sensenova-6.8-flash-lite \
  --base-url https://token.sensenova.cn/v1 \
  --max-tokens 512 --delay-ms 20000
```
