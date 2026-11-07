/**
 * 双网关配对盲测：把「能力数字」钉在原始逐次记录上。
 *
 * 2026-11-06 之前，单席绝对分口径的结论（「降 23.6 分」）跨批次复测漂到 +12.2，
 * 却已经写进过多处文档。这一组断言从 evidence/eval-dual-2026-11-06 的 154 条
 * 原始记录重新算一遍，再核对 SCORECARD 第 4 节的数字串：
 * 记录变了、或页面数字没跟着改，都会红。
 *
 * 取仓库根用 import.meta.url，不用 process.cwd() —— coverage-gate.ts 会把 cwd 设成 os.tmpdir()。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = path.join(ROOT, "evidence", "eval-dual-2026-11-06");
const SCORECARD = readFileSync(path.join(ROOT, "SCORECARD.md"), "utf8");

type Rec = {
  key: string;
  kind: "abs" | "pair";
  id: string;
  arm?: string;
  seat: string;
  score?: number | null;
  armTag?: string;
  engineWin?: boolean | null;
  pick?: string | null;
  err?: string | null;
};

const recs: Rec[] = readFileSync(path.join(EVIDENCE, "eval_dual_results.jsonl"), "utf8")
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Rec);

const abs = recs.filter((r) => r.kind === "abs");
const pair = recs.filter((r) => r.kind === "pair");
const ids = [...new Set(abs.map((r) => r.id))];

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const round1 = (n: number) => Math.round(n * 10) / 10;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pearson = (a: number[], b: number[]) => {
  const ma = mean(a);
  const mb = mean(b);
  const num = a.reduce((s, x, i) => s + (x - ma) * (b[i] - mb), 0);
  const da = a.reduce((s, x) => s + (x - ma) ** 2, 0);
  const db = b.reduce((s, y) => s + (y - mb) ** 2, 0);
  return num / Math.sqrt(da * db);
};

const armMean = (id: string, arm: string, seat?: string) =>
  mean(
    abs
      .filter((r) => r.id === id && r.arm === arm && (!seat || r.seat === seat) && r.score != null)
      .map((r) => r.score as number),
  );

const perCase = ids.map((id) => ({
  id,
  orig: armMean(id, "orig"),
  local09: armMean(id, "local09"),
}));
const drops = perCase.map((c) => c.orig - c.local09);

const seatPairs: Array<[number, number]> = [];
for (const id of ids) {
  for (const arm of ["orig", "local09"]) {
    const a = abs.find((r) => r.id === id && r.arm === arm && r.seat === "A")?.score;
    const b = abs.find((r) => r.id === id && r.arm === arm && r.seat === "B")?.score;
    if (a != null && b != null) seatPairs.push([a, b]);
  }
}

const stats = (tag: string) => {
  const sel = pair.filter((r) => r.armTag === tag);
  return {
    n: sel.length,
    win: sel.filter((r) => r.engineWin === true).length,
    bySeat: (seat: string) => {
      const s = sel.filter((r) => r.seat === seat);
      return { n: s.length, win: s.filter((r) => r.engineWin === true).length };
    },
    firstArmChosen: sel.filter((r) => r.pick === "甲").length / sel.length,
    agreement: (() => {
      let same = 0;
      let tot = 0;
      for (const id of ids) {
        const v = sel.filter((r) => r.id === id).map((r) => r.engineWin);
        if (v.length === 2) {
          tot += 1;
          if (v[0] === v[1]) same += 1;
        }
      }
      return { pairs: tot, rate: same / tot };
    })(),
  };
};

describe("2026-11-06 双网关配对盲测原始记录", () => {
  it("154 次调用，92 绝对分 + 62 配对，零错误零空分", () => {
    expect(recs).toHaveLength(154);
    expect(abs).toHaveLength(92);
    expect(pair).toHaveLength(62);
    expect(ids).toHaveLength(23);
    expect(recs.filter((r) => r.err)).toHaveLength(0);
    expect(abs.filter((r) => r.score == null)).toHaveLength(0);
    expect(pair.filter((r) => r.engineWin == null)).toHaveLength(0);
    expect(new Set(recs.map((r) => r.key)).size).toBe(154);
  });

  it("主判据：0.9 档 40/46、0.6 档 13/16，无位置偏置", () => {
    const s09 = stats("local09");
    const s06 = stats("local06");
    expect([s09.n, s09.win]).toEqual([46, 40]);
    expect([s09.bySeat("A").n, s09.bySeat("A").win]).toEqual([23, 21]);
    expect([s09.bySeat("B").n, s09.bySeat("B").win]).toEqual([23, 19]);
    expect(s09.firstArmChosen).toBe(0.5);
    expect(s09.agreement.rate).toBeCloseTo(0.826, 3);
    expect([s06.n, s06.win]).toEqual([16, 13]);
    expect(SCORECARD).toContain("40/46 = 87.0%");
    expect(SCORECARD).toContain("13/16 = 81.2%");
  });

  it("辅判据：均分 76.2 → 68.9，逐篇降幅均值 7.4、中位 5.0", () => {
    expect(round1(mean(abs.filter((r) => r.arm === "orig").map((r) => r.score as number)))).toBe(76.2);
    expect(round1(mean(abs.filter((r) => r.arm === "local09").map((r) => r.score as number)))).toBe(68.9);
    expect(round1(mean(drops))).toBe(7.4);
    expect(round1(median(drops))).toBe(5);
    expect(drops.filter((d) => d <= 0)).toHaveLength(7);
    expect(perCase.filter((c) => c.local09 >= 60)).toHaveLength(17);
    expect(SCORECARD).toContain("76.2 → 68.9");
    expect(SCORECARD).toContain("17/23");
  });

  it("双席绝对分 Pearson 0.666 / MAE 11.9，刻度不稳", () => {
    const a = seatPairs.map((p) => p[0]);
    const b = seatPairs.map((p) => p[1]);
    expect(seatPairs).toHaveLength(46);
    expect(pearson(a, b)).toBeCloseTo(0.666, 3);
    expect(round1(mean(a.map((x, i) => Math.abs(x - b[i]))))).toBe(11.9);
    expect(SCORECARD).toContain("Pearson 0.666 / MAE 11.9");
  });

  it("SCORECARD 指向归档证据而不是仓库外的临时目录", () => {
    expect(SCORECARD).toContain("evidence/eval-dual-2026-11-06/");
    expect(SCORECARD).toContain("scripts/eval-dual/");
    expect(SCORECARD).not.toContain("cd /d/projects/_quaiwei-tmp && python -u eval_dual.py");
  });
});
