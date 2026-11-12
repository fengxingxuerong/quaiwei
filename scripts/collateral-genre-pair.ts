/**
 * collateral-genre-pair.ts —— 体裁混淆分离（只报告，不门禁）
 *
 * ## 补的缺口
 *
 * `evidence/collateral-cross-2026-11-09/` 的硬伤：短真人稿全是**百科体**、
 * AI 短稿全是**营销/公文/技术体**，两面板密度差（4.6 vs 12.5）里
 * 有多少来自「人 vs AI」、多少来自「百科体 vs 营销体」，分不开。
 *
 * 11-10 生成长 AI 稿时，`collateral-ai-long.ts` 的 `wiki` 体裁明确
 * 「对齐 H-long 体裁」（真人维基长条目）——**同体裁配对语料其实已经有了**，
 * 只是当时没做这个对比。本脚本把它用起来：同体裁、同长度下只留「人 vs AI」一个变量。
 *
 * ## 设计
 *
 * | 面板 | 来源 | 处理 |
 * |---|---|---|
 * | AI-wiki | artifacts/ai-corpus-long/AI-LONG-wiki-*.txt（4 篇） | 直接用 |
 * | 真人-wiki | artifacts/human-corpus/（21 篇） | 按 600/1200/2400/4800 字取首段窗口 |
 *
 * 真人切片而非新抓短语料：让「同一批文本、只改长度」成立，避免把「开头导语」
 * 和「正文片段」的写作差异当成来源差异。真正的独立短真人稿由
 * `evidence/collateral-cross-2026-11-09/` 的 H-short 面板单独承担。
 *
 * ## 判据方向
 *
 * `--skip-low-risk` 想做的是「真人稿跳过、AI 稿改写」，
 * 即真人密度应**低于** AI 密度。AUC = P(真人密度 < AI 密度)，0.5 = 抛硬币。
 *
 * 用法：npx tsx scripts/collateral-genre-pair.ts
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lowYieldSignals, LOW_YIELD_FORMAL_PER_1K } from "../src/engine/low-yield";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "evidence", "collateral-genre-pair-2026-11-12");
const HUMAN_DIR = path.join(ROOT, "artifacts", "human-corpus");
const AI_DIR = path.join(ROOT, "artifacts", "ai-corpus-long");
const WINDOWS = [600, 1200, 2400, 4800];

/** 维基语料：头部 4 行元信息 + 空行 + 正文 */
const body = (raw: string): string => {
  const i = raw.indexOf("\n\n");
  return (i >= 0 ? raw.slice(i + 2) : raw).trim();
};

const round = (x: number) => Math.round(x * 1000) / 1000;
const med = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

interface TextRow {
  id: string;
  chars: number;
  density: number;
  hit: boolean;
}

function loadAi(): TextRow[] {
  return readdirSync(AI_DIR)
    .filter((f) => f.startsWith("AI-LONG-wiki-") && f.endsWith(".txt"))
    .sort()
    .map((f) => {
      const t = body(readFileSync(path.join(AI_DIR, f), "utf8"));
      return { id: f.replace(/\.txt$/, ""), chars: t.length, density: lowYieldSignals(t).formalPer1k, hit: lowYieldSignals(t).hit };
    });
}

function loadHuman(): string[] {
  return readdirSync(HUMAN_DIR)
    .filter((f) => f.endsWith(".txt") && !f.startsWith("_"))
    .sort()
    .map((f) => body(readFileSync(path.join(HUMAN_DIR, f), "utf8")));
}

/** AUC = P(真人密度 < AI 密度)，0.5 = 无区分力；平手记 0.5 */
function auc(h: number[], a: number[]): number {
  let win = 0;
  let tie = 0;
  for (const x of h) for (const y of a) {
    if (x < y) win++;
    else if (x === y) tie++;
  }
  return round((win + tie / 2) / (h.length * a.length));
}

