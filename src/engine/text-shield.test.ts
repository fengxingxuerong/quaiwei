/**
 * v0.9.25 结构化串（URL / 邮箱）区间表单元测试
 *
 * 锁的是**承载方式**这件事本身：v0.9.24 ⑩ 用「U+E000~U+E00F 占位符 + 还原」做同一件事，
 * 实测有两个洞（槽位上限 16、压字符破坏偏移），本文件把这两个洞钉成回归。
 *
 * 覆盖：
 * 1. `structuredSpans` 区间正确性（左闭右开、升序不重叠、URL 与邮箱）
 * 2. **40 个 URL 一个不少** —— 占位符方案在此处必崩（第 17 个起溢出成乱码并永久丢失）
 * 3. `spanGuard` 的二分与朴素线性实现逐下标一致（二分写错能被测出来）
 * 4. 切句联动：`humanize-text.splitSentences` 保真 + 纯中文语料的回归对照
 */
import { describe, it, expect } from "vitest";
import {
  structuredSpans,
  spanGuard,
  guardFor,
  fencedCodeSpans,
  isFencedBlock,
  isMarkdownStructLine,
  isProtectedBlock,
  isIndentedBlock,
  isFrontmatterBlock,
  frontmatterSpans,
  splitParagraphChunks,
  type TextSpan,
} from "./text-shield";
import { splitSentences } from "./humanize-text";

/** 朴素实现：线性扫描，用来对照二分 */
function naiveInside(spans: TextSpan[], idx: number): boolean {
  for (const s of spans) {
    if (idx >= s.start && idx < s.end) return true;
  }
  return false;
}

function urlsOf(s: string): string[] {
  return s.match(/https?:\/\/[^\s，。；]+/g) || [];
}

describe("structuredSpans（区间表）", () => {
  it("空输入 / 无结构化串 → 空数组", () => {
    expect(structuredSpans("")).toEqual([]);
    expect(structuredSpans("今天天气不错，我们去公园。")).toEqual([]);
    expect(structuredSpans("版本号是 v1.2.3，时间是 14:30。")).toEqual([]);
  });

  it("URL 区间左闭右开，且不含紧随其后的中文标点", () => {
    const text = "详见 https://example.com/a?b=1 。";
    const spans = structuredSpans(text);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end)).toBe("https://example.com/a?b=1");
    // 末尾那个 `。` 不在区间内 —— 否则切句会漏掉这个切点
    expect(spans[0].end).toBe(text.indexOf(" 。"));
  });

  it("邮箱同样纳入", () => {
    const text = "联系 a.b+c@ex-ample.com.cn 谢谢";
    const spans = structuredSpans(text);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end)).toBe("a.b+c@ex-ample.com.cn");
  });

  it("多个串按起点升序且互不重叠", () => {
    const text = "见 https://a.com/x 与 http://b.org/y?z=1，或 mail@x.io。";
    const spans = structuredSpans(text);
    expect(spans.length).toBe(3);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i].start).toBeGreaterThan(spans[i - 1].start);
      expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].end);
    }
  });

  it("40 个 URL 一个都不能少 —— 占位符方案 16 槽位的死穴回归", () => {
    // 构造：每个 URL 后跟一个句号，逼切句真的动手
    const parts: string[] = [];
    for (let i = 0; i < 40; i++) parts.push(`链接${i} https://ex.com/${i}?q=${i}。`);
    const text = parts.join("");

    const spans = structuredSpans(text);
    expect(spans).toHaveLength(40);

    // 每个区间都精确对应它那个 URL（不是错位的、不是空的）
    for (let i = 0; i < 40; i++) {
      const seg = text.slice(spans[i].start, spans[i].end);
      expect(seg).toBe(`https://ex.com/${i}?q=${i}`);
    }
  });
});

