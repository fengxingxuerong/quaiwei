/**
 * scripts/pin-guard.ts —— 事实钉住（v0.9.89，竞品吸收：sgaofen 的 Create fact）。
 *
 * 用户指定若干「逐字保留」的片段（事实、数字、引文、专名、承诺句），改写前后必须原样出现。
 * 实现走 CLI 层占位符 + 还原，**不改引擎、不动 2240 用例基线**：
 *
 *  1) preparePins：把命中片段替换成 Unicode 私用区占位符 U+E000<i>U+E001。
 *     私用区字符不进任何词表、标点表、数字守卫、结构守卫的匹配面——引擎看不见它们，
 *     因此不会切句/换词/注入/重排到占位符内部。
 *  2) restorePins：改写完成后按 token 换回原文。
 *  3) 任何一个 token 丢了对不上 ⇒ 调用方必须**整篇回退原文**（宁可不改，也不毁事实）。
 *
 * 契约：纯函数、确定性；同一 text + pins 永远得到同一 token 序列。
 */
import { frontmatterSpans, fencedCodeSpans, type TextSpan } from "../src/engine/text-shield.ts";

/** 占位符左右边界（Unicode 私用区，正常中文文稿不会出现）——本地引擎路径用 */
export const PIN_OPEN = "\uE000";
export const PIN_CLOSE = "\uE001";
/**
 * LLM 路径专用可读占位符：私用区字符会被 LLM 当噪声剥掉（实测 U+E0000U+E001 → "0"），
 * 自描述的中文标记存活率高得多。仍不保证 100%，缺失时 restorePins 报 missing → 整篇回退。
 */
export const PIN_LLM_OPEN = "⟦逐字保留";
export const PIN_LLM_CLOSE = "⟧";

/** 钉住片段最短可见字符数：短于 4 字会到处命中且无事实意义 */
export const PIN_MIN_CHARS = 4;

/** 单篇最多钉住片段数（防手滑把整篇切碎） */
export const PIN_MAX = 64;

export interface PinParseResult {
  pins: string[];
  /** 被跳过的行（空行/过短/注释），逐条给原因供 CLI 提示 */
  skipped: { line: number; reason: string }[];
}

/**
 * 解析 pin 文件：一行一个片段，保留行内空格（只剥 CRLF 的 \r），
 * 空行与 `#` 起的注释行跳过，可见字符 < PIN_MIN_CHARS 的片段跳过。
 */
export function parsePinFile(content: string): PinParseResult {
  const pins: string[] = [];
  const skipped: PinParseResult["skipped"] = [];
  const seen = new Set<string>();
  content.split(/\r?\n/).forEach((raw, idx) => {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || line.trimStart().startsWith("#")) return;
    const visible = line.replace(/\s/g, "").length;
    if (visible < PIN_MIN_CHARS) {
      skipped.push({ line: idx + 1, reason: `可见字符 ${visible} < ${PIN_MIN_CHARS}` });
      return;
    }
    if (seen.has(line)) return;
    if (pins.length >= PIN_MAX) {
      skipped.push({ line: idx + 1, reason: `超过单篇上限 ${PIN_MAX}` });
      return;
    }
    seen.add(line);
    pins.push(line);
  });
  return { pins, skipped };
}

export interface PreparedPins {
  text: string;
  /** 实际命中并被替换的片段（按 token 序号） */
  pins: string[];
  /** 在原文里一次都没命中的片段（CLI 提示用，不算失败） */
  unmatched: string[];
}

/**
 * 把命中的 pin 片段换成占位符。长片段优先，避免短片段是长片段子串时抢先替换。
 * 同一片段在原文出现多次时全部替换（语义：「这类内容都逐字保留」）。
 */
export function preparePins(text: string, pins: string[], llmMode = false): PreparedPins {
  const open = llmMode ? PIN_LLM_OPEN : PIN_OPEN;
  const close = llmMode ? PIN_LLM_CLOSE : PIN_CLOSE;
  // 已含占位符边界的原文直接拒绝——防止用户文稿本身带边界字符造成还原错乱。
  if (text.includes(open) || text.includes(close)) {
    return { text, pins: [], unmatched: pins.slice() };
  }
  let out = text;
  const active: string[] = [];
  const unmatched: string[] = [];
  for (const pin of [...pins].sort((a, b) => b.length - a.length)) {
    if (!out.includes(pin)) {
      unmatched.push(pin);
      continue;
    }
    const token = `${open}${active.length}${close}`;
    out = out.split(pin).join(token);
    active.push(pin);
  }
  return { text: out, pins: active, unmatched };
}

