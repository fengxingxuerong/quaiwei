/**
 * low-yield.test.ts —— `--skip-low-risk` 长度归一判据的防漂移锁。
 *
 * P1-1 归因（evidence/collateral-attribution-2026-11-09/）：旧判据用未归一的
 * formalHits，字数相关系数 0.958 ⇒ 长文构造性不可能命中。这里锁住三件事：
 * 长度放大后判据不翻转、密度高的短稿不命中、阈值与 signals 自洽。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOW_YIELD_FORMAL_PER_1K,
  isLegacyLowYieldRisk,
  isLowYieldRisk,
  lowYieldSignals,
} from "./low-yield.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 人写口语稿：humanize.test.ts 探针实测 aiScore=6、书面标记稀薄 */
const CASUAL =
  "我家楼下那家早餐店开了快十年了。老板娘记得我不吃香菜，每次都是提前给我挑出来。有次我出差一个月没去，回来她问我：上哪儿发财去了？这店能开十年，靠的不是什么营销打法，就是记得住人。";

/** 纯书面标记堆出来的高密度短稿 */
const DENSE = "然而从而进而因而其中之一反之乃至即可然而从而进而因而其中之一反之乃至即可";

describe("--skip-low-risk 判据（长度归一）", () => {
  it("口语低密度稿命中，高密度短稿不命中", () => {
    expect(isLowYieldRisk(CASUAL)).toBe(true);
    expect(isLowYieldRisk(DENSE)).toBe(false);
  });

  it("同一文本放大 10 倍：formalHits 变、formalPer1k 与判定不变（旧判据会翻转）", () => {
    // 基础稿含 1~2 个书面标记但密度仍低于阈值；拉长后原始次数线性增长，密度不变。
    const base = `然而${CASUAL.repeat(3)}`;
    const shortSignals = lowYieldSignals(base);
    const longSignals = lowYieldSignals(base.repeat(10));
    expect(shortSignals.formalHits).toBeGreaterThan(0);
    expect(shortSignals.formalHits).toBeLessThanOrEqual(2);
    expect(longSignals.formalHits).toBeGreaterThan(2);
    expect(Math.abs(longSignals.formalPer1k - shortSignals.formalPer1k)).toBeLessThanOrEqual(0.5);
    expect(isLowYieldRisk(base.repeat(10))).toBe(isLowYieldRisk(base));
    // 对照：旧判据只看原始次数，同一篇稿拉长后就不命中了
    expect(isLegacyLowYieldRisk(base, 6)).toBe(true);
    expect(isLegacyLowYieldRisk(base.repeat(10), 6)).toBe(false);
  });

  it("C23（aiScore=12 但书面标记密）不被跳过：锁住 humanize-cli-stdin 的 rescued 用例", () => {
    const cases = JSON.parse(
      readFileSync(path.join(ROOT, "scripts", "realcase", "cases.json"), "utf8"),
    ) as { cases: { id: string; text: string }[] };
    const c23 = cases.cases.find((c) => c.id === "C23-frontmatter-indent")!.text;
    expect(lowYieldSignals(c23).formalPer1k).toBeGreaterThan(LOW_YIELD_FORMAL_PER_1K);
    expect(isLowYieldRisk(c23)).toBe(false);
    expect(isLegacyLowYieldRisk(c23, 12)).toBe(false);
  });

  it("signals 与阈值自洽，阈值常量固定为 8/千字", () => {
    expect(LOW_YIELD_FORMAL_PER_1K).toBe(8);
    const s = lowYieldSignals(DENSE);
    expect(s.cjkChars).toBeGreaterThan(0);
    expect(s.thresholdPer1k).toBe(8);
    expect(s.hit).toBe(s.formalPer1k <= 8);
  });
});
