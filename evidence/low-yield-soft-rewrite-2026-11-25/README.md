# 低分稿「跳过 vs 少改」方向性裁决尝试（无结论）· 2026-11-25

> 承接待办 4。目标：验证 v0.9.90 默认「跳过低分稿」是否应改成「低强度改写（少改）」。
> **结论：无法裁决，候选不上线、不进 SCORECARD。** 评委输出格式不达标，10 票均为噪声。

## 一、做了什么

| 项 | 值 |
|---|---|
| 两臂生成 | `scripts/build-low-yield-arms.ts --intensity 0.3` |
| A 臂 | 原文（当前默认跳过行为） |
| B 臂 | `humanize(text, { intensity: 0.3, seed: 42 })` 低强度改写 |
| 语料 | realcase 23 篇中 `isLowYieldRisk` 命中 10 篇；剔除 5 篇两臂逐字节相同者，剩 **5 篇**（C4/C8/C13/C17/C20） |
| 裁决脚本 | `scripts/ab-pair-judge.mjs`（复刻 `ab_accept.py` 的 `flip_for` / `parse_pair`，因 Python urllib 被网关 403/1010 拦） |
| 评委 | A 席 `bailu-2.8`、B 席 `yuyu-air`，同属 bailucode 网关，**非异源** |

## 二、结果：无效

| 席位 | B 臂（少改）被选「更像 AI」 | 说明 |
|---|---:|---|
| A `bailu-2.8` | 2/5 | 5 票中仅 2 票纯「甲」/「乙」，其余 3 票英文推理中夹字 |
| B `yuyu-air` | 5/5 | **5 票全部英文推理**，从推理文本里瞎找「甲/乙」 |
| 双席一致 | 2/5 | 远低于有效裁决门槛 |

**判定：❌ 无结论，不是「少改更差」也不是「少改更好」。**
原因：系统提示明确要求「只输出一个字：甲或乙」，但两席（尤其 B 席 5/5）都以英文长推理回应，
`parse_pair` 只能从推理文本中取最后一个「甲/乙」字——那是噪声，不是模型判断。
此前的 `results.badflip.jsonl` 还用了自造的 flip 哈希，已作废，勿引用。

## 三、为什么不硬下结论

项目硬约束：判据改动必须**双席 A/B + 有效票**，且历史两次「指标达标但双席判退化」。
当前票不可信，强行解读等于给噪声编故事。同网关异模型本来就只够方向性，加上格式不达标，
连方向性都不成立。

## 四、后续若要重启

1. 换**遵守输出格式**的评委（实测 `bailu-2.8`/`yuyu-air` 均不合格；`bailu-2.7-free` 仅测过「收到」，
   需复测其配对输出格式）。
2. 或改裁决协议：用给出 JSON `{"pick":"甲"|"乙"}` 的强约束提示，并在 `parse_pair` 里只认严格格式，
   非严格格式记无效票而非猜字。
3. 补**异源**网关（不同厂商），否则永远只是方向性。
4. 语料扩到 20+ 篇有区分度稿；当前 5 篇统计力不足。

## 五、门禁

未改产品判据、未改引擎、未改归档评测脚本。全部产物在 gitignore 的 `eval-work/` 与 `scripts/_*.ts`，
不进产物、不影响 `check:release`。

## 六、复现

```bash
npx tsx scripts/build-low-yield-arms.ts --intensity 0.3
BASE=eval-work/ab-low-yield ARM_A=arms-skip ARM_B=arms-soft \
MODEL_A=bailu-2.8 MODEL_B=yuyu-air KEY_A=<key1> KEY_B=<key2> NODE_USE_ENV_PROXY=1 \
node scripts/ab-pair-judge.mjs
# 结果：eval-work/ab-low-yield/out-node/results.jsonl（核对 clean 字段）
```
