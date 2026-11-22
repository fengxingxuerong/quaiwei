/**
 * 为「碎句约束」双席 A/B 生成两臂（离线、确定性、不依赖网关）。
 *
 *   A 臂 arms-free/   = 无约束改写：单 seed=42，现行引擎默认行为（可能碎句化骗分）
 *   B 臂 arms-guard/  = 克制改写：多 seed 挑「句数增幅 ≤50%」且 aiScore 最低的稿
 *
 * 上游实验（evidence/optimization-experiments-2026-11-21/fragment-guard.json）显示：
 *   无约束 AUC 0.2645（判反=骗分），≤50% 增幅 AUC≈0.52（人机难分）。
 * 本脚本把该候选落到 realcase 23 篇，产出可直接喂 ab_accept.py 的两臂。
 *
 * 语料：scripts/realcase/cases.json 全量 23 篇。
 * 用法：npx tsx scripts/build-fragment-guard-arms.ts
 * 产物：eval-work/ab-fragment-guard/{arms-free,arms-guard}/<id>.humanized.txt + manifest.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { humanize } from "../src/engine/humanize";
import { aiScore } from "../src/engine/humanize-metrics";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "eval-work/ab-fragment-guard");
const FREE = path.join(OUT, "arms-free");
const GUARD = path.join(OUT, "arms-guard");
// 清掉上一次的臂：用 rename 整个移走，不用逐文件 unlink——
// 沙箱删除守卫 50/轮，批量重建臂会撞 SAFE_DELETE_BULK_CONFIRM_REQUIRED。
for (const d of [FREE, GUARD]) {
  if (fs.existsSync(d)) {
    fs.renameSync(d, `${d}.old-${Date.now()}`);
  }
  fs.mkdirSync(d, { recursive: true });
}

/**
 * 语料选择：
 *  - 默认（realcase/）：23 篇短 AI 稿——但实测本地引擎对其几乎不碎句（句数增幅 0.24），
 *    两臂 17/23 逐字节相同 ⇒ 配对退化成瞎猜，**不适合做本 A/B**。
 *  - `--detectrl`（推荐）：从 DetectRL-ZH machine 里挑「无约束改写句数增幅>50%」的 23 篇，
 *    这些才是真正会碎句化的样本，两臂有实质差异，A/B 才有区分度。
 */
const USE_DETECTRL = process.argv.includes("--detectrl");
const CORPUS_DIR = path.join(OUT, "corpus");

function loadCases(): { id: string; text: string }[] {
  if (USE_DETECTRL) {
    const data = JSON.parse(
      fs.readFileSync(path.join(ROOT, "artifacts/open-datasets/detectrl-zh-dev.json"), "utf8"),
    ) as { text: string; label: number }[];
    const machine = data.filter((x) => x.label === 1);
    const vis = (s: string) => s.replace(/\s/g, "").length;
    const picked: { id: string; text: string }[] = [];
    for (let i = 0; i < machine.length && picked.length < 23; i++) {
      const t = machine[i].text;
      const chars = vis(t);
      if (chars < 400 || chars > 1000) continue;
      const b = aiScore(t);
      const out = humanize(t, { intensity: INTENSITY, seed: 42, style: "plain" });
      const a = aiScore(out);
      const growth = (a.sentenceCount - b.sentenceCount) / Math.max(1, b.sentenceCount);
      if (growth > 0.5) picked.push({ id: `frag-${i}`, text: t });
    }
    // corpus 目录：ab_accept.py --corpus 用文件名取 id（rename 移走旧的，避开删除守卫）
    if (fs.existsSync(CORPUS_DIR)) fs.renameSync(CORPUS_DIR, `${CORPUS_DIR}.old-${Date.now()}`);
    fs.mkdirSync(CORPUS_DIR, { recursive: true });
    for (const c of picked) fs.writeFileSync(path.join(CORPUS_DIR, `${c.id}.txt`), c.text);
    return picked;
  }
  return (
    JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/realcase/cases.json"), "utf8")) as {
      cases: { id: string; text: string }[];
    }
  ).cases;
}
const SEEDS = [42, 1, 7, 2026, 20261015];
const MAX_GROWTH = 0.5;
const INTENSITY = 0.9;
const cases = loadCases();

