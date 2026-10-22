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

/**
 * 剧本格式的场景/人物/背景/时间/角色/旁白/简介 块头行正则（P7-E 共用，唯一实现）。
 *
 * 无锚 + 行内扫描：前置方言/观点注入会在段首加垫词，^ 锚定的整段匹配会被击穿
 * （台词区被塞自问自答的真实缺陷）。
 *
 * v0.9.54：此前 anti-fingerprint / humanize-guard / humanize-replace 各存一份**逐字相同**
 * 的拷贝，任何口径调整都要三处同步（漏一处就是两级判据打架）——现收拢到本模块。
 * 注意 classify-genre.ts 里另有一条**刻意更窄**的 40 字宽版本（只算体裁占比特征，
 * 不含旁白/简介），不是笔误，未合并。
 */
export const SCENE_BLOCK_LINE_RE =
  /【[^】]{0,80}(?:场景|人物|角色|地点|时间|背景|旁白|简介)[^】]{0,80}】/;

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
  return (
    isFencedBlock(para) ||
    isMarkdownStructLine(para) ||
    isIndentedBlock(para) ||
    isFrontmatterBlock(para)
  );
}

/**
 * YAML frontmatter 块（拼回后是一整段，首行是 `---`）。
 *
 * 必须单独有一条：frontmatter 拼回后段内带 `\n`，下游层若不整段跳过，
 * `splitSentences` + `join("")` 会把换行全吃掉
 * （实测：`---title: 项目周报---date: 2026-10-18`）。
 * 水平分割线（单独一行 `---`）落进同一判据也无害——它同样是结构标记，不该被改写。
 */
const FRONTMATTER_HEAD_RE = /^---[ \t]*\r?$/;

export function isFrontmatterBlock(para: string): boolean {
  return FRONTMATTER_HEAD_RE.test(para.split("\n", 1)[0] ?? "");
}

/* ------------------------------------------------------------------ *
 * v0.9.54+（第三形态）：缩进块——CommonMark 缩进代码块 **与** 列表项续行
 *
 * 判据只有一条：段首是 4 个空格或一个 tab。
 *
 * 这一个判据同时覆盖两种东西，而它们要的处理恰好**一样**：
 *   · 缩进代码块（`    const a = 1;`）：代码是事实性内容，且缩进本身是块身份——
 *     实测引擎会先把缩进 trim 掉再把注释里的套话改掉（「此外」→「再说」），
 *     缩进没了，代码块也就不再是代码块；
 *   · 列表项续行（`- 项` 的下一行 `    续行…`）：它**不属于独立段落**，
 *     被切成独立段落后行距、语义都错。
 *
 * 两者都不该进 humanizeSingle，也不该被插空行 ⇒ 按围栏块待遇：**整块冻结**。
 *
 * ⚠️ 误判代价很低：普通中文段落几乎不会以 4 空格/tab 开头；真误判也只是
 * 那一段不去味，不会产出病句。反向（不判）的代价是代码被改写 + 缩进丢失。
 * ------------------------------------------------------------------ */

const INDENT_RE = /^(?: {4}|\t)/;

/** 段首是 4 空格 / tab —— 缩进代码块或列表项续行，整块冻结 */
export function isIndentedBlock(para: string): boolean {
  return INDENT_RE.test(para);
}

/* ------------------------------------------------------------------ *
 * v0.9.54+（第四形态）：YAML frontmatter（`---` … `---`）
 *
 * 实测：frontmatter 被逐行炸开成 `---⏎⏎title: 项目周报⏎⏎date: 2026-10-18⏎⏎---`，
 * 空行一插进去 frontmatter 就不再是 frontmatter（渲染器把它当普通正文），
 * 且 `title:` 这种元数据被改属于篡改事实——与代码、URL 同性质。
 *
 * 判据按 YAML 标准：首行必须是 `---`，闭合行是 `---` 或 `...`。
 * 找不到闭合就不算（避免把正文里的水平分割线误判成 frontmatter）。
 * ------------------------------------------------------------------ */

export function frontmatterSpans(text: string): TextSpan[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (!/^---[ \t]*\r?$/.test(lines[0] ?? "")) return [];
  let off = lines[0].length + 1;
  for (let i = 1; i < lines.length; i++) {
    if (/^(?:---|\.\.\.)[ \t]*\r?$/.test(lines[i])) {
      return [{ start: 0, end: off + lines[i].length }];
    }
    off += lines[i].length + 1;
  }
  return [];
}

