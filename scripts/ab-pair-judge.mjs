/**
 * 配对强制选择裁决（Node fetch 版）——归档脚本 ab_accept.py 的等价复刻。
 *
 * 为什么不用 Python 原脚本：bailucode 网关的 Cloudflare 对 urllib 返回 403 code 1010，
 * Node fetch 能过。flip_for / parse_pair 逐字复刻 ab_accept.py，不碰归档脚本
 * （eval-dual-consistency.test.ts 守着它）。
 *
 * ⚠️ STRICT=1（默认）：只认纯「甲/乙」或 {"pick":"甲"}，非严格输出记无效票（clean=false），
 *    绝不从推理里抠字。实测 bailu-2.8 严格 JSON 提示把干净率从 19% 提到 53%
 *    （evidence/convergence-bailu-mirror-2026-11-25/）。STRICT=0 是旧兼容模式，不建议用于结论。
 *
 * 用法：
 *   BASE=eval-work/ab-low-yield ARM_A=arms-skip ARM_B=arms-soft \
 *   MODEL_A=bailu-2.8 MODEL_B=yuyu-air KEY_A=.. KEY_B=.. \
 *   NODE_USE_ENV_PROXY=1 node scripts/ab-pair-judge.mjs
 */
/* global AbortSignal */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const BASE = path.resolve(ROOT, process.env.BASE || "eval-work/ab-low-yield");
const ARM_A = process.env.ARM_A || "arms-skip";
const ARM_B = process.env.ARM_B || "arms-soft";
const URL = process.env.URL || "https://bailucode.com/openapi/v1/chat/completions";
const OUT = path.join(BASE, "out-node");
fs.mkdirSync(OUT, { recursive: true });
const RESULTS = path.join(OUT, "results.jsonl");

const KEY_A = process.env.KEY_A;
const KEY_B = process.env.KEY_B;
if (!KEY_A || !KEY_B) throw new Error("need KEY_A / KEY_B");

// URL_A / URL_B 可分别指定端点，用于「异源双席」；缺省回落到 URL，保持旧行为。
const SEATS = [
  {
    seat: "A",
    model: process.env.MODEL_A || "bailu-2.8",
    key: KEY_A,
    url: process.env.URL_A || URL,
  },
  {
    seat: "B",
    model: process.env.MODEL_B || "yuyu-air",
    key: KEY_B,
    url: process.env.URL_B || URL,
  },
];
// STRICT=1（默认）：只认严格格式输出——纯「甲」/「乙」或 {"pick":"甲"}，
// 非严格输出一律记无效票（绝不猜字）。复刻项目纪律：抠字=噪声，不得当有效票。
const STRICT = process.env.STRICT !== "0";
const SYS = STRICT
  ? '你是文本鉴别员。判断哪段更像 AI 生成。只输出 JSON：{"pick":"甲"} 或 {"pick":"乙"}。禁止解释、禁止标点、禁止英文。'
  : "你是中文文本鉴别员。下面给你两段内容相近的文本甲和乙。请判断哪一段更像 AI 生成的。" +
    "只输出一个字：甲或乙。不要输出解释、标点或其他文字。";

const corpusDir = path.join(BASE, "corpus");
const ids = fs
  .readdirSync(corpusDir)
  .filter((f) => f.endsWith(".txt"))
  .map((f) => f.slice(0, -4));
console.log("ids", ids.join(", "));

