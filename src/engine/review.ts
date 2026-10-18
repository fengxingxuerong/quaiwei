/**
 * 审题模式（detector-only）——**只给人看痕迹地图，一个字都不改**。
 *
 * 起因（2026-10-17 开源同类对标）：同赛道 `petergyang/no-ai-slop`（12.4k★）除改写外还提供一个
 * detect 模式（dry-run，只标不改）；本仓库当时的能力缺口是——`--explain` 只能解释**已经改完**
 * 的结果，用户没有「先验稿、再决定要不要改」这一步。
 *
 * 设计取舍：
 * 1. **不另写一套打分**。直接复用 `detector.ts` 的 `segmentRisk`，让「评分」与「痕迹地图」
 *    永远用的是同一个判据——否则两处迟早漂移。为此给 `segmentRisk` 补了 `reasons` 全量返回。
 * 2. **按文档顺序输出**，不按风险排序。用户要顺着读下去改东西，Top-N 排序会让他来回跳。
 *    注意 `DetectReport.topSegments` 是按风险降序的，两者定位不同。
 * 3. **低于门槛的句子不列**。门槛 40 取在 detector 的 medium 阈值（32）之上一点：
 *    32 是「疑似 AI 辅助」的判档线，审题是给人看具体句子，太松会淹没真信号。
 * 4. **正向特征不给建议**。「有主观视角 / 有具体细节 / 短句 / 疑问句」是减风险的项，
 *    它们出现在 reasons 里是解释为什么这句分数低，不是待办事项。
 * 5. **AI 参与比例与样本置信度（2026-10-19 竞品吸收（三）：harshaneel/humanize
 *    ai-check 的对应物）**。比例与 marks 同门槛——地图上列出的句 == 计入比例的句，
 *    两个数字不许打架；置信度按篇幅分档且带限定语，"短文本统计不稳"要说出来。
 */

import { detectAI, segmentRisk, splitSentences, type DetectReport } from "./detector";

export interface ReviewMark {
  /** 句序号（从 1 起，对着正文读方便） */
  index: number;
  sentence: string;
  /** 该句风险 0~100，与 detector 同一刻度 */
  risk: number;
  severity: "high" | "medium" | "low";
  severityText: string;
  /** 命中原因（可能多条，含减分列的正向特征） */
  reasons: string[];
  /** 针对负向特征的建议，可能为空 */
  suggestions: string[];
}

/** 样本置信度档位：短文本统计不稳，宁说明白不给错觉 */
export interface ReviewConfidence {
  level: "low" | "medium" | "high";
  /** 一句话说明（含限定语，供面板/CLI 直接展示） */
  text: string;
}

export interface ReviewReport {
  /** 全文综合代理分（本地启发式，非任何检测器官方分） */
  probability: number;
  levelText: string;
  /**
   * AI 参与比例（本地估计，0~100 整数）：达到痕迹门槛的句子占全文可见字符的
   * 百分比（harshaneel/humanize ai-check 的 "AI 编辑比例" 对应物）。
   * 与 marks 同一门槛口径：地图上列出的句子 == 计入比例的句子，两个数字不打架。
   */
  editedRatio: number;
  confidence: ReviewConfidence;
  /** 句子总数 */
  total: number;
  /** 达到门槛、被列出的句数 */
  marked: number;
  marks: ReviewMark[];
  /** 负向原因出现次数的降序统计，先看最多的那类 */
  summary: Array<[string, number]>;
  warnings: string[];
  report: DetectReport;
}

/** 列入痕迹地图的下限 */
const RISK_FLOOR = 40;
const SEV_HIGH = 60;
const SEV_MEDIUM = 45;

/** 置信度分档（全文可见字符数）：不足 200 统计不稳；800 以上判据相对稳定 */
const CONF_SHORT = 200;
const CONF_LONG = 800;

const visibleLen = (s: string): number => s.replace(/\s/g, "").length;

function confidenceOf(chars: number): ReviewConfidence {
  if (chars < CONF_SHORT) {
    return { level: "low", text: `低——全文不足 ${CONF_SHORT} 字，统计不稳，只作参考` };
  }
  if (chars < CONF_LONG) return { level: "medium", text: "中——中等篇幅，判据基本可用" };
  return { level: "high", text: "高——篇幅足够，判据相对稳定" };
}

/** 减风险项：出现在 reasons 里只是解释，不需要给建议 */
const POSITIVE = new Set(["有主观视角", "有具体细节", "短句", "疑问句"]);

