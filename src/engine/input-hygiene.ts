/**
 * 趣AI味 · 输入体检 / 机械清洗（竞品吸收（二））。
 *
 * 来源：randytorres/humanizer 的 autofix（纯规则、无 LLM：清 chatbot 残渣、隐
 * 形 unicode、填充短语）。本题材对中文场景重新圈定三类**确定性**问题：
 *
 *  1. 隐形字符：从网页/检测器对抗工具复制来的零宽字符、BOM、软连字符、双向
 *     文本控制符——有些"过检稿"靠它们藏字符，同时也污染本地统计与检测；
 *     怪异空白（NBSP 等"看起来是空格但不是"）统一换成普通空格。
 *  2. 聊天残渣：整行独立存在的 LLM 包装语（"以下是改写后的版本""希望这对你
 *     有帮助""需要我继续吗？"）。只删**独立成行**的匹配——正文里出现同款词语
 *     一律不动（宁可漏删，不可改坏正文）。
 *  3. 重复标点：。，、；： 的同类连续重复（"。。""，，"），收敛为一个；
 *     "！？"类强调标点不碰（那是真实语气的合法用法）。
 *
 * 纪律：确定性与可预期优先——清洗前后不产生新的语义变化，只做删除/替换/收敛。
 * 代码围栏（```）内的行不做聊天残渣匹配：文档里在讨论这些包装语时不能被误删。
 */

export type JunkKind = "invisible" | "chatbot" | "punct";

export interface JunkHit {
  kind: JunkKind;
  /** 问题名（含码位，供 UI 展示不可见字符） */
  label: string;
  /** 命中位置附近的上下文片段（±8 可见字符） */
  snippet: string;
  /** 命中起点下标（原文本坐标系） */
  index: number;
}

export interface JunkKindHits {
  /** 全部命中数（不受 samples 上限影响） */
  count: number;
  /** 至多 SAMPLES_MAX 条样本，供 UI 展示定位 */
  samples: JunkHit[];
}

export interface HygieneReport {
  invisible: JunkKindHits;
  chatbot: JunkKindHits;
  punct: JunkKindHits;
  /** 三类命中总数 */
  total: number;
}

export interface CleanResult {
  text: string;
  removed: { invisible: number; chatbot: number; punct: number };
  total: number;
}

/** 每类至多留几条样本上 UI */
export const SAMPLES_MAX = 3;

/* ----------------------------- 隐形字符 ----------------------------- */

/** 删除类：零宽/方向控制/软连字符/BOM——本身不承载任何内容 */
const INVISIBLE_DELETE: Record<string, string> = {
  "\u200B": "零宽空格 U+200B",
  "\u200C": "零宽不连字 U+200C",
  "\u200D": "零宽连字 U+200D",
  "\u2060": "word joiner U+2060",
  "\uFEFF": "BOM / 零宽不换行空格 U+FEFF",
  "\u00AD": "软连字符 U+00AD",
  "\u200E": "从左到右标记 U+200E",
  "\u200F": "从右到左标记 U+200F",
  "\u202A": "双向文本控制符 U+202A",
  "\u202B": "双向文本控制符 U+202B",
  "\u202C": "双向文本控制符 U+202C",
  "\u202D": "双向文本控制符 U+202D",
  "\u202E": "双向文本控制符 U+202E",
  "\u2066": "双向文本隔离符 U+2066",
  "\u2067": "双向文本隔离符 U+2067",
  "\u2068": "双向文本隔离符 U+2068",
  "\u2069": "双向文本隔离符 U+2069",
};

/** 替换类：怪异空白 → 普通空格（"看起来是空格但不是"） */
const WEIRD_SPACE: Record<string, string> = {
  "\u00A0": "不换行空格 NBSP U+00A0",
  "\u2007": "数字空格 U+2007",
  "\u2009": "窄空格 U+2009",
  "\u200A": "发丝空格 U+200A",
  "\u202F": "窄不换行空格 U+202F",
};

/** 单次扫描：删掉删除类字符，怪异空白换成普通空格，其余原样（避免把 ZWJ 等塞进字符类） */
function stripInvisibles(text: string): string {
  let out = "";
  for (const ch of text) {
    if (INVISIBLE_DELETE[ch] !== undefined) continue;
    out += WEIRD_SPACE[ch] !== undefined ? " " : ch;
  }
  return out;
}

/* ----------------------------- 聊天残渣 ----------------------------- */

