/**
 * 结构化串（URL / 邮箱）的**区间表**——切句时用来跳过串内部的标点。
 *
 * ## 为什么不用占位符
 *
 * v0.9.24 ⑩ 曾用「U+E000~U+E00F 占位符 + 还原」修 URL 腰斩，实测有两个坑：
 *
 * 1. **槽位上限 16**：`String.fromCharCode(0xe000 + n)` 在第 17 个结构化串处溢出到
 *    U+E010，超出还原正则 `[\uE000-\uE00F]` ⇒ 该串**永久丢失**、原位留下私用区乱码。
 *    实测（`artifacts/_probe-shield-cap.ts`）：40 个 URL 只剩 16 个，24 个变乱码。
 * 2. **破坏原文偏移**：`zhuque.ts` 的切句要保留 `start/end` 供 UI 高亮，
 *    占位符把多字符压成 1 字符，偏移全乱。
 *
 * 区间表两个问题都没有：它**不改动原文本**，只告诉调用方「哪些下标在串内部」。
 *
 * ## 用法
 *
 * - 需要保留偏移的切句（`zhuque.ts`）：拿 `structuredSpans()` + `spanGuard()`，
 *   遇到切点时先问 `guard(idx)`。
 * - 不需要偏移的切句（`detector.ts` / `classify-genre.ts`）：同样用 guard，
 *   只跳过落在串内的切点，其余语义一字不动。
 *
 * ⚠️ 判据刻意**只覆盖 URL 与邮箱**：版本号、时间、数字里没有切句标点，
 * 纳入只会让判据变宽、误伤正常句子（v0.9.24 ⑩ 的教训）。
 */

/** 结构化串区间，左闭右开 `[start, end)`，按起点升序、互不重叠 */
export interface TextSpan {
  start: number;
  end: number;
}

/**
 * 与 v0.9.24 ⑩ 的屏蔽正则**逐字一致**——保持行为不变，只换掉承载方式。
 * - `(?:https?:\/\/|www\.)[!-~]+`：URL，`[!-~]` 是 ASCII 可打印区，遇空格/中文自然止步
 * - `[\w.+-]+@[\w.-]+\.\w+`：邮箱
 */
const STRUCTURED_RE = /(?:https?:\/\/|www\.)[!-~]+|[\w.+-]+@[\w.-]+\.\w+/g;

/** 文本里所有 URL / 邮箱的区间。无匹配时返回空数组（调用方可放心遍历）。 */
export function structuredSpans(text: string): TextSpan[] {
  if (!text) return [];
  const out: TextSpan[] = [];
  STRUCTURED_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STRUCTURED_RE.exec(text)) !== null) {
    // 零宽匹配防御：正则两段都要求 ≥1 字符，理论上不可能，但 exec 循环里
    // 一旦出现零宽就会死循环，所以显式推进一次
    if (m[0].length === 0) {
      STRUCTURED_RE.lastIndex++;
      continue;
    }
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * 造一个「下标是否落在结构化串内部」的判定器（二分，O(log n)）。
 *
 * 传 `null`/空数组时返回恒 false —— 让调用方不需要写分支。
 */
export function spanGuard(spans: TextSpan[] | null | undefined): (idx: number) => boolean {
  if (!spans || spans.length === 0) return () => false;
  const starts = spans.map((s) => s.start);
  return (idx: number): boolean => {
    // 找最后一个 start <= idx 的区间
    let lo = 0;
    let hi = spans.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= idx) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found < 0) return false;
    return idx < spans[found].end;
  };
}

/**
 * v0.9.50：书名号引用的区间（《…》）。
 *
 * 起因（scripts/realcase C11 行政通知实测）：标题里的词被 VOCAB 改了——
 *   《合肥市智能制造成熟度评估**实施细则**》 → 《…评估**执行细则**》
 * 这是**改写事实**：文件标题是专名，改动它等于把一份不存在的文件塞给读者。
 * 比"语体崩"严重一档，和"URL/邮箱不得丢"同性质 ⇒ 与 URL 一样用区间保护。
 *
 * 为什么只收《》不收引号：引号里的多半是台词/发言，那正是要去味的对象；
 * 书名号里的是**作品名/文件名的字面本身**，动它一个字都叫篡改。
 */
const CITED_TITLE_RE = /《[^》]*》/g;