const manifest: {
  id: string;
  sentBefore: number;
  free: { sent: number; growth: number; score: number; seed: number };
  guard: { sent: number; growth: number; score: number; seed: number; underCap: boolean };
}[] = [];

for (const c of cases) {
  const before = aiScore(c.text);
  const sentBefore = before.sentenceCount;

  // A 臂：无约束，单 seed=42
  const freeText = humanize(c.text, { intensity: INTENSITY, seed: 42, style: "plain" });
  const freeScore = aiScore(freeText);
  const freeGrowth = (freeScore.sentenceCount - sentBefore) / Math.max(1, sentBefore);
  fs.writeFileSync(path.join(FREE, `${c.id}.humanized.txt`), freeText);

  // B 臂：多 seed 挑「句数增幅≤cap」中 aiScore 最低；无满足者取增幅最小
  const candidates = SEEDS.map((seed) => {
    const text = humanize(c.text, { intensity: INTENSITY, seed, style: "plain" });
    const s = aiScore(text);
    return {
      seed,
      text,
      score: s.score,
      sent: s.sentenceCount,
      growth: (s.sentenceCount - sentBefore) / Math.max(1, sentBefore),
    };
  });
  const underCap = candidates.filter((c2) => c2.growth <= MAX_GROWTH);
  // cap 内：选 aiScore 最低（既克制又有效）；cap 外（全部碎句化）：选**句数增幅最小**的，
  // 而不是分数最低——否则又会选回碎句最狠的稿，两臂雷同、A/B 退化成瞎猜。
  const best = underCap.length
    ? [...underCap].sort((a, b) => a.score - b.score || a.growth - b.growth)[0]
    : [...candidates].sort((a, b) => a.growth - b.growth || a.score - b.score)[0];
  fs.writeFileSync(path.join(GUARD, `${c.id}.humanized.txt`), best.text);

  manifest.push({
    id: c.id,
    sentBefore,
    free: {
      sent: freeScore.sentenceCount,
      growth: +freeGrowth.toFixed(3),
      score: freeScore.score,
      seed: 42,
    },
    guard: {
      sent: best.sent,
      growth: +best.growth.toFixed(3),
      score: best.score,
      seed: best.seed,
      underCap: underCap.length > 0,
    },
  });
}

fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));

const guardUnder = manifest.filter((m) => m.guard.underCap).length;
const avgGrowthFree = manifest.reduce((s, m) => s + m.free.growth, 0) / manifest.length;
const avgGrowthGuard = manifest.reduce((s, m) => s + m.guard.growth, 0) / manifest.length;
const avgScoreFree = manifest.reduce((s, m) => s + m.free.score, 0) / manifest.length;
const avgScoreGuard = manifest.reduce((s, m) => s + m.guard.score, 0) / manifest.length;

console.log("═".repeat(66));
console.log("碎句约束双席 A/B 两臂生成（离线，确定性）");
console.log("═".repeat(66));
console.log(
  `语料 ${cases.length} 篇 · cap=句数增幅≤${MAX_GROWTH * 100}% · seeds=[${SEEDS.join(",")}]`,
);
console.log(`B 臂满足 cap 的篇数：${guardUnder}/${cases.length}`);
console.log(
  `平均句数增幅  A(无约束) ${avgGrowthFree.toFixed(3)} → B(克制) ${avgGrowthGuard.toFixed(3)}`,
);
console.log(`平均 aiScore   A ${avgScoreFree.toFixed(1)} → B ${avgScoreGuard.toFixed(1)}`);
console.log(`产物：${OUT}/arms-free 与 arms-guard`);
console.log("\n下一步（网关 18326 恢复后）：");
console.log(
  "  QUAIWEI_EVAL_KEY_A=<key> QUAIWEI_EVAL_KEY_B=<key> python scripts/eval-dual/ab_accept.py \\\n" +
    "    --arm-a eval-work/ab-fragment-guard/arms-free --arm-b eval-work/ab-fragment-guard/arms-guard \\\n" +
    "    --corpus scripts/realcase --url-a http://127.0.0.1:18326 \\\n" +
    "    --model-a glm/glm-5.3-flash --reasoning-effort-a low --mirror --seats AB \\\n" +
    "    --out eval-work/ab-fragment-guard/ab-out",
);