function main(): void {
  const ai = loadAi();
  const humanTexts = loadHuman();
  const humanByWindow = new Map<number, number[]>();

  for (const w of WINDOWS) {
    const ds = humanTexts.filter((t) => t.length >= w).map((t) => lowYieldSignals(t.slice(0, w)).formalPer1k);
    humanByWindow.set(w, ds);
  }

  /** 每个 AI 稿落到最接近的长度档，与同档真人片段配对 */
  const bands = WINDOWS.map((w) => {
    const hs = humanByWindow.get(w) ?? [];
    const near = ai.filter((a) => Math.abs(a.chars - w) <= w * 0.35);
    return {
      windowChars: w,
      humanN: hs.length,
      humanDensityMedian: round(med(hs)),
      humanHitRate: round((hs.filter((d) => d <= LOW_YIELD_FORMAL_PER_1K).length / Math.max(1, hs.length)) * 100),
      aiN: near.length,
      aiDensityMedian: round(med(near.map((a) => a.density))),
      aucHumanLower: auc(hs, near.map((a) => a.density)),
    };
  });

  const allHuman = [...humanByWindow.values()].flat();
  const overallAuc = auc(allHuman, ai.map((a) => a.density));
  const aiHitRate = round((ai.filter((a) => a.hit).length / ai.length) * 100);

  /* 对照：跨体裁的原始读数（来自 collateral-cross-2026-11-09） */
  const crossGenre = {
    humanShortDensityMedian: 4.6,
    aiShortDensityMedian: 12.5,
    sameLengthAuc: 0.683,
    note: "真人=百科体短条目，AI=营销/公文/技术体；体裁与来源两者都变了",
  };

  const perBandAiN = bands.map((b) => b.aiN);
  const spread = round(Math.max(...bands.map((b) => b.aucHumanLower)) - Math.min(...bands.map((b) => b.aucHumanLower)));
  const insufficient = perBandAiN.some((n) => n < 3);
  const verdict = insufficient
    ? `**样本不足，不下结论。** 同体裁 AI 稿只有 ${ai.length} 篇、每个长度档 ${perBandAiN.join("/")} 篇，` +
      `逐档 AUC 从 ${Math.min(...bands.map((b) => b.aucHumanLower))} 摆到 ${Math.max(...bands.map((b) => b.aucHumanLower))}（跨度 ${spread}），` +
      `总体 AUC ${overallAuc} 只是把 4 篇不同长度的 AI 稿混算出来的描述值，**不能当成「体裁是否已分离」的判据**。` +
      `单篇就能把 AUC 从 0.4 拉到 0.944，说明方差主导。` +
      `⇒ 要分离体裁混淆，必需「同体裁 AI 稿每档 ≥5 篇」（建议 4 档 × 5 = 20 篇）+ 真人侧同长度窗口，` +
      `再看 AUC 是否稳定在 0.5 附近。本轮只把配对框架与缺口量化，不宣称已分离。`
    : overallAuc <= 0.6
      ? `同体裁、同长度配对后 AUC ${overallAuc}（0.5=抛硬币），与跨体裁 ${crossGenre.sameLengthAuc} 相比明显收缩 ⇒ ` +
        `原先观察到的密度差主要来自体裁差异，不是「人 vs AI」；密度判据不能当「人味检测器」。`
      : `同体裁、同长度配对后 AUC ${overallAuc}，与跨体裁 ${crossGenre.sameLengthAuc} 同量级 ⇒ ` +
        `体裁不是主要混淆项，密度差更可能来自「人 vs AI」本身。`;

  const report = {
    at: new Date().toISOString(),
    purpose: "体裁混淆分离：同体裁（百科体）、同长度下，「人 vs AI」的密度差还剩多少",
    thresholdPer1k: LOW_YIELD_FORMAL_PER_1K,
    corpora: {
      aiWiki: "artifacts/ai-corpus-long/AI-LONG-wiki-*.txt（11-10 GLM 生成，明确对齐 H-long 体裁）",
      humanWiki: "artifacts/human-corpus/（21 篇中文维基长条目）",
      note: "真人侧按 600/1200/2400/4800 字取首段窗口，与 AI 稿同长度；这是长度对照切片，不是独立短文",
    },
    panels: {
      aiWiki: { n: ai.length, densityMedian: round(med(ai.map((a) => a.density))), hitRate: aiHitRate },
      humanWiki: { n: humanTexts.length, windows: WINDOWS.length, densityMedianByWindow: Object.fromEntries(WINDOWS.map((w) => [w, round(med(humanByWindow.get(w) ?? []))])) },
    },
    bands,
    overallAuc,
    sampleAdequacy: { aiPerBand: perBandAiN, aucSpread: spread, insufficient, requiredAiPerBand: 5 },
    crossGenre,
    limitations: [
      "AI-wiki 只有 4 篇（每个长度档 1 篇），AUC 的置信区间极宽；本结论是方向性归因，不是标定",
      "同一模型（glm-5.3-flash）、4 个不同主题；换模型/主题是否同样重叠，未测",
      "真人侧是「长文首段窗口切片」，不是完整独立短文；导语的定义句密度可能与正文不同",
      "只覆盖了 wiki 百科体这一格；mkt/gov 体裁的真人对照语料仍缺，跨体裁泛化未验证",
      "语料由 LLM 生成，不可复现；量测可复跑",
      "本轮没有生成新语料：本机 8080 网关离线，18080 需 proxy API key（历史凭证全部 401）",
    ],
    verdict,
    rows: { aiWiki: ai, humanWindowDensities: Object.fromEntries(WINDOWS.map((w) => [w, humanByWindow.get(w) ?? []])) },
  };

  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");

  console.log("══════ 体裁混淆分离：同体裁（百科体）人 vs AI ══════\n");
  console.log("AI-wiki 逐篇：");
  for (const a of ai) console.log(`  ${a.id.padEnd(24)} ${String(a.chars).padStart(5)} 字  密度 ${String(round(a.density)).padStart(6)}  hit=${a.hit}`);
  console.log("\n真人 wiki 同长度窗口：");
  for (const b of bands) console.log(`  ${String(b.windowChars).padStart(4)} 字窗口  n=${String(b.humanN).padStart(2)}  密度中位 ${b.humanDensityMedian}  <=8 ${b.humanHitRate}%  vs AI AUC ${b.aucHumanLower}`);
  console.log(`\n总体 AUC（真人密度 < AI 密度）：${overallAuc}  ← 0.5 = 抛硬币，跨体裁对照 ${crossGenre.sameLengthAuc}`);
  console.log(`\n判定：${verdict}`);
  console.log(`\n报告：${path.relative(ROOT, path.join(OUT, "report.json"))}`);
}

main();
