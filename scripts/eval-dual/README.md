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

## 改动时别踩的坑

1. **`flip_for` 与 `SUB8` 是复现基线的一部分。** 改了呈现顺序或 0.6 档篇目，胜率就不能与归档比。
2. **别拿绝对分当能力刻度。** temperature=0 仍有跨批次漂移（同 8 篇改后稿 59.6 → 71.8，
   MAE 14.7）。任何能力数字必须双席 + 配对强制选择 + 跨批次复测。
3. **慢网关单请求 88~180s**，脚本超时设 200s；别换成长思考模型跑多轮。
4. **没有真人基线。** 23 篇全是模拟 AI 稿，只能量相对改善，不能量「距真人多远」或过检率。
5. `--local-rulers <json>` 是可选辅助（格式 `[{"id","arm","aiScore"}]`），缺了只跳过相关性段，
   不影响主判据。
6. 无 `--arms-dir` 时 `fidelityFailures` 输出 `null`（未检查），不是 `[]`（通过）。
