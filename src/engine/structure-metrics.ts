/**
 * src/engine/structure-metrics.ts —— 结构指标度量（**只算数，不改一个字**）
 *
 * ## 为什么要有这个文件
 *
 * 本仓已有的两把尺子都量不准「这次改动变好没有」：
 *   · `aiScore` 与引擎共用同一份词表 —— 改写后分数下降是构造性保证，自己证明自己
 *     （与独立评委只有 Pearson 0.353）；
 *   · 配对盲测在「长文本 + 细微改动」下四次都测不出（0.478 / 0.457 / 0.433 / 0.517，
 *     双席一致率 0.348~0.533，见 `evidence/ab-accept-2026-11-07/`）。
 *
 * 这里补第三把：**纯句法统计**。不碰词表、不调模型、不用随机数，
 * 同输入同输出。它不回答「像不像 AI」，只回答「这次改动让句子结构变了多少」——
 * 用它可以把「碎句化」这类改动的幅度量成可复现的数字，而不是靠评委印象。
 *
 * ## 边界
 *
 * - 只统计中文散文/说明文的句法形态；代码块内的文本也会计入（技术文档请自行剔除）。
 * - 指标本身没有「好坏」方向：句号密度高不一定是坏，要看跟什么比（真人基线/原文）。
 * - 不并入 `aiScore`、不进任何门禁 —— 它只是尺子，不是判决。
 */
import { splitSentences } from "./humanize-text.ts";
import { splitParasOutsideFences, isProtectedBlock } from "./text-shield.ts";

export interface StructureMetrics {
  /** 去空白后的字符数 */
  chars: number;
  sentences: number;
  /** 每千字句末标点数（碎句化主指标） */
  periodPerKChar: number;
  /** 句长（去标点后的字数）分布 */
  sentLen: {
    mean: number;
    median: number;
    cv: number;
    p10: number;
    p90: number;
    max: number;
  };
  /** 短句占比（<10 字）/ 超短句占比（<6 字） */
  shortRatio: number;
  ultraShortRatio: number;
  /** 并列结构：句内逗号总数 / 句数；含逗号的句子占比 */
  commasPerSentence: number;
  commaSentenceRatio: number;
  /** 标点密度（每千字） */
  emDashPerKChar: number;
  ellipsisPerKChar: number;
  /** 段落形态（只数非保护段） */
  paragraphs: number;
  sentencesPerParagraph: { mean: number; cv: number };
}

