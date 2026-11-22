/**
 * 改写是否让人/机更难分？—— 外部真值下的直接检验（只读，产出报告）。
 *
 * 对 DetectRL-ZH dev 的 machine 样本跑本地引擎改写，重算 aiScore 对 human 的 AUC：
 *   改写前 AUC（baseline，见 open-dataset-auc.ts）= P(score_machine > score_human)
 *   改写后 AUC = P(score_machine_rewritten > score_human)
 * 若工具真让人/机更难分，AUC 应从 0.575 向 0.5 收敛（或更低=判反）。
 *
 * 这比「aiScore 降幅」更有意义：降分只说明引擎按自己判据在动，AUC 才是外部真值下的可分性。
 *
 * 用法：npx tsx scripts/open-dataset-auc-after.ts
 * 报告：evidence/open-dataset-detectrl-2026-11-21/auc-after-report.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { humanize } from "../src/engine/humanize";
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

const human = data.filter((x) => x.label === 0);
const humanScores = human.map((x) => aiScore(x.text).score);
const humanLabels = human.map(() => 0);

// machine 样本：全量改写成本高（1700 篇 × 多次），取分层样本 300 篇求稳
const machine = data.filter((x) => x.label === 1).sort((a, b) => visLen(a.text) - visLen(b.text));
const stride = Math.max(1, Math.floor(machine.length / 300));
const sample = machine.filter((_, i) => i % stride === 0).slice(0, 300);
const SELECT_INTENSITY = 0.9;
const SEEDS = [42, 1, 7];

const beforeScores = sample.map((x) => aiScore(x.text).score);
const aucBefore = auc([...beforeScores, ...humanScores], [...sample.map(() => 1), ...humanLabels]);

// 长文档子集
const sampleLong = sample.filter((x) => visLen(x.text) >= q3);
const humanLong = human.filter((x) => visLen(x.text) >= q3);
const beforeLong = sampleLong.map((x) => aiScore(x.text).score);
const humanLongScores = humanLong.map((x) => aiScore(x.text).score);
const aucBeforeLong = auc(
  [...beforeLong, ...humanLongScores],
  [...sampleLong.map(() => 1), ...humanLong.map(() => 0)],
);

// 改写后：每个 seed 算一次 AUC，取中位，避免单 seed 偶然
const afterBySeed: { seed: number; aucAll: number; aucLong: number }[] = [];
for (const seed of SEEDS) {
  const rewritten = sample.map((x) =>
    humanize(x.text, { intensity: SELECT_INTENSITY, seed, style: "plain" }),
  );
  const afterScores = rewritten.map((x) => aiScore(x).score);
  const a = auc([...afterScores, ...humanScores], [...sample.map(() => 1), ...humanLabels]);

  const rewrittenLong = sampleLong.map((x) =>
    humanize(x.text, { intensity: SELECT_INTENSITY, seed, style: "plain" }),
  );
  const afterLong = rewrittenLong.map((x) => aiScore(x).score);
  const al = auc(
    [...afterLong, ...humanLongScores],
    [...sampleLong.map(() => 1), ...humanLong.map(() => 0)],
  );
  afterBySeed.push({ seed, aucAll: +a.toFixed(4), aucLong: +al.toFixed(4) });
}
const med = (a: number[]) => {
  const b = [...a].sort((x, y) => x - y);
  return b[Math.floor(b.length / 2)];
};

const report = {
  source: "DetectRL-ZH dev · machine 样本本地引擎改写",
  humanN: human.length,
  machineSampleN: sample.length,
  longThreshold: q3,
  longSampleN: sampleLong.length,
  longHumanN: humanLong.length,
  intensity: SELECT_INTENSITY,
  aucBefore: +aucBefore.toFixed(4),
  aucAfterMedian: +med(afterBySeed.map((r) => r.aucAll)).toFixed(4),
  aucBeforeLong: +aucBeforeLong.toFixed(4),
  aucAfterLongMedian: +med(afterBySeed.map((r) => r.aucLong)).toFixed(4),
  afterBySeed,
  interpretation: "AUC 越接近 0.5 = 人机越难分（工具越有效）；<0.5 = 判反",
};
fs.writeFileSync(path.join(OUT, "auc-after-report.json"), JSON.stringify(report, null, 2));

console.log("═".repeat(66));
console.log("改写是否让人/机更难分？（外部真值 AUC，越接近 0.5 越难分）");
console.log("═".repeat(66));
console.log(`样本 machine ${sample.length} / human ${human.length} · 强度 ${SELECT_INTENSITY}`);
console.log(`  全体   AUC ${report.aucBefore} → ${report.aucAfterMedian}（3 seed 中位）`);
console.log(`  长文档 AUC ${report.aucBeforeLong} → ${report.aucAfterLongMedian}（阈值≥${q3}字）`);
console.log("逐 seed：");
for (const r of afterBySeed) {
  console.log(`  seed ${r.seed}: 全体 ${r.aucAll} / 长文 ${r.aucLong}`);
}
const delta = report.aucAfterMedian - report.aucBefore;
const direction =
  Math.abs(report.aucAfterMedian - 0.5) < 0.03
    ? "改写后与真人几乎不可分（理想：真更像人）"
    : report.aucAfterMedian < 0.5
      ? "改写稿 aiScore 低于真人——骗过判据/判到另一侧，|AUC−0.5| 仍说明可分，不能声称更像人"
      : "改写稿 aiScore 高于真人——更可分，反效果";
console.log(`\n全体 AUC 变化 ${delta >= 0 ? "+" : ""}${delta.toFixed(4)} ⇒ ${direction}`);
console.log(
  "口径提醒：AUC 越接近 0.5 才越「人机难分」；远离 0.5（无论正反）都说明 aiScore 仍能分开两者，" +
    "只是方向不同。降分 ≠ 更像人。",
);
console.log(`报告：${path.join(OUT, "auc-after-report.json")}`);
