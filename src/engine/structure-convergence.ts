/**
 * src/engine/structure-convergence.ts —— 按结构目标收敛句读密度（**只改标点，不改一个字**）
 *
 * ## 为什么是「后处理还原」而不是「少切一点」
 *
 * `--metrics` 首跑（`evidence/structure-metrics-2026-11-07/`）量出：真人原文
 * 20.63 句号/千字、句长 41.17、逗号/句 1.49 → 引擎 37.35 / 23.78 / 0.51。
 * 碎句化的本质是「复句被拆成单句」，不是切得更短这么简单。
 *
 * 早先三次切句收敛（切点守卫 / 单入口预算 / 四入口 `splitScale`）都失败：
 * 四入口全接上只降 13%，还撞 12 样本棘轮。2026-11-08 的逐阶段句号计数诊断
 * 给出了原因（15 篇真人长文，intensity 0.6）：
 *
 * ```
 * 输入 50.8 → para +7.7 → rhythm +16.4 → clamp +13.7 → burst +3.1 → 91.7
 * ```
 *
 * 四个阶段各自按「句长均值 / CV 达标」循环到满足为止，压刀数上限不等于压句号数；
 * 且 `para` 段内的 `splitOnConnectors` / `burst-single` 根本没被 `splitScale` 接到。
 * 更要命的是 `clamp` 与 `limitPunctuation("……",1,"。")` 无条件生效。
 *
 * 所以这一版不再逐个阶段去猜预算，而是**在流水线末尾直接对目标值收敛**：
 * 把引擎自己造出来的、原文里没有的句号还原成逗号，直到句读密度回到目标区间。
 * 好处是单点落子、不碰任何守卫与词表、可复算（`--metrics` 同一口径）、
 * 且「只改标点」让「不新增事实」在构造上继续成立。
 *
 * ## ⚠️ 2026-11-08 双席裁决：结构达标 ≠ 评委认可，故默认不接产品路径
 *
 * 15 篇真人长文上三项结构指标全部向真人基线靠拢（37.35 → 24.26 句号/千字），
 * 但双席异源配对（glm-5.3-flash + qodercn/dfmodel，30 票）里收敛稿只赢 **8 票 = 0.267**，
 * 双席一致 0.733 —— 评委明显更偏好碎句版。按项目「能力验收必须双席配对」的口径，
 * 这是退化，不能推成默认行为。`humanize()` 只在 `opts.convergence === true` 时调用本模块；
 * 完整数据与两把尺子冲突的讨论见 `evidence/structure-convergence-2026-11-08/`。
 *
 * ## 判据纪律
 *
 * 1. **短文本逐字不变**：原文去空白字数 < `minChars`（默认 1000）时原样返回。
 *    12 样本最长 718 字、realcase 最长 453 字、V8_CORPUS 均短 ⇒ 棘轮与既有
 *    单测基线不受影响；碎句化本来也只在长文上显著。
 * 2. **目标取「相对原文 + 绝对上限」的较严者**：
 *    `target = max(原文密度, min(25/千字, 原文密度 + 4.4/千字))`。
 *    原文密度高的稿子（如红楼梦 29.6/千字）不会为了凑 25 而把原文句号也改掉。
 * 3. **原文句读用前后锚保护**：原文每处句读的「前 5 字 / 后 5 字」进锚集合，
 *    产出里命中任一锚的句号一律不动。宁可少还原，不可误还原原文句读。
 * 4. **只还原段内 `。`**：不跨段落、不动 `！？`、不动代码块 / 表格 / URL 段落、
 *    不还原后接引号的句号、不把两句并成 >72 字的超长句。
 * 5. **确定性排序**：按「前句 + 后句字数」升序、同分按位置升序取前 N 个，
 *    同输入同输出，不调随机数、不联网、不调模型。
 */

import { isProtectedBlock } from "./text-shield.ts";

export interface ConvergenceOptions {
  /** 绝对上限：每千字句末标点数（默认 25，来自 15 篇真人长文基线） */
  targetPeriodPerK?: number;
  /** 相对原文允许新增的每千字句末标点数（默认 4.4） */
  allowancePerK?: number;
  /** 启用门槛：原文去空白字数低于此值一律原样返回（默认 1000） */
  minChars?: number;
}

export interface ConvergenceResult {
  text: string;
  applied: boolean;
  before: number;
  after: number;
  targetCount: number;
  restored: number;
  candidates: number;
  skipped: "short" | "already-ok" | "no-candidate" | null;
}

