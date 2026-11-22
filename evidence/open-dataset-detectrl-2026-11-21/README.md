# 外部开源数据集测试 · NLPCC-2025 DetectRL-ZH · 2026-11-21

> 用**公开带标签**的中文人机文本数据集检验项目判据。此前项目只有自建语料 + 自评分
> aiScore，缺独立真值。本轮补上外部真值，得到一个**关键负面发现**。

## 一、数据来源

| 项 | 值 |
|---|---|
| 数据集 | NLPCC-2025 Shared-Task 1 / **DetectRL-ZH** dev.json |
| 出处 | https://github.com/NLP2CT/NLPCC-2025-Task1/tree/main/data/dev.json |
| 许可 | 竞赛共享任务公开数据（dev 集，明确「仅调参、不得训练」——本测试只读评测，合规） |
| 规模 | 2800 条：**human(label=0) 1100 / machine(label=1) 1700** |
| 机写来源 | GPT-4o / GLM-4-flash / Qwen-turbo（三种生成器） |
| 领域 | ASAP 社交评论 / CNewSum 新闻 / CSL 学术 |
| 长度 | human 中位 457 字 / machine 中位 615 字（**有长度差异，已分层**） |
| 本地副本 | `artifacts/open-datasets/detectrl-zh-dev.json`（gitignore，不入库） |

⚠️ `test_with_label.json`（含混合/释义/扰动攻击场景）多次下载失败（网络超时/连接重置），
本轮未测。已测 dev 集足够支撑本文主要结论。

## 二、检验 1：aiScore 的判别力（外部真值）

脚本 `scripts/open-dataset-auc.ts`，AUC = P(score_machine > score_human)，Mann-Whitney U 口径。

| 长度档 | n | H/M | **AUC** | score 中位 H/M |
|---|---:|---:|---:|---:|
| 短(<398字) | 698 | 432/266 | 0.615 | 14 / 20 |
| 中短(398-558) | 701 | 272/429 | **0.759** | 10 / 23 |
| 中长(558-742) | 701 | 188/513 | 0.603 | 11 / 15 |
| **长(≥742字)** | 700 | 208/492 | **0.398** | 13 / **8** |
| **总体** | 2800 | 1100/1700 | **0.575** | 12 / 15 |

阈值扫描（score≥t 判机器）：t=35 时 TPR 0.153 / FPR 0.036；t=27 时 TPR 0.260 / FPR 0.111。

### 关键发现
1. **总体 AUC 0.575** — 弱判别力，远达不到可用检测器水平。
2. **长文档 AUC 0.398 < 0.5（反向）**：machine 的中位 aiScore（8）**低于** human（13）。
   即 aiScore 系统性地把长篇 AI 文判成"更像人写"。这比项目此前"长文分不出"的结论
   更严重——不是分不出，而是**判反**。
3. 中短档 AUC 0.759 相对最好，但样本构成（H272/M429）不平衡。
4. 非单调的长度曲线（0.615→0.759→0.603→0.398）说明 aiScore 与"AI 性"的关系
   **受长度强调制**，不是稳定标尺。

⚠️ 边界：dev 集只有 text/label，**无 source/model 字段**，无法按生成器或领域分层；
本数据集的 machine 来自 GPT-4o/GLM/Qwen，与本项目自建语料的生成器不同谱系。
aiScore 的设计目标是"同篇前后相对比较"，本检验是**超范围使用**——但正因为超范围，
才暴露了把它当绝对刻度的风险。

## 三、检验 2：本地引擎改写前后（外部语料独立对照）

脚本 `scripts/open-dataset-rewrite.ts`：取 machine 样本按长度分层各 8 篇（共 24 篇），
3 seed × intensity 0.9，本地确定性引擎。

| 指标 | 值 |
|---|---:|
| 改写次数 | 24 篇 × 3 seed = 72 |
| 字数范围 | 454~774 |
| aiScore 中位 | 16 → **8** |
| 降幅 | 均值 -9.44 / 中位 -8 |
| 下降篇占比 | 66.7% |
| 硬保真失败 | **0/72 = 0%**（数字/单位/URL/英文专名全保住） |

结论：本地引擎在外部语料上**降分有效、保真零失败**，与自建 realcase 的结论一致。

⚠️ 但结合检验 1 必须诚实解读：**降的是自评分 aiScore，不等于更接近真人**。
外部真值显示 aiScore 本身在长文档上会判反（AUC 0.398），所以"aiScore 降了"
只能说明"引擎按自己的判据在动"，不能当作"改后更像人"的证据。真正的能力口径
仍需双席 A/B 盲测（见 `evidence/eval-local-glm-2026-11-21/` 等）。

## 四、对项目的意义

