# --api v0.9.89 复测 · 2026-11-21（完成：臂生成 + C16 验证 + GLM 双席配对）

> 目标：用 v0.9.89 CLI 重生成 `--api` 改写臂，确认 `addedNumericFacts` 修复后
> C16 的「新增 5.6 个百分点」失败消失，并跑双席配对复核 11-19 的 0.9 档口径。
> **本轮完成前两项，并用 GLM mirror 双席拿到方向性能力口径**（95.7% 判改后更像人，
> 甲被选率 0.5，双席一致 91.3%）。0.6 臂因网关 502 污染作废，异源双席因上游 key 池故障未跑。

## 一、做了什么

| 项 | 设置 |
|---|---|
| CLI | `dist-cli/humanize-cli.mjs`（v0.9.89，`npm run build:cli` 现构建） |
| 网关 | `http://127.0.0.1:18326/v1`，改写模型 `deepseek-auto/lobsterai/glm-5.3-flash`（GLM 谱系） |
| 参数 | `--api --no-deep --seed 20260905 --jobs 3 --llm-timeout 300`，两档 intensity 0.9 / 0.6 |
| key | 从本地 OFM settings 经 env 传入，不落盘、不回显 |
| 语料 | `scripts/realcase/cases.json` 全量 23 篇（53~453 字），`eval-work/in/` |

## 二、臂生成结果

| 档 | usedApi | 总数 | 可用性 |
|---|---:|---:|---|
| 0.9 | **23/23** | 23 | ✅ 纯 LLM，用于本轮评测 |
| 0.6 | 2/23 | 23 | ❌ 21 篇本地引擎回退（网关 502），作废 |

- 0.9 档：1m30s（并发 3），AI 味代理分均值 33→24，字数 5507→5945。
- 0.6 档：2m38s，末尾 21 篇连续 502「matched user group has no available model instance」
  ⇒ 本地回退污染，整批作废。**不用于任何能力数字。**

## 三、保真验证（0.9 干净臂，全 23 篇）

判据：`addedNumericFacts` + `missingNumericFacts`（`src/engine/number-fidelity.ts`）。

- **C16-prospectus-risk：通过。** 11-13 那轮产出新增「比营收增速低了 5.6 个百分点」
  （21.4−15.8 的算术派生，原文没有）；本轮新臂保留原文全部 7 个数字
  （2025 / 32.68 / 21.4 / 4.27 / 15.8 / 6.92 / 21.18），**未产生 5.6 派生数**。
- 全 23 篇：22 篇数字保真全过；**1 篇新失败 C23-frontmatter-indent**——
  LLM 把原文的 YAML frontmatter（`date: 2026-10-18`）整块吞掉，丢了 2026/10/18 三个数字。
  11-13 旧臂保留了 frontmatter，本轮是新的非确定性回归，与 `addedNumericFacts` 修复无关。
- 结论：**C16 的新增派生数本轮未复现**，但 LLM 非确定性使保真问题此起彼伏（C16→C23），
  单轮不能证明「修复」。真正保障在代码层：`addedNumericFacts` 已能检测此类派生数，
  `--strict` 下 `FabricationVetoError` 回退原稿（`src/api/llm-humanize.ts:452`），
  单测 `number-fidelity.test.ts:165` 覆盖。

## 四、双席配对评测（GLM mirror）

### 通道选择经过

0.9 臂生成后 OFM key 池的 chat 上游全挂（`/v1/models` 200、chat 全 502）；SenseNova 三 key
全限流；8080 无匹配 key。穷举本地 glm 变体后发现 **`glm/glm-5.3-flash` + `reasoning_effort=low`**
可稳定 200（该模型始终思考，不传此参数报 1210）。用户指定「只要本地 glm」⇒ 采用 mirror 模式。

### 结果

