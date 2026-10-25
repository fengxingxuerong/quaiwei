---
name: qu-ai-wei
display_name: 去 AI 味 · QuAiWei
display_name_zh: 去 AI 味 · QuAiWei
display_name_en: QuAiWei Humanizer
description: 去 AI 味（简体中文）——调用本仓库自带的本地离线引擎（零成本、不联网）或可选 LLM 深度闭环，把 AI 写的中文改得更像人写的，并输出前后 AI 味评分与逐条痕迹报告。当用户要求「降 AI 率 / 去 AI 味 / 去 AIGC 痕迹 / 让这段更像人写的 / 自检朱雀类检测」时使用。
description_zh: 去 AI 味（简体中文）——本地离线引擎或可选 LLM 深度闭环，把 AI 写的中文改得更像人写的，并输出前后评分与痕迹报告。
description_en: Remove AI-sounding Chinese prose with an offline deterministic engine or an optional LLM loop. Local proxy scores only; no detector-pass guarantee.
license: MIT
metadata:
  version: 0.9.76
  repo: https://github.com/fengxingxuerong/quaiwei
---

# 去 AI 味 · QuAiWei

薄壳 skill：**规则与引擎都在仓库里**，这里只负责告诉 agent「怎么调、什么别做」。
与"一份提示词清单"型 skill 的区别是——本仓库跑的是有回归测试锁死的 TypeScript 引擎，
不是让模型自由发挥。

## 什么时候用

- 用户要「降 AI 率 / 去 AI 味 / 去 AIGC 痕迹 / 改得像人写的」，且**文本是简体中文**；
- 用户要「自检一下会不会被判成 AI」——注意本 skill 只给**代理分**，不是任何检测器的官方分；
- 批量处理目录里的一批 `.txt` / `.md` / `.docx`。

英文文本、或要求「对某个检测器打包票」的场景，**不要**用本 skill（见下方边界）。

## 怎么跑

```bash
# 本地引擎：零成本、离线、不联网（默认推荐）
npx tsx scripts/humanize-cli.ts ./in --out ./out

# 想更强：走 LLM 深度闭环（Key 走环境变量，别写进命令行历史）
QUAIWEI_API_KEY=sk-xxx npx tsx scripts/humanize-cli.ts ./in --out ./out --api \
  --base-url https://token.sensenova.cn/v1 --model deepseek-v4-flash --judge-model glm-5.2
```

- 输入可以是文件或目录；输出扩展名默认跟随输入（`.docx` 进 `.docx` 出）。
- 文本编码自动识别（UTF-8 / UTF-8 BOM / UTF-16 / GBK，产物统一落 UTF-8）；目录批量默认跳过已带输出后缀的产物，重跑幂等。
- 需要留证据时加 `--report out.json`：每篇的耗时/字数/引擎/轮次分/降级原因都会落进去。

## 参数（与 `scripts/humanize-cli.ts` 一一对应）

