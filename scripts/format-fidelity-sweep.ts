/**
 * 格式保真扫查（v0.9.81）
 *
 * 目的：把 `defect-taxonomy.ts` 里 **「格式损坏」** 这一类从「几条形态正则」
 * 升级成**结构不变式**的批量实验。判据本体在 `src/engine/format-integrity.ts`
 * （那里也有 23 条判据的自检与 17 段格式密集语料），本文件只负责**跑批 + 落盘**。
 *
 * 两条管线分开记账，**门禁只管用户路径**：
 *
 *   · `humanize()`      —— 产品路径（Web/桌面端、CLI、DSH 插件都走它）⇒ **硬门禁**；
 *   · `mechanicalShuffle()` —— 机械扰动公开入口，**没有接任何已发布路径**
 *     （CLI / index.js / .dsh 里都没有调用点），且它的编排层整篇跑
 *     `splitSentences + join("")`，与结构保真是根本冲突的——已知边界，
 *     这里只**报告**，不让它把门禁染红（登记见 docs/format-fidelity-2026-10-26.md）。
 *
 * 用法：
 *   npx tsx scripts/format-fidelity-sweep.ts             # 全量：17 语料 × 4 档 × 30 种子 × 2 管线
 *   npx tsx scripts/format-fidelity-sweep.ts --quick     # 5 种子（改代码时用）
 *   npx tsx scripts/format-fidelity-sweep.ts --selftest  # 只跑判据自检（反向对照）
 * 退出码：**humanize 侧**违规 > 0 → 1；否则 0。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { humanize, mechanicalShuffle } from "../src/engine/humanize.ts";
import { FORMAT_CORPUS, formatIssues, selftestDead, SELFTEST_CASES } from "../src/engine/format-integrity.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const QUICK = args.includes("--quick");
const SEEDS = Array.from({ length: QUICK ? 5 : 30 }, (_, i) => i);
const INTENSITIES = [0.3, 0.6, 0.9, 1.0] as const;

interface Hit {
  rule: string;
  label: string;
  pipe: string;
  intensity: number;
  seed: number;
  detail: string;
  input?: string;
  output?: string;
}

if (args.includes("--selftest")) {
  const dead = selftestDead();
  console.log(
    dead.length
      ? `❌ ${dead.length}/${SELFTEST_CASES.length} 条判据是永真式：\n  ${dead.join("\n  ")}`
      : `✅ ${SELFTEST_CASES.length} 条判据全部能被坏样本触发`,
  );
  process.exit(dead.length ? 1 : 0);
}

const hits: Hit[] = [];
let runs = 0;

for (const [label, text] of FORMAT_CORPUS) {
  for (const intensity of INTENSITIES) {
    for (const seed of SEEDS) {
      for (const [pipe, out] of [
        ["humanize", humanize(text, { intensity, seed })],
        ["shuffle", mechanicalShuffle(text, { intensity, seed })],
      ] as const) {
        runs++;
        for (const i of formatIssues(text, out)) {
          hits.push({ rule: i.rule, label, pipe, intensity, seed, detail: i.detail, input: text, output: out });
        }
      }
    }
  }
}

const OUTDIR = path.join(ROOT, "artifacts", "format-fidelity");
fs.mkdirSync(OUTDIR, { recursive: true });
fs.writeFileSync(path.join(OUTDIR, "hits.json"), JSON.stringify(hits, null, 2), "utf8");

const report = (pipe: string): number => {
  const rows = hits.filter((h) => h.pipe === pipe);
  const byRule = new Map<string, number>();
  for (const h of rows) byRule.set(h.rule, (byRule.get(h.rule) ?? 0) + 1);
  console.log(`\n—— ${pipe}（${rows.length} 处）——`);
  if (rows.length === 0) {
    console.log("✅ 全部结构不变式成立");
    return 0;
  }
  console.log("| 判据 | 命中 | 首个样本 |");
  console.log("|---|---|---|");
  for (const [rule, n] of Array.from(byRule.entries()).sort((a, b) => b[1] - a[1])) {
    const first = rows.find((h) => h.rule === rule)!;
    console.log(
      `| ${rule} | ${n} | ${first.label} / i${first.intensity} / s${first.seed}：${first.detail} |`,
    );
  }
  return rows.length;
};

console.log(
  `[format-sweep] ${FORMAT_CORPUS.length} 语料 × ${INTENSITIES.length} 档 × ${SEEDS.length} 种子 × 2 管线 = ${runs} 次运行`,
);
const humanizeHits = report("humanize");
const shuffleHits = report("shuffle");

if (shuffleHits > 0) {
  console.log(
    `\nℹ️ 机械扰动入口 ${shuffleHits} 处属**已知边界**（未接产品路径），不计入门禁；` +
      `样本与根因见 docs/format-fidelity-2026-10-26.md`,
  );
}
console.log(`\n样本落盘：${path.join(OUTDIR, "hits.json")}（含完整 input/output）`);
process.exit(humanizeHits > 0 ? 1 : 0);