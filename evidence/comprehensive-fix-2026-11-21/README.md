# 全方面修复 · 2026-11-21

> 对 `eval-local-glm-2026-11-21` 暴露的缺点做定向修复。用户选定三项动手：结构块保真重试、
> 低分稿默认跳过、提速优化。外部依赖（网关脆弱、LLM 非确定性、评委同源）代码层修不了，
> 如实标注。

## 一、三项改动与结论

### 1. 结构块 pin 保真重试（机制完成，对 C21 无实际收益）

- `scripts/pin-guard.ts` 新增 `restorePinsWithRetry(out, pins, llmMode, rewrite)`：首次 pin
  失败时用回调重跑一次改写，仍丢哨兵才返回 missing（调用方整篇回退）。纯函数、可单测。
- `scripts/humanize-cli.ts`：LLM 路径 pin 失败时注入低强度（intensity≤0.4）重试回调；
  `rep.pinRetried` / `totals.pinRetried` 记账。
- 单测 +4（首次成功不重试 / 重试保住 / 仍失败回退 / 无通道降级）。
- **端到端 C21 复测**：`↻ 触发重试 → 仍丢 2 段 → 整篇回退`，耗时 84s（含重试）。
  ⇒ 机制正确、契约不变，但 GLM 直连通道保不住围栏哨兵，**该篇无收益**。这是模型能力问题，
  非代码可修；对其他可能靠低强度救回的稿仍有价值。

### 2. 低分稿默认跳过（已落地）

- `skipLowRisk` 默认 `false→true`，新增 `--force-low-risk` 恢复旧强制改写。
- stdin 与批量路径同步；USAGE / SKILL.md / 提示文案同步。
- 单测重写 5 条（默认跳过 / 反向开关强制改写 / 批量默认跳过 / 反向开关批量 / 组合判据）。
- 依据：C8（3→13）/C17（28→33）低分稿改写反噬。⚠️ 如实标注判据局限：仍误跳 10 篇该改稿、
  AUC 0.683、短档体裁未分离 ⇒ 默认跳过是**保守取向非能力承诺**。

### 3. 提速优化（并发 2→3 实测有效）

- `--jobs > 3` 加 502/429 风险警告（只警告不拦截，其他网关并发更高无妨）。
- USAGE 补「本地 GLM 并发上限 3，建议 --jobs 2~3」。
- **实测**（4 篇同语料、`--force-low-risk` 确保都调 LLM、相同参数）：

| 并发 | 耗时 | 产出 |
|---|---:|---|
| jobs=2 | 314s | 4/4 |
| jobs=3 | **180s** | 4/4（无 502） |

  ⇒ 并发 2→3 提速约 **43%**，在网关 3 上限内安全。产出逐篇不同是 LLM 非确定性（同 seed
  也不保证同输出），非并发 bug。
- 降 max_tokens 不提速（模型自定生成量）且会让 reasoning 更易吃空（C4 根因）——未做。

## 二、门禁（全绿）

- 全量 vitest **129 文件 2408 用例**（基线 2400 + 8 新用例，maxWorkers=2）
- `tsc --noEmit` 0 / `eslint`（改动文件）0 / `npm run build:cli` 0 / `npm run check:release` 0
- 相关单测：pin-guard 18、humanize-cli-stdin、scripts-logic、llm-humanize 57、llm-chat 35、store 63

## 三、修复矩阵（哪些修了、哪些没修）

| 缺点 | 结果 |
|---|---|
| 单轮空内容回退（C4） | ✅ 上一轮已修（token 翻倍重试），复测 36→28 纯 LLM |
| 低分稿反噬（C8/C17） | ✅ 默认跳过已落地（保守取向，判据局限如实标注） |
| 慢（45min/23篇） | ✅ 并发 3 提速 43%（外部网关延迟仍是主因，代码层到此为止） |
| 结构块保真（C21） | ⚠️ 重试机制完成，但该模型保不住围栏哨兵，无实际收益 |
| 网关脆弱（deepseek-auto 全挂、单通道、502） | ❌ 外部依赖，代码层修不了；已加并发警告 |
| LLM 非确定性 / 评委同源 / 不可复现 | ❌ 方法论与模型固有属性，只能标方向性口径 |

## 四、产物

- `pin-retry-report.json` — C21 重试复测报告（pinRetried=1, fallback=1）
- 工作日志 `2026-11-21.md` 已追加
- 全部改动**未提交、未发版**

## 五、改动文件

`src/api/llm-config.ts`、`llm-chat.ts`、`llm-humanize.ts`、`src/store.ts` + 对应 4 个 `.test.ts`；
`scripts/humanize-cli.ts`、`pin-guard.ts`、`humanize-cli-stdin.test.ts`、`pin-guard.test.ts`；
`SKILL.md`。均为本轮与前两轮累计，未提交。
