/**
 * convergence 21 篇全量两臂（含超长文等长截断）——只读，不改产品。
 *
 * 与 build-convergence-arms.ts 的区别：
 *   1. 用 artifacts/human-corpus 全部 21 篇（此前只取前 15）；
 *   2. 超长篇两臂**等长截断**到 MAX_CHARS，避免评委 400 `content exceeds maximum length`。
 *      两臂截同样字数 ⇒ 配对仍公平；被截断篇目写入 manifest 供复核。
 *
 * A 臂 = humanize(0.6, seed 20260905) 默认碎句版
 * B 臂 = 同参数 + convergence:true 收敛版
 * 用法：npx tsx scripts/build-convergence-arms-all.ts
 * 产物：eval-work/ab-convergence-all/{arms-free,arms-converged}/<id>.humanized.txt + manifest.json
 */
import fs from "node:fs";
import path from "node:path";
import { humanize } from "../src/engine/humanize.ts";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "artifacts/human-corpus");
const OUT = path.join(ROOT, "eval-work/ab-convergence-all");
const A = path.join(OUT, "arms-free");
const B = path.join(OUT, "arms-converged");
const CORPUS = path.join(OUT, "corpus");
const MAX_CHARS = 9000; // 两臂各 9000 字，配对 user 消息约 18k 字，低于网关上限
const idxP = process.argv.indexOf("--max-chars");
const MAX = idxP >= 0 ? Number(process.argv[idxP + 1]) || MAX_CHARS : MAX_CHARS;

for (const d of [A, B, CORPUS]) {
  if (fs.existsSync(d)) fs.renameSync(d, `${d}.old-${Date.now()}`);
  fs.mkdirSync(d, { recursive: true });
}

const files = fs.readdirSync(SRC).filter((f) => f.endsWith(".txt")).sort();
const rows: { id: string; chars: number; truncated: boolean; same: boolean }[] = [];
let same = 0;
let truncated = 0;
for (const f of files) {
  const orig = fs.readFileSync(path.join(SRC, f), "utf8");
  const cut = orig.length > MAX;
  const src = cut ? orig.slice(0, MAX) : orig;
  const a = humanize(src, { intensity: 0.6, seed: 20260905 });
  const b = humanize(src, { intensity: 0.6, seed: 20260905, convergence: true });
  if (a === b) same++;
  if (cut) truncated++;
  const id = f.slice(0, -4);
  fs.writeFileSync(path.join(A, `${id}.humanized.txt`), a);
  fs.writeFileSync(path.join(B, `${id}.humanized.txt`), b);
  fs.writeFileSync(path.join(CORPUS, `${id}.txt`), src);
  rows.push({ id, chars: src.length, truncated: cut, same: a === b });
}
fs.writeFileSync(
  path.join(OUT, "manifest.json"),
  JSON.stringify({ maxChars: MAX, total: files.length, same, truncated, rows }, null, 2),
);
console.log(`语料 ${files.length} 篇 | 两臂相同 ${same} | 超长截断 ${truncated} | 上限 ${MAX} 字`);
for (const r of rows)
  console.log(`  ${r.id.padEnd(22)} ${String(r.chars).padStart(5)}字 ${r.truncated ? "TRUNC" : ""} ${r.same ? "SAME" : ""}`);
console.log(`产物：${OUT}`);
