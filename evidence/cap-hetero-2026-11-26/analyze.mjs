/**
 * _cap-hetero-analyze.mjs —— 能力数字异源双席复核统计
 *
 * 口径与 2026-11-06 归档一致：问「哪段更像 AI」，**改写稿被判更像 AI 的比例越低 ⇒ 改写越有效**。
 *   engineWin = 1 - bWin（bWin = arms-local09 被判更像 AI）
 * 参照基线：同一 23 篇 / 0.9 档、两席都是 glm-5.3-flash 时 engineWin = 40/46 = 87.0%。
 */
import fs from "node:fs";

const BASE = process.env.BASE || "D:/projects/_quaiwei-tmp/cap-hetero-2026-11-26";
const rows = fs
  .readFileSync(`${BASE}/out-node/results.jsonl`, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const clean = rows.filter((r) => r.clean && r.bWin !== null);

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

console.log(`记录 ${rows.length} | 干净票 ${clean.length} | 格式失败 ${rows.filter((r) => !r.clean).length} | 网络错 ${rows.filter((r) => r.err).length}`);

const n = clean.length;
const bWin = clean.filter((r) => r.bWin).length;
const win = n - bWin;
console.log(`\n改写稿被判更像 AI：${bWin}/${n} = ${((bWin / n) * 100).toFixed(1)}%`);
console.log(`⇒ engineWin（改写更不像 AI）：${win}/${n} = ${((win / n) * 100).toFixed(1)}%  p=${binomTwoSided(win, n).toExponential(2)}`);
console.log(`归档基线（GLM 双席）：40/46 = 87.0%（p≈1.55e-07）`);

for (const seat of ["A", "B"]) {
  const rs = clean.filter((r) => r.seat === seat);
  const w = rs.filter((r) => !r.bWin).length;
  console.log(`  ${seat} 席 ${rs[0]?.model ?? "?"}: engineWin ${w}/${rs.length} = ${((w / rs.length) * 100).toFixed(1)}%`);
}
const a = clean.filter((r) => r.seat === "A");
const b = clean.filter((r) => r.seat === "B");
const aw = a.filter((r) => !r.bWin).length;
const bw = b.filter((r) => !r.bWin).length;
console.log(`  两席异质性 Fisher p=${fisher(aw, a.length - aw, bw, b.length - bw).toFixed(4)}`);

const ids = [...new Set(clean.map((r) => r.id))];
let both = 0;
let neither = 0;
let split = 0;
for (const id of ids) {
  const x = clean.find((r) => r.id === id && r.seat === "A");
  const y = clean.find((r) => r.id === id && r.seat === "B");
  if (!x || !y) continue;
  if (!x.bWin && !y.bWin) both++;
  else if (x.bWin && y.bWin) neither++;
  else split++;
}
console.log(`  两席都说改写更像人：${both}/${ids.length} | 两席都说改写更像 AI：${neither}/${ids.length} | 分歧：${split}`);

console.log("\n逐篇（改写被判更像 AI 的票数 / 该篇有效票）：");
for (const id of ids) {
  const vs = clean.filter((r) => r.id === id);
  console.log(`  ${id.padEnd(24)} ${vs.filter((r) => r.bWin).length}/${vs.length}`);
}
