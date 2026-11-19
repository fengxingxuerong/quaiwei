// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { buildZip, readZipDirectory, readZipEntry, docxXmlToText } from "./docx-io";
import { rewriteDocumentXml, rewriteDocxInplace, readDocumentXml } from "./docx-inplace";

const ENC = new TextEncoder();
const DEC = new TextDecoder();

const SAMPLE =
  `<w:document><w:body>` +
  `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>值得注意的是，本项目完成了升级。</w:t></w:r></w:p>` +
  `<w:p><w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:t>第 1 页</w:t></w:r></w:p>` +
  `<w:p><w:r><m:oMath><m:r><m:t>E=mc^2</m:t></m:r></m:oMath></w:r><w:r><w:t>公式如上。</w:t></w:r></w:p>` +
  `<w:p><w:r><w:t>文本框外正文</w:t><w:txbxContent><w:p><w:r><w:t>文本框内正文</w:t></w:r></w:p></w:txbxContent></w:r></w:p>` +
  `<w:p><w:r><w:delText>被删除的旧文本</w:delText></w:r><w:r><w:t>保留的新文本</w:t></w:r></w:p>` +
  `</w:body></w:document>`;

describe("rewriteDocumentXml（段落原地改写）", () => {
  it("改写正文段，rPr 属性保留", () => {
    const r = rewriteDocumentXml(SAMPLE, { rewrite: (s) => s.replace("值得注意的是，", "") });
    expect(r.xml).toContain("<w:rPr><w:b/></w:rPr>");
    expect(r.xml).toContain("本项目完成了升级");
    expect(r.xml).not.toContain("值得注意的是，");
    expect(r.paragraphs).toBeGreaterThanOrEqual(1);
  });

  it("文本框 / 域代码 / 公式 / 修订删除内的文本一律不改写", () => {
    // 改写函数给所有输入加前缀：凡是被加前缀的就是被误改的文本
    const r = rewriteDocumentXml(SAMPLE, { rewrite: (s) => `[改]${s}` });
    expect(r.xml).not.toContain("[改]文本框内正文");
    expect(r.xml).not.toContain("[改] PAGE ");
    expect(r.xml).not.toContain("[改]E=mc^2");
    expect(r.xml).not.toContain("[改]被删除的旧文本");
    // 正文仍被改
    expect(r.xml).toContain("[改]");
  });

  it("文本不变的段不回写，段落计数只算真改的", () => {
    const r = rewriteDocumentXml(SAMPLE, { rewrite: (s) => s });
    expect(r.paragraphs).toBe(0);
    expect(r.xml).toBe(SAMPLE);
  });

  it("改写函数抛错时该段跳过，不污染其它段", () => {
    const r = rewriteDocumentXml(SAMPLE, {
      rewrite: (s) => {
        if (s.includes("公式")) throw new Error("boom");
        return `[OK]${s}`;
      },
    });
    expect(r.xml).toContain("[OK]");
    expect(r.xml).toContain("公式如上。"); // 原样留下
  });

  it("不跨段：改写函数收到的输入不含其它段文本", () => {
    const seen: string[] = [];
    rewriteDocumentXml(SAMPLE, {
      rewrite: (s) => {
        seen.push(s);
        return s;
      },
    });
    for (const s of seen) expect(s).not.toContain("\n\n");
  });
});

describe("rewriteDocxInplace（zip 层不变式）", () => {
  async function makeDocx() {
    const parts = {
      "word/document.xml": SAMPLE,
      "word/styles.xml": `<w:styles><w:style w:styleId="Normal"/></w:styles>`,
      "word/settings.xml": `<w:settings><w:zoom w:percent="100"/></w:settings>`,
      "docProps/core.xml": `<cp:coreProperties><dc:title>标题</dc:title></cp:coreProperties>`,
    };
    const entries = Object.entries(parts).map(([name, text]) => ({
      name,
      data: ENC.encode(text),
    }));
    return { buf: await buildZip(entries), parts };
  }

  it("除 document.xml 外，每个 ZIP 条目解压后逐字节一致", async () => {
    const { buf, parts } = await makeDocx();
    const { blob } = await rewriteDocxInplace(buf, {
      rewrite: (s) => s.replace("值得注意的是，", ""),
    });
    const out = new Uint8Array(await blob.arrayBuffer());
    const entries = readZipDirectory(out);
    expect([...entries.keys()].sort()).toEqual(Object.keys(parts).sort());
    for (const [name, text] of Object.entries(parts)) {
      if (name === "word/document.xml") continue;
      const decoded = DEC.decode(await readZipEntry(out, entries.get(name)!));
      expect(decoded).toBe(text);
    }
  });

  it("改写后正文变化，非正文禁区文本保持", async () => {
    const { buf } = await makeDocx();
    const { blob, result } = await rewriteDocxInplace(buf, {
      rewrite: (s) => s.replace("值得注意的是，", ""),
    });
    const out = new Uint8Array(await blob.arrayBuffer());
    const xml = await readDocumentXml(out);
    expect(xml).not.toContain("值得注意的是，");
    expect(xml).toContain("文本框内正文");
    expect(xml).toContain("E=mc^2");
    expect(result.paragraphs).toBeGreaterThanOrEqual(1);
    // 文本提取仍可读
    expect(docxXmlToText(xml)).toContain("本项目完成了升级");
  });
});
