import { describe, it, expect } from "vitest";
import { humanize } from "./humanize";
import { runTracedHumanize, aggregateStages } from "./pipeline-trace";
import type { StageTrace } from "./humanize-primitives";

/**
 * 流水线 trace 的测试重心只有一个：**它不能改变引擎的输出**。
 *
 * trace 是一个旁路观测装置。如果哪天它开始影响改写结果（比如多消耗了一次 rng），
 * 那用户在面板上看到的就不是"引擎真实跑的过程"，而是"观测行为污染后的过程"——
 * 那样的面板比没有更糟。所以一致性用例是本文件的第一优先级。
 */

/** 多段文本：确保走到「逐段派生种子」的分支（单段文本覆盖不到那段） */
const MULTI = `值得注意的是，随着人工智能技术的快速发展，AI 写作工具应运而生。
综上所述，数字化办公不仅极大地提升了工作效率，而且有效地降低了运营成本。
然而，技术的变革也带来了一系列值得关注的挑战。与此同时，如何平衡创新与风险，成为至关重要的课题。`;

describe("pipeline-trace · 观测不得改变输出", () => {
  const cases = [
    { intensity: 0.3, seed: 1 },
    { intensity: 0.6, seed: 7 },
    { intensity: 0.9, seed: 42 },
    { intensity: 0.9, seed: 42, zhuqueMode: true },
    { intensity: 0.75, seed: 3, genre: "narrative" as const },
    { intensity: 0.75, seed: 3, genre: "dialogue" as const },
    { intensity: 0.5, seed: 11, style: "academic" as const },
  ];

  for (const c of cases) {
    it(`开不开 trace 输出逐字相同 · ${JSON.stringify(c)}`, () => {
      const plain = humanize(MULTI, c);
      const traced = runTracedHumanize(MULTI, c);
      expect(traced.text).toBe(plain);
      expect(traced.text.length).toBeGreaterThan(0);
    });
  }

  it("短到被入口守卫拦下的文本：两者都原样返回", () => {
    const t = "短。";
    expect(runTracedHumanize(t).text).toBe(humanize(t));
    expect(runTracedHumanize(t).trace.stages.length).toBe(1);
    expect(runTracedHumanize(t).trace.stages[0].skipped).toBe(true);
  });
});

describe("pipeline-trace · 阶段记录是真实执行产物", () => {
  it("核心阶段全部出现，且顺序符合引擎实际流程", () => {
    const { trace } = runTracedHumanize(MULTI, { intensity: 0.9, seed: 20261015 });
    const ids = trace.stages.map((s) => s.id);
    // 体裁判定必须先于一切改写
    expect(ids[0]).toBe("genre");
    for (const id of [
      "conn",
      "redundant",
      "intensifier",
      "le",
      "passive",
      "template",
      "vocab",
      "dev",
      "concessive",
      "punct",
      "splitconn",
      "sentence",
      "cleanup",
      "cliche",
      "halfwidth",
      "para",
      "zhuque",
      "structure",
      "final",
    ]) {
      expect(ids, `缺少阶段 ${id}`).toContain(id);
    }
    // 段落级步骤（逐段跑）必须排在全文级的段落汇总之前
    expect(ids.indexOf("halfwidth")).toBeLessThan(ids.indexOf("para"));
    // 清尾必须是最后一步
    expect(ids[ids.length - 1]).toBe("final");
  });

  it("多段文本：段落级步骤的 runs = 段落数，全文级步骤 runs = 1", () => {
    const { trace } = runTracedHumanize(MULTI, { intensity: 0.9, seed: 1 });
    const paraCount = MULTI.split(/\n+/).filter((p) => p.trim()).length;
    const byId = new Map(trace.stages.map((s) => [s.id, s]));
    expect(byId.get("conn")!.runs).toBe(paraCount);
    expect(byId.get("genre")!.runs).toBe(1);
    expect(byId.get("final")!.runs).toBe(1);
  });

  it("每一步都带 why（没有 why 的阶段等于没解释）", () => {
    const { trace } = runTracedHumanize(MULTI, { intensity: 0.9, seed: 1 });
    expect(trace.stages.length).toBeGreaterThan(20);
    for (const s of trace.stages) {
      expect(s.why.length, `阶段 ${s.id} 缺 why`).toBeGreaterThan(10);
    }
  });

  it("快照是这一步结束时的真实文本（取的是输出，不是输入）", () => {
    const { trace } = runTracedHumanize(MULTI, { intensity: 0.9, seed: 1 });
    const final = trace.stages.find((s) => s.id === "final")!;
    expect(final.snippets[0].text.length).toBeGreaterThan(0);
    // final 的 metric 里写着「输出 N 字」，必须与 trace 的输出长度一致
    expect(final.metrics.join("")).toContain(`输出 ${trace.outputChars} 字`);
  });

  it("耗时与事件数都是正数：说明确实跑了，不是空壳", () => {
    const { trace } = runTracedHumanize(MULTI, { intensity: 0.9, seed: 1 });
    expect(trace.eventCount).toBeGreaterThan(trace.stages.length);
    expect(trace.totalMs).toBeGreaterThan(0);
    expect(trace.totalMs).toBeLessThan(5000);
  });
});

