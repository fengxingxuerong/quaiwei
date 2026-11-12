/**
 * collateral-ai-long.ts —— P1-1 缺口收口：长 AI 稿密度实测（只报告，不门禁）
 *
 * ## 补的是什么缺口
 *
 * `evidence/collateral-cross-2026-11-09/` 自己写明的缺口：长 AI 稿这一象限未实测——
 * 「密度不随长度衰减」在真人侧已由 lengthStratified 验证，AI 侧只有定义层面论证。
 * 本脚本用本机 GLM 网关生成真实长 AI 稿（3 体裁 × 4 目标长度 = 12 篇），
 * 过同一把尺（lowYieldSignals / aiScore），回答一个问题：
 * **AI 稿的 formalPer1k 是否随长度增长而跌破 8/千字**——若跌破，`--skip-low-risk`
 * 会在长 AI 稿上误跳过；若稳定高于 8，判据在长 AI 稿上的行为就拿到了实测支撑。
 *
 * ## 用法
 *
 *   $env:QUAIWEI_API_KEY = "<网关 key>"
 *   npx tsx scripts/collateral-ai-long.ts                       # 生成 + 量测
 *   npx tsx scripts/collateral-ai-long.ts --reuse               # 已生成的稿子直接复用
 *   npx tsx scripts/collateral-ai-long.ts --base-url http://127.0.0.1:8080 --model glm-5.3-flash
 *
 * Key 只从 env 读，不打印、不落盘（与 eval-dual 同约定）。请求串行（避 429，同 eval-dual 口径）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lowYieldSignals, LOW_YIELD_FORMAL_PER_1K } from "../src/engine/low-yield";
import { aiScore } from "../src/engine/humanize-metrics";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS = path.join(ROOT, "artifacts", "ai-corpus-long");
/**
 * 证据目录：优先复用已有 `collateral-ai-long-*`（同一批语料重新分析时覆盖原报告，
 * 避免每跑一次多一份结论不同的文件），没有才按今天建。
 */
function resolveEvidenceDir(): string {
  const base = path.join(ROOT, "evidence");
  const existing = existsSync(base)
    ? readdirSync(base)
        .filter((d) => d.startsWith("collateral-ai-long-"))
        .sort()
    : [];
  const last = existing[existing.length - 1];
  return last ? path.join(base, last) : path.join(base, `collateral-ai-long-${new Date().toISOString().slice(0, 10)}`);
}
const EVIDENCE = resolveEvidenceDir();

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2);
const flagValue = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const BASE_URL = (flagValue("--base-url") ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const MODEL = flagValue("--model") ?? "glm-5.3-flash";
const REGEN = argv.includes("--regen");
const REUSE = argv.includes("--reuse") || !REGEN;
const API_KEY = process.env.QUAIWEI_API_KEY || process.env.QUAIWEI_EVAL_KEY_A || "";

/* ---------- 生成矩阵：3 体裁 × 4 目标长度 ---------- */
const GENRES: { key: string; label: string; topics: string[]; brief: string }[] = [
  {
    key: "wiki",
    label: "百科条目体（对齐 H-long 体裁）",
    brief: "维基百科条目风格的客观介绍，按主题-背景-发展-现状-影响的结构行文",
    topics: ["候鸟迁徙的导航机制", "中国古代驿传制度", "茶叶发酵工艺的分类", "城市地下管网的发展"],
  },
  {
    key: "mkt",
    label: "产品营销长文（对齐 AI-short 体裁）",
    brief: "面向普通消费者的产品长文案，有场景、有痛点、有卖点，语气自然",
    topics: ["一台智能保温杯的产品故事", "在线协作工具的团队效率长文", "扫地机器人的选购指南长文", "家用投影仪的体验长文"],
  },
  {
    key: "gov",
    label: "公文/技术方案体",
    brief: "正式的工作方案/技术方案文风，分点论述但以连贯段落为主",
    topics: ["老旧小区改造工作方案", "数据中台建设技术方案", "网络安全攻防演练总结报告", "乡村物流网点建设实施方案"],
  },
];
const TARGETS = [600, 1200, 2400, 4800];

/* ---------- 网关调用（OpenAI 兼容 /v1/chat/completions） ---------- */
interface ChatMsg {
  role: "system" | "user";
  content: string;
}

async function chat(messages: ChatMsg[], maxTokens: number): Promise<string> {
  if (!API_KEY) {
    console.error("✗ 未拿到网关 Key：请先 $env:QUAIWEI_API_KEY = \"<key>\"（只读 env，不落盘）");
    process.exit(1);
  }
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ model: MODEL, messages, temperature: 0.9, max_tokens: maxTokens }),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`✗ 网关 ${res.status}：${text.slice(0, 300)}`);
    process.exit(1);
  }
  const data = JSON.parse(text) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

