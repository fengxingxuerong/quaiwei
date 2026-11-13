/**
 * 新增数字守卫回放（v0.9.88）
 *
 * 为什么单开这个脚本：`addedNumericFacts` 的判据是「这个数值在整个原文一次都没出现过」，
 * 它的**误报面**直接决定 `--strict` 会不会把好稿子退回本地引擎——必须实测，不能靠直觉。
 * 2026-11-13 首跑结论：69 组真实产出命中 2 组、假阳性 0（见 `evidence/guard-v0988-2026-11-13/`）。
 *
 * 用法：
 *   npx tsx scripts/guard-replay.ts
 *
 * 语料面（存在哪个跑哪个，不存在的静默跳过）：
 *   · scripts/realcase/out/*.after.txt          —— 本地引擎 23 篇（先跑一次 realcase）
 *   · evidence/eval-api-glm-2026-11-13/arms-*   —— `--api` 单轮两档各 23 篇
 *
 * 注意：`evidence/.../arms-*` 与 `eval-work/arms-api/*` 是同一批产出的两份落盘，
 * 脚本只取 evidence 那份，别把 92 当 92 个独立样本（实际独立样本是 46）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { addedNumericFacts, missingNumericFacts } from "../src/engine/number-fidelity.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const cases = JSON.parse(fs.readFileSync(path.join(HERE, "realcase/cases.json"), "utf8")).cases as {
  id: string;
  text: string;
}[];
const byId = new Map(cases.map((c) => [c.id, c.text]));

interface Surface {
  name: string;
  dir: string;
  /** 产出文件名 → case id */
  idOf: (file: string) => string | null;
}

const SURFACES: Surface[] = [
  {
    name: "本地引擎（realcase 单点，强度 0.9）",
    dir: path.join(HERE, "realcase/out"),
    idOf: (f) => (f.endsWith(".after.txt") ? f.replace(/\.after\.txt$/, "") : null),
  },
  {
    name: "--api 单轮 0.9 档（glm-5.3-flash）",
    dir: path.join(ROOT, "evidence/eval-api-glm-2026-11-13/arms-09"),
    idOf: (f) => (f.endsWith(".humanized.txt") ? f.replace(/\.humanized\.txt$/, "") : null),
  },
  {
    name: "--api 单轮 0.6 档（glm-5.3-flash）",
    dir: path.join(ROOT, "evidence/eval-api-glm-2026-11-13/arms-06"),
    idOf: (f) => (f.endsWith(".humanized.txt") ? f.replace(/\.humanized\.txt$/, "") : null),
  },
];

let totalGroups = 0;
let totalHits = 0;
let skipped = 0;

for (const s of SURFACES) {
  if (!fs.existsSync(s.dir)) {
    console.log(`— 跳过（目录不存在）：${s.name}`);
    skipped++;
    continue;
  }
  const rows: { id: string; added: string[]; missing: string[] }[] = [];
  for (const f of fs.readdirSync(s.dir).sort()) {
    const id = s.idOf(f);
    if (!id) continue;
    const src = byId.get(id);
    if (!src) continue;
    const out = fs.readFileSync(path.join(s.dir, f), "utf8");
    rows.push({ id, added: addedNumericFacts(src, out), missing: missingNumericFacts(src, out) });
  }
  const hits = rows.filter((r) => r.added.length > 0);
  totalGroups += rows.length;
  totalHits += hits.length;
  const rate = rows.length ? ((hits.length / rows.length) * 100).toFixed(1) : "0.0";
  console.log(`\n=== ${s.name} ===`);
  console.log(`组数 ${rows.length}｜有新增数字 ${hits.length}（${rate}%）`);
  for (const r of hits) {
    const miss = r.missing.length ? `  缺失=${r.missing.join("、")}` : "";
    console.log(`  ${r.id}  新增=${r.added.join("、")}${miss}`);
  }
}

console.log(`\n合计 ${totalGroups} 组、命中 ${totalHits} 组。`);
console.log("命中是否真缺陷要人工读产出——判据只回答「原文有没有这个数」。");
if (skipped) console.log(`（${skipped} 个语料面缺失，已跳过）`);
