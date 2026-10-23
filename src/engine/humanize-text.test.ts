import { describe, expect, it } from "vitest";
import { isCJK, splitSentences } from "./humanize-text";

/**
 * isCJK 是两个汉字区间的判定，直接决定「中英之间加不加空格」的走向。
 * 范围写错不会报错、不会变红——只会让人名/地名里的生僻字被当成西文，
 * 空格规则从那里开始乱插。（此前无任何直测，且测试语料碰不到扩展 A 区。）
 */
describe("isCJK", () => {
  it("基本汉字区（U+4E00–U+9FFF，含上下边界）判定为 CJK", () => {
    expect(isCJK("\u4E00")).toBe(true);
    expect(isCJK("人")).toBe(true);
    expect(isCJK("\u9FFF")).toBe(true);
  });

  it("扩展 A 区（U+3400–U+4DBF）也算 CJK —— 生僻字不许被当成西文", () => {
    expect(isCJK("\u3400")).toBe(true);
    expect(isCJK("\u4DBF")).toBe(true);
  });

  it("区间外侧一律为假（全角标点、彝文、ASCII）", () => {
    expect(isCJK("\u33FF")).toBe(false);
    expect(isCJK("\uA000")).toBe(false);
    expect(isCJK("a")).toBe(false);
    expect(isCJK("，")).toBe(false);
    expect(isCJK(" ")).toBe(false);
  });
});

/**
 * v0.9.64：切句不得在**代码区间内部**下刀。
 *
 * 缺陷实测：「代码里 `a ?? b` 表示空值合并。」被切成
 *   ["代码里 `a ??", "b` 表示空值合并。"]
 * 后半段的前导空格在 trim 时丢掉，拼回去就成了 `a ??b`——代码语义没变但字形被改。
 * 修法：`structuredSpans`（URL/邮箱）之外再并入 `codeSpans`（围栏块 + 行内代码）。
 */
describe("splitSentences · 代码区间保护（v0.9.64）", () => {
  it("行内代码里的问号不切句，空格原样保留", () => {
    const out = splitSentences("代码里 `a ?? b` 表示空值合并。");
    expect(out).toEqual(["代码里 `a ?? b` 表示空值合并。"]);
    expect(out.join("")).toContain("`a ?? b`");
  });

  it("围栏块整块是一句（块内换行与分号都不切）", () => {
    const code = "```js\nconst a = 1;\nconst b = 2;\n```";
    const out = splitSentences(`${code}\n\n后面的正文。`);
    expect(out[0]).toBe(code);
    expect(out).toHaveLength(2);
  });

  it("反向：正文里的问号照切（保护面只覆盖代码，不是把切句关掉）", () => {
    const out = splitSentences("真的吗？那就试试。");
    expect(out).toEqual(["真的吗？", "那就试试。"]);
  });
});
