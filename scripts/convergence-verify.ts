/**
 * 结构目标收敛 · A/B 复现脚本（只读，不接门禁）
 *
 * 对同一批真人长文分别跑「关闭收敛」(A 臂 / 旧行为) 与「默认收敛」(B 臂)，
 * 用 `--metrics` 同一口径的 `structureMetrics` 输出三项结构指标，
 * 并逐字校验「收敛只改标点」。
 *
 * 语料不入库：默认读 `artifacts/human-corpus/*.txt`（21 篇真人维基，本机自备），
 * 也可用 `--corpus <dir>` 指向别的目录（例如 15 篇各截 2500 字的长文语料）。
 *
 * 用法：
 *   npx tsx scripts/convergence-verify.ts
 *   npx tsx scripts/convergence-verify.ts --corpus D:/.../corpus --out D:/.../report.json
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { humanize } from "../src/engine/humanize.ts";
import { structureMetrics } from "../src/engine/structure-metrics.ts";
import { convergeSentenceDensity } from "../src/engine/structure-convergence.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const CORPUS = arg("--corpus") ?? path.join(ROOT, "artifacts/human-corpus");
const OUT = arg("--out");
const INTENSITY = 0.6;
const SEED = 20260905;

const strip = (t: string): string => t.replace(/[，。！？!?]/g, "");
const round = (n: number): number => Math.round(n * 100) / 100;

interface Row {
  file: string;
  chars: number;
  aPeriodPerK: number;
  bPeriodPerK: number;
  aSentLen: number;
  bSentLen: number;
  aCommasPerSentence: number;
  bCommasPerSentence: number;
  targetPerK: number;
  restored: number;
  candidates: number;
  fidelityOk: boolean;
}

const files = readdirSync(CORPUS)
  .filter((f) => f.endsWith(".txt") && !f.endsWith(".humanized.txt"))
  .sort();
if (files.length === 0) {
  console.error(`语料目录为空：${CORPUS}`);
  process.exit(1);
}

const rows: Row[] = [];
for (const f of files) {
  const orig = readFileSync(path.join(CORPUS, f), "utf8");
  // A 臂 = 产品默认（收敛关，实验前行为）；B 臂 = 显式开启实验性收敛
  const A = humanize(orig, { intensity: INTENSITY, seed: SEED });
  const B = humanize(orig, { intensity: INTENSITY, seed: SEED, convergence: true });
  const r = convergeSentenceDensity(orig, A);
  const a = structureMetrics(A);
  const b = structureMetrics(B);
  rows.push({
    file: f,
    chars: b.chars,
    aPeriodPerK: a.periodPerKChar,
    bPeriodPerK: b.periodPerKChar,
    aSentLen: a.sentLen.mean,
    bSentLen: b.sentLen.mean,
    aCommasPerSentence: a.commasPerSentence,
    bCommasPerSentence: b.commasPerSentence,
    targetPerK: round(r.targetCount / (b.chars / 1000 || 1)),
    restored: r.restored,
    candidates: r.candidates,
    // 收敛只改标点 ⇒ 去标点后与 A 臂逐字相同，且 B 臂就是收敛函数的输出
    fidelityOk: strip(A) === strip(B) && B === r.text,
  });
}

const mean = (pick: (r: Row) => number): number =>
  round(rows.reduce((s, r) => s + pick(r), 0) / rows.length);

const summary = {
  corpus: CORPUS,
  files: rows.length,
  intensity: INTENSITY,
  seed: SEED,
  a: {
    periodPerK: mean((r) => r.aPeriodPerK),
    sentLen: mean((r) => r.aSentLen),
    commasPerSentence: mean((r) => r.aCommasPerSentence),
  },
  b: {
    periodPerK: mean((r) => r.bPeriodPerK),
    sentLen: mean((r) => r.bSentLen),
    commasPerSentence: mean((r) => r.bCommasPerSentence),
  },
  restored: rows.reduce((s, r) => s + r.restored, 0),
  candidates: rows.reduce((s, r) => s + r.candidates, 0),
  fidelityFailures: rows.filter((r) => !r.fidelityOk).length,
  targetMet: mean((r) => r.bPeriodPerK) <= 25,
  rows,
};

console.log(`\n语料 ${summary.files} 篇 · intensity ${INTENSITY} · seed ${SEED}`);
console.log("文件".padEnd(34) + "  A句号  B句号   目标   还原/候选   保真");
for (const r of rows) {
  console.log(
    r.file.padEnd(34) +
      `  ${r.aPeriodPerK.toFixed(2).padStart(6)}  ${r.bPeriodPerK.toFixed(2).padStart(6)}` +
      `  ${r.targetPerK.toFixed(2).padStart(5)}` +
      `   ${String(r.restored).padStart(3)}/${String(r.candidates).padStart(3)}` +
      `      ${r.fidelityOk ? "✓" : "✗"}`,
  );
}
console.log("\n均值            句号/千字   句长均值   逗号/句");
console.log(
  `A 臂（收敛前）     ${summary.a.periodPerK.toFixed(2).padStart(8)}   ${summary.a.sentLen.toFixed(2).padStart(8)}   ${summary.a.commasPerSentence.toFixed(2).padStart(7)}`,
);
console.log(
  `B 臂（收敛后）     ${summary.b.periodPerK.toFixed(2).padStart(8)}   ${summary.b.sentLen.toFixed(2).padStart(8)}   ${summary.b.commasPerSentence.toFixed(2).padStart(7)}`,
);
console.log(
  `\n还原 ${summary.restored} / 候选 ${summary.candidates} · 保真失败 ${summary.fidelityFailures}/${summary.files}` +
    ` · 均值达标(≤25/千字) ${summary.targetMet ? "是" : "否"}\n`,
);

if (OUT) {
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(summary, null, 2) + "\n", "utf8");
  console.log(`报告：${OUT}`);
}