/** 整行匹配的包装语模式。纪律：宁可漏删不可错删——只认高度特异的句式。 */
const CHATBOT_PATTERNS: Array<{ re: RegExp; label: string }> = [
  {
    re: /^(?:当然|没问题|好的|好嘞)?\s*[，,]?\s*(?:以下是?|下面(?:是)?|这是|这就是)(?:我)?(?:为你|为您)?(?:改写|润色|修改|优化|整理|生成|处理)(?:后|过)?的(?:版本|文字|内容|文本|稿子|答案)[：:。！!]?$/,
    label: "改写包装语（以下是改写后的版本）",
  },
  {
    re: /^希望(?:这|以上|这些|上述)(?:些)?(?:内容|信息|文字|建议)?(?:能|可以)?对(?:你|您|大家)有帮助[。！!~～]?$/,
    label: "客服式收尾（希望这对你有帮助）",
  },
  {
    re: /^希望(?:这|以上|这些|上述)(?:些)?(?:内容|信息|文字|建议)?(?:能|可以)?帮到(?:你|您|大家)[。！!~～]?$/,
    label: "客服式收尾（希望能帮到你）",
  },
  {
    re: /^(?:还|如果)?需要(?:我)?(?:继续|再|进一步)[^。！!？?\n]{0,8}(?:吗|么)[？?]?$/,
    label: "续写追问（需要我继续吗）",
  },
  {
    re: /^(?:如果|如|若)?(?:还|有|有其他|有其它的)?(?:问题|疑问|需要)?(?:的)?(?:话)?[，,]?(?:随时|可以|请)?(?:告诉我|联系我|说一声|喊我)[。！!？?~～]?$/,
    label: "留联语（有问题随时告诉我）",
  },
  {
    re: /^(?:我)?(?:是|作为)(?:一个)?(?:AI|ai|人工智能|语言模型|大语言模型|AI ?助手|智能助手)(?:助手)?[，,。：:]?$/,
    label: "AI 自曝身份（我是一个人工智能助手）",
  },
  { re: /^i hope (?:this|that) helps[.!]?$/i, label: "客服式收尾（I hope this helps）" },
  { re: /^let me know if (?:you|there)[^.!?\n]{0,40}[.!?]?$/i, label: "留联语（Let me know if…）" },
];

/** 该行（已 trim）是否是独立的聊天包装语 */
function wrapperLabel(line: string): string | null {
  const t = line.trim();
  if (!t) return null;
  for (const p of CHATBOT_PATTERNS) {
    if (p.re.test(t)) return p.label;
  }
  return null;
}

/* ----------------------------- 重复标点 ----------------------------- */

/** 同类句读连续重复（。，、；：）收敛为一个；！？ 不碰（合法强调） */
const PUNCT_DUP = /([。，、；：])\1+/g;

const PUNCT_LABEL: Record<string, string> = {
  "。": "重复句号（。。）",
  "，": "重复逗号（，，）",
  "、": "重复顿号（、、）",
  "；": "重复分号（；；）",
  "：": "重复冒号（：：）",
};

/* ----------------------------- 扫描 ----------------------------- */

function contextAt(text: string, index: number, len = 1): string {
  const start = Math.max(0, index - 8);
  const end = Math.min(text.length, index + len + 8);
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

function pushHit(bag: JunkKindHits, hit: JunkHit): void {
  bag.count++;
  if (bag.samples.length < SAMPLES_MAX) bag.samples.push(hit);
}

const emptyBag = (): JunkKindHits => ({ count: 0, samples: [] });

/** 输入体检：三类问题的计数 + 定位样本。纯函数，不改文本。 */
export function scanInputJunk(text: string): HygieneReport {
  const invisible = emptyBag();
  const chatbot = emptyBag();
  const punct = emptyBag();

  // 隐形字符 / 怪异空白：逐码位命中
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const label = INVISIBLE_DELETE[ch] ?? WEIRD_SPACE[ch];
    if (label) {
      pushHit(invisible, { kind: "invisible", label, snippet: contextAt(text, i), index: i });
    }
  }

  // 聊天残渣：整行匹配（代码围栏内跳过）
  let inFence = false;
  let offset = 0;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    else if (!inFence) {
      const label = wrapperLabel(line);
      if (label) {
        pushHit(chatbot, { kind: "chatbot", label, snippet: line.trim(), index: offset });
      }
    }
    offset += line.length + 1; // +1：被 split 吃掉的那个 \n
  }

  // 重复标点：按"组"命中（"。。。"算一处，收敛为 1 个）
  PUNCT_DUP.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PUNCT_DUP.exec(text)) !== null) {
    pushHit(punct, {
      kind: "punct",
      label: PUNCT_LABEL[m[1]] ?? "重复标点",
      snippet: contextAt(text, m.index, m[0].length),
      index: m.index,
    });
  }

  return {
    invisible,
    chatbot,
    punct,
    total: invisible.count + chatbot.count + punct.count,
  };
}

/* ----------------------------- 清洗 ----------------------------- */

/**
 * 一键清洗：删除隐形字符、怪异空白换普通空格、去独立包装语行、重复标点收敛。
 * 幂等：对清洗后的文本再跑一次，removed 全 0、文本逐字不变。
 */
export function cleanInputJunk(text: string): CleanResult {
  const before = scanInputJunk(text);

  let out = stripInvisibles(text);
  out = out.replace(PUNCT_DUP, "$1");

  // 包装语行整行删除（含换行）；围栏内不匹配，与扫描口径一致
  const kept: string[] = [];
  let inFence = false;
  let droppedLines = 0;
  for (const line of out.split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence && wrapperLabel(line)) {
      droppedLines++;
      continue;
    }
    kept.push(line);
  }
  out = kept.join("\n");
  if (droppedLines > 0) {
    // 删行产生的多余空行收敛与首尾空白整理——只在真的删了行时做，
    // 未命中的文本逐字原样返回
    out = out.replace(/\n{3,}/g, "\n\n").trim();
  }

  const removed = {
    invisible: before.invisible.count,
    // 用实际删掉的行数：隐形字符先被清掉后，个别包装语行可能才暴露出来
    chatbot: droppedLines,
    punct: before.punct.count,
  };
  return {
    text: out,
    removed,
    total: removed.invisible + removed.chatbot + removed.punct,
  };
}
