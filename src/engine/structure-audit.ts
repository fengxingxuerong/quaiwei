/**
 * src/engine/structure-audit.ts —— 篇章结构审计（**只报告，一个字都不改**）
 *
 * ## 为什么要有这个文件
 *
 * 2026-11-06 的赛道调研把结论摆在桌面上：头部项目已从「词表/句式规则」换层到**篇章结构**，
 * 而且换层是有实证的 —— SlopShape（arXiv:2609.15369）用 187 个结构特征单测 AI 商业博客拿到
 * 98.0 macro-F1；把 AI 稿的 13-gram 改写掉 73% 之后，**结构检测仍是 98.1，词级检测掉到 87.1**。
 * 换句话说：换词不换骨，在学术上已经被判了。本仓的 SCORECARD 第 2/9 条自己也承认
 * 「改写幅度集中在词句层，篇章结构没动」。
 *
 * 但直接去改结构风险极高：动段落顺序会碰 `sweep:format` 的 4080 次格式不变式、
 * 碰 12 样本基线、碰「不新增事实」的构造性保证。所以第一步只做**审计**：
 * 把「这篇文章的骨架像不像 AI 写的」变成一份可复现、可 diff、可进 CI 的清单。
 *
 * ## 为什么是确定性的
 *
 * 本仓的立身之本是「同输入同输出」。审计器不许调 LLM、不许用随机数、不许联网：
 * 同一份稿子跑一百次必须逐字相同的报告。所有判据都是字符/段落层面的可数特征
 * （标题承诺是否兑现、论点句落在第几段、首尾 4-gram 重合度、小标题密度、
 * 无人称标记数、序数词密度、段落长度变异系数）。判不准就不报 —— 见下面的「边界」。
 *
 * ## 边界（必须说清，否则这份报告会被当成判决书）
 *
 * - **只审形态，不审内容**。它不知道你的论点对不对，只知道「标题说三个方法、正文只有一个」。
 * - **不认体裁**。叙事文用「首先/其次」也可能是人写的。`--style academic` 时会把
 *   无人称解说腔降级，其余判据一视同仁。
 * - **阈值是启发式的**，不是标定出来的概率。`evidence/` 下有对照语料上的实测分布，
 *   报告里给出的永远是「命中/未命中」，不是「83% 像 AI」——本仓不再造第二个没有真值的分数。
 * - 只处理**中文为主的散文/说明文**。代码块、表格、引用块会被跳过（不当正文统计）。
 */

/* ------------------------------- 类型 ------------------------------- */

/** 审计项。每一条都必须能指回原文的某一段/某个标题，否则不许报。 */
export type StructureCode =
  | "heading-promise-unpaid" // 标题承诺（N 个方法/一个问句）正文没兑现
  | "thesis-delayed" // 论点/结论句落在全文后段，开头全是背景铺垫
  | "intro-outro-echo" // 首段与末段 4-gram 高度重合（首尾复述）
  | "heading-overdense" // 小标题过密，每节内容过薄
  | "impersonal-narrator" // 通篇无人称解说腔（我们可以看到/值得注意的是），且无「我/你」
  | "stepified-enumeration" // 段落被序数词切成步骤（首先/其次/最后、第一/第二/第三）
  | "uniform-paragraphs"; // 段落长度过于均匀（变异系数过低）

export type StructureSeverity = "high" | "medium" | "low";

export interface StructureIssue {
  code: StructureCode;
  severity: StructureSeverity;
  /** 定位：`第 3 段` / `标题「三、实现细节」` / `全文` */
  where: string;
  /** 证据原文（截断，保留可核对的前缀） */
  evidence: string;
  /** 人话：问题是什么 */
  message: string;
  /** 人话：往哪个方向改（只给方向，不代笔） */
  suggestion: string;
}

export interface StructureStats {
  /** 正文汉字/字母数字个数（不含空白与标点） */
  chars: number;
  /** 正文段落数（不含标题） */
  paragraphs: number;
  /** 标题数 */
  headings: number;
  /** 有正文的节数（标题后面跟着正文才算一节） */
  sections: number;
  /** 平均每节正文字数 */
  avgSectionChars: number;
  /** 段落长度变异系数（std/mean）；段落 < 3 时为 0 */
  paragraphCv: number;
}

