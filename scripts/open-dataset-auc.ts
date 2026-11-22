/**
 * 外部开源数据集检验 aiScore 判别力（只读，产出报告）。
 *
 * 数据集：NLPCC-2025 Task1 / DetectRL-ZH dev.json（GitHub 公开，带人工标签）
 *   来源 https://github.com/NLP2CT/NLPCC-2025-Task1/tree/main/data/dev.json
 *   2800 条：1100 human(label=0) + 1700 machine(label=1)，
 *   machine 由 GPT-4o / GLM-4-flash / Qwen-turbo 生成，领域 ASAP/CNewSum/CSL。
 * 本地副本 artifacts/open-datasets/detectrl-zh-dev.json（gitignore，不入库）。
 *
 * 为什么需要：项目此前只有自建语料 + 自评分 aiScore，缺独立真值。本脚本用公开标注
 * 检验 aiScore 能否分离人写/机写——必须与「真人中位 35、长文分不出」等既有结论对照。
 *
 * 口径：AUC = P(score_machine > score_human)，用 Mann-Whitney U（含 0.5 平局）。
 * 长度分层避免长度混淆（human 中位 457 / machine 中位 615 字）。
 *
 * 用法：npx tsx scripts/open-dataset-auc.ts
 * 报告：evidence/open-dataset-detectrl-2026-11-21/
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

/** Mann-Whitney U 口径的 AUC，平局记 0.5 */
function auc(scores: number[], labels: number[]): number {
  const pairs = scores.map((s, i) => ({ s, l: labels[i] })).sort((a, b) => a.s - b.s);
  let rankSum = 0; // machine(label=1) 的秩和（1-based，平局取平均秩）
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
  if (!n1 || !n0) return 0.5;
  return (rankSum - (n1 * (n1 + 1)) / 2) / (n1 * n0);
}

const med = (a: number[]) => {
  const b = [...a].sort((x, y) => x - y);
  return b[Math.floor(b.length / 2)] ?? 0;
};
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

const scored = data.map((it) => ({
  label: it.label,
  chars: visLen(it.text),
  score: aiScore(it.text).score,
}));

const scores = scored.map((r) => r.score);
const labels = scored.map((r) => r.label);
const machine = scored.filter((r) => r.label === 1);
const human = scored.filter((r) => r.label === 0);

// 长度分层：用全体长度四分位切档（避免按标签分层造成分布泄漏）
const lens = scored.map((r) => r.chars).sort((a, b) => a - b);
const q1 = lens[Math.floor(lens.length * 0.25)];
const q2 = med(lens);
const q3 = lens[Math.floor(lens.length * 0.75)];
const band = (lo: number, hi: number) => scored.filter((r) => r.chars >= lo && r.chars < hi);

const bands = [
  { name: `短(<${q1})`, rows: band(0, q1) },
  { name: `中短(${q1}-${q2})`, rows: band(q1, q2) },
  { name: `中长(${q2}-${q3})`, rows: band(q2, q3) },
  { name: `长(≥${q3})`, rows: band(q3, Infinity) },
].map((b) => ({
  name: b.name,
  n: b.rows.length,
  human: b.rows.filter((r) => r.label === 0).length,
  machine: b.rows.filter((r) => r.label === 1).length,
  medChars: med(b.rows.map((r) => r.chars)),
  auc: +auc(
    b.rows.map((r) => r.score),
    b.rows.map((r) => r.label),
  ).toFixed(3),
  medScoreHuman: med(b.rows.filter((r) => r.label === 0).map((r) => r.score)),
  medScoreMachine: med(b.rows.filter((r) => r.label === 1).map((r) => r.score)),
}));

const report = {
  source: "NLPCC-2025 Task1 / DetectRL-ZH dev.json (github.com/NLP2CT/NLPCC-2025-Task1)",
  n: scored.length,
  human: human.length,
  machine: machine.length,
  auc: +auc(scores, labels).toFixed(4),
  medScoreHuman: med(human.map((r) => r.score)),
  medScoreMachine: med(machine.map((r) => r.score)),
  meanScoreHuman: +mean(human.map((r) => r.score)).toFixed(1),
  meanScoreMachine: +mean(machine.map((r) => r.score)).toFixed(1),
  medCharsHuman: med(human.map((r) => r.chars)),
  medCharsMachine: med(machine.map((r) => r.chars)),
  bands,
  thresholdSweep: [20, 27, 35, 45, 55, 65].map((t) => ({
    threshold: t,
    tpr: +(machine.filter((r) => r.score >= t).length / machine.length).toFixed(3),
    fpr: +(human.filter((r) => r.score >= t).length / human.length).toFixed(3),
  })),
};

fs.writeFileSync(path.join(OUT, "auc-report.json"), JSON.stringify(report, null, 2));

console.log("═".repeat(64));
console.log("DetectRL-ZH dev · aiScore 判别力（外部真值）");
console.log("═".repeat(64));
console.log(`样本 ${report.n}（human ${report.human} / machine ${report.machine}）`);
console.log(`总体 AUC = ${report.auc}`);
console.log(`aiScore 中位：human ${report.medScoreHuman} / machine ${report.medScoreMachine}`);
console.log(`字数中位：human ${report.medCharsHuman} / machine ${report.medCharsMachine}`);
console.log("\n长度分层：");
for (const b of bands) {
  console.log(
    `  ${b.name.padEnd(12)} n=${String(b.n).padStart(4)} H/M=${b.human}/${b.machine} ` +
      `AUC=${b.auc} score中位 H${b.medScoreHuman}/M${b.medScoreMachine}`,
  );
}
console.log("\n阈值扫描（score≥t 判机器）：");
for (const s of report.thresholdSweep) {
  console.log(`  t=${s.threshold}  TPR=${s.tpr}  FPR=${s.fpr}`);
}
console.log(`\n报告：${path.join(OUT, "auc-report.json")}`);
