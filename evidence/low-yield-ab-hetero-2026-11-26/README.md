# 低分稿「跳过 vs 少改」异源双席 A/B · 2026-11-26

## 一句话结论

异源双席（DeepSeek v4.1-flash + Bailu-2.8）10/10 干净票，低强度改写（0.3）被判「更像 AI」**恰好 5/10 = 50%，p=1.00** ⇒ **无可识别差异**。
样本仅 5 对可判篇目，统计力不足；**维持现状（低分稿默认跳过），不上线「少改」**。

## 背景

v0.9.90 起 `lowYieldRisk` 命中稿默认**原样跳过**（`formalPer1k<=8`）。
候选策略是「少改」：不跳过，用强度 0.3 小幅改写，博取改善同时压低反噬。
本实验检验「少改」是否在双席盲评下优于原文。

## 方法

| 项 | 取值 |
| --- | --- |
| 语料 | `scripts/realcase` 中命中 `isLowYieldRisk` 的 10 篇 |
| 可判篇目 | **5 篇**（另 5 篇两臂输出完全相同，无差异可判） |
| A 臂 | 原文（= 当前默认跳过行为） |
| B 臂 | `humanize(text, {intensity: 0.3, seed: 42})` |
| 席位 A | `discovery-api.intern-ai.org.cn/v1` · `deepseek-v4.1-flash-1017` |
| 席位 B | `bailucode.com/openapi/v1` · `bailu-2.8` |
| 问法 | 「哪一段更像 AI 生成」强制二选一 |
| 协议 | `STRICT=1` 只认纯「甲/乙」或严格 JSON；非严格记无效票 |

## 结果

| 指标 | 数值 |
| --- | --- |
| 总票 | 10（5 篇 × 2 席） |
| 干净票 | **10 / 10（100%）** |
| 席位 A：少改被判更像 AI | 2 / 5 |
| 席位 B：少改被判更像 AI | 3 / 5 |
| 合计 | **5 / 10 = 50%，p=1.00** |
| 两席一致率 | 2 / 5（40%） |

两席方向相反（A 席倾向说少改更好，B 席倾向说更差），合计精确对半。

## 口径限制（关键）

- **样本只有 5 对**，任何方向的 p 值都不可能小于 0.06（5 对全一致时 p=0.0625）⇒ 本轮**设计上就不足以判定优劣**。
- 10 篇命中低分稿信号中 5 篇两臂输出完全相同（改写无实质变化），说明「少改」作用面本身就窄。
- 单 seed（42）、单强度（0.3）。
- 问的是「更像 AI」代理题，不是真人判别真值。

## 结论与建议

1. **维持默认跳过**：无证据支持「少改」优于跳过。
2. 若要继续这条线，前置是**扩充可判样本到 ≥30 对**（需要能找到两臂确实不同且命中低分稿信号的稿件），并做多种子。
3. 本轮不写入 SCORECARD、不改 `skipLowRisk` 默认值。

## 复现

```bash
npx tsx scripts/build-low-yield-arms.ts
BASE=eval-work/ab-low-yield ARM_A=arms-skip ARM_B=arms-soft \
URL_A=<deepseek 端点> MODEL_A=deepseek-v4.1-flash-1017 KEY_A=<key> \
URL_B=<bailu 端点> MODEL_B=bailu-2.8 KEY_B=<key> \
MAX_TOKENS=512 TEMPERATURE=0.6 NODE_USE_ENV_PROXY=1 node scripts/ab-pair-judge.mjs
```

注意：`out-node/results.jsonl` 会按 key 累积、自动跳过已判条目。
若更换评委组合，必须先把旧结果改名移开（本轮已将 2026-11-25 同源 bailu 旧票改名为 `results.old-20261125-same-source.jsonl`）。