describe("spanGuard（二分判定器）", () => {
  it("空数组 / null → 恒 false，调用方无需写分支", () => {
    const g0 = spanGuard([]);
    const gn = spanGuard(null);
    const gu = spanGuard(undefined);
    for (let i = 0; i < 5; i++) {
      expect(g0(i)).toBe(false);
      expect(gn(i)).toBe(false);
      expect(gu(i)).toBe(false);
    }
  });

  it("边界：start 命中、end 不命中（左闭右开）", () => {
    const g = spanGuard([{ start: 3, end: 7 }]);
    expect(g(2)).toBe(false);
    expect(g(3)).toBe(true);
    expect(g(6)).toBe(true);
    expect(g(7)).toBe(false);
  });

  it("与朴素实现逐下标一致（多区间下二分写错能被测出来）", () => {
    const text = "开头 https://a.com/x?y=1 中间 foo@bar.io 再一段 http://c.org/d 结尾。";
    const spans = structuredSpans(text);
    expect(spans.length).toBeGreaterThanOrEqual(3);
    const g = guardFor(text);
    for (let i = 0; i < text.length; i++) {
      expect(g(i)).toBe(naiveInside(spans, i));
    }
  });
});

describe("切句联动（humanize-text.splitSentences）", () => {
  it("URL 内的 ? / & 不再造出假句", () => {
    const text = "详见 https://example.com/a?b=1&c=2 的说明。后面还有一句。";
    const sents = splitSentences(text);
    expect(sents).toHaveLength(2);
    expect(sents[0]).toContain("https://example.com/a?b=1&c=2");
  });

  it("40 个 URL 的段落：切句后 URL 全部完整保留，无丢失、无私用区乱码", () => {
    const parts: string[] = [];
    for (let i = 0; i < 40; i++) parts.push(`链接${i} https://ex.com/${i}?q=${i}。`);
    const text = parts.join("");
    const sents = splitSentences(text);
    const joined = sents.join("");

    // 句数必须正好 40 —— 每个 URL 里的 `?` 都不该造出假句。
    // 这条**对区间表被截断/漏匹配敏感**（实测：把 guardFor 截到前 16 个区间，本断言即红），
    // 而上面的「URL 数 == 40」对新实现并不敏感（区间表缺了只会多切，不会丢字符），
    // 它锁的是「不许退回占位符方案」那条路。
    expect(sents).toHaveLength(40);
    expect(urlsOf(joined)).toHaveLength(40);
    // 私用区残留 = 占位符没还原，必须为零
    expect(/[\uE000-\uE00F]/.test(joined)).toBe(false);
    // 每个 URL 字面量都在
    for (let i = 0; i < 40; i++) {
      expect(joined).toContain(`https://ex.com/${i}?q=${i}`);
    }
  });

  it("纯中文语料：切句结果与改动前逐字一致（回归对照）", () => {
    expect(splitSentences("今天天气不错。我们去公园吧！你带水了吗？")).toEqual([
      "今天天气不错。",
      "我们去公园吧！",
      "你带水了吗？",
    ]);
    // 连续分隔符整体吃掉、拼到上一句尾，再 trim
    expect(splitSentences("第一段。\n第二段！\n")).toEqual(["第一段。", "第二段！"]);
    // 空段被滤掉
    expect(splitSentences("前面。；；；后面。")).toEqual(["前面。；；；", "后面。"]);
  });
});

