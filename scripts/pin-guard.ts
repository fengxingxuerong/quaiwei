/**
 * scripts/pin-guard.ts —— 事实钉住（v0.9.89，竞品吸收：sgaofen 的 Create fact）。
 *
 * 用户指定若干「逐字保留」的片段（事实、数字、引文、专名、承诺句），改写前后必须原样出现。
 * 实现走 CLI 层占位符 + 还原，**不改引擎、不动 2375 用例基线**：
 *
 *  1) preparePins：把命中片段替换成 Unicode 私用区占位符 U+E000<i>U+E001。
 *     私用区字符不进任何词表、标点表、数字守卫、结构守卫的匹配面——引擎看不见它们，
 *     因此不会切句/换词/注入/重排到占位符内部。
 *  2) restorePins：改写完成后按 token 换回原文。
 *  3) 任何一个 token 丢了对不上 ⇒ 调用方必须**整篇回退原文**（宁可不改，也不毁事实）。
 *
 * 契约：纯函数、确定性；同一 text + pins 永远得到同一 token 序列。
 */

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
    const token = llmMode
      ? `${PIN_LLM_OPEN}${i}${PIN_LLM_CLOSE}`
      : `${PIN_OPEN}${i}${PIN_CLOSE}`;
    if (!text.includes(token)) {
      missing.push(i);
      continue;
    }
    text = text.split(token).join(pins[i]);
    restored++;
  }
  return { text, restored, missing };
}
