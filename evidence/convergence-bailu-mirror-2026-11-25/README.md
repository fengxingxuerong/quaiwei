# bailu-2.8 单模型 mirror 复验 · 2026-11-25

> 承接 `evidence/convergence-rematch-2026-11-25/`：上次两席（bailu-2.8 + yuyu-air）
> 26 票仅 5 票输出格式达标。本次按用户要求只用 **bailu-2.8**，两席同模型、B 席反序（mirror），
> 并把裁决改成**严格格式**（只认纯「甲/乙」或 `{"pick":"甲"}`，非严格记无效票，绝不猜字）。
> **结论：方向性倾向收敛版更像人，但两席同篇仅 4 篇，统计力不足。候选仍不上线。**

## 一、配置

| 项 | 值 |
|---|---|
| 语料/两臂 | 同 `convergence-rematch`：15 篇真人长文，`humanize(0.6, seed 20260905)` A=默认 / B=`convergence:true`，15/15 有差异 |
| 模型 | bailu-2.8 两席（**同源 mirror**，非异源；B 席由 `flip_for` 反序抵消位置偏置） |
| 严格模式 | `STRICT=1`：system+user 都要求 `{"pick":"甲"|"乙"}`，`response_format: json_object`，`max_tokens 16`；`parseStrict` 只认纯「甲/乙」或严格 JSON |
| 无效票 | 非严格格式、HTTP 400 超长（2 篇：明朝/北京市）→ `bWin=null`，不计入 |
| 裁决脚本 | `scripts/ab-pair-judge.mjs`（`flip_for` 逐字复刻归档脚本） |

## 二、结果

| 指标 | 值 |
|---|---|
| 总票 | 30（15 篇 × 2 席） |
| **输出格式达标** | **16/30**（上次 5/26；严格 JSON 提示把干净率从 19% 提到 53%） |
| A 席 B 臂被选「更像 AI」 | 1/9 |
| B 席 B 臂被选「更像 AI」 | 2/7 |
| 两席都有干净票的篇目 | **4 篇**，其中一致 **3 篇** |
| 合计 B 臂（收敛版）被选更像 AI | **3/16** |

B 臂=收敛版。被选「更像 AI」越少 ⇒ 收敛版更像人。16 票里只有 3 票判收敛版更像 AI，
方向与 11-08 的 0.222（收敛稿只赢 20/90）**相反**。

## 三、判定：仍不上线

1. **统计力不足**：两席同篇且都干净的只有 4 篇（一致 3），远低于「30+ 独立配对票」的项目口径。
   16 票里 A 席 9、B 席 7 是**不同篇目**的票，不能合并当 16 个独立证据。
2. **同源 mirror**：两席同模型，不是异源评委，只能方向性，不能升级成能力口径。
3. **超长文 400 丢 2 篇**：15 篇里明朝/北京市触发 `content exceeds maximum length`。
4. 项目纪律：判据/切句守卫改动必须双席 A/B + 有效票，历史两次「指标达标但双席判退化」。
   本次方向虽正面，但不足以推翻 11-08 的 90 票退化结论。

**convergence 继续默认关闭，不进 SCORECARD，不改产品。**

## 四、收获（可复用）

- **严格 JSON 提示 + `response_format: json_object` 有效**：干净率 19%→53%（bailu-2.8）。
  这是本次唯一确定的工程改进；`ab-pair-judge.mjs` 的 `STRICT=1` 已固化，默认开。
- 非严格输出记无效票（不猜字）后，票变少但**可信**，比上次「抠字凑票」强。
- 超长文需在送入评委前按字节截断或分段，否则静默丢篇。

## 五、重启前置

1. **异源评委**（不同厂商），否则永远方向性；
2. 样本扩到 30+ 篇且**两席同篇干净**≥20；
3. 超长文截断后再送；
4. 若要保持 STRICT，确认评委支持 `response_format: json_object`（bailu-2.8 支持）。

## 六、复现

```bash
BASE=eval-work/ab-convergence ARM_A=arms-free ARM_B=arms-converged \
MODEL_A=bailu-2.8 MODEL_B=bailu-2.8 \
KEY_A=<key1> KEY_B=<key1> STRICT=1 NODE_USE_ENV_PROXY=1 \
node scripts/ab-pair-judge.mjs
# 结果：eval-work/ab-convergence/out-node/results.jsonl（clean 字段为有效性唯一判据）
```

门禁：未改产品判据/引擎/归档脚本，lint 0；产物在 gitignore 的 `eval-work/`，不影响 `check:release`。
