# 复现双网关配对盲测

`eval_dual.py` 是 2026-11-06 那轮评测的参数化版本：同样的语料、同样的 prompt、同样的呈现顺序，
但路径不硬编码、凭证只走环境变量、可断点续跑、`--summarize` 可离线复核归档。

结果归档在 [`evidence/eval-dual-2026-11-06/`](../../evidence/eval-dual-2026-11-06/)，
方法/结论/局限在 [`docs/eval-dual-2026-11-06.md`](../../docs/eval-dual-2026-11-06.md)。

## 0. 前置条件

- Python 3.8+、Node 22+（跑 CLI）。
- **两个** OpenAI 兼容 `/v1/chat/completions` 网关，同一个模型（基线用 `glm-5.3-flash`）。
  单账号并发 >1 会 429，所以脚本给每个席位各起一个串行 worker。
- 凭证只从环境变量读，**不要写进任何文件**：

```bash
export QUAIWEI_EVAL_URL_A=http://127.0.0.1:8080
export QUAIWEI_EVAL_URL_B=http://192.168.151.151:18080
export QUAIWEI_EVAL_KEY_A=...   # 不回显、不入库
export QUAIWEI_EVAL_KEY_B=...
```

## 1. 生成两档实产改写稿

必须用**当前 CLI 实跑**，别复用 `scripts/realcase/out/*.after.txt`（那是旧产物）。

```bash
npm run build:cli

node -e "const fs=require('fs');const c=require('./scripts/realcase/cases.json').cases;fs.mkdirSync('eval-work/in',{recursive:true});for(const x of c)fs.writeFileSync('eval-work/in/'+x.id+'.txt',x.text)"

node dist-cli/humanize-cli.mjs eval-work/in --out eval-work/arms/09 \
  --intensity 0.9 --suffix .humanized --report eval-work/report09.json
node dist-cli/humanize-cli.mjs eval-work/in --out eval-work/arms/06 \
  --intensity 0.6 --suffix .humanized --report eval-work/report06.json
```

`--arms-dir` 下必须恰好是 `09/<id>.humanized.txt` 与 `06/<id>.humanized.txt`。

## 2. 跑评测

```bash
python scripts/eval-dual/eval_dual.py \
  --arms-dir eval-work/arms \
  --out eval-work/out
```

154 次调用（92 绝对分 + 62 配对），两席并行、每席串行。结果增量写
`eval-work/out/eval_dual_results.jsonl`，中断后重跑会自动跳过已完成项；
`--summarize` 只重算 `eval_dual_report.json`，不联网。

## 3. 单席 / 跨模型谱系复核

只有一个上游时不必凑两个席位——`--seats A` 只跑 77 次调用（46 绝对分 + 31 配对）：

```bash
export QUAIWEI_EVAL_KEY_A=...
python scripts/eval-dual/eval_dual.py \
  --url-a http://127.0.0.1:8326 --seats A --model qodercn/dfmodel \
  --arms-dir eval-work/arms --out eval-work/dfmodel
```

结果是**单席口径，不能直接拿票数与双席的 40/46 比大小**：双席 46 票、单席 23 票，
且 B 席呈反序用于抵消位置偏置。可比的是胜率方向、逐篇判定和「甲被选率是否偏离 0.5」。
换模型谱系（Qwen / DeepSeek vs glm-5.3-flash）是为了检验结论是否依赖某一个评委，
不是为了提高分数。

⚠️ 若用 DSH 本地网关（127.0.0.1:8326），先确认模型确实在 `/v1/models` 里且响应带
`reasoning_content`：该网关对**未登记**的 model id 不报 404，会返回 200 + 无推理内容的
桩响应，与任意虚构 ID 逐字段同构。只看 HTTP 200 会把桩当成调通。

## 4. 只复核归档（无需凭证 / 网络）

```bash
python scripts/eval-dual/eval_dual.py --summarize \
  --results evidence/eval-dual-2026-11-06/eval_dual_results.jsonl \
  --out eval-work/verify
```

应当复现：均分 `orig 76.2 / local09 68.9`、配对 `40/46 (0.9 档)` 与 `13/16 (0.6 档)`、
双席 `Pearson 0.666 / MAE 11.9`。`npm test` 里的
`scripts/eval-dual-consistency.test.ts` 会自动做同一套重算并核对 SCORECARD。

