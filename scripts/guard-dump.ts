/**
 * 引擎产出盲compare用 dump（v0.9.88）
 *
 * 用途：验证「切句守卫改动的影响面」——改前/改后各跑一遍同一批语料，
 * 再逐文件 diff。只有目标缺陷那一处变化，才算"窄"。
 *
 * 用法（配合 git stash 做 A/B）：
 *   npx tsx scripts/guard-dump.ts /tmp/after-new
 *   git stash push -- src/engine/humanize-primitives.ts
 *   npx tsx scripts/guard-dump.ts /tmp/after-old
 *   git stash pop
 *   diff -rq /tmp/after-new /tmp/after-old
 *
 * 2026-11-13 首跑：21 篇真人维基长文只有 1 篇 1 处变化，正是 C 类悬空状语
 * （`…相比。有更高速度` → `…相比，有更高速度`）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { humanize } from "../src/engine/humanize.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const outDir = process.argv[2];
if (!outDir) {
  console.error("用法：npx tsx scripts/guard-dump.ts <outDir>");
  process.exit(2);
}
const corpus = path.join(ROOT, "artifacts/human-corpus");
if (!fs.existsSync(corpus)) {
  console.error(`语料目录不存在：${corpus}（artifacts/human-corpus 是 gitignored 的本地语料）`);
  process.exit(2);
}

fs.mkdirSync(outDir, { recursive: true });
let n = 0;
for (const f of fs.readdirSync(corpus)) {
  if (!f.endsWith(".txt")) continue;
  const text = fs.readFileSync(path.join(corpus, f), "utf8");
  fs.writeFileSync(
    path.join(outDir, f),
    humanize(text, { intensity: 0.9, seed: 20261113 }),
    "utf8",
  );
  n++;
}
console.log(`已 dump ${n} 篇 → ${outDir}（seed 20261113 / intensity 0.9）`);
