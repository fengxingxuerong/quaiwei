/**
 * collateral-bench.ts —— 误伤基准台（P1-1：误伤基准集的首个量化探针，只报告、不进门禁）。
 *
 * 为什么需要它：现有评测只量「改了有没有变好」（双席配对 / 结构指标 / 12 样本棘轮），
 * 没有一把带真人标签的尺子量「**不该动的稿子被动了多少**」——--skip-low-risk 的阈值
 * 就是从同批 23 篇、正例仅 7 个的探索性数据里来的。本脚本把 P1-1 的标签清单
 * （scripts/collateral-labels.json：no-touch 21 篇真人书面长文 + should-change 23 篇 AI 味案例）
 * 过一遍默认档引擎，产出双面板读数，让「误伤率」第一次有分母。
 *
 * 判定口径（与 SCORECARD §4 一致，禁止 aiScore 降幅作能力判定）：
 *   保真 = 丢数字 / 改单位 / URL / 代码围栏 四项硬失败，目标是 0；
 *   成句性 = collapseIssues（切句碎句化）+ 探针自写的句末悬空连接词签名；
 *   尺子 = structureMetrics（结构指标尺）+ registerIndex（语体尺）+ aiScore（仅参考列）；
 *   改动证据 = diffStats.ratio（改动率 %）。
 *
 * 误伤率（no-touch 面板）：保真硬失败 ∪ collapseIssues ∪ 悬空连接词 ∪ 改动率 ≥ 改动率红线
 * 的稿子占比。改动率红线默认 30（仅报告口径，**不写死门禁**——阈值该多少要等人工复核）。
 *
 * 语料 artifacts/human-corpus/*.txt 被 .gitignore 忽略，本脚本只在本机跑、报告入库，
 * 与 human-corpus-fidelity.ts 同一规矩。运行：npx tsx scripts/collateral-bench.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { humanize } from "../src/engine/humanize";
import { aiScore, collapseIssues } from "../src/engine/humanize-metrics";
import { changedUnits, missingNumericFacts } from "../src/engine/number-fidelity";
import { registerIndex } from "../src/engine/register-metrics";
import { compareMetrics, structureMetrics } from "../src/engine/structure-metrics";
import { diffStats } from "../src/engine/diff";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LABELS = path.join(ROOT, "scripts", "collateral-labels.json");
/** 改动率红线（%）：no-touch 面板被动得比这更多就算「误伤候选」。只进报告，不进门禁。 */
const EDIT_RATIO_REDLINE = 30;
/** 达改下限（%）：should-change 面板改动率低于它算「改不动」。 */
const EDIT_RATIO_FLOOR = 10;
const DANGLING_RE =
  /[，,](?:因此|所以|但是|然而|不过|总之|综上|另外|此外|而且|并且|首先|其次|最后|换句话说|也就是说)[。！？]/g;

interface Label {
  id: string;
  source: string;
  label: "no-touch" | "should-change";
  genre?: string;
  note?: string;
}
interface Manifest {
  panels: { noTouch: Label[]; shouldChange: Label[] };
  current: { noTouch: number; shouldChange: number };
}

interface PieceRow {
  id: string;
  label: "no-touch" | "should-change";
  charsIn: number;
  charsOut: number;
  editRatio: number;
  aiScoreIn: number;
  aiScoreOut: number;
  registerIn: number;
  registerOut: number;
  formalHitsIn: number;
  fidelity: { missingNumbers: string[]; changedUnits: string[]; urlOk: boolean; fenceOk: boolean };
  fidelityHardFail: boolean;
  collapse: string[];
  dangling: string[];
  topStructureDeltas: { key: string; label: string; before: number; after: number; deltaPct: number | null }[];
}

