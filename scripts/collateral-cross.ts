/**
 * collateral-cross.ts —— P1-1 交叉长度语料检验（只报告，不门禁）
 *
 * ## 补的是什么缺口
 *
 * `evidence/collateral-attribution-2026-11-09/` 的结论有一条硬伤自己写明了：
 * 基准台两面板长度区间完全不重叠（真人 2031~27148 字 / AI 稿 53~453 字），
 * 任何含长度项的判据都会得到虚高分离度。换成密度判据 `formalPer1k<=8` 后，
 * 公式上消除了长度项，但**没实测过**「短真人稿」这一象限：
 * 真人写 200~450 字时，书面标记密度是不是也低？如果短真人稿密度和短 AI 稿一样，
 * 判据在短文本上就是抛硬币，`--skip-low-risk` 只能算随机跳过。
 *
 * ## 三个面板
 *
 * | 面板 | 来源 | 长度 |
 * |---|---|---|
 * | H-short（新） | 中文维基短条目（scripts/collateral-cross-fetch.ts 抓） | 191~457 |
 * | H-long | 中文维基长条目（P1-1 no-touch 面板） | 2031~27148 |
 * | AI-short | 仓内 realcase 23 篇（P1-1 should-change 面板） | 53~453 |
 *
 * ## 三个读数
 *
 * 1. **同长度对比**（H-short vs AI-short）：长度对齐后判据还有没有区分力。
 *    用 AUC 度量（H-short 密度低于 AI-short 的比例），0.5 = 抛硬币。
 * 2. **长度分层**（H-long 切成 400/800/1600/3200 字窗口）：密度是否随长度漂移。
 *    密度若稳定，说明「换成密度 = 消除长度混淆」这一步在数学之外也成立。
 * 3. **长 AI 稿**：本机 LLM 网关 2026-11-09 全线不可达（8080/18080 均拒连），
 *    这一象限**未实测**，报告里显式标注为缺口，不用推断替代。
 *
 * 用法：npx tsx scripts/collateral-cross.ts
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lowYieldSignals, LOW_YIELD_FORMAL_PER_1K, isLegacyLowYieldRisk } from "../src/engine/low-yield";
import { aiScore } from "../src/engine/humanize-metrics";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = path.join(ROOT, "evidence", `collateral-cross-${new Date().toISOString().slice(0, 10)}`);

interface Row {
  id: string;
  panel: "H-short" | "H-long" | "AI-short";
  chars: number;
  cjkChars: number;
  formalHits: number;
  formalPer1k: number;
  aiScore: number;
  hit: boolean;
  legacyHit: boolean;
}

/** 维基语料文件：头部 4 行元信息 + 空行 + 正文 */
function wikiBody(raw: string): string {
  const at = raw.indexOf("\n\n");
  return (at >= 0 ? raw.slice(at + 2) : raw).trim();
}

function loadShortHuman(): Row[] {
  const dir = path.join(ROOT, "artifacts", "human-corpus-short");
  if (!existsSync(dir)) throw new Error(`缺短真人稿语料：${dir}（先跑 scripts/collateral-cross-fetch.ts）`);
  return readdirSync(dir)
    .filter((f) => /^WIKI-SHORT-\d+\.txt$/.test(f))
    .sort()
    .map((f) => {
      const raw = readFileSync(path.join(dir, f), "utf8");
      const title = /「(.+?)」/.exec(raw)?.[1] ?? f;
      const text = wikiBody(raw);
      const sig = lowYieldSignals(text);
      return {
        id: title,
        panel: "H-short" as const,
        chars: text.length,
        cjkChars: sig.cjkChars,
        formalHits: sig.formalHits,
        formalPer1k: sig.formalPer1k,
        aiScore: aiScore(text).score,
        hit: sig.hit,
        legacyHit: isLegacyLowYieldRisk(text, aiScore(text).score),
      };
    });
}

function loadLongHuman(): Row[] {
  const dir = path.join(ROOT, "artifacts", "human-corpus");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".txt") && !f.startsWith("_"))
    .sort()
    .map((f) => {
      const text = wikiBody(readFileSync(path.join(dir, f), "utf8"));
      const sig = lowYieldSignals(text);
      const score = aiScore(text).score;
      return {
        id: f.replace(/\.txt$/, ""),
        panel: "H-long" as const,
        chars: text.length,
        cjkChars: sig.cjkChars,
        formalHits: sig.formalHits,
        formalPer1k: sig.formalPer1k,
        aiScore: score,
        hit: sig.hit,
        legacyHit: isLegacyLowYieldRisk(text, score),
      };
    });
}