| 参数 | 取值 | 说明 |
|---|---|---|
| `--out <dir>` | 目录 | 输出目录（不给则写到输入旁） |
| `--intensity <0~1>` | 默认 0.6 | 去味强度滑块；要更强再显式给 0.9 |
| `--zhuque` | 开关 | 朱雀增强（反指纹特征注入） |
| `--style` | `plain` \| `casual` \| `academic` | 文风，默认 `plain`；**论文/公文必须给 `academic` 或 `plain`** |
| `--seed <n>` | 默认 20260905 | 本地引擎种子，给定即可复现 |
| `--suffix <s>` | 默认 `.humanized` | 输出文件后缀 |
| `--out-format` | `follow` \| `txt` \| `docx` | 强制输出格式 |
| `--report <file>` | JSON 路径 | 逐篇运行报告 |
| `--explain` | 开关 | 附「为什么这么改」清单：逐条标注属于哪类规则、依据哪张表（事后反查，判不准的标「推断」） |
| `--detect-only` | 开关 | **审题模式**：只输出「AI 味痕迹地图」（第几句、风险多少、命中哪类特征、该怎么改），**一个字都不改、不落盘**。改之前先看一遍用它；不需要 API Key |
| `--api` | 开关 | 走 LLM 深度闭环（否则纯本地引擎） |
| `--base-url <url>` | 绝对地址 | 网关地址；**不要**填 UI 里的 `/sensenova/v1` 相对路径 |
| `--model` / `--judge-model` / `--alt-model` | 模型名 | 主改写 / 交叉评判 / 备选改写 |
| `--api-key <key>` | — | 优先级低于环境变量 `QUAIWEI_API_KEY` |
| `--no-deep` | 开关 | 单轮改写，不开深度闭环 |
| `--contest <n>` | ≥1 | 首轮多候选择优（调用数 ×n） |
| `--max-calls <n>` / `--max-wait <sec>` | 预算 | 整篇调用预算 / 轮间最长等待 |
| `--target <1~100>` | 默认 10 | 深度模式达标线：LLM 评判 ≤ 此分即收手。调低=多压几轮更彻底也更慢，调高=更快收手；不给则沿用默认 |
| `--strict` | 开关 | 严格保真：发现编造事实即拒绝交付并回退 |
| `--persona` | `default` \| `netgen` \| `classic` | 人味人格分档 |
| `--detector-url <url>` | 任意 HTTP 接口，**可重复** | 接**外部检测器**（不绑定厂商）：把 `{text}` POST 过去，按 `--detector-path` 取分；原文与产出各送一次，前后分写进 `--report` 的 `detectorBefore` / `detectorAfter`（多档时另有 `detectorScores` 数组）。给多个 URL 就逐档送检、横向对比 |
| `--detector-key <key>` | — | 检测器凭证，作用在**最近一档** `--detector-url` 上；更建议走环境变量 `QUAIWEI_DETECTOR_KEY`（命令行会进 shell 历史） |
| `--detector-path <json.path>` | 默认 `score` | 响应里分数的点路径（如 `data.prob`），同样只作用于最近一档 |
| `--detector-scale` | `0-100`（默认）\| `0-1` | 分数刻度，只作用于最近一档；0~1 那类接口填 `0-1` |
| `--recursive` | 开关 | 目录扫描进子目录（默认不进；隐藏目录一律跳过） |
| `--jobs <n>` | ≥1 | `--api` 模式并发路数（本地引擎单线程，给了也只提示忽略） |
| `--dry-run` | 开关 | 只列出将处理哪些文件（含跳过原因），不建目录不落盘 |

## 边界（**不要越界承诺**）

1. **不承诺通过任何检测器**。内置评分是本地启发式**代理分**，与朱雀等官方分**无标定关系**；
   aiScore→官方分的换算线当前 18 个标定点里有 6 个漂移、且凭证认证率为 0/18。
2. **不要用"去味前后的分数差"判断安不安全**：本地检测器与去味引擎共用一套词表，
   分数必然变好看——这是同源指标，不是外部真值。要真值只能拿真实检测器跑。
3. **本地引擎是"换词不换骨"**：不打散段落结构与句序，而结构规律性恰是检测器重点；
   需要结构级去味必须给 `--api`。
4. **别拿单次数值下判断**：代理分测的是**词表命中的套话/公式化表达**，不是"语体像不像 AI"。
   21 篇真人文本实测：注入 AI 套话 **19/21 方向正确（Δ +14.6）**，
   而把书面体改成口语体（56 处替换）**只有 2/21 方向正确（Δ −0.6）**——
   语体变化几乎不影响分数，只有恰好命中词表才影响。
   真人文本本身分布 `8 8 10 11 20 20 29 31 32 32 35 37 38 39 43 51 54 57 59 68 95`（中位 35，
   最高 95）⇒ **低分 ≠ 像人写**，绝对值只在同一篇稿子的前后对比里有意义。
5. **人写稿别去味**：纯人写文本越去味，实测官方分反而略升——先看分再决定要不要跑。
6. 需要 100% 过检、或要求保留精确格式（表格/公式/加粗）的，**转人工处理**，别硬跑。

## 交付前自查

- 中英空格、数字、专名是否被改动（引擎有术语保护，但批量文本仍建议抽样 diff）；
- `--report` 里有没有 `降级` / `编造否决` 字样，有就说明该篇走了回退路径，需人工复看；
- 输出是否还含「综上所述 / 值得注意的是 / 深度融合」这类套话（`--intensity` 太低时会残留）。
