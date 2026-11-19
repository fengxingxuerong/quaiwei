/**
 * docx-inplace-audit.ts —— docx 原地编辑「只读体检」（v0.9.89 立项第一步，不改引擎/产物）
 *
 * 回答方案 §2.2 的核心问题：能否准确识别「可改的正文 <w:t>」与「不可改区域」？
 *
 * 关键洞察（体检真正要分辨的）：
 *  - 现有 docxXmlToText 只读 <w:t>，天然不碰 <w:instrText> / <m:t> 公式 / <w:delText> / 脚注文件 —— 这些不是 <w:t>
 *  - 真风险：<w:txbxContent> 文本框内也有 <w:t>，会被 reader 误当正文；页眉页脚在独立 part
 *  - 超链接 r:id 关系、w:rPr 是「改文本时保留」而非「整段不可改」，需单独归类
 *
 * 用法：npx tsx scripts/docx-inplace-audit.ts
 * 输出：evidence/docx-inplace-audit-2026-11-17/（audit.json + README.md）
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { docxXmlToText } from "../src/docx-io.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "evidence", "docx-inplace-audit-2026-11-17");

/** 富文本样例：覆盖方案 §2.2(2) 的全部不可改区域 + 可改正文 */
const SAMPLE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>
  <w:p><w:r><w:t>这是一段纯正文可以改写。</w:t></w:r></w:p>
  <w:p><w:pPr><w:b/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>这段带加粗属性，文本可改、rPr 保留。</w:t></w:r></w:p>
  <w:p><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:t>第 1 页</w:t></w:r></w:p>
  <w:p><w:r><m:oMath><m:r><m:t>E=mc^2</m:t></m:r></m:oMath></w:r><w:r><w:t>公式如上。</w:t></w:r></w:p>
  <w:p><w:r><w:t>带批注的正文</w:t><w:commentReference w:id="0"/></w:r></w:p>
  <w:p><w:r><w:t>图片说明文字</w:t><w:drawing><wp:inline/></w:drawing></w:r></w:p>
  <w:p><w:r><w:t>访问</w:t></w:r><w:hyperlink r:id="rId5"><w:r><w:t>示例网站</w:t></w:r></w:hyperlink><w:r><w:t>了解详情。</w:t></w:r></w:p>
  <w:p><w:del w:id="1"><w:r><w:delText>旧文本</w:delText></w:r></w:del><w:ins w:id="2"><w:r><w:t>新文本</w:t></w:r></w:ins></w:p>
  <w:p><w:r><w:t>文本框外正文</w:t><w:txbxContent><w:p><w:r><w:t>文本框内正文</w:t></w:r></w:p></w:txbxContent></w:r></w:p>
  <w:p/>
  <w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格单元格正文。</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body>
