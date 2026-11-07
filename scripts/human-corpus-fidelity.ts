/**
 * 21 篇真人语料误伤探针（只读，产出报告，不写死断言）。
 *
 * 量的是「引擎改写真人稿时有没有引入事实 / 格式 / 成句性问题」，
 * 不是「这篇该不该改」——后者需要人工标签，本探针不编标签。
 *
 * 语料 artifacts/human-corpus/*.txt 被 .gitignore 忽略（该目录只放行 *.ts），
 * 所以本脚本只在本机跑、报告入库，不接 CI 门禁。
 *
 * 运行：npx tsx scripts/human-corpus-fidelity.ts
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { humanize } from "../src/engine/humanize";
import { aiScore, collapseIssues } from "../src/engine/humanize-metrics";
import { missingNumericFacts, changedUnits } from "../src/engine/number-fidelity";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS = path.join(ROOT, "artifacts/human-corpus");
const OUT_DIR = path.join(ROOT, "evidence/human-corpus-fidelity-2026-11-07");

const URL_RE = /https?:\/\/[^\s)），,。；;]+/g;
/**
 * 探针自写的成句性签名：句末悬空连接词（「……，因此。」）。
 * 与 scan-bugs 的正式签名不是同一口径，只作趋势观察，不进门禁。
 */
const DANGLING_RE =
  /[，,](?:因此|所以|但是|然而|不过|总之|综上|另外|此外|而且|并且|首先|其次|最后|换句话说|也就是说)[。！？]/g;

const urls = (s: string): string[] => (s.match(URL_RE) ?? []).sort();
const fences = (s: string): number => (s.match(/```/g) ?? []).length;
const sameUrls = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

interface Row {
  file: string;
  charsIn: number;
  charsOut: number;
  aiScoreIn: number;
  aiScoreOut: number;
  missingNumbers: string[];
  changedUnits: string[];
  urlFidelity: boolean;
  fenceFidelity: boolean;
  collapse: string[];
  danglingConnective: string[];
}

const files = readdirSync(CORPUS)
  .filter((f) => f.endsWith(".txt"))
  .sort();
const rows: Row[] = files.map((file) => {
  const src = readFileSync(path.join(CORPUS, file), "utf8");
  const out = humanize(src, { intensity: 0.6, seed: 20260905 });
  return {
    file,
    charsIn: src.length,
    charsOut: out.length,
    aiScoreIn: aiScore(src).score,
    aiScoreOut: aiScore(out).score,
    missingNumbers: missingNumericFacts(src, out),
    changedUnits: changedUnits(src, out),
    urlFidelity: sameUrls(urls(src), urls(out)),
    fenceFidelity: fences(src) === fences(out),
    collapse: collapseIssues(src, out),
    danglingConnective: (out.match(DANGLING_RE) ?? []).slice(0, 3),
  };
});

/** 事实/格式保真：这四项任一命中就是真缺陷。 */
const hardFails = rows.filter(
  (r) =>
    r.missingNumbers.length > 0 ||
    r.changedUnits.length > 0 ||
    !r.urlFidelity ||
    !r.fenceFidelity,
);
/**
 * collapseIssues 是给 LLM 深度改写查「内容腰斩」的判据。
 * 规则引擎的切句同样会让它命中（破折号/省略号被切成独立片段），
 * 那是成句性问题而非事实丢失 ⇒ 单列，不混进 hardFails。
 */
const collapseHits = rows.filter((r) => r.collapse.length > 0);
const dangling = rows.filter((r) => r.danglingConnective.length > 0);
const sum = (pick: (r: Row) => number): number => rows.reduce((a, r) => a + pick(r), 0);

const report = {
  at: new Date().toISOString(),
  corpus: "artifacts/human-corpus/*.txt（中文维基正文，未入库）",
  engine: { intensity: 0.6, seed: 20260905, structural: false, api: false },
  files: rows.length,
  charsIn: sum((r) => r.charsIn),
  charsOut: sum((r) => r.charsOut),
  aiScoreMeanIn: Math.round((sum((r) => r.aiScoreIn) / rows.length) * 10) / 10,
  aiScoreMeanOut: Math.round((sum((r) => r.aiScoreOut) / rows.length) * 10) / 10,
  hardFailureFiles: hardFails.map((r) => r.file),
  collapseIssueFiles: collapseHits.map((r) => r.file),
  danglingConnectiveFiles: dangling.map((r) => r.file),
  rows,
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  path.join(OUT_DIR, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
  "utf8",
);

console.log(`语料 ${rows.length} 篇 | ${report.charsIn} → ${report.charsOut} 字`);
console.log(`aiScore 均值 ${report.aiScoreMeanIn} → ${report.aiScoreMeanOut}`);
console.log(`事实/格式保真失败（丢数字/改单位/URL/围栏）：${hardFails.length} 篇`, hardFails.map((r) => r.file));
console.log(`collapseIssues 命中（切句碎句化，需人工复核）：${collapseHits.length} 篇`, collapseHits.map((r) => r.file));
console.log(`句末悬空连接词（探针签名）：${dangling.length} 篇`, dangling.map((r) => r.file));
console.log(`报告：${path.join(OUT_DIR, "report.json")}`);
