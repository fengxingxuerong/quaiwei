/**
 * _split-cap-ab-analyze.mjs —— 碎句约束 A/B 统计
 *
 * 口径：
 *   bWin=true ⇒ 该票认为「受限版（arms-capped）」更像 AI ⇒ 对切句约束**不利**
 *   仅统计 clean=true（STRICT 纯甲/乙）的票；两臂逐字节相同的对已在对子组装阶段剔除
 *   H 组 / A 组分别统计（两者偏置方向相反，不可合并定论）
 */
import fs from "node:fs";

const BASE = process.env.BASE || "D:/projects/_quaiwei-tmp/split-cap-ab-2026-11-26";
const rows = fs
  .readFileSync(`${BASE}/out-node/results.jsonl`, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const clean = rows.filter((r) => r.clean && r.bWin !== null);
const errs = rows.filter((r) => r.err);
const fmtFail = rows.filter((r) => !r.err && !r.clean);

/** 精确二项双尾检验 */
function binomTwoSided(k, n, p = 0.5) {
  if (n === 0) return 1;
  const logC = (n, k) => {
    let s = 0;
    for (let i = 1; i <= k; i++) s += Math.log(n - i + 1) - Math.log(i);
    return s;
  };
  const pmf = (i) => Math.exp(logC(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  const obs = pmf(k);
  let s = 0;
  for (let i = 0; i <= n; i++) if (pmf(i) <= obs * (1 + 1e-9)) s += pmf(i);
  return Math.min(1, s);
}

/** Fisher 精确检验（2×2 异质性） */
function fisher(a, b, c, d) {
  const logFact = (n) => {
    let s = 0;
    for (let i = 2; i <= n; i++) s += Math.log(i);
    return s;
  };
  const lc = (n, k) => (k < 0 || k > n ? -Infinity : logFact(n) - logFact(k) - logFact(n - k));
  const n = a + b + c + d;
  const row1 = a + b;
  const col1 = a + c;
  const obs = lc(row1, a) + lc(n - row1, col1 - a) - lc(n, col1);
  let s = 0;
  for (let x = Math.max(0, col1 - (n - row1)); x <= Math.min(row1, col1); x++) {
    const p = Math.exp(lc(row1, x) + lc(n - row1, col1 - x) - lc(n, col1));
    if (p <= Math.exp(obs) * (1 + 1e-9)) s += p;
  }
  return Math.min(1, s);
}

const groupOf = (id) => (id.startsWith("H-") ? "H" : "A");

function report(label, rs) {
  const n = rs.length;
  const bWins = rs.filter((r) => r.bWin).length;
  console.log(
    `\n${label}: ${bWins}/${n} = ${(n ? ((bWins / n) * 100).toFixed(1) : "0")}% 判「受限版更像 AI」` +
      `  p=${binomTwoSided(bWins, n).toExponential(2)}`,
  );
  const ids = [...new Set(rs.map((r) => r.id))];
  let bothCapped = 0;
  let bothEngine = 0;
  let split = 0;
  for (const id of ids) {
    const a = rs.find((r) => r.id === id && r.seat === "A");
    const b = rs.find((r) => r.id === id && r.seat === "B");
    if (!a || !b) continue;
    if (a.bWin && b.bWin) bothCapped++;
    else if (!a.bWin && !b.bWin) bothEngine++;
    else split++;
  }
  console.log(`  两席都说受限版更像 AI: ${bothCapped}/${ids.length} | 两席都说引擎版更像 AI: ${bothEngine}/${ids.length} | 分歧: ${split}`);
  const seatA = rs.filter((r) => r.seat === "A");
  const seatB = rs.filter((r) => r.seat === "B");
  const fa = seatA.filter((r) => r.bWin).length;
  const fb = seatB.filter((r) => r.bWin).length;
  console.log(`  A 席 ${fa}/${seatA.length}  |  B 席 ${fb}/${seatB.length}  |  Fisher p=${fisher(fa, seatA.length - fa, fb, seatB.length - fb).toFixed(4)}`);
  return { ids, bothCapped, bothEngine, split, bWins, n };
}

console.log(`总记录 ${rows.length} | 干净票 ${clean.length} | HTTP/网络错 ${errs.length} | 格式失败 ${fmtFail.length}`);
if (errs.length) console.log("错误样本:", errs.slice(0, 3).map((e) => `${e.id}/${e.seat}: ${e.err}`).join(" | "));

const H = report("H 组（人写语料，偏置偏向受限版）", clean.filter((r) => groupOf(r.id) === "H"));
const A = report("A 组（AI 稿，偏置偏向引擎版）", clean.filter((r) => groupOf(r.id) === "A"));
report("合并（仅参考，偏置方向不同不可定论）", clean);

// 逐对明细
console.log("\n逐对（b=受限版被判更像 AI 的票数 / 2）：");
for (const id of [...new Set(clean.map((r) => r.id))]) {
  const vs = clean.filter((r) => r.id === id);
  console.log(`  ${id.padEnd(28)} ${vs.filter((r) => r.bWin).length}/${vs.length}`);
}
