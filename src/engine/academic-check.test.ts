/**
 * src/engine/academic-check.test.ts —— 学术硬出口的对照测试
 *
 * 守的是"能不能投"这个判定：能机器判的（数字/引用/结构）必须判准，
 * 不能机器判的（论证强弱）必须留在提醒里，别冒充结论。
 */
import { describe, it, expect } from "vitest";
import { academicAudit, formatAcademicReport } from "./academic-check";

const PAPER = [
  "本文在 3 个数据集上做了消融实验，准确率提升 4.2 个百分点~\\cite{wang2024}。",
  "结果表明，该方法在稀疏数据上表现更稳。",
].join("\n");

describe("干净稿：同一份文本当原文与产出", () => {
  it("判 ready，且不把「没查到问题」说成「查过了没问题」", () => {
    const a = academicAudit(PAPER, PAPER);
    expect(a.verdict).toBe("ready");
    expect(a.blockers).toEqual([]);
  });
});

describe("阻断项：必须人看一眼的那几类", () => {
  it("引用键被删 → blocked，并点名是哪个键", () => {
    const out = PAPER.replace("~\\cite{wang2024}", "");
    const a = academicAudit(PAPER, out);
    expect(a.verdict).toBe("blocked");
    expect(a.blockers.join()).toContain("wang2024");
    expect(a.blockers.join()).toContain("引用键丢失");
  });

  it("产出凭空多了引用键 → blocked（这是编造，比丢更糟）", () => {
    const out = PAPER + "另见~\\cite{li2025}。";
    const a = academicAudit(PAPER, out);
    expect(a.verdict).toBe("blocked");
    expect(a.blockers.join()).toContain("原文没有的引用键");
  });

  it("数字被吃掉 → blocked", () => {
    const out = PAPER.replace("3 个数据集", "多个数据集").replace("4.2 个百分点", "几个百分点");
    const a = academicAudit(PAPER, out);
    expect(a.verdict).toBe("blocked");
    expect(a.blockers.join()).toContain("数字");
  });

  it("结构被破坏 → blocked（表格/围栏/标题那一类）", () => {
    const src = [
      "# 方法",
      "",
      "| 数据集 | 准确率 |",
      "| --- | --- |",
      "| A | 91.2% |",
      "",
      "如上所示。",
    ].join("\n");
    const out = ["# 方法", "", "数据集和准确率分别是 A 和 91.2%。", "", "如上所示。"].join("\n");
    const a = academicAudit(src, out);
    expect(a.verdict).toBe("blocked");
    expect(a.blockers.join()).toContain("结构");
  });
});

describe("提醒项：只提醒，不阻断", () => {
  it("原文没有「显著」而产出有 → 提醒，但不算阻断", () => {
    const src = "结果表明，该方法在稀疏数据上表现更稳。";
    const out = "结果表明，该方法在稀疏数据上显著更稳。";
    const a = academicAudit(src, out);
    expect(a.warnings.join()).toContain("显著");
    expect(a.verdict).toBe("ready");
  });

  it("没有引用键时明说是空查，不装作查过", () => {
    const a = academicAudit("这是一段没有引用的草稿。", "这是一段没有引用的草稿。");
    expect(a.warnings.join()).toContain("空查");
    expect(a.checked.join()).toContain("引用");
  });

  it("查了什么要列出来（空查与查过都不许含糊）", () => {
    const a = academicAudit(PAPER, PAPER);
    expect(a.checked.length).toBeGreaterThanOrEqual(4);
    expect(a.stats.citeKeys).toBe(1);
  });
});

describe("报告正文", () => {
  it("阻断时标题带 NOT READY TO SUBMIT", () => {
    const a = academicAudit(PAPER, PAPER.replace("~\\cite{wang2024}", ""));
    const text = formatAcademicReport(a, { style: "academic", intensity: 0.4 });
    expect(text).toContain("NOT READY TO SUBMIT");
    expect(text).toContain("## 阻断项");
    expect(text).toContain("论证是否成立");
  });

  it("通过时明写 READY，并说清 READY 不等于一定能中", () => {
    const text = formatAcademicReport(academicAudit(PAPER, PAPER), {
      style: "academic",
      intensity: 0.4,
    });
    expect(text).toContain("**READY**");
    expect(text).toContain("不等于审稿人会收");
  });

  it("对比模式：报告里写清对比的是什么，不写成引擎跑过", () => {
    const text = formatAcademicReport(academicAudit(PAPER, PAPER), {
      style: "academic",
      intensity: 0,
      mode: "外部改写稿 vs 原文（引擎未参与）",
    });
    expect(text).toContain("对比方式：外部改写稿 vs 原文（引擎未参与）");
    expect(text).not.toContain("文风 academic · 强度 0");
  });
});