| 指标 | 值 |
|---|---|
| 配对票 | 46（23 篇 × 2 席） |
| B 臂（改写稿）被选「更像 AI」 | 2/46 = 0.043 |
| **B 臂被选「更像人」（反向）** | **44/46 = 0.957** |
| p（B 更像人，单尾二项） | **1.5e-11** |
| 双席一致 | 0.913（21/23 两席同判） |
| 甲被选率 | 0.500（mirror 反序完美抵消位置偏置） |
| 错误 | 0 |
| 逐篇 | A 胜 21、split 2、B 胜 0 |

**A 臂 = 原文（`eval-work/in`），B 臂 = v0.9.89 --api 改写稿（`arms-api-v0989/09`）。**
评委 prompt 问「哪段更像 AI」（`PAIR_SYS`），故 `bWin` 字段原义是「B 更像 AI」，
反向 `(n−bWin)` 才是「B 更像人」。`ab_accept.py` 旧打印把 `bWin` 误写成「更像人」，
本轮已更正打印与 p 值口径（字段定义未动，保持归档可比）。

### 与历史对比

| 轮次 | 口径 | 改后更像人 | 甲被选率 |
|---|---|---:|---:|
| 11-06 本地引擎臂 | 双席异源（glm/glm） | 87.0% | — |
| 11-19 --api 臂 | 双席异源（glm/dfmodel），同序 | 89.1% | 0.370（偏置未消） |
| **11-21 --api v0.9.89** | **GLM mirror，B 反序** | **95.7%** | **0.500（已消）** |

方向一致且更极端。但 95.7% 高于历史 87-89%，**不能简单读成「v0.9.89 更强」**：
① 改写臂来自不同批次 LLM，语料非同一臂；② 评委只剩单一 GLM 谱系（同源 mirror，
非异源）；③ `reasoning_effort=low` 是新参数，历史轮未用。这是**方向性旁证**，不是标定。

## 五、边界

- 本轮能力数字是**单一 GLM 评委 + 同源 mirror** 的方向性口径，不更新 SCORECARD。
  正式能力数字仍需异源双席（DeepSeek 通道恢复后补跑）。
- 0.6 臂污染已隔离，不产生 0.6 档数字。
- `--api` 臂由 LLM 生成，不可复现；C16/C23 保真表现是单轮观测，非稳定性结论。
- 评委 prompt 问「更像 AI」，「更像人」是反向推断，不是评委直接判定。

## 六、复现

```bash
# 1. 改写臂（需 OFM 网关，23 篇约 1m30s）
KEY=$(node -e "const fs=require('fs');process.stdout.write(JSON.parse(fs.readFileSync(process.env.USERPROFILE+'/.dsh/our-free-model/settings.json','utf8')).chanGateway.relay.key)")
QUAIWEI_API_KEY="$KEY" env -u NODE_OPTIONS node dist-cli/humanize-cli.mjs eval-work/in \
  --out eval-work/arms-api-v0989/09 --intensity 0.9 --suffix .humanized \
  --report eval-work/report-v0989-09.json --api --no-deep \
  --base-url http://127.0.0.1:18326/v1 --model deepseek-auto/lobsterai/glm-5.3-flash \
  --seed 20260905 --jobs 3 --llm-timeout 300

# 2. GLM mirror 双席（reasoning_effort=low 必传；B 席自动反序 + 继承 A 模型/参数）
QUAIWEI_EVAL_KEY_A="$KEY" QUAIWEI_EVAL_KEY_B="$KEY" py -3.12 \
  scripts/eval-dual/ab_accept.py --arm-a eval-work/in --arm-b eval-work/arms-api-v0989/09 \
  --url-a http://127.0.0.1:18326 --model-a glm/glm-5.3-flash --reasoning-effort-a low \
  --mirror --seats AB --out eval-work/ab-v0989-glm
```

## 七、产物

- `ab_report.json` / `ab_results.jsonl` — 双席汇总与逐票原始记录
- `status.json` — 臂生成状态、保真结果（机器可读）
- 臂/报告在 `eval-work/`（gitignore，不入库）