/**
 * 事实密集段：数字/金额/百分比/日期/中文数量词达到 3 个不同项。
 *
 * 2026-10-22 真实案例 C16（招股书风险因素）实测：structure 层把
 * 「营收 32.68 亿元，同比 21.4%；净利 4.27 亿元，同比 15.8%」
 * 重排成「同比 21.4%；净利 4.27 亿元。2025 年度，营收 32.68 亿元。同比 15.8%」
 * ——数字一个没丢，但**每个数字修饰的对象全错了**。这是事实层面的损坏，
 * 比语体问题严重一档。数字密集的段落本来就不该做结构重排：它的结构就是
 * 「指标 + 数值 + 同比」的绑定关系。
 *
 * 代价：这类段落少一层结构去味；保真优先于去味。
 */
export function isFactDenseParagraph(para: string): boolean {
  const arabic =
    para.match(
      /\d+(?:\.\d+)?\s*(?:%|％|亿|万|千|百|元|年|月|日|个|项|条|款|倍|GB|TB|Tbps|pp|个百分点)?/g,
    ) ?? [];
  const chinese =
    para.match(/[一二三四五六七八九十百千万亿]+(?:场|人次|份|项|条|款|个|年|月|日|倍|个百分点)/g) ??
    [];
  const unique = new Set([...arabic, ...chinese].map((s) => s.replace(/\s+/g, "")));
  return unique.size >= 3;
}

/* ------------------------------------------------------------------ *
 * v0.9.62：整篇清理的代码护栏（占位符挖走 → 改完再原样放回）
 *
 * 起因（2026-10-22 实测，0.9 档）：`humanize()` 在 intensity ≥0.65 时对**整篇拼接后**
 * 调 `capLongTemplateRepetition`，而它的收尾清理有一条
 * `[。！？!?]{2,} → 。`。代码里的 `??`（空值合并）和 `!!`（双否定）因此被改成「。」：
 *   const ok = !!value;  →  const ok = 。value;
 * 段落级冻结（`fencedCodeSpans` + `spanGuard`）管不到这一步——它跑在拼回之后。
 *
 * 与 `spanGuard` 的分工：切句要保留偏移，只能用区间表；这里是**整串替换**，
 * 没有偏移概念，占位符更省事（还原时放回原字节，长度变化无所谓）。
 *
 * ⚠️ 占位符不能用「固定槽位」（v0.9.24 ⑩ 踩过 16 槽上限溢出丢串），这里按序号编码。
 * ------------------------------------------------------------------ */

/** 行内代码：单/双反引号成对，内容不跨行（Markdown 行内代码语义） */
const INLINE_CODE_RE = /(`{1,2})([^`\n]*?)\1/g;

export function inlineCodeSpans(text: string): TextSpan[] {
  if (!text) return [];
  const out: TextSpan[] = [];
  INLINE_CODE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_CODE_RE.exec(text)) !== null) {
    if (m[0].length === 0) {
      INLINE_CODE_RE.lastIndex++;
      continue;
    }
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** 围栏块 + 行内代码，合并嵌套后的区间（按起点升序、互不重叠） */
export function codeSpans(text: string): TextSpan[] {
  const all = fencedCodeSpans(text)
    .concat(inlineCodeSpans(text))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: TextSpan[] = [];
  for (const s of all) {
    const last = out[out.length - 1];
    if (last && s.start < last.end) {
      // 嵌套（围栏块里的行内代码）→ 并进上一段，别让占位符套娃
      last.end = Math.max(last.end, s.end);
      continue;
    }
    out.push({ start: s.start, end: s.end });
  }
  return out;
}

const MASK_OPEN = "\uE000";
const MASK_CLOSE = "\uE001";
const MASK_RE = /\uE000(\d+)\uE001/g;

/**
 * 把 `spans` 里的内容换成占位符，返回挖空后的文本与还原器。
 *
 * 文本里本来就含私用区哨兵时**原样返回**（`restore` 退化成恒等）：宁可少一层保护，
 * 也不能让还原器把正文换成别人。这类字符在输入体检阶段本就会被清掉。
 */
export function maskSpans(
  text: string,
  spans: TextSpan[],
): { text: string; restore: (s: string) => string } {
  if (spans.length === 0 || text.includes(MASK_OPEN) || text.includes(MASK_CLOSE)) {
    return { text, restore: (s: string) => s };
  }
  let out = "";
  let cursor = 0;
  const kept: string[] = [];
  for (const s of spans) {
    if (s.start < cursor) continue;
    out += text.slice(cursor, s.start) + MASK_OPEN + kept.length + MASK_CLOSE;
    kept.push(text.slice(s.start, s.end));
    cursor = s.end;
  }
  out += text.slice(cursor);
  return {
    text: out,
    restore: (s: string) => s.replace(MASK_RE, (_m, i: string) => kept[Number(i)] ?? ""),
  };
}

/** 一步到位：挖走围栏块与行内代码（整篇清理前用） */
export function maskCodeSpans(text: string): { text: string; restore: (s: string) => string } {
  return maskSpans(text, codeSpans(text));
}
