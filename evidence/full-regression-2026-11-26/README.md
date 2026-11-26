# 发布前完整回归（2026-11-26）

HEAD `32230a1` · v0.9.91 工作树干净状态下跑的完整一轮。

用途：回答「全方面是否真的没问题」。分四层：静态 → 单元 → 发版门禁 → 真实链路与异源双席。
前三层是仓库自带门禁；第四层是门禁**不覆盖**的部分（无 key 环境跑不了），本轮用桌面 TXT 的真实网关补上。

## 一、门禁层（全绿）

| 项 | 结果 |
|---|---|
| vitest | 127 文件 / **2231 用例**，exit 0（65.6s） |
| tsc --noEmit | 0 错 |
| eslint src/ scripts/ | 0 错 |
| check:release | **exit 0**，11 子门禁全过（139s） |
| 覆盖率 | 语句 96.3 / 分支 92.5 / 函数 97.9 / 行 97.2（阈值 94/91/95/95） |
| realcase 矩阵 | 23 篇 × 5 seed × 2 强度 = **230 组**，硬缺陷 0、软提示 0 |
| MCP 冒烟 | **11/11**（协议 2025-06-18，版本 0.9.91） |
| CLI 产物 | humanize-cli 549.2kb / quaiwei-mcp 356.5kb，可加载可跑 |

> 表内数字是 HEAD `32230a1`（v0.9.92 收尾前）的实测值，属历史记录不改。
> 11-26 10:25 在 v0.9.92（HEAD `755ecf6`）复跑：**128 文件 / 2240 用例，0 失败 0 跳过**
> （串行 `--no-file-parallelism` 4m16s，退出 0）。+9 来自 `humanize-cli-report-redaction`
> 等 v0.9.92 新增用例。**引用用例数用 2240 / 128。**

原始日志：`check-release.txt`。

## 二、CLI 本地引擎端到端（3 篇真人语料）

| 路径 | 行为 |
|---|---|
| 默认（`skipLowRisk` 开） | **3/3 命中低收益风险，原样出稿，0 改写**（7770→7770 字，逐字节相同） |
| `--force-low-risk` | 3/3 改写生效，7770→7987 字，代理分 22→17，引擎 220ms |

即：真人写好的稿子，默认路径一个字都不改。这是设计意图，不是故障。

## 三、CLI `--api` 真实 LLM 端到端（bailu-2.8，单轮）

3 篇真人语料，`--no-deep`，总耗时 **473.7s**。

| 篇 | 耗时 | 结果 |
|---|---|---|
| 老舍 2178 字 | 200.0s | ✅ 分块 3 块 + 保真修复 1 次后通过 → 2109 字 |
| 屠呦呦 2160 字 | 202.0s | ❌ **保真否决回原文**：missing-numbers `91%,4,2026,10,14,96939,97570` / lost-url / quote-changed；定向修复失败 |
| 集成电路 3432 字 | 71.7s | ❌ **保真否决回原文**：missing-numbers `86%,88%,90%,94%,4,2026,10,14,1倍` / added-numbers / lost-url / quote-changed |

保真门禁在真实语料上确实拦住了事实损坏，**不是误报**。代价是：真实维基体长文 2/3 被拒，且单篇 70~200s。

### 缺陷：思考型模型走 `--api` 会静默挂死

`deepseek-v4.1-flash-1017` 是思考型：`reasoning` 吃满 `max_tokens`，`content` 恒为空。

| 配置 | 耗时 | content |
|---|---|---|
| max_tokens 512 | 4.1s | 0 字节（reasoning 786 字） |
| max_tokens 4096 | 29.9s | 0 字节（4096 tokens 全 reasoning） |
| `reasoning_effort:"low"` | 34.4s | 0 字节 |
| **`thinking:{type:"disabled"}`** | **3.6s** | **513 字** ✅ |
| `chat_template_kwargs:{thinking:false}` | 3.7s | 516 字 ✅ |

`humanize-cli` 只有 `--reasoning-effort` / `--reasoning-format nested|top-level`，**没有关闭思考的开关**。
实测走该模型单篇挂起 **14 分钟无任何产出**（空内容重试 + 换 altModel 循环），无快速失败。

## 四、异源双席配对评判

席 A = `deepseek-v4.1-flash-1017`（discovery-api），席 B = `bailu-2.8`（bailucode）。两网关两模型家族。
问题：「哪段更像 AI」，甲/乙强制选择，位置翻转抵消偏置；STRICT 严格输出。

| 组 | 篇 | 干净票 | 改写臂被判更像 AI | 一致性 |
|---|---|---|---|---|
| 真人语料：原文 vs 本地引擎改写 | 3 | 6/6 | **6/6 = 100%** | 3/3 两席一致 |
| 真人语料：原文 vs LLM 改写 | 1 | 2/2 | **2/2 = 100%** | 1/1 两席一致 |
| AI 稿（C1/C6/C16）：原文 vs 本地引擎改写 | 3 | 6/6 | **2/6 = 33.3%** | 1/3 两席一致 |

**结论**：
1. 真人写好的稿子，改写（本地或 LLM）后**两席一致判定更像 AI**（8/8）⇒ 印证 `skipLowRisk` 默认跳过的正确性，不是保守过头。
2. AI 稿改写方向对（33% < 50%）但 6 票不显著（p≈0.69）、两席一致率仅 1/3 ⇒ 样本不足以定性，需扩到 ≥30 对。

## 五、两个缺陷的现状

| # | 缺陷 | 状态 | 修法 |
|---|---|---|---|
| 1 | `--report` 明文落盘网关凭证 | ✅ `380591b` | 落盘前脱敏为 `***` + 2 条回归测试 |
| 2 | 思考型模型走 `--api` 空转/挂起 | ✅ `15625c3` | 识别「正文空 + reasoning 非空」跳过翻倍档 + 新增 `--no-think` |

缺陷 2 的三档实证见 `thinking-fix.md`：同一篇 2178 字，修复前 14 分钟无产出 → 152.3s 完成 → 加 `--no-think` 21.6s。
**口径**：加开关更快但那次被保真否决、不加那次慢 7 倍但交付成功 ⇒ 速度与质量权衡，不是纯改进。

## 口径边界

- 单 seed、单强度（0.7）、3~4 篇样本；不构成能力刻度。
- 双席虽异源，但都是「判断哪段像 AI」的自评，无人工标注基准。
- 代理分（aiScore）只适合同篇前后对比，跨文不可比。
- 本目录不涉及 SCORECARD，不改对外口径。

## 复现

```bash
# 门禁
npm test -- --reporter=dot && npx tsc --noEmit && npm run lint && npm run check:release
# 打包产物
npm run build:cli && npm run smoke:mcp
# 本地引擎端到端
node dist-cli/humanize-cli.mjs <in> --out <out> --intensity 0.7 --force-low-risk --report r.json
# LLM 端到端（bailu）
NODE_USE_ENV_PROXY=1 node dist-cli/humanize-cli.mjs <in> --out <out> --api --no-deep \
  --base-url https://bailucode.com/openapi/v1 --model bailu-2.8 --api-key $KEY \
  --intensity 0.7 --force-low-risk --llm-timeout 300 --report r.json
# 双席
BASE=<dir> ARM_A=<armA> ARM_B=<armB> URL_A=.. KEY_A=.. MODEL_A=.. URL_B=.. KEY_B=.. MODEL_B=.. \
  MAX_TOKENS=512 TEMPERATURE=0.6 NODE_USE_ENV_PROXY=1 node scripts/ab-pair-judge.mjs
```
