# 优化：单轮 `--api` 加 token 翻倍降级重试 · 2026-11-21

> 针对 `evidence/eval-local-glm-2026-11-21/` 暴露的问题做定向优化：本地 GLM 23 篇改写臂中，
> C4-product-copy 耗 274s 后空内容→本地回退。根因：`humanizeViaApi`（单轮路径）**裸调一次
> `chat()`**，无降级重试；而深度路径早有 `chatNonEmpty()`（默认→token 翻倍→换 altModel）。

## 一、改动

- `src/api/llm-humanize.ts`：`humanizeViaApi` 的裸 `chat()` → `chatNonEmpty(cfg, msgs,
  maxTokens=16000, cfg.altModel, () => false)`。单轮无预算概念，传恒 false 让降级链跑完。
  空内容错误改用 `emptyContentError(r.failure)`（保留真实网关失败原因）。
- `src/api/llm-humanize.test.ts`：单轮空内容用例改为「2 次尝试（默认+翻倍）才拒绝」；
  新增「首轮空、翻倍档成功」用例，断言 `tokens=[16000,32000]`。
- **判据/prompt/产出格式零改动**；只提高单轮可用性。默认 `nested` 格式行为不变。

## 二、验证

- 单测：`llm-humanize` 57 + `llm-chat` 35 + `store` 63 = **155 全绿**；tsc 0 / lint 0 / build:cli 0。
- 复测（新构建，C4/C8/C17 三篇，`--no-deep`，本地 GLM，jobs=1）：

| 篇目 | 优化前 | 优化后 | usedApi | 说明 |
|---|---|---|---|---|
| **C4-product-copy** | 274s 空内容→**本地回退** | 114s **36→28 纯 LLM** | ✅ true | 问题修复 |
| C8-social-post | 3→13 | 3→9 | true | 反噬减轻，仍升 |
| C17-verdict-labor | 28→33 | 28→32 | true | 基本不变 |

C4 复测产出与原文逐字节不同（`diff` 确认），非回退。`usedApi=true`/`engine=llm`/`degrade=[]`。

## 三、结论与边界

- ✅ **单轮空内容回退问题修复**：降级重试让 C4 这类"思考型模型偶发空 content"不再直接回退本地。
- C8/C17 是**另一类问题**：原文 AI 味代理分已很低（3/28，落在人写带），改写反而略升。
  这是「低收益反噬」，CLI 已提示「输入 AI 味已较低，本轮收益有限」。属产品已知边界，
  不在本次降级重试改动的范围内——是否需要「低分稿自动少改/不改」需单独立项 + 双席 A/B 验证。
- 未提交、未发版。复测产物 `eval-work/opt-retest/`（gitignore）。

## 四、复现

```bash
# 单测
cd /d/projects && env -u NODE_OPTIONS node /d/projects/quaiwei/node_modules/vitest/vitest.mjs \
  run --root D:/projects/quaiwei src/api/llm-humanize.test.ts

# C4 定向复测
cd /d/projects/quaiwei && npm run build:cli
KEY=$(node -e "const fs=require('fs');process.stdout.write(JSON.parse(fs.readFileSync(process.env.USERPROFILE+'/.dsh/our-free-model/settings.json','utf8')).chanGateway.relay.key)")
QUAIWEI_API_KEY="$KEY" env -u NODE_OPTIONS node dist-cli/humanize-cli.mjs <C4目录> \
  --api --no-deep --base-url http://127.0.0.1:18326/v1 --model glm/glm-5.3-flash \
  --reasoning-effort low --reasoning-format top-level --llm-timeout 300 --jobs 1
```
