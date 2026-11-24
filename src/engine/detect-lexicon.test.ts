import { describe, expect, it } from "vitest";
import {
  NOMINAL_SUFFIX,
  rePersonal,
  reConcrete,
  reIdiomLike,
  reModalDetector,
} from "./detect-lexicon";

const src = (re: RegExp) => re.source;

describe("detect-lexicon 特征正则：单一事实源守卫", () => {
  it("特征正则的字符级内容与登记值一致", () => {
    expect(src(NOMINAL_SUFFIX)).toBe(
      "(性|化|度|感|力|型|式|机制|体系|格局|举措|效能|路径|维度|层面)$",
    );
    expect(src(rePersonal())).toBe(
      "(我|我们|咱|你|您|我觉得|个人|身边|记得|那次|当时|小时候|昨天|上周|我家|朋友)",
    );
    expect(src(reConcrete())).toBe(
      "([0-9０-９]+[年月日%％元块个次万亿度公里分秒]|[一二三四五六七八九十百千万亿两几]{1,3}[块元个年月天次度岁遍]|[A-Za-z][A-Za-z0-9-]{2,}|第[一二三四五六七八九十]+[章节部])",
    );
    expect(src(reIdiomLike())).toBe("[\\u4e00-\\u9fa5]{4}(?:、[\\u4e00-\\u9fa5]{4}){1,}");
    expect(src(reModalDetector())).toContain("需要进一步");
  });

  it("带 g 标志的正则用 .search() 判定不受 lastIndex 残留影响", () => {
    const re = reConcrete();
    const text = "他昨天买了3个苹果。";
    const viaTest: boolean[] = [];
    for (let i = 0; i < 4; i++) viaTest.push(re.test(text));
    expect(viaTest).toEqual([true, false, true, false]);

    const re2 = reConcrete();
    const viaSearch: boolean[] = [];
    for (let i = 0; i < 4; i++) viaSearch.push(text.search(re2) >= 0);
    expect(viaSearch).toEqual([true, true, true, true]);
  });
});