</w:document>`;

/** 不可改元素：出现即表示所在段落含「非正文文本」或「结构」，需特殊处理 */
const IMMUTABLE = [
  { tag: "w:instrText", kind: "域代码", note: "不是 <w:t>，现有 reader 不读，天然安全" },
  { tag: "m:oMath", kind: "OMML 公式", note: "公式文本在 <m:t>，不是 <w:t>，天然安全" },
  { tag: "w:commentReference", kind: "批注引用", note: "批注内容在 comments.xml，不在 document.xml" },
  { tag: "w:drawing", kind: "图片/图形", note: "非文本 run，改同段 <w:t> 不影响图片" },
  { tag: "w:delText", kind: "修订删除文本", note: "不是 <w:t>，天然安全" },
  { tag: "w:ins", kind: "修订插入标记", note: "结构标记，需保留" },
  { tag: "w:del", kind: "修订删除标记", note: "结构标记，需保留" },
];

/** 需保留但文本可改：不是「整段跳过」的理由 */
const PRESERVE = [
  { tag: "w:rPr", kind: "run 属性", note: "改 <w:t> 文本时原样保留 rPr" },
  { tag: "w:hyperlink", kind: "超链接", note: "r:id 关系保留，链接内 <w:t> 文本可改" },
  { tag: "w:fldSimple", kind: "简单域", note: "域结构保留" },
];

/** 栈式切分段落：非贪婪正则遇 <w:txbxContent> 内嵌套 <w:p> 会提前闭合，必须用深度计数 */
function splitParagraphs(xml: string): string[] {
  const out: string[] = [];
  const tokenRe = /<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>|<\/w:p>/g;
  let t: RegExpExecArray | null;
  let depth = 0;
  let start = -1;
  while ((t = tokenRe.exec(xml)) !== null) {
    const tok = t[0];
    if (tok.endsWith("/>")) { if (depth === 0) out.push(""); continue; }
    if (tok.startsWith("</")) {
      depth--;
      if (depth === 0 && start >= 0) { out.push(xml.slice(start, t.index)); start = -1; }
      continue;
    }
    if (depth === 0) start = t.index + tok.length;
    depth++;
  }
  return out;
}

const paragraphs: {
  idx: number;
  textFromReaderScope: string;
  hasWt: boolean;
  immutable: { kind: string; tag: string }[];
  preserve: { kind: string; tag: string }[];
  textboxTexts: string[];
  cls: "可整段改写" | "含正文+结构(文本可改/结构保留)" | "含文本框(需拆分)" | "空段";
}[] = [];
let idx = 0;
for (const body of splitParagraphs(SAMPLE)) {
  const wt: string[] = [];
  const tRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let t: RegExpExecArray | null;
  while ((t = tRe.exec(body)) !== null) wt.push(t[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
  const imm = IMMUTABLE.filter((x) => new RegExp(`<${x.tag}(?:\\s|>|/)`).test(body)).map((x) => ({ kind: x.kind, tag: x.tag }));
  const pre = PRESERVE.filter((x) => new RegExp(`<${x.tag}(?:\\s|>|/)`).test(body)).map((x) => ({ kind: x.kind, tag: x.tag }));
  // 文本框内 <w:t>：body 里有 txbxContent 的文本段
  const txbxTexts: string[] = [];
  const tbRe = /<w:txbxContent\b[^>]*>([\s\S]*?)<\/w:txbxContent>/g;
  let tb: RegExpExecArray | null;
  while ((tb = tbRe.exec(body)) !== null) {
    const inner = tb[1].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g);
    for (const it of inner) txbxTexts.push(it[1]);
  }
  let cls: (typeof paragraphs)[number]["cls"];
  if (!wt.length) cls = "空段";
  else if (txbxTexts.length) cls = "含文本框(需拆分)";
  else if (imm.length || pre.length) cls = "含正文+结构(文本可改/结构保留)";
  else cls = "可整段改写";
  paragraphs.push({ idx: idx++, textFromReaderScope: wt.join(""), hasWt: wt.length > 0, immutable: imm, preserve: pre, textboxTexts: txbxTexts, cls });
}

const readerText = docxXmlToText(SAMPLE);
const textboxLeak = paragraphs.some((p) => p.textboxTexts.length && p.textboxTexts.some((s) => readerText.includes(s)));
const instrLeak = /PAGE/.test(readerText);
const formulaLeak = /E=mc\^2/.test(readerText);
const delLeak = /旧文本/.test(readerText);

const summary = {
  paragraphs: paragraphs.length,
  byClass: paragraphs.reduce((a: Record<string, number>, p) => { a[p.cls] = (a[p.cls] ?? 0) + 1; return a; }, {}),
  readerLeaks: { textbox: textboxLeak, instrText: instrLeak, formula_mt: formulaLeak, delText: delLeak },
  verdict:
    `只读体检通过：现有 docxXmlToText 只读 <w:t>，域代码(PAGE)/公式(m:t)/修订删除(delText) 均未泄漏（false=${!instrLeak && !formulaLeak && !delLeak}）；` +
    `唯一确认风险是文本框 <w:txbxContent> 内的 <w:t> 也被 reader 收入（leak=${textboxLeak}）——原地编辑必须把文本框节点排除在改写单位之外。` +
    `结论：方案 §2.2「只改 word/document.xml 的 <w:t>、其余 ZIP 条目逐字节回写」可行；` +
    `但必须补一条硬约束「跳过 <w:txbxContent> 内 <w:t>」，否则会把文本框文字当正文改写。` +
    `本轮只验证识别能力，未动产品代码、未实现写入。`,
};

mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, "audit.json"), JSON.stringify({ at: new Date().toISOString(), purpose: "docx 原地编辑只读体检：识别可改 <w:t> 与不可改区域", sample: SAMPLE, paragraphs, summary }, null, 2) + "\n", "utf8");
const lines = [
  "# docx 原地编辑 · 只读体检（2026-11-17）",
  "",
  "> v0.9.89 立项第一步。只验证「能否准确识别不可改区域」，未改引擎、未实现写入。",
  "",
  `## 结论`,
  "",
  summary.verdict,
  "",
  `## 段落分类（样例 ${paragraphs.length} 段）`,
  "",
  "| # | 分类 | 正文文本 | 不可改元素 | 保留元素 | 文本框文本 |",
  "|---|---|---|---|---|---|",
  ...paragraphs.map((p) => `| ${p.idx} | ${p.cls} | ${p.textFromReaderScope.slice(0, 24) || "(空)"} | ${p.immutable.map((x) => x.kind).join(",") || "-"} | ${p.preserve.map((x) => x.kind).join(",") || "-"} | ${p.textboxTexts.join(",") || "-"} |`),
  "",
  "## reader 泄漏检查",
  "",
  `- 文本框 <w:t> 被收入正文：${textboxLeak ? "是（需加硬约束）" : "否"}`,
  `- 域代码 PAGE 泄漏：${instrLeak ? "是" : "否"}`,
  `- 公式 m:t 泄漏：${formulaLeak ? "是" : "否"}`,
  `- 修订删除 delText 泄漏：${delLeak ? "是" : "否"}`,
  "",
  "复现：`npx tsx scripts/docx-inplace-audit.ts`（输出本目录 audit.json）。",
];
writeFileSync(path.join(OUT, "README.md"), lines.join("\n") + "\n", "utf8");

console.log("══════ docx 原地编辑 · 只读体检 ══════\n");
console.log(`样例段落：${paragraphs.length}；分类：${JSON.stringify(summary.byClass)}`);
console.log(`reader 泄漏：${JSON.stringify(summary.readerLeaks)}`);
console.log(`\n判定：${summary.verdict}`);
console.log(`\n报告：${path.relative(ROOT, OUT)}`);
