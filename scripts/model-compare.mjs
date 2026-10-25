/**
 * 模型改写效果对比（一次性判断「谁适合当主改写」用，可复现）
 *
 * 走**产品真实路径**：CLI 的 `--api --no-deep`（单轮改写），同一篇稿、同强度、同 seed，
 * 只换 `--model`。采集：墙钟耗时 / 字数 / 本地 aiScore 前后 / 引擎 / 落盘产出文本，
 * 再算两两差异（字符二元组 Jaccard）与套话残留。
 *
 * 用法：
 *   node scripts/model-compare.mjs --src <稿件.txt> [--models a,b,c] [--base <url>] [--out <目录>]
 *   npm run compare:models -- --src docs-samples/某稿.txt
 *
 * 凭证：SENSENOVA_KEYS 环境变量 → scripts/.sensenova-keys（与 CLI 一致，任何输出都不打印 Key）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const SRC = argOf("--src", "");
if (!SRC || !fs.existsSync(SRC)) {
  console.error("用法：node scripts/model-compare.mjs --src <稿件.txt> [--models a,b,c] [--base url]");
  process.exit(2);
}
const BASE = argOf("--base", "https://token.sensenova.cn/v1");
const OUT = argOf("--out", path.join(os.tmpdir(), "qw-model-compare"));
const MODELS = argOf(
  "--models",
  "deepseek-v4-flash,sensenova-6.8-flash-lite,glm-5.2,kimi-k3,deepseek-flash",
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** 与 CLI 同源的 Key 读取（文件优先，环境变量兜底；不打印内容） */
function keyEnv() {
  if (process.env.SENSENOVA_KEYS) return process.env.SENSENOVA_KEYS;
  const f = path.join(ROOT, "scripts", ".sensenova-keys");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim() : "";
}
const KEYS = keyEnv();
if (!KEYS) {
  console.error("没有可用 Key：请设 SENSENOVA_KEYS 或放 scripts/.sensenova-keys");
  process.exit(1);
}

const STOCK = [
  "综上所述",
  "首先",
  "其次",
  "再次",
  "总而言之",
  "必然选择",
  "系统性工程",
  "久久为功",
  "以问题为导向",
  "高质量发展",
  "赋能",
  "抓手",
];
const srcText = fs.readFileSync(SRC, "utf8");
fs.mkdirSync(OUT, { recursive: true });

function sentences(t) {
  return t
    .split(/(?<=[。！？])/)
    .map((s) => s.trim())
    .filter(Boolean);
}
function stats(t) {
  const s = sentences(t);
  const avg = s.reduce((a, x) => a + x.length, 0) / Math.max(1, s.length);
  return {
    chars: t.length,
    paras: t.split(/\n\s*\n/).filter((p) => p.trim()).length,
    sents: s.length,
    avgLen: avg.toFixed(1),
    stock: STOCK.filter((w) => t.includes(w)),
  };
}
function bigrams(s) {
  const t = s.replace(/\s/g, "");
  const m = new Set();
  for (let i = 0; i < t.length - 1; i++) m.add(t.slice(i, i + 2));
  return m;
}
function jaccard(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

console.log(`原文 ${srcText.length} 字 ｜ 网关 ${BASE} ｜ ${MODELS.length} 个模型 → ${OUT}\n`);
const results = [];
for (const [i, model] of MODELS.entries()) {
  const dir = path.join(OUT, model);
  fs.mkdirSync(dir, { recursive: true });
  const input = path.join(dir, "in.txt");
  fs.writeFileSync(input, srcText, "utf8");
  const report = path.join(dir, "report.json");
  process.stdout.write(`(${i + 1}/${MODELS.length}) ${model} … `);
  const t0 = Date.now();
  try {
    execFileSync(
      process.execPath,
      [
        path.join(ROOT, "node_modules/tsx/dist/cli.mjs"),
        path.join(ROOT, "scripts/humanize-cli.ts"),
        input,
        "--out",
        dir,
        "--api",
        "--no-deep",
        "--base-url",
        BASE,
        "--model",
        model,
        "--intensity",
        argOf("--intensity", "0.9"),
        "--seed",
        "20260905",
        "--report",
        report,
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 300_000,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, SENSENOVA_KEYS: KEYS },
      },
    );
    const wall = Date.now() - t0;
    const rep = JSON.parse(fs.readFileSync(report, "utf8")).reports[0];
    const out = fs.readFileSync(rep.outPath, "utf8");
    fs.writeFileSync(path.join(OUT, `${model}.txt`), out, "utf8");
    results.push({
      model,
      ok: true,
      wall,
      engine: rep.engine,
      before: rep.detectBefore,
      after: rep.detectAfter,
      out,
      note: rep.note ?? "",
    });
    console.log(`✅ ${wall}ms  分 ${rep.detectBefore}→${rep.detectAfter}  引擎 ${rep.engine}`);
  } catch (e) {
    const msg = String(e.stderr ?? e.message ?? e).slice(0, 200);
    results.push({ model, ok: false, wall: Date.now() - t0, out: "" });
    console.log(`❌ ${msg.split("\n")[0]}`);
  }
}

const ok = results.filter((r) => r.ok);
console.log("\n===== 客观指标 =====");
console.log("| 模型 | 墙钟 | 字数 | 段落 | 句数 | 平均句长 | 残留套话 | 本地分 前→后 | 引擎 |");
console.log("|---|---|---|---|---|---|---|---|---|");
const s0 = stats(srcText);
console.log(
  `| 原文 | — | ${s0.chars} | ${s0.paras} | ${s0.sents} | ${s0.avgLen} | ${s0.stock.length} | — | — |`,
);
for (const r of results) {
  if (!r.ok) {
    console.log(`| ${r.model} | ❌ | — | — | — | — | — | — | — |`);
    continue;
  }
  const s = stats(r.out);
  console.log(
    `| ${r.model} | ${r.wall}ms | ${s.chars} | ${s.paras} | ${s.sents} | ${s.avgLen} | ${s.stock.length} | ${r.before}→${r.after} | ${r.engine} |`,
  );
}

console.log("\n===== 两两相似度（字符二元组 Jaccard；越低越互补）=====");
for (let i = 0; i < ok.length; i++) {
  for (let j = i + 1; j < ok.length; j++) {
    console.log(`${ok[i].model.padEnd(26)} vs ${ok[j].model.padEnd(26)} ${jaccard(ok[i].out, ok[j].out).toFixed(3)}`);
  }
}
console.log(`\n产出已落盘：${OUT}<模型>.txt`);