const ADVICE: Record<string, string> = {
  含AI套话: "把套话换成具体说法，或整句重写；别保留套话的骨架只换词",
  提纲骨架开头: "删掉「本文/首先/综上所述」这类开头，直接切进正题",
  书面连接词开头: "段首连接词删掉，或换成更口语的过渡（其实/话说回来）",
  判断句式收尾: "「…是…的」改成动词谓语，或直接删掉判断尾巴",
  抽象名词: "换成具体名词或具体动作（降本增效 → 把成本砍了三成）",
  中英间空格: "全文统一：要么一律加空格，要么一律不加",
  超长句: "劈成两句，或把从句里的信息单独成句",
  四字排比: "留一处，其余删掉——人不会连着用三个同规格的短语",
  无明显痕迹: "",
};

function adviceFor(reason: string): string {
  return ADVICE[reason] ?? "";
}

function severityOf(risk: number): { severity: ReviewMark["severity"]; severityText: string } {
  if (risk >= SEV_HIGH) return { severity: "high", severityText: "建议改" };
  if (risk >= SEV_MEDIUM) return { severity: "medium", severityText: "可以改" };
  return { severity: "low", severityText: "看情况" };
}

/**
 * 审题：不涉及任何改写动作。
 * `sentences` 可选——需要与外部切句口径对齐时传入（默认用 detector 的切句）。
 */
export function reviewText(raw: string, sentences?: string[]): ReviewReport {
  const report = detectAI(raw);
  const segs = sentences?.length ? sentences : splitSentences(raw || "");

  const marks: ReviewMark[] = [];
  const tally = new Map<string, number>();
  let markedChars = 0;
  let totalChars = 0;

  segs.forEach((sentence, i) => {
    const vis = visibleLen(sentence);
    totalChars += vis;
    const { risk, reasons } = segmentRisk(sentence);
    if (risk < RISK_FLOOR) return;

    markedChars += vis;
    for (const r of reasons) {
      if (POSITIVE.has(r)) continue;
      tally.set(r, (tally.get(r) ?? 0) + 1);
    }
    const suggestions = reasons
      .filter((r) => !POSITIVE.has(r))
      .map(adviceFor)
      .filter(Boolean);

    marks.push({
      index: i + 1,
      sentence,
      risk,
      ...severityOf(risk),
      reasons,
      suggestions,
    });
  });

  const summary = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  // 空文本 totalChars=0 ⇒ 比例 0（真实输入路径，非死支兜底）
  const editedRatio = totalChars > 0 ? Math.round((markedChars / totalChars) * 100) : 0;

  return {
    probability: report.probability,
    levelText: report.levelText,
    editedRatio,
    confidence: confidenceOf(totalChars),
    total: segs.length,
    marked: marks.length,
    marks,
    summary,
    warnings: report.warnings,
    report,
  };
}

const SEV_MARK: Record<ReviewMark["severity"], string> = {
  high: "!!",
  medium: " !",
  low: " -",
};

/** 纯文本渲染，给 CLI 与不支持富文本的场景用 */
export function formatReview(r: ReviewReport): string {
  const lines: string[] = [];
  lines.push(`AI 味代理分 ${r.probability} / 100（${r.levelText}）· 本地启发式，非官方分`);
  lines.push(`共 ${r.total} 句，其中 ${r.marked} 句达到痕迹门槛`);
  lines.push(`AI 参与比例（本地估计）${r.editedRatio}% · 样本置信度：${r.confidence.text}`);
  if (r.summary.length) {
    lines.push("痕迹分布：" + r.summary.map(([k, v]) => `${k}×${v}`).join("、"));
  }
  lines.push("");

  for (const m of r.marks) {
    lines.push(`${SEV_MARK[m.severity]} 第${m.index}句（${m.risk}·${m.severityText}）`);
    lines.push(`   ${m.sentence}`);
    lines.push(`   命中：${m.reasons.join(" / ")}`);
    for (const s of m.suggestions) lines.push(`   建议：${s}`);
    lines.push("");
  }

  if (r.warnings.length) {
    lines.push("提醒：");
    for (const w of r.warnings) lines.push("  · " + w);
  }
  if (!r.marked) lines.push("没有句子达到痕迹门槛——不代表一定像人写，只代表本地判据没抓到。");
  return lines.join("\n");
}
