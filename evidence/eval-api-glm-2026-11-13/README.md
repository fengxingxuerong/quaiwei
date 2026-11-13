# 路径一（--api 单轮 LLM 改写）首轮双判据评测 · 2026-11-13

> 产品主路定标（路径一 = `--api` 单轮 LLM 改写）后的首轮实产评测。
> **口径：单席 + 评委与改写同源（glm-5.3-flash），只能作方向性证据，不能当正式能力数字引用。**

## 一、怎么跑的

| 项 | 设置 |
|---|---|
| 改写臂 | 当前 CLI 实跑 `--api --no-deep --base-url http://127.0.0.1:8080/v1 --model glm-5.3-flash --jobs 1 --llm-timeout 300 --seed 20260905` |
| 语料 | `scripts/realcase/cases.json` 全量 23 篇（53~453 字） |
| 档位 | 0.9 档 23 篇 + 0.6 档 23 篇（配对只用 SUB8 8 篇） |
| 评委 | 单席 A = `127.0.0.1:8080` `glm-5.3-flash`（本机 zcode-proxy），77 次调用 / 720s / 0 错误 |
| 纯度 | `usedApi=true` 23/23（两档都是）——首轮因 90s 默认超时 + 429 出现 21/19 篇本地回退污染，已整体作废重跑 |
| 保真 | 数字/URL/代码围栏：**1 篇失败（C16）**，详见第四节 |

## 二、主判据：配对强制选择（单席）

| 档位 | 票 | 判改后更像人 | 胜率 | 甲被选率 |
|---|---:|---:|---:|---:|
| 0.9 | 23 | 21 | **0.913** | 0.391 |
| 0.6（默认档子集） | 8 | 6 | **0.750** | 0.375 |

二项单尾 p ≈ 3.3e-5（21/23，n=23, p0=0.5）。**甲被选率 0.391 偏离 0.5**——单席没有 B 席反序，位置偏置只部分抵消（与 2026-11-07 dfmodel 单席 0.391 一致），引用时必须带此星号。

## 三、辅判据：绝对分（只作参考，不作能力刻度）

| 臂 | 均分 | 对照 11-06 双席基线（本地引擎臂） |
|---|---:|---|
| orig | 77.2 | 76.2（同语料同评委模型，校准一致） |
| api09 | 56.1（降幅 21.1） | local09 68.9（降幅 7.3） |

逐篇 9 篇 ≤0（含 C8 社交贴 15→80 大反向：原文本来人味就重）。绝对分两次被跨批次/跨模型复测证伪过（漂移 MAE 14.7 / 降幅 0.0），此处数字只说明"这轮评委读数"，**不得写成"多降 X 分 = 更强"**。

## 四、保真：C16 新增了原文没有的派生数字

- 原文 7 个数字（2025 / 32.68 / 21.4 / 4.27 / 15.8 / 6.92 / 21.18）**全部保留，无丢失**；
- 改写新增「比营收增速低了 **5.6** 个百分点」——21.4 − 15.8 的算术派生，数值正确，但属于原文没有的新增事实；
- 数字保真守卫（v0.9.75）只查"原有数字必须在"，**不查新增**——这类要靠 `--strict` 终审拦截。
- **落地建议：公文/招股/财报类稿子走 `--api` 必须开 `--strict`。**

## 五、结论与边界

1. **方向性证据成立**：--api 单轮 LLM 改写臂在单席配对里 91.3% / 75.0% 判改后更像人，与 11-06 本地引擎臂（87.0% / 81.2%，双席）同向同量级。
2. **不能引用为正式能力数字**：单席 + 自源评委（改写与裁判同一个模型，自评偏好方向未知）+ 位置偏置未完全抵消。正式口径需双席异源（A=glm @8080 / B=dfmodel @8326，或等 sensenova 额度恢复跑 deepseek-v4-flash 臂 + glm 裁判）。
3. 无官方检测器真值（历史凭证 0/18），本轮不产生、不推导过检率。
4. 语料全是模拟 AI 稿，无真人基线，量的是相对改善。

## 六、复现

```bash
# 改写臂（约 80 分钟，串行）
$env:QUAIWEI_API_KEY = "<zcode-proxy key>"
node dist-cli/humanize-cli.mjs eval-work/in --out eval-work/arms-api/09 --intensity 0.9 --suffix .humanized `
  --api --no-deep --base-url http://127.0.0.1:8080/v1 --model glm-5.3-flash --seed 20260905 --jobs 1 --llm-timeout 300
node dist-cli/humanize-cli.mjs eval-work/in --out eval-work/arms-api/06 --intensity 0.6 --suffix .humanized `
  --api --no-deep --base-url http://127.0.0.1:8080/v1 --model glm-5.3-flash --seed 20260905 --jobs 1 --llm-timeout 300

# 评委 + 对比
$env:QUAIWEI_EVAL_KEY_A = "<同上>"
py -3.12 scripts/eval-dual/eval_dual.py --url-a http://127.0.0.1:8080 --seats A --model glm-5.3-flash `
  --arms-dir eval-work/arms-api --out eval-work/out-api-glm
py -3.12 scripts/eval-dual/compare.py evidence/eval-dual-2026-11-06/eval_dual_report.json `
  eval-work/out-api-glm/eval_dual_report.json --md
```

`eval-work/in` 由 `scripts/realcase/cases.json` 展开（见 `scripts/eval-dual/README.md` §1）。
LLM 产出不可复现（同 prompt 不同批次输出不同），本目录 `arms-09/`、`arms-06/` 为当日实产留档。