// 逐字复刻 ab_accept.py 的 flip_for（tag 固定 "ab"）——不要改，位置偏置抵消是基线的一部分。
function flipFor(cid, seat, tag = "ab") {
  const v = ([...cid].reduce((a, c) => a + c.charCodeAt(0), 0) + tag.length) % 2 === 0;
  return seat === "B" ? !v : v;
}
/** 严格解析：只认纯「甲/乙」或 {"pick":"甲"}，其余一律 null（无效票，绝不猜字）。 */
function parseStrict(c) {
  const s = String(c ?? "").trim();
  if (/^[甲乙]$/.test(s)) return s;
  const m = /^\{"pick"\s*:\s*"([甲乙])"\}$/.exec(s);
  return m ? m[1] : null;
}
function parsePair(c) {
  if (STRICT) return parseStrict(c);
  if (!c) return null;
  for (let i = c.length - 1; i >= 0; i--) if (c[i] === "甲" || c[i] === "乙") return c[i];
  for (const ch of c) if (ch === "A" || ch === "B") return ch === "A" ? "甲" : "乙";
  if (c.includes("第一") || c.includes("前者")) return "甲";
  if (c.includes("第二") || c.includes("后者")) return "乙";
  return null;
}
async function call(up, user) {
  const body = JSON.stringify({
    model: up.model,
    temperature: Number(process.env.TEMPERATURE ?? 0),
    // 思考型模型（如 SenseNova flash-lite）的 reasoning 会吃满 token 预算导致 content 为空；
    // 默认保持原值不变，需时显式调大（例 MAX_TOKENS=512）。
    max_tokens: Number(process.env.MAX_TOKENS ?? (STRICT ? 16 : 96)),
    messages: [
      { role: "system", content: SYS },
      { role: "user", content: user },
    ],
    ...(STRICT ? { response_format: { type: "json_object" } } : {}),
  });
  let formatRetries = 0;
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch(up.url || URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + up.key },
        body,
        signal: AbortSignal.timeout(120000),
      });
      const t = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status} ${t.slice(0, 100)}`);
      const j = JSON.parse(t);
      const m = j.choices?.[0]?.message ?? {};
      const raw = (m.content || m.reasoning_content || "").trim();
      // 格式重试：仅当 STRICT 且输出无法严格解析时重发。触发条件与答案方向无关，
      // 绝不因为「选了想要的臂」就接受、也不因为「选了不想要的臂」就重发。上限 2 次。
      if (STRICT && !parseStrict(raw) && formatRetries < 2) {
        formatRetries++;
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      return { raw, formatRetries };
    } catch (e) {
      if (i >= 5) return { error: e.message };
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return { error: "exhausted" };
}

const done = new Set();
if (fs.existsSync(RESULTS))
  for (const l of fs.readFileSync(RESULTS, "utf8").split("\n").filter(Boolean))
    done.add(JSON.parse(l).key);

for (const up of SEATS) {
  for (const cid of ids) {
    const key = `pair|${cid}|${up.seat}`;
    if (done.has(key)) continue;
    const a = fs.readFileSync(path.join(BASE, ARM_A, `${cid}.humanized.txt`), "utf8");
    const b = fs.readFileSync(path.join(BASE, ARM_B, `${cid}.humanized.txt`), "utf8");
    const flip = flipFor(cid, up.seat);
    const first = flip ? b : a;
    const second = flip ? a : b;
    const tail = STRICT
      ? '哪一段更像 AI 生成的？只输出 JSON：{"pick":"甲"} 或 {"pick":"乙"}。'
      : "哪一段更像 AI 生成的？只输出「甲」或「乙」。";
    const user = "甲：\n<<<" + first + ">>>\n\n乙：\n<<<" + second + ">>>\n\n" + tail;
    const res = await call(up, user);
    const err = res.error ?? null;
    const raw = err ? "" : res.raw;
    const formatRetries = err ? 0 : res.formatRetries;
    const pick = err ? null : parsePair(raw);
    const chosen = pick === "甲" ? (flip ? "b" : "a") : pick === "乙" ? (flip ? "a" : "b") : null;
    const rec = {
      key, id: cid, seat: up.seat, model: up.model, aIsFirst: flip, pick, chosen, formatRetries,
      bWin: chosen ? chosen === "b" : null,
      clean: STRICT ? pick !== null : /^[甲乙]$/.test(String(raw || "").trim()),
      raw: String(raw).slice(0, 40),
      rawFull: raw,
      err,
    };
    fs.appendFileSync(RESULTS, JSON.stringify(rec) + "\n");
    console.log(up.seat, cid, "pick", pick, "clean", rec.clean, "bWin", rec.bWin, err || "");
    await new Promise((r) => setTimeout(r, 1500));
  }
}

const rows = fs
  .readFileSync(RESULTS, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const clean = rows.filter((r) => r.clean && r.bWin !== null);
const ok = rows.filter((r) => r.bWin !== null && r.bWin !== undefined);
console.log("\n=== 汇总 ===");
console.log("总票", rows.length, "| 有判定", ok.length, "| 输出格式达标(纯甲/乙)", clean.length);
if (clean.length < ok.length)
  console.log("⚠️ 有", ok.length - clean.length, "票是从推理里抠字，不得当有效票；结论无效。");
const a = clean.filter((r) => r.seat === "A");
const b = clean.filter((r) => r.seat === "B");
console.log("A 席 B臂被选更像AI", a.filter((r) => r.bWin).length, "/", a.length);
console.log("B 席 B臂被选更像AI", b.filter((r) => r.bWin).length, "/", b.length);
const agree = ids.filter((cid) => {
  const x = clean.find((r) => r.id === cid && r.seat === "A");
  const y = clean.find((r) => r.id === cid && r.seat === "B");
  return x && y && x.bWin === y.bWin;
}).length;
console.log("双席一致(仅干净票)", agree, "/", ids.length);
console.log("注：问的是「哪段更像 AI」，B 臂被选越多 ⇒ B 越差；越少 ⇒ B 更像人。");
