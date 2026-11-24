import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { humanize } from "../src/engine/humanize.ts";
import { aiScore } from "../src/engine/humanize-metrics.ts";
import { hardFidelityIssues } from "./open-source-humanizer-checks.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(ROOT, "scripts/fixtures/open-source");
const OUT = path.join(ROOT, "evidence/open-source-humanizer-2026-11-25");
const SEEDS = [42, 1, 7, 2026, 20261015];
const INTENSITIES = [0.6, 0.9];
const ENHANCEMENTS = [false, true];

interface CaseSample {
  id: string;
  input: string;
}

interface DraftSample {
  id: string;
  genre: string;
  writer: string;
  text: string;
}

interface Sample {
  id: string;
  source: string;
  kind: string;
  text: string;
}

interface Row {
  id: string;
  source: string;
  kind: string;
  seed: number;
  intensity: number;
  enhancement: boolean;
  charsIn: number;
  charsOut: number;
  scoreIn: number;
  scoreOut: number;
  delta: number;
  changed: boolean;
  issues: string[];
}

const cases = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, "humanizer-zh-cases.json"), "utf8"),
) as CaseSample[];
const drafts = fs
  .readFileSync(path.join(FIXTURES, "sgaofen-zh-drafts.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as DraftSample);
const structure = fs.readFileSync(path.join(FIXTURES, "humanizer-zh-structure.md"), "utf8");

const samples: Sample[] = [
  ...cases.map((sample) => ({
    id: `humanizer-zh/${sample.id}`,
    source: "op7418/Humanizer-zh",
    kind: `case/${sample.id}`,
    text: sample.input,
  })),
  {
    id: "humanizer-zh/structure",
    source: "op7418/Humanizer-zh",
    kind: "markdown/structure",
    text: structure,
  },
  ...drafts.map((sample) => ({
    id: `sgaofen/${sample.id}`,
    source: "sgaofen/humanizer-local-model",
    kind: sample.genre,
    text: sample.text,
  })),
];

const rows: Row[] = [];
for (const sample of samples) {
  const scoreIn = aiScore(sample.text).score;
  for (const seed of SEEDS) {
    for (const intensity of INTENSITIES) {
      for (const enhancement of ENHANCEMENTS) {
        const output = humanize(sample.text, { intensity, seed, enhancementMode: enhancement });
        const scoreOut = aiScore(output).score;
        rows.push({
          id: sample.id,
          source: sample.source,
          kind: sample.kind,
          seed,
          intensity,
          enhancement,
          charsIn: sample.text.length,
          charsOut: output.length,
          scoreIn,
          scoreOut,
          delta: scoreOut - scoreIn,
          changed: output !== sample.text,
          issues: hardFidelityIssues(sample.text, output),
        });
      }
    }
  }
}

const failures = rows.filter((row) => row.issues.length > 0);
const average = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const byKind = new Map<string, Row[]>();
for (const row of rows) {
  const group = byKind.get(row.kind) ?? [];
  group.push(row);
  byKind.set(row.kind, group);
}
const reasonCounts = new Map<string, number>();
for (const row of failures) {
  for (const issue of row.issues) {
    const reason = issue.split(":")[0];
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }
}

const summary = {
  generatedAt: new Date().toISOString(),
  matrix: {
    samples: samples.length,
    seeds: SEEDS,
    intensities: INTENSITIES,
    enhancements: ENHANCEMENTS,
  },
  hardFidelity: {
    runs: rows.length,
    failedRuns: failures.length,
    failedPct: rows.length ? Number(((100 * failures.length) / rows.length).toFixed(2)) : 0,
    reasons: Object.fromEntries([...reasonCounts.entries()].sort((a, b) => b[1] - a[1])),
  },
  scoreTrend: {
    note: "aiScore 是项目自评分，仅作同篇相对方向，不代表官方检测器或过检率。",
    byKind: Object.fromEntries(
      [...byKind.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([kind, group]) => [
          kind,
          {
            runs: group.length,
            avgIn: Number(average(group.map((row) => row.scoreIn)).toFixed(1)),
            avgOut: Number(average(group.map((row) => row.scoreOut)).toFixed(1)),
            avgDelta: Number(average(group.map((row) => row.delta)).toFixed(1)),
            improvedPct: Number(
              ((100 * group.filter((row) => row.delta < 0).length) / group.length).toFixed(1),
            ),
          },
        ]),
    ),
  },
  failures: failures.slice(0, 50).map((row) => ({
    id: row.id,
    seed: row.seed,
    intensity: row.intensity,
    enhancement: row.enhancement,
    issues: row.issues,
  })),
};

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
fs.writeFileSync(
  path.join(OUT, "rows.jsonl"),
  rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
);
fs.rmSync(path.join(OUT, "failures.json"), { force: true });
if (failures.length) {
  fs.writeFileSync(
    path.join(OUT, "failures.json"),
    JSON.stringify(
      failures.map((row) => ({
        ...row,
        input: samples.find((sample) => sample.id === row.id)?.text,
        output: humanize(samples.find((sample) => sample.id === row.id)!.text, {
          intensity: row.intensity,
          seed: row.seed,
          enhancementMode: row.enhancement,
        }),
      })),
      null,
      2,
    ) + "\n",
  );
}

console.log(
  JSON.stringify(
    {
      samples: samples.length,
      runs: rows.length,
      failedRuns: failures.length,
      reasons: summary.hardFidelity.reasons,
      report: path.relative(ROOT, OUT),
    },
    null,
    2,
  ),
);
process.exit(failures.length ? 1 : 0);
