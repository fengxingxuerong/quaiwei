/**
 * 十篇小说测试 · 指标分析器
 *
 * 输入：artifacts/novel-test-1028/novels/*.md（原文）
 *       artifacts/novel-test-1028/out-deep/ 等产物目录
 * 输出：metrics.json + 控制台 markdown 表
 *
 * 判据全部复用引擎自己的模块（detector / number-fidelity / format-integrity），
 * 不另写一套尺子——否则"测的"和"产品跑的"会悄悄分叉。
 */
import fs from "node:fs";
import path from "node:path";
import { detectAI, splitSentences } from "../../src/engine/detector.ts";
import {
  missingNumericFacts,
  changedUnits,
  numericFacts,
} from "../../src/engine/number-fidelity.ts";
import { formatIssues } from "../../src/engine/format-integrity.ts";
import { collapseIssues, aiScore } from "../../src/engine/humanize-metrics.ts";
import {
  truncationIssues,
  inflationIssues,
  structureIssues,
} from "../../src/api/llm-quality.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const BASE = path.join(ROOT, "artifacts", "novel-test-1028");
const NOVELS = path.join(BASE, "novels");

const visible = (s: string) => s.replace(/\s/g, "").length;
const paras = (s: string) => s.split(/\n{2,}/).filter((p) => p.trim());

function sentences(text: string): string[] {
  return splitSentences(text).map((s) => s.trim()).filter(Boolean);
}

/** 句长变异系数：越低越"节奏平"，检测器把低 CV 当作 AI 特征 */
function lengthCV(ss: string[]): number {
  const lens = ss.map((s) => visible(s));
  if (lens.length < 2) return 0;
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
  const varr = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length;
  return mean > 0 ? Math.sqrt(varr) / mean : 0;
}

const QUOTE_RE = /[「『“"]([^」』”"]{1,40})[」』”"]/g;
function quoted(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(QUOTE_RE)) {
    const v = m[1].trim();
    if (v.length >= 2) out.add(v);
  }
  return [...out];
}

const FIRST_PERSON = /(我|咱|俺)/g;
const countMatches = (text: string, re: RegExp) => (text.match(re) || []).length;

/**
 * 形态违规（口径复制自 src/engine/syntax-integrity.test.ts:67-140——
 * 那里是项目自己钉住"好句子长什么样"的地方，不另发明判据）
 */
const SENTENCE_SPLIT = /(?<=[。！？])/;
const sentencesOf = (t: string) =>
  t
    .split(SENTENCE_SPLIT)
    .map((s) => s.trim())
    .filter(Boolean);
const stripEnd = (s: string) => s.replace(/[。！？…]+$/, "").trim();
const DANGLING_TAIL =
  /(?:但|而|且|并|然而|因此|所以|但是|而且|以及|或者|同时|另外|此外|还有|总之|于是)$/;
const SKELETON_ONLY = new Set([
  "首先",
  "其次",
  "再次",
  "最后",
  "另外",
  "此外",
  "总之",
  "综上",
  "综上所述",
  "总的来说",
  "总的说来",
  "其一",
  "其二",
]);
const ENUM_ONLY = /^[一二三四五六七八九十0-9]{1,3}[、.．)）]?$/;
const LEAD_PUNCT = /^[，、；：]/;

function formProblems(out: string): string[] {
  const bad: string[] = [];
  for (const raw of sentencesOf(out)) {
    const body = stripEnd(raw);
    if (!body) continue;
    if (DANGLING_TAIL.test(body)) bad.push(`句末悬空连接词：${raw}`);
    if (SKELETON_ONLY.has(body)) bad.push(`骨架词独立成句：${raw}`);
    if (ENUM_ONLY.test(body)) bad.push(`枚举标记光杆：${raw}`);
    if (LEAD_PUNCT.test(body)) bad.push(`句首残标点：${raw}`);
  }
  return bad;
}

