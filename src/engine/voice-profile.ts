/**
 * 趣AI味 · 声线样本画像（voice profile）——竞品吸收（一）。
 *
 * 来源：blader/humanizer 的 voice matching（用户写作样本优先于全部默认规则——
 * 句长节奏/标点习惯/口气照样本走，样本用破折号就跟随样本密度而非一刀清零）；
 * harshaneel/humanize 的 HyPerAlign 思路（拿本人样本蒸馏风格假设再套用，
 * 比让模型"猜一个人味"准得多）。
 *
 * 定位：**纯统计、零模型**。把样本拆成可复述给 LLM 的数字与习惯
 * （句长均值/起伏、短长句占比、破折号/省略号/问号/叹号密度），
 * 由 voiceDirectiveBlock() 拼成定向提示词注入 system prompt。
 * 本地引擎不消费画像——只服务 LLM 侧，引擎阈值标定面不动。
 *
 * 契约：纯函数、确定性。样本过短（< VOICE_SAMPLE_MIN 可见字符）返回 null，
 * 宁可不注入，也不拿两句话的样本瞎画像。
 */
import { splitSentences } from "./humanize-text";

/** 声线样本的最少可见字符数：低于此值统计没意义（2~3 段 ≈ 150~400 字） */
export const VOICE_SAMPLE_MIN = 100;

/** 注入提示词的样本节选上限（可见字符）：随每轮改写/修订调用一起进上下文，
 *  再长只是烧 token。截断按句末收尾，不切在句子中间。 */
export const VOICE_QUOTE_MAX = 800;

export interface VoiceProfile {
  /** 可见字符数（去空白） */
  chars: number;
  /** 句数（canonical splitSentences 口径） */
  sentences: number;
  /** 句长均值（可见字符/句，保留 1 位） */
  avgLen: number;
  /** 句长变异系数 CV（保留 2 位）：人写作通常 0.4+，AI 平稳文本 0.2 上下 */
  cv: number;
  /** 短句（≤10 字）占比 0~1（保留 3 位） */
  shortRatio: number;
  /** 长句（≥40 字）占比 0~1（保留 3 位） */
  longRatio: number;
  /** 每千可见字符的破折号密度（连续破折号算一处，保留 1 位） */
  dashPer1k: number;
  /** 省略号密度（处/千字） */
  ellipsisPer1k: number;
  /** 问号密度（处/千字） */
  questionPer1k: number;
  /** 叹号密度（处/千字） */
  exclamationPer1k: number;
}

const visibleLen = (s: string): number => s.replace(/\s/g, "").length;

const round = (v: number, digits: number): number => {
  const p = 10 ** digits;
  return Math.round(v * p) / p;
};

/** 标点密度：按"组"计数（连续破折号/省略号算一处），折算每千可见字符。
 *  ⚠️ 调用点仅 extractVoiceProfile 一处，且必在 `chars ≥ VOICE_SAMPLE_MIN` 之后
 *  ⇒ chars 恒 >0，不做零除兜底（卫生八口径：证明完备的死支不留）。 */
function per1k(text: string, re: RegExp, chars: number): number {
  const hits = text.match(re)?.length ?? 0;
  return round((hits / chars) * 1000, 1);
}

/** 画像：样本可见字符不足 VOICE_SAMPLE_MIN 时返回 null（调用方不注入） */
export function extractVoiceProfile(sample: string): VoiceProfile | null {
  const text = (sample ?? "").trim();
  const chars = visibleLen(text);
  if (chars < VOICE_SAMPLE_MIN) return null;

  const sentences = splitSentences(text);
  // 可见字符 ≥ VOICE_SAMPLE_MIN ⇒ 切句结果必非空（末尾 buf 兜底 + trim 滤空），
  // 且每段的可见长度 ≥1、总和 = chars ⇒ n ≥1、mean >0：以下不做空集/零均兜底。
  const lens = sentences.map((s) => visibleLen(s));
  const n = lens.length;
  const mean = lens.reduce((a, b) => a + b, 0) / n;
  const variance = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const cv = Math.sqrt(variance) / mean;

  return {
    chars,
    sentences: n,
    avgLen: round(mean, 1),
    cv: round(cv, 2),
    shortRatio: round(lens.filter((l) => l <= 10).length / n, 3),
    longRatio: round(lens.filter((l) => l >= 40).length / n, 3),
    dashPer1k: per1k(text, /—+/g, chars),
    ellipsisPer1k: per1k(text, /…+/g, chars),
    questionPer1k: per1k(text, /[?？]/g, chars),
    exclamationPer1k: per1k(text, /[!！]/g, chars),
  };
}

/** 样本节选：超限时按可见字符截到上限，再回退到最近的句末标点收尾 */
function truncateQuote(text: string): string {
  if (visibleLen(text) <= VOICE_QUOTE_MAX) return text;
  let cut = "";
  let count = 0;
  for (const ch of text) {
    cut += ch;
    if (!/\s/.test(ch) && ++count >= VOICE_QUOTE_MAX) break;
  }
  // 回退到句末标点（至少保留上限的 1/3，否则宁可硬截也不返回一句话尾巴）
  const m = cut.match(/^[\s\S]*[。！？…；」』”）)]/);
  if (m && m[0].length >= Math.floor(cut.length / 3)) return m[0].trim();
  return cut.trim();
}

/**
 * 声线指令块：样本不足（空/过短）返回空串，调用方直接拼接不必判空。
 *
 * 关键设计——**显式覆盖主提示词第 15 条**（"破折号整篇最多一次，省略号最多一次"）：
 * blader/humanizer 明文要求"样本优先于全部规则，包括破折号限制"。
 * 样本本身就有破折号习惯的用户，被统一清零后改出来的稿反而不像本人。
 */
export function voiceDirectiveBlock(sample?: string): string {
  const raw = (sample ?? "").trim();
  if (!raw) return "";
  const prof = extractVoiceProfile(raw);
  if (!prof) return "";

  const quote = truncateQuote(raw);
  return `\n\n声线样本（用户本人写作，优先级高于上述全部文风预设与范例——冲突时以样本为准）：

样本画像：句长均值 ${prof.avgLen.toFixed(1)} 字、起伏 ${prof.cv.toFixed(2)}（短句≤10字占 ${(prof.shortRatio * 100).toFixed(0)}%、长句≥40字占 ${(prof.longRatio * 100).toFixed(0)}%）；破折号 ${prof.dashPer1k.toFixed(1)} 处/千字、省略号 ${prof.ellipsisPer1k.toFixed(1)}、问号 ${prof.questionPer1k.toFixed(1)}、叹号 ${prof.exclamationPer1k.toFixed(1)}。

执行要求：
- 句长节奏向样本靠拢：样本爱出短句就多出短句；样本句长本来就均匀（起伏低于 0.30）就不要硬塞 3~6 字的碎片句，那反而不是这个人。
- 标点习惯跟随样本：样本破折号/省略号本身有密度的，保留相近密度——此条覆盖前文"整篇最多一次"的默认上限（但不要超过样本密度）；样本几乎不用就跟着克制。
- 称呼、口气、过渡方式、惯用词照样本走，不要套用范文里的口头禅。

样本节选：
${quote}`;
}
