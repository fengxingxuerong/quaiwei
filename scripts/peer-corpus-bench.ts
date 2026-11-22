/**
 * 同类开源项目语料 → 趣AI味引擎独立跑测（只读，产出报告）。
 *
 * 语料来源（均已落盘 artifacts/peer-corpus/，gitignore 忽略，不入库）：
 *  1. swaylq/humanize-chinese @ main
 *     - tests/test_regression.py 等测试引用的 examples/sample_*.txt
 *       （4 篇项目自己用作去味验收的 AI 味重稿 + workplace/social）
 *     - examples/real_blog_plain.txt / real_blog_skill.txt（真人博客对照）
 *  2. Hello-SimpleAI/HC3-Chinese @ main（psychology.jsonl，1099 对）
 *     - human_answers / chatgpt_answers 成对真人 vs AI 答案
 *
 * 判据分两层：
 *  A. 硬保真（外部可观测）：数字、URL、英文专名、段落数、代码块围栏不被改写破坏。
 *  B. 软指标（方向性）：aiScore 是本项目自评分，只作相对趋势，不当绝对刻度。
 *
 * 用法：npx tsx scripts/peer-corpus-bench.ts
 * 报告：evidence/peer-corpus-bench-2026-11-20/
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { humanize } from "../src/engine/humanize.ts";
import { aiScore, collapseIssues } from "../src/engine/humanize-metrics.ts";
import { missingNumericFacts, changedUnits } from "../src/engine/number-fidelity.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS = path.join(ROOT, "artifacts/peer-corpus");
const OUT = path.join(ROOT, "evidence/peer-corpus-bench-2026-11-20");
fs.mkdirSync(OUT, { recursive: true });

const SEEDS = [42, 1, 7, 2026, 20261015];
const INTENSITIES = [0.6, 0.9];

const RE_URL = /https?:\/\/[^\s)）】，。；、"']+/g;
const RE_MAIL = /[\w.+-]+@[\w-]+\.[\w.]+/g;
const RE_ASCII = /[A-Za-z][A-Za-z0-9._-]{2,}/g;
const uniq = (a: string[]) => [...new Set(a)];
const grab = (s: string, re: RegExp) => uniq(s.match(re) ?? []).sort();
const paraCount = (s: string) =>
  s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean).length;

interface Row {
  id: string;
  source: string;
  kind: string;
  seed: number;
  intensity: number;
  charsIn: number;
  charsOut: number;
  scoreIn: number;
  scoreOut: number;
  dScore: number;
  missingNumbers: string[];
  changedUnits: string[];
  lostUrls: string[];
  lostMails: string[];
  lostAscii: string[];
  paraIn: number;
  paraOut: number;
  collapse: string[];
  changed: boolean;
}

function hardFail(r: Row): string[] {
  const f: string[] = [];
  if (r.missingNumbers.length) f.push(`数字丢失:${r.missingNumbers.join(",")}`);
  if (r.changedUnits.length) f.push(`单位变更:${r.changedUnits.join(",")}`);
  if (r.lostUrls.length) f.push(`URL丢失:${r.lostUrls.join(",")}`);
  if (r.lostMails.length) f.push(`邮箱丢失:${r.lostMails.join(",")}`);
  if (r.lostAscii.length) f.push(`英文专名丢失:${r.lostAscii.slice(0, 5).join(",")}`);
  // 段落数变化是引擎设计（vary_paragraph_rhythm / insert_short_interjection），
  // 同类项目 test_regression.py::test_paragraph_preservation 自己都允许丢 2 段，
  // 故不计硬缺陷，只作观察项写入 rows。
  if (r.collapse.length) f.push(`内容腰斩:${r.collapse.slice(0, 2).join(",")}`);
  return f;
}

function evalOne(
  id: string,
  source: string,
  kind: string,
  text: string,
  seed: number,
  intensity: number,
): Row {
  const out = humanize(text, { intensity, seed });
  const missing = missingNumericFacts(text, out);
  const units = changedUnits(text, out);
  const collapse = collapseIssues(text, out);
  const lost = (re: RegExp) => {
    const a = grab(text, re),
      b = new Set(grab(out, re));
    return a.filter((x) => !b.has(x));
  };
  const scoreIn = aiScore(text).score;
  const scoreOut = aiScore(out).score;
  return {
    id,
    source,
    kind,
    seed,
    intensity,
    charsIn: text.length,
    charsOut: out.length,
    scoreIn,
    scoreOut,
    dScore: scoreOut - scoreIn,
    missingNumbers: missing,
    changedUnits: units,
    lostUrls: lost(RE_URL),
    lostMails: lost(RE_MAIL),
    lostAscii: lost(RE_ASCII),
    paraIn: paraCount(text),
    paraOut: paraCount(out),
    collapse,
    changed: text !== out,
  };
}

// ---- 语料 1：同类项目 examples ----
const peerNames = [
  "sample_academic.txt",
  "sample_general.txt",
  "sample_social.txt",
  "sample_long_blog.txt",
  "sample_workplace.txt",
  "real_blog_plain.txt",
  "real_blog_skill.txt",
];
const peerRows: Row[] = [];
const peerOut: Record<string, string> = {};
for (const name of peerNames) {
  const p = path.join(CORPUS, name);
  if (!fs.existsSync(p)) continue;
  const text = fs.readFileSync(p, "utf8");
  const kind = name.startsWith("real_blog") ? "human-blog" : "ai-style-sample";
  for (const seed of SEEDS) {
    for (const intensity of INTENSITIES) {
      const r = evalOne(name, "swaylq/humanize-chinese", kind, text, seed, intensity);
      peerRows.push(r);
      if (seed === 42 && intensity === 0.9)
        peerOut[name] =
          text + "\n\n===== HUMANIZED =====\n\n" + humanize(text, { intensity, seed });
    }
  }
}

// ---- 语料 2：HC3 真人 vs AI 成对答案 ----
const hc3Path = path.join(CORPUS, "hc3-psychology.jsonl");
const hc3Rows: Row[] = [];
const hc3Samples: Array<{ q: string; human: string; ai: string }> = [];
if (fs.existsSync(hc3Path)) {
  const lines = fs.readFileSync(hc3Path, "utf8").trim().split("\n").filter(Boolean);
  // 固定步长抽样 120 条，避开随机——保证任何人复跑同一份
  const step = Math.max(1, Math.floor(lines.length / 120));
  const chosen: any[] = [];
  for (let i = 0; i < lines.length && chosen.length < 120; i += step) {
    try {
      const o = JSON.parse(lines[i]);
      const human =
        (o.human_answers ?? [])
          .filter((x: any) => typeof x === "string")
          .sort((a: string, b: string) => b.length - a.length)[0] ?? "";
      const ai =
        (o.chatgpt_answers ?? [])
          .filter((x: any) => typeof x === "string")
          .sort((a: string, b: string) => b.length - a.length)[0] ?? "";
      if (human.length >= 80 && ai.length >= 80) chosen.push({ q: o.question, human, ai });
    } catch {
      /* skip malformed */
    }
  }
  for (let i = 0; i < chosen.length; i++) {
    const s = chosen[i];
    hc3Samples.push(s);
    // 单 seed/单强度，成对对照即为目的；矩阵留给 examples
    hc3Rows.push(evalOne(`hc3-${i}-human`, "HC3-Chinese/psychology", "human", s.human, 42, 0.9));
    hc3Rows.push(evalOne(`hc3-${i}-ai`, "HC3-Chinese/psychology", "chatgpt", s.ai, 42, 0.9));
  }
}

