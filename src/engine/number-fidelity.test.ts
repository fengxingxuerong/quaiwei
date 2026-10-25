/**
 * 数字保真守卫的单元测试（v0.9.76）
 *
 * 这个守卫是在实测里被抓出来的真实缺陷的补丁：
 * 财经快讯那篇，模型把「公司总资产达到 126.75 亿元，较上年末上升 6.3%」整句删掉，
 * 两个数字随句子一起没了。所以这里锁三件事：
 *   ① 归一化要对：全角数字、千分位、百分号（含省略 % 的写法）都算同一事实；
 *   ② 不能误报：数字全在、只是位置/句式变了 → 不许报；
 *   ③ 文案要能直接贴给用户看（含缺失清单 + 为什么重要）。
 */
import { describe, it, expect } from "vitest";
import { numericFacts, missingNumericFacts, numericFidelityWarning } from "./number-fidelity";

const SRC =
  "报告期内，公司实现营业收入 48.62 亿元，较上年同期增长 12.7%；归属于上市公司股东的净利润 5.34 亿元，同比增长 8.9%。" +
  "报告期末，公司总资产达到 126.75 亿元，较上年末上升 6.3%，资产负债率维持在 41.2% 的较低水平。";

describe("numericFacts（归一化）", () => {
  it("全角数字、中文千分位、全角百分号都归一到同一形态", () => {
    expect(numericFacts("营收１２．７％，总资产 1，234 亿元").sort()).toEqual(["12.7%", "1234"]);
  });

  it("没有数字时返回空数组（不让空文本误触发）", () => {
    expect(numericFacts("行业竞争加剧，企业压力不小。")).toEqual([]);
  });

  it("小数与百分号保留原样（%）", () => {
    expect(numericFacts("增长 6.3%，净利 5.34 亿元").sort()).toEqual(["5.34", "6.3%"]);
  });
});

describe("missingNumericFacts（缺失判定）", () => {
  it("抓得到「整句连数字一起删」这种真实形态", () => {
    const out = SRC.replace(
      "报告期末，公司总资产达到 126.75 亿元，较上年末上升 6.3%，资产负债率维持在 41.2% 的较低水平。",
      "资产负债率维持在 41.2% 的较低水平。",
    );
    expect(missingNumericFacts(SRC, out)).toEqual(["126.75", "6.3%"]);
  });

  it("数字全在、只是换了位置和句式 → 不报", () => {
    const out =
      "营收 48.62 亿元（+12.7%），净利润 5.34 亿元（+8.9%）；期末总资产 126.75 亿元、+6.3%，" +
      "资产负债率 41.2%。";
    expect(missingNumericFacts(SRC, out)).toEqual([]);
  });

  it("把百分号写成「百分之」也算命中（12.7% vs 百分之 12.7）", () => {
    const out = SRC.replace("增长 12.7%", "增长百分之 12.7");
    expect(missingNumericFacts(SRC, out)).toEqual([]);
  });

  it("原文没有数字时不报（短句/散文不该被数字守卫降噪）", () => {
    expect(
      missingNumericFacts("这是一段没有数字的散文。", "这是改写后的散文，仍然没有数字。"),
    ).toEqual([]);
  });
});

describe("numericFidelityWarning（文案）", () => {
  it("有缺失时给出可读清单，并说明后果", () => {
    const out = SRC.replace("，较上年末上升 6.3%", "");
    const msg = numericFidelityWarning(SRC, out);
    expect(msg).toContain("6.3%");
    expect(msg).toContain("内容失真");
    expect(msg).toContain("严格保真");
  });

  it("无缺失时返回 null（调用方靠它决定要不要写 note）", () => {
    expect(numericFidelityWarning(SRC, SRC)).toBeNull();
  });

  it("缺失过多时截断展示，但仍报总数", () => {
    const many = Array.from({ length: 9 }, (_, i) => `${i + 1}.5 亿元`).join("、");
    const msg = numericFidelityWarning(`总计 ${many}。`, "总计若干。");
    expect(msg).toContain("等 9 个");
  });
});
