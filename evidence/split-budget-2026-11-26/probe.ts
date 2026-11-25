/**
 * _split-ratio-probe.ts —— 量「引擎把句子切多了多少倍」（碎句约束立项前的基线测量）
 * 临时脚本（scripts/_*.ts 已 gitignore），只读语料 + 调 humanize()，不写产品文件。
 *
 * 口径：
 *   n_in  = 输入按 splitSentences 切出的句数
 *   n_out = 输出按 splitSentences 切出的句数
 *   ratio = n_out / n_in                     ← 主指标：切句倍数
 *   period= 每千字句末标点数（。！？）
 *   avgLen= 去标点纯字数 / 句数
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { humanize } from "../../src/engine/humanize.ts";
import { splitSentences } from "../../src/engine/humanize-text.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const OUT = "D:/projects/_quaiwei-tmp/split-budget-2026-11-26";

const pure = (s: string) => s.replace(/[\s。！？!?…—\-，、；：""''「」（）《》【】]/g, "");

function stats(text: string) {
  const sents = splitSentences(text).map((s) => s.trim()).filter(Boolean);
  const chars = pure(text).length;
  const periods = (text.match(/[。！？!?]/g) ?? []).length;
  const pureLen = sents.reduce((a, s) => a + pure(s).length, 0);
  return {
    n: sents.length,
    chars,
    periodPer1k: chars > 0 ? (periods / chars) * 1000 : 0,
    avgLen: sents.length > 0 ? pureLen / sents.length : 0,
  };
}

interface Row {
  id: string;
  src: "realcase" | "human-corpus";
  chars: number;
  nIn: number;
  nOut: number;
  ratio: number;
  periodIn: number;
  periodOut: number;
  avgIn: number;
  avgOut: number;
}

const rows: Row[] = [];

// 1) realcase 23 篇
const CASES = (
  JSON.parse(readFileSync(path.join(ROOT, "scripts/realcase/cases.json"), "utf8")) as {
    cases: { id: string; text: string }[];
  }
).cases;
for (const c of CASES) {
  const a = stats(c.text);
  let out = c.text;
  try {
    out = humanize(c.text, { intensity: 0.9, seed: 20261015 });
  } catch (e) {
    console.error(`! ${c.id} humanize 抛错：${(e as Error).message}`);
  }
  const b = stats(out);
  rows.push({
    id: c.id,
    src: "realcase",
    chars: a.chars,
    nIn: a.n,
    nOut: b.n,
    ratio: a.n > 0 ? b.n / a.n : 0,
    periodIn: a.periodPer1k,
    periodOut: b.periodPer1k,
    avgIn: a.avgLen,
    avgOut: b.avgLen,
  });
}

// 2) 人写语料（前 12 篇，够看方向）
const CORPUS = path.join(ROOT, "artifacts/human-corpus");
let picked = 0;
for (const f of readdirSync(CORPUS).sort()) {
  if (picked >= 12) break;
  if (!f.endsWith(".txt") || f.startsWith("_")) continue;
  const raw = readFileSync(path.join(CORPUS, f), "utf8");
  const i = raw.indexOf("\n\n");
  const text = (i >= 0 ? raw.slice(i + 2) : raw).trim();
  if (text.length < 400) continue;
  const a = stats(text);
  let out = text;
  try {
    out = humanize(text, { intensity: 0.9, seed: 20261015 });
  } catch (e) {
    console.error(`! ${f} humanize 抛错：${(e as Error).message}`);
  }
  const b = stats(out);
  rows.push({
    id: f,
    src: "human-corpus",
    chars: a.chars,
    nIn: a.n,
    nOut: b.n,
    ratio: a.n > 0 ? b.n / a.n : 0,
    periodIn: a.periodPer1k,
    periodOut: b.periodPer1k,
    avgIn: a.avgLen,
    avgOut: b.avgLen,
  });
  picked++;
}

const med = (xs: number[]) => {
  const s = [...xs].sort((x, y) => x - y);
  return s.length === 0 ? 0 : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const f2 = (n: number) => n.toFixed(2);

mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, "baseline.json"), JSON.stringify({ at: new Date().toISOString(), rows }, null, 2) + "\n", "utf8");

const hdr = ["id", "chars", "nIn", "nOut", "ratio", "periodIn", "periodOut", "avgIn", "avgOut"];
console.log(hdr.join("\t"));
for (const r of rows) {
  console.log(
    [r.id.slice(0, 34), r.chars, r.nIn, r.nOut, f2(r.ratio), f2(r.periodIn), f2(r.periodOut), f2(r.avgIn), f2(r.avgOut)].join("\t"),
  );
}
console.log("\n=== 汇总（中位 / 均值 / 最大）===");
for (const g of ["realcase", "human-corpus"] as const) {
  const gs = rows.filter((r) => r.src === g);
  const ratios = gs.map((r) => r.ratio);
  console.log(
    `${g} (n=${gs.length})  ratio 中位 ${f2(med(ratios))} 均值 ${f2(ratios.reduce((a, b) => a + b, 0) / ratios.length)} 最大 ${f2(Math.max(...ratios))}` +
      ` | avgLen ${f2(med(gs.map((r) => r.avgIn)))}→${f2(med(gs.map((r) => r.avgOut)))}` +
      ` | 句/千字 ${f2((med(gs.map((r) => r.periodIn)) / 1000) * 1000)}→${f2(med(gs.map((r) => r.periodOut)))}`,
  );
}
console.log(`\n输出：${OUT}/baseline.json`);