function loadAiShort(): Row[] {
  const file = path.join(ROOT, "scripts", "realcase", "cases.json");
  const wrapped = JSON.parse(readFileSync(file, "utf8")) as { cases: { id: string; text: string }[] };
  return wrapped.cases.map((c) => {
    const sig = lowYieldSignals(c.text);
    const score = aiScore(c.text).score;
    return {
      id: c.id,
      panel: "AI-short" as const,
      chars: c.text.length,
      cjkChars: sig.cjkChars,
      formalHits: sig.formalHits,
      formalPer1k: sig.formalPer1k,
      aiScore: score,
      hit: sig.hit,
      legacyHit: isLegacyLowYieldRisk(c.text, score),
    };
  });
}

const med = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const q = (xs: number[], p: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const round = (x: number, d = 1): number => Math.round(x * 10 ** d) / 10 ** d;

function describe(rows: Row[]) {
  const d = rows.map((r) => r.formalPer1k);
  return {
    n: rows.length,
    charsMin: Math.min(...rows.map((r) => r.chars)),
    charsMax: Math.max(...rows.map((r) => r.chars)),
    cjkMin: Math.min(...rows.map((r) => r.cjkChars)),
    densityMedian: round(med(d)),
    densityQ1: round(q(d, 0.25)),
    densityQ3: round(q(d, 0.75)),
    densityMin: round(Math.min(...d)),
    densityMax: round(Math.max(...d)),
    hitCount: rows.filter((r) => r.hit).length,
    hitRate: round((rows.filter((r) => r.hit).length / rows.length) * 100),
    legacyHitCount: rows.filter((r) => r.legacyHit).length,
    aiScoreMedian: round(med(rows.map((r) => r.aiScore))),
  };
}

/** AUC：h 的密度低于 a 的配对占比。0.5 = 无区分力，1 = 完全可分（h 全部更低） */
function auc(h: Row[], a: Row[]): number {
  let win = 0;
  let tie = 0;
  for (const x of h) {
    for (const y of a) {
      if (x.formalPer1k < y.formalPer1k) win++;
      else if (x.formalPer1k === y.formalPer1k) tie++;
    }
  }
  return round((win + tie / 2) / (h.length * a.length), 3);
}

/**
 * 长度分层：把长文按 `win` 字窗口取首段切片，看密度是否随窗口变化。
 * 用切片而不是真短文，是为了让「同一文本、只改长度」这一条对照成立；
 * 真正的短真人稿由 H-short 面板单独承担。
 */
function lengthStratified(rows: Row[], texts: Map<string, string>, windows: number[]) {
  return windows.map((w) => {
    const vals: number[] = [];
    for (const r of rows) {
      const t = texts.get(r.id) ?? "";
      if (t.length < w) continue;
      vals.push(lowYieldSignals(t.slice(0, w)).formalPer1k);
    }
    return {
      windowChars: w,
      sample: vals.length,
      densityMedian: round(med(vals)),
      densityQ1: round(q(vals, 0.25)),
      densityQ3: round(q(vals, 0.75)),
      hitRate: round((vals.filter((v) => v <= LOW_YIELD_FORMAL_PER_1K).length / vals.length) * 100),
    };
  });
}

function main(): void {
  const hShort = loadShortHuman();
  const hLong = loadLongHuman();
  const aiShort = loadAiShort();

  const longTexts = new Map<string, string>();
  for (const r of hLong) {
    const raw = readFileSync(path.join(ROOT, "artifacts", "human-corpus", `${r.id}.txt`), "utf8");
    longTexts.set(r.id, wikiBody(raw));
  }

  const panels = { hShort: describe(hShort), hLong: describe(hLong), aiShort: describe(aiShort) };
  const separation = {
    aucHShortVsAiShort: auc(hShort, aiShort),
    aucHLongVsAiShort: auc(hLong, aiShort),
    aucHShortVsHLong: auc(hShort, hLong),
    note: "AUC=0.5 抛硬币；越接近 1 表示前者密度系统性更低（= 判据把真人判为低收益、AI 稿判为可改，方向正确）",
  };

  // 同长度区间：只保留 150~460 字，两边严格可比
  const inBand = (r: Row) => r.chars >= 150 && r.chars <= 460;
  const bandH = hShort.filter(inBand);
  const bandA = aiShort.filter(inBand);
  const sameLength = {
    band: "150~460 字",
    hShort: { n: bandH.length, hitRate: round((bandH.filter((r) => r.hit).length / Math.max(1, bandH.length)) * 100), densityMedian: round(med(bandH.map((r) => r.formalPer1k))) },
    aiShort: { n: bandA.length, hitRate: round((bandA.filter((r) => r.hit).length / Math.max(1, bandA.length)) * 100), densityMedian: round(med(bandA.map((r) => r.formalPer1k))) },
    auc: auc(bandH, bandA),
  };

  const stratified = lengthStratified(hLong, longTexts, [400, 800, 1600, 3200]);

  // 判定：同长度区间里判据是否还有区分力
  const gap = sameLength.hShort.hitRate - sameLength.aiShort.hitRate;
  const verdict =
    sameLength.auc >= 0.7 && gap >= 30
      ? `同长度区间仍可分：AUC ${sameLength.auc}、真人短稿命中率高出 ${round(gap)} 个百分点 ⇒ 判据不是按长度筛，换成密度后泛化成立`
      : sameLength.auc >= 0.6
        ? `同长度区间区分力中等：AUC ${sameLength.auc}、命中率差 ${round(gap)} 个百分点 ⇒ 判据在短文本上不足以支撑默认拦截，开关保持默认关是对的`
        : `同长度区间基本不可分：AUC ${sameLength.auc}、命中率差 ${round(gap)} 个百分点 ⇒ 判据在短文本上接近抛硬币，` +
          `--skip-low-risk 在短稿上等于随机跳过；长文上的 57%→14% 只在长文成立`;

  const gaps = {
    longAiSamples: {
      status: "未实测",
      reason: "本机 LLM 网关 2026-11-09 不可达（127.0.0.1:8080 与 192.168.151.151:18080 均拒连），无法生成真实长 AI 稿",
      impact: "长 AI 稿密度未知；但判据是密度（长度归一），短稿密度不随长度衰减的假设已由 lengthStratified 在真人侧验证，AI 侧未验证",
    },
  };

  const report = {
    at: new Date().toISOString(),
    thresholdPer1k: LOW_YIELD_FORMAL_PER_1K,
    purpose: "P1-1 交叉长度语料检验：短真人稿是否也会被判为低收益风险，判据在同长度区间是否仍有区分力",
    corpora: {
      hShort: "artifacts/human-corpus-short/（中文维基短条目，scripts/collateral-cross-fetch.ts 抓，CC BY-SA 4.0）",
      hLong: "artifacts/human-corpus/（中文维基长条目，P1-1 no-touch 面板）",
      aiShort: "scripts/realcase/cases.json（P1-1 should-change 面板）",
    },
    panels,
    separation,
    sameLength,
    lengthStratified: stratified,
    gaps,
    verdict,
    rows: { hShort, hLong, aiShort },
  };

  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(path.join(EVIDENCE, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");

  console.log("══════ P1-1 交叉长度语料检验（只报告不门禁） ══════");
  console.log(`判据：formalPer1k <= ${LOW_YIELD_FORMAL_PER_1K}/千字\n`);
  console.log("面板\t\tn\t长度区间\t\t密度中位\t命中率\t旧判据命中\taiScore中位");
  for (const [k, label] of [["hShort", "H-short"], ["hLong", "H-long"], ["aiShort", "AI-short"]] as const) {
    const p = panels[k];
    console.log(
      `${label}\t\t${p.n}\t${p.charsMin}~${p.charsMax}\t\t${p.densityMedian}\t\t${p.hitRate}%\t${p.legacyHitCount}\t\t${p.aiScoreMedian}`,
    );
  }
  console.log(`\n同长度区间（${sameLength.band}）：真人短稿命中 ${sameLength.hShort.hitRate}%（n=${sameLength.hShort.n}） vs AI 短稿 ${sameLength.aiShort.hitRate}%（n=${sameLength.aiShort.n}） | AUC ${sameLength.auc}`);
  console.log(`AUC：H-short vs AI-short ${separation.aucHShortVsAiShort} / H-long vs AI-short ${separation.aucHLongVsAiShort}`);
  console.log("\n长度分层（H-long 首段切片，看密度是否随长度漂移）：");
  for (const s of stratified) console.log(`  ${String(s.windowChars).padStart(4)} 字窗口  n=${s.sample}  密度中位 ${s.densityMedian}  命中率 ${s.hitRate}%`);
  console.log(`\n判定：${verdict}`);
  console.log(`缺口：长 AI 稿 ${gaps.longAiSamples.status} —— ${gaps.longAiSamples.reason}`);
  console.log(`\n报告：${path.relative(ROOT, path.join(EVIDENCE, "report.json"))}`);
}

main();
