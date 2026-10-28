/**
 * src/mcp/server.ts —— QuAiWei 的 MCP（Model Context Protocol）服务端，stdio 传输，零依赖。
 *
 * 为什么要有：用户已经不只在「打开某个网页」里写作，而是在 Claude Code / Codex / Cursor / DSH
 * 里让 agent 动手。同类项目这周都在往这条入口上走（humanizer-ru 带 MCP + Chrome 扩展、
 * humanpen-mcp 直接改 .docx）。本仓的引擎是纯函数、离线、确定性，最适合做成 MCP 工具——
 * 调用方拿到的是**改后正文**，不是一段「请模型自己改」的提示词。
 *
 * 边界（与 README 的诚实声明一致，工具描述里不许夸口）：
 *  · 只做简体中文；英文 / 繁中 / 日韩不在本引擎的调优范围内（词表是简中的）。
 *  · 本地代理分与任何检测器官方分都没有标定关系，只用于同一篇稿的前后对比。
 *  · **不承诺通过任何检测器**；默认离线、不联网、不需要 Key。
 *
 * 协议：JSON-RPC 2.0，按行分隔（MCP stdio 传输的规定），一个消息一行。
 * 本文件只依赖 Node 内置模块 + 本仓引擎，打包后是单文件 `dist-cli/quaiwei-mcp.mjs`。
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { humanize, adviceFor } from "../engine/humanize";
import { aiScore, checkFidelityLocal } from "../engine/humanize-metrics";
import { detectAI } from "../engine/detector";
import { explainChanges, type ExplainItem } from "../engine/explain";
import { reviewText } from "../engine/review";
import { formatIssues } from "../engine/format-integrity";
import { numericFidelityWarning } from "../engine/number-fidelity";
import { applyRegionalVariant, formatRegionalSummary } from "../engine/regional-zh";
import { academicAudit, formatAcademicReport } from "../engine/academic-check";
import type { HumanizeOptions, RewriteStyle } from "../engine/humanize-primitives";

/* ------------------------------- 协议类型 ------------------------------- */

type JsonRpcId = string | number | null;

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** 工具返回：MCP 规定 content 非空；isError 表示"工具自己失败了"，不是协议错误 */
export interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** 单次调用允许的最大字符数：再大应该走 CLI 批量，而不是把一整本书塞进一次工具调用 */
const MAX_TEXT_CHARS = 200_000;

/** 与 CLI `--seed` 一致的默认种子。引擎不传 seed 会退回 Date.now()，那样跨进程不可复现 */
const DEFAULT_SEED = 20260905;

/** 支持的协议版本（按新到旧）。客户端给的脸熟就回给它的，不脸熟就回我们最新的 */
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL = SUPPORTED_PROTOCOLS[0];

/** 服务端版本：从最近的 package.json 读，读不到就报 unknown（不猜） */
function readVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(here, rel), "utf8")).version;
      if (typeof v === "string" && v.trim()) return v.trim();
    } catch {
      // 换下一个候选路径：源码树下是 ../../，打包产物下是 ../
    }
  }
  return "unknown";
}

export const SERVER_INFO = { name: "quaiwei", version: readVersion() };

/** 初始化时回给客户端的说明：让 agent 一开始就知道这套工具的边界 */
const INSTRUCTIONS = [
  "趣AI味 QuAiWei：简体中文去 AI 味的本地引擎。",
  "humanize_text 只做换词/断句/删套话，不新增事实，不编数字；结果可复现（固定 seed）。",
  "academic_report 是论文场景的硬出口：判 READY / NOT READY，查数字、引用键与结构，",
  "但它不判论证对不对——READY 不等于审稿人会收。",
  "detect_ai 与 humanize_text 共用一套词表，所以「去味后分数变好看」是共用词表的必然结果，",
  "不等于通过了任何检测器；本工具不承诺通过任何检测。",
  "要判断能不能交付，请用真实检测器的结果，别用这里的降幅。",
  "超长文本（>20 万字）请用 CLI：npx ai-humanizer <目录> --out <目录>。",
].join("");

/* -------------------------------- 工具定义 ------------------------------- */

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TEXT_PROP = {
  type: "string",
  minLength: 1,
  description: "待处理的中文纯文本（不要包 Markdown 代码块围栏）",
};

