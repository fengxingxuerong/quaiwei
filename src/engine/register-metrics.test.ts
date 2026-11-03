/**
 * register-metrics 单测：语体指数的双向判别力。
 *
 * 锚定 2026-10-14 判别力实验的盲区（aiScore 对书面↔口语替换 2/21 方向正确）：
 * 本维度必须做到——书面→口语替换后指数显著下降、口语→书面显著上升。
 * 两方向都锁，缺一不可（只锁一个方向挡不住「它只对另一组词敏感」的假象）。
 */
import { describe, it, expect } from "vitest";
import { registerIndex, REGISTER_MARKERS } from "./register-metrics";

/** 公文腔样例：刻意铺满书面标记（对标 probe-inject 的政务/维基体裁） */
const FORMAL_TEXT =
  "然而，贯彻落实上述部署仍亟待加强。诸多环节尚未健全，若干指标较为滞后。" +
  "鉴于这种情况，有关部门随即开展专项行动，统筹推进各项任务，着力夯实基础。" +
  "与此同时，要切实压实责任，确保举措落地。原本若干试点已业已铺开，" +
  "倘若后续较为顺利，即可进行全面推进，其具有重要意义。";

/** 把上文的书面词换成口语等义词（与 probe-inject FORMAL_MAP 同向） */
function toColloquial(text: string): string {
  const map: [string, string][] = [
    ["然而", "不过"],
    ["亟待", "急着要"],
    ["诸多", "好多"],
    ["尚未", "还没"],
    ["若干", "一些"],
    ["较为", "挺"],
    ["随即", "接着"],
    ["统筹", "安排"],
    ["着力", "使劲"],
    ["夯实", "打牢"],
    ["与此同时", "同时呢"],
    ["切实", "实实在在"],
    ["确保", "保证"],
    ["原本", "原来"],
    ["业已", "已经"],
    ["倘若", "要是"],
    ["全面推进", "全面推开"],
  ];
  let out = text;
  for (const [a, b] of map) out = out.split(a).join(b);
  return out;
}

/** 口语样例：垫词、语气词、第一人称（对标真人随笔/聊天体） */
const CASUAL_TEXT =
  "说真的，我琢磨这事好几天了。差不多得了呗，反正也没啥大不了的。" +
  "咱们接着说啊，那天他赶紧跑过来，一脸懵，问咋整。我说你甭管，" +
  "弄完就舒坦了。好多人都觉得挺难，其实就是懒得动手，你说是不是？";

describe("registerIndex：语体指数（独立维度，不并入 aiScore）", () => {
  it("公文腔文本 → 高分区（偏书面以上）", () => {
    const r = registerIndex(FORMAL_TEXT);
    expect(r.formalHits).toBeGreaterThan(8);
    expect(r.index).toBeGreaterThanOrEqual(60);
    expect(["公文/书面腔浓", "偏书面"]).toContain(r.label);
  });

  it("同文书面→口语替换 → 指数显著下降（盲区修复的正向锚）", () => {
    const before = registerIndex(FORMAL_TEXT);
    const after = registerIndex(toColloquial(FORMAL_TEXT));
    expect(after.formalHits).toBeLessThan(before.formalHits);
    expect(before.index - after.index).toBeGreaterThanOrEqual(15);
  });

  it("口语文本 → 低分区（中性以下）", () => {
    const r = registerIndex(CASUAL_TEXT);
    expect(r.colloquialHits).toBeGreaterThan(5);
    expect(r.index).toBeLessThanOrEqual(45);
    expect(["中性", "偏口语", "口语"]).toContain(r.label);
  });

  it("口语→书面替换 → 指数显著上升（另一方向也要动）", () => {
    const before = registerIndex(CASUAL_TEXT);
    const up = CASUAL_TEXT.split("差不多")
      .join("大致")
      .split("好多")
      .join("诸多")
      .split("挺")
      .join("较为");
    const after = registerIndex(up);
    expect(after.formalHits).toBeGreaterThan(before.formalHits);
    expect(after.index - before.index).toBeGreaterThanOrEqual(10);
  });

  it("空串 / 纯标点 / 纯英文：不崩溃，返回中性 50", () => {
    for (const t of ["", "。！？、", "hello world 123"]) {
      const r = registerIndex(t);
      expect(r.index).toBe(50);
      expect(r.countedChars).toBe(0);
      expect(r.label).toBe("中性");
    }
  });

  it("英文夹注不摊薄密度：分母只数 CJK", () => {
    const zh = registerIndex("贯彻落实部署");
    const mixed = registerIndex("贯彻落实部署 roadmap 2026 Q1 OKR KPI");
    expect(mixed.countedChars).toBe(zh.countedChars);
    expect(mixed.index).toBe(zh.index);
  });

  it("确定性：同输入同输出", () => {
    expect(registerIndex(FORMAL_TEXT)).toEqual(registerIndex(FORMAL_TEXT));
  });

  it("词表无重复条目（重复会翻倍计分）", () => {
    expect(new Set(REGISTER_MARKERS.formal).size).toBe(REGISTER_MARKERS.formal.length);
    expect(new Set(REGISTER_MARKERS.colloquial).size).toBe(REGISTER_MARKERS.colloquial.length);
  });

  it("与 probe-inject 的双向替换表同口径：书面侧词必须都在正式词表里", () => {
    // 实验脚本的 FORMAL_MAP / STYLE_MAP 源侧词，缺了哪个方向测试就失真哪个
    const formalSide = [
      "大致",
      "尤其",
      "较为",
      "尚未",
      "随后",
      "当即",
      "随即",
      "原本",
      "诸多",
      "倘若",
      "若干",
      "颇为",
      "诸如",
      "以便",
    ];
    for (const w of formalSide) {
      expect(REGISTER_MARKERS.formal).toContain(w);
    }
  });
});
