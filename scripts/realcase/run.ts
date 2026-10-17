/**
 * 真实案例端到端跑测（v0.9.46）
 *
 * 为什么单开这个文件：项目自带的 scan-bugs 跑的是**模板语料**（v5.2/v6.0 合成句 + 多强度多种子），
 * 历史上每次拿真实稿件试一轮都能抓出模板没盖住的缺陷。本轮目标是反过来——用真实形态的输入，
 * 先看**客观不变量**（丢内容 / 结构坏 / 标点烂 / 占位泄漏），再看人味效果。
 *
 * 判据分两层，故意分开：
 *   A. 硬缺陷（不可辩驳）：URL/邮箱/数字/英文专名/代码行丢失、引号不配对、段落数变化、
 *      长度失控、占位符残留、黑话泄漏。这些不需要语言直觉，机器说了算。
 *   B. 软缺陷（必须人读）：通顺度、语义是否走样。脚本只负责把 before/after 落盘方便逐篇看。
 *
 * 用法：
 *   npx tsx scripts/realcase/run.ts                      单点（intensity 0.9 / seed 20261015）
 *   npx tsx scripts/realcase/run.ts --matrix             矩阵（5 seed × 2 强度 = 每篇 10 组）
 *   npx tsx scripts/realcase/run.ts --matrix --seeds=1,42 --intensities=0.9,0.7
 *   npx tsx scripts/realcase/run.ts --only C3-tech-popular    单篇调试（两种模式都支持）
 *
 * 为什么要矩阵：单点跑一遍等于抽奖——是否替换取决于 rng 落点 + 强度档，
 * 主力用例在 1.0 绿而产品默认 0.9 档漏是常态（见 docs/realcase-findings-2026-10-15.md）。
 * 矩阵模式下同一缺陷在多组重复出现只报一条，并标注命中组数——偶发与稳定要能分开看。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { humanize } from "../../src/engine/humanize.ts";
import { aiScore } from "../../src/engine/humanize-metrics.ts";
import { LEAK_WORDS } from "../verify-quality.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "out");
const OUT_MATRIX = path.join(OUT, "matrix");

const argOf = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  if (i >= 0) return process.argv[i + 1];
  // 同时支持 --seeds=1,42 与 --seeds 1,42 两种写法（等号形式更常用）
  const pref = `${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : undefined;
};

const ONLY = argOf("--only");
const MATRIX = process.argv.includes("--matrix");

/** `--seeds=1,42` → [1,42]；未给时取默认值 */
function numList(flag: string, dflt: number[], label: string): number[] {
  const raw = argOf(flag);
  if (!raw) return dflt;
  return raw.split(",").map((s) => {
    const n = Number(s.trim());
    if (!Number.isFinite(n)) throw new Error(`${label} 非数字：${s}`);
    if (label === "强度" && (n <= 0 || n > 1)) throw new Error(`强度越界（0,1]：${s}`);
    return n;
  });
}

// 单点默认 = 历史基线（20261015 / 0.9），矩阵默认额外扩到 5 seed × 2 档
const SEEDS = numList("--seeds", MATRIX ? [20261015, 1, 7, 42, 2026] : [20261015], "种子");
const INTENSITIES = numList("--intensities", MATRIX ? [0.9, 1.0] : [0.9], "强度");
const RUNS = SEEDS.length * INTENSITIES.length;
if (MATRIX && RUNS < 2) {
  throw new Error(`--matrix 至少要 2 组组合，当前只有 ${RUNS} 组（检查 --seeds / --intensities）`);
}

interface Case {
  id: string;
  title: string;
  text: string;
}
const cases: Case[] = JSON.parse(fs.readFileSync(path.join(HERE, "cases.json"), "utf8")).cases;
fs.mkdirSync(OUT, { recursive: true });

const uniq = (a: string[]) => [...new Set(a)];
const grab = (s: string, re: RegExp) => uniq(s.match(re) ?? []);

const RE_URL = /https?:\/\/[^\s)）】，。；、"']+/g;
const RE_MAIL = /[\w.+-]+@[\w-]+\.[\w.]+/g;
const RE_NUM = /\d+(?:\.\d+)?%?/g;
const RE_ASCII_WORD = /[A-Za-z][A-Za-z0-9._-]{2,}/g;