const URL_RE = /https?:\/\/[^\s)），,。；;]+/g;
const urls = (s: string): string[] => (s.match(URL_RE) ?? []).sort();
const sameUrls = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);
const fences = (s: string): number => (s.match(/```/g) ?? []).length;

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

function runPiece(lb: Label): PieceRow {
  const src = loadText(lb.source);
  const out = humanize(src, { intensity: 0.6, seed: 20260905 });
  const missingNumbers = missingNumericFacts(src, out);
  const changedUnitsL = changedUnits(src, out);
  const urlOk = sameUrls(urls(src), urls(out));
  const fenceOk = fences(src) === fences(out);
  const structure = compareMetrics(structureMetrics(src), structureMetrics(out))
    .slice()
    .sort((a, b) => Math.abs(b.deltaPct ?? 0) - Math.abs(a.deltaPct ?? 0))
    .slice(0, 3)
    .map((d) => ({ key: d.key, label: d.label, before: d.before, after: d.after, deltaPct: d.deltaPct }));
  return {
    id: lb.id,
    label: lb.label,
    charsIn: src.length,
    charsOut: out.length,
    editRatio: diffStats(src, out).ratio,
    aiScoreIn: aiScore(src).score,
    aiScoreOut: aiScore(out).score,
    registerIn: registerIndex(src).index,
    registerOut: registerIndex(out).index,
    formalHitsIn: registerIndex(src).formalHits,
    fidelity: { missingNumbers, changedUnits: changedUnitsL, urlOk, fenceOk },
    fidelityHardFail:
      missingNumbers.length > 0 || changedUnitsL.length > 0 || !urlOk || !fenceOk,
    collapse: collapseIssues(src, out),
    dangling: (out.match(DANGLING_RE) ?? []).slice(0, 3),
    topStructureDeltas: structure,
  };
}

function main(): void {
  if (!existsSync(LABELS)) {
    console.error(`✗ 找不到标签清单 ${LABELS}`);
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync(LABELS, "utf8")) as Manifest;
  const corpusDir = path.join(ROOT, "artifacts/human-corpus");
  const missingCorpus = manifest.panels.noTouch.filter(
    (l) => !existsSync(path.join(ROOT, l.source)),
  );
  if (missingCorpus.length > 0 || !existsSync(corpusDir)) {
    console.error(
      `✗ no-touch 语料缺 ${missingCorpus.length} 篇（artifacts/human-corpus 是 .gitignore 语料，只在本机存在）。` +
        `缺：${missingCorpus.map((l) => l.id).join("、")}`,
    );
    process.exit(2);
  }

  const rows = [...manifest.panels.noTouch, ...manifest.panels.shouldChange].map(runPiece);
  const noTouch = rows.filter((r) => r.label === "no-touch");
  const shouldChange = rows.filter((r) => r.label === "should-change");

  const hard = noTouch.filter((r) => r.fidelityHardFail);
  const collapseHits = noTouch.filter((r) => r.collapse.length > 0);
  const danglingHits = noTouch.filter((r) => r.dangling.length > 0);
  const overRedline = noTouch.filter((r) => r.editRatio >= EDIT_RATIO_REDLINE);
  const hurt = new Set([...hard, ...collapseHits, ...danglingHits, ...overRedline].map((r) => r.id));
  const lowRisk = noTouch.filter((r) => r.aiScoreIn <= 27 && r.formalHitsIn <= 2);
  const changed = shouldChange.filter((r) => r.editRatio >= EDIT_RATIO_FLOOR);
  const changedFidelity = changed.filter((r) => r.fidelityHardFail);

  const report = {
    at: new Date().toISOString(),
    engine: { intensity: 0.6, seed: 20260905, structural: false, api: false },
    labels: { file: "scripts/collateral-labels.json", ...manifest.current },
    thresholds: { editRatioRedline: EDIT_RATIO_REDLINE, editRatioFloor: EDIT_RATIO_FLOOR },
    noTouchPanel: {
      count: noTouch.length,
      fidelityHardFail: hard.map((r) => r.id),
      collapseIssues: collapseHits.map((r) => `${r.id}(${r.collapse.length})`),
      danglingConnective: danglingHits.map((r) => r.id),
      overEditRedline: overRedline.map((r) => `${r.id}(editRatio=${r.editRatio})`),
      hurtIds: [...hurt].sort(),
      hurtRate: Math.round((hurt.size / noTouch.length) * 100),
      lowRiskShare: Math.round((lowRisk.length / noTouch.length) * 100),
      editRatioMean: Math.round((noTouch.reduce((a, r) => a + r.editRatio, 0) / noTouch.length) * 10) / 10,
      aiScoreMeanIn: Math.round((noTouch.reduce((a, r) => a + r.aiScoreIn, 0) / noTouch.length) * 10) / 10,
      aiScoreMeanOut: Math.round((noTouch.reduce((a, r) => a + r.aiScoreOut, 0) / noTouch.length) * 10) / 10,
    },
    shouldChangePanel: {
      count: shouldChange.length,
      changedRatio: Math.round((changed.length / shouldChange.length) * 100),
      unchanged: shouldChange.filter((r) => r.editRatio < EDIT_RATIO_FLOOR).map((r) => r.id),
      fidelityHardFailAmongChanged: changedFidelity.map((r) => r.id),
      editRatioMean: Math.round((shouldChange.reduce((a, r) => a + r.editRatio, 0) / shouldChange.length) * 10) / 10,
    },
    rows,
  };

  const outDir = path.join(ROOT, "evidence", `collateral-bench-${new Date().toISOString().slice(0, 10)}`);
  mkdirSync(outDir, { recursive: true });
  const reportPath = path.join(outDir, "report.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");

  console.log(`══════════ 误伤基准台（P1-1，只报告不门禁） ══════════`);
  console.log(
    `no-touch（不该误杀）${noTouch.length} 篇：误伤率 ${report.noTouchPanel.hurtRate}%` +
      `（保真硬失败 ${hard.length} / collapse ${collapseHits.length} / 悬空连接词 ${danglingHits.length}` +
      ` / 改动率≥${EDIT_RATIO_REDLINE}% ${overRedline.length}）`,
  );
  console.log(
    `  低风险稿占比（--skip-low-risk 判据命中）${report.noTouchPanel.lowRiskShare}% | ` +
      `平均改动率 ${report.noTouchPanel.editRatioMean}% | ` +
      `aiScore 均值 ${report.noTouchPanel.aiScoreMeanIn} → ${report.noTouchPanel.aiScoreMeanOut}（仅参考列）`,
  );
  console.log(
    `should-change（该改）${shouldChange.length} 篇：达改率 ${report.shouldChangePanel.changedRatio}%` +
      `（改动率 ≥${EDIT_RATIO_FLOOR}%），其中保真硬失败 ${changedFidelity.length} 篇；` +
      `未动清单：${report.shouldChangePanel.unchanged.join("、") || "无"}`,
  );
  console.log(`报告：${reportPath}`);
}

main();