describe("fencedCodeSpans（Markdown 围栏代码块区间 · v0.9.54）", () => {
  it("空输入 / 无围栏 → 空数组", () => {
    expect(fencedCodeSpans("")).toEqual([]);
    expect(fencedCodeSpans("今天天气不错，我们去公园。")).toEqual([]);
    expect(fencedCodeSpans("行内 `code` 不是围栏。")).toEqual([]);
  });

  it("区间含开口行与闭合行本身，且不含闭合行之后的换行", () => {
    const text = "前文。\n```\nconst a = 1;\n```\n后文。";
    const spans = fencedCodeSpans(text);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end)).toBe("```\nconst a = 1;\n```");
    // 闭合行之后那个 \n 不在区间内
    expect(text[spans[0].end]).toBe("\n");
  });

  it("波浪号围栏同样纳入", () => {
    const text = "~~~\nconst b = 2;\n~~~";
    const spans = fencedCodeSpans(text);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end)).toBe(text);
  });

  it("未闭合 → 到文末（不返回空，否则调用方会把它当正文改写）", () => {
    const text = "前面。\n```\nconst c = 3;";
    const spans = fencedCodeSpans(text);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end)).toBe("```\nconst c = 3;");
  });

  it("闭合行必须同种字符且长度 ≥ 开口（不同种 / 更短都不算闭合）", () => {
    // 开口 ``` 却用 ~~~ 收：不闭合 ⇒ 整段到文末
    const mixed = "```\nconst d = 4;\n~~~\n后文。";
    const s1 = fencedCodeSpans(mixed);
    expect(s1).toHaveLength(1);
    expect(mixed.slice(s1[0].start, s1[0].end)).toBe(mixed);
    // 开口 4 个反引号、闭合 3 个：不够长 ⇒ 不闭合
    const short = "````\nconst e = 5;\n```\n后文。";
    const s2 = fencedCodeSpans(short);
    expect(s2).toHaveLength(1);
    expect(short.slice(s2[0].start, s2[0].end)).toBe(short);
    // 闭合更长：正常闭合
    const longer = "```\nconst f = 6;\n`````\n后文。";
    const s3 = fencedCodeSpans(longer);
    expect(longer.slice(s3[0].start, s3[0].end)).toBe("```\nconst f = 6;\n`````");
  });

  it("多个块各自成区间，按起点升序、互不重叠", () => {
    const text = "甲。\n```\n1\n```\n中间。\n~~~\n2\n~~~\n乙。";
    const spans = fencedCodeSpans(text);
    expect(spans).toHaveLength(2);
    expect(text.slice(spans[0].start, spans[0].end)).toBe("```\n1\n```");
    expect(text.slice(spans[1].start, spans[1].end)).toBe("~~~\n2\n~~~");
    expect(spans[1].start).toBeGreaterThanOrEqual(spans[0].end);
  });

  it("区间偏移可直接喂给 spanGuard：块内每行命中、块外不命中", () => {
    const text = "前文。\n```\n第一行\n第二行\n```\n后文。";
    const g = spanGuard(fencedCodeSpans(text));
    expect(g(text.indexOf("前文"))).toBe(false);
    expect(g(text.indexOf("```"))).toBe(true);
    expect(g(text.indexOf("第一行"))).toBe(true);
    expect(g(text.indexOf("第二行"))).toBe(true);
    expect(g(text.indexOf("后文"))).toBe(false);
  });
});

describe("isFencedBlock（段落级判定 · v0.9.54）", () => {
  it("只看首行：首行是围栏 → true", () => {
    expect(isFencedBlock("```\nconst a = 1;\n```")).toBe(true);
    expect(isFencedBlock("~~~\nconst b = 2;\n~~~")).toBe(true);
    expect(isFencedBlock("  ```js\nconsole.log(1);\n```")).toBe(true);
  });

  it("首行不是围栏 → false（块内的缩进围栏不该被当成新开口）", () => {
    expect(isFencedBlock("这是一段正文。")).toBe(false);
    expect(isFencedBlock("说明：\n```\ncode\n```")).toBe(false);
    expect(isFencedBlock("")).toBe(false);
  });
});

describe("splitParagraphChunks（带偏移与分隔符的切段 · v0.9.54）", () => {
  it("文本序列与 text.split(/\\n+/) + 滤空段 逐项一致（不引入新的切法）", () => {
    const cases = [
      "一段。",
      "甲。\n乙。",
      "甲。\n\n乙。\n\n\n丙。",
      "甲。\n```\ncode\n```\n乙。",
      "\n\n开头有空行。\n\n",
    ];
    for (const t of cases) {
      const expectParas = t.split(/\n+/).filter((p) => p.trim());
      expect(splitParagraphChunks(t).map((c) => c.text)).toEqual(expectParas);
    }
  });

  it("start 是段首在原文中的下标（slice 出来必须是这一段本身）", () => {
    const text = "甲。\n\n```\ncode\n```\n\n乙。";
    for (const c of splitParagraphChunks(text)) {
      expect(text.startsWith(c.text, c.start)).toBe(true);
    }
  });

  it("sep 保留原始分隔符：单换行不会被统一拉成双换行", () => {
    const chunks = splitParagraphChunks("甲。\n\n```\ncode\n```\n\n乙。");
    expect(chunks.map((c) => c.sep)).toEqual(["\n\n", "\n", "\n", "\n\n", ""]);
  });

  it("空输入 → 单个空段、sep 为空串", () => {
    expect(splitParagraphChunks("")).toEqual([]);
  });
});