- ✅ 外部公开标注**印证**了项目一直坚持的口径纪律：aiScore 是相对指标、真人基线中位 35、
  长文象限分不出——本轮进一步发现**长文判反**（AUC 0.398）。
- ✅ 本地引擎保真在独立语料上 0 失败，是稳健的正结果。
- 🔴 若要提升"判别力"这一能力（而非"改写降分"），需要新的判据，且必须单独立项 +
  外部带标签数据集交叉验证（本次的 DetectRL-ZH dev 可作测试集，但要遵守"不得训练"约束）。
- 本轮不更新 SCORECARD（aiScore 判别力本就不是 SCORECARD 的能力项）。

## 五、检验 3：长文判反的分项归因

脚本 `scripts/open-dataset-attribution.ts`，拆长文档(≥742字，H208/M492)各评分分项：

| 分项 | H 中位 | M 中位 | AUC | 方向 |
|---|---:|---:|---:|---|
| **avgLen（平均句长）** | 32.9 | **24.8** | **0.202** | M 更短 → 判人（主因） |
| **burstiness（句长变异）** | 0.53 | 0.49 | 0.388 | M 更低 → 判人 |
| sentenceCount（句数） | 26 | 34 | 0.756 | M 更多 → 判 AI |
| formulaicHits（套话） | 0 | 1 | 0.592 | M 更多 → 判 AI |
| broken/structure/typo | 0 | 0 | ≈0.5 | 无差异 |

**判反主因 = 句长**：这些机写长文本本身已碎句化（平均句长 24.8 < 真人 32.9、句数更多），
恰好撞上 aiScore「奖励短句」的偏好 → 被判成人写。反方向的套话/句数权重不足以抵消。
这与项目 history 高度一致：碎句化是长期风险，切句收敛曾因双席 90 票只赢 20（0.222）被判退化。

## 六、检验 4：改写后人机可分性是否收敛（关键负面发现）

脚本 `scripts/open-dataset-auc-after.ts`：对 machine 样本 300 篇跑本地引擎改写（3 seed），
重算「改写稿 vs human」的 aiScore AUC。这是外部真值下「工具是否有效」的直接检验——
比自评分降幅更有意义。

| 范围 | 改写前 AUC | 改写后 AUC（3 seed 中位） |
|---|---:|---:|
| 全体 | 0.6153 | **0.2971** |
| 长文档(≥742字) | 0.3815 | **0.3317** |

逐 seed 极稳（全体 0.2968~0.2987、长文 0.3291~0.3333）。

### 双重解读（必须同时讲）
- **规避检测角度**：改写后 machine 得分远低于 human（AUC 0.297 < 0.5），
  用 aiScore 当检测器会把改写稿判成「人写」——**规避有效**。
- **「更像人」角度**：AUC 越接近 0.5 才越「人机难分」。0.297 远离 0.5（|差|=0.203），
  说明 aiScore 仍能以可观把握把改写稿和真人分开（只是判到了另一侧），
  ⇒ **不能声称「改后更像人」**，只能说「骗过了这个特定判据」。
- **机制**：本地引擎疯狂碎句化 → aiScore 奖励短句 → 分大降。这个「降」是判据漏洞，
  不是真的更像人。与检验 3 的归因、项目切句收敛的阴性结论一脉相承。

⚠️ 边界：这里用的是本地引擎 + aiScore（自评分）。真正的「像人」判定仍需双席 A/B 盲测
（见 `evidence/eval-local-glm-2026-11-21/` 等，那个才是独立评委口径）。

## 七、复现

```bash
# 数据下载（Node fetch 更稳；curl 会连接重置）
node -e "const fs=require('fs');fetch('https://raw.githubusercontent.com/NLP2CT/NLPCC-2025-Task1/main/data/dev.json').then(r=>r.arrayBuffer()).then(b=>fs.writeFileSync('artifacts/open-datasets/detectrl-zh-dev.json',Buffer.from(b)))"

cd /d/projects/quaiwei
npx tsx scripts/open-dataset-auc.ts          # 检验1：判别力 AUC
npx tsx scripts/open-dataset-rewrite.ts      # 检验2：改写前后降分/保真
npx tsx scripts/open-dataset-attribution.ts  # 检验3：长文判反归因
npx tsx scripts/open-dataset-auc-after.ts    # 检验4：改写后可分性
```

## 八、产物

- `auc-report.json` — 2800 条 aiScore vs 外部标签的完整读数
- `rewrite-report.json` — 72 次改写的逐条记录
- `attribution-report.json` — 长文判反分项归因
- `auc-after-report.json` — 改写后人机可分性 AUC（3 seed）
- 脚本 `scripts/open-dataset-{auc,rewrite,attribution,auc-after}.ts`