/** 生成一篇：首轮按目标长度写，不足则串行续写（≤3 轮），合并后落盘 */
async function generateOne(genreLabel: string, brief: string, topic: string, target: number): Promise<string> {
  const sys = "你是中文写作者。直接输出正文，不解释，不使用任何 Markdown 标记。";
  let body = await chat(
    [
      { role: "system", content: sys },
      {
        role: "user",
        content:
          `写一篇约 ${target} 字的${genreLabel}，主题：${topic}。` +
          `要求：${brief}；连贯成段的自然行文，不用标题、不用列表、不用小标题；` +
          `不要出现「作为一个AI」之类的自我说明；只输出正文。`,
      },
    ],
    Math.min(target * 2, 8000),
  );
  for (let round = 1; round <= 3 && body.length < target * 0.8; round++) {
    const more = await chat(
      [
        { role: "system", content: sys },
        {
          role: "user",
          content:
            `继续写下面这篇稿子，从中断处自然接着写，不要重复已有内容，不要总结收尾，只输出新增正文：\n\n${body.slice(-800)}`,
        },
      ],
      Math.min(target * 2, 8000),
    );
    if (!more) break;
    body = `${body}\n${more}`;
  }
  return body.trim();
}

/* ---------- 量测（与 collateral-cross.ts 同一把尺） ---------- */
interface Row {
  id: string;
  genre: string;
  target: number;
  chars: number;
  cjkChars: number;
  formalHits: number;
  formalPer1k: number;
  aiScore: number;
  hit: boolean;
}

/**
 * 「该改」的代理判据：aiScore >= AI_MEANINGFUL_SCORE。
 *
 * 为什么必须分层（2026-11-12 补）：本批 12 篇是 LLM 生成的，aiScore 从 7 到 80，
 * 说明「AI 生成」≠「AI 味重」——GLM 按「语气自然」写出来的营销稿（mkt-1200）
 * aiScore 只有 7，`--skip-low-risk` 跳过它**不是误判**，是它本来就没有套话可删。
 * 不做这层区分，66.7% 的「误跳率」会把正确的跳过算成损失，结论直接反了。
 * 30 分是 P1-1 原有的探索性分界（旧判据用的就是 <=27），这里只作分层标签、不当门禁。
 */
const AI_MEANINGFUL_SCORE = 30;

const med = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (x: number, d = 1): number => Math.round(x * 10 ** d) / 10 ** d;

function measure(id: string, genre: string, target: number, text: string): Row {
  const sig = lowYieldSignals(text);
  return {
    id,
    genre,
    target,
    chars: text.length,
    cjkChars: sig.cjkChars,
    formalHits: sig.formalHits,
    formalPer1k: sig.formalPer1k,
    aiScore: aiScore(text).score,
    hit: sig.hit,
  };
}

/** H-long（真人长文）对照面板：同 collateral-cross.ts 的 loadLongHuman */
function loadHumanLong(): Row[] {
  const dir = path.join(ROOT, "artifacts", "human-corpus");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".txt") && !f.startsWith("_"))
    .sort()
    .map((f) => {
      const raw = readFileSync(path.join(dir, f), "utf8");
      const at = raw.indexOf("\n\n");
      const text = (at >= 0 ? raw.slice(at + 2) : raw).trim();
      return measure(f.replace(/\.txt$/, ""), "H-long", 0, text);
    });
}

