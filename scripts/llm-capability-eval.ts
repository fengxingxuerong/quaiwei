import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chat } from "../src/api/llm-chat.ts";
import { buildSystemPrompt } from "../src/api/llm-humanize.ts";
import { splitKeys, type ApiConfig } from "../src/api/llm-config.ts";
import { llmOutputIssues } from "../src/api/llm-output-guard.ts";
import { enforceLlmOutputGuard } from "../src/api/llm.ts";
import { aiScore } from "../src/engine/humanize-metrics.ts";
import { hardFidelityIssues } from "./open-source-humanizer-checks.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argOf = (name: string, fallback: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const FIXTURES = path.resolve(
  argOf("fixtures", path.join(ROOT, "scripts/fixtures/llm-capability")),
);
const OUT = path.resolve(argOf("out", path.join(ROOT, "evidence/llm-capability-2026-11-25")));
const RESULTS = path.join(OUT, "writes.jsonl");
const MODEL = argOf("model", "glm-5.3");
const PROMPT_MODE = argOf("prompt-mode", "concise");
const INTENSITY = Number(argOf("intensity", "0.9"));
const STYLE = argOf("style", "plain") as ApiConfig["style"];
const DELAY_MS = Math.max(0, Number(argOf("delay-ms", "30000")) || 0);
const LIMIT = Math.max(0, Number(argOf("limit", "0")) || 0);
const OFFSET = Math.max(0, Number(argOf("offset", "0")) || 0);
const TOKEN_ARG = argOf("max-tokens", "auto");
const RETRY = args.includes("--retry-failures");
const SUMMARIZE = args.includes("--summarize-only");
const REPLAY_FROM = argOf("replay-from", "");
const REPAIR_FROM = argOf("repair-from", "");
const IDS = argOf("ids", "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

interface Sample {
  id: string;
  source: string;
  kind: string;
  language: string;
  genre: string;
  text: string;
  sourcePath: string;
  sha256: string;
}

interface WriteRow {
  key: string;
  id: string;
  source: string;
  kind: string;
  language: string;
  genre: string;
  model: string;
  promptMode: string;
  intensity: number;
  style: string;
  maxTokens: number;
  status: "ok" | "api-failure";
  input: string;
  output: string;
  rawOutput?: string;
  rawHardIssues?: string[];
  guardIssues?: string[];
  repairAttempted?: boolean;
  repaired?: boolean;
  repairError?: string;
  repairLatencyMs?: number;
  engine?: "llm" | "passthrough";
  error?: string;
  latencyMs: number;
  reasoningLength: number;
  charsIn: number;
  charsOut: number;
  changedRatio: number;
  localScoreIn: number;
  localScoreOut: number;
  localDelta: number;
  aiIsmsIn: number;
  aiIsmsOut: number;
  hardIssues: string[];
  warnings: string[];
}

const CONCISE_PROMPT = [
  "你是文本去味编辑。删除套话、空泛过渡、机械排比和夸张措辞，使文字自然、具体、简洁。",
  "必须保持输入语言，不得翻译。必须保留事实、数字、单位、日期、人名、引语、代码、URL、标题、YAML、表格和链接目标。",
  "不得新增原文没有的 claims、例子、数据或观点。保留作者语气、否定、条件、归因和完成状态。",
  "只输出改写后的全文，不解释。",
].join("\n");
const AI_ISM_PATTERNS = [
  /absolutely/gi,
  /great question/gi,
  /let's dive in/gi,
  /in today's [^.!?]{0,40}/gi,
  /it's important to note/gi,
  /it's worth mentioning/gi,
  /in essence/gi,
  /generally speaking/gi,
  /pivotal/gi,
  /comprehensive/gi,
  /seamless/gi,
  /robust/gi,
  /cutting-edge/gi,
  /holistic/gi,
  /leverage/gi,
  /delve/gi,
  /testament/gi,
  /buckle up/gi,
];
const countAiIsms = (text: string) =>
  AI_ISM_PATTERNS.reduce((total, pattern) => total + (text.match(pattern)?.length ?? 0), 0);
const cjkRatio = (text: string) => {
  const visible = text.replace(/\s/g, "");
  return visible.length ? (text.match(/[\u3400-\u9fff]/g)?.length ?? 0) / visible.length : 0;
};
const autoTokens = (text: string) => (text.length <= 900 ? 1024 : 2048);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const keyRaw =
  process.env.QUAIWEI_LLM_KEYS?.trim() ||
  process.env.SENSENOVA_KEYS?.trim() ||
  (fs.existsSync(path.join(ROOT, "scripts/.sensenova-keys"))
    ? fs.readFileSync(path.join(ROOT, "scripts/.sensenova-keys"), "utf8").trim()
    : "");
const keys = splitKeys(keyRaw);
if (!keys.length && !REPLAY_FROM) throw new Error("没有可用 Key");
if (!["concise", "full"].includes(PROMPT_MODE)) throw new Error("prompt-mode 必须 concise/full");
if (![0.6, 0.9, 1].includes(INTENSITY)) throw new Error("intensity 仅支持 0.6/0.9/1");
if (!["plain", "academic", "casual"].includes(STYLE)) throw new Error("style 非法");

const cfg: ApiConfig = {
  enabled: true,
  baseUrl: argOf("base-url", process.env.QUAIWEI_LLM_BASE_URL || "https://token.sensenova.cn/v1"),
  apiKey: keys[0] ?? "",
  apiKeys: keyRaw,
  model: MODEL,
  temperature: 0.9,
  deepMode: false,
  judgeModel: "",
  altModel: "",
  contestSamples: 1,
  style: STYLE,
  maxWaitSeconds: 180,
  maxApiCalls: 0,
  requestTimeoutMs: 180_000,
};
const samples = fs
  .readFileSync(path.join(FIXTURES, "samples.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as Sample);
for (const sample of samples) {
  const digest = createHash("sha256").update(sample.text, "utf8").digest("hex");
  if (digest !== sample.sha256) throw new Error(`样本哈希不一致：${sample.id}`);
}
const rowKey = (sample: Sample) => [MODEL, PROMPT_MODE, INTENSITY, STYLE, sample.id].join("|");

fs.mkdirSync(OUT, { recursive: true });
const latest = new Map<string, WriteRow>();
if (fs.existsSync(RESULTS)) {
  for (const line of fs.readFileSync(RESULTS, "utf8").split("\n").filter(Boolean)) {
    const row = JSON.parse(line) as WriteRow;
    latest.set(row.key, row);
  }
}
if (REPLAY_FROM || REPAIR_FROM) {
  const sourcePath = REPAIR_FROM || REPLAY_FROM;
  const sourceRows = fs
    .readFileSync(path.resolve(sourcePath), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as WriteRow);
  const sourceById = new Map(sourceRows.map((row) => [row.id, row]));
  for (const sample of samples) {
    const source = sourceById.get(sample.id);
    if (!source || source.model !== MODEL || source.status !== "ok")
      throw new Error(`回放源缺少成功样本：${sample.id}`);
    if (source.input !== sample.text) throw new Error(`回放源输入与冻结样本不一致：${sample.id}`);
    const rawOutput = source.rawOutput ?? source.output;
    const rawHardIssues = hardFidelityIssues(sample.text, rawOutput);
    const repairStartedAt = Date.now();
    const guarded = REPAIR_FROM
      ? await enforceLlmOutputGuard(sample.text, rawOutput, cfg, INTENSITY)
      : (() => {
          const issues = llmOutputIssues(sample.text, rawOutput);
          return {
            text: issues.length ? sample.text : rawOutput,
            issues,
            initialIssues: issues,
            repaired: false,
            repairError: undefined,
          };
        })();
    const repairLatencyMs = REPAIR_FROM ? Date.now() - repairStartedAt : 0;
    const guardIssues = guarded.initialIssues;
    const output = guarded.text;
    latest.set(rowKey(sample), {
      ...source,
      key: rowKey(sample),
      input: sample.text,
      output,
      rawOutput,
      rawHardIssues,
      guardIssues,
      repairAttempted: Boolean(REPAIR_FROM && guardIssues.length),
      repaired: guarded.repaired,
      repairError: guarded.repairError,
      repairLatencyMs,
      engine: guarded.issues.length ? "passthrough" : "llm",
      charsOut: output.length,
      changedRatio: Number(
        (sample.text.length ? output.length / sample.text.length : 0).toFixed(3),
      ),
      localScoreIn: aiScore(sample.text).score,
      localScoreOut: aiScore(output).score,
      localDelta: aiScore(output).score - aiScore(sample.text).score,
      aiIsmsIn: countAiIsms(sample.text),
      aiIsmsOut: countAiIsms(output),
      hardIssues: guardIssues.length ? [] : rawHardIssues,
    });
  }
  fs.writeFileSync(
    RESULTS,
    [...latest.values()].map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
}
const candidates = IDS.length
  ? IDS.map((id) => samples.find((sample) => sample.id === id)).filter((sample): sample is Sample =>
      Boolean(sample),
    )
  : RETRY
    ? samples.filter((sample) => latest.get(rowKey(sample))?.status !== "ok")
    : samples;
const pending =
  SUMMARIZE || REPLAY_FROM || REPAIR_FROM
    ? []
    : candidates.slice(OFFSET, LIMIT ? OFFSET + LIMIT : undefined);
let completed = 0;
for (const sample of pending) {
  const key = rowKey(sample);
  if (latest.get(key)?.status === "ok") continue;
  const maxTokens = TOKEN_ARG === "auto" ? autoTokens(sample.text) : Number(TOKEN_ARG);
  if (!Number.isFinite(maxTokens) || maxTokens < 512)
    throw new Error("max-tokens 必须 ≥512 或 auto");
  const startedAt = Date.now();
  let row: WriteRow;
  try {
    const response = await chat(
      cfg,
      [
        {
          role: "system",
          content:
            PROMPT_MODE === "full"
              ? buildSystemPrompt(cfg, INTENSITY, sample.text)
              : CONCISE_PROMPT,
        },
        { role: "user", content: sample.text },
      ],
      { temperature: 0.9, maxTokens },
    );
    if (!response.content.trim()) {
      throw new Error(`模型未返回正文（reasoning ${response.reasoning.length} 字符）`);
    }
    const issues = hardFidelityIssues(sample.text, response.content);
    const warnings: string[] = [];
    if (sample.language === "en") {
      const inputLatin = sample.text.match(/[A-Za-z]/g)?.length ?? 0;
      const inputCjk = sample.text.match(/[\u3400-\u9fff]/g)?.length ?? 0;
      if (inputLatin > inputCjk * 2 && cjkRatio(response.content) > 0.1) {
        issues.push("language-drift:en-to-zh");
      }
    } else if (cjkRatio(response.content) < 0.15) {
      issues.push("language-drift:zh-to-en");
    }
    const ratio = sample.text.length ? response.content.length / sample.text.length : 0;
    if (sample.kind === "human" && (ratio < 0.55 || ratio > 1.8)) {
      warnings.push(`human-over-edit:ratio=${ratio.toFixed(2)}`);
    }
    if (sample.id === "zh-semantic/conditional_launch") {
      for (const rule of [
        /如果/,
        /并且|且/,
        /周五/,
        /条件.{0,4}(?:不满足|不对上|未满足)/,
        /继续使用旧站/,
        /审阅完成不代表|审阅完成.{0,5}不代表/,
        /只读/,
        /暂不/,
      ]) {
        if (!rule.test(response.content)) issues.push(`semantic-rule:${rule.source}`);
      }
    }
    const guardIssues = llmOutputIssues(sample.text, response.content);
    const delivered = guardIssues.length ? sample.text : response.content;
    const deliveredIssues = guardIssues.length ? [] : issues;
    const deliveredRatio = sample.text.length ? delivered.length / sample.text.length : 0;
    row = {
      key,
      id: sample.id,
      source: sample.source,
      kind: sample.kind,
      language: sample.language,
      genre: sample.genre,
      model: MODEL,
      promptMode: PROMPT_MODE,
      intensity: INTENSITY,
      style: STYLE,
      maxTokens,
      status: "ok",
      input: sample.text,
      output: delivered,
      rawOutput: response.content,
      rawHardIssues: issues,
      guardIssues,
      engine: guardIssues.length ? "passthrough" : "llm",
      latencyMs: Date.now() - startedAt,
      reasoningLength: response.reasoning.length,
      charsIn: sample.text.length,
      charsOut: delivered.length,
      changedRatio: Number(deliveredRatio.toFixed(3)),
      localScoreIn: aiScore(sample.text).score,
      localScoreOut: aiScore(delivered).score,
      localDelta: aiScore(delivered).score - aiScore(sample.text).score,
      aiIsmsIn: countAiIsms(sample.text),
      aiIsmsOut: countAiIsms(delivered),
      hardIssues: deliveredIssues,
      warnings,
    };
  } catch (error) {
    row = {
      key,
      id: sample.id,
      source: sample.source,
      kind: sample.kind,
      language: sample.language,
      genre: sample.genre,
      model: MODEL,
      promptMode: PROMPT_MODE,
      intensity: INTENSITY,
      style: STYLE,
      maxTokens,
      status: "api-failure",
      input: sample.text,
      output: "",
      error: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - startedAt,
      reasoningLength: 0,
      charsIn: sample.text.length,
      charsOut: 0,
      changedRatio: 0,
      localScoreIn: aiScore(sample.text).score,
      localScoreOut: 0,
      localDelta: 0,
      aiIsmsIn: countAiIsms(sample.text),
      aiIsmsOut: 0,
      hardIssues: ["api-failure"],
      warnings: [],
    };
  }
  latest.set(key, row);
  fs.appendFileSync(RESULTS, JSON.stringify(row) + "\n");
  completed++;
  console.log(
    `${row.status === "ok" ? "✅" : "❌"} ${MODEL} · ${sample.id} · ${row.latencyMs}ms · ` +
      `local ${row.localScoreIn}→${row.localScoreOut} · 问题 ${row.hardIssues.join("|") || "无"}`,
  );
  if (completed < pending.length && DELAY_MS) await sleep(DELAY_MS);
}

const rows = [...latest.values()];
const okRows = rows.filter((row) => row.status === "ok");
const average = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const groupSummary = (group: WriteRow[]) => {
  const ok = group.filter((row) => row.status === "ok");
  return {
    runs: group.length,
    apiSuccess: ok.length,
    apiFailure: group.length - ok.length,
    hardFailures: ok.filter((row) => row.hardIssues.length > 0).length,
    rawHardFailures: ok.filter((row) => (row.rawHardIssues ?? row.hardIssues).length > 0).length,
    guardAttempts: ok.filter((row) => row.repairAttempted).length,
    guardRepairs: ok.filter((row) => row.repaired).length,
    guardFallbacks: ok.filter((row) => (row.guardIssues?.length ?? 0) > 0 && !row.repaired).length,
    avgRepairLatencyMs: Math.round(
      average(ok.filter((row) => row.repairAttempted).map((row) => row.repairLatencyMs ?? 0)),
    ),
    effectiveRewrites: ok.filter((row) => row.output !== row.input).length,
    hardFailurePct: ok.length
      ? Number(
          ((100 * ok.filter((row) => row.hardIssues.length > 0).length) / ok.length).toFixed(2),
        )
      : 0,
    avgLatencyMs: Math.round(average(ok.map((row) => row.latencyMs))),
    avgLocalDelta: Number(average(ok.map((row) => row.localDelta)).toFixed(1)),
    avgAiIsmsIn: Number(average(ok.map((row) => row.aiIsmsIn)).toFixed(1)),
    avgAiIsmsOut: Number(average(ok.map((row) => row.aiIsmsOut)).toFixed(1)),
    humanOverEditWarnings: ok.filter((row) =>
      row.warnings.some((w) => w.startsWith("human-over-edit")),
    ).length,
  };
};
const byModel = Object.fromEntries(
  [...new Set(rows.map((row) => row.model))].map((model) => [
    model,
    groupSummary(rows.filter((row) => row.model === model)),
  ]),
);
const byLanguage = Object.fromEntries(
  [...new Set(rows.map((row) => row.language))].map((language) => [
    language,
    groupSummary(rows.filter((row) => row.language === language)),
  ]),
);
const byKind = Object.fromEntries(
  [...new Set(rows.map((row) => row.kind))].map((kind) => [
    kind,
    groupSummary(rows.filter((row) => row.kind === kind)),
  ]),
);
const issueCounts: Record<string, number> = {};
const rawIssueCounts: Record<string, number> = {};
for (const row of okRows) {
  for (const issue of row.hardIssues) {
    const reason = issue.split(":")[0];
    issueCounts[reason] = (issueCounts[reason] ?? 0) + 1;
  }
  for (const issue of row.rawHardIssues ?? row.hardIssues) {
    const reason = issue.split(":")[0];
    rawIssueCounts[reason] = (rawIssueCounts[reason] ?? 0) + 1;
  }
}
const summary = {
  generatedAt: new Date().toISOString(),
  baseUrl: cfg.baseUrl,
  replayFrom: REPLAY_FROM || null,
  repairFrom: REPAIR_FROM || null,
  keyCount: REPLAY_FROM ? 0 : keys.length,
  samples: samples.length,
  conditionCount: rows.length,
  byModel,
  byLanguage,
  byKind,
  issueCounts,
  rawIssueCounts,
  failures: okRows
    .filter((row) => row.hardIssues.length > 0)
    .map((row) => ({
      key: row.key,
      id: row.id,
      model: row.model,
      language: row.language,
      kind: row.kind,
      issues: row.hardIssues,
      warnings: row.warnings,
      output: row.output,
    })),
};
fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(
  JSON.stringify(
    {
      samples: samples.length,
      conditionCount: rows.length,
      byModel,
      byLanguage,
      byKind,
      issueCounts,
      rawIssueCounts,
    },
    null,
    2,
  ),
);
process.exitCode =
  rows.length < samples.length ||
  rows.some((row) => row.status !== "ok") ||
  okRows.some((row) => row.hardIssues.length > 0)
    ? 1
    : 0;
