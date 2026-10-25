/**
 * 事实保真扫查（v0.9.76）
 *
 * 目的：把「LLM 改写会不会丢事实」变成可复现的**批量实验**，而不是靠人肉读稿碰运气。
 * 今天（2026-10-25）就是靠同类实验抓到一次真实丢失：
 *   财经快讯 · deepseek-v4-flash · 第 2 轮 → 整句「总资产 126.75 亿元，较上年末上升 6.3%」被删。
 *
 * 判据（确定性，不花额外 API）：
 *   · **数字保真**：原文所有数字/百分数必须出现在产出里（归一化见 src/engine/number-fidelity.ts）；
 *   · **段落要点覆盖**：原文每段的"首个实词片段"是否还能在产出里找到近似（粗判，仅提示）。
 *
 * 用法：
 *   node scripts/fidelity-sweep.mjs [--cases C4,C12,C14,C16,C18] [--models a,b] [--runs 1]
 *                                  [--intensity 0.9] [--out <dir>]
 * 退出码：发现任何数字丢失 → 1（可直接当门禁用；不丢 → 0）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { missingNumericFacts } from "../src/engine/number-fidelity.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argOf = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const CASES = argOf(
  "--cases",
  "C4-product-copy,C12-paper-abstract,C14-finance-flash,C16-prospectus-risk,C18-tender-spec",
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const MODELS = argOf(
  "--models",
  "deepseek-v4-flash,sensenova-6.8-flash-lite,glm-5.2,kimi-k3,deepseek-flash",
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const RUNS = Number(argOf("--runs", "1"));
const INTENSITY = argOf("--intensity", "0.9");
const OUT = argOf("--out", path.join(os.tmpdir(), "qw-fidelity-sweep"));

const KEYS =
  process.env.SENSENOVA_KEYS ??
  (fs.existsSync(path.join(ROOT, "scripts", ".sensenova-keys"))
    ? fs.readFileSync(path.join(ROOT, "scripts", ".sensenova-keys"), "utf8").trim()
    : "");
if (!KEYS) {
  console.error("没有可用 Key：请设 SENSENOVA_KEYS 或放 scripts/.sensenova-keys");
  process.exit(1);
}

const allCases = JSON.parse(
  fs.readFileSync(path.join(ROOT, "scripts/realcase/cases.json"), "utf8"),
).cases;
const picked = CASES.map((id) => {
  const c = allCases.find((x) => x.id === id);
  if (!c) {
    console.error(`没有这个案例：${id}`);
    process.exit(2);
  }
  return c;
});

fs.mkdirSync(OUT, { recursive: true });
const rows = [];
const total = picked.length * MODELS.length * RUNS;
let n = 0;

for (const c of picked) {
  const srcFile = path.join(OUT, `src-${c.id}.txt`);
  fs.writeFileSync(srcFile, c.text, "utf8");
  for (const model of MODELS) {
    for (let run = 1; run <= RUNS; run++) {
      n++;
      const tag = `${c.id}__${model}__r${run}`;
      const dir = path.join(OUT, tag);
      fs.mkdirSync(dir, { recursive: true });
      const input = path.join(dir, "in.txt");
      fs.writeFileSync(input, c.text, "utf8");
      const report = path.join(dir, "report.json");
      process.stdout.write(`(${n}/${total}) ${tag} … `);
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
            argOf("--base", "https://token.sensenova.cn/v1"),
            "--model",
            model,
            "--intensity",
            INTENSITY,
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
        fs.writeFileSync(path.join(OUT, `${tag}.txt`), out, "utf8");
        const missing = missingNumericFacts(c.text, out);
        rows.push({
          id: c.id,
          model,
          run,
          wall,
          engine: rep.engine,
          charsIn: c.text.length,
          charsOut: out.length,
          before: rep.detectBefore,
          after: rep.detectAfter,
          missing,
          note: rep.note,
        });
        console.log(
          missing.length
            ? `⚠ 丢 ${missing.length} 个数字：${missing.join("、")}`
            : `✅ ${wall}ms 分 ${rep.detectBefore}→${rep.detectAfter}`,
        );
      } catch (e) {
        const msg = String(e.stderr ?? e.message ?? e).slice(0, 160);
        rows.push({
          id: c.id,
          model,
          run,
          wall: Date.now() - t0,
          engine: "error",
          error: msg.split("\n")[0],
          missing: [],
        });
        console.log(`❌ ${msg.split("\n")[0]}`);
      }
    }
  }
}

fs.writeFileSync(path.join(OUT, "rows.json"), JSON.stringify(rows, null, 2), "utf8");

const llmRows = rows.filter((r) => r.engine === "llm");
const lossy = llmRows.filter((r) => r.missing.length > 0);
console.log("\n===== 汇总 =====");
console.log(`| 案例 | 模型 | 引擎 | 字数比 | 本地分 | 丢数字 |`);
console.log(`|---|---|---|---|---|---|`);
for (const r of rows) {
  const ratio = r.charsOut ? (r.charsOut / r.charsIn).toFixed(2) : "—";
  console.log(
    `| ${r.id.replace(/^C\d+-/, "")} | ${r.model} | ${r.engine === "error" ? "❌ " + (r.error ?? "").slice(0, 30) : r.engine} | ${ratio} | ${r.before}→${r.after} | ${r.missing.length ? r.missing.join("、") : "—"} |`,
  );
}
console.log(`\nLLM 运行 ${llmRows.length} 次，其中**丢数字 ${lossy.length} 次**`);
for (const r of lossy)
  console.log(`  ❌ ${r.id} / ${r.model} / r${r.run}：${r.missing.join("、")}`);
console.log(`\n产出落盘：${OUT}`);

process.exit(lossy.length > 0 ? 1 : 0);