interface Row {
  id: string;
  variant: string;
  chars: number;
  charsRaw: number;
  paragraphs: number;
  sentences: number;
  avgSentence: number;
  cv: number;
  aiScore: number;
  /** 引擎自带 aiScore 明细（与 detectAI.probability 是两把尺子，别混） */
  scoreNative: number;
  formulaic: number;
  broken: number;
  structHits: number;
  sameRatio: number;
  /** 8 字以下的短句占比（碎句化的直接读数） */
  shortRatio: number;
  /** 每千字句数（切句密度） */
  sentPer1000: number;
  firstPerson: number;
  compression: number | null;
  anchorsKept: string;
  anchorsTotal: number;
  missingNumbers: string[];
  changedUnits: string[];
  quotedKept: string;
  quotedTotal: number;
  formatIssues: number;
  form: string[];
  collapse: string[];
  truncation: string[];
  inflation: string[];
  structure: string[];
  defectTotal: number;
}

function analyzeOne(id: string, variant: string, orig: string, out: string | null): Row {
  const text = out ?? orig;
  const ss = sentences(text);
  const det = detectAI(text);
  const native = aiScore(text);
  const origSentences = new Set(sentences(orig));
  const sameRatio = ss.length
    ? +(ss.filter((s) => origSentences.has(s)).length / ss.length).toFixed(3)
    : 0;
  const origQuotes = quoted(orig);
  const fmt = out ? formatIssues(orig, out) : [];
  const form = formProblems(text);
  const collapse = out ? collapseIssues(orig, out) : [];
  const truncation = out ? truncationIssues(orig, out) : [];
  const inflation = out ? inflationIssues(orig, out) : [];
  const structure = out ? structureIssues(orig, out) : [];
  return {
    id,
    variant,
    chars: visible(text),
    charsRaw: text.length,
    paragraphs: paras(text).length,
    sentences: ss.length,
    avgSentence: ss.length ? +(visible(text) / ss.length).toFixed(1) : 0,
    cv: +lengthCV(ss).toFixed(3),
    aiScore: det.probability,
    scoreNative: native.score,
    formulaic: native.formulaicHits,
    broken: native.brokenHits ?? 0,
    structHits: native.structureHits ?? 0,
    sameRatio,
    shortRatio: ss.length
      ? +(ss.filter((s) => visible(s) <= 8).length / ss.length).toFixed(3)
      : 0,
    sentPer1000: visible(text) ? +((ss.length / visible(text)) * 1000).toFixed(2) : 0,
    firstPerson: countMatches(text, FIRST_PERSON),
    compression: out ? +(visible(text) / visible(orig)).toFixed(3) : null,
    anchorsKept: "",
    anchorsTotal: 0,
    missingNumbers: out ? missingNumericFacts(orig, out) : [],
    changedUnits: out ? changedUnits(orig, out) : [],
    quotedKept: out ? `${origQuotes.filter((q) => text.includes(q)).length}/${origQuotes.length}` : "—",
    quotedTotal: origQuotes.length,
    formatIssues: fmt.length,
    form,
    collapse,
    truncation,
    inflation,
    structure,
    defectTotal:
      form.length + collapse.length + truncation.length + inflation.length + structure.length,
  };
}

/** 保真锚点：只对「原文里真出现过」的锚点计算留存 ——
 *  生成器没照要求写进去的那条，算生成器的账，不算引擎的账 */
function anchorCheck(orig: string, out: string, anchors: string[]) {
  const norm = (s: string) => s.replace(/\s/g, "");
  const present = anchors.filter((a) => orig.includes(a) || norm(orig).includes(norm(a)));
  const hit = present.filter((a) => out.includes(a) || norm(out).includes(norm(a)));
  return { hit, present, missingInOrig: anchors.filter((a) => !present.includes(a)) };
}

const metaPath = path.join(BASE, "meta.json");
const specs = JSON.parse(fs.readFileSync(path.join(BASE, "specs.json"), "utf8")) as Record<
  string,
  { genre: string; anchors: string[] }
>;
/** meta.json 由生成器收尾时写；生成器还在跑时退回直接扫 novels/ 目录 */
const meta = fs.existsSync(metaPath)
  ? JSON.parse(fs.readFileSync(metaPath, "utf8"))
  : {
      novels: fs
        .readdirSync(NOVELS)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => {
          const id = f.slice(0, 3);
          const text = fs.readFileSync(path.join(NOVELS, f), "utf8");
          return {
            id,
            genre: specs[id]?.genre ?? "",
            anchors: specs[id]?.anchors ?? [],
            file: `artifacts/novel-test-1028/novels/${f}`,
            chars: visible(text),
          };
        }),
    };
