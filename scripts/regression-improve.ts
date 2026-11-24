/**
 * scripts/regression-improve.ts —— 「相对改善」自证门禁（零外部 key）
 *
 * 本门禁只验证同一篇文本在本地指标下的相对改善。
 *
 * ## 判据
 *
 * 对每个样本：原文 aiScore（`before`）→ 当前引擎改写稿 aiScore（`after`），
 * 要求 `after` **显著低于** `before`（默认改善率 ≥ 20%），且**不得为负改善**。
 *
 * ⚠️ 阈值不是拍脑袋定的：先 `--measure` 跑出实测分布，再据此登记基线。
 *    真要放宽必须改本文件的常量并写清原因（同 --rebaseline 的纪律）。
 *
 * ## 不做什么（边界，别自我加冕）
 *   · 不声称"等价于外部认证"——本地的黑箱判据无法被任何本地指标替代；
 *   · 不把改善率当绝对能力刻度：一把刻度不明的尺子量的差值仍是相对量。
 * 声明降级这件事必须写进 CHANGELOG，不能悄悄放宽。
 */
import { humanize } from "../src/engine/humanize.ts";
import { aiScore } from "../src/engine/humanize-metrics.ts";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface ImproveRow {
  id: string;
  label: string;
  before: number;
  after: number;
  /** (before - after) / before，负数=变糟 */
  drop: number;
  /** true = 只打印不判定（见 SKIP 样本的说明） */
  skip?: boolean;
}

/**
 * 样本集第 4 位：`skip: true` 表示**只展示、不参与判定**。
 *
 * 目前只有 HUMAN-NAR（人写叙事）一条。该样本只展示趋势，不参与改善率判定。
 */

/**
 * 改善率下限 50%。
 *
 * 不是拍脑袋定的（本文件顶部写了"先量后定基线"）：2026-10-13 用 4 条判定样本实测
 * （强度 0.9 / plain / seed=20260826）分布为 65.3% / 100% / 100% / 91.3%，
 * 最低的是 GOV-EXPO=65.3%。阈值取 50% = 给最弱的样本留 15pp 余量：
 * 既能接住"引擎退化"这种量级的下跌，又不至于让一次小改动就误报。
 * 真要放宽：改这里并写清原因（同 --rebaseline 的纪律），不许悄悄调。
 */
export const IMPROVE_MIN_DROP = 0.5;

/**
 * 跑一批样本，返回每篇的「原文分 → 改写分 → 改善率」。
 *
 * @param samples [id, label, 原文, skip?] 四元组（skip 见接口注释）
 * @param seed    固定 ⇒ 结果可复现（引擎是纯确定性的）
 */
export function measureImprove(
  samples: [string, string, string, boolean?][],
  seed: number,
): ImproveRow[] {
  return samples.map(([id, label, src, skip]) => {
    const out = humanize(src, { intensity: 0.9, style: "plain", seed });
    const b = aiScore(src).score;
    const a = aiScore(out).score;
    return { id, label, before: b, after: a, drop: b === 0 ? 0 : (b - a) / b, skip };
  });
}

/** 判定：返回不达标的行（达标=改善率 ≥ 阈值；skip 行永不判红） */
export function badRows(rows: ImproveRow[], minDrop = IMPROVE_MIN_DROP): ImproveRow[] {
  return rows.filter((r) => !r.skip && r.drop < minDrop);
}

/* ---------------- CLI ---------------- */
function main(): number {
  const argv = process.argv.slice(2);
  const seedIdx = argv.indexOf("--seed");
  const seed = seedIdx >= 0 ? Number(argv[seedIdx + 1]) : 20260826;
  const fileIdx = argv.indexOf("--samples");
  const file = fileIdx >= 0 ? argv[fileIdx + 1] : "";

  if (!file) {
    console.error("用法: npx tsx scripts/regression-improve.ts --samples <json> [--seed 20260826]");
    return 2;
  }
  const samples = JSON.parse(fs.readFileSync(file, "utf8")) as [
    string,
    string,
    string,
    boolean?,
  ][];
  const rows = measureImprove(samples, seed);
  console.log("\n 趣AI味 · 相对改善自证（同一把尺：本地 aiScore，强度 0.9 plain）");
  console.log(` 固定 seed=${seed} / 阈值 ${(IMPROVE_MIN_DROP * 100).toFixed(0)}%\n`);
  console.log(" ID         原文  改后  改善率   判定");
  console.log(" ───────────────────────────────────────");
  const bad = badRows(rows);
  const badIds = new Set(bad.map((r) => r.id));
  for (const r of rows) {
    const mark = r.skip ? "—（人写稿，不判定）" : badIds.has(r.id) ? "❌" : "✅";
    console.log(
      ` ${r.id.padEnd(11)} ${String(r.before).padStart(4)} ${String(r.after).padStart(5)} ` +
        `${(r.drop * 100).toFixed(1).padStart(6)}%   ${mark}`,
    );
  }
  const judged = rows.filter((r) => !r.skip).length;
  console.log(
    `\n 判定 ${judged} 条 / 展示 ${rows.length} 条 → ${bad.length === 0 ? "✅ 全部达标" : `❌ ${bad.length} 条未达阈值`}`,
  );
  return bad.length ? 1 : 0;
}

// ⚠️ 不能用 `import.meta.url === "file://" + process.argv[1]`：
// Windows 下 argv[1] 是 `D:\...`，拼出来是 `file://D:\...`，而 import.meta.url 是
// `file:///D:/...` —— 永远不相等，main() 静默不执行（实测：跑完零输出、退出码 0，
// 看起来像"通过"其实什么都没做）。必须走 pathToFileURL 归一化。
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main());
}
