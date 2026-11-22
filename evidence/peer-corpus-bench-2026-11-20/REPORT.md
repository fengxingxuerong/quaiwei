# 同类开源项目测试语料 → 趣AI味引擎独立跑测

日期：2026-11-20　跑测脚本：`scripts/peer-corpus-bench.ts`　HEAD：`6981501`（v0.9.89）

## 1. 找了什么

项目自带 100+ 单元测试，缺的是**外部独立语料**。选了两家公开、许可清晰的同类项目：

| 来源 | 文件 | 用途 | 规模 |
|---|---|---|---|
| `swaylq/humanize-chinese` @ main | `examples/sample_{academic,general,social,long_blog,workplace}.txt` | 该项目自己用作去味验收的 AI 味重稿 | 5 篇 × 5 seed × 2 强度 = 50 行 |
| 同上 | `examples/real_blog_{plain,skill}.txt` | 真人博客对照（该项目 H1 验收用） | 2 篇 × 10 = 20 行 |
| `Hello-SimpleAI/HC3-Chinese` @ main | `psychology.jsonl` | 真人 / ChatGPT 成对答案（经典中文 AIGC 检测基准） | 116 对 = 232 行 |
| 同上 | `tests/*.py` | 读其断言，借鉴判据口径 | 6 个测试文件 |

语料全部落盘 `artifacts/peer-corpus/`（gitignore 忽略，不入库）；原文件 URL 见脚本头注释。
HC3 走 hf-mirror.com 镜像（huggingface.co 直连不通）。

## 2. 怎么测

两层判据，来源为同类项目自己测试里在意的点：

- **硬保真**：数字、单位、URL、邮箱、英文专名不丢；`collapseIssues` 不报内容腰斩。
- **软趋势**：`aiScore` 前后变化（**仅相对方向**，不作绝对刻度——同文复测 MAE 14.7）。
- **观察项**：段落数变化**不计缺陷**。理由：插短段落是引擎设计行为，
  `swaylq/tests/test_regression.py::test_paragraph_preservation` 自己也允许丢 2 段。
  初版把这算成缺陷，导致 63/302 假阳性，修正后 18/302。

## 3. 结果

### 硬保真：`summary.json`

```
302 行 → 18 行 collapse（6.0%）
数字丢失 0 / 单位变更 0 / URL 丢失 0 / 邮箱丢失 0 / 英文专名丢失 0
按来源：真人博客 6、ChatGPT 6、真人 HC3 6
```

18 条全部来自**破折号/省略号压缩后谓语残留**，不是数字/事实丢失。
与项目已归档的 `evidence/collateral-attribution-2026-11-09/` 27 条归因一致：
A 类（破折号转逗号）17 条当时裁决「不改」，B 类省略号压缩 5 条，
C 类悬空 3 条才是唯一真语病——R3′ 窄化守卫尚未上线。本次外部语料**未发现新型缺陷**。

### 软趋势：`aiScore` 相对变化

| 语料 | 段数 | 均分 in | 均分 out | 平均 Δ | 降分占比 |
|---|---|---|---|---|---|
| HC3 真人答案 | 116 | 13.3 | 4.9 | −8.4 | 73.3% |
| HC3 ChatGPT 答案 | 116 | 10.1 | 4.8 | −5.3 | 71.6% |
| 同类 AI 味样本 | 70 | — | — | −31.1 | 100% 被改写 |

**关键读数：真人文本降分比例（73.3%）比 AI 文本（71.6%）还高。**
这印证项目既有口径——长文象限密度分不出人与 AI、aiScore 不能当绝对刻度。
但本次用的是**心理学问答短文本**，与既有「长文」结论场景不同，
可视为「短文本上 aiScore 同样缺乏人/AI 区分力」的新增旁证（非定论）。

### 人工核对发现的真问题（模板测试没盖住）

`evidence/peer-corpus-bench-2026-11-20/sample-real_blog_plain.txt` 逐句对照，
seed=42 / 强度 0.9，改写后出现：

1. **语义替换走样**：
   - `产品方法论` → `产品办法`
   - `工程师背景确实是红利` → `确实是实惠`（后文又出现 `甜头`）
   - `我用了很久才接受这种延迟满足` → `延迟对上`（明显损坏）
2. **逻辑连接词丢失**：`但我借着出差去客户那儿坐了半天` → `我借着出差…`，
   `但` 被吞，转折关系消失。
3. **分句重排导致错位**：`你拒绝的只是优先级，而对面站着的是…销售同事`
   这一段被挪到「我做过一个笨办法」之后，语义连贯性受损。

这三条**不在**现有硬判据（数字/URL/专名）覆盖范围内，
属于「软缺陷（必须人读）」——与 `scripts/realcase/run.ts` 头注释里的判断一致：
每次拿真实稿件试一轮都能抓出模板没盖住的缺陷。
建议后续单独立项，不在这次跑测里改引擎。

## 4. 复现

```bash
# 语料已落盘 artifacts/peer-corpus/，脚本只读，不写语料
cd /d/projects && env -u NODE_OPTIONS node /d/projects/quaiwei/node_modules/tsx/dist/cli.mjs \
  /d/projects/quaiwei/scripts/peer-corpus-bench.ts
```

产物：
- `summary.json` — 汇总判据
- `rows.jsonl` — 全部 302 行逐条结果（含 seed/强度/各保真字段）
- `sample-*.txt` — 7 篇语料 seed=42 / 0.9 的 before/after 全文，供人工逐句读

## 5. 边界 / 未做

- 未测 `--api` 路径：`--api` 需外部 LLM 网关，记忆里双席 A/B 因网关离线不可执行，本次不引入外部依赖。
- 未做双席 A/B：aiScore 是自家代理分，软趋势只作方向性旁证。
- 未改引擎任何判据；本轮是**评测**，不是修复。
- HC3 只取 psychology 一个子集（1099 对抽 116 对），非全量；其他 6 个领域（金融/法律/医疗/百科等）未覆盖。
