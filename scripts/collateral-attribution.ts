/**
 * collateral-attribution.ts —— P1-1 阈值归因（只报告，不进门禁）
 *
 * 问题：误伤基准台首跑（evidence/collateral-bench-2026-11-08/report.json）显示
 * --skip-low-risk 的判据在 21 篇「不该动」真人稿上 lowRiskShare = 0，
 * 而同一判据在 23 篇「该改」短稿上命中 13 篇。本脚本回答「为什么」：
 *   1) formalHits 是**原始次数**（未做长度归一），长文天然 >2 ⇒ 判据是长度函数；
 *   2) 基准台两面板的长度分布完全不重叠 ⇒ 任何含长度的判据都会虚高分离（标签泄漏）；
 *   3) 把旧判据、长度归一的候选、结构候选放在同一张表上比较命中/误跳/残余误伤。
 *
 * 只读取语料与基准台报告，不调用 humanize()、不改一个字、不写门禁。
 * 用法：npx tsx scripts/collateral-attribution.ts [--bench <report.json>]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aiScore } from "../src/engine/humanize-metrics";
import { registerIndex } from "../src/engine/register-metrics";
import { structureMetrics } from "../src/engine/structure-metrics";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LABELS = path.join(ROOT, "scripts", "collateral-labels.json");
const EVIDENCE = path.join(ROOT, "evidence");
const REDLINE = 30;
const FLOOR = 10;

interface Label {
  id: string;
  source: string;
  label: "no-touch" | "should-change";
}
interface Manifest {
  panels: { noTouch: Label[]; shouldChange: Label[] };
}
interface BenchRow {
  id: string;
  label: "no-touch" | "should-change";
  editRatio: number;
  fidelityHardFail: boolean;
  collapse: string[];
  dangling: string[];
}

interface Feature {
  id: string;
  label: "no-touch" | "should-change";
  chars: number;
  cjkChars: number;
  aiScore: number;
  formalHits: number;
  formalPer1k: number;
  colloquialPer1k: number;
  registerIndex: number;
  periodPerKChar: number;
  sentLenMean: number;
  commasPerSentence: number;
  shortRatio: number;
  editRatio: number;
  hurt: boolean;
}

interface Candidate {
  name: string;
  rule: string;
  usesLength: boolean;
  noTouchHit: number;
  shouldChangeHit: number;
  hurtAvoided: number;
  residualHurtRate: number;
  changedLost: number;
  changedRatioAfter: number;
}

function loadText(source: string): string {
  const hashAt = source.indexOf(".json#");
  if (hashAt >= 0) {
    const file = path.join(ROOT, source.slice(0, hashAt + 5));
    const caseId = source.slice(hashAt + 6);
    const wrapped = JSON.parse(readFileSync(file, "utf8")) as { cases: { id: string; text: string }[] };
    const hit = wrapped.cases.find((c) => c.id === caseId);
    if (!hit) throw new Error(`cases.json 里找不到 ${caseId}`);
    return hit.text;
  }
  return readFileSync(path.join(ROOT, source), "utf8");
}

function defaultBench(): string {
  const dirs = readdirSync(EVIDENCE)
    .filter((d) => d.startsWith("collateral-bench-"))
    .sort();
  const last = dirs[dirs.length - 1];
  if (!last) throw new Error("找不到 evidence/collateral-bench-* 报告");
  return path.join(EVIDENCE, last, "report.json");
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

function buildFeatures(manifest: Manifest, benchRows: BenchRow[]): Feature[] {
  const rowById = new Map(benchRows.map((r) => [r.id, r]));
  return [...manifest.panels.noTouch, ...manifest.panels.shouldChange].map((lb) => {
    const src = loadText(lb.source);
    const row = rowById.get(lb.id);
    if (!row) throw new Error(`基准台报告缺 ${lb.id}`);
    const reg = registerIndex(src);
    const st = structureMetrics(src);
    return {
      id: lb.id,
      label: lb.label,
      chars: src.length,
      cjkChars: reg.countedChars,
      aiScore: aiScore(src).score,
      formalHits: reg.formalHits,
      formalPer1k: reg.formalPer1k,
      colloquialPer1k: reg.colloquialPer1k,
      registerIndex: reg.index,
      periodPerKChar: st.periodPerKChar,
      sentLenMean: st.sentLen.mean,
      commasPerSentence: st.commasPerSentence,
      shortRatio: st.shortRatio,
      editRatio: row.editRatio,
      hurt:
        row.fidelityHardFail ||
        row.collapse.length > 0 ||
        row.dangling.length > 0 ||
        row.editRatio >= REDLINE,
    };
  });
}

function scoreCandidate(name: string, rule: string, usesLength: boolean, hit: (f: Feature) => boolean, rows: Feature[]): Candidate {
  const noTouch = rows.filter((r) => r.label === "no-touch");
  const shouldChange = rows.filter((r) => r.label === "should-change");
  const hitNoTouch = noTouch.filter(hit);
  const hitShouldChange = shouldChange.filter(hit);
  const hurtAvoided = hitNoTouch.filter((r) => r.hurt).length;
  const hurtBefore = noTouch.filter((r) => r.hurt).length;
  const changedBefore = shouldChange.filter((r) => r.editRatio >= FLOOR).length;
  const changedLost = hitShouldChange.filter((r) => r.editRatio >= FLOOR).length;
  return {
    name,
    rule,
    usesLength,
    noTouchHit: hitNoTouch.length,
    shouldChangeHit: hitShouldChange.length,
    hurtAvoided,
    residualHurtRate: Math.round(((hurtBefore - hurtAvoided) / noTouch.length) * 100),
    changedLost,
    changedRatioAfter: Math.round(((changedBefore - changedLost) / shouldChange.length) * 100),
  };
}

function main(): void {
  const benchArg = process.argv.indexOf("--bench");
  const benchPath = benchArg >= 0 ? path.resolve(process.argv[benchArg + 1]) : defaultBench();
  if (!existsSync(benchPath)) throw new Error(`找不到基准台报告 ${benchPath}`);
  const manifest = JSON.parse(readFileSync(LABELS, "utf8")) as Manifest;
  const bench = JSON.parse(readFileSync(benchPath, "utf8")) as { rows: BenchRow[] };
  const rows = buildFeatures(manifest, bench.rows);

  const candidates: Candidate[] = [];
  const add = (name: string, rule: string, usesLength: boolean, hit: (f: Feature) => boolean) =>
    candidates.push(scoreCandidate(name, rule, usesLength, hit, rows));

  add("OLD(ai<=27 & formalHits<=2)", "aiScore<=27 && formalHits<=2", false, (f) => f.aiScore <= 27 && f.formalHits <= 2);
  add("AI_ONLY(ai<=27)", "aiScore<=27", false, (f) => f.aiScore <= 27);
  for (const k of [1, 2, 3, 4, 6, 8, 12, 20]) {
    add(`NORM(ai<=27 & formalPer1k<=${k})`, `aiScore<=27 && formalPer1k<=${k}`, false, (f) => f.aiScore <= 27 && f.formalPer1k <= k);
  }
  for (const k of [1, 2, 4, 8]) {
    add(`DENSITY(formalPer1k<=${k})`, `formalPer1k<=${k}`, false, (f) => f.formalPer1k <= k);
  }
  for (const s of [20, 27, 35, 45]) {
    add(`AI_SCORE<=${s}`, `aiScore<=${s}`, false, (f) => f.aiScore <= s);
  }
  for (const r of [60, 70, 80, 90]) {
    add(`REGISTER>=${r}`, `registerIndex>=${r}`, false, (f) => f.registerIndex >= r);
  }
  for (const p of [20, 25, 30, 40]) {
    add(`PERIOD<=${p}`, `periodPerKChar<=${p}`, false, (f) => f.periodPerKChar <= p);
  }
  for (const l of [500, 1000, 2000]) {
    add(`LENGTH(chars>=${l})`, `chars>=${l}`, true, (f) => f.chars >= l);
  }
  add("LENGTH+NORM", "chars>=1000 && formalPer1k<=8", true, (f) => f.chars >= 1000 && f.formalPer1k <= 8);

  const noTouch = rows.filter((r) => r.label === "no-touch");
  const shouldChange = rows.filter((r) => r.label === "should-change");
  const lengths = {
    noTouchMin: Math.min(...noTouch.map((r) => r.chars)),
    noTouchMax: Math.max(...noTouch.map((r) => r.chars)),
    shouldChangeMin: Math.min(...shouldChange.map((r) => r.chars)),
    shouldChangeMax: Math.max(...shouldChange.map((r) => r.chars)),
    overlap: Math.max(...shouldChange.map((r) => r.chars)) >= Math.min(...noTouch.map((r) => r.chars)),
  };
  // 独立交叉核对：双网关 0.9 档配对强制选择（23 篇就是 should-change 面板）。
  // 判据命中 = 开启 --skip-low-risk 会原样出稿；这些篇里「至少一席判改写更像人」就是放弃掉的改善。
  const dualPath = path.join(EVIDENCE, "eval-dual-2026-11-06", "eval_dual_results.jsonl");
  let dualJudge: unknown = null;
  if (existsSync(dualPath)) {
    const pairs = readFileSync(dualPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { kind: string; armTag?: string; id: string; engineWin?: boolean })
      .filter((p) => p.kind === "pair" && p.armTag === "local09");
    const wins = new Map<string, { w: number; t: number }>();
    for (const p of pairs) {
      const cur = wins.get(p.id) ?? { w: 0, t: 0 };
      cur.t += 1;
      if (p.engineWin) cur.w += 1;
      wins.set(p.id, cur);
    }
    const judge = (hit: (f: Feature) => boolean) => {
      const hits = rows.filter((r) => r.label === "should-change" && hit(r) && wins.has(r.id));
      const tally = hits.map((r) => wins.get(r.id)!);
      return {
        hit: hits.length,
        twoSeatWin: tally.filter((t) => t.w === t.t && t.t === 2).length,
        anySeatWin: tally.filter((t) => t.w > 0).length,
        zeroWin: tally.filter((t) => t.w === 0).length,
      };
    };
    dualJudge = {
      source: path.relative(ROOT, dualPath),
      basis: "0.9 档双席配对强制选择（engineWin）；绝对分不可复现，只作相对口径",
      legacy: judge((f) => f.aiScore <= 27 && f.formalHits <= 2),
      normalized: judge((f) => f.formalPer1k <= 8),
    };
  }

  const legacy = candidates[0];
  const normalized = candidates.find((c) => c.name === "DENSITY(formalPer1k<=8)")!;
  const diagnostics = {
    bench: path.relative(ROOT, benchPath),
    panels: { noTouch: noTouch.length, shouldChange: shouldChange.length },
    lengths,
    correlation: {
      charsVsFormalHits_all: Math.round(pearson(rows.map((r) => r.chars), rows.map((r) => r.formalHits)) * 1000) / 1000,
      charsVsFormalHits_noTouch: Math.round(pearson(noTouch.map((r) => r.chars), noTouch.map((r) => r.formalHits)) * 1000) / 1000,
      charsVsFormalPer1k_all: Math.round(pearson(rows.map((r) => r.chars), rows.map((r) => r.formalPer1k)) * 1000) / 1000,
      charsVsAiScore_all: Math.round(pearson(rows.map((r) => r.chars), rows.map((r) => r.aiScore)) * 1000) / 1000,
    },
    dualJudge,
    verdict:
      `旧判据是长度函数（字数~formalHits r=${Math.round(pearson(rows.map((r) => r.chars), rows.map((r) => r.formalHits)) * 1000) / 1000}）：` +
      `no-touch 命中 ${legacy.noTouchHit}/${noTouch.length}、should-change 误跳 ${legacy.shouldChangeHit}/${shouldChange.length}。` +
      `换长度归一的 formalPer1k<=8 后：no-touch 命中 ${normalized.noTouchHit}、should-change 误跳 ${normalized.shouldChangeHit}，` +
      `模拟残余误伤率 ${legacy.residualHurtRate}%→${normalized.residualHurtRate}%，该改达改率 ${legacy.changedRatioAfter}%→${normalized.changedRatioAfter}%。` +
      `两面板长度区间完全不重叠，含长度项的候选属标签泄漏；本结论仍属 44 篇探索性归因，需补长 AI 稿 / 短真人稿验证泛化。`,
    oldRule: {
      noTouchHit: candidates[0].noTouchHit,
      shouldChangeHit: candidates[0].shouldChangeHit,
      reason: "formalHits 是未归一的原始次数；长文书面标记命中随字数增长，<=2 在长文上构造性不可能。",
    },
    leakageWarning: lengths.overlap
      ? "两面板长度区间重叠"
      : "两面板长度区间完全不重叠：任何含长度项的判据在本语料上都会得到虚高分离度，属标签泄漏，不能据此标定阈值。",
    interpretation: "候选表只用于归因，不是门禁；需补「长 AI 稿 + 短真人稿」交叉样本才能判定泛化能力。",
  };

  const outDir = path.join(EVIDENCE, `collateral-attribution-${new Date().toISOString().slice(0, 10)}`);
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "report.json");
  writeFileSync(outPath, JSON.stringify({ at: new Date().toISOString(), diagnostics, candidates, features: rows }, null, 2) + "\n", "utf8");

  console.log("══════════ P1-1 阈值归因（只报告不门禁） ══════════");
  console.log(`基准台：${diagnostics.bench} | no-touch ${noTouch.length} / should-change ${shouldChange.length}`);
  console.log(
    `长度区间：no-touch ${lengths.noTouchMin}~${lengths.noTouchMax} 字 / should-change ${lengths.shouldChangeMin}~${lengths.shouldChangeMax} 字 | ${diagnostics.leakageWarning}`,
  );
  console.log(
    `相关：字数~formalHits 全样本 ${diagnostics.correlation.charsVsFormalHits_all}（no-touch 内 ${diagnostics.correlation.charsVsFormalHits_noTouch}）；字数~aiScore ${diagnostics.correlation.charsVsAiScore_all}`,
  );
  console.log(`结论：${diagnostics.verdict}`);
  console.log(`独立交叉核对（0.9 档配对）：${JSON.stringify(dualJudge)}`);
  console.log("候选（命中=跳过；残余误伤率越低越好，误跳该改稿越少越好）：");
  console.log("name\tnoTouch命中\tshouldChange命中\t救回误伤\t残余误伤率%\t丢失达改稿\t改后达改率%\t含长度项");
  for (const c of candidates) {
    console.log(
      [c.name, c.noTouchHit, c.shouldChangeHit, c.hurtAvoided, c.residualHurtRate, c.changedLost, c.changedRatioAfter, c.usesLength ? "YES" : "no"].join("\t"),
    );
  }
  console.log(`报告：${outPath}`);
}

main();