const variants: { name: string; dir: string; suffix: string }[] = [
  { name: "local06", dir: path.join(BASE, "out-local06"), suffix: ".humanized" },
  { name: "local09", dir: path.join(BASE, "out-local09"), suffix: ".humanized" },
  { name: "deep", dir: path.join(BASE, "out-deep"), suffix: ".humanized" },
];

const rows: Row[] = [];
const anchorRows: Record<string, Record<string, string>> = {};

for (const n of meta.novels) {
  const origPath = path.join(ROOT, n.file);
  const orig = fs.readFileSync(origPath, "utf8");
  rows.push(analyzeOne(n.id, "orig", orig, null));
  anchorRows[n.id] = {};
  for (const v of variants) {
    const base = path.basename(origPath, path.extname(origPath));
    // CLI 的 --out-format follow 把 .md 进料落成 .txt，两种后缀都找
    const cands = [".md", ".txt"].map((ext) => path.join(v.dir, base + v.suffix + ext));
    const cand = cands.find((p) => fs.existsSync(p));
    if (!cand) continue;
    const out = fs.readFileSync(cand, "utf8");
    const row = analyzeOne(n.id, v.name, orig, out);
    const ac = anchorCheck(orig, out, n.anchors);
    row.anchorsKept = `${ac.hit.length}/${ac.present.length}`;
    row.anchorsTotal = ac.present.length;
    anchorRows[n.id][v.name] =
      ac.hit.length === ac.present.length
        ? `全中(${ac.present.length})`
        : `丢 ${ac.present.filter((a) => !ac.hit.includes(a)).join("、")}` +
          (ac.missingInOrig.length ? `｜原文没写：${ac.missingInOrig.join("、")}` : "");
    rows.push(row);
  }
}

const result = {
  ts: new Date().toISOString(),
  engineVersion: JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version,
  novels: meta.novels.length,
  totalChars: meta.novels.reduce((a: number, n: { chars: number }) => a + n.chars, 0),
  rows,
  anchors: anchorRows,
};
fs.writeFileSync(path.join(BASE, "metrics.json"), JSON.stringify(result, null, 2), "utf8");

/* ------------------------------- 打印表 ------------------------------- */
const byVariant = (v: string) => rows.filter((r) => r.variant === v);
const avg = (xs: number[]) => (xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : 0);

console.log(`\n语料：${meta.novels.length} 篇 / ${result.totalChars} 字`);
console.log(
  "\n| 路线 | 篇数 | 字数比 | 代理分(detectAI) | aiScore | 套话命中 | 坏替身 | 句式损伤 | 句长CV | 每千字句数 | ≤8字短句 | 原句原样 | 丢数字 | 改单位 | 格式缺陷 | 形态违规 |",
);
console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
for (const v of ["orig", "local06", "local09", "deep"]) {
  const rs = byVariant(v);
  if (!rs.length) continue;
  const comp = rs.map((r) => r.compression).filter((x): x is number => x !== null);
  console.log(
    `| ${v} | ${rs.length} | ${comp.length ? (avg(comp) * 100).toFixed(0) + "%" : "—"} | ${avg(rs.map((r) => r.aiScore))} | ${avg(rs.map((r) => r.scoreNative))} | ${avg(rs.map((r) => r.formulaic))} | ${rs.reduce((a, r) => a + r.broken, 0)} | ${rs.reduce((a, r) => a + r.structHits, 0)} | ${avg(rs.map((r) => r.cv))} | ${avg(rs.map((r) => r.sentPer1000))} | ${(avg(rs.map((r) => r.shortRatio)) * 100).toFixed(0)}% | ${(avg(rs.map((r) => r.sameRatio)) * 100).toFixed(0)}% | ${rs.reduce((a, r) => a + r.missingNumbers.length, 0)} | ${rs.reduce((a, r) => a + r.changedUnits.length, 0)} | ${rs.reduce((a, r) => a + r.formatIssues, 0)} | ${rs.reduce((a, r) => a + r.defectTotal, 0)} |`,
  );
}

console.log("\n锚点保真（每篇 5 条具体数字/专名）：");
for (const [id, v] of Object.entries(anchorRows)) {
  const left = JSON.stringify(v);
  console.log(`  ${id}: ${left}`);
}
console.log("\n指标已写入 artifacts/novel-test-1028/metrics.json");