describe("aggregateStages · 归并口径", () => {
  const mk = (over: Partial<StageTrace>): StageTrace => ({
    id: "x",
    name: "X",
    why: "因为……",
    ms: 1,
    charsBefore: 100,
    charsAfter: 90,
    snippet: "abc",
    ...over,
  });

  it("同 id 多段：耗时累加、runs 累加、delta 取各段之和", () => {
    const t = aggregateStages(
      [
        mk({ id: "a", ms: 1.5, charsBefore: 100, charsAfter: 90 }),
        mk({ id: "a", ms: 2.25, charsBefore: 80, charsAfter: 70 }),
      ],
      100,
      70,
    );
    expect(t.stages).toHaveLength(1);
    expect(t.stages[0].runs).toBe(2);
    expect(t.stages[0].ms).toBe(3.75);
    expect(t.stages[0].delta).toBe(-20);
  });

  it("只要有一段真跑了，整条阶段就不算跳过", () => {
    const t = aggregateStages(
      [mk({ id: "a", skipped: true }), mk({ id: "a", skipped: false })],
      10,
      10,
    );
    expect(t.stages[0].skipped).toBe(false);
  });

  it("全跳过的阶段才标 skipped", () => {
    const t = aggregateStages([mk({ id: "a", skipped: true })], 10, 10);
    expect(t.stages[0].skipped).toBe(true);
  });

  it("deltaFromPrev 按流水线顺序做相邻差分（收尾阶段连着看不出变化的救药）", () => {
    const t = aggregateStages(
      [
        mk({ id: "a", charsBefore: 100, charsAfter: 90 }),
        mk({ id: "b", charsBefore: 100, charsAfter: 88 }),
        mk({ id: "c", charsBefore: 100, charsAfter: 88 }),
      ],
      100,
      88,
    );
    expect(t.stages.map((s) => s.deltaFromPrev)).toEqual([-10, -2, 0]);
  });

  it("阶段顺序按首次出现排序，不按 id 字典序", () => {
    const t = aggregateStages([mk({ id: "z" }), mk({ id: "a" }), mk({ id: "z" })], 1, 1);
    expect(t.stages.map((s) => s.id)).toEqual(["z", "a"]);
  });

  it("快照最多留 4 段：不让 trace 体积随段落数线性膨胀", () => {
    const events = Array.from({ length: 9 }, (_, i) => mk({ id: "a", snippet: `s${i}` }));
    const t = aggregateStages(events, 1, 1);
    expect(t.stages[0].snippets).toHaveLength(4);
    expect(t.stages[0].snippets.map((s) => s.text)).toEqual(["s0", "s1", "s2", "s3"]);
  });

  it("重复的 metric 只留一条（多段跑出来的 metric 往往一模一样）", () => {
    const t = aggregateStages(
      [mk({ id: "a", metric: "同一句" }), mk({ id: "a", metric: "同一句" })],
      1,
      1,
    );
    expect(t.stages[0].metrics).toEqual(["同一句"]);
  });
});

/**
 * v0.9.55 工程卫生：补齐「旁路分支」的 trace 记录。
 *
 * 这些分支不会进改写主路径——入口守卫的三种短路、单段落直通、朱雀三道门控的
 * 跳过原因——但它们的 metric 文案会**原样出现在 trace 面板上**，是用户肉眼可见的
 * 观测产物。此前全无用例走到，等于面板上有一半文案没有回归保护。
 */
describe("pipeline-trace · 旁路分支也留真记录", () => {
  it("空文本：入口守卫记录一条 skipped，输出空串", () => {
    const { text, trace } = runTracedHumanize("");
    expect(text).toBe("");
    expect(trace.stages.length).toBe(1);
    expect(trace.stages[0].id).toBe("guard");
    expect(trace.stages[0].skipped).toBe(true);
  });

  it("强度=0：入口即短路，记录 skipped 且输出逐字等于原文", () => {
    const r = runTracedHumanize(MULTI, { intensity: 0, seed: 1 });
    expect(r.text).toBe(MULTI);
    expect(r.trace.stages.length).toBe(1);
    expect(r.trace.stages[0].id).toBe("guard");
    expect(r.trace.stages[0].skipped).toBe(true);
  });

  it("单段普通文本：走直通分支（非逐段派生种子），输出仍与不开 trace 逐字相同", () => {
    const single = "随着人工智能技术的快速发展，AI 写作工具应运而生。它有效提升了写作效率。";
    const r = runTracedHumanize(single, { intensity: 0.9, seed: 42 });
    expect(r.text).toBe(humanize(single, { intensity: 0.9, seed: 42 }));
    const para = r.trace.stages.find((s) => s.id === "para")!;
    expect(para.metrics.join(" ")).toContain("单段文本");
  });

  it("朱雀跳过三种原因都如实记录：未开启 / 强度不足 / 垫词饱和", () => {
    // ① 默认不开朱雀增强（zhuqueMode 缺省 false）
    const a = runTracedHumanize(MULTI, { intensity: 0.9, seed: 1 });
    const zqA = a.trace.stages.find((s) => s.id === "zhuque")!;
    expect(zqA.skipped).toBe(true);
    expect(zqA.metrics.join(" ")).toContain("未开启");

    // ② 开了但强度不足（narrative 的 knobs.disableZhuque=false，可控）
    const b = runTracedHumanize(MULTI, {
      intensity: 0.3,
      seed: 1,
      zhuqueMode: true,
      genre: "narrative",
    });
    const zqB = b.trace.stages.find((s) => s.id === "zhuque")!;
    expect(zqB.skipped).toBe(true);
    expect(zqB.metrics.join(" ")).toContain("0.35");

    // ③ 开了、强度够，但原文垫词已饱和（≥ PAD_INJECT_CAP=10 处「讲道理」）
    const pad = Array.from({ length: 11 }, (_, i) => `讲道理，第 ${i + 1} 点确实值得注意。`).join(
      "",
    );
    const c = runTracedHumanize(pad, {
      intensity: 0.9,
      seed: 1,
      zhuqueMode: true,
      genre: "narrative",
    });
    const zqC = c.trace.stages.find((s) => s.id === "zhuque")!;
    expect(zqC.skipped).toBe(true);
    expect(zqC.metrics.join(" ")).toContain("饱和");
  });
});