const DEFAULT_TARGET = 25;
const DEFAULT_ALLOWANCE = 4.4;
const DEFAULT_MIN_CHARS = 1000;
/** 合并后两句的总字数上限：真人长文句长均值 41 字，留约 1.8 倍余量 */
const MAX_MERGED_LEN = 72;
const ANCHOR_LEN = 5;
const PUNCT_STRIP_RE = /[\s，。！？!?；;、：:「」『』（）()【】《》,.;:'"]/g;
const TERMINAL_RE = /[。！？!?]/g;

const countTerminals = (t: string): number => (t.match(TERMINAL_RE) ?? []).length;
const nchars = (t: string): number => t.replace(/\s/g, "").length;
const stripPunct = (t: string): string => t.replace(PUNCT_STRIP_RE, "");

/** 原文句读的前后锚：`B`=句读前 5 字，`A`=句读后 5 字。 */
function buildAnchors(orig: string): Set<string> {
  const out = new Set<string>();
  for (const m of orig.matchAll(TERMINAL_RE)) {
    const i = m.index ?? 0;
    const before = stripPunct(orig.slice(Math.max(0, i - 40), i)).slice(-ANCHOR_LEN);
    const after = stripPunct(orig.slice(i + 1, i + 41)).slice(0, ANCHOR_LEN);
    if (before.length >= 3) out.add("B" + before);
    if (after.length >= 3) out.add("A" + after);
  }
  return out;
}

interface Candidate {
  pos: number;
  score: number;
}

function nextTerminal(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === "。" || s[i] === "！" || s[i] === "？" || s[i] === "!" || s[i] === "?") return i;
  }
  return -1;
}

function prevTerminal(s: string, before: number): number {
  for (let i = before - 1; i >= 0; i--) {
    if (s[i] === "。" || s[i] === "！" || s[i] === "？" || s[i] === "!" || s[i] === "?") return i;
  }
  return -1;
}

/** 找出所有可还原的段内句号。保守：形态不对 / 命中原文锚 / 合并过长，一律跳过。 */
function findCandidates(out: string, anchors: Set<string>): Candidate[] {
  const cands: Candidate[] = [];
  const parts = out.split(/(\n+)/);
  let off = 0;
  for (const part of parts) {
    if (part && !/^\n+$/.test(part) && !isProtectedBlock(part)) {
      // 表格行、URL、代码围栏整段跳过：这些地方的句号是结构的一部分
      const structural = /^\s*\|/.test(part) || part.includes("://") || part.includes("www.");
      if (!structural) {
        for (let i = 0; i < part.length; i++) {
          if (part[i] !== "。") continue;
          const rest = part.slice(i + 1);
          if (!rest || /^[》」』）)\]]/.test(rest)) continue;

          const before = stripPunct(part.slice(Math.max(0, i - 40), i)).slice(-ANCHOR_LEN);
          const after = stripPunct(part.slice(i + 1, i + 41)).slice(0, ANCHOR_LEN);
          if (before.length >= 3 && anchors.has("B" + before)) continue;
          if (after.length >= 3 && anchors.has("A" + after)) continue;

          const p = prevTerminal(part, i);
          const n = nextTerminal(part, i + 1);
          const prevLen = stripPunct(part.slice(p + 1, i)).length;
          const nextLen = stripPunct(part.slice(i + 1, n < 0 ? part.length : n)).length;
          if (prevLen + nextLen > MAX_MERGED_LEN) continue;

          cands.push({ pos: off + i, score: prevLen + nextLen });
        }
      }
    }
    off += part.length;
  }
  return cands;
}

/**
 * 把产出里「引擎自己造出来」的句号还原成逗号，直到句读密度回到目标区间。
 * 纯函数：不修改入参、同输入同输出。
 */
export function convergeSentenceDensity(
  orig: string,
  out: string,
  opts: ConvergenceOptions = {},
): ConvergenceResult {
  const targetPerK = opts.targetPeriodPerK ?? DEFAULT_TARGET;
  const allowance = opts.allowancePerK ?? DEFAULT_ALLOWANCE;
  const minChars = opts.minChars ?? DEFAULT_MIN_CHARS;
  const before = countTerminals(out);
  const base: ConvergenceResult = {
    text: out,
    applied: false,
    before,
    after: before,
    targetCount: before,
    restored: 0,
    candidates: 0,
    skipped: null,
  };

  const origChars = nchars(orig);
  if (origChars < minChars) return { ...base, skipped: "short" };

  const outChars = nchars(out);
  if (outChars === 0) return { ...base, skipped: "short" };

  const origDensity = (countTerminals(orig) / origChars) * 1000;
  const targetDensity = Math.max(origDensity, Math.min(targetPerK, origDensity + allowance));
  const targetCount = Math.ceil((outChars / 1000) * targetDensity);
  if (before <= targetCount) return { ...base, targetCount, skipped: "already-ok" };

  const need = before - targetCount;
  const cands = findCandidates(out, buildAnchors(orig));
  if (cands.length === 0) return { ...base, targetCount, skipped: "no-candidate" };

  cands.sort((a, b) => a.score - b.score || a.pos - b.pos);
  const chosen = cands.slice(0, Math.min(need, cands.length));
  const arr = out.split("");
  for (const c of chosen) arr[c.pos] = "，";
  let text = arr.join("");
  text = text.replace(/，{2,}/g, "，").replace(/、，/g, "，");

  return {
    text,
    applied: chosen.length > 0,
    before,
    after: countTerminals(text),
    targetCount,
    restored: chosen.length,
    candidates: cands.length,
    skipped: chosen.length < need ? "no-candidate" : null,
  };
}
