/**
 * 低分稿「跳过 vs 少改」两臂生成（离线、确定性、只读）。
 *
 * 背景：v0.9.90 起 lowYieldRisk 命中稿默认原样跳过（formalPer1k<=8）。
 * 争议：直接跳过是「保守取向」还是「放弃改善」？候选策略是「少改」——
 *      不跳过，但用更低强度（0.3）改写，博取小幅改善同时压低反噬风险。
 *
 * 本脚本只生成两臂，不改产品判据、不改引擎默认：
 *   A 臂 arms-skip/    = 原文（当前默认跳过行为）
 *   B 臂 arms-soft/    = humanize(text, { intensity: 0.3, seed }) 低强度改写
 * 语料：realcase 23 篇中被 isLowYieldRisk 命中的篇目。
 *
 * 用法：npx tsx scripts/build-low-yield-arms.ts [--intensity 0.3]
 * 产物：eval-work/ab-low-yield/{arms-skip,arms-soft}/<id>.humanized.txt + manifest.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { humanize } from "../src/engine/humanize";
import { isLowYieldRisk, lowYieldSignals } from "../src/engine/low-yield";
import { aiScore } from "../src/engine/humanize-metrics";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "eval-work/ab-low-yield");
const SKIP = path.join(OUT, "arms-skip");
const SOFT = path.join(OUT, "arms-soft");
const idx = process.argv.indexOf("--intensity");
const INTENSITY = idx >= 0 ? Math.max(0, Math.min(1, Number(process.argv[idx + 1]) || 0.3)) : 0.3;
const SEED = 42;

function reset(d: string) {
  if (fs.existsSync(d)) fs.renameSync(d, `${d}.old-${Date.now()}`);
  fs.mkdirSync(d, { recursive: true });
}
for (const d of [SKIP, SOFT]) reset(d);

const cases = (
  JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/realcase/cases.json"), "utf8")) as {
    cases: { id: string; text: string }[];
  }
).cases;

const manifest: {
  intensity: number;
  seed: number;
  rows: {
    id: string;
    hit: boolean;
    formalPer1k: number;
    chars: number;
    same: boolean;
    scoreSkip: number;
    scoreSoft: number;
    delta: number;
  }[];
} = { intensity: INTENSITY, seed: SEED, rows: [] };

let skipped = 0;
for (const c of cases) {
  const sig = lowYieldSignals(c.text);
  if (!sig.hit) continue;
  skipped++;
  const soft = humanize(c.text, { intensity: INTENSITY, seed: SEED, style: "plain" });
  fs.writeFileSync(path.join(SKIP, `${c.id}.humanized.txt`), c.text);
  fs.writeFileSync(path.join(SOFT, `${c.id}.humanized.txt`), soft);
  const scoreSkip = aiScore(c.text).score;
  const scoreSoft = aiScore(soft).score;
  manifest.rows.push({
    id: c.id,
    hit: isLowYieldRisk(c.text),
    formalPer1k: sig.formalPer1k,
    chars: sig.chars,
    same: c.text === soft,
    scoreSkip,
    scoreSoft,
    delta: scoreSoft - scoreSkip,
  });
}
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));

const same = manifest.rows.filter((r) => r.same).length;
console.log(`低分稿命中 ${skipped} 篇，强度 ${INTENSITY}，seed ${SEED}`);
console.log(`两臂逐字节相同：${same}/${skipped}`);
for (const r of manifest.rows)
  console.log(
    `  ${r.id.padEnd(22)} d=${String(r.formalPer1k).padStart(5)} len=${String(r.chars).padStart(4)} ` +
      `aiScore ${r.scoreSkip}→${r.scoreSoft} (Δ${r.delta > 0 ? "+" : ""}${r.delta}) ${r.same ? "SAME" : ""}`,
  );
console.log(`\n产物：${OUT}`);
console.log(
  `\n下一步（方向性裁决，同网关异模型，不能当正式能力口径）：\n` +
    `  QUAIWEI_EVAL_KEY_A=<key1> QUAIWEI_EVAL_KEY_B=<key2> \\\n` +
    `  py -3.12 scripts/eval-dual/ab_accept.py \\\n` +
    `    --arm-a ${SKIP} --arm-b ${SOFT} --out eval-work/ab-low-yield/out-ab \\\n` +
    `    --url-a https://bailucode.com/openapi/v1 --url-b https://bailucode.com/openapi/v1 \\\n` +
    `    --model-a bailu-2.8 --model-b yuyu-air --seats AB`,
);
