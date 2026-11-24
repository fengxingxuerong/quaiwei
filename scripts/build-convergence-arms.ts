/** 临时：为 convergence 换评委复验生成两臂（不改产品）。 A=默认碎句版 B=convergence:true 收敛版。 */
import fs from "node:fs";
import path from "node:path";
import { humanize } from "../src/engine/humanize.ts";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "artifacts/human-corpus");
const OUT = path.join(ROOT, "eval-work/ab-convergence");
const A = path.join(OUT, "arms-free");
const B = path.join(OUT, "arms-converged");
for (const d of [A, B]) {
  if (fs.existsSync(d)) fs.renameSync(d, `${d}.old-${Date.now()}`);
  fs.mkdirSync(d, { recursive: true });
}
const files = fs
  .readdirSync(SRC)
  .filter((f) => f.endsWith(".txt"))
  .sort()
  .slice(0, 15);
let same = 0;
for (const f of files) {
  const orig = fs.readFileSync(path.join(SRC, f), "utf8");
  const a = humanize(orig, { intensity: 0.6, seed: 20260905 });
  const b = humanize(orig, { intensity: 0.6, seed: 20260905, convergence: true });
  if (a === b) same++;
  const id = f.slice(0, -4);
  fs.writeFileSync(path.join(A, `${id}.humanized.txt`), a);
  fs.writeFileSync(path.join(B, `${id}.humanized.txt`), b);
}
console.log(`语料 ${files.length} 篇，两臂逐字节相同 ${same} 篇`);
console.log(files.join("\n"));
console.log(`产物：${OUT}`);
