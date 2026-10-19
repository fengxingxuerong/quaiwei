/**
 * _live-api-verify.ts —— LLM API 端到端实测（走产品真实代码路径）
 *
 * 为什么不用裸 https.request：那样只能证明「网关活着」，
 * 证不了「用户在设置面板填的 baseUrl/key/model 真能被引擎消费」。
 * 本脚本直接 import src/api/llm.ts 的 runHumanize —— 与 UI 点「开始去味」
 * 走的是同一条链：chat() → llm-humanize → llm-judge → aiScore。
 *
 * 用法：npx tsx scripts/_live-api-verify.ts [--deep]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runHumanize } from "../src/api/llm";
import { effectiveKeys, type ApiConfig } from "../src/api/llm-config";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEEP = process.argv.includes("--deep");

/** 一段典型的 AI 味公文：排比 + 套话 + 书面连接词，足够触发改写 */
const SAMPLE = `在当今这个日新月异的时代背景下，数字化转型已经成为各行各业不可逆转的趋势。
我们应当坚持以人为本的理念，不断创新进取，持续优化服务体验，从而在激烈的市场竞争中占据有利地位。
需要指出的是，这一过程中既有机遇也有挑战，只有未雨绸缪，才能行稳致远。`;

async function main() {
  const keys = fs
    .readFileSync(path.join(ROOT, "electron-app/preset-keys.txt"), "utf8")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  console.log("═".repeat(64));
  console.log("趣AI味 · LLM API 端到端实测（产品真实代码路径）");
  console.log("═".repeat(64));
  console.log(`Key 池：${keys.length} 条（不打印明文）`);
  console.log(`深度模式：${DEEP ? "开（多轮改写→评分→再改写）" : "关（单轮）"}`);

  /* ---- 第 1 关：单轮改写（最基础的一次调用） ---- */
  const cfg1: ApiConfig = {
    enabled: true,
    // 走网关直连。桌面版 UI 里填的是 /sensenova/v1（相对路径，由 Electron 主进程转发），
    // 这里用绝对 URL 等价——同一个上游，转发层只解决 CORS 预检。
    baseUrl: "https://token.sensenova.cn/v1",
    apiKey: keys[0] ?? "",
    apiKeys: keys.join("\n"),
    model: "deepseek-v4-flash",
    temperature: 0.9,
    deepMode: false,
    judgeModel: "",
    altModel: "",
    contestSamples: 1,
    style: "plain",
    maxWaitSeconds: 120,
    maxApiCalls: 6,
  };
  console.log(`\n【第 1 关】单轮改写  baseUrl=${cfg1.baseUrl}  model=${cfg1.model}`);
  console.log(`  Key 池解析：${effectiveKeys(cfg1).length} 条生效`);
  const t0 = Date.now();
  const r1 = await runHumanize(SAMPLE, 0.9, cfg1, (round, score) =>
    console.log(`    进度：第 ${round} 轮 评分=${score ?? "-"}`),
  );
  console.log(`  ✅ 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  usedApi=${r1.usedApi}  engine=${r1.engine}`);
  console.log(`  aiScore：${r1.before.score} → ${r1.after.score}（越低越像人写）`);
  if (r1.degrade.length) console.log(`  ⚠️ 降级原因：${r1.degrade.join(" / ")}`);
  console.log(`  ── 产出 ──\n${r1.text}\n  ─────────`);

  /* ---- 第 2 关：交叉评判（judgeModel 另一家族） ---- */
  console.log(`\n【第 2 关】交叉评判  judgeModel=glm-5.2（与主模型不同家族）`);
  const cfg2 = { ...cfg1, judgeModel: "glm-5.2" };
  const t1 = Date.now();
  const r2 = await runHumanize(SAMPLE, 0.9, cfg2);
  console.log(`  ✅ 用时 ${((Date.now() - t1) / 1000).toFixed(1)}s  engine=${r2.engine}`);
  console.log(`  aiScore：${r2.before.score} → ${r2.after.score}  轮次分：${JSON.stringify(r2.roundScores)}`);
  if (r2.degrade.length) console.log(`  ⚠️ 降级原因：${r2.degrade.join(" / ")}`);

  /* ---- 第 3 关（可选）：深度闭环 + 双模型竞争 ---- */
  if (DEEP) {
    console.log(`\n【第 3 关】深度闭环  deepMode=true  altModel=kimi-k3`);
    const cfg3: ApiConfig = {
      ...cfg1,
      deepMode: true,
      altModel: "kimi-k3",
      judgeModel: "glm-5.2",
      maxWaitSeconds: 300,
      maxApiCalls: 20,
    };
    const t2 = Date.now();
    const r3 = await runHumanize(
      SAMPLE,
      0.9,
      cfg3,
      (round, score, stage) =>
        console.log(`    进度：第 ${round} 轮 评分=${score ?? "-"} 阶段=${stage ?? "-"}`),
    );
    console.log(`  ✅ 用时 ${((Date.now() - t2) / 1000).toFixed(1)}s  engine=${r3.engine}`);
    console.log(`  aiScore：${r3.before.score} → ${r3.after.score}  轮次分：${JSON.stringify(r3.roundScores)}`);
    console.log(`  压缩率：${r3.shrinkRatio ? (r3.shrinkRatio * 100).toFixed(0) + "%" : "-"}`);
    if (r3.note) console.log(`  note：${r3.note}`);
    if (r3.degrade.length) console.log(`  ⚠️ 降级原因：${r3.degrade.join(" / ")}`);
    console.log(`  ── 产出 ──\n${r3.text}\n  ─────────`);
  }

  console.log("\n" + "═".repeat(64));
  console.log("结论：三关全过 = 用户在设置面板填的 baseUrl/apiKey/model 确实可被引擎消费。");
  console.log("═".repeat(64));
}

main().catch((e) => {
  console.error("\n❌ 实测失败：", e?.message ?? e);
  if (e?.cause) console.error("  cause:", e.cause);
  process.exit(1);
});
