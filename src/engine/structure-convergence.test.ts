import { describe, expect, it } from "vitest";
import { convergeSentenceDensity } from "./structure-convergence.ts";
import { humanize } from "./humanize.ts";

const TERMINALS = /[。！？!?]/g;
const count = (t: string): number => (t.match(TERMINALS) ?? []).length;
const strip = (t: string): string => t.replace(/[，。！？!?]/g, "");

const BASE =
  "这一地区的气候条件十分复杂，冬季漫长而寒冷，夏季短暂却多雨，因此农作物的生长期被压缩在很短的一段时间之内";

/** 30 个真人式复句（约 1560 字 / 30 句号）与其「被切碎」的版本（120 句号）。 */
function longPair(sentences = 30): { orig: string; out: string } {
  const orig = Array.from({ length: sentences }, () => `${BASE}。`).join("\n");
  const out = Array.from({ length: sentences }, () => `${BASE.replace(/，/g, "。")}。`).join("\n");
  return { orig, out };
}

describe("convergeSentenceDensity · 纯函数与边界", () => {
  it("短文本逐字不变（守住 12 样本棘轮 / realcase / V8_CORPUS）", () => {
    const { orig, out } = longPair(5);
    const r = convergeSentenceDensity(orig, out);
    expect(r.text).toBe(out);
    expect(r.applied).toBe(false);
    expect(r.skipped).toBe("short");
  });

  it("同输入同输出，且不改入参", () => {
    const { orig, out } = longPair();
    const a = convergeSentenceDensity(orig, out);
    const b = convergeSentenceDensity(orig, out);
    expect(a).toEqual(b);
    expect(out).toBe(longPair().out);
  });

  it("已达标时原样返回", () => {
    const { orig } = longPair();
    const r = convergeSentenceDensity(orig, orig);
    expect(r.text).toBe(orig);
    expect(r.skipped).toBe("already-ok");
  });

  it("空产出不炸", () => {
    const { orig } = longPair();
    expect(convergeSentenceDensity(orig, "").text).toBe("");
  });
});

describe("convergeSentenceDensity · 收敛到结构目标", () => {
  it("长文收敛到目标句读数，且只改标点", () => {
    const { orig, out } = longPair();
    const r = convergeSentenceDensity(orig, out);
    expect(r.applied).toBe(true);
    expect(r.restored).toBeGreaterThan(0);
    expect(r.after).toBeLessThanOrEqual(r.targetCount);
    expect(r.after).toBe(count(r.text));
    expect(r.text.length).toBe(out.length);
    expect(strip(r.text)).toBe(strip(out));
  });

  it("目标不会低于原文句读数（原文密度高的稿子不被误伤）", () => {
    // 原文 30 句 / 1560 字 ≈ 19.2/千字，目标应为其 +4.4 而非绝对 25
    const { orig, out } = longPair();
    const r = convergeSentenceDensity(orig, out);
    expect(r.targetCount).toBeGreaterThanOrEqual(count(orig));
    expect(r.targetCount).toBeLessThan(Math.ceil((orig.replace(/\s/g, "").length / 1000) * 25));
  });

  it("可用绝对上限与增量覆盖默认值", () => {
    const { orig, out } = longPair();
    const loose = convergeSentenceDensity(orig, out, { targetPeriodPerK: 60 });
    const tight = convergeSentenceDensity(orig, out, { targetPeriodPerK: 15 });
    const generous = convergeSentenceDensity(orig, out, {
      targetPeriodPerK: 100,
      allowancePerK: 40,
    });
    expect(loose.after).toBeGreaterThan(tight.after);
    expect(generous.after).toBeGreaterThan(loose.after);
    // 30 句里恰好 90 个引擎新增句号，tight 需要还原 90 个 ⇒ 候选刚好够
    expect(tight.skipped).toBeNull();
  });
});

describe("convergeSentenceDensity · 保守判据", () => {
  it("原文自带句读受前后锚保护，不被还原", () => {
    const { orig, out } = longPair();
    const r = convergeSentenceDensity(orig, out);
    // 原文每句的结尾「一段时间之内。」是句读锚，应全部保留
    const kept = (r.text.match(/一段时间之内。/g) ?? []).length;
    expect(kept).toBe(30);
  });

  it("不跨段落、不动问号叹号、不碰表格与 URL 段", () => {
    const head = "这一地区的气候条件十分复杂，冬季漫长而寒冷，夏季短暂却多雨。\n";
    const orig = head.repeat(40);
    const out = orig.replace(/，/g, "。").replace(/。\n/g, "！\n");
    const r = convergeSentenceDensity(orig, out);
    // 只还原段内的「。」，段末「！」一律不动
    expect((r.text.match(/！\n/g) ?? []).length).toBe(40);

    const table = "| 项 | 值 |\n| --- | --- |\n| 甲。乙 | 一。二 |\n";
    const tableOrig = table.repeat(30);
    const t = convergeSentenceDensity(tableOrig, tableOrig.replace(/。/g, "。"), {
      targetPeriodPerK: 0.001,
    });
    expect(t.restored).toBe(0);
  });

  it("合并后超长（>72 字）的两句不还原", () => {
    const long = "甲".repeat(45);
    const long2 = "乙".repeat(45);
    const orig = `${long}，${long2}。\n`.repeat(30);
    const out = `${long}。${long2}。\n`.repeat(30);
    const r = convergeSentenceDensity(orig, out, { targetPeriodPerK: 1 });
    expect(r.restored).toBe(0);
    expect(r.skipped).toBe("no-candidate");
  });
});

describe("humanize 接入（实验性，默认关）", () => {
  it("默认与显式关闭逐字相同（不把被判退化的行为推给用户）", () => {
    const { orig } = longPair(50);
    expect(humanize(orig, { intensity: 0.6, seed: 20260905 })).toBe(
      humanize(orig, { intensity: 0.6, seed: 20260905, convergence: false }),
    );
  });

  it("短文本：显式开启也逐字相同（<1000 字门槛）", () => {
    const short = `${BASE}。\n${BASE}。\n${BASE}。`;
    expect(humanize(short, { intensity: 0.6, seed: 42, convergence: true })).toBe(
      humanize(short, { intensity: 0.6, seed: 42 }),
    );
  });

  it("显式开启时句读密度低于默认，且只改标点", () => {
    const { orig } = longPair(50);
    const on = humanize(orig, { intensity: 0.6, seed: 20260905, convergence: true });
    const off = humanize(orig, { intensity: 0.6, seed: 20260905 });
    expect(count(on)).toBeLessThan(count(off));
    expect(strip(on)).toBe(strip(off));
  });
});