/** 代码/纯符号行：汉字占比极低且有一定长度——这类行一旦被"润色"就是事故 */
function codeLines(s: string): string[] {
  return s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => {
      if (l.length < 8) return false;
      const han = (l.match(/[\u4e00-\u9fa5]/g) ?? []).length;
      return han / l.length < 0.2;
    });
}

function paraCount(s: string): number {
  return s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean).length;
}

interface Finding {
  level: "HARD" | "SOFT";
  kind: string;
  detail: string;
}

function check(before: string, after: string): Finding[] {
  const F: Finding[] = [];
  const push = (level: Finding["level"], kind: string, detail: string) =>
    F.push({ level, kind, detail });

  // 1. URL / 邮箱不得丢（丢了就是"把原文事实改没了"）
  for (const u of grab(before, RE_URL)) {
    if (!after.includes(u)) push("HARD", "URL 丢失", u);
  }
  for (const m of grab(before, RE_MAIL)) {
    if (!after.includes(m)) push("HARD", "邮箱丢失", m);
  }

  // 2. 数字不得丢。改数字是 LLM 才有的余地，本地引擎绝不能动
  const numsBefore = grab(before, RE_NUM);
  const numsAfter = grab(after, RE_NUM);
  const lostNums = numsBefore.filter((n) => !numsAfter.includes(n));
  if (lostNums.length) push("HARD", "数字丢失", lostNums.slice(0, 6).join(" / "));

  // 3. 英文专名（含版本号 / 型号）丢失
  const wordsBefore = grab(before, RE_ASCII_WORD);
  const lostWords = wordsBefore.filter((w) => !after.includes(w));
  if (lostWords.length) push("HARD", "英文专名丢失", lostWords.slice(0, 8).join(" / "));

  // 4. 代码块 / 纯符号行必须原样保留
  for (const line of codeLines(before)) {
    if (!after.includes(line)) push("HARD", "代码行丢失/被改写", line.slice(0, 60));
  }

  // 5. 引号配对（中文成对引号 + 直引号）
  for (const [open, close, name] of [
    ["“", "”", "中文弯引号"],
    ["「", "」", "日式引号"],
    ['"', '"', "直引号"],
  ] as const) {
    const o = (after.split(open).length - 1) as number;
    const c = (after.split(close).length - 1) as number;
    if (o !== c) push("HARD", `${name}不配对`, `开 ${o} / 闭 ${c}`);
  }

  // 6. 段落数（写一篇文章的人最直观的感受：结构被压扁/被炸开）
  const pb = paraCount(before);
  const pa = paraCount(after);
  if (pb !== pa) push("SOFT", "段落数变化", `${pb} → ${pa}`);

  // 7. 长度失控
  const ratio = after.length / Math.max(1, before.length);
  if (ratio > 1.3) push("HARD", "长度膨胀", `${(ratio * 100).toFixed(0)}%`);
  else if (ratio < 0.7) push("HARD", "长度塌缩", `${(ratio * 100).toFixed(0)}%`);

  // 8. 占位符 / 黑话泄漏
  if (after.includes("\uE000")) push("HARD", "占位符残留", "U+E000 未还原");
  for (const w of LEAK_WORDS) {
    if (after.includes(w) && !before.includes(w)) push("SOFT", "疑似黑话残留", w);
  }

  // 9. 标点体例：同字符连续 3+（省略号/破折号除外）、行首标点
  for (const line of after.split(/\r?\n/)) {
    const l = line.trim();
    if (/^[，。、；：？！）】」》%,.]/.test(l)) push("SOFT", "行首标点", l.slice(0, 20));
    const bad = l.match(/([，。、；：？！])\1{2,}/);
    if (bad) push("SOFT", "连续重复标点", bad[0]);
  }

  // 10. 相邻重复句（切句打散最容易把一句复制两遍）
  const lines = after
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const sentences = lines
    .join("\n")
    .split(/[。！？\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 6);
  for (let i = 1; i < sentences.length; i++) {
    if (sentences[i] === sentences[i - 1]) push("HARD", "相邻重复句", sentences[i].slice(0, 30));
  }

  // 11. 空句/只剩标点的句子
  for (const s of sentences) {
    if (/^[，。、；：？！、,.]+$/.test(s)) push("HARD", "空句", JSON.stringify(s));
  }
  return F;
}

/* ------------------------------ 跑 ------------------------------ */
interface Run {
  id: string;
  seed: number;
  intensity: number;
  before: string;
  after: string;
  ms: number;
  aiBefore: number;
  aiAfter: number;
  F: Finding[];
}

const selected = cases.filter((c) => !ONLY || c.id === ONLY);
// 拼错 id 必须报错，不能静默跑 0 篇然后打一行"硬缺陷 0"——v0.9.53 在送检脚本里踩过同一个坑
if (selected.length === 0) {
  throw new Error(`--only ${ONLY} 未匹配任何用例（共 ${cases.length} 篇）`);
}

const runs: Run[] = [];
const aiBeforeOf = new Map<string, number>();

for (const c of selected) {
  const sb = aiScore(c.text).score;
  aiBeforeOf.set(c.id, sb);
  for (const seed of SEEDS) {
    for (const intensity of INTENSITIES) {
      const t0 = Date.now();
      const after = humanize(c.text, { intensity, seed });
      const ms = Date.now() - t0;
      runs.push({
        id: c.id,
        seed,
        intensity,
        before: c.text,
        after,
        ms,
        aiBefore: sb,
        aiAfter: aiScore(after).score,
        F: check(c.text, after),
      });
    }
  }
}

/** 同一 (id, kind, detail) 在多个组合里重复出现 → 只报一条，记命中数 */
interface AggFinding {
  id: string;
  level: Finding["level"];
  kind: string;
  detail: string;
  hits: string[];
}
const agg = new Map<string, AggFinding>();
const runsWithDefect = new Set<string>();

for (const r of runs) {
  for (const f of r.F) {
    const key = `${r.id}\u0000${f.kind}\u0000${f.detail}`;
    const hit = `s${r.seed}/i${r.intensity}`;
    const cur = agg.get(key);
    if (cur) cur.hits.push(hit);
    else agg.set(key, { id: r.id, level: f.level, kind: f.kind, detail: f.detail, hits: [hit] });
    if (f.level === "HARD") runsWithDefect.add(`${r.id}\u0000${hit}`);
  }
}

// 硬缺陷优先，其次命中组数多的（稳定的 > 偶发的）
const ranked = [...agg.values()].sort(
  (a, b) =>
    Number(b.level === "HARD") - Number(a.level === "HARD") || b.hits.length - a.hits.length,
);
const hard = ranked.filter((x) => x.level === "HARD");
const soft = ranked.filter((x) => x.level === "SOFT");
const fmtHits = (h: string[]) => `${h.length}/${RUNS} 组（${h.slice(0, 3).join("、")}${h.length > 3 ? "…" : ""}）`;

if (!MATRIX) {
  /* ---------------- 单点模式：输出与 report.json 结构保持历史原样 ---------------- */
  const rows: Array<Record<string, string>> = [];
  const allFindings: Array<{ id: string; f: Finding }> = [];
  for (const r of runs) {
    fs.writeFileSync(path.join(OUT, `${r.id}.before.txt`), r.before, "utf8");
    fs.writeFileSync(path.join(OUT, `${r.id}.after.txt`), r.after, "utf8");
    rows.push({
      id: r.id,
      aiScore: `${r.aiBefore}→${r.aiAfter}`,
      len: `${r.before.length}→${r.after.length}`,
      段落: `${paraCount(r.before)}→${paraCount(r.after)}`,
      HARD: String(r.F.filter((f) => f.level === "HARD").length),
      SOFT: String(r.F.filter((f) => f.level === "SOFT").length),
      ms: String(r.ms),
    });
    for (const f of r.F) allFindings.push({ id: r.id, f });
  }

  console.log(
    `\n════════ 真实案例跑测：本地引擎（intensity ${INTENSITIES[0]}，seed ${SEEDS[0]}）════════\n`,
  );
  const cols = ["id", "aiScore", "len", "段落", "HARD", "SOFT", "ms"];
  console.log(cols.join("\t"));
  for (const r of rows) console.log(cols.map((k) => r[k]).join("\t"));

  console.log(`\n──── 硬缺陷 ${allFindings.filter((x) => x.f.level === "HARD").length} 条 ────`);
  for (const { id, f } of allFindings.filter((x) => x.f.level === "HARD"))
    console.log(`  [${id}] ${f.kind}：${f.detail}`);
  console.log(`\n──── 软提示 ${allFindings.filter((x) => x.f.level === "SOFT").length} 条 ────`);
  for (const { id, f } of allFindings.filter((x) => x.f.level === "SOFT"))
    console.log(`  [${id}] ${f.kind}：${f.detail}`);

  fs.writeFileSync(
    path.join(HERE, "report.json"),
    JSON.stringify({ rows, findings: allFindings }, null, 2),
    "utf8",
  );
  console.log(`\n📁 逐篇 before/after 已落 ${OUT}`);
  console.log(`📁 机器可读报告 ${path.join(HERE, "report.json")}`);
} else {
  /* ---------------- 矩阵模式：按篇汇总 + 缺陷聚合 ---------------- */
  fs.mkdirSync(OUT_MATRIX, { recursive: true });

  // 只有出缺陷的组才落盘，否则 20 篇 × 10 组 = 200 个文件把 out/ 淹了
  for (const r of runs) {
    if (r.F.length === 0) continue;
    fs.writeFileSync(
      path.join(OUT_MATRIX, `${r.id}__s${r.seed}__i${r.intensity}.after.txt`),
      r.after,
      "utf8",
    );
  }

  const rows: Array<Record<string, string>> = selected.map((c) => {
    const mine = runs.filter((r) => r.id === c.id);
    const hardRuns = mine.filter((r) => r.F.some((f) => f.level === "HARD"));
    const softRuns = mine.filter((r) => r.F.some((f) => f.level === "SOFT"));
    const scores = mine.map((r) => r.aiAfter);
    const sb = aiBeforeOf.get(c.id) ?? 0;
    return {
      id: c.id,
      aiScore: `${sb}→${Math.min(...scores)}~${Math.max(...scores)}`,
      len: `${c.text.length}→${Math.min(...mine.map((r) => r.after.length))}~${Math.max(...mine.map((r) => r.after.length))}`,
      组数: String(mine.length),
      HARD组: `${hardRuns.length}`,
      SOFT组: `${softRuns.length}`,
      ms: `${Math.min(...mine.map((r) => r.ms))}~${Math.max(...mine.map((r) => r.ms))}`,
    };
  });

  console.log(
    `\n════════ 真实案例跑测：矩阵（${SEEDS.length} seed × ${INTENSITIES.length} 强度 = 每篇 ${RUNS} 组）════════`,
  );
  console.log(`seed：[${SEEDS.join(", ")}]  强度：[${INTENSITIES.join(", ")}]\n`);
  const cols = ["id", "aiScore", "len", "组数", "HARD组", "SOFT组", "ms"];
  console.log(cols.join("\t"));
  for (const r of rows) console.log(cols.map((k) => r[k]).join("\t"));

  console.log(`\n──── 硬缺陷 ${hard.length} 条（已去重）────`);
  for (const f of hard) console.log(`  [${f.id}] ${f.kind}：${f.detail}  命中 ${fmtHits(f.hits)}`);
  console.log(`\n──── 软提示 ${soft.length} 条（已去重）────`);
  for (const f of soft) console.log(`  [${f.id}] ${f.kind}：${f.detail}  命中 ${fmtHits(f.hits)}`);

  fs.writeFileSync(
    path.join(HERE, "report-matrix.json"),
    JSON.stringify(
      {
        meta: { seeds: SEEDS, intensities: INTENSITIES, cases: selected.length, runs: runs.length },
        rows,
        findings: ranked,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`\n📁 出缺陷组的 after 已落 ${OUT_MATRIX}`);
  console.log(`📁 机器可读矩阵报告 ${path.join(HERE, "report-matrix.json")}`);
}

// 有硬缺陷就非 0 退出——否则进 check:release 只能靠人眼看输出
if (hard.length > 0) {
  process.exitCode = 1;
  console.error(`\n❌ 硬缺陷 ${hard.length} 类，涉及 ${runsWithDefect.size} 个「篇×组」`);
}
