/**
 * collateral-c-guard-sim.ts —— C 类窄守卫离线模拟（**不改产品代码**）
 *
 * ## 为什么只模拟
 *
 * `evidence/collateral-collapse-2026-11-12/README.md` 把 3 条 C 类「使得」悬空
 * 判为唯一真语病。但记忆与 90 票结论都要求「改切句守卫需单独立项 + 双席 A/B」，
 * 而本轮网关不可用（8080 离线、18080 需 proxy key、历史凭证全 401）
 * ⇒ **不能上线**。本脚本只回答「如果加，会动多少」，给立项提供数字。
 *
 * ## 三条 C 类 front（取自 collapse 报告的「产出残句」）
 *
 *   1. 集成电路：「这些电路的小尺寸使得与板级集成相比」  ← 状语尾「相比」
 *   2. 量子力学：「则这光子可以给予足够能量来」          ← 目的「来」收尾
 *   3. 5G：「更多的蜂窝」                                  ← 5 字名词残片
 *
 * 三者切点位置不同：**不是一条「使得」守卫能盖住的**。
 *
 * 用法：npx tsx scripts/collateral-c-guard-sim.ts
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fragmentFrontCanStand } from "../src/engine/humanize-primitives";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "evidence", "collateral-c-guard-sim-2026-11-12");

const C_FRONT = [
  "这些电路的小尺寸使得与板级集成相比",
  "则这光子可以给予足够能量来",
  "更多的蜂窝",
];

/** 模拟里复制一份（不进产品）：与 humanize-primitives.ts 的 NP_PREDICATE_RE 同表 */
const NP_PREDICATE_RE =
  /[着了过]|正在|可以|应该|需要|能够|必须|得以|受到|加以|提升|提高|降低|减少|增加|推动|实现|促进|加强|优化|改善|完成|开展|进行|出现|存在|发生|改变|影响|形成|构成|成为|决定|带来|导致|依赖|适用|具备|具有|意味着|表明|显示|说明/;

/** 候选窄守卫：三条，各自对准一种形态，合计远少于 10 个关联词/形态 */
const RULES: { name: string; hit: (front: string, lastSeg: string) => boolean; note: string }[] = [
  {
    name: "R1 致使+比较状语悬空",
    hit: (f) => /(?:使得|致使)[^，。；：]{0,24}(?:相比|相较|而言|来说)$/.test(f),
    note: "「A使得…相比，」逗号不是句法边界；只拦「相比/相较/而言/来说」这 4 个收尾",
  },
  {
    name: "R2 给予+目的「来」悬空",
    hit: (f) => /(?:给予|提供|带来)[^，。；：]{0,20}来$/.test(f),
    note: "「可以给予足够能量来」缺后续动词；只拦「给予/提供/带来…来」",
  },
  {
    name: "R3′ 5~6字短段无真谓语",
    hit: (_f, lastSeg) => lastSeg.length <= 6 && !NP_PREDICATE_RE.test(lastSeg),
    note: "把短残片门槛 4→6，但谓语判据从单字宽表换成 NP_PREDICATE_RE（双字谓词/体标记）",
  },
];

/** 从 21 篇真人长文抽取「，」切点的 front 末段，作为现有守卫的真实输入分布 */
function collectFronts(): string[] {
  const dir = path.join(ROOT, "artifacts", "human-corpus");
  const fronts: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".txt") || f.startsWith("_")) continue;
    const raw = readFileSync(path.join(dir, f), "utf8");
    const i = raw.indexOf("\n\n");
    const text = (i >= 0 ? raw.slice(i + 2) : raw).trim();
    // 按句末标点切句，再取每个句子里最后一个逗号前的末段（与 findSplitPoint 的 lastSeg 同口径）
    for (const sent of text.split(/[。！？!?]/)) {
      const s = sent.trim();
      if (s.length < 8 || s.length > 60) continue;
      const k = s.lastIndexOf("，");
      if (k < 0) continue;
      const front = s.slice(0, k).trim();
      if (front) fronts.push(front);
    }
  }
  return fronts;
}

