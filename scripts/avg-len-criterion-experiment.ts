/**
 * aiScore 的 avgLen 项候选修正实验（只读，**不改产品代码/默认行为**）。
 *
 * 背景：DetectRL-ZH dev 长文档 AUC 0.398 判反，归因主因是 avgLen（AUC 0.202）：
 * 现公式 `clamp((avgLen-25)/40)*25`（长句=AI）在该数据集长文上失效——机写反而句短。
 *
 * 本脚本复现 aiScore 公式，只替换 avgLen 一项做候选对比，其余分项原样：
 *   A baseline : clamp((avg-25)/40)*25
 *   B norm     : 以文本自身句长中位为锚，偏离度打分（相对而非绝对 25）
 *   C capped   : 长文档（>600字）把 avgLen 项权重减半（承认长文句长信号不稳）
 *   D inverted : 反方向：短句=AI（检验「碎句=机写」假设在该集是否成立）
 *
 * 双集验证：自建语料（探索，human-corpus/ai-corpus-long）与 DetectRL-ZH dev（验证，
 * 只算不调）。任何候选只有在两集都不劣化才值得提上线，且必须双席 A/B。
 *
 * 用法：npx tsx scripts/avg-len-criterion-experiment.ts
 * 报告：evidence/optimization-experiments-2026-11-21/avg-len-criterion.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aiScore } from "../src/engine/humanize-metrics";
import { sentenceStats } from "../src/engine/humanize-primitives";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "evidence/optimization-experiments-2026-11-21");
fs.mkdirSync(OUT, { recursive: true });

type Row = { text: string; label: number; id: string };
const readDir = (d: string, label: number): Row[] =>
  fs
    .readdirSync(path.join(ROOT, d))
    .filter((f) => f.endsWith(".txt"))
    .map((f) => ({ id: f, text: fs.readFileSync(path.join(ROOT, d, f), "utf8"), label }));

// 探索集：自建语料（human 长/短 + AI 长）
const local = [
  ...readDir("artifacts/human-corpus", 0),
  ...readDir("artifacts/human-corpus-short", 0),
  ...readDir("artifacts/ai-corpus-long", 1),
];
// 验证集：DetectRL-ZH dev（只读评测，不调参）
const detectrl = (
  JSON.parse(
    fs.readFileSync(path.join(ROOT, "artifacts/open-datasets/detectrl-zh-dev.json"), "utf8"),
  ) as { text: string; label: number }[]
).map((x, i) => ({ ...x, id: `d${i}` }));

const visLen = (s: string) => s.replace(/\s/g, "").length;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const baselineAvg = (avg: number) => clamp01((avg - 25) / 40) * 25;

/** 候选 avgLen 项，输入文本统计与 aiScore 已有分项 */
function avgTerm(text: string, variant: string): number {
  const st = sentenceStats(text);
  const avg = st.avg;
  const chars = visLen(text);
  switch (variant) {
    case "baseline":
      return baselineAvg(avg);
    case "norm": {
      // 相对锚：偏离文本自身中位句长的程度。sentenceStats 无 median，用 cv 反推不稳定，
      // 这里用 avg 与 std 的比值近似「系统性偏长」：avg 大而 cv 小 = 均匀长句更可疑。
      const uniformity = clamp01(1 - st.cv / 0.8);
      return clamp01((avg - 25) / 40) * 25 * (0.5 + 0.5 * uniformity);
    }
    case "capped": {
      const w = chars > 600 ? 0.5 : 1;
      return baselineAvg(avg) * w;
    }
    case "inverted":
      // 短句=AI：avg 越小分越高（检验碎句假设）
      return clamp01((40 - avg) / 30) * 25;
    default:
      return baselineAvg(avg);
  }
}

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

const variants = ["baseline", "norm", "capped", "inverted"];

function evalSet(rows: Row[], variant: string) {
  const scores = rows.map((r) => {
    const base = aiScore(r.text);
    // 复现 aiScore 其它分项之和 = score - baselineAvg项（四舍五入前）
    const st = sentenceStats(r.text);
    if (st.count === 0) return base.score;
    const other = base.score - Math.round(baselineAvg(st.avg));
    return Math.max(0, Math.min(100, other + Math.round(avgTerm(r.text, variant))));
  });
  const labels = rows.map((r) => r.label);
  const overall = auc(scores, labels);
  const longRows = rows
    .map((r, i) => ({ ...r, s: scores[i], c: visLen(r.text) }))
    .filter((r) => r.c >= 600);
  const long = auc(
    longRows.map((r) => r.s),
    longRows.map((r) => r.label),
  );
  return { overall: +overall.toFixed(4), long: +long.toFixed(4), longN: longRows.length };
}

const result: Record<string, Record<string, unknown>> = {};
for (const ds of [
  { name: "local(探索)", rows: local },
  { name: "DetectRL-ZH(验证)", rows: detectrl },
]) {
  result[ds.name] = {};
  for (const v of variants) {
    (result[ds.name] as Record<string, unknown>)[v] = evalSet(ds.rows, v);
  }
}

fs.writeFileSync(path.join(OUT, "avg-len-criterion.json"), JSON.stringify(result, null, 2));
console.log("═".repeat(70));
console.log("aiScore avgLen 项候选实验（只读，不改产品默认）");
console.log("═".repeat(70));
for (const [ds, variants] of Object.entries(result)) {
  console.log(`\n${ds}:`);
  for (const [v, r] of Object.entries(
    variants as Record<string, { overall: number; long: number; longN: number }>,
  )) {
    console.log(`  ${v.padEnd(10)} 总体AUC=${r.overall}  长文AUC=${r.long} (n=${r.longN})`);
  }
}
console.log(`\n报告：${path.join(OUT, "avg-len-criterion.json")}`);
