# 本地 GLM 作改写引擎 · 端到端测试 2026-11-21

> 目标：验证「项目能用**本地 GLM**（`127.0.0.1:18326` OFM 中继的 `glm/glm-5.3-flash`）作 `--api`
> 改写引擎」，并对产出的改写臂做 GLM mirror 双席配对盲测，给出方向性能力口径。
> 本次是首次跑通本地 GLM 改写通道（此前本地 GLM 只能当评委）。

## 一、测试前提（代码改动）

本次为打通本地 GLM 改写新增 `ApiConfig.reasoningEffortFormat`（默认 `nested`=旧 OpenRouter
格式，零行为改动；`top-level`=顶层 `reasoning_effort`，本地 GLM 直连专用）。CLI 新增
`--reasoning-effort` / `--reasoning-format`。改动 6 处：`src/api/llm-config.ts`、`llm-chat.ts`、
`src/store.ts`、`scripts/humanize-cli.ts`、`SKILL.md`、`llm-chat.test.ts`+`store.test.ts`。

- 单测：3 文件 142 全绿；tsc 0 / lint 0 / `npm run build:cli` 0。
- 根因：`glm/glm-5.3-flash` 直连始终思考，传 `reasoning:{effort}` → 1210「不支持关闭思考」，
  只认顶层 `reasoning_effort`。judge/quality 同走 `chat(cfg,…)`，字段自动覆盖全部调用。

## 二、改写臂生成

| 项 | 设置 |
|---|---|
| CLI | `dist-cli/humanize-cli.mjs`（v0.9.89） |
| 网关/模型 | `http://127.0.0.1:18326/v1` · `glm/glm-5.3-flash` · `reasoning_effort=low`（top-level） |
| 参数 | `--api --no-deep --seed 20260905 --jobs 2 --llm-timeout 300`，intensity 0.9 |
| key | OFM settings 经 env 传入，不落盘、不回显 |
| 语料 | `scripts/realcase/cases.json` 全量 23 篇（53~453 字） |

结果：23/23 生成成功，耗时 2684s（约 45min，平均单篇 70~180s，网关波动大）。

- **22/23 纯 LLM（`usedApi=true`, `engine=llm`）**。
- 1 篇污染：**C4-product-copy** — `usedApi=false`，本地引擎回退（「模型返回空内容，思考型模型
  token 预算耗尽」）⇒ 剔除。
- 1 篇无差异：**C21-fenced-code-doc** — `usedApi=true` 但 pin 回退，产出与原文逐字相同 ⇒ 剔除
  （配对时会退化成瞎猜）。
- 干净臂 = **21 篇**（23 − 2）。

aiScore（代理分）均值 33→26，字数 5507→5367。

## 三、GLM mirror 双席盲测（21 篇干净臂）

| 指标 | 值 |
|---|---:|
| 配对票 | 42（21 × 2 席） |
| B 臂（改写稿）被选「更像 AI」 | 8/42 = 0.19 |
| **B 臂被选「更像人」（反向）** | **34/42 = 0.810** |
| p（B 更像人，单尾二项） | **3.4e-05** |
| 双席一致 | 0.905（19/21 两席同判） |
| 甲被选率 | 0.452（mirror 反序基本消位置偏置） |
| 错误 | 0 |

评委 `glm/glm-5.3-flash` + `reasoning_effort=low`，`--mirror`（B 席反序），单网关充当两席。
评委 prompt 问「哪段更像 AI」，故 `bWin` 原义是「B 更像 AI」，反向才是「B 更像人」；
`ab_report.json` 的 `pValue=0.99999` 是「B 更像 AI」口径，脚本打印的 `3.4e-05` 是反向口径。

### 与历史对比

| 轮次 | 口径 | 改后更像人 | 甲被选率 |
|---|---|---:|---:|
| 11-06 本地引擎臂 | 双席异源（glm/glm） | 87.0% | — |
| 11-19 --api 臂 | 双席异源，同序 | 89.1% | 0.370 |
| 11-21 --api v0.9.89 | GLM mirror（另一臂，23 篇） | 95.7% | 0.500 |
| **11-21 本地 GLM 改写臂** | **GLM mirror（本轮，21 篇干净臂）** | **81.0%** | **0.452** |

本轮 81.0% 低于此前 87~96%，可能原因：① 改写臂换成本地 GLM 生成（不同 LLM 采样）；
② 剔除了 2 篇污染臂后的干净样本；③ 单 GLM 评委 + 同源 mirror，非异源。均为方向性旁证，
**不能据此声称「本地 GLM 改写更弱/更强」**——不同臂、不同批次，非受控对照。

## 四、边界

- 能力数字是**单一 GLM 评委 + 同源 mirror** 的方向性口径，**不更新 SCORECARD**。
- 改写臂来自 LLM，不可复现；`--no-deep` 单轮，未测深度闭环。
- 单篇 70~180s、23 篇约 45min；思考型模型 token 预算偶发耗尽（C4 本地回退），
  批量稳定性仍需 `--jobs` 与 prompt token 预算调优。
- 评委 prompt 问「更像 AI」，「更像人」是反向推断，不是评委直接判定。

## 五、复现

```bash
# 1. 改写臂（需 OFM 网关，23 篇约 45min）
KEY=$(node -e "const fs=require('fs');process.stdout.write(JSON.parse(fs.readFileSync(process.env.USERPROFILE+'/.dsh/our-free-model/settings.json','utf8')).chanGateway.relay.key)")
QUAIWEI_API_KEY="$KEY" env -u NODE_OPTIONS node dist-cli/humanize-cli.mjs eval-work/in \
  --out eval-work/arms-local-glm/09 --intensity 0.9 --suffix .humanized \
  --report eval-work/report-local-glm-09.json --api --no-deep \
  --base-url http://127.0.0.1:18326/v1 --model glm/glm-5.3-flash \
  --reasoning-effort low --reasoning-format top-level --seed 20260905 --jobs 2 --llm-timeout 300

# 2. GLM mirror 双席（剔除 C4/C21 后的 21 篇干净语料）
QUAIWEI_EVAL_KEY_A="$KEY" QUAIWEI_EVAL_KEY_B="$KEY" env -u NODE_OPTIONS py -3.12 \
  scripts/eval-dual/ab_accept.py \
  --arm-a eval-work/corpus-local-glm-clean --arm-b eval-work/arms-local-glm/09 \
  --corpus eval-work/corpus-local-glm-clean \
  --url-a http://127.0.0.1:18326 --model-a glm/glm-5.3-flash --reasoning-effort-a low \
  --mirror --seats AB --out eval-work/ab-local-glm
```

## 六、产物

- `ab_report.json` / `ab_results.jsonl` — 双席汇总与 42 票逐票记录。
- 改写臂/报告在 `eval-work/`（gitignore，不入库）。