const OPTION_PROPS = {
  intensity: {
    type: "number",
    minimum: 0,
    maximum: 1,
    description: "去味强度 0~1，默认 0.6；0.9 会动更多句式（论说/营销稿用 0.9，正式稿别超过 0.6）",
  },
  style: {
    type: "string",
    enum: ["plain", "casual", "academic"],
    description: "文风，默认 plain（平实书面）。论文与公文用 plain 或 academic，别用 casual",
  },
  seed: {
    type: "integer",
    description: "随机种子，默认 20260905。固定后同一段文本每次产出完全一致",
  },
  zhuque: {
    type: "boolean",
    description:
      "朱雀增强特征（方言/插入语/句式碎片/标点不规整）。默认 false；只说「更像人写」时不必开",
  },
  variant: {
    type: "string",
    enum: ["zh-TW"],
    description:
      "地区用词校正，默认不传（不动）。zh-TW = 台湾用词（软件→软体、信息→资讯）+ 半角标点转全角；不做简繁转换，输入简体输出简体",
  },
};

export const TOOLS: ToolDef[] = [
  {
    name: "humanize_text",
    title: "中文去 AI 味（本地引擎）",
    description:
      "把简体中文里 AI 写的腔调改掉：套话、公式化句式、句首连接词、书面腔词表，只换词和断句，不编事实。默认离线、不需要 Key、固定 seed 可复现。返回改后正文；本地代理分只用于同一篇稿的前后对比，不是任何检测器的官方分，也不承诺通过检测。只想看哪里像 AI 而不动原文，用 detect_ai；要一份带逐条改动与保真检查的报告，用 quality_report。",
    inputSchema: {
      type: "object",
      properties: { text: TEXT_PROP, ...OPTION_PROPS },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "detect_ai",
    title: "本地 AI 味自检（不改原文）",
    description:
      "只读检查：给一段简体中文打本地 AI 味代理分（0~100，越高越像 AI 写的），列出风险最高的句子与命中原因。它测的是词表命中的套话与公式化表达，不是「像不像人写」的抽象判断——真人写的长文也能到 90 分左右，所以分数只能在同体裁、同一篇稿的前后对比里看。不是任何检测器的官方分。",
    inputSchema: {
      type: "object",
      properties: {
        text: TEXT_PROP,
        top: { type: "integer", minimum: 1, maximum: 8, description: "列出几条高风险句，默认 5" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "quality_report",
    title: "去味 + 自检报告",
    description:
      "跑一遍去味，然后给一份交稿前自检报告：前后代理分、逐条改动（改了什么、凭什么、是不是推断）、结构保真问题（代码块/表格/标题/引用是否被破坏）、数字保真问题（原文的数字或单位有没有被改掉）、以及可读性小结。要「改完这段给我看看有没有改坏」时用这个。",
    inputSchema: {
      type: "object",
      properties: { text: TEXT_PROP, ...OPTION_PROPS },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "academic_report",
    title: "学术稿能不能投（硬判定）",
    description:
      "论文/投稿场景的交稿硬出口：判 READY 还是 NOT READY。查数字与单位、引用键（\\cite / \\ref / [@key] / [[EVIDENCE]] 丢了或凭空出现）、结构（代码块/表格/标题）、断言是否被说重、残留套话。给了 rewritten 就审那份现成稿（推荐：审 LLM 深度模式产出或别人改的版本，引擎不参与改写）；不给就先用本地 academic 文风跑一遍再审。它不判论证对不对——READY 不等于审稿人会收。",
    inputSchema: {
      type: "object",
      properties: {
        text: { ...TEXT_PROP, description: "原文（投稿稿的标准版本）" },
        rewritten: {
          type: "string",
          description:
            "可选：待检的改写稿。给了就审这一份，引擎不参与改写；不给就由引擎按 academic 文风生成",
        },
        intensity: OPTION_PROPS.intensity,
        seed: OPTION_PROPS.seed,
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
];

/* -------------------------------- 参数解析 ------------------------------- */

class ToolError extends Error {}

function asText(args: Record<string, unknown>): string {
  const v = args.text;
  if (typeof v !== "string" || !v.trim()) throw new ToolError("text 必须是非空字符串");
  if (v.length > MAX_TEXT_CHARS) {
    throw new ToolError(
      `text 过长（${v.length} 字 > ${MAX_TEXT_CHARS}）。超长文本请用 CLI：npx ai-humanizer <目录> --out <目录>`,
    );
  }
  return v;
}

function asOptions(args: Record<string, unknown>): HumanizeOptions {
  const o: HumanizeOptions = {};
  const n = args.intensity;
  if (typeof n === "number" && Number.isFinite(n)) o.intensity = Math.min(1, Math.max(0, n));
  const s = args.style;
  if (s === "plain" || s === "casual" || s === "academic") o.style = s as RewriteStyle;
  /**
   * seed 必须显式给默认值。引擎的 `makeRng(seed)` 在 seed 为 undefined 时会退回
   * `Date.now()`——不传 seed 时同一段文本每次跑出来的结果都不一样，"固定 seed 可复现"
   * 就成了空话（2026-10-26 实测：同一段 114 字，三个进程跑出 101/106/101 字三种结果）。
   * 这里用与 CLI `--seed` 相同的默认值，跨进程也逐字一致。
   */
  const seed = args.seed;
  o.seed = typeof seed === "number" && Number.isFinite(seed) ? Math.trunc(seed) : DEFAULT_SEED;
  if (args.zhuque === true) o.zhuqueMode = true;
  return o;
}

const clip = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n) + "…");

/** 地区变体参数：不传 / 空 = 不动；给了不认识的直接报错，别静默忽略 */
function asVariant(args: Record<string, unknown>): "zh-TW" | undefined {
  const v = args.variant;
  if (v === undefined || v === null || v === "") return undefined;
  if (v === "zh-TW") return "zh-TW";
  throw new ToolError(`variant 只认 "zh-TW"（不传 = 不动），收到：${String(v)}`);
}

/* -------------------------------- 工具实现 ------------------------------- */

function toolHumanize(args: Record<string, unknown>): ToolResult {
  const text = asText(args);
  const opts = asOptions(args);
  const variant = asVariant(args);
  const before = aiScore(text).score;
  const base = humanize(text, opts);
  // v0.9.81：地区校正排在引擎之后——它是后处理，不进去味管线，也不动标定
  const regional = applyRegionalVariant(base, variant);
  const out = regional.text;
  const after = aiScore(out).score;
  const advice = adviceFor(text, before);
  const notes: string[] = [];

  if (variant) notes.push(`地区校正（${variant}）：${formatRegionalSummary(regional)}`);
  if (advice.code !== "ok" && advice.message) notes.push(advice.message);
  const numWarn = numericFidelityWarning(text, out);
  if (numWarn) notes.push(numWarn);
  const fid = checkFidelityLocal(text, out);
  if (!fid.pass && fid.problems.length) notes.push("保真：" + fid.problems.slice(0, 4).join("；"));

  const blocks: ToolResult["content"] = [{ type: "text", text: out }];
  if (notes.length) {
    blocks.push({
      type: "text",
      text: `---\n本地代理分 ${before} → ${after}（同篇前后对比才有意义，不是检测器官方分）\n${notes.join("\n")}`,
    });
  }
  return {
    content: blocks,
    structuredContent: {
      text: out,
      scoreBefore: before,
      scoreAfter: after,
      adviceCode: advice.code,
      advice: advice.message,
      charsBefore: text.length,
      charsAfter: out.length,
      changed: out !== text,
      fidelityPass: fid.pass,
      fidelityProblems: fid.problems,
      numberWarning: numWarn,
      regional: variant
        ? { variant, terms: regional.terms, punctuation: regional.punctuation }
        : undefined,
    },
  };
}

function toolDetect(args: Record<string, unknown>): ToolResult {
  const text = asText(args);
  const rawTop = typeof args.top === "number" ? Math.trunc(args.top) : 5;
  const top = Math.min(8, Math.max(1, rawTop));
  const r = detectAI(text);

  const lines: string[] = [];
  lines.push(`本地 AI 味代理分 ${r.probability} / 100（${r.levelText}）· 置信度 ${r.confidence}`);
  lines.push(
    `共 ${r.stats.sentences} 句 / ${r.stats.chars} 字 / 句长变异系数 ${r.stats.sentenceCV.toFixed(2)}`,
  );
  if (r.topSegments.length) {
    lines.push("");
    lines.push(`风险最高的 ${Math.min(top, r.topSegments.length)} 句：`);
    r.topSegments.slice(0, top).forEach((s, i) => {
      lines.push(`${i + 1}. [${s.risk}] ${clip(s.text, 80)}`);
      lines.push(`   命中：${s.reason}`);
    });
  }
  if (r.warnings.length) {
    lines.push("");
    for (const w of r.warnings) lines.push(`注意：${w}`);
  }
  lines.push("");
  lines.push("这是本地词表命中的代理指标，不是任何检测器的官方分；同体裁同篇前后对比才有意义。");

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      probability: r.probability,
      level: r.level,
      levelText: r.levelText,
      confidence: r.confidence,
      stats: r.stats,
      topSegments: r.topSegments.slice(0, top),
      warnings: r.warnings,
    },
  };
}

function toolReport(args: Record<string, unknown>): ToolResult {
  const text = asText(args);
  const opts = asOptions(args);
  const variant = asVariant(args);
  const before = aiScore(text).score;
  const base = humanize(text, opts);
  const regional = applyRegionalVariant(base, variant);
  const out = regional.text;
  const after = aiScore(out).score;
  const items: ExplainItem[] = explainChanges(text, out);
  const issues = formatIssues(text, out);
  const numWarn = numericFidelityWarning(text, out);
  const fid = checkFidelityLocal(text, out);
  const review = reviewText(out);
  const advice = adviceFor(text, before);

  const lines: string[] = [];
  lines.push("# 去味自检报告（本地引擎）");
  lines.push("");
  lines.push(`原文 ${text.length} 字 → 产出 ${out.length} 字 · 本地代理分 ${before} → ${after}`);
  lines.push("代理分只用于同篇前后对比，与检测器官方分无标定关系。");

  lines.push("");
  lines.push("## 改了什么");
  if (!items.length) {
    lines.push("引擎没有改动这段文本（可能已落在人写带，或句式不在词表里）。");
  } else {
    const certain = items.filter((i) => i.certain).length;
    lines.push(
      `共 ${items.length} 处改动，其中 ${certain} 处命中明确规则表、${items.length - certain} 处为形态推断。`,
    );
    for (const it of items.slice(0, 12)) {
      lines.push(
        `- [${it.kind}${it.certain ? "" : "·推断"}] ${clip(it.before, 40)} → ${clip(it.after, 40) || "（删去）"}`,
      );
      lines.push(`  为什么：${it.reason}（依据：${it.basis}）`);
    }
    if (items.length > 12)
      lines.push(`- …另有 ${items.length - 12} 处未列出，需要完整清单请用 CLI --explain`);
  }

  if (variant) {
    lines.push("");
    lines.push("## 地区校正");
    lines.push(`${variant}：${formatRegionalSummary(regional)}`);
    lines.push("只换词与标点，不做简繁转换（字形请自行过 OpenCC）。");
  }

  lines.push("");
  lines.push("## 保真检查");
  lines.push(issues.length ? `结构/格式违规 ${issues.length} 处：` : "结构/格式：没有发现违规。");
  for (const is of issues.slice(0, 8)) lines.push(`- [${is.rule}] ${is.detail}`);
  if (numWarn) lines.push(`- 数字保真：${numWarn}`);
  else if (fid.pass) lines.push("- 数字与英文专名：与原文一致。");
  if (!fid.pass && fid.problems.length) {
    for (const p of fid.problems.slice(0, 6)) lines.push(`- 保真：${p}`);
  }

  lines.push("");
  lines.push("## 产出读起来怎么样（本地代理分，非官方）");
  lines.push(
    `代理分 ${review.probability} / 100（${review.levelText}）· 共 ${review.total} 句，其中 ${review.marked} 句达到痕迹门槛 · AI 参与比例估计 ${review.editedRatio}% · 样本置信度：${review.confidence.text}`,
  );
  if (review.summary.length)
    lines.push("残留痕迹：" + review.summary.map(([k, v]) => `${k}×${v}`).join("、"));

  lines.push("");
  lines.push("## 建议");
  lines.push(
    advice.code === "ok"
      ? "可以交稿；要更保险，请把产出送真实检测器复测一次，别只看这里的分数。"
      : advice.message,
  );

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      text: out,
      scoreBefore: before,
      scoreAfter: after,
      changes: items.length,
      changesCertain: items.filter((i) => i.certain).length,
      formatIssues: issues,
      numberWarning: numWarn,
      fidelityPass: fid.pass,
      review: {
        probability: review.probability,
        levelText: review.levelText,
        marked: review.marked,
        total: review.total,
        editedRatio: review.editedRatio,
      },
      regional: variant
        ? { variant, terms: regional.terms, punctuation: regional.punctuation }
        : undefined,
      adviceCode: advice.code,
    },
  };
}

/**
 * 学术硬出口：审的要么是引擎自己跑的稿，要么是调用方给的现成稿（`rewritten`）。
 * 给了 rewritten 就不跑引擎——这条门最有用的场景正是审 LLM 深度模式的产出，
 * 而那一步引擎不该插手（插手就变成自己审自己）。
 */
function toolAcademic(args: Record<string, unknown>): ToolResult {
  const text = asText(args);
  const given = args.rewritten;
  if (given !== undefined && typeof given !== "string")
    throw new ToolError("rewritten 必须是字符串（待检的改写稿）");
  const candidate =
    typeof given === "string" && given.trim()
      ? given
      : humanize(text, { ...asOptions(args), style: "academic" });
  const audit = academicAudit(text, candidate);
  const mode =
    typeof given === "string" && given.trim()
      ? "审现成改写稿（引擎未参与）"
      : "引擎按 academic 文风改写后自检";
  return {
    content: [
      {
        type: "text",
        text: formatAcademicReport(audit, { style: "academic", intensity: 0, mode }),
      },
    ],
    structuredContent: {
      verdict: audit.verdict,
      blockers: audit.blockers,
      warnings: audit.warnings,
      checked: audit.checked,
      stats: audit.stats,
      rewritten: candidate,
    },
  };
}

const HANDLERS: Record<string, (args: Record<string, unknown>) => ToolResult> = {
  humanize_text: toolHumanize,
  detect_ai: toolDetect,
  quality_report: toolReport,
  academic_report: toolAcademic,
};

/* ------------------------------- 协议分发 -------------------------------- */

function rpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * 处理一条 JSON-RPC 消息。返回 null 表示「这条不该有回应」（通知类消息）。
 * 抽成纯函数是为了让测试能直接喂消息、不必起进程。
 */
export function handleMessage(msg: unknown): JsonRpcResponse | null {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    return rpcError(null, -32600, "Invalid Request：需要一个 JSON 对象");
  }
  const m = msg as Record<string, unknown>;
  const method = typeof m.method === "string" ? m.method : "";
  const hasId = "id" in m && m.id !== undefined;
  const id: JsonRpcId = hasId ? (m.id as JsonRpcId) : null;
  if (!method) return hasId ? rpcError(id, -32600, "Invalid Request：缺少 method") : null;

  // 通知（没有 id）：按协议一律不回，包括 notifications/initialized
  const isNotification = !hasId;

  if (method === "initialize") {
    const params = (m.params ?? {}) as Record<string, unknown>;
    const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : LATEST_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      },
    };
  }

  if (isNotification) return null;

  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: TOOLS.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      },
    };
  }

  if (method === "tools/call") {
    const params = (m.params ?? {}) as Record<string, unknown>;
    const name = typeof params.name === "string" ? params.name : "";
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const handler = HANDLERS[name];
    if (!handler)
      return rpcError(
        id,
        -32602,
        `未知工具：${name || "(空)"}；可用：${Object.keys(HANDLERS).join(" / ")}`,
      );
    try {
      return { jsonrpc: "2.0", id, result: handler(args) };
    } catch (e) {
      // 工具自己失败（参数不合法、文本过长）按 MCP 约定走 isError，而不是 JSON-RPC error
      const message = e instanceof Error ? e.message : String(e);
      const failed: ToolResult = {
        content: [{ type: "text", text: `调用失败：${message}` }],
        isError: true,
      };
      return { jsonrpc: "2.0", id, result: failed };
    }
  }

  return rpcError(id, -32601, `不支持的方法：${method}`);
}