export function citedTitleSpans(text: string): TextSpan[] {
  if (!text) return [];
  const out: TextSpan[] = [];
  CITED_TITLE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CITED_TITLE_RE.exec(text)) !== null) {
    if (m[0].length === 0) {
      CITED_TITLE_RE.lastIndex++;
      continue;
    }
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** 一步到位：`structuredSpans(text)` + `spanGuard(...)` */
export function guardFor(text: string): (idx: number) => boolean {
  return spanGuard(structuredSpans(text));
}

/* ------------------------------------------------------------------ *
 * v0.9.54+：Markdown 围栏代码块（``` / ~~~）
 *
 * 起因（2026-10-17 追 realcase C9「段落 6→7」时实测抓出）：
 *   humanize 的段落切分是 `text.split(/\n+/)` + `join("\n\n")`——
 *   **每一行都被当成独立段落，段间距被统一拉成双换行**。后果有两层：
 *     ① 代码块被逐行炸开（行与行之间凭空多出空行）；
 *     ② 更要紧的是每行独立跑 humanizeSingle，围栏里的**中文注释被当正文改写**
 *        （实测「此外，需要说明的是」→「再说，需要说明的是」）。
 *
 * 代码是**事实性内容**，与 URL / 邮箱 / 书名号同性质：改它不叫去味，叫篡改。
 * 这里按既有惯例给出区间（不动原文、不占字符），由调用方整块跳过。
 *
 * ⚠️ 为什么不用正则一次匹配整块：围栏的闭合行要求「同种字符且长度 ≥ 开口」，
 * 一条正则写下来既难读又容易在 `[^]` 类字符上踩坑（本项目有 check:regex 专门查）。
 * 逐行扫描只有十来行，判据一眼可核对。
 * ------------------------------------------------------------------ */

/** 行首（允许缩进）的三个及以上反引号 / 波浪号 */
const FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;

/** 围栏代码块的区间，**含开口行与闭合行本身**（不含闭合行之后的换行）。未闭合则到文末。 */
export function fencedCodeSpans(text: string): TextSpan[] {
  if (!text) return [];
  const out: TextSpan[] = [];
  let off = 0;
  let start = -1;
  let fence = "";
  for (const line of text.split("\n")) {
    const m = FENCE_RE.exec(line);
    if (m) {
      if (start < 0) {
        start = off;
        fence = m[1];
      } else if (m[1][0] === fence[0] && m[1].length >= fence.length) {
        out.push({ start, end: off + line.length });
        start = -1;
        fence = "";
      }
    }
    off += line.length + 1; // +1 补回被 split 吃掉的 \n
  }
  if (start >= 0) out.push({ start, end: text.length });
  return out;
}

/**
 * 段落级判定：这一段是不是围栏代码块（**不需要偏移，只看文本形状**）。
 *
 * 为什么还要有这个：段落级冻结靠 `fencedCodeSpans` 的偏移，但结构层 / 节奏层跑在
 * **已被改写**的 result 上，原文偏移早已对不上。而围栏开口行是稳定的文本特征——
 * 只要段首是 ``` / ~~~，这一整段就是代码，不管前面几步把它改成什么样。
 *
 * 判据刻意只看首行：围栏块内可以出现缩进的 ```（嵌套围栏），那不该被当成新开口。
 */
export function isFencedBlock(para: string): boolean {
  const first = para.split("\n", 1)[0] ?? "";
  return FENCE_RE.test(first);
}

/** 带原文偏移与原始分隔符的段落切分——冻结块要能按**原样**拼回去 */
export interface ParaChunk {
  text: string;
  /** 该段首字符在原文中的下标（用来问 spanGuard） */
  start: number;
  /** 该段**之后**的原始分隔符；最后一段为 "" */
  sep: string;
}

/**
 * 按 `\n+` 切段，同时保留偏移与分隔符。
 *
 * 与 `text.split(/\n+/)` 等价（同样丢空段），但多带两个字段——冻结块（代码块）
 * 要靠 `sep` 拼回原文的行间距，靠 `start` 判断自己是否落在保护区里。
 */
export function splitParagraphChunks(text: string): ParaChunk[] {
  const out: ParaChunk[] = [];
  const re = /\n+/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ text: text.slice(last, m.index), start: last, sep: m[0] });
    last = m.index + m[0].length;
  }
  out.push({ text: text.slice(last), start: last, sep: "" });
  return out.filter((c) => c.text.trim());
}

/* ------------------------------------------------------------------ *
 * v0.9.54+：紧凑 Markdown 结构行（表格 / 列表项 / 引用行）
 *
 * 与围栏**同源但不同治**：围栏是「不许改内容」，这里是「内容照改、但**不许插空行**」。
 *
 * 起因（2026-10-18 实测，与围栏同一次追查）：段落切分把每一行当独立段落、
 * 再 `join("\n\n")` 统一拉成双换行，于是——
 *   · 表格：表头 `| a | b |` 与分隔行 `| --- | --- |` 之间被塞进空行
 *     ⇒ CommonMark/GFM 表格**直接失效**，渲染成一堆竖线文本；
 *   · 列表：三个 `- 项` 之间被塞进空行 ⇒ 紧凑列表变松散列表（`<li>` 各自包 `<p>`），
 *     行距与作者原意不符；
 *   · 引用：连续 `>` 行被拆成多个独立 blockquote。
 *
 * 这些行的内容**仍要去味**（列表项是正文，不是代码），所以走的是
 * 「保留原文分隔符」而不是「整块冻结」——见 humanize.ts 的 join 循环。
 *
 * ⚠️ 判据刻意只认**行首标记**，且不含围栏（``` / ~~~ 由 fencedCodeSpans 管）：
 * 缩进代码块、行内 `code` 都不在此列，避免判据过宽误伤普通段落。
 * ------------------------------------------------------------------ */

const MD_STRUCT_RE = /^[ \t]*(?:\||>|[-*+][ \t]|\d+[.)][ \t])/;

/**
 * 这一段是不是「紧凑 Markdown 结构行」——表格行 / 列表项 / 引用行。
 * 是的话它与相邻同类行之间要沿用**原文分隔符**，不能被统一拉成 `\n\n`。
 */
export function isMarkdownStructLine(para: string): boolean {
  return MD_STRUCT_RE.test(para);
}

/**
 * 下游层（结构重排 / 节奏切句 / 语气密度 / 段落重组）的**整段跳过**判据。
 *
 * 比段落级冻结宽一档——围栏块（不许改内容）与紧凑结构行（内容照改、不许插空行）
 * 在这四个层里待遇相同：它们内部都跑 `splitSentences` + `join("")`，
 * 一行一个列表项 / 一行一个表格行，进去就变成连写的一坨。
 *
 * ⚠️ 与 `frozen` 的区别只在 humanize() 主流程：那里结构行仍要过 humanizeSingle 去味，
 * 只有围栏块整块不动。
 */
export function isProtectedBlock(para: string): boolean {
  return isFencedBlock(para) || isMarkdownStructLine(para);
}
