/**
 * src/docx-inplace.ts —— docx 富文本「原地编辑」（v0.9.89，竞品吸收：humanpen / sgaofen hz）。
 *
 * 与 writeDocxText（纯文本往返、样式全掉）互补：这里**只改 word/document.xml 的 <w:t> 文本节点**，
 * 其余 ZIP 条目（[Content_Types].xml / styles.xml / 图片 / 批注 / 字体…）逐字节原样回写。
 *
 * 硬约束（来自 evidence/docx-inplace-audit-2026-11-17 的只读体检结论）：
 *  1. 跳过 <w:txbxContent> 内的 <w:t>（reader 的已知泄漏点，文本框文字不是正文）；
 *  2. 跳过 <w:instrText>（域代码）、<w:delText>（修订删除）、OMML（<m:…>）内的文本；
 *  3. 改写单位 = 段落，同段 <w:t> 拼接 → humanize() → 回写，**不跨段**；
 *  4. run 属性（<w:rPr>）、批注引用、书签、超链接关系一律不动；
 *  5. 任何一步解析失败 → 抛错，CLI 回退原文件，绝不产出半改坏的 docx。
 *
 * 术语「保格式档」：只做引擎的词级/短语级改写，切句/句序仍由引擎按段处理，但**不跨段**，
 * 因此段落骨架、run 结构、样式 100% 保留；结构级重写（跨段）在 docx 上不成立，不要承诺。
 */

import { readZipDirectory, readZipEntry, buildZip, type ZipEntry } from "./docx-io";

const ENC = new TextEncoder();
const DEC = new TextDecoder();

/** 段落正则：普通 <w:p>...</w:p> 与自闭合 <w:p/> */
const PARA_RE = /<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;
/** 段内 token：文本 / 换行 / 制表（顺序敏感，一次扫描） */
const TOKEN_RE = /<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>|<w:t(?:\s[^>]*)?\/>|<w:br\s*\/>|<w:tab\s*\/>/g;