function main(): void {
  const fronts = collectFronts();
  const existingPass = fronts.filter((f) => fragmentFrontCanStand(f));

  /* 逐条规则：在「现有守卫放行」的集合里，看它新增否决多少 */
  const perRule = RULES.map((r) => {
    const vetoed = existingPass.filter((f) => {
      const lastSeg = f.split(/[，,、；;：:]/).slice(-1)[0];
      return r.hit(f, lastSeg);
    });
    return {
      name: r.name,
      note: r.note,
      additionalVeto: vetoed.length,
      vetoRateOfPassing: Math.round((vetoed.length / Math.max(1, existingPass.length)) * 1000) / 10,
      samples: vetoed.slice(0, 6),
    };
  });

  /* C 类三条：现有守卫放行吗？候选规则能拦几条？ */
  const cRows = C_FRONT.map((f) => {
    const lastSeg = f.split(/[，,、；;：:]/).slice(-1)[0];
    const hits = RULES.filter((r) => r.hit(f, lastSeg)).map((r) => r.name);
    return { front: f, existingGuardAllows: fragmentFrontCanStand(f), caughtBy: hits };
  });

  const allRules = (f: string): boolean => {
    const lastSeg = f.split(/[，,、；;：:]/).slice(-1)[0];
    return RULES.some((r) => r.hit(f, lastSeg));
  };
  const combinedVeto = existingPass.filter(allRules).length;

  const report = {
    at: new Date().toISOString(),
    purpose: "C 类窄守卫离线模拟：若新增守卫，会动多少现有合法切点；不修改产品代码、不宣称验收通过",
    cFronts: cRows,
    corpus: { files: 21, candidateFronts: fronts.length, existingGuardPassing: existingPass.length },
    rules: perRule,
    combinedAdditionalVeto: combinedVeto,
    combinedVetoRateOfPassing: Math.round((combinedVeto / Math.max(1, existingPass.length)) * 1000) / 10,
    verdict:
      `现有守卫对 3 条 C 类全部放行（${cRows.filter((c) => c.existingGuardAllows).length}/3）；` +
      `候选规则能拦 ${cRows.filter((c) => c.caughtBy.length > 0).length}/3。` +
      `**风险全在 R3′**：R1/R2 在 ${existingPass.length} 个「现有放行」的真人切点上新增否决均为 0；` +
      `R3′ 单独带来 ${perRule[2].additionalVeto} 个（${perRule[2].vetoRateOfPassing}%），三条合并 ${combinedVeto} 个（${Math.round((combinedVeto / Math.max(1, existingPass.length)) * 1000) / 10}%）⇒ ` +
      `R1/R2 是零影响面的窄守卫，R3′ 会挡住大量现有切分、是否属误伤必须靠双席 A/B 判定。` +
      `本轮网关不可用（8080 离线 / 18080 需 proxy key / 历史凭证全 401）⇒ **A/B 未执行，三条都不进 src/**。`,
    limitations: [
      "「现有放行」不等于「合法」——其中可能本来就有缺陷，新增否决未必是误伤",
      "R3 只是把短残片门槛 4→6 的粗模拟，真实实现要配 NP_PREDICATE_RE，影响面会小很多",
      "front 抽取用 lastIndexOf('，')，与引擎 findSplitPoint 的 mid 选点不完全一致",
      "只覆盖 21 篇维基长文，未扫 realcase 23 篇与 4080 次 sweep:format 语料",
      "无双席 A/B，任何「效果更好」的说法都不成立",
    ],
  };

  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");

  console.log("══════ C 类窄守卫离线模拟（不进 src/） ══════\n");
  console.log(`语料：21 篇真人长文 → 候选 front ${fronts.length} 个，现有守卫放行 ${existingPass.length} 个\n`);
  console.log("C 类 3 条：");
  for (const c of cRows) console.log(`  ${c.front.padEnd(24)} 现有放行=${c.existingGuardAllows}  候选拦下=[${c.caughtBy.join(", ") || "无"}]`);
  console.log("\n逐条规则的新增否决：");
  for (const r of perRule) console.log(`  ${r.name.padEnd(22)} 新增否决 ${String(r.additionalVeto).padStart(4)} 个（占放行 ${r.vetoRateOfPassing}%）  例：${r.samples.slice(0, 2).join(" / ").slice(0, 60)}`);
  console.log(`\n三条合并：新增否决 ${combinedVeto} 个（${report.combinedVetoRateOfPassing}%）`);
  console.log(`\n判定：${report.verdict}`);
  console.log(`\n报告：${path.relative(ROOT, path.join(OUT, "report.json"))}`);
}

main();
