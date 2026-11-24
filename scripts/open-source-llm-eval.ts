import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chat } from "../src/api/llm-chat.ts";
import { buildSystemPrompt } from "../src/api/llm-humanize.ts";
import { splitKeys, type ApiConfig } from "../src/api/llm-config.ts";
import { aiScore } from "../src/engine/humanize-metrics.ts";
import { hardFidelityIssues } from "./open-source-humanizer-checks.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(ROOT, "scripts/fixtures/open-source-llm");
const OUT = path.join(ROOT, "evidence/open-source-llm-2026-11-25");
const RESULTS = path.join(OUT, "results.jsonl");
const args = process.argv.slice(2);
const argOf = (name: string, fallback: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const DELAY_MS = Math.max(0, Number(argOf("delay-ms", "20000")) || 0);
const LIMIT = Math.max(0, Number(argOf("limit", "0")) || 0);
const OFFSET = Math.max(0, Number(argOf("offset", "0")) || 0);
const PROMPT_MODE = argOf("prompt-mode", "full");
const MAX_TOKENS = Number(argOf("max-tokens", PROMPT_MODE === "concise" ? "4096" : "8192"));
const MODEL = argOf("model", "sensenova-6.8-flash-lite");
const BASE_URL = argOf("base-url", "https://token.sensenova.cn/v1");

interface Sample {
  id: string;
  source: string;
  kind: string;
  sourcePath: string;
  sha256: string;
  text: string;
}

interface ResultRow {
  id: string;
  source: string;
  kind: string;
  model: string;
  promptMode: string;
  maxTokens: number;
  status: "ok" | "api-failure";
  input: string;
  output: string;
  reasoning: string;
  error?: string;
  charsIn: number;
  charsOut: number;
  changedRatio: number;
  localScoreIn: number;
  localScoreOut: number;
  aiIsmsIn: number;
  aiIsmsOut: number;
  hardIssues: string[];
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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const keyRaw =
  process.env.SENSENOVA_KEYS?.trim() ||
  (fs.existsSync(path.join(ROOT, "scripts/.sensenova-keys"))
    ? fs.readFileSync(path.join(ROOT, "scripts/.sensenova-keys"), "utf8").trim()
    : "");
const keys = splitKeys(keyRaw);
if (!keys.length) throw new Error("没有可用 Key：SENSENOVA_KEYS 或 scripts/.sensenova-keys");
if (!Number.isFinite(MAX_TOKENS) || MAX_TOKENS < 512) throw new Error("max-tokens 必须 ≥512");

const cfg: ApiConfig = {
  enabled: true,
  baseUrl: BASE_URL,
  apiKey: keys[0],
  apiKeys: keyRaw,
  model: MODEL,
  temperature: 0.9,
  deepMode: false,
  judgeModel: "",
  altModel: "",
  contestSamples: 1,
  style: "plain",
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

fs.mkdirSync(OUT, { recursive: true });
const previous = new Map<string, ResultRow>();
const allPrevious = new Map<string, ResultRow>();
if (fs.existsSync(RESULTS)) {
  for (const line of fs.readFileSync(RESULTS, "utf8").split("\n").filter(Boolean)) {
    const row = JSON.parse(line) as ResultRow;
    allPrevious.set(row.id, row);
    if (row.status === "ok") previous.set(row.id, row);
  }
}
const retryFailures = args.includes("--retry-failures");
const summarizeOnly = args.includes("--summarize-only");
const candidates = retryFailures
  ? samples.filter((sample) => allPrevious.get(sample.id)?.status !== "ok")
  : samples;
const pending = summarizeOnly ? [] : candidates.slice(OFFSET, LIMIT ? OFFSET + LIMIT : undefined);
let completed = 0;
for (const sample of pending) {
  if (previous.has(sample.id)) {
    console.log(`跳过已完成：${sample.id}`);
    continue;
  }
  const startedAt = Date.now();
  let row: ResultRow;
  try {
    const response = await chat(
      cfg,
      [
        {
          role: "system",
          content:
            PROMPT_MODE === "concise" ? CONCISE_PROMPT : buildSystemPrompt(cfg, 0.9, sample.text),
        },
        { role: "user", content: sample.text },
      ],
      { temperature: 0.9, maxTokens: MAX_TOKENS },
    );
    if (!response.content.trim()) {
      throw new Error(`模型未返回正文（reasoning ${response.reasoning.length} 字符）`);
    }
    const issues = hardFidelityIssues(sample.text, response.content);
    const inputLatin = sample.text.match(/[A-Za-z]/g)?.length ?? 0;
    const inputCjk = sample.text.match(/[\u3400-\u9fff]/g)?.length ?? 0;
    if (inputLatin > inputCjk * 2 && cjkRatio(response.content) > 0.1) {
      issues.push("language-drift:en-to-zh");
    }
    row = {
      id: sample.id,
      source: sample.source,
      kind: sample.kind,
      model: MODEL,
      promptMode: PROMPT_MODE,
      maxTokens: MAX_TOKENS,
      status: "ok",
      input: sample.text,
      output: response.content,
      reasoning: response.reasoning,
      charsIn: sample.text.length,
      charsOut: response.content.length,
      changedRatio: sample.text.length
        ? Number((response.content.length / sample.text.length).toFixed(3))
        : 0,
      localScoreIn: aiScore(sample.text).score,
      localScoreOut: aiScore(response.content).score,
      aiIsmsIn: countAiIsms(sample.text),
      aiIsmsOut: countAiIsms(response.content),
      hardIssues: issues,
    };
  } catch (error) {
    row = {
      id: sample.id,
      source: sample.source,
      kind: sample.kind,
      model: MODEL,
      promptMode: PROMPT_MODE,
      maxTokens: MAX_TOKENS,
      status: "api-failure",
      input: sample.text,
      output: "",
      reasoning: "",
      error: error instanceof Error ? error.message : String(error),
      charsIn: sample.text.length,
      charsOut: 0,
      changedRatio: 0,
      localScoreIn: aiScore(sample.text).score,
      localScoreOut: 0,
      aiIsmsIn: countAiIsms(sample.text),
      aiIsmsOut: 0,
      hardIssues: ["api-failure"],
    };
  }
  previous.set(sample.id, row);
  allPrevious.set(sample.id, row);
  fs.appendFileSync(RESULTS, JSON.stringify(row) + "\n");
  completed++;
  console.log(
    `${row.status === "ok" ? "✅" : "❌"} ${sample.id} · ${Date.now() - startedAt}ms · ` +
      `AI-isms ${row.aiIsmsIn}→${row.aiIsmsOut} · 问题 ${row.hardIssues.join("|") || "无"}`,
  );
  if (completed < pending.length && DELAY_MS) await sleep(DELAY_MS);
}

const rows = samples
  .map((sample) => allPrevious.get(sample.id))
  .filter((row): row is ResultRow => Boolean(row));
const okRows = rows.filter((row) => row.status === "ok");
const hardRows = okRows.filter((row) => row.hardIssues.length > 0);
const byKind = new Map<string, ResultRow[]>();
for (const row of okRows) {
  const group = byKind.get(row.kind) ?? [];
  group.push(row);
  byKind.set(row.kind, group);
}
const average = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const summary = {
  generatedAt: new Date().toISOString(),
  model: MODEL,
  baseUrl: BASE_URL,
  keyCount: keys.length,
  maxTokens: MAX_TOKENS,
  promptModes: [...new Set(rows.map((row) => row.promptMode ?? "full"))],
  prompt: "full=QuAiWei buildSystemPrompt; concise=相同保真约束的短提示词；均无深度闭环/LLM 评委",
  samples: samples.length,
  completed: rows.length,
  apiSuccess: okRows.length,
  apiFailure: rows.length - okRows.length,
  hardFailureRows: hardRows.length,
  hardFailurePct: okRows.length ? Number(((100 * hardRows.length) / okRows.length).toFixed(2)) : 0,
  byKind: Object.fromEntries(
    [...byKind.entries()].map(([kind, group]) => [
      kind,
      {
        runs: group.length,
        avgAiIsmsIn: Number(average(group.map((row) => row.aiIsmsIn)).toFixed(1)),
        avgAiIsmsOut: Number(average(group.map((row) => row.aiIsmsOut)).toFixed(1)),
        avgChangedRatio: Number(average(group.map((row) => row.changedRatio)).toFixed(3)),
        hardFailures: group.filter((row) => row.hardIssues.length > 0).length,
      },
    ]),
  ),
  failures: hardRows.map((row) => ({
    id: row.id,
    kind: row.kind,
    issues: row.hardIssues,
    output: row.output,
  })),
};
fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
process.exitCode =
  rows.length < samples.length || summary.apiFailure > 0 || hardRows.length > 0 ? 1 : 0;
