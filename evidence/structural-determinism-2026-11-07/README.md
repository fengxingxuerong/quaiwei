# `--structural` 确定性改造 · 生效率实测（2026-11-07）

## 改了什么

v0.9.82~0.9.84 的 `src/engine/structural-shuffle.ts` 用概率门控
`SWAP_PROB = 0.55`：`rng() > 0.55 × intensity` 就整段跳过。
30 种子实测 14/30 触发交换（0.7 档约 45% / 1.0 档约 78%，2026-11-03 记录）。
现象：开了开关却看不出变化，且没有任何字段能查「到底换没换」。

v0.9.85 工作区改为「开启即尝试」：

| 项 | 改前 | 改后 |
|---|---|---|
| 跳过理由 | 强度门槛 + 体裁 + 段级防线 + **随机概率** + 守卫 | 强度门槛 + 体裁 + 段级防线 + 守卫 |
| 低强度 | 概率性偶尔仍动 | `< 0.55` 恒不动（显式门，与 `humanize.ts` 同口径） |
| 达标且有可换对 | 概率性跳过 | **必然交换**（rng 只用于选候选对，同 seed 可复现） |
| 报告 | 无 | CLI `--report` 的 `structuralApplied`（逐篇 + totals 计数） |

默认关时行为完全不变：结构层那一行不执行，12 样本棘轮与 4080 次格式不变式不受影响。

## 实测：瓶颈不是概率，是守卫密度

```bash
npm run build:cli
node dist-cli/humanize-cli.mjs <23 篇语料目录> --out out --intensity 0.9 \
  --structural --report report.json
```

语料 `scripts/realcase/cases.json` 全量 23 篇，v0.9.85 工作区当前 CLI 实产：

| 指标 | 结果 |
|---|---|
| 成功处理 | 23/23 |
| `totals.structuralApplied` | **2 / 23** |
| 真换成功的篇目 | `C2-opinion-wechat`、`C20-speech-opening` |
| 其余 21 篇 | 守卫或段级防线否决，产出与不开启 `--structural` 逐字相同 |

逐篇（Y = 真换，N = 未换）：

```
C1:N  C2:Y  C3:N  C4:N  C5:N  C6:N  C7:N  C8:N  C9:N  C10:N  C11:N  C12:N
C13:N C14:N C15:N C16:N C17:N C18:N C19:N C20:Y C21:N C22:N C23:N
```

构造样本（四句论说段、无回指/序列/引语/数字）跑同一条命令 →
`reports[0].structuralApplied = true`，证明 true 路径接通，不是回调恒为假。

## 结论（比改动本身重要）

1. **取消概率门控解决的是「可预期 + 可自查」，不是「效果变强」**。
   真实语料上只有 2/23 受影响，能力提升有限。
2. **别为提高生效率放宽守卫**。回指 / 序列因果 / 引语 / 跨句数字 / 首句锚定
   每条都对应一次真实翻车模式（见 `docs/structural-shuffle.md` 第 3 节）；
   交换要求相邻两句同时可动且首句固定，中文论说段落里数字和序列词本就常见。
   放宽等于把「不新增事实」换成「可能改坏逻辑顺序」。
3. 这条实测也**更正了 2026-11-07 早先的判断**：当时把「概率门控」列为
   「零引擎风险、最高 ROI」的能力提升项，实测表明主要瓶颈在守卫密度。
   `structuralApplied` 字段仍值得保留——它把静默不生效变成可观测事实。

## 复现

```bash
# 造 23 篇语料（与 scripts/eval-dual/README.md 第 1 节同法）
node -e "const fs=require('fs');const c=require('./scripts/realcase/cases.json').cases;fs.mkdirSync('in',{recursive:true});for(const x of c)fs.writeFileSync('in/'+x.id+'.txt',x.text)"

npm run build:cli
node dist-cli/humanize-cli.mjs in --out out --intensity 0.9 \
  --structural --report report.json
node -e "const j=require('./report.json');console.log(j.totals.structuralApplied,'/',j.totals.files)"
```

守卫单测：`npm test -- src/engine/structural-shuffle.test.ts`（16 例，含
「低于门槛恒不动」「达标且守卫全过时每个种子都动」「门槛常量 0.55」）。