/* ---------- 主流程 ---------- */
async function main(): Promise<void> {
  mkdirSync(CORPUS, { recursive: true });
  mkdirSync(EVIDENCE, { recursive: true });

  const rows: Row[] = [];
  for (const g of GENRES) {
    for (const target of TARGETS) {
      const id = `AI-LONG-${g.key}-${target}`;
      const file = path.join(CORPUS, `${id}.txt`);
      let text: string;
      if (REUSE && existsSync(file)) {
        const raw = readFileSync(file, "utf8");
        const at = raw.indexOf("\n\n");
        text = (at >= 0 ? raw.slice(at + 2) : raw).trim();
        console.log(`  ↺ 复用 ${id}（${text.length} 字）`);
      } else {
        const topic = g.topics[TARGETS.indexOf(target)] ?? g.topics[0];
        console.log(`  ✎ 生成 ${id}（${g.label}，目标 ${target} 字，主题：${topic}）…`);
        text = await generateOne(g.label.split("（")[0], g.brief, topic, target);
        const header =
          `来源：本机 GLM 网关（${BASE_URL}，模型 ${MODEL}）\n` +
          `体裁：${g.label}\n` +
          `目标长度：${target} 字；主题：${topic}\n` +
          `生成时间：${new Date().toISOString()}\n\n`;
        writeFileSync(file, header + text + "\n", "utf8");
        console.log(`    → ${text.length} 字`);
      }
      rows.push(measure(id, g.key, target, text));
    }
  }

  const humanLong = loadHumanLong();

  /* 按目标长度分层：AI 侧密度是否随长度衰减（本次实测的核心问题） */
  const bands = TARGETS.map((t) => {
    const rs = rows.filter((r) => r.target === t);
    return {
      targetChars: t,
      n: rs.length,
      charsMin: Math.min(...rs.map((r) => r.chars)),
      charsMax: Math.max(...rs.map((r) => r.chars)),
      densityMedian: round(med(rs.map((r) => r.formalPer1k))),
      densityMin: round(Math.min(...rs.map((r) => r.formalPer1k))),
      hitCount: rs.filter((r) => r.hit).length,
      hitRate: round((rs.filter((r) => r.hit).length / rs.length) * 100),
      aiScoreMedian: round(med(rs.map((r) => r.aiScore))),
    };
  });

  const overall = {
    n: rows.length,
    densityMedian: round(med(rows.map((r) => r.formalPer1k))),
    densityMin: round(Math.min(...rows.map((r) => r.formalPer1k))),
    hitCount: rows.filter((r) => r.hit).length,
    hitRate: round((rows.filter((r) => r.hit).length / rows.length) * 100),
  };
  const hLongStats = humanLong.length
    ? {
        n: humanLong.length,
        densityMedian: round(med(humanLong.map((r) => r.formalPer1k))),
        hitRate: round((humanLong.filter((r) => r.hit).length / humanLong.length) * 100),
      }
    : null;

  /* 判定一：密度是否随长度衰减（本次实测的原始问题） */
  const lowBands = bands.filter((b) => b.densityMedian <= LOW_YIELD_FORMAL_PER_1K);

  /* 判定二：按 AI 味强度分层后的真实误跳（2026-11-12 补，这才是「损失」） */
  const meaningful = rows.filter((r) => r.aiScore >= AI_MEANINGFUL_SCORE);
  const meaningfulSkipped = meaningful.filter((r) => r.hit);
  const faint = rows.filter((r) => r.aiScore < AI_MEANINGFUL_SCORE);
  const faintSkipped = faint.filter((r) => r.hit);
  const layered = {
    aiMeaningfulScoreCut: AI_MEANINGFUL_SCORE,
    meaningful: {
      n: meaningful.length,
      skipped: meaningfulSkipped.length,
      skippedIds: meaningfulSkipped.map((r) => r.id),
      falseSkipRate: round((meaningfulSkipped.length / Math.max(1, meaningful.length)) * 100),
    },
    faint: {
      n: faint.length,
      skipped: faintSkipped.length,
      note: "aiScore 低于分界的稿本来就没什么套话可删，跳过不算损失",
    },
  };

  const verdict =
    (lowBands.length
      ? `${lowBands.map((b) => `${b.targetChars} 字档（密度中位 ${b.densityMedian}）`).join("、")} 密度中位跌破阈值 ${LOW_YIELD_FORMAL_PER_1K}/千字，` +
        `AI 稿密度确实随长度衰减（短 AI 稿中位 12.5，本批 12 篇中位 ${overall.densityMedian}）。`
      : `全部 ${bands.length} 个长度档密度中位都 > ${LOW_YIELD_FORMAL_PER_1K}/千字（最低 ${overall.densityMin}）。`) +
    `但把「AI 生成」当「该改」是错的：只有 aiScore>=${AI_MEANINGFUL_SCORE} 的 ${meaningful.length} 篇才算有套话可删，` +
    `其中被误跳 ${meaningfulSkipped.length} 篇（${layered.meaningful.falseSkipRate}%，${meaningfulSkipped.map((r) => `${r.id}(aiScore ${r.aiScore}/密度 ${r.formalPer1k})`).join("、") || "无"}）；` +
    `其余 ${faint.length} 篇 aiScore<${AI_MEANINGFUL_SCORE}，跳过属正确行为。` +
    `长文象限里 AI 稿密度中位 ${overall.densityMedian} 与真人长文 ${hLongStats?.densityMedian ?? "?"} 几乎重叠 ⇒ ` +
    `密度判据在长文上分不出人与 AI，但对「套话已被写得很薄」的稿确实会误跳高 aiScore 样本。` +
    `结论不变：--skip-low-risk 继续默认关。`;

  const report = {
    at: new Date().toISOString(),
    thresholdPer1k: LOW_YIELD_FORMAL_PER_1K,
    purpose: "P1-1 缺口收口：长 AI 稿密度实测——formalPer1k 是否随长度增长跌破阈值（补 collateral-cross-2026-11-09 的未实测象限）",
    gateway: { baseUrl: BASE_URL, model: MODEL, keySource: "env:QUAIWEI_API_KEY（不落盘）" },
    corpora: {
      aiLong: "artifacts/ai-corpus-long/（本机 GLM 网关生成，3 体裁 × 4 目标长度）",
      hLong: "artifacts/human-corpus/（中文维基长条目，对照面板）",
    },
    overall,
    hLong: hLongStats,
    bands,
    byAiScore: layered,
    verdict,
    rows,
  };
  writeFileSync(path.join(EVIDENCE, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");

  console.log("\n══════ P1-1 长 AI 稿密度实测（只报告不门禁） ══════");
  console.log(`判据：formalPer1k <= ${LOW_YIELD_FORMAL_PER_1K}/千字 模型：${MODEL} @ ${BASE_URL}\n`);
  console.log("目标档\t\tn\t实际长度\t\t密度中位\t密度min\t命中\taiScore中位");
  for (const b of bands) {
    console.log(
      `${b.targetChars} 字\t\t${b.n}\t${b.charsMin}~${b.charsMax}\t\t${b.densityMedian}\t\t${b.densityMin}\t${b.hitCount}/${b.n}\t${b.aiScoreMedian}`,
    );
  }
  if (hLongStats) {
    console.log(
      `\n对照 H-long（真人长文）：n=${hLongStats.n}，密度中位 ${hLongStats.densityMedian}，命中 ${hLongStats.hitRate}%`,
    );
  }
  console.log(`\nAI-long 总体：n=${overall.n}，密度中位 ${overall.densityMedian}，命中 ${overall.hitCount}/${overall.n}（${overall.hitRate}%）`);
  console.log(`\n按 AI 味强度分层（aiScore 分界 ${AI_MEANINGFUL_SCORE}）：`);
  console.log(`  有套话可删（>=${AI_MEANINGFUL_SCORE}）：n=${layered.meaningful.n}，误跳 ${layered.meaningful.skipped} 篇（${layered.meaningful.falseSkipRate}%）`);
  for (const r of meaningfulSkipped) console.log(`    ✗ ${r.id}  aiScore ${r.aiScore}  密度 ${r.formalPer1k}`);
  console.log(`  套话已稀薄（<${AI_MEANINGFUL_SCORE}）：n=${layered.faint.n}，跳过 ${layered.faint.skipped} 篇（属正确行为）`);
  console.log(`判定：${verdict}`);
  console.log(`\n报告：${path.relative(ROOT, path.join(EVIDENCE, "report.json"))}`);
  console.log(`语料：${path.relative(ROOT, CORPUS)}\\`);
}

main().catch((e) => {
  console.error(`✗ ${e?.message ?? e}`);
  process.exit(1);
});