describe("isMarkdownStructLine / isProtectedBlock（紧凑结构行 · v0.9.54 续）", () => {
  it("表格行 / 列表项 / 引用行 → true", () => {
    expect(isMarkdownStructLine("| 参数 | 说明 |")).toBe(true);
    expect(isMarkdownStructLine("| --- | --- |")).toBe(true);
    expect(isMarkdownStructLine("- 首先，接口层做了重构。")).toBe(true);
    expect(isMarkdownStructLine("* 星号列表项")).toBe(true);
    expect(isMarkdownStructLine("1. 先完成数据迁移。")).toBe(true);
    expect(isMarkdownStructLine("2) 括号编号项")).toBe(true);
    expect(isMarkdownStructLine("> 这是引用行")).toBe(true);
    expect(isMarkdownStructLine("  - 缩进的列表项")).toBe(true);
  });

  it("普通段落 / 标题 / 围栏开口 → false（判据不许过宽）", () => {
    expect(isMarkdownStructLine("这是一段普通正文。")).toBe(false);
    expect(isMarkdownStructLine("# 一级标题")).toBe(false);
    expect(isMarkdownStructLine("```\nconst a = 1;\n```")).toBe(false);
    expect(isMarkdownStructLine("")).toBe(false);
  });

  it("isProtectedBlock = 围栏块 ∪ 紧凑结构行 ∪ 缩进块 ∪ frontmatter", () => {
    expect(isProtectedBlock("```\nconst a = 1;\n```")).toBe(true);
    expect(isProtectedBlock("| a | b |")).toBe(true);
    expect(isProtectedBlock("- 列表项")).toBe(true);
    expect(isProtectedBlock("    const a = 1;")).toBe(true);
    expect(isProtectedBlock("---\ntitle: 周报\n---")).toBe(true);
    expect(isProtectedBlock("普通段落。")).toBe(false);
  });
});

describe("frontmatterSpans / isIndentedBlock / isFrontmatterBlock（v0.9.54 第三、四形态）", () => {
  it("frontmatter：首行 --- 到闭合行，含首尾两行", () => {
    const text = "---\ntitle: 周报\ndate: 2026-10-18\n---\n正文。";
    const spans = frontmatterSpans(text);
    expect(spans).toHaveLength(1);
    expect(text.slice(spans[0].start, spans[0].end)).toBe(
      "---\ntitle: 周报\ndate: 2026-10-18\n---",
    );
  });

  it("闭合行可以是 ...（YAML 另一种写法）", () => {
    const text = "---\ntitle: 周报\n...\n正文。";
    expect(text.slice(0, frontmatterSpans(text)[0].end)).toBe("---\ntitle: 周报\n...");
  });

  it("无闭合 / 不在文首 → 不算 frontmatter（避免把正文里的分割线当元数据）", () => {
    expect(frontmatterSpans("---\ntitle: 周报\n正文。")).toEqual([]);
    expect(frontmatterSpans("正文。\n---\ntitle: 周报\n---")).toEqual([]);
    expect(frontmatterSpans("")).toEqual([]);
  });

  it("isIndentedBlock：4 空格或 tab 开头 → true，普通段落 → false", () => {
    expect(isIndentedBlock("    const a = 1;")).toBe(true);
    expect(isIndentedBlock("\tconst a = 1;")).toBe(true);
    expect(isIndentedBlock("  三个空格不够")).toBe(false);
    expect(isIndentedBlock("普通段落。")).toBe(false);
  });

  it("isFrontmatterBlock 只看首行是不是 ---", () => {
    expect(isFrontmatterBlock("---\ntitle: 周报\n---")).toBe(true);
    expect(isFrontmatterBlock("---")).toBe(true);
    expect(isFrontmatterBlock("title: 周报\n---")).toBe(false);
    expect(isFrontmatterBlock("普通段落。")).toBe(false);
  });
});
