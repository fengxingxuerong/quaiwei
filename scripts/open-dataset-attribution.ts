/**
 * 长文档 aiScore 判反（AUC 0.398）的分项归因（只读，产出报告）。
 *
 * 拆解 DetectRL-ZH dev 长文档(≥742字)里 machine vs human 的 aiScore 各分项差异，
 * 找出「为什么 machine 得分反而低于 human」。分项见 src/engine/humanize-metrics.ts:
 *   score / formulaicHits / burstiness / avgLen / sentenceCount / brokenHits /
 *   structureHits / typoHits
 *
 * 用法：npx tsx scripts/open-dataset-attribution.ts
 * 报告：evidence/open-dataset-detectrl-2026-11-21/attribution-report.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aiScore } from "../src/engine/humanize-metrics";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "artifacts/open-datasets/detectrl-zh-dev.json");
const OUT = path.join(ROOT, "evidence/open-dataset-detectrl-2026-11-21");
fs.mkdirSync(OUT, { recursive: true });

type Item = { text: string; label: number };
const data = JSON.parse(fs.readFileSync(DATA, "utf8")) as Item[];
const visLen = (s: string) => s.replace(/\s/g, "").length;
const lens = data.map((x) => visLen(x.text)).sort((a, b) => a - b);
const q3 = lens[Math.floor(lens.length * 0.75)];

const med = (a: number[]) => {
  const b = [...a].filter(Number.isFinite).sort((x, y) => x - y);
  return b.length ? b[Math.floor(b.length / 2)] : 0;
};
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/** Mann-Whitney AUC，machine=1 得分高于 human=0 的概率 */
function auc(scores: number[], labels: number[]): number {
  const pairs = scores.map((s, i) => ({ s, l: labels[i] })).sort((a, b) => a.s - b.s);
  let rankSum = 0;
  let i = 0;
  while (i < pairs.length) {
    let j = i;
    while (j + 1 < pairs.length && pairs[j + 1].s === pairs[i].s) j++;
    const avgRank = (i + 1 + j + 1) / 2;
    for (let k = i; k <= j; k++) if (pairs[k].l === 1) rankSum += avgRank;
    i = j + 1;
  }
  const n1 = labels.filter((l) => l === 1).length;
  const n0 = labels.length - n1;
  return n1 && n0 ? (rankSum - (n1 * (n1 + 1)) / 2) / (n1 * n0) : 0.5;
}

const longRows = data
  .filter((x) => visLen(x.text) >= q3)
  .map((x) => ({ label: x.label, chars: visLen(x.text), ...aiScore(x.text) }));

const fields = [
  "score",
  "formulaicHits",
  "burstiness",
  "avgLen",
  "sentenceCount",
  "brokenHits",
  "structureHits",
  "typoHits",
] as const;

const breakdown = fields.map((f) => {
  const hv = longRows.filter((r) => r.label === 0).map((r) => (r[f] as number) ?? 0);
  const mv = longRows.filter((r) => r.label === 1).map((r) => (r[f] as number) ?? 0);
  const all = longRows.map((r) => (r[f] as number) ?? 0);
  const labels = longRows.map((r) => r.label);
  return {
    field: f,
    humanMedian: +med(hv).toFixed(3),
    machineMedian: +med(mv).toFixed(3),
    humanMean: +mean(hv).toFixed(3),
    machineMean: +mean(mv).toFixed(3),
    auc: +auc(all, labels).toFixed(3),
  };
});

const report = {
  source: "DetectRL-ZH dev 长文档(≥" + q3 + "字)",
  threshold: q3,
  n: longRows.length,
  human: longRows.filter((r) => r.label === 0).length,
  machine: longRows.filter((r) => r.label === 1).length,
  breakdown,
};
fs.writeFileSync(path.join(OUT, "attribution-report.json"), JSON.stringify(report, null, 2));

console.log("═".repeat(70));
console.log(`长文档(≥${q3}字) aiScore 判反归因  H=${report.human} M=${report.machine}`);
console.log("═".repeat(70));
console.log("字段".padEnd(16) + "H中位".padEnd(10) + "M中位".padEnd(10) + "AUC".padEnd(8) + "方向");
for (const b of breakdown) {
  const dir =
    b.machineMedian > b.humanMedian
      ? "M更高→判AI"
      : b.machineMedian < b.humanMedian
        ? "M更低→判人"
        : "相同";
  console.log(
    b.field.padEnd(16) +
      String(b.humanMedian).padEnd(10) +
      String(b.machineMedian).padEnd(10) +
      String(b.auc).padEnd(8) +
      dir,
  );
}
console.log(`\n报告：${path.join(OUT, "attribution-report.json")}`);
