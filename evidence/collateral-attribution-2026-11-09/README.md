# P1-1 阈值归因（2026-11-09，19:40）

**一句话**：`--skip-low-risk` 的 v0.9.84 判据不是「阈值没调好」，而是**拿未归一的原始次数当长度函数用**；
换成书面标记密度后，44 篇基准台上「不该动」面板的模拟残余误伤率 57%→14%，且少误跳 3 篇该改稿。
开关仍默认关，结论属探索性。

## 复现

```bash
npx tsx scripts/collateral-bench.ts          # → evidence/collateral-bench-2026-11-09/report.json
npx tsx scripts/collateral-attribution.ts    # → evidence/collateral-attribution-2026-11-09/report.json
```

归因脚本只读标签清单、语料与基准台报告，不调用 `humanize()`、不改一个字、不进门禁。
语料 `artifacts/human-corpus/*.txt` 被 .gitignore 忽略，只在本机存在。

## 归因结果

| 事实 | 数值 |
|---|---|
| 字数 ~ `formalHits` 相关 | **0.958**（真人长文内部 0.939） |
| 字数 ~ `aiScore` 相关 | 0.785 |
| 两面板长度区间 | 真人 2160~27267 字 / AI 稿 53~453 字，**完全不重叠** |
| 旧判据 `aiScore≤27 && formalHits≤2` | no-touch **0/21** 命中、should-change **13/23** 误跳 |
| 现行判据 `formalPer1k≤8/千字` | no-touch **15/21** 命中、should-change **10/23** 误跳 |
| 开启开关后模拟残余误伤率 | **57% → 14%** |
| 开启开关后该改面板达改率 | 17% → **17%**（丢失达改稿 0） |

旧阈值是在 23 篇短稿上标定的，`formalHits≤2` 对长文构造性不可能满足 ⇒ 在真人稿上 0 命中，
却把 13 篇「该改」短稿判成低收益，方向完全反了。

**标签泄漏警告**：两面板长度不重叠，任何含长度项的候选（`chars>=500/1000/2000`）
在这份语料上都能得到 21/21 命中 + 0 误跳的「完美分离」，那是标签与长度共线，不是判别力。
同理 `registerIndex>=60`、`periodPerKChar<=30` 的「残余误伤 0」其实是几乎全命中（误跳 16~18 篇），
不能当改进。归因脚本把这些候选单列 `usesLength: YES` 并给出命中/误跳/丢失达改稿三列。

## 独立交叉核对（双网关 0.9 档配对）

`evidence/eval-dual-2026-11-06/eval_dual_results.jsonl` 的 `kind=pair, armTag=local09`：

| 判据 | 命中 | 两席全胜 | 至少一席判改写更像人 | 零胜 |
|---|---:|---:|---:|---:|
| 旧 | 13 | 9 | **13** | 0 |
| 新 | 10 | 6 | **10** | 0 |

⇒ 两种判据命中的短稿，改写都至少被一席判为更像人。**开启 `--skip-low-risk` 是主动放弃这部分改善**，
所以开关继续默认关；新判据少跳 3 篇是净减少损失，不是「判得更准」。
（绝对分不可复现，只取配对强制选择作相对口径。）

## 落地改动

- 新增 `src/engine/low-yield.ts`：`formalPer1k≤8/千字`，长度归一、不看 `aiScore`；保留旧判据函数供对照。
- `scripts/humanize-cli.ts`：stdin / 批量两处判据统一调用该入口；help、注释、警告文案同步；
  `adviceFor` / `humanize()` / Web / MCP / API **行为不变**，默认出稿逐字不变。
- `scripts/collateral-bench.ts`：新增 `skipPolicy` 模拟面板与 `lowRiskShareNormalized`。
- `SKILL.md` / `SCORECARD.md`：同步判据与「2026-11-09 修订」注记（历史 23 篇阈值表保留不改）。
- 新增 `src/engine/low-yield.test.ts`：锁住长度放大不翻转、C23 不被跳过、阈值自洽。

## 验证

| 项 | 结果 |
|---|---|
| `npx tsx scripts/collateral-bench.ts` | 57% → 14%（模拟），旧判据 0% / 新判据 71% |
| 目标单测 4 文件 | **87/87 通过** |
| `npx tsc --noEmit` | 0 错误 |
| ESLint（5 个改动文件） | 0 问题 |
| 端到端：14279 字真人维基长文 + `--skip-low-risk` | 输出与输入**逐字相同**，`lowYieldRisk=true`、`skippedLowRisk=true` |

⚠️ 跑验证时本机 `node_modules` 里 `esbuild.exe` / `tsc.exe` / `lib.dom.d.ts` 被静默删除，
已从 npm 离线缓存（`@esbuild/win32-x64@0.28.2`、`@typescript/typescript-win32-x64@7.0.2`）恢复；
若后续 `npx tsx` / `npx tsc` 再报「Executable not found」或满屏 DOM 类型错，先查这三个文件。

## 剩余项（本轮未做）

1. **交叉长度语料**：补「长 AI 稿 + 短真人稿」，否则 `formalPer1k≤8` 的泛化能力无法判定；
   `scripts/collateral-labels.json` 的 target 是 30/40，当前 21/23。
2. **碎句化 / 超改归因**：12/21 `collapseIssues`、1 篇 66% 超改未修。改切句守卫会重蹈
   90 票判退化的结构收敛方向（`evidence/structure-convergence-2026-11-08/`），需单独立项。
3. **发版时补 CHANGELOG**：本轮未 bump 版本、未写 CHANGELOG、未提交，留待发版流程统一处理。
