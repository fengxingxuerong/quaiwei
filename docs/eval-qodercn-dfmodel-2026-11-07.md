# 跨模型谱系复核：QoderCN DeepSeek-Flash 当评委（2026-11-07）

> 结论：**「方向有效」在另一个模型谱系上复现了；「绝对分降幅」被再次证伪。**
> 逐次记录在 [`evidence/eval-dfmodel-2026-11-07/`](../evidence/eval-dfmodel-2026-11-07/)，
> 基线在 [`evidence/eval-dual-2026-11-06/`](../evidence/eval-dual-2026-11-06/)。
> 本轮是**单席**复核，不取代 11-06 双席口径，只回答「结论是否依赖某一个评委」。

## 一、为什么要跑这一轮

`SCORECARD` 第 4 节与 [11-06 评测](eval-dual-2026-11-06.md) 都把这条写成局限：
两个席位都是 `glm-5.3-flash`（不同网关 / 不同凭证），**不是不同模型谱系**，独立性有限。
同日还发生过同文同模型隔批复测、改后稿均分从 59.6 漂到 71.8 的事故。

本轮把评委换成 QoderCN 的 `qodercn/dfmodel`（DeepSeek-Flash · x0.1），
被测引擎换成 **v0.9.84 当前 CLI 实产**（11-06 用的是 v0.9.83），其余 prompt、语料、
呈现顺序算法、配对判据一字不改。两件事一起变，所以这是一次**压力测试**，不是严格 A/B。

## 二、方法

| 项 | 设置 |
|---|---|
| 语料 | `scripts/realcase/cases.json` 全量 23 篇 |
| 改写臂 | v0.9.84 CLI 实跑 `0.9`（主）/ `0.6`（默认档子集），不复用 11-06 产物 |
| 评委 | `qodercn/dfmodel`，本地网关 `http://127.0.0.1:8326/v1` |
| 席位 | **单席 A**（`--seats A`），串行避 429 |
| 判据 1（辅） | 绝对分 0–100，越高越像 AI：23 × 2 = 46 次 |
| 判据 2（主） | 配对强制选择：23 篇（0.9 档）+ 8 篇（0.6 档）= 31 次 |
| 抗偏置 | 甲/乙按篇号奇偶轮换；温度 0 |
| 总量 | **77 次调用 / 0 错误 / 0 空分 / 0 解析失败**，耗时约 7 分 55 秒 |

凭证只走环境变量，不入库、不回显。

## 三、与 11-06 基线对比

`python scripts/eval-dual/compare.py <base> <new> --md` 实跑输出：

| 指标 | 11-06 基线 | 本轮 |
|---|---:|---:|
| 评委模型 | glm-5.3-flash（双网关） | qodercn/dfmodel |
| 席位 / 票数 | 双席 AB / 46 票 | 单席 A / 23 票 |
| 绝对分调用 | 92 | 46 |
| 配对调用 | 62 | 31 |
| 原文均分 | 76.2 | 83.7 |
| 0.9 档均分 | 68.9 | 83.7 |
| 均分降幅 | 7.3 | **0.0** |
| 0.9 档配对胜率 | **0.870**（40/46） | **0.826**（19/23） |
| 0.6 档配对胜率 | **0.812**（13/16） | **0.875**（7/8） |
| 0.9 档甲被选率 | 0.500 | 0.391 |
| 逐篇降幅方向一致 | — | 14/23 |

## 四、结论

1. **主判据跨谱系复现。** 换了模型谱系、换了被测引擎小版本，配对强制选择仍判
   82.6% / 87.5% 的改后稿更像人，与 11-06 的 87.0% / 81.2% 同向且同一量级。
   「方向有效」不是某一个评委的偏好。
2. **绝对分再次、且更彻底地被证伪。** 本轮两臂均分**完全相同（83.7 → 83.7，降幅 0.0）**，
   分布却没塌缩（orig 10~100、local09 25~98）——评委是在说「两臂一样像 AI」。
   同一批调用里配对题却有 82.6% 判改后更像人。
   ⇒ `SCORECARD` 第 4 节「别拿绝对分当能力刻度」这条规范不但成立，还拿到了跨模型证据。
   **本轮不产生任何新的「降了 X 分」能力数字。**
3. **聚合稳、逐篇不稳。** 逐篇降幅方向与基线只有 14/23 一致（61%）。
   别用单篇结果调引擎规则或做拦截门槛。
4. **保真仍干净。** 数字 / URL / 代码围栏 23/23 无失败，不靠删内容换分。

## 五、局限（比结论长是故意的）

- **单席口径**：票数只有双席一半，且没有 B 席反序。0.9 档甲被选率 0.391
  说明位置偏置未被完全抵消 ⇒ 引用能力数字**仍以 11-06 双席为准**，本轮只作方向性佐证。
- **两件事同时变了**：评委模型 + 引擎从 v0.9.83 → v0.9.84（含 CRLF 段分隔修复，
  会让 6 篇 CRLF 语料空行还原差 1 个空行）。所以差异不能单独归因给评委。
- **同一网关、同一账号**，没有跨账号 / 跨批次复测；`temperature=0` 仍有批次漂移。
- **没有真人基线**，23 篇仍全是模拟 AI 稿，量的是相对改善，不是「距真人多远」。
- **仍无任何官方检测器真值**（朱雀凭证 0/18），本轮不产生也不推导过检率。
- 网关侧坑：DSH 本地网关对**未登记** model id 不报 404，会返回 200 + 无
  `reasoning_content` 的桩响应，且桩能答算术/常识题。开跑前必须核对 `/v1/models`
  并确认响应带推理内容，不能只看状态码。

## 六、复现

```bash
# 1. 生成两档实产改写稿
npm run build:cli
node dist-cli/humanize-cli.mjs <in-dir> --out arms/09 --intensity 0.9 --suffix .humanized
node dist-cli/humanize-cli.mjs <in-dir> --out arms/06 --intensity 0.6 --suffix .humanized

# 2. 单席评测（凭证走环境变量，不落盘）
export QUAIWEI_EVAL_KEY_A=...
python -u scripts/eval-dual/eval_dual.py \
  --url-a http://127.0.0.1:8326 --seats A --model qodercn/dfmodel \
  --arms-dir arms --out out-dfmodel

# 3. 与基线对比 / 复核归档
python scripts/eval-dual/compare.py \
  evidence/eval-dual-2026-11-06/eval_dual_report.json \
  evidence/eval-dfmodel-2026-11-07/eval_dual_report.json --md
python scripts/eval-dual/eval_dual.py --summarize \
  --results evidence/eval-dfmodel-2026-11-07/eval_dual_results.jsonl --out verify
```

步骤细节见 [`scripts/eval-dual/README.md`](../scripts/eval-dual/README.md)。
