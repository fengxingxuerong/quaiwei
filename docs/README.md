# docs/ 索引

> 这里放的是**过程文档**（复盘 / 报告 / 证据 / 方案），不是使用手册。
> 使用手册在根目录：`README.md`（面向用户）、`CONTRIBUTING.md`（面向贡献者）。
>
> 读之前先看「类型」列——标记为**历史快照**的文档，结论多半已被后续版本覆盖，
> 只适合当"当时为什么这么决定"的现场材料，**不要照着它改代码**。
> 索引由 `scripts/docs-index.test.ts` 守着：docs/ 里加文件不登记，测试会红。

## 当前口径（可以照着做）

| 文件 | 类型 | 内容 |
|---|---|---|
| [key-rotation-status.md](key-rotation-status.md) | 当前口径 | Key 轮换与泄露面处置记录（2026-09-05 → 2026-10-14 多次复测）。涉及凭证时先看这份 |
| [mcp-server.md](mcp-server.md) | 当前口径 | MCP 服务端（v0.9.81）：三个工具的参数与返回、装法、边界、验法、已知没做的 |
| [竞品对比-2026-10-27.md](竞品对比-2026-10-27.md) | 当前口径 | 同赛道 33 项横比：实时星数、形态分布、能力面、撞名处置、该做与不做。抓数用 `node scripts/scan-github-sector.mjs --md`，脚本里的 `REPOS` 是竞品名单唯一出处 |
| [regional-zh.md](regional-zh.md) | 当前口径 | 地区用词校正（v0.9.81）：`--variant zh-TW` 的用法、三条边界、词表门槛、验法 |
| [academic-check.md](academic-check.md) | 当前口径 | 学术自检（v0.9.81）：`--academic-check` 与 `--against` 判什么/不判什么、退出码、180 组实测、真阻断样例 |
| [索引投稿.md](索引投稿.md) | 方案 | awesome-humanizer-skills 的投稿材料：他们的 issue 格式、可直接贴的正文、为什么这次没提交 |
| [桌面端冒烟-2026-10-23.md](桌面端冒烟-2026-10-23.md) | 当前口径 | 桌面端冒烟的两个环境坑与可执行判据（`npm run smoke:desktop`），发版流程第 4 步引用它 |
| [sensenova-models-2026-10-24.md](sensenova-models-2026-10-24.md) | 当前口径 | 商汤网关在售 7 个模型的可用性实测（4 可用 / 3 不可用及原因）；复核用 `npm run probe:models` |

## 证据与标定（引用型，改之前先想清楚）

| 文件 | 类型 | 内容 |
|---|---|---|
| [external-judge-findings.md](external-judge-findings.md) | 证据 | 外评证据：本地 aiScore 在论说/叙事上严重低报 AI 味（v0.9.54 起「分数冲突提示」的由来） |
| [fingerprint-and-zhuque-calibration.md](fingerprint-and-zhuque-calibration.md) | 证据 | AI 指纹检测与朱雀分映射标定（指纹面板与换算线据此实现） |
| [judge-anchor-calibration.md](judge-anchor-calibration.md) | 证据 | glm-5.2 严评锚点问题与评判模型的宽严校准 |
| [model-compare-2026-10-24.md](model-compare-2026-10-24.md) | 证据 | 5 个可用模型的改写效果对比（同一篇稿、真实 CLI 路径）：事实保真 / 套话残留 / 耗时 / 互补性，附各位置选型建议。复现用 `npm run compare:models` |
| [number-fidelity-2026-10-25.md](number-fidelity-2026-10-25.md) | 证据 | 数字保真这条线的判据演进（0.9.75→0.9.77）：真实丢数据的出处、为什么只查「数量型」、三次自我否定、各路径检查矩阵、已知局限（单位不校验） |
| [format-fidelity-2026-10-26.md](format-fidelity-2026-10-26.md) | 证据 | 格式保真从「形态正则」升级为**23 条结构不变式**：用户路径 `humanize()` 4080 次运行全绿、两个真缺陷（setext 下划线被拆、结构行续行被拆）的根因与修法、一次自我否定（12 样本棘轮拦回）、机械扰动入口无格式盾的已知边界。复现用 `npm run sweep:format` |
| [zhuque-gap-analysis.md](zhuque-gap-analysis.md) | 证据 | 趣AI味 vs 真实朱雀的差距分析与补全清单 |
| [十篇小说测试报告-2026-10-28.md](十篇小说测试报告-2026-10-28.md) | 实测报告 | 10 篇 × 1 万字 AI 小说规模测试（v0.9.81）：本地两档 / LLM 深度 / MCP / 审题 / 学术出口读数，含网关 429 限流导致的分块回退、本地引擎碎句化与两处坏替身。复现命令在文末 |
| [zhuque-official-resubmit-plan.md](zhuque-official-resubmit-plan.md) | 计划（部分搁置） | 朱雀官方送检分批计划；2026-10-23 起「不再以朱雀为验证主线」，仅作记录 |

## 历史快照（结论已被后续版本覆盖，别照做）

| 文件 | 类型 | 内容 | 为什么过期 |
|---|---|---|---|
| [2026-08-26-postmortem-genre-linkage-engine-defects.md](2026-08-26-postmortem-genre-linkage-engine-defects.md) | 复盘 | P7 体裁联动改造中两个隐藏缺陷的发现与修复 | 当时的分支与判定函数已重构 |
| [2026-09-30-sentence-defects-report.md](2026-09-30-sentence-defects-report.md) | 缺陷报告 | 本地引擎三类病句（动补/动宾不兼容替换、介词降级、主谓被切断） | 三类已在 v0.9.5x 修复并有 `scan-bugs` 探针复测 |
| [deep-mode-evidence-audit.md](deep-mode-evidence-audit.md) | 复核 | 深度模式能力·证据现状复核（2026-09-20） | 深度闭环此后重写了多轮（0.9.5x） |
| [realcase-findings-2026-10-15.md](realcase-findings-2026-10-15.md) | 实测报告 | 23 篇真实案例 · intensity 0.9 | 已是 `npm run test:realcase` 的日常门禁，本文件是单次切片 |
| [优化测试报告-2026-10-14.md](优化测试报告-2026-10-14.md) | 实测报告 | 全方面优化测试（v0.9.40 口径） | 版本已推进到 0.9.7x |
| [工程体检报告-2026-10-17.md](工程体检报告-2026-10-17.md) | 体检 | 结构/门禁/覆盖率体检 | 其中的拆分项已执行（见下） |
| [优化空间勘查-2026-10-03.md](优化空间勘查-2026-10-03.md) | 对标 | 同类开源项目对标与优化空间 | 竞品表以 README 最新版为准 |
| [对比测试报告_v0.8.md](对比测试报告_v0.8.md) | 对标 | v0.8 去 AI 味能力增强对比 | 已相差十余个版本 |
| [竞品周报-2026-10-26.md](竞品周报-2026-10-26.md) | 对标 | 同类项目 10-19~10-26 的提交/建仓异动、对齐清单与不对齐理由 | 一周快照，star 是存量不是增量，结论随周变 |

## 已执行的方案（留作边界记录）

| 文件 | 类型 | 内容 |
|---|---|---|
| [humanize-split-plan.md](humanize-split-plan.md) | 方案（已落地） | `humanize.ts` 2,477 行 → 现在 692 行；数据层与逻辑层的拆分边界都在这份里，改拆分前先读 |

## 工具产物

`*.md.artifact.json` 是外部工具写入的元数据（内容形如 `{"retain_for_chat": true}`），
不参与文档索引，也不需要维护。
