/**
 * 外部开源数据集上的改写前后对比（只读，产出报告）。
 *
 * 从 DetectRL-ZH dev 取 machine(label=1) 样本，按长度分层抽样，跑**本地引擎**改写，
 * 看 aiScore 降幅 + 数字/英文专名/URL 保真。与自建 realcase 23 篇形成独立对照。
 *
 * 为什么只用本地引擎：外部数据集的存储/网络不稳定，LLM 批量改写 45min 且不可复现；
 * 本地引擎确定性（seed 固定）可多 seed 扫，适合检验「引擎判据在外部语料上是否成立」。
 * aiScore 是项目自评分，只作相对趋势；外部真值的判别力见 open-dataset-auc.ts。
 *
 * 用法：npx tsx scripts/open-dataset-rewrite.ts
 * 报告：evidence/open-dataset-detectrl-2026-11-21/rewrite-report.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { humanize } from "../src/engine/humanize";
import { aiScore } from "../src/engine/humanize-metrics";
import { missingNumericFacts, changedUnits } from "../src/engine/number-fidelity";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "artifacts/open-datasets/detectrl-zh-dev.json");
const OUT = path.join(ROOT, "evidence/open-dataset-detectrl-2026-11-21");
fs.mkdirSync(OUT, { recursive: true });

type Item = { text: string; label: number };
const data = JSON.parse(fs.readFileSync(DATA, "utf8")) as Item[];
const machine = data.filter((x) => x.label === 1);
const visLen = (s: string) => s.replace(/\s/g, "").length;
const med = (a: number[]) => {
  const b = [...a].sort((x, y) => x - y);
  return b[Math.floor(b.length / 2)] ?? 0;
};
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const grab = (s: string, re: RegExp) => [...new Set(s.match(re) ?? [])].sort();
const RE_URL = /https?:\/\/[^\s)）】，。；、"']+/g;
const RE_ASCII = /[A-Za-z][A-Za-z0-9._-]{2,}/g;

// 按长度分层，每层取中位附近 8 篇（避开极端，稳定可比）
const sorted = [...machine].sort((a, b) => visLen(a.text) - visLen(b.text));
const q1 = Math.floor(sorted.length * 0.25);
const q2 = Math.floor(sorted.length * 0.5);
const q3 = Math.floor(sorted.length * 0.75);
const sample = [
  ...sorted.slice(q1, q1 + 8),
  ...sorted.slice(q2, q2 + 8),
  ...sorted.slice(q3, q3 + 8),
];

const SEEDS = [42, 1, 7];
const INTENSITY = 0.9;
const rows: {
  id: string;
  chars: number;
  seed: number;
  scoreIn: number;
  scoreOut: number;
  delta: number;
  missingNums: string[];
  changedUnits: string[];
  lostUrls: string[];
  lostAscii: string[];
}[] = [];

for (let i = 0; i < sample.length; i++) {
  const text = sample[i].text;
  const chars = visLen(text);
  for (const seed of SEEDS) {
    const out = humanize(text, { intensity: INTENSITY, seed, style: "plain" });
    const sIn = aiScore(text).score;
    const sOut = aiScore(out).score;
    rows.push({
      id: `m${i}-${chars}字`,
      chars,
      seed,
      scoreIn: sIn,
      scoreOut: sOut,
      delta: +(sOut - sIn).toFixed(1),
      missingNums: missingNumericFacts(text, out),
      changedUnits: changedUnits(text, out),
      lostUrls: grab(text, RE_URL).filter((u) => !out.includes(u)),
      lostAscii: grab(text, RE_ASCII)
        .filter((w) => !out.includes(w))
        .slice(0, 5),
    });
  }
}

const deltas = rows.map((r) => r.delta);
const hard = rows.filter(
  (r) => r.missingNums.length || r.changedUnits.length || r.lostUrls.length || r.lostAscii.length,
);
const report = {
  source: "NLPCC-2025 Task1 / DetectRL-ZH dev.json (machine label=1)",
  nSamples: sample.length,
  nRuns: rows.length,
  seeds: SEEDS,
  intensity: INTENSITY,
  charsRange: [
    Math.min(...sample.map((s) => visLen(s.text))),
    Math.max(...sample.map((s) => visLen(s.text))),
  ],
  scoreInMedian: med(rows.map((r) => r.scoreIn)),
  scoreOutMedian: med(rows.map((r) => r.scoreOut)),
  deltaMean: +mean(deltas).toFixed(2),
  deltaMedian: +med(deltas).toFixed(2),
  dropPct: +((deltas.filter((d) => d < 0).length / deltas.length) * 100).toFixed(1),
  hardFailRuns: hard.length,
  hardFailPct: +((hard.length / rows.length) * 100).toFixed(1),
  hardFailSamples: hard.slice(0, 5).map((r) => ({
    id: r.id,
    seed: r.seed,
    missingNums: r.missingNums,
    lostAscii: r.lostAscii,
  })),
  rows,
};
fs.writeFileSync(path.join(OUT, "rewrite-report.json"), JSON.stringify(report, null, 2));

console.log("═".repeat(64));
console.log("DetectRL-ZH machine 样本 · 本地引擎改写前后（外部语料独立对照）");
console.log("═".repeat(64));
console.log(`样本 ${report.nSamples} 篇 × ${SEEDS.length} seed = ${report.nRuns} 次改写`);
console.log(`字数范围 ${report.charsRange.join("~")}`);
console.log(`aiScore 中位 ${report.scoreInMedian} → ${report.scoreOutMedian}`);
console.log(
  `降幅 均值 ${report.deltaMean} / 中位 ${report.deltaMedian}；下降篇占比 ${report.dropPct}%`,
);
console.log(`硬保真失败 ${report.hardFailRuns}/${report.nRuns} = ${report.hardFailPct}%`);
if (hard.length) {
  console.log("失败样本（前 5）：");
  for (const h of report.hardFailSamples) {
    console.log(
      `  ${h.id} s${h.seed} 数字丢=${h.missingNums.join(",")} 英文丢=${h.lostAscii.join(",")}`,
    );
  }
}
console.log(`\n报告：${path.join(OUT, "rewrite-report.json")}`);