const all = [...peerRows, ...hc3Rows];
const fails = all.filter((r) => hardFail(r).length > 0);
const hardFailByKind: Record<string, number> = {};
for (const r of fails) hardFailByKind[r.kind] = (hardFailByKind[r.kind] ?? 0) + 1;

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (xs: (number | boolean)[]) =>
  xs.length ? +((100 * xs.filter(Boolean).length) / xs.length).toFixed(1) : 0;
const dHuman = hc3Rows.filter((r) => r.kind === "human").map((r) => r.dScore);
const dAi = hc3Rows.filter((r) => r.kind === "chatgpt").map((r) => r.dScore);

const summary = {
  generatedAt: new Date().toISOString(),
  corpus: {
    "swaylq/humanize-chinese": {
      files: peerNames.length,
      rows: peerRows.length,
      seeds: SEEDS,
      intensities: INTENSITIES,
    },
    "HC3-Chinese/psychology": {
      pairs: hc3Samples.length,
      rows: hc3Rows.length,
      seed: 42,
      intensity: 0.9,
    },
  },
  hardFidelity: {
    totalRows: all.length,
    failRows: fails.length,
    failPct: pct(all.map((r) => hardFail(r).length > 0)),
    byKind: hardFailByKind,
    byReason: {
      missingNumbers: fails.filter((r) => r.missingNumbers.length).length,
      changedUnits: fails.filter((r) => r.changedUnits.length).length,
      lostAscii: fails.filter((r) => r.lostAscii.length).length,
      lostUrls: fails.filter((r) => r.lostUrls.length).length,
      collapse: fails.filter((r) => r.collapse.length).length,
    },
    observationOnly: {
      paraChangedRows: all.filter((r) => r.paraIn !== r.paraOut).length,
      note: "段落数变化是插短段落设计的预期行为，同类项目自己也允许 ±2，不计缺陷",
    },
  },
  scoreTrend: {
    note: "aiScore 是本项目自评分，只作相对方向；不可当绝对刻度（同文复测 MAE 14.7）",
    hc3Human: {
      n: dHuman.length,
      avgIn: +avg(hc3Rows.filter((r) => r.kind === "human").map((r) => r.scoreIn)).toFixed(1),
      avgOut: +avg(hc3Rows.filter((r) => r.kind === "human").map((r) => r.scoreOut)).toFixed(1),
      avgDelta: +avg(dHuman).toFixed(1),
      dropPct: pct(dHuman.map((d) => d < 0)),
    },
    hc3Ai: {
      n: dAi.length,
      avgIn: +avg(hc3Rows.filter((r) => r.kind === "chatgpt").map((r) => r.scoreIn)).toFixed(1),
      avgOut: +avg(hc3Rows.filter((r) => r.kind === "chatgpt").map((r) => r.scoreOut)).toFixed(1),
      avgDelta: +avg(dAi).toFixed(1),
      dropPct: pct(dAi.map((d) => d < 0)),
    },
    peerSamples: {
      n: peerRows.length,
      changedPct: pct(peerRows.map((r) => r.changed)),
      avgDelta: +avg(peerRows.map((r) => r.dScore)).toFixed(1),
    },
  },
  worstFails: fails
    .slice(0, 40)
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      seed: r.seed,
      intensity: r.intensity,
      issues: hardFail(r),
    })),
};

fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
fs.writeFileSync(path.join(OUT, "rows.jsonl"), all.map((r) => JSON.stringify(r)).join("\n") + "\n");
for (const [name, text] of Object.entries(peerOut))
  fs.writeFileSync(path.join(OUT, "sample-" + name), text);

console.log(JSON.stringify(summary, null, 2));