function xmlUnescape(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 判断段内某个偏移是否落在不可改区域（文本框/域代码/修订删除/OMML） */
function isForbiddenRange(body: string, start: number): boolean {
  const before = body.slice(0, start);
  // 未闭合的禁止标签：若最近一个开标签晚于最近的闭标签，则当前位置在禁区内。
  const forbiddens = ["w:txbxContent", "w:instrText", "w:delText", "m:oMath", "m:oMathPara"];
  for (const tag of forbiddens) {
    const opens = before.match(new RegExp(`<${tag}(?:\\s[^>]*)?>`, "g"))?.length ?? 0;
    const closes = before.match(new RegExp(`</${tag}>`, "g"))?.length ?? 0;
    if (opens > closes) return true;
  }
  return false;
}

export interface InplaceOptions {
  /** 改写函数：接收段落纯文本，返回改写后文本。由调用方注入 humanize() */
  rewrite: (paragraph: string) => string;
  /**
   * 是否把改写后的整段文本回写到第一个 <w:t>（其余同段 <w:t> 清空）。
   * 默认 true——这是唯一能让引擎的断句/换词生效的方式；
   * run 属性（<w:rPr>）仍在，但段内多 run 的文字会合并到首 run。
   * 对「段内只有单个 run」的 docx（最常见）零影响。
   */
  collapseRuns?: boolean;
}

export interface InplaceResult {
  /** 改写后的 document.xml */
  xml: string;
  /** 实际改写的段数 */
  paragraphs: number;
  /** 因含禁区/空段跳过的段数 */
  skipped: number;
}

/** 在 document.xml 字符串上做原地段落改写（纯函数） */
export function rewriteDocumentXml(xml: string, opts: InplaceOptions): InplaceResult {
  let paragraphs = 0;
  let skipped = 0;
  const collapse = opts.collapseRuns !== false;

  const nextXml = xml.replace(PARA_RE, (full, bodyRaw: string | undefined) => {
    if (full.endsWith("/>")) return full; // 自闭合空段
    const body = bodyRaw ?? "";
    // 收集可改 token 的位置与原文（禁区内的 <w:t> 一律跳过）
    const tokens: { start: number; end: number; text: string; inner: string }[] = [];
    let m: RegExpExecArray | null;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(body)) !== null) {
      if (!m[0].startsWith("<w:t")) continue; // br/tab 不参与改写，但占位保留
      if (isForbiddenRange(body, m.index)) continue;
      const selfClose = m[0].endsWith("/>");
      const inner = selfClose ? "" : m[0].replace(/^<w:t(?:\s[^>]*)?>/, "").replace(/<\/w:t>$/, "");
      tokens.push({ start: m.index, end: m.index + m[0].length, text: xmlUnescape(inner), inner });
    }
    if (!tokens.length) {
      skipped++;
      return full;
    }
    // 段内纯文本：只取 <w:t>，按原顺序拼接（br/tab 不并入改写输入，避免被当空格吃掉）
    const original = tokens.map((t) => t.text).join("");
    if (!original.trim()) {
      skipped++;
      return full;
    }
    let rewritten: string;
    try {
      rewritten = opts.rewrite(original);
    } catch {
      skipped++;
      return full;
    }
    if (rewritten === original) return full;

    if (!collapse) {
      // 保 run 逐字模式：仅在 tokens 数量恰好 1 时回写，多 run 不动（最保守）
      if (tokens.length !== 1) {
        skipped++;
        return full;
      }
      const t = tokens[0];
      const head = body.slice(0, t.start);
      const tail = body.slice(t.end);
      paragraphs++;
      return full.replace(
        body,
        `${head}<w:t xml:space="preserve">${xmlEscape(rewritten)}</w:t>${tail}`,
      );
    }

    // 默认模式：整段文本写回首 run，同段其余 <w:t> 清空（run 节点与 rPr 仍保留）
    const [first, ...rest] = tokens;
    let out = body;
    // 倒序替换，避免偏移失效
    for (const t of [...rest].reverse()) {
      out = out.slice(0, t.start) + `<w:t xml:space="preserve"></w:t>` + out.slice(t.end);
    }
    // first 的位置未变（前面的 token 都在它之后）
    out =
      out.slice(0, first.start) +
      `<w:t xml:space="preserve">${xmlEscape(rewritten)}</w:t>` +
      out.slice(first.end);
    paragraphs++;
    return full.replace(body, out);
  });

  return { xml: nextXml, paragraphs, skipped };
}

/** 从 docx 字节读出 document.xml 文本 */
export async function readDocumentXml(buf: Uint8Array): Promise<string> {
  const entries = readZipDirectory(buf);
  const entry = entries.get("word/document.xml");
  if (!entry) throw new Error("不是有效的 .docx（找不到 word/document.xml）");
  return DEC.decode(await readZipEntry(buf, entry));
}

/**
 * 原地改写 docx：其余 ZIP 条目逐字节原样保留（用同一套 zip writer 重建，deflate 后字节
 * 未必与原压缩流逐位相同，但**解压内容**逐字节一致——这是可核验的不变式）。
 */
export async function rewriteDocxInplace(
  source: Blob | ArrayBuffer | Uint8Array,
  opts: InplaceOptions,
): Promise<{ blob: Blob; result: InplaceResult }> {
  const buf =
    source instanceof Uint8Array
      ? source
      : source instanceof ArrayBuffer
        ? new Uint8Array(source)
        : new Uint8Array(await source.arrayBuffer());
  const entries = readZipDirectory(buf);
  const xml = await readDocumentXml(buf);
  const result = rewriteDocumentXml(xml, opts);

  const files: { name: string; data: Uint8Array }[] = [];
  for (const [name, entry] of entries) {
    const raw = await readZipEntry(buf, entry as ZipEntry);
    files.push({
      name,
      data: name === "word/document.xml" ? ENC.encode(result.xml) : raw,
    });
  }
  const zip = await buildZip(files);
  return {
    blob: new Blob([zip as BlobPart], {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }),
    result,
  };
}
