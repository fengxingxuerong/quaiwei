# 双网关配对盲测 · 原始证据（2026-11-06）

这一目录是 `SCORECARD.md` 第 4 节所有能力数字的**唯一出处**。此前两轮单席绝对分结论
（「降 23.6 分」「81.6 分好用区间」）都因为没有可复核的原始记录而作废，所以本目录只做一件事：
把逐次调用的原始结果留在仓库里，让第三人能自己重算。

## 文件

| 文件 | 内容 |
|---|---|
| `eval_dual_results.jsonl` | **154 条逐次调用**：92 条绝对分 + 62 条配对强制选择。每行含 key / kind / id / seat / 分数或选择 / 原始回包前 60 字 / 错误 |
| `eval_dual_report.json` | 当日汇总（均分、胜率、双席一致性、本地两把尺相关性、逐篇降幅、保真检查） |
| [`../../docs/eval-dual-2026-11-06.md`](../../docs/eval-dual-2026-11-06.md) | 方法、结果、局限、结论作废清单 |
| [`../../scripts/eval-dual/`](../../scripts/eval-dual/) | 参数化后的复现脚本与步骤 |

`scripts/eval-dual-consistency.test.ts` 从 JSONL 重算全部关键数字，并核对 `SCORECARD.md` 的数字串。
记录变了或页面没跟着改，测试会红。

## 口径（别读反）

- 分数 **0–100，越高越像 AI**（`100=绝对是 AI 生成`，`0=绝对是人写`）。2026-09-15 那份
  「11 篇全过线、均值 81.6」就是把这把尺读反了。
- **主判据是配对强制选择**（原文 vs 改后稿随机甲乙、两席反序，问「哪段更像 AI」），
  不是绝对分降幅。双席 Pearson 只有 0.666、MAE 11.9，且同文隔日复测改后稿均分从 59.6 漂到 71.8
  ⇒ 单席绝对分不可作能力刻度。
- 语料是 `scripts/realcase/cases.json` 的 23 篇**模拟 AI 稿**，**没有真人基线**。
  量的是相对改善，不是「距真人多远」，更不是过检率。
- 两个席位都是 `glm-5.3-flash`（不同网关 / 不同凭证），独立性有限，不是不同模型谱系。

## 脱敏与完整性

- 归档前逐文件扫过 `sk-` / `nvapi-` / `rc-` / `Bearer` / `api_key` / `token`，命中 0。
  JSONL 里只有分数、篇目 id、席位、单字选择，没有凭证、没有正文。
- 凭证在评测时只从环境变量 `QUAIWEI_EVAL_KEY_A` / `QUAIWEI_EVAL_KEY_B` 读取，**不入库、不回显**。
- 154 条 key 全唯一，0 错误、0 空分、0 解析失败。

## 版本边界

数据由 **v0.9.83**（HEAD `c9e6517`）当日构建的 `dist-cli/` 产出。v0.9.84 只新增
`--skip-low-risk` / `--audit-structure` 两个开关并修了 CRLF 段分隔（`(?:\\r\\n|\\n)+`），
后者会让 6 篇 CRLF 语料的空行还原与当日产物差 1 个空行，非空行内容不变。
**v0.9.84 未重跑双网关评测**；引用这些数字时请连同版本一起写，别当成当前版本的实时测量。

## 复核

```bash
# 不需要任何凭证或网络，只按归档记录重算
python scripts/eval-dual/eval_dual.py --summarize \
  --results evidence/eval-dual-2026-11-06/eval_dual_results.jsonl \
  --out /tmp/quaiwei-eval-verify
```

全量重跑（需自备两个 OpenAI 兼容网关）见 [`scripts/eval-dual/README.md`](../../scripts/eval-dual/README.md)。
