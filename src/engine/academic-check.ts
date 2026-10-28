/**
 * src/engine/academic-check.ts —— 学术稿的「交稿硬出口」。
 *
 * 为什么单独一层：论文/投稿这类稿子，用户要的不是"读起来更像人"，而是一句话
 * **能不能投**。同类项目（junbolian/Academic-Humanizer）卖的就是这个——
 * 数字、公式、引用原样保留，缺证据的地方打占位符，模板没清干净就明写"NOT READY TO SUBMIT"。
 * 本仓已经有零件（数字/单位守卫、结构保真 23 条、逐条改动），缺的是把它们收成一个
 * 带退出码的判定。
 *
 * 边界：
 *  · 只判**可机器判**的事：数字/单位、引用键、结构、断言词、残留套话。
 *    「论证是否成立」「结论是否过头」这类判断不做——那是评审的活，机器判不了。
 *  · 判定为 NOT READY 不等于稿子差，等于"机器看见了必须人看一眼的改动"。
 *  · 不带引用的稿子不会因此判失败；找不到可判的证据时给 ready + 一句"没有可校验项"。
 */
import { formatIssues, type FormatIssue } from "./format-integrity";
import { numericFidelityWarning } from "./number-fidelity";
import { reviewText } from "./review";

/** 引用/交叉引用键的形态：LaTeX、Pandoc、纯数字方括号三种最常用 */
const CITE_PATTERNS: { label: string; re: RegExp }[] = [
  { label: "\\cite", re: /\\cite[a-z]*\{([^}]*)\}/g },
  { label: "\\ref", re: /\\ref\{([^}]*)\}/g },
  { label: "\\label", re: /\\label\{([^}]*)\}/g },
  { label: "[@key]", re: /\[@([^\]]+)\]/g },
  { label: "[[EVIDENCE]]", re: /\[\[EVIDENCE:([^\]]*)\]\]/g },
];

/** 断言词：产出里冒出来、原文没有，就是"机器把你的结论说重了" */
const ASSERTIONS = ["显著", "最优", "首次", "证明了", "完全", "必然", "毫无疑问", "彻底"];

export interface AcademicAudit {
  /** ready = 可以拿去投；blocked = 有必须人看一眼的阻断项 */
  verdict: "ready" | "blocked";
  /** 阻断项：数字/单位被改、引用键丢失或凭空出现、结构被破坏 */
  blockers: string[];
  /** 提醒项：断言变重、残留套话 —— 不阻断，但要读 */
  warnings: string[];
  /** 机器这轮到底查了什么，空查要说出来，不能假装查过 */
  checked: string[];
  stats: { charsIn: number; charsOut: number; citeKeys: number; structureIssues: number };
}

/** 抽出所有引用键（去重） */
function citeKeys(text: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const { label, re } of CITE_PATTERNS) {
    const set = new Set<string>();
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      for (const k of m[1].split(",")) {
        const key = k.trim();
        if (key) set.add(key);
      }
    }
    out.set(label, set);
  }
  return out;
}

/**
 * 审一篇：原文 vs 产出。
 *
 * 只做确定性比对，不调用任何模型、不联网。同一对输入永远给同一个结论。
 */
