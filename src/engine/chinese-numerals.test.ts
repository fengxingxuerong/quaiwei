/**
 * 中文数字解析的单元测试（v0.9.79）
 *
 * 这层存在的唯一理由：让「3 个」与「三个」在比对时是**同一个事实**。
 * 所以用例重点不在炫技解析，而在"别把虚词的『一』当成数字"。
 */
import { describe, it, expect } from "vitest";
import { parseChineseInteger, parseChineseNumber, canonNumber } from "./chinese-numerals";

describe("parseChineseInteger", () => {
  it("个位与简单组合", () => {
    expect(parseChineseInteger("三")).toBe(3);
    expect(parseChineseInteger("十")).toBe(10);
    expect(parseChineseInteger("十二")).toBe(12);
    expect(parseChineseInteger("二十三")).toBe(23);
    expect(parseChineseInteger("两")).toBe(2);
    expect(parseChineseInteger("〇")).toBe(0);
  });

  it("百千万亿的进位", () => {
    expect(parseChineseInteger("一百零五")).toBe(105);
    expect(parseChineseInteger("两千")).toBe(2000);
    expect(parseChineseInteger("一万二千")).toBe(12000);
    expect(parseChineseInteger("三亿五千万")).toBe(350000000);
    expect(parseChineseInteger("十万")).toBe(100000);
  });

  it("不认识的内容返回 null（不猜）", () => {
    expect(parseChineseInteger("")).toBeNull();
    expect(parseChineseInteger("一二三abc")).toBeNull();
    expect(parseChineseInteger("方面")).toBeNull();
  });
});

describe("parseChineseNumber（含小数）", () => {
  it("十二点七 = 12.7", () => {
    expect(parseChineseNumber("十二点七")).toBe(12.7);
  });

  it("三点零五 = 3.05（逐位念小数）", () => {
    expect(parseChineseNumber("三点零五")).toBe(3.05);
  });

  it("点后面为空或含非法字符 → null", () => {
    expect(parseChineseNumber("三点")).toBeNull();
    expect(parseChineseNumber("三点甲")).toBeNull();
  });
});

describe("canonNumber", () => {
  it("抹掉浮点尾噪，便于比对", () => {
    expect(canonNumber(12.7)).toBe("12.7");
    expect(canonNumber(0.1 + 0.2)).toBe("0.3");
    expect(canonNumber(350000000)).toBe("350000000");
  });
});
