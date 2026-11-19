# 路径一（--api 单轮 LLM 改写）双席异源正式轮 · 2026-11-19

> A 席（glm-5.3-flash @8080）票来自 [evidence/eval-api-glm-2026-11-13/](../eval-api-glm-2026-11-13/)，
> B 席（qodercn/dfmodel @18326 OFM 中继）本轮新投，改写臂与 A 席完全同一批（`eval-work/arms-api`，23/23 纯 LLM）。
> **本轮即路径一的正式能力口径**：两席不同模型谱系（GLM vs DeepSeek-Flash），评委与改写不同源。

## 一、主判据：双席合并配对强制选择

| 档位 | 票 | 改写臂赢 | 合并胜率 | A 席（glm） | B 席（dfmodel） | 双席逐篇一致 | 甲被选率 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 0.9 | 46 | 41 | **0.891**（p≈4.5e-13） | 21/23 | 20/23 | 87.0%（20/23） | 0.370 |
| 0.6（默认档子集） | 16 | 12 | **0.750**（p≈2.4e-4） | 6/8 | 6/8 | **100%**（8/8） | 0.375 |

对照基线（11-06 双席同模型 glm，本地引擎臂）：87.0% / 81.2%，一致率 82.6%。
**方向、量级同向，--api 臂 0.9 档略高（89.1% vs 87.0%），0.6 档略低（75.0% vs 81.2%）。**

## 二、绝对分跨席（只作参考，不作能力刻度）

| 臂 | A 席均值 | B 席均值 | 跨席 Pearson | MAE |
|---|---:|---:|---:|---:|
| orig | 77.2 | 89.3 | 0.481 | 13.4 |
| api09 | 56.1 | 59.2 | 0.099 | 31.1 |

改写稿上两席逐篇几乎不相关（0.099 / MAE 31.1）——再次坐实「绝对分不可当能力刻度」；
但两席均值都大幅低于各自 orig 均值（77.2→56.1、89.3→59.2），方向一致。

## 三、保真

fidelityFailures 两席口径一致：仅 **C16-prospectus-risk**（LLM 新增算术派生数「低 5.6 个百分点」，
无数字丢失）。仓库 v0.9.88 已落 `addedNumericFacts`（commit 581b432）针对此类新增事实，
本轮评测臂产自 v0.9.86 CLI，守卫修复未在臂中生效——**下轮复测应确认该失败消失**。
公文/招股/财报类用 `--api` 建议始终开 `--strict`。

## 四、方法与坑（复现须知）

| 项 | 值 |
|---|---|
| B 席通道 | `http://127.0.0.1:18326`（OFM 中继，key 为 `.dsh/our-free-model/settings.json` 的 `chanGateway.relay.key`） |
| B 席模型 | `qodercn/dfmodel`（DeepSeek-Flash · x0.1，与 11-07 跨谱系轮同一评委模型，直接可比） |
| 调用量 | 77 次（46 绝对分 + 31 配对）/ 508s / 0 错误 |
| 合并脚本 | `scripts/eval-dual/merge_two_seats.py <A.jsonl> <B.jsonl> <out.json>`（离线） |
| 坑 1 | 8326 直连 401；真正的 DSH 模型目录经 OFM 中继 18326 暴露，key 为 ofm- 前缀 |
| 坑 2 | OFM 对未登记 id 也会 200——开跑前必须验 `reasoning_content` 非空（本轮已验） |
| 坑 3 | **两席同序**：两次都是 `--seats A`（flip_for 按篇号奇偶轮换，但两席未反序），甲被选率 0.370 偏离 0.5 ⇒ 位置偏置未被反序抵消。与 11-06「两席反序」设计有差距；方向性结论稳健（两席独立同向），精确幅度留待真反序复测 |

## 五、结论

1. **路径一（--api 单轮 LLM 改写）拿到双席异源正式口径：89.1% / 75.0% 判改后更像人**，
   与本地引擎臂基线同向同量级——「改写更像人」不再依赖单一评委谱系，也不再是改写模型自评。
2. 合并 p≈4.5e-13（0.9 档），效应显著。
3. 仍无官方检测器真值（0/18），本轮依旧不产生、不推导过检率。
4. 语料为 23 篇模拟 AI 短稿（53~453 字），长文象限与真人基线仍是空白。

## 六、复现

```bash
# B 席（约 8.5 分钟）
$env:QUAIWEI_EVAL_KEY_A = "<ofm relay key>"
py -3.12 scripts/eval-dual/eval_dual.py --url-a http://127.0.0.1:18326 --seats A `
  --model qodercn/dfmodel --arms-dir eval-work/arms-api --out eval-work/out-api-dfmodel

# 合并
py -3.12 scripts/eval-dual/merge_two_seats.py `
  eval-work/out-api-glm/eval_dual_results.jsonl `
  eval-work/out-api-dfmodel/eval_dual_results.jsonl `
  eval-work/out-api-dual/merged_report.json
```

A 席复现见 [evidence/eval-api-glm-2026-11-13/README.md](../eval-api-glm-2026-11-13/README.md)。