export function academicAudit(original: string, rewritten: string): AcademicAudit {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const checked: string[] = [];

  // 1) 数字与单位
  checked.push("数字与单位（numericFidelityWarning）");
  const num = numericFidelityWarning(original, rewritten);
  if (num) blockers.push(num);

  // 2) 结构（代码块/表格/标题/引用块/列表）
  checked.push("结构保真（formatIssues，23 条不变式）");
  let issues: FormatIssue[] = [];
  try {
    issues = formatIssues(original, rewritten);
  } catch {
    warnings.push("结构检查本身抛错了，这一项没查成——请当未检查处理");
  }
  for (const it of issues.slice(0, 6)) blockers.push(`结构：${it.rule} —— ${it.detail}`);

  // 3) 引用键：丢了是事故，凭空多了是编造
  checked.push("引用/交叉引用键（\\cite / \\ref / \\label / [@key] / [[EVIDENCE]]）");
  const before = citeKeys(original);
  const after = citeKeys(rewritten);
  let keyCount = 0;
  for (const [label, set] of before) {
    keyCount += set.size;
    const now = after.get(label) ?? new Set<string>();
    const missing = [...set].filter((k) => !now.has(k));
    if (missing.length)
      blockers.push(
        `引用键丢失（${label}）：${missing.slice(0, 5).join("、")}${missing.length > 5 ? ` 等 ${missing.length} 个` : ""}`,
      );
    const added = [...now].filter((k) => !set.has(k));
    if (added.length)
      blockers.push(`产出里出现了原文没有的引用键（${label}）：${added.slice(0, 5).join("、")}`);
  }

  // 4) 断言强度：只在"原文没有、产出有"时报
  checked.push("断言强度（显著/最优/首次/证明了…）");
  const raised = ASSERTIONS.filter((w) => rewritten.includes(w) && !original.includes(w));
  if (raised.length)
    warnings.push(`产出新增了更硬的断言：${raised.join("、")}——原文没有这些词，请确认结论没被说重`);

  // 5) 残留套话
  checked.push("残留 AI 痕迹（reviewText）");
  const review = reviewText(rewritten);
  if (review.summary.length) {
    warnings.push(
      "产出仍有痕迹：" +
        review.summary
          .slice(0, 5)
          .map(([k, v]) => `${k}×${v}`)
          .join("、"),
    );
  }

  if (!keyCount) warnings.push("这轮没找到引用键，引用完整性这一项属于空查（草稿/短文常见）");

  return {
    verdict: blockers.length ? "blocked" : "ready",
    blockers,
    warnings,
    checked,
    stats: {
      charsIn: original.length,
      charsOut: rewritten.length,
      citeKeys: keyCount,
      structureIssues: issues.length,
    },
  };
}

/** 报告正文（stdout 用）：给人读，含一句硬结论 */
export function formatAcademicReport(
  a: AcademicAudit,
  opts: { style: string; intensity: number; mode?: string },
): string {
  const lines: string[] = [];
  lines.push("# 学术自检（本地，确定性）");
  lines.push("");
  lines.push(
    a.verdict === "blocked"
      ? "结论：**NOT READY TO SUBMIT**（有阻断项，见下）"
      : "结论：**READY**（机器没看见阻断项）",
  );
  if (opts.mode) lines.push(`对比方式：${opts.mode}`);
  else
    lines.push(
      `原文 ${a.stats.charsIn} 字 → 产出 ${a.stats.charsOut} 字 · 文风 ${opts.style} · 强度 ${opts.intensity}`,
    );
  lines.push("");

  lines.push("## 阻断项");
  if (!a.blockers.length) lines.push("无。");
  for (const b of a.blockers) lines.push(`- ${b}`);

  lines.push("");
  lines.push("## 提醒（不阻断，但要读）");
  if (!a.warnings.length) lines.push("无。");
  for (const w of a.warnings) lines.push(`- ${w}`);

  lines.push("");
  lines.push("## 这轮查了什么");
  for (const c of a.checked) lines.push(`- ${c}`);
  lines.push("");
  lines.push(
    `字数：原文 ${a.stats.charsIn} → 待检 ${a.stats.charsOut}；可校验引用键 ${a.stats.citeKeys} 个`,
  );

  lines.push("");
  lines.push("## 边界");
  lines.push("- 只判能机器判的事：数字/单位、引用键、结构、断言词、残留套话。");
  lines.push("- **论证是否成立、结论是否过头，机器判不了**，READY 不等于审稿人会收。");
  lines.push("- NOT READY 不等于稿子差，等于「机器看见了必须人看一眼的改动」。");

  return lines.join("\n");
}
