/**
 * 碎句化骗分约束实验（只读，**不改产品默认**）。
 *
 * 问题：外部真值检验发现，本地引擎改写后 aiScore 0.615→0.297（判反）。
 * 归因：引擎碎句化 → aiScore 奖励短句 → 分大降，但这是「骗分」不是「更像人」。
 *
 * 候选约束：限制改写后的句数增幅（碎句化代理指标）。分档看：
 *   - 低碎句增幅（sentenceCount 增幅 ≤ 10%）的改写稿，aiScore 还能降多少？
 *   - 这类「克制改写」的可分性 AUC 是否比无约束改写更接近 0.5？
 *
 * 若「克制改写」仍能显著降分、且 AUC 更接近 0.5，才值得提上线（且须双席 A/B）。
 * 否则证明「降分全靠碎句骗」，应放弃这条路。
 *
 * 用法：npx tsx scripts/fragment-guard-experiment.ts
 * 报告：evidence/optimization-experiments-2026-11-21/fragment-guard.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { humanize } from "../src/engine/humanize";
import { aiScore } from "../src/engine/humanize-metrics";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "evidence/optimization-experiments-2026-11-21");
fs.mkdirSync(OUT, { recursive: true });

type Item = { text: string; label: number };
const data = JSON.parse(
  fs.readFileSync(path.join(ROOT, "artifacts/open-datasets/detectrl-zh-dev.json"), "utf8"),
) as Item[];
const machine = data.filter((x) => x.label === 1);
const human = data.filter((x) => x.label === 0);
const stride = Math.max(1, Math.floor(machine.length / 300));
const sample = machine.filter((_, i) => i % stride === 0).slice(0, 300);
const SEEDS = [42, 1, 7];

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

const humanScores = human.map((x) => aiScore(x.text).score);
const humanLabels = human.map(() => 0);

// 收集所有改写结果（3 seed），带句数增幅
const attempts = sample.flatMap((x) => {
  const before = aiScore(x.text);
  return SEEDS.map((seed) => {
    const out = humanize(x.text, { intensity: 0.9, seed, style: "plain" });
    const after = aiScore(out);
    const sentGrowth =
      (after.sentenceCount - before.sentenceCount) / Math.max(1, before.sentenceCount);
    return { out, before: before.score, after: after.score, sentGrowth, seed };
  });
});

/** 对给定句数增幅上限，取每篇满足约束的改写（任 seed 满足即可），算降幅与 AUC */
function evalGuard(maxGrowth: number) {
  const picked: number[] = [];
  let covered = 0;
  for (let i = 0; i < sample.length; i++) {
    const opts = attempts.filter(
      (_, k) => Math.floor(k / SEEDS.length) === i && attempts[k].sentGrowth <= maxGrowth,
    );
    if (opts.length) {
      // 该篇有满足约束的改写：取 aiScore 最低的（引擎会挑最低分稿）
      picked.push(Math.min(...opts.map((o) => o.after)));
      covered++;
    } else {
      // 无满足约束的改写：保守回退原文（不改）
      picked.push(aiScore(sample[i].text).score);
    }
  }
  const before = sample.map((x) => aiScore(x.text).score);
  const a = auc([...picked, ...humanScores], [...sample.map(() => 1), ...humanLabels]);
  const meanDrop = picked.reduce((sum, s, i) => sum + (s - before[i]), 0) / picked.length;
  return {
    maxGrowth,
    label: maxGrowth === Infinity ? "无约束" : `≤${Math.round(maxGrowth * 100)}%`,
    covered: +(covered / sample.length).toFixed(3),
    auc: +a.toFixed(4),
    meanDelta: +meanDrop.toFixed(2),
  };
}

const guards = [Infinity, 0.5, 0.25, 0.1, 0].map((g) => evalGuard(g));
const baseline = auc(
  [...sample.map((x) => aiScore(x.text).score), ...humanScores],
  [...sample.map(() => 1), ...humanLabels],
);

const report = {
  source: "DetectRL-ZH dev machine 样本本地引擎改写（碎句约束实验）",
  sampleN: sample.length,
  seeds: SEEDS,
  baselineAuc: +baseline.toFixed(4),
  guards,
  verdictNote: "若严格约束(≤0.1)仍显著降分且 AUC 更接近 0.5，才值得提上线；否则证明降分全靠碎句骗",
};
fs.writeFileSync(path.join(OUT, "fragment-guard.json"), JSON.stringify(report, null, 2));

console.log("═".repeat(70));
console.log("碎句化骗分约束实验（句数增幅上限）");
console.log("═".repeat(70));
console.log(`样本 ${sample.length} 篇 × ${SEEDS.length} seed；改写前 AUC=${report.baselineAuc}`);
console.log("句数增幅上限".padEnd(16) + "覆盖率".padEnd(10) + "改写后AUC".padEnd(12) + "均分变化");
for (const g of guards) {
  console.log(
    g.label.padEnd(16) +
      String(g.covered).padEnd(10) +
      String(g.auc).padEnd(12) +
      String(g.meanDelta),
  );
}
console.log(`\n报告：${path.join(OUT, "fragment-guard.json")}`);