export interface RestoredPins {
  text: string;
  restored: number;
  /** 没换回来的 token 序号（改写把占位符拆了/吃了） */
  missing: number[];
}

/** 改写后按 token 换回原文。missing 非空 ⇒ 调用方必须整篇回退。 */
export function restorePins(out: string, pins: string[], llmMode = false): RestoredPins {
  let text = out;
  const missing: number[] = [];
  let restored = 0;
  for (let i = 0; i < pins.length; i++) {
    const token = llmMode ? `${PIN_LLM_OPEN}${i}${PIN_LLM_CLOSE}` : `${PIN_OPEN}${i}${PIN_CLOSE}`;
    if (!text.includes(token)) {
      missing.push(i);
      continue;
    }
    text = text.split(token).join(pins[i]);
    restored++;
  }
  return { text, restored, missing };
}

/**
 * v0.9.90：pin 失败后的保真重试（纯逻辑，重试动作由调用方以回调注入）。
 *
 * 第一次还原若丢了哨兵，调用 `rewrite()` 重跑一次改写（调用方用更低强度），
 * 再尝试还原；仍丢才返回 missing（调用方据此整篇回退）。无回调或首次成功则不重试。
 * `out` 字段在最终仍失败时为空串——调用方应据此回退原文，不要用半成品。
 */
export async function restorePinsWithRetry(
  out: string,
  pins: string[],
  llmMode: boolean,
  rewrite: (() => Promise<string>) | null,
): Promise<{ out: string; missing: number[]; retried: boolean }> {
  const first = restorePins(out, pins, llmMode);
  if (!first.missing.length || !rewrite) {
    return { out: first.missing.length ? "" : first.text, missing: first.missing, retried: false };
  }
  const second = await rewrite();
  const restored2 = restorePins(second, pins, llmMode);
  return {
    out: restored2.missing.length ? "" : restored2.text,
    missing: restored2.missing,
    retried: true,
  };
}

/**
 * v0.9.90：自动结构钉住——从原文提取「本地引擎已逐字保护、但 LLM 路径会重写」的结构块。
 *
 * 为什么需要：C23-frontmatter-indent 实测，--api 改写把 YAML frontmatter
 * （`date: 2026-10-18`）整块吞掉，丢了 3 个数字；11-13 旧臂却保留了。本地引擎有
 * `format-integrity.ts` 逐字冻结 frontmatter / 围栏块，但 LLM 拿到整篇重写时看不到这层保护。
 * 这里把结构块交给 pin 通道：LLM 只见占位符，产出后按 token 还原；任一块丢失 ⇒ 整篇回退。
 *
 * 提取范围与 `format-integrity.ts` 对齐：frontmatter（含首尾 ---）+ 围栏代码块（含围栏行）。
 * 缩进代码块不提取——它是 4 空格前缀的续行，整块钉住会连同前后正文一起吞，且实测 LLM
 * 对缩进块存活率较高（C23 新臂保留了代码行本身）；若用户要逐字保留可显式 --pin。
 *
 * 片段内若已含 pin 占位符边界（⟦逐字保留 / ⟧ 或私用区字符）则跳过该块——
 * 否则 preparePins 会因「原文自带边界」整体拒绝钉住，把用户显式 pin 也一起废掉。
 */
const PIN_BOUNDARIES = [PIN_OPEN, PIN_CLOSE, PIN_LLM_OPEN, PIN_LLM_CLOSE];

export function autoStructurePins(text: string): string[] {
  if (!text) return [];
  const spans: TextSpan[] = [...frontmatterSpans(text), ...fencedCodeSpans(text)].sort(
    (a, b) => a.start - b.start,
  );
  const out: string[] = [];
  for (const s of spans) {
    const block = text.slice(s.start, s.end);
    if (!block.trim()) continue;
    if (PIN_BOUNDARIES.some((b) => block.includes(b))) continue;
    // 去重：frontmatter 与围栏不会重叠，但保险起见
    if (!out.includes(block)) out.push(block);
  }
  return out;
}
