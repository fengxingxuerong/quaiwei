import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chat } from "../src/api/llm-chat.ts";
import { splitKeys, type ApiConfig } from "../src/api/llm-config.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argOf = (name: string, fallback: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const OUT = path.resolve(argOf("out", path.join(ROOT, "evidence/llm-capability-2026-11-25")));
const WRITES = path.resolve(argOf("writes", path.join(OUT, "writes.jsonl")));
const RESULTS = path.join(OUT, "judges.jsonl");
const MODEL = argOf("model", "sensenova-6.8-flash");
const DELAY_MS = Math.max(0, Number(argOf("delay-ms", "30000")) || 0);
const MAX_TOKENS = Number(argOf("max-tokens", "1024"));
const LIMIT = Math.max(0, Number(argOf("limit", "0")) || 0);
const OFFSET = Math.max(0, Number(argOf("offset", "0")) || 0);
const IDS = argOf("ids", "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const INCLUDE_SELF = args.includes("--include-self");
const SUMMARIZE = args.includes("--summarize-only");

interface WriteRow {
  key: string;
  id: string;
  model: string;
  status: "ok" | "api-failure";
  input: string;
  output: string;
  kind: string;
  language: string;
}
interface JudgeRow {
  key: string;
  writeKey: string;
  id: string;
  writerModel: string;
  judgeModel: string;
  selfJudge: boolean;
  status: "ok" | "failure";
  fidelity: number;
  language: number;
  format: number;
  deai: number;
  natural: number;
  preferred: "original" | "rewrite" | "tie";
  issues: string[];
  raw?: string;
  error?: string;
}
const SYSTEM = [
  "你是严格的文本编辑评审。比较原文与改写稿，按真实判断评分。",
  "维度均 0~10 分：fidelity=事实/数字/引语/条件保真，language=语言保持，format=标题/代码/URL/Markdown 保持，deai=去 AI 腔效果，natural=自然度。",
  "preferred 只能是 original/rewrite/tie。issues 用简短中文列出硬问题，没有则空数组。",
  "只输出 JSON，不要解释：",
  '{"fidelity":0,"language":0,"format":0,"deai":0,"natural":0,"preferred":"tie","issues":[]}',
].join("\n");
const keyRaw =
  process.env.QUAIWEI_LLM_KEYS?.trim() ||
  process.env.SENSENOVA_KEYS?.trim() ||
  (fs.existsSync(path.join(ROOT, "scripts/.sensenova-keys"))
    ? fs.readFileSync(path.join(ROOT, "scripts/.sensenova-keys"), "utf8").trim()
    : "");
const keys = splitKeys(keyRaw);
if (!keys.length) throw new Error("没有可用 Key");
const cfg: ApiConfig = {
  enabled: true,
  baseUrl: argOf("base-url", process.env.QUAIWEI_LLM_BASE_URL || "https://token.sensenova.cn/v1"),
  apiKey: keys[0],
  apiKeys: keyRaw,
  model: MODEL,
  temperature: 0.2,
  deepMode: false,
  judgeModel: "",
  altModel: "",
  style: "plain",
  requestTimeoutMs: 180_000,
};
const writes = fs.existsSync(WRITES)
  ? fs
      .readFileSync(WRITES, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as WriteRow)
  : [];
const latestWrites = new Map<string, WriteRow>();
for (const row of writes) latestWrites.set(row.key, row);
let candidates = [...latestWrites.values()].filter(
  (row) => row.status === "ok" && (INCLUDE_SELF || row.model !== MODEL),
);
if (IDS.length)
  candidates = IDS.map((id) => candidates.find((row) => row.id === id)).filter(
    (row): row is WriteRow => Boolean(row),
  );
const pending = SUMMARIZE ? [] : candidates.slice(OFFSET, LIMIT ? OFFSET + LIMIT : undefined);
const latest = new Map<string, JudgeRow>();
if (fs.existsSync(RESULTS)) {
  for (const line of fs.readFileSync(RESULTS, "utf8").split("\n").filter(Boolean)) {
    const row = JSON.parse(line) as JudgeRow;
    if (row.status === "ok") latest.set(row.key, row);
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let completed = 0;
for (const write of pending) {
  const key = `${MODEL}|${write.key}`;
  if (latest.get(key)?.status === "ok") continue;
  let row: JudgeRow;
  try {
    const response = await chat(
      cfg,
      [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: `[原文]\n${write.input}\n\n[改写稿]\n${write.output}\n\n[样本类型]\n${write.kind}/${write.language}`,
        },
      ],
      { temperature: 0.2, maxTokens: MAX_TOKENS },
    );
    const jsonMatch = response.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`评委未返回 JSON：${response.content.slice(0, 120)}`);
    const parsed = JSON.parse(jsonMatch[0]) as Omit<
      JudgeRow,
      "key" | "writeKey" | "id" | "writerModel" | "judgeModel" | "selfJudge" | "status" | "raw"
    >;
    for (const field of ["fidelity", "language", "format", "deai", "natural"] as const) {
      if (!Number.isFinite(parsed[field]) || parsed[field] < 0 || parsed[field] > 10) {
        throw new Error(`评委分数非法：${field}=${parsed[field]}`);
      }
    }
    row = {
      key,
      writeKey: write.key,
      id: write.id,
      writerModel: write.model,
      judgeModel: MODEL,
      selfJudge: write.model === MODEL,
      status: "ok",
      fidelity: parsed.fidelity,
      language: parsed.language,
      format: parsed.format,
      deai: parsed.deai,
      natural: parsed.natural,
      preferred: parsed.preferred,
      issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [],
      raw: response.content,
    };
  } catch (error) {
    row = {
      key,
      writeKey: write.key,
      id: write.id,
      writerModel: write.model,
      judgeModel: MODEL,
      selfJudge: write.model === MODEL,
      status: "failure",
      fidelity: 0,
      language: 0,
      format: 0,
      deai: 0,
      natural: 0,
      preferred: "tie",
      issues: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  latest.set(key, row);
  fs.appendFileSync(RESULTS, JSON.stringify(row) + "\n");
  completed++;
  console.log(
    `${row.status === "ok" ? "✅" : "❌"} ${row.writerModel}→${MODEL} · ${row.id} · ` +
      `保真${row.fidelity} 语言${row.language} 格式${row.format} 去味${row.deai} 自然${row.natural} · ${row.preferred}`,
  );
  if (completed < pending.length && DELAY_MS) await sleep(DELAY_MS);
}
const rows = [...latest.values()];
const ok = rows.filter((row) => row.status === "ok");
const avg = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const summary = {
  generatedAt: new Date().toISOString(),
  baseUrl: cfg.baseUrl,
  keyCount: keys.length,
  maxTokens: MAX_TOKENS,
  judgeModel: MODEL,
  judged: rows.length,
  success: ok.length,
  failure: rows.length - ok.length,
  avg: {
    fidelity: Number(avg(ok.map((row) => row.fidelity)).toFixed(2)),
    language: Number(avg(ok.map((row) => row.language)).toFixed(2)),
    format: Number(avg(ok.map((row) => row.format)).toFixed(2)),
    deai: Number(avg(ok.map((row) => row.deai)).toFixed(2)),
    natural: Number(avg(ok.map((row) => row.natural)).toFixed(2)),
  },
  rewritePreferred: ok.filter((row) => row.preferred === "rewrite").length,
  originalPreferred: ok.filter((row) => row.preferred === "original").length,
  tie: ok.filter((row) => row.preferred === "tie").length,
  rows,
};
fs.writeFileSync(
  path.join(OUT, `judge-summary-${MODEL}.json`),
  JSON.stringify(summary, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    {
      judged: rows.length,
      success: ok.length,
      failure: rows.length - ok.length,
      avg: summary.avg,
      rewritePreferred: summary.rewritePreferred,
      originalPreferred: summary.originalPreferred,
      tie: summary.tie,
    },
    null,
    2,
  ),
);
process.exitCode = rows.length === 0 || rows.some((row) => row.status !== "ok") ? 1 : 0;
