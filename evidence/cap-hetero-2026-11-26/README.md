# 能力数字的异源双席复核：改写是否真的更像人（2026-11-26）

## 一句话

用**两个不同模型家族**的评委（DeepSeek v4.1-flash + Bailu 2.8）重跑 23 篇 AI 稿的 0.9 档改写，
**31/42 = 73.8%** 判改写稿更像人（p=2.9e-3）⇒ 方向成立，但比 GLM 同谱系双席的 87.0% 低一截。
按产品**默认行为**（低收益稿跳过不改写）切子集后是 **22/26 = 84.6%**，与 11-06/11-07 两个历史读数同量级；
而**两席都判「改写反而更像 AI」的 3 篇全部落在 `skipLowRisk` 命中名单里**——这是 v0.9.90 那个行为变更的第一次异源实证。

## 为什么做

`SCORECARD.md` 第 4 节的旗舰数字 87.0%（40/46）两席都是 `glm-5.3-flash`（不同网关、同模型），
独立性有限；11-07 的跨谱系复核（`qodercn/dfmodel`）是**单席**。DeepSeek 通道恢复后
（见 `evidence/ai-rewrite-dual-seat-2026-11-26/`），才有条件用**两个不同家族**的双席重跑同一批题。

## 设计

| 项 | 设置 |
|---|---|
| 语料 | `scripts/realcase/cases.json` 全 23 篇（与 11-06 完全同一批） |
| 臂 A | 原文 |
| 臂 B | `node dist-cli/humanize-cli.mjs`（v0.9.92 实产）`--intensity 0.9 --seed 20260905 --force-low-risk` |
| 双席 | A 席 `deepseek-v4.1-flash-1017`（discovery-api）、B 席 `bailu-2.8`（bailucode）**不同家族** |
| 问题 / 协议 | 「哪段更像 AI」甲/乙强制选择，位置翻转、STRICT 纯 JSON、`max_tokens 512` / `temp 0.6` |
| 可判对数 | 23 篇里 C5、C18 改写后与原文逐字节相同 ⇒ 剔除，**21 对 × 2 席 = 42 票，42 票全部干净**（0 网络错、0 格式失败） |

`--force-low-risk` 是刻意的：要复现 11-06 那轮「23 篇全改」的口径；产品今天默认会跳过其中 10 篇，
那份差异在下面「按默认行为切子集」单独报。

## 结果

| 口径 | 改写被更多人判 | 比例 | p（精确二项） |
|---|---|---|---|
| 全量强制改写（21 对 / 42 票） | 31/42 | **73.8%** | 2.9e-3 |
| A 席 DeepSeek | 17/21 | 81.0% | — |
| B 席 Bailu | 14/21 | 66.7% | — |
| 两席异质性 | — | Fisher p=0.48（不显著） | — |
| 两席都说改写更像人 | 13/21 对 | 61.9% | — |
| 两席都说改写更像 AI | 3/21 对 | C7 / C8 / C13 | — |

对照历史读数：11-06 GLM 双席 **87.0%**（40/46）、11-07 dfmodel 单席 **82.6%**（19/23）。
本轮 73.8% 低于两者，但**两席方向一致、无显著异质性**，p 仍远低于 0.05 ⇒ 「方向有效」在第三个模型家族上再次成立，
只是幅度别按 87% 说。

### 按产品默认行为切子集（关键）

`skipLowRisk`（v0.9.90 起默认开）命中本轮可判集里的 8 篇：
C4 / C7 / C8 / C13 / C15 / C17 / C19 / C20。

| 子集 | 对 / 票 | 改写更像人 | 比例 |
|---|---|---|---|
| 默认**会**改写（13 对） | 26 票 | 22 | **84.6%** |
| 默认**会跳过**（8 对） | 16 票 | 9 | **56.3%**（≈ 抛硬币） |

- 两席都判「改写更像 AI」的 3 篇是 C7-story-dialogue、C8-social-post、C13-manual-steps，**全部在跳过名单里**。
  C8 正是 v0.9.90 记录的反噬样篇（本地 aiScore 3→13）；本轮异源双席独立复现了同一现象。
- ⇒ 默认跳过不是拍脑袋：跳过名单上的改写收益接近零（56.3%），而真正该改的稿子是 84.6%。

## 局限

1. **事后切子集**：84.6% / 56.3% 是对已收集票按 `lowYieldRisk` 标签的事后分层，不是随机分组实验；
   样本 26 / 16 票，置信区间很宽，只能作方向。
2. 21 对里有 2 篇（C5/C18）因逐字节相同被剔除，与 11-06 的 23 对不完全同集。
3. 引擎产物用 v0.9.92 CLI，**种子 20260905**；11-06 那轮是 v0.9.83 且未记录种子 ⇒ 两轮不是同一批改写稿，
   是「同一批语料 + 同一协议」的独立复现，不是逐字复算。
4. Bailu 席偏弱（本轮 66.7%，且在同日碎句实验里表现为系统性偏好长句版）。
5. 语料仍是模拟 AI 稿、无真人基线；量的是相对改善，不是过检率。

## 复现

```bash
# 1) 实产 0.9 档改写稿（v0.9.92 CLI）
node -e "const fs=require('fs');const c=require('./scripts/realcase/cases.json').cases;fs.mkdirSync('eval-work/cap/in',{recursive:true});for(const x of c)fs.writeFileSync('eval-work/cap/in/'+x.id+'.txt',x.text)"
node dist-cli/humanize-cli.mjs eval-work/cap/in --out eval-work/cap/09 \
  --intensity 0.9 --suffix .humanized --seed 20260905 --force-low-risk --report eval-work/cap/report09.json

# 2) 两臂：arms-orig = 原文，arms-local09 = 改写稿（文件名 <id>.humanized.txt）

# 3) 异源双席配对裁决
BASE=eval-work/cap ARM_A=arms-orig ARM_B=arms-local09 \
URL_A=https://discovery-api.intern-ai.org.cn/v1/chat/completions MODEL_A=deepseek-v4.1-flash-1017 KEY_A=... \
URL_B=https://bailucode.com/openapi/v1/chat/completions MODEL_B=bailu-2.8 KEY_B=... \
MAX_TOKENS=512 TEMPERATURE=0.6 STRICT=1 node scripts/ab-pair-judge.mjs

# 4) 统计
BASE=eval-work/cap node evidence/cap-hetero-2026-11-26/analyze.mjs
```

文件：`results.jsonl`（42 票原始记录）· `report09.json`（CLI 产出报告，含 `lowYieldRisk` 标记）·
`arms-orig/` `arms-local09/`（两臂原文）· `analyze.txt`（统计输出）· `analyze.mjs`（脚本）。