## 5. 门禁边界（2026-11-07 更正）

`check:release` 链含 `test:cov`（全量 vitest），所以
`scripts/eval-dual-consistency.test.ts` **已经在门禁里**：归档记录变了、或 SCORECARD 的能力数字
没跟着改，`npm run check:release` 会红。此前把这个测试说成「没接进门禁」是错的，已更正。

但**完整的双席配对盲测不能进门禁**：它需要两个 LLM 网关与凭证、154 次调用、约 6 分钟，
CI 拿不到。门禁守的是「归档证据 ↔ 页面数字一致」，不是「重新跑一遍评委」。
要重新验证能力，按第 2 节手动跑、跨批次复测并归档新证据。

## 6. A/B 能力验收（`ab_accept.py`）

`eval_dual.py` 评的是「引擎有没有效果」（固定 orig vs local09）；
`ab_accept.py` 评的是「**这次改动是不是更好**」——输入任意两臂产物目录。

为什么需要另一把尺：`aiScore` 与独立评委只有 0.353 相关，且它的构成奖励短句，
任何「少切句」的改动都会被判成「更像机器」。2026-11-07 三次切句收敛尝试全被它挡回，
详见 [`evidence/split-scale-2026-11-07/`](../../evidence/split-scale-2026-11-07/)。

```bash
export QUAIWEI_EVAL_KEY_A=...
python scripts/eval-dual/ab_accept.py \
  --arm-a arms/before --arm-b arms/after \
  --out out-ab --seats A --model qodercn/dfmodel
```

| 项 | 说明 |
|---|---|
| 臂目录 | `<id>.humanized.txt`（回退 `<id>.txt`），id 取 `scripts/realcase/cases.json` |
| `--corpus` | 改用任意语料目录（`*.txt`，排除 `.humanized.txt`）。**只在长文生效的改动必须换长文语料**：realcase 23 篇最长 453 字，实测切句收敛版两臂只有 1/23 篇不同，配对会退化成瞎猜 |
| `--model-a` / `--model-b` | 每席可用不同模型。**真双席应异源**（如 A=`qodercn/dfmodel` @8326、B=`glm-5.3-flash` @8080）；同源双席只能测反序，测不出评委模型本身的偏好 |
| 输出 | B 臂胜率、双席一致率、甲被选率（位置偏置）、二项单尾 p、逐篇 winner |
| 判定 | B 胜率显著 > 0.5（p < 0.05）才算「B 更好」；不显著只能说「测不出差别」 |
| 单席 | `firstArmChosen` 应接近 0.5。**实测单席 0.826**（2026-11-07，`qodercn/dfmodel`，23 票）⇒ 单席配对结果不可用，必须 `--mirror`（同一网关跑正反两遍）或真双席 |
| `--mirror` | 只有一个网关时用同一上游充当两席，B 席只负责反序呈现；调用量翻倍 |
| 离线复算 | `--summarize --results <jsonl>`，不需要凭证/网络 |

⚠️ 不接门禁：需要网关与凭证、每臂 23 次调用。门禁只守「归档证据 ↔ 页面数字一致」。

公共逻辑（call / parse / flip_for）刻意与 `eval_dual.py` 重复而不抽取——
后者已归档并被 `eval-dual-consistency.test.ts` 守着，不该为了 DRY 动它。

## 改动时别踩的坑

1. **`flip_for` 与 `SUB8` 是复现基线的一部分。** 改了呈现顺序或 0.6 档篇目，胜率就不能与归档比。
2. **别拿绝对分当能力刻度。** temperature=0 仍有跨批次漂移（同 8 篇改后稿 59.6 → 71.8，
   MAE 14.7）。任何能力数字必须双席 + 配对强制选择 + 跨批次复测。
3. **慢网关单请求 88~180s**，脚本超时设 200s；别换成长思考模型跑多轮。
4. **没有真人基线。** 23 篇全是模拟 AI 稿，只能量相对改善，不能量「距真人多远」或过检率。
5. `--local-rulers <json>` 是可选辅助（格式 `[{"id","arm","aiScore"}]`），缺了只跳过相关性段，
   不影响主判据。
6. 无 `--arms-dir` 时 `fidelityFailures` 输出 `null`（未检查），不是 `[]`（通过）。
