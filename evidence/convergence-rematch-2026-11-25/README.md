# convergence 换评委方向性复验（无结论）· 2026-11-25

> 承接待办 3。11-08 的 90 票双席判定 convergence 收敛稿为能力退化（0.222）。
> 本次用新网关（bailucode）重跑，看结论是否翻转。
> **结论：无法裁决，不改默认、不进 SCORECARD。** 26 有效票里仅 5 票输出格式达标。

## 一、设置

| 项 | 值 |
|---|---|
| 两臂生成 | `scripts/build-convergence-arms.ts`，15 篇真人长文（artifacts/human-corpus） |
| A 臂 | `humanize(intensity 0.6, seed 20260905)` 默认碎句版 |
| B 臂 | 同参数 + `convergence: true` 收敛版（只还原引擎新增句号） |
| 两臂差异 | 15/15 篇逐字节不同（有区分度，优于碎句约束实验的 17/23 SAME） |
| 裁决 | `scripts/ab-pair-judge.mjs`（复刻 `flip_for` / `parse_pair`） |
| 评委 | A `bailu-2.8` / B `yuyu-air`，**同网关异模型，非异源** |
| 丢弃 | 2 篇超长文触发 400 `content exceeds maximum length`，26/30 票 |

## 二、原始读数（不可采信）

| 席位 | B 臂（收敛版）被选「更像 AI」 | 说明 |
|---|---:|---|
| A `bailu-2.8` | 4/13 | 13 票中仅 4 票纯「甲/乙」 |
| B `yuyu-air` | 4/13 | **13 票全部英文推理抠字** |
| 双席一致 | 7/15 | — |

若采信，方向（9/13 收敛版更像人）与 11-08 的 0.222 相反。**但不采信**：
26 票中只有 **5 票**是干净的「甲」或「乙」（`CLEAN`），其余 21 票都是模型先输出一段中/英推理，
再由 `parse_pair` 取最后一个「甲/乙」字。系统提示要求「只输出一个字」，模型没遵守，
抠出来的字是噪声，不是判断。两次独立尝试（低分稿、convergence）撞同一堵墙 ⇒ 是**网关模型协议问题**。

## 三、判定

按项目纪律（能力验收必须双席 + 有效票，历史两次「指标达标但双席判退化」）：
**无结论。convergence 继续默认关闭，不改产品、不进 SCORECARD。**
同网关异模型本来就只够方向性，叠加格式不达标，连方向性都不成立。

## 四、后续若要重启（按顺序）

1. **解决评委协议**：换能稳定输出单字/严格 JSON 的模型，或改裁决协议为
   `{"pick":"甲"|"乙"}` 强约束 + `parse_pair` 只认严格格式，非严格格式记无效票（绝不猜字）。
2. **解决超长文 400**：裁决前按字节截断或分段，当前 15 篇里丢 2 篇。
3. **补异源评委**：不同厂商网关，否则永远只是方向性。
4. 扩样本到 30+ 篇并保持 15/15 两臂有区分度。

## 五、门禁与产物

未改产品判据 / 引擎 / 归档评测脚本。全部在 gitignore 的 `eval-work/` 与 `scripts/_*.ts`，
不影响 `check:release`。本地中文临时脚本见 `scripts/build-convergence-arms.ts`、`scripts/ab-pair-judge.mjs`。

## 六、复现

```bash
npx tsx scripts/build-convergence-arms.ts
mkdir -p eval-work/ab-convergence/corpus
cp eval-work/ab-convergence/arms-free/*.humanized.txt eval-work/ab-convergence/corpus/
for f in eval-work/ab-convergence/corpus/*.humanized.txt; do mv "$f" "${f%.humanized.txt}.txt"; done
BASE=eval-work/ab-convergence ARM_A=arms-free ARM_B=arms-converged \
MODEL_A=bailu-2.8 MODEL_B=yuyu-air KEY_A=<key1> KEY_B=<key2> NODE_USE_ENV_PROXY=1 \
node scripts/ab-pair-judge.mjs
# 结果：eval-work/ab-convergence/out-node/results.jsonl；核对 clean 字段（是否纯「甲/乙」）
```
