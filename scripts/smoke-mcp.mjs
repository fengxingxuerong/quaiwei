#!/usr/bin/env node
/**
 * MCP 冒烟：把打包产物当成一个真客户端用一遍。
 *
 * 和 src/mcp/server.test.ts 的分工：单元测试在内存流上验协议与工具语义，
 * 这个脚本验的是**打包产物**本身——shebang、esbuild 打进来之后还跑不跑、
 * 从 stdin 读一行回一行有没有被别的东西污染 stdout。
 * 改了 build-cli.mjs 或任何引擎入口，都该先跑这个。
 *
 * 用法：npm run smoke:mcp（需要先 npm run build:cli）
 *      验证已发布包时用 QUAIWEI_MCP_BIN 指向装出来的 bin：
 *      QUAIWEI_MCP_BIN=./node_modules/ai-humanizer/dist-cli/quaiwei-mcp.mjs npm run smoke:mcp
 * 退出码：0 全过；1 有断言没通过；2 产物不存在 / 进程起不来
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = process.env.QUAIWEI_MCP_BIN || join(root, "dist-cli", "quaiwei-mcp.mjs");

if (!existsSync(bundle)) {
  console.error(`✗ 找不到产物：${bundle}\n  先跑 npm run build:cli，或用 QUAIWEI_MCP_BIN 指到实际文件`);
  process.exit(2);
}

const AI_ISH =
  "在当前快速迭代的行业背景下，团队围绕提质增效开展了系统性的实践。" +
  "值得注意的是，本季度共发布了 3 个版本，修复了 17 个线上问题，进一步赋能了组织协同。" +
  "综上所述，这一系列举措不仅提升了交付效率，更标志着研发体系迈入了新的阶段。";

const child = spawn(process.execPath, [bundle], { stdio: ["pipe", "pipe", "pipe"] });

let buffered = "";
const pending = new Map();
const stderr = [];

child.stderr.on("data", (b) => stderr.push(b.toString("utf8")));

child.stdout.on("data", (chunk) => {
  buffered += chunk.toString("utf8");
  let nl;
  while ((nl = buffered.indexOf("\n")) >= 0) {
    const line = buffered.slice(0, nl).trim();
    buffered = buffered.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error(`✗ stdout 上有非 JSON 的东西（会毁掉协议）：${line.slice(0, 120)}`);
      process.exit(1);
    }
    const cb = pending.get(msg.id);
    if (cb) {
      pending.delete(msg.id);
      cb(msg);
    }
  }
});

let seq = 0;
function rpc(method, params) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => reject(new Error(`${method} 超时（10s）`)), 10_000);
    pending.set(id, (msg) => {
      globalThis.clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` · ${detail}` : ""}`);
}

try {
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke-mcp", version: "0" },
  });
  check("initialize", init.result?.serverInfo?.name === "quaiwei", `协议 ${init.result?.protocolVersion} · 版本 ${init.result?.serverInfo?.version}`);

  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const list = await rpc("tools/list", {});
  const names = (list.result?.tools ?? []).map((t) => t.name);
  check("tools/list", names.length === 4, names.join(" / "));

  const hum = await rpc("tools/call", { name: "humanize_text", arguments: { text: AI_ISH } });
  const out = hum.result?.content?.[0]?.text ?? "";
  check("humanize_text 有产出", out.length > 0 && out !== AI_ISH, `${AI_ISH.length} 字 → ${out.length} 字`);
  check("humanize_text 没吃掉数字", out.includes("17") && out.includes("3"));
  check(
    "humanize_text 前后分",
    typeof hum.result?.structuredContent?.scoreBefore === "number",
    `${hum.result?.structuredContent?.scoreBefore} → ${hum.result?.structuredContent?.scoreAfter}`,
  );

  const det = await rpc("tools/call", { name: "detect_ai", arguments: { text: AI_ISH } });
  check(
    "detect_ai 返回代理分",
    typeof det.result?.structuredContent?.probability === "number",
    `分 ${det.result?.structuredContent?.probability}`,
  );

  const tw = await rpc("tools/call", { name: "humanize_text", arguments: { text: "打开软件，改一下默认设置。", variant: "zh-TW" } });
  const twText = tw.result?.content?.[0]?.text ?? "";
  check("variant=zh-TW 换词生效", twText.includes("软体") && twText.includes("预设"), twText.slice(0, 40));

  const rep = await rpc("tools/call", { name: "quality_report", arguments: { text: AI_ISH } });
  const report = rep.result?.content?.[0]?.text ?? "";
  check("quality_report 有保真一节", report.includes("## 保真检查"), `${report.length} 字`);

  const paper = "本文在 3 个数据集上做了消融实验，准确率提升 4.2 个百分点~\\cite{wang2024}。";
  const acad = await rpc("tools/call", {
    name: "academic_report",
    arguments: { text: paper, rewritten: "我们在多个数据集上做了实验，效果有明显提升。" },
  });
  const auditText = acad.result?.content?.[0]?.text ?? "";
  check(
    "academic_report 判 NOT READY",
    acad.result?.structuredContent?.verdict === "blocked" && auditText.includes("wang2024"),
    `阻断 ${acad.result?.structuredContent?.blockers?.length ?? 0} 项`,
  );
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exitCode = 1;
} finally {
  child.stdin.end();
  child.kill();
}

if (stderr.length) {
  // stderr 允许有内容（引擎的警告都走这里），但媒体协议不能借道 stdout
  console.log(`\nstderr（不影响协议）：\n${stderr.join("").trim().slice(0, 400)}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? "✗" : "✓"} 冒烟 ${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
