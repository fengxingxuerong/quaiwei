import { describe, expect, it } from "vitest";
import { isCJK } from "./humanize-text";

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
