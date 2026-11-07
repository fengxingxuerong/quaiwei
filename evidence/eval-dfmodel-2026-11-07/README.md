# 跨模型谱系复核 · 原始证据（2026-11-07）

用 **QoderCN `qodercn/dfmodel`**（DeepSeek-Flash · x0.1）当独立评委，把 2026-11-06 那轮
配对盲测在**另一个模型谱系**上重跑一遍。目的不是刷分，是检验「方向有效」这个结论
是否只是 `glm-5.3-flash` 一个评委的偏好。

## 文件

| 文件 | 内容 |
|---|---|
| `eval_dual_results.jsonl` | **77 条逐次调用**：46 条绝对分 + 31 条配对强制选择，全部 `err: null` |
| `eval_dual_report.json` | 汇总（均分、胜率、逐篇降幅、保真检查） |
| [`../../docs/eval-qodercn-dfmodel-2026-11-07.md`](../../docs/eval-qodercn-dfmodel-2026-11-07.md) | 方法、与基线对比表、结论与局限 |
| [`../../scripts/eval-dual/`](../../scripts/eval-dual/) | 复现脚本（`--seats A --model qodercn/dfmodel`）与 `compare.py` |

## 口径（别读错）

| 项 | 值 |
|---|---|
| 被测引擎 | **v0.9.84** 当前 CLI（HEAD `10b9026`），当日 `npm run build:cli` 重建后实跑 |
| 语料 | `scripts/realcase/cases.json` 全量 23 篇 |
| 改写臂 | 实跑 `--intensity 0.9` / `0.6`，**不复用** 11-06 的产物 |
| 评委 | `qodercn/dfmodel`，经本地网关 `http://127.0.0.1:8326/v1` |
| 席位 | **单席 A**（`--seats A`）：77 次调用，0 错误 / 0 空分 / 0 解析失败 |
| 分数方向 | 0–100，**越高越像 AI** |
| 抗偏置 | 甲/乙位置按篇号奇偶轮换；**单席没有 B 席反序**，故位置偏置只部分抵消 |

⚠️ **单席 23 票不能与双席 46 票直接比大小**。可比的是胜率方向、逐篇判定与
「甲被选率是否偏离 0.5」。

## 三条读数

1. **主判据跨谱系复现**：0.9 档 **19/23 = 82.6%**、0.6 档 **7/8 = 87.5%** 判改后更像人；
   11-06 双席基线为 87.0% / 81.2%。方向一致，未出现「换个评委就翻盘」。
2. **绝对分彻底不可用**：原文 83.7 → 0.9 档 83.7，**降幅 0.0**；
   分布并未塌缩（orig 10~100、local09 25~98），是评委认为两臂「一样像 AI」。
   同一批评委在配对题里却有 82.6% 判改后更像人 ⇒ 再次印证
   **「绝对刻度不稳、相对比较稳」**，别拿降幅当能力刻度。
3. **单席有位置偏置残留**：0.9 档甲被选率 **0.391**（双席基线 0.500）。
   这正是双席反序设计存在的理由；要引用胜率数字，仍以 11-06 双席口径为准。

保真：数字 / URL / 代码围栏 **0 失败（23/23）**。
逐篇降幅方向与 11-06 基线一致 **14/23** —— 聚合方向稳，逐篇判断并不稳。

## 脱敏与完整性

凭证只从环境变量 `QUAIWEI_EVAL_KEY_A` 读取，不入库、不回显。
归档前对 `sk-` / `nvapi-` / `rc-` / `Bearer` / `api_key` / `token` 及网关 key 字面量扫描，
两文件命中均为 **0**；JSONL 只有分数、篇目 id、席位、单字选择，无正文、无凭证。
77 条 key 全唯一。

## 复核

```bash
python scripts/eval-dual/eval_dual.py --summarize \
  --results evidence/eval-dfmodel-2026-11-07/eval_dual_results.jsonl \
  --out eval-work/verify-dfmodel

python scripts/eval-dual/compare.py \
  evidence/eval-dual-2026-11-06/eval_dual_report.json \
  evidence/eval-dfmodel-2026-11-07/eval_dual_report.json --md
```

全量重跑见 [`scripts/eval-dual/README.md`](../../scripts/eval-dual/README.md) 第 3 节。
需要先确认 `qodercn/dfmodel` 在网关 `/v1/models` 里且响应带 `reasoning_content`：
该网关对未登记 model id 会返回 200 + 无推理内容的桩响应，只看状态码会把桩当成调通。