export interface StructureAuditReport {
  issues: StructureIssue[];
  stats: StructureStats;
  /** 一句话结论，给终端和 CI 日志用 */
  verdict: string;
}

export interface StructureAuditOptions {
  /** 文风。academic 时无人称解说腔降为 low（学术写作里「我们」本就合法） */
  style?: string;
}

/* ------------------------------ 阈值 ------------------------------ */

/**
 * 首尾复述：首段与末段的 4-gram Jaccard。
 *
 * 4-gram 而不是词：中文没有空格，词表切分本身就有歧义；4 字窗口足够长到不会误命中
 * 「我们认为」这种通用串，又足够短到能抓住「改写后的同一句话」。
 * 0.28 是在 23 篇 AI 稿 + 21 篇真人语料上取的（见 evidence/structure-audit-2026-11-06.md）：
 * 真人语料最高 0.19，AI 稿里首尾复述的那几篇都在 0.3 以上。
 */
const ECHO_JACCARD = 0.28;

/** 首尾复述升级为 high 的门槛：超过它基本就是同一段话换了个说法 */
const ECHO_JACCARD_HIGH = 0.45;

/** 小标题过密：平均每节正文少于这么多字，说明标题在替代论证 */
const SECTION_MIN_CHARS = 120;

/** 段落均匀：变异系数低于它算「过于均匀」 */
const PARAGRAPH_CV_MIN = 0.2;

/** 论点后置：第一个结论句落在全文这个比例之后 */
const THESIS_LATE_RATIO = 0.6;

/** 参与统计的最短段落（太短的过渡句会把 CV 拉飞） */
const MIN_PARA_CHARS = 20;

/* ------------------------------ 解析 ------------------------------ */

interface Block {
  kind: "heading" | "para";
  text: string;
  /** 1-based 行号，报告里用来定位 */
  line: number;
  /** 标题层级：1-6 = markdown #，7 = 中文序号/数字序号/加粗整行 */
  level: number;
}

/** 中文序号标题：`一、` `（二）` `3.` `1)`；要求整行短，避免把正文里的「1. 先做 X」当标题 */
const RE_HEADING_CN = /^([一二三四五六七八九十百]+)\s*[、.．]\s*(.*)$/;
const RE_HEADING_NUM = /^(\d{1,2})\s*[.、)）]\s*(.*)$/;
const RE_HEADING_BOLD = /^\*\*(.{1,40})\*\*$/;

/**
 * 把稿子切成「标题 / 段落」两种块。
 *
 * 段落按**空行**切；没有空行的纯文本（记事本一行一段）退化为「一行一段」。
 * 代码围栏（```）、引用块（>）、表格行（|）整块跳过 —— 它们不是散文，
 * 混进来会把「段落长度变异系数」这类统计带偏。
 */
