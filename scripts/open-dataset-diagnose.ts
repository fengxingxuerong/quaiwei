/**
 * 外部数据集诊断一键入口（只读，不碰产品判据/默认行为）。
 *
 * 串起本项目的外部真值检验与判据实验，打印汇总表并给出解读口径：
 *   detectrl-auc      aiScore 对公开标注的判别力（总体/长度分层）
 *   detectrl-rewrite  本地引擎改写的降分与保真
 *   detectrl-attr     长文判反的分项归因
 *   detectrl-auc-after 改写后人机可分性是否收敛
 *   avg-len-exp       avgLen 判据候选（双集，只实验不上线）
 *   fragment-exp      碎句约束候选（只实验不上线）
 *
 * 前置：artifacts/open-datasets/detectrl-zh-dev.json（见 evidence 的下载命令）。
 * 用法：npx tsx scripts/open-dataset-diagnose.ts
 * 各子脚本单独跑会写自己的报告；本脚本只读汇总、不写文件。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = path.join(ROOT, "evidence");
const read = (rel: string): unknown => {
  const p = path.join(EVIDENCE, rel);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
};
const num = (x: unknown) => (typeof x === "number" ? x.toFixed(4) : "-");

const auc = read("open-dataset-detectrl-2026-11-21/auc-report.json") as Record<
  string,
  unknown
> | null;
const rw = read("open-dataset-detectrl-2026-11-21/rewrite-report.json") as Record<
  string,
  unknown
> | null;
const attr = read("open-dataset-detectrl-2026-11-21/attribution-report.json") as Record<
  string,
  unknown
> | null;
const after = read("open-dataset-detectrl-2026-11-21/auc-after-report.json") as Record<
  string,
  unknown
> | null;
const avgExp = read("optimization-experiments-2026-11-21/avg-len-criterion.json") as Record<
  string,
  Record<string, { overall: number; long: number }>
> | null;
const fragExp = read("optimization-experiments-2026-11-21/fragment-guard.json") as {
  guards: { label: string; covered: number; auc: number; meanDelta: number }[];
} | null;

console.log("═".repeat(72));
console.log("趣AI味 · 外部数据集诊断汇总（DetectRL-ZH / NLPCC-2025）");
console.log("═".repeat(72));

if (!auc) {
  console.log("缺 auc-report.json，请先跑 scripts/open-dataset-auc.ts");
  process.exit(1);
}

console.log("\n【1】aiScore 判别力（外部真值，AUC 越接近 0.5 越分不出）");
console.log(`  总体 AUC        ${num(auc.auc)}`);
const bands = auc.bands as { name: string; auc: number }[] | undefined;
if (bands) for (const b of bands) console.log(`  ${b.name.padEnd(14)} ${num(b.auc)}`);

if (rw) {
  console.log("\n【2】本地引擎改写（自评分降幅 + 硬保真）");
  console.log(`  aiScore 中位    ${num(rw.scoreInMedian)} → ${num(rw.scoreOutMedian)}`);
  console.log(`  硬保真失败      ${rw.hardFailRuns}/${rw.nRuns}`);
}

if (attr) {
  console.log("\n【3】长文判反归因（AUC<0.5 = 该项把机写判成人写）");
  const bd = attr.breakdown as { field: string; auc: number }[];
  for (const b of bd.slice(0, 4)) console.log(`  ${b.field.padEnd(16)} ${num(b.auc)}`);
}

if (after) {
  console.log("\n【4】改写后人机可分性");
  console.log(`  全体 AUC        ${num(after.aucBefore)} → ${num(after.aucAfterMedian)}`);
  console.log(`  长文 AUC        ${num(after.aucBeforeLong)} → ${num(after.aucAfterLongMedian)}`);
}

console.log("\n【口径提醒】");
console.log("  • AUC 远离 0.5（无论正反）都说明 aiScore 能分开人机；降分 ≠ 更像人。");
console.log("  • aiScore 是相对指标（同篇前后），此处是超范围使用，仅暴露风险，不更新 SCORECARD。");

if (avgExp) {
  console.log("\n【实验 A】avgLen 判据候选（双集对比，均未上线）");
  const v = avgExp["DetectRL-ZH(验证)"];
  const l = avgExp["local(探索)"];
  if (v && l) {
    for (const k of Object.keys(v)) {
      console.log(`  ${k.padEnd(10)} 验证集 ${num(v[k].overall)} / 探索集 ${num(l[k].overall)}`);
    }
  }
  console.log("  ⇒ 候选在两集方向相反，单一 avgLen 方向不通用，不建议上线。");
}

if (fragExp) {
  console.log("\n【实验 B】碎句约束候选（均未上线）");
  for (const g of fragExp.guards) {
    console.log(
      `  ${g.label.padEnd(10)} AUC ${num(g.auc)} 覆盖率 ${g.covered} 均分 ${g.meanDelta}`,
    );
  }
  console.log("  ⇒ ≤50% 增幅时 AUC≈0.52（人机难分），值得双席 A/B 验证后再考虑上线。");
}

console.log("\n" + "═".repeat(72));
console.log("复跑各子脚本：scripts/open-dataset-{auc,rewrite,attribution,auc-after}.ts");
console.log("实验脚本：scripts/{avg-len-criterion,fragment-guard}-experiment.ts");
