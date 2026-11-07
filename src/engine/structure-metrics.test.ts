/**
 * structure-metrics 单测：钉住「纯句法统计」的可复现性与边界。
 *
 * 这些断言不判断「好/坏」，只钉数值关系——指标本身没有方向，方向来自跟谁比。
 */
import { describe, it, expect } from "vitest";
import { structureMetrics, compareMetrics, formatMetrics } from "./structure-metrics";

describe("structureMetrics：基础统计", () => {
  const t = "城市更新需要长期投入。资金来源决定项目成败。居民参与影响最终效果。";

  it("句数与句号密度", () => {
    const m = structureMetrics(t);
    expect(m.sentences).toBe(3);
    expect(m.chars).toBe(t.length);
    expect(m.periodPerKChar).toBeCloseTo((3 / m.chars) * 1000, 1);
  });

  it("短句阈值是 <10 字：正好 10 字不算短句", () => {
    expect(structureMetrics(t).shortRatio).toBe(0);
    expect(structureMetrics("甲。乙。丙。").shortRatio).toBe(1);
  });

  it("空串/纯空白不炸", () => {
    for (const s of ["", "   ", "\n\n"]) {
      const m = structureMetrics(s);
      expect(m.sentences).toBe(0);
      expect(m.periodPerKChar).toBe(0);
      expect(m.sentLen.mean).toBe(0);
      expect(m.shortRatio).toBe(0);
    }
  });

  it("纯函数：同输入同输出", () => {
    expect(structureMetrics(t)).toEqual(structureMetrics(t));
  });
});

describe("structureMetrics：句长分布", () => {
  const t =
    "短句。这是一句长度中等的句子用来测试均值。这一句明显更长一些因为它包含更多的字词和修饰成分整体把平均值拉高了。";

  it("P10 ≤ 中位 ≤ P90 ≤ 最长", () => {
    const m = structureMetrics(t);
    expect(m.sentLen.p10).toBeLessThanOrEqual(m.sentLen.median);
    expect(m.sentLen.median).toBeLessThanOrEqual(m.sentLen.p90);
    expect(m.sentLen.p90).toBeLessThanOrEqual(m.sentLen.max);
    expect(m.sentLen.cv).toBeGreaterThan(0);
  });
});

describe("structureMetrics：并列与标点", () => {
  it("逗号只认全角；每句逗号数与含逗号句占比", () => {
    const m = structureMetrics("甲，乙，丙。丁。");
    expect(m.commasPerSentence).toBe(1); // 2 个逗号 / 2 句
    expect(m.commaSentenceRatio).toBe(0.5); // 2 句里 1 句含逗号
    expect(structureMetrics("甲, 乙。").commasPerSentence).toBe(0); // 半角不计
  });

  it("破折号/省略号按千字密度", () => {
    const m = structureMetrics("他走了——真的走了……就这样。");
    expect(m.emDashPerKChar).toBeGreaterThan(0);
    expect(m.ellipsisPerKChar).toBeGreaterThan(0);
  });

  it("段落形态：多段时每段句数可算", () => {
    const m = structureMetrics("甲。乙。\n\n丙。\n\n丁。戊。己。");
    expect(m.paragraphs).toBe(3);
    expect(m.sentencesPerParagraph.mean).toBe(2);
  });
});

describe("compareMetrics：改动幅度可复算", () => {
  it("按变化幅度降序，且逗号项能算到 -100%", () => {
    const before = structureMetrics("甲，乙。丙，丁。");
    const after = structureMetrics("甲。乙。丙。丁。");
    const rows = compareMetrics(before, after);
    // 排序必须按 |deltaPct| 非递增（并列时保留登记顺序，不强求某一项夺冠）
    for (let i = 1; i < rows.length; i++) {
      expect(Math.abs(rows[i - 1].deltaPct ?? 0)).toBeGreaterThanOrEqual(
        Math.abs(rows[i].deltaPct ?? 0),
      );
    }
    const comma = rows.find((r) => r.key === "commasPerSentence")!;
    expect(comma.after).toBe(0);
    expect(comma.deltaPct).toBe(-100);
    // 全 0 基线时 deltaPct 必须是 null，不能伪装成 0%
    expect(rows.filter((r) => r.deltaPct === null).length).toBeGreaterThan(0);
  });

  it("formatMetrics 含关键项，便于 CLI 一眼读", () => {
    const s = formatMetrics(structureMetrics("甲。乙。"));
    expect(s).toContain("句号");
    expect(s).toContain("句长");
    expect(s).toContain("段");
  });
});