/**
 * 把服务端接到一对流上（生产是 stdin/stdout，测试是内存流）。
 * 返回一个关闭函数。行分隔 JSON；坏 JSON 回 -32700 而不是直接崩。
 */
export function attachStdio(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): () => void {
  const write = (obj: unknown) => {
    output.write(JSON.stringify(obj) + "\n");
  };
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const t = line.trim();
    if (!t) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      write(rpcError(null, -32700, "Parse error：这一行不是合法 JSON"));
      return;
    }
    if (Array.isArray(parsed)) {
      const out = parsed
        .map((p) => handleMessage(p))
        .filter((r): r is JsonRpcResponse => r !== null);
      if (out.length) write(out);
      return;
    }
    const res = handleMessage(parsed);
    if (res) write(res);
  });
  // 客户端先走一步是常态（编辑器重启、管道结束）：别让它冒成未捕获异常
  output.on?.("error", () => rl.close());
  return () => rl.close();
}

/* --------------------------------- 入口 ---------------------------------- */

const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isMain) {
  // stdout 只能走协议：引擎里任何 console.log 都会毁掉这一路，所以这里把游离输出导向 stderr
  const log = console.log.bind(console);
  console.log = (...a: unknown[]) => console.error(...a);
  void log;
  process.stdin.setEncoding("utf8");
  attachStdio(process.stdin, process.stdout);
  process.on("SIGINT", () => process.exit(0));
}