export function splitBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let buf: string[] = [];
  let bufLine = 0;
  let inFence = false;

  const flush = () => {
    if (!buf.length) return;
    const body = buf.join("\n").trim();
    if (body) blocks.push({ kind: "para", text: body, line: bufLine, level: 0 });
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    // 代码围栏：整块跳过，不参与任何统计
    if (/^```/.test(line)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (line === "") {
      flush();
      continue;
    }
    // 引用块与表格：不是散文，单独跳过（但不打断上一段？打断——它们是独立块）
    if (/^>/.test(line) || /^\|/.test(line)) {
      flush();
      continue;
    }

    const h = matchHeading(line);
    if (h) {
      flush();
      blocks.push({ kind: "heading", text: h.text, line: i + 1, level: h.level });
      continue;
    }

    if (!buf.length) bufLine = i + 1;
    buf.push(line);
  }
  flush();
  return blocks;
}

function matchHeading(line: string): { text: string; level: number } | null {
  const md = /^(#{1,6})\s+(.+)$/.exec(line);
  if (md) return { text: md[2].trim(), level: md[1].length };

  const bold = RE_HEADING_BOLD.exec(line);
  if (bold) return { text: bold[1].trim(), level: 7 };

  // 中文/数字序号标题：必须短，且不能带句末标点（否则是正文里的列举）
  if (line.length <= 30 && !/[。！？；]$/.test(line)) {
    const cn = RE_HEADING_CN.exec(line);
    if (cn) return { text: (cn[2] || cn[1]).trim(), level: 7 };
    const num = RE_HEADING_NUM.exec(line);
    if (num && num[2].trim().length >= 2) return { text: num[2].trim(), level: 7 };
  }
  return null;
}

/** 标题去掉装饰后剩下的「承诺文本」 */
function headingText(t: string): string {
  return t
    .replace(/^[#*\s]+/, "")
    .replace(/[*\s]+$/, "")
    .trim();
}

/* ---------------------------- 文本工具 ---------------------------- */

/** 只留汉字/字母/数字，用于 n-gram 比对（标点与空白不参与） */
function normForGram(s: string): string {
  return s.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, "").toLowerCase();
}

function grams(s: string, n: number): Set<string> {
  const out = new Set<string>();
  const t = normForGram(s);
  for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** 证据截断：保留 36 字，超出补省略号（报告里要能一眼核对，又不能糊满屏） */
function clip(s: string, n = 36): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

function cjkCount(s: string): number {
  return normForGram(s).length;
}

/** 段落长度的变异系数；样本太少时返回 0（不参与判定） */
function cvOf(nums: number[]): number {
  if (nums.length < 3) return 0;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  if (mean <= 0) return 0;
  const varSum = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length;
  return Math.sqrt(varSum) / mean;
}

/* ---------------------------- 判据：标题 ---------------------------- */

/** 「三个方法」「四种写法」「两条路」——数字承诺 */
const RE_COUNT_PROMISE = /([一二三四五六七八九十两\d]+)\s*(个|种|条|步|点|招|类|项|层|件|大|组|套)/;
/** 问句标题：带问号，或以疑问词开头 */
const RE_QUESTION = /(如何|为什么|为何|怎么|怎样|是什么|有哪些|能不能|要不要|该不该|吗[？?]?$)/;
/** 问句标题的「兑现标记」：正文里出现这些词，说明真的在回答 */
const ANSWER_MARKERS = [
  "因为",
  "原因",
  "答案",
  "关键",
  "在于",
  "区别",
  "做法",
  "建议",
  "核心",
  "本质",
  "取决于",
  "第一步",
  "先说",
];

function auditHeadingPromise(blocks: Block[]): StructureIssue[] {
  const issues: StructureIssue[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind !== "heading") continue;
    const title = headingText(b.text);
    if (!title || cjkCount(title) < 2) continue;

    // 本节正文：到下一个同级或更高级标题为止
    const body: Block[] = [];
    for (let j = i + 1; j < blocks.length; j++) {
      const nb = blocks[j];
      if (nb.kind === "heading" && nb.level <= b.level) break;
      if (nb.kind === "para") body.push(nb);
    }
    if (!body.length) continue; // 空节不归这里管（那是 heading-overdense 的事）

    const count = RE_COUNT_PROMISE.exec(title);
    if (count) {
      const promised = cnNum(count[1]);
      const got = Math.max(countListItems(body), body.length);
      if (promised >= 2 && got < promised) {
        issues.push({
          code: "heading-promise-unpaid",
          severity: promised - got >= 2 ? "high" : "medium",
          where: `标题「${clip(title, 20)}」`,
          evidence: `${body.length} 段正文 / ${countListItems(body)} 个列表项`,
          message: `标题承诺了 ${promised} ${count[2]}，正文只兑现了 ${got} ${count[2]}`,
          suggestion: "要么补齐到承诺的数量，要么把标题里的数字去掉（改标题比硬凑内容诚实）",
        });
      }
      continue;
    }

    if (RE_QUESTION.test(title)) {
      const head = body
        .slice(0, 2)
        .map((x) => x.text)
        .join("");
      const answered = ANSWER_MARKERS.some((m) => head.includes(m));
      if (!answered && cjkCount(head) >= 40) {
        issues.push({
          code: "heading-promise-unpaid",
          severity: "low",
          where: `标题「${clip(title, 20)}」`,
          evidence: clip(head),
          message: "问句标题，但正文前两段里没有回答的痕迹（原因/答案/关键在于…都没有）",
          suggestion: "标题问什么，第一节就答什么；铺垫放到答完之后",
        });
      }
    }
  }
  return issues;
}

function cnNum(s: string): number {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const map: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  if (s.length === 1) return map[s] ?? 0;
  if (s === "十一") return 11;
  if (s === "十二") return 12;
  return 0;
}

/** 数一数本节里显式的列表项（- / 1. / ① / 一、） */
function countListItems(body: Block[]): number {
  let n = 0;
  for (const b of body) {
    for (const line of b.text.split("\n")) {
      if (
        /^\s*(?:[-*+·]\s|\d{1,2}[.、)）]\s|[（(]\d{1,2}[）)]|[①-⑩]|[一二三四五六七八九十]+[、.])/.test(
          line,
        )
      )
        n++;
    }
  }
  return n;
}

/* ---------------------------- 判据：论点 ---------------------------- */

/** 结论/立场标记：出现它，说明作者在表态，而不是在铺垫 */
const THESIS_MARKERS = [
  "因此",
  "所以",
  "可见",
  "由此",
  "综上",
  "结论",
  "说到底",
  "归根到底",
  "关键在于",
  "真正的问题是",
  "我的判断",
  "我认为",
  "我倾向于",
  "我的结论",
];

/** 开场背景铺垫的典型形态 */
const BACKGROUND_OPENERS = [
  "随着",
  "近年来",
  "在当今",
  "如今",
  "众所周知",
  "长期以来",
  "不可否认",
  "在这个",
  "进入21世纪",
  "伴随着",
];

function auditThesis(blocks: Block[]): StructureIssue[] {
  const paras = blocks.filter((b) => b.kind === "para");
  if (paras.length < 4) return [];
  const total = paras.reduce((s, p) => s + cjkCount(p.text), 0);
  if (total < 250) return []; // 太短的稿子谈「论点前置」没有意义（250 字约等于一段导语 + 两段正文）

  let firstThesis = -1;
  for (let i = 0; i < paras.length; i++) {
    if (THESIS_MARKERS.some((m) => paras[i].text.includes(m))) {
      firstThesis = i;
      break;
    }
  }
  if (firstThesis < 0) return []; // 通篇没表态 —— 可能是叙事文，不报

  const late = firstThesis >= Math.ceil(paras.length * THESIS_LATE_RATIO);
  const opener = paras[0].text.slice(0, 60);
  const background = BACKGROUND_OPENERS.some((m) => opener.includes(m));
  if (!late) return [];

  return [
    {
      code: "thesis-delayed",
      severity: background ? "medium" : "low",
      where: `第 ${firstThesis + 1} 段（共 ${paras.length} 段）`,
      evidence: clip(paras[firstThesis].text),
      message: `第一个结论句出现在 ${Math.round(((firstThesis + 1) / paras.length) * 100)}% 处${
        background
          ? "，开头是背景铺垫（" + BACKGROUND_OPENERS.find((m) => opener.includes(m)) + "…）"
          : ""
      }`,
      suggestion: "把结论提到前两段，背景压缩成一句；读者先知道你要说什么，才愿意看你为什么这么说",
    },
  ];
}

/* --------------------------- 判据：首尾复述 --------------------------- */

function auditEcho(blocks: Block[]): StructureIssue[] {
  const paras = blocks.filter((b) => b.kind === "para");
  if (paras.length < 3) return [];
  const first = paras[0].text;
  const last = paras[paras.length - 1].text;
  if (cjkCount(first) < 40 || cjkCount(last) < 40) return [];

  const j = jaccard(grams(first, 4), grams(last, 4));
  if (j < ECHO_JACCARD) return [];

  return [
    {
      code: "intro-outro-echo",
      severity: j >= ECHO_JACCARD_HIGH ? "high" : "medium",
      where: `第 1 段 ↔ 第 ${paras.length} 段`,
      evidence: `4-gram 重合 ${(j * 100).toFixed(1)}%：${clip(last)}`,
      message: "首段与末段高度重合（换个说法把开头又说了一遍）",
      suggestion:
        "结尾给新东西：一个新例子、一个反例、一个还没解决的麻烦。复述开头是最典型的 AI 收尾",
    },
  ];
}

/* -------------------------- 判据：小标题密度 -------------------------- */

function auditHeadingDensity(stats: StructureStats): StructureIssue[] {
  if (stats.headings < 3) return [];
  if (stats.sections < 3) return [];

  const issues: StructureIssue[] = [];
  if (stats.avgSectionChars < SECTION_MIN_CHARS) {
    issues.push({
      code: "heading-overdense",
      severity: "medium",
      where: `全文（${stats.headings} 个标题 / ${stats.sections} 节）`,
      evidence: `平均每节 ${Math.round(stats.avgSectionChars)} 字`,
      message: `小标题过密：平均每节正文不到 ${SECTION_MIN_CHARS} 字，标题在替代论证`,
      suggestion:
        "合并相邻小节，把并列的三四个标题压成一段有转折的叙述；标题多了，读起来像 PPT 不像文章",
    });
  }
  return issues;
}

/* ------------------------- 判据：无人称解说腔 ------------------------- */

const IMPERSONAL_MARKERS = [
  "我们可以看到",
  "我们可以发现",
  "我们不难看出",
  "不难看出",
  "可以看出",
  "由此可见",
  "众所周知",
  "值得注意的是",
  "需要指出的是",
  "需要注意的是",
  "总的来说",
  "综上所述",
  "换言之",
];

const FIRST_PERSON = [
  "我认为",
  "我觉得",
  "我见过",
  "我试过",
  "我的经验",
  "我建议",
  "在我看来",
  "我印象",
];
const SECOND_PERSON = ["你", "你们"];

function auditNarrator(blocks: Block[], opts: StructureAuditOptions): StructureIssue[] {
  const text = blocks.map((b) => b.text).join("\n");
  if (cjkCount(text) < 300) return [];

  const hits: string[] = [];
  for (const m of IMPERSONAL_MARKERS) {
    if (text.includes(m)) hits.push(m);
  }
  if (hits.length < 2) return [];

  const hasFirst = FIRST_PERSON.some((m) => text.includes(m));
  const hasSecond = SECOND_PERSON.some((m) => text.includes(m));
  if (hasFirst || hasSecond) return [];

  const academic = opts.style === "academic";
  return [
    {
      code: "impersonal-narrator",
      severity: academic ? "low" : "medium",
      where: "全文",
      evidence: hits.slice(0, 4).join(" / "),
      message: `无人称解说腔：${hits.length} 处「${hits[0]}」类标记，通篇没有「我」也没有「你」`,
      suggestion:
        "至少让一个人在场：谁在说、对谁说。把「我们可以看到」换成「我看到的」比删掉更有用",
    },
  ];
}

/* -------------------------- 判据：编号步骤化 -------------------------- */

const ORDINAL_GROUPS: string[][] = [
  ["首先", "其次", "再次", "然后", "最后", "最终"],
  ["第一", "第二", "第三", "第四", "第五"],
  ["一是", "二是", "三是", "四是"],
  ["其一", "其二", "其三"],
];

function auditStepified(blocks: Block[]): StructureIssue[] {
  const paras = blocks.filter((b) => b.kind === "para");
  const issues: StructureIssue[] = [];

  for (let i = 0; i < paras.length; i++) {
    const t = paras[i].text;
    for (const group of ORDINAL_GROUPS) {
      const used = group.filter((m) => t.includes(m));
      if (used.length >= 3) {
        issues.push({
          code: "stepified-enumeration",
          severity: "low",
          where: `第 ${i + 1} 段`,
          evidence: clip(t),
          message: `同一段里用了 ${used.length} 个序数词（${used.join("/")}），把叙述切成了步骤`,
          suggestion:
            "留一个序数词，其余改成因果或转折连接：不是「其次」，而是「因为前一条不成立」",
        });
        break; // 一段只报一次
      }
    }
  }
  return issues;
}

/* -------------------------- 判据：段落均匀 -------------------------- */

function auditUniformParagraphs(blocks: Block[]): StructureIssue[] {
  const paras = blocks.filter((b) => b.kind === "para" && cjkCount(b.text) >= MIN_PARA_CHARS);
  if (paras.length < 4) return [];
  const lens = paras.map((p) => cjkCount(p.text));
  const cv = cvOf(lens);
  // cv === 0 是「每段一模一样长」，正是要报的形态，不能当「样本不足」放掉
  if (cv >= PARAGRAPH_CV_MIN) return [];

  return [
    {
      code: "uniform-paragraphs",
      severity: "low",
      where: `全文（${paras.length} 段）`,
      evidence: `段长 ${Math.min(...lens)}–${Math.max(...lens)} 字，变异系数 ${cv.toFixed(3)}`,
      message: "段落长度过于均匀：每段都差不多长，读起来像按模板填的",
      suggestion: "允许一段只有一句话，也允许一段写八行；长短交替本身就是人味",
    },
  ];
}

/* ------------------------------ 主入口 ------------------------------ */

export function auditStructure(
  text: string,
  opts: StructureAuditOptions = {},
): StructureAuditReport {
  const blocks = splitBlocks(text);
  const paras = blocks.filter((b) => b.kind === "para");
  const headings = blocks.filter((b) => b.kind === "heading");

  // 每节正文长度：标题之后到下一个同级标题之前的正文
  let sections = 0;
  let sectionChars = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].kind !== "heading") continue;
    let chars = 0;
    for (let j = i + 1; j < blocks.length; j++) {
      const nb = blocks[j];
      if (nb.kind === "heading" && nb.level <= blocks[i].level) break;
      if (nb.kind === "para") chars += cjkCount(nb.text);
    }
    if (chars > 0) {
      sections++;
      sectionChars += chars;
    }
  }

  const paraLens = paras
    .filter((p) => cjkCount(p.text) >= MIN_PARA_CHARS)
    .map((p) => cjkCount(p.text));
  const stats: StructureStats = {
    chars: cjkCount(text),
    paragraphs: paras.length,
    headings: headings.length,
    sections,
    avgSectionChars: sections ? sectionChars / sections : 0,
    paragraphCv: cvOf(paraLens),
  };

  const issues: StructureIssue[] = [
    ...auditHeadingPromise(blocks),
    ...auditThesis(blocks),
    ...auditEcho(blocks),
    ...auditHeadingDensity(stats),
    ...auditNarrator(blocks, opts),
    ...auditStepified(blocks),
    ...auditUniformParagraphs(blocks),
  ];

  // 排序：先按严重度，再按原文出现顺序（where 里的段号不保证可解析，用稳定插入序兜底）
  const rank: Record<StructureSeverity, number> = { high: 0, medium: 1, low: 2 };
  issues.sort((a, b) => rank[a.severity] - rank[b.severity]);

  return { issues, stats, verdict: verdictOf(issues, stats) };
}

function verdictOf(issues: StructureIssue[], stats: StructureStats): string {
  // 「太短」只解释**为什么没有更多条目**，不能盖掉已经报出来的问题
  // （标题承诺这类判据在 200 字以内照样成立，说「不判」会自相矛盾）
  if (!issues.length) {
    return stats.chars < 200 ? "稿子太短，结构层不判（<200 字）" : "结构层没看见高置信问题";
  }
  const high = issues.filter((i) => i.severity === "high").length;
  const mid = issues.filter((i) => i.severity === "medium").length;
  if (high) return `结构层 ${high} 处硬伤、${mid} 处待商榷`;
  if (mid) return `结构层 ${mid} 处待商榷`;
  return `结构层 ${issues.length} 处低置信提示（可不动）`;
}

/** 终端报告格式。缩进与 CLI 其他报告保持一致（两格起） */
export function formatStructureReport(r: StructureAuditReport): string {
  const lines: string[] = [];
  const { stats } = r;
  lines.push(
    `结构审计：${stats.chars} 字 · ${stats.paragraphs} 段 · ${stats.headings} 个标题 · ` +
      `段长 CV ${stats.paragraphCv.toFixed(3)}` +
      (stats.sections ? ` · 平均每节 ${Math.round(stats.avgSectionChars)} 字` : ""),
  );
  lines.push(`结论：${r.verdict}`);
  for (const it of r.issues) {
    const tag = it.severity === "high" ? "✗" : it.severity === "medium" ? "⚠" : "·";
    lines.push(`  ${tag} [${it.code}] ${it.where}：${it.message}`);
    lines.push(`      证据：${it.evidence}`);
    lines.push(`      方向：${it.suggestion}`);
  }
  if (r.issues.length) {
    lines.push("  （只报告，未改动任何字。结构改写请人工决定，别交给自动流程）");
  }
  return lines.join("\n");
}