const PUNCT_RE = /[。！？!?；;\n]/g;
const round2 = (x: number): number => Math.round(x * 100) / 100;

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function mean(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function sd(nums: number[]): number {
  if (nums.length < 2) return 0;
  const m = mean(nums);
  return Math.sqrt(mean(nums.map((x) => (x - m) ** 2)));
}

const perK = (n: number, chars: number): number => (chars === 0 ? 0 : (n / chars) * 1000);

/** 统计一份文本的结构指标。纯函数，同输入同输出。 */
export function structureMetrics(text: string): StructureMetrics {
  const chars = text.replace(/\s/g, "").length;
  const sents = splitSentences(text);
  const lens = sents.map((s) => s.replace(PUNCT_RE, "").length).filter((n) => n > 0);
  const sorted = [...lens].sort((a, b) => a - b);
  const avg = mean(lens);
  const cv = avg === 0 ? 0 : sd(lens) / avg;

  const paras = splitParasOutsideFences(text).filter(
    (p) => p.trim().length > 0 && !isProtectedBlock(p),
  );
  const perPara = paras.map((p) => splitSentences(p).length).filter((n) => n > 0);
  const paraAvg = mean(perPara);

  const commaTotal = (text.match(/，/g) ?? []).length;
  const commaSents = sents.filter((s) => s.includes("，")).length;

  return {
    chars,
    sentences: sents.length,
    periodPerKChar: round2(perK((text.match(/[。！？!?]/g) ?? []).length, chars)),
    sentLen: {
      mean: round2(avg),
      median: round2(quantile(sorted, 0.5)),
      cv: round2(cv),
      p10: round2(quantile(sorted, 0.1)),
      p90: round2(quantile(sorted, 0.9)),
      max: sorted.length ? sorted[sorted.length - 1] : 0,
    },
    shortRatio: lens.length ? round2(lens.filter((n) => n < 10).length / lens.length) : 0,
    ultraShortRatio: lens.length ? round2(lens.filter((n) => n < 6).length / lens.length) : 0,
    commasPerSentence: sents.length ? round2(commaTotal / sents.length) : 0,
    commaSentenceRatio: sents.length ? round2(commaSents / sents.length) : 0,
    emDashPerKChar: round2(perK((text.match(/——/g) ?? []).length, chars)),
    ellipsisPerKChar: round2(perK((text.match(/……/g) ?? []).length, chars)),
    paragraphs: paras.length,
    sentencesPerParagraph: {
      mean: round2(paraAvg),
      cv: round2(paraAvg === 0 ? 0 : sd(perPara) / paraAvg),
    },
  };
}

/** 一行摘要，给 CLI / 报告用。 */
export function formatMetrics(m: StructureMetrics): string {
  return [
    `${m.chars} 字 / ${m.sentences} 句 / ${m.paragraphs} 段`,
    `句号 ${m.periodPerKChar}/千字`,
    `句长 均值 ${m.sentLen.mean} 中位 ${m.sentLen.median} CV ${m.sentLen.cv} (P10 ${m.sentLen.p10} / P90 ${m.sentLen.p90} / 最长 ${m.sentLen.max})`,
    `短句 ${(m.shortRatio * 100).toFixed(1)}% / 超短 ${(m.ultraShortRatio * 100).toFixed(1)}%`,
    `逗号 ${m.commasPerSentence}/句（含逗号句 ${(m.commaSentenceRatio * 100).toFixed(1)}%）`,
    `破折号 ${m.emDashPerKChar}/千字 · 省略号 ${m.ellipsisPerKChar}/千字`,
  ].join(" | ");
}

export interface MetricDelta {
  key: string;
  label: string;
  before: number;
  after: number;
  delta: number;
  /** 相对变化百分比（before 为 0 时为 null） */
  deltaPct: number | null;
}

/** 两组指标的逐项差异，按 |deltaPct| 降序 —— 用来回答「这次改动动了什么」。 */
export function compareMetrics(before: StructureMetrics, after: StructureMetrics): MetricDelta[] {
  const rows: Array<[string, string, number, number]> = [
    ["periodPerKChar", "句号密度/千字", before.periodPerKChar, after.periodPerKChar],
    ["sentLen.mean", "句长均值", before.sentLen.mean, after.sentLen.mean],
    ["sentLen.cv", "句长 CV", before.sentLen.cv, after.sentLen.cv],
    ["sentLen.p90", "句长 P90", before.sentLen.p90, after.sentLen.p90],
    ["shortRatio", "短句占比", before.shortRatio, after.shortRatio],
    ["ultraShortRatio", "超短句占比", before.ultraShortRatio, after.ultraShortRatio],
    ["commasPerSentence", "逗号/句", before.commasPerSentence, after.commasPerSentence],
    ["commaSentenceRatio", "含逗号句占比", before.commaSentenceRatio, after.commaSentenceRatio],
    ["emDashPerKChar", "破折号/千字", before.emDashPerKChar, after.emDashPerKChar],
    ["ellipsisPerKChar", "省略号/千字", before.ellipsisPerKChar, after.ellipsisPerKChar],
    [
      "sentencesPerParagraph.mean",
      "每段句数",
      before.sentencesPerParagraph.mean,
      after.sentencesPerParagraph.mean,
    ],
  ];
  return rows
    .map(([key, label, b, a]) => ({
      key,
      label,
      before: b,
      after: a,
      delta: round2(a - b),
      deltaPct: b === 0 ? null : round2(((a - b) / b) * 100),
    }))
    .sort((x, y) => Math.abs(y.deltaPct ?? 0) - Math.abs(x.deltaPct ?? 0));
}
