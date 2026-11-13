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
import {
  numericFacts,
  quantitativeFacts,
  changedUnits,
  missingNumericFacts,
  addedNumericFacts,
  numericFidelityWarning,
} from "./number-fidelity";

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

describe("missingNumericFacts（缺失判定，按 数值+量纲 比）", () => {
  it("抓得到「整句连数字一起删」这种真实形态", () => {
    const out = SRC.replace(
      "报告期末，公司总资产达到 126.75 亿元，较上年末上升 6.3%，资产负债率维持在 41.2% 的较低水平。",
      "资产负债率维持在 41.2% 的较低水平。",
    );
    // 带上量纲更好定位：是「126.75 亿元」这一个事实没了
    expect(missingNumericFacts(SRC, out)).toEqual(["126.75亿", "6.3%"]);
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

describe("quantitativeFacts（只收数量型事实，压住假阳性）", () => {
  it("型号里的数字不算数量（C4 实测：X200 智能会议终端）", () => {
    expect(quantitativeFacts("X200 智能会议终端搭载 8 核处理器")).toEqual([]);
    expect(quantitativeFacts("支持 5G 与 Wi-Fi 7、iPhone15 同传")).toEqual([]);
  });

  it("中文数字与阿拉伯数字互认（量纲单位）：「14 小时」≡「十四小时」", () => {
    expect(missingNumericFacts("会议时长 14 小时。", "会议时长为十四小时。")).toEqual([]);
    expect(missingNumericFacts("投入 3 亿元。", "投入三亿元。")).toEqual([]);
    // 数值真的变了仍要报
    expect(missingNumericFacts("会议时长 14 小时。", "会议时长为十二小时。")).toEqual(["14小时"]);
  });

  it("量词不在检查范围（一种方法 → 一个方法 是合法改写）", () => {
    // 回放 53 次真实产出时，这类"报警"占了绝大多数，全是噪音——量词必须排除
    expect(quantitativeFacts("共有 3 个指标、5 类样本。")).toEqual([]);
    expect(missingNumericFacts("共有 3 个指标。", "共有五个指标。")).toEqual([]);
    expect(missingNumericFacts("这是一种方法。", "这是一个方法。")).toEqual([]);
  });

  it("多位数 / 小数 / 百分数 / 带单位的量都保留", () => {
    expect(quantitativeFacts("总资产 126.75 亿元、增长 6.3%、65Wh、14 小时").sort()).toEqual([
      "126.75",
      "14",
      "6.3",
      "65",
    ]);
  });

  it("无单位的单个阿拉伯数字仍不收（「3」太容易是编号）", () => {
    expect(quantitativeFacts("第 3 页，共 3 处。")).toEqual([]);
  });

  it("真实缺陷仍然抓得到（财经快讯那次）", () => {
    const src = "报告期末，公司总资产达到 126.75 亿元，较上年末上升 6.3%，资产负债率 41.2%。";
    const out = "报告期末，资产负债率 41.2%。";
    expect(missingNumericFacts(src, out)).toEqual(["126.75亿", "6.3%"]);
  });
});

describe("单位保真（v0.9.78）", () => {
  const SRC =
    "营业收入 48.62 亿元，同比 12.7%，总资产 126.75 亿元，研发 3.87 亿元，会议时长 14 小时。";

  it("改单位要报：亿元 → 万元（量级差 10000 倍）", () => {
    const out = SRC.replace("总资产 126.75 亿元", "总资产 126.75 万元");
    expect(changedUnits(SRC, out)).toEqual(["126.75亿 → 万"]);
    expect(numericFidelityWarning(SRC, out)).toContain("改了原文的数字单位");
  });

  it("同一量纲的不同写法不报：亿元 ↔ 亿", () => {
    const out = SRC.replace("总资产 126.75 亿元", "总资产 126.75 亿");
    expect(changedUnits(SRC, out)).toEqual([]);
  });

  it("时间单位也不能换：14 小时 → 14 分钟", () => {
    const out = SRC.replace("14 小时", "14 分钟");
    expect(changedUnits(SRC, out)).toEqual(["14小时 → 分钟"]);
  });

  it("数字整个消失时不走单位检查（交给缺失检查，避免同一处报两遍）", () => {
    const out = SRC.replace("总资产 126.75 亿元，", "");
    expect(changedUnits(SRC, out)).toEqual([]);
    expect(numericFidelityWarning(SRC, out)).toContain("缺少原文中的数字");
  });

  it("百分比不是单位：12.7% 保持 12.7% 不报", () => {
    expect(changedUnits(SRC, SRC)).toEqual([]);
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

/**
 * v0.9.88：反向缺口——产出多出原文没有的数量事实。
 *
 * 两条用例都来自 2026-11-13 的 `--api` 单轮实产（`evidence/eval-api-glm-2026-11-13/`），
 * 不是构造的：模型做了算术派生，数字全对，但原文没这个口径。
 */
describe("addedNumericFacts（新增数字）", () => {
  it("算术派生算新增：21.4% 与 15.8% 推出「低了 5.6 个百分点」", () => {
    const src = "公司营收同比增长 21.4%，净利润同比增长 15.8%。";
    const out = "公司营收同比增长 21.4%，净利润增长 15.8%，比营收增速低了 5.6 个百分点。";
    expect(addedNumericFacts(src, out)).toEqual(["5.6个百分点"]);
    expect(numericFidelityWarning(src, out)).toContain("新增了原文没有的数字");
  });

  it("价格差也是新增：4999 与 6499 之间凭空写出「差价 1500 元」", () => {
    const src = "标准版定价 4999 元，Pro 版定价 6499 元。";
    const out = "标准版 4999 元，Pro 版 6499 元，差价 1500 元。";
    expect(addedNumericFacts(src, out)).toEqual(["1500"]);
  });

  it("原文一次都没提到的量才算新增（数值出现过就归 changedUnits，不重复报）", () => {
    const src = "总资产 126.75 亿元。";
    const out = "总资产 126.75 万元。";
    expect(addedNumericFacts(src, out)).toEqual([]);
    expect(changedUnits(src, out).length).toBe(1);
  });

  it("中文数字与阿拉伯数字互认，不当新增", () => {
    expect(addedNumericFacts("共三个批次，耗时十四小时。", "共 3 个批次，耗时 14 小时。")).toEqual(
      [],
    );
  });

  it("完全相同的文本不报", () => {
    expect(addedNumericFacts(SRC, SRC)).toEqual([]);
    expect(numericFidelityWarning(SRC, SRC)).toBeNull();
  });

  it("原文没有任何数量事实、产出冒出量化的，照样报", () => {
    expect(addedNumericFacts("很多用户反馈不错。", "有 68% 的用户反馈不错。")).toEqual(["68%"]);
  });

  it("标识符里的数字不算：X200 / iPhone15 不进事实表", () => {
    expect(addedNumericFacts("设备型号 X200。", "设备型号 X200，另配 iPhone15。")).toEqual([]);
  });
});
