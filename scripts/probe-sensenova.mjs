/**
 * 商汤（SenseNova 网关）模型可用性探测
 *
 * 只做两件事：
 *   1. GET {base}/models —— 看在售清单；
 *   2. 对每个模型发一次**最小** chat 请求 —— 在售 ≠ 有权限（历史教训：v4-pro 已下线但仍在列、
 *      v4.1-flash 在售但套餐 403）。
 *
 * 凭证只从文件/环境变量读，**任何输出都不打印 Key**（只打印后缀 4 位用于区分）。
 * 用法：node scripts/probe-sensenova.mjs [--base https://token.sensenova.cn/v1] [--dry]
 */
/* global AbortSignal -- Node 18+ 的全局；eslint 的 env 里没声明 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const BASE = argOf("--base", "https://token.sensenova.cn/v1").replace(/\/$/, "");
const DRY = args.includes("--dry");

function loadKeys() {
  const out = [];
  const env = process.env.SENSENOVA_KEYS ?? "";
  for (const k of env.split(/[\s,]+/)) if (k.trim()) out.push(k.trim());
  const file = path.join(ROOT, "scripts", ".sensenova-keys");
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const k = line.trim();
      if (k && !k.startsWith("#")) out.push(k);
    }
  }
  return [...new Set(out)];
}

const mask = (k) => (k.length <= 4 ? "****" : "…" + k.slice(-4));

async function getModels(key) {
  const resp = await fetch(`${BASE}/models`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 也要把状态码报出来 */
  }
  return { status: resp.status, json, text: text.slice(0, 300) };
}

async function probeChat(key, model, temperature = 0.2) {
  const t0 = Date.now();
  try {
    const resp = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "只回复两个字：可用" }],
        max_tokens: 2048,
        temperature,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const ms = Date.now() - t0;
    const text = await resp.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* ignore */
    }
    if (!resp.ok) {
      const msg = (json?.error?.message ?? json?.message ?? text).slice(0, 160);
      return { ok: false, ms, status: resp.status, msg };
    }
    const choice = json?.choices?.[0];
    const content = (choice?.message?.content ?? "").trim();
    const reasoning = (choice?.message?.reasoning_content ?? "").trim();
    return {
      ok: content.length > 0 || reasoning.length > 0,
      ms,
      status: resp.status,
      msg: content ? content.slice(0, 40) : reasoning ? `（仅思考：${reasoning.slice(0, 30)}）` : "空输出",
    };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, status: 0, msg: `网络/超时：${String(e).slice(0, 120)}` };
  }
}

/**
 * 带自适应的探测：网关对不同模型有不同的硬约束，直接判"不可用"会误杀。
 *   · 400「only 1 is allowed」→ 该模型强制 temperature=1（kimi-k3 就是这类），换 1 重试；
 *   · 429 → **限流**。3 条 Key 的套餐有 tpm/rpm 上限，连续探测很容易撞上；
 *     先换下一条 Key 重试，四条都撞就等 3 秒再来一次（轮换是产品里就有的策略）。
 *   · 403（套餐）/ 404（下线）→ 真不可用，不重试。
 */
async function probeWithAdapt(keys, keyIdx, model) {
  let r = await probeChat(keys[keyIdx], model);
  if (!r.ok && r.status === 400 && /only 1 is allowed|temperature/i.test(r.msg)) {
    const r2 = await probeChat(keys[keyIdx], model, 1);
    return { ...r2, note: "需 temperature=1" };
  }
  if (!r.ok && r.status === 429) {
    for (let i = 1; i <= keys.length; i++) {
      const k = (keyIdx + i) % keys.length;
      const r2 = await probeChat(keys[k], model);
      if (r2.ok) return { ...r2, note: `换 Key …${keys[k].slice(-4)} 后可用` };
      if (r2.status !== 429) return r2; // 换个 Key 得到别的错，就以它为准
    }
    await new Promise((res) => setTimeout(res, 3000));
    const r3 = await probeChat(keys[keyIdx], model);
    return { ...r3, note: "限流（全部 Key 撞 429，已再等 3 秒）" };
  }
  return r;
}

const keys = loadKeys();
if (keys.length === 0) {
  console.log("没有可用 Key：scripts/.sensenova-keys 与 SENSENOVA_KEYS 都是空的");
  process.exit(1);
}
console.log(`网关 ${BASE} ｜ Key ${keys.length} 条（${keys.map(mask).join(", ")}）`);
if (DRY) {
  console.log("--dry：只列 Key，不发请求");
  process.exit(0);
}

const first = keys[0];
const listed = await getModels(first);
console.log(`\n[1] GET /models → HTTP ${listed.status}`);
if (listed.status !== 200) {
  console.log(`    响应：${listed.text}`);
  process.exit(1);
}
const rawModels = listed.json?.data ?? listed.json?.models ?? [];
const ids = rawModels
  .map((m) => m?.id ?? m?.name ?? m?.model)
  .filter(Boolean)
  .sort();
console.log(`    在售 ${ids.length} 个：`);
for (const id of ids) {
  const meta = rawModels.find((m) => (m?.id ?? m?.name ?? m?.model) === id);
  const owned = meta?.owned_by ?? meta?.provider ?? "";
  console.log(`      · ${id}${owned ? `  (${owned})` : ""}`);
}

console.log(`\n[2] 逐个发最小请求（max_tokens=2048，60s 超时）`);
const rows = [];
for (const [i, id] of ids.entries()) {
  process.stdout.write(`    (${i + 1}/${ids.length}) ${id} … `);
  const r = await probeWithAdapt(keys, 0, id);
  rows.push({ id, ...r });
  const tail = r.note ? `（${r.note}）` : "";
  console.log(r.ok ? `✅ ${r.ms}ms — ${r.msg}${tail}` : `❌ ${r.status} ${r.ms}ms — ${r.msg}`);
}

const ok = rows.filter((r) => r.ok);
console.log(`\n===== 汇总 =====`);
console.log(`可用 ${ok.length} / ${rows.length}`);
console.log(`\n| 模型 | 判定 | 耗时 | 说明 |`);
console.log(`|---|---|---|---|`);
for (const r of rows) {
  console.log(`| ${r.id} | ${r.ok ? "✅ 可用" : "❌ 不可用"} | ${r.ms}ms | ${r.msg.replace(/\|/g, "/")} |`);
}
